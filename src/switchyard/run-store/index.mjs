import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const defaultStateRoot = resolve(
	__dirname,
	"..",
	"..",
	"..",
	".logs",
	"switchyard",
);

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

const CURRENT_SCHEMA_VERSION = 1;

const DEFAULT_LEASE_AGE_MS = 60_000;

function validateRunId(runId) {
	if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
		throw new SchemaError(`Invalid runId: ${runId}`);
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
	if (data.schemaVersion !== CURRENT_SCHEMA_VERSION) {
		throw new SchemaError(
			`Unsupported schemaVersion: ${data.schemaVersion} (expected ${CURRENT_SCHEMA_VERSION})`,
		);
	}
	if (typeof data.runId !== "string") {
		throw new SchemaError("runId must be a string");
	}
	if (typeof data.state !== "string" || !VALID_STATES.has(data.state)) {
		throw new SchemaError(`Invalid state: ${data.state}`);
	}
	if (
		typeof data.cleanupState !== "string" ||
		!VALID_CLEANUP_STATES.has(data.cleanupState)
	) {
		throw new SchemaError(`Invalid cleanupState: ${data.cleanupState}`);
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
	const snapshot = {
		schemaVersion: CURRENT_SCHEMA_VERSION,
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
		terminalSummary: null,
		cleanupError: null,
		lastLeaseHeartbeat: now,
		lastEventSequence: 0,
		launchArgs,
	};

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
			throw new Error(`Run not found: ${runId}`);
		}
		throw e;
	}

	let data;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		throw new SchemaError(
			`Invalid JSON in run.json for ${runId}: ${e.message}`,
		);
	}

	if (data === null || typeof data !== "object") {
		throw new SchemaError(`run.json for ${runId} is not a valid object`);
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
	const runDir = getRunRoot(runId);
	const eventsPath = resolve(runDir, "events.jsonl");

	let current = await readRun(runId);
	const nextSeq = current.lastEventSequence + 1;

	const entry = {
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

/**
 * Apply retention policy to completed runs.
 * Deletes runs where state is "succeeded" AND cleanupState is "complete".
 * Never touches non-terminal or cleanup-failed runs.
 *
 * @param {object} options
 * @param {number} [options.maxRuns] - maximum number of completed runs to keep
 * @param {number} [options.maxAgeDays] - maximum age in days for completed runs
 * @param {string} [options.now] - reference ISO timestamp (default: now)
 * @returns {Promise<number>} number of runs deleted
 */
export async function applyRetention(options = {}) {
	const { maxRuns, maxAgeDays, now } = options;
	const referenceTime = now ? new Date(now).getTime() : Date.now();

	let entries;
	try {
		entries = await readdir(runsRoot(), { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return 0;
		throw e;
	}

	const eligible = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const run = await readRun(entry.name);
			if (run.state === "succeeded" && run.cleanupState === "complete") {
				eligible.push({
					runId: entry.name,
					createdAt: new Date(run.createdAt).getTime(),
				});
			}
		} catch (e) {
			console.warn(`Failed to read run ${entry.name}: ${e.message}`);
		}
	}

	eligible.sort((a, b) => a.createdAt - b.createdAt);

	const deleted = new Set();

	if (maxAgeDays != null && Number.isFinite(maxAgeDays)) {
		const cutoff = referenceTime - maxAgeDays * 86_400_000;
		for (const r of eligible) {
			if (r.createdAt < cutoff) {
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
			try {
				await rm(getRunRoot(r.runId), { recursive: true, force: true });
				deleted.add(r.runId);
			} catch (e) {
				console.warn(`Failed to delete run ${r.runId}: ${e.message}`);
			}
		}
	}

	return deleted.size;
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

export { LockError, RevisionError, SchemaError };
