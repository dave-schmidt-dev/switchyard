import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
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
describe("CLI exit code contract", () => {
	it("exit 0: launch success", () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0);
	});

	it("exit 2: launch with missing --project", () => {
		const result = runDispatch(["launch", tasksFile]);
		strictEqual(result.status, 2);
	});

	it("exit 2: status with missing run-id", () => {
		const result = runDispatch(["status"]);
		strictEqual(result.status, 2);
	});

	it("exit 2: result with missing run-id", () => {
		const result = runDispatch(["result"]);
		strictEqual(result.status, 2);
	});

	it("exit 3: status with nonexistent runId", () => {
		const result = runDispatch(["status", "nonexistent"], makeStateRootEnv());
		strictEqual(result.status, 3);
	});

	it("exit 3: result with nonexistent runId", () => {
		const result = runDispatch(["result", "nonexistent"], makeStateRootEnv());
		strictEqual(result.status, 3);
	});

	it("exit 5: result with non-terminal run", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "exit-code-5",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(["result", "exit-code-5"], makeStateRootEnv());
		strictEqual(result.status, 5);
	});
});
describe("exit code 4: corrupt state", () => {
	it("status with corrupt run.json exits 4", () => {
		const runDir = join(stateRoot, "runs", "corrupt-status");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "{not valid json at all", "utf8");

		const result = runDispatch(
			["status", "corrupt-status"],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			4,
			`expected exit 4, got ${result.status}: ${result.stderr}`,
		);
	});

	it("result with corrupt run.json exits 4", () => {
		const runDir = join(stateRoot, "runs", "corrupt-result");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "{not valid json at all", "utf8");

		const result = runDispatch(
			["result", "corrupt-result"],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			4,
			`expected exit 4, got ${result.status}: ${result.stderr}`,
		);
	});
});
describe("CLI exit code contract - launch failures", () => {
	it("exit 1: launch with unwritable state root", () => {
		const fileStateRoot = join(dir, "is-a-file-not-dir");
		writeFileSync(fileStateRoot, "block", "utf8");

		const result = runDispatch(["launch", tasksFile, "--project", projectDir], {
			...makeStateRootEnv(),
			SWITCHYARD_RUN_STORE_ROOT: fileStateRoot,
		});
		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: stderr=${result.stderr} stdout=${result.stdout}`,
		);
	});
});
describe("run subcommand via spawn", () => {
	it("run with valid args exits 0 and produces checkpoint", async () => {
		const tasksPath = join(dir, "run-tasks.md");
		writeFileSync(
			tasksPath,
			"### Task 1.1: Test run task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** Run test\n",
			"utf8",
		);

		const runProjectDir = join(dir, "run-project");
		mkdirSync(runProjectDir, { recursive: true });
		mkdirSync(join(runProjectDir, ".git"), { recursive: true });
		execSync("git init", { cwd: runProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: runProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: runProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: runProjectDir,
			stdio: "ignore",
		});

		const result = runDispatch(
			["run", tasksPath, "--project", runProjectDir, "--max-tasks", "1"],
			makeStateRootEnv(),
			60_000,
		);
		ok(
			result.status === 0 || result.status === 1,
			`expected exit 0 or 1, got ${result.status}: stderr=${result.stderr}`,
		);

		// The sync path's terminal write must persist cleanupState:"complete"
		// (Task D.5) so applyRetention can later reclaim the run. Unlike
		// `launch`, the `run` subcommand prints no envelope, so locate the
		// single persisted run record in the fresh state root instead.
		const runDirs = readdirSync(join(stateRoot, "runs"));
		strictEqual(
			runDirs.length,
			1,
			`expected exactly one run record, got ${runDirs.length}`,
		);
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runDirs[0]);
		strictEqual(run.cleanupState, "complete");
		ok(typeof run.startedAt === "string");
		ok(typeof run.finishedAt === "string");
		ok(Date.parse(run.startedAt) <= Date.parse(run.finishedAt));
	});
});
describe("deriveTelemetryFields parity between status and result envelopes", () => {
	it("status and result envelopes agree on the shared telemetry fields for the same run", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "telemetry-parity-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const activeTaskStartedAt = Date.now() - 5_000;
		const lastCompletionAt = Date.now() - 1_000;
		const activeTaskDeadline = new Date(Date.now() + 1_800_000).toISOString();

		const current = await readRun(runId);
		// Fields set directly (rather than via a real run) purely to exercise
		// the telemetry math with every input populated at once — the two
		// envelope builders must derive identical shared-field values from
		// the same underlying run record regardless of run state.
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				activeTaskId: "1.2",
				activeTaskProvider: "claude",
				activeTaskModel: "claude-sonnet-5",
				activeTaskStartedAt,
				activeTaskDeadline,
				lastCompletionAt,
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());

		// Deterministic fields (no dependency on wall-clock "now" at build
		// time) must match exactly between the two envelopes.
		strictEqual(statusEnvelope.queueStartedAt, resultEnvelope.queueStartedAt);
		strictEqual(statusEnvelope.totalTaskCount, resultEnvelope.totalTaskCount);
		strictEqual(statusEnvelope.totalTaskCount, 3);
		strictEqual(statusEnvelope.pendingCount, resultEnvelope.pendingCount);
		// No checkpoint file exists for this run's tasksFile, so pendingCount
		// falls back to the full orderedTaskIds count — it must NOT be
		// derived from terminalSummary.completedTaskIds (a different,
		// run-record-level notion of "done" that deriveTelemetryFields does
		// not consult).
		strictEqual(statusEnvelope.pendingCount, 3);
		strictEqual(statusEnvelope.runningCount, resultEnvelope.runningCount);
		strictEqual(statusEnvelope.runningCount, 1);
		strictEqual(
			statusEnvelope.lastCompletionAt,
			resultEnvelope.lastCompletionAt,
		);
		strictEqual(statusEnvelope.lastCompletionAt, lastCompletionAt);

		// now()-derived fields: assert both envelopes computed them (not
		// null/NaN) and agree within a generous tolerance for the wall-clock
		// drift between the two spawned CLI calls.
		for (const key of [
			"elapsedMs",
			"elapsedSinceLastCompletionMs",
			"activeTaskAgeMs",
			"activeTaskRemainingMs",
		]) {
			ok(
				typeof statusEnvelope[key] === "number" &&
					!Number.isNaN(statusEnvelope[key]),
				`status envelope ${key} should be a number, got ${statusEnvelope[key]}`,
			);
			ok(
				typeof resultEnvelope[key] === "number" &&
					!Number.isNaN(resultEnvelope[key]),
				`result envelope ${key} should be a number, got ${resultEnvelope[key]}`,
			);
			ok(
				Math.abs(statusEnvelope[key] - resultEnvelope[key]) < 5_000,
				`status/result ${key} drifted too far: ${statusEnvelope[key]} vs ${resultEnvelope[key]}`,
			);
		}
	});

	it("activeTaskAgeMs and activeTaskRemainingMs are null when the underlying fields are unset", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "telemetry-null-fields-run";
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

		strictEqual(envelope.activeTaskAgeMs, null);
		strictEqual(envelope.activeTaskRemainingMs, null);
		strictEqual(envelope.lastCompletionAt, null);
		strictEqual(envelope.runningCount, 0);
		strictEqual(envelope.totalTaskCount, 1);
		ok(typeof envelope.elapsedMs === "number" && envelope.elapsedMs >= 0);
		// lastCompletionAt is unset, so elapsedSinceLastCompletionMs must fall
		// back to the same queueStartedAt-derived value as elapsedMs — both
		// fields are computed from the same `now` inside deriveTelemetryFields.
		strictEqual(envelope.elapsedSinceLastCompletionMs, envelope.elapsedMs);
	});

	it("activeTaskAgeMs is null once activeTaskId clears, even though activeTaskStartedAt remains set on the underlying run record (regression: activeTaskAgeMs never cleared)", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "telemetry-completed-task-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun(runId);
		// Mirrors onResult's real patch shape (worker-bootstrap.mjs): on task
		// completion activeTaskId/Provider/Model/Deadline are nulled, but
		// activeTaskStartedAt is left as-is — it is never cleared anywhere.
		// Before the fix, activeTaskAgeMs gated on activeTaskStartedAt alone
		// and so kept reporting a stale, ever-growing age here.
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				activeTaskId: null,
				activeTaskProvider: null,
				activeTaskModel: null,
				activeTaskDeadline: null,
				activeTaskStartedAt: Date.now() - 60_000,
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());
		strictEqual(statusEnvelope.activeTaskAgeMs, null);
		strictEqual(statusEnvelope.runningCount, 0);

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0, `stderr: ${resultResult.stderr}`);
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());
		strictEqual(resultEnvelope.activeTaskAgeMs, null);
		strictEqual(resultEnvelope.runningCount, 0);
	});
});
