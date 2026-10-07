import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueueAsync,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

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
describe("runner orchestration", () => {
	it("re-evaluates dependencies after each successful task", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Root task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** none
- **Description:** Root operation

### Task 1.2: Dependent task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** Task 1.1
- **Description:** Dependent operation
`);
		const dispatches = [];
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.runnableTasks, 1);
		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			dispatches.map((dispatch) => dispatch.taskId),
			["1.1", "1.2"],
		);
	});

	it("executes tasks serially and checkpoints completion", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		const prompts = [];

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: (entry) => dispatches.push(entry),
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					executeAsync: async (prompt) => {
						prompts.push(prompt);
						return { success: true, output: "ok" };
					},
					captureDiffAsync: async () => "diff --git a/a b/a",
				},
				codex: {
					executeAsync: async () => ({ success: true, output: "ok" }),
					captureDiffAsync: async () => "diff --git a/b b/b",
				},
			},
		};

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(result.completedTaskIds.length, 2);
		strictEqual(dispatches.length, 2);
		deepStrictEqual(prompts, [
			"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** First operation",
			"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** Second operation",
		]);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1", "1.2"]);
	});

	it("resumes from checkpoint and only runs remaining work", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const prompts = [];

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					executeAsync: async (prompt) => {
						prompts.push(prompt);
						return { success: true, output: "ok" };
					},
					captureDiffAsync: async () => "diff --git a/a b/a",
				},
				codex: {
					executeAsync: async () => ({ success: true, output: "ok" }),
					captureDiffAsync: async () => "diff --git a/b b/b",
				},
			},
		};

		await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
			maxTasks: 1,
		});

		await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		deepStrictEqual(prompts, [
			"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** First operation",
			"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** Second operation",
		]);
	});

	it("treats an exactly selected completed task as already_complete without routing", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Already complete
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** Already completed operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let routeCalls = 0;
		const dependencies = {
			route: () => {
				routeCalls += 1;
				throw new Error("completed exact selection must not route");
			},
			recordDispatch: () => {
				throw new Error("completed exact selection must not dispatch");
			},
			adapters: {},
		};

		// Seed an identity-bound checkpoint through the normal queue path so the
		// exact selection has durable successful-completion evidence to reconcile.
		await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			taskIds: ["1.1"],
			dependencies: {
				route: () => ({ provider: "claude", model: "sonnet", reason: "test" }),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true }),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
			},
		});

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			taskIds: ["1.1"],
			dependencies,
		});

		strictEqual(routeCalls, 0);
		strictEqual(result.results.length, 1);
		strictEqual(result.results[0].result, "already_complete");
		strictEqual(result.results[0].success, true);
		strictEqual(
			loadCheckpoint(checkpointPath, tasksPath, {
				queueIdentity: result.queueIdentity,
				runOptions: result.runOptions,
			}).results.at(-1).result,
			"already_complete",
		);
	});
	it("captures and releases a fresh immutable base for each terminal task", async () => {
		const tasksPath = writeTasksFile(`
### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const captured = [];
		const released = [];
		const persistedBeforeExecute = [];
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "worker",
			checkpointPath,
			dependencies: {
				route: () => ({ provider: "claude", model: "test-model" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				captureTaskBase: (_workspaceId, { taskId }) => {
					captured.push(taskId);
					return {
						ref: `refs/switchyard/task-base/run/${taskId}`,
						tree: taskId === "1.1" ? "1".repeat(40) : "2".repeat(40),
					};
				},
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: (_workspaceId, base) => released.push(base.ref),
				adapters: {
					claude: {
						executeAsync: async () => {
							const taskId = captured.at(-1);
							persistedBeforeExecute.push(
								Boolean(
									JSON.parse(readFileSync(checkpointPath, "utf8")).taskBases[
										taskId
									],
								),
							);
							return { success: true };
						},
						captureDiffAsync: async () => "diff --git a/src/a.mjs b/src/a.mjs",
					},
				},
				integrationGate: () => ({ success: true }),
			},
		});
		strictEqual(result.completedTaskIds.length, 2);
		deepStrictEqual(captured, ["1.1", "1.2"]);
		deepStrictEqual(persistedBeforeExecute, [true, true]);
		deepStrictEqual(released, [
			"refs/switchyard/task-base/run/1.1",
			"refs/switchyard/task-base/run/1.2",
		]);
		deepStrictEqual(
			JSON.parse(readFileSync(checkpointPath, "utf8")).taskBases,
			{},
		);
	});

	it("persists task-base release uncertainty and prevents reuse", async () => {
		const tasksPath = writeTasksFile(`
### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "worker",
			checkpointPath,
			dependencies: {
				route: () => ({ provider: "claude", model: "test-model" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				captureTaskBase: () => TASK_BASE,
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: () => {
					throw new Error("uncertain");
				},
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true }),
						captureDiffAsync: async () => "diff --git a/src/a.mjs b/src/a.mjs",
					},
				},
				integrationGate: () => ({ success: true }),
			},
		});
		strictEqual(
			result.results.at(-1).result,
			"halted_after_task_base_release_failure",
		);
		const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
		strictEqual(checkpoint.taskBases["1.1"].ref, TASK_BASE.ref);
		strictEqual(checkpoint.taskBases["1.1"].tree, TASK_BASE.tree);
		strictEqual(checkpoint.taskBases["1.1"].cleanupContext.operation, "helper");
		strictEqual(checkpoint.taskBaseReleaseUncertain.taskId, "1.1");
	});

	it("captures a new base when a terminal failure is retried in a fresh workspace", async () => {
		const tasksPath = writeTasksFile(`
### Task 1.1: Retryable in a new run
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** retry later
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const captured = [];
		const makeDependencies = (success) => ({
			route: () => ({ provider: "claude", model: "test-model" }),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			captureTaskBase: (workspaceId) => {
				captured.push(workspaceId);
				return {
					ref: `refs/switchyard/task-base/run-${captured.length}/1.1`,
					tree: String(captured.length).repeat(40),
				};
			},
			validateTaskBase: (_workspaceId, base) => base,
			releaseTaskBase: () => {},
			adapters: {
				claude: {
					executeAsync: async () => ({ success }),
					captureDiffAsync: async () => "diff --git a/src/a.mjs b/src/a.mjs",
				},
			},
			integrationGate: () => ({ success: true }),
		});
		const failed = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "worker-one",
			checkpointPath,
			dependencies: makeDependencies(false),
		});
		strictEqual(failed.results[0].success, false);
		deepStrictEqual(
			JSON.parse(readFileSync(checkpointPath, "utf8")).taskBases,
			{},
		);
		const retried = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "worker-two",
			checkpointPath,
			dependencies: makeDependencies(true),
		});
		strictEqual(retried.results.at(-1).success, true);
		deepStrictEqual(captured, ["worker-one", "worker-two"]);
	});
});
