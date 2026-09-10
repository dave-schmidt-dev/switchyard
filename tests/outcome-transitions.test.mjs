import {
	deepStrictEqual,
	notStrictEqual,
	strictEqual,
	throws,
} from "node:assert";
import { describe, it } from "node:test";
import {
	artifactTransition,
	cleanupTransition,
	failureTransition,
	integrationTransition,
	recoveryTransition,
	retryTransition,
	reviewTransition,
	successTransition,
	terminalSummaryTransition,
	terminalTransition,
} from "../src/switchyard/outcome/transitions.mjs";

describe("shared outcome transitions", () => {
	it("keeps success and failure decisions closed and side-effect free", () => {
		const input = { provider: "codex", model: "gpt", cleanupFailed: true };
		const success = successTransition(input);
		const failure = failureTransition({ ...input, errorKind: "launch_failed" });
		strictEqual(success.success, true);
		strictEqual(failure.success, false);
		strictEqual(success.terminal, true);
		notStrictEqual(success, input);
		strictEqual(input.cleanupFailed, true);
		strictEqual(
			failureTransition({ errorKind: "not-a-closed-kind" }).errorKind,
			"execution_failed",
		);
		strictEqual(
			failureTransition({
				result: "orchestrator_timed_out",
				timedOut: true,
			}).errorKind,
			"orchestrator_timeout",
		);
		strictEqual(
			failureTransition({ result: "halted_after_commit_failure" }).errorKind,
			"unknown_failure",
		);
		strictEqual(
			failureTransition({
				result: "execution_failed",
				diagnosticCode: "provider_exit_nonzero",
			}).failureMetadata.diagnosticCode,
			"provider_exit_nonzero",
		);
		strictEqual(
			failureTransition({
				result: "provider_cleanup_failed",
				cleanupStage: "pid_observed",
			}).failureMetadata.diagnosticCode,
			"provider_cleanup_after_pid_observed",
		);
		strictEqual(
			successTransition({
				reviewResult: { verdict: "clean", summary: "/secret/path" },
			}).reviewResult.verdict,
			"clean",
		);
	});

	it("centralizes stage and retry classifications", () => {
		deepStrictEqual(artifactTransition({ captureStatus: "captured" }), {
			type: "artifact",
			status: "succeeded",
			code: "artifact_capture",
			artifactKind: "diff",
			captured: true,
			contentHash: null,
		});
		deepStrictEqual(integrationTransition({ reached: true, accepted: false }), {
			type: "integration",
			status: "failed",
			code: "integration_gate",
			gateCode: "integration_gate",
			accepted: false,
		});
		strictEqual(
			retryTransition({ kind: "retry_started", attempt: 2 }).kind,
			"retry_started",
		);
		throws(() => retryTransition({ kind: "provider_retry" }), /unknown retry/);
	});

	it("keeps review, cleanup, recovery, and summary decisions deterministic", () => {
		const unavailable = {
			schemaVersion: 1,
			status: "unavailable",
			verdict: "unavailable",
			reason: "timeout",
			findings: [],
			comments: [],
			findingCount: 0,
			commentCount: 0,
			sourceMutationCount: 0,
		};
		deepStrictEqual(
			reviewTransition({ reviewResult: unavailable }).reviewResult,
			unavailable,
		);
		strictEqual(reviewTransition({ status: "succeeded" }).available, false);
		strictEqual(cleanupTransition({ status: "failed" }).observed, false);
		strictEqual(
			recoveryTransition({ reasonCode: "orphan_attempt" }).automatic,
			false,
		);
		deepStrictEqual(
			terminalSummaryTransition({
				outcome: "failed",
				totalTasks: 2,
				completedTaskIds: ["1.1", "bad path"],
			}),
			{
				type: "terminal_summary",
				outcome: "failed",
				totalTasks: 2,
				runnableTasks: null,
				processedTasks: null,
				completedTaskIds: ["1.1"],
				failedCount: null,
				deferredTaskIds: null,
				halted: null,
			},
		);
		strictEqual(
			failureTransition({ failurePhase: "not-a-phase" }).failurePhase,
			null,
		);
		strictEqual(
			failureTransition({
				diagnosticCode: "provider_timeout",
				diagnosticOrigin: "provider",
				failurePhase: "provider_execution",
				diagnosticEvidenceAvailable: true,
				diagnosticRef: "diagnostic:not-a-valid-ref",
			}).diagnosticRef,
			null,
		);
		const facts = {
			results: [{ success: true }, { success: false }],
			totalTasks: 2,
			processedTasks: 2,
			completedTaskIds: ["1.1"],
			deferredTaskIds: [],
		};
		const terminal = terminalTransition(facts);
		deepStrictEqual(
			terminalTransition({ ...facts, state: terminal.state }).terminalSummary,
			terminal.terminalSummary,
		);
		strictEqual(terminal.state, "failed");
		strictEqual(terminal.terminalSummary.failedCount, 1);
		strictEqual(
			terminalTransition({ ...facts, state: "succeeded" }).state,
			"failed",
		);
		strictEqual(Object.hasOwn(terminal.terminalSummary, "outcome"), false);
		strictEqual(Object.hasOwn(terminal.terminalSummary, "halted"), false);
	});
});
