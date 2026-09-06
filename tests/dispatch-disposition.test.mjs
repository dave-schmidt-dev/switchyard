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

function targetDisposition({
	errorKind,
	diagnosticCode = errorKind,
	failurePhase = "provider_execution",
	retryConsumed = false,
	optionalEvidenceValid = true,
}) {
	const cleanupCodes = new Set([
		"provider_cleanup_failed",
		"provider_cleanup_after_cleanup_started",
		"provider_cleanup_after_pid_observed",
		"provider_cleanup_after_tree_terminated",
		"provider_cleanup_after_pid_marker_removed",
		"provider_cleanup_after_index_lock_removed",
	]);
	const integrationCodes = new Set([
		"integration_failed",
		"required_paths_missing",
		"undeclared_paths_touched",
		"empty_required_diff",
		"no_op_diff",
		"manifest_review_required",
		"corrupt_patch",
		"conflict",
		"empty_diff",
		"path_escapes_project_root",
		"git_internals_touched",
		"credential_path_touched",
		"symlink_creation_refused",
		"executable_file_refused",
	]);
	const provenance =
		diagnosticCode === "cli_usage_error"
			? { diagnosticOrigin: "launcher", failurePhase: "provider_execution" }
			: cleanupCodes.has(diagnosticCode)
				? { diagnosticOrigin: "adapter", failurePhase: "provider_cleanup" }
				: integrationCodes.has(diagnosticCode)
					? {
							diagnosticOrigin: "integration",
							failurePhase: "adapter_validation",
						}
					: { diagnosticOrigin: "adapter", failurePhase };
	const exact = exactFailure("codex/standard");
	Object.assign(exact, {
		errorKind,
		reasonCode: errorKind,
		diagnosticCode,
		...provenance,
	});
	return projectDisposition({
		run: run({
			state: "failed",
			cleanupState: "complete",
			lastFailure: failure({
				errorKind,
				reasonCode: errorKind,
				diagnosticCode,
				...provenance,
				resolvedTargetId: exact.resolvedTargetId,
				descriptorIdentity: exact.descriptorIdentity,
				descriptorHarness: exact.descriptorHarness,
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

	it("stops when trusted failures span tasks without a current task context", () => {
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
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
		strictEqual(result.taskId, null);
		deepStrictEqual(result.failedTargetIds, []);
	});

	it("uses the current checkpoint task instead of historical task order", () => {
		const current = exactFailure("opencode-go", "10.1");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				currentTaskId: null,
				lastFailure: failure({
					taskId: "10.1",
					resolvedTargetId: current.resolvedTargetId,
					descriptorIdentity: current.descriptorIdentity,
					descriptorHarness: current.descriptorHarness,
				}),
			}),
			checkpoint: {
				lastTaskId: "10.1",
				retryAttempts: [current, exactFailure("opencode-go", "2.1")],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "target_failed");
		strictEqual(result.taskId, "10.1");
		deepStrictEqual(result.failedTargetIds, ["opencode-go"]);
	});

	it("does not authorize a current failure from legacy-only historical evidence", () => {
		const legacy = exactFailure("vibe", "1.1");
		delete legacy.diagnosticOrigin;
		delete legacy.diagnosticEvidenceAvailable;
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				currentTaskId: null,
				lastFailure: failure({
					taskId: "1.2",
					resolvedTargetId: "opencode-go",
					descriptorIdentity: `sha256:${"b".repeat(64)}`,
					descriptorHarness: "opencode",
				}),
			}),
			checkpoint: {
				lastTaskId: "1.2",
				completedTaskIds: ["1.1"],
				retryAttempts: [legacy],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
		strictEqual(result.taskId, null);
		deepStrictEqual(result.failedTargetIds, []);
	});

	it("excludes trusted completed-task evidence without mutating the checkpoint", () => {
		const completed = exactFailure("vibe", "1.1");
		const checkpoint = {
			lastTaskId: "1.2",
			completedTaskIds: ["1.1"],
			retryAttempts: [completed],
		};
		const snapshot = structuredClone(checkpoint);
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				currentTaskId: null,
				lastFailure: failure({ taskId: "1.2" }),
			}),
			checkpoint,
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		deepStrictEqual(result.failedTargetIds, []);
		deepStrictEqual(checkpoint, snapshot);
	});

	it("keeps all trusted current-task attempts after matching the terminal route", () => {
		const terminal = exactFailure("opencode-go", "1.2");
		terminal.descriptorHarness = "opencode";
		const priorAttempt = exactFailure("agy-gemini", "1.2");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				currentTaskId: null,
				lastFailure: failure({
					taskId: "1.2",
					resolvedTargetId: terminal.resolvedTargetId,
					descriptorIdentity: terminal.descriptorIdentity,
					descriptorHarness: terminal.descriptorHarness,
				}),
			}),
			checkpoint: {
				lastTaskId: "1.2",
				completedTaskIds: ["1.1"],
				retryAttempts: [priorAttempt, terminal],
				results: [exactFailure("vibe", "1.1")],
			},
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "target_failed");
		strictEqual(result.taskId, "1.2");
		deepStrictEqual(result.failedTargetIds, ["agy-gemini", "opencode-go"]);
	});

	it("stops when terminal and checkpoint task contexts disagree", () => {
		const current = exactFailure("opencode-go", "1.2");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: failure({ taskId: "1.3" }),
			}),
			checkpoint: { lastTaskId: "1.2", retryAttempts: [current] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
		deepStrictEqual(result.failedTargetIds, []);
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

describe("closed caller direction", () => {
	const targetMappings = [
		["auth_expired", "auth_expired", "stop"],
		["quota_exhausted", "quota_exhausted", "advance_authorized_fallback"],
		["model_unavailable", "model_unavailable", "stop"],
		["execution_failed", "cli_usage_error", "repair_input"],
		[
			"execution_failed",
			"provider_exit_nonzero",
			"advance_authorized_fallback",
		],
		["execution_failed", "provider_signalled", "advance_authorized_fallback"],
		["execution_timed_out", "execution_timed_out", "stop"],
		["execution_timed_out", "execution_cancelled", "stop"],
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

	it("fails unminted target tuples closed", () => {
		for (const [errorKind, diagnosticCode] of [
			["execution_failed", "execution_failed"],
			["execution_failed", "provider_output_unclassified"],
			["diff_capture_failed", "diff_capture_failed"],
			["provider_cleanup_failed", "provider_cleanup_failed"],
			["provider_cleanup_failed", "provider_cleanup_after_pid_marker_removed"],
			["integration_failed", "declared_path_not_seeded"],
			["required_paths_missing", "required_paths_missing"],
			["integration_failed", "credential_path_touched"],
			["integration_failed", "unknown_closed_diagnostic"],
		]) {
			const result = targetDisposition({ errorKind, diagnosticCode });
			strictEqual(result.action, "stop", diagnosticCode);
			strictEqual(result.direction, "stop", diagnosticCode);
			strictEqual(result.reasonCode, "insufficient_evidence", diagnosticCode);
		}
	});

	it("does not let a legacy closed label authorize a new fallback", () => {
		const exact = exactFailure("codex/standard");
		const result = projectDisposition({
			run: run({
				state: "failed",
				cleanupState: "complete",
				lastFailure: {
					errorKind: "execution_failed",
					reasonCode: "execution_failed",
					reason: "closed",
					diagnosticCode: "provider_exit_nonzero",
					failurePhase: "provider_execution",
				},
			}),
			checkpoint: { retryAttempts: [exact] },
			liveness: "terminal_clean",
		});
		strictEqual(result.action, "stop");
		strictEqual(result.reasonCode, "insufficient_evidence");
	});

	it("uses the underlying closed failure when retry_consumed is reachable", () => {
		for (const [errorKind, diagnosticCode, direction] of [
			["quota_exhausted", "quota_exhausted", "advance_authorized_fallback"],
			["auth_expired", "auth_expired", "stop"],
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
					lastFailure: failure({
						diagnosticCode,
						diagnosticOrigin: "worker_boot",
						failurePhase: "worker_boot",
					}),
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
					lastFailure: failure({
						diagnosticCode,
						diagnosticOrigin: "worker_boot",
						failurePhase: "project_lock",
					}),
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
				lastFailure: failure({
					diagnosticCode: "vm_slot_unavailable",
					diagnosticOrigin: "worker_boot",
					failurePhase: "queue_preflight",
				}),
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
					diagnosticOrigin: "worker_boot",
					failurePhase: "queue_preflight",
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
			"queue_contract_invalid",
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
			strictEqual(result.diagnosticCode, code);
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
			targetDisposition({
				errorKind: "execution_failed",
				diagnosticCode: "provider_exit_nonzero",
			}).direction,
			projectDisposition({
				run: run({
					state: "failed",
					cleanupState: "complete",
					lastFailure: failure({
						diagnosticCode: "project_lock_held",
						diagnosticOrigin: "worker_boot",
						failurePhase: "project_lock",
					}),
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
			"deferred work",
			run({
				state: "deferred",
				cleanupState: "complete",
				terminalSummary: summary(0),
			}),
			"deferred_work",
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
