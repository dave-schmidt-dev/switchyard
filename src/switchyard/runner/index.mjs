import { join } from "node:path";
import { reportCheckpointReleaseFailure } from "./checkpoint-load.mjs";
import { CHECKPOINT_VERSION } from "./constants.mjs";
import { runQueueAsyncImpl } from "./run-queue-async-impl.mjs";
import { runQueueImpl } from "./run-queue-impl.mjs";
import { runQueueWithOrchestratorImpl } from "./run-queue-orchestrator-impl.mjs";

export { createBrokerAdapterLauncher } from "./broker.mjs";
export { invalidCompletedQuickCheckTaskIds } from "./checks.mjs";
export { executeTask, executeTaskAsync } from "./execute-task.mjs";
export { DEFAULT_ADAPTERS } from "./halts.mjs";
export { emitStageOutcome, prepareOutcomeWriter } from "./outcome-writer.mjs";
export { createQueueBackend } from "./queue-backend.mjs";
export {
	QueuePreflightError,
	sanitizeQueuePreflightDetail,
} from "./queue-preflight.mjs";
export { integrationFailureMetadata } from "./retry-transitions.mjs";
export { executeTaskWithOrchestrator } from "./run-queue-orchestrator-impl.mjs";

export async function runQueueAsync(options) {
	let failed = true;
	try {
		const result = await runQueueAsyncImpl(options);
		failed = false;
		return result;
	} finally {
		if (failed) reportCheckpointReleaseFailure(options);
	}
}

export function runQueue(options) {
	let failed = true;
	try {
		const result = runQueueImpl(options);
		failed = false;
		return result;
	} finally {
		if (failed) reportCheckpointReleaseFailure(options);
	}
}

export async function runQueueWithOrchestrator(options) {
	let failed = true;
	try {
		const result = await runQueueWithOrchestratorImpl(options);
		failed = false;
		return result;
	} finally {
		if (failed) reportCheckpointReleaseFailure(options);
	}
}

export function runProjectQueue(
	projectRoot,
	tasksFileName,
	workingContainerName,
) {
	return runQueue({
		tasksFilePath: join(projectRoot, tasksFileName),
		projectPath: projectRoot,
		workingContainerName,
	});
}

export { persistAsyncResultArtifacts } from "./artifacts.mjs";
export { validateCallerInputs } from "./caller-inputs.mjs";
export {
	CallerInputValidationError,
	CHECKPOINT_IDENTITY_CODES,
	CHECKPOINT_IDENTITY_REMEDIES,
	CheckpointHistoricalCheckpointError,
	CheckpointIdentityError,
	CheckpointMissingQueueIdentityError,
	CheckpointQueueIdentityMismatchError,
	CheckpointRunOptionsMismatchError,
	CheckpointTaskFileMismatchError,
	getProjectRevision,
	IntegrationStateUnknownError,
	QueueCleanupError,
	TaskSelectionError,
} from "./checkpoint-errors.mjs";
export {
	claimCheckpointOwnership,
	loadCheckpoint,
	migrateLegacyCheckpoint,
} from "./checkpoint-load.mjs";
export {
	acquireCheckpointLease,
	createEmptyCheckpoint,
	getCheckpointPath,
	releaseCheckpointLease,
	releaseCheckpointOwnership,
	saveCheckpoint,
} from "./checkpoint-store.mjs";
export {
	createQueueIdentity,
	DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
	normalizeQueuePlatform,
	normalizeRunOptions,
	ORCHESTRATOR_PAYLOAD_VERSION,
	QUEUE_PLATFORMS,
} from "./constants.mjs";
export {
	createCliOrchestrator,
	resolveOrchestrator,
	writeDispatchIntent,
	writeDispatchIntentAsync,
} from "./ledger-reporting.mjs";
export {
	deriveQueueDiagnostics,
	getRunnableTasks,
	planPotentialAttemptTasks,
	selectNextQueueTask,
	validateTaskSelection,
} from "./queue-selection.mjs";
export { isRouteHealthDeferredResult } from "./route-health.mjs";
export { validateProjectFileEntries } from "./task-fields.mjs";
export {
	computeQueueIdentityFromFile,
	loadTaskQueue,
	parseTaskQueue,
	validateTaskGraph,
} from "./task-queue.mjs";
export {
	findIgnoredDeclaredPath,
	parseExpectedBy,
	waitForJobCompletion,
} from "./task-routing.mjs";
export { CHECKPOINT_VERSION };
