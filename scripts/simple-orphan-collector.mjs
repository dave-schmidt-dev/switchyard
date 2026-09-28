import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRunLiveness } from "../src/switchyard/run-store/run-liveness.mjs";
import { cleanupSimpleWorktree } from "../src/switchyard/simple/worktree-cleanup.mjs";

function simplePathHeld(path, heldPaths) {
	return heldPaths.some((open) => open === path || open.startsWith(`${path}/`));
}
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

import "./simple-orphan-collector-scan.mjs";
import {
	classifySimpleRun,
	inspectSimpleTree,
	readSimpleMarker,
	readSimpleRunStore,
	SIMPLE_ORPHAN_TTL_MS,
	SIMPLE_PREFIX,
	SIMPLE_ROOT_RE,
} from "./simple-orphan-collector-scan.mjs";

export {
	listHeldPathsViaLsof,
	SIMPLE_ORPHAN_TTL_MS,
} from "./simple-orphan-collector-scan.mjs";
