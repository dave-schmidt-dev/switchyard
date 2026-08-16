import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	isPersistentFailureMetadata,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import {
	validateIdentifier,
	validateInvocationArgs,
	validateModelArg,
} from "../adapter/shell-safety.mjs";
import {
	getInvocationDescriptorIdentity,
	normalizeProviderName,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";

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
	"recovery_required",
]);

const VALID_CLEANUP_STATES = new Set([
	"not_started",
	"pending",
	"complete",
	"failed",
]);

const RUN_ID_RE = /^[\w-]+$/;

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

function isSafeTargetId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) {
		return false;
	}
	return ![...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

const DESCRIPTOR_IDENTITY_RE = /^sha256:[a-f0-9]{64}$/;
const DESCRIPTOR_CONTROL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// Schema-v1 receipts predate harness binding. They remain readable only when
// no harness provenance is available; execution paths require the new
// canonical identity below whenever a harness is known.
function legacyDescriptorIdentityForReceipt(value) {
	const canonical = {
		effort: value.effort ?? null,
		invocation_args: [...value.invocation_args],
		model_ref: value.model_ref,
		selector: value.selector,
		target_id: value.target_id,
		variant: value.variant ?? null,
	};
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(canonical), "utf8")
		.digest("hex")}`;
}

// Best-effort provenance lookup: current roster targets are authoritative when
// available, while synthetic or historical target ids remain readable when no
// roster can resolve them. Strict execution still requires an explicit
// descriptor harness in either case.
function knownTargetHarness(targetId) {
	try {
		const identity = resolveTargetIdentity(targetId);
		return identity?.targetId === targetId ? identity.harnessKey : null;
	} catch {
		return null;
	}
}

function isSafeDescriptorReceipt(value, descriptorHarness = null) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const fields = [
		"target_id",
		"model_ref",
		"selector",
		"effort",
		"variant",
		"invocation_args",
		"descriptor_identity",
	];
	if (Object.keys(value).some((key) => !fields.includes(key))) return false;
	try {
		validateIdentifier(value.target_id, "descriptor target_id");
		validateModelArg(value.model_ref, "descriptor model_ref");
		validateModelArg(value.selector, "descriptor selector");
	} catch {
		return false;
	}
	if (!DESCRIPTOR_IDENTITY_RE.test(value.descriptor_identity)) return false;
	if (
		(value.effort !== null &&
			value.effort !== undefined &&
			(typeof value.effort !== "string" ||
				!["low", "medium", "high", "xhigh", "max"].includes(value.effort))) ||
		(value.variant !== null &&
			value.variant !== undefined &&
			(typeof value.variant !== "string" ||
				![
					"default",
					"none",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
					"thinking",
				].includes(value.variant))) ||
		(value.effort != null && value.variant != null)
	)
		return false;
	if (!Array.isArray(value.invocation_args)) return false;
	if (
		value.invocation_args.some(
			(arg) => typeof arg !== "string" || DESCRIPTOR_CONTROL_RE.test(arg),
		)
	)
		return false;
	const validArgGrammar = ["claude", "codex", "opencode"].some((harness) => {
		try {
			validateInvocationArgs(value.invocation_args, harness);
			return true;
		} catch {
			return false;
		}
	});
	if (!validArgGrammar) return false;
	if (
		value.invocation_args[0] === "--effort" &&
		value.effort !== value.invocation_args[1]
	) {
		return false;
	}
	if (
		value.invocation_args[0] === "-c" &&
		value.effort !== value.invocation_args[1].split("=", 2)[1]
	) {
		return false;
	}
	if (
		value.invocation_args[0] === "--variant" &&
		value.variant !== value.invocation_args[1]
	) {
		return false;
	}
	if (descriptorHarness !== null && descriptorHarness !== undefined) {
		if (
			typeof descriptorHarness !== "string" ||
			descriptorHarness.trim() === ""
		) {
			return false;
		}
		try {
			validateInvocationDescriptor(value, descriptorHarness);
			if (
				getInvocationDescriptorIdentity(value, descriptorHarness) !==
				value.descriptor_identity
			)
				return false;
		} catch {
			return false;
		}
		if (!normalizeProviderName(descriptorHarness)) return false;
		const rosterHarness = knownTargetHarness(value.target_id);
		if (
			rosterHarness &&
			normalizeProviderName(descriptorHarness) !==
				normalizeProviderName(rosterHarness)
		) {
			return false;
		}
	} else if (
		value.descriptor_identity !== legacyDescriptorIdentityForReceipt(value)
	) {
		// A model-only historical receipt cannot be rebound to a harness safely;
		// accept only the exact legacy digest and keep it out of strict execution.
		return false;
	}
	return true;
}

function validateRunId(runId) {
	if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
		throw new SchemaError("Invalid runId");
	}
}

class RevisionError extends Error {
	constructor(message) {
		super(message);
		this.name = "RevisionError";
	}
}

class LockError extends Error {
	constructor(message) {
		super(message);
		this.name = "LockError";
	}
}

class VmSlotUnavailableError extends LockError {
	constructor(holderRuns) {
		const holders = holderRuns.length > 0 ? holderRuns.join(", ") : "unknown";
		super(
			`VM_SLOT_UNAVAILABLE: VM admission capacity is unavailable (held by run ${holders})`,
		);
		this.name = "VmSlotUnavailableError";
		this.code = "VM_SLOT_UNAVAILABLE";
	}
}

class SchemaError extends Error {
	constructor(message) {
		super(message);
		this.name = "SchemaError";
	}
}

/**
 * Resolve the absolute path to .logs/switchyard from the package root.
 * Honors SWITCHYARD_RUN_STORE_ROOT env var for testing.
 * @returns {string}
 */
export function getStateRoot() {
	return resolveStateRoot();
}

/**
 * Resolve the global root containing the two VM admission slot files.
 * Honors SWITCHYARD_VM_ADMISSION_ROOT for hermetic tests and operators.
 * @returns {string}
 */
export function getVmAdmissionRoot() {
	return resolveVmAdmissionRoot();
}

/**
 * Resolve the absolute path to a run's directory.
 * @param {string} runId
 * @returns {string}
 */
export function getRunRoot(runId) {
	return resolve(runsRoot(), runId);
}

function lockFilePath(canonicalPath) {
	const resolvedPath = resolve(canonicalPath);
	const hash = createHash("sha256").update(resolvedPath).digest("hex");
	return resolve(locksRoot(), `${hash}.lock`);
}

function validateRun(data) {
	if (
		data.schemaVersion !== HISTORICAL_SCHEMA_VERSION &&
		data.schemaVersion !== CURRENT_SCHEMA_VERSION
	) {
		throw new SchemaError(
			`Unsupported schemaVersion (expected ${HISTORICAL_SCHEMA_VERSION} or ${CURRENT_SCHEMA_VERSION})`,
		);
	}
	if (typeof data.runId !== "string") {
		throw new SchemaError("runId must be a string");
	}
	if (typeof data.state !== "string" || !VALID_STATES.has(data.state)) {
		throw new SchemaError("Invalid state");
	}
	if (
		typeof data.cleanupState !== "string" ||
		!VALID_CLEANUP_STATES.has(data.cleanupState)
	) {
		throw new SchemaError("Invalid cleanupState");
	}
	if (typeof data.revision !== "number" || !Number.isInteger(data.revision)) {
		throw new SchemaError("revision must be an integer");
	}
	if (typeof data.createdAt !== "string") {
		throw new SchemaError("createdAt must be a string");
	}
	if (typeof data.updatedAt !== "string") {
		throw new SchemaError("updatedAt must be a string");
	}
	if (!Array.isArray(data.orderedTaskIds)) {
		throw new SchemaError("orderedTaskIds must be an array");
	}
	if (data.initialHostFingerprint == null) {
		throw new SchemaError("initialHostFingerprint is required");
	}
	if (typeof data.workerNonce !== "string") {
		throw new SchemaError("workerNonce must be a string");
	}
	if (typeof data.lastLeaseHeartbeat !== "string") {
		throw new SchemaError("lastLeaseHeartbeat must be a string");
	}
	if (
		typeof data.lastEventSequence !== "number" ||
		!Number.isInteger(data.lastEventSequence)
	) {
		throw new SchemaError("lastEventSequence must be an integer");
	}
	if (
		data.activeTaskStartedAt !== undefined &&
		data.activeTaskStartedAt !== null &&
		typeof data.activeTaskStartedAt !== "number"
	) {
		throw new SchemaError("activeTaskStartedAt must be a number or null");
	}
	for (const field of ["activeTaskElapsedMs", "activeTaskHeartbeatAt"]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			(typeof data[field] !== "number" ||
				!Number.isFinite(data[field]) ||
				data[field] < 0)
		) {
			throw new SchemaError(
				`${field} must be a finite non-negative number or null`,
			);
		}
	}
	if (
		data.activeTaskProcessPhase !== undefined &&
		data.activeTaskProcessPhase !== null &&
		(typeof data.activeTaskProcessPhase !== "string" ||
			data.activeTaskProcessPhase.length > 64 ||
			/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(data.activeTaskProcessPhase))
	) {
		throw new SchemaError(
			"activeTaskProcessPhase must be a safe scalar string or null",
		);
	}
	if (
		data.telemetryWriteFailures !== undefined &&
		(typeof data.telemetryWriteFailures !== "number" ||
			!Number.isInteger(data.telemetryWriteFailures) ||
			data.telemetryWriteFailures < 0)
	) {
		throw new SchemaError(
			"telemetryWriteFailures must be a non-negative integer",
		);
	}
	if (
		data.lastTelemetryWriteFailure !== undefined &&
		data.lastTelemetryWriteFailure !== null &&
		(typeof data.lastTelemetryWriteFailure !== "string" ||
			!TELEMETRY_WRITE_FAILURE_LABELS.has(data.lastTelemetryWriteFailure))
	) {
		throw new SchemaError(
			"lastTelemetryWriteFailure must be a known safe label or null",
		);
	}
	if (
		data.lastCompletionAt !== undefined &&
		data.lastCompletionAt !== null &&
		typeof data.lastCompletionAt !== "number"
	) {
		throw new SchemaError("lastCompletionAt must be a number or null");
	}
	if (
		data.workingContainerName !== undefined &&
		data.workingContainerName !== null &&
		typeof data.workingContainerName !== "string"
	) {
		throw new SchemaError("workingContainerName must be a string or null");
	}
	if (
		data.snapshotStatus !== undefined &&
		data.snapshotStatus !== null &&
		typeof data.snapshotStatus !== "string"
	) {
		throw new SchemaError("snapshotStatus must be a string or null");
	}
	if (
		data.resolvedTargetId !== undefined &&
		data.resolvedTargetId !== null &&
		typeof data.resolvedTargetId !== "string"
	) {
		throw new SchemaError("resolvedTargetId must be a string or null");
	}
	for (const field of ["lastResolvedTargetId"]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			!isSafeTargetId(data[field])
		) {
			throw new SchemaError(`${field} must be a safe target id or null`);
		}
	}
	for (const field of [
		"activeTaskDescriptorHarness",
		"lastTaskDescriptorHarness",
	]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			(typeof data[field] !== "string" || !normalizeProviderName(data[field]))
		) {
			throw new SchemaError(`${field} must be a provider harness or null`);
		}
	}
	for (const field of [
		"activeTaskInvocationDescriptor",
		"lastTaskInvocationDescriptor",
	]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			!isSafeDescriptorReceipt(
				data[field],
				field === "activeTaskInvocationDescriptor"
					? data.activeTaskDescriptorHarness
					: data.lastTaskDescriptorHarness,
			)
		) {
			throw new SchemaError(`${field} contains an invalid descriptor receipt`);
		}
	}
	for (const field of [
		"activeTaskDescriptorIdentity",
		"lastTaskDescriptorIdentity",
	]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			(typeof data[field] !== "string" ||
				!DESCRIPTOR_IDENTITY_RE.test(data[field]))
		) {
			throw new SchemaError(`${field} must be a descriptor identity or null`);
		}
	}
	for (const [descriptorField, identityField] of [
		["activeTaskInvocationDescriptor", "activeTaskDescriptorIdentity"],
		["lastTaskInvocationDescriptor", "lastTaskDescriptorIdentity"],
	]) {
		const descriptor = data[descriptorField];
		const identity = data[identityField];
		if (
			descriptor !== undefined &&
			descriptor !== null &&
			identity !== undefined &&
			identity !== null &&
			descriptor.descriptor_identity !== identity
		) {
			throw new SchemaError(
				`${identityField} does not match ${descriptorField}`,
			);
		}
	}
	if (data.activeTaskInvocationDescriptor) {
		if (!data.activeTaskDescriptorHarness || !data.resolvedTargetId) {
			throw new SchemaError(
				"active descriptor requires descriptor harness and resolvedTargetId",
			);
		}
	}
	if (data.lastTaskInvocationDescriptor) {
		if (!data.lastTaskDescriptorHarness || !data.lastResolvedTargetId) {
			throw new SchemaError(
				"last descriptor requires descriptor harness and lastResolvedTargetId",
			);
		}
	}
	if (
		data.activeTaskInvocationDescriptor &&
		data.resolvedTargetId &&
		data.activeTaskInvocationDescriptor.target_id !== data.resolvedTargetId
	) {
		throw new SchemaError(
			"active descriptor target does not match resolvedTargetId",
		);
	}
	if (
		data.lastTaskInvocationDescriptor &&
		data.lastResolvedTargetId &&
		data.lastTaskInvocationDescriptor.target_id !== data.lastResolvedTargetId
	) {
		throw new SchemaError(
			"last descriptor target does not match lastResolvedTargetId",
		);
	}
	if (
		data.dispatchContractVersion !== undefined &&
		(!Number.isInteger(data.dispatchContractVersion) ||
			data.dispatchContractVersion < 1)
	) {
		throw new SchemaError("dispatchContractVersion must be a positive integer");
	}
	if (data.quarantinedTargetIds !== undefined) {
		if (
			!Array.isArray(data.quarantinedTargetIds) ||
			data.quarantinedTargetIds.some((value) => !isSafeTargetId(value))
		) {
			throw new SchemaError(
				"quarantinedTargetIds must be an array of non-empty strings",
			);
		}
	}
	if (
		data.retryTransitionId !== undefined &&
		(!Number.isInteger(data.retryTransitionId) || data.retryTransitionId < 0)
	) {
		throw new SchemaError("retryTransitionId must be a non-negative integer");
	}
	if (data.retryState !== undefined && data.retryState !== null) {
		const retryState = data.retryState;
		if (
			typeof retryState !== "object" ||
			Array.isArray(retryState) ||
			typeof retryState.taskId !== "string" ||
			!Number.isInteger(retryState.attempt) ||
			(retryState.attempt !== 1 && retryState.attempt !== 2) ||
			typeof retryState.phase !== "string" ||
			(retryState.resolvedTargetId !== undefined &&
				retryState.resolvedTargetId !== null &&
				!isSafeTargetId(retryState.resolvedTargetId))
		) {
			throw new SchemaError("retryState contains invalid retry metadata");
		}
		if (
			retryState.invocationDescriptor !== undefined &&
			retryState.invocationDescriptor !== null &&
			!isSafeDescriptorReceipt(
				retryState.invocationDescriptor,
				retryState.descriptorHarness,
			)
		) {
			throw new SchemaError(
				"retryState contains an invalid descriptor receipt",
			);
		}
		if (
			retryState.invocationDescriptor &&
			(!retryState.descriptorHarness || !retryState.resolvedTargetId)
		) {
			throw new SchemaError(
				"retryState descriptor requires descriptor harness and resolvedTargetId",
			);
		}
		if (
			retryState.descriptorIdentity !== undefined &&
			retryState.descriptorIdentity !== null &&
			(!DESCRIPTOR_IDENTITY_RE.test(retryState.descriptorIdentity) ||
				retryState.invocationDescriptor?.descriptor_identity !==
					retryState.descriptorIdentity)
		) {
			throw new SchemaError("retryState descriptor identity is invalid");
		}
		if (
			retryState.invocationDescriptor &&
			retryState.resolvedTargetId &&
			retryState.invocationDescriptor.target_id !== retryState.resolvedTargetId
		) {
			throw new SchemaError(
				"retryState descriptor target does not match target",
			);
		}
	}
	for (const field of ["retryAttempts", "retryTransitions"]) {
		if (data[field] === undefined) continue;
		if (!Array.isArray(data[field])) {
			throw new SchemaError(`${field} must be an array`);
		}
		for (const entry of data[field]) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new SchemaError(`${field} contains invalid retry metadata`);
			}
			if (
				entry.invocationDescriptor !== undefined &&
				entry.invocationDescriptor !== null &&
				!isSafeDescriptorReceipt(
					entry.invocationDescriptor,
					entry.descriptorHarness,
				)
			) {
				throw new SchemaError(
					`${field} contains an invalid descriptor receipt`,
				);
			}
			if (
				entry.invocationDescriptor &&
				(!entry.descriptorHarness || !entry.resolvedTargetId)
			) {
				throw new SchemaError(
					`${field} descriptor requires descriptor harness and resolvedTargetId`,
				);
			}
			if (
				entry.descriptorIdentity !== undefined &&
				entry.descriptorIdentity !== null &&
				(!DESCRIPTOR_IDENTITY_RE.test(entry.descriptorIdentity) ||
					entry.invocationDescriptor?.descriptor_identity !==
						entry.descriptorIdentity)
			) {
				throw new SchemaError(`${field} descriptor identity is invalid`);
			}
			if (
				entry.invocationDescriptor &&
				entry.resolvedTargetId &&
				entry.invocationDescriptor.target_id !== entry.resolvedTargetId
			) {
				throw new SchemaError(
					`${field} descriptor target does not match target`,
				);
			}
		}
	}
	for (const field of ["snapshotMtime", "snapshotAgeMsAtRoute"]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			(typeof data[field] !== "number" || !Number.isFinite(data[field]))
		) {
			throw new SchemaError(`${field} must be a finite number or null`);
		}
	}
	if (
		data.lastFailure !== undefined &&
		data.lastFailure !== null &&
		!isPersistentFailureMetadata(data.lastFailure)
	) {
		throw new SchemaError("lastFailure contains invalid persistent metadata");
	}
	if (data.schemaVersion === CURRENT_SCHEMA_VERSION) {
		if (
			typeof data.queueIdentity !== "string" ||
			!/^[a-f0-9]{64}$/.test(data.queueIdentity)
		) {
			throw new SchemaError("queueIdentity must be a sha256 hex string");
		}
		if (typeof data.projectRevision !== "string" || !data.projectRevision) {
			throw new SchemaError("projectRevision must be a non-empty string");
		}
		const options = data.runOptions;
		if (
			options === null ||
			typeof options !== "object" ||
			Array.isArray(options)
		) {
			throw new SchemaError("runOptions must be an object");
		}
		if (options.version !== 1) {
			throw new SchemaError("runOptions.version must be 1");
		}
		if (
			(options.maxTasks !== null &&
				(!Number.isInteger(options.maxTasks) || options.maxTasks < 1)) ||
			typeof options.stopOnFailure !== "boolean" ||
			(options.checkpointPath !== null &&
				typeof options.checkpointPath !== "string") ||
			(options.platform !== undefined &&
				!["docker", "macos"].includes(options.platform))
		) {
			throw new SchemaError("runOptions contains invalid scalar fields");
		}
		for (const field of ["onlyProviders", "excludeProviders", "taskIds"]) {
			if (
				!Array.isArray(options[field]) ||
				options[field].some((value) => typeof value !== "string")
			) {
				throw new SchemaError(
					`runOptions.${field} must be an array of strings`,
				);
			}
		}
	}
}

async function writeRunAtomically(runJsonPath, data) {
	// Unique tmp path per write call: process.pid + a random UUID. A fixed
	// shared tmp path lets concurrent writers to the same run.json collide —
	// writer A renames (and removes) the tmp before writer B's rename runs,
	// so B fails with ENOENT. Per-call uniqueness means each writer's rename
	// only ever touches its own tmp file.
	const tmpPath = `${runJsonPath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmpPath, JSON.stringify(data), { mode: 0o600 });
	try {
		await rename(tmpPath, runJsonPath);
	} catch (e) {
		// Best-effort cleanup so a failed rename never orphans a unique tmp.
		await unlink(tmpPath).catch(() => {});
		throw e;
	}
}

