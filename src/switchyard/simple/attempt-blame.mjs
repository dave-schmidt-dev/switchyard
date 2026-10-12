/** Which recorded attempt failures may blame the target, not the environment. */

/**
 * Attempt reasons that blame the environment, not the target, for this task.
 */
export const TASK_EXCLUSION_EXEMPT_REASONS = new Set([
	"baseline_failed",
	"environment_failure",
	"lifecycle_recovered",
]);

/**
 * Causes that never blame the target for an attempt failure.
 *
 * A caller-initiated cancellation is the caller's decision, and a live quota
 * error is the provider account's capacity, so neither is evidence against a
 * target. Both are persisted on the attempt so later attempts at the same task
 * may still use the target.
 */
export const NON_BLAMING_CAUSES = Object.freeze([
	"caller_cancelled",
	"quota_exhausted",
]);

/**
 * Classify a failed attempt result that does not blame its target.
 *
 * A SIGTERM or SIGINT cancellation is the caller stopping the run, not the
 * target failing it, so the target stays eligible for later attempts at the
 * same task. A live `quota_exhausted` provider error says the account has no
 * capacity now, which also is not a target defect. Internal-deadline and
 * unspecified cancellations keep their blame: they can mark a provider that
 * never settled its own work as unreliable.
 *
 * @param {object} result - The engine result object.
 * @returns {"caller_cancelled"|"quota_exhausted"|null} The non-blaming cause,
 *   or null when the failure blames the target.
 */
export function nonBlamingCause(result) {
	const reliability = result?.providerReliability;
	if (reliability?.causeCode === "quota_exhausted") return "quota_exhausted";
	if (reliability?.causeCode !== "cancelled") return null;
	const source = reliability.cancelSource ?? result.cancelSource;
	return source === "signal_sigterm" || source === "signal_sigint"
		? "caller_cancelled"
		: null;
}

/**
 * Targets this logical task already tried and did not succeed on. Unlike the
 * run-wide failedTargetIds, this set is rebuilt from persisted attempts and
 * scoped to one task, so a task-local failure never removes a healthy target
 * from other tasks in the same routing run. Baseline, environment and
 * lifecycle-recovery attempts blame the environment, and caller cancellations
 * or live quota errors do not blame the target, so they keep the target
 * eligible for the task.
 *
 * @param {object[]} attempts - Persisted attempt records.
 * @param {string} logicalTaskId - The task whose attempts are considered.
 * @returns {Set<string>} Target ids excluded for this task.
 */
export function taskExcludedTargets(attempts, logicalTaskId) {
	const excluded = new Set();
	for (const attempt of attempts) {
		const failedForTask =
			attempt.taskId === logicalTaskId &&
			(attempt.terminal === "failed" || attempt.terminal === "skipped") &&
			!TASK_EXCLUSION_EXEMPT_REASONS.has(attempt.reason) &&
			!NON_BLAMING_CAUSES.includes(attempt.nonBlamingCause);
		if (failedForTask) excluded.add(attempt.targetId);
	}
	return excluded;
}
