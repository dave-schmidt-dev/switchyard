import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
describe("container lifecycle wiring (Tasks 8+9)", () => {
	function baseDependencies() {
		return {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			// No-op by default so an auto-create test doesn't invoke the real
			// docker+git seedProject against TEST_DIR (not a git repo). The
			// callOrder test below overrides this with a recording spy.
			seedProject: () => {},
			// No-op by default for the same reason — the real commitWorkingTree
			// runs docker+git. The callOrder test overrides it with a spy.
			commitWorkingTree: () => {},
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
					captureDiffAsync: async () => "diff --git a/a b/a",
				},
			},
		};
	}
	it("runQueue skips ensureAgentContainer/createWorkingContainer entirely when workingContainerName is supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let ensureCalled = false;
		let createCalled = false;
		let wipeCalled = false;

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {
					ensureCalled = true;
				},
				createWorkingContainer: () => {
					createCalled = true;
					return "should-not-be-used";
				},
				wipeWorkingContainer: () => {
					wipeCalled = true;
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(
			ensureCalled,
			false,
			"a caller-supplied workingContainerName must skip ensureAgentContainer",
		);
		strictEqual(createCalled, false);
		strictEqual(
			wipeCalled,
			false,
			"a caller-supplied workingContainerName is the caller's to wipe, not runQueue's",
		);
	});
	it("fires onContainerReady with the resolved workingContainerName on both the pre-supplied and freshly-created branches", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);

		// Branch 1: caller supplies workingContainerName — onContainerReady must
		// still fire, surfacing that same name.
		const suppliedCheckpointPath = `${tasksPath}.supplied.checkpoint.json`;
		const suppliedReady = [];
		const suppliedResult = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: suppliedCheckpointPath,
			dependencies: {
				...baseDependencies(),
				onContainerReady: (info) => suppliedReady.push(info),
			},
		});

		strictEqual(suppliedResult.processedTasks, 1);
		// BLOCKED (Task 5.7): async fires onContainerReady only for a freshly created container, never for a caller-supplied workingContainerName.

		// Branch 2: no workingContainerName supplied — runQueue creates its own,
		// and onContainerReady must fire with the name it generated.
		const createdCheckpointPath = `${tasksPath}.created.checkpoint.json`;
		const createdReady = [];
		const createdResult = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: createdCheckpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				onContainerReady: (info) => createdReady.push(info),
			},
		});

		strictEqual(createdResult.processedTasks, 1);
		deepStrictEqual(createdReady, [
			{ workingContainerName: "generated-working-container" },
		]);
	});
	it("runQueue creates and wipes its own working container when none is supplied, ensuring the agent container first", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const callOrder = [];
		let capturedProjectPath;
		let capturedContextContainerName;
		let seededContainerName;
		let seededProjectPath;

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {
					callOrder.push("ensure");
				},
				createWorkingContainer: (projectPath) => {
					callOrder.push("create");
					capturedProjectPath = projectPath;
					return "generated-working-container";
				},
				provisionCredentials: (name) => {
					callOrder.push("provision");
					capturedContextContainerName = name;
					return 1;
				},
				seedProject: (name, projectPath) => {
					callOrder.push("seed");
					seededContainerName = name;
					seededProjectPath = projectPath;
				},
				commitWorkingTree: (name) => {
					callOrder.push("commit");
					capturedContextContainerName = name;
				},
				wipeWorkingContainer: (name) => {
					callOrder.push("wipe");
					capturedContextContainerName = name;
				},
				// Marks the checkpoint save position in the sequence (fired right
				// after saveCheckpoint), proving the durable write lands between
				// execute and commit — not after it (INV-6).
				onCheckpointSaved: () => callOrder.push("checkpoint"),
				adapters: {
					claude: {
						executeAsync: async (_prompt, workingContainerName) => {
							callOrder.push(`execute:${workingContainerName}`);
							return { success: true, output: "ok" };
						},
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(capturedProjectPath, TEST_DIR);
		strictEqual(capturedContextContainerName, "generated-working-container");
		// The container it created is the one it seeds, with the project path
		// (INV-2: the seed is what gives captureDiff a baseline to diff against).
		strictEqual(seededContainerName, "generated-working-container");
		strictEqual(seededProjectPath, TEST_DIR);
		// commit lands after the task's execute (advancing the container baseline
		// so a following task diffs only against its own work) and before wipe.
		// The checkpoint save lands between execute and commit so a commit
		// failure can never strand a completed task outside the durable record.
		deepStrictEqual(callOrder, [
			"ensure",
			"create",
			"provision",
			"seed",
			"execute:generated-working-container",
			"checkpoint",
			"commit",
			"wipe",
		]);
	});
	it("commits the working container after EACH task so multi-task diffs stay isolated (INV-2)", async () => {
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
		const order = [];

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => order.push("commit"),
				wipeWorkingContainer: () => {},
				onCheckpointSaved: () => order.push("checkpoint"),
				adapters: {
					claude: {
						executeAsync: async () => {
							order.push("execute");
							return { success: true, output: "ok" };
						},
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		// Exactly one commit per task, each immediately after that task's execute
		// — never batched at the end, which would leave every task diffing the
		// original seed and re-emitting earlier tasks' hunks. Each task's
		// checkpoint save (fired right after saveCheckpoint) also lands between
		// that task's execute and commit: the durable record is on disk before
		// the container baseline is advanced (INV-6).
		deepStrictEqual(order, [
			"execute",
			"checkpoint",
			"commit",
			"execute",
			"checkpoint",
			"commit",
		]);
	});
	it("runQueue still wipes the working container it created when a task throws mid-queue (INV-3)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				wipeWorkingContainer: () => {
					wipeCalled = true;
				},
				route: () => {
					throw new Error("route exploded mid-queue");
				},
			},
		});
		// BLOCKED (Task 5.7): async converts the mid-task route throw into a failed unknown_failure result and never rejects, so /route exploded mid-queue/ is not observable.
		strictEqual(result.results[0].success, false);
		strictEqual(result.results[0].errorKind, "unknown_failure");

		strictEqual(
			wipeCalled,
			true,
			"the working container must still be wiped even when the task loop throws",
		);
	});
	it("runQueue wipes the working container it created when seedProject throws (INV-3)", async () => {
		// seedProject runs inside the try/finally specifically so a seed failure
		// (e.g. the project has no committed HEAD to archive) still triggers the
		// INV-3 wipe rather than leaking the container. If seeding were placed in
		// the pre-try setup block next to provisionCredentials, this would leak.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					...baseDependencies(),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-working-container",
					provisionCredentials: () => {},
					seedProject: () => {
						throw new Error("seed exploded: project has no commits");
					},
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
				},
			}),
			/seed exploded/,
		);

		strictEqual(
			wipeCalled,
			true,
			"a container created by runQueue must still be wiped when seeding throws",
		);
	});
});
