import { ok, rejects, strictEqual } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
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
	releaseOrphanedProjectLocks,
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

	it("persists an identity-bound v2 run while retaining the v1 reader", async () => {
		const opts = makeOptions({
			projectRevision: "rev-1",
			queueIdentity: "a".repeat(64),
			runOptions: {
				version: 1,
				maxTasks: 2,
				checkpointPath: "/tmp/checkpoint.json",
				stopOnFailure: true,
				onlyProviders: ["claude"],
				excludeProviders: [],
				taskIds: ["task-1"],
			},
		});
		const snapshot = await initializeRun(opts);
		strictEqual(snapshot.schemaVersion, 2);
		strictEqual(snapshot.projectRevision, "rev-1");
		strictEqual(snapshot.queueIdentity, "a".repeat(64));
		strictEqual((await readRun(opts.runId)).schemaVersion, 2);

		const legacy = makeOptions({ runId: uniqueRunId() });
		const legacySnapshot = await initializeRun(legacy);
		strictEqual(legacySnapshot.schemaVersion, 1);
		strictEqual((await readRun(legacy.runId)).schemaVersion, 1);
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

		strictEqual(parsed.schemaVersion, 1);
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

		const result = await applyRetention({ maxRuns: 2 });
		strictEqual(result.deletedCount, 3);

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

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 1);

		const r = await readRun(nonTerminal.runId);
		strictEqual(r.state, "failed");
	});

	it("leaves cleanup-failed runs alone", async () => {
		const run = await createTerminalRun("cf");
		await updateRun(run.runId, { cleanupState: "failed" }, run.revision);

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 0);
	});

	it("deletes runs older than maxAgeDays", async () => {
		await createTerminalRun("old");

		const result = await applyRetention({
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});
		strictEqual(result.deletedCount, 1);
	});

	it("dryRun reports maxAgeDays-eligible runs without deleting them", async () => {
		const run = await createTerminalRun("dry-age");

		const result = await applyRetention({
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
			dryRun: true,
		});
		// Same count as the non-dryRun call above, but nothing was removed.
		strictEqual(result.deletedCount, 1);

		const r = await readRun(run.runId);
		strictEqual(r.state, "succeeded");
	});

	it("dryRun reports maxRuns-eligible runs without deleting them", async () => {
		const runs = [];
		for (let i = 0; i < 3; i++) {
			runs.push(await createTerminalRun(`dry-runs-${i}`));
		}

		const result = await applyRetention({ maxRuns: 1, dryRun: true });
		strictEqual(result.deletedCount, 2);

		for (const run of runs) {
			const r = await readRun(run.runId);
			strictEqual(r.state, "succeeded");
		}
	});

	it("deletes nothing when no retention limits set", async () => {
		await createTerminalRun("keep");
		const result = await applyRetention({});
		strictEqual(result.deletedCount, 0);
	});

	it("returns 0 when runs directory does not exist", async () => {
		const result = await applyRetention({ maxRuns: 1 });
		strictEqual(result.deletedCount, 0);
	});

	function writeMalformedRun(runId, rawContent) {
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), rawContent, "utf8");
		return runDir;
	}

	it("quarantines a run with invalid JSON using a safe, static reason", async () => {
		const runId = `quarantine-badjson-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "not valid json at all {{{");

		const result = await applyRetention({});
		strictEqual(result.deletedCount, 0);
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, runId);
		strictEqual(result.quarantined[0].reason, "run.json contains invalid JSON");
		ok(!result.quarantined[0].reason.includes("{{{"));

		strictEqual(existsSync(join(getStateRoot(), "runs", runId)), false);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId, "run.json")),
			true,
		);
		await rejects(readRun(runId), /Run not found/);
	});

	it("quarantines a run with an unsupported schemaVersion, surfacing SchemaError's static message", async () => {
		const runId = `quarantine-schema-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, JSON.stringify({ schemaVersion: 99, runId }));

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, runId);
		strictEqual(
			result.quarantined[0].reason,
			"Unsupported schemaVersion (expected 1 or 2)",
		);
	});

	it("dryRun suppresses deletion of eligible runs but still quarantines malformed ones", async () => {
		const malformedRunId = `quarantine-dry-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(malformedRunId, "{ this is not json");
		const goodRun = await createTerminalRun("dry-keep");

		const result = await applyRetention({
			maxRuns: 0,
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
			dryRun: true,
		});
		// dryRun only suppresses the DELETION of eligible valid runs — the
		// protective quarantine move must still happen, or a malformed record
		// would fail this same scan forever under a dry-run-only dispatch.
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, malformedRunId);
		strictEqual(
			existsSync(join(getStateRoot(), "runs", malformedRunId)),
			false,
			"the malformed run must leave the active scan even under dryRun",
		);
		strictEqual(
			existsSync(
				join(getStateRoot(), ".quarantine", malformedRunId, "run.json"),
			),
			true,
			"the malformed run must be moved into quarantine even under dryRun",
		);
		// ...while the eligible valid run is only reported, never deleted.
		strictEqual(result.deletedCount, 1);
		const r = await readRun(goodRun.runId);
		strictEqual(r.state, "succeeded");
	});

	it("quarantining a malformed run does not affect valid records in the same sweep", async () => {
		const badRunId = `quarantine-mixed-bad-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(badRunId, "garbage");
		const goodRun = await createTerminalRun("mixed-good");

		const result = await applyRetention({ maxRuns: 0 });
		strictEqual(result.deletedCount, 1);
		strictEqual(result.quarantined.length, 1);
		strictEqual(result.quarantined[0].runId, badRunId);

		await rejects(readRun(goodRun.runId), /Run not found/);
		await rejects(readRun(badRunId), /Run not found/);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", badRunId, "run.json")),
			true,
		);
	});

	it("does not quarantine a run directory whose run.json is absent (ENOENT)", async () => {
		const runId = `quarantine-nojson-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		// No run.json at all. This is the transient-missing signal a
		// concurrent initializeRun mid-flight produces (the window between
		// ensureDir and the atomic run.json write), which is indistinguishable
		// from a genuinely malformed record on this signal — so the
		// conservative choice is to leave the directory in place for a later
		// sweep rather than quarantine a legitimate run's directory.

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 0);
		strictEqual(
			existsSync(runDir),
			true,
			"a directory without run.json must be left in the active scan",
		);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId)),
			false,
			"a directory without run.json must not be quarantined",
		);
	});

	it("preserves a pre-existing quarantine artifact instead of overwriting it", async () => {
		const runId = `quarantine-collide-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "garbage");

		// Pre-seed `.quarantine/<runId>` with an existing artifact that must
		// survive the sweep untouched — the collision the move must never
		// overwrite or replace.
		const existingQuarantine = join(getStateRoot(), ".quarantine", runId);
		mkdirSync(existingQuarantine, { recursive: true });
		writeFileSync(
			join(existingQuarantine, "pre-existing.txt"),
			"keep me",
			"utf8",
		);

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		strictEqual(entry.runId, runId);
		ok(
			entry.destination !== existingQuarantine,
			"a suffixed destination must be used on collision",
		);
		ok(
			entry.destination.startsWith(existingQuarantine),
			"the suffixed destination stays under .quarantine/<runId>",
		);
		strictEqual(
			existsSync(join(existingQuarantine, "pre-existing.txt")),
			true,
			"the pre-existing quarantine artifact must survive untouched",
		);
		strictEqual(
			existsSync(join(entry.destination, "run.json")),
			true,
			"the newly quarantined run must be preserved alongside the existing artifact",
		);
		strictEqual(
			existsSync(join(getStateRoot(), "runs", runId)),
			false,
			"the malformed run must leave the active scan",
		);
	});

	it("skips a run whose run.json is unreadable (EACCES) instead of quarantining it", {
		skip:
			process.platform === "win32" || process.getuid?.() === 0
				? "permissions not applicable on Windows or when running as root (uid 0 can still read mode-000 files)"
				: false,
	}, async () => {
		const runId = `quarantine-eacces-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "garbage {{{", "utf8");
		// chmod 000 makes readFile throw EACCES before JSON.parse can run, so
		// this read fails with a filesystem/IO error, NOT a SchemaError — the
		// non-SchemaError branch must skip, never quarantine. (The garbage
		// content is irrelevant; it is never reached.)
		chmodSync(join(runDir, "run.json"), 0o000);

		try {
			const result = await applyRetention({});
			strictEqual(result.quarantined.length, 0);
			strictEqual(
				existsSync(runDir),
				true,
				"an unreadable run.json is not a positive corruption signal; the directory must be left in the active scan",
			);
			strictEqual(
				existsSync(join(getStateRoot(), ".quarantine", runId)),
				false,
				"an unreadable run.json must not be quarantined",
			);
		} finally {
			// Restore permissions so the temp tree cleans up cleanly.
			chmodSync(join(runDir, "run.json"), 0o600);
		}
	});

	it("skips a run whose run.json is a directory (EISDIR) instead of quarantining it", async () => {
		const runId = `quarantine-eisdir-${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", runId);
		mkdirSync(runDir, { recursive: true });
		// readFile on a directory throws EISDIR — a non-SchemaError
		// filesystem/IO error that must be skipped conservatively, never
		// quarantined.
		mkdirSync(join(runDir, "run.json"));

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 0);
		strictEqual(
			existsSync(runDir),
			true,
			"a directory-shaped run.json must be left in the active scan, not quarantined",
		);
		strictEqual(
			existsSync(join(getStateRoot(), ".quarantine", runId)),
			false,
			"a directory-shaped run.json must not be quarantined",
		);
	});

	it("returns the raw on-disk destination and a separately sanitized destinationDisplay for bidi/zero-width names", async () => {
		const name = `quarantine-bidi-\u202e\u200b\u200e${uniqueRunId().slice(0, 8)}`;
		const runDir = join(getStateRoot(), "runs", name);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "garbage", "utf8");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];

		// The raw on-disk destination is preserved verbatim for machine use.
		const expectedDestination = join(getStateRoot(), ".quarantine", name);
		strictEqual(entry.destination, expectedDestination);
		strictEqual(existsSync(entry.destination), true);

		// The display variant is sanitized: no control, format, or separator
		// characters may survive.
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.destinationDisplay),
			"destinationDisplay must never carry control, format, or separator characters",
		);
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.runId),
			"runId metadata must never carry control, format, or separator characters",
		);
		ok(
			entry.destinationDisplay !== entry.destination,
			"destinationDisplay must differ from the raw destination when the name needs sanitization",
		);
		strictEqual(
			existsSync(runDir),
			false,
			"the bidi/zero-width-named run must still leave the active scan",
		);
	});

	it("returns destinationDisplay identical to the raw destination when no sanitization is needed", async () => {
		const runId = `quarantine-plain-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(runId, "garbage");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		strictEqual(entry.destination, join(getStateRoot(), ".quarantine", runId));
		strictEqual(entry.destinationDisplay, entry.destination);
	});

	it("sanitizes control and format characters in directory names from quarantine metadata", async () => {
		const runId = `quarantine-ctrl-${uniqueRunId().slice(0, 8)}\nINJECT`;
		writeMalformedRun(runId, "garbage");

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, 1);
		const entry = result.quarantined[0];
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.runId),
			"returned runId metadata must never carry control or format characters",
		);
		ok(
			!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.destinationDisplay),
			"returned destinationDisplay metadata must never carry control or format characters",
		);
		// The raw destination is the verbatim on-disk path, control
		// characters and all, so machine callers can still act on it.
		strictEqual(entry.destination, join(getStateRoot(), ".quarantine", runId));
		strictEqual(existsSync(entry.destination), true);
		// The raw directory was still moved out of the active scan, control
		// characters and all.
		strictEqual(existsSync(join(getStateRoot(), "runs", runId)), false);
	});

	it("a repeated sweep is idempotent: nothing left to quarantine or delete", async () => {
		const badRunId = `quarantine-repeat-${uniqueRunId().slice(0, 8)}`;
		writeMalformedRun(badRunId, "garbage");
		await createTerminalRun("repeat-good");

		const first = await applyRetention({ maxRuns: 0 });
		strictEqual(first.quarantined.length, 1);
		strictEqual(first.deletedCount, 1);

		const second = await applyRetention({ maxRuns: 0 });
		strictEqual(
			second.quarantined.length,
			0,
			"already-quarantined runs are not re-reported on a repeated sweep",
		);
		strictEqual(
			second.deletedCount,
			0,
			"already-deleted runs are not re-reported on a repeated sweep",
		);
	});

	it("classifies each malformed category with a static, sanitized reason", async () => {
		const cases = [
			{
				name: `q-invalid-json-${uniqueRunId().slice(0, 8)}`,
				content: "not json {{",
				reason: "run.json contains invalid JSON",
			},
			{
				name: `q-non-object-${uniqueRunId().slice(0, 8)}`,
				content: "null",
				reason: "run.json is not a valid object",
			},
			{
				name: `q-bad-schema-${uniqueRunId().slice(0, 8)}`,
				content: JSON.stringify({ schemaVersion: 99 }),
				reason: "Unsupported schemaVersion (expected 1 or 2)",
			},
			{
				name: `q-missing-field-${uniqueRunId().slice(0, 8)}`,
				content: JSON.stringify({ schemaVersion: 1 }),
				reason: "runId must be a string",
			},
			{
				name: `dir name with spaces-${uniqueRunId().slice(0, 8)}`,
				content: "ignored",
				reason: "Invalid runId",
			},
		];
		for (const c of cases) writeMalformedRun(c.name, c.content);

		const result = await applyRetention({});
		strictEqual(result.quarantined.length, cases.length);
		const byId = new Map(result.quarantined.map((e) => [e.runId, e]));
		for (const c of cases) {
			ok(byId.has(c.name), `expected ${c.name} to be quarantined`);
			strictEqual(byId.get(c.name).reason, c.reason);
			ok(
				!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(byId.get(c.name).reason),
				"a quarantined reason must never carry control or format characters",
			);
		}
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

describe("validateRun type checks for telemetry fields", () => {
	it("rejects a non-number activeTaskStartedAt", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		await rejects(
			updateRun(
				opts.runId,
				{ activeTaskStartedAt: "not-a-number" },
				snapshot.revision,
			),
			SchemaError,
		);
	});

	it("rejects a non-number lastCompletionAt", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		await rejects(
			updateRun(
				opts.runId,
				{ lastCompletionAt: "not-a-number" },
				snapshot.revision,
			),
			SchemaError,
		);
	});

	it("rejects a non-string workingContainerName", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		await rejects(
			updateRun(opts.runId, { workingContainerName: 12345 }, snapshot.revision),
			SchemaError,
		);
	});

	it("accepts activeTaskStartedAt, lastCompletionAt, and workingContainerName when absent, null, or correctly typed", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);

		// Absent: initializeRun doesn't set these fields at all.
		strictEqual(snapshot.activeTaskStartedAt, undefined);
		strictEqual(snapshot.lastCompletionAt, undefined);
		strictEqual(snapshot.workingContainerName, undefined);

		// Explicit null.
		const nulled = await updateRun(
			opts.runId,
			{
				activeTaskStartedAt: null,
				lastCompletionAt: null,
				workingContainerName: null,
			},
			snapshot.revision,
		);
		strictEqual(nulled.activeTaskStartedAt, null);
		strictEqual(nulled.lastCompletionAt, null);
		strictEqual(nulled.workingContainerName, null);

		// Correctly typed values.
		const typed = await updateRun(
			opts.runId,
			{
				activeTaskStartedAt: 1000,
				lastCompletionAt: 2000,
				workingContainerName: "container-abc",
			},
			nulled.revision,
		);
		strictEqual(typed.activeTaskStartedAt, 1000);
		strictEqual(typed.lastCompletionAt, 2000);
		strictEqual(typed.workingContainerName, "container-abc");
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
