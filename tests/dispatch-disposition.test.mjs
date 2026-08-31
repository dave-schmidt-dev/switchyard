import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";

import {
	projectDisposition,
	projectTerminalOutcome,
} from "../src/switchyard/dispatch/disposition.mjs";

function run(overrides = {}) {
	return {
		runId: "run-1",
		state: "running",
		cleanupState: "not_started",
		lastFailure: null,
		...overrides,
	};
}

function failure(overrides = {}) {
	return {
		errorKind: "execution_failed",
		reasonCode: "execution_failed",
		reason: "closed",
		failurePhase: "provider_execution",
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

describe("caller disposition precedence", () => {
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
			"execution_failed",
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

	it("projects descriptor-bound Agy and OpenCode attempts from existing checkpoint channels", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: {
				retryAttempts: [exactFailure("agy-gemini", "2.3")],
				results: [exactFailure("opencode-go", "2.3")],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "target_failed");
		strictEqual(result.taskId, "2.3");
		deepStrictEqual(result.failedTargetIds, ["agy-gemini", "opencode-go"]);
	});

	it("returns failed targets only for its bounded, validated task identity", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: {
				retryAttempts: [
					exactFailure("opencode-go", "2.4"),
					exactFailure("agy-gemini", "2.3"),
					exactFailure("codex-standard", "2.3"),
					exactFailure("invalid-task", "2.3/unsafe"),
					exactFailure("oversized-task", "1".repeat(65)),
				],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "target_failed");
		strictEqual(result.taskId, "2.3");
		deepStrictEqual(result.failedTargetIds, ["agy-gemini", "codex-standard"]);
	});

	it("deduplicates six sanitized OpenCode execution failures without a cooldown schema", () => {
		const events = Array.from({ length: 6 }, () => ({
			...exactFailure("opencode-go", "2.3"),
			phase: "execution",
			event: "task_failed",
		}));
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: { retryAttempts: [], results: [] },
			events,
			liveness: "terminal_clean",
		});
		deepStrictEqual(result.failedTargetIds, ["opencode-go"]);
		strictEqual(Object.hasOwn(result, "cooldown"), false);
		strictEqual(Object.hasOwn(result, "cooldownUntil"), false);
	});

	it("does not promote run-record route fields into attempt evidence", () => {
		const exact = exactFailure("opencode-go", "2.3");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
				lastResolvedTargetId: exact.resolvedTargetId,
				lastTaskInvocationDescriptor: exact.invocationDescriptor,
				lastTaskDescriptorIdentity: exact.descriptorIdentity,
				lastTaskDescriptorHarness: exact.descriptorHarness,
			}),
			checkpoint: { retryAttempts: [], results: [] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
	});

	it("ignores descriptor-bound failures outside sanitized execution events", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: { retryAttempts: [], results: [] },
			events: [
				{
					...exactFailure("opencode-go", "2.3"),
					phase: "broker",
					event: "task_failed",
				},
			],
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
	});

	it("requires a provider or integration failure for target_failed", () => {
		const preProviderFailure = {
			...exactFailure("opencode-go", "2.3"),
			errorKind: "declared_path_not_seeded",
			failurePhase: "adapter_validation",
		};
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure({
					errorKind: "declared_path_not_seeded",
					failurePhase: "adapter_validation",
				}),
			}),
			checkpoint: { retryAttempts: [preProviderFailure], results: [] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
	});

	it("rejects target IDs without exact descriptor-bound failure evidence", () => {
		const inexact = exactFailure("codex/standard");
		inexact.invocationDescriptor.target_id = "different";
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: { retryAttempts: [inexact] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
	});
});

describe("typed launch evidence", () => {
	it("maps typed queue and identity failures to contract repair", () => {
		for (const code of [
			"invalid_invocation",
			"queue_empty",
			"queue_identity_invalid",
		]) {
			const result = projectDisposition({
				preInitialization: { type: "contract_failure", code },
			});
			strictEqual(result.action, "repair_contract");
			strictEqual(result.reasonCode, code);
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
					}),
				}),
				liveness: "terminal_clean",
			});
			strictEqual(result.action, "repair_contract");
			strictEqual(result.reasonCode, diagnosticCode);
		}
	});
});

describe("terminal outcome projection", () => {
	const summary = (processedTasks) => ({ processedTasks });
	for (const [name, evidence, expected] of [
		[
			"completed work",
			run({
				state: "succeeded",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(2),
			}),
			"completed_work",
		],
		[
			"no runnable work",
			run({
				state: "succeeded",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(0),
			}),
			"no_runnable_work",
		],
		[
			"failed work",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(1),
			}),
			"failed_work",
		],
		[
			"failed before work",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(0),
			}),
			"failed_before_work",
		],
		[
			"dead worker recovery outranks counts",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "dead_worker_recovery",
				terminalSummary: summary(7),
			}),
			"recovered_dead_worker",
		],
		[
			"historical failure stays unknown",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalSummary: summary(3),
			}),
			"unknown_failure",
		],
		[
			"missing counts stay unknown",
			run({
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: summary(null),
			}),
			"unknown_failure",
		],
	]) {
		it(name, () => strictEqual(projectTerminalOutcome(evidence), expected));
	}
});
