import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { collectGcInventory } from "../src/switchyard/dispatch/index.mjs";
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
	it("CLI output produces valid JSON inventory across discovered parents", () => {
		const localStateRoot = tempDir("gc-cli-state-");
		const runsDir = join(localStateRoot, "runs");
		mkdirSync(runsDir, { recursive: true });

		const rawParent1 = tempDir("gc-cli-p1-");
		const parent1 = realpathSync(rawParent1);
		const candidate1 = "switchyard-simple-cli-rec";
		const path1 = join(parent1, candidate1);
		mkdirSync(path1, { recursive: true });
		writeFileSync(join(path1, "file.txt"), "cli test payload", "utf8");

		const runDir1 = join(runsDir, "run-cli-1");
		mkdirSync(runDir1, { recursive: true });
		writeFileSync(
			join(runDir1, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId: "run-cli-1",
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
					canonicalParent: parent1,
					candidateChild: candidate1,
					path: path1,
					state: "active",
					reason: null,
					retainedAt: null,
				},
			}),
			"utf8",
		);

		const result = runDispatch(["gc", "--state-root", localStateRoot], {
			TMPDIR: parent1,
		});
		strictEqual(result.status, 0, `CLI failed: ${result.stderr}`);
		const parsed = JSON.parse(result.stdout.trim());
		ok(parsed.roots.length >= 1);
		const found = parsed.roots.find((r) => r.path === path1);
		ok(found);
		strictEqual(found.classification, "recorded");
		strictEqual(found.runId, "run-cli-1");
		strictEqual(found.deletionEligible, false);
	});
	it("CLI --apply preserves fixture and unknown paths", () => {
		const localStateRoot = tempDir("gc-apply-state-");
		const rawParent = tempDir("gc-apply-parent-");
		const parent = realpathSync(rawParent);

		const fixtureChild = "switchyard-simple-fixture-keep";
		const fixtureDir = join(parent, fixtureChild);
		mkdirSync(fixtureDir, { recursive: true });
		const fixtureFile = join(fixtureDir, "important-fixture.txt");
		writeFileSync(fixtureFile, "precious-fixture-content", "utf8");

		const unknownChild = "switchyard-simple-unknown-keep";
		const unknownDir = join(parent, unknownChild);
		mkdirSync(unknownDir, { recursive: true });
		const unknownFile = join(unknownDir, "keep.txt");
		writeFileSync(unknownFile, "precious-unknown-content", "utf8");

		// Run switchyard-dispatch gc --apply
		const result = runDispatch(
			["gc", "--apply", "--state-root", localStateRoot],
			{ TMPDIR: parent },
		);

		strictEqual(result.status, 0, result.stderr);
		const inventory = JSON.parse(result.stdout);
		strictEqual(inventory.apply.removed, 0);

		// Every fixture path must remain intact and unchanged
		ok(existsSync(fixtureDir), "fixture dir must exist after --apply refusal");
		ok(
			existsSync(fixtureFile),
			"fixture file must exist after --apply refusal",
		);
		strictEqual(
			readFileSync(fixtureFile, "utf8"),
			"precious-fixture-content",
			"fixture content must remain unchanged",
		);

		// Unknown path must also remain intact
		ok(existsSync(unknownDir), "unknown dir must exist after --apply refusal");
		ok(
			existsSync(unknownFile),
			"unknown file must exist after --apply refusal",
		);
		strictEqual(
			readFileSync(unknownFile, "utf8"),
			"precious-unknown-content",
			"unknown content must remain unchanged",
		);
	});
	it("reports path ambiguity as unavailable when a symlink is encountered", async () => {
		const localStateRoot = tempDir("gc-symlink-state-");
		const rawParent = tempDir("gc-symlink-parent-");
		const parent = realpathSync(rawParent);

		const targetDir = join(parent, "switchyard-simple-target");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "file.txt"), "target file", "utf8");

		const symlinkChild = "switchyard-simple-symlink-entry";
		const symlinkPath = join(parent, symlinkChild);
		symlinkSync(targetDir, symlinkPath);

		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot },
			{ tmpdir: () => parent },
		);

		const symlinkRoot = inventory.roots.find((r) => r.path === symlinkPath);
		ok(symlinkRoot, "symlink root must be listed in inventory");
		strictEqual(symlinkRoot.pathAmbiguity, true);
		strictEqual(symlinkRoot.measurable, false);
		strictEqual(symlinkRoot.unavailableReason, "path_ambiguity");
		strictEqual(symlinkRoot.deletionEligible, false);

		strictEqual(inventory.summary.measurable, false);
		strictEqual(inventory.summary.totalBytes, null);
		strictEqual(
			inventory.summary.unavailableReason,
			"private_bytes_unavailable",
		);
	});
	it("reads only direct inventory directories and preserves nested content", async () => {
		const localStateRoot = tempDir("gc-bounded-state-");
		const parent = realpathSync(tempDir("gc-bounded-parent-"));
		const root = join(parent, "switchyard-simple-kept");
		const nested = join(root, "nested", "switchyard-simple-not-a-root");
		mkdirSync(nested, { recursive: true });
		const payload = join(nested, "payload.txt");
		writeFileSync(payload, "preserved content");
		const directoriesRead = [];
		const pathsStatted = [];
		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot },
			{
				tmpdir: parent,
				readdir: async (path, options) => {
					directoriesRead.push(path);
					return readdir(path, options);
				},
				lstat: async (path) => {
					pathsStatted.push(path);
					return lstat(path);
				},
			},
		);
		deepStrictEqual(directoriesRead, [join(localStateRoot, "runs"), parent]);
		ok(pathsStatted.every((path) => path === parent || path === root));
		strictEqual(inventory.roots.length, 1);
		strictEqual(inventory.roots[0].bytes, null);
		strictEqual(
			inventory.roots[0].unavailableReason,
			"private_bytes_unavailable",
		);
		strictEqual(inventory.roots[0].deletionEligible, false);
		strictEqual(readFileSync(payload, "utf8"), "preserved content");
	});
	it("skips regular files and detects fixture markers through injected existence", async () => {
		const localStateRoot = tempDir("gc-entry-types-state-");
		const parent = realpathSync(tempDir("gc-entry-types-parent-"));
		const file = join(parent, "switchyard-simple-regular-file");
		const root = join(parent, "switchyard-simple-marker-root");
		writeFileSync(file, "keep");
		mkdirSync(root);
		const marker = join(root, ".fixture");
		const existsCalls = [];
		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot },
			{
				tmpdir: parent,
				existsSync: (path) => {
					existsCalls.push(path);
					return path === root || path === marker;
				},
			},
		);
		strictEqual(
			inventory.roots.some((entry) => entry.path === file),
			false,
		);
		strictEqual(inventory.roots.length, 1);
		strictEqual(inventory.roots[0].path, root);
		strictEqual(inventory.roots[0].classification, "fixture");
		ok(existsCalls.includes(marker));
		strictEqual(readFileSync(file, "utf8"), "keep");
	});
	it("programmatic inventory remains read-only even when apply is requested", async () => {
		const parent = realpathSync(tempDir("gc-inventory-apply-"));
		const root = join(parent, "switchyard-simple-unknown");
		mkdirSync(root);
		const inventory = await collectGcInventory(
			{ apply: true, stateRoot: tempDir("gc-inventory-state-") },
			{ tmpdir: () => parent },
		);
		strictEqual(
			inventory.roots.find((entry) => entry.path === root).deletionEligible,
			false,
		);
		ok(existsSync(root));
	});
	it("fails closed when the OS temp parent cannot be canonicalized", async () => {
		const localStateRoot = tempDir("gc-canonical-state-");
		let reads = 0;
		await rejects(
			collectGcInventory(
				{ stateRoot: localStateRoot },
				{
					tmpdir: "/missing-temp-parent",
					realpathSync: () => {
						throw new Error("unavailable");
					},
					readdir: () => {
						reads += 1;
						return [];
					},
				},
			),
			/parent_canonicalization_failed/,
		);
		strictEqual(reads, 0);
	});
	it("reports an unavailable record when its canonical parent now resolves elsewhere", async () => {
		const localStateRoot = tempDir("gc-parent-alias-state-");
		mkdirSync(join(localStateRoot, "runs", "run-alias"), { recursive: true });
		const parent = realpathSync(tempDir("gc-parent-alias-"));
		const alias = join(parent, "alias");
		symlinkSync(parent, alias);
		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot },
			{
				tmpdir: parent,
				readRun: async () => ({
					runId: "run-alias",
					worktree: {
						canonicalParent: alias,
						candidateChild: "switchyard-simple-retained",
						state: "retained",
					},
				}),
			},
		);
		strictEqual(inventory.roots.length, 1);
		strictEqual(inventory.roots[0].classification, "unavailable");
		strictEqual(inventory.roots[0].exists, null);
		strictEqual(
			inventory.roots[0].unavailableReason,
			"parent_canonicalization_failed",
		);
		strictEqual(inventory.roots[0].deletionEligible, false);
	});
	it("preserves both run claims when records name the same root", async () => {
		const localStateRoot = tempDir("gc-conflict-state-");
		const parent = realpathSync(tempDir("gc-conflict-parent-"));
		const candidateChild = "switchyard-simple-conflict";
		const path = join(parent, candidateChild);
		mkdirSync(path);
		for (const runId of ["run-first", "run-second"]) {
			mkdirSync(join(localStateRoot, "runs", runId), { recursive: true });
		}
		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot },
			{
				tmpdir: parent,
				readRun: async (runId) => ({
					runId,
					worktree: {
						canonicalParent: parent,
						candidateChild,
						state: "retained",
					},
				}),
			},
		);
		const root = inventory.roots.find((entry) => entry.path === path);
		deepStrictEqual(root.runIds, ["run-first", "run-second"]);
		strictEqual(root.classification, "conflicting-records");
		strictEqual(root.pathAmbiguity, true);
		strictEqual(root.deletionEligible, false);
	});
	it("does not label an unreadable parent as missing roots", async () => {
		const localStateRoot = tempDir("gc-parent-read-state-");
		const parent = realpathSync(tempDir("gc-parent-read-"));
		await rejects(
			collectGcInventory(
				{ stateRoot: localStateRoot },
				{
					tmpdir: parent,
					readdir: async (path, options) => {
						if (path === parent) throw new Error("parent unreadable");
						return readdir(path, options);
					},
				},
			),
			/parent unreadable/,
		);
	});
	it("reports unresolved child canonicalization as path ambiguity", async () => {
		const localStateRoot = tempDir("gc-child-realpath-state-");
		const parent = realpathSync(tempDir("gc-child-realpath-"));
		const root = join(parent, "switchyard-simple-unresolved");
		mkdirSync(root);
		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot },
			{
				tmpdir: parent,
				realpathSync: (path) => {
					if (path === root) throw new Error("unavailable");
					return realpathSync(path);
				},
			},
		);
		strictEqual(inventory.roots[0].pathAmbiguity, true);
		strictEqual(inventory.roots[0].bytes, null);
		strictEqual(inventory.roots[0].unavailableReason, "path_ambiguity");
		strictEqual(inventory.roots[0].deletionEligible, false);
	});
});
