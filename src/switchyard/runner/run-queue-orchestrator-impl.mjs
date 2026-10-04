export async function executeTaskWithOrchestrator(task, context) {
	const result = decorateDirtyOverlayResult(
		await executeTaskWithOrchestratorUnsafe(task, context),
		context,
	);
	if (context?.recordOutcomeEvent && context?.outcomeWriterEpoch) {
		await emitTaskStageOutcomes(context, task, result);
	}
	return result;
}

import { performance } from "node:perf_hooks";
import { integrationGate } from "../integrate/index.mjs";
import {
	recordDispatchIntentToStore,
	recordDispatchToStore,
} from "../ledger/index.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import { route } from "../router/index.mjs";
import { sleep } from "./checkpoint-errors.mjs";
import { getCheckpointPath, saveCheckpoint } from "./checkpoint-store.mjs";
import { executeTaskWithOrchestratorUnsafe } from "./execute-orchestrator-unsafe.mjs";
import {
	emitTaskStageOutcomes,
	persistCheckpointOutcomeShadow,
} from "./execute-task.mjs";
import {
	_installOwnedContainerSignalCleanup,
	_resolveOnStatus,
	_safeError,
	commitOrResetWorkingContainer,
	DEFAULT_ADAPTERS,
	recordHalt,
	resolveQueueHealthDecision,
} from "./halts.mjs";
import {
	ledgerReportingContext,
	resolveOrchestrator,
} from "./ledger-reporting.mjs";
import { assertDirtyOverlayReceiptCurrent } from "./queue-backend.mjs";
import {
	prepareQueueLaunch,
	recordDispatchToBothLedgers,
	releaseQueueSlot,
} from "./queue-launch.mjs";
import { ensureProviderAttemptAllocations } from "./retry-transitions.mjs";
import { policyDeferredQueueResult } from "./route-health.mjs";
import { runQueueWithOrchestratorCore } from "./run-queue-orchestrator-core.mjs";
import { decorateDirtyOverlayResult } from "./task-routing.mjs";

export async function runQueueWithOrchestratorImpl(options) {
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
		pollIntervalMs = 10_000,
		maxPolls = 1_000,
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
			// Pass runId so the container is labeled managed + run_id (see runQueue).
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: emitStatus,
			});
			if (!workingContainerName) {
				throw new Error(
					"runQueueWithOrchestrator: failed to create working container",
				);
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
					`runQueueWithOrchestrator: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
		}
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueueWithOrchestrator: before_remove hook failed: ${hookError.message}`,
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
	const defaultRecordDispatch = async (dispatch) => {
		await recordDispatchToBothLedgers(
			dispatch,
			(data) => recordDispatchToStoreFn(data, runStorePath),
			ledgerReportingContext(emitStatus, dependencies),
		);
	};
	const defaultRecordDispatchIntent = (intent) =>
		recordDispatchIntentFn(intent, runStorePath);
	checkpoint.taskBases ??= {};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		recordOutcomeEvent: dependencies.recordOutcomeEvent ?? null,
		outcomeWriterEpoch: dependencies.outcomeWriterEpoch ?? null,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ?? defaultRecordDispatchIntent,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		orchestrator: resolveOrchestrator(dependencies),
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
		runId: queueBackend.taskBaseRunId ?? runId,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
		pollIntervalMs,
		maxPolls,
		now: dependencies.now ?? Date.now,
		sleepFn: dependencies.sleepFn ?? sleep,
		onPoll: dependencies.onPoll ?? null,
		onStatus: emitStatus,
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
		completionContinuationMode: "unavailable",
		emitNonProviderOutcomes:
			dependencies.enableNonProviderOutcomes === true ||
			typeof dependencies.recordOutcomeEvent !== "function",
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
	};

	return await runQueueWithOrchestratorCore(options, {
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
	});
}
