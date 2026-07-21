import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
	throws,
} from "node:assert";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import { SNAPSHOT_PATH } from "../src/switchyard/router/index.mjs";
import {
	createCliOrchestrator,
	executeTask,
	getRunnableTasks,
	loadCheckpoint,
	parseTaskQueue,
	resolveOrchestrator,
	runQueue,
	runQueueWithOrchestrator,
	saveCheckpoint,
	waitForJobCompletion,
} from "../src/switchyard/runner/index.mjs";

const TEST_DIR = join(cwd(), ".switchyard-runner-test");

function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, content, "utf8");
	return tasksPath;
}

afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});

describe("runner queue parsing", () => {
	it("parses task blocks with status and description", () => {
		const markdown = `## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** Do first thing

### Task 1.2: Second task
- **Status:** in progress
- **Description:** Do second thing
`;

		const tasks = parseTaskQueue(markdown);
		strictEqual(tasks.length, 2);
		strictEqual(tasks[0].id, "1.1");
		strictEqual(tasks[0].status, "pending");
		strictEqual(tasks[1].id, "1.2");
		strictEqual(tasks[1].status, "in progress");
	});

	it("returns runnable tasks excluding completed checkpoint IDs", () => {
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "in progress" },
			{ id: "1.3", status: "done" },
		];
		const checkpoint = {
			completedTaskIds: ["1.1"],
		};
		const runnable = getRunnableTasks(tasks, checkpoint);
		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.2"],
		);
	});

	it("warns and excludes a task with an unrecognized status instead of silently dropping it", () => {
		// Regression (Task 12): the old filter matched exactly
		// `pending`/`in progress`, so a typo'd status was excluded with no
		// signal, indistinguishable from a deliberate skip. The task must now
		// still be excluded, but the exclusion must be *visible*. The
		// discriminating assertion is that console.error fires — the old code
		// also excluded it, so "excluded" alone would pass on the unfixed code.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "pnding" }, // typo
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1"],
		);
		strictEqual(warnings.length, 1);
		ok(warnings[0].includes("1.2"));
		ok(warnings[0].includes("pnding"));
	});

	it("excludes recognized non-runnable statuses (done, blocked) without any warning", () => {
		// `done` and `blocked` are documented project vocabulary — an
		// intentional skip, not a mistake — so they must be excluded silently.
		// Warning on them (e.g. on every completed task) would be pure noise.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "done" },
			{ id: "1.3", status: "blocked" },
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1"],
		);
		strictEqual(warnings.length, 0);
	});

	it("normalizes case and surrounding whitespace before matching status", () => {
		// A differently-cased or padded status is a recognized status, not an
		// unrecognized one — it must run, not warn.
		const tasks = [
			{ id: "1.1", status: "  Pending  " },
			{ id: "1.2", status: "IN PROGRESS" },
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1", "1.2"],
		);
		strictEqual(warnings.length, 0);
	});

	it("throws on duplicate task IDs within one parse instead of yielding both", () => {
		// Regression (Task 12): a malformed queue with two blocks sharing an id
		// previously returned both — `done.has(id)` only checks the checkpoint's
		// completed set, not IDs already yielded in this same pass — so both
		// would execute in one run. Fail loudly, matching loadCheckpoint's
		// posture on malformed input.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.1", status: "pending" },
		];
		throws(
			() => getRunnableTasks(tasks, { completedTaskIds: [] }),
			/duplicate task id "1\.1"/,
		);
	});
});

describe("runner orchestration", () => {
	it("executes tasks serially and checkpoints completion", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
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
					execute: (prompt) => {
						prompts.push(prompt);
						return { success: true, output: "ok" };
					},
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(result.completedTaskIds.length, 2);
		strictEqual(dispatches.length, 2);
		deepStrictEqual(prompts, ["First operation", "Second operation"]);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1", "1.2"]);
	});

	it("resumes from checkpoint and only runs remaining work", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
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
					execute: (prompt) => {
						prompts.push(prompt);
						return { success: true, output: "ok" };
					},
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
			maxTasks: 1,
		});

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		deepStrictEqual(prompts, ["First operation", "Second operation"]);
	});
});

