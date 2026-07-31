import { ok, rejects, strictEqual } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	acquireLaunchLock,
	acquireProjectLock,
	acquireRunLock,
	advanceState,
	applyRetention,
	createEvent,
	getRunRoot,
	getStateRoot,
	initializeRun,
	isProjectLockHeld,
	isRunLockExpired,
	LockError,
	RevisionError,
	readRun,
	releaseLaunchLock,
	releaseProjectLock,
	releaseRunLock,
	renewRunLock,
	SchemaError,
	updateRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "switchyard-run-store-"));

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");

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
	} catch {
		// no-op
	}
});

function uniqueRunId() {
	return randomUUID();
}

function uniquePath(label) {
	return join(TEST_ROOT, `path-${label || uniqueRunId()}`);
}

// Mirrors the private lockFilePath() hashing scheme in run-store/index.mjs
// so tests can read a lock file's raw JSON body directly.
function projectLockFilePath(canonicalProjectPath) {
	const resolvedPath = resolve(`project:${canonicalProjectPath}`);
	const hash = createHash("sha256").update(resolvedPath).digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
}

function makeOptions(overrides = {}) {
	return {
		runId: uniqueRunId(),
		tasksFilePath: uniquePath("tasks"),
		projectPath: uniquePath("project"),
		orderedTaskIds: ["task-1", "task-2", "task-3"],
		initialHostFingerprint: { git: "abc123", worktree: "clean" },
		launchArgs: ["--provider", "claude"],
		...overrides,
	};
}

describe("getStateRoot", () => {
	it("returns an absolute path ending in .logs/switchyard by default", () => {
		const saved = process.env.SWITCHYARD_RUN_STORE_ROOT;
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		try {
			const root = getStateRoot();
			strictEqual(resolve(root), root);
			ok(
				root.endsWith(`${sep}.logs${sep}switchyard`),
				`${root} should end with .logs/switchyard, got ${root}`,
			);
		} finally {
			if (saved) process.env.SWITCHYARD_RUN_STORE_ROOT = saved;
		}
	});

	it("returns the env override path when SWITCHYARD_RUN_STORE_ROOT is set", () => {
		const root = getStateRoot();
		strictEqual(resolve(root), root);
		ok(
			root.endsWith(`${sep}store`),
			`${root} should end with store (the env override)`,
		);
	});
});

describe("initializeRun", () => {
	it("creates run.json with state created and all required fields", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		strictEqual(snapshot.schemaVersion, 1);
		strictEqual(snapshot.runId, opts.runId);
		strictEqual(snapshot.state, "created");
		strictEqual(snapshot.cleanupState, "not_started");
		strictEqual(snapshot.revision, 1);
		strictEqual(typeof snapshot.createdAt, "string");
		strictEqual(typeof snapshot.updatedAt, "string");
		strictEqual(snapshot.tasksFilePath, opts.tasksFilePath);
		strictEqual(snapshot.projectPath, opts.projectPath);
		ok(Array.isArray(snapshot.orderedTaskIds));
		strictEqual(snapshot.orderedTaskIds.length, 3);
		ok(typeof snapshot.initialHostFingerprint === "object");
		strictEqual(snapshot.workerPid, null);
		strictEqual(snapshot.workerStartToken, null);
		strictEqual(snapshot.workerNonce, "");
		strictEqual(snapshot.activeTaskId, null);
		strictEqual(snapshot.terminalSummary, null);
		strictEqual(snapshot.cleanupError, null);
		strictEqual(typeof snapshot.lastLeaseHeartbeat, "string");
		ok(Array.isArray(snapshot.launchArgs));
		strictEqual(snapshot.launchArgs[0], "--provider");
	});

	it("readRun returns the same data written to disk", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const loaded = await readRun(opts.runId);

		strictEqual(loaded.runId, opts.runId);
		strictEqual(loaded.state, "created");
		strictEqual(loaded.revision, 1);
	});

	it("creates run directory and artifacts subdirectory", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const runDir = getRunRoot(opts.runId);
		const artifactsDir = join(runDir, "artifacts");
		ok(existsSync(runDir));
		ok(existsSync(artifactsDir));
	});

	it("fails when runId already exists", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await rejects(initializeRun(opts), /Run already exists/);
	});
});

