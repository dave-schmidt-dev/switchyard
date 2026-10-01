import { createProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import { extractErrno } from "./overlay.mjs";

const VERIFIED_PROVIDER_CODES = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"cli_usage_error",
	"execution_timed_out",
	"provider_signalled",
]);

function phaseForFailure(phase) {
	if (phase === "execute") return "provider";
	if (phase === "checks") return "check";
	return phase;
}

function failureCode(reason, phase, providerResult) {
	if (phase === "baseline")
		return reason === "baseline_mutation"
			? "baseline_mutation"
			: "baseline_check_failed";
	if (reason === "provider_cancelled") return "cancelled";
	if (
		phase === "execute" &&
		VERIFIED_PROVIDER_CODES.has(providerResult?.diagnosticCode) &&
		["adapter", "launcher"].includes(providerResult?.diagnosticOrigin) &&
		providerResult?.diagnosticEvidenceAvailable === true
	)
		return providerResult.diagnosticCode;
	if (reason === "provider_exit_nonzero") return "provider_exit_nonzero";
	if (reason === "check_failed") return "acceptance_check_failed";
	if (
		reason === "check_deadline_exceeded" ||
		reason === "check_silence_timeout"
	)
		return "acceptance_check_timeout";
	if (reason === "check_repair_succeeded") return "check_repair_succeeded";
	if (reason === "check_repair_failed") return "check_repair_failed";
	if (reason === "empty_diff") return "diff_rejected";
	if (
		[
			"undeclared_paths_changed",
			"read_only_input_changed",
			"unsafe_diff",
			"manifest_review_required",
			"dirty_overlay_drift",
			"project_head_changed_concurrently",
			"declared_path_changed_concurrently",
		].includes(reason)
	)
		return "scope_rejected";
	if (reason === "provider_cleanup_failed" || phase === "cleanup")
		return "cleanup_failed";
	if (reason === "run_store_write_failed") return "run_store_write_failed";
	if (phase === "input_validation") return "input_rejected";
	if (phase === "execute") return "unknown";
	return "unknown";
}

function diffCategory(reason) {
	if (reason === "empty_diff") return "empty";
	if (reason === "undeclared_paths_changed") return "undeclared";
	if (reason === "read_only_input_changed") return "read_only_input";
	if (reason === "manifest_review_required") return "manifest_review";
	if (reason === "unsafe_diff") return "unsafe";
	if (reason === "declared_path_changed_concurrently")
		return "concurrent_change";
	if (reason === "integration_failed") return "integration";
	return null;
}

export function createSimpleProviderReliabilityDiagnostic(input = {}) {
	const reason = input.failureReason ?? null;
	const failurePhase = input.failurePhase ?? "unknown";
	const code = failureCode(reason, failurePhase, input.providerResult);
	const category = diffCategory(reason);
	return createProviderReliabilityDiagnostic({
		causeCode: code,
		phase: phaseForFailure(failurePhase),
		exitCode: input.exitCode ?? input.providerResult?.code,
		signal: input.signal ?? input.providerResult?.signal,
		timedOut: input.timedOut ?? input.providerResult?.timedOut,
		cancelled:
			input.cancelled ??
			(input.providerResult?.cancelled === true ||
			input.providerResult?.cancelled === false
				? input.providerResult.cancelled
				: null),
		checkIndex: input.checkIndex,
		checkIdentity: input.checkIdentity,
		baselineStatus: input.baselineStatus,
		diffRejectionCategory: input.diffRejectionCategory ?? category,
		diffRejectionCount: input.diffRejectionCount,
		repairCount: input.repairCount,
		repairStatus: input.repairStatus,
	});
}

export function classifySimpleErrorKind(
	failureReason,
	failurePhase,
	error = null,
) {
	const errno =
		extractErrno(error) ??
		(typeof failureReason === "string" && /^[A-Z0-9]+$/u.test(failureReason)
			? failureReason
			: null);
	if (errno === "EPERM" || errno === "EACCES") return "permission_denied";
	if (
		[
			"EROFS",
			"ENOSPC",
			"EMFILE",
			"ENFILE",
			"EIO",
			"EDQUOT",
			"ETIMEDOUT",
			"ECONNREFUSED",
			"ENETUNREACH",
			"ENETDOWN",
		].includes(errno)
	)
		return "environment_failure";
	if (failureReason === "run_store_write_failed")
		return "run_store_write_failed";
	if (failurePhase === "baseline") return "environment_failure";
	if (
		[
			"paid_overage_not_allowed",
			"included_usage_unverified",
			"ambiguous_combined_rename_spelling",
		].includes(failureReason)
	)
		return "policy_violation";
	if (failureReason === "manifest_review_required")
		return failurePhase === "input_validation"
			? "validation_failed"
			: "policy_violation";
	if (failureReason === "empty_diff") return "empty_diff";
	if (
		[
			"invalid_invocation",
			"predecessor_receipt_invalid",
			"predecessor_receipt_missing",
			"predecessor_receipt_mismatch",
			"predecessor_receipt_unverified",
		].includes(failureReason) ||
		(failureReason?.startsWith("dirty_overlay_") &&
			failureReason !== "dirty_overlay_drift")
	)
		return "validation_failed";
	if (
		[
			"dirty_overlay_drift",
			"project_head_changed_concurrently",
			"declared_path_changed_concurrently",
			"read_only_input_changed",
			"undeclared_paths_changed",
			"unsafe_diff",
			"integration_failed",
		].includes(failureReason)
	)
		return "policy_violation";
	if (
		failurePhase === "checks" ||
		[
			"check_failed",
			"check_deadline_exceeded",
			"check_silence_timeout",
		].includes(failureReason)
	)
		return "check_failed";
	if (
		[
			"provider_cleanup_failed",
			"worktree_cleanup_failed",
			"project_lock_release_unconfirmed",
		].includes(failureReason) ||
		failurePhase === "cleanup"
	)
		return "cleanup_failed";
	if (
		[
			"provider_silence_timeout",
			"provider_deadline_exceeded",
			"provider_cancelled",
			"provider_signalled",
			"provider_adapter_error",
			"provider_result_inconsistent",
			"provider_exit_nonzero",
			"provider_launch_failed",
		].includes(failureReason) ||
		failurePhase === "execute"
	)
		return "execution_failed";
	if (failureReason === "deadline_expired") {
		if (["preflight", "input_validation"].includes(failurePhase))
			return "validation_failed";
		if (failurePhase === "execute") return "execution_failed";
		if (failurePhase === "checks") return "check_failed";
		if (failurePhase === "cleanup") return "cleanup_failed";
		return "policy_violation";
	}
	if (
		[
			"project_revision_unavailable",
			"workspace_clone_failed",
			"workspace_checkout_failed",
			"dirty_overlay_stage_failed",
			"dirty_overlay_baseline_failed",
		].includes(failureReason)
	)
		return "environment_failure";
	if (failurePhase === "input_validation") return "validation_failed";
	return "unclassified_failure";
}
