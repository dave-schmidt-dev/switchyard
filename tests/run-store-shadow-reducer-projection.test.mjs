import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	appendOutcomeEvent,
	createStageOutcome,
	initializeRun,
	mergeOutcomeShadow,
	projectCheckpointOutcome,
	projectOutcomeReader,
	projectOutcomeShadow,
	readEvents,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import { TEST_ROOT, VM_ADMISSION_ROOT } from "./helpers/run-store-fixtures.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
describe("shadow reducer projection", () => {
	it("keeps legacy status authoritative and exposes sanitized parity", () => {
		const provider = createStageOutcome({
			runId: "shadow-projection",
			taskId: "1.1",
			attemptId: "attempt-1",
			stage: "artifact",
			status: "failed",
			producer: "runner",
			code: "execution_failed",
			detail: { artifactKind: "diff", captured: false },
		});
		const shadow = projectOutcomeShadow([provider], {
			run: {
				runId: "shadow-projection",
				state: "failed",
				cleanupState: "complete",
			},
		});
		strictEqual(shadow.version, 1);
		strictEqual(shadow.projection.finalStatus, "failed");
		strictEqual(shadow.parity.status, "match");
		strictEqual(shadow.parity.evidence, "shadow");
		strictEqual(shadow.recoveryQueue.length, 0);
		ok(!Object.hasOwn(shadow.parity, "detail"));
	});

	it("queues orphan attempts for operator recovery without retry or slot use", () => {
		const orphan = createStageOutcome({
			runId: "shadow-orphan",
			taskId: "1.1",
			attemptId: "attempt-1",
			stage: "recovery",
			status: "failed",
			producer: "recovery",
			code: "orphan_attempt",
			detail: {
				reasonCode: "orphan_attempt",
				operatorCommand: "switchyard-dispatch recover",
			},
		});
		const shadow = projectOutcomeShadow([orphan], {
			run: { runId: "shadow-orphan", state: "recovery_required" },
		});
		strictEqual(shadow.projection.finalStatus, "recovery_required");
		strictEqual(shadow.recoveryQueue.length, 1);
		strictEqual(shadow.recoveryQueue[0].automaticRetry, false);
		strictEqual(shadow.recoveryQueue[0].executionSlotConsumed, false);
		strictEqual(
			shadow.recoveryQueue[0].operatorCommand,
			"switchyard-dispatch recover",
		);
	});

	it("latches a mismatch across later matching observations", () => {
		const mismatch = projectOutcomeShadow(
			[
				createStageOutcome({
					runId: "shadow-latch",
					taskId: "1.1",
					stage: "recovery",
					status: "failed",
					producer: "recovery",
					code: "orphan_attempt",
					detail: { reasonCode: "orphan_attempt" },
				}),
			],
			{ run: { runId: "shadow-latch", state: "failed" } },
		);
		const matching = projectOutcomeShadow(
			[
				createStageOutcome({
					runId: "shadow-latch",
					taskId: "1.1",
					stage: "artifact",
					status: "failed",
					producer: "runner",
					code: "artifact_capture",
					detail: { artifactKind: "diff", captured: false },
				}),
			],
			{ run: { runId: "shadow-latch", state: "failed" } },
		);
		const latched = mergeOutcomeShadow(mismatch, matching);
		strictEqual(mismatch.parity.status, "mismatch");
		strictEqual(matching.parity.status, "match");
		strictEqual(latched.parity.status, "mismatch");
		strictEqual(latched.parity.cutoverBlocked, true);
	});

	it("refreshes parity after a terminal run-state transition", async () => {
		const runId = `shadow-terminal-${randomUUID()}`;
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
			{ outcomeWriterEpoch: "epoch-shadow-terminal" },
			initial.revision,
		);
		await appendOutcomeEvent(
			runId,
			createStageOutcome({
				runId,
				taskId: "1.1",
				stage: "artifact",
				status: "failed",
				producer: "runner",
				code: "artifact_capture",
				detail: { artifactKind: "diff", captured: false },
				writerEpoch: active.outcomeWriterEpoch,
			}),
			{ writerEpoch: active.outcomeWriterEpoch },
		);
		const before = await readRun(runId);
		strictEqual(before.outcomeShadow.parity.legacyStatus, "unknown");
		const terminal = await updateRun(
			runId,
			{
				state: "failed",
				cleanupState: "complete",
				terminalSummary: { processedTasks: 1 },
			},
			before.revision,
		);
		strictEqual(terminal.outcomeShadow.parity.legacyStatus, "failed");
		strictEqual(terminal.outcomeShadow.projection.finalStatus, "failed");
	});
});
describe("outcome reader cutover", () => {
	function failedArtifact(runId) {
		return createStageOutcome({
			runId,
			taskId: "1.1",
			attemptId: "attempt-1",
			stage: "artifact",
			status: "failed",
			producer: "runner",
			code: "artifact_capture",
			detail: { artifactKind: "diff", captured: false },
		});
	}

	it("uses the reducer only after matching shadow evidence", () => {
		const runId = "reader-cutover";
		const event = failedArtifact(runId);
		const run = {
			runId,
			state: "failed",
			cleanupState: "complete",
		};
		run.outcomeShadow = projectOutcomeShadow([event], { run });
		const projection = projectOutcomeReader({ run, events: [event] });
		strictEqual(projection.reader, "reducer");
		strictEqual(projection.finalStatus, "failed");
		strictEqual(projection.taskCounters.failed, 1);
	});

	it("reduces the exact mixed event set approved by parity", () => {
		const runId = "reader-mixed-events";
		const typed = createStageOutcome({
			runId,
			taskId: "1.1",
			attemptId: "attempt-1",
			stage: "run",
			status: "succeeded",
			producer: "runner",
			code: "task_completed",
		});
		const legacyFailure = {
			runId,
			sequence: 2,
			event: "task_failed",
			phase: "execution",
			status: "failed",
			taskId: "1.1",
		};
		const events = [typed, legacyFailure];
		const run = { runId, state: "failed", cleanupState: "complete" };
		run.outcomeShadow = projectOutcomeShadow(events, { run });
		strictEqual(run.outcomeShadow.parity.status, "match");
		const projection = projectOutcomeReader({ run, events });
		strictEqual(projection.reader, "reducer");
		strictEqual(projection.finalStatus, "failed");
	});

	it("binds persisted approval to the current event snapshot", () => {
		const runId = "reader-current-snapshot";
		const success = createStageOutcome({
			runId,
			taskId: "1.1",
			attemptId: "attempt-1",
			stage: "run",
			status: "succeeded",
			producer: "runner",
			code: "task_completed",
		});
		const run = { runId, state: "succeeded", cleanupState: "complete" };
		run.outcomeShadow = projectOutcomeShadow([success], { run });
		const newerFailure = {
			runId,
			sequence: 2,
			event: "task_failed",
			phase: "execution",
			status: "failed",
			taskId: "1.1",
		};
		strictEqual(
			projectOutcomeReader({ run, events: [success, newerFailure] }).reader,
			"legacy",
		);
	});

	it("falls back conservatively for history, mismatch, and the test rollback", () => {
		const runId = "reader-fallback";
		const event = failedArtifact(runId);
		const historical = projectOutcomeReader({
			run: { runId, state: "succeeded" },
			events: [],
		});
		strictEqual(historical.reader, "legacy");
		strictEqual(Object.hasOwn(historical, "taskCounters"), false);

		const mismatchRun = {
			runId,
			state: "succeeded",
			cleanupState: "complete",
		};
		mismatchRun.outcomeShadow = projectOutcomeShadow([event], {
			run: mismatchRun,
		});
		strictEqual(mismatchRun.outcomeShadow.parity.status, "mismatch");
		strictEqual(
			projectOutcomeReader({ run: mismatchRun, events: [event] }).reader,
			"legacy",
		);

		const matchedRun = {
			runId,
			state: "failed",
			cleanupState: "complete",
		};
		matchedRun.outcomeShadow = projectOutcomeShadow([event], {
			run: matchedRun,
		});
		const shadowSnapshot = structuredClone(matchedRun.outcomeShadow);
		strictEqual(
			projectOutcomeReader({
				run: matchedRun,
				events: [event],
				reader: "legacy",
			}).reader,
			"legacy",
		);
		deepStrictEqual(matchedRun.outcomeShadow, shadowSnapshot);
		strictEqual(
			projectOutcomeReader({
				run: { ...matchedRun, outcomeShadow: { invalid: true } },
				events: [event],
			}).reader,
			"legacy",
		);
	});

	it("reads reducer evidence retained by current checkpoints", () => {
		const run = {
			runId: "checkpoint-reader",
			state: "failed",
			cleanupState: "complete",
		};
		const event = failedArtifact(run.runId);
		const outcomeShadow = projectOutcomeShadow([event], { run });
		const captured = projectOutcomeReader({
			run: { ...run, outcomeShadow },
			events: [event],
		});
		const projection = projectCheckpointOutcome({
			outcomeShadow,
			outcomeProjection: captured,
		});
		strictEqual(projection.reader, "reducer");
		strictEqual(projection.finalStatus, "failed");
		strictEqual(
			projectCheckpointOutcome({
				outcomeProjection: { reader: "reducer", finalStatus: "succeeded" },
			}),
			null,
		);
		strictEqual(
			projectCheckpointOutcome({
				outcomeShadow: projectOutcomeShadow([], {
					run: { runId: "legacy-checkpoint", state: "created" },
				}),
				outcomeProjection: {
					reader: "reducer",
					historical: false,
					projectionVersion: 1,
					typedEventCount: 0,
				},
			}),
			null,
		);
		strictEqual(
			projectCheckpointOutcome({
				outcomeShadow: {
					version: 1,
					projection: {},
					parity: { version: 1, status: "match" },
					recoveryQueue: [],
				},
				outcomeProjection: captured,
			}),
			null,
		);
		strictEqual(projectCheckpointOutcome({ version: 2 }), null);
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
		const shadowRun = await readRun(runId);
		strictEqual(shadowRun.outcomeShadow.version, 1);
		strictEqual(shadowRun.outcomeShadow.parity.evidence, "shadow");
		strictEqual(shadowRun.outcomeShadow.projection.finalStatus, "unknown");
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
