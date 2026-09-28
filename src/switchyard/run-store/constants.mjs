import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaError } from "./errors.mjs";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const defaultStateRoot = resolve(
	__dirname,
	"..",
	"..",
	"..",
	".logs",
	"switchyard",
);
const defaultVmAdmissionRoot = resolve(homedir(), ".switchyard", "admission");
function resolveStateRoot() {
	const envOverride = process.env.SWITCHYARD_RUN_STORE_ROOT;
	if (envOverride) {
		return resolve(envOverride);
	}
	return defaultStateRoot;
}
function runsRoot() {
	return resolve(resolveStateRoot(), "runs");
}
function locksRoot() {
	return resolve(resolveStateRoot(), "locks");
}
function quarantineRoot() {
	return resolve(resolveStateRoot(), ".quarantine");
}
function resolveVmAdmissionRoot() {
	const envOverride = process.env.SWITCHYARD_VM_ADMISSION_ROOT;
	if (envOverride) return resolve(envOverride);
	return defaultVmAdmissionRoot;
}
function vmSlotPath(slotIndex) {
	return resolve(resolveVmAdmissionRoot(), `vm-slot-${slotIndex}.lock`);
}
const VALID_STATES = new Set([
	"created",
	"launching",
	"launcher_ready",
	"running",
	"succeeded",
	"failed",
	"deferred",
	"recovery_required",
]);
const VALID_CLEANUP_STATES = new Set([
	"not_started",
	"pending",
	"complete",
	"failed",
]);
const VALID_WORKTREE_STATES = new Set([
	"allocating",
	"active",
	"removed",
	"retained",
]);
const WORKTREE_RECORD_KEYS = new Set([
	"canonicalParent",
	"candidateChild",
	"path",
	"state",
	"reason",
	"retainedAt",
	"device",
	"inode",
	"nonce",
	"writerStopped",
]);
const PROCESS_INSTANCE_ID = randomUUID();
const HISTORICAL_SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 2;
const DEFAULT_LEASE_AGE_MS = 60_000;
const TELEMETRY_WRITE_FAILURE_LABELS = new Set([
	"revision_conflict",
	"schema_invalid",
	"lock_error",
	"type_error",
	"write_failed",
]);
const SUCCESS_RESULTS = new Set([
	"success",
	"success_no_diff",
	"review_completed",
]);
const APPROVED_EVENT_KEYS = new Set([
	"schemaVersion",
	"sequence",
	"timestamp",
	"phase",
	"event",
	"status",
	"taskId",
	"provider",
	"model",
	"requiredCapability",
	"resolvedTargetId",
	"outcome",
	"progress",
	"deadline",
	"byteCount",
	"container",
	"executionPlatform",
	"percentLeft",
	"timedOut",
	"targetId",
	"completedCount",
	"totalCount",
	"processedTasks",
	"completedTasks",
	"halted",
	"dispatchContractVersion",
	"invocationDescriptor",
	"descriptorIdentity",
	"descriptorHarness",
	"roster_sha256",
	"roster_schema_version",
	"resolved_target",
	"resolved_harness",
	"resolved_selector",
	"resolved_credential_profile",
	"quarantinedTargetIds",
	"retryTransitionId",
	"retryState",
	"attempt",
	"transitionType",
	"errorKind",
	"reasonCode",
	"reason",
	"artifactRef",
	"diagnosticRef",
	"diagnosticCode",
	"exitCode",
	"signal",
	"failurePhase",
	"diagnosticOrigin",
	"diagnosticEvidenceAvailable",
	// Closed vocabulary owned by the execution backend (CLEANUP_STAGES in
	// adapter/exec-error.mjs), never interpolated from provider output.
	"cleanupStage",
	// Boolean only: whether the adapter affirmatively read back the model the
	// provider served. Absent when the adapter cannot report one.
	"servedModelVerified",
	// Bounded route-health decision and deferral telemetry. These fields are
	// accepted only from closed host events; they are observational and never
	// participate in health authority. `result` is used only for the closed
	// route_health_deferred execution status.
	"result",
	"mode",
	"state",
	"available",
	"suppress",
	"trialAvailable",
	"initializable",
	// Route health binding is written only through createRouteHealthEvent().
	// It binds an otherwise ordinary, sanitized host event to an explicit public
	// configuration and host repair epoch.  Legacy events remain readable but
	// deliberately have no route-health authority.
	"routeHealthBinding",
	"reviewResult",
	// Reader-first outcome compatibility fields. Production writers do not
	// populate these in this checkpoint.
	"minimumReaderVersion",
	"writerEpoch",
	"outcomeId",
	"runId",
	"scope",
	"attemptId",
	"resumesOutcomeId",
	"stage",
	"legacyPhase",
	"legacyEvent",
	"dispatchCausality",
	"recordedAt",
	"producer",
	"causedBy",
	"operationId",
	"detail",
	"milestone",
	"checkIndex",
	"checkIdentity",
	"checkStatus",
	"firstChangeObserved",
	"elapsedSinceLastMilestoneMs",
]);
const EVENT_RESERVE_BYTES = 1024;
const EVENT_LOCK_WAIT_MS = 5_000;
const MUTATION_OPERATION_LIMIT = 64;
const MUTATION_OPERATION_STATES = new Set([
	"intent",
	"commanded",
	"observed",
	"completed",
	"failed",
	"uncertain",
]);
const MUTATION_OPERATION_OUTCOMES = new Set([
	"confirmed",
	"failed",
	"ambiguous",
	"unknown",
	"timed_out",
]);
const MUTATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MUTATION_RESOURCE_RE = /^[A-Za-z0-9._:/-]{1,256}$/u;
function validateMutationOperations(value) {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > MUTATION_OPERATION_LIMIT)
		throw new SchemaError("mutationOperations must be a bounded array");
	for (const operation of value) {
		if (
			!operation ||
			typeof operation !== "object" ||
			Array.isArray(operation) ||
			!MUTATION_ID_RE.test(operation.operationId ?? "") ||
			!MUTATION_ID_RE.test(operation.operation ?? "") ||
			!MUTATION_RESOURCE_RE.test(operation.resource ?? "") ||
			!MUTATION_OPERATION_STATES.has(operation.state) ||
			!MUTATION_OPERATION_OUTCOMES.has(operation.outcome) ||
			!Number.isSafeInteger(operation.attempt) ||
			operation.attempt < 0 ||
			!Number.isSafeInteger(operation.maxAttempts) ||
			operation.maxAttempts < 1 ||
			operation.maxAttempts > 3 ||
			(operation.idempotency !== undefined &&
				!["idempotent", "conditional", "unknown"].includes(
					operation.idempotency,
				)) ||
			(operation.retryAmbiguous !== undefined &&
				typeof operation.retryAmbiguous !== "boolean") ||
			typeof operation.recordedAt !== "string" ||
			Number.isNaN(Date.parse(operation.recordedAt))
		)
			throw new SchemaError("mutationOperations contains invalid metadata");
	}
}
const ROUTE_HEALTH_BINDING_KEYS = new Set([
	"version",
	"producer",
	"runId",
	"runRevision",
	"adapterContractId",
	"publicConfigurationEpoch",
	"repairEpoch",
	"claimRevision",
	"transportVerified",
	"lifecycleVerified",
]);
const ROUTE_HEALTH_EPOCH_RE = /^sha256:[a-f0-9]{64}$/;
const ROUTE_HEALTH_DEFERRED_RESULT = "route_health_deferred";
const DIAGNOSTIC_REF_RE = /^diagnostic:[a-f0-9]{32}$/u;
const MAX_DIAGNOSTIC_ARTIFACT_BYTES = 4096;
const DIAGNOSTIC_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_DIAGNOSTIC_STREAM_BYTES = 128 * 1024 * 1024;
const DIAGNOSTIC_ARTIFACT_KINDS = new Set([
	"auth_required",
	"usage_exhausted",
	"model_unsupported",
	"permission_denied",
	"network_unreachable",
	"cli_usage_error",
]);
const CHECKPOINT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_ARTIFACT_MAX_ENTRIES = 128;
const CHECKPOINT_ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;

