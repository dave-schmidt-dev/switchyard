import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	appendOutcomeEvent,
	createStageOutcome,
	getRunRoot,
	initializeRun,
	projectOutcomeReader,
	readEvents,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import { TEST_ROOT, VM_ADMISSION_ROOT } from "./helpers/run-store-fixtures.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;

// Owner decision O4 (2026-10-18): the reducer shadow and its reader cutover
// are retired; the legacy projection is the only outcome reader. The fixture
// is a complete matching shadow written by the retired writer, which used to
// switch a run with typed events to the reducer reader.
const HISTORICAL_MATCHED_SHADOW = JSON.parse(
	readFileSync(
		resolve("tests/fixtures/historical-outcome-shadow-match.json"),
		"utf8",
	),
);
const LEGACY_KEYS = [
	"projectionVersion",
	"reader",
	"historical",
	"runId",
	"finalStatus",
	"legacyState",
	"typedEventCount",
	"primaryFailure",
	"terminalSummary",
	"legacyEventCount",
];

function failedArtifact(runId, writerEpoch) {
	return createStageOutcome({
		runId,
		taskId: "1.1",
		attemptId: "attempt-1",
		stage: "artifact",
		status: "failed",
		producer: "runner",
		code: "artifact_capture",
		detail: { artifactKind: "diff", captured: false },
		...(writerEpoch ? { writerEpoch } : {}),
	});
}

function newRun(runId) {
	return initializeRun({
		runId,
		tasksFilePath: "/tmp/tasks.md",
		projectPath: "/tmp/project",
		orderedTaskIds: ["1.1"],
		initialHostFingerprint: "fixture",
		workerNonce: randomUUID(),
	});
}

