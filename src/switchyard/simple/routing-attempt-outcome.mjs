/** What a routing attempt's outcome means and whether the waterfall stops. */
import { isDeepStrictEqual } from "node:util";
import { hasTaskFailureEvidence } from "../diagnostics/failure-semantics.mjs";
import { nonBlamingCause, taskExcludedTargets } from "./attempt-blame.mjs";
import { deriveFailureAccountability } from "./failure-accountability.mjs";
import { classifyAttemptFailure } from "./failure-severity.mjs";
import {
	knownBrokenCheck,
	rememberBrokenCheck,
} from "./routing-check-memory.mjs";
import {
	DEADLINE_FIT_REFUSAL,
	failureTerminal,
	MAX_SOFT_ATTEMPTS_PER_TASK,
	rerouteBudgetExhausted,
	unfittableRetry,
} from "./routing-reroute-policy.mjs";
import { lifecycleFailure, routingErrorCode } from "./routing-stop-record.mjs";

/**
 * Guard answers that re-report state an earlier invocation left behind, or
 * null to proceed. Each is answered without logging and allocates nothing.
 */
export function preflightStop({
	handle,
	options,
	pinned,
	resolveIdentity,
	logicalTaskId,
}) {
	if (handle.state.pendingAttempt)
		return {
			direction: "stop",
			extra: {
				stopReason: "pending_attempt_exists",
				pendingAttempt: handle.state.pendingAttempt,
			},
		};
	if (handle.state.nativeLatch)
		return { direction: "native_latched", extra: { status: "deferred" } };
	if (handle.state.attempts.some((attempt) => attempt.partialWorktree !== null))
		return {
			direction: "stop",
			extra: { stopReason: "partial_work_retained" },
		};
	if (pinned) {
		const state = handle.state;
		const pinnedExcluded = new Set([
			...state.failedTargetIds,
			...taskExcludedTargets(state.attempts, logicalTaskId),
		]);
		if (
			options.onlyProviders.every((id) =>
				pinnedExcluded.has(resolveIdentity(id).targetId),
			)
		)
			return {
				direction: "stop",
				extra: { stopReason: "pinned_target_failed" },
			};
	}
	// A check this run already found environment-broken fails every target
	// the same way: answer with the stored evidence, allocate nothing.
	const brokenCheck = knownBrokenCheck(handle.state, options.checks);
	if (brokenCheck)
		return {
			direction: "stop",
			extra: { stopReason: "check_known_broken", brokenCheck },
		};
	return null;
}

/**
 * Answer for an engine call that never routed to a target: the direction and
 * extra fields to report. Funding refusals count as capacity, so native
 * fallback still applies when every eligible target is refused for funding
 * (stability audit O10, 2026-10-18).
 */
export function unroutedStop({
	result,
	attempts,
	logicalTaskId,
	anyFailed,
	routeCalled,
	noEligible,
	pinned,
	signal,
}) {
	if (result?.lockConflict && result?.disposition) {
		const action = result.disposition.action;
		return {
			direction: ["defer", "recover"].includes(action) ? action : "stop",
			extra: {
				status: action === "defer" ? "deferred" : "failed",
				stopReason: result.disposition.reasonCode,
				result,
				disposition: result.disposition,
			},
		};
	}
	const exhausted =
		anyFailed || hasTaskFailureEvidence(attempts, logicalTaskId);
	if (
		routeCalled &&
		noEligible &&
		result?.failurePhase === "route" &&
		!signal?.aborted
	)
		return {
			direction: pinned ? "stop" : "native_required",
			extra: {
				status: pinned ? "failed" : "deferred",
				stopReason: pinned ? "pinned_target_unavailable" : undefined,
				exhaustionCause: pinned
					? undefined
					: exhausted
						? "task_failures"
						: "capacity",
				result,
			},
		};
	return {
		direction: "stop",
		extra: {
			stopReason:
				result?.failureReason === DEADLINE_FIT_REFUSAL
					? DEADLINE_FIT_REFUSAL
					: "preflight_failed",
			result,
		},
	};
}

/**
 * Read the attempt's run record, confirm its lifecycle and derive what the
 * result means. Returns `{ stop }` (extra fields for a "stop" answer) when the
 * record is unreadable or the lifecycle is unconfirmed; otherwise the
 * evaluated facts. The result gains `accountability` when it is typed.
 */
export async function evaluateAttempt({
	result,
	pending,
	projectPath,
	options,
	readRunRecord,
}) {
	let record;
	try {
		record = await readRunRecord(pending.runId);
	} catch {
		return {
			stop: {
				stopReason: "lifecycle_unconfirmed",
				lifecycleCheck: "run_record_unreadable",
				result,
				pendingAttempt: pending,
			},
		};
	}
	const lifecycleCheck = lifecycleFailure(
		result,
		pending,
		record,
		projectPath,
		options,
	);
	if (lifecycleCheck)
		return {
			stop: {
				stopReason: "lifecycle_unconfirmed",
				lifecycleCheck,
				result,
				pendingAttempt: pending,
			},
		};
	const failed = result.status !== "succeeded";
	const typed = result.providerReliability !== undefined;
	const diagnosticMatches = isDeepStrictEqual(
		result.providerReliability,
		record.lastFailure?.providerReliability,
	);
	const matchedProvenance = diagnosticMatches ? record.lastFailure : null;
	const accountability = deriveFailureAccountability({
		providerReliability: diagnosticMatches
			? record.lastFailure?.providerReliability
			: undefined,
		provenance: matchedProvenance ?? {},
	});
	if (typed) result.accountability = accountability;
	// A baseline failure precedes the provider and is not evidence against the target.
	const tried =
		result.failurePhase !== "baseline" &&
		result.recovery.cleanup.writer.state === "stopped";
	const terminal = failed
		? failureTerminal(
				result,
				typed ? accountability.providerMemoryEligible && tried : tried,
			)
		: "succeeded";

	// lifecycle() already proved the writer stopped or never started.
	// Task 2.7: a post-provider dependency refusal stops on its own cause.
	const refusalCode =
		result.providerReliability?.causeCode ?? result.failureReason;
	const postProviderDependencyRefusal =
		failed &&
		result.failurePhase === "checks" &&
		(refusalCode === "check_dependencies_unverified" ||
			refusalCode === "check_manifest_changed_by_diff");
	const classification = failed
		? classifyAttemptFailure({ result, accountability })
		: null;
	return {
		record,
		failed,
		accountability,
		terminal,
		refusalCode,
		postProviderDependencyRefusal,
		classification,
		reason: failed ? classification.reason : "succeeded",
		matchedProvenance,
		// Caller cancellation or trusted quota evidence is not the target's fault;
		// recording it keeps the target eligible for later attempts at this task.
		nonBlaming: failed ? nonBlamingCause(result, matchedProvenance) : null,
	};
}

