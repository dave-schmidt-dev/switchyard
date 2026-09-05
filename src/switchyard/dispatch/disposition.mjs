import { isSafeTargetId } from "../run-store/index.mjs";

const TERMINAL_STATES = new Set(["succeeded", "failed"]);
const LIVE_STATES = new Set(["live", "startup_grace"]);
const CONTRACT_DIAGNOSTICS = new Set([
	"worker_nonce_mismatch",
	"worker_fingerprint_mismatch",
	"worker_contract_unsupported",
	"worker_boot_exception",
	"clone_hardening_failed",
	"workspace_prepare_failed",
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
	"vm_admission_permission_denied",
	"vm_admission_storage_failed",
	"vm_admission_unavailable",
]);
const PRE_INITIALIZATION_CONTRACT_CODES = new Set([
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
]);
const RUN_ID_RE = /^[\w-]+$/;
const TASK_ID_RE = /^\d+(?:\.\d+)*$/;
const MAX_TASK_ID_LENGTH = 64;
const CONTRACT_FAILURE_KINDS = new Set([
	"no_provider",
	"unsupported_provider",
	"executor_not_switchyard",
]);
const TARGET_FAILURE_KINDS = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"execution_failed",
	"execution_timed_out",
	"provider_cleanup_failed",
	"diff_capture_failed",
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
const ADVANCE_FALLBACK_FAILURE_CODES = new Set([
	"quota_exhausted",
	"provider_exit_nonzero",
	"provider_signalled",
]);
const REPAIR_INPUT_FAILURE_CODES = new Set([
	"cli_usage_error",
	"declared_path_not_seeded",
	"required_paths_missing",
	"undeclared_paths_touched",
	"empty_required_diff",
	"no_op_diff",
	"manifest_review_required",
	"corrupt_patch",
	"conflict",
	"empty_diff",
]);
const TERMINAL_LOCK_DIAGNOSTICS = new Set([
	"project_lock_held",
	"project_lock_recovery_in_progress",
	"project_lock_ownership_failed",
	"project_lock_ownership_displaced",
	"project_lock_claim_cleanup_failed",
	"project_lock_recovery_claim_blocks_execution",
]);
const RETRY_LAUNCH_DIAGNOSTICS = new Set([
	...TERMINAL_LOCK_DIAGNOSTICS,
	"vm_slot_unavailable",
]);
const PRE_PROVIDER_STOP_DIAGNOSTICS = new Set([
	...TERMINAL_LOCK_DIAGNOSTICS,
	"vm_slot_unavailable",
	"prlctl_job_misfire",
	"prlctl_session_not_ready",
	"prlctl_call_timed_out",
	"prlctl_call_failed",
]);

function baseDisposition(action, reasonCode, failure = null) {
	const diagnosticCode = failure?.diagnosticCode ?? null;
	let direction = "stop";
	if (action === "complete") {
		direction = "complete";
	} else if (action === "monitor" || action === "defer") {
		direction = "wait";
	} else if (action === "recover") {
		direction = "recover_and_retry";
	} else if (action === "repair_contract") {
		direction = "repair_input";
	} else if (
		action === "stop" &&
		diagnosticCode === reasonCode &&
		RETRY_LAUNCH_DIAGNOSTICS.has(diagnosticCode)
	) {
		// A terminal record carries no fresh holder classification. Direct the
		// caller through normal launch preflight without acting on stored identity.
		direction = "retry_launch";
	} else if (action === "target_failed") {
		const closedFailureCode = diagnosticCode ?? reasonCode;
		if (ADVANCE_FALLBACK_FAILURE_CODES.has(closedFailureCode)) {
			direction = "advance_authorized_fallback";
		} else if (REPAIR_INPUT_FAILURE_CODES.has(closedFailureCode)) {
			direction = "repair_input";
		}
	}
	return {
		version: 1,
		action,
		direction,
		reasonCode,
		diagnosticCode,
		taskId: null,
		blockingRunId: null,
		recoveryCommand: null,
		remediationCommand: null,
		failedTargetIds: [],
		failedTargetIdsTruncated: false,
	};
}

function projectPreInitialization(fact, recoveryCommand) {
	if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
		return baseDisposition("stop", "insufficient_evidence");
	}
	if (
		fact.type === "contract_failure" &&
		PRE_INITIALIZATION_CONTRACT_CODES.has(fact.code)
	) {
		// The code is closed-vocabulary by the membership test above, so echoing
		// it as the diagnostic is bounded. Leaving it null told the caller a
		// classified contract failure had no classified cause.
		return baseDisposition("repair_contract", fact.code, {
			diagnosticCode: fact.code,
		});
	}
	if (fact.type !== "lock_conflict" || fact.code !== "PROJECT_LOCK_HELD") {
		return baseDisposition("stop", "insufficient_evidence");
	}
	const holderRunId =
		typeof fact.holderRunId === "string" && RUN_ID_RE.test(fact.holderRunId)
			? fact.holderRunId
			: null;
	if (
		holderRunId &&
		(fact.holderLiveness === "live" || fact.holderLiveness === "startup_grace")
	) {
		const result = baseDisposition("defer", "project_lock_owner_live");
		result.blockingRunId = holderRunId;
		return result;
	}
	if (holderRunId && fact.holderLiveness === "dead") {
		if (!hasRecoveryCommand(recoveryCommand)) {
			return baseDisposition("stop", "insufficient_evidence");
		}
		const result = baseDisposition("recover", "project_lock_owner_dead");
		result.recoveryCommand = recoveryCommand;
		return result;
	}
	return baseDisposition("stop", "project_lock_ownership_unresolved");
}

