import {
	artifactTransition,
	failureTransition,
	integrationTransition,
	retryTransition,
	reviewTransition,
	terminalTransition,
} from "../outcome/transitions.mjs";
import { releaseCheckpointOwnership } from "./checkpoint-store.mjs";
import { CHECKPOINT_VERSION } from "./constants.mjs";
import { reportOutcomeProjectionFailure } from "./ledger-reporting.mjs";
import { failureMetadataFor } from "./quick-checks.mjs";

export function projectRunQueueTerminal(context, scope) {
	let {
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
	} = scope;
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
		let writePromise;
		try {
			writePromise = Promise.resolve(
				runStore.updateRun(terminalProjection),
			).catch((error) => {
				reportOutcomeProjectionFailure(ledgerReporting, error);
			});
		} catch (error) {
			reportOutcomeProjectionFailure(ledgerReporting, error);
			writePromise = Promise.resolve();
		}
		storeWriteChain = storeWriteChain.then(() => writePromise);
	}

	// Guarantee a checkpoint file exists at the path this return value
	// reports, even when the per-task loop above never ran (e.g. every
	// task was already completed by a prior checkpoint) — the caller must
	// never be handed a checkpointPath with nothing on disk behind it.
	// A halt entry was already persisted by recordHalt before the
	// queue_halted event fired; this final save is a no-op for that entry
	// and remains for the other fields/zero-runnable path.
	let checkpointShadowSettled = null;
	if (
		checkpoint.version === CHECKPOINT_VERSION &&
		runStore &&
		typeof runStore.readRun === "function" &&
		typeof runId === "string"
	) {
		// runQueue is intentionally synchronous. Defer checkpoint release to
		// the returned drain boundary so terminal shadow evidence observes both
		// the terminal run update and the final typed outcome writes.
		checkpointShadowSettled = Promise.all([
			storeWriteChain,
			context._outcomeWriteChain ?? Promise.resolve(),
		])
			.then(() =>
				persistCheckpointOutcomeShadow(
					checkpointPath,
					checkpoint,
					runStore,
					runId,
				).catch(() => false),
			)
			.catch(() => false)
			.finally(() => {
				try {
					releaseCheckpointOwnership(checkpointPath, checkpoint);
				} catch {
					// Shadow/release failures are best effort and must not alter
					// the established synchronous caller result.
				}
			});
	}
	if (checkpoint.version === CHECKPOINT_VERSION && !checkpointShadowSettled) {
		releaseCheckpointOwnership(checkpointPath, checkpoint);
	}

	return {
		totalTasks: tasks.length,
		runnableTasks: initialRunnable.length,
		processedTasks: processed,
		completedTaskIds: checkpoint.completedTaskIds,
		deferredTaskIds,
		lastTaskId: checkpoint.lastTaskId,
		checkpointPath,
		// The drain boundary for the async outcome writes queued above. A
		// caller that terminates on return (or that reads the ledger right
		// after it) must await this; every other caller can ignore it, which
		// is why runQueue's own signature stays synchronous.
		ledgerWritesSettled: Promise.all([
			storeWriteChain,
			context._outcomeWriteChain ?? Promise.resolve(),
			checkpointShadowSettled ?? Promise.resolve(),
		]),
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
}