describe("runner stopOnFailure + integration gate failure", () => {
	function dependenciesWithGateResult(gateResult) {
		return {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => gateResult,
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};
	}

	it("halts the queue when integrationGate fails and stopOnFailure is true", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: true,
			dependencies: dependenciesWithGateResult({
				success: false,
				message: "rejected",
			}),
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].result, "integration_failed");
		strictEqual(result.results[0].success, false);
		deepStrictEqual(result.completedTaskIds, []);
	});

	it("continues past an integrationGate failure when stopOnFailure is false", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: false,
			dependencies: dependenciesWithGateResult({
				success: false,
				message: "rejected",
			}),
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["integration_failed", "integration_failed"],
		);
		deepStrictEqual(result.completedTaskIds, []);
	});
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
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
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
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
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
			["success", "success_no_diff"],
		);
		deepStrictEqual(
			launches.map((payload) => payload.prompt),
			["First operation", "Second operation"],
		);
		deepStrictEqual(polls, ["running", "done", "done"]);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1", "1.2"]);
	});

	it("resumes in orchestrator mode from checkpoint", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
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

	it("re-selects and re-fails the same unsupported provider on every resume (characterizes the intentionally-unfiltered orchestrator route — Task 16)", async () => {
		// Unlike executeTask, executeTaskWithOrchestrator does NOT pass
		// availableProviders, so route() can pick a provider the external
		// orchestrator can't actually run. This is deliberate: the orchestrator
		// is an opaque black box with no capability-discovery protocol. Here the
		// fake orchestrator rejects "cursor" at launch(), standing in for one
		// that doesn't support that provider. Because a failed launch never adds
		// the task to completedTaskIds, a resume re-selects the same task and
		// the same provider and fails identically — accepted behavior today, not
		// a bug. This test pins that loop and doubles as a real guard: the mock
		// route below honors availableProviders, so today (this path passes
		// none) cursor is returned and launch throws, but if this path is ever
		// constrained to a set excluding the picked provider, route() returns no
		// provider and the launch_failed assertions below fail — forcing a
		// deliberate update rather than silently passing.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
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

describe("runner provider spread recording", () => {
	it("records split dispatches across claude and codex", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		let routeIndex = 0;
		const routes = [
			{
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 70,
				reason: "spread",
			},
			{
				provider: "codex",
				model: "gpt-5.6-terra",
				percentLeft: 68,
				reason: "spread",
			},
		];
		let launchIndex = 0;

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => {
					const selected = routes[Math.min(routeIndex, routes.length - 1)];
					routeIndex += 1;
					return selected;
				},
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
		});

		deepStrictEqual(
			dispatches.map((entry) => entry.provider),
			["claude", "codex"],
		);
		deepStrictEqual(
			dispatches.map((entry) => entry.model),
			["claude-sonnet-5", "gpt-5.6-terra"],
		);
		deepStrictEqual(
			dispatches.map((entry) => entry.result),
			["success_no_diff", "success_no_diff"],
		);
	});

	it("uses headroom routing to split providers across tasks", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** integration task one

### Task 1.2: Second task
- **Status:** pending
- **Description:** integration task two
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		const snapshotDir = dirname(SNAPSHOT_PATH);
		let originalSnapshot = null;
		let launchIndex = 0;

		const writeSnapshot = (claudePercentLeft, codexPercentLeft) => {
			mkdirSync(snapshotDir, { recursive: true });
			writeFileSync(
				SNAPSHOT_PATH,
				JSON.stringify({
					schema_version: 2,
					providers: [
						{
							name: "claude",
							ok: true,
							windows: [{ percent_left: claudePercentLeft, pace_delta: 100 }],
						},
						{
							name: "codex",
							ok: true,
							windows: [{ percent_left: codexPercentLeft, pace_delta: 100 }],
						},
					],
				}),
				"utf8",
			);
		};

		try {
			try {
				originalSnapshot = readFileSync(SNAPSHOT_PATH, "utf8");
			} catch {
				originalSnapshot = null;
			}

			writeSnapshot(72, 60);

			await runQueueWithOrchestrator({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					recordDispatch: (entry) => {
						dispatches.push(entry);
						if (dispatches.length === 1) {
							writeSnapshot(4, 68);
						}
					},
					integrationGate: () => ({ success: true, message: "ok" }),
					sleepFn: async () => {},
					orchestrator: {
						launch: async () => {
							launchIndex += 1;
							return `job-${launchIndex}`;
						},
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: "" }),
					},
				},
			});

			deepStrictEqual(
				dispatches.map((entry) => entry.provider),
				["claude", "codex"],
			);
			// Assert the mechanism, not just the outcome sequence: the first
			// dispatch picks claude specifically because it has more headroom
			// (72 > 60) via spread selection, and the second picks codex
			// specifically because claude's headroom then dropped to 4% —
			// below DEFAULT_FLOOR (5.0) — excluding it, not because provider
			// selection happened to differ for some unrelated reason.
			strictEqual(dispatches[0].reason, "spread");
			strictEqual(dispatches[0].percentLeft, 72);
			strictEqual(dispatches[1].reason, "spread");
			strictEqual(dispatches[1].percentLeft, 68);
		} finally {
			if (originalSnapshot === null) {
				try {
					rmSync(SNAPSHOT_PATH, { force: true });
				} catch {
					// ignore cleanup errors
				}
			} else {
				writeFileSync(SNAPSHOT_PATH, originalSnapshot, "utf8");
			}
		}
	});

	it("never dispatches to a roster provider with no adapter, even with the most headroom", async () => {
		// Regression: vibe/agy/cursor/copilot are in the roster but only
		// claude/codex have adapters wired here. Before the availableProviders
		// fix, route() (unconstrained) could legitimately pick vibe for a
		// low-tier task, selectAdapter() would return null, and the task
		// would fail with "unsupported_provider" forever — every resume
		// re-picks the same unsupported provider and fails identically.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** simple trivial cleanup
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const snapshotDir = dirname(SNAPSHOT_PATH);
		let originalSnapshot = null;

		try {
			try {
				originalSnapshot = readFileSync(SNAPSHOT_PATH, "utf8");
			} catch {
				originalSnapshot = null;
			}

			mkdirSync(snapshotDir, { recursive: true });
			writeFileSync(
				SNAPSHOT_PATH,
				JSON.stringify({
					schema_version: 2,
					providers: [
						{
							name: "claude",
							ok: true,
							windows: [{ percent_left: 30, pace_delta: 100 }],
						},
						{
							name: "vibe",
							ok: true,
							windows: [{ percent_left: 95, pace_delta: 10 }],
						},
					],
				}),
				"utf8",
			);

			const dispatches = [];
			const result = runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					// Real router (not mocked) — only override recordDispatch/adapters.
					recordDispatch: (entry) => dispatches.push(entry),
					integrationGate: () => ({ success: true, message: "ok" }),
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/b b/b",
						},
					},
				},
			});

			strictEqual(dispatches[0].provider, "claude");
			notStrictEqual(dispatches[0].result, "unsupported_provider");
			strictEqual(result.results[0].success, true);
		} finally {
			if (originalSnapshot === null) {
				try {
					rmSync(SNAPSHOT_PATH, { force: true });
				} catch {
					// ignore cleanup errors
				}
			} else {
				writeFileSync(SNAPSHOT_PATH, originalSnapshot, "utf8");
			}
		}
	});

	for (const provider of ["agy", "cursor"]) {
		it(`dispatches to the ${provider} adapter when route selects it (regression: selectAdapter only recognized claude/codex)`, () => {
			// Regression: runQueue's default adapters map was extended to include
			// agy/cursor (so route()'s availableProviders correctly reports them
			// as dispatchable), but selectAdapter() itself was never updated
			// beyond its original claude/codex checks. That combination is worse
			// than not wiring them at all: route() is now told agy/cursor are
			// available and may legitimately pick one, but selectAdapter() then
			// returns null for it and the task fails with "unsupported_provider"
			// on every attempt (and every resume), exactly the failure mode the
			// availableProviders fix was meant to eliminate.
			const dispatches = [];
			const result = executeTask(
				{ id: "1.1", title: "task", description: "simple cleanup" },
				{
					route: () => ({
						provider,
						model: `${provider}-model`,
						percentLeft: 50,
						reason: "spread",
					}),
					recordDispatch: (entry) => dispatches.push(entry),
					integrationGate: () => ({ success: true, message: "ok" }),
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/b b/b",
						},
						agy: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/c b/c",
						},
						cursor: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/d b/d",
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
			);

			notStrictEqual(
				result.result,
				"unsupported_provider",
				`${provider} has an adapter wired but was rejected as unsupported`,
			);
			strictEqual(result.success, true);
			strictEqual(dispatches[0].provider, provider);
			strictEqual(dispatches[0].result, "success");
		});
	}
});

