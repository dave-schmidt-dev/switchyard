import {
	INTEGRATION_REFUSAL_KINDS,
	PRE_PROVIDER_TRIPLE_BY_CODE,
} from "./exec-error-codes.mjs";
import {
	CLEANUP_STAGE_DIAGNOSTIC_CODES,
	PERSISTED_ERROR_KINDS,
} from "./exec-error-kinds.mjs";

const DIAGNOSTIC_ORIGINS = Object.freeze([
	"adapter",
	"launcher",
	"worker_boot",
	"integration",
]);
const DIAGNOSTIC_ORIGIN_SET = new Set(DIAGNOSTIC_ORIGINS);
const ADAPTER_PROVIDER_EXECUTION_CODES = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"provider_exit_nonzero",
	"provider_signalled",
	"execution_timed_out",
	"execution_cancelled",
]);
const ADAPTER_PROVIDER_CLEANUP_CODES = new Set([
	"provider_cleanup_failed",
	...Object.values(CLEANUP_STAGE_DIAGNOSTIC_CODES),
]);
const INTEGRATION_DIAGNOSTIC_CODES = new Set([
	"integration_failed",
	"required_paths_missing",
	"undeclared_paths_touched",
	"empty_required_diff",
	"no_op_diff",
	...INTEGRATION_REFUSAL_KINDS,
]);
export function hasAuthoritativeDiagnosticProvenance({
	diagnosticCode,
	diagnosticOrigin,
	diagnosticEvidenceAvailable,
	failurePhase,
} = {}) {
	if (
		diagnosticEvidenceAvailable !== true ||
		!DIAGNOSTIC_ORIGIN_SET.has(diagnosticOrigin)
	) {
		return false;
	}
	if (diagnosticOrigin === "launcher") {
		return (
			diagnosticCode === "cli_usage_error" &&
			failurePhase === "provider_execution"
		);
	}
	if (diagnosticOrigin === "adapter") {
		return (
			(failurePhase === "provider_execution" &&
				ADAPTER_PROVIDER_EXECUTION_CODES.has(diagnosticCode)) ||
			(failurePhase === "provider_cleanup" &&
				ADAPTER_PROVIDER_CLEANUP_CODES.has(diagnosticCode))
		);
	}
	if (diagnosticOrigin === "worker_boot") {
		const triple = PRE_PROVIDER_TRIPLE_BY_CODE.get(diagnosticCode);
		return Boolean(triple && triple.failurePhase === failurePhase);
	}
	return (
		diagnosticOrigin === "integration" &&
		failurePhase === "adapter_validation" &&
		INTEGRATION_DIAGNOSTIC_CODES.has(diagnosticCode)
	);
}
function trustedLauncherUsageDiagnostic({
	diagnosticCode,
	diagnosticOrigin,
	diagnosticEvidenceAvailable,
	failurePhase,
}) {
	return (
		diagnosticCode === "cli_usage_error" &&
		diagnosticOrigin === "launcher" &&
		diagnosticEvidenceAvailable === true &&
		failurePhase === "provider_execution"
	);
}
const TRUSTED_ADAPTER_DIAGNOSTIC_CODES = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
]);
export function classifyProviderDiagnostic({
	diagnosticCode,
	diagnosticOrigin,
	diagnosticEvidenceAvailable = false,
	failurePhase = "provider_execution",
	exitCode,
	signal,
	timedOut = false,
	cancelled = false,
} = {}) {
	// `cli_usage_error` is intentionally the sole launcher-minted code. It
	// cannot be inferred from text supplied by a provider or task.
	if (
		trustedLauncherUsageDiagnostic({
			diagnosticCode,
			diagnosticOrigin,
			diagnosticEvidenceAvailable,
			failurePhase,
		})
	) {
		return "cli_usage_error";
	}
	if (
		diagnosticOrigin !== "adapter" ||
		diagnosticEvidenceAvailable !== true ||
		failurePhase !== "provider_execution"
	) {
		return null;
	}
	if (cancelled) return "execution_cancelled";
	if (timedOut) return "execution_timed_out";
	if (TRUSTED_ADAPTER_DIAGNOSTIC_CODES.has(diagnosticCode)) {
		return diagnosticCode;
	}
	if (typeof signal === "string" && signal) return "provider_signalled";
	if (Number.isSafeInteger(exitCode) && exitCode !== 0) {
		return "provider_exit_nonzero";
	}
	return null;
}
const PERSISTED_ERROR_METADATA = Object.freeze({
	auth_expired: Object.freeze({
		reasonCode: "auth_expired",
		reason:
			"Provider authentication expired; interactive re-authentication is required.",
	}),
	quota_exhausted: Object.freeze({
		reasonCode: "quota_exhausted",
		reason:
			"Provider quota is exhausted; the target is unavailable for this attempt.",
	}),
	model_unavailable: Object.freeze({
		reasonCode: "model_unavailable",
		reason:
			"The provider CLI did not resolve the dispatched model; its resolvable catalog is stale or incomplete for this attempt.",
	}),
	execution_failed: Object.freeze({
		reasonCode: "execution_failed",
		reason: "Provider execution failed before a reviewed integration.",
	}),
	silence_timeout: Object.freeze({
		reasonCode: "silence_timeout",
		reason:
			"Provider made no substantive progress before the silence deadline.",
	}),
	execution_timed_out: Object.freeze({
		reasonCode: "execution_timed_out",
		reason: "Provider execution exceeded its bounded deadline.",
	}),
	provider_cleanup_failed: Object.freeze({
		reasonCode: "provider_cleanup_failed",
		reason: "Working container cleanup failed after execution timeout.",
	}),
	diff_capture_failed: Object.freeze({
		reasonCode: "diff_capture_failed",
		reason: "Diff capture failed.",
	}),
	declared_path_not_seeded: Object.freeze({
		reasonCode: "declared_path_not_seeded",
		reason:
			"The task declared a Git-ignored path that cannot be seeded or captured.",
	}),
	integration_failed: Object.freeze({
		reasonCode: "integration_failed",
		reason: "The reviewed integration gate rejected the task result.",
	}),
	required_paths_missing: Object.freeze({
		reasonCode: "required_paths_missing",
		reason: "Declared required paths were not touched by the task diff.",
	}),
	undeclared_paths_touched: Object.freeze({
		reasonCode: "undeclared_paths_touched",
		reason:
			"The task diff touched paths not declared in its Files specification.",
	}),
	empty_required_diff: Object.freeze({
		reasonCode: "empty_required_diff",
		reason: "The task required file modifications but produced an empty diff.",
	}),
	no_op_diff: Object.freeze({
		reasonCode: "no_op_diff",
		reason: "The task diff produced no net change in the repository tree.",
	}),
	manifest_review_required: Object.freeze({
		reasonCode: "manifest_review_required",
		reason:
			"The task diff touches execution manifests requiring explicit review.",
	}),
	corrupt_patch: Object.freeze({
		reasonCode: "corrupt_patch",
		reason: "The patch format is corrupt or unparseable by git apply.",
	}),
	conflict: Object.freeze({
		reasonCode: "conflict",
		reason:
			"The patch could not be applied due to conflicting workspace state.",
	}),
	integration_state_unknown: Object.freeze({
		reasonCode: "integration_state_unknown",
		reason:
			"Durable integration evidence cannot prove whether the patch was applied.",
	}),
	empty_diff: Object.freeze({
		reasonCode: "empty_diff",
		reason: "The task produced no diff for the integration gate to review.",
	}),
	path_escapes_project_root: Object.freeze({
		reasonCode: "path_escapes_project_root",
		reason: "The task diff touches a path outside the project root.",
	}),
	git_internals_touched: Object.freeze({
		reasonCode: "git_internals_touched",
		reason: "The task diff touches Git internals under a .git directory.",
	}),
	credential_path_touched: Object.freeze({
		reasonCode: "credential_path_touched",
		reason: "The task diff touches a path matching a credential convention.",
	}),
	symlink_creation_refused: Object.freeze({
		reasonCode: "symlink_creation_refused",
		reason: "The task diff creates a symbolic link.",
	}),
	executable_file_refused: Object.freeze({
		reasonCode: "executable_file_refused",
		reason: "The task diff introduces a file with the executable bit set.",
	}),
	no_provider: Object.freeze({
		reasonCode: "no_provider",
		reason: "No eligible provider was available for this task.",
	}),
	unsupported_provider: Object.freeze({
		reasonCode: "unsupported_provider",
		reason: "The selected provider has no supported execution adapter.",
	}),
	launch_failed: Object.freeze({
		reasonCode: "launch_failed",
		reason: "The headless provider job could not be launched.",
	}),
	result_fetch_failed: Object.freeze({
		reasonCode: "result_fetch_failed",
		reason: "The headless provider result could not be fetched.",
	}),
	run_store_write_failed: Object.freeze({
		reasonCode: "run_store_write_failed",
		reason:
			"Durable run-state persistence failed, so terminal success cannot be trusted.",
	}),
	orchestrator_timeout: Object.freeze({
		reasonCode: "orchestrator_timeout",
		reason: "The headless provider job exceeded its bounded wait.",
	}),
	executor_not_switchyard: Object.freeze({
		reasonCode: "executor_not_switchyard",
		reason: "This task is assigned to a non-Switchyard executor.",
	}),
	unknown_failure: Object.freeze({
		reasonCode: "unknown_failure",
		reason: "The task failed for an unclassified reason.",
	}),
	unclassified: Object.freeze({
		reasonCode: "unclassified",
		reason: "The task failed for an unclassified reason.",
	}),
	task_selection_failed: Object.freeze({
		reasonCode: "task_selection_failed",
		reason: "The requested task selection does not satisfy the queue contract.",
	}),
	environment_incomplete: Object.freeze({
		reasonCode: "environment_incomplete",
		reason: "The selected queue environment did not pass preflight.",
	}),
	project_lock_failed: Object.freeze({
		reasonCode: "project_lock_failed",
		reason: "Project lock acquisition or ownership validation failed.",
	}),
	permission_denied: Object.freeze({
		reasonCode: "permission_denied",
		reason: "Filesystem or environment permission was denied.",
	}),
	environment_failure: Object.freeze({
		reasonCode: "environment_failure",
		reason: "Filesystem or host environment failed.",
	}),
	validation_failed: Object.freeze({
		reasonCode: "validation_failed",
		reason: "Caller contract, input, or schema validation failed.",
	}),
	policy_violation: Object.freeze({
		reasonCode: "policy_violation",
		reason: "Execution policy violation.",
	}),
	check_failed: Object.freeze({
		reasonCode: "check_failed",
		reason: "Task check command failed.",
	}),
	cleanup_failed: Object.freeze({
		reasonCode: "cleanup_failed",
		reason: "Workspace or container cleanup failed.",
	}),
	unclassified_failure: Object.freeze({
		reasonCode: "unclassified_failure",
		reason: "Execution failed with an unclassified error.",
	}),
	ambiguous_combined_rename_spelling: Object.freeze({
		reasonCode: "ambiguous_combined_rename_spelling",
		reason: "Declared path contains ambiguous combined rename syntax.",
	}),
});
const SUCCESS_RESULTS = new Set(["success", "success_no_diff"]);
const RESULT_TO_ERROR_KIND = Object.freeze({
	execution_failed: "execution_failed",
	silence_timeout: "silence_timeout",
	execution_timed_out: "execution_timed_out",
	execution_timed_out_cleanup_failed: "provider_cleanup_failed",
	execution_timed_out_capture_failed: "diff_capture_failed",
	provider_cleanup_failed: "provider_cleanup_failed",
	diff_capture_failed: "diff_capture_failed",
	declared_path_not_seeded: "declared_path_not_seeded",
	integration_failed: "integration_failed",
	required_paths_missing: "required_paths_missing",
	undeclared_paths_touched: "undeclared_paths_touched",
	empty_required_diff: "empty_required_diff",
	no_op_diff: "no_op_diff",
	manifest_review_required: "manifest_review_required",
	corrupt_patch: "corrupt_patch",
	conflict: "conflict",
	integration_state_unknown: "integration_state_unknown",
	empty_diff: "empty_diff",
	path_escapes_project_root: "path_escapes_project_root",
	git_internals_touched: "git_internals_touched",
	credential_path_touched: "credential_path_touched",
	symlink_creation_refused: "symlink_creation_refused",
	executable_file_refused: "executable_file_refused",
	no_provider: "no_provider",
	unsupported_provider: "unsupported_provider",
	launch_failed: "launch_failed",
	result_fetch_failed: "result_fetch_failed",
	run_store_write_failed: "run_store_write_failed",
	orchestrator_timed_out: "orchestrator_timeout",
	orchestrator_timeout: "orchestrator_timeout",
	executor_not_switchyard: "executor_not_switchyard",
	halted_after_commit_failure: "unknown_failure",
	halted_after_reset_failure: "unknown_failure",
	unclassified: "unclassified",
});
function normalizePersistentErrorKind(value) {
	return typeof value === "string" && PERSISTED_ERROR_KINDS.includes(value)
		? value
		: null;
}

export {
	normalizePersistentErrorKind,
	PERSISTED_ERROR_METADATA,
	RESULT_TO_ERROR_KIND,
	SUCCESS_RESULTS,
};
