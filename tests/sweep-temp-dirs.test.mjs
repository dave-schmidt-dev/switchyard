import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { listHeldPathsViaLsof } from "../scripts/simple-orphan-collector.mjs";
import {
	DEFAULT_MAX_AGE_DAYS,
	inspectTree,
	isSweepAuthorized,
	parseLsofResult,
	parseSweepArgs,
	SIMPLE_ORPHAN_TTL_MS,
	sweepSimpleOrphans,
	sweepTempDirs,
} from "../scripts/sweep-temp-dirs.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const DAY = 86_400_000;
/** Fixed so age is measured against an injected clock, never the real one. */
const NOW = Date.parse("2026-09-04T17:00:00Z");

const silent = () => {};

/**
 * A directory whose own mtime and whose content's mtime are set independently,
 * so "old directory holding recent content" is expressible.
 */
function makeEntry(parent, name, ageDays, innerAgeDays = ageDays) {
	const dir = join(parent, name);
	mkdirSync(dir, { recursive: true });
	const inner = join(dir, "payload.txt");
	writeFileSync(inner, "x".repeat(64));
	const innerAt = new Date(NOW - innerAgeDays * DAY);
	utimesSync(inner, innerAt, innerAt);
	// After the write, or the write would bump the directory back to now.
	const dirAt = new Date(NOW - ageDays * DAY);
	utimesSync(dir, dirAt, dirAt);
	return dir;
}