async function ensureDir(dirPath, mode) {
	await mkdir(dirPath, { recursive: true, mode, force: true });
}

// Strip control characters (C0, DEL, C1 — \p{Cc}), Unicode format controls
// (\p{Cf}: zero-width joiners/spaces, bidi override marks, etc.), and the
// Unicode line/paragraph separators (\p{Zl}/\p{Zp}) from any untrusted string
// before it reaches a warning or the returned quarantine metadata, so an
// arbitrary directory name or filesystem error can never inject log lines,
// hide or reorder text, or control the terminal.
const CONTROL_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
function sanitizeForDisplay(text) {
	if (typeof text !== "string") return "";
	return text.replace(CONTROL_CHAR_RE, "?");
}

/**
 * Initialize a new run with state "created".
 *
 * @param {object} options
 * @param {string} options.runId
 * @param {string} options.tasksFilePath
 * @param {string} options.projectPath
 * @param {string[]} options.orderedTaskIds
 * @param {object|string} options.initialHostFingerprint
 * @param {string[]} [options.launchArgs]
 * @returns {Promise<object>} the written run snapshot
 */
export async function initializeRun(options) {
	const {
		runId,
		tasksFilePath,
		projectPath,
		orderedTaskIds,
		initialHostFingerprint,
		workerNonce = "",
		launchArgs = [],
		projectRevision = null,
		runOptions = undefined,
		queueIdentity = undefined,
	} = options;

	validateRunId(runId);

	const runDir = getRunRoot(runId);
	await ensureDir(runDir, 0o700);

	const runJsonPath = resolve(runDir, "run.json");
	try {
		await readFile(runJsonPath, "utf8");
		throw new Error(`Run already exists: ${runId}`);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}

	await ensureDir(resolve(runDir, "artifacts"), 0o700);

	const now = new Date().toISOString();
	const versioned =
		queueIdentity !== undefined ||
		runOptions !== undefined ||
		projectRevision !== null;
	const snapshot = {
		schemaVersion: versioned
			? CURRENT_SCHEMA_VERSION
			: HISTORICAL_SCHEMA_VERSION,
		runId,
		state: "created",
		cleanupState: "not_started",
		createdAt: now,
		updatedAt: now,
		revision: 1,
		tasksFilePath,
		projectPath,
		orderedTaskIds,
		initialHostFingerprint,
		workerPid: null,
		workerStartToken: null,
		workerNonce,
		activeTaskId: null,
		activeTaskProvider: null,
		activeTaskModel: null,
		activeTaskDeadline: null,
		activeTaskElapsedMs: null,
		activeTaskHeartbeatAt: null,
		activeTaskProcessPhase: null,
		snapshotStatus: null,
		snapshotMtime: null,
		snapshotAgeMsAtRoute: null,
		resolvedTargetId: null,
		lastResolvedTargetId: null,
		activeTaskInvocationDescriptor: null,
		activeTaskDescriptorIdentity: null,
		activeTaskDescriptorHarness: null,
		lastTaskInvocationDescriptor: null,
		lastTaskDescriptorIdentity: null,
		lastTaskDescriptorHarness: null,
		dispatchContractVersion: 1,
		quarantinedTargetIds: [],
		retryState: null,
		retryTransitionId: 0,
		terminalSummary: null,
		cleanupError: null,
		lastLeaseHeartbeat: now,
		lastEventSequence: 0,
		lastFailure: null,
		launchArgs,
	};
	if (versioned) {
		snapshot.projectRevision = projectRevision ?? "unknown";
		snapshot.runOptions = runOptions ?? null;
		snapshot.queueIdentity = queueIdentity;
	}

	await writeRunAtomically(runJsonPath, snapshot);
	return snapshot;
}

