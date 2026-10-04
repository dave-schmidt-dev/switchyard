import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	loadCheckpoint,
	waitForJobCompletion,
} from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueueWithOrchestrator,
	testDescriptor,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeLegacyCheckpoint(path, checkpoint) {
	writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
}
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
describe("runner poll/wait loop", () => {
	it("waits through running states until done", async () => {
		const statuses = [
			{ state: "running", expected_by: "2999-01-01T00:00:00Z" },
			{ state: "2/3", expected_by: "2999-01-01T00:00:00Z" },
			{ state: "done", expected_by: "2999-01-01T00:00:00Z" },
		];
		let i = 0;
		const pollStates = [];
		let sleeps = 0;

		const result = await waitForJobCompletion({
			jobId: "job-1",
			orchestrator: {
				status: async () => {
					const current = statuses[Math.min(i, statuses.length - 1)];
					i += 1;
					return current;
				},
			},
			pollIntervalMs: 1,
			sleepFn: async () => {
				sleeps += 1;
			},
			onPoll: ({ state }) => {
				pollStates.push(state);
			},
		});

		strictEqual(result.state, "done");
		strictEqual(result.timedOut, false);
		deepStrictEqual(pollStates, ["running", "2/3", "done"]);
		strictEqual(sleeps, 2);
	});

	it("returns timed_out when expected_by is exceeded", async () => {
		const result = await waitForJobCompletion({
			jobId: "job-2",
			orchestrator: {
				status: async () => ({
					state: "running",
					expected_by: "2020-01-01T00:00:00Z",
				}),
			},
			now: () => Date.parse("2021-01-01T00:00:00Z"),
			pollIntervalMs: 1,
			sleepFn: async () => {},
		});

		strictEqual(result.state, "timed_out");
		strictEqual(result.timedOut, true);
	});
});
describe("runner headless orchestrator mode", () => {
	it("runs through launch/status/result and checkpoints", async () => {
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
		const launches = [];
		const dispatches = [];
		const polls = [];
		const statusesByJob = new Map([
			["job-1", [{ state: "running" }, { state: "done" }]],
			["job-2", [{ state: "done" }]],
		]);
		const diffsByJob = new Map([
			["job-1", "diff --git a/a b/a"],
			["job-2", ""],
		]);
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			pollIntervalMs: 1,
			dependencies: {
				captureTaskBase: (_workspaceId, { taskId }) => ({
					ref: `refs/switchyard/task-base/orchestrator/${taskId}`,
					tree: taskId === "1.1" ? "1".repeat(40) : "2".repeat(40),
				}),
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: () => {},
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude-target",
					resolved_harness: "claude",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				onPoll: ({ state }) => polls.push(state),
				orchestrator: {
					launch: async (payload) => {
						launches.push(payload);
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async (jobId) => {
						const queue = statusesByJob.get(jobId) ?? [{ state: "missing" }];
						if (queue.length > 1) {
							return queue.shift();
						}
						return queue[0];
					},
					result: async (jobId) => ({
						success: true,
						diff: diffsByJob.get(jobId) ?? "",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(dispatches.length, 2);
		deepStrictEqual(
			dispatches.map((entry) => entry.result),
			["success", "success"],
		);
		deepStrictEqual(
			launches.map((payload) => payload.prompt),
			[
				"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** First operation",
				"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** Second operation",
			],
		);
		deepStrictEqual(
			launches.map(({ taskBase }) => ({
				ref: taskBase.ref,
				tree: taskBase.tree,
			})),
			[
				{
					ref: "refs/switchyard/task-base/orchestrator/1.1",
					tree: "1".repeat(40),
				},
				{
					ref: "refs/switchyard/task-base/orchestrator/1.2",
					tree: "2".repeat(40),
				},
			],
		);
		deepStrictEqual(polls, ["running", "done", "done"]);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1", "1.2"]);
		strictEqual(checkpoint.results[0].descriptorHarness, "claude");
		strictEqual(checkpoint.results[0].resolvedTargetId, "claude-target");
	});

	it("resumes in orchestrator mode from checkpoint", async () => {
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
		const launches = [];
		let launchIndex = 0;

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 65,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			sleepFn: async () => {},
			orchestrator: {
				launch: async (payload) => {
					launches.push(payload);
					launchIndex += 1;
					return `job-${launchIndex}`;
				},
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
			},
		};

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			maxTasks: 1,
			dependencies,
		});

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		deepStrictEqual(
			launches.map((payload) => payload.taskId),
			["1.1", "1.2"],
		);
	});

	it("blocks historical model-only retry state before routing or orchestrator launch", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Historical retry
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** A legacy retry record must not be reinterpreted as a fresh task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["agy-gemini"],
			retryAttempts: [],
			retryTransitions: [],
			retryTransitionId: 0,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
			},
		});
		let routeCalls = 0;
		let launchCalls = 0;

		await rejects(
			() =>
				runQueueWithOrchestrator({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {
						route: () => {
							routeCalls += 1;
							return { provider: "agy", model: "fixture-gemini" };
						},
						orchestrator: {
							launch: async () => {
								launchCalls += 1;
								return "job-never-launched";
							},
							status: async () => ({ state: "done" }),
							result: async () => ({ success: true, diff: "" }),
						},
					},
				}),
			/explicit reconciliation/,
		);
		strictEqual(routeCalls, 0);
		strictEqual(launchCalls, 0);
	});

	it("blocks complete retry state until orchestrator retry-resume semantics are audited", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Complete retry
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** A complete retry record needs an explicit resume state machine
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const descriptor = testDescriptor({
			target_id: "claude-target",
			model_ref: "claude-sonnet-5",
			selector: "claude-sonnet-5",
		});
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["claude-target"],
			retryAttempts: [],
			retryTransitions: [],
			retryTransitionId: 0,
			retryState: {
				taskId: "1.1",
				attempt: 2,
				phase: "retry_started",
				resolvedTargetId: "claude-target",
				invocationDescriptor: descriptor,
				descriptorIdentity: descriptor.descriptor_identity,
				descriptorHarness: "claude",
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		});
		let routeCalls = 0;
		let launchCalls = 0;

		await rejects(
			() =>
				runQueueWithOrchestrator({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {
						route: () => {
							routeCalls += 1;
							return { provider: "claude", model: "claude-sonnet-5" };
						},
						orchestrator: {
							launch: async () => {
								launchCalls += 1;
								return "job-never-launched";
							},
							status: async () => ({ state: "done" }),
							result: async () => ({ success: true, diff: "" }),
						},
					},
				}),
			/invalid quota diagnostic provenance/,
		);
		strictEqual(routeCalls, 0);
		strictEqual(launchCalls, 0);
	});

	it("re-selects and re-fails the same unsupported provider on every resume (orchestrator launch failure, not a route gap — Task E.1)", async () => {
		// Since Task E.1, executeTaskWithOrchestrator passes availableProviders
		// (derived from context.adapters), same as executeTask — so this
		// dependencies object declares an adapters.cursor entry to keep cursor
		// selectable, isolating the scenario under test: the external
		// orchestrator is an opaque black box with no capability-discovery
		// protocol, so route() can still pick a provider the orchestrator
		// itself can't run. Here the fake orchestrator rejects "cursor" at
		// launch(), standing in for one that doesn't support that provider.
		// Because a failed launch never adds the task to completedTaskIds, a
		// resume re-selects the same task and the same provider and fails
		// identically — accepted behavior today, not a bug.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launchAttempts = [];
		const dispatches = [];

		const dependencies = {
			route: ({ availableProviders }) =>
				availableProviders && !availableProviders.includes("cursor")
					? { provider: null, reason: "no candidates" }
					: {
							provider: "cursor",
							model: "cursor-fast",
							percentLeft: 95,
							reason: "spread",
						},
			recordDispatch: (entry) => dispatches.push(entry),
			integrationGate: () => ({ success: true, message: "ok" }),
			sleepFn: async () => {},
			adapters: {
				cursor: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => null,
				},
			},
			orchestrator: {
				launch: async (payload) => {
					launchAttempts.push(payload);
					throw new Error(
						`orchestrator cannot run provider ${payload.provider}`,
					);
				},
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
			},
		};

		const first = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		// Failed task is recorded but NOT marked complete...
		strictEqual(first.results[0].result, "launch_failed");
		deepStrictEqual(first.completedTaskIds, []);
		deepStrictEqual(
			loadCheckpoint(checkpointPath, tasksPath).completedTaskIds,
			[],
		);

		// ...so a resume re-runs the SAME task against the SAME provider.
		const second = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		strictEqual(second.results[0].result, "launch_failed");
		deepStrictEqual(second.completedTaskIds, []);

		strictEqual(launchAttempts.length, 2);
		deepStrictEqual(
			launchAttempts.map((payload) => payload.taskId),
			["1.1", "1.1"],
		);
		deepStrictEqual(
			launchAttempts.map((payload) => payload.provider),
			["cursor", "cursor"],
		);
	});
});
