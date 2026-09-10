import { createHash } from "node:crypto";
import { reduceOutcomeEvents } from "./reducer.mjs";

/** Version of the additive shadow envelope. */
const OUTCOME_SHADOW_VERSION = 1;
const FAILURE_LIMIT = 16;
const DIAGNOSTIC_LIMIT = 16;
const EXPECTED_DIFFERENCE_KEYS = new Set([
	"version",
	"fixture",
	"fixtureDigest",
	"field",
	"legacyValue",
	"reducerValue",
	"evidenceBasis",
	"reviewerDisposition",
]);
const EVIDENCE_BASES = new Set(["sanitized_fixture", "historical_record"]);
const REVIEW_DISPOSITIONS = new Set(["accepted", "resolved"]);
const PROJECTION_KEYS = new Set([
	"projectionVersion",
	"runId",
	"finalStatus",
	"primaryFailure",
	"secondaryFailures",
	"diagnosticEvidence",
	"artifactOutcome",
	"integrationOutcome",
	"cleanupOutcome",
	"recoveryOutcome",
	"postconditionOutcome",
	"taskCounters",
	"reviewProof",
	"modelProof",
	"attempts",
	"causalIntegrity",
	"identityConflicts",
	"duplicateOutcomes",
]);
const PARITY_KEYS = new Set([
	"version",
	"status",
	"legacyStatus",
	"reducerStatus",
	"legacyDigest",
	"reducerDigest",
	"mismatchFields",
	"cutoverBlocked",
	"mismatchCount",
	"mismatchDigest",
	"evidence",
	"expectedHistoricalDifferences",
]);

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** Return a non-reversible digest for bounded parity records. */
export function shadowDigest(value) {
	return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function boundedFailure(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result = {};
	for (const key of [
		"stage",
		"status",
		"code",
		"reasonCode",
		"sequence",
		"outcomeId",
		"taskId",
		"attemptId",
		"attempt",
		"operationId",
		"causedBy",
		"evidence",
		"legacyPhase",
		"legacyEvent",
		"diagnosticRef",
	]) {
		if (value[key] !== undefined) result[key] = value[key];
	}
	return result;
}

function boundedFailures(values) {
	return (Array.isArray(values) ? values : [])
		.slice(0, FAILURE_LIMIT)
		.map(boundedFailure)
		.filter(Boolean);
}

/** Remove unbounded reducer detail while retaining evidence needed for parity. */
function sanitizeShadowProjection(projection) {
	return {
		projectionVersion: projection?.projectionVersion ?? 1,
		runId: projection?.runId ?? null,
		finalStatus: projection?.finalStatus ?? "unknown",
		primaryFailure: boundedFailure(projection?.primaryFailure),
		secondaryFailures: boundedFailures(projection?.secondaryFailures),
		diagnosticEvidence: {
			status: projection?.diagnosticEvidence?.status ?? "unknown",
			available: projection?.diagnosticEvidence?.available === true,
			diagnosticRefs: Array.isArray(
				projection?.diagnosticEvidence?.diagnosticRefs,
			)
				? projection.diagnosticEvidence.diagnosticRefs.slice(
						0,
						DIAGNOSTIC_LIMIT,
					)
				: [],
			origins: Array.isArray(projection?.diagnosticEvidence?.origins)
				? projection.diagnosticEvidence.origins.slice(0, DIAGNOSTIC_LIMIT)
				: [],
		},
		artifactOutcome: boundedFailure(projection?.artifactOutcome),
		integrationOutcome: boundedFailure(projection?.integrationOutcome),
		cleanupOutcome: boundedFailure(projection?.cleanupOutcome),
		recoveryOutcome: boundedFailure(projection?.recoveryOutcome),
		postconditionOutcome: boundedFailure(projection?.postconditionOutcome),
		taskCounters: projection?.taskCounters ?? null,
		reviewProof: {
			status: projection?.reviewProof?.status ?? "unknown",
			reviewResult: projection?.reviewProof?.reviewResult ?? null,
		},
		modelProof: {
			status: projection?.modelProof?.status ?? "unknown",
			servedModelVerified: projection?.modelProof?.servedModelVerified ?? null,
			completionContinuationProof:
				projection?.modelProof?.completionContinuationProof ?? null,
			targetId: projection?.modelProof?.targetId ?? null,
		},
		attempts: Array.isArray(projection?.attempts)
			? projection.attempts.slice(0, FAILURE_LIMIT)
			: [],
		causalIntegrity: projection?.causalIntegrity ?? null,
		identityConflicts: Array.isArray(projection?.identityConflicts)
			? projection.identityConflicts.slice(0, FAILURE_LIMIT)
			: [],
		duplicateOutcomes: Array.isArray(projection?.duplicateOutcomes)
			? projection.duplicateOutcomes.slice(0, FAILURE_LIMIT)
			: [],
	};
}

function safeDifferenceValue(value) {
	if (value === null || typeof value === "boolean") return true;
	if (typeof value !== "string") return false;
	return (
		value.length > 0 &&
		value.length <= 256 &&
		!value.startsWith("/") &&
		!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
	);
}

/** Validate the closed historical exception record used by cutover evidence. */
export function validateExpectedDifference(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("historical parity record must be an object");
	if (
		Object.keys(value).some((key) => !EXPECTED_DIFFERENCE_KEYS.has(key)) ||
		value.version !== 1 ||
		typeof value.fixture !== "string" ||
		!safeDifferenceValue(value.fixture) ||
		typeof value.fixtureDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(value.fixtureDigest) ||
		typeof value.field !== "string" ||
		!safeDifferenceValue(value.field) ||
		!safeDifferenceValue(value.legacyValue) ||
		!safeDifferenceValue(value.reducerValue) ||
		!EVIDENCE_BASES.has(value.evidenceBasis) ||
		!REVIEW_DISPOSITIONS.has(value.reviewerDisposition)
	)
		throw new TypeError("historical parity record is not closed or sanitized");
	return value;
}

function legacyStatus(run) {
	if (run?.state === "recovery_required") return "recovery_required";
	if (run?.state === "failed") return "failed";
	if (run?.state === "succeeded") return "succeeded";
	if (run?.state === "deferred") return "skipped";
	return "unknown";
}

function recoveryQueue(projection) {
	if (projection?.finalStatus !== "recovery_required") return [];
	const orphan = projection.outcomes?.find(
		(event) =>
			event.stage === "recovery" &&
			(event.detail?.reasonCode === "orphan_attempt" ||
				event.detail?.code === "recovery_required"),
	);
	return [
		{
			version: 1,
			status: "queued",
			reasonCode: orphan?.detail?.reasonCode ?? "recovery_required",
			automaticRetry: false,
			executionSlotConsumed: false,
			operatorCommand: "switchyard-dispatch recover",
		},
	];
}

/**
 * Compare the legacy terminal state with the reducer projection. This is
 * intentionally status-only for the compatibility floor; missing historical
 * fields are evidence of an older record, not guessed values.
 */
export function compareShadowParity(legacy, reducer, options = {}) {
	const expected = (options.expectedHistoricalDifferences ?? []).map(
		validateExpectedDifference,
	);
	const fields = [];
	if (legacy?.status !== "unknown" && legacy.status !== reducer.finalStatus)
		fields.push("finalStatus");
	const historical = expected.filter(
		(entry) =>
			entry.fixture === options.fixture &&
			entry.fixtureDigest === options.fixtureDigest &&
			entry.reviewerDisposition === "accepted",
	);
	const unresolved = fields.filter(
		(field) =>
			!historical.some(
				(entry) => entry.fixture === options.fixture && entry.field === field,
			),
	);
	const invalidHistoricalValues = historical.filter(
		(entry) =>
			entry.field === "finalStatus" &&
			(entry.legacyValue !== legacy?.status ||
				entry.reducerValue !== reducer?.finalStatus),
	);
	return {
		status:
			unresolved.length === 0 && invalidHistoricalValues.length === 0
				? "match"
				: "mismatch",
		mismatchFields: [
			...unresolved,
			...invalidHistoricalValues.map((entry) => `${entry.field}:record`),
		],
		allowedHistoricalDifferences: historical,
	};
}

/**
 * Build a deterministic, sanitized reducer projection and parity envelope.
 * The typed event log is replayed on every call; no historical record is
 * rewritten and no raw provider content crosses this boundary.
 */
export function projectOutcomeShadow(
	events,
	{
		run = null,
		fixture = null,
		fixtureDigest = null,
		expectedHistoricalDifferences = [],
	} = {},
) {
	if (!Array.isArray(events))
		throw new TypeError("shadow events must be an array");
	try {
		const reduced = reduceOutcomeEvents(events, { runId: run?.runId });
		const projection = sanitizeShadowProjection(reduced);
		const legacy = { status: legacyStatus(run) };
		const parity = compareShadowParity(legacy, projection, {
			fixture,
			fixtureDigest,
			expectedHistoricalDifferences,
		});
		const unavailable =
			legacy.status !== "unknown" && projection.finalStatus === "unknown";
		const status = unavailable ? "unavailable" : parity.status;
		return {
			version: OUTCOME_SHADOW_VERSION,
			projection,
			parity: {
				version: OUTCOME_SHADOW_VERSION,
				status,
				legacyStatus: legacy.status,
				reducerStatus: projection.finalStatus,
				legacyDigest: shadowDigest({
					state: run?.state ?? null,
					cleanupState: run?.cleanupState ?? null,
					terminalSummary: run?.terminalSummary ?? null,
				}),
				reducerDigest: shadowDigest(projection),
				mismatchFields: unavailable ? ["history"] : parity.mismatchFields,
				expectedHistoricalDifferences: parity.allowedHistoricalDifferences,
				cutoverBlocked: status === "mismatch",
				mismatchCount: status === "mismatch" ? 1 : 0,
				mismatchDigest:
					status === "mismatch"
						? shadowDigest({
								legacyStatus: legacy.status,
								reducerStatus: projection.finalStatus,
								mismatchFields: parity.mismatchFields,
							})
						: null,
				evidence: "shadow",
			},
			recoveryQueue: recoveryQueue(reduced),
		};
	} catch {
		return unavailableShadow(run);
	}
}

function unavailableShadow(run) {
	const status = legacyStatus(run);
	return {
		version: OUTCOME_SHADOW_VERSION,
		projection: sanitizeShadowProjection({
			runId: run?.runId,
			finalStatus: "unknown",
		}),
		parity: {
			version: OUTCOME_SHADOW_VERSION,
			status: "unavailable",
			legacyStatus: status,
			reducerStatus: "unknown",
			legacyDigest: null,
			reducerDigest: null,
			mismatchFields: ["history"],
			evidence: "shadow",
		},
		recoveryQueue: [],
	};
}

/** Preserve an observed mismatch for the lifetime of a run. */
export function mergeOutcomeShadow(previous, next) {
	if (!previous || typeof previous !== "object") return next;
	const prior = previous.parity ?? {};
	const current = next.parity ?? {};
	const priorDigest = prior.mismatchDigest ?? null;
	const mismatchDigest =
		current.status === "mismatch"
			? shadowDigest({
					legacyStatus: current.legacyStatus,
					reducerStatus: current.reducerStatus,
					mismatchFields: current.mismatchFields,
				})
			: priorDigest;
	const mismatchCount =
		(prior.mismatchCount ?? 0) +
		(current.status === "mismatch" && mismatchDigest !== priorDigest ? 1 : 0);
	if (prior.cutoverBlocked !== true && current.status !== "mismatch")
		return { ...next, parity: { ...current, mismatchCount, mismatchDigest } };
	return {
		...next,
		parity: {
			...current,
			status: "mismatch",
			mismatchFields: [
				...new Set([
					...(prior.mismatchFields ?? []),
					...(current.mismatchFields ?? []),
				]),
			],
			cutoverBlocked: true,
			mismatchCount,
			mismatchDigest: mismatchDigest ?? priorDigest,
		},
	};
}

/** Validate the closed envelope before a compatibility consumer copies it. */
export function validateShadowEnvelope(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("shadow envelope must be an object");
	if (
		value.version !== OUTCOME_SHADOW_VERSION ||
		!value.projection ||
		!value.parity ||
		!Array.isArray(value.recoveryQueue) ||
		Object.keys(value).some(
			(key) =>
				!["version", "projection", "parity", "recoveryQueue"].includes(key),
		)
	)
		throw new TypeError("shadow envelope is not closed");
	if (
		value.parity.version !== OUTCOME_SHADOW_VERSION ||
		!new Set(["match", "mismatch", "unavailable"]).has(value.parity.status) ||
		Object.keys(value.projection).some((key) => !PROJECTION_KEYS.has(key)) ||
		Object.keys(value.parity).some((key) => !PARITY_KEYS.has(key))
	)
		throw new TypeError("shadow parity is invalid");
	assertSafeShadowValue(value.projection);
	assertSafeShadowValue(value.parity);
	assertSafeShadowValue(value.recoveryQueue);
	for (const item of value.recoveryQueue) {
		if (
			!item ||
			typeof item !== "object" ||
			item.version !== 1 ||
			item.status !== "queued" ||
			item.automaticRetry !== false ||
			item.executionSlotConsumed !== false ||
			item.operatorCommand !== "switchyard-dispatch recover" ||
			Object.keys(item).some(
				(key) =>
					![
						"version",
						"status",
						"reasonCode",
						"automaticRetry",
						"executionSlotConsumed",
						"operatorCommand",
					].includes(key),
			)
		)
			throw new TypeError("shadow recovery queue is invalid");
	}
	for (const expected of value.parity.expectedHistoricalDifferences ?? [])
		validateExpectedDifference(expected);
	return value;
}

function assertSafeShadowValue(value, path = "shadow") {
	if (value === null || typeof value === "boolean" || typeof value === "number")
		return;
	if (typeof value === "string") {
		if (
			value.length > 4096 ||
			value.startsWith("/") ||
			/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
		)
			throw new TypeError(`${path} contains unsafe content`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) throw new TypeError(`${path} is unbounded`);
		value.forEach((item, index) => {
			assertSafeShadowValue(item, `${path}[${index}]`);
		});
		return;
	}
	if (!value || typeof value !== "object")
		throw new TypeError(`${path} is invalid`);
	for (const [key, item] of Object.entries(value)) {
		if (
			/(?:prompt|stream|exception|patch|credential|secret|environment|hostpath|stdout|stderr)/iu.test(
				key,
			)
		)
			throw new TypeError(`${path} contains forbidden content`);
		assertSafeShadowValue(item, `${path}.${key}`);
	}
}
