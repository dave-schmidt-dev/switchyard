import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
	adaptLegacyOutcomeEvent,
	createOversizeRejectionFact,
	OUTCOME_EVENT_MAX_BYTES,
	OUTCOME_STAGES,
	reconstructResumeLink,
	validateOutcomeEvent,
} from "../src/switchyard/outcome/schema.mjs";

function outcome(overrides = {}) {
	return {
		schemaVersion: 1,
		minimumReaderVersion: 1,
		writerEpoch: "epoch-1",
		outcomeId: "outcome-1",
		sequence: 1,
		runId: "run-1",
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
		...overrides,
	};
}

describe("closed outcome schema", () => {
	it("reads every version-1 stage and rejects forward minimum-reader requirements", () => {
		for (const stage of OUTCOME_STAGES) {
			const event = outcome({
				stage,
				legacyPhase: stage === "legacy" ? "execution" : null,
				legacyEvent: stage === "legacy" ? "task_failed" : null,
				detail:
					stage === "legacy"
						? { originalSequence: 1, evidence: "unknown" }
						: {},
			});
			strictEqual(validateOutcomeEvent(event), event);
		}
		throws(
			() => validateOutcomeEvent(outcome({ minimumReaderVersion: 2 })),
			/minimum outcome reader/,
		);
	});

	it("enforces scope, dispatch linkage, closure, and durable-data safety", () => {
		throws(() => validateOutcomeEvent(outcome({ scope: "run" })), /run scope/);
		validateOutcomeEvent(
			outcome({ scope: "run", taskId: null, attemptId: null, attempt: 0 }),
		);
		throws(
			() =>
				validateOutcomeEvent(outcome({ dispatchCausality: "dispatch-raw" })),
			/dispatchCausality/,
		);
		throws(
			() => validateOutcomeEvent(outcome({ extra: true })),
			/extra fields/,
		);
		throws(
			() => validateOutcomeEvent(outcome({ detail: { prompt: "secret" } })),
			/not closed|forbidden/,
		);
		throws(
			() =>
				validateOutcomeEvent(
					outcome({ detail: { targetId: "/Users/private" } }),
				),
			/host path/,
		);
	});

	it("maps only closed legacy events without inventing identities", () => {
		deepStrictEqual(
			adaptLegacyOutcomeEvent(
				{
					sequence: 4,
					phase: "execution",
					event: "task_failed",
					taskId: "1.1",
				},
				"run-1",
			),
			{
				stage: "legacy",
				legacyPhase: "execution",
				legacyEvent: "task_failed",
				sequence: 4,
				runId: "run-1",
				taskId: "1.1",
				status: "failed",
				reasonCode: null,
				evidence: "unknown",
			},
		);
		throws(
			() =>
				adaptLegacyOutcomeEvent(
					{ sequence: 1, phase: "execution", event: "new_future_event" },
					"run-1",
				),
			/closed adapter/,
		);
	});

	it("creates a bounded rejection fact with only an approved reference and content hash", () => {
		const fact = createOversizeRejectionFact(
			outcome({ detail: { targetId: "x".repeat(4000) } }),
			{
				diagnosticRef: `diagnostic:${"b".repeat(32)}`,
			},
		);
		deepStrictEqual(Object.keys(fact), [
			"originalStage",
			"reasonCode",
			"contentHash",
			"diagnosticRef",
		]);
		strictEqual(
			Buffer.byteLength(JSON.stringify(fact)) < OUTCOME_EVENT_MAX_BYTES,
			true,
		);
		strictEqual(fact.reasonCode, "outcome_too_large");
		deepStrictEqual(
			createOversizeRejectionFact(outcome()),
			createOversizeRejectionFact(outcome()),
		);
	});

	it("accepts exactly the line-byte limit and rejects one byte over", () => {
		const items = Array.from({ length: 8 }, () => "x".repeat(3900));
		items.push("");
		const exact = outcome({ detail: { reviewResult: { items } } });
		const remaining =
			OUTCOME_EVENT_MAX_BYTES -
			(Buffer.byteLength(JSON.stringify(exact), "utf8") + 1);
		strictEqual(remaining > 0 && remaining <= 4096, true);
		items[items.length - 1] = "x".repeat(remaining);
		strictEqual(
			Buffer.byteLength(JSON.stringify(exact), "utf8") + 1,
			OUTCOME_EVENT_MAX_BYTES,
		);
		validateOutcomeEvent(exact);
		items[items.length - 1] += "x";
		throws(() => validateOutcomeEvent(exact), /line limit/);
	});

	it("reconstructs only a unique torn resume tuple and never retries an orphan", () => {
		const candidate = outcome({
			detail: {
				checkpointDigest: `sha256:${"c".repeat(64)}`,
				priorSequence: 7,
			},
			sequence: 7,
		});
		const tuple = {
			runId: "run-1",
			taskId: "1.1",
			attempt: 1,
			checkpointDigest: candidate.detail.checkpointDigest,
			priorSequence: 7,
		};
		deepStrictEqual(reconstructResumeLink([candidate], tuple), {
			status: "reconstructed",
			resumesOutcomeId: "outcome-1",
		});
		for (const candidates of [[], [candidate, candidate]]) {
			const result = reconstructResumeLink(candidates, tuple);
			strictEqual(result.status, "recovery_required");
			strictEqual(result.reasonCode, "orphan_attempt");
			strictEqual(result.automaticRetry, false);
		}
	});
});
