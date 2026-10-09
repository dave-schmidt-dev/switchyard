import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import {
	SIMPLE_ORPHAN_TTL_MS,
	sweepSimpleOrphans,
	sweepTempDirs,
} from "../scripts/sweep-temp-dirs.mjs";
import {
	allocateSimpleRoot,
	ensureSimpleRootsParent,
	OWNER_MARKER,
	removeInjectedTestRoot,
	SIMPLE_ROOTS_DIRNAME,
	simpleRootMissing,
} from "../src/switchyard/simple/simple-root.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const NOW = Date.parse("2026-10-09T19:00:00Z");
const silent = () => {};

function ownedRoot(parent) {
	const child = `switchyard-simple-${randomUUID()}`;
	const root = join(parent, child);
	mkdirSync(join(root, "worktree"), { recursive: true });
	writeFileSync(join(root, OWNER_MARKER), "{}\n", { mode: 0o600 });
	return { child, root };
}

describe("owned simple roots parent", () => {
	it("allocates roots inside an owner-only parent in the temp base", () => {
		const base = realpathSync(tempDir("switchyard-simple-root-alloc-"));
		const { canonicalParent, candidateChild, candidatePath } =
			allocateSimpleRoot({ tmpdir: base });
		strictEqual(canonicalParent, join(base, SIMPLE_ROOTS_DIRNAME));
		strictEqual(candidatePath, join(canonicalParent, candidateChild));
		strictEqual(lstatSync(canonicalParent).mode & 0o777, 0o700);
		strictEqual(
			allocateSimpleRoot({ tmpdir: base }).canonicalParent,
			canonicalParent,
		);
	});

	it("refuses a symlinked or group-accessible parent", () => {
		const base = realpathSync(tempDir("switchyard-simple-root-planted-"));
		const elsewhere = join(base, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, join(base, SIMPLE_ROOTS_DIRNAME));
		throws(() => ensureSimpleRootsParent(base), /owner-only/);

		const open = realpathSync(tempDir("switchyard-simple-root-open-"));
		mkdirSync(join(open, SIMPLE_ROOTS_DIRNAME));
		chmodSync(join(open, SIMPLE_ROOTS_DIRNAME), 0o755);
		throws(() => ensureSimpleRootsParent(open), /owner-only/);
	});
});

describe("removeInjectedTestRoot", () => {
	it("removes only the exact marked root this run allocated", () => {
		const parent = realpathSync(tempDir("switchyard-simple-root-remove-"));
		const { child, root } = ownedRoot(parent);
		const calls = [];
		const rm = (path) => calls.push(path);
		for (const [path, name] of [
			[parent, child],
			[join(parent, child, ".."), child],
			[join(parent, "switchyard-simple-other"), "switchyard-simple-other"],
			[root, `${child}x`],
		])
			throws(
				() => removeInjectedTestRoot(path, parent, name, { rmSync: rm }),
				/unsafe workspace root/,
			);
		deepStrictEqual(calls, []);
		removeInjectedTestRoot(root, parent, child, { rmSync: rm });
		deepStrictEqual(calls, [root]);
	});

	it("refuses an unmarked or symlinked root and tolerates an absent one", () => {
		const parent = realpathSync(tempDir("switchyard-simple-root-unmarked-"));
		const rm = () => {
			throw new Error("must not remove");
		};
		const unmarked = `switchyard-simple-${randomUUID()}`;
		mkdirSync(join(parent, unmarked));
		throws(() =>
			removeInjectedTestRoot(join(parent, unmarked), parent, unmarked, {
				rmSync: rm,
			}),
		);
		const linked = `switchyard-simple-${randomUUID()}`;
		symlinkSync(parent, join(parent, linked));
		throws(
			() =>
				removeInjectedTestRoot(join(parent, linked), parent, linked, {
					rmSync: rm,
				}),
			/unsafe workspace root/,
		);
		const absent = `switchyard-simple-${randomUUID()}`;
		removeInjectedTestRoot(join(parent, absent), parent, absent, {
			rmSync: rm,
		});
	});
});

describe("simpleRootMissing", () => {
	it("is true only for a provably absent path", () => {
		const parent = tempDir("switchyard-simple-root-missing-");
		strictEqual(simpleRootMissing(parent), false);
		strictEqual(simpleRootMissing(join(parent, "gone")), true);
		strictEqual(simpleRootMissing(""), false);
		strictEqual(simpleRootMissing(undefined), false);
	});
});

describe("sweepers and the owned parent", () => {
	it("broad temp sweep never selects the owned parent", () => {
		const base = tempDir("switchyard-simple-root-sweep-");
		const parent = join(base, SIMPLE_ROOTS_DIRNAME);
		mkdirSync(parent, { mode: 0o700 });
		const old = new Date(NOW - 400 * 86_400_000);
		utimesSync(parent, old, old);
		const { status, summary } = sweepTempDirs({
			tmpDir: base,
			apply: true,
			maxAgeDays: 0,
			now: NOW,
			listHeldPaths: () => [],
			log: silent,
		});
		strictEqual(status, 0);
		strictEqual(summary.candidates, 0);
		ok(existsSync(parent));
	});

	it("orphan collector reclaims a dead retained root inside the owned parent", async () => {
		const base = realpathSync(tempDir("switchyard-simple-root-orphans-"));
		const stateRoot = join(base, "state");
		const parent = ensureSimpleRootsParent(base);
		const child = `switchyard-simple-${randomUUID()}`;
		const root = join(parent, child);
		const runId = `simple-owned-orphan-${randomUUID()}`;
		const nonce = randomUUID();
		mkdirSync(join(root, "worktree"), { recursive: true });
		writeFileSync(
			join(root, OWNER_MARKER),
			`${JSON.stringify({ runId, nonce })}\n`,
			{ mode: 0o600 },
		);
		const old = new Date(NOW - SIMPLE_ORPHAN_TTL_MS - 1);
		for (const path of [join(root, OWNER_MARKER), join(root, "worktree"), root])
			utimesSync(path, old, old);
		const stat = lstatSync(root);
		mkdirSync(join(stateRoot, "runs", runId), { recursive: true });
		writeFileSync(
			join(stateRoot, "runs", runId, "run.json"),
			JSON.stringify({
				runId,
				state: "failed",
				cleanupState: "pending",
				createdAt: old.toISOString(),
				workerPid: null,
				worktree: {
					canonicalParent: parent,
					candidateChild: child,
					path: root,
					state: "retained",
					retainedAt: new Date(NOW - 2 * 86_400_000).toISOString(),
					nonce,
					device: String(stat.dev),
					inode: String(stat.ino),
				},
			}),
		);
		const collect = (apply) =>
			sweepSimpleOrphans({
				tmpDir: base,
				stateRoot,
				apply,
				now: NOW,
				listHeldPaths: () => [],
				log: silent,
				progress: silent,
			});
		const dry = await collect(false);
		deepStrictEqual(
			[dry.status, dry.summary.candidates, dry.summary.legacyInventory],
			[0, 1, 0],
		);
		strictEqual(dry.summary.wouldRemove, 1);
		const applied = await collect(true);
		deepStrictEqual([applied.status, applied.summary.removed], [0, 1]);
		strictEqual(existsSync(root), false);
		ok(existsSync(parent), "the owned parent itself is never removed");
		strictEqual(basename(parent), SIMPLE_ROOTS_DIRNAME);
	});
});