/** A populated fake `$TMPDIR` covering every disposition the sweep can reach. */
function makeFixture() {
	const root = tempDir("switchyard-sweep-fixture-");
	const entries = {
		stale: makeEntry(root, "switchyard-stale-abc", 10),
		freshTop: makeEntry(root, "switchyard-fresh-top-abc", 1, 10),
		freshInner: makeEntry(root, "switchyard-fresh-inner-abc", 10, 1),
		held: makeEntry(root, "switchyard-held-abc", 10),
		foreign: makeEntry(root, "other-project-ancient", 400),
	};
	// Never created by the suite, so a `switchyard-*` symlink is not ours to
	// resolve - and following one would put its target in scope.
	entries.link = join(root, "switchyard-link-abc");
	symlinkSync(entries.foreign, entries.link);
	return { root, entries };
}

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
	for (const apply of [false, true]) {
		for (const maxAgeDays of [0, DEFAULT_MAX_AGE_DAYS, 365]) {
			it(`excludes simple roots with apply=${apply} and days=${maxAgeDays}`, () => {
				const root = tempDir("switchyard-sweep-simple-exclusion-");
				const stale = makeEntry(root, "switchyard-simplex-stale", 400);
				const simple = ["switchyard-simple-", "switchyard-simple-stale"].map(
					(name) => makeEntry(root, name, 400),
				);
				const expectedBytes = inspectTree(stale).bytes;

				const { status, summary } = sweepTempDirs({
					tmpDir: root,
					apply,
					maxAgeDays,
					now: NOW,
					listHeldPaths: noneHeld,
					log: silent,
				});

				strictEqual(status, 0);
				strictEqual(summary.candidates, 1);
				strictEqual(summary.removed, 1);
				strictEqual(summary.apparentBytes, expectedBytes);
				strictEqual(existsSync(stale), !apply);
				for (const retained of simple) {
					ok(existsSync(join(retained, "payload.txt")));
				}
			});
		}
	}

	it("removes only stale switchyard entries and reports what it removed", () => {
		const { root, entries } = makeFixture();
		const expectedBytes = inspectTree(entries.stale).bytes;

		const { status, summary } = sweepTempDirs({
			tmpDir: root,
			apply: true,
			now: NOW,
			listHeldPaths: () => [realpathSync(entries.held)],
			log: silent,
		});

		strictEqual(status, 0);
		strictEqual(summary.removed, 1);
		strictEqual(summary.apparentBytes, expectedBytes);
		strictEqual(summary.skippedHeld, 1);
		strictEqual(summary.skippedFresh, 2);
		strictEqual(summary.skippedSymlink, 1);
		strictEqual(summary.failed, 0);

		strictEqual(existsSync(entries.stale), false);
		for (const kept of ["freshTop", "freshInner", "held", "foreign", "link"]) {
			ok(existsSync(entries[kept]), `${kept} must survive the sweep`);
		}
		// The counters are only worth reading if they match the disk.
		deepStrictEqual(readdirSync(root).sort(), [
			"other-project-ancient",
			"switchyard-fresh-inner-abc",
			"switchyard-fresh-top-abc",
			"switchyard-held-abc",
			"switchyard-link-abc",
		]);
	});

	it("leaves an ancient entry that is not switchyard's", () => {
		const { root, entries } = makeFixture();

		sweepTempDirs({
			tmpDir: root,
			apply: true,
			now: NOW,
			listHeldPaths: noneHeld,
			log: silent,
		});

		// $TMPDIR holds other projects' state and tens of thousands of
		// unattributed entries. Age is not authorization; the prefix is.
		ok(existsSync(entries.foreign), "a non-switchyard entry is out of scope");
		ok(existsSync(join(entries.foreign, "payload.txt")));
	});

	it("matches held paths reported in canonical form", () => {
		// One entry, so the counters below cannot be satisfied by another.
		const root = tempDir("switchyard-sweep-canonical-");
		const stale = makeEntry(root, "switchyard-canonical-abc", 10);
		// macOS lsof reports `/private/var/...` for a `$TMPDIR` of `/var/...`.
		// The original sweep compared against the uncanonicalized value, so its
		// open-handle check matched nothing and reported a truthful zero that
		// proved nothing. `root` here is the raw path; the held path is not.
		const canonicalRoot = realpathSync(root);
		if (process.platform === "darwin") {
			ok(
				canonicalRoot !== root,
				"this test is only meaningful where the two forms differ",
			);
		}
		const heldCanonical = join(canonicalRoot, "switchyard-canonical-abc");

		const { summary } = sweepTempDirs({
			tmpDir: root,
			apply: true,
			now: NOW,
			listHeldPaths: () => [join(heldCanonical, "payload.txt")],
			log: silent,
		});

		strictEqual(summary.skippedHeld, 1);
		strictEqual(summary.removed, 0);
		ok(existsSync(stale), "a held directory must survive");
	});

	it("does not treat a sibling prefix as held", () => {
		const root = tempDir("switchyard-sweep-sibling-");
		const target = makeEntry(root, "switchyard-a", 10);
		makeEntry(root, "switchyard-abc", 10);

		const { summary } = sweepTempDirs({
			tmpDir: root,
			apply: true,
			now: NOW,
			listHeldPaths: () => [join(realpathSync(root), "switchyard-abc")],
			log: silent,
		});

		strictEqual(summary.skippedHeld, 1);
		strictEqual(summary.removed, 1);
		strictEqual(existsSync(target), false);
	});

	it("refuses to sweep when the open-handle check is unavailable", () => {
		const { root, entries } = makeFixture();

		const messages = [];
		const { status, summary } = sweepTempDirs({
			tmpDir: root,
			apply: true,
			now: NOW,
			// `null` is "could not check", which is not the same as "none held".
			listHeldPaths: () => null,
			log: (message) => messages.push(message),
		});

		strictEqual(status, 1);
		strictEqual(summary.removed, 0);
		ok(existsSync(entries.stale), "nothing may be deleted unchecked");
		ok(messages.some((message) => message.includes("lsof unavailable")));
	});

	it("removes nothing in the default dry run", () => {
		const { root, entries } = makeFixture();

		const { status, summary } = sweepTempDirs({
			tmpDir: root,
			now: NOW,
			listHeldPaths: noneHeld,
			log: silent,
		});

		strictEqual(status, 0);
		strictEqual(summary.apply, false);
		// Both `stale` and `held` are old, and nothing is held in this run.
		strictEqual(summary.removed, 2, "it still reports what it would remove");
		ok(existsSync(entries.stale), "a dry run must not delete");
	});

	it("keeps an entry whose tree was touched inside the age bound", () => {
		const root = tempDir("switchyard-sweep-age-");
		makeEntry(root, "switchyard-boundary", 10, DEFAULT_MAX_AGE_DAYS - 0.5);

		const { summary } = sweepTempDirs({
			tmpDir: root,
			apply: true,
			now: NOW,
			listHeldPaths: noneHeld,
			log: silent,
		});

		// The six entries the real sweep held back had exactly this shape: an
		// ancient top-level mtime over content written days later.
		strictEqual(summary.skippedFresh, 1);
		strictEqual(summary.removed, 0);
	});

	it("treats an incomplete lsof listing as unavailable, not as empty", () => {
		const stdout = "p1\nn/private/var/folders/ab/T/switchyard-x/f\nn*:*\n";
		deepStrictEqual(parseLsofResult({ status: 0, stdout, stderr: "" }), [
			"/private/var/folders/ab/T/switchyard-x/f",
		]);
		// lsof exits non-zero and warns when a process refused inspection. Its
		// output is then a subset of what is open, and a subset is exactly the
		// shape that lets the sweep delete something a process still holds.
		strictEqual(parseLsofResult({ status: 1, stdout, stderr: "" }), null);
		strictEqual(
			parseLsofResult({
				status: 0,
				stdout,
				stderr: "lsof: WARNING: can't stat() 1 file\n",
			}),
			null,
		);
		strictEqual(
			parseLsofResult({
				status: 0,
				stdout,
				stderr: "Output information may be incomplete.\n",
			}),
			null,
		);
		strictEqual(parseLsofResult({ error: new Error("ENOENT") }), null);
		strictEqual(parseLsofResult({ status: 0, stdout: "" }), null);
	});

	it("uses a bounded lsof invocation with a sanitized environment", () => {
		let invocation;
		const result = listHeldPathsViaLsof((command, args, options) => {
			invocation = { command, args, options };
			return { status: 0, stdout: "p1\nn/private/tmp/held\n", stderr: "" };
		});
		deepStrictEqual(result, ["/private/tmp/held"]);
		strictEqual(invocation.command, "/usr/sbin/lsof");
		deepStrictEqual(invocation.args, ["-Fn"]);
		strictEqual(invocation.options.timeout, 30_000);
		strictEqual(invocation.options.killSignal, "SIGKILL");
		strictEqual(Number.isFinite(invocation.options.maxBuffer), true);
		deepStrictEqual(Object.keys(invocation.options.env).sort(), [
			"LANG",
			"LC_ALL",
			"PATH",
		]);
		strictEqual(
			listHeldPathsViaLsof(() => ({ error: { code: "ETIMEDOUT" } })),
			null,
		);
	});

	it("authorizes only prefixed direct children of the swept directory", () => {
		// The last check before `rm -rf`, and redundant with the filter applied
		// when candidates are collected - so it is tested directly rather than
		// through a sweep, where the earlier filter would mask a regression.
		const tmp = "/private/var/folders/ab/T";
		strictEqual(isSweepAuthorized(`${tmp}/switchyard-abc`, tmp), true);
		strictEqual(isSweepAuthorized(`${tmp}/switchyard-simplex-abc`, tmp), true);
		strictEqual(isSweepAuthorized(`${tmp}/switchyard-simple-`, tmp), false);
		strictEqual(isSweepAuthorized(`${tmp}/switchyard-simple-abc`, tmp), false);
		strictEqual(isSweepAuthorized(`${tmp}/other-project`, tmp), false);
		strictEqual(isSweepAuthorized(`${tmp}/nested/switchyard-abc`, tmp), false);
		strictEqual(isSweepAuthorized("/private/var/switchyard-abc", tmp), false);
		strictEqual(isSweepAuthorized(tmp, tmp), false);
	});

	it("rejects an unknown flag rather than falling back to a dry run", () => {
		deepStrictEqual(parseSweepArgs(["--apply"]), {
			apply: true,
			maxAgeDays: DEFAULT_MAX_AGE_DAYS,
		});
		deepStrictEqual(parseSweepArgs(["--days=7"]), {
			apply: false,
			maxAgeDays: 7,
		});
		// `--dry-run` is not a flag here; silently accepting it would read as a
		// safe no-op while doing the opposite of what it says.
		ok("error" in parseSweepArgs(["--dry-run"]));
		ok("error" in parseSweepArgs(["--aply"]));
	});

	it("dry-runs old UUID roots and inventories legacy six-character roots only", async () => {
		const parent = tempDir("switchyard-simple-orphan-dry-run-");
		const stateRoot = makeRunStore(parent);
		const roots = Array.from({ length: 11 }, () =>
			makeSimpleRoot(parent, randomUUID()),
		);
		const legacy = join(parent, "switchyard-simple-abcdef");
		mkdirSync(legacy);
		writeFileSync(join(legacy, "payload.txt"), "legacy");
		const messages = [];
		const progress = [];
		const { status, summary } = await collectSimple(parent, stateRoot, {
			log: (message) => messages.push(message),
			progress: (message) => progress.push(message),
		});
		strictEqual(status, 0);
		deepStrictEqual(
			[
				summary.apply,
				summary.candidates,
				summary.legacyInventory,
				summary.wouldRemove,
				summary.removed,
			],
			[false, 11, 1, 11, 0],
		);
		ok(
			summary.apparentBytes > 0 && roots.every((root) => existsSync(root.root)),
		);
		ok(progress.includes("simple-orphans: progress rootsChecked=10/11"));
		ok(existsSync(join(legacy, "payload.txt")));
		const report = messages.find((message) =>
			message.startsWith("simple-orphans dry-run"),
		);
		ok(report?.includes(`apparentBytes=${summary.apparentBytes}`));
	});

	it("keeps roots whose run records are active or retained", async () => {
		const parent = tempDir("switchyard-simple-orphan-run-state-");
		const stateRoot = makeRunStore(parent);
		const activeId = "simple-task-22222222-3333-4444-8555-666666666666";
		const retainedId = "simple-task-33333333-4444-4555-8666-777777777777";
		const active = makeSimpleRoot(parent, activeId.slice(-36));
		const retained = makeSimpleRoot(parent, retainedId.slice(-36));
		const startup = makeSimpleRoot(
			parent,
			"44444444-5555-4666-8777-888888888888",
		);
		const unknown = makeSimpleRoot(
			parent,
			"55555555-6666-4777-8888-999999999999",
		);
		addRunRecord(
			stateRoot,
			active.runId,
			"running",
			worktreeRecord(active.root, parent, active.nonce, "active"),
		);
		addRunRecord(
			stateRoot,
			retained.runId,
			"failed",
			worktreeRecord(retained.root, parent, retained.nonce, "retained"),
		);
		addRunRecord(
			stateRoot,
			startup.runId,
			"running",
			worktreeRecord(startup.root, parent, startup.nonce, "active"),
			{ workerPid: null, createdAt: new Date(NOW - 60_000).toISOString() },
		);
		addRunRecord(
			stateRoot,
			unknown.runId,
			"running",
			worktreeRecord(unknown.root, parent, unknown.nonce, "active"),
			{ workerPid: undefined, createdAt: new Date(NOW - DAY).toISOString() },
		);
		const { status, summary } = await collectSimple(parent, stateRoot);
		strictEqual(status, 0);
		deepStrictEqual(
			[summary.skippedActive, summary.skippedRetained, summary.wouldRemove],
			[3, 1, 0],
		);
		ok(
			[active, retained, startup, unknown].every((root) =>
				existsSync(root.root),
			),
		);
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
