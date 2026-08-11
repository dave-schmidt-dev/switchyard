import { execFileSync } from "node:child_process";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "./constants.mjs";
import { describeExecError } from "./exec-error.mjs";
import { validateAdapterInvocation } from "./invocation.mjs";
import {
	killOrphanedProcesses,
	killOrphanedProcessesAsync,
} from "./orphan-kill.mjs";
import { addProviderPromptGuardrail } from "./prompt-guardrails.mjs";
import {
	captureProviderDiffAsync,
	executeProviderInvocation,
} from "./provider-lifecycle.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const COPILOT_CMD = "copilot";
// Copilot CLI's current OAuth device-flow credential store. The file is
// copied as an opaque credential file; its contents are never parsed or
// logged by Switchyard.
const CREDENTIALS_PATH = "/root/.copilot/config.json";
const MIN_CREDENTIAL_BYTES = 16;

function hasNonTrivialCredential(containerName) {
	try {
		execFileSync(
			"docker",
			[
				"exec",
				containerName,
				"sh",
				"-c",
				`[ -f ${CREDENTIALS_PATH} ] && [ "$(wc -c < ${CREDENTIALS_PATH} | tr -d '[:space:]')" -ge ${MIN_CREDENTIAL_BYTES} ]`,
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

export function isCopilotAuthenticated(containerName = AGENT_CONTAINER_NAME) {
	try {
		execFileSync("docker", ["exec", containerName, COPILOT_CMD, "--version"], {
			encoding: "utf8",
			stdio: "pipe",
		});
	} catch {
		return false;
	}
	return hasNonTrivialCredential(containerName);
}

export function execute(prompt, workingContainerName, options = {}) {
	const { model, timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS } = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);

	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}
	try {
		validateAdapterInvocation(options, {
			expectedHarness: "copilot",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}

	const args = [
		"exec",
		"-w",
		"/project",
		workingContainerName,
		COPILOT_CMD,
		"-p",
		guardedPrompt,
		"--allow-all-tools",
		"--no-ask-user",
	];
	if (model) {
		try {
			validateModelArg(model, "model");
		} catch (error) {
			return { output: "", success: false, error: error.message };
		}
		args.push("--model", model);
	}

	try {
		const result = execFileSync("docker", args, {
			input: guardedPrompt,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: timeoutMs,
			maxBuffer: 128 * 1024 * 1024, // 128 MB
		});

		return { output: result, success: true };
	} catch (error) {
		const timedOut = error.code === "ETIMEDOUT";
		if (timedOut) {
			killOrphanedProcesses(workingContainerName);
			// Keep error.message (carries ETIMEDOUT) so the runner classifies
			// this as execution_timed_out, not a generic failure.
			return {
				output: error.stdout || "",
				success: false,
				error: error.message,
				timedOut,
			};
		}
		// Non-timeout failure: surface the provider's own diagnostic (and, on an
		// expired session, an actionable re-auth hint) instead of Node's opaque
		// "Command failed: docker exec …" wrapper — see exec-error.mjs.
		const described = describeExecError(error, { provider: "copilot" });
		return {
			output: described.output,
			success: false,
			error: described.error,
			errorKind: described.errorKind,
			timedOut,
		};
	}
}

/** Async counterpart used by non-blocking queue workers. */
export async function executeAsync(prompt, workingContainerName, options = {}) {
	const {
		model,
		timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
		signal,
		onPoll,
	} = options;
	const guardedPrompt = addProviderPromptGuardrail(prompt);
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
		validateAdapterInvocation(options, {
			expectedHarness: "copilot",
			expectedTargetId: options.resolvedTargetId,
			expectedModel: model,
		});
		const args = [
			"exec",
			"-w",
			"/project",
			workingContainerName,
			COPILOT_CMD,
			"-p",
			guardedPrompt,
			"--allow-all-tools",
			"--no-ask-user",
		];
		if (model) {
			validateModelArg(model, "model");
			args.push("--model", model);
		}
		return await executeProviderInvocation("docker", args, {
			...options,
			provider: "copilot",
			timeoutMs,
			signal,
			onPoll,
			cleanup: () => killOrphanedProcessesAsync(workingContainerName),
		});
	} catch (error) {
		return { output: "", success: false, error: error.message };
	}
}

export function captureDiff(workingContainerName) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return null;
	}
	try {
		execFileSync(
			"docker",
			["exec", "-w", "/project", workingContainerName, "git", "add", "-A"],
			{ stdio: "pipe" },
		);
		const diff = execFileSync(
			"docker",
			[
				"exec",
				"-w",
				"/project",
				workingContainerName,
				"git",
				"diff",
				"--cached",
				"HEAD",
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return /\S/u.test(diff) ? diff : null;
	} catch {
		return null;
	}
}

export function captureDiffAsync(workingContainerName, options = {}) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return Promise.resolve(null);
	}
	return captureProviderDiffAsync(workingContainerName, options);
}