describe("runner cli orchestrator wiring", () => {
	it("builds launch/status/result calls for CLI orchestrator", async () => {
		const calls = [];
		const outputs = [
			JSON.stringify({ job_id: "job-123" }),
			JSON.stringify({ state: "done", expected_by: "2999-01-01T00:00:00Z" }),
			JSON.stringify({ success: true, diff: "diff --git a/a b/a" }),
		];

		const orch = createCliOrchestrator({
			command: "switchyard-orch",
			baseArgs: ["--headless"],
			execFn: (command, args) => {
				calls.push([command, args]);
				return outputs.shift();
			},
		});

		const jobId = await orch.launch({ taskId: "1.1" });
		const status = await orch.status(jobId);
		const result = await orch.result(jobId);

		strictEqual(jobId, "job-123");
		strictEqual(status.state, "done");
		strictEqual(result.success, true);
		deepStrictEqual(calls[0], [
			"switchyard-orch",
			["--headless", "launch", "--json", JSON.stringify({ taskId: "1.1" })],
		]);
		deepStrictEqual(calls[1], [
			"switchyard-orch",
			["--headless", "status", "job-123"],
		]);
		deepStrictEqual(calls[2], [
			"switchyard-orch",
			["--headless", "result", "job-123"],
		]);
	});

	it("resolves orchestrator from dependencies first", () => {
		const marker = { status: async () => ({ state: "done" }) };
		const resolved = resolveOrchestrator({ orchestrator: marker });
		strictEqual(resolved, marker);
	});

	it("throws when no dependency or environment orchestrator is set", () => {
		const previousCmd = process.env.SWITCHYARD_ORCHESTRATOR_CMD;
		const previousArgs = process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;
		delete process.env.SWITCHYARD_ORCHESTRATOR_CMD;
		delete process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;

		let error = null;
		try {
			resolveOrchestrator({});
		} catch (err) {
			error = err;
		} finally {
			if (previousCmd === undefined) {
				delete process.env.SWITCHYARD_ORCHESTRATOR_CMD;
			} else {
				process.env.SWITCHYARD_ORCHESTRATOR_CMD = previousCmd;
			}
			if (previousArgs === undefined) {
				delete process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;
			} else {
				process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON = previousArgs;
			}
		}

		ok(error instanceof Error);
		ok(error.message.includes("SWITCHYARD_ORCHESTRATOR_CMD"));
	});
});

