#!/usr/bin/env node

/**
 * Evidence-checked collector for orphaned Switchyard simple roots. It is
 * intentionally separate from the broad legacy temp sweep and dry-runs unless
 * an operator explicitly selects apply mode.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRunLiveness } from "../src/switchyard/run-store/run-liveness.mjs";
import { cleanupSimpleWorktree } from "../src/switchyard/simple/worktree-cleanup.mjs";

const SIMPLE_PREFIX = "switchyard-simple-";
/** One-day grace period for crashed or killed simple runs. */
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
/**
 * Inspect every descendant without following links. A link or unreadable node
 * makes the candidate ineligible because its complete age and size are not
 * known.
 * @param {string} root
 * @returns {{newestMs:number,bytes:number}|null}
 */
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
			stat.isSymbolicLink() ||
			(!stat.isDirectory() && !stat.isFile()) ||
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

/**
 * Load the run index used by the orphan collector. A directory without a
 * top-level run record is indexed by id and blocks only a candidate bearing
 * that same owner id; unreadable or malformed records still fail closed.
 * @param {string} stateRoot
 * @returns {{byId:Map<string,object>,byPath:Map<string,object>,unknownIds:Set<string>}}
 */
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
	if (worktree.state === "retained") return "retained";
	const liveness = classifyRunLiveness(byId, { now });
	return liveness === "dead" || liveness === "terminal_clean"
		? "eligible"
		: "active";
}

function simplePathHeld(path, heldPaths) {
	return heldPaths.some((open) => open === path || open.startsWith(`${path}/`));
}

/**
 * Dry-run by default. Only exact UUID roots with a valid ownership marker,
 * complete run-store and lsof evidence, and a full-tree age of at least one
 * day can be counted as collectible. Applying delegates to the existing
 * quarantine and descriptor-bound removal helper.
 * @param {object} [options]
 * @param {string} [options.tmpDir]
 * @param {string} [options.stateRoot]
 * @param {boolean} [options.apply]
 * @param {number} [options.now]
 * @param {() => (string[] | null)} [options.listHeldPaths]
 * @param {(message:string) => void} [options.log]
 * @param {(message:string) => void} [options.progress]
 * @returns {Promise<{status:number,summary:object}>}
 */
