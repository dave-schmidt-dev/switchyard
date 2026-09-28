import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { probeProviderProcess } from "../src/switchyard/dispatch/index.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function writeLegacyCheckpoint(path, checkpoint) {
	writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
}
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
describe("elapsedSinceLastCompletionMs telemetry field (B.4)", () => {
	it("falls back to queueStartedAt-derived elapsed time when lastCompletionAt is unset (zero-completions incident state)", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "elapsed-since-completion-fallback-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());

		strictEqual(envelope.lastCompletionAt, null);
		ok(
			typeof envelope.elapsedSinceLastCompletionMs === "number" &&
				!Number.isNaN(envelope.elapsedSinceLastCompletionMs),
			`expected a number, got ${envelope.elapsedSinceLastCompletionMs}`,
		);
		strictEqual(envelope.elapsedSinceLastCompletionMs, envelope.elapsedMs);
	});

	it("uses lastCompletionAt once at least one task has completed", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "elapsed-since-completion-lastcompletion-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const lastCompletionAt = Date.now() - 60_000;
		const current = await readRun(runId);
		await updateRun(runId, { lastCompletionAt }, current.revision);

		const result = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());

		strictEqual(envelope.lastCompletionAt, lastCompletionAt);
		// Should track ~60s since lastCompletionAt, not the (much smaller)
		// queueStartedAt-derived elapsedMs for a run created moments ago in
		// this same test.
		ok(
			Math.abs(envelope.elapsedSinceLastCompletionMs - 60_000) < 5_000,
			`expected ~60000ms since lastCompletionAt, got ${envelope.elapsedSinceLastCompletionMs}`,
		);
		ok(
			envelope.elapsedSinceLastCompletionMs > envelope.elapsedMs,
			`expected elapsedSinceLastCompletionMs (${envelope.elapsedSinceLastCompletionMs}) to exceed elapsedMs (${envelope.elapsedMs}) once lastCompletionAt predates queueStartedAt-derived elapsed`,
		);
	});
});
describe("pendingCount telemetry field (checkpoint-derived, CR-3 regression)", () => {
	it("pendingCount equals totalTaskCount on a fresh run with no checkpoint file", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "pending-fresh-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());
		strictEqual(statusEnvelope.totalTaskCount, 3);
		strictEqual(statusEnvelope.pendingCount, 3);

		// result requires a terminal run state — advance it before checking
		// the same field agrees on the result envelope.
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: [] },
			},
			current.revision,
		);

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0, `stderr: ${resultResult.stderr}`);
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());
		strictEqual(resultEnvelope.pendingCount, 3);
	});

	it("pendingCount excludes tasks a pre-existing checkpoint already marks done, even with zero matching events in this run's own log (resumed-run regression case)", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { getCheckpointPath } = await import(
			"../src/switchyard/runner/index.mjs"
		);

		const runId = "pending-resumed-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		// Simulate a checkpoint left behind by a prior process on a resumed
		// run: task "1.1" is already marked done there, but this run's own
		// events.jsonl has recorded zero events for it (no run-store events
		// were ever written for this runId). This is the exact CR-3
		// regression shape: a flat `orderedTaskIds.length - events.length`
		// subtraction would see 0 events and report pendingCount as 3,
		// silently counting an already-completed task as still pending. The
		// checkpoint-derived computation must instead see completedTaskIds
		// and report 2.
		writeLegacyCheckpoint(getCheckpointPath(tasksFile), {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: ["1.1"],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [],
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());
		strictEqual(statusEnvelope.totalTaskCount, 3);
		strictEqual(
			statusEnvelope.pendingCount,
			2,
			"pendingCount must exclude the checkpoint-completed task even though this run's own events.jsonl has no matching event",
		);

		// result requires a terminal run state — advance it before checking
		// the same field agrees on the result envelope.
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0, `stderr: ${resultResult.stderr}`);
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());
		strictEqual(resultEnvelope.pendingCount, 2);
	});

	it("rejects a real pre-receipt checkpoint on detached status and result", async () => {
		writeFileSync(
			tasksFile,
			"### Task 1.1: Checked task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** npm run lint\n- **Description:** fixture\n",
		);
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { getCheckpointPath } = await import(
			"../src/switchyard/runner/index.mjs"
		);
		const runId = `pre-receipt-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		writeLegacyCheckpoint(getCheckpointPath(tasksFile), {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: ["1.1"],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [
				{ taskId: "1.1", attempt: 1, success: true, result: "success" },
			],
		});
		const run = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"], failedCount: 0 },
			},
			run.revision,
		);
		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.state, "failed");
		strictEqual(status.pendingCount, 1);
		strictEqual(status.disposition.reasonCode, "check_failed");
		const resultCall = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultCall.status, 1);
		const result = JSON.parse(resultCall.stdout.trim());
		strictEqual(result.state, "failed");
		deepStrictEqual(result.terminalSummary.completedTaskIds, []);
		strictEqual(result.disposition.action, "stop");
	});

	it("status degrades pendingCount rather than crashing when the checkpoint file exists but is corrupt", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { getCheckpointPath } = await import(
			"../src/switchyard/runner/index.mjs"
		);

		const runId = "pending-corrupt-checkpoint-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		// status/result are read-only diagnostic commands (like
		// readEventsSafe's best-effort event read above) — a checkpoint that
		// exists but fails to parse must not crash an otherwise-healthy
		// status read, even though runQueue's own write path deliberately
		// fails loudly on the same condition.
		writeFileSync(
			getCheckpointPath(tasksFile),
			"{not valid json at all",
			"utf8",
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());
		strictEqual(statusEnvelope.totalTaskCount, 3);
		strictEqual(statusEnvelope.pendingCount, 3);
	});
});
describe("probeProviderProcess (providerProcessDetected)", () => {
	it("never shells out when run.state is not 'running'", () => {
		for (const state of [
			"created",
			"launching",
			"launcher_ready",
			"succeeded",
			"failed",
			"recovery_required",
		]) {
			let execCalled = false;
			const spyExecFn = () => {
				execCalled = true;
				return "";
			};
			const result = probeProviderProcess(
				{
					state,
					workingContainerName: "some-container",
					activeTaskProvider: "claude",
				},
				{ execFn: spyExecFn },
			);
			strictEqual(result, null, `expected null for state ${state}`);
			strictEqual(
				execCalled,
				false,
				`execFn must never be invoked for state ${state}`,
			);
		}
	});

	it("returns null without shelling out when workingContainerName or activeTaskProvider is unset, even while running", () => {
		let execCalled = false;
		const spyExecFn = () => {
			execCalled = true;
			return "";
		};
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: null,
					activeTaskProvider: "claude",
				},
				{ execFn: spyExecFn },
			),
			null,
		);
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: "some-container",
					activeTaskProvider: null,
				},
				{ execFn: spyExecFn },
			),
			null,
		);
		strictEqual(execCalled, false);
	});

	it("returns null without shelling out for a provider with no known binary mapping", () => {
		let execCalled = false;
		const spyExecFn = () => {
			execCalled = true;
			return "";
		};
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "totally-unknown-provider",
			},
			{ execFn: spyExecFn },
		);
		strictEqual(result, null);
		strictEqual(execCalled, false);
	});

	it("returns null (never throws) when the backend itself throws, e.g. the VM is unreachable", () => {
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => {
				throw new Error("simulated prlctl failure");
			},
		});
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ executionBackend: backend },
		);
		strictEqual(result, null);
	});

	it("returns true when a guest ps line's command column matches the mapped binary basename, even via a fully-qualified path", () => {
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () =>
				"123 /usr/local/bin/claude --headless\n456 sleep infinity\n",
		});
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ executionBackend: backend },
		);
		strictEqual(result, true);
	});

	it("returns false (a real boolean, not null) when the guest probe succeeds but no line matches", () => {
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => "456 sleep infinity\n",
		});
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ executionBackend: backend },
		);
		strictEqual(result, false);
	});

	it("uses the cursor-agent binary name (not cursor) for the cursor provider", () => {
		const noMatchBackend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => "123 cursor --headless\n",
		});
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: "some-container",
					activeTaskProvider: "cursor",
				},
				{ executionBackend: noMatchBackend },
			),
			false,
			"binary name 'cursor' alone must not match — the actual binary is cursor-agent",
		);

		const matchBackend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => "123 cursor-agent --headless\n",
		});
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: "some-container",
					activeTaskProvider: "cursor",
				},
				{ executionBackend: matchBackend },
			),
			true,
		);
	});

	it("inspects the workspace through prlctl exec against the routed workspace id", () => {
		let capturedCommand;
		let capturedArgs;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: (command, args) => {
				capturedCommand = command;
				capturedArgs = args;
				return "";
			},
		});
		probeProviderProcess(
			{
				state: "running",
				workingContainerName: "my-container",
				activeTaskProvider: "claude",
			},
			{ executionBackend: backend },
		);
		strictEqual(capturedCommand, "prlctl");
		strictEqual(capturedArgs[0], "exec");
		strictEqual(capturedArgs[1], "my-container");
	});
});
