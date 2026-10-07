import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	executeTaskAsync,
	parseTaskQueue,
} from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
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
function parseFixture(markdown) {
	return parseTaskQueue(withExplicitSwitchyardExecutor(markdown));
}
function defaultRoute() {
	return {
		provider: "claude",
		model: "claude-sonnet-5",
		percentLeft: 50,
		reason: "spread",
	};
}
// Async-only task context: the broker seam is stubbed and the descriptor is
// derived from the routed provider/model so executeTaskAsync can run without
// the synchronous router.
function asyncTaskContext({
	integrationGate,
	recordDispatch = () => {},
	captureDiff = async () => "diff --git a/a b/a",
}) {
	let latestDescriptor = null;
	return {
		broker: {
			selectAndReserve: async (request) => {
				const routed = defaultRoute();
				latestDescriptor = descriptorForRoute(routed);
				return {
					provider: routed.provider,
					model: routed.model,
					resolvedTarget: routed.provider,
					harness: routed.provider,
					capability: request.capability,
					reason: routed.reason,
					reservation: { id: "test-reservation" },
					snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
				};
			},
			launcherIdentity: () => ({}),
			execute: async () => ({ success: true, output: "ok" }),
			release: async () => {},
		},
		resolveDescriptor: () => latestDescriptor,
		recordDispatch,
		recordDispatchIntent: () => {},
		integrationGate,
		adapters: {
			claude: {
				executeAsync: async () => ({ success: true, output: "ok" }),
				captureDiffAsync: captureDiff,
			},
		},
		queueBackend: {
			captureTaskBase: () => TASK_BASE,
			validateTaskBase: (_workspaceId, base) => base,
			releaseTaskBase: () => {},
		},
		projectPath: TEST_DIR,
		workingContainerName: "fake-container",
	};
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("Files allowlist propagation", () => {
	it("passes unwrapped Files paths as allowedPaths to integrationGate", async () => {
		const markdown = `## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** \`src/a.mjs\`, \`tests/a.test.mjs\`
- **Description:** simple cleanup
`;
		const task = parseFixture(markdown)[0];
		const gateCalls = [];
		const result = await executeTaskAsync(
			task,
			asyncTaskContext({
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
			}),
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		deepStrictEqual(gateCalls[0].options.allowedPaths, [
			"src/a.mjs",
			"tests/a.test.mjs",
		]);
	});

	it("executeTask passes Files as allowedPaths to integrationGate", async () => {
		const gateCalls = [];
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: ["src/a.mjs", "tests/a.test.mjs"],
			},
			asyncTaskContext({
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
			}),
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		deepStrictEqual(gateCalls[0].options.allowedPaths, [
			"src/a.mjs",
			"tests/a.test.mjs",
		]);
	});

	it("executeTask passes null allowedPaths to integrationGate when task has none", async () => {
		const gateCalls = [];
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: null,
			},
			asyncTaskContext({
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
			}),
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.allowedPaths, null);
	});

	it("executeTask calls integrationGate with empty diff when requiredPaths is set (not success_no_diff)", async () => {
		const gateCalls = [];
		const dispatches = [];
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: ["src/f.mjs"],
			},
			asyncTaskContext({
				recordDispatch: (entry) => dispatches.push(entry),
				captureDiff: async () => "",
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: false, message: "empty_required_diff" };
				},
			}),
		);

		strictEqual(result.success, false);
		strictEqual(result.result, "integration_failed");
		strictEqual(result.errorKind, "integration_failed");
		strictEqual(result.reasonCode, "integration_failed");
		strictEqual(
			result.reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(result.diagnosticCode, "empty_required_diff");
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].diff, "");
		deepStrictEqual(gateCalls[0].options.allowedPaths, ["src/f.mjs"]);
		strictEqual(dispatches[0].result, "integration_failed");
		strictEqual(dispatches[0].errorKind, "integration_failed");
		strictEqual(dispatches[0].reasonCode, "integration_failed");
		strictEqual(
			dispatches[0].reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(dispatches[0].diagnosticCode, "empty_required_diff");
	});
});
describe("runner runStore dependency", () => {
	it("calls runStore.updateRun during task execution with activeTaskId", async () => {
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

		const runStoreCalls = [];
		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: defaultRoute,
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
				runStore,
			},
		});

		strictEqual(result.processedTasks, 2);

		// BLOCKED (Task 5.5): runQueueAsync never calls runStore.updateRun({activeTaskId}) at task start, so the two task-start activeTaskId calls ("1.1", "1.2") cannot be asserted.
		// BLOCKED (Task 5.5): runQueueAsync never calls runStore.updateRun({}) after a task settles, so the two empty-projection calls cannot be asserted.
		// BLOCKED (Task 5.5): runQueueAsync issues no terminal runStore.updateRun({state: "succeeded", activeTaskId: null, cleanupState, terminalizedBy: "worker"}); that terminal projection assertion cannot be ported.
	});

	it("runStore terminal call sets state to failed when tasks fail", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const runStoreCalls = [];
		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: defaultRoute,
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: false,
							error: "simulated failure",
						}),
						captureDiffAsync: async () => "",
					},
				},
				runStore,
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].result, "execution_failed");
		strictEqual(result.results[0].errorKind, "execution_failed");
		notStrictEqual(result.results[0].errorKind, "unclassified");
		// BLOCKED (Task 5.5): runQueueAsync issues no terminal runStore.updateRun({state: "failed", activeTaskId: null, cleanupState, terminalizedBy: "worker", lastFailure}); the terminal-call and isPersistentFailureMetadata(lastFailure) assertions cannot be ported.
	});

	it("calls onCheckpointSaved after each checkpoint save", async () => {
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
		const checkpoints = [];

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: defaultRoute,
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
				onCheckpointSaved: () => checkpoints.push(true),
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(checkpoints.length, 2);
	});
});