describe("legacy outcome projection", () => {
	it("persists no shadow on a new run, an outcome append, or a terminal update", async () => {
		const runId = `legacy-only-${randomUUID()}`;
		const initial = await newRun(runId);
		strictEqual(Object.hasOwn(initial, "outcomeShadow"), false);
		const active = await updateRun(
			runId,
			{ outcomeWriterEpoch: "epoch-legacy-only" },
			initial.revision,
		);
		await appendOutcomeEvent(
			runId,
			failedArtifact(runId, active.outcomeWriterEpoch),
			{ writerEpoch: active.outcomeWriterEpoch },
		);
		const appended = await readRun(runId);
		strictEqual(Object.hasOwn(appended, "outcomeShadow"), false);
		await updateRun(
			runId,
			{
				state: "failed",
				cleanupState: "complete",
				terminalSummary: { processedTasks: 1 },
			},
			appended.revision,
		);
		const terminal = await readRun(runId);
		strictEqual(Object.hasOwn(terminal, "outcomeShadow"), false);
		deepStrictEqual(Object.keys(terminal.outcomeProjection), LEGACY_KEYS);
		deepStrictEqual(terminal.outcomeProjection, {
			projectionVersion: 0,
			reader: "legacy",
			historical: true,
			runId,
			finalStatus: "failed",
			legacyState: "failed",
			typedEventCount: 0,
			primaryFailure: terminal.lastFailure,
			terminalSummary: { processedTasks: 1 },
			legacyEventCount: 1,
		});
	});

	it("never lets a historical matching shadow select the reducer", () => {
		const runId = HISTORICAL_MATCHED_SHADOW.projection.runId;
		const run = {
			runId,
			state: "failed",
			cleanupState: "complete",
			lastFailure: { errorKind: "artifact_capture" },
			terminalSummary: { processedTasks: 1 },
			outcomeShadow: structuredClone(HISTORICAL_MATCHED_SHADOW),
		};
		const projection = projectOutcomeReader({
			run,
			events: [failedArtifact(runId)],
		});
		ok(Object.isFrozen(projection));
		deepStrictEqual(Object.keys(projection), LEGACY_KEYS);
		deepStrictEqual(
			{ ...projection },
			{
				projectionVersion: 0,
				reader: "legacy",
				historical: true,
				runId,
				finalStatus: "failed",
				legacyState: "failed",
				typedEventCount: 0,
				primaryFailure: { errorKind: "artifact_capture" },
				terminalSummary: { processedTasks: 1 },
				legacyEventCount: 1,
			},
		);
		deepStrictEqual(run.outcomeShadow, HISTORICAL_MATCHED_SHADOW);
		throws(() => projectOutcomeReader({ run, events: null }), TypeError);
	});

	it("reads and updates a historical run.json that still carries a shadow", async () => {
		const runId = `historical-shadow-${randomUUID()}`;
		await newRun(runId);
		const runJsonPath = join(getRunRoot(runId), "run.json");
		const stored = JSON.parse(readFileSync(runJsonPath, "utf8"));
		stored.outcomeShadow = structuredClone(HISTORICAL_MATCHED_SHADOW);
		writeFileSync(runJsonPath, `${JSON.stringify(stored)}\n`);
		const historical = await readRun(runId);
		deepStrictEqual(historical.outcomeShadow, HISTORICAL_MATCHED_SHADOW);
		const terminal = await updateRun(
			runId,
			{ state: "succeeded", cleanupState: "complete" },
			historical.revision,
		);
		// Carried as inert history: nothing recomputes or reads it any more.
		deepStrictEqual(terminal.outcomeShadow, HISTORICAL_MATCHED_SHADOW);
		strictEqual(terminal.outcomeProjection.reader, "legacy");
		strictEqual(terminal.outcomeProjection.finalStatus, "succeeded");
	});
});
describe("typed stage append boundary", () => {
	it("keeps retry and causality identities distinct", () => {
		const base = {
			runId: "stage-identity",
			taskId: "1.1",
			stage: "artifact",
			status: "succeeded",
			producer: "runner",
			code: "artifact_capture",
			detail: { artifactKind: "diff", captured: true },
			writerEpoch: "epoch-stage-identity",
		};
		const first = createStageOutcome({
			...base,
			attempt: 1,
			attemptId: "attempt-primary",
			causedBy: "process-primary",
		});
		const retry = createStageOutcome({
			...base,
			attempt: 2,
			attemptId: "attempt-retry",
			causedBy: "process-retry",
		});
		notStrictEqual(first.outcomeId, retry.outcomeId);
		notStrictEqual(first.operationId, retry.operationId);
	});

	it("accepts the provider fact required beside non-provider production stages", async () => {
		const runId = `provider-stage-${randomUUID()}`;
		const initial = await initializeRun({
			runId,
			tasksFilePath: "/tmp/tasks.md",
			projectPath: "/tmp/project",
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "fixture",
			workerNonce: randomUUID(),
		});
		const active = await updateRun(
			runId,
			{ outcomeWriterEpoch: "epoch-provider-stage" },
			initial.revision,
		);
		const providerFact = {
			schemaVersion: 1,
			minimumReaderVersion: 1,
			writerEpoch: active.outcomeWriterEpoch,
			outcomeId: `provider-${randomUUID()}`,
			sequence: 1,
			runId,
			scope: "task",
			taskId: "1.1",
			attemptId: "attempt-1",
			resumesOutcomeId: null,
			stage: "provider",
			legacyPhase: null,
			legacyEvent: null,
			dispatchCausality: `sha256:${"a".repeat(64)}`,
			attempt: 1,
			recordedAt: new Date().toISOString(),
			producer: "provider-lifecycle",
			causedBy: null,
			operationId: "operation-provider-stage",
			status: "succeeded",
			detail: {
				code: "process_completed",
				servedModelVerified: true,
				targetId: "fixture-target",
			},
		};
		await appendOutcomeEvent(runId, providerFact, {
			writerEpoch: active.outcomeWriterEpoch,
		});
		const [persisted] = await readEvents(runId);
		strictEqual(persisted.stage, "provider");
		strictEqual(persisted.detail.code, "process_completed");
		strictEqual(Object.hasOwn(await readRun(runId), "outcomeShadow"), false);
	});

	it("assigns one sequenced typed fact per stage and preserves causality", async () => {
		const runId = `stage-${randomUUID()}`;
		const initial = await initializeRun({
			runId,
			tasksFilePath: "/tmp/tasks.md",
			projectPath: "/tmp/project",
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "fixture",
			workerNonce: randomUUID(),
		});
		const active = await updateRun(
			runId,
			{ outcomeWriterEpoch: "epoch-stage" },
			initial.revision,
		);
		const processOutcomeId = `outcome-process-${randomUUID()}`;
		const stage = createStageOutcome({
			runId,
			taskId: "1.1",
			stage: "integration",
			status: "succeeded",
			producer: "runner",
			code: "integration_gate",
			detail: { gateCode: "success", accepted: true },
			writerEpoch: active.outcomeWriterEpoch,
			causedBy: processOutcomeId,
		});
		const sequence = await appendOutcomeEvent(runId, stage, {
			writerEpoch: active.outcomeWriterEpoch,
		});
		strictEqual(sequence, 1);
		const [persisted] = await readEvents(runId);
		strictEqual(persisted.stage, "integration");
		strictEqual(persisted.detail.accepted, true);
		strictEqual(persisted.causedBy, processOutcomeId);
		strictEqual(persisted.minimumReaderVersion, 1);
	});
});
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
