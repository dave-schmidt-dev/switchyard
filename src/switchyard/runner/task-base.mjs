import { readFileSync } from "node:fs";
import { validateCheckpointV3 } from "./checkpoint-load.mjs";
import {
	acquireCheckpointLease,
	assertCheckpointLease,
	releaseCheckpointLease,
	saveCheckpoint,
} from "./checkpoint-store.mjs";
import { descriptorReceiptFields } from "./ledger-reporting.mjs";
import {
	integrationOperation,
	persistedTaskBaseHelperContext,
	taskBaseProbeOptions,
} from "./review-results.mjs";
import { mergeAttemptCleanupContext } from "./route-health.mjs";

function sameIntegrationOperation(left, right) {
	return (
		left?.runId === right?.runId &&
		left?.taskId === right?.taskId &&
		left?.attempt === right?.attempt &&
		left?.baseTree === right?.baseTree &&
		left?.patchHash === right?.patchHash &&
		JSON.stringify(left?.paths) === JSON.stringify(right?.paths) &&
		(left?.dirtyOverlayReceiptHash ?? null) ===
			(right?.dirtyOverlayReceiptHash ?? null)
	);
}
function checkpointIntegrationIntent(context, task, diff) {
	const operation = integrationOperation(context, task, diff);
	if (!operation) return undefined;
	const read = (candidate, lease) => {
		assertCheckpointLease(
			lease,
			context.checkpointPath,
			context.checkpoint.owner,
		);
		const disk = JSON.parse(readFileSync(context.checkpointPath, "utf8"));
		validateCheckpointV3(disk, context.checkpoint.tasksFilePath, {
			checkpointOwner: context.checkpoint.owner,
		});
		const proof = disk.integrationIntents?.[task.id] ?? null;
		if (proof && !sameIntegrationOperation(proof.operation, candidate))
			return proof;
		return proof ? structuredClone(proof) : null;
	};
	const persist = (proof, lease) => {
		const checkpoint = context.checkpoint;
		const existing = checkpoint.integrationIntents?.[task.id];
		if (
			existing ||
			!sameIntegrationOperation(proof.operation, operation) ||
			proof.status !== "pending"
		)
			return null;
		checkpoint.integrationIntents ??= {};
		checkpoint.taskAttempts ??= {};
		checkpoint.integrationIntents[task.id] = structuredClone(proof);
		checkpoint.taskAttempts[task.id] = operation.attempt;
		checkpoint.lastUpdatedAt = new Date().toISOString();
		try {
			saveCheckpoint(context.checkpointPath, checkpoint, { lease });
			return read(operation, lease);
		} catch {
			return null;
		}
	};
	const complete = (proof, lease) => {
		const entry = context.checkpoint.integrationIntents?.[task.id];
		if (
			!sameIntegrationOperation(entry?.operation, proof.operation) ||
			entry?.status !== "pending" ||
			proof.status !== "completed"
		)
			return null;
		context.checkpoint.integrationIntents[task.id] = structuredClone(proof);
		context.checkpoint.lastUpdatedAt = new Date().toISOString();
		try {
			saveCheckpoint(context.checkpointPath, context.checkpoint, { lease });
			return read(operation, lease);
		} catch {
			return null;
		}
	};
	return {
		operation,
		acquire: () =>
			acquireCheckpointLease(context.checkpointPath, context.checkpoint.owner),
		release: releaseCheckpointLease,
		persist,
		complete,
		read,
	};
}
function prepareTaskBase(context, task, cleanupContext) {
	try {
		const existing = context.taskBases?.[task.id] ?? null;
		if (
			existing &&
			(existing.dirtyOverlayReceiptHash ?? null) !==
				(context.dirtyOverlayReceipt?.receiptHash ?? null)
		)
			throw new Error("dirty overlay receipt changed for persisted task base");
		const helperContext = mergeAttemptCleanupContext(cleanupContext, {
			operation: "helper",
		});
		if (existing) persistedTaskBaseHelperContext(existing, helperContext);
		const base = existing
			? context.queueBackend.validateTaskBase(
					context.workingContainerName,
					existing,
					taskBaseProbeOptions(context, helperContext),
				)
			: context.queueBackend.captureTaskBase(context.workingContainerName, {
					runId: context.runId,
					taskId: task.id,
					...taskBaseProbeOptions(context, helperContext),
				});
		const recordedBase = existing ?? {
			...base,
			cleanupContext: helperContext,
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		};
		context.persistTaskBase?.(task.id, recordedBase);
		context._activeTaskBase = recordedBase;
		context._activeTaskHelperContext = helperContext;
		return recordedBase;
	} catch {
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_failed",
			status: `Task ${task.id} immutable base capture failed`,
			taskId: task.id,
		});
		return null;
	}
}
async function prepareTaskBaseAsync(context, task, cleanupContext) {
	try {
		const existing = context.taskBases?.[task.id] ?? null;
		if (
			existing &&
			(existing.dirtyOverlayReceiptHash ?? null) !==
				(context.dirtyOverlayReceipt?.receiptHash ?? null)
		)
			throw new Error("dirty overlay receipt changed for persisted task base");
		const helperContext = mergeAttemptCleanupContext(cleanupContext, {
			operation: "helper",
		});
		if (existing) persistedTaskBaseHelperContext(existing, helperContext);
		const validateAsync =
			context.queueBackend.validateTaskBaseAsync ??
			((...args) => context.queueBackend.validateTaskBase(...args));
		const captureAsync =
			context.queueBackend.captureTaskBaseAsync ??
			((...args) => context.queueBackend.captureTaskBase(...args));
		const base = existing
			? await validateAsync(
					context.workingContainerName,
					existing,
					taskBaseProbeOptions(context, helperContext),
				)
			: await captureAsync(context.workingContainerName, {
					runId: context.runId,
					taskId: task.id,
					...taskBaseProbeOptions(context, helperContext),
				});
		const recordedBase = existing ?? {
			...base,
			cleanupContext: helperContext,
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		};
		context.persistTaskBase?.(task.id, recordedBase);
		context._activeTaskBase = recordedBase;
		context._activeTaskHelperContext = helperContext;
		return recordedBase;
	} catch {
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_failed",
			status: `Task ${task.id} immutable base capture failed`,
			taskId: task.id,
		});
		return null;
	}
}
function taskBaseReleaseDiagnosticCode(error) {
	const message = String(error?.message ?? "");
	if (message.startsWith("persisted task base"))
		return "task_base_release_ownership_invalid";
	if (message.includes("process marker requires an exact attempt identity"))
		return "task_base_release_marker_invalid";
	if (message.includes("task base probe aborted"))
		return "task_base_release_aborted";
	if (error?.code === "ETIMEDOUT") return "task_base_release_timed_out";
	if (/PrlJob_Get(?:RetCode|Result):\s*Invalid argument/iu.test(message))
		return "task_base_release_transport_lost";
	return "task_base_release_failed";
}
function taskBaseReleaseHalt(taskId, error) {
	return {
		taskId,
		success: false,
		provider: null,
		model: null,
		result: "halted_after_task_base_release_failure",
		errorKind: "diff_capture_failed",
		reason: "immutable task base release is uncertain; recovery required",
		diagnosticCode: taskBaseReleaseDiagnosticCode(error),
	};
}
function providerCleanupHalt(result) {
	return {
		taskId: result.taskId,
		success: false,
		provider: result.provider ?? null,
		model: result.model ?? null,
		result: "halted_after_provider_cleanup_failure",
		errorKind: "provider_cleanup_failed",
		reason: "provider cleanup is uncertain; recovery required",
		cleanupFailed: true,
		cleanupStage: result.cleanupStage ?? null,
	};
}
function markProviderCleanupUncertain(checkpoint, result) {
	if (result.cleanupFailed !== true) return;
	checkpoint.providerCleanupUncertain = {
		taskId: result.taskId,
		cleanupStage: result.cleanupStage ?? null,
	};
}
function persistProviderCleanupUncertain(checkpoint, result, checkpointPath) {
	if (result.cleanupFailed !== true) return;
	markProviderCleanupUncertain(checkpoint, result);
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
}
function assertCheckpointRecoverySafe(checkpoint) {
	const marker = checkpoint.taskBaseReleaseUncertain
		? "immutable task base release"
		: checkpoint.providerCleanupUncertain
			? "provider cleanup"
			: null;
	if (!marker) return;
	const error = new Error(
		`checkpoint records uncertain ${marker}; explicit recovery is required`,
	);
	error.code = "recovery_required";
	throw error;
}
function finalizeTaskBase(context, taskId, checkpoint, checkpointPath) {
	const base = checkpoint.taskBases?.[taskId];
	if (!base) return null;
	try {
		const helperContext = context._activeTaskHelperContext;
		persistedTaskBaseHelperContext(base, helperContext ?? {});
		context.queueBackend.releaseTaskBase(
			context.workingContainerName,
			base,
			taskBaseProbeOptions(context, helperContext),
		);
		delete checkpoint.taskBases[taskId];
		if (checkpoint.taskBaseReleaseUncertain?.taskId === taskId) {
			delete checkpoint.taskBaseReleaseUncertain;
		}
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_released",
			status: `Task ${taskId} immutable base released`,
			taskId,
		});
		return null;
	} catch (error) {
		checkpoint.taskBaseReleaseUncertain = {
			taskId,
			...base,
			diagnosticCode: taskBaseReleaseDiagnosticCode(error),
		};
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_release_failed",
			status: `Task ${taskId} immutable base release uncertain; recovery required`,
			taskId,
		});
		return taskBaseReleaseHalt(taskId, error);
	}
}
async function finalizeTaskBaseAsync(
	context,
	taskId,
	checkpoint,
	checkpointPath,
) {
	const base = checkpoint.taskBases?.[taskId];
	if (!base) return null;
	try {
		const helperContext = context._activeTaskHelperContext;
		persistedTaskBaseHelperContext(base, helperContext ?? {});
		const releaseAsync =
			context.queueBackend.releaseTaskBaseAsync ??
			((...args) => context.queueBackend.releaseTaskBase(...args));
		await releaseAsync(
			context.workingContainerName,
			base,
			taskBaseProbeOptions(context, helperContext),
		);
		delete checkpoint.taskBases[taskId];
		if (checkpoint.taskBaseReleaseUncertain?.taskId === taskId) {
			delete checkpoint.taskBaseReleaseUncertain;
		}
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_released",
			status: `Task ${taskId} immutable base released`,
			taskId,
		});
		return null;
	} catch (error) {
		checkpoint.taskBaseReleaseUncertain = {
			taskId,
			...base,
			diagnosticCode: taskBaseReleaseDiagnosticCode(error),
		};
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_release_failed",
			status: `Task ${taskId} immutable base release uncertain; recovery required`,
			taskId,
		});
		return taskBaseReleaseHalt(taskId, error);
	}
}
function taskBaseFailure(
	task,
	routeResult,
	invocationDescriptor,
	requiredCapability,
) {
	return {
		...descriptorReceiptFields(invocationDescriptor),
		taskId: task.id,
		success: false,
		provider: routeResult.provider ?? null,
		model: invocationDescriptor?.selector ?? routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId: routeResult.resolvedTargetId ?? null,
		result: "task_base_capture_failed",
		errorKind: "diff_capture_failed",
		reason: "immutable task base capture failed",
	};
}
function taskBaseMatches(actual, expected) {
	return (
		actual !== null &&
		typeof actual === "object" &&
		actual.ref === expected?.ref &&
		actual.tree === expected?.tree
	);
}

export {
	assertCheckpointRecoverySafe,
	checkpointIntegrationIntent,
	finalizeTaskBase,
	finalizeTaskBaseAsync,
	persistProviderCleanupUncertain,
	prepareTaskBase,
	prepareTaskBaseAsync,
	providerCleanupHalt,
	taskBaseFailure,
	taskBaseMatches,
};