describe("revision", () => {
	it("throws RevisionError when expectedRevision does not match", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await rejects(
			updateRun(opts.runId, { state: "launching" }, 999),
			RevisionError,
		);
	});

	it("succeeds and increments revision on correct expectedRevision", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const updated = await updateRun(opts.runId, { state: "launching" }, 1);
		strictEqual(updated.revision, 2);
		strictEqual(updated.state, "launching");
	});

	it("advanceState reads current revision and increments", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const updated = await advanceState(opts.runId, "running");
		strictEqual(updated.revision, 2);
		strictEqual(updated.state, "running");
	});

	it("rapid consecutive updates each increment revision", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const a = await updateRun(opts.runId, { state: "launching" }, 1);
		const b = await updateRun(opts.runId, { state: "running" }, 2);
		const c = await updateRun(opts.runId, { state: "succeeded" }, 3);

		strictEqual(a.revision, 2);
		strictEqual(b.revision, 3);
		strictEqual(c.revision, 4);
	});

	it("prevents stale concurrent writes via revision mismatch", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const current = await readRun(opts.runId);

		await advanceState(opts.runId, "launching");

		await rejects(
			updateRun(opts.runId, { state: "running" }, current.revision),
			RevisionError,
		);
	});
});

describe("event ordering", () => {
	it("assigns monotonically increasing sequence numbers", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const s1 = await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "task_started",
			status: "ok",
		});
		const s2 = await createEvent(opts.runId, {
			phase: "execution",
			event: "task_completed",
			status: "ok",
		});
		const s3 = await createEvent(opts.runId, {
			phase: "cleanup",
			event: "cleanup_started",
			status: "ok",
		});

		strictEqual(s1, 1);
		strictEqual(s2, 2);
		strictEqual(s3, 3);
	});

	it("includes extra context fields in the event entry", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_started",
			status: "ok",
			taskId: "task-1",
			provider: "claude",
			model: "sonnet",
		});

		const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(eventsPath, "utf8");
		const parsed = JSON.parse(content.trim().split("\n")[0]);

		strictEqual(parsed.sequence, 1);
		strictEqual(parsed.taskId, "task-1");
		strictEqual(parsed.provider, "claude");
		strictEqual(parsed.model, "sonnet");
	});
});

describe("corruption", () => {
	it("throws SchemaError when run.json contains invalid JSON", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "not json {{{");

		await rejects(readRun(runId), SchemaError);
	});

	it("throws SchemaError when schemaVersion is wrong", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({
				schemaVersion: 99,
				runId,
				state: "created",
				cleanupState: "not_started",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: [],
				initialHostFingerprint: {},
				workerNonce: "",
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
			}),
		);

		await rejects(readRun(runId), SchemaError);
	});

	it("throws SchemaError when required fields are missing", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({ schemaVersion: 1 }),
		);

		await rejects(readRun(runId), SchemaError);
	});

	it("throws Error when run does not exist", async () => {
		await rejects(readRun("nonexistent-run-id"), /Run not found/);
	});
});

describe("permissions", () => {
	it("run.json and events.jsonl have mode 0600", {
		skip:
			process.platform === "win32"
				? "permissions not applicable on Windows"
				: false,
	}, async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "task_started",
			status: "ok",
		});

		const runDir = getRunRoot(opts.runId);
		const runJsonStat = await stat(join(runDir, "run.json"));
		const eventsStat = await stat(join(runDir, "events.jsonl"));

		const runPerm = runJsonStat.mode & 0o777;
		const eventsPerm = eventsStat.mode & 0o777;

		strictEqual(runPerm, 0o600, "run.json should be 0600");
		strictEqual(eventsPerm, 0o600, "events.jsonl should be 0600");
	});
});

