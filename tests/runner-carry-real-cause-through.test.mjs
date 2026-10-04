import { match, notStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { isPersistentFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueue,
	runQueueWithOrchestrator,
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
		const result = runQueue({
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
						execute: () => ({
							success: false,
							error: "SECRET_CANARY raw provider text",
							errorKind: "auth_expired",
							diagnosticCode: "auth_expired",
							diagnosticOrigin: "adapter",
							diagnosticEvidenceAvailable: true,
							failurePhase: "provider_execution",
							exitCode: 1,
						}),
						captureDiff: () => null,
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
		const terminalFailure = runStoreCalls.find(
			(call) => call.state === "failed",
		).lastFailure;
		const dispatchFailure = dispatches.find(
			(entry) => entry.result === "execution_failed",
		);
		const statusFailure = statuses.find(
			(event) => event.event === "task_failed",
		);
		for (const value of [
			failure,
			checkpointFailure,
			terminalFailure,
			dispatchFailure,
			statusFailure,
		]) {
			ok(value, "sync failure projection is present");
			strictEqual(value.diagnosticCode, "auth_expired");
			strictEqual(value.diagnosticOrigin, "adapter");
			strictEqual(value.diagnosticEvidenceAvailable, false);
			strictEqual(value.diagnosticRef ?? null, null);
		}
		for (const value of [
			failure,
			checkpointFailure,
			terminalFailure,
			dispatchFailure,
		]) {
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

		const result = runQueue({
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
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "failed");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
		strictEqual(terminalCall.terminalizedBy, "worker");
		ok(terminalCall.lastFailure, "lastFailure present on failed run");
		ok(isPersistentFailureMetadata(terminalCall.lastFailure));
		strictEqual(terminalCall.lastFailure.errorKind, "integration_failed");
		strictEqual(terminalCall.lastFailure.diagnosticCode, "empty_required_diff");
		notStrictEqual(terminalCall.lastFailure.errorKind, "unclassified");
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
		const result = runQueue({
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
						execute: () => {
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
						captureDiff: () => "",
					},
				},
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "failed");
		strictEqual(terminalCall.terminalizedBy, "worker");
		ok(terminalCall.lastFailure);
		ok(isPersistentFailureMetadata(terminalCall.lastFailure));
		strictEqual(terminalCall.lastFailure.errorKind, "execution_timed_out");
		notStrictEqual(terminalCall.lastFailure.errorKind, "unclassified");
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

		const result = runQueue({
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
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		const outcomeFailedEvent = statuses.find(
			(e) => e.event === "outcome_projection_failed",
		);
		ok(outcomeFailedEvent, "emitted outcome_projection_failed event");
		strictEqual(outcomeFailedEvent.phase, "ledger");
		strictEqual(outcomeFailedEvent.ledgerFailureCode, "EACCES");
		strictEqual(projectionFailures.length, 1);
		strictEqual(projectionFailures[0].ledgerFailureCode, "EACCES");
	});

	it("runQueueWithOrchestrator terminal projection carries sanitized lastFailure and terminalizedBy on task failure", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Orchestrator failure
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => {
						throw new Error("spawn failed");
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: false }),
				},
				runStore,
			},
		});

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "failed");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
		strictEqual(terminalCall.terminalizedBy, "worker");
		ok(
			terminalCall.lastFailure,
			"lastFailure present on failed orchestrator run",
		);
		ok(isPersistentFailureMetadata(terminalCall.lastFailure));
		strictEqual(terminalCall.lastFailure.errorKind, "launch_failed");
		notStrictEqual(terminalCall.lastFailure.errorKind, "unclassified");
	});

	it("runQueueWithOrchestrator terminal projection sets terminalizedBy: 'worker' and no lastFailure on success", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Success task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Orchestrator success
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				runStore,
			},
		});

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "succeeded");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
		strictEqual(terminalCall.terminalizedBy, "worker");
		strictEqual(terminalCall.lastFailure, undefined);
	});

	it("runQueueWithOrchestrator surfaces terminal updateRun rejection via outcome_projection_failed", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Success task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Orchestrator success
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const statuses = [];
		const projectionFailures = [];

		const runStore = {
			updateRun: (partial) => {
				if (partial.state !== undefined) {
					const err = new Error("readonly filesystem");
					err.code = "EROFS";
					return Promise.reject(err);
				}
				return Promise.resolve({ revision: 0 });
			},
		};

		await runQueueWithOrchestrator({
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
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				runStore,
			},
		});

		const outcomeFailedEvent = statuses.find(
			(e) => e.event === "outcome_projection_failed",
		);
		ok(outcomeFailedEvent, "emitted outcome_projection_failed event");
		strictEqual(outcomeFailedEvent.phase, "ledger");
		strictEqual(outcomeFailedEvent.ledgerFailureCode, "EROFS");
		strictEqual(projectionFailures.length, 1);
		strictEqual(projectionFailures[0].ledgerFailureCode, "EROFS");
	});
});
