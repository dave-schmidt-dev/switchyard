import { isAbsolute } from "node:path";
import {
	CHECK_SETUP_STEPS,
	CODE_CATEGORIES,
	causeCategoryFor,
	DETAIL_FIELD_TYPES,
} from "../diagnostics/failure-registry.mjs";
import { isProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	checkpointDimensionsFromReason,
	checkpointRemediation,
	normalizedCheckpointDimensions,
	PERSISTED_DIAGNOSTIC_CODES,
	PERSISTED_FAILURE_PHASES,
} from "./exec-error-codes.mjs";
import {
	cleanupDiagnosticCodeFor,
	PERSISTED_SIGNALS,
} from "./exec-error-kinds.mjs";
import {
	hasAuthoritativeDiagnosticProvenance,
	normalizePersistentErrorKind,
	PERSISTED_ERROR_METADATA,
	RESULT_TO_ERROR_KIND,
	SUCCESS_RESULTS,
} from "./exec-error-metadata.mjs";

const DETAIL_FIELDS = Object.keys(DETAIL_FIELD_TYPES);
// exitCode and signal stay in `lastFailure` through their own closed inputs.
// Every other registered detail field is persisted in the top-level run.json
// `failureDetails` record, sanitized by its declared registry type, so a newly
// registered detail reaches run.json without editing this boundary. Keeping
// them out of `lastFailure` lets readers that validate its closed key set
// (rollback to an older release) still read the record.
const EXPLICIT_DETAIL_FIELDS = new Set(["exitCode", "signal"]);
const DETAIL_STRING_MAX_CHARS = 256;
const DETAIL_PATH_LIMIT = 5;
const DETAIL_PATH_MAX_CHARS = 200;
const CHECK_SETUP_EXECUTABLE_MAX_CHARS = 64;
const CHECK_SETUP_TOKEN_RE = /^[A-Za-z0-9_]{1,64}$/u;
const CHECK_EXECUTABLE_MAX_CHARS = 256;
const CHECK_EXECUTABLE_LINE_PREFIX = "check command resolves to ";
const CHECK_EXECUTABLE_LINE_MIDDLE = " in the check sandbox but ";
const CHECK_EXECUTABLE_LINE_SUFFIX = " on the host.";
const CLOSED_CHECK_SETUP_STEPS = new Set(CHECK_SETUP_STEPS);
// `git_control_tampered` is minted by the harness's own git-control
// verification, never derived from provider output, so harness provenance
// with evidence is authoritative for it even though it is neither an
// adapter nor a launcher diagnostic.
const HARNESS_DIAGNOSTIC_CODES = new Set(["git_control_tampered"]);

const hasControlChars = (value) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

function sanitizeAbsoluteDetailPath(value) {
	return typeof value === "string" &&
		value.length <= CHECK_EXECUTABLE_MAX_CHARS &&
		isAbsolute(value) &&
		!hasControlChars(value)
		? value
		: undefined;
}

// Task 2.8: one prose line naming where the check command's first word
// resolves in the check sandbox and on the host, or null when the two do not
// form a bounded absolute-path pair.
function checkExecutableMessageLine(checkExecutable, hostExecutable) {
	const check = sanitizeAbsoluteDetailPath(checkExecutable);
	const host = sanitizeAbsoluteDetailPath(hostExecutable);
	if (check === undefined || host === undefined || check === host) return null;
	return `${CHECK_EXECUTABLE_LINE_PREFIX}${check}${CHECK_EXECUTABLE_LINE_MIDDLE}${host}${CHECK_EXECUTABLE_LINE_SUFFIX}`;
}

// True when `reason` is exactly `baseReason` plus the mismatch line.
function isCheckExecutableMessage(reason, baseReason) {
	if (typeof reason !== "string" || typeof baseReason !== "string")
		return false;
	if (!reason.startsWith(`${baseReason}\n`)) return false;
	const line = reason.slice(baseReason.length + 1);
	if (
		!line.startsWith(CHECK_EXECUTABLE_LINE_PREFIX) ||
		!line.endsWith(CHECK_EXECUTABLE_LINE_SUFFIX)
	)
		return false;
	const middle = line.slice(
		CHECK_EXECUTABLE_LINE_PREFIX.length,
		line.length - CHECK_EXECUTABLE_LINE_SUFFIX.length,
	);
	const split = middle.indexOf(CHECK_EXECUTABLE_LINE_MIDDLE);
	if (split < 0) return false;
	const check = middle.slice(0, split);
	const host = middle.slice(split + CHECK_EXECUTABLE_LINE_MIDDLE.length);
	return checkExecutableMessageLine(check, host) === line;
}

