import { rejects, strictEqual } from "node:assert";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	OUTCOME_EVENT_MAX_BYTES,
	OUTCOME_FILE_MAX_BYTES,
	OUTCOME_FILE_MAX_LINES,
} from "../src/switchyard/outcome/schema.mjs";
import {
	appendOutcomeEvent,
	applyRetention,
	getRunRoot,
	initializeRun,
	readEvents,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function typedOutcome(runId, outcomeId, writerEpoch = "epoch-1") {
	return {
		schemaVersion: 1,
		minimumReaderVersion: 1,
		writerEpoch,
		outcomeId,
		sequence: 0,
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
		recordedAt: "2026-09-09T12:00:00.000Z",
		producer: "provider-lifecycle",
		causedBy: null,
		operationId: "operation-1",
		status: "succeeded",
		detail: { servedModelVerified: true, targetId: "codex" },
	};
}

describe("reader-first outcome event floor", () => {
	it("does not activate a typed production writer", () => {
		const production = readFileSync(
			new URL("../src/switchyard/run-store/index.mjs", import.meta.url),
			"utf8",
		);
		strictEqual(production.match(/appendOutcomeEvent\s*\(/gu)?.length, 1);
		strictEqual(production.includes('stage: "provider"'), false);
	});

	it("has real limits with margin for 17-task dual-write", () => {
		const maximumDualWriteLines = 17 * 2 + 32;
		const representativeLineBytes = 2048;
		strictEqual(maximumDualWriteLines + 1 < OUTCOME_FILE_MAX_LINES, true);
		strictEqual(
			maximumDualWriteLines * representativeLineBytes +
				OUTCOME_EVENT_MAX_BYTES <
				OUTCOME_FILE_MAX_BYTES,
			true,
		);
		strictEqual(OUTCOME_FILE_MAX_BYTES, 4 * 1024 * 1024);
		strictEqual(OUTCOME_FILE_MAX_LINES, 10_000);
		strictEqual(OUTCOME_EVENT_MAX_BYTES, 32 * 1024);
	});

	it("reads and retains a typed-outcome-only fixture without activating production writes", async () => {
		const root = tempDir("switchyard-outcome-reader-");
		process.env.SWITCHYARD_RUN_STORE_ROOT = root;
		const runId = "typed-only-run";
		try {
			const run = await initializeRun({
				runId,
				tasksFilePath: "/tmp/tasks.md",
				projectPath: "/tmp/project",
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "fixture",
				workerNonce: "fixture",
			});
			const typed = {
				schemaVersion: 1,
				minimumReaderVersion: 1,
				writerEpoch: "epoch-1",
				outcomeId: "outcome-1",
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
				recordedAt: "2026-09-09T12:00:00.000Z",
				producer: "provider-lifecycle",
				causedBy: null,
				operationId: "operation-1",
				status: "succeeded",
				detail: { servedModelVerified: true, targetId: "codex" },
			};
			writeFileSync(
				join(getRunRoot(runId), "events.jsonl"),
				`${JSON.stringify(typed)}\n`,
				{ mode: 0o600 },
			);
			await updateRun(runId, { lastEventSequence: 1 }, run.revision);
			strictEqual((await readEvents(runId))[0].outcomeId, "outcome-1");
			strictEqual((await applyRetention({ maxRuns: 0 })).deletedCount, 0);
			strictEqual(existsSync(join(getRunRoot(runId), "events.jsonl")), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes exact-limit typed outcomes and one deduplicated reserved rejection fact", async () => {
		const root = tempDir("switchyard-outcome-limit-");
		process.env.SWITCHYARD_RUN_STORE_ROOT = root;
		const runId = "typed-limit-run";
		try {
			let run = await initializeRun({
				runId,
				tasksFilePath: "/tmp/tasks.md",
				projectPath: "/tmp/project",
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "fixture",
				workerNonce: "fixture",
			});
			run = await updateRun(
				runId,
				{ outcomeWriterEpoch: "epoch-1" },
				run.revision,
			);
			const exact = typedOutcome(runId, "outcome-exact");
			const items = Array.from({ length: 8 }, () => "x".repeat(3900));
			items.push("");
			exact.detail = { reviewResult: { items } };
			const assigned = { ...exact, sequence: 1 };
			const remaining =
				OUTCOME_EVENT_MAX_BYTES -
				(Buffer.byteLength(JSON.stringify(assigned), "utf8") + 1);
			items[items.length - 1] = "x".repeat(remaining);
			strictEqual(
				await appendOutcomeEvent(runId, exact, { writerEpoch: "epoch-1" }),
				1,
			);

			const over = structuredClone(exact);
			over.outcomeId = "outcome-overs";
			over.detail.reviewResult.items[
				over.detail.reviewResult.items.length - 1
			] += "x";
			const first = await appendOutcomeEvent(runId, over, {
				writerEpoch: "epoch-1",
			});
			const second = await appendOutcomeEvent(runId, over, {
				writerEpoch: "epoch-1",
			});
			strictEqual(first, 2);
			strictEqual(second, first);
			const events = await readEvents(runId);
			strictEqual(events.length, 2);
			strictEqual(events[1].detail.reasonCode, "outcome_too_large");
			strictEqual(events[1].detail.contentHash.startsWith("sha256:"), true);
			strictEqual(JSON.stringify(events[1]).includes("reviewResult"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks recovery_required when the rejection reserve is unavailable", async () => {
		const root = tempDir("switchyard-outcome-reserve-");
		process.env.SWITCHYARD_RUN_STORE_ROOT = root;
		const runId = "typed-reserve-run";
		try {
			let run = await initializeRun({
				runId,
				tasksFilePath: "/tmp/tasks.md",
				projectPath: "/tmp/project",
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "fixture",
				workerNonce: "fixture",
			});
			run = await updateRun(
				runId,
				{
					outcomeWriterEpoch: "epoch-1",
					lastEventSequence: OUTCOME_FILE_MAX_LINES,
				},
				run.revision,
			);
			const rows = Array.from({ length: OUTCOME_FILE_MAX_LINES }, (_, index) =>
				JSON.stringify({
					schemaVersion: 1,
					sequence: index + 1,
					timestamp: "2026-09-09T12:00:00.000Z",
					phase: "execution",
					event: "task_started",
					status: "ok",
				}),
			);
			writeFileSync(
				join(getRunRoot(runId), "events.jsonl"),
				`${rows.join("\n")}\n`,
				{ mode: 0o600 },
			);
			const over = typedOutcome(runId, "outcome-no-reserve");
			over.detail = {
				reviewResult: {
					items: Array.from({ length: 9 }, () => "x".repeat(4000)),
				},
			};
			await rejects(
				appendOutcomeEvent(runId, over, { writerEpoch: "epoch-1" }),
				/recovery required/,
			);
			const recovered = await readRun(runId);
			strictEqual(recovered.state, "recovery_required");
			strictEqual(recovered.outcomeRecovery.automaticRetry, false);
			strictEqual(
				recovered.outcomeRecovery.operatorCommand,
				"switchyard-dispatch recover",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
