import { performance } from "node:perf_hooks";
import { integrationGate } from "../integrate/index.mjs";
import {
	recordDispatchIntentToStore,
	recordDispatchToStore,
} from "../ledger/index.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import { getConfiguredInvocationDescriptor } from "../roster/index.mjs";
import { route } from "../router/index.mjs";
import { createDispatchBroker } from "./broker.mjs";
import { QueueCleanupError } from "./checkpoint-errors.mjs";
import { getCheckpointPath, saveCheckpoint } from "./checkpoint-store.mjs";
import { persistCheckpointOutcomeShadow } from "./execute-task.mjs";
import {
	_installOwnedContainerSignalCleanup,
	_resolveOnStatus,
	DEFAULT_ADAPTERS,
	resolveQueueHealthDecision,
} from "./halts.mjs";
import { ledgerReportingContext } from "./ledger-reporting.mjs";
import { emitStageOutcome, prepareOutcomeWriter } from "./outcome-writer.mjs";
import { assertDirtyOverlayReceiptCurrent } from "./queue-backend.mjs";
import {
	acquireQueueSlotAsync,
	isVmSlotUnavailable,
	prepareQueueLaunch,
	recordDispatchToBothLedgers,
	releaseQueueSlot,
} from "./queue-launch.mjs";
import {
	getRunnableTasks,
	reconcileAlreadyCompleteSelection,
} from "./queue-selection.mjs";
import { ensureRetryCheckpoint } from "./quick-checks.mjs";
import {
	ensureProviderAttemptAllocations,
	mergeRetryExclusions,
} from "./retry-transitions.mjs";
import { policyDeferredQueueResult } from "./route-health.mjs";
import { runQueueAsyncLoop } from "./run-queue-async-loop.mjs";
import { projectRunQueueAsyncTerminal } from "./run-queue-async-terminal.mjs";

