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
	completeSynchronousProviderExit,
	executeProviderInvocation,
	getWorkspaceExecution,
	reconcileSynchronousProviderExit,
	runProviderProcess,
} from "./provider-lifecycle.mjs";
import { validateIdentifier, validateModelArg } from "./shell-safety.mjs";
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
		if (writeError) return configWriteFailure({ stderr: writeError.message });
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
		return {
			...completeSynchronousProviderExit(output, execution.args, options),
			servedModel,
		};
	} catch (error) {
		const timedOut = error?.code === "ETIMEDOUT";
		if (timedOut && execution) {
			const cleanup = killOrphanedProcesses(workingContainerName, {
				executionBackend: options.executionBackend,
				command: execution.command,
				args: execution.args,
				cleanupContext: options.cleanupContext,
			});
			return {
				output: error.stdout || "",
				success: false,
				error: error.message,
				timedOut,
				...cleanup,
			};
		}
		const reconciled = execution
			? reconcileSynchronousProviderExit(error, execution.args, {
					...options,
					provider: "vibe",
				})
			: null;
		if (reconciled?.success) {
			const { servedModel, mismatch } = classifyServedModel(
				readServedModelSync(workingContainerName, options),
				execution.selector,
				options.onStatus,
			);
			if (mismatch) return servedModelFailure(execution.selector, servedModel);
			return { ...reconciled, servedModel };
		}
		if (reconciled) return reconciled;
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
	const probe = buildServedModelExecution(workspaceId, options);
	for (let attempt = 1; attempt <= VIBE_HELPER_ATTEMPTS; attempt += 1) {
		// Each attempt can sit for SERVED_MODEL_TIMEOUT_MS with nothing on the
		// wire, so the wait is announced rather than silent.
		options.onStatus?.({
			phase: "execution",
			event: "served_model_probe_started",
			status: `Reading Vibe's served-model record (attempt ${attempt}/${VIBE_HELPER_ATTEMPTS})`,
		});
		try {
			const result = await runProviderProcess(probe.command, probe.args, {
				...lifecycleClockOptions(options),
				timeoutMs: SERVED_MODEL_TIMEOUT_MS,
				silenceTimeoutMs: options.silenceTimeoutMs,
				progressStage: "starting",
				onProgress: options.onProgress,
				...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
			});
			if (result?.success) return result.output;
		} catch {
			// Missing evidence, not contrary evidence - see classifyServedModel.
		}
	}
	return null;
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
			options.onStatus?.({
				phase: "execution",
				event: "provider_config_write_started",
				status: `Writing Vibe's model config into the workspace (attempt ${attempt}/${VIBE_HELPER_ATTEMPTS})`,
			});
			written = await runProviderProcess(write.command, write.args, {
				...lifecycleClockOptions(options),
				input: write.input,
				timeoutMs: SERVED_MODEL_TIMEOUT_MS,
				silenceTimeoutMs: options.silenceTimeoutMs,
				progressStage: "configuring",
				onProgress: options.onProgress,
				...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
			});
			if (written?.success) break;
		}
		if (!written?.success) return configWriteFailure(written);
		const result = await executeProviderInvocation(
			execution.command,
			execution.args,
			{
				...options,
				provider: "vibe",
				input: execution.input,
				cleanupContext: {
					...options.cleanupContext,
					...execution.cleanupContext,
				},
				timeoutMs: options.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS,
				cleanup: () => killOrphanedProcessesAsync(workingContainerName),
				silenceTimeoutMs: options.silenceTimeoutMs,
				progressStage: "working",
				onProgress: options.onProgress,
			},
		);
		// Unlike the sync path, where execFileSync throws and this line is
		// unreachable on a failure, executeProviderInvocation *returns* a failed
		// result. Verifying the served model here would read the newest session
		// directory in a working container that is reused across every task in
		// the queue, so a task that failed before Vibe wrote a session reads the
		// PREVIOUS task's model and reports a substitution that never happened -
		// discarding the accurate timeout, cleanup stage, exit code, and signal
		// in favour of a false diagnosis.
		if (!result?.success) return result;
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

import "./vibe-config.mjs";
import "./vibe-execution.mjs";
import {
	buildConfigWriteExecution,
	buildServedModelExecution,
	classifyServedModel,
	configWriteFailure,
	lifecycleClockOptions,
	SERVED_MODEL_TIMEOUT_MS,
	servedModelFailure,
	VIBE_HELPER_ATTEMPTS,
} from "./vibe-config.mjs";
import {
	buildExecution,
	readServedModelSync,
	writeVibeConfigSync,
} from "./vibe-execution.mjs";

export {
	isVibeAuthenticated,
	renderVibeConfig,
	VIBE_ACTIVE_MODEL,
	VIBE_HOME_PATH,
	VIBE_MODELS,
} from "./vibe-config.mjs";
