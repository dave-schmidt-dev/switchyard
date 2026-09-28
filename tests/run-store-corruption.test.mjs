import { ok, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	acquireLaunchLock,
	createEvent,
	getRunRoot,
	initializeRun,
	LockError,
	readRun,
	releaseLaunchLock,
	SchemaError,
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
