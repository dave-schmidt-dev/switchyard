/** Frozen historical vocabulary for the consolidated failure decisions. */

export const VERIFIED_PROVIDER_CODES = new Set([
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

export const ENVIRONMENT_ERRNOS = [
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

export const LAUNCHER_ENVIRONMENT_REASONS = [
	"launcher_environment_unavailable",
	"request_log_open_failed",
	// S7: the target's CLI no longer honors its lane contract.
	"provider_cli_contract_failed",
];

export const POLICY_REASONS = [
	"paid_overage_not_allowed",
	"included_usage_unverified",
	"ambiguous_combined_rename_spelling",
];

export const VALIDATION_REASONS = [
	"invalid_invocation",
	"check_out_of_clone_exec",
	"check_tool_denied",
	"predecessor_receipt_invalid",
	"predecessor_receipt_missing",
	"predecessor_receipt_mismatch",
	"predecessor_receipt_unverified",
];

export const SCOPE_REASONS = [
	"dirty_overlay_drift",
	"project_head_changed_concurrently",
	"declared_path_changed_concurrently",
	"read_only_input_changed",
	"undeclared_paths_changed",
	"unsafe_diff",
	"integration_failed",
];

export const CHECK_REASONS = [
	"check_failed",
	"check_deadline_exceeded",
	"check_silence_timeout",
];

export const CLEANUP_REASONS = [
	"provider_cleanup_failed",
	"worktree_cleanup_failed",
	"project_lock_release_unconfirmed",
];

export const PROVIDER_EXECUTION_REASONS = [
	"provider_silence_timeout",
	"provider_deadline_exceeded",
	"provider_cancelled",
	"provider_signalled",
	"provider_adapter_error",
	"provider_result_inconsistent",
	"provider_exit_nonzero",
	"provider_launch_failed",
];

// Host git could not stage, list or read the candidate's changes, so no
// reason about the diff itself can be given.
export const DIFF_CAPTURE_REASONS = [
	"diff_stage_failed",
	"diff_names_failed",
	"diff_capture_failed",
];

// Phases whose deadline already resolves to a phase-specific cause.
export const DEADLINE_CAUSE_PHASES = [
	"preflight",
	"input_validation",
	"execute",
	"checks",
	"check",
	"cleanup",
];

export const ENVIRONMENT_REASONS = [
	"project_revision_unavailable",
	"workspace_clone_failed",
	"workspace_checkout_failed",
	"dirty_overlay_stage_failed",
	"dirty_overlay_baseline_failed",
	...DIFF_CAPTURE_REASONS,
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
	// The disposable checkout vanished under a live run (2026-10-09: a shared
	// $TMPDIR wipe). An outside deletion is not the provider's fault, and a
	// retry would race the same deletion, so the routing run stops.
	"worktree_missing",
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
export const CLOSED_CAUSE_CODES = new Map([
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
	["worktree_missing", "worktree_missing"],
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
