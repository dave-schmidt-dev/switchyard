import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	runnerTestDir,
	runQueue,
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
describe("runner progress hooks (INV-1: no silent waits)", () => {
	it("runner emits checkpoint events (checkpoint_saved) for each task", () => {
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

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
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
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const checkpoints = events.filter((e) => e.event === "checkpoint_saved");
		strictEqual(checkpoints.length, 2);
		strictEqual(checkpoints[0].taskId, "1.1");
		strictEqual(checkpoints[1].taskId, "1.2");
	});
	it("runner emits container_created when it creates a working container", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
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
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const created = events.find((e) => e.event === "container_created");
		ok(created, "container_created event emitted");
		strictEqual(created.phase, "bootstrap");
	});
	it("does NOT emit container_created when working container is supplied by caller", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied-container",
			checkpointPath,
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
				createWorkingContainer: () => "should-not-be-used",
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(
			events.find((e) => e.event === "container_created"),
			undefined,
			"container_created not emitted for caller-supplied container",
		);
	});
	it("onStatus absence: existing behavior unchanged (no new output when hook not provided)", () => {
		// Regression guard: ensure that when neither onStatus nor diagnostics
		// is provided, runQueue behaves exactly as before — no errors, no
		// new side effects.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
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
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].success, true);
	});
	it("supports Diagnostics instance via dependencies.diagnostics", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		// Build a minimal diagnostics-like interface inline.
		const diag = {
			emit: (e) => events.push(e),
		};

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				diagnostics: diag,
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
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(events.length > 0, "diagnostics.emit was called");
		ok(
			events.find((e) => e.event === "task_completed"),
			"task_completed event via diagnostics",
		);
	});
	it("cleanup_failed event is emitted when wipe fails", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		throws(() => {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
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
					createWorkingContainer: () => "generated-diag-container",
					provisionCredentials: () => 1,
					seedProject: () => {},
					commitWorkingTree: () => {},
					wipeWorkingContainer: () => {
						throw new Error("wipe exploded");
					},
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
					},
				},
			});
		}, /wipe exploded/);

		const failed = events.find((e) => e.event === "cleanup_failed");
		ok(failed, "cleanup_failed event emitted");
		strictEqual(failed.phase, "cleanup");
		ok(
			events.find((e) => e.event === "cleanup_started"),
			"cleanup_started was emitted first",
		);
	});
	it("Diagnostics instance supports multiple sinks via dependencies.diagnostics", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const sinkA = [];
		const sinkB = [];
		const d = {
			_sinks: [],
			emit(event) {
				for (const s of this._sinks) s(event);
			},
			sink(fn) {
				this._sinks.push(fn);
			},
			removeSink(fn) {
				this._sinks = this._sinks.filter((s) => s !== fn);
			},
		};
		d.sink((e) => sinkA.push(e));
		d.sink((e) => sinkB.push(e));

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				diagnostics: d,
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
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(
			sinkA.length === sinkB.length,
			"both sinks received same number of events",
		);
		ok(sinkA.length > 0, "sink A received events");
		deepStrictEqual(
			sinkA.map((e) => e.event),
			sinkB.map((e) => e.event),
		);
	});
	it("fires onResult with success:false when a task fails", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
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
				onTaskStart: (task) => events.push(`start:${task.id}`),
				onResult: (result) =>
					events.push(`result:${result.taskId}:${result.success}`),
				adapters: {
					claude: {
						execute: () => ({ success: false, error: "simulated failure" }),
						captureDiff: () => "",
					},
				},
			},
		});

		deepStrictEqual(events, ["start:1.1", "result:1.1:false"]);
	});
});