export {
	__dirname,
	APPROVED_EVENT_KEYS,
	CHECKPOINT_ARTIFACT_MAX_BYTES,
	CHECKPOINT_ARTIFACT_MAX_ENTRIES,
	CHECKPOINT_ARTIFACT_MAX_FILE_BYTES,
	CURRENT_SCHEMA_VERSION,
	DEFAULT_LEASE_AGE_MS,
	DIAGNOSTIC_ARTIFACT_KINDS,
	DIAGNOSTIC_DIGEST_RE,
	DIAGNOSTIC_REF_RE,
	defaultStateRoot,
	defaultVmAdmissionRoot,
	EVENT_LOCK_WAIT_MS,
	EVENT_RESERVE_BYTES,
	HISTORICAL_SCHEMA_VERSION,
	locksRoot,
	MAX_DIAGNOSTIC_ARTIFACT_BYTES,
	MAX_DIAGNOSTIC_STREAM_BYTES,
	MUTATION_ID_RE,
	MUTATION_OPERATION_LIMIT,
	MUTATION_OPERATION_OUTCOMES,
	MUTATION_OPERATION_STATES,
	MUTATION_RESOURCE_RE,
	PROCESS_INSTANCE_ID,
	quarantineRoot,
	ROUTE_HEALTH_BINDING_KEYS,
	ROUTE_HEALTH_DEFERRED_RESULT,
	ROUTE_HEALTH_EPOCH_RE,
	resolveStateRoot,
	resolveVmAdmissionRoot,
	runsRoot,
	SUCCESS_RESULTS,
	TELEMETRY_WRITE_FAILURE_LABELS,
	VALID_CLEANUP_STATES,
	VALID_STATES,
	VALID_WORKTREE_STATES,
	validateMutationOperations,
	vmSlotPath,
	WORKTREE_RECORD_KEYS,
};
