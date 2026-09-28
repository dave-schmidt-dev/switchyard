import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	appendOutcomeEvent,
	createStageOutcome,
	initializeRun,
	projectOutcomeShadow,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	__dirname,
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	// Set env var so direct run-store calls in tests target the temp dir
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	rmSync(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});
describe("status integration", () => {
	it("status with a real run produces valid status envelope", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-status-run",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const current = await readRun("test-status-run");
		await updateRun(
			"test-status-run",
			{
				preflightDetail: {
					reason: "no_eligible",
					rejections: [{ capability: "standard", reason: "safe" }],
					canary: "must-not-surface",
				},
			},
			current.revision,
		);

		const result = runDispatch(
			["status", "test-status-run"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.schemaVersion, 1);
		strictEqual(envelope.runId, "test-status-run");
		strictEqual(envelope.state, "created");
		strictEqual(envelope.cleanupState, "not_started");
		strictEqual(envelope.activeTaskId, null);
		strictEqual(envelope.completedCount, 0);
		strictEqual(envelope.failedCount, 0);
		deepStrictEqual(envelope.preflightDetail, {
			reason: "no_eligible",
			rejections: [{ capability: "standard", reason: "safe" }],
		});
	});

	it("status --json produces same envelope", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-status-json",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(
			["status", "test-status-json", "--json"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.runId, "test-status-json");
	});

	it("status and terminal result expose the same bounded queue diagnostics", async () => {
		const diagnosticTasksFile = join(dir, "diagnostic-tasks.md");
		writeFileSync(
			diagnosticTasksFile,
			`### Task 1.1: Provider task with sensitive description
- **Status:** pending
- **Executor:** switchyard
- **Quick checks:** none
- **Files:** src/provider-secret-name.mjs
- **Description:** provider task description

### Task 1.2: Human gate
- **Status:** pending
- **Executor:** human
- **Description:** human approval details

### Task 1.3: Native gate
- **Status:** pending
- **Executor:** native
- **Description:** local worker details

### Task 1.4: Dependency gate
- **Status:** pending
- **Executor:** switchyard
- **Quick checks:** none
- **Files:** src/dependent.mjs
- **Blocked by:** Task 1.1

### Task 1.5: External gate
- **Status:** pending
- **Executor:** switchyard
- **Quick checks:** none
- **Files:** src/external.mjs
- **External blockers:** decision:approval

### Task 1.6: Completed task
- **Status:** done
- **Executor:** switchyard
- **Quick checks:** none
- **Files:** src/completed.mjs
`,
			"utf8",
		);
		const runId = "diagnostic-parity";
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		await initializeRun({
			runId,
			tasksFilePath: diagnosticTasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.6"] },
			},
			current.revision,
		);

		const status = JSON.parse(
			runDispatch(["status", runId], makeStateRootEnv()).stdout.trim(),
		);
		const result = JSON.parse(
			runDispatch(["result", runId], makeStateRootEnv()).stdout.trim(),
		);
		deepStrictEqual(status.queueDiagnostics, result.queueDiagnostics);
		deepStrictEqual(status.queueDiagnostics.selected, {
			count: 5,
			reason: "queue_default",
		});
		strictEqual(status.queueDiagnostics.runnable.count, 1);
		strictEqual(status.queueDiagnostics.humanGated.count, 1);
		strictEqual(status.queueDiagnostics.nativeGated.count, 1);
		strictEqual(status.queueDiagnostics.dependencyBlocked.count, 1);
		strictEqual(status.queueDiagnostics.externalBlocked.count, 1);
		strictEqual(status.queueDiagnostics.completed.count, 1);
		const allowedReasons = new Set([
			"queue_default",
			"provider_eligible_and_unblocked",
			"executor_human",
			"executor_native",
			"task_dependency",
			"external_blocker",
			"queue_status_or_checkpoint",
			"queue_unavailable",
		]);
		for (const value of Object.values(status.queueDiagnostics)) {
			ok(allowedReasons.has(value.reason));
		}
		const serialized = JSON.stringify(status.queueDiagnostics);
		ok(!serialized.includes("provider-secret-name.mjs"));
		ok(!serialized.includes("provider task description"));
	});

	it("detached status/result preserve the fixture-reduced shadow and legacy disposition", async () => {
		const runId = `typed-shadow-envelope-${randomUUID()}`;
		const replayFixture = JSON.parse(
			readFileSync(
				resolve(__dirname, "fixtures", "outcome-replay.json"),
				"utf8",
			),
		);
		const source = replayFixture.records.find(
			(record) =>
				record.evidenceStatus === "observed" && record.stage === "artifact",
		);
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		let current = await readRun(runId);
		current = await updateRun(
			runId,
			{ outcomeWriterEpoch: `epoch-${runId}` },
			current.revision,
		);
		const typed = createStageOutcome({
			runId,
			taskId: "1.1",
			attempt: source.counter,
			attemptId: "fixture-attempt-1",
			stage: "artifact",
			status: "failed",
			producer: "runner",
			code: "artifact_capture",
			detail: {
				artifactKind: "diff",
				captured: false,
				contentHash: source.identityHash,
			},
			writerEpoch: current.outcomeWriterEpoch,
		});
		await appendOutcomeEvent(runId, typed, {
			writerEpoch: current.outcomeWriterEpoch,
		});
		current = await readRun(runId);
		current = await updateRun(
			runId,
			{
				state: "failed",
				cleanupState: "complete",
				terminalSummary: { processedTasks: 1, failedCount: 1 },
			},
			current.revision,
		);
		const expectedShadow = projectOutcomeShadow([typed], { run: current });
		deepStrictEqual(current.outcomeShadow, expectedShadow);

		const status = JSON.parse(
			runDispatch(["status", runId], makeStateRootEnv()).stdout.trim(),
		);
		const result = JSON.parse(
			runDispatch(["result", runId], makeStateRootEnv()).stdout.trim(),
		);
		deepStrictEqual(status.outcomeShadow, expectedShadow);
		deepStrictEqual(result.outcomeShadow, expectedShadow);
		strictEqual(status.outcomeProjection.reader, "reducer");
		strictEqual(result.outcomeProjection.reader, "reducer");
		strictEqual(status.outcomeProjection.finalStatus, "failed");
		deepStrictEqual(status.outcomeProjection, result.outcomeProjection);
		strictEqual(status.disposition.action, result.disposition.action);
		strictEqual(status.disposition.outcomeShadow.parity.evidence, "shadow");
		strictEqual(result.disposition.outcomeShadow.parity.evidence, "shadow");
	});
});
describe("result integration", () => {
	it("result with non-terminal run exits 5", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-result-nonterminal",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(
			["result", "test-result-nonterminal"],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			5,
			`expected exit 5, got ${result.status}: ${result.stderr}`,
		);
	});

	it("result with succeeded run exits 0 when cleanup complete", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-result-terminal",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun("test-result-terminal");
		await updateRun(
			"test-result-terminal",
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const result = runDispatch(
			["result", "test-result-terminal"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());
		ok(envelope.terminalSummary !== null);
		ok(Array.isArray(envelope.artifactRefs));
	});

	it("result with failed run exits 1", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-result-failed",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun("test-result-failed");
		await updateRun(
			"test-result-failed",
			{
				state: "failed",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: [], failedCount: 1 },
			},
			current.revision,
		);

		const result = runDispatch(
			["result", "test-result-failed"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 1);
	});

	it("result with cleanup not complete exits 1 even for succeeded", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-result-cleanup-incomplete",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun("test-result-cleanup-incomplete");
		await updateRun(
			"test-result-cleanup-incomplete",
			{
				state: "succeeded",
				cleanupState: "not_started",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const result = runDispatch(
			["result", "test-result-cleanup-incomplete"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 1);
	});
});
