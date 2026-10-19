function legacyStatus(run) {
	if (run?.state === "recovery_required") return "recovery_required";
	if (run?.state === "failed") return "failed";
	if (run?.state === "succeeded") return "succeeded";
	if (run?.state === "deferred") return "skipped";
	return "unknown";
}

/**
 * Project a run's outcome from its legacy fields.
 *
 * This is the only outcome reader. The reducer shadow and its reader cutover
 * were retired by owner decision O4 (2026-10-18): no recorded run ever reached
 * the reducer, so the legacy projection stays exactly as it was. It carries
 * the fields that were actually persisted and leaves artifact, retry,
 * diagnostic, and counter fields absent when absent. A historical
 * `run.outcomeShadow` is ignored.
 */
export function projectOutcomeReader({ run = null, events = [] } = {}) {
	if (!Array.isArray(events))
		throw new TypeError("outcome events must be an array");
	const projection = {
		projectionVersion: 0,
		reader: "legacy",
		historical: true,
		runId: run?.runId ?? null,
		finalStatus: legacyStatus(run),
		legacyState: run?.state ?? null,
		typedEventCount: 0,
	};
	if (run?.lastFailure !== undefined)
		projection.primaryFailure = run.lastFailure;
	if (run?.terminalSummary !== undefined)
		projection.terminalSummary = run.terminalSummary;
	projection.legacyEventCount = events.length;
	return Object.freeze(projection);
}
