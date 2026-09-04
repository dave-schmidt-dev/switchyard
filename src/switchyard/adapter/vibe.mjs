import { execFileSync } from "node:child_process";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "./constants.mjs";
import { describeExecError } from "./exec-error.mjs";
import { validateAdapterInvocation } from "./invocation.mjs";
import {
	killOrphanedProcesses,
	killOrphanedProcessesAsync,
} from "./orphan-kill.mjs";
import { addProviderPromptGuardrail } from "./prompt-guardrails.mjs";
import {
	captureProviderDiff,
	captureProviderDiffAsync,
	captureProviderDiffDetailed,
	captureProviderDiffDetailedAsync,
	executeProviderInvocation,
	getWorkspaceExecution,
	runProviderProcess,
} from "./provider-lifecycle.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const VIBE_CMD = "vibe";
/**
 * The selectors switchyard is willing to route through Vibe, each mapped to the
 * provider-side model name and thinking level that defines it.
 *
 * Vibe resolves a selector against its *configured* models and, when the name is
 * absent, `_apply_active_model_fallback` swaps in the first configured model,
 * logs a warning, and exits 0 (measured against mistral-vibe 2.24.5). The guest
 * image carries no `~/.vibe/config.toml`, so its configured set is Vibe's own
 * defaults — which contain no GLM entry. Asking a bare guest for `glm-5.2-high`
 * therefore runs `mistral-medium-3.5` and reports success. `renderVibeConfig`
 * exists to close that hole: switchyard declares the models itself rather than
 * trusting whatever the guest happens to have.
 */
export const VIBE_MODELS = Object.freeze({
	"mistral-medium-3.5": Object.freeze({
		name: "mistral-vibe-cli-latest",
		thinking: "high",
	}),
	"glm-5.2-low": Object.freeze({ name: "zai-glm-5-2", thinking: "low" }),
	"glm-5.2-high": Object.freeze({ name: "zai-glm-5-2", thinking: "high" }),
});
/**
 * The default selector: what an auth liveness probe asks for when no roster slot
 * is in play. Routing no longer pins this — the roster's slot decides.
 */
export const VIBE_ACTIVE_MODEL = "mistral-medium-3.5";
/**
 * A switchyard-owned `VIBE_HOME` rather than the provider account's `~/.vibe`.
 * Outside `/project` so nothing here reaches the diff the integration gate reads,
 * and disposable with the clone. It holds no secret: the config names the API key
 * by environment-variable *name*, and `resolve_api_key` falls back to the guest
 * Keychain entry that already authenticates Vibe today.
 */
export const VIBE_HOME_PATH = "/tmp/switchyard-vibe";
const VIBE_CONFIG_PATH = `${VIBE_HOME_PATH}/config.toml`;
const VIBE_KEYCHAIN_SERVICE = "ai.mistral.vibe";
const VIBE_KEYCHAIN_ACCOUNT = "MISTRAL_API_KEY";

/**
 * Render the guest's Vibe config for one selector. Every routable model is
 * declared, not just the requested one, so the file is identical across runs
 * apart from `active_model` and a stale copy cannot silently narrow the set.
 * @param {string} selector
 * @returns {string}
 */
export function renderVibeConfig(selector) {
	const lines = [
		"# Written by switchyard before every Vibe dispatch. Do not edit in the guest.",
		"# Declaring the models here is what stops Vibe from silently substituting",
		"# its default model for a selector it does not recognise.",
		`active_model = ${JSON.stringify(selector)}`,
	];
	for (const [alias, model] of Object.entries(VIBE_MODELS)) {
		lines.push(
			"",
			"[[models]]",
			`name = ${JSON.stringify(model.name)}`,
			'provider = "mistral"',
			`alias = ${JSON.stringify(alias)}`,
			`thinking = ${JSON.stringify(model.thinking)}`,
		);
	}
	return `${lines.join("\n")}\n`;
}
// Twelve turns bounds a standard task's inspect/edit/test loop while leaving
// room for one correction pass; the surrounding provider timeout remains the
// hard wall for unexpectedly slow provider responses.
const VIBE_MAX_TURNS = "12";
// Both helper execs are single short guest commands; the provider timeout is the
// wrong scale for them and would turn a wedged transport into a 30-minute stall.
const SERVED_MODEL_TIMEOUT_MS = 60_000;
// `prlctl exec` misfires transiently on this substrate (documented in
// ParallelsExecutionBackend: 5 of 150 serial calls on an idle host, worse under
// load). The backend retries its own calls, but these two helpers spawn the
// built argv directly and so carry no retry of their own. Measured the hard way:
// a single misfire on the config write failed an otherwise healthy canary with
// `environment_incomplete`.
const VIBE_HELPER_ATTEMPTS = 3;

