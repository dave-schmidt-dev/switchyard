import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	appendFile,
	link,
	lstat,
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
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	isPersistentFailureMetadata,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { createProgressSnapshot } from "../adapter/provider-lifecycle.mjs";
import {
	validateIdentifier,
	validateInvocationArgs,
	validateModelArg,
} from "../adapter/shell-safety.mjs";
import {
	isReviewResult,
	sanitizeReviewResult,
} from "../diagnostics/review-result.mjs";
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
	"deferred",
	"recovery_required",
]);

const VALID_CLEANUP_STATES = new Set([
	"not_started",
	"pending",
	"complete",
	"failed",
]);

const RUN_ID_RE = /^[\w-]+$/;
// A random value allocated once for this module instance distinguishes two
// Switchyard processes even when the operating system later reuses a PID. It
// is an instance fence only; it is deliberately not presented as OS liveness
// or process-birth evidence.
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
]);

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

// Checkpoint-adjacent review files are deliberately a separate evidence
// channel from run-store artifacts.  Their names carry only the bounded task
// identity; the checkpoint supplies the authoritative attempt and purpose
// state.  Legacy first-attempt names remain readable for one compatibility
// interval, but they are never deleted when their identity is ambiguous.
const CHECKPOINT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_ARTIFACT_MAX_ENTRIES = 128;
const CHECKPOINT_ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;

function ownerUidMatches(stat) {
	return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function ownerOnlyDirectoryStat(stat) {
	return (
		stat.isDirectory() &&
		!stat.isSymbolicLink() &&
		ownerUidMatches(stat) &&
		(stat.mode & 0o077) === 0
	);
}

function ownerOnlyRegularFileStat(stat, maxBytes) {
	return (
		stat.isFile() &&
		!stat.isSymbolicLink() &&
		stat.nlink === 1 &&
		ownerUidMatches(stat) &&
		(stat.mode & 0o077) === 0 &&
		stat.size <= maxBytes
	);
}

function validateRouteHealthBinding(binding) {
	if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
		throw new SchemaError("route health binding is invalid");
	}
	if (
		Object.keys(binding).some((key) => !ROUTE_HEALTH_BINDING_KEYS.has(key)) ||
		binding.version !== 1 ||
		binding.producer !== "run-store" ||
		typeof binding.runId !== "string" ||
		!Number.isSafeInteger(binding.runRevision) ||
		binding.runRevision < 1 ||
		typeof binding.adapterContractId !== "string" ||
		binding.adapterContractId.length === 0 ||
		binding.adapterContractId.length > 128 ||
		!ROUTE_HEALTH_EPOCH_RE.test(binding.publicConfigurationEpoch) ||
		!Number.isSafeInteger(binding.repairEpoch) ||
		binding.repairEpoch < 0 ||
		typeof binding.transportVerified !== "boolean" ||
		typeof binding.lifecycleVerified !== "boolean" ||
		(binding.claimRevision !== undefined &&
			binding.lifecycleVerified !== true) ||
		(binding.claimRevision !== undefined &&
			(!Number.isSafeInteger(binding.claimRevision) ||
				binding.claimRevision < 1))
	) {
		throw new SchemaError("route health binding is invalid");
	}
}

