import { runCheckRepairSync } from "./check-repair.mjs";
import { executeTask, runCompletionCorrection } from "./execute-task.mjs";
import { resetBeforeQuotaRetry } from "./halts.mjs";
import { descriptorReceiptFields } from "./ledger-reporting.mjs";
import { selectNextQueueTask } from "./queue-selection.mjs";
import {
	hasTrustedQuotaRetryEvidence,
	normalizeRetryTargetId,
} from "./quick-checks.mjs";
import {
	allocateExtraProviderInvocation,
	appendRetryAttempt,
	ensureProviderAttemptAllocations,
	isQuotaRetryCandidate,
	mergeRetryExclusions,
	persistRetryTransition,
	startExtraProviderInvocation,
} from "./retry-transitions.mjs";

export function attemptRunQueueTask(scope, queueState) {
	const {
		checkpoint,
		selectionOptions,
		tasks,
		attemptedTaskIds,
		onTaskStart,
		runStore,
		emitStatus,
		effectiveExclude,
		checkpointPath,
		workingContainerName,
		queueBackend,
		ownsWorkingContainer,
		projectRetryState,
		context,
	} = scope;
	let { resumedRetryTaskId } = queueState;
	const selection = selectNextQueueTask(tasks, checkpoint, {
		...selectionOptions,
		excludedTaskIds: attemptedTaskIds,
		retryTaskId: resumedRetryTaskId,
	});
	const task = selection.task;
	if (!task) return { action: "break" };
	resumedRetryTaskId = selection.retryTaskId;
	attemptedTaskIds.clear();
	for (const taskId of selection.excludedTaskIds) attemptedTaskIds.add(taskId);
	const retryState =
		checkpoint.retryState?.taskId === task.id ? checkpoint.retryState : null;
	const priorExtraAllocation = ensureProviderAttemptAllocations(
		checkpoint,
	).find((entry) => entry?.taskId === task.id);
	context._activeInvocationDescriptor = null;

	if (onTaskStart) onTaskStart(task);
	if (runStore) {
		runStore
			.updateRun({ activeTaskId: task.id })
			.then((upd) => {
				runStore._rev = upd.revision;
			})
			.catch(() => {});
	}
	if (emitStatus) {
		emitStatus({
			phase: "execution",
			event: "task_started",
			status: `Starting task ${task.id}`,
			taskId: task.id,
		});
	}
	context.exclude = mergeRetryExclusions(
		effectiveExclude,
		checkpoint.quarantinedTargetIds,
	);
	const executeProviderTask = scope.executeTask ?? executeTask;
	let result;
	let retryHaltResult = null;
	let retryUsed = Boolean(retryState);
	let retryTargetId = retryState?.resolvedTargetId ?? null;
	const retryEvidenceMissing =
		Boolean(retryState) && !hasTrustedQuotaRetryEvidence(retryState);
	if (!retryState && priorExtraAllocation) {
		result = {
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			result: "unknown_failure",
			errorKind: "unknown_failure",
			reason: "persisted extra provider invocation already consumed",
		};
	} else if (retryEvidenceMissing) {
		// Historical model-only retry state is readable, but it cannot
		// authorize a retry against an exact descriptor/target. Halt before
		// reset, reroute, or adapter invocation; the normal finally path
		// still releases the run/project locks.
		result = {
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			resolvedTargetId: retryState.resolvedTargetId ?? null,
			result: "unknown_failure",
			errorKind: "unknown_failure",
			reason:
				"historical retry state lacks trusted quota diagnostic provenance",
		};
	} else if (retryState) {
		const resumedTargetId = normalizeRetryTargetId(retryState.resolvedTargetId);
		if (
			resumedTargetId &&
			!checkpoint.quarantinedTargetIds.includes(resumedTargetId)
		) {
			// A crash can land after attempt_recorded but before the
			// separate quarantine transition. Reconstruct the safety
			// invariant before any reset/reroute so resume cannot select
			// the exhausted target again.
			checkpoint.quarantinedTargetIds = [
				...checkpoint.quarantinedTargetIds,
				resumedTargetId,
			];
			persistRetryTransition(checkpoint, checkpointPath, {
				type: "target_quarantined",
				taskId: task.id,
				attempt: 1,
				resolvedTargetId: resumedTargetId,
				invocationDescriptor: retryState.invocationDescriptor,
				descriptorIdentity: retryState.descriptorIdentity,
				descriptorHarness: retryState.descriptorHarness,
			});
			projectRetryState();
		}
		if (retryState.phase === "retry_halted") {
			result = {
				taskId: task.id,
				success: false,
				provider: null,
				model: null,
				result: "unknown_failure",
				errorKind: "unknown_failure",
			};
		} else if (retryState.phase === "retry_started") {
			// A provider may already have run when the process died after
			// this transition. Never spend a third attempt; fail closed.
			result = {
				taskId: task.id,
				success: false,
				provider: null,
				model: null,
				result: "unknown_failure",
				errorKind: "unknown_failure",
			};
		} else {
			if (retryState.phase !== "reset_completed") {
				retryHaltResult = resetBeforeQuotaRetry({
					result: {
						taskId: task.id,
						provider: null,
						model: null,
						resolvedTargetId: retryState.resolvedTargetId,
						invocationDescriptor: retryState.invocationDescriptor,
						descriptorIdentity: retryState.descriptorIdentity,
						descriptorHarness: retryState.descriptorHarness,
					},
					checkpoint,
					checkpointPath,
					workingContainerName,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus,
				});
				projectRetryState();
			}
			if (!retryHaltResult) {
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "retry_started",
					taskId: task.id,
					attempt: 2,
					resolvedTargetId: retryState.resolvedTargetId,
					invocationDescriptor: retryState.invocationDescriptor,
					descriptorIdentity: retryState.descriptorIdentity,
					descriptorHarness: retryState.descriptorHarness,
				});
				projectRetryState();
				context.exclude = mergeRetryExclusions(
					effectiveExclude,
					checkpoint.quarantinedTargetIds,
				);
				startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
				result = executeProviderTask(task, context);
			}
		}
	} else {
		result = executeProviderTask(task, context);
		if (context._activeInvocationDescriptor) {
			Object.assign(
				result,
				descriptorReceiptFields(context._activeInvocationDescriptor),
			);
		}
		result = runCompletionCorrection(
			task,
			context,
			result,
			checkpoint,
			checkpointPath,
		);
		result = runCheckRepairSync({
			task,
			result,
			context,
			checkpoint,
			checkpointPath,
			execute: executeProviderTask,
		});
		if (
			result._routeHealthTrialStarted !== true &&
			result.extraProviderInvocationUsed !== true &&
			isQuotaRetryCandidate(result, ownsWorkingContainer) &&
			allocateExtraProviderInvocation(
				checkpoint,
				checkpointPath,
				task.id,
				"quota_fallback",
			)
		) {
			const targetId = normalizeRetryTargetId(result.resolvedTargetId);
			retryUsed = true;
			retryTargetId = targetId;
			appendRetryAttempt(checkpoint, result, 1);
			persistRetryTransition(checkpoint, checkpointPath, {
				type: "attempt_recorded",
				taskId: task.id,
				attempt: 1,
				provider: result.provider,
				model: result.model,
				resolvedTargetId: targetId,
				invocationDescriptor: result.invocationDescriptor,
				descriptorIdentity: result.descriptorIdentity,
				descriptorHarness: result.descriptorHarness,
				diagnosticCode: result.diagnosticCode,
				diagnosticOrigin: result.diagnosticOrigin,
				diagnosticEvidenceAvailable: result.diagnosticEvidenceAvailable,
				diagnosticRef: result.diagnosticRef,
				failurePhase: result.failurePhase,
			});
			projectRetryState();
			checkpoint.quarantinedTargetIds = [
				...new Set([...checkpoint.quarantinedTargetIds, targetId]),
			];
			persistRetryTransition(checkpoint, checkpointPath, {
				type: "target_quarantined",
				taskId: task.id,
				attempt: 1,
				provider: result.provider,
				model: result.model,
				resolvedTargetId: targetId,
				invocationDescriptor: result.invocationDescriptor,
				descriptorIdentity: result.descriptorIdentity,
				descriptorHarness: result.descriptorHarness,
			});
			projectRetryState();
			if (emitStatus) {
				emitStatus({
					phase: "execution",
					event: "target_quarantined",
					status: `Quarantined ${targetId} after quota exhaustion`,
					taskId: task.id,
					provider: result.provider,
					model: result.model,
					resolvedTargetId: targetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
				});
			}
			retryHaltResult = resetBeforeQuotaRetry({
				result,
				checkpoint,
				checkpointPath,
				workingContainerName,
				resetWorkingTreeFn: queueBackend.reset,
				emitStatus,
			});
			projectRetryState();
			if (!retryHaltResult) {
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "retry_started",
					taskId: task.id,
					attempt: 2,
					provider: result.provider,
					model: result.model,
					resolvedTargetId: targetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
				});
				projectRetryState();
				context.exclude = mergeRetryExclusions(
					effectiveExclude,
					checkpoint.quarantinedTargetIds,
				);
				startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
				result = executeProviderTask(task, context);
			}
		}
	}
	queueState.resumedRetryTaskId = resumedRetryTaskId;
	queueState.attempt = {
		task,
		retryState,
		priorExtraAllocation,
		result,
		retryHaltResult,
		retryUsed,
		retryTargetId,
		retryEvidenceMissing,
	};
	return { action: "settle" };
}