/**
 * Read and validate the run.json for a given runId.
 *
 * @param {string} runId
 * @returns {Promise<object>} parsed and validated run snapshot
 */
export async function readRun(runId) {
	validateRunId(runId);
	const runJsonPath = resolve(getRunRoot(runId), "run.json");
	let raw;
	try {
		raw = await readFile(runJsonPath, "utf8");
	} catch (e) {
		if (e.code === "ENOENT") {
			// Tag the not-found signal with ENOENT so callers can tell a
			// transient missing run.json apart from corruption (see
			// applyRetention's conservative skip in its quarantine loop).
			const notFound = new Error(`Run not found: ${runId}`);
			notFound.code = "ENOENT";
			throw notFound;
		}
		throw e;
	}

	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		// Never interpolate JSON.parse's own message or the raw file content —
		// both can echo fragments of whatever malformed bytes were on disk.
		throw new SchemaError("run.json contains invalid JSON");
	}

	if (data === null || typeof data !== "object") {
		throw new SchemaError("run.json is not a valid object");
	}

	validateRun(data);
	return data;
}

// Per-runId queue serializing updateRun's read-check-write section. Without
// this, concurrent callers (e.g. worker-bootstrap's fire-and-forget event
// callbacks racing its own terminal write) can all read the same on-disk
// revision, all pass the optimistic-concurrency check, and last-rename-wins
// silently clobbers an earlier write with no error thrown.
const updateQueues = new Map();

