import { ok, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { ROSTER_FIXTURE_PATH } from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
let detachedCleanupPending;
let detachedCleanupRunId;
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
describe("project-lock reconciliation without managed VMs", () => {
	it("recover without --state-root binds the backend to the run-store default", async () => {
		const { handleRecover } = await import(
			"../src/switchyard/dispatch/index.mjs"
		);
		const { getStateRoot } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const previousRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		const expectedRoot = getStateRoot();
		let observedRoot = null;
		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(line);
		try {
			await handleRecover([], {
				executionBackend: {
					listManaged: () => {
						observedRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
						return [];
					},
					reclaim: () => ({
						reclaimed: [],
						errors: [],
						skippedSnapshots: [],
					}),
				},
				releaseOrphanedProjectLocks: async () => [],
				reconcileProjectLockClaims: async () => [],
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
			if (previousRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRoot;
		}
		strictEqual(observedRoot, expectedRoot);
		strictEqual(JSON.parse(output[0]).vmsReclaimed, 0);
	});

	it("recover --run reclaims terminal-clean and dead-running VMs from durable ownership", async () => {
		const { handleRecover } = await import(
			"../src/switchyard/dispatch/index.mjs"
		);
		const { advanceState, initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const bootSessionUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		const creatorPid = 999_991;
		const processStartIdentity = `switchyard-host-process-v1:${bootSessionUuid}:${creatorPid}:42`;

		for (const state of ["terminal-clean", "dead-running"]) {
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
			if (state === "terminal-clean") {
				await advanceState(runId, "failed");
				const current = await readRun(runId);
				await updateRun(runId, { cleanupState: "complete" }, current.revision);
			} else {
				await advanceState(runId, "running");
				const current = await readRun(runId);
				await updateRun(runId, { workerPid: creatorPid }, current.revision);
			}

			const uuid = `{${randomUUID()}}`;
			const name = `switchyard-work-${runId}-${creatorPid}`;
			const resourceRoot = join(stateRoot, "runs", runId, "resources");
			const writer = new ParallelsExecutionBackend({
				creatorPid,
				runId,
			});
			writer.writeVmOwnership(uuid, name, {
				resourceRoot,
				runId,
				taskId: "1.1",
				attemptId: "attempt-1",
				projectRoot: resolve(projectDir),
				purpose: "detached-recovery-test",
				creatorPid,
				processStartIdentity,
			});
			const ownershipPath = writer.vmOwnershipPath(uuid, resourceRoot);
			ok(existsSync(ownershipPath));

			const calls = [];
			let present = true;
			const reader = new ParallelsExecutionBackend({
				prlctlFn: (args) => {
					calls.push(args);
					if (args[0] === "list") {
						return present
							? `uuid\tstatus\tname\n${uuid}\tstopped\t${name}`
							: "uuid\tstatus\tname";
					}
					if (args[0] === "delete") present = false;
					return "";
				},
				hostProcessIdentityProbe: (pid) => ({
					state: "absent",
					pid,
					bootSessionUuid,
					identity: null,
				}),
			});
			strictEqual(reader.ownedResourcesByUuid.size, 0);

			const output = [];
			const originalLog = console.log;
			const previousExitCode = process.exitCode;
			console.log = (line) => output.push(line);
			try {
				await handleRecover(["--run", runId, "--state-root", stateRoot], {
					executionBackend: reader,
					isWorkerLive: () => false,
					releaseProjectLockIfOwnedBy: async () => false,
					isProjectLockOwnedBy: async () => false,
					releaseOrphanedProjectLocks: async () => [],
					reconcileProjectLockClaims: async () => [],
				});
			} finally {
				console.log = originalLog;
				process.exitCode = previousExitCode;
			}
			const result = JSON.parse(output[0]);
			strictEqual(
				result.vmsReclaimed,
				1,
				`${state}: ${JSON.stringify(result)}`,
			);
			ok(calls.some((args) => args[0] === "delete" && args[1] === uuid));
			ok(!existsSync(ownershipPath), `${state} ownership must be removed`);
		}
	});

	it("recover --state-root releases one stale lock once with no VM candidate", async () => {
		const {
			acquireProjectLock,
			advanceState,
			initializeRun,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");
		const { handleRecover } = await import(
			"../src/switchyard/dispatch/index.mjs"
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
		await advanceState(runId, "failed");
		const current = await readRun(runId);
		await updateRun(runId, { cleanupState: "complete" }, current.revision);
		await acquireProjectLock(projectDir, runId);

		const output = [];
		const reclaimEligibility = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(line);
		const dependencies = {
			executionBackend: {
				listManaged: () => [],
				reclaim: ({ eligibility }) => {
					reclaimEligibility.push(
						eligibility({
							uuid: "missing-uuid",
							name: "switchyard-work-missing-999999",
							runId: "missing",
							creatorPid: 999999,
						}),
					);
					return { reclaimed: [], errors: [], skippedSnapshots: [] };
				},
			},
		};
		try {
			await handleRecover(["--state-root", stateRoot], dependencies);
			await handleRecover(["--state-root", stateRoot], dependencies);
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}
		strictEqual(JSON.parse(output[0]).projectLocksReleased, 1);
		strictEqual(JSON.parse(output[1]).projectLocksReleased, 0);
		strictEqual(
			reclaimEligibility.every((eligible) => eligible === false),
			true,
		);
		strictEqual(isProjectLockHeld(projectDir), false);
	});

	it("never enters the queue when ownership reassertion fails", async () => {
		const { runDispatch: runDispatchInProcess } = await import(
			"../src/switchyard/dispatch/index.mjs"
		);
		let queueEntries = 0;
		await rejects(
			runDispatchInProcess(
				{
					tasksFilePath: tasksFile,
					projectPath: projectDir,
					maxTasks: 1,
					checkpointPath: undefined,
					stopOnFailure: true,
					excludeProviders: [],
					onlyProviders: [],
					taskIds: ["1.1"],
					platform: "macos",
				},
				{
					assertGenerationAllowed: () => {},
					releaseOrphanedProjectLocks: async () => [],
					reconcileProjectLockClaims: async () => [],
					assertProjectLockOwnership: async () => false,
					executionBackend: {
						listManaged: () => [],
						reclaim: () => ({
							reclaimed: [],
							errors: [],
							skippedSnapshots: [],
						}),
					},
					runQueue: async () => {
						queueEntries += 1;
						return null;
					},
				},
			),
		);
		strictEqual(queueEntries, 0);
	});
});
