import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueue,
	runQueueWithOrchestrator,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("runner commit/reset behavior (Task 3.2)", () => {
	it("orchestrator path: does not reset when working container is caller-supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resets = [];

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				commitWorkingTree: () => {},
				resetWorkingTree: () => resets.push(true),
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(
			resets.length,
			0,
			"orchestrator: reset not called when container is caller-supplied",
		);
	});
	it("orchestrator path: resets when result returns success=false (execution_failed) with continuation", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resets = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: false,
						error: "execution_failed",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["execution_failed", "execution_failed"],
		);
		strictEqual(
			resets.length,
			2,
			"orchestrator: reset called after each execution_failed",
		);
	});
	it("sync path: a completed task is already in the durable checkpoint when commitWorkingTree throws (INV-6)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let checkpointAtCommit = null;

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					// Snapshot the checkpoint the instant commit is attempted.
					checkpointAtCommit = JSON.parse(readFileSync(checkpointPath, "utf8"));
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(checkpointAtCommit, "commitWorkingTree was attempted");
		// The checkpoint save runs ahead of the commit block, so a commit failure
		// can never strand a completed task outside the durable record.
		deepStrictEqual(checkpointAtCommit.completedTaskIds, ["1.1"]);
		strictEqual(checkpointAtCommit.results[0].taskId, "1.1");
		strictEqual(checkpointAtCommit.results[0].result, "success");
		strictEqual(checkpointAtCommit.results[0].success, true);
	});
	it("orchestrator path: a completed task is already in the durable checkpoint when commitWorkingTree throws (INV-6)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let checkpointAtCommit = null;

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					checkpointAtCommit = JSON.parse(readFileSync(checkpointPath, "utf8"));
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		ok(checkpointAtCommit, "commitWorkingTree was attempted");
		deepStrictEqual(checkpointAtCommit.completedTaskIds, ["1.1"]);
		strictEqual(checkpointAtCommit.results[0].taskId, "1.1");
		strictEqual(checkpointAtCommit.results[0].result, "success");
		strictEqual(checkpointAtCommit.results[0].success, true);
	});
	it("sync path: a commitWorkingTree failure halts the queue before the next task, keeping the completed task's durable checkpoint (Task 1.2)", () => {
		// INV-3: a success whose container baseline was not advanced is not
		// reusable — the next task would diff against (and re-emit) task 1's
		// uncommitted work. The run must stop before task 2's execute, even
		// with stopOnFailure:false (only the commit failure can stop it here).
		// Task 1's checkpoint stays on disk (INV-6); the halt is recorded as a
		// distinct outcome, not by failing task 1.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		const executes = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							executes.push(true);
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(
			executes.length,
			1,
			"task 2's execute must never run against an unadvanced container",
		);
		strictEqual(result.processedTasks, 1);
		// The completed task's durable checkpoint stays on disk (INV-6)...
		deepStrictEqual(result.completedTaskIds, ["1.1"]);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1"]);
		strictEqual(checkpoint.results[0].taskId, "1.1");
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].success, true);
		// ...and the halt is a distinct, recorded outcome — not a failure
		// assigned to the successfully completed task.
		strictEqual(result.results.length, 2);
		strictEqual(result.results[0].result, "success");
		strictEqual(result.results[1].result, "halted_after_commit_failure");
		strictEqual(result.results[1].success, false);
		strictEqual(result.results[1].action, "commit");
		ok(
			result.results[1].reason.includes("commit exploded"),
			"halt outcome carries the underlying commit failure detail",
		);
		strictEqual(checkpoint.results[1].result, "halted_after_commit_failure");
		// The durable halt entry carries the action-specific static fields
		// and never embeds the raw commit error message.
		strictEqual(checkpoint.results[1].action, "commit");
		strictEqual(checkpoint.results[1].success, false);
		strictEqual(checkpoint.results[1].timedOut, false);
		strictEqual(checkpoint.results[1].partialDiffPath, null);
		ok(
			!readFileSync(checkpointPath, "utf8").includes("commit exploded"),
			"checkpoint.json must not embed the commit failure's raw message",
		);
		// The failure stays observable on the status channel.
		const commitFailure = events.find(
			(e) =>
				e.event === "checkpoint_failed" &&
				e.status.startsWith("Checkpoint commit failed"),
		);
		ok(commitFailure, "checkpoint_failed event emitted for the commit failure");
		strictEqual(commitFailure.taskId, "1.1");
		ok(
			events.find((e) => e.event === "queue_halted"),
			"queue_halted event emitted when the run stops",
		);
		// The terminal status must not claim "Queue complete" for a halted run.
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(
			terminal.status,
			"Queue halted: 1 tasks processed",
			"a halted run reports a halted terminal status, not Queue complete",
		);
	});
	it("orchestrator path: a commitWorkingTree failure halts the queue before the next launch (Task 1.2)", async () => {
		// Same INV-3 halt through the headless orchestrator path: task 2 must
		// never be launched once task 1's container baseline commit failed.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw new Error("orchestrator commit exploded");
				},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async (payload) => {
						launches.push(payload);
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(
			launches.length,
			1,
			"task 2 must never be launched against an unadvanced container",
		);
		deepStrictEqual(launches[0].taskId, "1.1");
		strictEqual(result.processedTasks, 1);
		deepStrictEqual(result.completedTaskIds, ["1.1"]);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1"]);
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].success, true);
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_commit_failure");
		strictEqual(result.results[1].success, false);
		strictEqual(result.results[1].action, "commit");
		strictEqual(checkpoint.results[1].result, "halted_after_commit_failure");
		// The durable orchestrator halt entry carries the action-specific
		// static fields and never embeds the raw commit error message.
		strictEqual(checkpoint.results[1].action, "commit");
		strictEqual(checkpoint.results[1].success, false);
		strictEqual(checkpoint.results[1].timedOut, false);
		strictEqual(checkpoint.results[1].partialDiffPath, null);
		ok(
			!readFileSync(checkpointPath, "utf8").includes(
				"orchestrator commit exploded",
			),
			"checkpoint.json must not embed the commit failure's raw message",
		);
	});
});
