import { deepStrictEqual, ok, strictEqual } from "node:assert";
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
	it("fires onTaskStart before and onResult after each task, in order", () => {
		// A serial dispatch blocks with no feedback during each multi-minute
		// provider exec. These hooks are the CLI's feedback path — assert they
		// fire interleaved (start then result, per task) so the surface can
		// print a line as each task begins and finishes.
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
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		deepStrictEqual(events, [
			"start:1.1",
			"result:1.1:true",
			"start:1.2",
			"result:1.2:true",
		]);
	});
	it("fires onTaskRouted with provider/model/deadline before the blocking adapter.execute call", () => {
		// Regression: task_started fires before routing decides a provider, so
		// an operator watching progress couldn't learn which provider/model was
		// picked until the (up to 30-minute) adapter call finished. onTaskRouted
		// must fire between routing and the execute call.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
- **Timeout:** 60s
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		const routedBefore = Date.now();

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
				onTaskRouted: (info) => events.push({ type: "routed", ...info }),
				adapters: {
					claude: {
						execute: () => {
							events.push({ type: "execute" });
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const routedAfter = Date.now();
		strictEqual(events.length, 2);
		strictEqual(events[0].type, "routed");
		strictEqual(events[0].taskId, "1.1");
		strictEqual(events[0].provider, "claude");
		strictEqual(events[0].model, "claude-sonnet-5");
		// The deadline must encode the task's declared Timeout (60s), not
		// merely "some future time" — a deadline hardcoded to now, or to the
		// wrong unit, fails this range check. runQueue is synchronous, so the
		// routing happens between the two timestamps captured around it and
		// deadline = routing time + 60s must land in [before, after] + 60s.
		const deadlineMs = new Date(events[0].deadline).getTime();
		ok(
			deadlineMs >= routedBefore + 60_000 && deadlineMs <= routedAfter + 60_000,
			`deadline must encode the 60s task Timeout, got ${events[0].deadline}`,
		);
		strictEqual(events[1].type, "execute", "routed must fire before execute");
	});
	it("emits a task_routed onStatus event with provider/model/deadline", () => {
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
			workingContainerName: "fake-container",
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
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const routed = events.find((e) => e.event === "task_routed");
		ok(routed, "task_routed event fired");
		strictEqual(routed.phase, "execution");
		strictEqual(routed.provider, "claude");
		strictEqual(routed.model, "claude-sonnet-5");
		ok(routed.deadline, "deadline present");

		const routedIndex = events.findIndex((e) => e.event === "task_routed");
		const completedIndex = events.findIndex(
			(e) => e.event === "task_completed",
		);
		ok(
			routedIndex < completedIndex,
			"task_routed must fire before task_completed",
		);
	});
	it("runner emits task_started, diff_captured, gate_validated, gate_applied, task_completed, checkpoint_saved, and cleanup events via onStatus", () => {
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
				onStatus: (e) =>
					events.push({
						phase: e.phase,
						event: e.event,
						outcome: e.outcome,
						byteCount: e.byteCount,
						taskId: e.taskId,
					}),
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

		const byEvent = {};
		for (const e of events) {
			byEvent[e.event] = e;
		}

		ok(byEvent.container_created, "container_created fired");
		strictEqual(byEvent.container_created.phase, "bootstrap");
		ok(byEvent.task_started, "task_started fired");
		strictEqual(byEvent.task_started.taskId, "1.1");
		ok(byEvent.diff_captured, "diff_captured fired");
		strictEqual(byEvent.diff_captured.byteCount, 18);
		ok(byEvent.gate_validated, "gate_validated fired");
		strictEqual(byEvent.gate_validated.outcome, "passed");
		ok(byEvent.gate_applied, "gate_applied fired");
		ok(byEvent.task_completed, "task_completed fired");
		strictEqual(byEvent.task_completed.taskId, "1.1");
		ok(byEvent.checkpoint_saved, "checkpoint_saved fired");
		ok(byEvent.terminal, "terminal fired");
		strictEqual(byEvent.terminal.phase, "lifecycle");
		ok(byEvent.cleanup_started, "cleanup_started fired");
		ok(byEvent.cleanup_complete, "cleanup_complete fired");
	});
	it("runner emits task_failed event with error serialization", () => {
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
						execute: () => ({
							success: false,
							error: "SECRET_CANARY_provider_failure",
						}),
						captureDiff: () => "",
					},
				},
			},
		});

		const failed = events.find((e) => e.event === "task_failed");
		ok(failed, "task_failed event emitted");
		strictEqual(failed.taskId, "1.1");
		ok(failed.error, "error field present");
		strictEqual(failed.errorKind, "execution_failed");
		strictEqual(failed.reasonCode, "execution_failed");
		strictEqual(
			failed.error.message,
			"Provider execution failed before a reviewed integration.",
		);
		ok(!JSON.stringify(events).includes("SECRET_CANARY_provider_failure"));
	});
	it("runner emits gate_validated event with rejected outcome on gate failure", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Gate-failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will be rejected
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
				integrationGate: () => ({
					success: false,
					message: "gate rejected diff",
				}),
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

		const validated = events.find((e) => e.event === "gate_validated");
		ok(validated, "gate_validated event emitted");
		strictEqual(validated.outcome, "rejected");
		strictEqual(validated.errorKind, "integration_failed");
		strictEqual(validated.reasonCode, "integration_failed");
		strictEqual(
			validated.status,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(validated.artifactRef, undefined);
		ok(
			!events.find((e) => e.event === "gate_applied"),
			"gate_applied not emitted on rejection",
		);
		ok(!JSON.stringify(events).includes("gate rejected diff"));
	});
});
