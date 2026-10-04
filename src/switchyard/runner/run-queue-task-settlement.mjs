import {
	reserveTaskAttempt,
	saveGateEvidence,
	savePartialDiff,
} from "./artifacts.mjs";
import { saveCheckpoint } from "./checkpoint-store.mjs";
import { enforceQuickCheckCompletion } from "./checks.mjs";
import { DISPATCH_DESCRIPTOR_CONTRACT_VERSION } from "./constants.mjs";
import {
	_safeError,
	commitOrResetWorkingContainer,
	recordHalt,
} from "./halts.mjs";
import { descriptorReceiptFields } from "./ledger-reporting.mjs";
import { failureMetadataFor, normalizeRetryTargetId } from "./quick-checks.mjs";
import {
	appendRetryAttempt,
	persistRetryTransition,
	recordExtraProviderInvocationResult,
} from "./retry-transitions.mjs";
import { opaqueArtifactRef } from "./review-results.mjs";
import {
	isRouteHealthDeferredResult,
	reportRouteHealthDeferred,
} from "./route-health.mjs";
import {
	finalizeTaskBase,
	persistProviderCleanupUncertain,
	providerCleanupHalt,
} from "./task-base.mjs";
import { decorateDirtyOverlayResult } from "./task-routing.mjs";

