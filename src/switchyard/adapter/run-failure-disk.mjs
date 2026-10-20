// The on-disk form of a run record's failure: what the rollback-floor
// release (d48047a) can still read, and the in-memory upgrade back from it.
import {
	CODE_CATEGORIES,
	causeCategoryFor,
} from "../diagnostics/failure-registry.mjs";
import { isProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import {
	checkExecutableMessageLine,
	isCheckExecutableMessage,
	sanitizeFailureMetadata,
} from "./exec-error-sanitize.mjs";

// The closed `providerReliability` code-to-category map the previous release
// (d48047a) validates. Persisted
// `lastFailure.providerReliability` stays inside it so that release can still
// read new run records; a code outside it is stored as the frozen stand-in,
// which is what that release's classifier produced for those failures, and
// the precise code moves to `failureDetails.causeCode`. Deliberately a
// literal: a code registered later is downgraded until a release that reads
// it is the rollback floor.
const FROZEN_CODE_CATEGORY = new Map([
	["auth_expired", "provider"],
	["quota_exhausted", "provider"],
	["model_unavailable", "provider"],
	["cli_usage_error", "provider"],
	["execution_timed_out", "provider"],
	["provider_deadline_exceeded", "provider"],
	["provider_signalled", "provider"],
	["provider_exit_nonzero", "unknown"],
	["provider_launch_failed", "unknown"],
	["launch_failed", "unknown"],
	["provider_verdict_rejected", "unknown"],
	["check_repair_succeeded", "check"],
	["check_repair_failed", "check"],
	["baseline_check_failed", "environment"],
	["baseline_mutation", "environment"],
	["environment_failure", "environment"],
	["check_dependencies_unverified", "environment"],
	["run_store_write_failed", "environment"],
	["project_lock_failed", "environment"],
	["acceptance_check_failed", "check"],
	["acceptance_check_timeout", "check"],
	["diff_rejected", "policy"],
	["scope_rejected", "policy"],
	["input_rejected", "input"],
	["provider_cleanup_failed", "cleanup"],
	["cleanup_failed", "cleanup"],
	["cancelled", "cancellation"],
	["unknown", "unknown"],
]);
// A code the frozen release can store exactly: known to it under the same
// category the current registry assigns.
function frozenRepresentable(causeCode) {
	return (
		FROZEN_CODE_CATEGORY.has(causeCode) &&
		FROZEN_CODE_CATEGORY.get(causeCode) === causeCategoryFor(causeCode)
	);
}
const FROZEN_STAND_IN = Object.freeze({
	causeCode: "unknown",
	causeCategory: "unknown",
});
// Detail keys that unreleased builds of this change wrote inside `lastFailure`.
// Exactly this set is lifted into `failureDetails` on read; later detail
// fields were never written there.
const LEGACY_LAST_FAILURE_DETAIL_KEYS = Object.freeze([
	"failureReason",
	"timedOut",
	"cancelled",
	"checkIndex",
	"checkIdentity",
	"diffRejectionCategory",
	"diffRejectionCount",
	"diffRejectionRule",
	"diffRejectionPaths",
]);

const isPlainObject = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);

// The registry reason and the reason with the executable mismatch line that
// `failureDetails` rebuilds exactly, or null when the details name no pair.
function executableReasonParts(record) {
	const lastFailure = record.lastFailure;
	if (!isPlainObject(lastFailure) || typeof lastFailure.reason !== "string")
		return null;
	const details = isPlainObject(record.failureDetails)
		? record.failureDetails
		: null;
	const line = checkExecutableMessageLine(
		details?.checkExecutable,
		details?.hostExecutable,
	);
	if (line === null) return null;
	const base = sanitizeFailureMetadata({
		result: "execution_failed",
		errorKind: lastFailure.errorKind,
	})?.reason;
	if (typeof base !== "string") return null;
	// A path holding the line's own separator rebuilds a reason the validator
	// splits differently; such a pair is neither left off nor restored.
	const full = `${base}\n${line}`;
	return isCheckExecutableMessage(full, base) ? { base, full } : null;
}

