import { createHash } from "node:crypto";

const OUTCOME_SCHEMA_VERSION = 1;
export const SUPPORTED_OUTCOME_READER_VERSION = 1;
export const OUTCOME_EVENT_MAX_BYTES = 32 * 1024;
export const OUTCOME_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const OUTCOME_FILE_MAX_LINES = 10_000;

export const OUTCOME_STAGES = Object.freeze([
	"run",
	"preflight",
	"worker",
	"provider",
	"artifact",
	"integration",
	"cleanup",
	"recovery",
	"postcondition",
	"legacy",
]);
const OUTCOME_STATUSES = Object.freeze([
	"started",
	"succeeded",
	"failed",
	"uncertain",
	"skipped",
]);
const OUTCOME_PRODUCERS = Object.freeze([
	"run-store",
	"runner",
	"dispatch",
	"worker-bootstrap",
	"provider-lifecycle",
	"broker",
	"integrator",
	"recovery",
	"legacy-adapter",
]);

const STAGES = new Set(OUTCOME_STAGES);
const STATUSES = new Set(OUTCOME_STATUSES);
const PRODUCERS = new Set(OUTCOME_PRODUCERS);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH_RE = /^sha256:[a-f0-9]{64}$/u;
const DIAGNOSTIC_REF_RE = /^diagnostic:[a-f0-9]{32}$/u;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const FORBIDDEN_KEYS =
	/(?:prompt|raw(?:provider)?stream|exception|patchbytes|credentials?|environment|envcontents?|hostpath|output|stdout|stderr)/iu;

const ENVELOPE_KEYS = new Set([
	"schemaVersion",
	"minimumReaderVersion",
	"writerEpoch",
	"outcomeId",
	"sequence",
	"runId",
	"scope",
	"taskId",
	"attemptId",
	"resumesOutcomeId",
	"stage",
	"legacyPhase",
	"legacyEvent",
	"dispatchCausality",
	"attempt",
	"recordedAt",
	"producer",
	"causedBy",
	"operationId",
	"status",
	"detail",
]);

const DETAIL_KEYS = Object.freeze({
	run: new Set(["code", "reasonCode", "readerVersion", "writerEpoch"]),
	preflight: new Set(["code", "reasonCode", "eligible"]),
	worker: new Set([
		"code",
		"reasonCode",
		"launchVerified",
		"checkpointDigest",
		"priorSequence",
	]),
	provider: new Set([
		"code",
		"reasonCode",
		"reviewResult",
		"servedModelVerified",
		"completionContinuationProof",
		"targetId",
		"exitClassification",
		"diagnosticOrigin",
		"evidenceAvailable",
		"diagnosticRef",
		"contentHash",
	]),
	artifact: new Set([
		"code",
		"reasonCode",
		"artifactKind",
		"captured",
		"contentHash",
	]),
	integration: new Set(["code", "reasonCode", "gateCode", "accepted"]),
	cleanup: new Set([
		"code",
		"reasonCode",
		"cleanupCode",
		"observed",
		"mutationState",
		"mutationOutcome",
		"postcondition",
		"ownership",
		"attempts",
		"maxAttempts",
		"retryAllowed",
		"reconciled",
		"idempotency",
	]),
	recovery: new Set([
		"code",
		"reasonCode",
		"originalStage",
		"checkpointDigest",
		"priorSequence",
		"diagnosticRef",
		"contentHash",
		"operatorCommand",
		"evidenceRef",
	]),
	postcondition: new Set([
		"code",
		"reasonCode",
		"commandResult",
		"observedState",
		"mutationState",
		"mutationOutcome",
		"postcondition",
		"ownership",
		"reconciled",
	]),
	legacy: new Set(["code", "reasonCode", "originalSequence", "evidence"]),
});

class OutcomeSchemaError extends Error {
	constructor(message) {
		super(message);
		this.name = "OutcomeSchemaError";
	}
}

function fail(message) {
	throw new OutcomeSchemaError(message);
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value, nullable = false) {
	return (
		(nullable && value === null) ||
		(typeof value === "string" && ID_RE.test(value))
	);
}

function assertSafeValue(value, path = "detail") {
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
		return;
	}
	if (typeof value === "string") {
		if (value.length > 4096 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
			fail(`${path} contains an unsafe string`);
		if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value))
			fail(`${path} contains an unrestricted host path`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) fail(`${path} array is too large`);
		for (const [index, item] of value.entries())
			assertSafeValue(item, `${path}[${index}]`);
		return;
	}
	if (!isObject(value)) fail(`${path} contains an unsupported value`);
	const keys = Object.keys(value);
	if (keys.length > 64) fail(`${path} object is too large`);
	for (const key of keys) {
		if (FORBIDDEN_KEYS.test(key)) fail(`${path} contains forbidden field`);
		assertSafeValue(value[key], `${path}.${key}`);
	}
}

