import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyCheckpointArtifactRetention } from "../src/switchyard/run-store/index.mjs";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
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
describe("runQueue timeout diff persistence", () => {
	it("persists a timed-out task's partial diff to disk and records partialDiffPath + timedOut in checkpoint.json without embedding the raw diff text", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o755 });
		chmodSync(artifactsDir, 0o755);
		const diffText =
			"diff --git a/wip.mjs b/wip.mjs\n+SECRET_CANARY_wip_marker";

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
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
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
							cleanupFailed: true,
							cleanupStage: "pid_marker_removed",
							failurePhase: "provider_cleanup",
						}),
						captureDiff: () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.timedOut, true);
		strictEqual(taskResult.errorKind, "provider_cleanup_failed");
		strictEqual(taskResult.cleanupStage, "pid_marker_removed");
		strictEqual(
			taskResult.diagnosticCode,
			"provider_cleanup_after_pid_marker_removed",
		);
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"raw diff text must not ride along in the in-memory result once persisted",
		);
		ok(taskResult.partialDiffPath, "result carries the artifact path");
		ok(existsSync(taskResult.partialDiffPath));
		strictEqual(readFileSync(taskResult.partialDiffPath, "utf8"), diffText);
		strictEqual(
			statSync(`${checkpointPath}.partial-diffs`).mode & 0o777,
			0o700,
		);
		strictEqual(statSync(taskResult.partialDiffPath).mode & 0o777, 0o600);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.taskAttempts["1.1"], 1);
		strictEqual(
			taskResult.partialDiffPath.endsWith("1.1.attempt-1.diff"),
			true,
		);
		strictEqual(checkpoint.results[0].success, false);
		strictEqual(checkpoint.results[0].timedOut, true);
		strictEqual(
			checkpoint.results[0].diagnosticCode,
			"provider_cleanup_after_pid_marker_removed",
		);
		strictEqual(checkpoint.results[0].partialDiffPath, null);
		strictEqual(checkpoint.results[0].artifactRef, undefined);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_wip_marker"),
			"checkpoint.json must reference the artifact by path only, never embed the diff text",
		);
		ok(
			!rawCheckpointJson.includes(taskResult.partialDiffPath),
			"checkpoint.json must not persist the host artifact path",
		);
	});
	it("refuses a pre-existing symlink partial-diffs directory", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Symlinked artifact directory
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** must not write through a symlink
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		const outsideDir = `${checkpointPath}.outside`;
		mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
		symlinkSync(outsideDir, artifactsDir);
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
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
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						captureDiff: () => "untrusted symlink output",
					},
				},
			},
		});
		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].partialDiffPath, undefined);
		strictEqual(readdirSync(outsideDir).length, 0);
	});
	it("refuses a pre-existing symlink artifact without changing its target", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Symlinked artifact file
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** must not write through a final-component symlink
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const artifactsDir = `${checkpointPath}.partial-diffs`;
		const outsidePath = `${checkpointPath}.outside`;
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		writeFileSync(outsidePath, "outside stays unchanged", { mode: 0o600 });
		symlinkSync(outsidePath, join(artifactsDir, "1.1.attempt-1.diff"));
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			workingContainerName: "provided-container",
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
						execute: () => ({
							success: false,
							output: "",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						captureDiff: () => "must not escape",
					},
				},
			},
		});
		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].partialDiffPath, undefined);
		strictEqual(readFileSync(outsidePath, "utf8"), "outside stays unchanged");
	});
	it("retires runner-written retry evidence after the task later succeeds", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Retried task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first times out, then succeeds
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let shouldSucceed = false;
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
					execute: () =>
						shouldSucceed
							? { success: true, output: "ok" }
							: {
									success: false,
									output: "",
									error: "spawnSync docker ETIMEDOUT",
									timedOut: true,
								},
					captureDiff: () =>
						shouldSucceed ? "" : "diff --git a/retry.mjs b/retry.mjs\n+pending",
				},
			},
		};
		const first = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			workingContainerName: "provided-container",
			dependencies,
		});
		strictEqual(first.results[0].success, false);
		const artifactPath = first.results[0].partialDiffPath;
		ok(artifactPath);
		ok(existsSync(artifactPath));

		shouldSucceed = true;
		const second = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			workingContainerName: "provided-container",
			dependencies,
		});
		strictEqual(second.results[0].success, true);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.taskAttempts["1.1"], 2);
		deepStrictEqual(
			checkpoint.results.map((entry) => entry.attempt),
			[1, 2],
		);
		const retention = await applyCheckpointArtifactRetention(checkpointPath, {
			terminal: true,
			maxBytes: 0,
			maxEntries: 0,
		});
		strictEqual(retention.deletedCount, 1);
		strictEqual(existsSync(artifactPath), false);
	});
	it("records an integrated result against the gate-reserved attempt", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Integrated task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** preserve integration attempt identity
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			workingContainerName: "provided-container",
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: (_diff, _projectPath, options) => {
					const intent = options.integrationIntent;
					const lease = intent.acquire();
					const pending = {
						operation: intent.operation,
						status: "pending",
						beforeState: "a".repeat(64),
					};
					deepStrictEqual(intent.persist(pending, lease), pending);
					const completed = {
						...pending,
						status: "completed",
						afterState: "b".repeat(64),
					};
					deepStrictEqual(intent.complete(completed, lease), completed);
					intent.release(lease);
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () =>
							"diff --git a/src/a.mjs b/src/a.mjs\n+integrated change",
					},
				},
			},
		});

		strictEqual(result.results[0].success, true);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.taskAttempts["1.1"], 1);
		strictEqual(checkpoint.results[0].attempt, 1);
		strictEqual(checkpoint.integrationIntents["1.1"].operation.attempt, 1);
	});
	it("does not bind a stale artifact to the next result after a crash window", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Crash-safe artifact attempt
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** keeps stale and fresh evidence distinct
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let diffText = "first attempt evidence";
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
					execute: () => ({
						success: false,
						output: "",
						error: "spawnSync docker ETIMEDOUT",
						timedOut: true,
					}),
					captureDiff: () => diffText,
				},
			},
		};
		const first = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			workingContainerName: "provided-container",
			dependencies,
		});
		const staleArtifact = first.results[0].partialDiffPath;
		ok(staleArtifact?.endsWith("1.1.attempt-1.diff"));

		const crashState = JSON.parse(readFileSync(checkpointPath, "utf8"));
		crashState.results = [];
		crashState.completedTaskIds = [];
		writeFileSync(checkpointPath, JSON.stringify(crashState, null, 2), {
			mode: 0o600,
		});

		diffText = "second attempt evidence";
		const second = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			workingContainerName: "provided-container",
			dependencies,
		});
		const freshArtifact = second.results[0].partialDiffPath;
		ok(freshArtifact?.endsWith("1.1.attempt-2.diff"));
		strictEqual(readFileSync(staleArtifact, "utf8"), "first attempt evidence");
		strictEqual(readFileSync(freshArtifact, "utf8"), "second attempt evidence");
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.taskAttempts["1.1"], 2);
		deepStrictEqual(
			checkpoint.results.map((entry) => entry.attempt),
			[2],
		);
	});
});
