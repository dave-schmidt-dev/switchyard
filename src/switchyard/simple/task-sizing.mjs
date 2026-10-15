/**
 * Pure task-sizing policy for the simple deadline fit.
 *
 * The caller may supply one estimate in whole minutes of provider execution.
 * It is an estimate, never a proven duration. When the caller gives none the
 * same fit is evaluated against the selected target's observed p80 from the
 * existing run store (at least five successful same-project/target samples);
 * otherwise the estimate is unknown. Historical sizing stays advisory; only
 * an explicit caller estimate triggers the new refusal. The usable budget
 * is the remaining deadline minus the existing acceptance-check reserve and
 * the fixed fit margin; the estimate must be at most that budget. No file
 * count or other repository shape ever contributes to an estimate. Pure
 * functions; no I/O, no mutation.
 */

const DEADLINE_FIT_MARGIN_MS = 90_000;
const DEADLINE_FIT_CHECK_RESERVE_BASE_MS = 60_000;
const DEADLINE_FIT_CHECK_RESERVE_PER_CHECK_MS = 30_000;
export const MAX_ESTIMATE_MINUTES = 24 * 60;

/** Bounded non-negative check count for the reserve formula. */
function checkCountFor(checkCount) {
	return Number.isSafeInteger(checkCount) && checkCount > 0 ? checkCount : 0;
}

/** The existing acceptance-check reserve: max(60s, 30s * checks). */
function deadlineFitCheckReserveMs(checkCount) {
	return Math.max(
		DEADLINE_FIT_CHECK_RESERVE_BASE_MS,
		DEADLINE_FIT_CHECK_RESERVE_PER_CHECK_MS * checkCountFor(checkCount),
	);
}

/**
 * Remaining deadline minus the check reserve and the fit margin, or null when
 * the deadline or the clock is not finite. Fixed positive elapsed time at or
 * past the deadline clamps to zero remaining, matching the existing
 * pre-selection deadline-fit filter.
 */
export function deadlineFitBudgetMs({ deadlineMs, nowMs, checkCount }) {
	const remainingMs = deadlineFitRemainingMs({ deadlineMs, nowMs });
	if (remainingMs === null) return null;
	return (
		remainingMs - deadlineFitCheckReserveMs(checkCount) - DEADLINE_FIT_MARGIN_MS
	);
}

/** Non-negative remaining milliseconds, or null when either input is not finite. */
function deadlineFitRemainingMs({ deadlineMs, nowMs }) {
	if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return null;
	return Math.max(0, deadlineMs - nowMs);
}

/**
 * Evaluate the one fit formula against the best available estimate.
 *
 * The caller estimate wins when present; otherwise the selected target's
 * observed p80 (already gated on at least five successful samples by the run
 * store reader) is the estimate. With neither source `fits` is null: unknown
 * never refuses. `fits === false` is the closed `task_estimate_exceeds_budget`
 * condition, evaluated before any provider work.
 */
export function evaluateDeadlineFit({
	estimateMinutes,
	p80Ms,
	deadlineMs,
	nowMs,
	checkCount,
}) {
	const remainingMs = deadlineFitRemainingMs({ deadlineMs, nowMs });
	const checkReserveMs = deadlineFitCheckReserveMs(checkCount);
	const budgetMs =
		remainingMs === null
			? null
			: remainingMs - checkReserveMs - DEADLINE_FIT_MARGIN_MS;
	let source = "unknown";
	let resolvedEstimateMinutes = null;
	let estimateMs = null;
	let resolvedP80Ms = null;
	if (
		typeof estimateMinutes === "number" &&
		Number.isFinite(estimateMinutes) &&
		estimateMinutes > 0
	) {
		source = "caller_estimate";
		estimateMs = Math.ceil(estimateMinutes * 60_000);
		resolvedEstimateMinutes = Number.isSafeInteger(estimateMinutes)
			? estimateMinutes
			: null;
	} else if (Number.isFinite(p80Ms) && p80Ms >= 0) {
		source = "observed_p80";
		estimateMs = p80Ms;
		resolvedP80Ms = p80Ms;
	}
	return Object.freeze({
		source,
		deadlineMs,
		unverified: source === "caller_estimate",
		splitRecommended: source === "caller_estimate" && estimateMinutes >= 20,
		estimateMinutes: resolvedEstimateMinutes,
		estimateMs,
		p80Ms: resolvedP80Ms,
		remainingMs,
		checkReserveMs,
		marginMs: DEADLINE_FIT_MARGIN_MS,
		budgetMs,
		fits:
			source === "unknown" || budgetMs === null ? null : estimateMs <= budgetMs,
	});
}

/** Flat typed evidence shared by the caller, persisted failure and progress. */
export function deadlineFitDetails(fit, { persisted = false } = {}) {
	if (!fit) return {};
	const ms = (value) =>
		persisted && Number.isSafeInteger(value) ? String(value) : value;
	return {
		...(persisted ? { deadlineFitEncoding: "decimal_milliseconds" } : {}),
		deadlineFitSource: fit.source,
		deadlineFitDeadlineMs: ms(fit.deadlineMs),
		deadlineFitEstimateMs: ms(fit.estimateMs),
		deadlineFitRemainingMs: ms(fit.remainingMs),
		deadlineFitCheckReserveMs: ms(fit.checkReserveMs),
		deadlineFitMarginMs: ms(fit.marginMs),
		deadlineFitBudgetMs: ms(fit.budgetMs),
		deadlineFitUnverified: fit.unverified,
		deadlineFitSplitRecommended: fit.splitRecommended,
	};
}
