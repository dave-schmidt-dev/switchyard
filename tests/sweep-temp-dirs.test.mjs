import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_MAX_AGE_DAYS,
	inspectTree,
	isSweepAuthorized,
	parseSweepArgs,
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

describe("sweep-temp-dirs", () => {
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

	it("authorizes only prefixed direct children of the swept directory", () => {
		// The last check before `rm -rf`, and redundant with the filter applied
		// when candidates are collected - so it is tested directly rather than
		// through a sweep, where the earlier filter would mask a regression.
		const tmp = "/private/var/folders/ab/T";
		strictEqual(isSweepAuthorized(`${tmp}/switchyard-abc`, tmp), true);
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
});
