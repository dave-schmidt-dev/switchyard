import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	projectDisposition,
	projectTerminalOutcome,
} from "../src/switchyard/dispatch/disposition.mjs";
import { run } from "./helpers/dispatch-disposition-fixtures.mjs";

function failure(overrides = {}) {
	return {
		errorKind: "execution_failed",
		reasonCode: "execution_failed",
		reason: "closed",
		diagnosticCode: "provider_exit_nonzero",
		failurePhase: "provider_execution",
		diagnosticOrigin: "adapter",
		diagnosticEvidenceAvailable: true,
		...overrides,
	};
}
function exactFailure(targetId, taskId = "2.1") {
	const descriptorIdentity = `sha256:${"a".repeat(64)}`;
	return {
		taskId,
		success: false,
		resolvedTargetId: targetId,
		descriptorHarness: "codex",
		descriptorIdentity,
		invocationDescriptor: {
			target_id: targetId,
			descriptor_identity: descriptorIdentity,
		},
		...failure(),
	};
}

describe("reducer terminal projection", () => {
	it("does not report completed work before lifecycle cleanup is terminal", () => {
		strictEqual(
			projectTerminalOutcome(
				run({ state: "running", cleanupState: "not_started" }),
				{
					reader: "reducer",
					finalStatus: "succeeded",
					taskCounters: { completed: 1 },
				},
			),
			"unknown_failure",
		);
	});
});

