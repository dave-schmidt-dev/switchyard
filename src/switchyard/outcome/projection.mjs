import { reduceOutcomeEvents } from "./reducer.mjs";
import { isOutcomeEvent } from "./schema.mjs";
import { projectOutcomeShadow, validateShadowEnvelope } from "./shadow.mjs";

const LEGACY_STATES = new Set([
	"created",
	"launching",
	"launcher_ready",
	"running",
	"succeeded",
	"failed",
	"deferred",
	"recovery_required",
]);

function legacyStatus(run) {
	if (run?.state === "recovery_required") return "recovery_required";
	if (run?.state === "failed") return "failed";
	if (run?.state === "succeeded") return "succeeded";
	if (run?.state === "deferred") return "skipped";
	return "unknown";
}

function readerOverride(options) {
	const requested = options?.reader;
	if (requested === undefined || requested === "") return null;
	if (requested === "legacy") return "legacy";
	throw new TypeError("test outcome reader must be legacy");
}

function completeMatchingShadow(shadow) {
	try {
		validateShadowEnvelope(shadow);
		return (
			shadow.version === 1 &&
			shadow.projection?.projectionVersion === 1 &&
			typeof shadow.projection?.finalStatus === "string" &&
			shadow.parity.status === "match" &&
			shadow.parity.evidence === "shadow" &&
			shadow.parity.cutoverBlocked !== true &&
			shadow.parity.reducerStatus === shadow.projection.finalStatus &&
			shadow.parity.legacyStatus === shadow.projection.finalStatus &&
			Array.isArray(shadow.parity.mismatchFields) &&
			shadow.parity.mismatchFields.length === 0
		);
	} catch {
		return false;
	}
}

/** Return true when an event log contains at least one validated typed event. */
function hasTypedOutcomeEvents(events) {
	return Array.isArray(events) && events.some((event) => isOutcomeEvent(event));
}

/**
 * Preserve a legacy run without manufacturing typed fields.
 *
 * Older runs may contain only the historical run.json and legacy events. The
 * adapter intentionally carries the fields that were actually persisted and
 * leaves artifact, retry, diagnostic, and counter fields absent when absent.
 */
function projectLegacyOutcome(run, events = []) {
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
	if (Array.isArray(events)) projection.legacyEventCount = events.length;
	return Object.freeze(projection);
}

/**
 * Select the authoritative reader for a run.
 *
 * New records with typed outcomes use the reducer by default. Historical
 * records without typed events use the conservative adapter above. A caller
 * can pass `reader: "legacy"` only for the documented test rollback.
 */
export function projectOutcomeReader({ run = null, events = [], reader } = {}) {
	if (!Array.isArray(events))
		throw new TypeError("outcome events must be an array");
	const override = readerOverride({ reader });
	const typed = hasTypedOutcomeEvents(events);
	const persistedShadow = run?.outcomeShadow;
	const freshShadow = typed ? projectOutcomeShadow(events, { run }) : null;
	if (
		override === "legacy" ||
		!typed ||
		!completeMatchingShadow(persistedShadow) ||
		!completeMatchingShadow(freshShadow)
	)
		return projectLegacyOutcome(run, events);
	// Reduce the same closed event set that established parity. Filtering after
	// the gate would authorize a projection different from the one reviewed.
	const projection = reduceOutcomeEvents(events, { runId: run?.runId });
	return Object.freeze({
		...projection,
		reader: "reducer",
		historical: false,
		typedEventCount: events.filter((event) => isOutcomeEvent(event)).length,
	});
}

/**
 * Apply a reducer terminal state to a compatibility run snapshot.
 * Live lifecycle states remain owned by run-store; only terminal truth is
 * replaced, preventing a stale typed event from making a live run appear
 * complete while retaining conservative legacy behavior for old records.
 */
export function applyOutcomeProjection(run, projection) {
	if (!run || !projection || projection.reader !== "reducer") return run;
	const nextState =
		projection.finalStatus === "recovery_required"
			? "recovery_required"
			: projection.finalStatus === "succeeded"
				? "succeeded"
				: projection.finalStatus === "failed"
					? "failed"
					: projection.finalStatus === "skipped"
						? "deferred"
						: projection.finalStatus === "uncertain"
							? "recovery_required"
							: null;
	if (!nextState || !LEGACY_STATES.has(run.state)) return run;
	if (
		nextState === run.state ||
		(!["succeeded", "failed", "deferred", "recovery_required"].includes(
			run.state,
		) &&
			nextState !== "recovery_required")
	)
		return run;
	return { ...run, state: nextState };
}

/** Read the projection retained in a checkpoint, if one was captured. */
export function projectCheckpointOutcome(checkpoint) {
	const shadow = checkpoint?.outcomeShadow;
	const captured = checkpoint?.outcomeProjection;
	if (
		!completeMatchingShadow(shadow) ||
		!captured ||
		captured.reader !== "reducer" ||
		captured.historical !== false ||
		captured.projectionVersion !== 1 ||
		!Number.isInteger(captured.typedEventCount) ||
		captured.typedEventCount < 1 ||
		captured.runId !== shadow.projection.runId ||
		captured.finalStatus !== shadow.projection.finalStatus ||
		JSON.stringify(captured.taskCounters ?? null) !==
			JSON.stringify(shadow.projection.taskCounters ?? null)
	)
		return null;
	return Object.freeze({
		...shadow.projection,
		reader: "reducer",
		historical: false,
		typedEventCount: captured.typedEventCount,
	});
}
