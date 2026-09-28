import { ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { collectGcInventory } from "../src/switchyard/dispatch/index.mjs";
import { ROSTER_FIXTURE_PATH } from "./helpers/dispatch-cli-fixtures.mjs";
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
	it("classifies roots across two private temp parents without claiming apparent sizes as private bytes", async () => {
		const localStateRoot = tempDir("gc-state-root-");
		const runsDir = join(localStateRoot, "runs");
		mkdirSync(runsDir, { recursive: true });

		const rawParent1 = tempDir("gc-temp-p1-");
		const rawParent2 = tempDir("gc-temp-p2-");
		const parent1 = realpathSync(rawParent1);
		const parent2 = realpathSync(rawParent2);

		// 1. recorded: exists on disk under parent1, active worktree in run record
		const candidate1 = "switchyard-simple-recorded-01";
		const path1 = join(parent1, candidate1);
		mkdirSync(path1, { recursive: true });
		writeFileSync(join(path1, "payload.txt"), "hello recorded root", "utf8"); // 19 bytes
		const runDir1 = join(runsDir, "run-recorded-1");
		mkdirSync(runDir1, { recursive: true });
		writeFileSync(
			join(runDir1, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId: "run-recorded-1",
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

		// 2. removed-but-exists: exists on disk under parent1, removed worktree in run record
		const candidate2 = "switchyard-simple-removed-02";
		const path2 = join(parent1, candidate2);
		mkdirSync(path2, { recursive: true });
		writeFileSync(join(path2, "residual.txt"), "residual data", "utf8"); // 13 bytes
		const runDir2 = join(runsDir, "run-removed-2");
		mkdirSync(runDir2, { recursive: true });
		writeFileSync(
			join(runDir2, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId: "run-removed-2",
				state: "succeeded",
				cleanupState: "complete",
				revision: 2,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: ["1.2"],
				initialHostFingerprint: "test-host",
				workerNonce: randomUUID(),
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
				worktree: {
					canonicalParent: parent1,
					candidateChild: candidate2,
					path: path2,
					state: "removed",
					reason: null,
					retainedAt: null,
				},
			}),
			"utf8",
		);

		// 3. missing: not on disk under parent1, active worktree in run record
		const candidate3 = "switchyard-simple-missing-03";
		const path3 = join(parent1, candidate3);
		// Note: directory path3 is NOT created on disk!
		const runDir3 = join(runsDir, "run-missing-3");
		mkdirSync(runDir3, { recursive: true });
		writeFileSync(
			join(runDir3, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId: "run-missing-3",
				state: "failed",
				cleanupState: "failed",
				revision: 3,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: ["1.3"],
				initialHostFingerprint: "test-host",
				workerNonce: randomUUID(),
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
				worktree: {
					canonicalParent: parent1,
					candidateChild: candidate3,
					path: path3,
					state: "retained",
					reason: "salvage_retained",
					retainedAt: new Date().toISOString(),
				},
			}),
			"utf8",
		);

		// 4. fixture: exists on disk under parent2, name includes fixture, active worktree in run record
		const candidate4 = "switchyard-simple-fixture-04";
		const path4 = join(parent2, candidate4);
		mkdirSync(path4, { recursive: true });
		writeFileSync(join(path4, "fixture.txt"), "fixture content bytes", "utf8"); // 21 bytes
		const runDir4 = join(runsDir, "run-fixture-4");
		mkdirSync(runDir4, { recursive: true });
		writeFileSync(
			join(runDir4, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId: "run-fixture-4",
				state: "running",
				cleanupState: "pending",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: ["1.4"],
				initialHostFingerprint: "test-host",
				workerNonce: randomUUID(),
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
				worktree: {
					canonicalParent: parent2,
					candidateChild: candidate4,
					path: path4,
					state: "active",
					reason: "fixture",
					retainedAt: null,
				},
			}),
			"utf8",
		);

		// 5. unknown: exists on disk under parent2, no run record
		const candidate5 = "switchyard-simple-unknown-05";
		const path5 = join(parent2, candidate5);
		mkdirSync(path5, { recursive: true });
		writeFileSync(
			join(path5, "untracked.txt"),
			"untracked unknown bytes",
			"utf8",
		); // 23 bytes

		// Collect GC inventory with parent1 as default tmpdir
		const inventory = await collectGcInventory(
			{ stateRoot: localStateRoot },
			{ tmpdir: () => parent1 },
		);

		// Both canonical parents discovered (parent1 from tmpdir, parent2 from run-fixture-4)
		ok(inventory.canonicalParents.includes(parent1));
		ok(inventory.canonicalParents.includes(parent2));

		// Check roots classification
		const root1 = inventory.roots.find((r) => r.path === path1);
		ok(root1, "recorded root must be found");
		strictEqual(root1.classification, "recorded");
		strictEqual(root1.runId, "run-recorded-1");
		strictEqual(root1.recordedState, "active");
		strictEqual(root1.exists, true);
		strictEqual(root1.bytes, null);
		strictEqual(root1.measurable, false);
		strictEqual(root1.unavailableReason, "private_bytes_unavailable");
		strictEqual(root1.deletionEligible, false);

		const root2 = inventory.roots.find((r) => r.path === path2);
		ok(root2, "removed-but-exists root must be found");
		strictEqual(root2.classification, "removed-but-exists");
		strictEqual(root2.runId, "run-removed-2");
		strictEqual(root2.recordedState, "removed");
		strictEqual(root2.exists, true);
		strictEqual(root2.bytes, null);
		strictEqual(root2.measurable, false);
		strictEqual(root2.unavailableReason, "private_bytes_unavailable");
		strictEqual(root2.deletionEligible, false);

		const root3 = inventory.roots.find((r) => r.path === path3);
		ok(root3, "missing root must be found");
		strictEqual(root3.classification, "missing");
		strictEqual(root3.runId, "run-missing-3");
		strictEqual(root3.recordedState, "retained");
		strictEqual(root3.exists, false);
		strictEqual(root3.bytes, null);
		strictEqual(root3.measurable, false);
		strictEqual(root3.unavailableReason, "private_bytes_unavailable");
		strictEqual(root3.deletionEligible, false);

		const root4 = inventory.roots.find((r) => r.path === path4);
		ok(root4, "fixture root must be found");
		strictEqual(root4.classification, "fixture");
		strictEqual(root4.runId, "run-fixture-4");
		strictEqual(root4.recordedState, "active");
		strictEqual(root4.exists, true);
		strictEqual(root4.bytes, null);
		strictEqual(root4.measurable, false);
		strictEqual(root4.unavailableReason, "private_bytes_unavailable");
		strictEqual(root4.deletionEligible, false);

		const root5 = inventory.roots.find((r) => r.path === path5);
		ok(root5, "unknown root must be found");
		strictEqual(root5.classification, "unknown");
		strictEqual(root5.runId, null);
		strictEqual(root5.recordedState, null);
		strictEqual(root5.exists, true);
		strictEqual(root5.bytes, null);
		strictEqual(root5.measurable, false);
		strictEqual(root5.unavailableReason, "private_bytes_unavailable");
		strictEqual(root5.deletionEligible, false);

		// Summary checks
		strictEqual(inventory.summary.totalRoots, 5);
		strictEqual(inventory.summary.measurable, false);
		strictEqual(inventory.summary.totalBytes, null);

		strictEqual(inventory.summary.byClass.recorded.count, 1);
		strictEqual(inventory.summary.byClass.recorded.bytes, null);

		strictEqual(inventory.summary.byClass["removed-but-exists"].count, 1);
		strictEqual(inventory.summary.byClass["removed-but-exists"].bytes, null);

		strictEqual(inventory.summary.byClass.missing.count, 1);
		strictEqual(inventory.summary.byClass.missing.bytes, null);

		strictEqual(inventory.summary.byClass.fixture.count, 1);
		strictEqual(inventory.summary.byClass.fixture.bytes, null);

		strictEqual(inventory.summary.byClass.unknown.count, 1);
		strictEqual(inventory.summary.byClass.unknown.bytes, null);
	});
});
