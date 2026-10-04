import { terminalTransition } from "../outcome/transitions.mjs";
import { reserveTaskAttempt } from "./artifacts.mjs";
import {
	releaseCheckpointOwnership,
	saveCheckpoint,
} from "./checkpoint-store.mjs";
import { enforceQuickCheckCompletion } from "./checks.mjs";
import {
	CHECKPOINT_VERSION,
	DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
} from "./constants.mjs";
import {
	descriptorReceiptFields,
	ledgerReportingContext,
	reportOutcomeProjectionFailure,
} from "./ledger-reporting.mjs";
import {
	getRunnableTasks,
	reconcileAlreadyCompleteSelection,
} from "./queue-selection.mjs";
import {
	failureMetadataFor,
	hasTrustedQuotaRetryEvidence,
} from "./quick-checks.mjs";
import { opaqueArtifactRef } from "./review-results.mjs";
import {
	attachRouteHealthTerminal,
	isRouteHealthDeferredResult,
	reportRouteHealthDeferred,
} from "./route-health.mjs";
import {
	finalizeTaskBaseAsync,
	persistProviderCleanupUncertain,
	providerCleanupHalt,
} from "./task-base.mjs";
import { decorateDirtyOverlayResult } from "./task-routing.mjs";

export async function runQueueWithOrchestratorCore(_options, scope) {
	const {
		_safeError,
		checkpoint,
		checkpointPath,
		commitOrResetWorkingContainer,
		context,
		dependencies,
		dirtyOverlayReceipt,
		effectiveExclude,
		effectiveMaxTasks,
		effectiveOnly,
		effectiveStopOnFailure,
		effectiveTaskIds,
		emitStatus,
		ensureProviderAttemptAllocations,
		executeTaskWithOrchestrator,
		identity,
		onCheckpointSaved,
		onResult,
		onTaskStart,
		ownsWorkingContainer,
		persistCheckpointOutcomeShadow,
		projectPath,
		queueBackend,
		recordHalt,
		releaseQueueSlot,
		runId,
		runStore,
		slotLease,
		tasks,
		uninstallSignalCleanup,
		workingContainerName,
	} = scope;
	try {
		if (ownsWorkingContainer) {
			try {
				queueBackend.seed(workingContainerName, projectPath, {
					dirtyOverlayReceipt,
				});
				queueBackend.afterCreate?.(workingContainerName, projectPath, {
					onStatus: emitStatus,
				});
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "bootstrap",
						event: "seed_failed",
						status: `Seed failed: ${error.message}`,
						error: _safeError(error),
					});
				}
				throw error;
			}
		}

		context.exclude = effectiveExclude;
		context.only = effectiveOnly;
		if (checkpoint.retryState !== null) {
			const reason = hasTrustedQuotaRetryEvidence(checkpoint.retryState)
				? "orchestrator mode cannot resume persisted retry state until an audited retry-resume state machine is implemented"
				: "historical retry state lacks trusted quota diagnostic provenance";
			throw new Error(`runQueueWithOrchestrator: ${reason}`);
		}
		const selectionOptions = identity.enabled
			? { selectedTaskIds: effectiveTaskIds }
			: {};
		const initialRunnable = getRunnableTasks(
			tasks,
			checkpoint,
			selectionOptions,
		);
		const attemptedTaskIds = new Set();
		const results = [];
		const deferredTaskIds = [];
		let policyDeferred = null;
		reconcileAlreadyCompleteSelection(
			checkpoint,
			checkpointPath,
			results,
			effectiveTaskIds,
			tasks,
			onResult,
			emitStatus,
			onCheckpointSaved,
		);
		let processed = 0;
		let halted = false;

		while (processed < effectiveMaxTasks) {
			const runnable = getRunnableTasks(tasks, checkpoint, {
				excludedTaskIds: attemptedTaskIds,
				...selectionOptions,
			});
			const task = runnable[0];
			if (!task) break;
			attemptedTaskIds.add(task.id);
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

			const priorExtraAllocation = ensureProviderAttemptAllocations(
				checkpoint,
			).find((entry) => entry?.taskId === task.id);
			let result;
			if (priorExtraAllocation) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason: "persisted extra provider invocation already consumed",
				};
			} else {
				// eslint-disable-next-line no-await-in-loop
				result = await executeTaskWithOrchestrator(task, context);
			}
			if (context._activeInvocationDescriptor) {
				Object.assign(
					result,
					descriptorReceiptFields(context._activeInvocationDescriptor),
				);
			}
			if (result?.result === "policy_deferred") {
				deferredTaskIds.push(result.taskId);
				policyDeferred = result.policyDeferred;
				break;
			}
			decorateDirtyOverlayResult(result, context);

			if (isRouteHealthDeferredResult(result)) {
				deferredTaskIds.push(result.taskId);
				reportRouteHealthDeferred(result, onResult, emitStatus);
				continue;
			}

			const resultAttempt = reserveTaskAttempt(
				checkpoint,
				checkpointPath,
				result.taskId,
			);
			enforceQuickCheckCompletion(task, result, resultAttempt, checkpoint);
			persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
			attachRouteHealthTerminal(result, context);
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
							descriptorIdentity:
								result.invocationDescriptor.descriptor_identity,
							descriptorHarness: result.descriptorHarness ?? null,
							resolvedTargetId: result.resolvedTargetId ?? null,
						}
					: {}),
				result: result.result,
				...(result.quickCheckReceipt
					? { quickCheckReceipt: result.quickCheckReceipt }
					: {}),
				...(typeof result.servedModelVerified === "boolean"
					? { servedModelVerified: result.servedModelVerified }
					: {}),
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
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
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_saved",
					status: `Checkpoint saved after task ${result.taskId}`,
					taskId: result.taskId,
				});
			}
			if (onCheckpointSaved) onCheckpointSaved();

			// Same INV-6 ordering as runQueue: the checkpoint is on disk before
			// the working-container commit/reset is attempted.
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
					logPrefix: "runQueueWithOrchestrator: ",
				});
			if (!haltResult) {
				haltResult = await finalizeTaskBaseAsync(
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

			// Same INV-3 halt as runQueue: a commit/reset failure makes the
			// container non-reusable, so the run stops before the next task's
			// launch/status/result cycle instead of reusing an unadvanced or
			// un-reset baseline. The completed task's checkpoint stays durable.
			if (haltResult) {
				recordHalt(checkpoint, checkpointPath, results, haltResult, emitStatus);
				halted = true;
				break;
			}

			if (!result.success && effectiveStopOnFailure) {
				break;
			}
		}

		if (emitStatus) {
			emitStatus({
				phase: "lifecycle",
				event: "terminal",
				status: `Queue ${halted ? "halted" : "complete"}: ${processed} tasks processed`,
			});
		}
		if (runStore) {
			const terminalDecision = terminalTransition({
				results,
				totalTasks: tasks.length,
				runnableTasks: initialRunnable.length,
				processedTasks: processed,
				completedTaskIds: checkpoint.completedTaskIds,
				deferredTaskIds,
				failedCount: results.filter((result) => !result.success).length,
			});
			const lastFailed = results.findLast((r) => !r.success);
			const lastFailure = lastFailed
				? failureMetadataFor(lastFailed, lastFailed.partialDiffPath)
				: null;
			const terminalProjection = {
				state: terminalDecision.state,
				activeTaskId: null,
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
				cleanupState: "complete",
				terminalSummary: terminalDecision.terminalSummary,
				terminalizedBy: "worker",
				...(lastFailure ? { lastFailure } : {}),
				...(policyDeferred ? { policyDeferred } : {}),
			};
			try {
				await runStore.updateRun(terminalProjection);
			} catch (error) {
				reportOutcomeProjectionFailure(
					ledgerReportingContext(
						emitStatus,
						dependencies,
						"runQueueWithOrchestrator",
					),
					error,
				);
			}
			// Shadow evidence is strictly additive. Isolate its failure from the
			// legacy terminal update and caller result.
			try {
				await persistCheckpointOutcomeShadow(
					checkpointPath,
					checkpoint,
					runStore,
					runId,
				);
			} catch {
				// Best effort only: release below still completes the legacy path.
			}
		}

		// Guarantee a checkpoint file exists at the path this return value
		// reports, even when the per-task loop above never ran (e.g. every
		// task was already completed by a prior checkpoint) — the caller must
		// never be handed a checkpointPath with nothing on disk behind it.
		// A halt entry was already persisted by recordHalt before the
		// queue_halted event fired; this final save is a no-op for that entry
		// and remains for the other fields/zero-runnable path.
		if (checkpoint.version === CHECKPOINT_VERSION)
			releaseCheckpointOwnership(checkpointPath, checkpoint);

		return {
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			deferredTaskIds,
			lastTaskId: checkpoint.lastTaskId,
			checkpointPath,
			...(identity.enabled
				? {
						queueIdentity: identity.queueIdentity,
						runOptions: identity.runOptions,
						projectRevision: identity.projectRevision,
					}
				: {}),
			results,
			...(policyDeferred ? { policyDeferred } : {}),
		};
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		try {
			if (ownsWorkingContainer) {
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_started",
						status: "Wiping working container",
					});
				}
				try {
					try {
						queueBackend.beforeRemove?.(workingContainerName, projectPath);
					} catch (hookError) {
						console.error(
							`runQueueWithOrchestrator: before_remove hook failed: ${hookError.message}`,
						);
					}
					queueBackend.destroy(workingContainerName);
					if (emitStatus) {
						emitStatus({
							phase: "cleanup",
							event: "cleanup_complete",
							status: "Cleanup complete",
						});
					}
				} catch (error) {
					if (emitStatus) {
						emitStatus({
							phase: "cleanup",
							event: "cleanup_failed",
							status: `Cleanup failed: ${error.message}`,
							error: _safeError(error),
						});
					}
					// biome-ignore lint/correctness/noUnsafeFinally: re-throwing the same error the bare wipe call would throw
					throw error;
				}
			}
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
		}
	}
}
