import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleRecover } from "../src/switchyard/dispatch/index.mjs";
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
	it("finalizes a dead old run while preserving a newer live project-lock owner", async () => {
		const {
			acquireProjectLock,
			advanceState,
			initializeRun,
			isProjectLockOwnedBy,
			readEvents,
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
		const target = {
			uuid: "dead-worker-vm",
			name: `switchyard-work-${staleRunId}-fixture`,
			runId: staleRunId,
			creatorPid: 999999,
			status: "stopped",
		};

		const output = [];
		const originalLog = console.log;
		const originalExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", staleRunId], {
				listManaged: () => [target],
				reclaim: ({ eligibility, ownershipContext }) => {
					const candidate = {
						...target,
						ownership: {
							...ownershipContext,
							vmUuid: target.uuid,
							vmName: target.name,
						},
					};
					strictEqual(eligibility(candidate), true);
					strictEqual(
						eligibility({ ...candidate, recoveryPhase: "pre_mutation" }),
						true,
					);
					return {
						reclaimed: [target],
						skipped: [],
						skippedSnapshots: [],
						errors: [],
					};
				},
			});
		} finally {
			console.log = originalLog;
			process.exitCode = originalExitCode;
		}

		const envelope = JSON.parse(output[0]);
		deepStrictEqual(envelope.errors, []);
		strictEqual(envelope.vmsReclaimed, 1);
		strictEqual(envelope.projectLocksReleased, 0);
		strictEqual(await isProjectLockOwnedBy(projectDir, activeRunId), true);
		const staleRun = await readRun(staleRunId);
		strictEqual(staleRun.state, "failed");
		strictEqual(staleRun.cleanupState, "complete");
		strictEqual(staleRun.terminalizedBy, "dead_worker_recovery");
		const typedStages = (await readEvents(staleRunId))
			.filter((event) => typeof event.stage === "string")
			.map((event) => event.stage);
		deepStrictEqual(typedStages, [
			"cleanup",
			"cleanup",
			"run",
			"postcondition",
		]);
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
			await handleRecover(["--run", runId], { listManaged: () => [] });
		} finally {
			console.log = originalLog;
			process.exitCode = originalExitCode;
		}

		const envelope = JSON.parse(output[0]);
		deepStrictEqual(envelope.errors, []);
		strictEqual(envelope.projectLocksReleased, 1);
		strictEqual(isProjectLockHeld(projectDir), false);
	});
	it("keeps finalizer cleanup incomplete when fresh VM proof becomes live", async () => {
		const { initializeRun, advanceState, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
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
		let current = await readRun(runId);
		await updateRun(runId, { workerPid: 999999 }, current.revision);
		const target = {
			uuid: "race-uuid",
			name: `switchyard-work-${runId}-999999`,
			runId,
			creatorPid: 999999,
			status: "stopped",
		};
		let proofReads = 0;
		let destroys = 0;
		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", runId], {
				listManaged: () => [target],
				readRun: async () => ({
					...(await readRun(runId)),
					liveness: proofReads++ === 0 ? "dead" : "live",
				}),
				classifyRunLiveness: (run) => run.liveness,
				destroy: () => {
					destroys += 1;
				},
				reconcileProjectLockClaims: async () => [],
				releaseProjectLockIfOwnedBy: async () => false,
				isProjectLockOwnedBy: async () => false,
				releaseOrphanedProjectLocks: async () => [],
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}
		strictEqual(destroys, 0);
		current = await readRun(runId);
		strictEqual(current.cleanupState, "failed");
		ok(JSON.parse(output[0]).errors.includes("recovery_incomplete"));
	});
});
