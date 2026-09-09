import { ok, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
	adaptLegacyOutcome,
	FAILURE_PRECEDENCE,
	reduceOutcomeEvents,
} from "../src/switchyard/outcome/reducer.mjs";

const RUN = "reducer-run";
const HASH = `sha256:${"a".repeat(64)}`;

function outcome({
	id,
	sequence,
	stage,
	status,
	taskId = "1.1",
	attemptId = "attempt-1",
	attempt = 1,
	operationId = `${stage}-operation`,
	detail = {},
	causedBy = null,
}) {
	return {
		schemaVersion: 1,
		minimumReaderVersion: 1,
		writerEpoch: "epoch-1",
		outcomeId: id,
		sequence,
		runId: RUN,
		scope: "task",
		taskId,
		attemptId,
		resumesOutcomeId: null,
		stage,
		legacyPhase: null,
		legacyEvent: null,
		dispatchCausality: HASH,
		attempt,
		recordedAt: `2026-09-09T12:00:${String(sequence).padStart(2, "0")}.000Z`,
		producer: stage === "provider" ? "provider-lifecycle" : "runner",
		causedBy,
		operationId,
		status,
		detail,
	};
}

describe("deterministic outcome reducer", () => {
	it("uses explicit precedence and keeps masking failures independent", () => {
		const projection = reduceOutcomeEvents([
			outcome({
				id: "artifact-failure",
				sequence: 2,
				stage: "artifact",
				status: "failed",
				detail: {
					code: "diff_capture_failed",
					reasonCode: "diff_capture_failed",
					captured: false,
				},
			}),
			outcome({
				id: "provider-failure",
				sequence: 1,
				stage: "provider",
				status: "failed",
				detail: {
					code: "execution_failed",
					reasonCode: "execution_failed",
					evidenceAvailable: true,
					diagnosticRef: `diagnostic:${"b".repeat(32)}`,
					diagnosticOrigin: "adapter",
				},
			}),
		]);
		strictEqual(projection.primaryFailure.reasonCode, "execution_failed");
		strictEqual(projection.primaryFailure.stage, "provider");
		strictEqual(
			projection.secondaryFailures[0].reasonCode,
			"diff_capture_failed",
		);
		strictEqual(projection.secondaryFailures[0].stage, "artifact");
		strictEqual(projection.artifactOutcome.reasonCode, "diff_capture_failed");
		strictEqual(projection.finalStatus, "failed");
		strictEqual(projection.diagnosticEvidence.status, "observed");
		strictEqual(
			FAILURE_PRECEDENCE.provider < FAILURE_PRECEDENCE.artifact,
			true,
		);
	});

	it("is byte deterministic regardless of input order", () => {
		const events = [
			outcome({
				id: "success",
				sequence: 3,
				stage: "run",
				status: "succeeded",
				taskId: "1.1",
				detail: { code: "complete" },
				operationId: "terminal",
			}),
			outcome({
				id: "start",
				sequence: 1,
				stage: "worker",
				status: "started",
				detail: { code: "started" },
				operationId: "start",
			}),
			outcome({
				id: "provider",
				sequence: 2,
				stage: "provider",
				status: "succeeded",
				detail: {
					servedModelVerified: true,
					completionContinuationProof: true,
					targetId: "codex",
				},
				operationId: "provider",
			}),
		];
		strictEqual(
			JSON.stringify(reduceOutcomeEvents(events)),
			JSON.stringify(reduceOutcomeEvents([...events].reverse())),
		);
	});

	it("canonicalizes conflicting same-id/same-sequence facts", () => {
		const left = outcome({
			id: "conflict",
			sequence: 1,
			stage: "provider",
			status: "failed",
			detail: { reasonCode: "execution_failed", code: "a" },
			operationId: "left",
		});
		const right = outcome({
			id: "conflict",
			sequence: 1,
			stage: "provider",
			status: "succeeded",
			detail: { servedModelVerified: true, code: "b" },
			operationId: "right",
		});
		const first = reduceOutcomeEvents([left, right]);
		const second = reduceOutcomeEvents([right, left]);
		strictEqual(JSON.stringify(first), JSON.stringify(second));
		strictEqual(first.outcomes.length, 1);
		strictEqual(first.identityConflicts.length, 1);
		strictEqual(first.finalStatus, "recovery_required");
	});

	it("deduplicates exact retries and crash replay without losing attempts", () => {
		const first = outcome({
			id: "provider-1",
			sequence: 1,
			stage: "provider",
			status: "failed",
			detail: { reasonCode: "execution_failed" },
			operationId: "execute",
		});
		const retry = outcome({
			id: "provider-2",
			sequence: 2,
			stage: "provider",
			status: "succeeded",
			attemptId: "attempt-2",
			attempt: 2,
			detail: { servedModelVerified: true },
			operationId: "execute",
		});
		const duplicate = structuredClone(first);
		const projection = reduceOutcomeEvents([first, duplicate, retry]);
		strictEqual(projection.outcomes.length, 2);
		strictEqual(projection.duplicateOutcomes.length, 1);
		strictEqual(projection.attempts.length, 2);
		strictEqual(projection.taskCounters.total, 1);
		strictEqual(projection.taskCounters.completed, 1);
		strictEqual(projection.taskCounters.failed, 0);
		strictEqual(projection.taskCounters.succeeded, 1);
	});

	it("merges duplicate logical transitions while retaining later evidence and proof", () => {
		const first = outcome({
			id: "capture-1",
			sequence: 1,
			stage: "provider",
			status: "failed",
			operationId: "capture",
			detail: { reasonCode: "execution_failed" },
		});
		const later = outcome({
			id: "capture-2",
			sequence: 2,
			stage: "provider",
			status: "failed",
			operationId: "capture",
			detail: {
				reasonCode: "execution_failed",
				evidenceAvailable: true,
				diagnosticRef: `diagnostic:${"c".repeat(32)}`,
				servedModelVerified: true,
			},
		});
		const projection = reduceOutcomeEvents([first, later]);
		strictEqual(projection.outcomes.length, 1);
		strictEqual(projection.outcomes[0].detail.evidenceAvailable, true);
		strictEqual(
			projection.outcomes[0].detail.diagnosticRef,
			`diagnostic:${"c".repeat(32)}`,
		);
		strictEqual(projection.modelProof.servedModelVerified, true);
		strictEqual(projection.diagnosticEvidence.diagnosticRefs.length, 1);
		strictEqual(projection.diagnosticEvidence.status, "observed");
	});

	it("retains review and model proof fields", () => {
		const projection = reduceOutcomeEvents([
			outcome({
				id: "provider-proof",
				sequence: 1,
				stage: "provider",
				status: "succeeded",
				detail: {
					reviewResult: {
						schemaVersion: 1,
						status: "available",
						verdict: "clean",
						findings: [],
						comments: [],
						findingCount: 0,
						commentCount: 0,
						sourceMutationCount: 0,
					},
					servedModelVerified: true,
					completionContinuationProof: true,
					targetId: "codex",
				},
			}),
		]);
		strictEqual(projection.reviewProof.reviewResult.verdict, "clean");
		strictEqual(projection.modelProof.servedModelVerified, true);
		strictEqual(projection.modelProof.completionContinuationProof, true);
		strictEqual(projection.modelProof.targetId, "codex");
	});

	it("reports unknown when there is insufficient terminal history", () => {
		const projection = reduceOutcomeEvents([
			outcome({
				id: "started",
				sequence: 1,
				stage: "worker",
				status: "started",
				detail: { code: "started" },
			}),
		]);
		strictEqual(projection.finalStatus, "unknown");
		strictEqual(projection.primaryFailure, null);
		strictEqual(projection.taskCounters.pending, 1);
		strictEqual(projection.taskCounters.terminal, 0);
		strictEqual(projection.diagnosticEvidence.status, "unknown");
	});

	it("adapts legacy rows without synthetic production identity", () => {
		const adapted = adaptLegacyOutcome(
			{
				sequence: 2,
				phase: "provider",
				event: "execution_failed",
				taskId: "1.1",
				reasonCode: "execution_failed",
			},
			{ runId: RUN },
		);
		strictEqual(adapted.stage, "legacy");
		strictEqual(adapted.originalSequence, 2);
		strictEqual(adapted.legacyPhase, "provider");
		strictEqual(adapted.legacyEvent, "execution_failed");
		strictEqual(adapted.taskId, "1.1");
		strictEqual(adapted.reasonCode, "execution_failed");
		strictEqual(Object.hasOwn(adapted, "outcomeId"), false);
		strictEqual(Object.hasOwn(adapted, "attemptId"), false);
		const projection = reduceOutcomeEvents([
			{
				sequence: 1,
				phase: "provider",
				event: "execution_failed",
				taskId: "1.1",
				reasonCode: "execution_failed",
				runId: RUN,
			},
			{
				sequence: 2,
				phase: "artifact",
				event: "diff_capture_failed",
				taskId: "1.1",
				reasonCode: "diff_capture_failed",
				runId: RUN,
			},
		]);
		strictEqual(projection.primaryFailure.stage, "provider");
		strictEqual(projection.primaryFailure.reasonCode, "execution_failed");
		strictEqual(projection.secondaryFailures[0].stage, "artifact");
		strictEqual(projection.taskCounters.failed, 1);
		ok(
			projection.outcomes.every((event) => !Object.hasOwn(event, "outcomeId")),
		);
		throws(
			() =>
				adaptLegacyOutcome({
					sequence: 3,
					phase: "provider",
					event: "future_event",
				}),
			/closed adapter/,
		);
	});

	it("keeps recovery required separate from the original failure", () => {
		const projection = reduceOutcomeEvents([
			outcome({
				id: "provider-failure",
				sequence: 1,
				stage: "provider",
				status: "failed",
				detail: { reasonCode: "execution_failed" },
			}),
			outcome({
				id: "recovery",
				sequence: 2,
				stage: "recovery",
				status: "failed",
				detail: {
					code: "recovery_required",
					reasonCode: "orphan_attempt",
					operatorCommand: "switchyard-dispatch recover",
				},
			}),
		]);
		strictEqual(projection.primaryFailure.stage, "provider");
		strictEqual(projection.recoveryOutcome.reasonCode, "orphan_attempt");
		strictEqual(projection.finalStatus, "recovery_required");
	});

	it("classifies every closed legacy failure event as a failure", () => {
		for (const [event, phase, stage] of [
			["seed_failed", "bootstrap", "worker"],
			["served_model_unverified", "provider", "provider"],
			["task_base_failed", "bootstrap", "worker"],
			["task_base_release_failed", "bootstrap", "worker"],
			["intent_receipt_failed", "preflight", "preflight"],
			["dirty_overlay_rejected", "integration", "integration"],
		]) {
			const projection = reduceOutcomeEvents([
				{
					sequence: 1,
					phase,
					event,
					taskId: "1.1",
					reasonCode: event,
					runId: RUN,
				},
			]);
			strictEqual(projection.primaryFailure.stage, stage);
			strictEqual(projection.primaryFailure.reasonCode, event);
			strictEqual(projection.finalStatus, "failed");
			strictEqual(projection.taskCounters.failed, 1);
		}
	});

	it("fails closed for invalid causal links", () => {
		const predecessor = outcome({
			id: "predecessor",
			sequence: 2,
			stage: "provider",
			status: "succeeded",
			operationId: "provider",
		});
		const dependent = outcome({
			id: "dependent",
			sequence: 1,
			stage: "artifact",
			status: "failed",
			operationId: "artifact",
			causedBy: "predecessor",
			detail: { reasonCode: "diff_capture_failed" },
		});
		const missing = outcome({
			id: "missing-cause",
			sequence: 3,
			stage: "cleanup",
			status: "failed",
			operationId: "cleanup",
			causedBy: "does-not-exist",
			detail: { reasonCode: "cleanup_uncertain" },
		});
		const projection = reduceOutcomeEvents([predecessor, dependent, missing]);
		strictEqual(projection.causalIntegrity.status, "invalid");
		strictEqual(projection.causalIntegrity.invalidLinks.length, 2);
		strictEqual(projection.finalStatus, "recovery_required");
	});

	it("does not infer terminal success from provider or cleanup success alone", () => {
		const projection = reduceOutcomeEvents([
			outcome({
				id: "provider-success",
				sequence: 1,
				stage: "provider",
				status: "succeeded",
				detail: { servedModelVerified: true },
				operationId: "provider",
			}),
			outcome({
				id: "cleanup-success",
				sequence: 2,
				stage: "cleanup",
				status: "succeeded",
				detail: { observed: true },
				operationId: "cleanup",
			}),
		]);
		strictEqual(projection.finalStatus, "unknown");
	});

	it("does not count stage-local legacy successes as task completion", () => {
		for (const [event, phase] of [
			["diff_captured", "artifact"],
			["cleanup_completed", "cleanup"],
			["checkpoint_saved", "checkpoint"],
		]) {
			const projection = reduceOutcomeEvents([
				{ sequence: 1, phase, event, taskId: "1.1", runId: RUN },
			]);
			strictEqual(projection.finalStatus, "unknown");
			strictEqual(projection.taskCounters.pending, 1);
			strictEqual(projection.taskCounters.completed, 0);
		}
	});
});
