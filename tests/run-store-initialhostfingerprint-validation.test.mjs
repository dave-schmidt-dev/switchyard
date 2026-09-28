import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import {
	createEvent,
	getRunRoot,
	initializeRun,
	readEvents,
	readRun,
	reconcileEventSequence,
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
	it("accepts retry projection metadata and rejects unsafe shapes", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const projection = {
			quarantinedTargetIds: ["agy-gemini"],
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
			},
			retryTransitionId: 2,
		};

		const updated = await updateRun(opts.runId, projection, snapshot.revision);
		strictEqual(updated.retryTransitionId, 2);
		deepStrictEqual(updated.quarantinedTargetIds, ["agy-gemini"]);

		await rejects(
			updateRun(
				opts.runId,
				{ retryState: { taskId: "1.1", attempt: 3, phase: "bad" } },
				updated.revision,
			),
			SchemaError,
		);
		await rejects(
			updateRun(
				opts.runId,
				{ quarantinedTargetIds: ["bad\u0000target"] },
				updated.revision,
			),
			SchemaError,
		);
	});

	it("accepts static lastFailure metadata and rejects raw fields", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const safeFailure = {
			errorKind: "execution_failed",
			reasonCode: "execution_failed",
			reason: "Provider execution failed before a reviewed integration.",
			artifactRef: "artifact:0123456789abcdef01234567",
		};

		const updated = await updateRun(
			opts.runId,
			{ lastFailure: safeFailure },
			snapshot.revision,
		);
		strictEqual(updated.lastFailure.reasonCode, "execution_failed");

		await rejects(
			updateRun(
				opts.runId,
				{
					lastFailure: {
						...safeFailure,
						output: "SECRET_CANARY_provider_output",
					},
				},
				updated.revision,
			),
			SchemaError,
		);
	});

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

	it("accepts independent lifecycle timestamps and rejects unsafe shapes", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const finishedAt = new Date().toISOString();
		const terminal = await updateRun(
			opts.runId,
			{ state: "failed", finishedAt },
			snapshot.revision,
		);
		strictEqual(terminal.startedAt, null);
		strictEqual(terminal.finishedAt, finishedAt);

		await rejects(
			updateRun(opts.runId, { finishedAt: 12345 }, terminal.revision),
			SchemaError,
		);
	});

	it("rejects unrecognized telemetry write-failure labels", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		await rejects(
			updateRun(
				opts.runId,
				{ lastTelemetryWriteFailure: "/private/path/SECRET" },
				snapshot.revision,
			),
			SchemaError,
		);
		const valid = await updateRun(
			opts.runId,
			{ lastTelemetryWriteFailure: "revision_conflict" },
			snapshot.revision,
		);
		strictEqual(valid.lastTelemetryWriteFailure, "revision_conflict");
	});
});
describe("descriptor receipt harness binding", () => {
	it("rejects forged Claude provenance and accepts the enabled Agy Sonnet target", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		// Empty argv is valid for both harnesses, so this identity is deliberately
		// recomputed for Claude. The rejection below must therefore come from the
		// current roster's antigravity -> agy target provenance, not a hash mismatch.
		const forgedClaudeDescriptor = validateInvocationDescriptor(
			{
				target_id: "antigravity",
				model_ref: "google/fixture",
				selector: "fixture-gemini",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"claude",
		);

		await rejects(
			updateRun(
				opts.runId,
				{
					resolvedTargetId: "antigravity",
					activeTaskInvocationDescriptor: forgedClaudeDescriptor,
					activeTaskDescriptorIdentity:
						forgedClaudeDescriptor.descriptor_identity,
					activeTaskDescriptorHarness: "claude",
				},
				snapshot.revision,
			),
			SchemaError,
		);

		const descriptor = validateInvocationDescriptor(
			{
				target_id: "antigravity-claude",
				model_ref: "google/fixture",
				selector: "fixture-gemini",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"agy",
		);
		const accepted = await updateRun(
			opts.runId,
			{
				resolvedTargetId: "antigravity-claude",
				activeTaskInvocationDescriptor: descriptor,
				activeTaskDescriptorIdentity: descriptor.descriptor_identity,
				activeTaskDescriptorHarness: "agy",
			},
			snapshot.revision,
		);
		strictEqual(accepted.activeTaskDescriptorHarness, "agy");
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

	it("allocates unique sequences for concurrent appends and reconciles a torn ceiling", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const sequences = await Promise.all(
			Array.from({ length: 40 }, (_, index) =>
				createEvent(opts.runId, {
					phase: "execution",
					event: `concurrent_${index}`,
					status: "ok",
				}),
			),
		);
		deepStrictEqual(
			[...sequences].sort((a, b) => a - b),
			Array.from({ length: 40 }, (_, index) => index + 1),
		);

		const run = await readRun(opts.runId);
		writeFileSync(
			join(getRunRoot(opts.runId), "run.json"),
			JSON.stringify({ ...run, lastEventSequence: 39 }),
			{ mode: 0o600 },
		);
		await rejects(readEvents(opts.runId), /ceiling is unresolved/);
		const repair = await reconcileEventSequence(opts.runId);
		strictEqual(repair.repaired, true);
		strictEqual((await readRun(opts.runId)).lastEventSequence, 40);
	});

	it("rejects a sequence gap and a persisted minimum reader above this binary", async () => {
		const opts = makeOptions();
		const run = await initializeRun(opts);
		writeFileSync(
			join(getRunRoot(opts.runId), "events.jsonl"),
			`${JSON.stringify({ schemaVersion: 1, sequence: 2, timestamp: new Date().toISOString(), phase: "execution", event: "task_started", status: "ok" })}\n`,
			{ mode: 0o600 },
		);
		await rejects(reconcileEventSequence(opts.runId), /sequence gap/);
		writeFileSync(
			join(getRunRoot(opts.runId), "run.json"),
			JSON.stringify({ ...run, minimumOutcomeReaderVersion: 2 }),
			{ mode: 0o600 },
		);
		await rejects(readRun(opts.runId), /minimum outcome reader version/);
	});
});
