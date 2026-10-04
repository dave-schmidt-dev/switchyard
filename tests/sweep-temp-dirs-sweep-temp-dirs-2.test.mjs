import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import {
	parseSweepArgs,
	SIMPLE_ORPHAN_TTL_MS,
	sweepSimpleOrphans,
} from "../scripts/sweep-temp-dirs.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const DAY = 86_400_000;
/** Fixed so age is measured against an injected clock, never the real one. */
const NOW = Date.parse("2026-09-04T17:00:00Z");

const silent = () => {};

const noneHeld = () => [];

const makeRunStore = (parent) => {
	const root = join(parent, "state");
	mkdirSync(join(root, "runs"), { recursive: true });
	return root;
};

const addRunRecord = (root, runId, state, worktree, overrides = {}) => {
	const dir = join(root, "runs", runId);
	mkdirSync(dir, { recursive: true });
	const terminal = ["succeeded", "failed", "deferred"].includes(state);
	writeFileSync(
		join(dir, "run.json"),
		JSON.stringify({
			runId,
			state,
			cleanupState: terminal ? "complete" : "pending",
			createdAt: new Date(NOW).toISOString(),
			workerPid: state === "running" ? process.pid : null,
			worktree,
			...overrides,
		}),
	);
};

function makeSimpleRoot(
	parent,
	suffix,
	runId = `simple-task-${suffix}`,
	ageMs = SIMPLE_ORPHAN_TTL_MS + 1,
) {
	const root = join(parent, `switchyard-simple-${suffix}`);
	mkdirSync(root);
	const nonce = randomUUID();
	const marker = join(root, ".switchyard-cleanup-owner.json");
	const payload = join(root, "payload.txt");
	writeFileSync(marker, `${JSON.stringify({ runId, nonce })}\n`, {
		mode: 0o600,
	});
	writeFileSync(payload, "orphan fixture");
	const at = new Date(NOW - ageMs);
	for (const path of [marker, payload, root]) utimesSync(path, at, at);
	return { root, nonce, runId };
}

function worktreeRecord(root, parent, nonce, state) {
	const stat = lstatSync(root);
	return {
		canonicalParent: realpathSync(parent),
		candidateChild: basename(root),
		path: realpathSync(root),
		state,
		...(state === "retained"
			? { retainedAt: new Date(NOW - 2 * DAY).toISOString() }
			: {}),
		nonce,
		device: String(stat.dev),
		inode: String(stat.ino),
	};
}

const collectSimple = (tmpDir, stateRoot, options = {}) =>
	sweepSimpleOrphans({
		tmpDir,
		stateRoot,
		now: NOW,
		listHeldPaths: noneHeld,
		log: silent,
		progress: options.progress ?? silent,
		...options,
	});