export async function runQueueAsyncImpl(options) {
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
		runOptions = null,
		queueIdentity = null,
		projectRevision = null,
		runStorePath = null,
		runId = null,
		dependencies = {},
	} = options;
	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});
	const emitStatus = _resolveOnStatus(dependencies);
	// Discover the run writer before any queue parsing, backend preflight, or
	// VM admission. Those are authoritative preflight boundaries: if one fails,
	// the run must still receive an explicit typed failure when its lease exists.
	const outcomeWriter = await prepareOutcomeWriter(runId, dependencies);
	const stageContext = {
		runId,
		recordOutcomeEvent:
			dependencies.recordOutcomeEvent ?? outcomeWriter?.record ?? null,
		outcomeWriterEpoch:
			dependencies.outcomeWriterEpoch ?? outcomeWriter?.writerEpoch ?? null,
		onStatus: emitStatus,
	};
	await emitStageOutcome(stageContext, {
		stage: "worker",
		status: "succeeded",
		producer: "runner",
		code: "worker_started",
		detail: { launchVerified: true },
	});
	await emitStageOutcome(stageContext, {
		stage: "run",
		status: "started",
		producer: "runner",
		code: "run_started",
	});
	let launch;
	try {
		launch = prepareQueueLaunch({
			tasksFilePath,
			projectPath,
			checkpointPath,
			maxTasks,
			stopOnFailure,
			exclude,
			only,
			taskIds,
			identityTaskIds: [],
			platform,
			runOptions,
			queueIdentity,
			projectRevision,
			runId,
			dependencies,
			onStatus: emitStatus,
			deferSlotAcquisition: true,
		});
	} catch (error) {
		await emitStageOutcome(stageContext, {
			stage: "preflight",
			status: "failed",
			producer: "runner",
			code: "queue_preflight_failed",
			detail: { eligible: false },
		});
		throw error;
	}
	const {
		queueBackend,
		dirtyOverlayReceipt,
		selectedPlatform,
		tasks,
		checkpoint,
		taskFileSha256,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	if (launch.policyDeferred) {
		await emitStageOutcome(stageContext, {
			stage: "preflight",
			status: "skipped",
			producer: "runner",
			code: "queue_deferred",
			detail: { eligible: false },
		});
		emitStatus?.({
			phase: "policy",
			event: "queue_deferred",
			status: "Queue deferred while host is on battery power",
			taskId: launch.policyDeferred.nextTaskId,
			diagnosticCode: launch.policyDeferred.diagnosticCode,
		});
		return policyDeferredQueueResult(launch, checkpointPath);
	}
	ensureRetryCheckpoint(checkpoint);
	ensureProviderAttemptAllocations(checkpoint);
	let slotLease;
	try {
		slotLease = await acquireQueueSlotAsync({
			queueBackend,
			selectedPlatform,
			runId,
			dependencies,
			onStatus: emitStatus,
		});
	} catch (error) {
		await emitStageOutcome(stageContext, {
			stage: "preflight",
			status: "failed",
			producer: "runner",
			code: isVmSlotUnavailable(error)
				? "vm_slot_unavailable"
				: "queue_admission_failed",
			detail: { eligible: false },
		});
		throw error;
	}
	await emitStageOutcome(stageContext, {
		stage: "preflight",
		status: "succeeded",
		producer: "runner",
		code: "queue_preflight",
		detail: { eligible: true },
	});
	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	let queueResult = null;
	try {
		if (!workingContainerName) {
			assertDirtyOverlayReceiptCurrent(
				projectPath,
				dirtyOverlayReceipt,
				"immediately before allocation",
			);
			queueBackend.ensureAgentContainer();
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: dependencies.onStatus,
			});
			if (!workingContainerName) {
				throw new Error("runQueueAsync: failed to create working container");
			}
			ownsWorkingContainer = true;
			if (!dependencies.signal) {
				uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
					workingContainerName,
					queueBackend.destroy,
				);
			}
			dependencies.onStatus?.({
				phase: "bootstrap",
				event: "container_created",
				status: "Working container created",
			});
			// Credential provisioning and project seeding can be slow. Publish the
			// resolved container before either operation so status is useful during
			// bootstrap rather than looking like a dead launch.
			dependencies.onContainerReady?.({ workingContainerName });
			try {
				queueBackend.provision(workingContainerName);
			} catch (error) {
				console.error(
					`runQueueAsync: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
			queueBackend.seed(workingContainerName, projectPath, {
				dirtyOverlayReceipt,
			});
			queueBackend.afterCreate?.(workingContainerName, projectPath, {
				onStatus: dependencies.onStatus,
			});
		}
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueueAsync: before_remove hook failed: ${hookError.message}`,
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
	checkpoint.taskBases ??= {};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch:
			dependencies.recordDispatch ??
			((dispatch) =>
				recordDispatchToBothLedgers(
					dispatch,
					(data) => recordDispatchToStore(data, runStorePath),
					ledgerReportingContext(dependencies.onStatus ?? null, dependencies),
				)),
		recordOutcomeEvent:
			dependencies.recordOutcomeEvent ?? outcomeWriter?.record ?? null,
		outcomeWriterEpoch:
			dependencies.outcomeWriterEpoch ?? outcomeWriter?.writerEpoch ?? null,
		_activeProcessOutcomeId: null,
		_activeOutcomeAttempt: null,
		_outcomeAttemptCursor: 0,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ??
			((intent) => recordDispatchIntentToStore(intent, runStorePath)),
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
		dirtyOverlayReceipt,
		checkpointPath,
		taskFileSha256,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
		onStatus: dependencies.onStatus ?? null,
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
		onTaskRouted: dependencies.onTaskRouted ?? null,
		onTaskHeartbeat: dependencies.onTaskHeartbeat ?? null,
		checkIgnoredPath: dependencies.checkIgnoredPath,
		hostPowerProbe: dependencies.hostPowerProbe,
		hostPowerExecFn: dependencies.hostPowerExecFn,
		hostPowerProbeTimeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		exclude: mergeRetryExclusions(
			effectiveExclude,
			checkpoint.quarantinedTargetIds,
		),
		only: effectiveOnly,
		emitNonProviderOutcomes:
			dependencies.enableNonProviderOutcomes === true ||
			typeof dependencies.recordOutcomeEvent !== "function",
		signal: dependencies.signal,
		onPoll: dependencies.onPoll,
		resolveDescriptor: dependencies.resolveDescriptor,
		qualificationAttempt:
			runOptions?.qualificationAttempt === true ||
			options.qualificationAttempt === true,
		hasInvocationDescriptor:
			runOptions?.qualificationAttempt === true ||
			options.qualificationAttempt === true
				? getConfiguredInvocationDescriptor
				: undefined,
		runId: queueBackend.taskBaseRunId ?? runId,
		snapshotSource: dependencies.snapshotSource ?? "gradus-v2",
		completionContinuation: dependencies.completionContinuation ?? {
			enabled: false,
		},
		completionContinuationMode: "unavailable",
		now: dependencies.now ?? Date.now,
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
	};
	const results = [];
	const deferredTaskIds = [];
	let policyDeferred = null;
	// Retained only so a teardown failure can name the failure it displaces.
	let inFlightError = null;
	try {
		context.broker = createDispatchBroker(context, dependencies);
		const initialRunnable = getRunnableTasks(tasks, checkpoint, {
			selectedTaskIds: effectiveTaskIds,
			resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
		});
		const attemptedTaskIds = new Set();
		let resumedRetryTaskId = checkpoint.retryState?.taskId ?? null;
		let processed = 0;
		const projectRetryState = () => {
			dependencies.onRetryStateChanged?.({
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
			});
		};
		reconcileAlreadyCompleteSelection(
			checkpoint,
			checkpointPath,
			results,
			effectiveTaskIds,
			tasks,
			dependencies.onResult,
			dependencies.onStatus,
			dependencies.onCheckpointSaved,
		);
		const queueState = {
			processed,
			resumedRetryTaskId,
			policyDeferred,
			deferredTaskIds,
		};
		const queueScope = {
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
			onResult: dependencies.onResult,
			emitStatus,
			effectiveStopOnFailure,
			projectRetryState,
			context,
		};
		await runQueueAsyncLoop(queueScope, queueState);
		({ processed, resumedRetryTaskId, policyDeferred } = queueState);
		queueResult = await projectRunQueueAsyncTerminal(context, {
			checkpoint,
			checkpointPath,
			deferredTaskIds,
			dependencies,
			initialRunnable,
			persistCheckpointOutcomeShadow,
			policyDeferred,
			processed,
			queueResult,
			results,
			runId,
			tasks,
		});
		return queueResult;
	} catch (error) {
		inFlightError = error;
		throw error;
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		let cleanupError = null;
		try {
			if (ownsWorkingContainer) {
				// The detached worker must durably mark cleanup as pending before
				// destroying the workspace. This gives its run-store telemetry a
				// clear lifecycle boundary and prevents a late heartbeat from
				// describing a provider that no longer has a workspace.
				try {
					await dependencies.onCleanupStarted?.();
				} catch (error) {
					console.error(
						`runQueueAsync: cleanup-started hook failed: ${error?.message ?? "unknown error"}`,
					);
				}
				try {
					try {
						queueBackend.beforeRemove?.(workingContainerName, projectPath);
					} catch (hookError) {
						console.error(
							`runQueueAsync: before_remove hook failed: ${hookError.message}`,
						);
					}
					queueBackend.destroy(workingContainerName);
				} catch {
					// Never retain or forward the backend error: it may contain host paths
					// or provider-controlled text. The fixed event and error below carry
					// the only evidence terminal finalization needs.
					console.error("runQueueAsync: queue backend teardown failed");
					try {
						dependencies.onStatus?.({
							phase: "cleanup",
							event: "cleanup_failed",
							status: "Cleanup failed; recovery required",
						});
					} catch {
						// A progress callback cannot replace the closed cleanup failure.
					}
					cleanupError = new QueueCleanupError(queueResult, inFlightError);
				}
			}
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
		}
		if (cleanupError) {
			// biome-ignore lint/correctness/noUnsafeFinally: teardown failure must override both a nominal queue return and an in-flight failure so callers cannot finalize success over a leaked workspace; the displaced failure's diagnostic code rides along on cleanupError
			throw cleanupError;
		}
	}
}
