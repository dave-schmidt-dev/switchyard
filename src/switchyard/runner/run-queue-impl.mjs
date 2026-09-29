import { performance } from "node:perf_hooks";
import {
	integrationGate,
	validateExactPathSet,
	validateIntegratedCommitAncestry,
	validateIntegratedCommitPaths,
	validateNoTrackedPathOverlap,
} from "../integrate/index.mjs";
import {
	readLedgerFromStore,
	recordDispatch,
	recordDispatchIntentToStore,
	recordDispatchToStore,
	recordExternalCompletionToStore,
} from "../ledger/index.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import {
	GOLDEN_IMAGE_VERIFIED_PROVIDERS,
	preflightMacosQueue,
	readSnapshotAtRoute,
	route,
} from "../router/index.mjs";
import { getCheckpointPath, saveCheckpoint } from "./checkpoint-store.mjs";
import { persistCheckpointOutcomeShadow } from "./execute-task.mjs";
import {
	_installOwnedContainerSignalCleanup,
	_resolveOnStatus,
	_safeError,
	DEFAULT_ADAPTERS,
	resolveQueueHealthDecision,
} from "./halts.mjs";
import {
	ledgerReportingContext,
	reportLegacyProjectionFailure,
	reportOutcomeProjectionFailure,
} from "./ledger-reporting.mjs";
import { emitStageOutcome } from "./outcome-writer.mjs";
import { assertDirtyOverlayReceiptCurrent } from "./queue-backend.mjs";
import { prepareQueueLaunch, releaseQueueSlot } from "./queue-launch.mjs";
import {
	getRunnableTasks,
	reconcileAlreadyCompleteSelection,
} from "./queue-selection.mjs";
import {
	ensureProviderAttemptAllocations,
	mergeRetryExclusions,
} from "./retry-transitions.mjs";
import { policyDeferredQueueResult } from "./route-health.mjs";
import { attemptRunQueueTask } from "./run-queue-task-attempt.mjs";
import { settleRunQueueTask } from "./run-queue-task-settlement.mjs";
import { projectRunQueueTerminal } from "./run-queue-terminal.mjs";

