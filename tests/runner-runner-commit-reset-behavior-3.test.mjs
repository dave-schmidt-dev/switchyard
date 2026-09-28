import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueue,
	runQueueWithOrchestrator,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);
const VALID_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
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
	it("sync path: a resetWorkingTree failure after a failed task halts the queue before the next task, keeping the failed task's durable checkpoint (Task 1.2)", () => {
		// INV-3 continuation reset: with stopOnFailure:false a failed task's
		// un-reset changes would bleed into the next task, so a reset failure
		// must stop the run before task 2's execute. The failed task's
		// checkpoint entry stays durable (INV-6, success:false and NOT in
		// completedTaskIds); the halt is a distinct halted_after_reset_failure
		// outcome — not a failure retroactively assigned to the failed task.
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
		const executes = [];
		const events = [];

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
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {
					throw new Error("reset exploded");
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
			"task 2's execute must never run after a reset failure",
		);
		strictEqual(result.processedTasks, 1);
		// The failed task's bookkeeping stays durable and un-completed.
		deepStrictEqual(result.completedTaskIds, []);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		strictEqual(checkpoint.results[0].taskId, "1.1");
		strictEqual(checkpoint.results[0].result, "integration_failed");
		strictEqual(checkpoint.results[0].success, false);
		// The outcome identifies a reset halt, action-specifically and durably.
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_reset_failure");
		strictEqual(result.results[1].action, "reset");
		strictEqual(result.results[1].success, false);
		ok(
			result.results[1].reason.includes("reset exploded"),
			"halt outcome carries the underlying reset failure detail",
		);
		strictEqual(checkpoint.results[1].result, "halted_after_reset_failure");
		strictEqual(checkpoint.results[1].action, "reset");
		// Raw command stderr must never reach the durable checkpoint.
		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("reset exploded"),
			"checkpoint.json must not embed the reset failure's raw message",
		);
		// The failure stays observable on the status channel and the terminal
		// status is truthful about the halt.
		const resetFailure = events.find(
			(e) =>
				e.event === "checkpoint_failed" &&
				e.status.startsWith("Checkpoint reset failed"),
		);
		ok(resetFailure, "checkpoint_failed event emitted for the reset failure");
		strictEqual(resetFailure.taskId, "1.1");
		ok(
			events.find((e) => e.event === "queue_halted"),
			"queue_halted event emitted when the run stops",
		);
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(terminal.status, "Queue halted: 1 tasks processed");
	});
	it("orchestrator path: a resetWorkingTree failure after a failed task halts the queue before the next launch (Task 1.2)", async () => {
		// Same INV-3 halt through the headless orchestrator path: task 2 must
		// never be launched once task 1's continuation reset failed.
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
		const launches = [];
		const events = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {
					throw new Error("orchestrator reset exploded");
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
			"task 2 must never be launched after a reset failure",
		);
		deepStrictEqual(launches[0].taskId, "1.1");
		strictEqual(result.processedTasks, 1);
		deepStrictEqual(result.completedTaskIds, []);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		strictEqual(checkpoint.results[0].result, "integration_failed");
		strictEqual(checkpoint.results[0].success, false);
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_reset_failure");
		strictEqual(result.results[1].action, "reset");
		strictEqual(result.results[1].success, false);
		strictEqual(checkpoint.results[1].result, "halted_after_reset_failure");
		strictEqual(checkpoint.results[1].action, "reset");
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(terminal.status, "Queue halted: 1 tasks processed");
	});
	it("failed and timed-out tasks still land in the checkpoint with success:false under the reordered flow", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Fails
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Times out
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText = "diff --git a/wip.mjs b/wip.mjs\n+work in progress";
		let callCount = 0;

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
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
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							callCount += 1;
							if (callCount === 1) {
								return { success: false, error: "provider crashed" };
							}
							return {
								success: false,
								error: "spawnSync docker ETIMEDOUT",
								timedOut: true,
							};
						},
						captureDiff: () => diffText,
					},
				},
			},
		});

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results.length, 2);
		deepStrictEqual(
			checkpoint.results.map((r) => r.success),
			[false, false],
		);
		deepStrictEqual(
			checkpoint.results.map((r) => r.result),
			["execution_failed", "execution_timed_out"],
		);
		strictEqual(checkpoint.results[1].timedOut, true);
		deepStrictEqual(checkpoint.completedTaskIds, []);
	});
	it("orchestrator path: failed and timed-out tasks land in the checkpoint with success:false under the reordered flow", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Fails
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Times out
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
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
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				// Deterministic orchestrator timeout: the first status poll
				// reports a running job whose expected_by is already in the
				// past relative to the injected clock, so waitForJobCompletion
				// returns timed_out without sleeping.
				now: () => 2_000_000_000_000,
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async (jobId) =>
						jobId === "job-1"
							? { state: "done" }
							: {
									state: "running",
									expected_by: "2020-01-01T00:00:00Z",
								},
					result: async () => ({
						success: false,
						error: "provider crashed",
					}),
				},
			},
		});

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results.length, 2);
		deepStrictEqual(
			checkpoint.results.map((r) => r.success),
			[false, false],
		);
		deepStrictEqual(
			checkpoint.results.map((r) => r.result),
			["execution_failed", "orchestrator_timed_out"],
		);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		// The orchestrator timeout verdict must reach the durable record, not
		// just the result string: the checkpoint's timedOut flag is truthful
		// for the orchestrator_timed_out outcome (and the in-memory result it
		// was derived from).
		strictEqual(result.results[1].timedOut, true);
		strictEqual(result.results[1].result, "orchestrator_timed_out");
		strictEqual(checkpoint.results[1].timedOut, true);
	});
});
