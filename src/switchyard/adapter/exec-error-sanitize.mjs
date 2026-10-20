import { isAbsolute } from "node:path";
import {
	CANCEL_SOURCES,
	CHECK_SETUP_STEPS,
	DETAIL_FIELD_TYPES,
	INTEGRATION_UNKNOWN_CAUSES,
	INTEGRATION_UNKNOWN_STEPS,
	sanitizeGitControlTamper,
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
// Evidence and executable references are filesystem paths a captain opens, so
// they are bounded by macOS PATH_MAX rather than the generic detail bound: a
// deep owned scratch root (a 115-character TMPDIR) pushes a check-evidence
// path past 256 characters, and a truncated path cannot be opened.
const DETAIL_PATH_REFERENCE_MAX_CHARS = 1024;
const CHECK_EXECUTABLE_LINE_PREFIX = "check command resolves to ";
const CHECK_EXECUTABLE_LINE_MIDDLE = " in the check sandbox but ";
const CHECK_EXECUTABLE_LINE_SUFFIX = " on the host.";
const CLOSED_CHECK_SETUP_STEPS = new Set(CHECK_SETUP_STEPS);
const CLOSED_CANCEL_SOURCES = new Set(CANCEL_SOURCES);
// The `git apply` metadata step and cause behind `integration_state_unknown`.
const CLOSED_INTEGRATION_UNKNOWN = Object.freeze({
	diffRejectionUnknownStep: new Set(INTEGRATION_UNKNOWN_STEPS),
	diffRejectionUnknownCause: new Set(INTEGRATION_UNKNOWN_CAUSES),
});
// `git_control_tampered` is minted by the harness's own git-control
// verification, never derived from provider output, so harness provenance
// with evidence is authoritative for it even though it is neither an
// adapter nor a launcher diagnostic.
const HARNESS_DIAGNOSTIC_CODES = new Set(["git_control_tampered"]);

const hasControlChars = (value) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

function sanitizeAbsoluteDetailPath(value) {
	return typeof value === "string" &&
		value.length <= DETAIL_PATH_REFERENCE_MAX_CHARS &&
		isAbsolute(value) &&
		!hasControlChars(value)
		? value
		: undefined;
}

// Task 2.8: one prose line naming where the check command's first word
// resolves in the check sandbox and on the host, or null when the two do not
// form a bounded absolute-path pair.
export function checkExecutableMessageLine(checkExecutable, hostExecutable) {
	const check = sanitizeAbsoluteDetailPath(checkExecutable);
	const host = sanitizeAbsoluteDetailPath(hostExecutable);
	if (check === undefined || host === undefined || check === host) return null;
	return `${CHECK_EXECUTABLE_LINE_PREFIX}${check}${CHECK_EXECUTABLE_LINE_MIDDLE}${host}${CHECK_EXECUTABLE_LINE_SUFFIX}`;
}

// True when `reason` is exactly `baseReason` plus the mismatch line.
export function isCheckExecutableMessage(reason, baseReason) {
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
	if (field === "cancelSource")
		return typeof value === "string" && CLOSED_CANCEL_SOURCES.has(value)
			? value
			: undefined;
	if (field === "checkSetupStep")
		return typeof value === "string" && CLOSED_CHECK_SETUP_STEPS.has(value)
			? value
			: undefined;
	if (Object.hasOwn(CLOSED_INTEGRATION_UNKNOWN, field))
		return typeof value === "string" &&
			CLOSED_INTEGRATION_UNKNOWN[field].has(value)
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
	if (
		field === "checkExecutable" ||
		field === "hostExecutable" ||
		field === "sandboxDeniedPath"
	)
		return sanitizeAbsoluteDetailPath(value);
	// Earlier releases persisted any bounded string here, so only the bound
	// differs from the generic rule.
	if (field === "outputPath")
		return typeof value === "string" &&
			value.length <= DETAIL_PATH_REFERENCE_MAX_CHARS &&
			!hasControlChars(value)
			? value
			: undefined;
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
	gitControlTamper,
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
	const safeGitControlTamper = sanitizeGitControlTamper(gitControlTamper);
	if (safeGitControlTamper) safe.gitControlTamper = safeGitControlTamper;
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
		"gitControlTamper",
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
		gitControlTamper: value.gitControlTamper,
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
		"gitControlTamper",
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
		if (field === "gitControlTamper") {
			const tamper = value[field];
			const safeTamper = safeDiagnostics?.[field];
			if (tamper === undefined && safeTamper === undefined) continue;
			if (
				!safeTamper ||
				tamper?.kind !== safeTamper.kind ||
				tamper?.area !== safeTamper.area ||
				Object.keys(tamper ?? {}).length !== 2
			)
				return false;
			continue;
		}
		if (value[field] !== safeDiagnostics?.[field]) return false;
	}
	return true;
}
