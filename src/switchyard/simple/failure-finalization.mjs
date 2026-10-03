import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";

/** Publish terminal failure and cleanup intent atomically before removing artifacts. */
export async function publishFailedTerminal(updateRun, runId, terminalPatch) {
	try {
		await updateRun(runId, { ...terminalPatch, cleanupState: "pending" });
		return true;
	} catch {
		return false;
	}
}

/** Persist the final failure disposition, including failures with no clone claim. */
export async function persistFailureDisposition({
	runInitialized,
	status,
	terminalDurable,
	runId,
	taskId,
	keepWorktree,
	worktreePath,
	cleanupAttempted,
	worktreeCleanupReason,
	failureReason,
	canonicalParent,
	candidateChild,
	candidatePath,
	worktreeIdentity,
	writerLifecycle,
	projectLockState,
	now,
	updateRun,
}) {
	if (!runInitialized || status === "succeeded") return null;
	const retained = Boolean(candidateChild && (keepWorktree || worktreePath));
	const writerStopped =
		writerLifecycle === "stopped" || writerLifecycle === "never_started";
	const cleanupFailed =
		(cleanupAttempted && retained) ||
		!writerStopped ||
		projectLockState === "unavailable" ||
		projectLockState === "held";
	// A failed terminal write cannot be repaired by writing cleanup completion.
	const cleanupState = !terminalDurable
		? "pending"
		: cleanupFailed
			? "failed"
			: retained
				? "pending"
				: "complete";
	const patch = {
		cleanupState,
		...(cleanupFailed
			? {
					cleanupFailure: {
						...sanitizeFailureMetadata({
							taskId,
							result: "worktree_cleanup_failed",
							errorKind: "cleanup_failed",
							failurePhase: "cleanup",
						}),
						result: "worktree_cleanup_failed",
					},
				}
			: {}),
		...(candidateChild
			? {
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: retained ? "retained" : "removed",
						reason: retained
							? (worktreeCleanupReason ?? failureReason ?? "salvage_retained")
							: null,
						retainedAt: retained ? new Date(now()).toISOString() : null,
						writerStopped,
						...(worktreeIdentity ?? {}),
					},
				}
			: {}),
	};
	try {
		await updateRun(runId, patch);
		return { persisted: true, cleanupState };
	} catch {
		return { persisted: false, cleanupState: "pending" };
	}
}
