import { createHash } from "node:crypto";
import { boundCompletionContinuationProof } from "../adapter/provider-lifecycle.mjs";
import { sanitizeReviewResult } from "../diagnostics/review-result.mjs";
import { validateOutcomeEvent } from "../outcome/schema.mjs";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH_RE = /^sha256:[a-f0-9]{64}$/u;
const DIAGNOSTIC_RE = /^diagnostic:[a-f0-9]{32}$/u;

function safeId(value, label, nullable = false) {
	if (nullable && value === null) return null;
	if (typeof value !== "string" || !ID_RE.test(value))
		throw new TypeError(`${label} must be a safe identifier`);
	return value;
}

function hashId(value) {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function routeIdentity(route) {
	if (!route?.provider) return null;
	return {
		targetId: safeId(route.resolvedTarget, "route.resolvedTarget"),
	};
}

function boundedDiagnosticRef(value) {
	return typeof value === "string" && DIAGNOSTIC_RE.test(value) ? value : null;
}

function boundedBoolean(value) {
	return typeof value === "boolean" ? value : null;
}

function outcomeStatus(outcome, cancelled) {
	if (cancelled) return "skipped";
	return outcome === "success" ? "succeeded" : "failed";
}

function detailForExecution({ route, launcherResult, cancelled, preLaunch }) {
	const detail = {
		code: preLaunch
			? "execution_cancelled"
			: cancelled
				? "execution_cancelled"
				: launcherResult?.success === true
					? "execution_succeeded"
					: "execution_failed",
	};
	if (route?.provider) {
		const identity = routeIdentity(route);
		Object.assign(detail, identity);
	}
	if (!preLaunch && launcherResult) {
		const review = launcherResult.reviewResult;
		if (review) detail.reviewResult = sanitizeReviewResult(review);
		const served = boundedBoolean(launcherResult.servedModelVerified);
		if (served !== null) detail.servedModelVerified = served;
		const proof = boundCompletionContinuationProof(
			launcherResult.completionContinuationProof,
		);
		if (proof) detail.completionContinuationProof = proof;
		if (
			typeof launcherResult.errorKind === "string" &&
			ID_RE.test(launcherResult.errorKind)
		)
			detail.exitClassification = launcherResult.errorKind;
		if (
			typeof launcherResult.diagnosticOrigin === "string" &&
			ID_RE.test(launcherResult.diagnosticOrigin)
		)
			detail.diagnosticOrigin = launcherResult.diagnosticOrigin;
		if (typeof launcherResult.diagnosticEvidenceAvailable === "boolean")
			detail.evidenceAvailable = launcherResult.diagnosticEvidenceAvailable;
		const diagnosticRef = boundedDiagnosticRef(launcherResult.diagnosticRef);
		if (diagnosticRef) detail.diagnosticRef = diagnosticRef;
	}
	return detail;
}

function commonOutcome({
	request,
	route,
	writerEpoch,
	outcomeId,
	operationId,
	causedBy,
	dispatchCausality,
	attempt,
	detail,
	status,
	producer = "broker",
}) {
	const runId = safeId(request?.runId ?? route?.runId, "runId");
	const taskId = safeId(request?.taskId ?? route?.taskId, "taskId");
	const epoch =
		writerEpoch === null ? null : safeId(writerEpoch, "writerEpoch");
	const causality =
		dispatchCausality === null || dispatchCausality === undefined
			? hashId(
					`${runId}:${taskId}:${route?.reservation?.id ?? "unreserved"}:${route?.resolvedTarget ?? "none"}`,
				)
			: (() => {
					if (!HASH_RE.test(dispatchCausality))
						throw new TypeError("dispatchCausality must be a sha256 hash");
					return dispatchCausality;
				})();
	const safeAttempt =
		Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1;
	const safeOperation =
		operationId === null || operationId === undefined
			? `operation-${hashId(`${runId}:${taskId}:${safeAttempt}`).slice(7, 39)}`
			: safeId(operationId, "operationId");
	const safeOutcome =
		outcomeId ??
		`outcome-${hashId(`${safeOperation}:${safeAttempt}:${status}:${detail.code}`).slice(7, 39)}`;
	const event = {
		schemaVersion: 1,
		minimumReaderVersion: 1,
		writerEpoch: epoch,
		outcomeId: safeId(safeOutcome, "outcomeId"),
		// The run store replaces this with the serialized sequence.  A valid
		// provisional value keeps the constructor itself schema-checked.
		sequence: 1,
		runId,
		scope: "task",
		taskId,
		attemptId: safeId(
			request?.attemptId ?? `attempt-${safeAttempt}`,
			"attemptId",
		),
		resumesOutcomeId:
			causedBy === undefined ? null : safeId(causedBy, "causedBy", true),
		stage: "provider",
		legacyPhase: null,
		legacyEvent: null,
		dispatchCausality: causality,
		attempt: safeAttempt,
		recordedAt: new Date().toISOString(),
		producer,
		causedBy:
			causedBy === undefined ? null : safeId(causedBy, "causedBy", true),
		operationId: safeOperation,
		status,
		detail,
	};
	validateOutcomeEvent(event);
	return Object.freeze(event);
}

/** Construct the one authoritative typed execution outcome for a broker run. */
export function createExecutionOutcome({
	request,
	route,
	launcherResult = null,
	writerEpoch = null,
	operationId = null,
	causedBy = null,
	dispatchCausality = null,
	attempt = 1,
	preLaunch = false,
	cancelled = false,
} = {}) {
	const outcome =
		preLaunch || cancelled
			? "cancel"
			: launcherResult?.success === true
				? "success"
				: "failure";
	return commonOutcome({
		request,
		route,
		writerEpoch,
		operationId,
		causedBy,
		dispatchCausality,
		attempt,
		status: outcomeStatus(outcome, outcome === "cancel"),
		detail: detailForExecution({
			route,
			launcherResult,
			cancelled: outcome === "cancel",
			preLaunch,
		}),
	});
}

/** Construct the provider lifecycle fact that must precede broker control. */
export function createProviderProcessCompletedOutcome({
	request,
	route = null,
	processResult = {},
	writerEpoch = null,
	operationId = null,
	dispatchCausality = null,
	attempt = 1,
} = {}) {
	const success = processResult.success === true;
	const detail = {
		code: "process_completed",
		...(route?.resolvedTarget
			? { targetId: safeId(route.resolvedTarget, "route.resolvedTarget") }
			: {}),
		...(typeof processResult.diagnosticOrigin === "string" &&
		ID_RE.test(processResult.diagnosticOrigin)
			? { diagnosticOrigin: processResult.diagnosticOrigin }
			: {}),
		...(typeof processResult.diagnosticEvidenceAvailable === "boolean"
			? { evidenceAvailable: processResult.diagnosticEvidenceAvailable }
			: {}),
	};
	return commonOutcome({
		request,
		route,
		writerEpoch,
		operationId,
		dispatchCausality,
		attempt,
		status: success ? "succeeded" : "failed",
		detail,
		producer: "provider-lifecycle",
	});
}
