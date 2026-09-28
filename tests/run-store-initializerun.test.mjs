import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	advanceState,
	createFencingIdentity,
	getRunRoot,
	initializeRun,
	RevisionError,
	readMutationOperation,
	readRun,
	recordMutationOperation,
	SchemaError,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	TEST_ROOT,
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
describe("initializeRun", () => {
	it("persists and replays one bounded mutation operation by operationId", async () => {
		const runId = `mutation-record-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: join(TEST_ROOT, "tasks.md"),
			projectPath: TEST_ROOT,
			orderedTaskIds: [],
			initialHostFingerprint: "test-host",
		});
		const operation = {
			version: 1,
			operationId: "operation-lock-release",
			operation: "project_lock_release",
			resource: "lock-project-a",
			state: "intent",
			outcome: "unknown",
			attempt: 0,
			maxAttempts: 2,
			idempotency: "conditional",
			recordedAt: new Date().toISOString(),
		};
		await recordMutationOperation(runId, operation);
		const replay = await readMutationOperation(runId, operation.operationId);
		deepStrictEqual(replay, operation);
	});
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
		strictEqual(snapshot.startedAt, null);
		strictEqual(snapshot.finishedAt, null);
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
		strictEqual(snapshot.lastFailure, null);
		strictEqual(snapshot.resolvedTargetId, null);
		deepStrictEqual(snapshot.quarantinedTargetIds, []);
		strictEqual(snapshot.retryState, null);
		strictEqual(snapshot.retryTransitionId, 0);
		strictEqual(snapshot.snapshotStatus, null);
		strictEqual(snapshot.snapshotMtime, null);
		strictEqual(snapshot.snapshotAgeMsAtRoute, null);
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
		const legacyPath = join(getRunRoot(legacy.runId), "run.json");
		const legacyOnDisk = JSON.parse(readFileSync(legacyPath, "utf8"));
		delete legacyOnDisk.startedAt;
		delete legacyOnDisk.finishedAt;
		writeFileSync(legacyPath, JSON.stringify(legacyOnDisk));
		const legacyLoaded = await readRun(legacy.runId);
		strictEqual(legacyLoaded.schemaVersion, 1);
		strictEqual(legacyLoaded.startedAt, undefined);
		strictEqual(legacyLoaded.finishedAt, undefined);
	});

	it("creates the run directory but not an empty artifacts subdirectory", async () => {
		// artifacts/ has had no writer since the partial-diff copy was removed
		// for INV-2, so provisioning one left an empty directory behind on every
		// single run -- 81 of them in the consuming project by 2026-09-04. Both
		// readers treat absence as ordinary; a producer would create its own.
		const opts = makeOptions();
		await initializeRun(opts);
		const runDir = getRunRoot(opts.runId);
		ok(existsSync(runDir));
		ok(!existsSync(join(runDir, "artifacts")));
	});

	it("fails when runId already exists", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await rejects(initializeRun(opts), /Run already exists/);
	});
});
describe("revision", () => {
	it("creates a validated fencing identity with a caller-owned nonce", () => {
		deepStrictEqual(createFencingIdentity("fenced-run", "start-1", "nonce-1"), {
			runId: "fenced-run",
			processStartIdentity: "start-1",
			nonce: "nonce-1",
		});
		throws(
			() => createFencingIdentity("../unsafe", "start", "nonce"),
			SchemaError,
		);
	});

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
		ok(typeof updated.startedAt === "string");
		strictEqual(updated.finishedAt, null);
		ok(Date.parse(updated.startedAt) >= Date.parse(updated.createdAt));
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
