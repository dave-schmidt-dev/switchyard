/**
 * Pure lifecycle decisions shared by all execution adapters.
 *
 * These functions only classify bounded inputs. They do not write a run,
 * allocate an identity, inspect a provider, or perform cleanup. Persistence
 * and ownership remain with the run-store and lifecycle callers.
 */

import {
	CLEANUP_STAGES,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import {
	isReviewResult,
	sanitizeReviewResult,
} from "../diagnostics/review-result.mjs";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const REVIEW_CODES = Object.freeze([
	"review_outcome",
	"review_completed",
	"review_unavailable",
	"review_result_unavailable",
]);
const CLEANUP_CODES = Object.freeze([
	"cleanup_started",
	"cleanup_completed",
	"cleanup_failed",
]);
const INTEGRATION_CODES = Object.freeze([
	"integration_gate",
	"not_observed",
	"success",
	"integration_failed",
]);
const RECOVERY_CODES = Object.freeze([
	"recovery_required",
	"recovery_incomplete",
	"orphan_attempt",
	"execution_outcome_missing_after_process_fact",
	"integration_state_unknown",
]);
const TERMINAL_OUTCOMES = Object.freeze([
	"succeeded",
	"failed",
	"deferred",
	"success",
	"completed_work",
	"no_runnable_work",
	"deferred_work",
	"failed_work",
	"failed_before_work",
	"recovered_dead_worker",
	"unknown_failure",
]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "deferred"]);
const RECOVERY_STAGES = new Set([
	"cleanup",
	"provider",
	"worker",
	"checkpoint",
	"integration",
	"run",
	"preflight",
	"recovery",
]);
const CONTENT_HASH_RE = /^sha256:[a-f0-9]{64}$/u;

const TRANSITION_STATUSES = new Set([
	"started",
	"succeeded",
	"failed",
	"uncertain",
	"skipped",
]);

const RETRY_KINDS = new Set([
	"attempt_recorded",
	"target_quarantined",
	"reset_completed",
	"retry_started",
	"finalized",
	"retry_halted",
]);

function boundedString(value, fallback = null, max = 256) {
	if (value === null || value === undefined) return fallback;
	if (typeof value !== "string" || value.length === 0 || value.length > max)
		return fallback;
	if ([...value].some((character) => character.codePointAt(0) < 0x20))
		return fallback;
	return value;
}

function boundedId(value) {
	return typeof value === "string" && SAFE_ID_RE.test(value) ? value : null;
}

function boundedClosed(value, vocabulary) {
	const contains =
		typeof vocabulary?.has === "function"
			? vocabulary.has(value)
			: typeof vocabulary?.includes === "function" &&
				vocabulary.includes(value);
	return typeof value === "string" && contains ? value : null;
}

function boundedBoolean(value, fallback = null) {
	return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value, fallback = null) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clone(value) {
	return value === undefined ? undefined : structuredClone(value);
}

function freezeDecision(type, fields) {
	return Object.freeze({ type, ...clone(fields) });
}

function status(value, fallback) {
	return TRANSITION_STATUSES.has(value) ? value : fallback;
}

/** Decide the bounded success result without performing terminalization. */
export function successTransition(input = {}) {
	return freezeDecision("success", {
		outcome: "success",
		result: boundedString(input.result, "success"),
		success: true,
		terminal: true,
		provider: boundedString(input.provider),
		model: boundedString(input.model),
		actualConsumption: boundedNumber(input.actualConsumption),
		cleanupFailed: boundedBoolean(input.cleanupFailed, false),
		cleanupStage: CLEANUP_STAGES.has(input.cleanupStage)
			? input.cleanupStage
			: null,
		servedModelVerified: boundedBoolean(input.servedModelVerified),
		reviewResult:
			input.reviewResult === null || input.reviewResult === undefined
				? null
				: isReviewResult(input.reviewResult)
					? clone(input.reviewResult)
					: sanitizeReviewResult(input.reviewResult),
		reason: null,
	});
}

