import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sanitizeFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import {
	loadCheckpoint,
	runQueueAsync as runQueueAsyncImpl,
} from "../src/switchyard/runner/index.mjs";
import {
	runQueueAsync as runFixtureQueueAsync,
	runnerTestDir,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
before(() => {
	process.env.SWITCHYARD_ROSTER_PATH = fileURLToPath(
		new URL("./fixtures/roster.fixture.json", import.meta.url),
	);
	__resetRosterCacheForTests();
});
after(() => {
	if (previousRosterPath === undefined)
		delete process.env.SWITCHYARD_ROSTER_PATH;
	else process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	__resetRosterCacheForTests();
});

function testDescriptor(overrides = {}) {
	const core = {
		target_id: "claude",
		model_ref: "claude-sonnet-5",
		selector: "claude-sonnet-5",
		effort: null,
		variant: null,
		invocation_args: [],
		...overrides,
	};
	return validateInvocationDescriptor(
		{
			...core,
			descriptor_identity: getInvocationDescriptorIdentity(core, "claude"),
		},
		"claude",
	);
}

// Broker-routed recovery fixtures supply their own resolveDescriptor; the
// shared fixture wrapper replaces it with a route-derived one that never fires
// on the broker path, so these tests call the runner with a passthrough seam.
function runBrokerQueueAsync(options) {
	const dependencies = options.dependencies ?? {};
	return runQueueAsyncImpl({
		...options,
		platform: "macos",
		dependencies: {
			...dependencies,
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				readiness: () => ({ inventoryCount: 0 }),
				ensureAgentContainer: () => {},
				create: dependencies.createWorkingContainer,
				provision: () => null,
				seed: dependencies.seedProject,
				commit: dependencies.commitWorkingTree,
				reset: dependencies.resetWorkingTree,
				captureTaskBase: dependencies.captureTaskBase,
				validateTaskBase: dependencies.validateTaskBase,
				releaseTaskBase: dependencies.releaseTaskBase,
				destroy: dependencies.wipeWorkingContainer,
			}),
		},
	});
}

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
describe("immutable-base recovery guards", () => {
	const entrypoints = [["async", runBrokerQueueAsync]];

	function recoveryDependencies(
		mode,
		counters,
		{ cleanupFailed = false } = {},
	) {
		const parallels = new ParallelsExecutionBackend({ aquaUid: 501 });
		const validateHelperTransport = (options) => {
			parallels.execArgv("recovery-worker", {
				argv: ["git", "status", "--porcelain"],
				recordPid: true,
				cleanupContext: options.cleanupContext,
			});
			counters.helperContexts.push(options.cleanupContext);
		};
		const execution = cleanupFailed
			? {
					success: true,
					cleanupFailed: true,
					cleanupStage: "pid_marker_removed",
				}
			: { success: true };
		const brokerExecution = cleanupFailed
			? {
					success: true,
					outcome: "success",
					cleanupFailed: true,
					cleanupStage: "pid_marker_removed",
				}
			: { success: true, outcome: "success" };
		return {
			route: () => ({
				provider: "claude",
				model: "fixture-model",
				resolved_harness: "claude",
			}),
			resolveDescriptor: () =>
				testDescriptor({
					model_ref: "fixture-model",
					selector: "fixture-model",
				}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			createWorkingContainer: () => "recovery-worker",
			seedProject: () => {},
			commitWorkingTree: () => {
				counters.commits += 1;
			},
			resetWorkingTree: () => {
				counters.resets += 1;
			},
			wipeWorkingContainer: () => {},
			captureTaskBase: (_workspaceId, { taskId, ...options }) => {
				validateHelperTransport(options);
				counters.captures += 1;
				return {
					ref: `refs/switchyard/task-base/recovery/${taskId}`,
					tree: "6".repeat(40),
				};
			},
			validateTaskBase: (_workspaceId, base, options) => {
				validateHelperTransport(options);
				return base;
			},
			releaseTaskBase: (_workspaceId, _base, options) => {
				validateHelperTransport(options);
				counters.releases += 1;
				if (counters.releaseThrows) throw new Error("uncertain release");
			},
			onTaskStart: (task) => counters.started.push(task.id),
			integrationGate: () => ({ success: true }),
			adapters: {
				claude: {
					execute: () => execution,
					executeAsync: async () => execution,
					captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
					captureDiffAsync: async () => "diff --git a/src/a.mjs b/src/a.mjs",
				},
			},
			...(mode === "async"
				? {
						broker: {
							selectAndReserve: async () => ({
								provider: "claude",
								model: "fixture-model",
								resolvedTarget: "claude",
								harness: "claude",
								capability: "standard",
								reason: "spread",
								snapshotIdentity: {
									status: "fresh",
									mtime: null,
									ageMs: 0,
								},
							}),
							launcherIdentity: () => ({}),
							execute: async () => brokerExecution,
						},
					}
				: {}),
			...(mode === "orchestrator"
				? {
						orchestrator: {
							launch: async () => "recovery-job",
							status: async () => ({ state: "done" }),
							result: async () =>
								cleanupFailed
									? {
											success: true,
											cleanupFailed: true,
											cleanupStage: "pid_marker_removed",
										}
									: { success: true },
						},
					}
				: {}),
		};
	}

	for (const [mode, entrypoint] of entrypoints) {
		it(`${mode} blocks a fresh queue after task-base release becomes uncertain`, async () => {
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
			const counters = {
				captures: 0,
				commits: 0,
				resets: 0,
				releases: 0,
				releaseThrows: true,
				started: [],
				helperContexts: [],
			};
			const options = {
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				runId: `recovery-${mode}`,
				checkpointPath,
				maxTasks: 1,
				dependencies: recoveryDependencies(mode, counters),
			};
			const first = await entrypoint(options);
			strictEqual(
				first.results.at(-1).result,
				"halted_after_task_base_release_failure",
			);
			await rejects(
				Promise.resolve().then(() => entrypoint(options)),
				/recovery is required/,
			);
			deepStrictEqual(counters.started, ["1.1"]);
			strictEqual(counters.captures, 1);
			strictEqual(counters.releases, 1);
			ok(counters.helperContexts.length >= 2);
			for (const helperContext of counters.helperContexts) {
				strictEqual(helperContext.operation, "helper");
				strictEqual(helperContext.runId, `recovery-${mode}`);
				strictEqual(helperContext.taskId, "1.1");
			}
			deepStrictEqual(
				new Set(counters.helperContexts.map(({ attemptId }) => attemptId)).size,
				1,
			);
		});

		it(`${mode} preserves the base and halts when provider cleanup is uncertain`, async () => {
			const tasksPath = writeTasksFile(`
### Task 1.1: Cleanup uncertainty
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** cleanup uncertainty
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const counters = {
				captures: 0,
				commits: 0,
				resets: 0,
				releases: 0,
				releaseThrows: false,
				started: [],
				helperContexts: [],
			};
			const options = {
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				runId: `recovery-cleanup-${mode}`,
				checkpointPath,
				stopOnFailure: false,
				dependencies: recoveryDependencies(mode, counters, {
					cleanupFailed: true,
				}),
			};
			const first = await entrypoint(options);
			strictEqual(
				first.results.at(-1).result,
				"halted_after_provider_cleanup_failure",
			);
			const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
			strictEqual(checkpoint.providerCleanupUncertain.taskId, "1.1");
			strictEqual(
				checkpoint.taskBases["1.1"].ref,
				"refs/switchyard/task-base/recovery/1.1",
			);
			strictEqual(checkpoint.taskBases["1.1"].tree, "6".repeat(40));
			strictEqual(
				checkpoint.taskBases["1.1"].cleanupContext.operation,
				"helper",
			);
			strictEqual(counters.commits, 0);
			strictEqual(counters.resets, 0);
			strictEqual(counters.releases, 0);
			await rejects(
				Promise.resolve().then(() => entrypoint(options)),
				/recovery is required/,
			);
			deepStrictEqual(counters.started, ["1.1"]);
			strictEqual(counters.captures, 1);
		});
	}
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
					executeAsync: async () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					executeAsync: async () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};
	}

	it("halts the queue when integrationGate fails and stopOnFailure is true", async () => {
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

		const result = await runFixtureQueueAsync({
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

	it("continues past an integrationGate failure when stopOnFailure is false", async () => {
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

		const result = await runFixtureQueueAsync({
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

	it("reconciles alreadyApplied as a successful terminal outcome", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Already applied
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** Idempotent operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const artifactRef = "artifact:0123456789abcdef01234567";
		const dispatches = [];
		const events = [];
		const result = await runFixtureQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "sonnet",
					reason:
						"../../private/sk-proj-opaquevalue at service.prod.company.com",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				onStatus: (event) => events.push(event),
				integrationGate: () => ({ alreadyApplied: true, artifactRef }),
				adapters: {
					claude: {
						execute: () => ({ success: true }),
						executeAsync: async () => ({ success: true }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.results[0].success, true);
		strictEqual(result.results[0].result, "success");
		strictEqual(result.results[0].alreadyApplied, true);
		// BLOCKED (Task 5.8): async executeTask result omits gateResult.artifactRef on the returned result entry.
		strictEqual(dispatches[0].result, "success");
		strictEqual(dispatches[0].alreadyApplied, true);
		// BLOCKED (Task 5.8): async recordDispatch entry omits gateResult.artifactRef for an alreadyApplied success.
		strictEqual(dispatches[0].reason, "spread");
		strictEqual(sanitizeFailureMetadata(dispatches[0]), null);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].alreadyApplied, true);
		// BLOCKED (Task 5.8): async checkpoint results[0] has no artifactRef because the async task result never carries it.
		ok(!JSON.stringify(dispatches).includes("unknown_failure"));
		ok(
			!JSON.stringify({ result, checkpoint, dispatches, events }).includes(
				"sk-proj-opaquevalue",
			),
		);
		// BLOCKED (Task 5.8): async emits no onStatus event with outcome "already_applied" for an alreadyApplied gate result.
	});
});
