import {
	captureDiff as captureAgyDiff,
	captureDiffAsync as captureAgyDiffAsync,
	captureDiffDetailed as captureAgyDiffDetailed,
	captureDiffDetailedAsync as captureAgyDiffDetailedAsync,
	executeAgy,
	executeAgyAsync,
} from "../adapter/agy.mjs";
import {
	captureDiff as captureClaudeDiff,
	captureDiffAsync as captureClaudeDiffAsync,
	captureDiffDetailed as captureClaudeDiffDetailed,
	captureDiffDetailedAsync as captureClaudeDiffDetailedAsync,
	executeClaude,
	executeClaudeAsync,
} from "../adapter/claude.mjs";
import {
	captureDiff as captureCodexDiff,
	captureDiffAsync as captureCodexDiffAsync,
	captureDiffDetailed as captureCodexDiffDetailed,
	captureDiffDetailedAsync as captureCodexDiffDetailedAsync,
	executeCodex,
	executeCodexAsync,
} from "../adapter/codex.mjs";
import {
	captureDiff as captureCopilotDiff,
	captureDiffAsync as captureCopilotDiffAsync,
	captureDiffDetailed as captureCopilotDiffDetailed,
	captureDiffDetailedAsync as captureCopilotDiffDetailedAsync,
	execute as executeCopilot,
	executeAsync as executeCopilotAsync,
} from "../adapter/copilot.mjs";
import {
	captureDiff as captureCursorDiff,
	captureDiffAsync as captureCursorDiffAsync,
	captureDiffDetailed as captureCursorDiffDetailed,
	captureDiffDetailedAsync as captureCursorDiffDetailedAsync,
	executeCursor,
	executeCursorAsync,
} from "../adapter/cursor.mjs";
import {
	captureDiff as captureOpencodeDiff,
	captureDiffAsync as captureOpencodeDiffAsync,
	captureDiffDetailed as captureOpencodeDiffDetailed,
	captureDiffDetailedAsync as captureOpencodeDiffDetailedAsync,
	execute as executeOpencode,
	executeAsync as executeOpencodeAsync,
} from "../adapter/opencode.mjs";
import { createProgressSnapshot } from "../adapter/provider-lifecycle.mjs";
import {
	captureDiff as captureVibeDiff,
	captureDiffAsync as captureVibeDiffAsync,
	captureDiffDetailed as captureVibeDiffDetailed,
	captureDiffDetailedAsync as captureVibeDiffDetailedAsync,
	execute as executeVibe,
	executeAsync as executeVibeAsync,
} from "../adapter/vibe.mjs";
import { createDefaultRouteHealthDecision } from "../router/health.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../router/index.mjs";
import { createEmptyCheckpoint, saveCheckpoint } from "./checkpoint-store.mjs";
import { failureMetadataFor } from "./quick-checks.mjs";
import { persistRetryTransition } from "./retry-transitions.mjs";

export function _resolveOnStatus(deps) {
	const diagnostics = deps.diagnostics ?? null;
	const onStatus = deps.onStatus ?? null;

	if (!onStatus && !diagnostics) return null;

	return (event) => {
		if (diagnostics && typeof diagnostics.emit === "function") {
			diagnostics.emit(event);
		}
		if (onStatus && typeof onStatus === "function") {
			onStatus(event);
		}
	};
}

export function resolveQueueHealthDecision(dependencies) {
	if (dependencies.healthDecision) return dependencies.healthDecision;
	const environmentMode = process.env.SWITCHYARD_ROUTE_HEALTH_MODE;
	return createDefaultRouteHealthDecision({
		healthStateRoot:
			dependencies.healthStateRoot ??
			process.env.SWITCHYARD_ROUTE_HEALTH_STATE_ROOT,
		mode: dependencies.healthMode ?? environmentMode ?? "shadow",
		qualifiedProviders:
			dependencies.goldenImageVerifiedProviders ??
			GOLDEN_IMAGE_VERIFIED_PROVIDERS,
		goldenImageReference:
			dependencies.goldenImage ??
			process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE ??
			"golden-image-unconfigured",
	});
}

export function _safeError(error) {
	if (error == null) return { message: "unknown error" };
	if (typeof error === "string") return { message: error };
	if (error instanceof Error) {
		const out = { name: error.name, message: error.message };
		if (error.code !== undefined) out.code = error.code;
		return out;
	}
	const out = {};
	if (error.name !== undefined) out.name = error.name;
	if (error.message !== undefined) out.message = error.message;
	if (error.code !== undefined) out.code = error.code;
	return out;
}

