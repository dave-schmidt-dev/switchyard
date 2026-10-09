import { deepStrictEqual, strictEqual, throws } from "node:assert";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	simpleRouteFundingFailure,
	simpleRouteIsFunded,
} from "../src/switchyard/simple/index.mjs";
import { simpleQuarantinePath } from "../src/switchyard/simple/worktree-cleanup.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdirEnv = process.env.TMPDIR;
const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const ORIGINAL_REAL_TMPDIR = realpathSync(tmpdir());
function listRealTmpSimpleDirectoryNames(
	dir = ORIGINAL_REAL_TMPDIR,
	prefix = "switchyard-simple-",
) {
	return new Set(
		readdirSync(dir, { withFileTypes: true })
			.filter((dirent) => dirent.name.startsWith(prefix))
			.map((dirent) => dirent.name),
	);
}
function findNewSimpleRoots(
	initialSnapshot,
	currentEntries,
	prefix = "switchyard-simple-",
) {
	const initialSet =
		initialSnapshot instanceof Set ? initialSnapshot : new Set(initialSnapshot);
	return Array.from(currentEntries).filter(
		(name) => name.startsWith(prefix) && !initialSet.has(name),
	);
}
function assertNoLeakedSimpleRoots(initialSnapshot, currentEntries, prefix) {
	const leaked = findNewSimpleRoots(initialSnapshot, currentEntries, prefix);
	deepStrictEqual(
		leaked,
		[],
		`isolated simple tests leaked real temp roots: ${leaked.join(", ")}`,
	);
}
const initialRealTmpSimpleRoots =
	listRealTmpSimpleDirectoryNames(ORIGINAL_REAL_TMPDIR);
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-suite-tmp-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");
const retainedWorktrees = [];
afterEach(() => {
	for (const { worktreePath } of retainedWorktrees.splice(0)) {
		const root = dirname(resolve(worktreePath));
		if (
			dirname(root) === SUITE_TMPDIR &&
			basename(root).startsWith("switchyard-simple-")
		) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {}
		}
	}
	if (existsSync(SUITE_TMPDIR)) {
		for (const entry of readdirSync(SUITE_TMPDIR)) {
			if (/^switchyard-simple-[0-9a-f-]{36}$/u.test(entry)) {
				try {
					rmSync(join(SUITE_TMPDIR, entry), { recursive: true, force: true });
				} catch {}
			}
		}
	}
});
after(() => {
	const ownQuarantineRoots = [];
	const ownRealTmpRoots = [];
	const runsDir = join(SUITE_TMPDIR, "run-store", "runs");
	if (existsSync(runsDir)) {
		for (const entry of readdirSync(runsDir)) {
			const recordPath = join(runsDir, entry, "run.json");
			if (!existsSync(recordPath)) continue;
			const record = JSON.parse(readFileSync(recordPath, "utf8"));
			const recordedPath = record.worktree?.path;
			if (
				typeof recordedPath === "string" &&
				dirname(recordedPath) ===
					join(ORIGINAL_REAL_TMPDIR, "switchyard-simple-roots") &&
				existsSync(recordedPath)
			)
				ownRealTmpRoots.push(recordedPath);
			if (record.worktree?.nonce) {
				const quarantine = simpleQuarantinePath(record.worktree.nonce);
				if (existsSync(quarantine)) ownQuarantineRoots.push(quarantine);
			}
		}
	}
	if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdirEnv;
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	try {
		rmSync(SUITE_TMPDIR, { recursive: true, force: true });
	} catch {}

	const syntheticRoot = "switchyard-simple-synthetic-leak-check";
	deepStrictEqual(
		findNewSimpleRoots(initialRealTmpSimpleRoots, [
			...initialRealTmpSimpleRoots,
			syntheticRoot,
		]),
		[syntheticRoot],
	);
	throws(
		() =>
			assertNoLeakedSimpleRoots(initialRealTmpSimpleRoots, [
				...initialRealTmpSimpleRoots,
				syntheticRoot,
			]),
		/isolated simple tests leaked real temp roots/,
	);

	deepStrictEqual(
		ownRealTmpRoots,
		[],
		"simple tests leaked owned real temp roots",
	);
	deepStrictEqual(
		ownQuarantineRoots,
		[],
		"simple tests leaked owned quarantines",
	);
});
describe("simple dispatch argument boundary", () => {
	it("admits OpenCode Go overage-enabled subscription only with fresh included headroom", () => {
		const target = {
			enabled: true,
			snapshot_name: "OpenCode Go",
			funding: {
				included: { mode: "subscription" },
				overage: { enabled: true },
			},
		};
		const includedUsage = (windows = [100, 94, 97], overrides = {}) => ({
			snapshotStatus: "fresh",
			snapshot: {
				providers: [
					{
						name: "OpenCode Go",
						ok: true,
						windows: ["five_hour", "weekly", "monthly"].map((id, index) => ({
							id,
							percent_left: windows[index],
						})),
						...overrides,
					},
				],
			},
		});
		const options = (snapshotRead) => ({
			targetId: "opencode-go",
			snapshotRead,
		});

		strictEqual(
			simpleRouteFundingFailure(target, options(includedUsage())),
			null,
			"the reproduced 100/94/97 Go subscription snapshot is included usage",
		);
		strictEqual(
			simpleRouteIsFunded(target, options(includedUsage([5, 5, 5]))),
			true,
			"the router's 5% reserve boundary is admitted",
		);

		for (const snapshotStatus of ["missing", "stale", "future", "malformed"]) {
			strictEqual(
				simpleRouteFundingFailure(
					target,
					options({ snapshotStatus, snapshot: null }),
				),
				"included_usage_unverified",
				`${snapshotStatus} Go usage must fail closed`,
			);
		}
		for (const snapshotRead of [
			includedUsage([100, 4.99, 97]),
			includedUsage([100, 94, 0]),
			includedUsage([100, Number.NaN, 97]),
			includedUsage([100, 101, 97]),
			includedUsage([100, 94]),
			includedUsage([100, 94, 97], { name: "OpenCode Zen" }),
			includedUsage([100, 94, 97], { ok: false }),
			{ snapshotStatus: "fresh", snapshot: { providers: [] } },
		]) {
			strictEqual(
				simpleRouteFundingFailure(target, options(snapshotRead)),
				"included_usage_unverified",
				"unavailable, malformed, or under-reserve Go usage must fail closed",
			);
		}
		strictEqual(
			simpleRouteFundingFailure(
				{
					...target,
					funding: { ...target.funding, included: { mode: "quota" } },
				},
				options(includedUsage()),
			),
			"paid_overage_not_allowed",
			"this exception is limited to the OpenCode Go subscription",
		);
		strictEqual(
			simpleRouteFundingFailure(target, {
				...options(includedUsage()),
				targetId: "vibe",
			}),
			"paid_overage_not_allowed",
			"other targets retain the no-overage rule",
		);
	});
});