describe("checkpoint durability", () => {
	it("round-trips through an atomic write with no leftover temp file", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		saveCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: ["1.1"],
			lastTaskId: "1.1",
			lastUpdatedAt: "2026-01-01T00:00:00Z",
			results: [],
		});

		strictEqual(existsSync(`${checkpointPath}.tmp`), false);
		deepStrictEqual(
			loadCheckpoint(checkpointPath, tasksPath).completedTaskIds,
			["1.1"],
		);
	});

	it("throws instead of silently discarding a checkpoint that exists but fails to parse", () => {
		// Regression: a prior version caught any parse error and returned a
		// fresh empty checkpoint, indistinguishable from "no checkpoint yet" —
		// a crash mid-write (before checkpoints were written atomically) would
		// silently erase all completed-task history and trigger a full re-run.
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeFileSync(checkpointPath, "{not valid json", "utf8");

		throws(() => loadCheckpoint(checkpointPath, tasksPath), /not valid JSON/);
	});

	it("throws on a checkpoint file with an unexpected shape", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeFileSync(checkpointPath, JSON.stringify({ foo: "bar" }), "utf8");

		throws(() => loadCheckpoint(checkpointPath, tasksPath), /unexpected shape/);
	});

	it("still returns an empty checkpoint when the file is simply missing", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpoint = loadCheckpoint(
			`${tasksPath}.checkpoint.json`,
			tasksPath,
		);
		deepStrictEqual(checkpoint.completedTaskIds, []);
	});
});