describe("retention", () => {
	async function createTerminalRun(idSuffix, overrides = {}) {
		const opts = makeOptions({
			runId: `retention-${idSuffix}-${uniqueRunId().slice(0, 8)}`,
		});
		await initializeRun(opts);

		let run = await advanceState(opts.runId, "succeeded");
		run = await updateRun(
			opts.runId,
			{ cleanupState: "complete", ...overrides },
			run.revision,
		);
		return run;
	}

	it("deletes eligible completed runs respecting maxRuns", async () => {
		const runs = [];
		for (let i = 0; i < 5; i++) {
			runs.push(await createTerminalRun(i));
		}

		const deleted = await applyRetention({ maxRuns: 2 });
		strictEqual(deleted, 3);

		for (let i = 0; i < 3; i++) {
			await rejects(readRun(runs[i].runId), /Run not found/);
		}
		for (let i = 3; i < 5; i++) {
			const r = await readRun(runs[i].runId);
			strictEqual(r.state, "succeeded");
		}
	});

	it("leaves non-terminal runs alone", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const nonTerminal = await updateRun(
			opts.runId,
			{ state: "failed", cleanupState: "not_started" },
			1,
		);

		await createTerminalRun("ok");

		const deleted = await applyRetention({ maxRuns: 0 });
		strictEqual(deleted, 1);

		const r = await readRun(nonTerminal.runId);
		strictEqual(r.state, "failed");
	});

	it("leaves cleanup-failed runs alone", async () => {
		const run = await createTerminalRun("cf");
		await updateRun(run.runId, { cleanupState: "failed" }, run.revision);

		const deleted = await applyRetention({ maxRuns: 0 });
		strictEqual(deleted, 0);
	});

	it("deletes runs older than maxAgeDays", async () => {
		await createTerminalRun("old");

		const deleted = await applyRetention({
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});
		strictEqual(deleted, 1);
	});

	it("deletes nothing when no retention limits set", async () => {
		await createTerminalRun("keep");
		const deleted = await applyRetention({});
		strictEqual(deleted, 0);
	});

	it("returns 0 when runs directory does not exist", async () => {
		const deleted = await applyRetention({ maxRuns: 1 });
		strictEqual(deleted, 0);
	});
});

describe("launch lock", () => {
	it("two acquires on different paths succeed for different runIds", async () => {
		const path1 = uniquePath("tasks-a");
		const path2 = uniquePath("tasks-b");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireLaunchLock(path1, runId1);
		await acquireLaunchLock(path2, runId2);

		ok(true);
	});

	it("two acquires on the same path fails", async () => {
		const path = uniquePath("tasks");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireLaunchLock(path, runId1);
		await rejects(acquireLaunchLock(path, runId2), LockError);
	});

	it("release then re-acquire with a different runId succeeds", async () => {
		const path = uniquePath("tasks");
		const runId1 = uniqueRunId();

		await acquireLaunchLock(path, runId1);
		await releaseLaunchLock(path);
		await acquireLaunchLock(path, uniqueRunId());
		ok(true);
	});

	it("release on non-existent lock does not throw", async () => {
		await releaseLaunchLock(uniquePath("nonexistent"));
		ok(true);
	});
});

describe("project lock", () => {
	it("two acquires on different project paths succeed", async () => {
		const path1 = uniquePath("proj-a");
		const path2 = uniquePath("proj-b");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireProjectLock(path1, runId1);
		await acquireProjectLock(path2, runId2);

		ok(true);
	});

	it("two acquires on the same project path fails", async () => {
		const path = uniquePath("project");
		const runId1 = uniqueRunId();
		const runId2 = uniqueRunId();

		await acquireProjectLock(path, runId1);
		await rejects(acquireProjectLock(path, runId2), LockError);
	});

	it("isProjectLockHeld reflects lock state", async () => {
		const path = uniquePath("project");
		strictEqual(isProjectLockHeld(path), false);

		await acquireProjectLock(path, uniqueRunId());
		strictEqual(isProjectLockHeld(path), true);

		await releaseProjectLock(path);
		strictEqual(isProjectLockHeld(path), false);
	});

	it("release then re-acquire with a different runId succeeds", async () => {
		const path = uniquePath("project");
		await acquireProjectLock(path, uniqueRunId());
		await releaseProjectLock(path);
		await acquireProjectLock(path, uniqueRunId());
		ok(true);
	});

	it("release on non-existent lock does not throw", async () => {
		await releaseProjectLock(uniquePath("nonexistent"));
		ok(true);
	});

	it("lock body includes projectPath alongside runId and createdAt", async () => {
		const path = uniquePath("project");
		const runId = uniqueRunId();

		await acquireProjectLock(path, runId);

		const raw = await readFile(projectLockFilePath(path), "utf8");
		const body = JSON.parse(raw);
		strictEqual(body.projectPath, path);
		strictEqual(body.runId, runId);
		ok(typeof body.createdAt === "string");
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

describe("initialHostFingerprint validation", () => {
	it("rejects null initialHostFingerprint", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId,
				state: "created",
				cleanupState: "not_started",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: [],
				initialHostFingerprint: null,
				workerNonce: "",
				lastLeaseHeartbeat: new Date().toISOString(),
				lastEventSequence: 0,
			}),
		);

		await rejects(readRun(runId), SchemaError);
	});
});

