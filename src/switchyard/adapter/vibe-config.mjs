import { getWorkspaceExecution } from "./provider-lifecycle.mjs";

const VIBE_CMD = "vibe";
export const VIBE_MODELS = Object.freeze({
	"mistral-medium-3.5": Object.freeze({
		name: "mistral-vibe-cli-latest",
		thinking: "high",
	}),
	"glm-5-3-medium": Object.freeze({ name: "zai-glm-5-3", thinking: "medium" }),
	"glm-5-3": Object.freeze({ name: "zai-glm-5-3", thinking: "max" }),
});
export const VIBE_ACTIVE_MODEL = "mistral-medium-3.5";
export const VIBE_HOME_PATH = "/tmp/switchyard-vibe";
const VIBE_CONFIG_PATH = `${VIBE_HOME_PATH}/config.toml`;
const VIBE_KEYCHAIN_SERVICE = "ai.mistral.vibe";
const VIBE_KEYCHAIN_ACCOUNT = "MISTRAL_API_KEY";
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
const SERVED_MODEL_TIMEOUT_MS = 60_000;
function lifecycleClockOptions(options) {
	return Object.fromEntries(
		[
			"now",
			"setTimeoutFn",
			"clearTimeoutFn",
			"setIntervalFn",
			"clearIntervalFn",
		]
			.filter((key) => typeof options[key] === "function")
			.map((key) => [key, options[key]]),
	);
}
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
function configWriteFailure(result) {
	const silenceTimedOut = result?.silenceTimedOut === true;
	const timedOut = result?.timedOut === true;
	return {
		output: "",
		success: false,
		error: silenceTimedOut
			? "provider made no substantive progress before the silence deadline"
			: timedOut
				? "provider execution timed out while writing the Vibe model config"
				: (
						"could not write the Vibe model config into the workspace after " +
						`${VIBE_HELPER_ATTEMPTS} attempts; without it the guest would ` +
						"silently run its default model. " +
						`${result?.stderr ?? ""}`
					).trim(),
		errorKind: silenceTimedOut
			? "silence_timeout"
			: timedOut
				? "execution_timed_out"
				: "environment_incomplete",
		timedOut,
		silenceTimedOut,
		outcome: silenceTimedOut
			? "silence_timeout"
			: timedOut
				? "execution_timed_out"
				: "failure",
		progress: result?.progress ?? null,
		providerLifecycle: result?.providerLifecycle ?? null,
		writerLifecycle: result?.writerLifecycle ?? "unavailable",
		cleanupFailed: result?.cleanupFailed === true,
		cleanupStage: result?.cleanupStage ?? null,
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

export {
	buildConfigWriteExecution,
	buildServedModelExecution,
	classifyServedModel,
	configWriteFailure,
	lifecycleClockOptions,
	SERVED_MODEL_TIMEOUT_MS,
	servedModelFailure,
	VIBE_CMD,
	VIBE_HELPER_ATTEMPTS,
};
