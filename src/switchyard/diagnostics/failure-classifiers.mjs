/**
 * Frozen pre-registry failure classifiers.
 *
 * The reason groups and classifier chains below reproduce the classifiers
 * that predate the failure registry, plus the closed-code rules, so
 * failure-registry.mjs can build its rows from them and the golden parity
 * test can pin every row. Pure functions; no I/O, no mutation.
 */

const VERIFIED_PROVIDER_CODES = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"cli_usage_error",
	"execution_timed_out",
	"provider_signalled",
]);

const PROVIDER_DIAGNOSTIC_CODES = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"cli_usage_error",
	"execution_timed_out",
]);

export const PROVIDER_CAUSED_REASONS = new Set([
	...PROVIDER_DIAGNOSTIC_CODES,
	"provider_signalled",
	"provider_silence_timeout",
	"provider_deadline_exceeded",
	"provider_cancelled",
	"provider_exit_nonzero",
	"provider_cleanup_failed",
	"provider_adapter_error",
	"provider_result_inconsistent",
	"provider_launch_failed",
	"provider_group_unconfirmed",
	"provider_verdict_rejected",
]);

const ENVIRONMENT_ERRNOS = [
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
];

const LAUNCHER_ENVIRONMENT_REASONS = [
	"launcher_environment_unavailable",
	"request_log_open_failed",
];

const POLICY_REASONS = [
	"paid_overage_not_allowed",
	"included_usage_unverified",
	"ambiguous_combined_rename_spelling",
];

const VALIDATION_REASONS = [
	"invalid_invocation",
	"check_out_of_clone_exec",
	"check_tool_denied",
	"predecessor_receipt_invalid",
	"predecessor_receipt_missing",
	"predecessor_receipt_mismatch",
	"predecessor_receipt_unverified",
];

const SCOPE_REASONS = [
	"dirty_overlay_drift",
	"project_head_changed_concurrently",
	"declared_path_changed_concurrently",
	"read_only_input_changed",
	"undeclared_paths_changed",
	"unsafe_diff",
	"integration_failed",
];

const CHECK_REASONS = [
	"check_failed",
	"check_deadline_exceeded",
	"check_silence_timeout",
];

const CLEANUP_REASONS = [
	"provider_cleanup_failed",
	"worktree_cleanup_failed",
	"project_lock_release_unconfirmed",
];

const PROVIDER_EXECUTION_REASONS = [
	"provider_silence_timeout",
	"provider_deadline_exceeded",
	"provider_cancelled",
	"provider_signalled",
	"provider_adapter_error",
	"provider_result_inconsistent",
	"provider_exit_nonzero",
	"provider_launch_failed",
];

const ENVIRONMENT_REASONS = [
	"project_revision_unavailable",
	"workspace_clone_failed",
	"workspace_checkout_failed",
	"dirty_overlay_stage_failed",
	"dirty_overlay_baseline_failed",
];

export const DIFF_CAUSE_REASONS = [
	"undeclared_paths_changed",
	"read_only_input_changed",
	"unsafe_diff",
	"manifest_review_required",
	"dirty_overlay_drift",
	"project_head_changed_concurrently",
	"declared_path_changed_concurrently",
];

export const SNAPSHOT_BASELINE_CODES = new Set([
	"baseline_check_failed",
	"baseline_check_unavailable",
	"baseline_mutation",
	// Task 2.7: baseline only before the provider starts; the registry escalates
	// a post-provider dependency refusal to hard by phase.
	"check_dependencies_unverified",
	// Task 2.3: a check-session setup failure precedes any baseline check, so it
	// stops the waterfall like a baseline failure without claiming one ran.
	"check_setup_failed",
	// Task 2.4: a check that cannot run here fails every provider the same way.
	"check_environment_failed",
]);
export const SNAPSHOT_HARD_CODES = new Set([
	"run_store_write_failed",
	"project_lock_failed",
	// Task 2.7: a candidate changed the dependency manifest the checks run
	// against, so the run stops instead of blaming the host baseline.
	"check_manifest_changed_by_diff",
]);
export const SNAPSHOT_HARD_UNTYPED = new Set([
	...SNAPSHOT_HARD_CODES,
	"cleanup_failed",
	"provider_cleanup_failed",
	"provider_cancelled",
	"cancelled",
]);
export const SNAPSHOT_CHECK_CODES = new Set([
	"acceptance_check_failed",
	"acceptance_check_timeout",
	"check_repair_failed",
]);

/**
 * Closed cause codes for every reason that previously fell through the
 * classifier chain to `unknown`. Phase-specific matches (errno, baseline,
 * cleanup, validation) still win; the closed code only replaces the
 * would-be-unknown fallthrough.
 */
