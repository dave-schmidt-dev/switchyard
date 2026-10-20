/** Reroute limits and per-attempt terminal rules for the simple routing waterfall. */
import { deadlineFitDetails, evaluateDeadlineFit } from "./task-sizing.mjs";

export const MAX_SOFT_ATTEMPTS_PER_TASK = 4;

/**
 * Floor below which a failed or skipped attempt must not reroute. Starting a
 * fresh provider with only seconds of task budget left burns a baseline and a
 * provider start to fail immediately, so the loop stops with the attempt's own
 * outcome instead. The floor is capped at a tenth of the task's initial budget
 * so short tasks keep their fallbacks.
 */
const MIN_REROUTE_BUDGET_MS = 120_000;

/**
 * True when a failed or skipped attempt must not reroute to another target:
 * the deadline has passed, or the remaining budget is below the reroute floor
 * derived from the budget captured when the task started. A non-finite deadline
 * has no finite budget to protect and never trips the floor.
 */
export function rerouteBudgetExhausted(options, initialBudgetMs, now) {
	if (!Number.isFinite(options.deadlineMs)) return false;
	const remainingMs = options.deadlineMs - now();
	if (remainingMs <= 0) return true;
	const rerouteFloorMs = Math.min(
		MIN_REROUTE_BUDGET_MS,
		Math.ceil(0.1 * initialBudgetMs),
	);
	return remainingMs < rerouteFloorMs;
}

export const DEADLINE_FIT_REFUSAL = "task_estimate_exceeds_budget";

/**
 * Typed `retrySkipped` evidence when the caller's estimate cannot fit the time
 * left, or null. Uses the same fit as route selection, so the loop stops with
 * the failed attempt's outcome instead of making a call the engine will refuse.
 */
export function unfittableRetry(options, initialBudgetMs, nowMs) {
	const fit = evaluateDeadlineFit({
		estimateMinutes: options.estimateMinutes ?? null,
		p80Ms: null,
		deadlineMs: options.deadlineMs,
		nowMs,
		checkCount: (options.checks ?? []).length,
	});
	if (fit.fits !== false) return null;
	return {
		reason: DEADLINE_FIT_REFUSAL,
		deadlineFit: deadlineFitDetails(fit),
		deadlineConsumedMs: initialBudgetMs - (options.deadlineMs - nowMs),
	};
}

export const FUNDING_UNAVAILABLE = new Set([
	"paid_overage_not_allowed",
	"included_usage_unverified",
]);

export { failureTerminal } from "../diagnostics/failure-semantics.mjs";
