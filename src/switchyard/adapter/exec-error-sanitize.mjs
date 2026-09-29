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
	const closedDiagnosticCode = PERSISTED_DIAGNOSTIC_CODES.includes(
		diagnosticCode,
	)
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
		(!hasProvenanceInput || authoritativeProvenance || trustedDiagnosticShape)
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
		(authoritativeProvenance || trustedDiagnosticShape) &&
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
	return safe;
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
		(value.reason !== expected.reason && value.reason !== checkpointReason) ||
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
