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

export function buildSimpleRepairPrompt({
	originalTask,
	checkIndex,
	causeCode,
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
	return `${originalTask}\n\nOne correction is allowed. Acceptance check ${checkIndex} failed with ${causeCode}. Make only the correction needed to complete the original task within its declared file scope. Do not request or reproduce check output.`;
}
