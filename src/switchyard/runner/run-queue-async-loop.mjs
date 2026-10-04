import {
	persistAsyncResultArtifacts,
	reserveTaskAttempt,
} from "./artifacts.mjs";
import { runCheckRepairAsync } from "./check-repair.mjs";
import { saveCheckpoint } from "./checkpoint-store.mjs";
import { enforceQuickCheckCompletion } from "./checks.mjs";
import { DISPATCH_DESCRIPTOR_CONTRACT_VERSION } from "./constants.mjs";
import { executeTaskAsync } from "./execute-task.mjs";
import {
	commitOrResetWorkingContainer,
	recordHalt,
	resetBeforeQuotaRetry,
} from "./halts.mjs";
import { selectNextQueueTask } from "./queue-selection.mjs";
import {
	failureMetadataFor,
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
	recordExtraProviderInvocationResult,
	startExtraProviderInvocation,
} from "./retry-transitions.mjs";
import { opaqueArtifactRef } from "./review-results.mjs";
import {
	isRouteHealthDeferredResult,
	reportRouteHealthDeferred,
} from "./route-health.mjs";
import {
	finalizeTaskBaseAsync,
	persistProviderCleanupUncertain,
	providerCleanupHalt,
} from "./task-base.mjs";
import { decorateDirtyOverlayResult } from "./task-routing.mjs";