function validateDetail(stage, detail) {
	if (!isObject(detail)) fail("detail must be an object");
	const allowed = DETAIL_KEYS[stage];
	if (Object.keys(detail).some((key) => !allowed.has(key)))
		fail(`detail is not closed for stage ${stage}`);
	assertSafeValue(detail);
	if (
		detail.diagnosticRef !== undefined &&
		!DIAGNOSTIC_REF_RE.test(detail.diagnosticRef)
	)
		fail("diagnosticRef is invalid");
	if (detail.contentHash !== undefined && !HASH_RE.test(detail.contentHash))
		fail("contentHash is invalid");
	if (
		detail.checkpointDigest !== undefined &&
		!HASH_RE.test(detail.checkpointDigest)
	)
		fail("checkpointDigest is invalid");
	if (
		detail.priorSequence !== undefined &&
		(!Number.isSafeInteger(detail.priorSequence) || detail.priorSequence < 0)
	)
		fail("priorSequence is invalid");
}

/** Validate and return a closed version-1 outcome event. */
export function validateOutcomeEvent(value, options = {}) {
	if (!isObject(value)) fail("outcome event must be an object");
	if (Object.keys(value).some((key) => !ENVELOPE_KEYS.has(key)))
		fail("outcome event has extra fields");
	if (value.schemaVersion !== OUTCOME_SCHEMA_VERSION)
		fail("unsupported outcome schema version");
	const minimum = value.minimumReaderVersion ?? OUTCOME_SCHEMA_VERSION;
	const supported =
		options.supportedReaderVersion ?? SUPPORTED_OUTCOME_READER_VERSION;
	if (!Number.isSafeInteger(minimum) || minimum < 1)
		fail("minimumReaderVersion is invalid");
	if (!Number.isSafeInteger(supported) || supported < minimum)
		fail("minimum outcome reader version is not supported");
	if (!validId(value.outcomeId) || !validId(value.runId))
		fail("outcome identity is invalid");
	if (!Number.isSafeInteger(value.sequence) || value.sequence < 1)
		fail("sequence is invalid");
	if (
		!STAGES.has(value.stage) ||
		!STATUSES.has(value.status) ||
		!PRODUCERS.has(value.producer)
	)
		fail("closed outcome vocabulary is invalid");
	if (
		!RFC3339_RE.test(value.recordedAt ?? "") ||
		Number.isNaN(Date.parse(value.recordedAt))
	)
		fail("recordedAt is invalid");
	if (!Number.isSafeInteger(value.attempt) || value.attempt < 0)
		fail("attempt is invalid");
	if (
		!validId(value.causedBy, true) ||
		!validId(value.operationId, true) ||
		!validId(value.resumesOutcomeId, true)
	)
		fail("outcome linkage is invalid");
	if (value.writerEpoch !== null && !validId(value.writerEpoch))
		fail("writerEpoch is invalid");
	if (
		value.dispatchCausality !== null &&
		!HASH_RE.test(value.dispatchCausality ?? "")
	)
		fail("dispatchCausality is invalid");
	if (value.scope === "run") {
		if (
			value.taskId !== null ||
			value.attemptId !== null ||
			value.attempt !== 0
		)
			fail("run scope cannot carry task identity");
	} else if (value.scope === "task") {
		if (
			!validId(value.taskId) ||
			!validId(value.attemptId) ||
			value.attempt < 1
		)
			fail("task scope requires attempt identity");
	} else fail("scope is invalid");
	if (value.stage === "legacy") {
		if (
			typeof value.legacyPhase !== "string" ||
			typeof value.legacyEvent !== "string"
		)
			fail("legacy stage requires closed legacy identity");
	} else if (value.legacyPhase !== null || value.legacyEvent !== null)
		fail("non-legacy stage cannot carry legacy identity");
	validateDetail(value.stage, value.detail);
	const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
	if (bytes > OUTCOME_EVENT_MAX_BYTES) fail("outcome event exceeds line limit");
	return value;
}

export function isOutcomeEvent(value, options) {
	try {
		validateOutcomeEvent(value, options);
		return true;
	} catch {
		return false;
	}
}