/**
 * Atomically update a run snapshot with a revision check.
 * Merges `partial` into the current snapshot, increments revision,
 * sets updatedAt, and writes atomically.
 *
 * Throws RevisionError if expectedRevision does not match the current revision.
 *
 * @param {string} runId
 * @param {object} partial - key-value updates to merge
 * @param {number} expectedRevision
 * @returns {Promise<object>} updated run snapshot
 */
export async function updateRun(runId, partial, expectedRevision) {
	validateRunId(runId);
	const previous = updateQueues.get(runId) ?? Promise.resolve();
	const settledPrevious = previous.catch(() => {});
	const result = settledPrevious.then(() =>
		performUpdate(runId, partial, expectedRevision),
	);
	updateQueues.set(runId, result);
	return result;
}

async function performUpdate(runId, partial, expectedRevision) {
	const current = await readRun(runId);

	if (current.revision !== expectedRevision) {
		throw new RevisionError(
			`Revision mismatch for ${runId}: expected ${expectedRevision}, got ${current.revision}`,
		);
	}

	const merged = {
		...current,
		...partial,
		runId: current.runId,
		schemaVersion: current.schemaVersion,
		createdAt: current.createdAt,
		updatedAt: new Date().toISOString(),
		revision: current.revision + 1,
	};

	validateRun(merged);

	const runJsonPath = resolve(getRunRoot(runId), "run.json");
	await writeRunAtomically(runJsonPath, merged);
	return merged;
}

/**
 * Update a run, retrying against the freshest on-disk revision when a
 * concurrent writer wins the race. Use this for an authoritative write (e.g.
 * a worker's terminal state) that must not be discarded just because a
 * lower-priority in-flight update (a fire-and-forget event callback) reached
 * the per-runId update queue first.
 *
 * @param {string} runId
 * @param {object} partial - key-value updates to merge
 * @param {number} [maxAttempts=10]
 * @returns {Promise<object>} updated run snapshot
 */
export async function updateRunWithRetry(runId, partial, maxAttempts = 10) {
	for (let attempt = 0; ; attempt++) {
		const current = await readRun(runId);
		try {
			return await updateRun(runId, partial, current.revision);
		} catch (error) {
			if (!(error instanceof RevisionError) || attempt >= maxAttempts - 1) {
				throw error;
			}
		}
	}
}

/**
 * Convenience helper: advance the run state and update revision.
 *
 * @param {string} runId
 * @param {string} newState - one of the valid run states
 * @returns {Promise<object>} updated run snapshot
 */
export async function advanceState(runId, newState) {
	const current = await readRun(runId);
	return updateRun(runId, { state: newState }, current.revision);
}

/**
 * Append an event to the run's events.jsonl with a monotonically increasing
 * sequence number.
 *
 * @param {string} runId
 * @param {object} event
 * @param {string} event.phase
 * @param {string} event.event
 * @param {string} event.status
 * @returns {Promise<number>} the assigned sequence number
 */
