import { deriveFailureAccountability } from "../diagnostics/failure-semantics.mjs";

export {
	deriveFailureAccountability,
	lifecycleBackedProviderFailure,
} from "../diagnostics/failure-semantics.mjs";

/** Verify the existing run identity before using linked outcome evidence. */
export function linkedRoutingRecordMatches(record, attempt, projectPath) {
	return Boolean(
		record &&
			record.runId === attempt.runId &&
			record.projectPath === projectPath &&
			Array.isArray(record.orderedTaskIds) &&
			record.orderedTaskIds.length === 1 &&
			record.orderedTaskIds[0] === attempt.taskId &&
			record.resolvedTargetId === attempt.targetId &&
			(record.lastFailure?.taskId == null ||
				record.lastFailure.taskId === attempt.taskId) &&
			(record.worktree?.taskId == null ||
				record.worktree.taskId === attempt.taskId) &&
			(record.worktree?.attemptId == null ||
				record.worktree.attemptId === attempt.attemptId) &&
			(record.state === "succeeded"
				? attempt.terminal === "succeeded"
				: record.state === "failed" &&
					["failed", "skipped"].includes(attempt.terminal)),
	);
}

function totals(entries) {
	const successes = entries.filter((entry) => entry.outcome === "succeeded");
	return {
		attempts: entries.length,
		succeededAttempts: successes.length,
		failedAttempts: entries.filter((entry) => entry.outcome === "failed")
			.length,
		unknownAttempts: entries.filter((entry) => entry.outcome === "unknown")
			.length,
		uniqueTasks: new Set(entries.map((entry) => entry.taskId)).size,
		succeededTasks: new Set(successes.map((entry) => entry.taskId)).size,
	};
}

/** Inspect only identity-verified records; cleanup never changes task success. */
export async function inspectRoutingAccountability(state, readRun) {
	const attempts = [];
	for (const attempt of state.attempts) {
		let record;
		try {
			record = await readRun(attempt.runId);
		} catch {
			// Missing, unreadable and malformed linked records have no outcome authority.
		}
		const verified = linkedRoutingRecordMatches(
			record,
			attempt,
			state.canonicalProjectPath,
		);
		attempts.push({
			attemptId: attempt.attemptId,
			taskId: attempt.taskId,
			runId: attempt.runId,
			targetId: attempt.targetId,
			linkedRecord: verified ? "verified" : "unknown",
			outcome: verified ? record.state : "unknown",
			accountability:
				verified && record.state === "succeeded"
					? null
					: deriveFailureAccountability(
							verified && record.state === "failed"
								? {
										providerReliability:
											record.lastFailure?.providerReliability,
										provenance: record.lastFailure,
									}
								: {},
						),
			cleanup: verified
				? {
						state: ["not_started", "pending", "complete", "failed"].includes(
							record.cleanupState,
						)
							? record.cleanupState
							: "unknown",
						worktree: ["removed", "retained", "not_created"].includes(
							record.worktree?.state,
						)
							? record.worktree.state
							: "unknown",
					}
				: { state: "unknown", worktree: "unknown" },
		});
	}
	return {
		version: 1,
		totals: totals(attempts),
		providers: [...new Set(attempts.map((entry) => entry.targetId))].map(
			(targetId) => ({
				targetId,
				...totals(attempts.filter((entry) => entry.targetId === targetId)),
			}),
		),
		attempts,
	};
}
