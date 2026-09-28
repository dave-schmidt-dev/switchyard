import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRunLiveness } from "../src/switchyard/run-store/run-liveness.mjs";

const SIMPLE_PREFIX = "switchyard-simple-";
export const SIMPLE_ORPHAN_TTL_MS = 86_400_000;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIMPLE_ROOT_RE = new RegExp(
	`^${SIMPLE_PREFIX}(${UUID_RE.source.slice(1, -1)})$`,
);
const SIMPLE_MARKER = ".switchyard-cleanup-owner.json";
const VALID_RUN_STATES = new Set([
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
const LSOF_TIMEOUT_MS = 30_000;
const LSOF_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const LSOF_ENV = Object.freeze({
	LANG: "C",
	LC_ALL: "C",
	PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
});
const DEFAULT_RUN_STORE_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	".logs",
	"switchyard",
);
function parseLsofResult(result) {
	if (
		result.error ||
		typeof result.stdout !== "string" ||
		!result.stdout ||
		result.status !== 0
	)
		return null;
	if (
		/incomplete|WARNING/i.test(
			typeof result.stderr === "string" ? result.stderr : "",
		)
	)
		return null;
	const held = [];
	for (const line of result.stdout.split("\n"))
		if (line.startsWith("n/")) held.push(line.slice(1));
	return held;
}
export function listHeldPathsViaLsof(run = spawnSync) {
	return parseLsofResult(
		run("/usr/sbin/lsof", ["-Fn"], {
			encoding: "utf8",
			timeout: LSOF_TIMEOUT_MS,
			killSignal: "SIGKILL",
			maxBuffer: LSOF_MAX_BUFFER_BYTES,
			env: { ...LSOF_ENV },
		}),
	);
}
function inspectSimpleTree(root, onProgress = () => {}) {
	let newestMs = 0;
	let bytes = 0;
	let visited = 0;
	let lastProgressAt = Date.now();
	let rootDevice = null;
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		let stat;
		try {
			stat = lstatSync(current);
		} catch {
			return null;
		}
		if (
			(current === root && !stat.isDirectory()) ||
			(!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) ||
			(rootDevice !== null && rootDevice !== stat.dev)
		)
			return null;
		rootDevice ??= stat.dev;
		visited += 1;
		if (visited % 1000 === 0 && Date.now() - lastProgressAt >= 5000) {
			lastProgressAt = Date.now();
			try {
				onProgress(visited);
			} catch {}
		}
		newestMs = Math.max(newestMs, stat.mtimeMs);
		bytes += stat.size;
		if (!stat.isDirectory()) continue;
		let entries;
		try {
			entries = readdirSync(current);
		} catch {
			return null;
		}
		for (const entry of entries) pending.push(join(current, entry));
	}
	return { newestMs, bytes };
}
function readSimpleRunStore(stateRoot) {
	const rootStat = lstatSync(stateRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error("invalid run-store root");
	}
	const canonicalRoot = realpathSync(stateRoot);
	const runsPath = join(canonicalRoot, "runs");
	const runsStat = lstatSync(runsPath);
	if (!runsStat.isDirectory() || runsStat.isSymbolicLink()) {
		throw new Error("invalid run-store runs directory");
	}
	const canonicalRuns = realpathSync(runsPath);
	if (dirname(canonicalRuns) !== canonicalRoot) {
		throw new Error("replaced run-store runs directory");
	}

	const byId = new Map();
	const byPath = new Map();
	const unknownIds = new Set();
	for (const entry of readdirSync(canonicalRuns, { withFileTypes: true })) {
		if (
			!entry.isDirectory() ||
			entry.isSymbolicLink() ||
			!/^[\w-]+$/.test(entry.name)
		) {
			throw new Error("invalid run-store entry");
		}
		const runDir = join(canonicalRuns, entry.name);
		const runDirStat = lstatSync(runDir);
		if (!runDirStat.isDirectory() || runDirStat.isSymbolicLink()) {
			throw new Error("replaced run-store entry");
		}
		if (realpathSync(runDir) !== runDir)
			throw new Error("replaced run-store entry");
		const recordPath = join(runDir, "run.json");
		let recordStat;
		try {
			recordStat = lstatSync(recordPath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			unknownIds.add(entry.name);
			continue;
		}
		if (
			!recordStat.isFile() ||
			recordStat.isSymbolicLink() ||
			recordStat.nlink !== 1 ||
			recordStat.size > 16 * 1024 * 1024
		) {
			throw new Error("invalid run record");
		}
		const recordText = readFileSync(recordPath, "utf8");
		const record = JSON.parse(recordText);
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			record.runId !== entry.name ||
			!VALID_RUN_STATES.has(record.state) ||
			!VALID_CLEANUP_STATES.has(record.cleanupState) ||
			typeof record.createdAt !== "string" ||
			!Number.isFinite(Date.parse(record.createdAt)) ||
			(record.workerPid !== undefined &&
				record.workerPid !== null &&
				(!Number.isSafeInteger(record.workerPid) || record.workerPid <= 0))
		) {
			throw new Error("corrupt run record");
		}
		let worktree = null;
		if (record.worktree !== undefined && record.worktree !== null) {
			worktree = record.worktree;
			if (
				!worktree ||
				typeof worktree !== "object" ||
				Array.isArray(worktree) ||
				!VALID_WORKTREE_STATES.has(worktree.state) ||
				typeof worktree.path !== "string" ||
				typeof worktree.canonicalParent !== "string" ||
				!isAbsolute(worktree.canonicalParent) ||
				!worktree.candidateChild ||
				worktree.candidateChild.includes("/") ||
				worktree.candidateChild.includes("\\") ||
				worktree.candidateChild === "." ||
				worktree.candidateChild === ".." ||
				resolve(worktree.canonicalParent, worktree.candidateChild) !==
					worktree.path
			) {
				throw new Error("corrupt worktree record");
			}
			if (
				(worktree.nonce !== undefined && !UUID_RE.test(worktree.nonce)) ||
				(worktree.device !== undefined && !/^[0-9]+$/.test(worktree.device)) ||
				(worktree.inode !== undefined && !/^[0-9]+$/.test(worktree.inode))
			) {
				throw new Error("corrupt worktree identity");
			}
			if (byPath.has(worktree.path))
				throw new Error("duplicate worktree record");
		}
		const indexed = {
			runId: record.runId,
			state: record.state,
			cleanupState: record.cleanupState,
			createdAt: record.createdAt,
			workerPid: record.workerPid,
			worktree,
		};
		byId.set(record.runId, indexed);
		if (worktree) byPath.set(worktree.path, indexed);
	}
	return { byId, byPath, unknownIds };
}
function readSimpleMarker(root) {
	const markerPath = join(root, SIMPLE_MARKER);
	const stat = lstatSync(markerPath);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
		(stat.mode & 0o177) !== 0 ||
		stat.nlink !== 1 ||
		stat.size > 4096
	) {
		throw new Error("invalid owner marker");
	}
	const text = readFileSync(markerPath, "utf8");
	const marker = JSON.parse(text);
	if (
		!marker ||
		typeof marker !== "object" ||
		Array.isArray(marker) ||
		Object.keys(marker).sort().join(",") !== "nonce,runId" ||
		typeof marker.runId !== "string" ||
		!/^[\w-]{1,128}$/.test(marker.runId) ||
		!UUID_RE.test(marker.nonce) ||
		text !== `${JSON.stringify(marker)}\n`
	) {
		throw new Error("invalid owner marker");
	}
	return { marker, stat, text };
}
function classifySimpleRun(candidatePath, rootStat, owner, runIndex, now) {
	const byId = runIndex.byId.get(owner.marker.runId) ?? null;
	const byPath = runIndex.byPath.get(candidatePath) ?? null;
	if (byPath && byPath.runId !== owner.marker.runId) return "record_mismatch";
	if (!byId) {
		if (byPath) return "record_mismatch";
		return runIndex.unknownIds.has(owner.marker.runId)
			? "record_unavailable"
			: "eligible";
	}
	const worktree = byId.worktree;
	if (!worktree || worktree.path !== candidatePath) return "record_mismatch";
	if (
		(worktree.nonce !== undefined && worktree.nonce !== owner.marker.nonce) ||
		(worktree.device !== undefined &&
			worktree.device !== String(rootStat.dev)) ||
		(worktree.inode !== undefined && worktree.inode !== String(rootStat.ino))
	) {
		return "record_mismatch";
	}
	const liveness = classifyRunLiveness(byId, { now });
	if (worktree.state === "retained") {
		// A retained salvage root needs the durable identity fields, not just a
		// matching path and marker, before it can enter guarded collection.
		if (
			worktree.nonce == null ||
			worktree.device == null ||
			worktree.inode == null
		)
			return "retained";
		const retainedMs =
			typeof worktree.retainedAt === "string"
				? Date.parse(worktree.retainedAt)
				: NaN;
		if (
			!Number.isFinite(retainedMs) ||
			new Date(retainedMs).toISOString() !== worktree.retainedAt ||
			retainedMs > now - SIMPLE_ORPHAN_TTL_MS
		)
			return "retained";
		return liveness === "dead" || liveness === "terminal_clean"
			? "eligible"
			: "retained";
	}
	return liveness === "dead" || liveness === "terminal_clean"
		? "eligible"
		: "active";
}

export {
	classifySimpleRun,
	DEFAULT_RUN_STORE_ROOT,
	inspectSimpleTree,
	LSOF_ENV,
	LSOF_MAX_BUFFER_BYTES,
	LSOF_TIMEOUT_MS,
	parseLsofResult,
	readSimpleMarker,
	readSimpleRunStore,
	SIMPLE_MARKER,
	SIMPLE_PREFIX,
	SIMPLE_ROOT_RE,
	UUID_RE,
	VALID_CLEANUP_STATES,
	VALID_RUN_STATES,
	VALID_WORKTREE_STATES,
};