const CLOSED_CAUSE_CODES = new Map([
	["provider_silence_timeout", "provider_silence_timeout"],
	["provider_signalled", "provider_signalled"],
	["provider_adapter_error", "provider_adapter_error"],
	["provider_launch_failed", "provider_launch_failed"],
	["provider_result_inconsistent", "provider_result_inconsistent"],
	["provider_group_unconfirmed", "provider_group_unconfirmed"],
	["provider_verdict_rejected", "provider_verdict_rejected"],
	["simple_execution_failed", "simple_execution_failed"],
	["check_group_unconfirmed", "check_group_unconfirmed"],
	["check_session_cleanup_failed", "check_session_cleanup_failed"],
	["check_environment_unavailable", "check_environment_unavailable"],
	["check_candidate_rejected", "check_candidate_rejected"],
	["check_session_base_mismatch", "check_session_base_mismatch"],
	["check_session_unavailable", "check_session_unavailable"],
	["project_lock_release_unconfirmed", "project_lock_release_unconfirmed"],
	["project_lock_failed", "project_lock_failed"],
	["project_lock_owner_live", "project_lock_owner_live"],
	["project_lock_owner_dead", "project_lock_owner_dead"],
	["declared_path_has_owner_edits", "declared_path_has_owner_edits"],
	["worktree_allocation_failed", "worktree_allocation_failed"],
	["worktree_ownership_failed", "worktree_ownership_failed"],
	["git_control_tampered", "git_control_tampered"],
	["target_identity_unavailable", "target_identity_unavailable"],
	["invocation_descriptor_unavailable", "invocation_descriptor_unavailable"],
	["local_descriptor_model_unavailable", "local_descriptor_model_unavailable"],
	["local_descriptor_args_unsafe", "local_descriptor_args_unsafe"],
	// Task 2.3: every route-selection dead end shares one closed code.
	["no_eligible", "no_route_available"],
	["no_eligible_provider", "no_route_available"],
	["route_health_blocked", "no_route_available"],
	["local_adapter_unavailable", "no_route_available"],
	["routing_selection_invalid", "no_route_available"],
	// Task 2.3: every bridge request-ledger error shares one closed code.
	["request_event_end_invalid", "request_evidence_invalid"],
	["request_event_end_missing", "request_evidence_invalid"],
	["request_event_truncated", "request_evidence_invalid"],
	["request_event_invalid", "request_evidence_invalid"],
	["request_event_after_end", "request_evidence_invalid"],
	["request_event_line_too_long", "request_evidence_invalid"],
	["request_event_write_failed", "request_evidence_invalid"],
	["request_event_close_failed", "request_evidence_invalid"],
]);

/**
 * Pre-change error-kind classifier, copied verbatim from reliability.mjs.
 * The registry snapshot must reproduce these outputs exactly.
 */
