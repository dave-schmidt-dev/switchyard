import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sanitizeFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueue,
	runQueueAsync,
	runQueueWithOrchestrator,
	testDescriptor,
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
describe("immutable-base recovery guards", () => {
	const entrypoints = [
		["sync", runQueue],
		["async", runQueueAsync],
		["orchestrator", runQueueWithOrchestrator],
	];

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
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
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
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
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

	it("reconciles alreadyApplied as a successful terminal outcome", () => {
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
		const result = runQueue({
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
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.results[0].success, true);
		strictEqual(result.results[0].result, "success");
		strictEqual(result.results[0].alreadyApplied, true);
		strictEqual(result.results[0].artifactRef, artifactRef);
		strictEqual(dispatches[0].result, "success");
		strictEqual(dispatches[0].alreadyApplied, true);
		strictEqual(dispatches[0].artifactRef, artifactRef);
		strictEqual(dispatches[0].reason, "spread");
		strictEqual(sanitizeFailureMetadata(dispatches[0]), null);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].alreadyApplied, true);
		strictEqual(checkpoint.results[0].artifactRef, artifactRef);
		ok(!JSON.stringify(dispatches).includes("unknown_failure"));
		ok(
			!JSON.stringify({ result, checkpoint, dispatches, events }).includes(
				"sk-proj-opaquevalue",
			),
		);
		ok(events.some((event) => event.outcome === "already_applied"));
	});

	it("keeps orchestrator alreadyApplied outcomes safe and ledger-compatible", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Orchestrator already applied
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** Idempotent headless operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const artifactRef = "artifact:fedcba987654321001234567";
		const dispatches = [];
		const events = [];
		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "sonnet",
					resolvedTargetId: "claude-target",
					resolved_harness: "claude",
					reason:
						"../../private/sk-proj-orchestrator at service.prod.company.com",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				onStatus: (event) => events.push(event),
				integrationGate: () => ({ alreadyApplied: true, artifactRef }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(result.results[0].result, "success");
		strictEqual(result.results[0].alreadyApplied, true);
		strictEqual(dispatches[0].reason, "spread");
		strictEqual(dispatches[0].artifactRef, artifactRef);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		ok(
			!JSON.stringify({ result, checkpoint, dispatches, events }).includes(
				"sk-proj-orchestrator",
			),
		);
		ok(events.some((event) => event.outcome === "already_applied"));
	});
});