export async function sweepSimpleOrphans({
	tmpDir = tmpdir(),
	stateRoot = process.env.SWITCHYARD_RUN_STORE_ROOT ?? DEFAULT_RUN_STORE_ROOT,
	apply = false,
	now = Date.now(),
	listHeldPaths = listHeldPathsViaLsof,
	log = console.log,
	progress = (message) => process.stderr.write(`${message}\n`),
} = {}) {
	const summary = {
		tmpDir,
		apply,
		ttlMs: SIMPLE_ORPHAN_TTL_MS,
		candidates: 0,
		legacyInventory: 0,
		wouldRemove: 0,
		removed: 0,
		apparentBytes: 0,
		skippedFresh: 0,
		skippedHeld: 0,
		skippedActive: 0,
		skippedRetained: 0,
		skippedMarker: 0,
		skippedRecordMismatch: 0,
		skippedRecordUnavailable: 0,
		skippedSymlink: 0,
		skippedUnreadable: 0,
		retained: 0,
		refused: 0,
		failed: 0,
	};

	let canonicalTmp;
	let runIndex;
	let held;
	try {
		canonicalTmp = realpathSync(tmpDir);
		runIndex = readSimpleRunStore(resolve(stateRoot));
		log("simple-orphans: checking open handles");
		held = listHeldPaths();
	} catch {
		log(
			"simple-orphans: temp directory or run store unavailable; refusing collection",
		);
		return { status: 1, summary };
	}
	if (held === null) {
		log(
			"simple-orphans: lsof unavailable; refusing collection without a complete open-handle check",
		);
		return { status: 1, summary };
	}

	let names;
	try {
		names = readdirSync(canonicalTmp);
	} catch {
		log("simple-orphans: cannot read temp directory; refusing collection");
		return { status: 1, summary };
	}
	const canonicalRoots = names.filter((name) => SIMPLE_ROOT_RE.test(name));
	summary.candidates = canonicalRoots.length;
	summary.legacyInventory = names.filter(
		(name) => name.startsWith(SIMPLE_PREFIX) && !SIMPLE_ROOT_RE.test(name),
	).length;
	const cutoffMs = now - SIMPLE_ORPHAN_TTL_MS;
	progress(`simple-orphans: scanning uuid roots=${canonicalRoots.length}`);

	for (let index = 0; index < canonicalRoots.length; index += 1) {
		if (index > 0 && index % 10 === 0) {
			progress(
				`simple-orphans: progress rootsChecked=${index}/${canonicalRoots.length}`,
			);
		}
		const name = canonicalRoots[index];
		const path = join(canonicalTmp, name);
		let rootStat;
		let owner;
		let canonicalPath;
		try {
			rootStat = lstatSync(path);
			if (rootStat.isSymbolicLink()) {
				summary.skippedSymlink += 1;
				continue;
			}
			if (
				!rootStat.isDirectory() ||
				(typeof process.getuid === "function" &&
					rootStat.uid !== process.getuid())
			) {
				summary.skippedUnreadable += 1;
				continue;
			}
			canonicalPath = realpathSync(path);
			if (
				canonicalPath !== path ||
				dirname(canonicalPath) !== canonicalTmp ||
				basename(canonicalPath) !== name
			) {
				summary.refused += 1;
				continue;
			}
			owner = readSimpleMarker(canonicalPath);
		} catch {
			summary.skippedMarker += 1;
			continue;
		}
		const tree = inspectSimpleTree(canonicalPath, (visited) =>
			progress(`simple-orphans: scanned candidate entries=${visited}`),
		);
		if (!tree) {
			summary.skippedUnreadable += 1;
			continue;
		}
		if (tree.newestMs > cutoffMs) {
			summary.skippedFresh += 1;
			continue;
		}
		if (simplePathHeld(canonicalPath, held)) {
			summary.skippedHeld += 1;
			continue;
		}
		const disposition = classifySimpleRun(
			canonicalPath,
			rootStat,
			owner,
			runIndex,
			now,
		);
		if (disposition === "active") {
			summary.skippedActive += 1;
			continue;
		}
		if (disposition === "retained") {
			summary.skippedRetained += 1;
			continue;
		}
		if (disposition === "record_mismatch") {
			summary.skippedRecordMismatch += 1;
			continue;
		}
		if (disposition === "record_unavailable") {
			summary.skippedRecordUnavailable += 1;
			continue;
		}

		if (apply) {
			let currentRunIndex;
			let currentHeld;
			try {
				currentRunIndex = readSimpleRunStore(resolve(stateRoot));
				log("simple-orphans: rechecking run-store and open handles");
				currentHeld = listHeldPaths();
			} catch {
				summary.failed += 1;
				break;
			}
			if (currentHeld === null) {
				summary.failed += 1;
				break;
			}
			if (simplePathHeld(canonicalPath, currentHeld)) {
				summary.skippedHeld += 1;
				continue;
			}
			const currentTree = inspectSimpleTree(canonicalPath, (visited) =>
				progress(`simple-orphans: rescanned candidate entries=${visited}`),
			);
			if (!currentTree) {
				summary.skippedUnreadable += 1;
				continue;
			}
			if (currentTree.newestMs > cutoffMs) {
				summary.skippedFresh += 1;
				continue;
			}
			const currentDisposition = classifySimpleRun(
				canonicalPath,
				rootStat,
				owner,
				currentRunIndex,
				now,
			);
			if (currentDisposition !== "eligible") {
				if (currentDisposition === "active") summary.skippedActive += 1;
				else if (currentDisposition === "retained")
					summary.skippedRetained += 1;
				else if (currentDisposition === "record_unavailable")
					summary.skippedRecordUnavailable += 1;
				else summary.skippedRecordMismatch += 1;
				continue;
			}
			try {
				const currentRootStat = lstatSync(canonicalPath);
				const currentMarker = readSimpleMarker(canonicalPath);
				if (
					currentRootStat.isSymbolicLink() ||
					currentRootStat.dev !== rootStat.dev ||
					currentRootStat.ino !== rootStat.ino ||
					currentMarker.stat.dev !== owner.stat.dev ||
					currentMarker.stat.ino !== owner.stat.ino ||
					owner.text !== currentMarker.text ||
					realpathSync(canonicalPath) !== canonicalPath
				) {
					summary.refused += 1;
					continue;
				}
			} catch {
				summary.failed += 1;
				continue;
			}
			const claim = {
				canonicalParent: canonicalTmp,
				candidateChild: name,
				path: canonicalPath,
				device: String(rootStat.dev),
				inode: String(rootStat.ino),
				nonce: owner.marker.nonce,
			};
			const removal = await cleanupSimpleWorktree(owner.marker.runId, claim, {
				writerStopped: true,
				onStatus: (phase) => log(`simple-orphans: ${phase}`),
				postQuarantineCheck: async (quarantinePath) => {
					const latestIndex = readSimpleRunStore(resolve(stateRoot));
					if (
						classifySimpleRun(
							canonicalPath,
							rootStat,
							owner,
							latestIndex,
							now,
						) !== "eligible"
					)
						return false;
					const latestTree = inspectSimpleTree(quarantinePath, (visited) =>
						progress(
							`simple-orphans: rechecked quarantined entries=${visited}`,
						),
					);
					return Boolean(latestTree && latestTree.newestMs <= cutoffMs);
				},
			});
			if (removal.removed) {
				summary.removed += 1;
				summary.apparentBytes += tree.bytes;
			} else {
				summary.retained += 1;
			}
		} else {
			summary.wouldRemove += 1;
			summary.apparentBytes += tree.bytes;
		}
	}

	log(
		`simple-orphans ${apply ? "applied" : "dry-run"}: uuidRoots=${summary.candidates} ` +
			`legacyInventory=${summary.legacyInventory} ` +
			`${apply ? "removed" : "wouldRemove"}=${apply ? summary.removed : summary.wouldRemove} ` +
			`apparentBytes=${summary.apparentBytes} held=${summary.skippedHeld} ` +
			`active=${summary.skippedActive} retained=${summary.skippedRetained} ` +
			`fresh=${summary.skippedFresh} marker=${summary.skippedMarker} ` +
			`recordMismatch=${summary.skippedRecordMismatch} ` +
			`recordUnavailable=${summary.skippedRecordUnavailable} symlink=${summary.skippedSymlink} ` +
			`unreadable=${summary.skippedUnreadable} cleanupRetained=${summary.retained} ` +
			`refused=${summary.refused} failed=${summary.failed}`,
	);
	return {
		status:
			summary.failed > 0 ||
			(apply && (summary.retained > 0 || summary.refused > 0))
				? 1
				: 0,
		summary,
	};
}
