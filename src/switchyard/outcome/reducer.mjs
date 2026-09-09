import { validateOutcomeEvent } from "./schema.mjs";

/** Version of the stable terminal projection returned by this module. */
const OUTCOME_PROJECTION_VERSION = 1;

// Lower numbers win when choosing a primary failure.  This is deliberately a
// stage table rather than an incidental sort order: an artifact or cleanup
// failure must not mask the provider failure that caused it.
export const FAILURE_PRECEDENCE = Object.freeze({
	preflight: 10,
	worker: 20,
	provider: 30,
	integration: 40,
	artifact: 50,
	cleanup: 60,
	recovery: 70,
	postcondition: 80,
	run: 90,
	legacy: 100,
});

const STAGE_OUTCOME_KEYS = Object.freeze({
	artifact: "artifactOutcome",
	integration: "integrationOutcome",
	cleanup: "cleanupOutcome",
	recovery: "recoveryOutcome",
});
const TERMINAL_STATUSES = new Set([
	"succeeded",
	"failed",
	"uncertain",
	"skipped",
]);
const FAILURE_STATUSES = new Set(["failed", "uncertain"]);
// One classification table is the source of truth for adaptation, failure
// selection, terminal status, and task counters.  Keeping these decisions in
// separate sets was how legacy failure rows became silently non-terminal.
const LEGACY_EVENT_CLASSIFICATION = Object.freeze({
	task_failed: "failed",
	execution_failed: "failed",
	queue_halted: "failed",
	worker_boot_failed: "failed",
	cleanup_failed: "failed",
	provider_cleanup_failed: "failed",
	diff_capture_failed: "failed",
	partial_diff_capture_failed: "failed",
	integration_failed: "failed",
	checkpoint_failed: "failed",
	parse_failed: "failed",
	outcome_projection_failed: "failed",
	legacy_projection_failed: "failed",
	seed_failed: "failed",
	served_model_unverified: "failed",
	task_base_failed: "failed",
	task_base_release_failed: "failed",
	intent_receipt_failed: "failed",
	dirty_overlay_rejected: "failed",
	task_completed: "succeeded",
	cleanup_completed: "succeeded",
	cleanup_complete: "succeeded",
	provider_cleanup_complete: "succeeded",
	complete: "succeeded",
	completed: "succeeded",
	checkpoint_saved: "succeeded",
	diff_capture_completed: "succeeded",
	diff_captured: "succeeded",
	partial_diff_captured: "succeeded",
	route_health_deferred: "skipped",
	host_power_unknown: "uncertain",
});
const CLOSED_LEGACY_EVENTS = new Set([
	"task_started",
	"task_completed",
	"task_failed",
	"execution_failed",
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
const CLOSED_LEGACY_PHASES = new Set([
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
const LEGACY_TASK_COMPLETION_EVENTS = new Set([
	"task_completed",
	"complete",
	"completed",
]);

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
	return value === undefined ? undefined : structuredClone(value);
}

function knownId(value) {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
	);
}

function canonicalStringify(value) {
	if (Array.isArray(value))
		return `[${value.map(canonicalStringify).join(",")}]`;
	if (isObject(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function sortEvents(left, right) {
	const sequence =
		(left.sequence ?? Number.MAX_SAFE_INTEGER) -
		(right.sequence ?? Number.MAX_SAFE_INTEGER);
	if (sequence !== 0) return sequence;
	return canonicalStringify(left).localeCompare(canonicalStringify(right));
}

function legacyStage(event) {
	if (
		event.phase === "preflight" ||
		event.phase === "policy" ||
		event.phase === "checkpoint"
	)
		return "preflight";
	if (
		event.phase === "bootstrap" ||
		event.phase === "host" ||
		event.phase === "broker"
	)
		return "worker";
	if (
		event.phase === "provider" ||
		event.phase === "execution" ||
		event.phase === "broker_execution"
	)
		return "provider";
	if (event.phase === "artifact") return "artifact";
	if (event.phase === "integration") return "integration";
	if (event.phase === "cleanup") return "cleanup";
	if (event.phase === "recovery") return "recovery";
	if (
		event.phase === "finalization" ||
		event.phase === "lifecycle" ||
		event.phase === "lifecycle_hook"
	)
		return "run";
	return "legacy";
}

function legacyCause(event) {
	const stage = legacyStage(event);
	const classified = LEGACY_EVENT_CLASSIFICATION[event.event];
	const status =
		classified ??
		(event.status === "failed" && stage !== "legacy" ? "failed" : null);
	if (!status) return null;
	return {
		stage,
		code: event.reasonCode ?? event.event,
		reasonCode: event.reasonCode ?? event.event,
		sequence: event.sequence,
		phase: event.phase,
		event: event.event,
		taskId: event.taskId ?? null,
		status,
		evidence: event.evidence ?? "unknown",
	};
}

/**
 * Adapt one retained legacy row without manufacturing an outcome/attempt id.
 * Only fields present in the original row are retained.
 */
export function adaptLegacyOutcome(legacy, options = {}) {
	if (!isObject(legacy))
		throw new TypeError("legacy outcome must be an object");
	const runId = options.runId ?? legacy.runId;
	if (!Number.isSafeInteger(legacy.sequence) || legacy.sequence < 1)
		throw new TypeError("legacy outcome sequence is invalid");
	if (typeof legacy.phase !== "string" || typeof legacy.event !== "string")
		throw new TypeError("legacy outcome requires phase and event");
	if (!CLOSED_LEGACY_PHASES.has(legacy.phase))
		throw new TypeError("legacy phase is outside the closed adapter");
	if (!CLOSED_LEGACY_EVENTS.has(legacy.event))
		throw new TypeError("legacy event is outside the closed adapter");
	const cause = legacyCause(legacy);
	const adapted = {
		stage: "legacy",
		legacyPhase: legacy.phase,
		legacyEvent: legacy.event,
		originalSequence: legacy.sequence,
		taskId: knownId(legacy.taskId) ? legacy.taskId : null,
		reasonCode: knownId(legacy.reasonCode) ? legacy.reasonCode : null,
		evidence: cause?.evidence ?? "unknown",
	};
	if (knownId(runId)) adapted.runId = runId;
	if (cause) adapted.cause = cause;
	return Object.freeze(adapted);
}

function normalizeEvent(value, runId) {
	if (
		isObject(value) &&
		value.stage === "legacy" &&
		value.schemaVersion === undefined
	)
		return adaptLegacyOutcome(
			{
				...value,
				sequence: value.sequence ?? value.originalSequence,
				phase: value.phase ?? value.legacyPhase,
				event: value.event ?? value.legacyEvent,
			},
			{ runId },
		);
	if (isObject(value) && value.phase !== undefined && value.event !== undefined)
		return adaptLegacyOutcome(value, { runId });
	const validated = validateOutcomeEvent(value);
	return validated.stage === "legacy"
		? adaptLegacyOutcome(
				{
					sequence: validated.sequence,
					phase: validated.legacyPhase,
					event: validated.legacyEvent,
					taskId: validated.taskId,
					reasonCode: validated.detail.reasonCode,
					evidence: validated.detail.evidence,
					runId: validated.runId,
				},
				{ runId },
			)
		: validated;
}

function eventCode(event) {
	return (
		event.detail?.reasonCode ??
		event.detail?.code ??
		event.reasonCode ??
		event.event ??
		event.status
	);
}

function stageOf(event) {
	return event.stage === "legacy"
		? (event.cause?.stage ?? legacyStage(event))
		: event.stage;
}

function isFailure(event) {
	if (event.stage === "legacy") return event.cause?.status === "failed";
	return FAILURE_STATUSES.has(event.status);
}

function isTerminal(event) {
	return event.stage === "legacy"
		? Boolean(event.cause?.status && TERMINAL_STATUSES.has(event.cause.status))
		: TERMINAL_STATUSES.has(event.status);
}

function logicalKey(event) {
	if (event.stage === "legacy")
		return `legacy|${event.runId ?? ""}|${event.taskId ?? ""}|${event.originalSequence}|${event.legacyPhase}|${event.legacyEvent}|${event.reasonCode ?? ""}`;
	if (event.operationId)
		return `operation|${event.runId}|${event.scope}|${event.taskId ?? ""}|${event.attemptId ?? ""}|${event.operationId}|${event.stage}|${event.status}|${eventCode(event)}`;
	return `outcome|${event.outcomeId}`;
}

function failureRecord(event) {
	const stage = stageOf(event);
	const detail = event.detail ?? event.cause ?? {};
	return {
		stage,
		status: event.status ?? (isFailure(event) ? "failed" : "succeeded"),
		code:
			detail.code ??
			detail.reasonCode ??
			event.reasonCode ??
			event.legacyEvent ??
			null,
		reasonCode: detail.reasonCode ?? event.reasonCode ?? null,
		sequence: event.sequence ?? event.originalSequence,
		outcomeId: event.outcomeId ?? null,
		taskId: event.taskId ?? null,
		attemptId: event.attemptId ?? null,
		attempt: event.attempt ?? null,
		causedBy: event.causedBy ?? null,
		operationId: event.operationId ?? null,
		evidence:
			detail.evidence ??
			(detail.evidenceAvailable === true ? "observed" : "unknown"),
		...(event.stage === "legacy"
			? { legacyPhase: event.legacyPhase, legacyEvent: event.legacyEvent }
			: {}),
	};
}

function failureOrder(left, right) {
	const rank = (event) => FAILURE_PRECEDENCE[stageOf(event)] ?? 999;
	return (
		rank(left) - rank(right) ||
		(left.sequence ?? left.originalSequence) -
			(right.sequence ?? right.originalSequence) ||
		String(left.outcomeId ?? "").localeCompare(String(right.outcomeId ?? ""))
	);
}

function emptyEvidence() {
	return {
		status: "unknown",
		available: false,
		diagnosticRefs: [],
		origins: [],
	};
}

function emptyProof() {
	return {
		status: "unknown",
		reviewResult: null,
		servedModelVerified: null,
		completionContinuationProof: null,
		targetId: null,
	};
}

function addEvidence(evidence, event) {
	const detail = event.detail ?? {};
	const explicitEvidence = detail.evidence ?? event.evidence;
	if (
		detail.evidenceAvailable === true ||
		detail.diagnosticRef ||
		explicitEvidence === "observed"
	) {
		evidence.available = true;
		evidence.status = "observed";
	}
	if (
		(detail.evidenceAvailable === false ||
			explicitEvidence === "unavailable") &&
		evidence.status === "unknown"
	)
		evidence.status = "unavailable";
	if (
		detail.diagnosticRef &&
		!evidence.diagnosticRefs.includes(detail.diagnosticRef)
	)
		evidence.diagnosticRefs.push(detail.diagnosticRef);
	if (
		detail.diagnosticOrigin &&
		!evidence.origins.includes(detail.diagnosticOrigin)
	)
		evidence.origins.push(detail.diagnosticOrigin);
}

function updateProof(proof, event) {
	const detail = event.detail ?? {};
	if (detail.reviewResult !== undefined) {
		proof.reviewResult = clone(detail.reviewResult);
		proof.status = detail.reviewResult === null ? "unknown" : "observed";
	}
	for (const field of [
		"servedModelVerified",
		"completionContinuationProof",
		"targetId",
	]) {
		if (detail[field] !== undefined) proof[field] = clone(detail[field]);
	}
	if (
		detail.servedModelVerified !== undefined ||
		detail.completionContinuationProof !== undefined
	)
		proof.status = "observed";
}

function mergeTransitionEvents(members) {
	const ordered = [...members].sort(sortEvents);
	const merged = clone(ordered[0]);
	for (const member of ordered.slice(1)) {
		if (!isObject(member.detail)) continue;
		for (const [key, value] of Object.entries(member.detail)) {
			if (merged.detail[key] === undefined) {
				merged.detail[key] = clone(value);
				continue;
			}
			if (key === "evidenceAvailable") {
				merged.detail[key] = merged.detail[key] === true || value === true;
				continue;
			}
			if (canonicalStringify(value) < canonicalStringify(merged.detail[key]))
				merged.detail[key] = clone(value);
		}
	}
	return merged;
}

function counterTemplate() {
	return {
		total: 0,
		started: 0,
		succeeded: 0,
		failed: 0,
		uncertain: 0,
		skipped: 0,
		completed: 0,
		terminal: 0,
		pending: 0,
	};
}

function eventTerminalStatus(event) {
	if (event.stage === "legacy") {
		const status =
			event.cause?.status ??
			LEGACY_EVENT_CLASSIFICATION[event.legacyEvent] ??
			null;
		if (
			status === "succeeded" &&
			!LEGACY_TASK_COMPLETION_EVENTS.has(event.legacyEvent)
		)
			return null;
		return status;
	}
	return isTerminal(event) ? event.status : null;
}

function reconcileCounters(events) {
	const byTask = new Map();
	for (const event of events) {
		if (!knownId(event.taskId)) continue;
		const status = eventTerminalStatus(event);
		const existing = byTask.get(event.taskId);
		if (
			!existing ||
			(event.sequence ?? event.originalSequence) >= existing.sequence
		)
			byTask.set(event.taskId, {
				status,
				sequence: event.sequence ?? event.originalSequence,
			});
	}
	const counters = counterTemplate();
	counters.total = byTask.size;
	for (const { status } of byTask.values()) {
		if (!status) {
			counters.pending += 1;
			continue;
		}
		counters[status] += 1;
		if (status !== "skipped") counters.completed += 1;
		counters.terminal += 1;
	}
	return counters;
}

/** Fold validated typed outcomes and retained legacy rows into one projection. */
export function reduceOutcomeEvents(input, options = {}) {
	const source = Array.isArray(input) ? input : input?.events;
	if (!Array.isArray(source)) throw new TypeError("outcomes must be an array");
	const sourceRunIds = [
		...new Set(source.map((event) => event?.runId).filter(knownId)),
	].sort();
	const runId = options.runId ?? sourceRunIds[0] ?? null;
	const normalized = source
		.map((event) => normalizeEvent(event, runId))
		.sort(sortEvents);
	const seenIds = new Map();
	const transitionGroups = new Map();
	const duplicateOutcomes = [];
	const duplicateSet = new Set();
	const recordDuplicate = (value) => {
		if (!duplicateSet.has(value)) {
			duplicateSet.add(value);
			duplicateOutcomes.push(value);
		}
	};
	const identityConflicts = [];
	for (const event of normalized) {
		if (event.outcomeId && seenIds.has(event.outcomeId)) {
			recordDuplicate(event.outcomeId);
			const prior = seenIds.get(event.outcomeId);
			if (canonicalStringify(prior) !== canonicalStringify(event))
				identityConflicts.push(event.outcomeId);
			// One production identity can represent only one fact.  Preserve the
			// rejected row as diagnostic/proof input, but retain one canonical fact
			// in the logical projection and fail closed below.
			continue;
		} else if (event.outcomeId) {
			seenIds.set(event.outcomeId, event);
		}
		const transition = logicalKey(event);
		const group = transitionGroups.get(transition);
		if (group) {
			recordDuplicate(event.outcomeId ?? `legacy:${event.originalSequence}`);
			group.push(event);
		} else {
			transitionGroups.set(transition, [event]);
		}
	}
	const events = [...transitionGroups.values()]
		.map(mergeTransitionEvents)
		.sort(sortEvents);

	const failures = events.filter(isFailure).sort(failureOrder);
	const primaryFailure =
		failures.find(
			(event) =>
				stageOf(event) !== "artifact" &&
				stageOf(event) !== "cleanup" &&
				stageOf(event) !== "recovery",
		) ??
		failures[0] ??
		null;
	const secondaryFailures = failures
		.filter((event) => event !== primaryFailure)
		.map(failureRecord);
	const evidence = emptyEvidence();
	const proof = emptyProof();
	for (const event of normalized) {
		addEvidence(evidence, event);
		updateProof(proof, event);
	}
	const stageOutcomes = {};
	for (const event of events) {
		const stage = stageOf(event);
		const key = STAGE_OUTCOME_KEYS[stage];
		if (!key || !isTerminal(event)) continue;
		if (stageOutcomes[key] === undefined)
			stageOutcomes[key] = failureRecord(event);
	}
	const hasRecoveryRequired = events.some(
		(event) =>
			stageOf(event) === "recovery" &&
			(event.detail?.reasonCode === "orphan_attempt" ||
				event.detail?.code === "recovery_required"),
	);
	const hasUncertain = events.some(
		(event) =>
			event.status === "uncertain" ||
			event.legacyEvent === "host_power_unknown",
	);
	const hasTerminalCompletion = events.some((event) =>
		event.stage === "legacy"
			? LEGACY_TASK_COMPLETION_EVENTS.has(event.legacyEvent)
			: event.status === "succeeded" &&
				(event.stage === "run" ||
					["task_completed", "complete", "completed", "terminal"].includes(
						event.detail?.code,
					)),
	);
	const causalLinks = [];
	for (const event of normalized) {
		if (!event.causedBy) continue;
		const predecessor = normalized.find(
			(candidate) => candidate.outcomeId === event.causedBy,
		);
		const valid = Boolean(
			predecessor &&
				predecessor !== event &&
				predecessor.outcomeId !== event.outcomeId &&
				predecessor.runId === event.runId &&
				(predecessor.sequence ?? 0) <= (event.sequence ?? 0),
		);
		causalLinks.push({
			outcomeId: event.outcomeId ?? null,
			causedBy: event.causedBy,
			valid,
		});
	}
	const invalidCausality = causalLinks.filter((link) => !link.valid);
	const causalIntegrity = {
		status:
			invalidCausality.length > 0 || sourceRunIds.length > 1
				? "invalid"
				: "valid",
		invalidLinks: invalidCausality,
		...(sourceRunIds.length > 1 ? { runIds: sourceRunIds } : {}),
	};
	const finalStatus =
		invalidCausality.length > 0 ||
		sourceRunIds.length > 1 ||
		identityConflicts.length > 0
			? "recovery_required"
			: hasRecoveryRequired
				? "recovery_required"
				: primaryFailure
					? "failed"
					: hasUncertain
						? "uncertain"
						: hasTerminalCompletion
							? "succeeded"
							: "unknown";
	return {
		projectionVersion: OUTCOME_PROJECTION_VERSION,
		runId,
		finalStatus,
		primaryFailure: primaryFailure ? failureRecord(primaryFailure) : null,
		secondaryFailures,
		diagnosticEvidence: evidence,
		...stageOutcomes,
		reviewProof: proof,
		modelProof: {
			status: proof.status,
			servedModelVerified: proof.servedModelVerified,
			completionContinuationProof: proof.completionContinuationProof,
			targetId: proof.targetId,
		},
		taskCounters: reconcileCounters(events),
		attempts: [
			...new Set(
				events
					.filter((event) => event.attemptId)
					.map((event) => event.attemptId),
			),
		],
		causalIntegrity,
		causalLinks,
		identityConflicts,
		outcomes: events.map(clone),
		duplicateOutcomes,
	};
}
