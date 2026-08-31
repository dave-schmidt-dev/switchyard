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
} from "./provider-lifecycle.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";

const VIBE_CMD = "vibe";
const VIBE_KEYCHAIN_SERVICE = "ai.mistral.vibe";
const VIBE_KEYCHAIN_ACCOUNT = "MISTRAL_API_KEY";
// Twelve turns bounds a standard task's inspect/edit/test loop while leaving
// room for one correction pass; the surrounding provider timeout remains the
// hard wall for unexpectedly slow provider responses.
const VIBE_MAX_TURNS = "12";

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

function buildExecution(workspaceId, prompt, options) {
	validateIdentifier(workspaceId, "workingContainerName");
	const invocationArgs = validateAdapterInvocation(options, {
		expectedHarness: "vibe",
		expectedTargetId: options.resolvedTargetId,
		expectedModel: options.model,
	});
	validateModelArg(options.model, "model");
	return getWorkspaceExecution(workspaceId, {
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
		env: [`VIBE_ACTIVE_MODEL=${options.model}`],
	});
}

export function execute(prompt, workingContainerName, options = {}) {
	const guardedPrompt = addProviderPromptGuardrail(prompt);
	let execution;
	try {
		execution = buildExecution(workingContainerName, guardedPrompt, options);
		const output = execFileSync(execution.command, execution.args, {
			input: execution.input,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: options.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS,
			maxBuffer: 128 * 1024 * 1024,
		});
		return { output, success: true };
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

export async function executeAsync(prompt, workingContainerName, options = {}) {
	const guardedPrompt = addProviderPromptGuardrail(prompt);
	try {
		const execution = buildExecution(
			workingContainerName,
			guardedPrompt,
			options,
		);
		return await executeProviderInvocation(execution.command, execution.args, {
			...options,
			provider: "vibe",
			input: execution.input,
			cleanupContext: execution.cleanupContext,
			timeoutMs: options.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS,
			cleanup: () => killOrphanedProcessesAsync(workingContainerName),
		});
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
