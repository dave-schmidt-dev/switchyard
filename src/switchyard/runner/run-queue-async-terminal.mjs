import { readEvents, readRun } from "../run-store/index.mjs";
import { releaseCheckpointOwnership } from "./checkpoint-store.mjs";
import { CHECKPOINT_VERSION } from "./constants.mjs";

export async function projectRunQueueAsyncTerminal(context, scope) {
	let {
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
	} = scope;
	// Keep ownership until the terminal reducer projection has been observed
	// and copied into the checkpoint. Shadow persistence is additive evidence:
	// a read/write failure must never change the queue result or strand the
	// checkpoint lease.
	let checkpointShadowSettled = Promise.resolve();
	if (checkpoint.version === CHECKPOINT_VERSION) {
		const checkpointRunStore = dependencies.runStore ?? {
			readRun,
			readEvents,
		};
		checkpointShadowSettled = Promise.resolve(
			context._outcomeWriteChain ?? Promise.resolve(),
		)
			.then(() =>
				persistCheckpointOutcomeShadow(
					checkpointPath,
					checkpoint,
					checkpointRunStore,
					runId,
				).catch(() => false),
			)
			.catch(() => false)
			.finally(() => {
				try {
					releaseCheckpointOwnership(checkpointPath, checkpoint);
				} catch {
					// Checkpoint shadow/release failures are best effort and must
					// not alter the established async caller result.
				}
			});
		await checkpointShadowSettled;
	}
	queueResult = {
		results,
		totalTasks: tasks.length,
		runnableTasks: initialRunnable.length,
		processedTasks: processed,
		completedTaskIds: checkpoint.completedTaskIds,
		deferredTaskIds,
		policyDeferred,
		checkpointPath,
		ledgerWritesSettled: checkpointShadowSettled,
		quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
		retryState: checkpoint.retryState,
		retryTransitionId: checkpoint.retryTransitionId,
	};
	return queueResult;
}