export function snapshotErrorKind(failureReason, failurePhase, errno) {
	if (errno === "EPERM" || errno === "EACCES") return "permission_denied";
	if (ENVIRONMENT_ERRNOS.includes(errno)) return "environment_failure";
	if (LAUNCHER_ENVIRONMENT_REASONS.includes(failureReason))
		return "environment_failure";
	if (failureReason === "run_store_write_failed")
		return "run_store_write_failed";
	if (failurePhase === "baseline") return "environment_failure";
	if (failureReason === "check_dependencies_unverified")
		return "environment_failure";
	// Task 2.3: a failure while preparing the check session is environmental.
	if (failureReason === "check_setup_failed") return "environment_failure";
	// Task 2.4: a check that cannot run in this environment.
	if (failureReason === "check_environment_failed")
		return "environment_failure";
	// Task 3.2: the host moved under the run; that is the environment's fault.
	if (failureReason === "host_concurrency") return "environment_failure";
	// Task 2.7: a dependency manifest changed by the candidate's own diff is a
	// check fact, not an environment fault.
	if (failureReason === "check_manifest_changed_by_diff") return "check_failed";
	if (POLICY_REASONS.includes(failureReason)) return "policy_violation";
	if (failureReason === "manifest_review_required")
		return failurePhase === "input_validation"
			? "validation_failed"
			: "policy_violation";
	if (failureReason === "empty_diff") return "empty_diff";
	if (
		VALIDATION_REASONS.includes(failureReason) ||
		(failureReason?.startsWith("dirty_overlay_") &&
			failureReason !== "dirty_overlay_drift")
	)
		return "validation_failed";
	if (SCOPE_REASONS.includes(failureReason)) return "policy_violation";
	if (failurePhase === "checks" || CHECK_REASONS.includes(failureReason))
		return "check_failed";
	if (CLEANUP_REASONS.includes(failureReason) || failurePhase === "cleanup")
		return "cleanup_failed";
	if (
		PROVIDER_EXECUTION_REASONS.includes(failureReason) ||
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
	if (ENVIRONMENT_REASONS.includes(failureReason)) return "environment_failure";
	if (failurePhase === "input_validation") return "validation_failed";
	return "unclassified_failure";
}

/**
 * Cause-code classifier: the frozen pre-registry chain plus the closed-code
 * rules. A cancelled provider result resolves to `cancelled` for any reason;
 * a timed-out provider result resolves to `provider_deadline_exceeded` (a
 * timed-out check to `acceptance_check_timeout`) when no more specific rule
 * matched; and the closed-code table replaces the would-be-unknown
 * fallthrough for every reason that used to land there.
 */
export function snapshotCauseCode(
	reason,
	phase,
	providerResult,
	errorKind,
	cancelled = false,
	timedOut = false,
) {
	if (cancelled) return "cancelled";
	// Task 3.2: a genuine host-concurrency conflict is an environment stop,
	// never a scope/policy rejection by the provider.
	if (reason === "host_concurrency") return "host_concurrency";
	if (LAUNCHER_ENVIRONMENT_REASONS.includes(reason))
		return "environment_failure";
	if (reason === "run_store_write_failed") return "run_store_write_failed";
	if (reason === "check_dependencies_unverified") return reason;
	// Task 2.3: wins over the generic environment_failure rule below.
	if (reason === "check_setup_failed") return reason;
	if (reason === "check_environment_failed") return reason;
	// Task 2.7: a candidate-changed dependency manifest has its own check cause.
	if (reason === "check_manifest_changed_by_diff") return reason;
	if (phase === "baseline") {
		if (reason === "baseline_mutation") return "baseline_mutation";
		if (reason === "baseline_check_unavailable")
			return "baseline_check_unavailable";
		return "baseline_check_failed";
	}
	if (["environment_failure", "permission_denied"].includes(errorKind))
		return "environment_failure";
	if (reason === "provider_cancelled") return "cancelled";
	if (reason === "provider_deadline_exceeded")
		return "provider_deadline_exceeded";
	if (timedOut) {
		if (
			phase === "checks" ||
			phase === "check" ||
			CHECK_REASONS.includes(reason)
		)
			return "acceptance_check_timeout";
		return "provider_deadline_exceeded";
	}
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
	if (DIFF_CAUSE_REASONS.includes(reason)) return "scope_rejected";
	if (reason === "provider_cleanup_failed" || phase === "cleanup")
		return "cleanup_failed";
	if (errorKind === "policy_violation") return "scope_rejected";
	if (phase === "input_validation" || errorKind === "validation_failed")
		return "input_rejected";
	if (reason === "deadline_expired") {
		if (phase === "execute") return "provider_deadline_exceeded";
		if (phase === "checks" || phase === "check")
			return "acceptance_check_timeout";
	}
	return CLOSED_CAUSE_CODES.get(reason) ?? "unknown";
}

/** Pre-change diff category classifier, copied verbatim from reliability.mjs. */
export function snapshotDiffCategory(reason) {
	if (reason === "empty_diff") return "empty";
	if (reason === "undeclared_paths_changed") return "undeclared";
	if (reason === "read_only_input_changed") return "read_only_input";
	if (reason === "manifest_review_required") return "manifest_review";
	if (reason === "unsafe_diff") return "unsafe";
	if (reason === "declared_path_changed_concurrently")
		return "concurrent_change";
	// Integrate-phase scope rejections keep a category instead of falling
	// through to null, so a drift or concurrent-head stop is tunable.
	if (reason === "dirty_overlay_drift") return "concurrent_change";
	if (reason === "project_head_changed_concurrently")
		return "concurrent_change";
	if (reason === "host_concurrency") return "concurrent_change";
	if (reason === "ambiguous_combined_rename_spelling") return "integration";
	if (reason === "integration_failed") return "integration";
	return null;
}

/** Pre-change attempt severity bucket (first-match-wins), from failure-severity. */
export function snapshotSeverity(
	reason,
	phase,
	causeCode,
	causeCategory,
	errorKind,
) {
	if (
		phase === "baseline" ||
		SNAPSHOT_BASELINE_CODES.has(causeCode) ||
		SNAPSHOT_BASELINE_CODES.has(reason)
	)
		return "baseline";
	if (
		["cleanup", "cancellation", "input"].includes(causeCategory) ||
		SNAPSHOT_HARD_CODES.has(causeCode) ||
		SNAPSHOT_HARD_UNTYPED.has(errorKind) ||
		SNAPSHOT_HARD_UNTYPED.has(reason) ||
		phase === "cleanup"
	)
		return "hard";
	return "soft";
}