function sanitizeDetailValue(field, value) {
	const type = DETAIL_FIELD_TYPES[field];
	if (type === "boolean") return typeof value === "boolean" ? value : undefined;
	if (type === "integer")
		return Number.isSafeInteger(value) && value >= 0 && value <= 4096
			? value
			: undefined;
	if (type === "stringArray") {
		if (!Array.isArray(value)) return undefined;
		const bounded = [];
		for (const item of value) {
			if (typeof item !== "string") continue;
			bounded.push(
				item.replace(/\p{Cc}/gu, "?").slice(0, DETAIL_PATH_MAX_CHARS),
			);
			if (bounded.length === DETAIL_PATH_LIMIT) break;
		}
		return bounded;
	}
	if (field === "checkSetupStep")
		return typeof value === "string" && CLOSED_CHECK_SETUP_STEPS.has(value)
			? value
			: undefined;
	if (field === "checkSetupErrorCode" || field === "checkSetupSyscall")
		return typeof value === "string" && CHECK_SETUP_TOKEN_RE.test(value)
			? value
			: undefined;
	if (field === "checkSetupExecutable")
		return typeof value === "string" &&
			value.length > 0 &&
			value.length <= CHECK_SETUP_EXECUTABLE_MAX_CHARS &&
			!/[/\\]/u.test(value) &&
			!hasControlChars(value)
			? value
			: undefined;
	if (field === "checkExecutable" || field === "hostExecutable")
		return sanitizeAbsoluteDetailPath(value);
	return typeof value === "string" &&
		value.length <= DETAIL_STRING_MAX_CHARS &&
		!hasControlChars(value)
		? value
		: undefined;
}