export function isSafeTargetId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) {
		return false;
	}
	return ![...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

/**
 * Produce the stable identity shape used by durable writers that must fence a
 * later publisher. The nonce is caller-owned when a process already has one.
 * @param {string} runId
 * @param {string} [processStartIdentity]
 * @param {string} [nonce]
 * @returns {{runId: string, processStartIdentity: string, nonce: string}}
 */
export function createFencingIdentity(
	runId,
	processStartIdentity = PROCESS_INSTANCE_ID,
	nonce = randomUUID(),
) {
	validateRunId(runId);
	if (
		typeof processStartIdentity !== "string" ||
		processStartIdentity.length === 0 ||
		typeof nonce !== "string" ||
		nonce.length === 0
	) {
		throw new SchemaError("fencing identity is invalid");
	}
	return { runId, processStartIdentity, nonce };
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
	for (const field of ["startedAt", "finishedAt"]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			typeof data[field] !== "string"
		) {
			throw new SchemaError(`${field} must be a string or null`);
		}
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
		data.lastReviewResult !== undefined &&
		data.lastReviewResult !== null &&
		!isReviewResult(data.lastReviewResult)
	) {
		throw new SchemaError("lastReviewResult contains invalid review metadata");
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

	// No artifacts/ directory is provisioned here. The channel's only writer --
	// the partial-diff copy in dispatch/worker-bootstrap.mjs -- was removed
	// because INV-2 forbids persisting raw provider output nothing reads back,
	// so every run since has created an empty directory and left it there: 81 of
	// them, zero bytes, found during a 2026-09-04 cleanup of the consuming
	// project. Both readers (listArtifactRefs, collectArtifacts) already treat
	// absence as ordinary and return empty. Should a producer ever return, it
	// creates the directory itself.

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
		startedAt: null,
		finishedAt: null,
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
		lastReviewResult: null,
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
 * Persist only the bounded, already-sanitized provider diagnostic summary.
 * The resource directory is owner-only and symlink-free; the returned opaque
 * reference is the only value intended for run/event projections.
 */
export async function persistDiagnosticArtifact(runId, evidence) {
	validateRunId(runId);
	if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
		return null;
	}
	const evidenceKeys = new Set([
		"stdoutBytes",
		"stderrBytes",
		"stdoutDigest",
		"stderrDigest",
		"diagnosticKind",
	]);
	if (Object.keys(evidence).some((key) => !evidenceKeys.has(key))) return null;
	const runRoot = getRunRoot(runId);
	const resources = resolve(runRoot, "resources");
	for (const existing of [runRoot, resources]) {
		try {
			const stat = await lstat(existing);
			if (!ownerOnlyDirectoryStat(stat)) return null;
		} catch (error) {
			if (error.code !== "ENOENT") return null;
		}
	}
	await ensureDir(runRoot, 0o700);
	await ensureDir(resources, 0o700);
	const runRootStat = await lstat(runRoot);
	if (!ownerOnlyDirectoryStat(runRootStat)) return null;
	const resourceStat = await lstat(resources);
	if (!ownerOnlyDirectoryStat(resourceStat)) return null;
	const stdoutBytes = evidence.stdoutBytes;
	const stderrBytes = evidence.stderrBytes;
	if (
		!Number.isSafeInteger(stdoutBytes) ||
		!Number.isSafeInteger(stderrBytes) ||
		stdoutBytes < 0 ||
		stderrBytes < 0 ||
		stdoutBytes > MAX_DIAGNOSTIC_STREAM_BYTES ||
		stderrBytes > MAX_DIAGNOSTIC_STREAM_BYTES ||
		!DIAGNOSTIC_DIGEST_RE.test(evidence.stdoutDigest ?? "") ||
		!DIAGNOSTIC_DIGEST_RE.test(evidence.stderrDigest ?? "") ||
		(evidence.diagnosticKind !== undefined &&
			!DIAGNOSTIC_ARTIFACT_KINDS.has(evidence.diagnosticKind))
	) {
		return null;
	}
	const bounded = {
		schemaVersion: 1,
		kind: "provider_diagnostic",
		...(DIAGNOSTIC_ARTIFACT_KINDS.has(evidence.diagnosticKind)
			? { diagnosticKind: evidence.diagnosticKind }
			: {}),
		stdoutBytes,
		stderrBytes,
		stdoutDigest: evidence.stdoutDigest,
		stderrDigest: evidence.stderrDigest,
	};
	const raw = JSON.stringify(bounded);
	if (Buffer.byteLength(raw) > MAX_DIAGNOSTIC_ARTIFACT_BYTES) return null;
	const token = randomUUID().replaceAll("-", "");
	const filename = `provider-diagnostic-${token}.json`;
	const destination = resolve(resources, filename);
	await writeFile(destination, `${raw}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	return `diagnostic:${token}`;
}

/** Resolve and validate a stored diagnostic reference without exposing raw streams. */
export async function resolveDiagnosticArtifact(runId, diagnosticRef) {
	if (!DIAGNOSTIC_REF_RE.test(diagnosticRef ?? "")) return null;
	validateRunId(runId);
	const token = diagnosticRef.slice("diagnostic:".length);
	const path = resolve(
		getRunRoot(runId),
		"resources",
		`provider-diagnostic-${token}.json`,
	);
	try {
		const runRootStat = await lstat(getRunRoot(runId));
		const resourcesStat = await lstat(resolve(getRunRoot(runId), "resources"));
		if (
			!ownerOnlyDirectoryStat(runRootStat) ||
			!ownerOnlyDirectoryStat(resourcesStat)
		)
			return null;
		const stat = await lstat(path);
		if (!ownerOnlyRegularFileStat(stat, MAX_DIAGNOSTIC_ARTIFACT_BYTES))
			return null;
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (parsed?.kind !== "provider_diagnostic" || parsed?.schemaVersion !== 1)
			return null;
		const allowed = new Set([
			"schemaVersion",
			"kind",
			"diagnosticKind",
			"stdoutBytes",
			"stderrBytes",
			"stdoutDigest",
			"stderrDigest",
		]);
		if (Object.keys(parsed).some((key) => !allowed.has(key))) return null;
		if (
			(parsed.diagnosticKind !== undefined &&
				!DIAGNOSTIC_ARTIFACT_KINDS.has(parsed.diagnosticKind)) ||
			!Number.isSafeInteger(parsed.stdoutBytes) ||
			!Number.isSafeInteger(parsed.stderrBytes) ||
			parsed.stdoutBytes < 0 ||
			parsed.stderrBytes < 0 ||
			parsed.stdoutBytes > MAX_DIAGNOSTIC_STREAM_BYTES ||
			parsed.stderrBytes > MAX_DIAGNOSTIC_STREAM_BYTES ||
			!DIAGNOSTIC_DIGEST_RE.test(parsed.stdoutDigest ?? "") ||
			!DIAGNOSTIC_DIGEST_RE.test(parsed.stderrDigest ?? "")
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
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

	if (
		partial?.lastReviewResult !== undefined &&
		partial.lastReviewResult !== null &&
		!isReviewResult(partial.lastReviewResult)
	) {
		throw new SchemaError("lastReviewResult contains invalid review metadata");
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
	if (merged.lastFailure?.diagnosticRef) {
		const diagnosticArtifact = await resolveDiagnosticArtifact(
			runId,
			merged.lastFailure.diagnosticRef,
		);
		if (!diagnosticArtifact) {
			const withoutDiagnosticRef = { ...merged.lastFailure };
			delete withoutDiagnosticRef.diagnosticRef;
			merged.lastFailure = {
				...withoutDiagnosticRef,
				diagnosticEvidenceAvailable: false,
			};
		}
	}

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
	const patch = { state: newState };
	if (newState === "running" && current.startedAt == null) {
		patch.startedAt = new Date().toISOString();
	}
	return updateRun(runId, patch, current.revision);
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

	let current = await readRun(runId);
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

	await appendFile(eventsPath, `${JSON.stringify(entry)}\n`, {
		mode: 0o600,
	});

	try {
		await updateRun(
			runId,
			{
				lastEventSequence: nextSeq,
				...(safeFailure ? { lastFailure: safeFailure } : {}),
				...(projectedReviewResult !== undefined
					? { lastReviewResult: projectedReviewResult }
					: {}),
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
						...(projectedReviewResult !== undefined
							? { lastReviewResult: projectedReviewResult }
							: {}),
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

/** Persist a normal sanitized run event. */
export async function createEvent(runId, event) {
	return createEventInternal(runId, event);
}

/**
 * Write a sanitized execution event bound by the host to a route-health
 * generation.  Callers cannot retrofit this binding onto retained legacy
 * events during projection rebuilds.
 */
export async function createRouteHealthEvent(runId, event, binding) {
	validateRunId(runId);
	if (
		event?.phase !== "execution" ||
		!["task_completed", "task_failed"].includes(event?.event) ||
		typeof event?.taskId !== "string" ||
		(!Number.isSafeInteger(event?.attempt) &&
			typeof event?.attempt !== "string") ||
		!event?.invocationDescriptor ||
		!event?.descriptorIdentity ||
		!event?.descriptorHarness ||
		!event?.resolvedTargetId
	) {
		throw new SchemaError(
			"route health event requires exact execution evidence",
		);
	}
	const current = await readRun(runId);
	if (!current.orderedTaskIds.includes(event.taskId))
		throw new SchemaError(
			"route health event task is outside the run contract",
		);
	const hostBinding = {
		...binding,
		version: 1,
		producer: "run-store",
		runId,
		runRevision: current.revision,
	};
	validateRouteHealthBinding(hostBinding);
	return createEventInternal(
		runId,
		{ ...event, routeHealthBinding: hostBinding },
		{ routeHealthAuthorised: true },
	);
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

// The live VM gates use the same host-global admission primitive as production,
// but their wait is deliberately shorter and injectable so fixture runs cannot
// hide an admission race behind an unbounded test timeout.
export const TEST_VM_SLOT_WAIT_TIMEOUT_MS = 120_000;
export const TEST_VM_SLOT_WAIT_INTERVAL_MS = 250;

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
 * Project a VM gate result into the three states the phase runners understand.
 * An unavailable gate is valid only when its caller supplies a bounded reason;
 * an omitted reason is a failure rather than a silent green skip.
 *
 * @param {{executed?: boolean, unavailableReason?: string, error?: unknown}} [result]
 * @returns {{status: "executed"|"unavailable-with-proof"|"failed", reason?: string}}
 */
export function projectVmGateOutcome({
	executed = false,
	unavailableReason = null,
	error = null,
} = {}) {
	if (error) {
		return { status: "failed", reason: "gate-error" };
	}
	if (executed) return { status: "executed" };
	if (
		typeof unavailableReason === "string" &&
		unavailableReason.trim().length > 0
	) {
		return {
			status: "unavailable-with-proof",
			reason: unavailableReason.trim().slice(0, 160),
		};
	}
	return { status: "failed", reason: "missing-unavailability-proof" };
}

/**
 * Publish one machine-readable live VM-gate terminal outcome for the phase
 * runner. The side channel is opt-in and never writes to stdout or durable
 * Switchyard state; direct `node --test` runs therefore retain their normal
 * behavior while `run-test-phases` can fail closed on missing evidence.
 *
 * @param {string} gateName
 * @param {{status: "executed"|"unavailable-with-proof"|"failed", reason?: string}} outcome
 * @returns {boolean} whether an outcome was written
 */
export function publishVmGateOutcome(gateName, outcome) {
	const path = process.env.SWITCHYARD_VM_GATE_OUTCOME_FILE;
	if (!path) return false;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(gateName)) {
		throw new TypeError("VM gate name is invalid");
	}
	const projected = projectVmGateOutcome({
		executed: outcome?.status === "executed",
		unavailableReason:
			outcome?.status === "unavailable-with-proof" ? outcome.reason : null,
		error: outcome?.status === "failed" ? new Error("gate failed") : null,
	});
	const record = {
		schemaVersion: 1,
		gate: gateName,
		status: projected.status,
		...(projected.reason ? { reason: projected.reason } : {}),
	};
	appendFileSync(path, `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return true;
}

function testVmReadinessUnavailable(error) {
	return (
		typeof error?.code === "string" &&
		(error.code.startsWith("vm_host_") ||
			error.code === "VM_ADMISSION_UNAVAILABLE" ||
			error.code === "VM_ADMISSION_PERMISSION_DENIED")
	);
}

/**
 * Acquire a test VM slot with bounded, observable admission.
 *
 * The default acquire function is the production `acquireVmSlot`, including
 * its exact owner-PID liveness predicate and stale-claim reclaim fence. Tests
 * may inject a hermetic function, but unrelated errors are never converted to
 * an unavailable result. A readiness probe can be supplied when a gate also
 * needs the backend's production host-readiness predicate.
 *
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.nowFn]
 * @param {(ms:number) => (void|Promise<void>)} [options.sleepFn]
 * @param {(event: object) => void} [options.onStatus]
 * @param {() => (void|boolean|object|Promise<void|boolean|object>)} [options.readinessFn]
 * @param {(options: object) => object} [options.acquireFn]
 * @returns {Promise<{status: "executed"|"unavailable-with-proof", lease?: object, reason?: string, attempts: number, elapsedMs: number}>}
 */
export async function acquireVmSlotForTest({
	runId,
	timeoutMs = TEST_VM_SLOT_WAIT_TIMEOUT_MS,
	intervalMs = TEST_VM_SLOT_WAIT_INTERVAL_MS,
	nowFn = () => performance.now(),
	sleepFn = (delayMs) =>
		new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
	onStatus,
	readinessFn,
	acquireFn = acquireVmSlot,
} = {}) {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new RangeError("timeoutMs must be a non-negative number");
	}
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new RangeError("intervalMs must be a positive number");
	}
	if (typeof nowFn !== "function" || typeof sleepFn !== "function") {
		throw new TypeError("nowFn and sleepFn must be functions");
	}
	if (typeof acquireFn !== "function") {
		throw new TypeError("acquireFn must be a function");
	}
	if (readinessFn !== undefined && typeof readinessFn !== "function") {
		throw new TypeError("readinessFn must be a function");
	}

	const startedAt = nowFn();
	const deadline = startedAt + timeoutMs;
	let attempts = 0;
	let lastReason = "vm_slot_unavailable";
	for (;;) {
		attempts += 1;
		let readinessAvailable = true;
		try {
			const readiness = readinessFn ? await readinessFn() : true;
			if (
				readiness === false ||
				(readiness &&
					typeof readiness === "object" &&
					(readiness.ready === false ||
						readiness.status === "unavailable-with-proof"))
			) {
				lastReason =
					typeof readiness?.reason === "string" && readiness.reason.trim()
						? readiness.reason
						: "vm_host_not_ready";
				throw Object.assign(new Error(lastReason), {
					code: "VM_TEST_READINESS_UNAVAILABLE",
				});
			}
		} catch (error) {
			if (
				!testVmReadinessUnavailable(error) &&
				error?.code !== "VM_TEST_READINESS_UNAVAILABLE"
			) {
				throw error;
			}
			readinessAvailable = false;
			lastReason =
				error.code === "VM_TEST_READINESS_UNAVAILABLE"
					? String(error.message || "vm_host_not_ready").slice(0, 160)
					: error.code;
		}

		if (readinessAvailable) {
			try {
				const lease = await acquireFn({ runId });
				return {
					status: "executed",
					lease,
					attempts,
					elapsedMs: Math.max(0, nowFn() - startedAt),
				};
			} catch (error) {
				if (error?.code !== "VM_SLOT_UNAVAILABLE") throw error;
				lastReason = "vm_slot_unavailable";
			}
		}

		const remainingMs = Math.max(0, deadline - nowFn());
		const elapsedMs = Math.max(0, nowFn() - startedAt);
		onStatus?.({
			type: "vm-test-gate",
			event: "vm_slot_wait",
			status: "Waiting for VM admission capacity",
			elapsedMs,
			reason: lastReason,
		});
		if (remainingMs === 0) {
			return {
				status: "unavailable-with-proof",
				reason: lastReason,
				attempts,
				elapsedMs,
			};
		}
		await sleepFn(Math.min(intervalMs, remainingMs));
	}
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
		const stat = lstatSync(resolve(getRunRoot(runId), "boot-stderr.log"));
		return (
			ownerOnlyRegularFileStat(stat, MAX_DIAGNOSTIC_ARTIFACT_BYTES) &&
			stat.size > 0
		);
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

function checkpointArtifactTaskIds(checkpoint) {
	const ids = new Set();
	for (const taskId of checkpoint?.completedTaskIds ?? []) {
		if (typeof taskId === "string" && taskId.length > 0) ids.add(taskId);
	}
	for (const taskId of Object.keys(checkpoint?.taskAttempts ?? {}))
		ids.add(taskId);
	for (const taskId of Object.keys(checkpoint?.integrationIntents ?? {}))
		ids.add(taskId);
	for (const result of checkpoint?.results ?? []) {
		if (typeof result?.taskId === "string" && result.taskId.length > 0)
			ids.add(result.taskId);
	}
	return [...ids].sort((left, right) => right.length - left.length);
}

function checkpointArtifactResultAttempts(checkpoint, taskId) {
	const counts = new Map();
	let invalidCount = 0;
	for (const result of checkpoint?.results ?? []) {
		if (result?.taskId !== taskId) continue;
		if (!Number.isSafeInteger(result.attempt) || result.attempt < 1) {
			invalidCount += 1;
			continue;
		}
		counts.set(result.attempt, (counts.get(result.attempt) ?? 0) + 1);
	}
	return { counts, invalidCount };
}

function checkpointArtifactIdentity(name, checkpoint) {
	if (
		typeof name !== "string" ||
		(!name.endsWith(".diff") && !name.endsWith(".output"))
	) {
		return { disposition: "unknown", reason: "unknown_entry" };
	}
	const purpose = name.endsWith(".diff") ? "partial_diff" : "gate_evidence";
	const suffix = name.slice(0, -(purpose === "partial_diff" ? 5 : 7));
	const taskId = checkpointArtifactTaskIds(checkpoint).find(
		(candidate) =>
			suffix === candidate || suffix.startsWith(`${candidate}.attempt-`),
	);
	if (!taskId) return { disposition: "malformed", reason: "unknown_task" };
	const remainder = suffix.slice(taskId.length);
	let attempt = null;
	const resultEvidence = checkpointArtifactResultAttempts(checkpoint, taskId);
	const resultAttempts = resultEvidence.counts;
	const declared = checkpoint.taskAttempts?.[taskId];
	const declaredIsValid = Number.isSafeInteger(declared) && declared > 0;
	if (remainder === "") {
		// The original `<taskId>.<ext>` form has no attempt in its name.  It is
		// safe only when the checkpoint proves one unambiguous attempt.
		const uniqueResultAttempts = [...resultAttempts].filter(
			(attempt) => resultAttempts.get(attempt) === 1,
		);
		const resultEvidenceIsExact =
			resultEvidence.invalidCount === 0 &&
			resultAttempts.size === 1 &&
			uniqueResultAttempts.length === 1 &&
			declaredIsValid &&
			uniqueResultAttempts[0] === declared;
		if (!resultEvidenceIsExact && resultAttempts.size !== 0)
			return {
				disposition: "ambiguous",
				reason: "attempt_identity_ambiguous",
			};
		if (!resultEvidenceIsExact && !declaredIsValid)
			return {
				disposition: "ambiguous",
				reason: "attempt_identity_ambiguous",
			};
		attempt = resultEvidenceIsExact ? uniqueResultAttempts[0] : declared;
	} else {
		const match = /^\.attempt-(\d+)$/u.exec(remainder);
		if (!match || Number(match[1]) < 1)
			return { disposition: "malformed", reason: "malformed_name" };
		attempt = Number(match[1]);
	}
	if (!Number.isSafeInteger(attempt) || attempt < 1)
		return { disposition: "malformed", reason: "malformed_attempt" };
	if (
		resultEvidence.invalidCount !== 0 ||
		!declaredIsValid ||
		resultAttempts.get(attempt) !== 1 ||
		attempt > declared
	)
		return { disposition: "unknown", reason: "attempt_not_in_checkpoint" };
	return { disposition: "classified", taskId, attempt, purpose };
}

function checkpointArtifactPurpose(checkpoint, identity, terminal) {
	const taskId = identity.taskId;
	const completed = new Set(checkpoint.completedTaskIds ?? []);
	const pending = checkpoint.integrationIntents?.[taskId];
	const latest = [...(checkpoint.results ?? [])]
		.reverse()
		.find((result) => result?.taskId === taskId);
	if (
		!terminal ||
		!completed.has(taskId) ||
		pending?.status === "pending" ||
		(latest && latest.success !== true)
	)
		return {
			active: true,
			reason:
				pending?.status === "pending"
					? "active_reconciliation"
					: "current_review",
		};
	return { active: false, reason: "purpose_complete" };
}

function sameFilesystemIdentity(left, right) {
	return (
		left?.dev === right?.dev &&
		left?.ino === right?.ino &&
		left?.mode === right?.mode &&
		left?.uid === right?.uid
	);
}

function sameCheckpointArtifactIdentity(stat, identity, includeCtime = true) {
	return (
		ownerOnlyRegularFileStat(stat, CHECKPOINT_ARTIFACT_MAX_FILE_BYTES) &&
		stat.nlink === 1 &&
		stat.dev === identity.dev &&
		stat.ino === identity.ino &&
		stat.mode === identity.mode &&
		stat.uid === identity.uid &&
		stat.size === identity.size &&
		stat.mtimeMs === identity.mtimeMs &&
		(!includeCtime || stat.ctimeMs === identity.ctimeMs)
	);
}

function checkpointShapeIsUsable(checkpoint) {
	return (
		checkpoint &&
		typeof checkpoint === "object" &&
		!Array.isArray(checkpoint) &&
		Array.isArray(checkpoint.completedTaskIds) &&
		Array.isArray(checkpoint.results) &&
		checkpoint.taskAttempts &&
		typeof checkpoint.taskAttempts === "object" &&
		!Array.isArray(checkpoint.taskAttempts) &&
		checkpoint.integrationIntents &&
		typeof checkpoint.integrationIntents === "object" &&
		!Array.isArray(checkpoint.integrationIntents)
	);
}

async function readCheckpointArtifactSnapshot(checkpointPath) {
	const stat = await lstat(checkpointPath);
	if (!ownerOnlyRegularFileStat(stat, 64 * 1024 * 1024)) return null;
	const raw = await readFile(checkpointPath, "utf8");
	let checkpoint;
	try {
		checkpoint = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!checkpointShapeIsUsable(checkpoint)) return null;
	return {
		raw,
		checkpoint,
		identity: {
			dev: stat.dev,
			ino: stat.ino,
			mode: stat.mode,
			uid: stat.uid,
		},
	};
}

/**
 * Inspect and, when identity and terminal purpose are proven, bound the
 * checkpoint-adjacent review evidence directory.  Unknown, malformed,
 * ambiguous, and symlinked entries are reported and never passed to unlink.
 *
 * @param {string} checkpointPath
 * @param {object} options
 * @returns {Promise<{deletedCount:number, bytesDeleted:number, reports:Array<object>}>}
 */
export async function applyCheckpointArtifactRetention(
	checkpointPath,
	options = {},
) {
	const reports = [];
	const terminal = options.terminal === true;
	const dryRun = options.dryRun === true;
	const maxBytes = Number.isSafeInteger(options.maxBytes)
		? Math.max(0, options.maxBytes)
		: CHECKPOINT_ARTIFACT_MAX_BYTES;
	const maxEntries = Number.isSafeInteger(options.maxEntries)
		? Math.max(0, options.maxEntries)
		: CHECKPOINT_ARTIFACT_MAX_ENTRIES;
	if (typeof checkpointPath !== "string" || !isAbsolute(checkpointPath))
		return {
			deletedCount: 0,
			bytesDeleted: 0,
			reports: [
				{ disposition: "unknown", reason: "checkpoint_identity_unavailable" },
			],
		};
	const checkpointRoot = resolve(checkpointPath);
	let checkpointSnapshot;
	try {
		checkpointSnapshot = await readCheckpointArtifactSnapshot(checkpointRoot);
	} catch (error) {
		if (error?.code === "ENOENT")
			return { deletedCount: 0, bytesDeleted: 0, reports };
		checkpointSnapshot = null;
	}
	if (!checkpointSnapshot) {
		reports.push({
			disposition: "malformed",
			reason: "checkpoint_malformed",
		});
		return { deletedCount: 0, bytesDeleted: 0, reports };
	}
	const checkpoint = checkpointSnapshot.checkpoint;
	const checkpointRaw = checkpointSnapshot.raw;
	const checkpointIdentity = checkpointSnapshot.identity;
	const artifactsDir = `${checkpointRoot}.partial-diffs`;
	let artifactDirectoryIdentity;
	try {
		artifactDirectoryIdentity = await lstat(artifactsDir);
		if (!ownerOnlyDirectoryStat(artifactDirectoryIdentity)) {
			reports.push({
				disposition: "unsafe",
				reason: "artifact_directory_unsafe",
			});
			return { deletedCount: 0, bytesDeleted: 0, reports };
		}
	} catch (error) {
		if (error.code !== "ENOENT")
			reports.push({
				disposition: "unsafe",
				reason: "artifact_directory_unreadable",
			});
		return { deletedCount: 0, bytesDeleted: 0, reports };
	}
	let entries;
	try {
		entries = await readdir(artifactsDir, { withFileTypes: true });
	} catch (error) {
		if (error.code !== "ENOENT")
			reports.push({
				disposition: "unsafe",
				reason: "artifact_directory_unreadable",
			});
		return { deletedCount: 0, bytesDeleted: 0, reports };
	}
	const candidates = [];
	for (const entry of entries) {
		const artifactPath = resolve(artifactsDir, entry.name);
		const identity = checkpointArtifactIdentity(entry.name, checkpoint);
		if (identity.disposition !== "classified") {
			reports.push({
				name: sanitizeForDisplay(entry.name),
				...identity,
			});
			continue;
		}
		const purpose = checkpointArtifactPurpose(checkpoint, identity, terminal);
		let stat;
		try {
			stat = await lstat(artifactPath);
		} catch {
			reports.push({
				name: sanitizeForDisplay(entry.name),
				disposition: "unsafe",
				reason: "entry_unreadable",
			});
			continue;
		}
		if (
			!ownerOnlyRegularFileStat(stat, CHECKPOINT_ARTIFACT_MAX_FILE_BYTES) ||
			stat.nlink !== 1
		) {
			reports.push({
				name: sanitizeForDisplay(entry.name),
				disposition: "unsafe",
				reason: stat.isSymbolicLink()
					? "symlink"
					: stat.nlink !== 1
						? "hard_link"
						: "not_owner_regular",
			});
			continue;
		}
		if (purpose.active || !terminal) {
			reports.push({
				name: sanitizeForDisplay(entry.name),
				disposition: "protected",
				reason: purpose.reason,
			});
			continue;
		}
		candidates.push({
			path: artifactPath,
			name: entry.name,
			taskId: identity.taskId,
			attempt: identity.attempt,
			purpose: identity.purpose,
			artifactIdentity: {
				dev: stat.dev,
				ino: stat.ino,
				mode: stat.mode,
				uid: stat.uid,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				ctimeMs: stat.ctimeMs,
				nlink: stat.nlink,
			},
			parentIdentity: {
				dev: artifactDirectoryIdentity.dev,
				ino: artifactDirectoryIdentity.ino,
				mode: artifactDirectoryIdentity.mode,
				uid: artifactDirectoryIdentity.uid,
			},
		});
	}
	const totalBytes = candidates.reduce(
		(sum, candidate) => sum + candidate.artifactIdentity.size,
		0,
	);
	if (totalBytes <= maxBytes && candidates.length <= maxEntries) {
		for (const candidate of candidates)
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "retained",
				reason: "within_bound",
			});
		return { deletedCount: 0, bytesDeleted: 0, reports };
	}
	candidates.sort(
		(left, right) =>
			left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
	);
	let remainingBytes = totalBytes;
	let remainingEntries = candidates.length;
	let deletedCount = 0;
	let bytesDeleted = 0;
	for (const candidate of candidates) {
		if (remainingBytes <= maxBytes && remainingEntries <= maxEntries) {
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "retained",
				reason: "within_bound",
			});
			continue;
		}
		if (dryRun) {
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "would_delete",
				reason: "purpose_complete_bound",
			});
			remainingBytes -= candidate.artifactIdentity.size;
			remainingEntries -= 1;
			deletedCount += 1;
			bytesDeleted += candidate.artifactIdentity.size;
			continue;
		}
		try {
			await options.beforeDelete?.({
				name: candidate.name,
				path: candidate.path,
			});
			const currentCheckpoint =
				await readCheckpointArtifactSnapshot(checkpointRoot);
			if (
				!currentCheckpoint ||
				currentCheckpoint.raw !== checkpointRaw ||
				!sameFilesystemIdentity(currentCheckpoint.identity, checkpointIdentity)
			) {
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: "checkpoint_changed",
				});
				continue;
			}
			const reboundIdentity = checkpointArtifactIdentity(
				candidate.name,
				currentCheckpoint.checkpoint,
			);
			const reboundPurpose =
				reboundIdentity.disposition === "classified"
					? checkpointArtifactPurpose(
							currentCheckpoint.checkpoint,
							reboundIdentity,
							terminal,
						)
					: { active: true, reason: "checkpoint_changed" };
			if (
				reboundIdentity.disposition !== "classified" ||
				reboundIdentity.taskId !== candidate.taskId ||
				reboundIdentity.attempt !== candidate.attempt ||
				reboundIdentity.purpose !== candidate.purpose ||
				reboundPurpose.active
			) {
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: reboundPurpose.reason ?? "checkpoint_changed",
				});
				continue;
			}
			const currentParent = await lstat(dirname(candidate.path));
			if (
				!ownerOnlyDirectoryStat(currentParent) ||
				!sameFilesystemIdentity(currentParent, candidate.parentIdentity)
			) {
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: "parent_directory_changed",
				});
				continue;
			}
			// Recheck immediately before mutation; a replacement symlink or owner
			// change must fail closed without invoking unlink.
			const latest = await lstat(candidate.path);
			if (!sameCheckpointArtifactIdentity(latest, candidate.artifactIdentity)) {
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: "entry_changed",
				});
				continue;
			}
			await options.beforeClaim?.({
				name: candidate.name,
				path: candidate.path,
			});
			const claimPath = resolve(
				dirname(candidate.path),
				`.${candidate.name}.${randomUUID()}.retention-claim`,
			);
			await rename(candidate.path, claimPath);
			const claimed = await lstat(claimPath);
			if (
				!sameCheckpointArtifactIdentity(
					claimed,
					candidate.artifactIdentity,
					false,
				)
			) {
				let originalExists = true;
				try {
					await lstat(candidate.path);
				} catch (error) {
					if (error?.code === "ENOENT") originalExists = false;
					else throw error;
				}
				if (!originalExists) {
					const restoreParent = await lstat(dirname(candidate.path));
					if (
						ownerOnlyDirectoryStat(restoreParent) &&
						sameFilesystemIdentity(restoreParent, candidate.parentIdentity)
					)
						await rename(claimPath, candidate.path);
				}
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: "entry_changed",
				});
				continue;
			}
			await unlink(claimPath);
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "deleted",
				reason: "purpose_complete_bound",
			});
			remainingBytes -= candidate.artifactIdentity.size;
			remainingEntries -= 1;
			deletedCount += 1;
			bytesDeleted += candidate.artifactIdentity.size;
		} catch {
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "unsafe",
				reason: "delete_failed",
			});
		}
	}
	return { deletedCount, bytesDeleted, reports };
}