/** Decide the bounded failure result without performing terminalization. */
export function failureTransition(input = {}) {
	const result = boundedString(input.result, "execution_failed");
	const failureInput = {
		result,
		timedOut: input.timedOut === true,
		errorKind: input.errorKind,
		diagnosticCode: input.diagnosticCode,
		failurePhase: input.failurePhase,
		diagnosticOrigin: input.diagnosticOrigin,
		diagnosticEvidenceAvailable: input.diagnosticEvidenceAvailable,
		diagnosticRef: input.diagnosticRef,
		exitCode: input.exitCode,
		signal: input.signal,
		cleanupStage: input.cleanupStage,
		artifactRef: input.artifactRef,
		checkpointCode: input.checkpointCode,
		checkpointDimensions: input.checkpointDimensions,
		resolvedTargetId: input.resolvedTargetId,
		descriptorIdentity: input.descriptorIdentity,
		descriptorHarness: input.descriptorHarness,
	};
	const safeFailure = sanitizeFailureMetadata(failureInput);
	return freezeDecision("failure", {
		outcome: input.cancelled === true ? "cancel" : "failure",
		result,
		success: false,
		terminal: true,
		provider: boundedString(input.provider),
		model: boundedString(input.model),
		errorKind: safeFailure?.errorKind ?? null,
		reasonCode: safeFailure?.reasonCode ?? null,
		reason: safeFailure?.reason ?? null,
		timedOut: boundedBoolean(input.timedOut, false),
		silenceTimedOut: boundedBoolean(input.silenceTimedOut, false),
		failurePhase: safeFailure?.failurePhase ?? null,
		diagnosticCode: safeFailure?.diagnosticCode ?? null,
		diagnosticOrigin: safeFailure?.diagnosticOrigin ?? null,
		diagnosticEvidenceAvailable:
			safeFailure?.diagnosticEvidenceAvailable ?? false,
		diagnosticRef: safeFailure?.diagnosticRef ?? null,
		cleanupFailed: boundedBoolean(input.cleanupFailed, false),
		cleanupStage: CLEANUP_STAGES.has(input.cleanupStage)
			? input.cleanupStage
			: null,
		servedModelVerified: boundedBoolean(input.servedModelVerified),
		reviewResult: null,
		failureMetadata: safeFailure,
	});
}

/** Decide a review stage while retaining only the already-sanitized verdict. */
export function reviewTransition(input = {}) {
	const reviewStatus = status(input.status, "uncertain");
	const reviewResult =
		input.reviewResult !== null &&
		input.reviewResult !== undefined &&
		isReviewResult(input.reviewResult)
			? clone(input.reviewResult)
			: sanitizeReviewResult(input.reviewResult);
	return freezeDecision("review", {
		status: reviewStatus,
		code: boundedClosed(input.code, REVIEW_CODES) ?? "review_outcome",
		reasonCode:
			boundedClosed(input.reasonCode, REVIEW_CODES) ??
			boundedClosed(input.code, REVIEW_CODES) ??
			"review_outcome",
		reviewResult,
		available:
			reviewStatus === "succeeded" &&
			reviewResult.status === "available" &&
			input.available !== false,
	});
}

/** Decide one retry transition; this function never authorizes a retry. */
export function retryTransition(input = {}) {
	const kind = boundedString(input.kind, null);
	if (!RETRY_KINDS.has(kind)) throw new TypeError("unknown retry transition");
	const failure = sanitizeFailureMetadata({
		result: "execution_failed",
		diagnosticCode: input.diagnosticCode,
		diagnosticOrigin: input.diagnosticOrigin,
		diagnosticEvidenceAvailable: input.diagnosticEvidenceAvailable,
		diagnosticRef: input.diagnosticRef,
		failurePhase: input.failurePhase,
	});
	return freezeDecision("retry", {
		kind,
		taskId: boundedId(input.taskId),
		attempt:
			Number.isInteger(input.attempt) && input.attempt >= 0
				? input.attempt
				: null,
		provider: boundedString(input.provider),
		model: boundedString(input.model),
		resolvedTargetId: boundedId(input.resolvedTargetId),
		invocationDescriptor: clone(input.invocationDescriptor ?? null),
		descriptorIdentity: boundedString(input.descriptorIdentity),
		descriptorHarness: boundedString(input.descriptorHarness),
		diagnosticCode: failure?.diagnosticCode ?? null,
		diagnosticOrigin: failure?.diagnosticOrigin ?? null,
		diagnosticEvidenceAvailable: failure?.diagnosticEvidenceAvailable ?? false,
		diagnosticRef: failure?.diagnosticRef ?? null,
		failurePhase: failure?.failurePhase ?? null,
		phase: boundedString(input.phase, kind),
		clearState: input.clearState === true,
	});
}

/** Decide the artifact evidence status for a task. */
export function artifactTransition(input = {}) {
	const expectsArtifact = input.expectsArtifact !== false;
	const captureStatus = boundedString(input.captureStatus);
	const captured = ["captured", "empty"].includes(captureStatus);
	return freezeDecision("artifact", {
		status: !expectsArtifact
			? "skipped"
			: captureStatus === null
				? "uncertain"
				: captured
					? "succeeded"
					: "failed",
		code: !expectsArtifact
			? "artifact_not_applicable"
			: captureStatus === null
				? "artifact_evidence_unavailable"
				: "artifact_capture",
		artifactKind: "diff",
		captured: captureStatus === "captured",
		contentHash:
			typeof input.contentHash === "string" &&
			CONTENT_HASH_RE.test(input.contentHash)
				? input.contentHash
				: null,
	});
}

