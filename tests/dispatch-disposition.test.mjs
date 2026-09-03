import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
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

function targetDisposition({
	errorKind,
	diagnosticCode = errorKind,
	failurePhase = "provider_execution",
	retryConsumed = false,
	optionalEvidenceValid = true,
}) {
	const exact = exactFailure("codex/standard");
	Object.assign(exact, {
		errorKind,
		reasonCode: errorKind,
		diagnosticCode,
		failurePhase,
	});
	return projectDisposition({
		run: run({
			state: "failed",
			cleanupState: "complete",
			lastFailure: failure({
				errorKind,
				reasonCode: errorKind,
				diagnosticCode,
				failurePhase,
			}),
		}),
		checkpoint: {
			...(retryConsumed ? { retryState: { phase: "retry_halted" } } : {}),
			retryAttempts: [exact],
		},
		liveness: "terminal_clean",
		optionalEvidenceValid,
	});
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

	it("names the blocking task by numeric order once a queue passes nine tasks", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: {
				retryAttempts: [
					exactFailure("agy-gemini", "10.1"),
					exactFailure("opencode-go", "2.1"),
				],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "target_failed");
		// A lexical sort ranks "10.1" ahead of "2.1" and reports the wrong task
		// and the wrong targets as blocking.
		strictEqual(result.taskId, "2.1");
		deepStrictEqual(result.failedTargetIds, ["opencode-go"]);
	});

	it("ranks a parent task ahead of its own subtask", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure(),
			}),
			checkpoint: {
				retryAttempts: [
					exactFailure("agy-gemini", "2.1"),
					exactFailure("opencode-go", "2"),
				],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.taskId, "2");
		deepStrictEqual(result.failedTargetIds, ["opencode-go"]);
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