const LEGACY_PHASES = new Set([
	"bootstrap",
	"preflight",
	"execution",
	"provider",
	"artifact",
	"integration",
	"cleanup",
	"recovery",
	"finalization",
	"host",
	"route_health",
	"lifecycle",
	"lifecycle_hook",
	"checkpoint",
	"ledger",
	"policy",
	"broker",
	"broker_execution",
]);
const LEGACY_EVENTS = new Set([
	"task_started",
	"task_completed",
	"task_failed",
	"queue_halted",
	"worker_boot_failed",
	"cleanup_started",
	"cleanup_completed",
	"cleanup_failed",
	"execution_progress",
	"route_health_deferred",
	"vm_slot_wait",
	"diff_capture_failed",
	"integration_failed",
	"aqua_ready",
	"aqua_wait",
	"checkpoint_failed",
	"checkpoint_saved",
	"cleanup_complete",
	"complete",
	"completed",
	"completion_continuation_proof_completed",
	"completion_continuation_proof_started",
	"completion_correction_allocated",
	"container_created",
	"diff_capture_completed",
	"diff_capture_started",
	"diff_captured",
	"dirty_overlay_rejected",
	"fallback_reserved",
	"gate_applied",
	"gate_validated",
	"half_open_claim_unavailable",
	"half_open_trial_shadowed",
	"health_decision",
	"health_ingest_run_complete",
	"health_ingest_run_start",
	"host_power_unknown",
	"host_readiness_probe",
	"host_readiness_ready",
	"host_readiness_wait",
	"ignored_failure",
	"intent_receipt_failed",
	"legacy_projection_failed",
	"outcome_projection_failed",
	"parse_failed",
	"partial_diff_capture_failed",
	"partial_diff_captured",
	"probe",
	"provider_cleanup_complete",
	"provider_cleanup_failed",
	"provider_cleanup_started",
	"provider_config_write_started",
	"provider_index_lock_removed",
	"provider_pid_marker_removed",
	"provider_pid_observed",
	"provider_tree_gone",
	"queue_deferred",
	"retry_reset_started",
	"seed_failed",
	"served_model_probe_started",
	"served_model_unverified",
	"start",
	"started",
	"state_reset",
	"target_quarantined",
	"task_base_failed",
	"task_base_release_failed",
	"task_base_released",
	"task_routed",
	"terminal",
	"unavailable",
]);

/** Map a retained legacy event in memory. It never writes or invents causality. */
export function adaptLegacyOutcomeEvent(legacy, runId) {
	if (
		!isObject(legacy) ||
		!LEGACY_PHASES.has(legacy.phase) ||
		!LEGACY_EVENTS.has(legacy.event)
	)
		fail("legacy event is outside the closed adapter");
	if (
		!Number.isSafeInteger(legacy.sequence) ||
		legacy.sequence < 1 ||
		!validId(runId)
	)
		fail("legacy event identity is invalid");
	const status =
		legacy.event.endsWith("failed") || legacy.event === "queue_halted"
			? "failed"
			: legacy.event.endsWith("completed")
				? "succeeded"
				: legacy.event === "route_health_deferred"
					? "skipped"
					: "started";
	return Object.freeze({
		stage: "legacy",
		legacyPhase: legacy.phase,
		legacyEvent: legacy.event,
		sequence: legacy.sequence,
		runId,
		taskId:
			typeof legacy.taskId === "string" && ID_RE.test(legacy.taskId)
				? legacy.taskId
				: null,
		status,
		reasonCode:
			typeof legacy.reasonCode === "string" && ID_RE.test(legacy.reasonCode)
				? legacy.reasonCode
				: null,
		evidence: "unknown",
	});
}

function outcomeContentHash(value) {
	return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export function createOversizeRejectionFact(
	original,
	{ diagnosticRef = null } = {},
) {
	const fact = {
		originalStage: STAGES.has(original?.stage) ? original.stage : "legacy",
		reasonCode: "outcome_too_large",
		contentHash: outcomeContentHash(original),
	};
	if (diagnosticRef !== null) {
		if (!DIAGNOSTIC_REF_RE.test(diagnosticRef))
			fail("diagnosticRef is invalid");
		fact.diagnosticRef = diagnosticRef;
	}
	return Object.freeze(fact);
}

/** Unique resume matching; ambiguity is always an operator recovery disposition. */
export function reconstructResumeLink(candidates, tuple) {
	const matches = candidates.filter(
		(candidate) =>
			candidate.runId === tuple.runId &&
			candidate.taskId === tuple.taskId &&
			candidate.attempt === tuple.attempt &&
			candidate.detail?.checkpointDigest === tuple.checkpointDigest &&
			candidate.detail?.priorSequence === tuple.priorSequence,
	);
	if (matches.length === 1)
		return { status: "reconstructed", resumesOutcomeId: matches[0].outcomeId };
	return {
		status: "recovery_required",
		reasonCode: "orphan_attempt",
		automaticRetry: false,
		matchCount: matches.length,
		operatorCommand: "switchyard-dispatch recover",
	};
}
