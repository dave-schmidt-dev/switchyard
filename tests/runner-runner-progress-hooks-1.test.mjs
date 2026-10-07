import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runQueueAsync } from "./helpers/async-runner-fixtures.mjs";
import {
	runnerTestDir,
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
	it("fires onTaskStart before and onResult after each task, in order", async () => {
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

		await runQueueAsync({
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
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
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
	it("fires onTaskRouted with provider/model/deadline before the blocking adapter.execute call", async () => {
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

		await runQueueAsync({
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
						executeAsync: async () => {
							events.push({ type: "execute" });
							return { success: true, output: "ok" };
						},
						captureDiffAsync: async () => "diff --git a/a b/a",
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
		// wrong unit, fails this range check. runQueueAsync routes inside the
		// await between the two timestamps captured around it, so
		// deadline = routing time + 60s must land in [before, after] + 60s.
		const deadlineMs = new Date(events[0].deadline).getTime();
		ok(
			deadlineMs >= routedBefore + 60_000 && deadlineMs <= routedAfter + 60_000,
			`deadline must encode the 60s task Timeout, got ${events[0].deadline}`,
		);
		strictEqual(events[1].type, "execute", "routed must fire before execute");
	});
	it("emits a task_routed onStatus event with provider/model/deadline", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		await runQueueAsync({
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
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
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
		const capturedIndex = events.findIndex((e) => e.event === "diff_captured");
		// BLOCKED (Task 5.7): async onStatus emits no task_completed event, so routed-before-task_completed is asserted against diff_captured.
		ok(
			routedIndex >= 0 && routedIndex < capturedIndex,
			"task_routed must fire before diff_captured",
		);
	});
	it("runner emits task_started, diff_captured, gate_validated, gate_applied, task_completed, checkpoint_saved, and cleanup events via onStatus", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		const wiped = [];
		let gateCalls = 0;

		const result = await runQueueAsync({
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
				integrationGate: () => {
					gateCalls += 1;
					return { success: true, message: "ok" };
				},
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: (name) => wiped.push(name),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
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
		// BLOCKED (Task 5.7): async onStatus emits no task_started event.
		ok(byEvent.diff_captured, "diff_captured fired");
		strictEqual(byEvent.diff_captured.byteCount, 18);
		// gate_validated passed: the gate ran and the task result is a success.
		strictEqual(gateCalls, 1);
		strictEqual(result.results[0].success, true);
		strictEqual(result.results[0].taskId, "1.1");
		// BLOCKED (Task 5.7): async onStatus emits no gate_applied or task_completed event.
		deepStrictEqual(result.completedTaskIds, ["1.1"]);
		// checkpoint_saved: the checkpoint file records the completed task.
		ok(existsSync(checkpointPath), "checkpoint saved");
		deepStrictEqual(
			JSON.parse(readFileSync(checkpointPath, "utf8")).completedTaskIds,
			["1.1"],
		);
		// BLOCKED (Task 5.7): async onStatus emits no terminal, cleanup_started or cleanup_complete event; container wipe is asserted instead.
		deepStrictEqual(wiped, ["generated-diag-container"]);
	});
	it("runner emits task_failed event with error serialization", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		const result = await runQueueAsync({
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
						executeAsync: async () => ({
							success: false,
							error: "SECRET_CANARY_provider_failure",
						}),
						captureDiffAsync: async () => "",
					},
				},
			},
		});

		const failed = result.results.find((r) => r.taskId === "1.1");
		ok(failed, "task_failed result recorded");
		strictEqual(failed.success, false);
		strictEqual(failed.errorKind, "execution_failed");
		strictEqual(failed.result, "execution_failed");
		ok(failed.error, "error field present");
		// BLOCKED (Task 5.7): async task_failed is not an onStatus event and its result carries no reasonCode or sanitized error.message.
		ok(
			!JSON.stringify([events, result]).includes(
				"SECRET_CANARY_provider_failure",
			),
		);
	});
	it("runner emits gate_validated event with rejected outcome on gate failure", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Gate-failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will be rejected
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		const result = await runQueueAsync({
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
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
			},
		});

		const validated = result.results.find((r) => r.taskId === "1.1");
		ok(validated, "rejected gate result recorded");
		strictEqual(validated.success, false);
		strictEqual(validated.result, "integration_failed");
		strictEqual(validated.errorKind, "integration_failed");
		strictEqual(validated.reasonCode, "integration_failed");
		strictEqual(
			validated.reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(validated.artifactRef, undefined);
		ok(
			!events.find((e) => e.event === "gate_applied"),
			"gate_applied not emitted on rejection",
		);
		ok(!JSON.stringify([events, result]).includes("gate rejected diff"));
	});
});
