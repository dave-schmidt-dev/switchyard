import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	__dirname,
	ROSTER_FIXTURE_PATH,
	runBootstrap,
	runDispatch,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
let detachedCleanupPending;
let detachedCleanupRunId;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-detached-dispatch-");
	detachedCleanupPending = false;
	detachedCleanupRunId = null;
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

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
	if (detachedCleanupPending) {
		console.error(
			`detached cleanup was not confirmed for run ${detachedCleanupRunId ?? "unknown"}; preserving fixture ${dir}`,
		);
		return;
	}
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("fast/failed bootstrap", () => {
	it("emits one fixed diagnostic when the run record is missing", async () => {
		const runId = `missing-${randomUUID()}`;
		const canary = "SECRET_CANARY_MISSING_RUN";
		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", canary],
			makeStateRootEnv(),
		);

		strictEqual(result.status, 1);
		strictEqual(
			result.stderr,
			"worker-bootstrap: fatal event persistence unavailable; durable run state may be incomplete\n",
		);
		ok(!result.stderr.includes(canary));
		ok(!existsSync(resolve(stateRoot, "runs", runId, "run.json")));
	});

	it("emits one fixed diagnostic and preserves corrupt run.json", async () => {
		const runId = `corrupt-${randomUUID()}`;
		const canary = "SECRET_CANARY_CORRUPT_RUN";
		const runRoot = resolve(stateRoot, "runs", runId);
		const runJsonPath = resolve(runRoot, "run.json");
		mkdirSync(runRoot, { recursive: true });
		// An unreadable run.json (a directory) exercises the filesystem-error
		// path, which retention conservatively leaves in place.
		mkdirSync(runJsonPath);
		const canaryPath = resolve(runJsonPath, "canary");
		writeFileSync(canaryPath, canary, "utf8");

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", canary],
			makeStateRootEnv(),
		);

		strictEqual(result.status, 1);
		strictEqual(
			result.stderr,
			"worker-bootstrap: fatal event persistence unavailable; durable run state may be incomplete\n",
		);
		ok(!result.stderr.includes(canary));
		ok(existsSync(runJsonPath));
		strictEqual(readFileSync(canaryPath, "utf8"), canary);
	});

	it("bootstrap that fails to import the runner records worker_boot_failed and does not hang", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = randomUUID();

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		// Build a broken bootstrap script that fails to import
		const brokenBootstrapPath = join(dir, "broken-bootstrap.mjs");
		writeFileSync(
			brokenBootstrapPath,
			`process.env.SWITCHYARD_RUN_STORE_ROOT = ${JSON.stringify(stateRoot)};
import("${resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs")}").then(async (runStore) => {
	await runStore.advanceState("${runId}", "running");
	throw new Error("simulated import failure: module not found");
}).catch(async (err) => {
	try {
		await (await import("${resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs")}")).createEvent("${runId}", {
			phase: "worker",
			event: "worker_boot_failed",
			status: "fatal",
			errorKind: "launch_failed",
			diagnosticCode: "worker_boot_exception",
			failurePhase: "worker_boot",
		});
	} catch {}
	process.exit(1);
});
`,
			"utf8",
		);

		const start = Date.now();
		const result = spawnSync(process.execPath, [brokenBootstrapPath], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			env: { ...process.env, SWITCHYARD_RUN_STORE_ROOT: stateRoot },
		});
		const elapsed = Date.now() - start;

		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: ${result.stderr}`,
		);
		ok(elapsed < 10_000, `broken bootstrap hung: ${elapsed}ms`);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_boot_exception");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(
			bootFailed.reason,
			"The headless provider job could not be launched.",
		);
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes("simulated import failure"));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.diagnosticCode, "worker_boot_exception");
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		strictEqual(run.lastFailure.reasonCode, "launch_failed");
		strictEqual(
			run.lastFailure.reason,
			"The headless provider job could not be launched.",
		);
	});
});
describe("status and result envelope contracts", () => {
	it("surfaces a deferred terminal run and result exits 6", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "deferred",
				cleanupState: "complete",
				terminalSummary: {
					processedTasks: 0,
					completedTaskIds: [],
					deferredTaskIds: ["1.1"],
					failedCount: 0,
				},
			},
			current.revision,
		);

		const status = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(status.status, 0);
		strictEqual(
			JSON.parse(status.stdout.trim()).disposition.reasonCode,
			"deferred_work",
		);
		const result = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(result.status, 6);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.state, "deferred");
		strictEqual(envelope.terminalSummary.outcome, "deferred_work");
	});

	it("status shows activeTaskId when a task is running and completed/failed counts change", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		// Advance to running and set activeTaskId
		const current = await readRun(runId);
		await updateRun(
			runId,
			{ state: "running", activeTaskId: "1.1" },
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.state, "running");
		strictEqual(status.activeTaskId, "1.1");
	});

	it("status exposes workerLive:true and the routed provider/model/deadline for a live worker, without needing docker top", async () => {
		// Regression: an operator had to shell out to `docker top`/`ps` to
		// distinguish a genuinely active run from a ghost (a "running" state
		// whose worker process actually died), and had to inspect the host
		// process to learn which provider/model a task was routed to.
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const deadline = new Date(Date.now() + 1_800_000).toISOString();
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "running",
				workerPid: process.pid,
				activeTaskId: "1.1",
				activeTaskProvider: "claude",
				activeTaskModel: "claude-sonnet-5",
				activeTaskDeadline: deadline,
				activeTaskElapsedMs: 321,
				activeTaskHeartbeatAt: 123456,
				activeTaskProcessPhase: "provider_transport_running",
				telemetryWriteFailures: 2,
				lastTelemetryWriteFailure: "revision_conflict",
			},
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.workerLive, true);
		strictEqual(status.activeTaskProvider, "claude");
		strictEqual(status.activeTaskModel, "claude-sonnet-5");
		strictEqual(status.activeTaskDeadline, deadline);
		strictEqual(status.activeTaskElapsedMs, 321);
		strictEqual(status.activeTaskHeartbeatAt, 123456);
		strictEqual(status.activeTaskProcessPhase, "provider_transport_running");
		strictEqual(status.telemetryWriteFailures, 2);
		strictEqual(status.lastTelemetryWriteFailure, "revision_conflict");

		const terminalCurrent = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: {
					totalTasks: 1,
					runnableTasks: 1,
					processedTasks: 1,
					completedTaskIds: ["1.1"],
					failedCount: 0,
				},
			},
			terminalCurrent.revision,
		);
		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0);
		const result = JSON.parse(resultResult.stdout.trim());
		strictEqual(result.activeTaskId, null);
		strictEqual(result.activeTaskProvider, null);
		strictEqual(result.activeTaskModel, null);
		strictEqual(result.activeTaskDeadline, null);
		strictEqual(result.activeTaskElapsedMs, null);
		strictEqual(result.activeTaskHeartbeatAt, null);
		strictEqual(result.activeTaskProcessPhase, null);
		strictEqual(result.telemetryWriteFailures, 2);
		strictEqual(result.lastTelemetryWriteFailure, "revision_conflict");
	});

	it("status exposes workerLive:false for a running state whose worker pid is dead (ghost run)", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const current = await readRun(runId);
		await updateRun(
			runId,
			{ state: "running", workerPid: 99999, activeTaskId: "1.1" },
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.workerLive, false);
	});

	it("status reports workerLive:null for a non-running state (no live-worker question applies)", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.state, "created");
		strictEqual(status.workerLive, null);
		strictEqual(status.activeTaskProvider, null);
		strictEqual(status.activeTaskModel, null);
		strictEqual(status.activeTaskDeadline, null);
		strictEqual(status.activeTaskElapsedMs, null);
		strictEqual(status.activeTaskHeartbeatAt, null);
		strictEqual(status.activeTaskProcessPhase, null);
		strictEqual(status.telemetryWriteFailures, 0);
		strictEqual(status.lastTelemetryWriteFailure, null);
	});
});
