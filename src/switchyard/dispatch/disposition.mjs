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
]);
const PRE_INITIALIZATION_CONTRACT_CODES = new Set([
	"invalid_invocation",
	"queue_empty",
	"queue_identity_invalid",
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

function baseDisposition(action, reasonCode, failure = null) {
	return {
		version: 1,
		action,
		reasonCode,
		diagnosticCode: failure?.diagnosticCode ?? null,
		taskId: null,
		blockingRunId: null,
		recoveryCommand: null,
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
		return baseDisposition("repair_contract", fact.code);
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

function failedTargetEvidence(checkpoint, events) {
	const evidence = [];
	for (const field of ["retryAttempts", "results"]) {
		for (const entry of checkpoint?.[field] ?? []) {
			if (
				hasExactDescriptorEvidence(entry) &&
				isSafeTaskId(entry.taskId) &&
				isTargetFailure(entry, field)
			) {
				evidence.push({
					targetId: entry.resolvedTargetId,
					taskId: entry.taskId,
				});
			}
		}
	}
	for (const entry of events ?? []) {
		if (
			hasExactDescriptorEvidence(entry) &&
			isSafeTaskId(entry.taskId) &&
			isTargetFailure(entry, "event")
		) {
			evidence.push({ targetId: entry.resolvedTargetId, taskId: entry.taskId });
		}
	}
	const taskId = evidence.map((entry) => entry.taskId).sort()[0] ?? null;
	const targetIds = [
		...new Set(
			evidence
				.filter((entry) => entry.taskId === taskId)
				.map((entry) => entry.targetId),
		),
	].sort();
	return {
		targetIds: targetIds.slice(0, 16),
		truncated: targetIds.length > 16,
		taskId,
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
		return baseDisposition("stop", "recovery_incomplete", failure);
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
		if (!optionalEvidenceValid || !failure) {
			return baseDisposition("stop", "insufficient_evidence", failure);
		}
		const failedTargets = failedTargetEvidence(checkpoint, events);
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