describe("protected fields in updateRun", () => {
	it("does not allow overwriting runId", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		const updated = await updateRun(
			opts.runId,
			{ runId: "hacked-id", state: "launching" },
			snapshot.revision,
		);

		strictEqual(updated.runId, opts.runId);
		strictEqual(updated.state, "launching");
	});

	it("does not allow overwriting schemaVersion", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		const updated = await updateRun(
			opts.runId,
			{ schemaVersion: 99 },
			snapshot.revision,
		);

		strictEqual(updated.schemaVersion, 1);
	});

	it("does not allow overwriting createdAt", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		const updated = await updateRun(
			opts.runId,
			{ createdAt: "2000-01-01T00:00:00.000Z" },
			snapshot.revision,
		);

		strictEqual(updated.createdAt, snapshot.createdAt);
	});
});

describe("lastEventSequence tracking", () => {
	it("tracks sequence in run.json after createEvent", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		strictEqual(snapshot.lastEventSequence, 0);

		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "task_started",
			status: "ok",
		});

		const run = await readRun(opts.runId);
		strictEqual(run.lastEventSequence, 1);
	});

	it("increments lastEventSequence across multiple events", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "event_1",
			status: "ok",
		});
		await createEvent(opts.runId, {
			phase: "execution",
			event: "event_2",
			status: "ok",
		});
		await createEvent(opts.runId, {
			phase: "cleanup",
			event: "event_3",
			status: "ok",
		});

		const run = await readRun(opts.runId);
		strictEqual(run.lastEventSequence, 3);
	});

	it("createEvent fails validation when lastEventSequence is missing", async () => {
		const runId = uniqueRunId();
		const runDir = getRunRoot(runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId,
				state: "created",
				cleanupState: "not_started",
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				orderedTaskIds: [],
				initialHostFingerprint: {},
				workerNonce: "",
				lastLeaseHeartbeat: new Date().toISOString(),
			}),
		);

		await rejects(
			createEvent(runId, {
				phase: "bootstrap",
				event: "test",
				status: "ok",
			}),
			SchemaError,
		);
	});
});

describe("lock file path resolution", () => {
	it("acquireLaunchLock resolves relative paths to the same lock", async () => {
		const path1 = uniquePath("tasks");
		const runId = uniqueRunId();
		await acquireLaunchLock(path1, runId);

		const relPath = relative(process.cwd(), path1);
		await rejects(acquireLaunchLock(relPath, uniqueRunId()), LockError);
	});
});