export async function runQueueAsyncLoop(scope, queueState) {
	const {
		checkpoint,
		effectiveMaxTasks,
		effectiveExclude,
		effectiveTaskIds,
		tasks,
		attemptedTaskIds,
		dependencies,
		checkpointPath,
		workingContainerName,
		queueBackend,
		ownsWorkingContainer,
		results,
		deferredTaskIds,
		effectiveStopOnFailure,
		projectRetryState,
		context,
	} = scope;
	let { processed, resumedRetryTaskId, policyDeferred } = queueState;
	const executeProviderTask = dependencies.executeTaskAsync ?? executeTaskAsync;
	while (processed < effectiveMaxTasks) {
		context.exclude = mergeRetryExclusions(
			effectiveExclude,
			checkpoint.quarantinedTargetIds,
		);
		const selection = selectNextQueueTask(tasks, checkpoint, {
			selectedTaskIds: effectiveTaskIds,
			resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
			excludedTaskIds: attemptedTaskIds,
			retryTaskId: resumedRetryTaskId,
		});
		const task = selection.task;
		if (!task) break;
		resumedRetryTaskId = selection.retryTaskId;
		attemptedTaskIds.clear();
		for (const taskId of selection.excludedTaskIds)
			attemptedTaskIds.add(taskId);
		dependencies.onTaskStart?.(task);
		const retryState =
			checkpoint.retryState?.taskId === task.id ? checkpoint.retryState : null;
		const priorExtraAllocation = ensureProviderAttemptAllocations(
			checkpoint,
		).find((entry) => entry?.taskId === task.id);
		let result;
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
		} else if (retryState && !hasTrustedQuotaRetryEvidence(retryState)) {
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
			persistRetryTransition(checkpoint, checkpointPath, {
				type: "finalized",
				taskId: task.id,
				attempt: retryState.attempt,
				resolvedTargetId: retryState.resolvedTargetId,
				clearState: true,
				save: false,
			});
			projectRetryState();
		} else if (
			retryState &&
			["retry_started", "retry_halted"].includes(retryState.phase)
		) {
			result = {
				taskId: task.id,
				success: false,
				provider: null,
				model: null,
				resolvedTargetId: retryState.resolvedTargetId ?? null,
				result: "unknown_failure",
				errorKind: "unknown_failure",
				reason:
					"persisted retry state already consumed the bounded retry attempt",
			};
			persistRetryTransition(checkpoint, checkpointPath, {
				type: "finalized",
				taskId: task.id,
				attempt: retryState.attempt,
				provider: retryState.provider,
				model: retryState.model,
				resolvedTargetId: retryState.resolvedTargetId,
				invocationDescriptor: retryState.invocationDescriptor,
				descriptorIdentity: retryState.descriptorIdentity,
				descriptorHarness: retryState.descriptorHarness,
				clearState: true,
				save: false,
			});
			projectRetryState();
		} else if (retryState) {
			const retryTargetId = normalizeRetryTargetId(retryState.resolvedTargetId);
			if (
				retryTargetId &&
				!checkpoint.quarantinedTargetIds.includes(retryTargetId)
			) {
				checkpoint.quarantinedTargetIds.push(retryTargetId);
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "target_quarantined",
					taskId: task.id,
					attempt: 1,
					resolvedTargetId: retryTargetId,
					invocationDescriptor: retryState.invocationDescriptor,
					descriptorIdentity: retryState.descriptorIdentity,
					descriptorHarness: retryState.descriptorHarness,
				});
				projectRetryState();
			}
			let retryHalt = null;
			if (retryState.phase !== "reset_completed") {
				retryHalt = resetBeforeQuotaRetry({
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
					emitStatus: dependencies.onStatus,
				});
				projectRetryState();
			}
			if (retryHalt) {
				result = retryHalt;
			} else {
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
				result = await executeProviderTask(task, context);
				appendRetryAttempt(checkpoint, result, 2);
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "finalized",
					taskId: task.id,
					attempt: 2,
					provider: result.provider,
					model: result.model,
					resolvedTargetId:
						result.invocationDescriptor?.target_id ??
						normalizeRetryTargetId(result.resolvedTargetId) ??
						retryTargetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
					clearState: true,
					save: false,
				});
				projectRetryState();
			}
		} else {
			result = await executeProviderTask(task, context);
		}
		if (!retryState && result?.result === "check_failed") {
			result = await runCheckRepairAsync({
				task,
				result,
				context,
				checkpoint,
				checkpointPath,
				execute: executeProviderTask,
				dependencies,
			});
		}
		if (result?.result === "policy_deferred") {
			policyDeferred = result.policyDeferred;
			deferredTaskIds.push(result.taskId);
			break;
		}
		decorateDirtyOverlayResult(result, context);
		if (
			!retryState &&
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
			const retryHalt = resetBeforeQuotaRetry({
				result,
				checkpoint,
				checkpointPath,
				workingContainerName,
				resetWorkingTreeFn: queueBackend.reset,
				emitStatus: dependencies.onStatus,
			});
			if (retryHalt) {
				result = retryHalt;
			} else {
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
				result = await executeProviderTask(task, context);
				appendRetryAttempt(checkpoint, result, 2);
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "finalized",
					taskId: task.id,
					attempt: 2,
					provider: result.provider,
					model: result.model,
					resolvedTargetId:
						result.invocationDescriptor?.target_id ??
						normalizeRetryTargetId(result.resolvedTargetId) ??
						targetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
					clearState: true,
					save: false,
				});
				projectRetryState();
			}
		}
		recordExtraProviderInvocationResult(checkpoint, checkpointPath, task.id);
		if (isRouteHealthDeferredResult(result)) {
			deferredTaskIds.push(result.taskId);
			reportRouteHealthDeferred(
				result,
				dependencies.onResult,
				dependencies.onStatus,
			);
			continue;
		}
		const resultAttempt = reserveTaskAttempt(
			checkpoint,
			checkpointPath,
			result.taskId,
		);
		enforceQuickCheckCompletion(task, result, resultAttempt, checkpoint);
		persistAsyncResultArtifacts({
			result,
			checkpointPath,
			resultAttempt,
			onStatus: dependencies.onStatus,
		});
		persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
		results.push(result);
		dependencies.onResult?.(result);
		const safeFailure = failureMetadataFor(result, result.partialDiffPath);
		checkpoint.results.push({
			taskId: result.taskId,
			attempt: resultAttempt,
			provider: result.provider,
			model: result.model,
			...(result.invocationDescriptor
				? {
						dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.invocationDescriptor.descriptor_identity,
						descriptorHarness: result.descriptorHarness ?? null,
						resolvedTargetId: result.resolvedTargetId ?? null,
					}
				: {}),
			result: result.result,
			...(result.quickCheckReceipt
				? { quickCheckReceipt: result.quickCheckReceipt }
				: {}),
			...(result.baselineCheckReceipt
				? { baselineCheckReceipt: result.baselineCheckReceipt }
				: {}),
			...(result.providerReliability
				? { providerReliability: result.providerReliability }
				: {}),
			...(result.failurePhase === "baseline"
				? { failurePhase: "baseline" }
				: {}),
			...(typeof result.servedModelVerified === "boolean"
				? { servedModelVerified: result.servedModelVerified }
				: {}),
			...(result.alreadyApplied ? { alreadyApplied: true } : {}),
			// Presence is the signal: these are written only when the provider
			// outlived its kill, so a resumed run and `switchyard status` can see
			// that an otherwise successful task left a process in the guest.
			...(result.cleanupFailed === true
				? {
						cleanupFailed: true,
						cleanupStage: result.cleanupStage ?? null,
					}
				: {}),
			success: result.success,
			dirtyOverlayReceiptHash: result.dirtyOverlayReceiptHash ?? null,
			timedOut: Boolean(result.timedOut),
			// The host path is transient; safeFailure carries only its opaque
			// artifactRef into the durable checkpoint.
			partialDiffPath: null,
			...(safeFailure ?? {}),
			...(opaqueArtifactRef(result.artifactRef)
				? { artifactRef: opaqueArtifactRef(result.artifactRef) }
				: {}),
			timestamp: new Date().toISOString(),
		});
		checkpoint.lastTaskId = result.taskId;
		if (result.success) checkpoint.completedTaskIds.push(result.taskId);
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		dependencies.onCheckpointSaved?.(checkpoint);
		let haltResult =
			result.cleanupFailed === true ? providerCleanupHalt(result) : null;
		if (!haltResult)
			haltResult = commitOrResetWorkingContainer(result, {
				ownsWorkingContainer,
				workingContainerName,
				stopOnFailure: effectiveStopOnFailure,
				commitWorkingTreeFn: queueBackend.commit,
				resetWorkingTreeFn: queueBackend.reset,
				emitStatus: dependencies.onStatus,
				logPrefix: "runQueueAsync: ",
			});
		if (!haltResult) {
			haltResult = await finalizeTaskBaseAsync(
				context,
				result.taskId,
				checkpoint,
				checkpointPath,
			);
		}
		processed += 1;
		if (haltResult) {
			recordHalt(
				checkpoint,
				checkpointPath,
				results,
				haltResult,
				dependencies.onStatus,
			);
			break;
		}
		if (
			!result.success &&
			!isRouteHealthDeferredResult(result) &&
			effectiveStopOnFailure
		)
			break;
	}
	Object.assign(queueState, { processed, resumedRetryTaskId, policyDeferred });
	return { action: "complete" };
}