/** Decide whether integration evidence was reached and accepted. */
export function integrationTransition(input = {}) {
	const expectsArtifact = input.expectsArtifact !== false;
	const reached = input.reached === true;
	const accepted = reached && input.accepted === true;
	return freezeDecision("integration", {
		status: !expectsArtifact
			? "skipped"
			: !reached
				? "uncertain"
				: accepted
					? "succeeded"
					: "failed",
		code: !expectsArtifact
			? "integration_not_applicable"
			: !reached
				? "integration_evidence_unavailable"
				: "integration_gate",
		gateCode:
			boundedClosed(input.gateCode, INTEGRATION_CODES) ??
			(reached ? "integration_gate" : "not_observed"),
		accepted,
	});
}

/** Decide cleanup evidence independently from the task's primary outcome. */
export function cleanupTransition(input = {}) {
	const cleanupStatus = status(input.status, "uncertain");
	return freezeDecision("cleanup", {
		status: cleanupStatus,
		code:
			boundedClosed(input.code, CLEANUP_CODES) ??
			(cleanupStatus === "succeeded" ? "cleanup_completed" : "cleanup_failed"),
		cleanupCode:
			boundedClosed(input.cleanupCode, CLEANUP_CODES) ??
			boundedClosed(input.code, CLEANUP_CODES) ??
			"cleanup_failed",
		observed: input.observed === true,
		mutationState: ["intent", "uncertain", "completed"].includes(
			input.mutationState,
		)
			? input.mutationState
			: null,
		mutationOutcome: ["unknown", "ambiguous", "confirmed"].includes(
			input.mutationOutcome,
		)
			? input.mutationOutcome
			: null,
		postcondition: ["unknown", "observed"].includes(input.postcondition)
			? input.postcondition
			: null,
	});
}

/** Decide recovery evidence without changing the run or lock state. */
export function recoveryTransition(input = {}) {
	return freezeDecision("recovery", {
		status: status(input.status, "uncertain"),
		code: boundedClosed(input.code, RECOVERY_CODES) ?? "recovery_required",
		reasonCode:
			boundedClosed(input.reasonCode, RECOVERY_CODES) ?? "recovery_required",
		originalStage: RECOVERY_STAGES.has(input.originalStage)
			? input.originalStage
			: null,
		automatic: input.automatic === true,
		operatorCommand:
			input.operatorCommand === "switchyard-dispatch recover"
				? input.operatorCommand
				: null,
	});
}

/** Build a stable terminal summary from already-authorized scalar facts. */
export function terminalSummaryTransition(input = {}) {
	const source =
		input.terminalSummary && typeof input.terminalSummary === "object"
			? input.terminalSummary
			: input;
	const list = (value) =>
		Array.isArray(value)
			? value.filter((item) => boundedId(item) !== null).map((item) => item)
			: null;
	return freezeDecision("terminal_summary", {
		outcome: boundedClosed(source.outcome, TERMINAL_OUTCOMES),
		totalTasks: Number.isInteger(source.totalTasks) ? source.totalTasks : null,
		runnableTasks: Number.isInteger(source.runnableTasks)
			? source.runnableTasks
			: null,
		processedTasks: Number.isInteger(source.processedTasks)
			? source.processedTasks
			: null,
		completedTaskIds: list(source.completedTaskIds),
		failedCount: Number.isInteger(source.failedCount)
			? source.failedCount
			: null,
		deferredTaskIds: list(source.deferredTaskIds),
		halted: boundedBoolean(source.halted),
	});
}

/** Decide one terminal state and summary from the same task facts everywhere. */
export function terminalTransition(input = {}) {
	const results = Array.isArray(input.results) ? input.results : [];
	const deferredTaskIds = Array.isArray(input.deferredTaskIds)
		? input.deferredTaskIds
		: [];
	const hasTaskFacts = results.length > 0 || deferredTaskIds.length > 0;
	const state = hasTaskFacts
		? results.some((result) => result?.success === false)
			? "failed"
			: deferredTaskIds.length > 0
				? "deferred"
				: "succeeded"
		: TERMINAL_STATES.has(input.state)
			? input.state
			: "succeeded";
	const summary = terminalSummaryTransition({
		...(input.terminalSummary ?? input),
		outcome: state,
		failedCount:
			input.failedCount ??
			input.terminalSummary?.failedCount ??
			(results.length > 0
				? results.filter((result) => !result?.success).length
				: null),
	});
	const {
		type: _type,
		outcome: _outcome,
		halted: _halted,
		...rawTerminalSummary
	} = summary;
	const terminalSummary = Object.fromEntries(
		Object.entries(rawTerminalSummary).filter(([, value]) => value !== null),
	);
	return freezeDecision("terminal", { state, terminalSummary, outcome: state });
}