function hasRecoveryCommand(recoveryCommand) {
	return (
		typeof recoveryCommand === "string" && recoveryCommand.trim().length > 0
	);
}

function isSafeTaskId(taskId) {
	return (
		typeof taskId === "string" &&
		taskId.length <= MAX_TASK_ID_LENGTH &&
		TASK_ID_RE.test(taskId)
	);
}

function hasExactDescriptorEvidence(entry) {
	return Boolean(
		entry &&
			isSafeTargetId(entry.resolvedTargetId) &&
			entry.invocationDescriptor &&
			entry.invocationDescriptor.target_id === entry.resolvedTargetId &&
			typeof entry.descriptorIdentity === "string" &&
			entry.invocationDescriptor.descriptor_identity ===
				entry.descriptorIdentity &&
			typeof entry.descriptorHarness === "string" &&
			entry.descriptorHarness.length > 0,
	);
}

// A retained legacy result can remain readable, but its old labels did not
// bind a code to the host boundary, evidence state, and exact route. It is
// therefore evidence for inspection only, never fresh fallback authority.
function hasAuthoritativeRoutingFailure(failure) {
	return Boolean(
		failure &&
			failure.diagnosticEvidenceAvailable === true &&
			["adapter", "launcher"].includes(failure.diagnosticOrigin) &&
			failure.failurePhase === "provider_execution" &&
			typeof failure.diagnosticCode === "string",
	);
}

function isTargetFailure(entry, source) {
	const isFailedEvidence =
		source === "event"
			? entry?.phase === "execution" && entry?.event === "task_failed"
			: entry?.success === false;
	return Boolean(
		entry &&
			isFailedEvidence &&
			(TARGET_FAILURE_KINDS.has(entry.errorKind) ||
				["provider_execution", "provider_cleanup"].includes(
					entry.failurePhase,
				)),
	);
}

function matchesFailureRoute(entry, failure) {
	const routeFields = [
		["resolvedTargetId", failure?.resolvedTargetId],
		["descriptorIdentity", failure?.descriptorIdentity],
		["descriptorHarness", failure?.descriptorHarness],
	];
	const supplied = routeFields.filter(([, value]) => value != null);
	if (supplied.length === 0) return true;
	return (
		supplied.length === routeFields.length &&
		supplied.every(([field, value]) => entry[field] === value)
	);
}

function failedTargetEvidence(checkpoint, events, currentTaskId, failure) {
	const completedTaskIds = new Set(
		(checkpoint?.completedTaskIds ?? []).filter(isSafeTaskId),
	);
	const evidence = [];
	for (const field of ["retryAttempts", "results"]) {
		for (const entry of checkpoint?.[field] ?? []) {
			if (
				hasAuthoritativeRoutingFailure(entry) &&
				hasExactDescriptorEvidence(entry) &&
				isSafeTaskId(entry.taskId) &&
				!completedTaskIds.has(entry.taskId) &&
				isTargetFailure(entry, field)
			) {
				evidence.push(entry);
			}
		}
	}
	for (const entry of events ?? []) {
		if (
			hasAuthoritativeRoutingFailure(entry) &&
			hasExactDescriptorEvidence(entry) &&
			isSafeTaskId(entry.taskId) &&
			!completedTaskIds.has(entry.taskId) &&
			isTargetFailure(entry, "event")
		) {
			evidence.push(entry);
		}
	}
	const taskIds = [...new Set(evidence.map((entry) => entry.taskId))];
	const taskId = isSafeTaskId(currentTaskId)
		? currentTaskId
		: taskIds.length === 1
			? taskIds[0]
			: null;
	const taskEvidence = evidence.filter((entry) => entry.taskId === taskId);
	if (
		completedTaskIds.has(taskId) ||
		!taskEvidence.some((entry) => matchesFailureRoute(entry, failure))
	) {
		return { targetIds: [], truncated: false, taskId: null };
	}
	const targetIds = [
		...new Set(taskEvidence.map((entry) => entry.resolvedTargetId)),
	].sort();
	return {
		targetIds: targetIds.slice(0, 16),
		truncated: targetIds.length > 16,
		taskId,
	};
}

function currentFailureTaskContext(run, checkpoint, failure) {
	const supplied = [
		run?.currentTaskId,
		run?.activeTaskId,
		checkpoint?.lastTaskId,
		failure?.taskId,
	].filter((taskId) => taskId != null);
	if (supplied.some((taskId) => !isSafeTaskId(taskId))) {
		return { ambiguous: true, taskId: null };
	}
	const taskIds = [...new Set(supplied)];
	return {
		ambiguous: taskIds.length > 1,
		taskId: taskIds.length === 1 ? taskIds[0] : null,
	};
}