describe("sweep-temp-dirs", () => {
	it("allows an old dead retained root with a symlink without following its target", async () => {
		const parent = tempDir("switchyard-simple-orphan-retained-link-");
		const stateRoot = makeRunStore(parent);
		const retained = makeSimpleRoot(
			parent,
			"bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
		);
		const outside = join(parent, "outside.txt");
		writeFileSync(outside, "outside remains");
		const link = join(retained.root, "outside-link");
		symlinkSync(outside, link);
		const oldAt = new Date(NOW - SIMPLE_ORPHAN_TTL_MS - 1);
		lutimesSync(link, oldAt, oldAt);
		utimesSync(retained.root, oldAt, oldAt);
		addRunRecord(
			stateRoot,
			retained.runId,
			"failed",
			worktreeRecord(retained.root, parent, retained.nonce, "retained"),
			{
				cleanupState: "pending",
				workerPid: null,
				createdAt: oldAt.toISOString(),
			},
		);
		const { status, summary } = await collectSimple(parent, stateRoot);
		deepStrictEqual(
			[
				status,
				summary.wouldRemove,
				summary.skippedRetained,
				summary.skippedUnreadable,
			],
			[0, 1, 0, 0],
		);
		strictEqual(readFileSync(outside, "utf8"), "outside remains");
		ok(existsSync(retained.root), "dry-run keeps the retained root");
		lutimesSync(link, new Date(NOW), new Date(NOW));
		const freshLink = await collectSimple(parent, stateRoot);
		deepStrictEqual(
			[freshLink.summary.skippedFresh, freshLink.summary.wouldRemove],
			[1, 0],
		);
		lutimesSync(link, oldAt, oldAt);
		const applied = await collectSimple(parent, stateRoot, { apply: true });
		deepStrictEqual([applied.status, applied.summary.removed], [0, 1]);
		strictEqual(existsSync(retained.root), false);
		strictEqual(readFileSync(outside, "utf8"), "outside remains");
	});
	it("keeps an old retained tree until its retention is at least one day old", async () => {
		const parent = tempDir("switchyard-simple-orphan-retention-age-");
		const stateRoot = makeRunStore(parent);
		const retained = makeSimpleRoot(
			parent,
			"eeeeeeee-ffff-4000-8111-222222222222",
		);
		const worktree = worktreeRecord(
			retained.root,
			parent,
			retained.nonce,
			"retained",
		);
		worktree.retainedAt = new Date(NOW - 60_000).toISOString();
		addRunRecord(stateRoot, retained.runId, "failed", worktree);
		const recent = await collectSimple(parent, stateRoot);
		deepStrictEqual(
			[
				recent.status,
				recent.summary.skippedRetained,
				recent.summary.wouldRemove,
			],
			[0, 1, 0],
		);
		worktree.retainedAt = "not-a-date";
		addRunRecord(stateRoot, retained.runId, "failed", worktree);
		const malformed = await collectSimple(parent, stateRoot);
		deepStrictEqual(
			[
				malformed.status,
				malformed.summary.skippedRetained,
				malformed.summary.wouldRemove,
			],
			[0, 1, 0],
		);
		ok(existsSync(retained.root));
	});
	it("refuses a retained root whose recorded inode no longer matches", async () => {
		const parent = tempDir("switchyard-simple-orphan-retained-identity-");
		const stateRoot = makeRunStore(parent);
		const retained = makeSimpleRoot(
			parent,
			"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		);
		const worktree = worktreeRecord(
			retained.root,
			parent,
			retained.nonce,
			"retained",
		);
		worktree.inode = String(BigInt(worktree.inode) + 1n);
		addRunRecord(stateRoot, retained.runId, "failed", worktree);
		const result = await collectSimple(parent, stateRoot, { apply: true });
		deepStrictEqual(
			[
				result.status,
				result.summary.skippedRecordMismatch,
				result.summary.removed,
			],
			[0, 1, 0],
		);
		ok(existsSync(retained.root));
	});
	it("keeps retained roots with a live worker or incomplete durable identity", async () => {
		const parent = tempDir("switchyard-simple-orphan-retained-guards-");
		const stateRoot = makeRunStore(parent);
		const live = makeSimpleRoot(parent, "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa");
		const legacy = makeSimpleRoot(
			parent,
			"dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb",
		);
		addRunRecord(
			stateRoot,
			live.runId,
			"failed",
			worktreeRecord(live.root, parent, live.nonce, "retained"),
			{ cleanupState: "pending", workerPid: process.pid },
		);
		const incomplete = worktreeRecord(
			legacy.root,
			parent,
			legacy.nonce,
			"retained",
		);
		delete incomplete.nonce;
		delete incomplete.device;
		delete incomplete.inode;
		addRunRecord(stateRoot, legacy.runId, "failed", incomplete);
		const { status, summary } = await collectSimple(parent, stateRoot);
		deepStrictEqual(
			[status, summary.skippedRetained, summary.wouldRemove],
			[0, 2, 0],
		);
		ok(existsSync(live.root) && existsSync(legacy.root));
	});
	it("allows an old active root after its recorded worker is proven dead", async () => {
		const parent = tempDir("switchyard-simple-orphan-dead-worker-");
		const stateRoot = makeRunStore(parent);
		const orphan = makeSimpleRoot(
			parent,
			"66666666-7777-4888-8999-aaaaaaaaaaaa",
		);
		addRunRecord(
			stateRoot,
			orphan.runId,
			"running",
			worktreeRecord(orphan.root, parent, orphan.nonce, "active"),
			{ workerPid: null, createdAt: new Date(NOW - 10 * 60_000).toISOString() },
		);
		const { status, summary } = await collectSimple(parent, stateRoot);
		deepStrictEqual(
			[status, summary.skippedActive, summary.wouldRemove],
			[0, 0, 1],
		);
		ok(existsSync(orphan.root), "dry-run keeps the fixture on disk");
	});
	it("honors full-tree TTL and canonical open-handle evidence", async () => {
		const parent = tempDir("switchyard-simple-orphan-guards-");
		const stateRoot = makeRunStore(parent);
		const fresh = makeSimpleRoot(
			parent,
			"44444444-5555-4666-8777-888888888888",
			undefined,
			SIMPLE_ORPHAN_TTL_MS - 1,
		);
		const held = makeSimpleRoot(parent, "55555555-6666-4777-8888-999999999999");
		const { summary } = await collectSimple(parent, stateRoot, {
			listHeldPaths: () => [join(realpathSync(held.root), "payload.txt")],
		});
		deepStrictEqual(
			[summary.skippedFresh, summary.skippedHeld, summary.wouldRemove],
			[1, 1, 0],
		);
		ok(existsSync(fresh.root) && existsSync(held.root));
	});
	it("fails closed for corrupt relevant records and skips malformed markers", async () => {
		const parent = tempDir("switchyard-simple-orphan-evidence-");
		const unknownRunId = "broken-simple-run";
		const orphan = makeSimpleRoot(
			parent,
			"66666666-7777-4888-8999-aaaaaaaaaaaa",
			unknownRunId,
		);
		const unrelated = makeSimpleRoot(
			parent,
			"77777777-8888-4999-8aaa-bbbbbbbbbbbb",
		);
		const missing = await collectSimple(parent, join(parent, "missing"));
		strictEqual(missing.status, 1);
		strictEqual(missing.summary.wouldRemove, 0);
		const stateRoot = makeRunStore(parent);
		const runs = join(stateRoot, "runs");
		const legacyRunId = "legacy-run-without-record";
		const legacyDir = join(runs, legacyRunId);
		mkdirSync(join(legacyDir, "legacy-artifacts"), { recursive: true });
		const missingRecordRoot = makeSimpleRoot(
			parent,
			"99999999-aaaa-4bbb-8ccc-dddddddddddd",
			legacyRunId,
		);
		const badRunDir = join(runs, unknownRunId);
		mkdirSync(badRunDir);
		writeFileSync(join(badRunDir, "run.json"), "{");
		const malformed = await collectSimple(parent, stateRoot);
		strictEqual(malformed.status, 1);
		strictEqual(malformed.summary.wouldRemove, 0);
		writeFileSync(
			join(badRunDir, "run.json"),
			JSON.stringify({
				runId: unknownRunId,
				state: "failed",
				cleanupState: "complete",
				createdAt: new Date(NOW).toISOString(),
				workerPid: null,
			}),
		);
		const invalid = makeSimpleRoot(
			parent,
			"88888888-9999-4aaa-8bbb-cccccccccccc",
		);
		writeFileSync(join(invalid.root, ".switchyard-cleanup-owner.json"), "{}");
		const unavailable = await collectSimple(parent, stateRoot, {
			listHeldPaths: () => null,
		});
		strictEqual(unavailable.status, 1);
		const safe = await collectSimple(parent, stateRoot);
		deepStrictEqual(
			[
				safe.status,
				safe.summary.skippedRecordMismatch,
				safe.summary.skippedRecordUnavailable,
				safe.summary.skippedMarker,
				safe.summary.wouldRemove,
			],
			[0, 1, 1, 1, 1],
		);
		ok(existsSync(orphan.root) && existsSync(unrelated.root));
		ok(existsSync(missingRecordRoot.root) && existsSync(invalid.root));
	});
	it("refuses a replaced root and uses guarded cleanup on intact fixtures", async () => {
		const parent = tempDir("switchyard-simple-orphan-identity-");
		const stateRoot = makeRunStore(parent);
		const suffix = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
		const original = makeSimpleRoot(parent, suffix);
		const runId = original.runId;
		const displaced = `${original.root}-displaced`;
		let scans = 0;
		let replacement;
		const swapped = await collectSimple(parent, stateRoot, {
			apply: true,
			listHeldPaths: () => {
				if (++scans === 2) {
					renameSync(original.root, displaced);
					replacement = makeSimpleRoot(parent, suffix, runId);
					writeFileSync(join(replacement.root, "payload.txt"), "replacement");
					const oldAt = new Date(NOW - SIMPLE_ORPHAN_TTL_MS - 1);
					for (const path of [
						join(replacement.root, "payload.txt"),
						replacement.root,
					])
						utimesSync(path, oldAt, oldAt);
				}
				return [];
			},
		});
		deepStrictEqual(
			[swapped.status, swapped.summary.refused, swapped.summary.removed],
			[1, 1, 0],
		);
		strictEqual(
			readFileSync(join(original.root, "payload.txt"), "utf8"),
			"replacement",
		);
		strictEqual(
			readFileSync(join(displaced, "payload.txt"), "utf8"),
			"orphan fixture",
		);
		addRunRecord(
			stateRoot,
			runId,
			"running",
			worktreeRecord(replacement.root, parent, replacement.nonce, "active"),
		);
		const intact = makeSimpleRoot(
			parent,
			"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		);
		const cleaned = await collectSimple(parent, stateRoot, { apply: true });
		deepStrictEqual(
			[cleaned.status, cleaned.summary.removed, existsSync(intact.root)],
			[0, 1, false],
		);
		ok(existsSync(original.root), "the replacement survives guarded cleanup");
	});
	it("uses a fixed TTL in simple-orphan mode without changing broad-sweep parsing", () => {
		deepStrictEqual(parseSweepArgs(["--simple-orphans"]), {
			apply: false,
			simpleOrphans: true,
		});
		ok("error" in parseSweepArgs(["--simple-orphans", "--days=2"]));
		deepStrictEqual(parseSweepArgs(["--days=7"]), {
			apply: false,
			maxAgeDays: 7,
		});
	});
});
