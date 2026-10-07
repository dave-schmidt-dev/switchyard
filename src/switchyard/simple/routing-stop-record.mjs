/** Closed lifecycle verdicts and failure-log record shapes for the routing waterfall. */
import { createHash } from "node:crypto";
import { deriveFailureAccountability } from "./failure-accountability.mjs";
import { classifyAttemptFailure } from "./failure-severity.mjs";

/** Closed names for the single check that made `lifecycle_unconfirmed` fire. */
export const LIFECYCLE_CHECKS = Object.freeze([
	"recovery_schema",
	"scope_mismatch",
	"recovery_status",
	"recovery_reason",
	"recovery_phase",
	"run_id",
	"task_id",
	"attempt_id",
	"target_id",
	"identity_missing",
	"identity_task",
	"identity_attempt",
	"result_status",
	"writer_state",
	"project_lock_state",
	"worktree_state",
	"run_record_unreadable",
	"run_record_missing",
	"record_run_id",
	"record_project",
	"record_tasks",
	"record_target",
	"record_state",
	"record_error_kind",
	"worktree_not_created_claim",
	"worktree_not_created_writer",
	"worktree_not_created_partial",
	"worktree_record_state",
	"worktree_writer_stopped",
	"worktree_retained_path",
	"worktree_cleanup_state",
	"worktree_partial_unexpected",
]);

const hash = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
const firstFailed = (checks) =>
	checks.find(([, failed]) => failed)?.[0] ?? null;

/**
 * Prove that the engine result, the pending allocation and the run record
 * describe one stopped, cleaned-up attempt.
 *
 * @returns {string|null} The first failing check, as a LIFECYCLE_CHECKS name,
 *   or null when the lifecycle is confirmed.
 */
export function lifecycleFailure(result, pending, record, project, options) {
	const scope = {
		files: options.files,
		checks: (options.checks ?? []).map((command, index) => ({
			index: index + 1,
			digest: hash(command),
		})),
	};
	scope.digest = hash(JSON.stringify(scope));
	if (result?.recovery?.schemaVersion !== 1) return "recovery_schema";
	const cleanup = result.recovery.cleanup;
	const identity = result.recovery.identity;
	const recovered = result.recovery.result;
	const resultFailure = firstFailed([
		[
			"scope_mismatch",
			JSON.stringify(identity?.scope) !== JSON.stringify(scope),
		],
		["recovery_status", recovered?.status !== result.status],
		["recovery_reason", recovered?.failureReason !== result.failureReason],
		["recovery_phase", recovered?.failurePhase !== result.failurePhase],
		["run_id", result.runId !== pending.runId],
		["task_id", result.taskId !== pending.taskId],
		["attempt_id", result.attemptId !== pending.attemptId],
		["target_id", result.targetId !== pending.targetId],
		["identity_missing", !identity],
		["identity_task", identity?.taskId !== pending.taskId],
		["identity_attempt", identity?.attemptId !== pending.attemptId],
		["result_status", !["succeeded", "failed"].includes(result.status)],
		[
			"writer_state",
			!["stopped", "never_started"].includes(cleanup?.writer?.state),
		],
		[
			"project_lock_state",
			!["released", "not_acquired"].includes(cleanup?.projectLock?.state),
		],
		[
			"worktree_state",
			!["removed", "not_created", "retained"].includes(
				cleanup?.worktree?.state,
			),
		],
	]);
	if (resultFailure) return resultFailure;
	const recordFailure = firstFailed([
		["run_record_missing", !record],
		["record_run_id", record?.runId !== pending.runId],
		["record_project", record?.projectPath !== project],
		[
			"record_tasks",
			JSON.stringify(record?.orderedTaskIds) !==
				JSON.stringify([pending.taskId]),
		],
		["record_target", record?.resolvedTargetId !== pending.targetId],
		["record_state", record?.state !== result.status],
		[
			"record_error_kind",
			result.status === "failed" &&
				record?.lastFailure?.errorKind !== result.errorKind,
		],
	]);
	if (recordFailure) return recordFailure;
	if (cleanup.worktree.state === "not_created")
		return firstFailed([
			["worktree_not_created_claim", record.worktree != null],
			["worktree_not_created_writer", cleanup.writer.state !== "never_started"],
			["worktree_not_created_partial", Boolean(result.partialWorktree)],
		]);
	const retained = cleanup.worktree.state === "retained";
	return firstFailed([
		[
			"worktree_record_state",
			record.worktree?.state !== cleanup.worktree.state,
		],
		["worktree_writer_stopped", record.worktree?.writerStopped !== true],
		[
			"worktree_retained_path",
			retained &&
				!(
					typeof result.partialWorktree === "string" &&
					result.partialWorktree === cleanup.worktree.path
				),
		],
		["worktree_cleanup_state", !retained && record.cleanupState !== "complete"],
		[
			"worktree_partial_unexpected",
			!retained && Boolean(result.partialWorktree),
		],
	]);
}

/** Cause fields every attempt and stop record copies from its triggering result. */
function causeFields(result, accountability = result?.accountability) {
	const reliability = result?.providerReliability;
	return {
		causeCategory: reliability?.causeCategory ?? accountability?.causeCategory,
		causeCode: reliability?.causeCode ?? accountability?.causeCode,
		phase: reliability?.phase,
		failurePhase: result?.failurePhase,
		errorKind: result?.errorKind,
	};
}

/** Failure-log attempt record for one failed engine result. */
export function failureAttemptRecord({
	project,
	routingRunId,
	attempt,
	result,
	accountability,
	classification,
}) {
	return {
		recordType: "attempt",
		project,
		routingRunId,
		taskId: attempt.taskId,
		attemptId: attempt.attemptId,
		runId: attempt.runId,
		targetId: attempt.targetId,
		capability: attempt.capability,
		severity: classification.severity,
		reason: classification.reason,
		salvageable: classification.salvageable,
		partialRetained: typeof result.partialWorktree === "string",
		...causeFields(result, accountability),
	};
}

/**
 * Identity of a failed engine call that never reached a target allocation.
 * The result must carry this iteration's own task, attempt and run ids; a
 * result that does not cannot be attributed and is neither logged nor used to
 * name the stop.
 *
 * @returns {object|null} The attempt identity with `targetId: null`, or null.
 */
export function unroutedAttempt(result, allocation, capability) {
	const own =
		result?.status === "failed" &&
		result.runId === allocation.runId &&
		result.taskId === allocation.taskId &&
		result.attemptId === allocation.attemptId;
	return own ? { ...allocation, targetId: null, capability } : null;
}

/** Attempt record for a failed engine call that never reached a target. */
export function unroutedAttemptRecord({
	project,
	routingRunId,
	attempt,
	result,
}) {
	const accountability = deriveFailureAccountability({
		providerReliability: result.providerReliability,
		provenance: result,
	});
	return failureAttemptRecord({
		project,
		routingRunId,
		attempt,
		result,
		accountability,
		classification: classifyAttemptFailure({ result, accountability }),
	});
}

/** Failure-log stop record; the cause comes from the result that triggered it. */
export function stopRecord({
	project,
	routingRunId,
	attempt,
	direction,
	extra,
}) {
	return {
		recordType: "stop",
		project,
		routingRunId,
		taskId: attempt?.taskId,
		attemptId: attempt?.attemptId,
		runId: attempt?.runId,
		targetId: attempt?.targetId,
		capability: attempt?.capability,
		stopReason: extra.stopReason ?? direction,
		exhaustionCause: extra.exhaustionCause,
		lifecycleCheck: extra.lifecycleCheck,
		...causeFields(extra.result),
	};
}
