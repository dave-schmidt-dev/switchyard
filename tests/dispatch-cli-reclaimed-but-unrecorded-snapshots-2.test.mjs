import { deepStrictEqual, strictEqual } from "node:assert";
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
describe("reclaimed-but-unrecorded snapshots reach the operator", () => {
	it("recover preserves a candidate that becomes live at backend mutation", async () => {
		const { initializeRun, readRun, updateRun } = await import(
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
		let terminalRun = await readRun(runId);
		terminalRun = await updateRun(
			runId,
			{ state: "failed", cleanupState: "complete" },
			terminalRun.revision,
		);
		const target = {
			uuid: "race-uuid",
			name: `switchyard-work-${runId}-42`,
			runId,
			creatorPid: 42,
			status: "stopped",
		};
		let destructiveCalls = 0;
		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", runId], {
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
					writeFileSync(
						join(stateRoot, "runs", runId, "run.json"),
						JSON.stringify({
							...terminalRun,
							state: "running",
							cleanupState: "not_started",
							workerPid: process.pid,
						}),
						"utf8",
					);
					const allowed = eligibility({
						...candidate,
						recoveryPhase: "pre_mutation",
					});
					if (allowed) destructiveCalls += 1;
					return {
						reclaimed: allowed ? [target] : [],
						skipped: allowed
							? []
							: [{ ...target, reason: "identity-or-eligibility-changed" }],
						skippedSnapshots: [],
						errors: [],
					};
				},
				releaseProjectLockIfOwnedBy: async () => false,
				releaseOrphanedProjectLocks: async () => [],
				reconcileProjectLockClaims: async () => [],
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}

		strictEqual(destructiveCalls, 0);
		const envelope = JSON.parse(output[0]);
		strictEqual(envelope.disposition, "preserved");
		strictEqual(envelope.vmsReclaimed, 0);
		strictEqual(
			envelope.candidates[0].reason,
			"identity-or-eligibility-changed",
		);
	});
	it("recover preserves canonical-schema-malformed evidence at backend mutation", async () => {
		const { initializeRun, readRun, updateRun } = await import(
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
		let terminalRun = await readRun(runId);
		terminalRun = await updateRun(
			runId,
			{ state: "failed", cleanupState: "complete" },
			terminalRun.revision,
		);
		const target = {
			uuid: "malformed-race-uuid",
			name: `switchyard-work-${runId}-42`,
			runId,
			creatorPid: 42,
			status: "stopped",
		};
		let destructiveCalls = 0;
		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", runId], {
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
					writeFileSync(
						join(stateRoot, "runs", runId, "run.json"),
						JSON.stringify({
							...terminalRun,
							orderedTaskIds: "schema-malformed",
						}),
						"utf8",
					);
					const allowed = eligibility({
						...candidate,
						recoveryPhase: "pre_mutation",
					});
					if (allowed) destructiveCalls += 1;
					return {
						reclaimed: allowed ? [target] : [],
						skipped: allowed
							? []
							: [{ ...target, reason: "identity-or-eligibility-changed" }],
						skippedSnapshots: [],
						errors: [],
					};
				},
				releaseProjectLockIfOwnedBy: async () => false,
				releaseOrphanedProjectLocks: async () => [],
				reconcileProjectLockClaims: async () => [],
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}

		strictEqual(destructiveCalls, 0);
		const envelope = JSON.parse(output[0]);
		strictEqual(envelope.disposition, "preserved");
		strictEqual(envelope.vmsReclaimed, 0);
		strictEqual(
			envelope.candidates[0].reason,
			"identity-or-eligibility-changed",
		);
	});
	it("targeted recover preserves a specific reclaim failure", async () => {
		const target = {
			uuid: "target-uuid",
			name: "switchyard-work-target-42",
			runId: "target",
			creatorPid: 42,
			status: "stopped",
		};
		let lockReconciliations = 0;
		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", "target"], {
				listManaged: () => [target],
				readRun: async () => ({
					runId: "target",
					projectPath: projectDir,
					state: "failed",
					cleanupState: "complete",
				}),
				classifyRunLiveness: () => "terminal_clean",
				reclaim: () => ({
					reclaimed: [],
					skippedSnapshots: [],
					errors: [{ name: target.name, reason: "backend deletion failed" }],
				}),
				releaseProjectLockIfOwnedBy: async () => {
					lockReconciliations += 1;
					return false;
				},
				releaseOrphanedProjectLocks: async () => [],
				reconcileProjectLockClaims: async () => [],
			});
			strictEqual(process.exitCode, 1);
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}

		strictEqual(lockReconciliations, 1);
		deepStrictEqual(JSON.parse(output[0]).errors, [
			"switchyard-work-target-42: backend deletion failed",
		]);
	});
	it("untargeted recover supplies per-resource liveness eligibility", async () => {
		const entries = [
			"clean",
			"dead",
			"live",
			"startup",
			"unknown",
			"cleanup-failed",
			"missing",
		].map((runId, index) => ({
			uuid: `uuid-${index}`,
			name: `switchyard-work-${runId}-${index + 1}`,
			runId,
			creatorPid: index + 1,
			status: "stopped",
		}));
		const states = {
			clean: "terminal_clean",
			dead: "dead",
			live: "live",
			startup: "startup_grace",
			unknown: "unknown",
			"cleanup-failed": "dead",
		};
		const authorized = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = () => {};
		try {
			await handleRecover([], {
				listManaged: () => entries,
				readRun: async (runId) => {
					if (runId === "missing") throw new Error("missing");
					return {
						runId,
						projectPath: projectDir,
						state: runId === "clean" ? "failed" : "running",
						cleanupState:
							runId === "cleanup-failed"
								? "failed"
								: runId === "clean"
									? "complete"
									: "pending",
						liveness: states[runId],
					};
				},
				classifyRunLiveness: (run) => run.liveness,
				reclaim: ({ eligibility }) => {
					authorized.push(
						...entries.filter(eligibility).map((entry) => entry.runId),
					);
					return { reclaimed: [], errors: [], skippedSnapshots: [] };
				},
				releaseOrphanedProjectLocks: async () => [],
				reconcileProjectLockClaims: async () => [],
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}
		deepStrictEqual(authorized, ["clean", "dead"]);
	});
	it("untargeted recovery refuses mixed projects and a dead-to-live proof race", async () => {
		const entry = (runId, index) => ({
			uuid: `race-${index}`,
			name: `switchyard-work-${runId}-${index}`,
			runId,
			creatorPid: index,
			status: "stopped",
		});
		for (const mode of ["mixed", "race"]) {
			const entries =
				mode === "mixed" ? [entry("a", 1), entry("b", 2)] : [entry("a", 1)];
			let reads = 0;
			let authorized = 0;
			const originalLog = console.log;
			const previousExitCode = process.exitCode;
			console.log = () => {};
			try {
				await handleRecover([], {
					listManaged: () => entries,
					readRun: async (runId) => ({
						runId,
						projectPath:
							mode === "mixed" && runId === "b" ? "/project-b" : "/project-a",
						cleanupState: "complete",
						state: "failed",
						liveness:
							mode === "race" && reads++ > 0 ? "live" : "terminal_clean",
					}),
					classifyRunLiveness: (run) => run.liveness,
					reclaim: ({ eligibility }) => {
						authorized += entries.filter(eligibility).length;
						return { reclaimed: [], errors: [], skippedSnapshots: [] };
					},
					releaseOrphanedProjectLocks: async () => [],
					reconcileProjectLockClaims: async () => [],
				});
			} finally {
				console.log = originalLog;
				process.exitCode = previousExitCode;
			}
			strictEqual(authorized, 0, mode);
		}
	});
});
