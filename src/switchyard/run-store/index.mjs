import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	appendFile,
	link,
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
import { basename, resolve } from "node:path";
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
import { classifyRunLiveness } from "./run-liveness.mjs";

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

const SUCCESS_RESULTS = new Set(["success", "success_no_diff"]);

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
	"diagnosticCode",
	"exitCode",
	"signal",
	"failurePhase",
	// Closed vocabulary owned by the execution backend (CLEANUP_STAGES in
	// adapter/exec-error.mjs), never interpolated from provider output.
	"cleanupStage",
]);

export function isSafeTargetId(value) {
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

const LOCK_ERROR_CODES = new Set([
	"LOCK_ERROR",
	"RUN_LOCK_HELD",
	"RUN_LOCK_IDENTITY_MISMATCH",
	"LAUNCH_LOCK_HELD",
	"PROJECT_LOCK_HELD",
	"PROJECT_LOCK_RECOVERY_IN_PROGRESS",
	"PROJECT_LOCK_OWNERSHIP_FAILED",
	"PROJECT_LOCK_OWNERSHIP_DISPLACED",
	"PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
	"PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
	"VM_SLOT_UNAVAILABLE",
]);

class LockError extends Error {
	constructor(message, { code = "LOCK_ERROR", holderRunId = null } = {}) {
		super(message);
		this.name = "LockError";
		if (!LOCK_ERROR_CODES.has(code)) {
			throw new TypeError("LockError requires a closed code");
		}
		this.code = code;
		try {
			validateRunId(holderRunId);
			this.holderRunId = holderRunId;
		} catch {
			this.holderRunId = null;
		}
	}
}

class VmSlotUnavailableError extends LockError {
	constructor(holderRuns) {
		const holders = holderRuns.length > 0 ? holderRuns.join(", ") : "unknown";
		super(
			`VM_SLOT_UNAVAILABLE: VM admission capacity is unavailable (held by run ${holders})`,
			{ code: "VM_SLOT_UNAVAILABLE" },
		);
		this.name = "VmSlotUnavailableError";
	}
}

/** A closed boundary for host filesystem failures during VM admission. */
class VmAdmissionUnavailableError extends Error {
	constructor(cause) {
		super("VM admission storage is unavailable", { cause });
		this.name = "VmAdmissionUnavailableError";
		this.code = "VM_ADMISSION_UNAVAILABLE";
	}
}

/** A closed boundary for a host permission or sandbox denial during VM admission. */
class VmAdmissionPermissionDeniedError extends Error {
	constructor(cause) {
		super("VM admission storage permission is denied", { cause });
		this.name = "VmAdmissionPermissionDeniedError";
		this.code = "VM_ADMISSION_PERMISSION_DENIED";
	}
}

/** A closed boundary for host storage or I/O failures during VM admission. */
class VmAdmissionStorageError extends Error {
	constructor(cause) {
		super("VM admission storage I/O failed", { cause });
		this.name = "VmAdmissionStorageError";
		this.code = "VM_ADMISSION_STORAGE_FAILED";
	}
}

const VM_ADMISSION_PERMISSION_CODES = new Set(["EACCES", "EPERM"]);
const VM_ADMISSION_STORAGE_CODES = new Set([
	"EIO",
	"ENOSPC",
	"EDQUOT",
	"EMFILE",
	"ENFILE",
	"EROFS",
]);

export function sanitizeVmAdmissionError(cause) {
	if (
		cause instanceof VmAdmissionUnavailableError ||
		cause instanceof VmAdmissionPermissionDeniedError ||
		cause instanceof VmAdmissionStorageError
	) {
		return cause;
	}
	if (VM_ADMISSION_PERMISSION_CODES.has(cause?.code)) {
		return new VmAdmissionPermissionDeniedError(cause);
	}
	if (VM_ADMISSION_STORAGE_CODES.has(cause?.code)) {
		return new VmAdmissionStorageError(cause);
	}
	return new VmAdmissionUnavailableError(cause);
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

function resolveCanonicalProjectPath(projectPath) {
	return resolve(projectPath);
}

function projectLockFileName(projectPath) {
	// Keep the namespace as data for the hash, rather than handing a
	// namespace-prefixed string to path.resolve(). The latter made the lock
	// identity depend on this process's cwd.
	const identity = `project:${resolveCanonicalProjectPath(projectPath)}`;
	return `${createHash("sha256").update(identity).digest("hex")}.lock`;
}

function projectLockPath(canonicalProjectPath) {
	return resolve(locksRoot(), projectLockFileName(canonicalProjectPath));
}

function projectLockClaimPath(canonicalProjectPath) {
	return `${projectLockPath(canonicalProjectPath)}.recovery-claim`;
}

function parseProjectLockBody(raw, canonicalProjectPath = null) {
	try {
		const body = JSON.parse(raw);
		if (
			body === null ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			typeof body.runId !== "string" ||
			body.runId.length === 0 ||
			typeof body.projectPath !== "string" ||
			body.projectPath.length === 0 ||
			(canonicalProjectPath !== null &&
				resolveCanonicalProjectPath(body.projectPath) !==
					resolveCanonicalProjectPath(canonicalProjectPath))
		) {
			return null;
		}
		return body;
	} catch {
		return null;
	}
}

function parseOwnedProjectLockBody(raw, canonicalProjectPath) {
	const body = parseProjectLockBody(raw, canonicalProjectPath);
	if (body) return body;
	// Pre-F.1 project locks did not persist projectPath. The canonical hashed
	// path still identifies the project, so an exact runId remains sufficient
	// for ownership checks and release compatibility.
	return parseLegacyProjectLockBody(raw);
}

function parseLegacyProjectLockBody(raw) {
	try {
		const legacyBody = JSON.parse(raw);
		if (
			legacyBody !== null &&
			typeof legacyBody === "object" &&
			!Array.isArray(legacyBody) &&
			typeof legacyBody.runId === "string" &&
			legacyBody.runId.length > 0 &&
			!Object.hasOwn(legacyBody, "projectPath")
		) {
			return legacyBody;
		}
	} catch {
		// The strict parser already rejected malformed JSON.
	}
	return null;
}

async function readTextIfPresent(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

async function unlinkBodyMatched(path, expectedRaw, options = {}) {
	// Atomically take the directory entry before inspecting it. A read followed
	// by unlink(path) can delete a replacement created in between; renaming to a
	// unique recovery-claim path means only the inode actually taken can be
	// deleted. A mismatched inode is restored without clobbering, or retained as
	// discoverable recovery evidence if the original path is already occupied.
	const existingProof = recoveryProofMetadata(basename(path));
	const originalName = existingProof?.originalName ?? basename(path);
	const proofPath = resolve(
		locksRoot(),
		`${originalName}.${process.pid}.${randomUUID()}.lock.recovery-claim`,
	);
	try {
		await rename(path, proofPath);
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	if (typeof options.afterRename === "function") {
		await options.afterRename(proofPath);
	}
	const proofRaw = await readFile(proofPath, "utf8");
	if (proofRaw === expectedRaw) {
		await unlink(proofPath);
		return true;
	}
	await restoreClaimWithoutClobber(proofPath, path, proofRaw);
	return false;
}

const RECOVERY_PROOF_SUFFIX =
	/^([0-9a-f]{64}\.lock(?:\.recovery-claim)?)\.([1-9]\d*)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock\.recovery-claim$/;

function recoveryProofMetadata(name) {
	const match = RECOVERY_PROOF_SUFFIX.exec(name);
	if (!match) return null;
	const ownerPid = Number(match[2]);
	return Number.isSafeInteger(ownerPid)
		? { originalName: match[1], ownerPid }
		: null;
}

async function restoreClaimWithoutClobber(claimPath, lockPath, raw) {
	try {
		await link(claimPath, lockPath);
	} catch (error) {
		if (error.code === "EEXIST" || error.code === "ENOENT") return false;
		throw error;
	}
	const restoredRaw = await readTextIfPresent(lockPath);
	if (restoredRaw !== raw) return false;
	await unlinkBodyMatched(claimPath, raw);
	return true;
}

export const runStoreTesting = Object.freeze({
	acquireVmSlotWithDependencies,
	projectLockArtifacts,
	readVmSlotBody,
	unlinkBodyMatched,
});

async function moveProjectLockPathToClaim(
	lockPath,
	claimPath,
	canonicalProjectPath,
	expectedRaw,
) {
	// The reservation is recoverable evidence, not an opaque marker. Keep the
	// exact owner body so a crash before rename can only be reconciled against
	// the same bytes that were read before claiming the lock.
	if (!parseOwnedProjectLockBody(expectedRaw, canonicalProjectPath)) {
		return null;
	}
	const reservation = JSON.stringify({
		claimState: "reservation",
		expectedRaw,
	});
	try {
		await writeFile(claimPath, reservation, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (error.code === "EEXIST") return null;
		throw error;
	}

	try {
		const currentRaw = await readTextIfPresent(lockPath);
		if (currentRaw !== expectedRaw) {
			await unlinkBodyMatched(claimPath, reservation);
			return null;
		}
		try {
			await rename(lockPath, claimPath);
		} catch (error) {
			await unlinkBodyMatched(claimPath, reservation);
			if (error.code === "ENOENT") return null;
			throw error;
		}
		const claimedRaw = await readTextIfPresent(claimPath);
		if (claimedRaw === expectedRaw) return { claimPath, raw: claimedRaw };
		if (claimedRaw !== null) {
			await restoreClaimWithoutClobber(claimPath, lockPath, claimedRaw);
		}
		return null;
	} catch (error) {
		const claimRaw = await readTextIfPresent(claimPath).catch(() => null);
		if (claimRaw === reservation) {
			await unlinkBodyMatched(claimPath, reservation).catch(() => false);
		}
		throw error;
	}
}

function cwdDerivedProjectLockPath(canonicalProjectPath) {
	const historicalKeyPath = resolve(
		canonicalProjectPath,
		`project:${canonicalProjectPath}`,
	);
	return lockFilePath(historicalKeyPath);
}

function parseProjectLockArtifact(raw, projectPath, isOwnedPath) {
	return isOwnedPath
		? parseOwnedProjectLockBody(raw, projectPath)
		: parseProjectLockBody(raw, projectPath);
}

async function projectLockArtifacts(projectPath) {
	const canonicalPath = resolveCanonicalProjectPath(projectPath);
	const canonicalLockPath = projectLockPath(canonicalPath);
	const cwdDerivedLockPath = cwdDerivedProjectLockPath(canonicalPath);
	let entries;
	try {
		entries = await readdir(locksRoot(), { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const artifacts = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const isClaim = entry.name.endsWith(".lock.recovery-claim");
		if (!isClaim && !entry.name.endsWith(".lock")) continue;
		const path = resolve(locksRoot(), entry.name);
		const proof = recoveryProofMetadata(entry.name);
		const raw = await readTextIfPresent(path).catch(() => null);
		if (raw === null) continue;
		const originalPath = proof
			? resolve(locksRoot(), proof.originalName)
			: path;
		const lockPath = originalPath.endsWith(".lock.recovery-claim")
			? originalPath.slice(0, -".recovery-claim".length)
			: originalPath;
		const isOwnedPath =
			lockPath === canonicalLockPath || lockPath === cwdDerivedLockPath;
		if (!isClaim) {
			const body = parseProjectLockArtifact(raw, canonicalPath, isOwnedPath);
			if (body) artifacts.push({ body, kind: "lock", lockPath, path, raw });
			continue;
		}
		const reservation = parseRecoveryReservation(raw);
		if (reservation) {
			const body = parseProjectLockArtifact(
				reservation.expectedRaw,
				canonicalPath,
				isOwnedPath,
			);
			if (body) {
				artifacts.push({
					body,
					claimPath: path,
					kind: "reservation",
					lockPath,
					raw,
					reservation,
				});
			}
			continue;
		}
		const body = parseProjectLockArtifact(raw, canonicalPath, isOwnedPath);
		if (body) {
			artifacts.push({ body, claimPath: path, kind: "claim", lockPath, raw });
		}
	}
	return artifacts;
}

function parseRecoveryReservation(raw) {
	try {
		const body = JSON.parse(raw);
		if (
			body === null ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			body.claimState !== "reservation" ||
			typeof body.expectedRaw !== "string" ||
			Object.keys(body).some(
				(key) => !["claimState", "expectedRaw"].includes(key),
			)
		) {
			return null;
		}
		return body;
	} catch {
		return null;
	}
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
	if (
		data.terminalizedBy !== undefined &&
		data.terminalizedBy !== "worker" &&
		data.terminalizedBy !== "dead_worker_recovery"
	) {
		throw new SchemaError("terminalizedBy must be a known terminal writer");
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

	if (merged.state === "failed" && !merged.lastFailure) {
		merged.lastFailure = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "unclassified",
		});
	}

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
		event?.event === "task_failed" ||
		event?.event === "queue_halted" ||
		event?.event === "worker_boot_failed" ||
		event?.errorKind !== undefined ||
		(event?.result !== undefined && !SUCCESS_RESULTS.has(event.result));
	const suppliedFailure =
		isFailureEvent && event?.errorKind
			? {
					errorKind: event.errorKind,
					reasonCode: event.reasonCode,
					reason: event.reason,
					...(event.artifactRef !== undefined
						? { artifactRef: event.artifactRef }
						: {}),
					...(event.diagnosticCode !== undefined
						? { diagnosticCode: event.diagnosticCode }
						: {}),
					...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
					...(event.signal !== undefined ? { signal: event.signal } : {}),
					...(event.failurePhase !== undefined
						? { failurePhase: event.failurePhase }
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
					partialDiffPath: event.partialDiffPath,
					diagnosticCode: event.diagnosticCode,
					exitCode: event.exitCode,
					signal: event.signal,
					failurePhase: event.failurePhase,
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

	if (event && typeof event === "object") {
		for (const key of Object.keys(event)) {
			if (APPROVED_EVENT_KEYS.has(key)) {
				entry[key] = event[key];
			}
		}
	}
	// Admission wait telemetry is deliberately opt-in rather than a general
	// event field. This prevents arbitrary status payloads from widening the
	// durable event schema while retaining one content-free progress measure.
	if (
		event?.event === "vm_slot_wait" &&
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
		delete entry.artifactRef;
		delete entry.reason;
		delete entry.diagnosticCode;
		delete entry.exitCode;
		delete entry.signal;
		delete entry.failurePhase;
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

	await appendFile(eventsPath, `${JSON.stringify(entry)}\n`, {
		mode: 0o600,
	});

	try {
		await updateRun(
			runId,
			{
				lastEventSequence: nextSeq,
				...(safeFailure ? { lastFailure: safeFailure } : {}),
			},
			current.revision,
		);
	} catch (e) {
		if (!(e instanceof RevisionError)) throw e;
		current = await readRun(runId);
		if (current.lastEventSequence < nextSeq) {
			try {
				await updateRun(
					runId,
					{
						lastEventSequence: nextSeq,
						...(safeFailure ? { lastFailure: safeFailure } : {}),
					},
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
	if (
		(current.state === "launching" || current.state === "launcher_ready") &&
		typeof current.projectPath === "string"
	) {
		await assertProjectLockOwnership(current.projectPath, runId);
		current = await readRun(runId);
	}

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
				{ code: "RUN_LOCK_HELD", holderRunId: runId },
			);
		}

		const expired = await isRunLockExpired(runId, {
			maxAgeMs: options.maxAgeMs ?? DEFAULT_LEASE_AGE_MS,
			now: options.now ?? new Date().toISOString(),
		});

		if (!expired) {
			throw new LockError(
				`Run ${runId} is already leased by pid ${current.workerPid} and lease has not expired`,
				{ code: "RUN_LOCK_HELD", holderRunId: runId },
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
			{ code: "RUN_LOCK_IDENTITY_MISMATCH", holderRunId: runId },
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
				{ code: "LAUNCH_LOCK_HELD", holderRunId: holder },
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
	canonicalProjectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	await ensureDir(locksRoot(), 0o700);
	const lockPath = projectLockPath(canonicalProjectPath);
	const claimPath = projectLockClaimPath(canonicalProjectPath);
	const historicalLockPath = cwdDerivedProjectLockPath(canonicalProjectPath);
	const historicalClaimPath = `${historicalLockPath}.recovery-claim`;
	const content = JSON.stringify({
		runId,
		createdAt: new Date().toISOString(),
		projectPath: canonicalProjectPath,
		holderPid: process.pid,
	});
	if (
		existsSync(claimPath) ||
		existsSync(historicalLockPath) ||
		existsSync(historicalClaimPath) ||
		(await projectLockArtifacts(canonicalProjectPath)).some(
			(artifact) => artifact.kind !== "lock" || artifact.lockPath !== lockPath,
		)
	) {
		throw new LockError(
			`Project lock recovery is in progress for ${canonicalProjectPath}`,
			{ code: "PROJECT_LOCK_RECOVERY_IN_PROGRESS" },
		);
	}
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
				{ code: "PROJECT_LOCK_HELD", holderRunId: holder },
			);
		}
		throw e;
	}
	if (
		existsSync(claimPath) ||
		existsSync(historicalLockPath) ||
		existsSync(historicalClaimPath) ||
		(await projectLockArtifacts(canonicalProjectPath)).some(
			(artifact) => artifact.path !== lockPath,
		)
	) {
		await unlinkBodyMatched(lockPath, content);
		throw new LockError(
			`Project lock recovery is in progress for ${canonicalProjectPath}`,
			{ code: "PROJECT_LOCK_RECOVERY_IN_PROGRESS" },
		);
	}
}

/**
 * Release the project lock for the given canonical project path.
 *
 * @param {string} canonicalProjectPath
 * @param {string} expectedRunId
 * @returns {Promise<boolean>}
 */
export async function releaseProjectLock(canonicalProjectPath, expectedRunId) {
	if (typeof expectedRunId !== "string" || expectedRunId.length === 0) {
		return false;
	}
	return releaseProjectLockIfOwnedBy(canonicalProjectPath, expectedRunId);
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
 * @param {{onRemoved?: (path: string) => void}} [options]
 * @returns {Promise<boolean>} true if the lock was held by expectedRunId and released
 */
export async function releaseProjectLockIfOwnedBy(
	canonicalProjectPath,
	expectedRunId,
	options = {},
) {
	const projectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	let released = false;
	const recordRemoved = (path) => {
		released = true;
		options.onRemoved?.(path);
	};
	for (const artifact of await projectLockArtifacts(projectPath)) {
		if (artifact.body.runId !== expectedRunId) continue;
		if (artifact.kind === "claim") {
			if (await unlinkBodyMatched(artifact.claimPath, artifact.raw)) {
				recordRemoved(artifact.claimPath);
			}
			continue;
		}
		if (artifact.kind === "reservation") {
			const lockRaw = await readTextIfPresent(artifact.lockPath);
			if (lockRaw !== artifact.reservation.expectedRaw) continue;
			if (!(await unlinkBodyMatched(artifact.claimPath, artifact.raw)))
				continue;
			recordRemoved(artifact.claimPath);
		}
		const raw = await readTextIfPresent(artifact.lockPath);
		if (raw === null) continue;
		const body = parseProjectLockArtifact(
			raw,
			projectPath,
			artifact.lockPath === projectLockPath(projectPath) ||
				artifact.lockPath === cwdDerivedProjectLockPath(projectPath),
		);
		if (!body || body.runId !== expectedRunId) continue;
		const claimed = await moveProjectLockPathToClaim(
			artifact.lockPath,
			`${artifact.lockPath}.recovery-claim`,
			projectPath,
			raw,
		);
		if (claimed) {
			if (await unlinkBodyMatched(claimed.claimPath, claimed.raw)) {
				recordRemoved(artifact.lockPath);
			}
		}
	}
	return released;
}

/**
 * Release the historical cwd-derived project-lock filename used when a
 * dispatcher ran from the project root. The body must still bind the exact
 * project and run, and removal uses the same atomic claim protocol as the
 * canonical release path.
 *
 * @param {string} canonicalProjectPath
 * @param {string} expectedRunId
 * @param {{onRemoved?: (path: string) => void}} [options]
 * @returns {Promise<boolean>}
 */
export async function releaseCwdDerivedProjectLockIfOwnedBy(
	canonicalProjectPath,
	expectedRunId,
	options = {},
) {
	canonicalProjectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	const lockPath = cwdDerivedProjectLockPath(canonicalProjectPath);
	const raw = await readTextIfPresent(lockPath);
	if (raw === null) return false;
	const body = parseOwnedProjectLockBody(raw, canonicalProjectPath);
	if (!body || body.runId !== expectedRunId) return false;
	const claimPath = `${lockPath}.recovery-claim`;
	const claimed = await moveProjectLockPathToClaim(
		lockPath,
		claimPath,
		canonicalProjectPath,
		raw,
	);
	if (!claimed) return false;
	const released = await unlinkBodyMatched(claimed.claimPath, claimed.raw);
	if (released) options.onRemoved?.(lockPath);
	return released;
}

/**
 * Check whether the canonical project lock or an in-flight recovery claim is
 * still owned by the expected run. A lock held by another run is not evidence
 * that cleanup for the expected run failed.
 *
 * @param {string} canonicalProjectPath
 * @param {string} expectedRunId
 * @returns {Promise<boolean>}
 */
export async function isProjectLockOwnedBy(
	canonicalProjectPath,
	expectedRunId,
) {
	return (await projectLockArtifacts(canonicalProjectPath)).some(
		(artifact) => artifact.body.runId === expectedRunId,
	);
}

async function markClaimCleanupFailure(runId) {
	try {
		await updateRunWithRetry(runId, {
			state: "recovery_required",
			cleanupState: "failed",
		});
	} catch {
		// The caller still rejects execution; persistence failure stays bounded.
	}
}

/**
 * Reassert canonical project-lock ownership before queue/provider entry.
 *
 * @param {string} canonicalProjectPath
 * @param {string} runId
 * @returns {Promise<boolean>} true only while this run owns the canonical lock
 */
export async function assertProjectLockOwnership(
	canonicalProjectPath,
	runId,
	options = {},
) {
	const unlinkMatched = options.unlinkBodyMatched ?? unlinkBodyMatched;
	await reconcileProjectLockClaims();
	const projectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	const artifacts = await projectLockArtifacts(projectPath);
	const claimArtifact = artifacts.find(
		(artifact) => artifact.kind === "claim" || artifact.kind === "reservation",
	);
	if (claimArtifact) {
		if (claimArtifact.kind === "reservation") {
			throw new LockError("Project lock recovery claim blocks execution", {
				code: "PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
			});
		}
		const lockPath = claimArtifact.lockPath;
		const claimPath = claimArtifact.claimPath;
		const claimRaw = claimArtifact.raw;
		const claimBody = claimArtifact.body;
		if (claimBody?.runId === runId) {
			const restoredBody = JSON.stringify({
				...claimBody,
				holderPid: process.pid,
			});
			try {
				await writeFile(lockPath, restoredBody, { flag: "wx", mode: 0o600 });
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				try {
					const removed = await unlinkMatched(claimPath, claimRaw);
					if (!removed) throw new Error("claim changed");
				} catch {
					await markClaimCleanupFailure(runId);
					throw new LockError("Project lock claim cleanup failed", {
						code: "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
					});
				}
				throw new LockError("Project lock ownership was displaced", {
					code: "PROJECT_LOCK_OWNERSHIP_DISPLACED",
				});
			}
			try {
				const removed = await unlinkMatched(claimPath, claimRaw);
				if (!removed) throw new Error("claim changed");
			} catch {
				await unlinkBodyMatched(lockPath, restoredBody).catch(() => false);
				await markClaimCleanupFailure(runId);
				throw new LockError("Project lock claim cleanup failed", {
					code: "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
				});
			}
			return true;
		}
		throw new LockError("Project lock recovery claim blocks execution", {
			code: "PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
		});
	}

	const lockArtifact = artifacts.find((artifact) => artifact.kind === "lock");
	const lockPath = lockArtifact?.lockPath ?? projectLockPath(projectPath);
	const claimPath = `${lockPath}.recovery-claim`;
	const raw = lockArtifact?.raw ?? (await readTextIfPresent(lockPath));
	const body =
		raw === null
			? null
			: parseProjectLockArtifact(
					raw,
					projectPath,
					lockPath === projectLockPath(projectPath) ||
						lockPath === cwdDerivedProjectLockPath(projectPath),
				);
	if (!body || body.runId !== runId) {
		throw new LockError("Project lock ownership assertion failed", {
			code: "PROJECT_LOCK_OWNERSHIP_FAILED",
		});
	}
	if (body.holderPid === process.pid) return true;

	const claimed = await moveProjectLockPathToClaim(
		lockPath,
		claimPath,
		projectPath,
		raw,
	);
	if (!claimed) {
		throw new LockError("Project lock ownership assertion failed", {
			code: "PROJECT_LOCK_OWNERSHIP_FAILED",
		});
	}
	const refreshedRaw = JSON.stringify({ ...body, holderPid: process.pid });
	try {
		await writeFile(lockPath, refreshedRaw, { flag: "wx", mode: 0o600 });
	} catch (error) {
		try {
			const removed = await unlinkMatched(claimed.claimPath, claimed.raw);
			if (!removed) throw new Error("claim changed");
		} catch {
			await markClaimCleanupFailure(runId);
			throw new LockError("Project lock claim cleanup failed", {
				code: "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
			});
		}
		if (error.code === "EEXIST") {
			throw new LockError("Project lock ownership was displaced", {
				code: "PROJECT_LOCK_OWNERSHIP_DISPLACED",
			});
		}
		throw error;
	}
	try {
		const removed = await unlinkMatched(claimed.claimPath, claimed.raw);
		if (!removed) throw new Error("claim changed");
	} catch {
		await unlinkBodyMatched(lockPath, refreshedRaw).catch(() => false);
		await markClaimCleanupFailure(runId);
		throw new LockError("Project lock claim cleanup failed", {
			code: "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
		});
	}
	return true;
}

/**
 * Check whether a project lock is currently held for the given path.
 *
 * @param {string} canonicalProjectPath
 * @returns {boolean}
 */
export function isProjectLockHeld(canonicalProjectPath) {
	const projectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	const canonicalLockPath = projectLockPath(projectPath);
	const historicalLockPath = cwdDerivedProjectLockPath(projectPath);
	if (
		existsSync(canonicalLockPath) ||
		existsSync(projectLockClaimPath(projectPath)) ||
		existsSync(historicalLockPath) ||
		existsSync(`${historicalLockPath}.recovery-claim`)
	) {
		return true;
	}
	try {
		return readdirSync(locksRoot(), { withFileTypes: true }).some((entry) => {
			if (!entry.isFile()) return false;
			const isClaim = entry.name.endsWith(".lock.recovery-claim");
			if (!isClaim && !entry.name.endsWith(".lock")) return false;
			const path = resolve(locksRoot(), entry.name);
			const proof = recoveryProofMetadata(entry.name);
			const originalPath = proof
				? resolve(locksRoot(), proof.originalName)
				: path;
			const lockPath = originalPath.endsWith(".lock.recovery-claim")
				? originalPath.slice(0, -".recovery-claim".length)
				: originalPath;
			const isOwnedPath =
				lockPath === canonicalLockPath || lockPath === historicalLockPath;
			if (isOwnedPath) return true;
			try {
				const raw = readFileSync(path, "utf8");
				if (!isClaim)
					return (
						parseProjectLockArtifact(raw, projectPath, isOwnedPath) !== null
					);
				const reservation = parseRecoveryReservation(raw);
				return reservation
					? parseProjectLockArtifact(
							reservation.expectedRaw,
							projectPath,
							isOwnedPath,
						) !== null
					: parseProjectLockArtifact(raw, projectPath, isOwnedPath) !== null;
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

// Host-global ceiling on concurrently running macOS guests, imposed by Apple's
// Virtualization.framework (Parallels rides the same framework). This is the
// platform's maximum, not a tuning knob: raising it does not buy a third VM, it
// buys an opaque framework failure at VM start. The two slot files live under the
// home directory, so the pool spans every session, project and harness on this Mac.
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

function readVmSlotBody(slotPath, readSlot = readFileSync) {
	let raw;
	try {
		raw = readSlot(slotPath, "utf8");
	} catch (error) {
		// An unreadable occupied slot is not evidence of ordinary capacity
		// contention. Preserve closed permission/storage failures for the
		// admission boundary instead of collapsing them to an unknown holder.
		if (
			VM_ADMISSION_PERMISSION_CODES.has(error?.code) ||
			VM_ADMISSION_STORAGE_CODES.has(error?.code)
		) {
			throw error;
		}
		// A vanished occupied slot is a normal acquire/release race. The
		// caller retries that slot within its bounded admission loop; other
		// unclassified read failures remain within the closed admission boundary.
		throw error;
	}
	try {
		const body = vmSlotBody(JSON.parse(raw));
		if (body) return body;
	} catch (error) {
		throw new VmAdmissionStorageError(error);
	}
	// A slot that won the atomic publish operation must contain a complete,
	// valid owner record. Treat malformed-but-readable storage as a closed
	// storage failure, never as ordinary contention that can poison a slot.
	throw new VmAdmissionStorageError(
		new Error("VM admission slot contains an invalid owner record"),
	);
}

function removeVmTempFile(tmpPath) {
	try {
		unlinkSync(tmpPath);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

function vmOwnerIsLive(ownerPid, probePid) {
	if (probePid) {
		try {
			return probePid(ownerPid) !== "dead";
		} catch {
			return true;
		}
	}
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
function acquireVmSlotWithDependencies(options = {}, dependencies = {}) {
	const normalized = typeof options === "string" ? { runId: options } : options;
	const publishSlot = dependencies.publishVmSlot ?? publishVmSlot;
	const readSlotBody = dependencies.readVmSlotBody ?? readVmSlotBody;
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

	try {
		mkdirSync(resolveVmAdmissionRoot(), { recursive: true, mode: 0o700 });
		const holders = [];

		for (let slotIndex = 0; slotIndex < VM_SLOT_COUNT; slotIndex += 1) {
			const slotPath = vmSlotPath(slotIndex);
			for (let attempt = 0; attempt < 2; attempt += 1) {
				if (publishSlot(slotPath, body)) {
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

				let owner;
				try {
					owner = readSlotBody(slotPath);
				} catch (error) {
					if (error?.code === "ENOENT") continue;
					throw error;
				}
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
	} catch (error) {
		if (error instanceof VmSlotUnavailableError) throw error;
		throw sanitizeVmAdmissionError(error);
	}
}

export function acquireVmSlot(options = {}) {
	return acquireVmSlotWithDependencies(options);
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
	let owner;
	try {
		owner = readVmSlotBody(slotPath);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
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
 * Reconcile abandoned project-lock recovery claims in one bounded pass.
 * Live, startup-grace, malformed, and unresolved owners are deliberately
 * retained for their holder or a human-confirmed repair. A cleanup-failed
 * claim is removed automatically only when a valid canonical lock proves that
 * a different run now owns the same project. The attended remediation CLI may
 * opt into removal after it has confirmed the action and freshly proved the
 * cleanup-failed worker dead.
 *
 * @param {{onRemoved?: (path: string) => void, allowCleanupFailedDead?: boolean, now?: number, probePid?: (pid: number) => string}} [options]
 * @returns {Promise<string[]>} run ids whose claim was removed
 */
export async function reconcileProjectLockClaims(options = {}) {
	let entries;
	try {
		entries = await readdir(locksRoot(), { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const reclaimed = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".lock.recovery-claim")) {
			continue;
		}
		const proof = recoveryProofMetadata(entry.name);
		if (proof !== null && vmOwnerIsLive(proof.ownerPid, options.probePid))
			continue;
		const claimPath = resolve(locksRoot(), entry.name);
		const originalPath = proof
			? resolve(locksRoot(), proof.originalName)
			: claimPath;
		const lockPath = originalPath.endsWith(".lock.recovery-claim")
			? originalPath.slice(0, -".recovery-claim".length)
			: originalPath;
		const raw = await readTextIfPresent(claimPath).catch(() => null);
		if (raw === null) continue;
		const reservation = parseRecoveryReservation(raw);
		if (reservation) {
			let parsedOwnerBody = parseProjectLockBody(reservation.expectedRaw);
			if (!parsedOwnerBody?.projectPath) {
				const legacyBody = parseLegacyProjectLockBody(reservation.expectedRaw);
				if (legacyBody) {
					try {
						const legacyRun = await readRun(legacyBody.runId);
						const projectPath = resolveCanonicalProjectPath(
							legacyRun.projectPath,
						);
						if (
							lockPath === projectLockPath(projectPath) ||
							lockPath === cwdDerivedProjectLockPath(projectPath)
						) {
							parsedOwnerBody = { ...legacyBody, projectPath };
						}
					} catch {
						// Missing or malformed run evidence cannot bind a legacy proof.
					}
				}
			}
			if (!parsedOwnerBody?.projectPath) continue;
			const canonicalRaw = await readTextIfPresent(lockPath).catch(() => null);
			// An ordinary reservation may still coordinate an active recoverer, so
			// its lock bytes must match. A PID-bearing proof is the atomically taken
			// reservation itself; once that PID is dead, a mismatch means the
			// cleanup path was interrupted and the proof can be reconciled safely.
			if (!proof && canonicalRaw !== reservation.expectedRaw) continue;
			let run;
			try {
				run = await readRun(parsedOwnerBody.runId);
			} catch {
				continue;
			}
			if (
				typeof run.projectPath !== "string" ||
				resolveCanonicalProjectPath(run.projectPath) !==
					resolveCanonicalProjectPath(parsedOwnerBody.projectPath)
			) {
				continue;
			}
			if (run.cleanupState === "failed") {
				if (!options.allowCleanupFailedDead) continue;
				const liveness = classifyRunLiveness(run, {
					...(options.now !== undefined ? { now: options.now } : {}),
					...(options.probePid ? { probePid: options.probePid } : {}),
				});
				if (liveness !== "dead") continue;
			} else {
				const liveness = classifyRunLiveness(run, {
					...(options.now !== undefined ? { now: options.now } : {}),
					...(options.probePid ? { probePid: options.probePid } : {}),
				});
				if (liveness !== "terminal_clean" && liveness !== "dead") continue;
			}
			try {
				if (await unlinkBodyMatched(claimPath, raw)) {
					reclaimed.push(parsedOwnerBody.runId);
					options.onRemoved?.(claimPath);
				}
			} catch {
				// One attempt per claim. A later reconciliation may retry it.
			}
			continue;
		}
		let parsedBody = parseProjectLockBody(raw);
		if (!parsedBody?.projectPath) {
			const legacyBody = parseLegacyProjectLockBody(raw);
			if (legacyBody) {
				try {
					const legacyRun = await readRun(legacyBody.runId);
					const projectPath = resolveCanonicalProjectPath(
						legacyRun.projectPath,
					);
					if (
						lockPath === projectLockPath(projectPath) ||
						lockPath === cwdDerivedProjectLockPath(projectPath)
					) {
						parsedBody = { ...legacyBody, projectPath };
					}
				} catch {
					// Missing or malformed run evidence cannot bind a legacy proof.
				}
			}
		}
		if (!parsedBody?.projectPath) continue;
		let run;
		try {
			run = await readRun(parsedBody.runId);
		} catch {
			continue;
		}
		if (
			typeof run.projectPath !== "string" ||
			resolveCanonicalProjectPath(run.projectPath) !==
				resolveCanonicalProjectPath(parsedBody.projectPath)
		) {
			continue;
		}
		if (run.cleanupState === "failed") {
			if (options.allowCleanupFailedDead) {
				const liveness = classifyRunLiveness(run, {
					...(options.now !== undefined ? { now: options.now } : {}),
					...(options.probePid ? { probePid: options.probePid } : {}),
				});
				if (liveness !== "dead") continue;
			} else {
				const replacement = (
					await projectLockArtifacts(parsedBody.projectPath)
				).find(
					(artifact) =>
						artifact.kind === "lock" &&
						artifact.lockPath === projectLockPath(parsedBody.projectPath) &&
						artifact.body.runId !== parsedBody.runId,
				);
				if (!replacement) continue;
			}
		} else {
			const liveness = classifyRunLiveness(run, {
				...(options.now !== undefined ? { now: options.now } : {}),
				...(options.probePid ? { probePid: options.probePid } : {}),
			});
			if (liveness !== "terminal_clean" && liveness !== "dead") continue;
		}
		try {
			if (await unlinkBodyMatched(claimPath, raw)) {
				reclaimed.push(parsedBody.runId);
				options.onRemoved?.(claimPath);
			}
		} catch {
			// One attempt per claim. A later reconciliation may retry it.
		}
	}
	return reclaimed;
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
	const reclaimedClaims = await reconcileProjectLockClaims();
	let entries;
	try {
		entries = await readdir(locksRoot(), { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return reclaimedClaims;
		throw e;
	}

	const reclaimed = [...reclaimedClaims];

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
		if (
			typeof run.projectPath !== "string" ||
			resolveCanonicalProjectPath(run.projectPath) !==
				resolveCanonicalProjectPath(body.projectPath)
		) {
			continue;
		}

		if (run.cleanupState === "failed") continue;
		const liveness = classifyRunLiveness(run);
		if (liveness !== "terminal_clean" && liveness !== "dead") continue;

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
 * Whether a run directory holds a diagnostic record.
 *
 * Retention splits the store by what a file IS, not by what state its run
 * reached. `run.json`, `events.jsonl`, and a non-empty `boot-stderr.log` are
 * the diagnostic record — the files a post-mortem actually reads — and are
 * retained with no expiry. Everything else is either derivable or, in the case
 * of `artifacts/`, raw provider output that INV-2 says must not persist.
 *
 * A directory with neither `events.jsonl` nor a non-empty `boot-stderr.log`
 * recorded no events and captured no boot failure, so there is nothing to
 * post-mortem: `run.json` alone attests that a run was initialized and reached
 * some state, which the directory's absence attests just as well. Measured on
 * 2026-08-26, 60 of 159 directories were in that shape and every one of them
 * carried `processedTasks: 0`, so no completed work is reachable by this rule.
 *
 * @param {string} runId
 */
function hasDiagnosticRecord(runId) {
	if (existsSync(resolve(getRunRoot(runId), "events.jsonl"))) {
		return true;
	}
	try {
		const stat = statSync(resolve(getRunRoot(runId), "boot-stderr.log"));
		return stat.size > 0;
	} catch {
		return false;
	}
}

/**
 * The checkpoint a run would resume from, or null when the run record names
 * no tasks file. Mirrors dispatch's
 * `run.runOptions?.checkpointPath ?? getCheckpointPath(run.tasksFilePath)`
 * inline rather than importing it: run-store sits below runner/ and dispatch/
 * and must not depend on them.
 *
 * @param {object} run
 * @returns {string|null}
 */
function checkpointPathForRun(run) {
	const explicit = run?.runOptions?.checkpointPath;
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	if (typeof run?.tasksFilePath === "string" && run.tasksFilePath.length > 0) {
		return `${run.tasksFilePath}.checkpoint.json`;
	}
	return null;
}

/**
 * Whether a resume could still read this run's checkpoint. A run in that
 * position is left completely alone — not collected, not removed — because
 * the checkpoint is the authoritative queue state and the run directory is
 * what `switchyard recover` reads alongside it.
 *
 * Deliberately conservative: the checkpoint is keyed by tasks file, not by
 * run, so a checkpoint left behind by a sibling run also protects this one.
 * Over-retaining a directory costs kilobytes; deleting one out from under a
 * resume costs the resume.
 *
 * @param {object} run
 */
function hasLiveCheckpoint(run) {
	const path = checkpointPathForRun(run);
	if (path === null) return false;
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}

/**
 * Remove the CONTENTS of a run's artifacts directory, leaving the directory
 * itself in place — `initializeRun` provisions it for every run, so removing
 * it would only be undone by the next run.
 *
 * Collection is unconditional rather than age-gated: an artifact is raw
 * provider output at every age, and the age of the run that produced it does
 * not change that. A missing or unreadable artifacts directory is not an
 * error; it is the steady state this function drives toward.
 *
 * @param {string} runId
 * @param {boolean} dryRun
 * @returns {Promise<number>} number of entries removed (or eligible, in dryRun)
 */
async function collectArtifacts(runId, dryRun) {
	const artifactsDir = resolve(getRunRoot(runId), "artifacts");
	let entries;
	try {
		entries = await readdir(artifactsDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (dryRun) {
			console.error(
				`applyRetention: would collect artifact ${sanitizeForDisplay(entry.name)} from run ${sanitizeForDisplay(runId)}`,
			);
			removed += 1;
			continue;
		}
		try {
			await rm(resolve(artifactsDir, entry.name), {
				recursive: true,
				force: true,
			});
			removed += 1;
		} catch (e) {
			console.warn(
				`applyRetention: failed to collect artifact ${sanitizeForDisplay(entry.name)} from run ${sanitizeForDisplay(runId)}: ${sanitizeForDisplay(e.message)}`,
			);
		}
	}
	return removed;
}

/**
 * Apply the run-store retention policy.
 *
 * The policy splits the store by what a file IS rather than by what state
 * its run reached, because run state turned out to be a poor proxy for
 * diagnostic value. The previous rule could only ever reach runs that were
 * "succeeded" with cleanupState "complete" — the runs least worth reading —
 * while a failed run's post-mortem aged out only by never being eligible at
 * all. Three rules replace it:
 *
 *   1. `run.json` and `events.jsonl` are never deleted, at any age, for any
 *      run state. They are the diagnostic record. At the measured rate they
 *      project to roughly 18 MB a year, which is not a retention problem.
 *   2. `artifacts/` contents are collected on every sweep, unconditionally.
 *      Nothing reads them back — listArtifactRefs hashes the file NAME into
 *      an opaque ref and never opens the file — so they are raw provider
 *      output persisted without a consumer, which is what INV-2 forbids.
 *   3. A run directory with no diagnostic record (see hasDiagnosticRecord)
 *      is removed entirely, whatever its state. maxAgeDays/maxRuns bound THIS
 *      removal and nothing else, which is also what keeps a mid-flight run —
 *      run.json written, first event not yet appended — out of reach of the
 *      same sweep.
 *
 * A run whose checkpoint still exists on disk is exempt from both 2 and 3:
 * a resume would read it.
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
 * @param {number} [options.maxRuns] - maximum number of no-diagnostic run
 *   directories to keep. Bounds rule 3 only; it can never remove a run that
 *   has an events.jsonl.
 * @param {number} [options.maxAgeDays] - maximum age in days for a
 *   no-diagnostic run directory. Bounds rule 3 only, for the same reason.
 * @param {string} [options.now] - reference ISO timestamp (default: now)
 * @param {boolean} [options.dryRun] - log-only mode for DELETION AND
 *   COLLECTION: report what WOULD be removed (on stderr, with the reason)
 *   without calling `rm`. Malformed-run quarantine is NOT suppressed —
 *   malformed directories are still moved, since they would otherwise fail
 *   this same scan forever.
 * @returns {Promise<{deletedCount: number, collectedCount: number, quarantined: Array<{runId: string, destination: string, destinationDisplay: string, reason: string}>}>}
 *   deletedCount: number of no-diagnostic run directories removed (or
 *   eligible, in dryRun); collectedCount: number of artifact entries removed
 *   (or eligible, in dryRun); quarantined: one entry per malformed run
 *   directory moved out of the active scan, with its sanitized runId, the
 *   actual on-disk destination it was moved to (raw, for machine use), a
 *   separately sanitized destinationDisplay safe for logs/terminal, and a
 *   static reason string.
 */
export async function applyRetention(options = {}) {
	const { maxRuns, maxAgeDays, now, dryRun } = options;
	const referenceTime = now ? new Date(now).getTime() : Date.now();

	let entries;
	try {
		entries = await readdir(runsRoot(), { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT")
			return { deletedCount: 0, collectedCount: 0, quarantined: [] };
		throw e;
	}

	const quarantined = [];
	const removable = [];
	let collectedCount = 0;
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
		// A quarantined directory `continue`d above, so it is never reached by
		// the collect/remove paths below in the same sweep — the two never
		// contend for the same directory.
		if (hasLiveCheckpoint(run)) continue;
		collectedCount += await collectArtifacts(entry.name, dryRun);
		if (!hasDiagnosticRecord(entry.name)) {
			removable.push({
				runId: entry.name,
				createdAt: new Date(run.createdAt).getTime(),
			});
		}
	}

	removable.sort((a, b) => a.createdAt - b.createdAt);

	const deleted = new Set();

	if (maxAgeDays != null && Number.isFinite(maxAgeDays)) {
		const cutoff = referenceTime - maxAgeDays * 86_400_000;
		for (const r of removable) {
			if (r.createdAt < cutoff) {
				if (dryRun) {
					console.error(
						`applyRetention: would delete run ${r.runId} (no events.jsonl, older than maxAgeDays cutoff)`,
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

	const remaining = removable.filter((r) => !deleted.has(r.runId));

	if (
		maxRuns != null &&
		Number.isFinite(maxRuns) &&
		remaining.length > maxRuns
	) {
		const toDelete = remaining.slice(0, remaining.length - maxRuns);
		for (const r of toDelete) {
			if (dryRun) {
				console.error(
					`applyRetention: would delete run ${r.runId} (no events.jsonl, maxRuns trim)`,
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

	return { deletedCount: deleted.size, collectedCount, quarantined };
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

export {
	LockError,
	RevisionError,
	SchemaError,
	VmAdmissionPermissionDeniedError,
	VmAdmissionStorageError,
	VmAdmissionUnavailableError,
	VmSlotUnavailableError,
};