export function sanitizeFailureMetadata({
	result,
	errorKind,
	timedOut = false,
	artifactRef,
	diagnosticCode,
	diagnosticOrigin,
	diagnosticEvidenceAvailable,
	exitCode,
	signal,
	failurePhase,
	cleanupStage,
	resolvedTargetId,
	descriptorIdentity,
	descriptorHarness,
	diagnosticRef,
	checkpointCode,
	checkpointDimensions,
	providerReliability,
	checkExecutable,
	hostExecutable,
} = {}) {
	if (!result || SUCCESS_RESULTS.has(result)) return null;
	const requestedKind = normalizePersistentErrorKind(errorKind);
	const kind =
		requestedKind ??
		RESULT_TO_ERROR_KIND[result] ??
		(timedOut ? "execution_timed_out" : "unknown_failure");
	const metadata = PERSISTED_ERROR_METADATA[kind];
	const safe = {
		errorKind: kind,
		reasonCode: metadata.reasonCode,
		reason: metadata.reason,
	};
	if (isProviderReliabilityDiagnostic(providerReliability)) {
		safe.providerReliability = providerReliability;
	}
	const normalizedCheckpointCode =
		typeof checkpointCode === "string" &&
		Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, checkpointCode)
			? checkpointCode
			: null;
	const normalizedDimensions =
		normalizedCheckpointDimensions(checkpointDimensions);
	if (normalizedCheckpointCode) {
		safe.reasonCode = normalizedCheckpointCode;
		safe.reason = checkpointRemediation(normalizedCheckpointCode, {
			dimensions: normalizedDimensions,
		});
		safe.checkpointCode = normalizedCheckpointCode;
		safe.checkpointDimensions = normalizedDimensions;
	}
	const safeCleanupDiagnostic = cleanupDiagnosticCodeFor(cleanupStage);
	const harnessAuthoritative =
		HARNESS_DIAGNOSTIC_CODES.has(diagnosticCode) &&
		diagnosticOrigin === "harness" &&
		diagnosticEvidenceAvailable === true;
	const closedDiagnosticCode = harnessAuthoritative
		? diagnosticCode
		: PERSISTED_DIAGNOSTIC_CODES.includes(diagnosticCode)
			? diagnosticCode
			: safeCleanupDiagnostic;
	const hasProvenanceInput =
		diagnosticOrigin !== undefined || diagnosticEvidenceAvailable !== undefined;
	const authoritativeProvenance = hasAuthoritativeDiagnosticProvenance({
		diagnosticCode: closedDiagnosticCode,
		diagnosticOrigin,
		diagnosticEvidenceAvailable,
		failurePhase,
	});
	const trustedDiagnosticShape = hasAuthoritativeDiagnosticProvenance({
		diagnosticCode: closedDiagnosticCode,
		diagnosticOrigin,
		diagnosticEvidenceAvailable: true,
		failurePhase,
	});
	if (
		closedDiagnosticCode &&
		(harnessAuthoritative ||
			!hasProvenanceInput ||
			authoritativeProvenance ||
			trustedDiagnosticShape)
	) {
		safe.diagnosticCode = closedDiagnosticCode;
	}
	if (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
		safe.exitCode = exitCode;
	}
	if (PERSISTED_SIGNALS.has(signal)) safe.signal = signal;
	if (PERSISTED_FAILURE_PHASES.has(failurePhase)) {
		safe.failurePhase = failurePhase;
	}
	if (
		(authoritativeProvenance ||
			trustedDiagnosticShape ||
			harnessAuthoritative) &&
		diagnosticEvidenceAvailable === true
	) {
		safe.diagnosticOrigin = diagnosticOrigin;
		safe.diagnosticEvidenceAvailable = true;
	}
	if (diagnosticEvidenceAvailable === false) {
		safe.diagnosticEvidenceAvailable = false;
	}
	if (
		typeof artifactRef === "string" &&
		/^artifact:[a-f0-9]{24}$/u.test(artifactRef)
	) {
		safe.artifactRef = artifactRef;
	}
	if (trustedDiagnosticShape && diagnosticEvidenceAvailable !== true) {
		safe.diagnosticOrigin = diagnosticOrigin;
	}
	if (
		typeof diagnosticRef === "string" &&
		/^diagnostic:[a-f0-9]{32}$/u.test(diagnosticRef) &&
		diagnosticEvidenceAvailable === true
	) {
		safe.diagnosticRef = diagnosticRef;
	}
	// Route identity is additive, bounded provenance. It is deliberately
	// independent from raw invocation arguments so it is safe in public state.
	if (
		typeof resolvedTargetId === "string" &&
		resolvedTargetId.length > 0 &&
		resolvedTargetId.length <= 256 &&
		!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(resolvedTargetId) &&
		typeof descriptorIdentity === "string" &&
		/^sha256:[a-f0-9]{64}$/.test(descriptorIdentity) &&
		typeof descriptorHarness === "string" &&
		descriptorHarness.length > 0 &&
		descriptorHarness.length <= 128 &&
		!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(descriptorHarness)
	) {
		safe.resolvedTargetId = resolvedTargetId;
		safe.descriptorIdentity = descriptorIdentity;
		safe.descriptorHarness = descriptorHarness;
	}
	// Task 2.8: a dry-run environment failure can name both interpretations of
	// the check command's first word; the line joins the human-readable reason.
	const executableLine = checkExecutableMessageLine(
		checkExecutable,
		hostExecutable,
	);
	if (executableLine !== null)
		safe.reason = `${safe.reason}\n${executableLine}`;
	return safe;
}

/**
 * Sanitizes registered failure details for the run.json `failureDetails` field.
 *
 * @param {object|null|undefined} failureDetails Raw detail values keyed by
 *   registered detail field.
 * @returns {object|null} The typed, bounded details, or null when none survive.
 */
export function sanitizeFailureDetails(failureDetails) {
	if (failureDetails === null || typeof failureDetails !== "object")
		return null;
	const safe = {};
	for (const field of DETAIL_FIELDS) {
		if (EXPLICIT_DETAIL_FIELDS.has(field) || !(field in failureDetails))
			continue;
		const sanitized = sanitizeDetailValue(field, failureDetails[field]);
		if (sanitized !== undefined) safe[field] = sanitized;
	}
	return Object.keys(safe).length > 0 ? safe : null;
}