export function boundedProgressProjection(value) {
	if (!value || typeof value !== "object") return null;
	return createProgressSnapshot({
		stage: value.stage,
		elapsedMs: value.elapsedMs,
		lastSubstantiveProgressAt: value.lastSubstantiveProgressAt,
		lastSubstantiveProgressAgeMs: value.lastSubstantiveProgressAgeMs,
		stdoutBytes: value.counters?.stdoutBytes,
		stderrBytes: value.counters?.stderrBytes,
		pollCount: value.counters?.polls,
		progressCount: value.counters?.progressEvents,
		outcome: value.outcome,
	});
}

export function _formatCheckpointActionError(error) {
	if (
		error instanceof Error &&
		typeof error.message === "string" &&
		error.message.length > 0
	) {
		return error.message;
	}
	return "unknown error";
}

export function _haltResult(result, actionLabel, error) {
	return {
		taskId: result.taskId,
		success: false,
		provider: result.provider ?? null,
		model: result.model ?? null,
		result: `halted_after_${actionLabel}_failure`,
		action: actionLabel,
		// Bounded: only a real Error's message is kept; a non-Error throw
		// value (including a plain object's `message`) never rides along.
		error: error instanceof Error ? error.message : null,
		reason: `${actionLabel} failed after task ${result.taskId}: ${_formatCheckpointActionError(error)}`,
	};
}

export function commitOrResetWorkingContainer(result, deps) {
	const {
		ownsWorkingContainer,
		workingContainerName,
		stopOnFailure,
		commitWorkingTreeFn,
		resetWorkingTreeFn,
		emitStatus,
		logPrefix,
	} = deps;

	if (!ownsWorkingContainer) return null;

	if (result.success) {
		try {
			commitWorkingTreeFn(workingContainerName);
		} catch (error) {
			const message = _formatCheckpointActionError(error);
			console.error(
				`${logPrefix} could not checkpoint working container after task ${result.taskId}: ${message}`,
			);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_failed",
					status: `Checkpoint commit failed: ${message}`,
					taskId: result.taskId,
					error: _safeError(error),
				});
			}
			return _haltResult(result, "commit", error);
		}
	} else if (!stopOnFailure) {
		try {
			resetWorkingTreeFn(workingContainerName);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "state_reset",
					status: `Reset working tree after failed task ${result.taskId}`,
					taskId: result.taskId,
				});
			}
		} catch (error) {
			const message = _formatCheckpointActionError(error);
			console.error(
				`${logPrefix} could not reset working container after task ${result.taskId}: ${message}`,
			);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_failed",
					status: `Checkpoint reset failed: ${message}`,
					taskId: result.taskId,
					error: _safeError(error),
				});
			}
			return _haltResult(result, "reset", error);
		}
	}

	return null;
}

export function resetBeforeQuotaRetry({
	result,
	checkpoint,
	checkpointPath,
	workingContainerName,
	resetWorkingTreeFn,
	emitStatus,
}) {
	if (emitStatus) {
		emitStatus({
			phase: "checkpoint",
			event: "retry_reset_started",
			status: `Resetting the working tree before retrying task ${result.taskId}`,
			taskId: result.taskId,
			provider: result.provider ?? null,
			model: result.model ?? null,
			resolvedTargetId: result.resolvedTargetId ?? null,
		});
	}
	try {
		resetWorkingTreeFn(workingContainerName);
	} catch (error) {
		const haltResult = _haltResult(result, "reset", error);
		persistRetryTransition(checkpoint, checkpointPath, {
			type: "retry_halted",
			taskId: result.taskId,
			attempt: 1,
			provider: result.provider,
			model: result.model,
			resolvedTargetId: result.resolvedTargetId,
			invocationDescriptor: result.invocationDescriptor,
			descriptorIdentity: result.descriptorIdentity,
			descriptorHarness: result.descriptorHarness,
			clearState: true,
		});
		if (emitStatus) {
			emitStatus({
				phase: "checkpoint",
				event: "checkpoint_failed",
				status: `Checkpoint reset failed: ${_formatCheckpointActionError(error)}`,
				taskId: result.taskId,
				error: _safeError(error),
			});
		}
		return haltResult;
	}

	persistRetryTransition(checkpoint, checkpointPath, {
		type: "reset_completed",
		taskId: result.taskId,
		attempt: 1,
		provider: result.provider,
		model: result.model,
		resolvedTargetId: result.resolvedTargetId,
		invocationDescriptor: result.invocationDescriptor,
		descriptorIdentity: result.descriptorIdentity,
		descriptorHarness: result.descriptorHarness,
	});
	if (emitStatus) {
		emitStatus({
			phase: "checkpoint",
			event: "state_reset",
			status: `Reset working tree before retrying task ${result.taskId}`,
			taskId: result.taskId,
		});
	}
	return null;
}