/**
 * Remove the CONTENTS of a run's artifacts directory, leaving the directory
 * itself in place. A future producer would create it and may hold an open
 * handle; removing it under one to save an inode is not a trade worth making.
 *
 * Collection is unconditional rather than age-gated: an artifact is raw
 * provider output at every age, and the age of the run that produced it does
 * not change that. A missing artifacts directory is not an error but the
 * normal case, since `initializeRun` no longer provisions one.
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
	const checkpointArtifacts = [];
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
		const checkpointPath = checkpointPathForRun(run);
		if (checkpointPath) {
			const artifactResult = await applyCheckpointArtifactRetention(
				checkpointPath,
				{
					terminal:
						(run.state === "succeeded" ||
							run.state === "failed" ||
							run.state === "deferred") &&
						run.cleanupState === "complete",
					dryRun,
					maxBytes: options.maxCheckpointArtifactBytes,
					maxEntries: options.maxCheckpointArtifactEntries,
				},
			);
			if (artifactResult.reports.length > 0) {
				checkpointArtifacts.push({
					checkpointPath: sanitizeForDisplay(checkpointPath),
					...artifactResult,
				});
			}
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

	return {
		deletedCount: deleted.size,
		collectedCount,
		quarantined,
		checkpointArtifacts,
	};
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

/**
 * Read retained events from an explicitly authorised run directory.  This is
 * intentionally not a discovery API: the caller supplies each root and the
 * filesystem object must be a bounded, owner-only, non-symlinked directory
 * and event file.  Invalid or legacy event shapes are rejected rather than
 * becoming durable health evidence.
 */
