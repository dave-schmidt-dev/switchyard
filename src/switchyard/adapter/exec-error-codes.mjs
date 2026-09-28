import {
	CLEANUP_STAGE_DIAGNOSTIC_CODES,
	prlctlFailureMetadata,
	workerBootStageDiagnosticCode,
} from "./exec-error-kinds.mjs";
export const INTEGRATION_REFUSAL_KINDS = Object.freeze([
	"empty_diff",
	"path_escapes_project_root",
	"git_internals_touched",
	"credential_path_touched",
	"symlink_creation_refused",
	"executable_file_refused",
	"manifest_review_required",
	"corrupt_patch",
	"conflict",
	"integration_state_unknown",
	"ambiguous_combined_rename_spelling",
]);
export const PERSISTED_DIAGNOSTIC_CODES = Object.freeze([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"cli_usage_error",
	"provider_exit_nonzero",
	"provider_signalled",
	"provider_output_unclassified",
	"execution_timed_out",
	"execution_cancelled",
	"provider_cleanup_failed",
	...Object.values(CLEANUP_STAGE_DIAGNOSTIC_CODES),
	"diff_capture_failed",
	"run_store_write_failed",
	// The codes `taskBaseReleaseDiagnosticCode()` computes. Without them the
	// sanitizer's closed filter silently dropped `diagnosticCode`, so every
	// release failure recorded the same generic `diff_capture_failed` /
	// "Diff capture failed." — which is how a Parallels job misfire spent a
	// session looking like a provider or capture defect. These are fixed enum
	// strings switchyard derives from an error's own shape, never provider
	// output, so INV-2 is untouched.
	"task_base_release_ownership_invalid",
	"task_base_release_marker_invalid",
	"task_base_release_aborted",
	"task_base_release_timed_out",
	"task_base_release_transport_lost",
	"task_base_release_failed",
	"declared_path_not_seeded",
	"integration_failed",
	"required_paths_missing",
	"undeclared_paths_touched",
	"empty_required_diff",
	"no_op_diff",
	"manifest_review_required",
	"corrupt_patch",
	"conflict",
	"integration_state_unknown",
	"empty_diff",
	"path_escapes_project_root",
	"git_internals_touched",
	"credential_path_touched",
	"symlink_creation_refused",
	"executable_file_refused",
	"worker_nonce_mismatch",
	"worker_fingerprint_mismatch",
	"worker_contract_unsupported",
	"worker_boot_exception",
	"clone_hardening_failed",
	"workspace_prepare_failed",
	"vm_admission_permission_denied",
	"vm_admission_storage_failed",
	"vm_admission_unavailable",
	"vm_slot_unavailable",
	"vm_host_inventory_permission_denied",
	"vm_host_inventory_unavailable",
	"vm_host_service_degraded",
	"prlctl_job_misfire",
	"prlctl_session_not_ready",
	"prlctl_call_timed_out",
	"prlctl_call_failed",
	"recovery_incomplete",
	"checkpoint_task_file_mismatch",
	"checkpoint_tasks_file_mismatch",
	"checkpoint_missing_queue_identity",
	"checkpoint_queue_identity_missing",
	"checkpoint_queue_identity_mismatch",
	"checkpoint_run_options_mismatch",
	"checkpoint_historical_checkpoint",
	"checkpoint_historical_state",
	"task_selection_failed",
	"environment_incomplete",
	// A run that ends `failed` must say why. These two name the cases where the
	// answer used to be nothing at all: the queue resolving without a result and
	// without throwing, and a failed task result carrying no classifiable
	// metadata. Both previously produced `lastFailure: null` on a failed run.
	"queue_returned_no_result",
	"terminal_without_failure_metadata",
	"project_lock_held",
	"project_lock_recovery_in_progress",
	"project_lock_ownership_failed",
	"project_lock_ownership_displaced",
	"project_lock_claim_cleanup_failed",
	"project_lock_recovery_claim_blocks_execution",
	"ambiguous_combined_rename_spelling",
	"permission_denied",
	"environment_failure",
	"validation_failed",
	"policy_violation",
	"check_failed",
	"cleanup_failed",
	"unclassified_failure",
	"run_store_write_failed",
]);
const PERSISTED_FAILURE_PHASES = new Set([
	"adapter_validation",
	"provider_execution",
	"provider_cleanup",
	"terminal_reconciliation",
	"worker_boot",
	"task_selection",
	"queue_preflight",
	"checkpoint_validation",
	"project_lock",
	"preflight",
	"input_validation",
	"route",
	"prepare",
	"diff",
	"checks",
	"integrate",
	"cleanup",
]);
const CHECKPOINT_DIAGNOSTIC_CODES = new Set([
	"checkpoint_task_file_mismatch",
	"checkpoint_tasks_file_mismatch",
	"checkpoint_missing_queue_identity",
	"checkpoint_queue_identity_missing",
	"checkpoint_queue_identity_mismatch",
	"checkpoint_run_options_mismatch",
	"checkpoint_historical_checkpoint",
	"checkpoint_historical_state",
]);
const LOCK_DIAGNOSTIC_CODES = Object.freeze({
	PROJECT_LOCK_HELD: "project_lock_held",
	PROJECT_LOCK_RECOVERY_IN_PROGRESS: "project_lock_recovery_in_progress",
	PROJECT_LOCK_OWNERSHIP_FAILED: "project_lock_ownership_failed",
	PROJECT_LOCK_OWNERSHIP_DISPLACED: "project_lock_ownership_displaced",
	PROJECT_LOCK_CLAIM_CLEANUP_FAILED: "project_lock_claim_cleanup_failed",
	PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION:
		"project_lock_recovery_claim_blocks_execution",
});
export const PRE_PROVIDER_FAILURE_TRIPLES = Object.freeze([
	Object.freeze({
		diagnosticCode: "integration_state_unknown",
		errorKind: "integration_failed",
		failurePhase: "checkpoint_validation",
	}),
	Object.freeze({
		diagnosticCode: "task_selection_failed",
		errorKind: "task_selection_failed",
		failurePhase: "task_selection",
	}),
	Object.freeze({
		diagnosticCode: "environment_incomplete",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	Object.freeze({
		diagnosticCode: "vm_admission_permission_denied",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	Object.freeze({
		diagnosticCode: "vm_admission_storage_failed",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	Object.freeze({
		diagnosticCode: "vm_admission_unavailable",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	Object.freeze({
		diagnosticCode: "vm_slot_unavailable",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	...[
		"vm_host_inventory_permission_denied",
		"vm_host_inventory_unavailable",
		"vm_host_service_degraded",
	].map((diagnosticCode) =>
		Object.freeze({
			diagnosticCode,
			errorKind: "environment_incomplete",
			failurePhase: "queue_preflight",
		}),
	),
	...[...CHECKPOINT_DIAGNOSTIC_CODES].map((diagnosticCode) =>
		Object.freeze({
			diagnosticCode,
			errorKind: "launch_failed",
			failurePhase: "worker_boot",
		}),
	),
	...Object.values(LOCK_DIAGNOSTIC_CODES).map((diagnosticCode) =>
		Object.freeze({
			diagnosticCode,
			errorKind: "project_lock_failed",
			failurePhase: "project_lock",
		}),
	),
	...[
		"worker_nonce_mismatch",
		"worker_fingerprint_mismatch",
		"worker_contract_unsupported",
		"worker_boot_exception",
		"clone_hardening_failed",
		"workspace_prepare_failed",
		"prlctl_job_misfire",
		"prlctl_session_not_ready",
		"prlctl_call_timed_out",
		"prlctl_call_failed",
	].map((diagnosticCode) =>
		Object.freeze({
			diagnosticCode,
			errorKind: "launch_failed",
			failurePhase: "worker_boot",
		}),
	),
]);
const PRE_PROVIDER_TRIPLE_BY_CODE = new Map(
	PRE_PROVIDER_FAILURE_TRIPLES.map((triple) => [triple.diagnosticCode, triple]),
);
export function classifyPreProviderFailure(error) {
	if (!error || typeof error !== "object") return null;
	let diagnosticCode = null;
	if (error.name === "TaskSelectionError") {
		diagnosticCode = "task_selection_failed";
	} else if (
		error.name === "IntegrationStateUnknownError" &&
		error.code === "INTEGRATION_STATE_UNKNOWN"
	) {
		diagnosticCode = "integration_state_unknown";
	} else if (error.name === "QueuePreflightError") {
		diagnosticCode = "environment_incomplete";
	} else if (CHECKPOINT_DIAGNOSTIC_CODES.has(error.code)) {
		diagnosticCode = error.code;
	} else if (
		error.name === "LockError" &&
		Object.hasOwn(LOCK_DIAGNOSTIC_CODES, error.code)
	) {
		diagnosticCode = LOCK_DIAGNOSTIC_CODES[error.code];
	} else if (
		error.name === "VmAdmissionPermissionDeniedError" &&
		error.code === "VM_ADMISSION_PERMISSION_DENIED"
	) {
		diagnosticCode = "vm_admission_permission_denied";
	} else if (
		error.name === "VmAdmissionStorageError" &&
		error.code === "VM_ADMISSION_STORAGE_FAILED"
	) {
		diagnosticCode = "vm_admission_storage_failed";
	} else if (
		error.name === "VmAdmissionUnavailableError" &&
		error.code === "VM_ADMISSION_UNAVAILABLE"
	) {
		diagnosticCode = "vm_admission_unavailable";
	} else if (
		error.name === "VmSlotUnavailableError" &&
		error.code === "VM_SLOT_UNAVAILABLE"
	) {
		diagnosticCode = "vm_slot_unavailable";
	} else if (
		error.name === "ParallelsHostReadinessError" &&
		[
			"vm_host_inventory_permission_denied",
			"vm_host_inventory_unavailable",
			"vm_host_service_degraded",
		].includes(error.code)
	) {
		diagnosticCode = error.code;
	} else {
		const prlctl = prlctlFailureMetadata(error);
		diagnosticCode =
			prlctl?.diagnosticCode ?? workerBootStageDiagnosticCode(error) ?? null;
	}
	return PRE_PROVIDER_TRIPLE_BY_CODE.get(diagnosticCode) ?? null;
}
export const CHECKPOINT_REMEDIATION_MESSAGES = Object.freeze({
	checkpoint_task_file_mismatch:
		"checkpoint task file mismatch: tasksFilePath does not match; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_tasks_file_mismatch:
		"checkpoint task file mismatch: tasksFilePath does not match; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_missing_queue_identity:
		"checkpoint v2 is missing queueIdentity; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_queue_identity_missing:
		"checkpoint v2 is missing queueIdentity; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_queue_identity_mismatch:
		"checkpoint queue identity mismatch; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_run_options_mismatch:
		"checkpoint run options mismatch: normalized run options changed; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_historical_checkpoint:
		"checkpoint is historical state without queue identity; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_historical_state:
		"checkpoint is historical state without queue identity; create a fresh checkpoint explicitly or use an audited migration",
});
const CHECKPOINT_IDENTITY_DIMENSIONS = new Set([
	"tasksFilePath",
	"queueIdentity",
	"runOptions",
	"checkpointVersion",
	"taskIds",
	"excludeProviders",
	"onlyProviders",
	"maxTasks",
	"stopOnFailure",
]);
function normalizedCheckpointDimensions(dimensions) {
	if (!Array.isArray(dimensions)) return [];
	return [
		...new Set(
			dimensions.filter(
				(dimension) =>
					typeof dimension === "string" &&
					CHECKPOINT_IDENTITY_DIMENSIONS.has(dimension),
			),
		),
	];
}
function checkpointDimensionsFromReason(code, reason) {
	const prefix = CHECKPOINT_REMEDIATION_MESSAGES[code];
	const marker = `${prefix} changed: `;
	const suffix =
		". Example fresh checkpoint: switchyard-fresh.checkpoint.json.";
	if (typeof reason !== "string" || !reason.startsWith(marker)) return [];
	if (!reason.endsWith(suffix)) return [];
	return normalizedCheckpointDimensions(
		reason
			.slice(marker.length, -suffix.length)
			.replace(/\.$/u, "")
			.split(", ")
			.filter(Boolean),
	);
}
export function checkpointRemediation(code, { dimensions = [] } = {}) {
	const changed = normalizedCheckpointDimensions(dimensions);
	const suffix = changed.length > 0 ? ` changed: ${changed.join(", ")}.` : "";
	return `${CHECKPOINT_REMEDIATION_MESSAGES[code] ?? "create a fresh checkpoint explicitly"}${suffix} Example fresh checkpoint: switchyard-fresh.checkpoint.json.`;
}
export {
	checkpointDimensionsFromReason,
	normalizedCheckpointDimensions,
	PERSISTED_FAILURE_PHASES,
	PRE_PROVIDER_TRIPLE_BY_CODE,
};
