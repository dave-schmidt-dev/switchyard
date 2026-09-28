import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	acquireLaunchLock,
	acquireProjectLock,
	acquireRunLock,
	advanceState,
	getStateRoot,
	initializeRun,
	isProjectLockHeld,
	isRunLockExpired,
	LockError,
	readRun,
	releaseOrphanedProjectLocks,
	releaseRunLock,
	renewRunLock,
	SchemaError,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	TEST_ROOT,
	uniquePath,
	uniqueRunId,
	VM_ADMISSION_ROOT,
} from "./helpers/run-store-fixtures.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
process.env.SWITCHYARD_ROSTER_PATH = resolve(
	"tests/fixtures/roster.fixture.json",
);
after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
afterEach(() => {
	try {
		rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
		rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("releaseOrphanedProjectLocks", () => {
	it("returns an empty array when the locks directory does not exist", async () => {
		const reclaimed = await releaseOrphanedProjectLocks();
		strictEqual(reclaimed.length, 0);
	});

	it("leaves a live run's lock untouched alongside an orphaned lock it reclaims", async () => {
		// Live run: non-terminal state, worker pid points at this very test
		// process, which is provably alive.
		const liveOpts = makeOptions({ projectPath: uniquePath("live-project") });
		await initializeRun(liveOpts);
		await advanceState(liveOpts.runId, "running");
		const liveCurrent = await readRun(liveOpts.runId);
		await updateRun(
			liveOpts.runId,
			{ workerPid: process.pid },
			liveCurrent.revision,
		);
		await acquireProjectLock(liveOpts.projectPath, liveOpts.runId);

		// Orphaned run sitting alongside it: terminal state, lock never
		// released (the residue a crashed worker leaves behind).
		const deadOpts = makeOptions({ projectPath: uniquePath("dead-project") });
		await initializeRun(deadOpts);
		await advanceState(deadOpts.runId, "failed");
		const deadCurrent = await readRun(deadOpts.runId);
		await updateRun(
			deadOpts.runId,
			{ cleanupState: "complete" },
			deadCurrent.revision,
		);
		await acquireProjectLock(deadOpts.projectPath, deadOpts.runId);

		const reclaimed = await releaseOrphanedProjectLocks();

		ok(
			reclaimed.includes(deadOpts.runId),
			"the orphaned run's lock should be reclaimed",
		);
		ok(
			!reclaimed.includes(liveOpts.runId),
			"the live run's id must not appear in the reclaimed list",
		);
		strictEqual(
			isProjectLockHeld(liveOpts.projectPath),
			true,
			"a live run's lock must never be touched by the scan",
		);
		strictEqual(
			isProjectLockHeld(deadOpts.projectPath),
			false,
			"the orphaned lock should have been reclaimed",
		);
	});

	it("reclaims a lock whose worker is still 'running' but the pid is dead", async () => {
		// Non-terminal state with a dead worker pid: exactly what a
		// hard-crashed worker (process.exit before any terminal write)
		// leaves behind. Covered by the isWorkerLive branch, not the
		// terminal-state branch, of the shared staleness check.
		const opts = makeOptions();
		await initializeRun(opts);
		await advanceState(opts.runId, "running");
		const current = await readRun(opts.runId);
		await updateRun(opts.runId, { workerPid: 999999 }, current.revision);
		await acquireProjectLock(opts.projectPath, opts.runId);

		const reclaimed = await releaseOrphanedProjectLocks();

		ok(reclaimed.includes(opts.runId));
		strictEqual(isProjectLockHeld(opts.projectPath), false);
	});

	it("never reclaims a lock with an unparseable body, regardless of age", async () => {
		const locksDir = join(getStateRoot(), "locks");
		mkdirSync(locksDir, { recursive: true });
		const corruptLockPath = join(locksDir, "corrupt-test.lock");
		writeFileSync(corruptLockPath, "not json {{{");

		const reclaimed = await releaseOrphanedProjectLocks();

		strictEqual(reclaimed.length, 0);
		ok(
			existsSync(corruptLockPath),
			"a lock with an unparseable body must be left on disk untouched",
		);
	});

	it("never reclaims a launch lock (parseable body, no projectPath)", async () => {
		// A launch lock predates F.1's projectPath addition: {runId,
		// createdAt} only. This is the permanent, correct shape for launch
		// locks — not a migration gap — so the scan must leave it alone.
		const tasksPath = uniquePath("tasks");
		const launchRunId = uniqueRunId();
		await acquireLaunchLock(tasksPath, launchRunId);

		const reclaimed = await releaseOrphanedProjectLocks();

		strictEqual(reclaimed.length, 0);
		// Black-box check that the launch lock file is still present: a
		// second acquire on the same tasks path must still collide.
		await rejects(acquireLaunchLock(tasksPath, uniqueRunId()), LockError);
	});

	it("never reclaims a lock whose runId has no run.json at all", async () => {
		// A parseable, projectPath-bearing lock whose run was never
		// initialized (or whose run directory is gone entirely) is a
		// strictly weaker signal than a resolvable-but-dead run: the scan
		// can observe the run record is gone but cannot prove the lock's
		// original holder is actually dead. Per CR-4/CR-5 this resolves to
		// "cannot identify, leave alone" — same posture as an unparseable
		// body or a launch lock. Deferred to F.3's human-confirmed manual
		// remediation, not something this scan should reclaim on its own.
		const path = uniquePath("project");
		const ghostRunId = uniqueRunId();
		await acquireProjectLock(path, ghostRunId);

		const reclaimed = await releaseOrphanedProjectLocks();

		ok(!reclaimed.includes(ghostRunId));
		strictEqual(isProjectLockHeld(path), true);
	});

	it("retains a lock whose project path disagrees with its run record", async () => {
		const opts = makeOptions({
			projectPath: uniquePath("orphan-owner-project"),
		});
		await initializeRun(opts);
		await advanceState(opts.runId, "failed");
		await updateRun(
			opts.runId,
			{ cleanupState: "complete" },
			(await readRun(opts.runId)).revision,
		);
		const mismatchedProjectPath = uniquePath("orphan-mismatched-project");
		const mismatchedLockPath = join(
			getStateRoot(),
			"locks",
			`${createHash("sha256").update(uniqueRunId()).digest("hex")}.lock`,
		);
		const lockRaw = JSON.stringify({
			runId: opts.runId,
			projectPath: mismatchedProjectPath,
			createdAt: new Date().toISOString(),
		});
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(mismatchedLockPath, lockRaw);

		deepStrictEqual(await releaseOrphanedProjectLocks(), []);
		strictEqual(readFileSync(mismatchedLockPath, "utf8"), lockRaw);
	});

	it("does not release a lock already reassigned to a newer active run on the same project", async () => {
		// Mirrors dispatch's releaseProjectLockIfOwnedBy ownership guard: a
		// stale run's own lock file was already superseded by a different,
		// currently-active run against the same project path. The scan must
		// never pull that active run's lock out from under it.
		const projectPath = uniquePath("project");

		const staleOpts = makeOptions({ projectPath });
		await initializeRun(staleOpts);
		await advanceState(staleOpts.runId, "failed");
		// staleRunId's own lock was already released elsewhere; only the
		// active run below currently holds project lock for this path.

		const activeOpts = makeOptions({ projectPath });
		await initializeRun(activeOpts);
		await advanceState(activeOpts.runId, "running");
		const activeCurrent = await readRun(activeOpts.runId);
		await updateRun(
			activeOpts.runId,
			{ workerPid: process.pid },
			activeCurrent.revision,
		);
		await acquireProjectLock(projectPath, activeOpts.runId);

		const reclaimed = await releaseOrphanedProjectLocks();

		ok(!reclaimed.includes(activeOpts.runId));
		strictEqual(
			isProjectLockHeld(projectPath),
			true,
			"the active run's lock must survive even though a stale run once used the same project path",
		);
	});
});
describe("lease", () => {
	it("acquire -> renew -> release round-trip", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const pid = 12345;
		const token = "start-token-abc";
		const nonce = "nonce-xyz";

		const acquired = await acquireRunLock(opts.runId, pid, token, nonce);
		strictEqual(acquired.workerPid, pid);
		strictEqual(acquired.workerStartToken, token);
		strictEqual(acquired.workerNonce, nonce);

		const renewed = await renewRunLock(opts.runId, pid, token);
		ok(
			new Date(renewed.lastLeaseHeartbeat).getTime() >=
				new Date(acquired.lastLeaseHeartbeat).getTime(),
		);

		const released = await releaseRunLock(opts.runId);
		strictEqual(released.workerPid, null);
		strictEqual(released.workerStartToken, null);
		strictEqual(released.workerNonce, "");
	});

	it("stale lease is recognized as expired", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 34567, "token-1", "nonce-1");

		const expired = await isRunLockExpired(opts.runId, {
			maxAgeMs: 0,
			now: new Date(Date.now() + 120_000).toISOString(),
		});
		strictEqual(expired, true);
	});

	it("wrong identity fails renew", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token-a", "nonce");
		await rejects(renewRunLock(opts.runId, 99999, "token-a"), LockError);
		await rejects(renewRunLock(opts.runId, 12345, "token-b"), LockError);
	});

	it("wrong identity fails acquire when lease is active", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token-a", "nonce-a");
		await rejects(
			acquireRunLock(opts.runId, 99999, "token-b", "nonce-b"),
			LockError,
		);
	});

	it("acquire with allowRecovery succeeds on expired lease", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token-a", "nonce-a");

		const acquired = await acquireRunLock(
			opts.runId,
			99999,
			"token-b",
			"nonce-b",
			{
				allowRecovery: true,
				maxAgeMs: 0,
				now: new Date(Date.now() + 120_000).toISOString(),
			},
		);

		strictEqual(acquired.workerPid, 99999);
		strictEqual(acquired.workerStartToken, "token-b");
	});

	it("acquire with allowRecovery fails on non-expired lease", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token-a", "nonce-a");

		await rejects(
			acquireRunLock(opts.runId, 99999, "token-b", "nonce-b", {
				allowRecovery: true,
			}),
			LockError,
		);
	});

	it("isRunLockExpired returns true when no lease is held", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const expired = await isRunLockExpired(opts.runId);
		strictEqual(expired, true);
	});
});
describe("nonce handshake", () => {
	it("lease acquire includes nonce and readRun shows it", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const nonce = "handshake-nonce-42";
		await acquireRunLock(opts.runId, 12345, "token", nonce);

		const run = await readRun(opts.runId);
		strictEqual(run.workerNonce, nonce);
	});

	it("release clears nonce", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await acquireRunLock(opts.runId, 12345, "token", "nonce-1");
		await releaseRunLock(opts.runId);

		const run = await readRun(opts.runId);
		strictEqual(run.workerNonce, "");
	});
});
describe("runId validation", () => {
	it("rejects runId with path traversal attempts", async () => {
		await rejects(readRun("../etc/passwd"), SchemaError);
	});

	it("rejects runId with forward-slash traversal", async () => {
		await rejects(readRun("foo/../../bar"), SchemaError);
	});

	it("rejects runId in initializeRun with traversal", async () => {
		const opts = makeOptions({ runId: "../../etc" });
		await rejects(initializeRun(opts), SchemaError);
	});

	it("accepts valid runId characters", async () => {
		const opts = makeOptions({ runId: "valid-run_123" });
		const snapshot = await initializeRun(opts);
		strictEqual(snapshot.runId, "valid-run_123");
	});

	it("rejects runId with special characters", async () => {
		await rejects(readRun("run with spaces"), SchemaError);
	});
});