export function recordHalt(
	checkpoint,
	checkpointPath,
	results,
	haltResult,
	emitStatus,
) {
	const safeFailure = failureMetadataFor(haltResult);
	results.push(haltResult);
	checkpoint.results.push({
		taskId: haltResult.taskId,
		provider: haltResult.provider,
		model: haltResult.model,
		result: haltResult.result,
		action: haltResult.action,
		success: haltResult.success,
		timedOut: false,
		partialDiffPath: null,
		...(safeFailure ?? {}),
		timestamp: new Date().toISOString(),
	});
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
	if (emitStatus) {
		emitStatus({
			phase: "lifecycle",
			event: "queue_halted",
			status: `Queue halted after task ${haltResult.taskId}: ${safeFailure?.reason ?? "The queue halted after a checkpoint action failure."}`,
			taskId: haltResult.taskId,
			error: safeFailure ? { message: safeFailure.reason } : undefined,
			errorKind: safeFailure?.errorKind,
			reasonCode: safeFailure?.reasonCode,
		});
	}
}

export function _installOwnedContainerSignalCleanup(containerName, wipeFn) {
	const handler = (signal) => {
		try {
			wipeFn(containerName);
		} catch {
			/* best effort — recover is the backstop */
		}
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
		// Re-raise with default disposition so the exit status reflects the signal.
		process.kill(process.pid, signal);
	};
	process.on("SIGINT", handler);
	process.on("SIGTERM", handler);
	return () => {
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
	};
}

export function throwOnEmptyParse(tasksFilePath, checkpointPath, emitStatus) {
	const message =
		`runQueue: no tasks parsed from ${tasksFilePath} — 0 headings matching ` +
		`"### Task <id>: <title>" were found. Expected format:\n` +
		`### Task <id>: <title>\n- **Status:** pending\n- **Description:** ...`;
	const failureCheckpoint = createEmptyCheckpoint(tasksFilePath);
	failureCheckpoint.parseError = {
		message: "no tasks parsed",
		tasksFilePath,
		detectedHeadings: 0,
		expectedFormat: "### Task <id>: <title>",
	};
	failureCheckpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, failureCheckpoint);
	if (emitStatus) {
		emitStatus({
			phase: "bootstrap",
			event: "parse_failed",
			status: message,
			error: { tasksFilePath, detectedHeadings: 0 },
		});
	}
	throw new Error(message);
}

export const DEFAULT_ADAPTERS = {
	claude: {
		execute: executeClaude,
		executeAsync: executeClaudeAsync,
		captureDiff: captureClaudeDiff,
		captureDiffAsync: captureClaudeDiffAsync,
		captureDiffDetailed: captureClaudeDiffDetailed,
		captureDiffDetailedAsync: captureClaudeDiffDetailedAsync,
	},
	codex: {
		execute: executeCodex,
		executeAsync: executeCodexAsync,
		captureDiff: captureCodexDiff,
		captureDiffAsync: captureCodexDiffAsync,
		captureDiffDetailed: captureCodexDiffDetailed,
		captureDiffDetailedAsync: captureCodexDiffDetailedAsync,
	},
	agy: {
		execute: executeAgy,
		executeAsync: executeAgyAsync,
		captureDiff: captureAgyDiff,
		captureDiffAsync: captureAgyDiffAsync,
		captureDiffDetailed: captureAgyDiffDetailed,
		captureDiffDetailedAsync: captureAgyDiffDetailedAsync,
	},
	cursor: {
		execute: executeCursor,
		executeAsync: executeCursorAsync,
		captureDiff: captureCursorDiff,
		captureDiffAsync: captureCursorDiffAsync,
		captureDiffDetailed: captureCursorDiffDetailed,
		captureDiffDetailedAsync: captureCursorDiffDetailedAsync,
	},
	copilot: {
		execute: executeCopilot,
		executeAsync: executeCopilotAsync,
		captureDiff: captureCopilotDiff,
		captureDiffAsync: captureCopilotDiffAsync,
		captureDiffDetailed: captureCopilotDiffDetailed,
		captureDiffDetailedAsync: captureCopilotDiffDetailedAsync,
	},
	opencode: {
		execute: executeOpencode,
		executeAsync: executeOpencodeAsync,
		captureDiff: captureOpencodeDiff,
		captureDiffAsync: captureOpencodeDiffAsync,
		captureDiffDetailed: captureOpencodeDiffDetailed,
		captureDiffDetailedAsync: captureOpencodeDiffDetailedAsync,
	},
	vibe: {
		execute: executeVibe,
		executeAsync: executeVibeAsync,
		captureDiff: captureVibeDiff,
		captureDiffAsync: captureVibeDiffAsync,
		captureDiffDetailed: captureVibeDiffDetailed,
		captureDiffDetailedAsync: captureVibeDiffDetailedAsync,
	},
};
