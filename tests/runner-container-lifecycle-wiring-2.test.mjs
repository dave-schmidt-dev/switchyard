import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	runnerTestDir,
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
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
			},
		};
	}
	it("runQueueWithOrchestrator also skips container wiring when workingContainerName is supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let ensureCalled = false;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				ensureAgentContainer: () => {
					ensureCalled = true;
				},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "diff --git a/a b/a" }),
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(ensureCalled, false);
	});
	it("runQueueWithOrchestrator creates and wipes its own working container when none is supplied, ensuring the agent container first", async () => {
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

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				ensureAgentContainer: () => {
					callOrder.push("ensure");
				},
				createWorkingContainer: (projectPath) => {
					callOrder.push("create");
					capturedProjectPath = projectPath;
					return "generated-orchestrator-container";
				},
				provisionCredentials: (name) => {
					callOrder.push("provision");
					capturedContextContainerName = name;
					return 1;
				},
				seedProject: () => {
					callOrder.push("seed");
				},
				commitWorkingTree: () => {
					callOrder.push("commit");
				},
				wipeWorkingContainer: (name) => {
					callOrder.push("wipe");
					capturedContextContainerName = name;
				},
				// Marks the checkpoint save position in the sequence (fired right
				// after saveCheckpoint) — it must land between launch and commit.
				onCheckpointSaved: () => callOrder.push("checkpoint"),
				orchestrator: {
					launch: async (payload) => {
						callOrder.push(`launch:${payload.workingContainerName}`);
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "diff --git a/a b/a" }),
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(capturedProjectPath, TEST_DIR);
		strictEqual(
			capturedContextContainerName,
			"generated-orchestrator-container",
		);
		deepStrictEqual(callOrder, [
			"ensure",
			"create",
			"provision",
			"seed",
			"launch:generated-orchestrator-container",
			"checkpoint",
			"commit",
			"wipe",
		]);
	});
	it("runQueueWithOrchestrator still wipes the working container it created when a task throws mid-queue (INV-3)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		await rejects(async () => {
			await runQueueWithOrchestrator({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					recordDispatch: () => {},
					integrationGate: () => ({ success: true, message: "ok" }),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-orchestrator-container",
					provisionCredentials: () => {},
					seedProject: () => {},
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
					route: () => {
						throw new Error("route exploded mid-orchestrator-queue");
					},
					orchestrator: {
						launch: async () => "job-1",
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: "" }),
					},
				},
			});
		}, /route exploded mid-orchestrator-queue/);

		strictEqual(
			wipeCalled,
			true,
			"the working container must still be wiped even when the orchestrator task loop throws",
		);
	});
});
