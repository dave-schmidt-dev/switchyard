import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	handleRecover,
	parseRecoverArgs,
} from "../src/switchyard/dispatch/index.mjs";
import {
	acquireProjectLock,
	advanceState,
	initializeRun,
	isProjectLockOwnedBy,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import { simpleQuarantinePath } from "../src/switchyard/simple/worktree-cleanup.mjs";
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
async function createSimpleWorktreeRun({
	runState = "failed",
	worktreeState = "retained",
	rootKind = "directory",
	workerPid = 999999,
} = {}) {
	const runId = randomUUID();
	const candidateParent = join(dir, "simple-recovery-parent");
	mkdirSync(candidateParent, { recursive: true });
	const canonicalParent = realpathSync(candidateParent);
	const candidateChild = `switchyard-simple-${randomUUID()}`;
	const worktreePath = join(canonicalParent, candidateChild);
	const symlinkTarget = join(dir, "simple-recovery-target");
	if (rootKind === "directory") mkdirSync(worktreePath);
	if (rootKind === "symlink") {
		mkdirSync(symlinkTarget);
		symlinkSync(symlinkTarget, worktreePath, "dir");
	}
	await initializeRun({
		runId,
		tasksFilePath: tasksFile,
		projectPath: projectDir,
		orderedTaskIds: ["1.1"],
		initialHostFingerprint: "simple",
		workerPid,
		workerNonce: randomUUID(),
		launchArgs: [],
	});
	if (runState === "running") await advanceState(runId, "running");
	else {
		const current = await readRun(runId);
		await updateRun(
			runId,
			{ state: runState, cleanupState: "pending" },
			current.revision,
		);
	}
	const current = await readRun(runId);
	if (worktreeState !== null) {
		await updateRun(
			runId,
			{
				worktree: {
					canonicalParent,
					candidateChild,
					path: worktreePath,
					state: worktreeState,
					reason: "provider_exit_nonzero",
					retainedAt:
						worktreeState === "retained" ? new Date().toISOString() : null,
				},
			},
			current.revision,
		);
	}
	return { runId, worktreePath, worktreeState };
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
describe("recover integration", () => {
	it("recover --run removes an expired, stopped, exact recorded salvage root", async () => {
		const runId = `recover-owned-${randomUUID()}`;
		const nonce = randomUUID();
		const canonicalParent = "/private/tmp";
		const candidateChild = `switchyard-simple-${randomUUID()}`;
		const path = join(canonicalParent, candidateChild);
		const quarantine = simpleQuarantinePath(nonce);
		const oldDate = new Date(Date.now() - 26 * 60 * 60 * 1000);
		mkdirSync(path, { mode: 0o700 });
		const marker = join(path, ".switchyard-cleanup-owner.json");
		writeFileSync(marker, JSON.stringify({ runId, nonce }), { mode: 0o600 });
		writeFileSync(join(path, "payload.txt"), "salvage", { mode: 0o600 });
		for (const entry of [marker, join(path, "payload.txt"), path])
			utimesSync(entry, oldDate, oldDate);
		const info = lstatSync(path, { bigint: true });
		try {
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "simple",
				workerPid: process.pid,
				workerNonce: randomUUID(),
				launchArgs: [],
			});
			const initial = await readRun(runId);
			await updateRun(
				runId,
				{
					state: "failed",
					cleanupState: "pending",
					worktree: {
						canonicalParent,
						candidateChild,
						path,
						state: "retained",
						reason: "provider_exit_nonzero",
						retainedAt: oldDate.toISOString(),
						device: info.dev.toString(),
						inode: info.ino.toString(),
						nonce,
						writerStopped: true,
					},
				},
				initial.revision,
			);
			const lines = [];
			const progress = [];
			const originalLog = console.log;
			const originalError = console.error;
			const priorExit = process.exitCode;
			try {
				console.log = (line) => lines.push(line);
				console.error = (line) => progress.push(line);
				await handleRecover(["--run", runId, "--state-root", stateRoot]);
			} finally {
				console.log = originalLog;
				console.error = originalError;
				process.exitCode = priorExit;
			}
			ok(progress.some((line) => line.includes("cleanup_scan_started")));
			ok(progress.some((line) => line.includes("cleanup_remove_started")));
			const result = JSON.parse(lines.at(-1));
			strictEqual(result.worktreesReclaimed, 1);
			strictEqual(result.disposition, "reclaimed");
			strictEqual((await readRun(runId)).worktree.state, "removed");
			strictEqual(existsSync(path), false);
			strictEqual(existsSync(quarantine), false);
		} finally {
			if (existsSync(path)) rmSync(path, { recursive: true, force: true });
			if (existsSync(quarantine))
				rmSync(quarantine, { recursive: true, force: true });
		}
	});
	it("recover --help prints usage and exits 0", () => {
		const result = runDispatch(["recover", "--help"]);
		strictEqual(result.status, 0);
		ok(result.stdout.includes("recover"));
	});
	it("recover with --run flag parses correctly", () => {
		const parsed = parseRecoverArgs(["--run", "test-run"]);
		strictEqual(parsed.runId, "test-run");
	});
	it("recover --run reports simple worktree dispositions without VM inventory", async () => {
		const retained = await createSimpleWorktreeRun();
		const removed = await createSimpleWorktreeRun({
			worktreeState: "removed",
			rootKind: "missing",
		});
		const missing = await createSimpleWorktreeRun({
			worktreeState: "active",
			rootKind: "missing",
		});
		const ambiguous = await createSimpleWorktreeRun({ rootKind: "symlink" });

		for (const [fixture, disposition, reason, expectedPath, topDisposition] of [
			[
				retained,
				"retained",
				"identity_unavailable",
				retained.worktreePath,
				"preserved",
			],
			[
				removed,
				"removed",
				"worktree_removed",
				removed.worktreePath,
				"no_candidates",
			],
			[
				missing,
				"missing",
				"worktree_missing",
				missing.worktreePath,
				"no_candidates",
			],
			[
				ambiguous,
				"ambiguous",
				"worktree_identity_ambiguous",
				null,
				"preserved",
			],
		]) {
			const result = runDispatch(
				["recover", "--run", fixture.runId, "--state-root", stateRoot],
				makeStateRootEnv(),
			);
			strictEqual(result.status, 0, result.stderr);
			const envelope = JSON.parse(result.stdout.trim());
			strictEqual(envelope.disposition, topDisposition);
			const [candidate] = envelope.candidates;
			strictEqual(candidate.runId, fixture.runId);
			strictEqual(candidate.disposition, disposition);
			strictEqual(candidate.reason, reason);
			strictEqual(candidate.worktree.path, expectedPath);
			strictEqual(candidate.worktree.state, fixture.worktreeState);
			strictEqual(candidate.status, "failed");
			deepStrictEqual(envelope.errors, []);
		}

		const unavailable = await createSimpleWorktreeRun();
		const unavailableOutput = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		const inaccessible = Object.assign(new Error("fixture denial"), {
			code: "EACCES",
		});
		console.log = (line) => unavailableOutput.push(String(line));
		try {
			await handleRecover(
				["--run", unavailable.runId, "--state-root", stateRoot],
				{
					lstatSimpleWorktreePath: (path) => {
						if (path === unavailable.worktreePath) throw inaccessible;
						return lstatSync(path);
					},
				},
			);
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}
		const [candidate] = JSON.parse(unavailableOutput[0]).candidates;
		strictEqual(candidate.disposition, "unavailable");
		strictEqual(candidate.reason, "worktree_unavailable");
		strictEqual(candidate.worktree.path, null);
	});
	it("recover --run preserves running simple records and their project lock", async () => {
		const live = await createSimpleWorktreeRun({
			runState: "running",
			worktreeState: "active",
			workerPid: process.pid,
		});
		const writerUnknown = await createSimpleWorktreeRun({
			runState: "running",
			worktreeState: "active",
			workerPid: 999999,
		});
		const ambiguousLive = await createSimpleWorktreeRun({
			runState: "running",
			worktreeState: "active",
			rootKind: "symlink",
			workerPid: process.pid,
		});
		await acquireProjectLock(projectDir, writerUnknown.runId);

		for (const [fixture, disposition, reason] of [
			[live, "preserved", "writer_stop_unconfirmed"],
			[writerUnknown, "preserved", "writer_stop_unconfirmed"],
			[ambiguousLive, "ambiguous", "worktree_identity_ambiguous"],
		]) {
			const result = runDispatch(
				["recover", "--run", fixture.runId, "--state-root", stateRoot],
				makeStateRootEnv(),
			);
			strictEqual(result.status, 0, result.stderr);
			const [candidate] = JSON.parse(result.stdout.trim()).candidates;
			strictEqual(candidate.disposition, disposition);
			strictEqual(candidate.reason, reason);
			strictEqual(candidate.status, "running");
			strictEqual(
				candidate.worktree.path,
				fixture === ambiguousLive ? null : fixture.worktreePath,
			);
			strictEqual(
				candidate.runLiveness,
				fixture === writerUnknown ? "dead" : "live",
			);
			strictEqual((await readRun(fixture.runId)).state, "running");
		}
		strictEqual(
			await isProjectLockOwnedBy(projectDir, writerUnknown.runId),
			true,
		);
	});
	it("targeted simple recovery skips VM inventory, allocation audit, and lock cleanup", async () => {
		const fixture = await createSimpleWorktreeRun({
			runState: "running",
			worktreeState: "active",
			workerPid: 999999,
		});
		await acquireProjectLock(projectDir, fixture.runId);
		const calls = { inventory: 0, audit: 0, lockCleanup: 0 };
		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", fixture.runId, "--state-root", stateRoot], {
				listManaged: () => {
					calls.inventory += 1;
					return [];
				},
				auditAllocationIntents: () => {
					calls.audit += 1;
					return [];
				},
				releaseProjectLockIfOwnedBy: async () => {
					calls.lockCleanup += 1;
					return false;
				},
				releaseOrphanedProjectLocks: async () => {
					calls.lockCleanup += 1;
					return [];
				},
				reconcileProjectLockClaims: async () => {
					calls.lockCleanup += 1;
					return [];
				},
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}
		deepStrictEqual(calls, { inventory: 0, audit: 0, lockCleanup: 0 });
		strictEqual(
			JSON.parse(output[0]).candidates[0].reason,
			"writer_stop_unconfirmed",
		);
		strictEqual((await readRun(fixture.runId)).state, "running");
		strictEqual(await isProjectLockOwnedBy(projectDir, fixture.runId), true);
	});
	it("simple records without a worktree return no candidate when VM inventory is unavailable", async () => {
		const fixture = await createSimpleWorktreeRun({
			runState: "running",
			worktreeState: null,
			rootKind: "none",
			workerPid: 999999,
		});
		const calls = { inventory: 0, audit: 0, lockCleanup: 0 };
		const output = [];
		const originalLog = console.log;
		const previousExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", fixture.runId, "--state-root", stateRoot], {
				listManaged: () => {
					calls.inventory += 1;
					throw new Error("VM inventory unavailable");
				},
				auditAllocationIntents: () => {
					calls.audit += 1;
					throw new Error("VM allocation audit unavailable");
				},
				releaseProjectLockIfOwnedBy: async () => {
					calls.lockCleanup += 1;
					return false;
				},
				releaseOrphanedProjectLocks: async () => {
					calls.lockCleanup += 1;
					return [];
				},
				reconcileProjectLockClaims: async () => {
					calls.lockCleanup += 1;
					return [];
				},
			});
		} finally {
			console.log = originalLog;
			process.exitCode = previousExitCode;
		}
		const envelope = JSON.parse(output[0]);
		strictEqual(envelope.disposition, "no_candidates");
		deepStrictEqual(envelope.candidates, []);
		deepStrictEqual(envelope.allocationIntents, []);
		deepStrictEqual(envelope.errors, []);
		deepStrictEqual(calls, { inventory: 0, audit: 0, lockCleanup: 0 });
		const current = await readRun(fixture.runId);
		strictEqual(current.state, "running");
		strictEqual(current.worktree, null);
	});
	it("recover without --help runs and exits (Parallels may not be available)", () => {
		const result = runDispatch(["recover"]);
		ok(
			result.status === 0 || result.status === 1,
			`unexpected exit code: ${result.status}`,
		);
		const output = JSON.parse(result.stdout.trim());
		ok(typeof output.vmsReclaimed === "number");
		ok(Array.isArray(output.errors));
		ok(Array.isArray(output.candidates) || output.candidates === null);
	});
});