export async function createEvent(runId, event) {
	validateRunId(runId);
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

	let current = await readRun(runId);
	const nextSeq = current.lastEventSequence + 1;
	const isFailureEvent =
		event?.event === "task_failed" || event?.event === "queue_halted";
	const suppliedFailure = isFailureEvent
		? {
				errorKind: event.errorKind,
				reasonCode: event.reasonCode,
				reason: event.reason,
				...(event.artifactRef !== undefined
					? { artifactRef: event.artifactRef }
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
					partialDiffPath: event.partialDiffPath,
				})
		: null;

	const entry = {
		schemaVersion: current.schemaVersion,
		sequence: nextSeq,
		timestamp: new Date().toISOString(),
		phase: event.phase,
		event: event.event,
		status: event.status,
	};

	const extra = { ...event };
	delete extra.phase;
	delete extra.event;
	delete extra.status;
	delete extra.sequence;
	delete extra.timestamp;
	if (safeFailure) {
		delete extra.error;
		delete extra.output;
		delete extra.partialDiff;
		delete extra.partialDiffPath;
		delete extra.artifactRef;
		delete extra.reason;
		Object.assign(extra, safeFailure);
	}
	Object.assign(entry, extra);

	await appendFile(eventsPath, `${JSON.stringify(entry)}\n`, {
		mode: 0o600,
	});

	try {
		await updateRun(runId, { lastEventSequence: nextSeq }, current.revision);
	} catch (e) {
		if (!(e instanceof RevisionError)) throw e;
		current = await readRun(runId);
		if (current.lastEventSequence < nextSeq) {
			try {
				await updateRun(
					runId,
					{ lastEventSequence: nextSeq },
					current.revision,
				);
			} catch {
				// best effort; event is already persisted
			}
		}
	}

	return nextSeq;
}

/**
 * Acquire the run lease. Sets workerPid, workerStartToken, workerNonce,
 * and lastLeaseHeartbeat on the run snapshot.
 *
 * Fails if the run is already leased by a different identity.
 * With `allowRecovery: true`, will take over an expired lease from another
 * identity.
 *
 * @param {string} runId
 * @param {number} pid
 * @param {string} startToken
 * @param {string} nonce
 * @param {object} [options]
 * @param {boolean} [options.allowRecovery]
 * @param {number} [options.maxAgeMs]
 * @param {string} [options.now]
 * @returns {Promise<object>} updated run snapshot
 */
export async function acquireRunLock(
	runId,
	pid,
	startToken,
	nonce,
	options = {},
) {
	let current = await readRun(runId);

	if (current.workerPid !== null) {
		if (current.workerPid === pid && current.workerStartToken === startToken) {
			const updated = await updateRun(
				runId,
				{
					workerPid: pid,
					workerStartToken: startToken,
					workerNonce: nonce,
					lastLeaseHeartbeat: new Date().toISOString(),
				},
				current.revision,
			);
			return updated;
		}

		if (!options.allowRecovery) {
			throw new LockError(
				`Run ${runId} is already leased by pid ${current.workerPid}`,
			);
		}

		const expired = await isRunLockExpired(runId, {
			maxAgeMs: options.maxAgeMs ?? DEFAULT_LEASE_AGE_MS,
			now: options.now ?? new Date().toISOString(),
		});

		if (!expired) {
			throw new LockError(
				`Run ${runId} is already leased by pid ${current.workerPid} and lease has not expired`,
			);
		}

		current = await readRun(runId);
	}

	const updated = await updateRun(
		runId,
		{
			workerPid: pid,
			workerStartToken: startToken,
			workerNonce: nonce,
			lastLeaseHeartbeat: new Date().toISOString(),
		},
		current.revision,
	);
	return updated;
}

/**
 * Release the run lease. Clears workerPid, workerStartToken, and workerNonce.
 *
 * @param {string} runId
 * @returns {Promise<object>} updated run snapshot
 */
export async function releaseRunLock(runId) {
	const current = await readRun(runId);
	const updated = await updateRun(
		runId,
		{
			workerPid: null,
			workerStartToken: null,
			workerNonce: "",
			lastLeaseHeartbeat: new Date().toISOString(),
		},
		current.revision,
	);
	return updated;
}

/**
 * Renew the run lease heartbeat. Fails if the calling identity does not
 * match the current lease holder.
 *
 * @param {string} runId
 * @param {number} pid
 * @param {string} startToken
 * @returns {Promise<object>} updated run snapshot
 */
export async function renewRunLock(runId, pid, startToken) {
	const current = await readRun(runId);

	if (current.workerPid !== pid || current.workerStartToken !== startToken) {
		throw new LockError(
			`Cannot renew lock: identity mismatch for ${runId} (pid ${pid} vs ${current.workerPid})`,
		);
	}

	const updated = await updateRun(
		runId,
		{ lastLeaseHeartbeat: new Date().toISOString() },
		current.revision,
	);
	return updated;
}

/**
 * Check whether the run lease has expired based on maxAgeMs.
 *
 * @param {string} runId
 * @param {object} options
 * @param {number} [options.maxAgeMs=60000] - max age in milliseconds
 * @param {string} [options.now] - reference ISO timestamp (default: now)
 * @returns {Promise<boolean>}
 */
export async function isRunLockExpired(runId, options = {}) {
	const current = await readRun(runId);

	if (current.workerPid === null) return true;

	const maxAgeMs = options.maxAgeMs ?? DEFAULT_LEASE_AGE_MS;
	const reference = options.now ? new Date(options.now).getTime() : Date.now();
	const heartbeat = new Date(current.lastLeaseHeartbeat).getTime();

	return reference - heartbeat > maxAgeMs;
}

/**
 * Acquire an exclusive launch lock keyed by the canonical tasks file path.
 * Fails if a launch lock for the same path is already held.
 *
 * @param {string} canonicalTasksPath
 * @param {string} runId
 * @returns {Promise<void>}
 */
export async function acquireLaunchLock(canonicalTasksPath, runId) {
	await ensureDir(locksRoot(), 0o700);
	const lockPath = lockFilePath(canonicalTasksPath);
	const content = JSON.stringify({
		runId,
		createdAt: new Date().toISOString(),
	});
	try {
		await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
	} catch (e) {
		if (e.code === "EEXIST") {
			let holder = "unknown";
			try {
				const raw = await readFile(lockPath, "utf8");
				holder = JSON.parse(raw).runId;
			} catch {
				// ignore
			}
			throw new LockError(
				`Launch lock already held for ${canonicalTasksPath} by ${holder}`,
			);
		}
		throw e;
	}
}

/**
 * Release the launch lock for the given canonical tasks file path.
 *
 * @param {string} canonicalTasksPath
 * @returns {Promise<void>}
 */