/**
 * Extra fields for the "stop" answer a failed attempt ends the waterfall
 * with, or null to continue to the next eligible target. `softAttemptCount`
 * includes this attempt.
 */
export function failedAttemptStop({
	result,
	record,
	classification,
	accountability,
	refusalCode,
	postProviderDependencyRefusal,
	handle,
	options,
	pinned,
	signal,
	initialBudgetMs,
	softAttemptCount,
	now,
}) {
	if (classification.severity === "hard") {
		return {
			stopReason:
				postProviderDependencyRefusal || refusalCode === DEADLINE_FIT_REFUSAL
					? refusalCode
					: "unsafe_failure",
			result,
			classification,
		};
	}
	// A check that cannot run here is the environment's fault, not the
	// target's: remember it (only the pre-provider dry run writes
	// memory) and stop without blaming anyone.
	if (result.providerReliability?.causeCode === "check_environment_failed") {
		try {
			rememberBrokenCheck(handle.state, handle.commit, {
				result,
				record,
				now,
			});
		} catch (error) {
			return {
				stopReason: routingErrorCode(error, "routing_state_write_failed"),
				result,
				classification,
			};
		}
		return {
			stopReason: "check_environment_failed",
			result,
			classification,
		};
	}
	// The work passed its checks and only integration was refused, so the
	// captain applies the retained partial onto the new HEAD; another target
	// would redo it against the same moved HEAD.
	if (
		result.failurePhase === "integrate" &&
		refusalCode === "host_concurrency" &&
		typeof result.partialWorktree === "string"
	)
		return { stopReason: "host_concurrency", result, classification };
	if (classification.severity === "baseline") {
		// A check environment that could not be set up is not a red check
		// (O5, 2026-10-18): its own stop label tells the caller to repair the
		// host, not the check. The attempt keeps `baseline_failed`, so the
		// target stays unblamed and routing state stays version 1.
		const checkSetup =
			(result.providerReliability?.causeCode ?? accountability?.causeCode) ===
			"check_setup_failed";
		return {
			stopReason: checkSetup ? "check_setup_failed" : "baseline_failed",
			result,
			classification,
		};
	}
	// severity === "soft" from here
	if (pinned || options.capability === "high")
		return { stopReason: classification.reason, result, classification };
	if (softAttemptCount >= MAX_SOFT_ATTEMPTS_PER_TASK)
		return {
			stopReason: "soft_retry_budget_exhausted",
			result,
			classification,
		};
	// A cancelled invocation, an expired deadline, or too little budget
	// left to start another provider keeps this attempt's own outcome.
	if (signal?.aborted || rerouteBudgetExhausted(options, initialBudgetMs, now))
		return { stopReason: classification.reason, result, classification };
	// An estimate that cannot fit the time left would be refused before any
	// attempt is allocated, so the doomed call must not become the terminal.
	const retrySkipped = unfittableRetry(options, initialBudgetMs, now());
	if (retrySkipped)
		return {
			stopReason: classification.reason,
			result,
			classification,
			retrySkipped,
		};
	// Continue to the next eligible target (retained clone is independent).
	return null;
}

const closedCode = (value) =>
	typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
		? value
		: null;

/** The engine's own closed failure codes for one closed attempt. */
export function closedAttemptCodes(result) {
	return {
		failureReason: closedCode(result?.failureReason),
		causeCode: closedCode(result?.providerReliability?.causeCode),
	};
}

/**
 * Summaries of this invocation's closed attempts other than the one the
 * answer's top-level result describes, oldest first. `partialWorktree` is
 * read from routing state, so a partial released since is null.
 *
 * @param {object[]} attempts Routing state's attempt history.
 * @param {Map<string, {failureReason: string|null, causeCode: string|null}>} own
 *   This invocation's closed attempts, by attempt ID.
 * @param {string|null} reportedAttemptId
 */
export function priorAttemptSummaries(attempts, own, reportedAttemptId) {
	return attempts
		.filter(
			(attempt) =>
				own.has(attempt.attemptId) && attempt.attemptId !== reportedAttemptId,
		)
		.map((attempt) => ({
			attemptId: attempt.attemptId,
			targetId: attempt.targetId,
			terminal: attempt.terminal,
			reason: attempt.reason,
			...own.get(attempt.attemptId),
			partialWorktree: attempt.partialWorktree,
		}));
}
