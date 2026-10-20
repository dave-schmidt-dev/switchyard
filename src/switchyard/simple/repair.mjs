const MIN_PROVIDER_REPAIR_BUDGET_MS = 30_000;
const MIN_ACCEPTANCE_RECHECK_BUDGET_MS = 60_000;
const PER_CHECK_RECHECK_BUDGET_MS = 30_000;

export function simpleRepairBudget(remainingMs, checkCount) {
	if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) return null;
	const checkBudget = Math.max(
		MIN_ACCEPTANCE_RECHECK_BUDGET_MS,
		Math.max(1, checkCount) * PER_CHECK_RECHECK_BUDGET_MS,
	);
	const providerBudget = remainingMs - checkBudget;
	if (providerBudget < MIN_PROVIDER_REPAIR_BUDGET_MS) return null;
	return { providerTimeoutMs: providerBudget, checkReserveMs: checkBudget };
}

/**
 * Builds the single repair prompt after a failed acceptance check.
 *
 * @param {object} options
 * @param {string} options.originalTask The guarded prompt of the first attempt.
 * @param {number} options.checkIndex 1-based index of the failed check.
 * @param {string} options.causeCode `acceptance_check_failed` or `acceptance_check_timeout`.
 * @param {boolean} [options.redAtBaseline] The check also failed on the unmodified checkout (the pre-provider dry run), so some failures may predate the task.
 * @param {boolean} [options.differential] That red check passes test by test (differential acceptance), so the note asks only for the task's own tests and no new failure.
 * @returns {string}
 */
export function buildSimpleRepairPrompt({
	originalTask,
	checkIndex,
	causeCode,
	redAtBaseline = false,
	differential = false,
}) {
	if (
		typeof originalTask !== "string" ||
		!Number.isSafeInteger(checkIndex) ||
		checkIndex < 1 ||
		!new Set(["acceptance_check_failed", "acceptance_check_timeout"]).has(
			causeCode,
		)
	)
		throw new TypeError("simple repair context is invalid");
	const baselineNote = !redAtBaseline
		? ""
		: differential
			? " This check also failed on the unmodified checkout before your change and is judged test by test: the task's own tests must pass and no new failure may appear; failures that predate the task outside your declared files may remain."
			: " This check also failed on the unmodified checkout before your change, so some of its failures may predate the task; fix only what the task requires.";
	return `${originalTask}\n\nOne correction is allowed. Acceptance check ${checkIndex} failed with ${causeCode}. Make only the correction needed to complete the original task within its declared file scope. Do not request or reproduce check output.${baselineNote}`;
}