describe("concurrent atomic writes", () => {
	it("concurrent updateRun/createEvent never throw ENOENT and leave a valid run.json", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Fire many writers concurrently at the same run.json. With a fixed,
		// shared tmp path (the bug), roughly half of these collide on rename:
		// one writer renames the shared tmp away before another's rename runs,
		// so the loser throws ENOENT. A unique tmp path per write eliminates
		// the collision — each writer's rename only touches its own tmp file.
		const N = 40;
		const ops = [];
		for (let i = 0; i < N; i++) {
			if (i % 2 === 0) {
				ops.push(
					updateRun(runId, { activeTaskId: `task-${i}` }, base.revision),
				);
			} else {
				ops.push(
					createEvent(runId, {
						phase: "execution",
						event: `evt-${i}`,
						status: "ok",
					}),
				);
			}
		}
		const settled = await Promise.allSettled(ops);

		const enoent = settled.filter(
			(r) => r.status === "rejected" && r.reason?.code === "ENOENT",
		);
		strictEqual(
			enoent.length,
			0,
			`no writer should fail with ENOENT, got ${enoent.length}`,
		);

		// run.json must remain valid and parseable; readRun validates the schema.
		const final = await readRun(runId);
		strictEqual(final.runId, runId);
		ok(
			final.revision > base.revision,
			`revision should advance past ${base.revision}, got ${final.revision}`,
		);
	});

	it("serializes racing updateRun calls on the same expectedRevision instead of clobbering", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Simulate worker-bootstrap's fire-and-forget callbacks (onTaskStart,
		// onResult) racing the main thread's terminal write: every caller reads
		// the same starting revision before any of them has written. Without
		// serialization, all of these can pass the optimistic-concurrency check
		// and last-rename-wins silently discards every write but the last —
		// with no error thrown, and no guarantee the terminal write survives.
		const N = 10;
		const settled = await Promise.allSettled(
			Array.from({ length: N }, (_, i) =>
				updateRun(runId, { activeTaskId: `task-${i}` }, base.revision),
			),
		);

		const succeeded = settled.filter((r) => r.status === "fulfilled");
		const revisionErrors = settled.filter(
			(r) => r.status === "rejected" && r.reason instanceof RevisionError,
		);
		strictEqual(
			succeeded.length,
			1,
			`exactly one racing updateRun should win, got ${succeeded.length}`,
		);
		strictEqual(
			revisionErrors.length,
			N - 1,
			`the other ${N - 1} should lose with RevisionError, got ${revisionErrors.length}`,
		);

		const final = await readRun(runId);
		strictEqual(final.revision, base.revision + 1);
		strictEqual(final.activeTaskId, succeeded[0].value.activeTaskId);
	});

	it("updateRunWithRetry's authoritative write survives a losing race against a stale-revision writer", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Mirror worker-bootstrap: a fire-and-forget callback (e.g. onResult)
		// captured the starting revision before the terminal write began, so
		// it races updateRunWithRetry using that now-stale expectedRevision.
		// Whichever of these actually reaches the update queue first, the
		// authoritative write must still land with its real payload — it must
		// never be discarded by losing the race.
		const floatingWrite = updateRun(
			runId,
			{ activeTaskId: "floating-task" },
			base.revision,
		);
		const authoritativeWrite = updateRunWithRetry(runId, {
			state: "failed",
			activeTaskId: null,
			cleanupState: "complete",
			terminalSummary: { totalTasks: 2, processedTasks: 1, failedCount: 1 },
		});

		const authoritative = await authoritativeWrite;
		await floatingWrite.catch(() => {});

		strictEqual(authoritative.state, "failed");
		strictEqual(authoritative.cleanupState, "complete");
		strictEqual(authoritative.terminalSummary.failedCount, 1);

		const final = await readRun(runId);
		strictEqual(final.state, "failed");
		strictEqual(final.cleanupState, "complete");
		strictEqual(
			final.terminalSummary.failedCount,
			1,
			"the real terminal summary must win, not be lost to the floating writer",
		);
	});

	it("two concurrent updateRunWithRetry callers touching different fields both survive", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		// Mirrors worker-bootstrap's onTaskStart and onTaskRouted: routing is
		// synchronous and fires microseconds after task-start, so both
		// callbacks can read the same base revision and race for the same
		// per-runId update queue slot. Before onTaskStart/onTaskRouted/onResult
		// were switched to updateRunWithRetry, this shape (two fixed-revision
		// updateRun calls) would silently drop one caller's write via
		// RevisionError — the specific regression this fix addresses.
		const [a, b] = await Promise.all([
			updateRunWithRetry(runId, { activeTaskId: "task-1" }),
			updateRunWithRetry(runId, {
				activeTaskProvider: "claude",
				activeTaskModel: "claude-sonnet-5",
			}),
		]);
		ok(a && b, "both concurrent updateRunWithRetry calls should resolve");

		const final = await readRun(runId);
		strictEqual(final.activeTaskId, "task-1");
		strictEqual(final.activeTaskProvider, "claude");
		strictEqual(final.activeTaskModel, "claude-sonnet-5");
	});
});

describe("lastCompletionAt (worker-bootstrap onResult conditional field)", () => {
	// Mirrors worker-bootstrap's onResult callback, which adds lastCompletionAt
	// via a conditional spread — `...(r.success ? { lastCompletionAt: Date.now() } : {})`
	// — rather than a bare field. A failed task's patch must never carry the
	// key at all, so it can neither introduce nor null out lastCompletionAt.
	function completionPatch(success, now) {
		return {
			activeTaskId: null,
			activeTaskProvider: null,
			activeTaskModel: null,
			activeTaskDeadline: null,
			...(success ? { lastCompletionAt: now } : {}),
		};
	}

	it("stays absent (not null, not set) after a task_failed outcome on a fresh run", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		const final = await updateRunWithRetry(runId, completionPatch(false, 1234));

		ok(
			!Object.hasOwn(final, "lastCompletionAt"),
			"a failed task's patch must never introduce lastCompletionAt",
		);
		strictEqual(final.lastCompletionAt, undefined);
	});

	it("leaves an existing lastCompletionAt untouched (not nulled) when a later task fails", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		const afterSuccess = await updateRunWithRetry(
			runId,
			completionPatch(true, 111222),
		);
		strictEqual(afterSuccess.lastCompletionAt, 111222);

		const afterFailure = await updateRunWithRetry(
			runId,
			completionPatch(false, 333444),
		);

		strictEqual(
			afterFailure.lastCompletionAt,
			111222,
			"a failed task must not overwrite or null out the prior completion timestamp",
		);
	});
});