/**
 * Returns the on-disk form of a run record: a copy whose
 * `lastFailure.providerReliability` uses only frozen cause codes, with the
 * precise code in `failureDetails.causeCode`, and whose `lastFailure.reason`
 * leaves off the executable mismatch line when `failureDetails` rebuilds it
 * exactly. The frozen release accepts only the registry reason; the read
 * upgrade appends the line again. Returns `record` itself when nothing
 * changes, and never mutates it.
 *
 * @param {object} record In-memory run record.
 * @returns {object} The record to serialize.
 */
export function projectRunFailureForDisk(record) {
	if (!isPlainObject(record)) return record;
	const projected = projectCauseCodeForDisk(record);
	const parts = executableReasonParts(projected);
	if (!parts || projected.lastFailure.reason !== parts.full) return projected;
	return {
		...projected,
		lastFailure: { ...projected.lastFailure, reason: parts.base },
	};
}

function projectCauseCodeForDisk(record) {
	const reliability = isPlainObject(record.lastFailure)
		? record.lastFailure.providerReliability
		: undefined;
	const preciseCode = isProviderReliabilityDiagnostic(reliability)
		? reliability.causeCode
		: null;
	const details = isPlainObject(record.failureDetails)
		? record.failureDetails
		: null;
	if (preciseCode === null || frozenRepresentable(preciseCode)) {
		// A stale precise code must not outlive the failure it described.
		if (!details || !Object.hasOwn(details, "causeCode")) return record;
		const { causeCode: _stale, ...rest } = details;
		return {
			...record,
			failureDetails: Object.keys(rest).length > 0 ? rest : null,
		};
	}
	return {
		...record,
		lastFailure: {
			...record.lastFailure,
			providerReliability: { ...reliability, ...FROZEN_STAND_IN },
		},
		failureDetails: { ...(details ?? {}), causeCode: preciseCode },
	};
}

/**
 * Upgrades a parsed run.json in memory, never on disk: lifts legacy detail
 * keys out of `lastFailure` into `failureDetails`, restores a precise cause
 * code that `projectRunFailureForDisk` stored as the frozen stand-in, and
 * appends the executable mismatch line it left off the reason.
 *
 * @param {object} record Parsed run.json object; mutated in place.
 * @returns {object} The same object.
 */
export function upgradeRunFailureFromDisk(record) {
	if (!isPlainObject(record) || !isPlainObject(record.lastFailure))
		return record;
	const lastFailure = record.lastFailure;
	const legacy = LEGACY_LAST_FAILURE_DETAIL_KEYS.filter((key) =>
		Object.hasOwn(lastFailure, key),
	);
	if (legacy.length > 0) {
		const details = isPlainObject(record.failureDetails)
			? { ...record.failureDetails }
			: {};
		for (const key of legacy) {
			if (!Object.hasOwn(details, key)) details[key] = lastFailure[key];
			delete lastFailure[key];
		}
		record.failureDetails = details;
	}
	const preciseCode = record.failureDetails?.causeCode;
	const reliability = lastFailure.providerReliability;
	if (
		typeof preciseCode === "string" &&
		!frozenRepresentable(preciseCode) &&
		CODE_CATEGORIES.has(preciseCode) &&
		isPlainObject(reliability) &&
		reliability.causeCode === FROZEN_STAND_IN.causeCode &&
		reliability.causeCategory === FROZEN_STAND_IN.causeCategory
	) {
		lastFailure.providerReliability = {
			...reliability,
			causeCode: preciseCode,
			causeCategory: causeCategoryFor(preciseCode),
		};
	}
	const parts = executableReasonParts(record);
	if (parts && lastFailure.reason === parts.base)
		lastFailure.reason = parts.full;
	return record;
}