describe("closed caller direction", () => {
	const targetMappings = [
		["auth_expired", "auth_expired", "stop"],
		["quota_exhausted", "quota_exhausted", "advance_authorized_fallback"],
		["model_unavailable", "model_unavailable", "advance_authorized_fallback"],
		["execution_failed", "execution_failed", "advance_authorized_fallback"],
		["execution_failed", "cli_usage_error", "advance_authorized_fallback"],
		[
			"execution_failed",
			"provider_exit_nonzero",
			"advance_authorized_fallback",
		],
		["execution_failed", "provider_signalled", "advance_authorized_fallback"],
		[
			"execution_failed",
			"provider_output_unclassified",
			"advance_authorized_fallback",
		],
		[
			"execution_timed_out",
			"execution_timed_out",
			"advance_authorized_fallback",
		],
		[
			"execution_timed_out",
			"execution_cancelled",
			"advance_authorized_fallback",
		],
		[
			"provider_cleanup_failed",
			"provider_cleanup_failed",
			"advance_authorized_fallback",
		],
		[
			"diff_capture_failed",
			"diff_capture_failed",
			"advance_authorized_fallback",
		],
		...[
			"provider_cleanup_after_cleanup_started",
			"provider_cleanup_after_pid_observed",
			"provider_cleanup_after_tree_terminated",
			"provider_cleanup_after_pid_marker_removed",
			"provider_cleanup_after_index_lock_removed",
		].map((diagnosticCode) => [
			"provider_cleanup_failed",
			diagnosticCode,
			"advance_authorized_fallback",
		]),
		["integration_failed", "declared_path_not_seeded", "repair_input"],
		["required_paths_missing", "required_paths_missing", "repair_input"],
		["undeclared_paths_touched", "undeclared_paths_touched", "repair_input"],
		["empty_required_diff", "empty_required_diff", "repair_input"],
		["no_op_diff", "no_op_diff", "repair_input"],
		["manifest_review_required", "manifest_review_required", "repair_input"],
		["corrupt_patch", "corrupt_patch", "repair_input"],
		["conflict", "conflict", "repair_input"],
		["empty_diff", "empty_diff", "repair_input"],
		["integration_failed", "path_escapes_project_root", "stop"],
		["integration_failed", "git_internals_touched", "stop"],
		["integration_failed", "credential_path_touched", "stop"],
		["integration_failed", "symlink_creation_refused", "stop"],
		["integration_failed", "executable_file_refused", "stop"],
		["integration_failed", "integration_failed", "stop"],
	];

	it("enumerates every closed target-failure tuple without changing its legacy action", () => {
		for (const [errorKind, diagnosticCode, direction] of targetMappings) {
			const result = targetDisposition({ errorKind, diagnosticCode });
			strictEqual(result.action, "target_failed", diagnosticCode);
			strictEqual(result.direction, direction, diagnosticCode);
			strictEqual(result.taskId, "2.1", diagnosticCode);
			deepStrictEqual(
				result.failedTargetIds,
				["codex/standard"],
				diagnosticCode,
			);
			strictEqual(Object.hasOwn(result, "nextRoute"), false, diagnosticCode);
			strictEqual(
				Object.hasOwn(result, "fallbackRoute"),
				false,
				diagnosticCode,
			);
		}
	});

	it("fails an unenumerated target tuple closed", () => {
		const result = targetDisposition({
			errorKind: "integration_failed",
			diagnosticCode: "unknown_closed_diagnostic",
		});
		strictEqual(result.action, "target_failed");
		strictEqual(result.direction, "stop");
	});

	it("uses the underlying closed failure when retry_consumed is reachable", () => {
		for (const [errorKind, diagnosticCode, direction] of [
			["quota_exhausted", "quota_exhausted", "advance_authorized_fallback"],
			["auth_expired", "auth_expired", "stop"],
			["integration_failed", "credential_path_touched", "stop"],
		]) {
			const result = targetDisposition({
				errorKind,
				diagnosticCode,
				retryConsumed: true,
			});
			strictEqual(result.reasonCode, "retry_consumed");
			strictEqual(result.direction, direction);
		}
	});

	it("keeps invalid optional target evidence at insufficient_evidence", () => {
		const result = targetDisposition({
			errorKind: "execution_failed",
			optionalEvidenceValid: false,
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
		strictEqual(result.direction, "stop");
	});

	it("projects closed pre-provider diagnostics before the optional-evidence gate", () => {
		for (const diagnosticCode of [
			"prlctl_job_misfire",
			"prlctl_session_not_ready",
			"prlctl_call_timed_out",
			"prlctl_call_failed",
		]) {
			const result = projectDisposition({
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure({ diagnosticCode }),
				}),
				optionalEvidenceValid: false,
				liveness: "terminal_clean",
			});
			strictEqual(result.action, "stop");
			strictEqual(result.reasonCode, diagnosticCode);
			strictEqual(result.direction, "stop");
		}
	});

	it("maps terminal lock diagnostics only to a fresh launch retry", () => {
		for (const diagnosticCode of [
			"project_lock_held",
			"project_lock_recovery_in_progress",
			"project_lock_ownership_failed",
			"project_lock_ownership_displaced",
			"project_lock_claim_cleanup_failed",
			"project_lock_recovery_claim_blocks_execution",
		]) {
			const result = projectDisposition({
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure({ diagnosticCode }),
				}),
				optionalEvidenceValid: false,
				liveness: "terminal_clean",
			});
			strictEqual(result.action, "stop");
			strictEqual(result.direction, "retry_launch");
			strictEqual(result.blockingRunId, null);
			strictEqual(result.recoveryCommand, null);
		}
	});

	it("maps terminal VM-slot exhaustion to a fresh launch retry", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure({ diagnosticCode: "vm_slot_unavailable" }),
			}),
			optionalEvidenceValid: false,
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "vm_slot_unavailable");
		strictEqual(result.direction, "retry_launch");
	});

	it("maps VM admission storage failure to contract repair", () => {
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure({
					diagnosticCode: "vm_admission_unavailable",
				}),
			}),
			optionalEvidenceValid: false,
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "repair_contract");
		strictEqual(result.reasonCode, "vm_admission_unavailable");
		strictEqual(result.direction, "repair_input");
	});

	it("keeps holder-aware wait and recovery confined to pre-initialization", () => {
		const wait = projectDisposition({
			preInitialization: {
				type: "lock_conflict",
				code: "PROJECT_LOCK_HELD",
				holderRunId: "holder-1",
				holderLiveness: "live",
			},
		});
		strictEqual(wait.direction, "wait");
		strictEqual(wait.blockingRunId, "holder-1");

		const recover = projectDisposition({
			preInitialization: {
				type: "lock_conflict",
				code: "PROJECT_LOCK_HELD",
				holderRunId: "holder-1",
				holderLiveness: "dead",
			},
			recoveryCommand: "switchyard-dispatch recover --run holder-1",
		});
		strictEqual(recover.direction, "recover_and_retry");
		ok(recover.recoveryCommand.includes("holder-1"));
	});

	it("maps every pre-initialization contract code without insufficient evidence", () => {
		for (const code of [
			"invalid_invocation",
			"queue_empty",
			"queue_identity_invalid",
			"task_selection_failed",
			"environment_incomplete",
			"project_lock_held",
			"project_lock_recovery_in_progress",
			"project_lock_ownership_failed",
			"project_lock_ownership_displaced",
			"project_lock_claim_cleanup_failed",
			"project_lock_recovery_claim_blocks_execution",
		]) {
			const result = projectDisposition({
				preInitialization: { type: "contract_failure", code },
			});
			strictEqual(result.reasonCode, code);
			strictEqual(result.direction, "repair_input");
		}
	});

	it("derives direction only inside baseDisposition", () => {
		const source = readFileSync(
			new URL("../src/switchyard/dispatch/disposition.mjs", import.meta.url),
			"utf8",
		);
		const start = source.indexOf("function baseDisposition(");
		const end = source.indexOf("function projectPreInitialization(");
		ok(start >= 0 && end > start);
		const outside = `${source.slice(0, start)}${source.slice(end)}`;
		strictEqual(/\bdirection\b/.test(outside), false);
	});

	it("covers the complete closed direction vocabulary", () => {
		const observed = new Set([
			projectDisposition({
				run: run({ state: "succeeded", cleanupState: "complete" }),
				liveness: "terminal_clean",
			}).direction,
			projectDisposition({ run: run(), liveness: "live" }).direction,
			projectDisposition({
				run: run(),
				liveness: "dead",
				recoveryCommand: "switchyard-dispatch recover --run run-1",
			}).direction,
			projectDisposition({
				preInitialization: {
					type: "contract_failure",
					code: "invalid_invocation",
				},
			}).direction,
			targetDisposition({ errorKind: "execution_failed" }).direction,
			projectDisposition({
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure({ diagnosticCode: "project_lock_held" }),
				}),
				liveness: "terminal_clean",
			}).direction,
			targetDisposition({ errorKind: "auth_expired" }).direction,
		]);
		deepStrictEqual([...observed].sort(), [
			"advance_authorized_fallback",
			"complete",
			"recover_and_retry",
			"repair_input",
			"retry_launch",
			"stop",
			"wait",
		]);
	});

	it("keeps README schema/mapping and INV-6 synchronized", () => {
		const readme = readFileSync(
			new URL("../README.md", import.meta.url),
			"utf8",
		);
		const invariants = readFileSync(
			new URL("../INVARIANTS.md", import.meta.url),
			"utf8",
		);
		for (const direction of [
			"repair_input",
			"advance_authorized_fallback",
			"recover_and_retry",
			"retry_launch",
			"wait",
			"complete",
			"stop",
		]) {
			ok(readme.includes(`| \`${direction}\` |`), direction);
			ok(invariants.includes(`\`${direction}\``), direction);
		}
		ok(
			readme.includes('"direction":"repair_input|advance_authorized_fallback'),
		);
		ok(
			readme.includes(
				"pure total function of `(action, reasonCode, diagnosticCode)`",
			),
		);
		const inv6 = invariants.slice(invariants.indexOf("### INV-6"));
		ok(
			inv6.includes(
				"pure total function of `(action, reasonCode, diagnosticCode)`",
			),
		);
		ok(inv6.includes("never authorizes, selects, or invokes a route"));
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