export function runQueueImpl(options) {
	const {
		tasksFilePath,
		projectPath,
		workingContainerName: suppliedWorkingContainerName,
		checkpointPath = getCheckpointPath(tasksFilePath),
		maxTasks = Number.POSITIVE_INFINITY,
		stopOnFailure = true,
		exclude = [],
		only = [],
		taskIds = [],
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId = null,
		dependencies = {},
	} = options;

	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});
	const onTaskStart = dependencies.onTaskStart ?? null;
	const onTaskRouted = dependencies.onTaskRouted ?? null;
	const onResult = dependencies.onResult ?? null;
	const onCheckpointSaved = dependencies.onCheckpointSaved ?? null;
	const onRetryStateChanged = dependencies.onRetryStateChanged ?? null;
	const onContainerReady = dependencies.onContainerReady ?? null;
	const runStore = dependencies.runStore ?? null;
	const runStorePath = dependencies.runStorePath ?? null;
	const emitStatus = _resolveOnStatus(dependencies);
	const launch = prepareQueueLaunch({
		tasksFilePath,
		projectPath,
		checkpointPath,
		maxTasks,
		stopOnFailure,
		exclude,
		only,
		taskIds,
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId,
		dependencies,
		onStatus: emitStatus,
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
	});
	const {
		queueBackend,
		dirtyOverlayReceipt,
		selectedPlatform,
		slotLease,
		tasks,
		checkpoint,
		taskFileSha256,
		identity,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	if (launch.policyDeferred) {
		emitStatus?.({
			phase: "policy",
			event: "queue_deferred",
			status: "Queue deferred while host is on battery power",
			taskId: launch.policyDeferred.nextTaskId,
			diagnosticCode: launch.policyDeferred.diagnosticCode,
		});
		return policyDeferredQueueResult(launch, checkpointPath);
	}
	ensureProviderAttemptAllocations(checkpoint);

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	try {
		if (!workingContainerName) {
			assertDirtyOverlayReceiptCurrent(
				projectPath,
				dirtyOverlayReceipt,
				"immediately before allocation",
			);
			queueBackend.ensureAgentContainer();
			// Pass runId so the cloned VM's name embeds it (see
			// buildParallelsWorkingName) — that embedding is the only ownership
			// record `recover`/reclaim has, so a missing runId here is invisible
			// to leak reclamation.
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: emitStatus,
			});
			if (!workingContainerName) {
				throw new Error("runQueue: failed to create working container");
			}
			ownsWorkingContainer = true;
			if (!dependencies.signal) {
				uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
					workingContainerName,
					queueBackend.destroy,
				);
			}
			if (emitStatus) {
				emitStatus({
					phase: "bootstrap",
					event: "container_created",
					status: "Working container created",
					provider: null,
					model: null,
				});
			}
			try {
				queueBackend.provision(workingContainerName);
			} catch (error) {
				console.error(
					`runQueue: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
		}

		// Fires once the workspace handle holds its final value, whether it was
		// supplied by the caller or created by this queue.
		if (onContainerReady) onContainerReady({ workingContainerName });
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueue: before_remove hook failed: ${hookError.message}`,
					);
				}
				queueBackend.destroy(workingContainerName);
			} catch {
				// Preserve the bootstrap error.
			}
		}
		releaseQueueSlot(queueBackend, slotLease);
		throw error;
	}

	const recordDispatchToStoreFn =
		dependencies.recordDispatchToStore ?? recordDispatchToStore;
	const recordDispatchIntentFn =
		dependencies.recordDispatchIntent ?? recordDispatchIntentToStore;
	const ledgerReporting = ledgerReportingContext(
		emitStatus,
		dependencies,
		"runQueue",
	);
	// The project-local outcome write is async; executeTask() and runQueue are
	// both synchronous. Writes are therefore queued onto one chain that keeps
	// them in dispatch order, and nothing in this function can await it --
	// making runQueue async would duplicate runQueueAsync, which exists for
	// exactly that reason.
	//
	// What the chain cannot do on its own is guarantee durability before the
	// caller acts on the return value: a caller that exits the process as soon
	// as runQueue returns drops any write still in flight. The chain is
	// returned as `ledgerWritesSettled` so such a caller can drain it. The
	// authoritative pre-dispatch intent receipt is unaffected -- it is written
	// synchronously by recordDispatchIntentToStore, before the provider runs,
	// and never goes through this chain.
	let storeWriteChain = Promise.resolve();
	const defaultRecordDispatch = (dispatch) => {
		storeWriteChain = storeWriteChain
			.then(() => recordDispatchToStoreFn(dispatch, runStorePath))
			.catch((error) => {
				reportOutcomeProjectionFailure(ledgerReporting, error);
			})
			.then(() => {
				try {
					recordDispatch(dispatch);
				} catch (error) {
					reportLegacyProjectionFailure(ledgerReporting, error);
				}
			})
			// Both handlers above call caller-supplied code (`onStatus`,
			// `diagnostics.emit`, `onLedgerProjectionFailure`), none of which is
			// guarded against throwing. Everywhere else in this runner such a
			// throw propagates synchronously and is the caller's own visible
			// bug; here it would instead reject a chain that the documented
			// normal case ignores, turning a best-effort ledger warning into an
			// unhandled rejection -- fatal on current Node, and raised after
			// runQueue has already returned success. So the chain is kept
			// non-rejecting: `ledgerWritesSettled` always settles, which is also
			// what a caller draining it before exit needs. console.warn is the
			// only channel left once the status surface is the thing that broke.
			.catch((error) => {
				console.warn(
					`runQueue: dispatch-ledger failure reporting threw (${error?.name ?? "Error"}); the ledger write itself is unaffected`,
				);
			});
	};
	const defaultRecordDispatchIntent = (intent) => {
		recordDispatchIntentFn(intent, runStorePath);
	};
	checkpoint.taskBases ??= {};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		recordOutcomeEvent: dependencies.recordOutcomeEvent ?? null,
		outcomeWriterEpoch: dependencies.outcomeWriterEpoch ?? null,
		_activeProcessOutcomeId: null,
		_activeOutcomeAttempt: 1,
		_outcomeAttemptCursor: 0,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ?? defaultRecordDispatchIntent,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		ownsWorkingContainer,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		platform: selectedPlatform,
		goldenImageVerifiedProviders: dependencies.goldenImageVerifiedProviders,
		healthDecision: resolveQueueHealthDecision(dependencies),
		onHealthDecision: dependencies.onHealthDecision,
		checkpoint,
		checkpointPath,
		taskFileSha256,
		runId: queueBackend.taskBaseRunId ?? runId,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
		onStatus: emitStatus,
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
		onTaskRouted,
		onLedgerProjectionFailure: dependencies.onLedgerProjectionFailure,
		onIntentReceiptFailure: dependencies.onIntentReceiptFailure,
		resolveDescriptor: dependencies.resolveDescriptor,
		checkIgnoredPath: dependencies.checkIgnoredPath,
		hostPowerProbe: dependencies.hostPowerProbe,
		hostPowerExecFn: dependencies.hostPowerExecFn,
		hostPowerProbeTimeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		completionContinuation: dependencies.completionContinuation ?? {
			enabled: false,
		},
		completionContinuationMode: "sync",
		now: dependencies.now ?? Date.now,
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
		exclude,
		only,
		emitNonProviderOutcomes:
			dependencies.enableNonProviderOutcomes === true ||
			typeof dependencies.recordOutcomeEvent !== "function",
	};
	if (context.recordOutcomeEvent && context.outcomeWriterEpoch) {
		context._outcomeWriteChain = Promise.resolve()
			.then(() =>
				emitStageOutcome(context, {
					stage: "preflight",
					status: "succeeded",
					producer: "runner",
					code: "queue_preflight",
					detail: { eligible: true },
				}),
			)
			.then(() =>
				emitStageOutcome(context, {
					stage: "run",
					status: "started",
					producer: "runner",
					code: "run_started",
				}),
			)
			.then(() =>
				emitStageOutcome(context, {
					stage: "worker",
					status: "started",
					producer: "runner",
					code: "worker_started",
					detail: { launchVerified: true },
				}),
			)
			.catch(() => {});
	}

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
		const projectRetryState = () => {
			if (
				(!runStore && !onRetryStateChanged) ||
				(checkpoint.retryTransitionId === 0 &&
					checkpoint.retryState === null &&
					checkpoint.quarantinedTargetIds.length === 0)
			) {
				return;
			}
			const projection = {
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
			};
			if (runStore) runStore.updateRun(projection).catch(() => {});
			if (onRetryStateChanged) onRetryStateChanged(projection);
		};
		const selectionOptions = identity.enabled
			? { selectedTaskIds: effectiveTaskIds }
			: {};
		context.exclude = mergeRetryExclusions(
			effectiveExclude,
			checkpoint.quarantinedTargetIds,
		);
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
		let resumedRetryTaskId = checkpoint.retryState?.taskId ?? null;

		while (processed < effectiveMaxTasks) {
			const queueState = {
				processed,
				halted,
				resumedRetryTaskId,
				policyDeferred,
				deferredTaskIds,
			};
			const queueScope = {
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
				results,
				deferredTaskIds,
				onResult,
				onCheckpointSaved,
				effectiveStopOnFailure,
			};
			const attemptResult = attemptRunQueueTask(queueScope, queueState);
			({ resumedRetryTaskId } = queueState);
			if (attemptResult.action === "break") break;

			const settlementResult = settleRunQueueTask(queueScope, queueState);
			({ processed, halted, policyDeferred } = queueState);
			if (settlementResult.action === "break") break;
			if (settlementResult.action === "continue") continue;
		}

		return projectRunQueueTerminal(context, {
			checkpoint,
			checkpointPath,
			deferredTaskIds,
			emitStatus,
			halted,
			identity,
			initialRunnable,
			ledgerReporting,
			persistCheckpointOutcomeShadow,
			policyDeferred,
			processed,
			results,
			runId,
			runStore,
			storeWriteChain,
			tasks,
		});
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
							`runQueue: before_remove hook failed: ${hookError.message}`,
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
