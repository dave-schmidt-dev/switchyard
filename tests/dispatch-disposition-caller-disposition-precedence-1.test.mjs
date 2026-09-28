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
		["integration_failed", "empty_diff", "advance_authorized_fallback"],
		[
			"integration_failed",
			"empty_required_diff",
			"advance_authorized_fallback",
		],
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