export function isVibeAuthenticated(workspaceId, executionBackend) {
	try {
		executionBackend.execGuest(workspaceId, VIBE_CMD, ["--version"], {
			cwd: "/",
		});
		executionBackend.execGuest(
			workspaceId,
			"/usr/bin/security",
			[
				"find-generic-password",
				"-s",
				VIBE_KEYCHAIN_SERVICE,
				"-a",
				VIBE_KEYCHAIN_ACCOUNT,
			],
			{ cwd: "/" },
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write the switchyard-owned Vibe config into the guest. The file travels on
 * stdin, so nothing about its contents is interpolated into a command line.
 * @param {string} workspaceId
 * @param {object} options
 * @param {string} selector
 */
function buildConfigWriteExecution(workspaceId, options, selector) {
	return {
		...getWorkspaceExecution(workspaceId, {
			...options,
			cwd: "/",
			recordPid: false,
			env: undefined,
			argv: [
				"/bin/bash",
				"-c",
				`/bin/mkdir -p ${VIBE_HOME_PATH} && /usr/bin/tee ${VIBE_CONFIG_PATH} > /dev/null`,
			],
		}),
		input: renderVibeConfig(selector),
	};
}

/**
 * Vibe's own session metadata is the only affirmative record of which model
 * actually ran: `config.active_model` there is the value *after* the fallback
 * validator, so a substitution that exits 0 is still visible. Measured both ways
 * on 2026-09-04 — asking for `glm-5.2-low` records `glm-5.2-low`, asking for a
 * name Vibe does not know records `mistral-medium-3.5`. The streaming envelope
 * names no model at all, which is why this reads a file instead of the output.
 *
 * `plutil` rather than `python3`: plutil reads JSON and ships in the macOS
 * base system, while `/usr/bin/python3` is a Command Line Tools stub that
 * fails non-interactively on a guest that has never installed them. A probe
 * that cannot run degrades this guard to a no-op, which is the exact failure
 * it exists to prevent.
 */
const SERVED_MODEL_SCRIPT =
	"set -o pipefail; " +
	`d=$(/bin/ls -1dt ${VIBE_HOME_PATH}/logs/session/session_* 2>/dev/null | /usr/bin/head -1); ` +
	'[ -n "$d" ] || exit 3; ' +
	'/usr/bin/plutil -extract config.active_model raw -o - "$d/meta.json"';

function buildServedModelExecution(workspaceId, options) {
	return getWorkspaceExecution(workspaceId, {
		...options,
		cwd: "/",
		recordPid: false,
		env: undefined,
		argv: ["/bin/bash", "-c", SERVED_MODEL_SCRIPT],
	});
}

/**
 * Compare the model Vibe reports having run against the one the roster routed.
 *
 * A mismatch fails the task: the run happened, but not the run that was
 * authorized, and a receipt claiming otherwise is worse than no receipt. An
 * unreadable record is not treated as a mismatch — it is missing evidence, not
 * contrary evidence, and the substitution it would hide can only occur if the
 * config write above failed, which is checked on its own.
 * @returns {{servedModel:string|null, mismatch:boolean}}
 */
function classifyServedModel(servedModel, selector, onStatus) {
	const served = String(servedModel ?? "").trim();
	if (!served) {
		// Say so rather than passing quietly. A probe that cannot read Vibe's
		// session metadata leaves the substitution guard inactive for that run,
		// and an unobservable inactive guard is indistinguishable from a working
		// one — which is the failure mode this whole path exists to remove.
		onStatus?.({
			phase: "execution",
			event: "served_model_unverified",
			status: `Vibe served-model record was unreadable; ${selector} is unverified for this run`,
		});
		return { servedModel: null, mismatch: false };
	}
	return { servedModel: served, mismatch: served !== selector };
}

function configWriteFailure(detail) {
	return {
		output: "",
		success: false,
		error:
			"could not write the Vibe model config into the workspace after " +
			`${VIBE_HELPER_ATTEMPTS} attempts; without it the guest would ` +
			`silently run its default model. ${detail ?? ""}`.trim(),
		errorKind: "environment_incomplete",
		timedOut: false,
	};
}

function servedModelFailure(selector, servedModel) {
	return {
		output: "",
		success: false,
		error:
			`Vibe ran ${servedModel} but the routed descriptor selected ${selector}; ` +
			"the guest silently substituted a model and the result is not attributable.",
		errorKind: "execution_failed",
		servedModel,
		timedOut: false,
	};
}

function buildExecution(workspaceId, prompt, options) {
	validateIdentifier(workspaceId, "workingContainerName");
	const selector = options.model;
	if (!Object.hasOwn(VIBE_MODELS, selector)) {
		throw new Error(
			`Vibe does not serve model ${selector}; routable selectors: ${Object.keys(
				VIBE_MODELS,
			).join(", ")}`,
		);
	}
	const invocationArgs = validateAdapterInvocation(options, {
		expectedHarness: "vibe",
		expectedTargetId: options.resolvedTargetId,
		expectedModel: selector,
	});
	validateModelArg(selector, "model");
	return {
		selector,
		...getWorkspaceExecution(workspaceId, {
			...options,
			argv: [
				VIBE_CMD,
				...invocationArgs,
				"-p",
				prompt,
				"--auto-approve",
				"--output",
				"streaming",
				"--trust",
				"--max-turns",
				VIBE_MAX_TURNS,
			],
			env: [`VIBE_HOME=${VIBE_HOME_PATH}`, `VIBE_ACTIVE_MODEL=${selector}`],
		}),
		input: "",
	};
}

function readServedModelSync(workspaceId, options) {
	const probe = buildServedModelExecution(workspaceId, options);
	for (let attempt = 1; attempt <= VIBE_HELPER_ATTEMPTS; attempt += 1) {
		try {
			return execFileSync(probe.command, probe.args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: SERVED_MODEL_TIMEOUT_MS,
			});
		} catch {
			// Missing evidence, not contrary evidence — see classifyServedModel.
		}
	}
	return null;
}

function writeVibeConfigSync(workspaceId, options, selector) {
	const write = buildConfigWriteExecution(workspaceId, options, selector);
	let lastError = null;
	for (let attempt = 1; attempt <= VIBE_HELPER_ATTEMPTS; attempt += 1) {
		try {
			execFileSync(write.command, write.args, {
				input: write.input,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: SERVED_MODEL_TIMEOUT_MS,
			});
			return null;
		} catch (error) {
			lastError = error;
		}
	}
	return lastError;
}

export function execute(prompt, workingContainerName, options = {}) {
	const guardedPrompt = addProviderPromptGuardrail(prompt);
	let execution;
	try {
		execution = buildExecution(workingContainerName, guardedPrompt, options);
		const writeError = writeVibeConfigSync(
			workingContainerName,
			options,
			execution.selector,
		);
		if (writeError) return configWriteFailure(writeError.message);
		const output = execFileSync(execution.command, execution.args, {
			input: execution.input,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: options.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS,
			maxBuffer: 128 * 1024 * 1024,
		});
		const { servedModel, mismatch } = classifyServedModel(
			readServedModelSync(workingContainerName, options),
			execution.selector,
			options.onStatus,
		);
		if (mismatch) return servedModelFailure(execution.selector, servedModel);
		return { output, success: true, servedModel };
	} catch (error) {
		const timedOut = error?.code === "ETIMEDOUT";
		if (timedOut && execution) {
			const cleanup = killOrphanedProcesses(workingContainerName, {
				executionBackend: options.executionBackend,
				command: execution.command,
				args: execution.args,
			});
			return {
				output: error.stdout || "",
				success: false,
				error: error.message,
				timedOut,
				...cleanup,
			};
		}
		const described = describeExecError(error, { provider: "vibe" });
		return {
			output: described.output,
			success: false,
			error: described.error,
			errorKind: described.errorKind,
			timedOut,
		};
	}
}

async function readServedModelAsync(workspaceId, options) {
	try {
		const probe = buildServedModelExecution(workspaceId, options);
		const result = await runProviderProcess(probe.command, probe.args, {
			timeoutMs: SERVED_MODEL_TIMEOUT_MS,
			...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
		});
		return result?.success ? result.output : null;
	} catch {
		return null;
	}
}

export async function executeAsync(prompt, workingContainerName, options = {}) {
	const guardedPrompt = addProviderPromptGuardrail(prompt);
	try {
		const execution = buildExecution(
			workingContainerName,
			guardedPrompt,
			options,
		);
		const write = buildConfigWriteExecution(
			workingContainerName,
			options,
			execution.selector,
		);
		let written = null;
		for (let attempt = 1; attempt <= VIBE_HELPER_ATTEMPTS; attempt += 1) {
			written = await runProviderProcess(write.command, write.args, {
				input: write.input,
				timeoutMs: SERVED_MODEL_TIMEOUT_MS,
				...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
			});
			if (written?.success) break;
		}
		if (!written?.success) return configWriteFailure(written?.stderr);
		const result = await executeProviderInvocation(
			execution.command,
			execution.args,
			{
				...options,
				provider: "vibe",
				input: execution.input,
				cleanupContext: execution.cleanupContext,
				timeoutMs: options.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS,
				cleanup: () => killOrphanedProcessesAsync(workingContainerName),
			},
		);
		const { servedModel, mismatch } = classifyServedModel(
			await readServedModelAsync(workingContainerName, options),
			execution.selector,
			options.onStatus,
		);
		if (mismatch) return servedModelFailure(execution.selector, servedModel);
		return { ...result, servedModel };
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}
}

export function captureDiff(workingContainerName, options = {}) {
	return captureProviderDiff(workingContainerName, options);
}

export function captureDiffAsync(workingContainerName, options = {}) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return Promise.resolve(null);
	}
	return captureProviderDiffAsync(workingContainerName, options);
}

export function captureDiffDetailed(workingContainerName, options = {}) {
	return captureProviderDiffDetailed(workingContainerName, options);
}

export function captureDiffDetailedAsync(workingContainerName, options = {}) {
	return captureProviderDiffDetailedAsync(workingContainerName, options);
}