export async function readAuthorizedRunEvidence(runRoot) {
	if (typeof runRoot !== "string" || !isAbsolute(runRoot)) {
		throw new SchemaError("authorised run root must be absolute");
	}
	const root = resolve(runRoot);
	let rootStat;
	try {
		rootStat = await lstat(root);
	} catch (error) {
		throw new SchemaError(
			error?.code === "ENOENT"
				? "authorised run root missing"
				: "authorised run root unreadable",
		);
	}
	if (
		!rootStat.isDirectory() ||
		rootStat.isSymbolicLink() ||
		rootStat.uid !== process.getuid() ||
		(rootStat.mode & 0o077) !== 0
	) {
		throw new SchemaError("authorised run root is not owner-only");
	}
	const eventsPath = resolve(root, "events.jsonl");
	const runPath = resolve(root, "run.json");
	let runStat;
	try {
		runStat = await lstat(runPath);
	} catch {
		throw new SchemaError("authorised run projection missing");
	}
	if (
		!runStat.isFile() ||
		runStat.isSymbolicLink() ||
		runStat.uid !== process.getuid() ||
		(runStat.mode & 0o077) !== 0 ||
		runStat.size > 1024 * 1024
	) {
		throw new SchemaError("authorised run projection is not owner-only");
	}
	let run;
	try {
		run = JSON.parse(await readFile(runPath, "utf8"));
		validateRun(run);
	} catch {
		throw new SchemaError("authorised run projection is invalid");
	}
	let eventStat;
	try {
		eventStat = await lstat(eventsPath);
	} catch (error) {
		if (error?.code === "ENOENT") return { run, events: [] };
		throw new SchemaError("authorised events are unreadable");
	}
	if (
		!eventStat.isFile() ||
		eventStat.isSymbolicLink() ||
		eventStat.uid !== process.getuid() ||
		(eventStat.mode & 0o077) !== 0 ||
		eventStat.size > 4 * 1024 * 1024
	) {
		throw new SchemaError("authorised events are not owner-only");
	}
	const raw = await readFile(eventsPath, "utf8");
	const lines = raw.split("\n").filter(Boolean);
	if (lines.length > 10_000)
		throw new SchemaError("authorised events exceed limit");
	let sequence = 0;
	const events = lines.map((line) => {
		if (line.length > 32 * 1024)
			throw new SchemaError("authorised event exceeds limit");
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new SchemaError("authorised event contains invalid JSON");
		}
		if (
			!event ||
			typeof event !== "object" ||
			Array.isArray(event) ||
			Object.keys(event).some((key) => !APPROVED_EVENT_KEYS.has(key)) ||
			!Number.isSafeInteger(event.sequence) ||
			event.sequence <= sequence
		) {
			throw new SchemaError("authorised event schema is invalid");
		}
		sequence = event.sequence;
		if (event.routeHealthBinding !== undefined)
			validateRouteHealthBinding(event.routeHealthBinding);
		if (
			event.routeHealthBinding !== undefined &&
			(event.routeHealthBinding.runId !== run.runId ||
				event.routeHealthBinding.runRevision > run.revision ||
				event.phase !== "execution" ||
				!["task_completed", "task_failed"].includes(event.event) ||
				!run.orderedTaskIds.includes(event.taskId) ||
				!event.invocationDescriptor ||
				!isSafeDescriptorReceipt(
					event.invocationDescriptor,
					event.descriptorHarness,
				) ||
				event.invocationDescriptor.descriptor_identity !==
					event.descriptorIdentity ||
				event.invocationDescriptor.target_id !== event.resolvedTargetId)
		)
			throw new SchemaError("authorised route health event is invalid");
		return event;
	});
	if (sequence > run.lastEventSequence)
		throw new SchemaError("authorised event sequence exceeds run projection");
	return { run, events };
}

export async function readAuthorizedRunEvents(runRoot) {
	return (await readAuthorizedRunEvidence(runRoot)).events;
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
