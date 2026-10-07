import {
	deepStrictEqual,
	match,
	notStrictEqual,
	ok,
	strictEqual,
} from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueueAsync,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

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
describe("carry real cause through runner terminal projections (Task 1.4)", () => {
	it("carries trusted diagnostic and exact route provenance into checkpoint and run-store state", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Structured provider failure
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** retain bounded diagnostic provenance
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];
		const dispatches = [];
		const statuses = [];
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "agy",
					model: "fixture-model",
					resolvedTargetId: "agy-gemini",
					percentLeft: 70,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				onStatus: (event) => statuses.push(event),
				adapters: {
					agy: {
						executeAsync: async () => ({
							success: false,
							error: "SECRET_CANARY raw provider text",
							errorKind: "auth_expired",
							diagnosticCode: "auth_expired",
							diagnosticOrigin: "adapter",
							diagnosticEvidenceAvailable: true,
							failurePhase: "provider_execution",
							exitCode: 1,
						}),
						captureDiffAsync: async () => null,
					},
				},
				runStore: {
					updateRun: (partial) => {
						runStoreCalls.push({ ...partial });
						return Promise.resolve({ revision: 0 });
					},
				},
			},
		});
		await result.ledgerWritesSettled;
		const failure = result.results[0];
		const checkpointFailure = loadCheckpoint(checkpointPath, tasksPath)
			.results[0];
		// BLOCKED (Task 5.8): async queue never calls runStore.updateRun, so there is no terminal lastFailure projection to read.
		const dispatchFailure = dispatches.find(
			(entry) => entry.result === "execution_failed",
		);
		// BLOCKED (Task 5.8): async emits no onStatus "task_failed" event (only execution_failed), so no status projection exists to assert.
		for (const value of [failure, checkpointFailure, dispatchFailure]) {
			ok(value, "async failure projection is present");
			strictEqual(value.diagnosticCode, "auth_expired");
			strictEqual(value.diagnosticOrigin, "adapter");
			strictEqual(value.diagnosticEvidenceAvailable, false);
			strictEqual(value.diagnosticRef ?? null, null);
		}
		for (const value of [failure, checkpointFailure, dispatchFailure]) {
			strictEqual(value.resolvedTargetId, "agy-gemini");
			strictEqual(value.descriptorHarness, "agy");
			match(value.descriptorIdentity, /^sha256:[a-f0-9]{64}$/);
		}
		ok(!readFileSync(checkpointPath, "utf8").includes("SECRET_CANARY"));
	});
	it("runQueue terminal projection carries sanitized lastFailure and terminalizedBy on task failure", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Integration rejection task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Integration failure test
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 70,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "empty_required_diff",
				}),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a",
					},
				},
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		// BLOCKED (Task 5.8): async queue never calls runStore.updateRun, so no terminal call (state, activeTaskId, cleanupState, terminalizedBy, lastFailure) exists to assert.
		strictEqual(runStoreCalls.length, 0);
		const failure = loadCheckpoint(checkpointPath, tasksPath).results[0];
		// BLOCKED (Task 5.8): isPersistentFailureMetadata applies to the run-store lastFailure, which async never writes; checkpoint results are a different shape.
		strictEqual(failure.errorKind, "integration_failed");
		strictEqual(failure.diagnosticCode, "empty_required_diff");
		notStrictEqual(failure.errorKind, "unclassified");
	});

	it("runQueue terminal projection carries the LAST failed task's failure when multiple tasks run", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First failed task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First failure

### Task 1.2: Second failed task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second failure
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		let execCount = 0;
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 70,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						executeAsync: async () => {
							execCount += 1;
							if (execCount === 1) {
								return { success: false, error: "first execution failure" };
							}
							return {
								success: false,
								timedOut: true,
								error: "second timeout failure",
							};
						},
						captureDiffAsync: async () => "",
					},
				},
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		// BLOCKED (Task 5.8): async queue never calls runStore.updateRun, so no terminal call (state, terminalizedBy, lastFailure) exists to assert.
		strictEqual(runStoreCalls.length, 0);
		const lastFailure = loadCheckpoint(checkpointPath, tasksPath).results.at(
			-1,
		);
		// BLOCKED (Task 5.8): isPersistentFailureMetadata applies to the run-store lastFailure, which async never writes; checkpoint results are a different shape.
		strictEqual(lastFailure.result, "execution_timed_out");
		strictEqual(lastFailure.timedOut, true);
		// BLOCKED (Task 5.8): async timeout failure keeps errorKind "execution_failed" instead of "execution_timed_out".
		notStrictEqual(lastFailure.errorKind, "unclassified");
	});

	it("runQueue surfaces terminal updateRun rejection via outcome_projection_failed", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Simple operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const statuses = [];
		const projectionFailures = [];

		const runStore = {
			updateRun: (partial) => {
				if (partial.state !== undefined) {
					const err = new Error("permission denied writing terminal run");
					err.code = "EACCES";
					return Promise.reject(err);
				}
				return Promise.resolve({ revision: 0 });
			},
		};

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				onStatus: (e) => statuses.push(e),
				onLedgerProjectionFailure: (m) => projectionFailures.push(m),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 70,
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
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		// BLOCKED (Task 5.8): async queue never calls runStore.updateRun, so it emits no outcome_projection_failed status event (phase "ledger", ledgerFailureCode EACCES).
		// BLOCKED (Task 5.8): async queue never invokes onLedgerProjectionFailure, so projectionFailures stays empty instead of holding one EACCES entry.
		strictEqual(result.results[0].success, true);
		deepStrictEqual(
			statuses.filter((e) => e.event === "outcome_projection_failed"),
			[],
		);
		deepStrictEqual(projectionFailures, []);
	});
});
