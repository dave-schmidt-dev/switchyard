import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	runnerTestDir,
	runQueueAsync,
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
describe("runner commit/reset behavior (Task 3.2)", () => {
	it("commits only after successful tasks, not after failed ones", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task

### Task 1.3: Third
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** third task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];
		let gateCalls = 0;
		let routeCalls = 0;
		let executeCalls = 0;

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => {
					routeCalls += 1;
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 72,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => {
					gateCalls += 1;
					if (gateCalls === 2) {
						return { success: false, message: "rejected" };
					}
					return { success: true, message: "ok" };
				},
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						executeAsync: async () => {
							executeCalls += 1;
							return { success: true, output: "ok" };
						},
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 3);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["success", "integration_failed", "success"],
		);
		strictEqual(commits.length, 2, "commit called after tasks 1 and 3 only");
		strictEqual(resets.length, 1, "reset called after failed task 2");
		strictEqual(
			routeCalls,
			3,
			"integration rejection must not re-route the task",
		);
		strictEqual(
			executeCalls,
			3,
			"integration rejection must not re-execute the task",
		);
	});
	it("resets rejected state before continuing when stopOnFailure is false", async () => {
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
		const commits = [];
		const resets = [];

		const result = await runQueueAsync({
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
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(commits.length, 0, "commit never called for failed tasks");
		strictEqual(resets.length, 2, "reset called after each failed task");
	});
	it("does not reset when stopOnFailure is true", async () => {
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
		const commits = [];
		const resets = [];

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: true,
			dependencies: {
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
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1, "stopped after first failure");
		strictEqual(commits.length, 0);
		strictEqual(
			resets.length,
			0,
			"reset not called when stopOnFailure is true",
		);
	});
	it("does not reset when working container is caller-supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied",
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
				integrationGate: () => ({ success: false, message: "rejected" }),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(commits.length, 0);
		strictEqual(
			resets.length,
			0,
			"reset not called when container is caller-supplied",
		);
	});
});