describe("orchestrator status/result error guards", () => {
	it("waitForJobCompletion returns status_error instead of throwing when status() fails", async () => {
		const result = await waitForJobCompletion({
			jobId: "job-1",
			orchestrator: {
				status: async () => {
					throw new Error("orchestrator CLI crashed");
				},
			},
			sleepFn: async () => {},
		});

		strictEqual(result.state, "status_error");
		strictEqual(result.timedOut, false);
	});

	it("runQueueWithOrchestrator fails only the affected task when result() throws, not the whole queue", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => {
						throw new Error("orchestrator result endpoint unreachable");
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["result_fetch_failed", "result_fetch_failed"],
		);
		strictEqual(
			dispatches[0].reason,
			"orchestrator result endpoint unreachable",
		);
	});
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
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
			},
		};
	}

	it("runQueue skips ensureAgentContainer/createWorkingContainer entirely when workingContainerName is supplied", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let ensureCalled = false;
		let createCalled = false;
		let wipeCalled = false;

		const result = runQueue({
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

	it("runQueue creates and wipes its own working container when none is supplied, ensuring the agent container first", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const callOrder = [];
		let capturedProjectPath;
		let capturedContextContainerName;

		const result = runQueue({
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
				wipeWorkingContainer: (name) => {
					callOrder.push("wipe");
					capturedContextContainerName = name;
				},
				adapters: {
					claude: {
						execute: (_prompt, workingContainerName) => {
							callOrder.push(`execute:${workingContainerName}`);
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(capturedProjectPath, TEST_DIR);
		strictEqual(capturedContextContainerName, "generated-working-container");
		deepStrictEqual(callOrder, [
			"ensure",
			"create",
			"execute:generated-working-container",
			"wipe",
		]);
	});

	it("runQueue still wipes the working container it created when a task throws mid-queue (INV-3)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		throws(() => {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					...baseDependencies(),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-working-container",
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
					route: () => {
						throw new Error("route exploded mid-queue");
					},
				},
			});
		}, /route exploded mid-queue/);

		strictEqual(
			wipeCalled,
			true,
			"the working container must still be wiped even when the task loop throws",
		);
	});

	it("runQueueWithOrchestrator also skips container wiring when workingContainerName is supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
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
				wipeWorkingContainer: (name) => {
					callOrder.push("wipe");
					capturedContextContainerName = name;
				},
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
			"launch:generated-orchestrator-container",
			"wipe",
		]);
	});

	it("runQueueWithOrchestrator still wipes the working container it created when a task throws mid-queue (INV-3)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
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