/** Pure caller disposition projection over already-validated durable evidence. */
export function projectDisposition({
	run = null,
	preInitialization = null,
	checkpoint = null,
	events = [],
	liveness = "unknown",
	recoveryCommand = null,
	remediationCommand = null,
	optionalEvidenceValid = true,
}) {
	if (preInitialization !== null) {
		return projectPreInitialization(preInitialization, recoveryCommand);
	}
	const failure = run?.lastFailure ?? null;
	const terminal = TERMINAL_STATES.has(run?.state);
	const cleanupIncomplete = ["not_started", "pending"].includes(
		run?.cleanupState,
	);
	const cleanupPending = run?.cleanupState === "pending";

	if (run?.state === "recovery_required" || run?.cleanupState === "failed") {
		const result = baseDisposition("stop", "recovery_incomplete", failure);
		if (hasRecoveryCommand(remediationCommand)) {
			result.remediationCommand = remediationCommand;
		}
		return result;
	}
	if (cleanupPending && LIVE_STATES.has(liveness)) {
		return baseDisposition("monitor", "cleanup_in_progress", failure);
	}
	if (terminal && cleanupIncomplete && liveness === "dead") {
		if (!hasRecoveryCommand(recoveryCommand)) {
			return baseDisposition("stop", "insufficient_evidence", failure);
		}
		const result = baseDisposition("recover", "cleanup_incomplete", failure);
		result.recoveryCommand = recoveryCommand;
		return result;
	}
	if (terminal && cleanupIncomplete) {
		return baseDisposition("stop", "cleanup_incomplete", failure);
	}
	if (run?.state === "succeeded" && run?.cleanupState === "complete") {
		return baseDisposition("complete", "run_succeeded", failure);
	}
	if (!terminal && LIVE_STATES.has(liveness)) {
		return baseDisposition(
			"monitor",
			checkpoint?.retryState ? "retry_in_progress" : "run_in_progress",
			failure,
		);
	}
	if (!terminal && liveness === "dead") {
		if (!hasRecoveryCommand(recoveryCommand)) {
			return baseDisposition("stop", "insufficient_evidence", failure);
		}
		const result = baseDisposition("recover", "worker_dead", failure);
		result.recoveryCommand = recoveryCommand;
		return result;
	}
	if (run?.state === "failed" && run?.cleanupState === "complete") {
		if (
			CONTRACT_DIAGNOSTICS.has(failure?.diagnosticCode) ||
			CONTRACT_FAILURE_KINDS.has(failure?.errorKind)
		) {
			return baseDisposition(
				"repair_contract",
				failure.diagnosticCode ?? failure.reasonCode,
				failure,
			);
		}
		if (PRE_PROVIDER_STOP_DIAGNOSTICS.has(failure?.diagnosticCode)) {
			return baseDisposition("stop", failure.diagnosticCode, failure);
		}
		if (!optionalEvidenceValid || !failure) {
			return baseDisposition("stop", "insufficient_evidence", failure);
		}
		if (
			TARGET_FAILURE_KINDS.has(failure.errorKind) &&
			!hasAuthoritativeRoutingFailure(failure)
		) {
			return baseDisposition("stop", "insufficient_evidence", failure);
		}
		const taskContext = currentFailureTaskContext(run, checkpoint, failure);
		if (taskContext.ambiguous) {
			return baseDisposition("stop", "insufficient_evidence", failure);
		}
		const failedTargets = failedTargetEvidence(
			checkpoint,
			events,
			taskContext.taskId,
			failure,
		);
		if (
			TARGET_FAILURE_KINDS.has(failure.errorKind) &&
			failedTargets.targetIds.length
		) {
			const result = baseDisposition(
				"target_failed",
				checkpoint?.retryState?.phase === "retry_halted"
					? "retry_consumed"
					: (failure.diagnosticCode ?? failure.reasonCode),
				failure,
			);
			result.taskId = failedTargets.taskId;
			result.failedTargetIds = failedTargets.targetIds;
			result.failedTargetIdsTruncated = failedTargets.truncated;
			return result;
		}
	}
	return baseDisposition("stop", "insufficient_evidence", failure);
}

/** Derive an additive closed terminal outcome without mutating history. */
export function projectTerminalOutcome(run) {
	if (
		run?.state === "failed" &&
		run?.cleanupState === "complete" &&
		run?.terminalizedBy === "dead_worker_recovery"
	) {
		return "recovered_dead_worker";
	}
	if (run?.cleanupState !== "complete") {
		return "unknown_failure";
	}
	const processed = run?.terminalSummary?.processedTasks;
	if (!Number.isInteger(processed) || processed < 0) return "unknown_failure";
	if (run.state === "succeeded") {
		return processed > 0 ? "completed_work" : "no_runnable_work";
	}
	if (run.state === "failed" && run.terminalizedBy === "worker") {
		return processed > 0 ? "failed_work" : "failed_before_work";
	}
	return "unknown_failure";
}