export async function releaseLaunchLock(canonicalTasksPath) {
	const lockPath = lockFilePath(canonicalTasksPath);
	try {
		await unlink(lockPath);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
}

/**
 * Acquire an exclusive project lock keyed by the canonical project path.
 * Prevents two Switchyard runs against the same project simultaneously.
 *
 * @param {string} canonicalProjectPath
 * @param {string} runId
 * @returns {Promise<void>}
 */
export async function acquireProjectLock(canonicalProjectPath, runId) {
	await ensureDir(locksRoot(), 0o700);
	const lockPath = lockFilePath(`project:${canonicalProjectPath}`);
	const content = JSON.stringify({
		runId,
		createdAt: new Date().toISOString(),
		projectPath: canonicalProjectPath,
	});
	try {
		await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
	} catch (e) {
		if (e.code === "EEXIST") {
			let holder = "unknown";
			try {
				const raw = await readFile(lockPath, "utf8");
				holder = JSON.parse(raw).runId;
			} catch {
				// ignore
			}
			throw new LockError(
				`Project lock already held for ${canonicalProjectPath} by ${holder}`,
			);
		}
		throw e;
	}
}

/**
 * Release the project lock for the given canonical project path.
 *
 * @param {string} canonicalProjectPath
 * @returns {Promise<void>}
 */
export async function releaseProjectLock(canonicalProjectPath) {
	const lockPath = lockFilePath(`project:${canonicalProjectPath}`);
	try {
		await unlink(lockPath);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
}

/**
 * Release the project lock only if it is still held by the expected run.
 *
 * A blind `releaseProjectLock` by path is unsafe for stale-run cleanup: the
 * lock is keyed by project path only, so a lock legitimately re-acquired by
 * a newer run (after the stale run's own lock was already cleared) would be
 * silently deleted too, defeating the mutual exclusion the lock exists for.
 * This performs a read-then-compare-then-delete so a recovery sweep against
 * an old runId can never release a different, currently-active run's lock.
 *
 * @param {string} canonicalProjectPath
 * @param {string} expectedRunId
 * @returns {Promise<boolean>} true if the lock was held by expectedRunId and released
 */
export async function releaseProjectLockIfOwnedBy(
	canonicalProjectPath,
	expectedRunId,
) {
	const lockPath = lockFilePath(`project:${canonicalProjectPath}`);
	let holder;
	try {
		const raw = await readFile(lockPath, "utf8");
		holder = JSON.parse(raw).runId;
	} catch (e) {
		if (e.code === "ENOENT") return false;
		throw e;
	}
	if (holder !== expectedRunId) return false;
	await releaseProjectLock(canonicalProjectPath);
	return true;
}

/**
 * Check whether a project lock is currently held for the given path.
 *
 * @param {string} canonicalProjectPath
 * @returns {boolean}
 */
export function isProjectLockHeld(canonicalProjectPath) {
	const lockPath = lockFilePath(`project:${canonicalProjectPath}`);
	return existsSync(lockPath);
}

const VM_SLOT_COUNT = 2;

function safeVmRunId(value) {
	if (typeof value !== "string" || value.length === 0) return "unknown";
	const safe = sanitizeForDisplay(value).slice(0, 128);
	return safe || "unknown";
}

function vmSlotBody(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const ownerPid = raw.ownerPid ?? raw.pid;
	if (
		!Number.isInteger(ownerPid) ||
		ownerPid <= 0 ||
		typeof raw.runId !== "string" ||
		raw.runId.length === 0 ||
		typeof raw.token !== "string" ||
		raw.token.length === 0
	) {
		return null;
	}
	return { ownerPid, runId: raw.runId, token: raw.token };
}

function readVmSlotBody(slotPath) {
	try {
		return vmSlotBody(JSON.parse(readFileSync(slotPath, "utf8")));
	} catch {
		return null;
	}
}

function removeVmTempFile(tmpPath) {
	try {
		unlinkSync(tmpPath);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

function vmOwnerIsLive(ownerPid) {
	try {
		process.kill(ownerPid, 0);
		return true;
	} catch (error) {
		// Only ESRCH proves that the owner is gone. EPERM, EINVAL, and all
		// other probe failures are conservatively treated as live/unknown.
		return error.code !== "ESRCH";
	}
}

function publishVmSlot(slotPath, body) {
	const tmpPath = `${slotPath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(body), { mode: 0o600 });
	try {
		linkSync(tmpPath, slotPath);
		return true;
	} catch (error) {
		if (error.code === "EEXIST") return false;
		throw error;
	} finally {
		removeVmTempFile(tmpPath);
	}
}

function vmSlotIndex(value) {
	if (Number.isInteger(value) && value >= 0 && value < VM_SLOT_COUNT) {
		return value;
	}
	if (typeof value !== "string") return null;
	for (let index = 0; index < VM_SLOT_COUNT; index += 1) {
		if (value === vmSlotPath(index)) return index;
	}
	return null;
}

/**
 * Acquire one of the two global VM admission slots synchronously.
 *
 * A complete unique temporary file is hard-linked into the fixed slot path;
 * the hard link is the cross-process exclusion operation. Dead owners are
 * reclaimed by atomically renaming the stale slot away before retrying.
 *
 * @param {object} [options]
 * @param {string} [options.runId] identifying the queue holding the slot
 * @returns {{slot: number, slotIndex: number, path: string, ownerPid: number, runId: string, token: string, release: () => boolean}}
 */
export function acquireVmSlot(options = {}) {
	const normalized = typeof options === "string" ? { runId: options } : options;
	const runId =
		typeof normalized?.runId === "string" && normalized.runId.length > 0
			? normalized.runId
			: `pid-${process.pid}-${randomUUID()}`;
	const token =
		typeof normalized?.token === "string" && normalized.token.length > 0
			? normalized.token
			: randomUUID();
	const body = {
		ownerPid: process.pid,
		pid: process.pid,
		runId,
		token,
		createdAt: new Date().toISOString(),
	};

	mkdirSync(resolveVmAdmissionRoot(), { recursive: true, mode: 0o700 });
	const holders = [];

	for (let slotIndex = 0; slotIndex < VM_SLOT_COUNT; slotIndex += 1) {
		const slotPath = vmSlotPath(slotIndex);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (publishVmSlot(slotPath, body)) {
				const lease = {
					slot: slotIndex,
					slotIndex,
					path: slotPath,
					ownerPid: process.pid,
					runId,
					token,
				};
				lease.release = () => releaseVmSlot(lease);
				return lease;
			}

			const owner = readVmSlotBody(slotPath);
			if (owner && !vmOwnerIsLive(owner.ownerPid)) {
				const reclaimPath = `${slotPath}.${process.pid}.${randomUUID()}.reclaim`;
				try {
					renameSync(slotPath, reclaimPath);
				} catch (error) {
					if (error.code === "ENOENT") continue;
					throw error;
				}
				try {
					unlinkSync(reclaimPath);
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
				continue;
			}

			holders.push(owner ? safeVmRunId(owner.runId) : "unknown");
			break;
		}
	}

	throw new VmSlotUnavailableError([...new Set(holders)]);
}

/**
 * Release a VM slot only when its token (and supplied identity) still match.
 * Missing or already-released slots are harmless, making this idempotent.
 *
 * @param {object|number|string} leaseOrSlot lease returned by acquireVmSlot, or slot index/path
 * @param {string} [token]
 * @param {string} [runId]
 * @returns {boolean} whether this call removed its slot file
 */
export function releaseVmSlot(leaseOrSlot, token, runId) {
	const lease =
		leaseOrSlot && typeof leaseOrSlot === "object"
			? leaseOrSlot
			: { slot: leaseOrSlot, token, runId };
	const slotIndex = vmSlotIndex(lease.slotIndex ?? lease.slot ?? lease.path);
	const expectedToken = lease.token ?? token;
	if (slotIndex === null || typeof expectedToken !== "string") return false;

	const slotPath = vmSlotPath(slotIndex);
	const owner = readVmSlotBody(slotPath);
	if (!owner || owner.token !== expectedToken) return false;
	if (lease.runId !== undefined && owner.runId !== lease.runId) return false;
	if (lease.ownerPid !== undefined && owner.ownerPid !== lease.ownerPid) {
		return false;
	}

	try {
		unlinkSync(slotPath);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

// Existing VM gate callers use this spelling while the runner integration is
// still being assembled. Keep it as the same synchronous primitive.
export const acquireMacosVmSlot = acquireVmSlot;
export const releaseMacosVmSlot = releaseVmSlot;

/**
 * Best-effort liveness probe for a run's worker process.
 *
 * Not exported: this mirrors dispatch/index.mjs's private isWorkerLive
 * exactly (signal-0 kill(2) probe: ESRCH => dead, EPERM => alive-but-
 * foreign). That copy predates this one and dispatch has not been rewired
 * to import from here, so the two definitions currently coexist as
 * module-private code in their respective files. If dispatch/index.mjs is
 * ever updated to import this instead of keeping its own copy, export this
 * function at that point. Until then, any change to the liveness rule must
 * be mirrored in dispatch/index.mjs by hand.
 *
 * @param {object} run parsed run snapshot
 * @returns {boolean} true only if a signalable worker pid still exists
 */
function isWorkerLive(run) {
	if (run.workerPid == null) return false;
	try {
		// Signal 0 performs error checking without delivering a signal.
		process.kill(run.workerPid, 0);
		return true;
	} catch (e) {
		// ESRCH => no such process; EPERM => process exists but is not ours.
		return e.code === "EPERM";
	}
}

/**
 * Determine whether a run is stale/reclaimable for lock-recovery purposes:
 * its worker is provably gone (terminal state, or a non-terminal state with
 * no live worker process left).
 *
 * Factored out so this module has exactly one definition of "stale" —
 * releaseOrphanedProjectLocks below is the only current caller, but the
 * point is to avoid a second inline copy of dispatch/index.mjs's
 * `terminal || !isWorkerLive(run)` check appearing anywhere in this file.
 *
 * NOTE: container recovery (dispatch/index.mjs's resolveIsRunDead) deliberately
 * does NOT use this predicate — it gates the `!isWorkerLive` half behind
 * `isRunLockExpired` as well, so a run still inside its pre-lock startup window
 * (workerPid null but lease fresh) is not mistaken for dead and its container
 * reaped out from under a launching dispatch.
 *
 * @param {object} run parsed run snapshot
 * @returns {boolean}
 */
function isRunStale(run) {
	const terminal = run.state === "succeeded" || run.state === "failed";
	return terminal || !isWorkerLive(run);
}

/**
 * Scan locksRoot() on disk and reclaim orphaned project locks.
 *
 * releaseStaleProjectLocks (dispatch/index.mjs) walks *known* candidate run
 * ids inward to their locks. This scan walks the other direction: it starts
 * from every lock file actually on disk, so a project lock left behind by a
 * run that never made it into that candidate list (e.g. its container was
 * already reaped before recovery ran) still gets reconciled. It relies on
 * the projectPath F.1 added to every newly-acquired project lock body, so a
 * lock's owning project never has to be looked up via the run itself.
 *
 * Scope is intentionally conservative (David's CR-4/CR-5 decision):
 *  - A lock file whose body is not valid JSON is left untouched, regardless
 *    of age. A corrupt lock body is not this scan's business to repair,
 *    delete, or recover.
 *  - A lock file with a valid JSON body but no `projectPath` is a launch
 *    lock (predates F.1's schema addition). It is left untouched —
 *    permanently, by design, not a migration gap to close later. There is
 *    no safe way to derive a projectPath for a lock that never recorded
 *    one, so do not "fix" this case.
 *  - A lock file with a valid JSON body and a `projectPath`, but whose
 *    runId no longer resolves to any run.json at all (pruned, or never
 *    written), is ALSO left untouched. A missing run record is a strictly
 *    weaker signal than "the run exists and is provably dead" — the scan
 *    can observe the record is gone, but cannot prove the lock's original
 *    holder is actually dead versus e.g. mid-retention-sweep. Per CR-4/CR-5
 *    this ambiguity resolves to "cannot identify, leave alone," the same
 *    posture as the missing-projectPath case above. This is intentionally
 *    deferred to F.3's human-confirmed manual remediation, not a gap for
 *    this scan to close.
 *  - Only a lock that is parseable AND has a projectPath AND whose run.json
 *    exists AND is stale per the shared liveness check is reclaimed.
 *
 * Reclaiming is ownership-checked (releaseProjectLockIfOwnedBy), never a
 * blind unlink by path, so a lock already superseded by a newer,
 * currently-active run against the same project is never pulled out from
 * under it.
 *
 * @returns {Promise<string[]>} runIds whose project lock was reclaimed
 */
export async function releaseOrphanedProjectLocks() {
	let entries;
	try {
		entries = await readdir(locksRoot(), { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}

	const reclaimed = [];

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;

		const lockPath = resolve(locksRoot(), entry.name);
		let body;
		try {
			const raw = await readFile(lockPath, "utf8");
			body = JSON.parse(raw);
		} catch {
			// Unparseable body: never touched, regardless of age. See the
			// scope note in this function's doc comment.
			continue;
		}

		if (
			body === null ||
			typeof body !== "object" ||
			typeof body.projectPath !== "string"
		) {
			// Parseable but no projectPath: a launch lock. Left untouched
			// permanently — see the scope note in this function's doc comment.
			continue;
		}

		let run;
		try {
			run = await readRun(body.runId);
		} catch {
			// The run no longer exists at all: a strictly weaker signal than
			// a resolvable-but-dead run, so this cannot be proven stale.
			// "Cannot identify, leave alone" per CR-4/CR-5 — see the doc
			// comment above. Deferred to F.3's manual remediation.
			continue;
		}

		if (!isRunStale(run)) continue;

		try {
			const didRelease = await releaseProjectLockIfOwnedBy(
				body.projectPath,
				body.runId,
			);
			if (didRelease) reclaimed.push(body.runId);
		} catch {
			// Best-effort; leave the lock for a future scan rather than throw
			// and abandon the rest of the sweep.
		}
	}

	return reclaimed;
}

// Move a malformed run directory out of the active scan and under
// quarantineRoot(), preserving its artifacts on disk. The first-choice
// destination is exactly `.quarantine/<name>`; when that path already exists
// it is NEVER overwritten or replaced — a unique suffixed destination is
// allocated instead, so both the pre-existing quarantine artifact and the
// newly moved run survive. `mkdir` reserves the destination name first, so
// the empty placeholder replaced by a successful rename is always one this
// function created itself, never a pre-existing artifact.
async function quarantineDirectory(name) {
	await ensureDir(quarantineRoot(), 0o700);
	const baseDestination = resolve(quarantineRoot(), name);
	let destination = baseDestination;
	try {
		await mkdir(baseDestination);
	} catch (e) {
		if (e.code !== "EEXIST") throw e;
		destination = resolve(
			quarantineRoot(),
			`${name}-collision-${randomUUID()}`,
		);
		await mkdir(destination);
	}
	try {
		await rename(getRunRoot(name), destination);
		return destination;
	} catch (e) {
		// Only remove the empty placeholder reserved above. rmdir removes a
		// directory only when it is empty, so a pre-existing or non-empty
		// quarantine artifact can never be deleted — unlike
		// rm({recursive:false}), which throws EISDIR on a directory and would
		// leave the placeholder behind.
		await rmdir(destination).catch(() => {});
		throw e;
	}
}

/**
 * Apply retention policy to completed runs.
 * Deletes runs where state is "succeeded" AND cleanupState is "complete".
 * Never touches non-terminal or cleanup-failed runs.
 *
 * Malformed run directories (invalid JSON, unsupported schema, corrupt
 * runId, etc.) fail readRun on every single scan forever — they never age
 * out via the normal succeeded+complete retention path below, since they
 * can't even be classified. Quarantine moves them out of the active scan
 * atomically (a rename, never a delete) on every sweep, dryRun or not, so
 * they stop being re-read while staying inspectable on disk. The
 * conservative exception: a run directory whose read fails for any
 * non-validation reason — run.json absent (readRun's ENOENT signal, e.g. a
 * concurrent initializeRun mid-flight), EACCES, EIO, EMFILE, or any other
 * filesystem/IO error — is left in place and skipped, not quarantined.
 * None of those signals proves corruption, and a later sweep may or may not
 * resolve them: a transiently-missing run.json likely will, while a
 * persistent I/O error is simply re-skipped on every sweep (see the
 * quarantine loop below).
 *
 * @param {object} options
 * @param {number} [options.maxRuns] - maximum number of completed runs to keep
 * @param {number} [options.maxAgeDays] - maximum age in days for completed runs
 * @param {string} [options.now] - reference ISO timestamp (default: now)
 * @param {boolean} [options.dryRun] - log-only mode for DELETION: report which
 *   eligible valid runs WOULD be reclaimed (on stderr, with the reason)
 *   without calling `rm`. Malformed-run quarantine is NOT suppressed —
 *   malformed directories are still moved, since they would otherwise fail
 *   this same scan forever.
 * @returns {Promise<{deletedCount: number, quarantined: Array<{runId: string, destination: string, destinationDisplay: string, reason: string}>}>}
 *   deletedCount: number of eligible runs deleted (or eligible, in dryRun);
 *   quarantined: one entry per malformed run directory moved out of the
 *   active scan, with its sanitized runId, the actual on-disk destination it
 *   was moved to (raw, for machine use), a separately sanitized
 *   destinationDisplay safe for logs/terminal, and a static reason string.
 */
export async function applyRetention(options = {}) {
	const { maxRuns, maxAgeDays, now, dryRun } = options;
	const referenceTime = now ? new Date(now).getTime() : Date.now();

	let entries;
	try {
		entries = await readdir(runsRoot(), { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return { deletedCount: 0, quarantined: [] };
		throw e;
	}

	const quarantined = [];
	const eligible = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let run;
		try {
			run = await readRun(entry.name);
		} catch (e) {
			if (!(e instanceof SchemaError)) {
				// Conservative choice: a run directory that fails to read is
				// NOT quarantined unless the failure is a positive content-
				// validation error. ENOENT (run.json absent — e.g. a
				// concurrent initializeRun mid-flight), EACCES, EIO, EMFILE,
				// and any other filesystem/IO error are indistinguishable
				// from transient or externally-caused failures on this
				// signal, so moving the directory out from under a live
				// writer would be worse than re-scanning it. Leave it in
				// place and skip it. A later sweep may find it readable
				// again, but that is not guaranteed — a persistent I/O error
				// is simply re-skipped each sweep. Only present-but-invalid
				// content (invalid JSON, non-object JSON, SchemaError
				// validation failures) is worth quarantining.
				continue;
			}
			// Reason text is always one of a small set of static strings
			// (SchemaError's own message, which by construction never
			// interpolates file content — see readRun/validateRun); raw
			// error or file content never appears.
			const reason = e.message;
			try {
				const destination = await quarantineDirectory(entry.name);
				quarantined.push({
					runId: sanitizeForDisplay(entry.name),
					// Raw on-disk path for machine use; destinationDisplay is
					// the separately sanitized value safe for logs/terminal.
					destination,
					destinationDisplay: sanitizeForDisplay(destination),
					reason,
				});
			} catch (moveError) {
				// ENOENT here means the source run directory is already gone —
				// a concurrent or repeated sweep moved it first — which is the
				// expected outcome, not a failure worth warning about.
				if (moveError.code === "ENOENT") continue;
				console.warn(
					`applyRetention: failed to quarantine run ${sanitizeForDisplay(entry.name)}: ${sanitizeForDisplay(moveError.message)}`,
				);
			}
			continue;
		}
		if (run.state === "succeeded" && run.cleanupState === "complete") {
			eligible.push({
				runId: entry.name,
				createdAt: new Date(run.createdAt).getTime(),
			});
		}
	}

	eligible.sort((a, b) => a.createdAt - b.createdAt);

	const deleted = new Set();

	if (maxAgeDays != null && Number.isFinite(maxAgeDays)) {
		const cutoff = referenceTime - maxAgeDays * 86_400_000;
		for (const r of eligible) {
			if (r.createdAt < cutoff) {
				if (dryRun) {
					console.error(
						`applyRetention: would delete run ${r.runId} (older than maxAgeDays cutoff)`,
					);
					deleted.add(r.runId);
					continue;
				}
				try {
					await rm(getRunRoot(r.runId), { recursive: true, force: true });
					deleted.add(r.runId);
				} catch (e) {
					console.warn(`Failed to delete run ${r.runId}: ${e.message}`);
				}
			}
		}
	}

	const remaining = eligible.filter((r) => !deleted.has(r.runId));

	if (
		maxRuns != null &&
		Number.isFinite(maxRuns) &&
		remaining.length > maxRuns
	) {
		const toDelete = remaining.slice(0, remaining.length - maxRuns);
		for (const r of toDelete) {
			if (dryRun) {
				console.error(
					`applyRetention: would delete run ${r.runId} (maxRuns trim)`,
				);
				deleted.add(r.runId);
				continue;
			}
			try {
				await rm(getRunRoot(r.runId), { recursive: true, force: true });
				deleted.add(r.runId);
			} catch (e) {
				console.warn(`Failed to delete run ${r.runId}: ${e.message}`);
			}
		}
	}

	return { deletedCount: deleted.size, quarantined };
}

/**
 * Read all events for a run from events.jsonl.
 *
 * @param {string} runId
 * @returns {Promise<object[]>} parsed event entries, or empty array if no events
 */
export async function readEvents(runId) {
	validateRunId(runId);
	const eventsPath = resolve(getRunRoot(runId), "events.jsonl");
	try {
		const raw = await readFile(eventsPath, "utf8");
		return raw
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

export { LockError, RevisionError, SchemaError, VmSlotUnavailableError };
