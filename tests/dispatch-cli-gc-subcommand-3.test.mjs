import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	collectGcInventory,
	defaultMeasureApfsPrivateBytes,
} from "../src/switchyard/dispatch/index.mjs";
import {
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	// Set env var so direct run-store calls in tests target the temp dir
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	rmSync(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});
describe("gc subcommand (T62)", () => {
	it("measures APFS private bytes for fresh regular file fixtures (allows unavailable on non-APFS)", async () => {
		const localStateRoot = tempDir("gc-measure-state-");
		const rawParent = tempDir("gc-measure-parent-");
		const parent = realpathSync(rawParent);

		const candidate = "switchyard-simple-fixture-1mb";
		const rootPath = join(parent, candidate);
		mkdirSync(rootPath, { recursive: true });

		// Fresh 1 MiB regular file:
		const payload1MiB = Buffer.alloc(1024 * 1024, 0x42);
		writeFileSync(join(rootPath, "payload-1mb.bin"), payload1MiB);

		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot, measureBytes: true },
			{ tmpdir: () => parent },
		);

		const root = inventory.roots.find((r) => r.path === rootPath);
		ok(root, "fixture root must be discovered in inventory");
		strictEqual(root.exists, true);
		strictEqual(root.deletionEligible, false);

		if (root.measurable) {
			strictEqual(typeof root.bytes, "number");
			// Host probe confirmed getattrlist ATTR_CMNEXT_PRIVATESIZE returns 1048576 for fresh 1 MiB regular file
			strictEqual(root.bytes, 1048576);
			strictEqual(root.unavailableReason, null);
			strictEqual(inventory.summary.measurable, true);
			strictEqual(inventory.summary.totalBytes, 1048576);
		} else {
			// On non-APFS or unsupported platform
			strictEqual(root.bytes, null);
			ok(typeof root.unavailableReason === "string");
			strictEqual(inventory.summary.measurable, false);
			strictEqual(inventory.summary.totalBytes, null);
		}
	});
	it("distinguishes APFS clone private bytes from allocated bytes", {
		skip: process.platform !== "darwin",
	}, async () => {
		const parent = realpathSync(tempDir("gc-clone-parent-"));
		const rootPath = join(parent, "switchyard-simple-fixture-clone");
		mkdirSync(rootPath);
		const source = join(rootPath, "source.bin");
		const clone = join(rootPath, "clone.bin");
		writeFileSync(source, Buffer.alloc(1024 * 1024, 0x42));
		const before = await defaultMeasureApfsPrivateBytes([rootPath]);
		strictEqual(
			before.roots[rootPath]?.measurable,
			true,
			"APFS private-byte measurement must work on the macOS test volume",
		);
		strictEqual(before.roots[rootPath].bytes, 1024 * 1024);
		const copied = spawnSync("/bin/cp", ["-c", source, clone], {
			encoding: "utf8",
		});
		strictEqual(copied.status, 0, copied.stderr);
		const after = await defaultMeasureApfsPrivateBytes([rootPath]);
		strictEqual(after.roots[rootPath].measurable, true);
		strictEqual(after.roots[rootPath].bytes, 0);
		ok(statSync(source).blocks > 0, "shared blocks remain allocated");
	});
	it("sums only complete measurements into each class total and whole-inventory summary", async () => {
		const localStateRoot = tempDir("gc-totals-state-");
		const runsDir = join(localStateRoot, "runs");
		mkdirSync(runsDir, { recursive: true });

		const rawParent = tempDir("gc-totals-parent-");
		const parent = realpathSync(rawParent);

		// 1. recorded root with 1 MiB file
		const candidateRec = "switchyard-simple-recorded-tot";
		const pathRec = join(parent, candidateRec);
		mkdirSync(pathRec, { recursive: true });
		writeFileSync(
			join(pathRec, "rec-1mb.bin"),
			Buffer.alloc(1024 * 1024, 0x52),
		);

		const runDirRec = join(runsDir, "run-tot-rec");
		mkdirSync(runDirRec, { recursive: true });
		writeFileSync(
			join(runDirRec, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId: "run-tot-rec",
				state: "running",
				cleanupState: "pending",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-host",
				workerNonce: randomUUID(),
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
				worktree: {
					canonicalParent: parent,
					candidateChild: candidateRec,
					path: pathRec,
					state: "active",
					reason: null,
					retainedAt: null,
				},
			}),
			"utf8",
		);

		// 2. unknown root with 1 MiB file
		const candidateUnk = "switchyard-simple-unknown-tot";
		const pathUnk = join(parent, candidateUnk);
		mkdirSync(pathUnk, { recursive: true });
		writeFileSync(
			join(pathUnk, "unk-1mb.bin"),
			Buffer.alloc(1024 * 1024, 0x55),
		);

		// 3. missing root (recorded, but does not exist on disk)
		const candidateMiss = "switchyard-simple-missing-tot";
		const pathMiss = join(parent, candidateMiss);
		const runDirMiss = join(runsDir, "run-tot-miss");
		mkdirSync(runDirMiss, { recursive: true });
		writeFileSync(
			join(runDirMiss, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId: "run-tot-miss",
				state: "failed",
				cleanupState: "failed",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: ["1.2"],
				initialHostFingerprint: "test-host",
				workerNonce: randomUUID(),
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
				worktree: {
					canonicalParent: parent,
					candidateChild: candidateMiss,
					path: pathMiss,
					state: "retained",
					reason: null,
					retainedAt: null,
				},
			}),
			"utf8",
		);

		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot, measureBytes: true },
			{ tmpdir: () => parent },
		);

		const rootRec = inventory.roots.find((r) => r.path === pathRec);
		const rootUnk = inventory.roots.find((r) => r.path === pathUnk);
		const rootMiss = inventory.roots.find((r) => r.path === pathMiss);

		ok(rootRec);
		ok(rootUnk);
		ok(rootMiss);
		strictEqual(rootMiss.bytes, null);
		strictEqual(rootMiss.measurable, false);

		if (rootRec.measurable && rootUnk.measurable) {
			strictEqual(rootRec.bytes, 1048576);
			strictEqual(rootUnk.bytes, 1048576);
			strictEqual(inventory.summary.byClass.recorded.bytes, 1048576);
			strictEqual(inventory.summary.byClass.recorded.measurable, true);
			strictEqual(inventory.summary.byClass.unknown.bytes, 1048576);
			strictEqual(inventory.summary.byClass.unknown.measurable, true);
			strictEqual(inventory.summary.byClass.missing.bytes, null);
			strictEqual(inventory.summary.byClass.missing.measurable, false);
			strictEqual(inventory.summary.totalBytes, null);
			strictEqual(inventory.summary.measurable, false);
		} else {
			strictEqual(inventory.summary.totalBytes, null);
			strictEqual(inventory.summary.measurable, false);
		}
	});
	it("does not label a partially measured class as a complete private-byte total", async () => {
		const parent = realpathSync(tempDir("gc-partial-parent-"));
		const stateRoot = tempDir("gc-partial-state-");
		const goodPath = join(parent, "switchyard-simple-fixture-complete");
		const badPath = join(parent, "switchyard-simple-fixture-unavailable");
		mkdirSync(goodPath);
		mkdirSync(badPath);
		const inventory = await collectGcInventory(
			{ stateRoot, measureBytes: true },
			{
				tmpdir: () => parent,
				measurePrivateBytes: async () => ({
					status: "ok",
					roots: {
						[goodPath]: { measurable: true, bytes: 1024 },
						[badPath]: {
							measurable: false,
							bytes: null,
							unavailableReason: "inaccessible",
						},
					},
				}),
			},
		);
		strictEqual(inventory.summary.byClass.fixture.count, 2);
		strictEqual(inventory.summary.byClass.fixture.bytes, null);
		strictEqual(inventory.summary.byClass.fixture.measurable, false);
		strictEqual(inventory.summary.totalBytes, null);
		strictEqual(inventory.summary.measurable, false);
	});
	it("refuses symlinks and never follows symlink targets outside or inside roots", async () => {
		const localStateRoot = tempDir("gc-symlink-refuse-state-");
		const rawParent = tempDir("gc-symlink-refuse-parent-");
		const parent = realpathSync(rawParent);

		// Outside directory with a large 5 MiB payload:
		const outsideDir = tempDir("gc-outside-data-");
		writeFileSync(
			join(outsideDir, "external.bin"),
			Buffer.alloc(1024 * 1024 * 5, 0x58),
		);

		// 1. Root directory containing a regular file and a symlink to outsideDir:
		const candidateDir = "switchyard-simple-symlink-dir";
		const rootPath = join(parent, candidateDir);
		mkdirSync(rootPath, { recursive: true });
		writeFileSync(
			join(rootPath, "payload-1mb.bin"),
			Buffer.alloc(1024 * 1024, 0x59),
		);
		symlinkSync(outsideDir, join(rootPath, "symlink-to-outside"));

		// 2. Root that is itself a symlink pointing to outsideDir:
		const candidateSymlink = "switchyard-simple-symlink-root";
		const symlinkRootPath = join(parent, candidateSymlink);
		symlinkSync(outsideDir, symlinkRootPath);

		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot, measureBytes: true },
			{ tmpdir: () => parent },
		);

		const symlinkRoot = inventory.roots.find((r) => r.path === symlinkRootPath);
		ok(symlinkRoot);
		strictEqual(symlinkRoot.pathAmbiguity, true);
		strictEqual(symlinkRoot.measurable, false);
		strictEqual(symlinkRoot.bytes, null);
		strictEqual(symlinkRoot.deletionEligible, false);

		const dirRoot = inventory.roots.find((r) => r.path === rootPath);
		ok(dirRoot);
		strictEqual(dirRoot.deletionEligible, false);
		if (dirRoot.measurable) {
			// Must count ONLY the 1 MiB regular file, never following the 5 MiB symlink!
			strictEqual(dirRoot.bytes, 1048576);
		} else {
			strictEqual(dirRoot.bytes, null);
		}
	});
	it("handles timeout, measurement error, or inaccessible roots by reporting unavailable without affecting deletion eligibility", async () => {
		const localStateRoot = tempDir("gc-error-state-");
		const rawParent = tempDir("gc-error-parent-");
		const parent = realpathSync(rawParent);

		const candidate = "switchyard-simple-error-root";
		const rootPath = join(parent, candidate);
		mkdirSync(rootPath, { recursive: true });
		writeFileSync(join(rootPath, "file.bin"), Buffer.alloc(1024 * 1024, 0x60));

		// Case A: Measurement timeout
		const inventoryTimeout = await collectGcInventory(
			{ stateRoot: localStateRoot, measureBytes: true },
			{
				tmpdir: () => parent,
				measurePrivateBytes: async () => ({
					status: "timeout",
					roots: {},
				}),
			},
		);
		const rootTimeout = inventoryTimeout.roots.find((r) => r.path === rootPath);
		ok(rootTimeout);
		strictEqual(rootTimeout.measurable, false);
		strictEqual(rootTimeout.bytes, null);
		strictEqual(rootTimeout.unavailableReason, "private_bytes_unavailable");
		strictEqual(rootTimeout.deletionEligible, false);
		strictEqual(inventoryTimeout.summary.measurable, false);
		strictEqual(inventoryTimeout.summary.totalBytes, null);

		// Case B: Injected measurement exception/crash
		const inventoryError = await collectGcInventory(
			{ stateRoot: localStateRoot, measureBytes: true },
			{
				tmpdir: () => parent,
				measurePrivateBytes: async () => {
					throw new Error("subprocess spawned failure");
				},
			},
		);
		const rootError = inventoryError.roots.find((r) => r.path === rootPath);
		ok(rootError);
		strictEqual(rootError.measurable, false);
		strictEqual(rootError.bytes, null);
		strictEqual(rootError.unavailableReason, "private_bytes_unavailable");
		strictEqual(rootError.deletionEligible, false);
		strictEqual(inventoryError.summary.measurable, false);
		strictEqual(inventoryError.summary.totalBytes, null);
	});
	it("emits live progress on stderr during gc run and produces safe valid JSON on stdout", () => {
		const localStateRoot = tempDir("gc-progress-state-");
		const rawParent = tempDir("gc-progress-parent-");
		const parent = realpathSync(rawParent);

		const candidate = "switchyard-simple-progress-root";
		const rootPath = join(parent, candidate);
		mkdirSync(rootPath, { recursive: true });
		writeFileSync(join(rootPath, "data.bin"), Buffer.alloc(1024 * 1024, 0x61));

		const result = runDispatch(["gc", "--state-root", localStateRoot], {
			TMPDIR: parent,
		});

		strictEqual(result.status, 0, `gc failed: ${result.stderr}`);
		ok(
			result.stderr.includes("[gc]"),
			`expected [gc] progress on stderr, got: ${result.stderr}`,
		);
		ok(
			result.stderr.includes("Reading run records and direct temp children") ||
				result.stderr.includes("APFS private bytes"),
			`expected progress messages on stderr, got: ${result.stderr}`,
		);

		const parsed = JSON.parse(result.stdout.trim());
		strictEqual(parsed.schemaVersion, 1);
		ok(Array.isArray(parsed.roots));
		const root = parsed.roots.find((r) => r.path === rootPath);
		ok(root);
		strictEqual(root.deletionEligible, false);
	});
});