describe("caller disposition precedence", () => {
	it("projects battery policy deferral as an authorized fallback advance", () => {
		const disposition = projectDisposition({
			run: run({
				state: "deferred",
				cleanupState: "complete",
				policyDeferred: {
					action: "policy_deferred",
					reasonCode: "host_on_battery",
					nextTaskId: "2.1",
					taskFileSha256: "a".repeat(64),
				},
			}),
			liveness: "terminal_clean",
		});
		strictEqual(disposition.action, "policy_deferred");
		strictEqual(disposition.direction, "advance_authorized_fallback");
		strictEqual(disposition.reasonCode, "host_on_battery");
		strictEqual(disposition.diagnosticCode, "host_on_battery");
		strictEqual(disposition.taskId, "2.1");
		strictEqual(disposition.taskFileSha256, "a".repeat(64));
	});
	it("projects clean deferred terminal work as deferred_work", () => {
		const disposition = projectDisposition({
			run: run({ state: "deferred", cleanupState: "complete" }),
			liveness: "terminal_clean",
		});
		strictEqual(disposition.action, "defer");
		strictEqual(disposition.reasonCode, "deferred_work");
		strictEqual(disposition.direction, "wait");
	});
	const recoveryCommand =
		"switchyard-dispatch recover --run run-1 --state-root '/tmp/state'";
	const cases = [
		[
			"recovery required outranks dead-worker recovery",
			{
				run: run({ state: "recovery_required", cleanupState: "failed" }),
				liveness: "dead",
			},
			"stop",
			"recovery_incomplete",
		],
		[
			"live succeeded finalizer outranks completion",
			{
				run: run({ state: "succeeded", cleanupState: "pending" }),
				liveness: "live",
			},
			"monitor",
			"cleanup_in_progress",
		],
		[
			"live failed finalizer outranks contract repair",
			{
				run: run({
					state: "failed",
					cleanupState: "pending",
					lastFailure: failure({
						diagnosticCode: "worker_contract_unsupported",
					}),
				}),
				liveness: "startup_grace",
			},
			"monitor",
			"cleanup_in_progress",
		],
		[
			"dead terminal cleanup is recoverable",
			{
				run: run({ state: "failed", cleanupState: "not_started" }),
				liveness: "dead",
				recoveryCommand,
			},
			"recover",
			"cleanup_incomplete",
		],
		[
			"clean success completes",
			{
				run: run({ state: "succeeded", cleanupState: "complete" }),
				liveness: "terminal_clean",
			},
			"complete",
			"run_succeeded",
		],
		[
			"live nonterminal with no cleanup work monitors",
			{ run: run({ cleanupState: "complete" }), liveness: "live" },
			"monitor",
			"run_in_progress",
		],
		[
			"dead nonterminal recovers",
			{ run: run(), liveness: "dead", recoveryCommand },
			"recover",
			"worker_dead",
		],
		[
			"contract diagnostics repair",
			{
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure({
						diagnosticCode: "checkpoint_queue_identity_mismatch",
						diagnosticOrigin: "worker_boot",
						failurePhase: "worker_boot",
					}),
				}),
				liveness: "terminal_clean",
			},
			"repair_contract",
			"checkpoint_queue_identity_mismatch",
		],
		[
			"exact target failure is projected without authority",
			{
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure(),
				}),
				checkpoint: { retryAttempts: [exactFailure("codex/standard")] },
				liveness: "terminal_clean",
			},
			"target_failed",
			"provider_exit_nonzero",
		],
		[
			"insufficient evidence stops",
			{
				run: run({ state: "failed", cleanupState: "complete" }),
				liveness: "terminal_clean",
			},
			"stop",
			"insufficient_evidence",
		],
	];
	it("projects interactive cleanup remediation without changing stop behavior", () => {
		const remediationCommand =
			"switchyard-dispatch remediate-orphaned-locks --state-root '/tmp/state'";
		const result = projectDisposition({
			run: run({ state: "recovery_required", cleanupState: "failed" }),
			liveness: "dead",
			recoveryCommand,
			remediationCommand,
		});
		strictEqual(result.action, "stop");
		strictEqual(result.direction, "stop");
		strictEqual(result.reasonCode, "recovery_incomplete");
		strictEqual(result.recoveryCommand, null);
		strictEqual(result.remediationCommand, remediationCommand);
	});
	for (const [name, evidence, action, reasonCode] of cases) {
		it(name, () => {
			const result = projectDisposition(evidence);
			strictEqual(result.action, action);
			strictEqual(result.reasonCode, reasonCode);
			strictEqual(result.version, 1);
		});
	}
	it("corrupt optional evidence reduces a target failure to stop", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: { retryAttempts: [exactFailure("codex/standard")] },
			optionalEvidenceValid: false,
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
	});
	it("wrong origin and code combinations cannot authorize routing or repair", () => {
		for (const lastFailure of [
			failure({
				diagnosticCode: "cli_usage_error",
				diagnosticOrigin: "adapter",
			}),
			failure({
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "launcher",
			}),
			failure({
				diagnosticCode: "worker_contract_unsupported",
				diagnosticOrigin: "adapter",
			}),
			failure({
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "worker_boot",
				failurePhase: undefined,
			}),
			failure({
				diagnosticCode: "worker_boot_exception",
				diagnosticOrigin: "worker_boot",
				failurePhase: undefined,
			}),
		]) {
			const result = projectDisposition({
				run: run({ state: "failed", cleanupState: "complete", lastFailure }),
				checkpoint: { retryAttempts: [exactFailure("codex/standard")] },
				liveness: "terminal_clean",
			});
			strictEqual(result.action, "stop");
			strictEqual(result.direction, "stop");
			strictEqual(result.reasonCode, "insufficient_evidence");
			strictEqual(result.diagnosticCode, null);
			deepStrictEqual(result.failedTargetIds, []);
		}
	});
	it("does not emit runtime recovery without a usable command", () => {
		for (const evidence of [
			{
				run: run({ state: "failed", cleanupState: "pending" }),
				liveness: "dead",
			},
			{ run: run(), liveness: "dead", recoveryCommand: "   " },
		]) {
			const result = projectDisposition(evidence);
			strictEqual(result.action, "stop");
			strictEqual(result.reasonCode, "insufficient_evidence");
			strictEqual(result.recoveryCommand, null);
		}
	});
	it("durable contract diagnostics outrank unloadable optional evidence", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure({
					diagnosticCode: "checkpoint_queue_identity_mismatch",
					diagnosticOrigin: "worker_boot",
					failurePhase: "worker_boot",
				}),
			}),
			optionalEvidenceValid: false,
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "repair_contract");
		strictEqual(result.reasonCode, "checkpoint_queue_identity_mismatch");
	});
	it("retry state distinguishes in-progress and consumed states", () => {
		strictEqual(
			projectDisposition({
				run: run({ cleanupState: "complete" }),
				checkpoint: { retryState: { phase: "retry_started" } },
				liveness: "live",
			}).reasonCode,
			"retry_in_progress",
		);
		strictEqual(
			projectDisposition({
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure(),
				}),
				checkpoint: {
					retryState: { phase: "retry_halted" },
					retryAttempts: [exactFailure("codex/standard")],
				},
				liveness: "terminal_clean",
			}).reasonCode,
			"retry_consumed",
		);
	});
	it("keeps live runs with no cleanup work in run or retry progress", () => {
		strictEqual(
			projectDisposition({
				run: run({ cleanupState: "not_started" }),
				liveness: "live",
			}).reasonCode,
			"run_in_progress",
		);
		strictEqual(
			projectDisposition({
				run: run({ cleanupState: "not_started" }),
				checkpoint: { retryState: { phase: "retry_started" } },
				liveness: "startup_grace",
			}).reasonCode,
			"retry_in_progress",
		);
	});
	it("sorts, deduplicates, caps, and marks exact failed targets", () => {
		const attempts = Array.from({ length: 18 }, (_, index) =>
			exactFailure(`target-${String(17 - index).padStart(2, "0")}`),
		);
		attempts.push(exactFailure("target-00"));
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: { retryAttempts: attempts },
			liveness: "terminal_clean",
		});
		strictEqual(result.failedTargetIds.length, 16);
		strictEqual(result.failedTargetIdsTruncated, true);
		deepStrictEqual(result.failedTargetIds, [...result.failedTargetIds].sort());
		strictEqual(Object.hasOwn(result, "nextRoute"), false);
	});
});