/** True when `value` is exactly what sanitizeFailureDetails would persist. */
export function isPersistentFailureDetails(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const safe = sanitizeFailureDetails(value);
	if (!safe || Object.keys(value).length !== Object.keys(safe).length)
		return false;
	return Object.keys(value).every((field) => {
		const stored = value[field];
		const clean = safe[field];
		if (Array.isArray(stored) || Array.isArray(clean))
			return (
				Array.isArray(stored) &&
				Array.isArray(clean) &&
				stored.length === clean.length &&
				stored.every((item, index) => item === clean[index])
			);
		return stored === clean;
	});
}
export function isPersistentFailureMetadata(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const allowedKeys = new Set([
		"errorKind",
		"reasonCode",
		"reason",
		"artifactRef",
		"diagnosticCode",
		"exitCode",
		"signal",
		"failurePhase",
		"diagnosticOrigin",
		"diagnosticEvidenceAvailable",
		"resolvedTargetId",
		"descriptorIdentity",
		"descriptorHarness",
		"diagnosticRef",
		"checkpointCode",
		"checkpointDimensions",
		"providerReliability",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
	const expected = sanitizeFailureMetadata({
		result: "execution_failed",
		errorKind: value.errorKind,
	});
	if (!expected) return false;
	const checkpointCode =
		typeof value.checkpointCode === "string" &&
		Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, value.checkpointCode)
			? value.checkpointCode
			: typeof value.reasonCode === "string" &&
					Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, value.reasonCode)
				? value.reasonCode
				: null;
	const checkpointDimensions =
		value.checkpointDimensions !== undefined
			? normalizedCheckpointDimensions(value.checkpointDimensions)
			: checkpointDimensionsFromReason(checkpointCode, value.reason);
	const checkpointReason = checkpointCode
		? checkpointRemediation(checkpointCode, {
				dimensions: checkpointDimensions,
			})
		: null;
	if (
		(value.reasonCode !== expected.reasonCode &&
			value.reasonCode !== checkpointCode) ||
		(value.reason !== expected.reason &&
			value.reason !== checkpointReason &&
			!isCheckExecutableMessage(value.reason, expected.reason)) ||
		(checkpointCode && value.reasonCode !== checkpointCode) ||
		(checkpointCode && value.reason !== checkpointReason) ||
		(value.checkpointDimensions !== undefined &&
			(!Array.isArray(value.checkpointDimensions) ||
				value.checkpointDimensions.length !== checkpointDimensions.length)) ||
		(value.checkpointCode !== undefined &&
			value.checkpointCode !== checkpointCode)
	) {
		return false;
	}
	if (value.artifactRef !== undefined) {
		if (
			typeof value.artifactRef !== "string" ||
			!/^artifact:[a-f0-9]{24}$/.test(value.artifactRef)
		) {
			return false;
		}
	}
	if (
		value.diagnosticRef !== undefined &&
		(typeof value.diagnosticRef !== "string" ||
			!/^diagnostic:[a-f0-9]{32}$/u.test(value.diagnosticRef))
	)
		return false;
	const safeDiagnostics = sanitizeFailureMetadata({
		result: "execution_failed",
		diagnosticCode: value.diagnosticCode,
		exitCode: value.exitCode,
		signal: value.signal,
		failurePhase: value.failurePhase,
		diagnosticOrigin: value.diagnosticOrigin,
		diagnosticEvidenceAvailable: value.diagnosticEvidenceAvailable,
		resolvedTargetId: value.resolvedTargetId,
		descriptorIdentity: value.descriptorIdentity,
		descriptorHarness: value.descriptorHarness,
		diagnosticRef: value.diagnosticRef,
		checkpointCode: value.checkpointCode,
		checkpointDimensions: value.checkpointDimensions,
		providerReliability: value.providerReliability,
	});
	for (const field of [
		"diagnosticCode",
		"exitCode",
		"signal",
		"failurePhase",
		"diagnosticOrigin",
		"diagnosticEvidenceAvailable",
		"resolvedTargetId",
		"descriptorIdentity",
		"descriptorHarness",
		"diagnosticRef",
		"checkpointCode",
		"checkpointDimensions",
		"providerReliability",
	]) {
		if (field === "checkpointDimensions") {
			if (value[field] === undefined && safeDiagnostics?.[field] === undefined)
				continue;
			if (
				!Array.isArray(value[field]) ||
				!Array.isArray(safeDiagnostics?.[field]) ||
				value[field].length !== safeDiagnostics[field].length ||
				value[field].some(
					(dimension, index) => dimension !== safeDiagnostics[field][index],
				)
			)
				return false;
			continue;
		}
		if (value[field] !== safeDiagnostics?.[field]) return false;
	}
	return true;
}

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

/**
 * Returns the on-disk form of a run record: a copy whose
 * `lastFailure.providerReliability` uses only frozen cause codes, with the
 * precise code in `failureDetails.causeCode`. Returns `record` itself when
 * nothing changes, and never mutates it.
 *
 * @param {object} record In-memory run record.
 * @returns {object} The record to serialize.
 */
export function projectRunFailureForDisk(record) {
	if (!isPlainObject(record)) return record;
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
 * keys out of `lastFailure` into `failureDetails`, and restores a precise
 * cause code that `projectRunFailureForDisk` stored as the frozen stand-in.
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
	return record;
}
