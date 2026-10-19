const AUTH_FAILURE_SIGNATURES = [
	"oauth session expired", // observed: Claude Code, exit 1, on stdout
	"session expired",
	"failed to authenticate",
	"authentication failed",
	"not authenticated",
	"not logged in",
	"please log in",
	"please login",
	"login expired",
	"token expired",
	"credentials expired",
	"re-authenticate",
	// Measured 2026-09-12 in switchyard-golden-6: codex's terminal line when a
	// rotating OAuth refresh token has been spent by another consumer. None of
	// the phrases above appear anywhere in that output, so the operator's FAIL
	// line read `execution_failed` -- "something went wrong" -- for a failure
	// whose only fix is an interactive re-login.
	"refresh token was already used",
];
const QUOTA_FAILURE_SIGNATURES = Object.freeze({
	agy: /individual[\s.,:;_/-]+quota[\s.,:;_/-]+reached\b/i,
	cursor: {
		usage: /out[\s.,:;_/-]+of[\s.,:;_/-]+usage\b/i,
		limit: /your[\s.,:;_/-]+limit\b/i,
	},
});
const MODEL_UNAVAILABLE_SIGNATURES = Object.freeze({
	agy: /is[\s.,:;_/-]+not[\s.,:;_/-]+recognized[\s.,:;_/-]+as[\s.,:;_/-]+a[\s.,:;_/-]+known[\s.,:;_/-]+model[\s.,:;_/-]+or[\s.,:;_/-]+custom[\s.,:;_/-]+model\b/i,
});
export const PERSISTED_ERROR_KINDS = Object.freeze([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"execution_failed",
	"silence_timeout",
	"execution_timed_out",
	"provider_cleanup_failed",
	"diff_capture_failed",
	"declared_path_not_seeded",
	"integration_failed",
	"required_paths_missing",
	"undeclared_paths_touched",
	"empty_diff",
	"empty_required_diff",
	"no_op_diff",
	"manifest_review_required",
	"corrupt_patch",
	"conflict",
	"no_provider",
	"unsupported_provider",
	"launch_failed",
	"result_fetch_failed",
	"run_store_write_failed",
	"orchestrator_timeout",
	"executor_not_switchyard",
	"unknown_failure",
	"unclassified",
	"task_selection_failed",
	"environment_incomplete",
	"project_lock_failed",
	"permission_denied",
	"environment_failure",
	"validation_failed",
	"policy_violation",
	"check_failed",
	"cleanup_failed",
	"unclassified_failure",
	"ambiguous_combined_rename_spelling",
]);
const CLEANUP_STAGE_DIAGNOSTIC_CODES = Object.freeze({
	cleanup_started: "provider_cleanup_after_cleanup_started",
	pid_observed: "provider_cleanup_after_pid_observed",
	tree_terminated: "provider_cleanup_after_tree_terminated",
	pid_marker_removed: "provider_cleanup_after_pid_marker_removed",
	index_lock_removed: "provider_cleanup_after_index_lock_removed",
});
function childProcessText(value) {
	if (typeof value === "string") return value.trim();
	if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
	return "";
}
export function cleanupDiagnosticCodeFor(cleanupStage) {
	return CLEANUP_STAGE_DIAGNOSTIC_CODES[cleanupStage] ?? null;
}
export const CLEANUP_STAGES = Object.freeze(
	new Set(Object.keys(CLEANUP_STAGE_DIAGNOSTIC_CODES)),
);
export const PERSISTED_SIGNALS = new Set([
	"SIGABRT",
	"SIGHUP",
	"SIGINT",
	"SIGKILL",
	"SIGQUIT",
	"SIGTERM",
]);
export {
	AUTH_FAILURE_SIGNATURES,
	CLEANUP_STAGE_DIAGNOSTIC_CODES,
	childProcessText,
	MODEL_UNAVAILABLE_SIGNATURES,
	QUOTA_FAILURE_SIGNATURES,
};
