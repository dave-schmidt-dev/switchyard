// @test-phase: serial
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleRecover } from "../src/switchyard/dispatch/cli.mjs";
import { ROSTER_FIXTURE_PATH } from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
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
describe("recover integration", () => {
	it("leaves a newer live project-lock owner alone when recovering a dead old run", async () => {
		const {
			acquireProjectLock,
			advanceState,
			initializeRun,
			isProjectLockOwnedBy,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");
		const staleRunId = randomUUID();
		await initializeRun({
			runId: staleRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(staleRunId, "running");
		let current = await readRun(staleRunId);
		await updateRun(staleRunId, { workerPid: 999999 }, current.revision);

		const activeRunId = randomUUID();
		await initializeRun({
			runId: activeRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(activeRunId, "running");
		current = await readRun(activeRunId);
		await updateRun(activeRunId, { workerPid: process.pid }, current.revision);
		await acquireProjectLock(projectDir, activeRunId);
		const output = [];
		const originalLog = console.log;
		const originalExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", staleRunId]);
		} finally {
			console.log = originalLog;
			process.exitCode = originalExitCode;
		}

		const envelope = JSON.parse(output[0]);
		deepStrictEqual(envelope.errors, []);
		ok(!Object.hasOwn(envelope, "vmsReclaimed"));
		strictEqual(envelope.projectLocksReleased, 0);
		strictEqual(await isProjectLockOwnedBy(projectDir, activeRunId), true);
	});
	it("counts a project lock successfully released by dead-run finalization", async () => {
		const {
			acquireProjectLock,
			advanceState,
			initializeRun,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");
		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(runId, "running");
		const current = await readRun(runId);
		await updateRun(runId, { workerPid: 999999 }, current.revision);
		await acquireProjectLock(projectDir, runId);

		const output = [];
		const originalLog = console.log;
		const originalExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", runId]);
		} finally {
			console.log = originalLog;
			process.exitCode = originalExitCode;
		}

		const envelope = JSON.parse(output[0]);
		deepStrictEqual(envelope.errors, []);
		strictEqual(envelope.projectLocksReleased, 1);
		strictEqual(isProjectLockHeld(projectDir), false);
	});
});