describe("typed launch evidence", () => {
	it("maps typed queue and identity failures to contract repair", () => {
		for (const code of [
			"invalid_invocation",
			"queue_contract_invalid",
			"queue_empty",
			"queue_identity_invalid",
		]) {
			const result = projectDisposition({
				preInitialization: { type: "contract_failure", code },
			});
			strictEqual(result.action, "repair_contract");
			strictEqual(result.reasonCode, code);
			strictEqual(result.diagnosticCode, code);
		}
	});

	it("defers to a validated live lock owner", () => {
		const result = projectDisposition({
			preInitialization: {
				type: "lock_conflict",
				code: "PROJECT_LOCK_HELD",
				holderRunId: "holder-1",
				holderLiveness: "startup_grace",
			},
		});
		strictEqual(result.action, "defer");
		strictEqual(result.blockingRunId, "holder-1");
	});

	it("recovers a proven-dead owner only with a supplied bound command", () => {
		const recoveryCommand =
			"switchyard-dispatch recover --run holder-1 --state-root '/tmp/state'";
		const result = projectDisposition({
			preInitialization: {
				type: "lock_conflict",
				code: "PROJECT_LOCK_HELD",
				holderRunId: "holder-1",
				holderLiveness: "dead",
			},
			recoveryCommand,
		});
		strictEqual(result.action, "recover");
		strictEqual(result.recoveryCommand, recoveryCommand);
	});

	it("does not emit an unusable recovery for a dead owner without a command", () => {
		const result = projectDisposition({
			preInitialization: {
				type: "lock_conflict",
				code: "PROJECT_LOCK_HELD",
				holderRunId: "holder-1",
				holderLiveness: "dead",
			},
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
		strictEqual(result.recoveryCommand, null);
	});

	it("stops on unresolved or invalid lock ownership", () => {
		for (const holderRunId of [null, "bad/run-id"]) {
			const result = projectDisposition({
				preInitialization: {
					type: "lock_conflict",
					code: "PROJECT_LOCK_HELD",
					holderRunId,
					holderLiveness: "unknown",
				},
			});
			strictEqual(result.action, "stop");
			strictEqual(result.blockingRunId, null);
		}
	});

	it("projects worker boot and preparation failures to contract repair", () => {
		for (const diagnosticCode of [
			"worker_boot_exception",
			"clone_hardening_failed",
			"workspace_prepare_failed",
		]) {
			const result = projectDisposition({
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure({
						errorKind: "launch_failed",
						reasonCode: diagnosticCode,
						diagnosticCode,
						failurePhase: "worker_boot",
						diagnosticOrigin: "worker_boot",
					}),
				}),
				liveness: "terminal_clean",
			});
			strictEqual(result.action, "repair_contract");
			strictEqual(result.reasonCode, diagnosticCode);
		}
	});
});
