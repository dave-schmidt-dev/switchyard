import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	isPersistentFailureMetadata,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { createProgressSnapshot } from "../adapter/provider-lifecycle.mjs";
import { isProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import { sanitizeReviewResult } from "../diagnostics/review-result.mjs";
import {
	OUTCOME_EVENT_MAX_BYTES,
	OUTCOME_FILE_MAX_BYTES,
	OUTCOME_FILE_MAX_LINES,
	OUTCOME_STAGES,
	SUPPORTED_OUTCOME_READER_VERSION,
	validateOutcomeEvent,
} from "../outcome/schema.mjs";
import {
	mergeOutcomeShadow,
	projectOutcomeShadow,
} from "../outcome/shadow.mjs";
import {
	APPROVED_EVENT_KEYS,
	EVENT_RESERVE_BYTES,
	MAX_DIAGNOSTIC_ARTIFACT_BYTES,
	ROUTE_HEALTH_DEFERRED_RESULT,
	SUCCESS_RESULTS,
} from "./constants.mjs";
import { RUN_ID_RE, SchemaError, validateRunId } from "./errors.mjs";
import {
	DESCRIPTOR_IDENTITY_RE,
	isSafeDescriptorReceipt,
	ownerOnlyRegularFileStat,
	validateRouteHealthBinding,
} from "./receipt-validation.mjs";
import {
	getRunRoot,
	readRun,
	resolveDiagnosticArtifact,
} from "./run-records.mjs";
import {
	enqueueRunMutation,
	performUpdate,
	reconcileEventCeilingLocked,
	withEventAppendLock,
} from "./run-updates.mjs";

async function createEventInternal(
	runId,
	event,
	{ routeHealthAuthorised = false } = {},
) {
	validateRunId(runId);
	if (event?.routeHealthBinding !== undefined) {
		if (!routeHealthAuthorised)
			throw new SchemaError("route health binding requires the host producer");
		validateRouteHealthBinding(event.routeHealthBinding);
	}
	if (
		event?.providerReliability !== undefined &&
		!isProviderReliabilityDiagnostic(event.providerReliability)
	) {
		throw new SchemaError(
			"event contains invalid provider reliability metadata",
		);
	}
	if (
		event?.invocationDescriptor !== undefined &&
		event.invocationDescriptor !== null &&
		!isSafeDescriptorReceipt(
			event.invocationDescriptor,
			event.descriptorHarness,
		)
	) {
		throw new SchemaError("event contains an invalid descriptor receipt");
	}
	if (
		event?.descriptorIdentity !== undefined &&
		event.descriptorIdentity !== null &&
		(typeof event.descriptorIdentity !== "string" ||
			!DESCRIPTOR_IDENTITY_RE.test(event.descriptorIdentity))
	) {
		throw new SchemaError("event descriptorIdentity is invalid");
	}
	if (
		event?.invocationDescriptor != null &&
		event?.descriptorIdentity != null &&
		event.invocationDescriptor.descriptor_identity !== event.descriptorIdentity
	) {
		throw new SchemaError(
			"event descriptorIdentity does not match invocationDescriptor",
		);
	}
	if (
		event?.invocationDescriptor &&
		event?.resolvedTargetId &&
		event.invocationDescriptor.target_id !== event.resolvedTargetId
	) {
		throw new SchemaError(
			"event descriptor target does not match resolvedTargetId",
		);
	}
	if (
		event?.invocationDescriptor &&
		(!event.descriptorHarness || !event.resolvedTargetId)
	) {
		throw new SchemaError(
			"event descriptor requires descriptor harness and resolvedTargetId",
		);
	}
	if (
		event?.dispatchContractVersion !== undefined &&
		(!Number.isInteger(event.dispatchContractVersion) ||
			event.dispatchContractVersion < 1)
	) {
		throw new SchemaError(
			"event dispatchContractVersion must be a positive integer",
		);
	}
	const runDir = getRunRoot(runId);
	const eventsPath = resolve(runDir, "events.jsonl");
	const bootDiagnosticAvailable = () => {
		try {
			const stat = lstatSync(resolve(runDir, "boot-stderr.log"));
			return (
				ownerOnlyRegularFileStat(stat, MAX_DIAGNOSTIC_ARTIFACT_BYTES) &&
				stat.size > 0
			);
		} catch {
			return false;
		}
	};

	const log = await reconcileEventCeilingLocked(runId);
	const current = await readRun(runId);
	const diagnosticArtifact = event?.diagnosticRef
		? await resolveDiagnosticArtifact(runId, event.diagnosticRef)
		: null;
	const diagnosticEvidenceAvailable = event?.routeHealthBinding
		? event?.diagnosticEvidenceAvailable === true || Boolean(diagnosticArtifact)
		: Boolean(diagnosticArtifact) ||
			(event?.failurePhase === "worker_boot" && bootDiagnosticAvailable());
	if (
		event?.routeHealthBinding &&
		(event.routeHealthBinding.runId !== current.runId ||
			event.routeHealthBinding.runRevision !== current.revision)
	) {
		throw new SchemaError("route health binding does not match run projection");
	}
	const nextSeq = current.lastEventSequence + 1;
	const isDeferredEvent =
		event?.event === ROUTE_HEALTH_DEFERRED_RESULT ||
		event?.result === ROUTE_HEALTH_DEFERRED_RESULT;
	const isFailureEvent =
		!isDeferredEvent &&
		(event?.event === "task_failed" ||
			event?.event === "queue_halted" ||
			event?.event === "worker_boot_failed" ||
			event?.errorKind !== undefined ||
			(event?.result !== undefined && !SUCCESS_RESULTS.has(event.result)));
	const suppliedFailure =
		isFailureEvent && event?.errorKind
			? {
					errorKind: event.errorKind,
					reasonCode: event.reasonCode,
					reason: event.reason,
					...(event.artifactRef !== undefined
						? { artifactRef: event.artifactRef }
						: {}),
					...(diagnosticArtifact ? { diagnosticRef: event.diagnosticRef } : {}),
					...(event.diagnosticCode !== undefined
						? { diagnosticCode: event.diagnosticCode }
						: {}),
					...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
					...(event.signal !== undefined ? { signal: event.signal } : {}),
					...(event.failurePhase !== undefined
						? { failurePhase: event.failurePhase }
						: {}),
					...(event.diagnosticOrigin !== undefined
						? { diagnosticOrigin: event.diagnosticOrigin }
						: {}),
					...(event.diagnosticEvidenceAvailable !== undefined
						? {
								diagnosticEvidenceAvailable,
							}
						: {}),
					...(event.providerReliability !== undefined
						? { providerReliability: event.providerReliability }
						: {}),
				}
			: null;
	const safeFailure = isFailureEvent
		? isPersistentFailureMetadata(suppliedFailure)
			? suppliedFailure
			: sanitizeFailureMetadata({
					taskId: event.taskId,
					result: event.result ?? "unknown_failure",
					errorKind: event.errorKind,
					timedOut: event.timedOut,
					artifactRef: event.artifactRef,
					partialDiffPath: event.partialDiffPath,
					gateEvidencePath: event.gateEvidencePath,
					diagnosticRef: diagnosticArtifact ? event.diagnosticRef : undefined,
					diagnosticCode: event.diagnosticCode,
					exitCode: event.exitCode,
					signal: event.signal,
					failurePhase: event.failurePhase,
					diagnosticOrigin: event.diagnosticOrigin,
					diagnosticEvidenceAvailable: diagnosticEvidenceAvailable
						? true
						: event.diagnosticEvidenceAvailable !== undefined
							? false
							: undefined,
					resolvedTargetId: event.resolvedTargetId,
					descriptorIdentity: event.descriptorIdentity,
					descriptorHarness: event.descriptorHarness,
					providerReliability: event.providerReliability,
				})
		: null;
	const projectedReviewResult =
		event?.reviewResult === undefined
			? undefined
			: sanitizeReviewResult(event.reviewResult);

	const entry = {
		schemaVersion: current.schemaVersion,
		sequence: nextSeq,
		timestamp: new Date().toISOString(),
		phase: event.phase,
		event: event.event,
		status: event.status,
	};

	if (event && typeof event === "object") {
		for (const key of Object.keys(event)) {
			if (APPROVED_EVENT_KEYS.has(key)) {
				entry[key] =
					key === "reviewResult"
						? projectedReviewResult
						: key === "progress"
							? createProgressSnapshot({
									stage: event.progress?.stage,
									elapsedMs: event.progress?.elapsedMs,
									lastSubstantiveProgressAt:
										event.progress?.lastSubstantiveProgressAt,
									lastSubstantiveProgressAgeMs:
										event.progress?.lastSubstantiveProgressAgeMs,
									stdoutBytes: event.progress?.counters?.stdoutBytes,
									stderrBytes: event.progress?.counters?.stderrBytes,
									pollCount: event.progress?.counters?.polls,
									progressCount: event.progress?.counters?.progressEvents,
									outcome: event.progress?.outcome,
								})
							: event[key];
			}
		}
	}
	if (!diagnosticArtifact) delete entry.diagnosticRef;
	// Admission wait telemetry is deliberately opt-in rather than a general
	// event field. This prevents arbitrary status payloads from widening the
	// durable event schema while retaining one content-free progress measure.
	if (
		(event?.event === "vm_slot_wait" ||
			event?.milestone !== undefined ||
			event?.event === "milestone") &&
		Number.isFinite(event.elapsedMs) &&
		event.elapsedMs >= 0
	) {
		entry.elapsedMs = event.elapsedMs;
	}

	entry.schemaVersion = current.schemaVersion;
	entry.sequence = nextSeq;
	entry.timestamp = new Date().toISOString();
	entry.phase = event.phase;
	entry.event = event.event;
	entry.status = event.status;

	if (safeFailure) {
		const existingReasonCode = entry.reasonCode;
		const existingReason = entry.reason;
		const existingDiagnosticCode = entry.diagnosticCode;
		delete entry.error;
		delete entry.output;
		delete entry.partialDiff;
		delete entry.partialDiffPath;
		delete entry.gateEvidence;
		delete entry.gateEvidencePath;
		delete entry.artifactRef;
		delete entry.reason;
		delete entry.diagnosticCode;
		delete entry.exitCode;
		delete entry.signal;
		delete entry.failurePhase;
		delete entry.diagnosticOrigin;
		delete entry.diagnosticEvidenceAvailable;
		Object.assign(entry, safeFailure);
		if (
			event?.event === "worker_boot_failed" &&
			existingReasonCode &&
			existingReasonCode !== "launch_failed"
		) {
			entry.reasonCode = existingReasonCode;
			if (existingReason) entry.reason = existingReason;
			if (existingDiagnosticCode) entry.diagnosticCode = existingDiagnosticCode;
		}
	}

	const serialized = `${JSON.stringify(entry)}\n`;
	const entryBytes = Buffer.byteLength(serialized, "utf8");
	if (entryBytes > OUTCOME_EVENT_MAX_BYTES)
		throw new SchemaError("event exceeds line limit");
	if (
		log.lines + 1 >= OUTCOME_FILE_MAX_LINES ||
		log.bytes + entryBytes + EVENT_RESERVE_BYTES > OUTCOME_FILE_MAX_BYTES
	)
		throw new SchemaError("event reserve cannot be proven intact");

	await appendFile(eventsPath, serialized, {
		mode: 0o600,
	});
	const shadow = projectOutcomeShadow([...log.events, entry], { run: current });

	await performUpdate(
		runId,
		{
			lastEventSequence: nextSeq,
			outcomeShadow: mergeOutcomeShadow(current.outcomeShadow, shadow),
			...(safeFailure ? { lastFailure: safeFailure } : {}),
			...(projectedReviewResult !== undefined
				? { lastReviewResult: projectedReviewResult }
				: {}),
		},
		current.revision,
	);

	return nextSeq;
}
export function createStageOutcome({
	runId,
	taskId = null,
	attemptId = null,
	attempt = taskId === null ? 0 : 1,
	stage,
	status,
	producer,
	code,
	reasonCode = code,
	detail = {},
	writerEpoch = null,
	causedBy = null,
	resumesOutcomeId = causedBy,
	operationId = null,
	dispatchCausality = null,
	outcomeId = null,
	recordedAt = new Date().toISOString(),
} = {}) {
	if (!OUTCOME_STAGES.includes(stage) || stage === "provider")
		throw new SchemaError("stage outcome requires a non-provider stage");
	if (!detail || typeof detail !== "object" || Array.isArray(detail))
		throw new SchemaError("stage outcome detail must be an object");
	if (
		typeof code !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(code)
	)
		throw new SchemaError("stage outcome code is invalid");
	if (typeof runId !== "string" || !RUN_ID_RE.test(runId))
		throw new SchemaError("stage outcome runId is invalid");
	const safeAttemptId =
		taskId === null ? null : (attemptId ?? `attempt-${attempt}`);
	const identitySeed = [
		runId,
		taskId ?? "run",
		safeAttemptId ?? "run",
		stage,
		code,
		status,
		causedBy ?? "root",
		operationId ?? "default-operation",
	].join(":");
	const identityHash = createHash("sha256")
		.update(identitySeed, "utf8")
		.digest("hex")
		.slice(0, 32);
	const safeOutcomeId = outcomeId ?? `outcome-${identityHash}`;
	const safeOperationId = operationId ?? `operation-${identityHash}`;
	const safeCausality =
		dispatchCausality ??
		`sha256:${createHash("sha256")
			.update(`${runId}:${taskId ?? "run"}`, "utf8")
			.digest("hex")}`;
	const event = {
		schemaVersion: 1,
		minimumReaderVersion: SUPPORTED_OUTCOME_READER_VERSION,
		writerEpoch,
		outcomeId: safeOutcomeId,
		sequence: 1,
		runId,
		scope: taskId === null ? "run" : "task",
		taskId,
		attemptId: safeAttemptId,
		resumesOutcomeId,
		stage,
		legacyPhase: null,
		legacyEvent: null,
		dispatchCausality: safeCausality,
		attempt,
		recordedAt,
		producer,
		causedBy,
		operationId: safeOperationId,
		status,
		detail: { ...detail, code, ...(reasonCode ? { reasonCode } : {}) },
	};
	validateOutcomeEvent(event);
	return Object.freeze(event);
}
export async function createEvent(runId, event) {
	validateRunId(runId);
	return enqueueRunMutation(runId, () =>
		withEventAppendLock(runId, () => createEventInternal(runId, event)),
	);
}
export { createEventInternal };