export function settleRunQueueTask(scope, queueState) {
	const {
		checkpoint,
		checkpointPath,
		results,
		emitStatus,
		deferredTaskIds,
		onResult,
		onCheckpointSaved,
		effectiveStopOnFailure,
		ownsWorkingContainer,
		workingContainerName,
		queueBackend,
		runStore,
		projectRetryState,
		context,
	} = scope;
	let { processed, halted, policyDeferred } = queueState;
	const {
		task,
		retryState,
		priorExtraAllocation,
		result,
		retryHaltResult,
		retryUsed,
		retryTargetId,
		retryEvidenceMissing,
	} = queueState.attempt;
	try {
		if (retryHaltResult) {
			recordHalt(
				checkpoint,
				checkpointPath,
				results,
				retryHaltResult,
				emitStatus,
			);
			processed += 1;
			halted = true;
			return { action: "break" };
		}
		if (retryUsed) {
			appendRetryAttempt(checkpoint, result, 2);
		}
		recordExtraProviderInvocationResult(checkpoint, checkpointPath, task.id);
		if (context._activeInvocationDescriptor) {
			Object.assign(
				result,
				descriptorReceiptFields(context._activeInvocationDescriptor),
			);
		}
		if (result?.result === "policy_deferred") {
			deferredTaskIds.push(result.taskId);
			policyDeferred = result.policyDeferred;
			return { action: "break" };
		}
		decorateDirtyOverlayResult(result, context);
		if (isRouteHealthDeferredResult(result)) {
			deferredTaskIds.push(result.taskId);
			reportRouteHealthDeferred(result, onResult, emitStatus);
			return { action: "continue" };
		}
		const resultAttempt = reserveTaskAttempt(
			checkpoint,
			checkpointPath,
			result.taskId,
		);
		enforceQuickCheckCompletion(task, result, resultAttempt, checkpoint);
		if (result.partialDiff) {
			try {
				result.partialDiffPath = savePartialDiff(
					checkpointPath,
					result.taskId,
					result.partialDiff,
					resultAttempt,
				);
				if (emitStatus) {
					emitStatus({
						phase: "execution",
						event: "partial_diff_captured",
						status: result.timedOut
							? `Task ${result.taskId} timed out; partial diff saved for review (not applied)`
							: `Task ${result.taskId} was rejected (${result.result}); diff saved for review (not applied)`,
						taskId: result.taskId,
						partialDiffPath: result.partialDiffPath,
						byteCount: result.partialDiff.length,
					});
				}
			} catch (error) {
				console.error(
					`runQueue: could not save diff artifact for task ${result.taskId}: ${error.message}`,
				);
			}
			// Raw diff text stays out of checkpoint.json / onResult payloads —
			// the artifact on disk (partialDiffPath) is the single copy.
			result.partialDiff = undefined;
		} else if (result.timedOut && result.captureStatus !== "empty") {
			// The rescue attempt itself came up empty (no edits were made
			// before the kill, or diff capture failed — e.g. a container in a
			// state git couldn't diff). Distinct from the diff-captured case so
			// this doesn't collapse into a generic task_failed: an operator
			// needs to know whether their in-progress work was actually saved,
			// not just that the task didn't finish.
			if (emitStatus) {
				emitStatus({
					phase: "execution",
					event: "partial_diff_capture_failed",
					status: `Task ${result.taskId} timed out; no diff was recovered (${result.captureStatus ?? "unknown"})`,
					taskId: result.taskId,
					captureStatus: result.captureStatus ?? "unknown",
				});
			}
		}
		if (result.gateEvidence) {
			try {
				result.gateEvidencePath = saveGateEvidence(
					checkpointPath,
					result.taskId,
					result.gateEvidence,
					resultAttempt,
				);
			} catch (error) {
				console.error(
					`runQueue: could not save gate evidence for task ${result.taskId}: ${error.message}`,
				);
				result.gateEvidencePath = null;
			}
			// Same rule as the diff above: host-only bytes, never onResult.
			result.gateEvidence = undefined;
		}
		persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
		if (onResult) onResult(result);
		const safeFailure = failureMetadataFor(result, result.partialDiffPath);
		if (emitStatus) {
			if (result.success) {
				emitStatus({
					phase: "execution",
					event: "task_completed",
					status: `Task ${result.taskId} completed`,
					taskId: result.taskId,
					provider: result.provider ?? null,
					model: result.model ?? null,
				});
			} else {
				emitStatus({
					phase: "execution",
					event: "task_failed",
					status: `Task ${result.taskId} failed: ${result.result}`,
					taskId: result.taskId,
					provider: result.provider ?? null,
					model: result.model ?? null,
					error: safeFailure ? { message: safeFailure.reason } : undefined,
					errorKind: safeFailure?.errorKind,
					reasonCode: safeFailure?.reasonCode,
					reason: safeFailure?.reason,
					artifactRef: safeFailure?.artifactRef,
					...(safeFailure?.diagnosticCode
						? { diagnosticCode: safeFailure.diagnosticCode }
						: {}),
					...(safeFailure?.diagnosticOrigin
						? {
								diagnosticOrigin: safeFailure.diagnosticOrigin,
								diagnosticEvidenceAvailable:
									safeFailure.diagnosticEvidenceAvailable,
							}
						: {}),
					...(safeFailure?.diagnosticRef
						? { diagnosticRef: safeFailure.diagnosticRef }
						: {}),
				});
			}
		}
		results.push(result);
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
			partialDiffPath: null,
			...(safeFailure ?? {}),
			...(opaqueArtifactRef(result.artifactRef)
				? { artifactRef: opaqueArtifactRef(result.artifactRef) }
				: {}),
			timestamp: new Date().toISOString(),
		});
		checkpoint.lastTaskId = result.taskId;
		checkpoint.lastUpdatedAt = new Date().toISOString();

		if (result.success) {
			checkpoint.completedTaskIds.push(result.taskId);
		}
		if (retryUsed) {
			persistRetryTransition(checkpoint, checkpointPath, {
				type: "finalized",
				taskId: result.taskId,
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
		}

		try {
			saveCheckpoint(checkpointPath, checkpoint);
		} catch (error) {
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_failed",
					status: `Checkpoint save failed: ${error.message}`,
					taskId: result.taskId,
					error: _safeError(error),
				});
			}
			throw error;
		}
		projectRetryState();
		if (emitStatus) {
			emitStatus({
				phase: "checkpoint",
				event: "checkpoint_saved",
				status: `Checkpoint saved after task ${result.taskId}`,
				taskId: result.taskId,
			});
		}
		if (onCheckpointSaved) onCheckpointSaved();

		// The checkpoint/result bookkeeping block above runs ahead of the
		// working-container commit/reset below: a commit or reset failure (or
		// a crash mid-commit) must never leave a task whose execute succeeded
		// missing from the durable checkpoint (INV-6). The result and
		// completedTaskIds are on disk before commit is even attempted.
		let haltResult =
			result.cleanupFailed === true ? providerCleanupHalt(result) : null;
		if (!haltResult)
			haltResult = commitOrResetWorkingContainer(result, {
				ownsWorkingContainer,
				workingContainerName,
				stopOnFailure: effectiveStopOnFailure,
				commitWorkingTreeFn: queueBackend.commit,
				resetWorkingTreeFn: queueBackend.reset,
				emitStatus,
				logPrefix: "runQueue: ",
			});
		if (!haltResult) {
			haltResult = finalizeTaskBase(
				context,
				result.taskId,
				checkpoint,
				checkpointPath,
			);
		}
		if (runStore) {
			runStore.updateRun({}).catch(() => {});
		}
		processed += 1;

		// A commit/reset failure leaves the owned working container in a
		// state INV-3 forbids reusing (an unadvanced baseline or a failed
		// task's un-reset changes), so the run must halt here — after this
		// task's checkpoint/bookkeeping and failure handling — before the
		// next task's execute/gate/capture can begin. The completed task's
		// checkpoint stays durable for a later invocation on a fresh
		// container; the halt itself is recorded as a distinct outcome.
		if (haltResult) {
			recordHalt(checkpoint, checkpointPath, results, haltResult, emitStatus);
			halted = true;
			return { action: "break" };
		}

		if (!result.success && effectiveStopOnFailure) {
			return { action: "break" };
		}
	} finally {
		Object.assign(queueState, { processed, halted, policyDeferred });
	}
	return { action: "continue" };
}
