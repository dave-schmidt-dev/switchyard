/** Pure classifier: maps an attempt result to a severity bucket. No I/O. */

const BASELINE_CODES = new Set([
	"baseline_check_failed",
	"baseline_mutation",
	"check_dependencies_unverified",
]);
const HARD_CODES = new Set(["run_store_write_failed", "project_lock_failed"]);
// Untyped results carry these in failureReason/errorKind instead of a diagnostic.
const HARD_UNTYPED = new Set([
	...HARD_CODES,
	"cleanup_failed",
	"provider_cleanup_failed",
	"provider_cancelled",
	"cancelled",
]);
const CHECK_CODES = new Set([
	"acceptance_check_failed",
	"acceptance_check_timeout",
	"check_repair_failed",
]);

/**
 * Classify a single attempt failure into a severity bucket.
 *
 * @param {object} params
 * @param {object} params.result - The engine result object (status, failurePhase,
 *   failureReason, errorKind, partialWorktree, providerReliability).
 * @param {object} [params.accountability] - Derived accountability object with
 *   causeCategory and causeCode (from deriveFailureAccountability). May be absent
 *   when providerReliability was not present.
 * @returns {{ severity: "hard"|"soft"|"baseline", reason: string, salvageable: boolean }}
 *   Frozen classification object. First-match-wins over the ordered rule set.
 */
export function classifyAttemptFailure({ result, accountability }) {
	const pr = result?.providerReliability;
	const causeCode = pr?.causeCode ?? accountability?.causeCode;
	const causeCategory = pr?.causeCategory ?? accountability?.causeCategory;
	const phase = pr?.phase;
	const failurePhase = result?.failurePhase;
	const errorKind = result?.errorKind;
	const failureReason = result?.failureReason;

	// Rule 1 — baseline: not evidence against the target provider
	if (
		failurePhase === "baseline" ||
		phase === "baseline" ||
		BASELINE_CODES.has(causeCode) ||
		BASELINE_CODES.has(failureReason)
	) {
		return Object.freeze({
			severity: "baseline",
			reason: "baseline_failed",
			salvageable: false,
		});
	}

	// Rule 2 — hard: unsafe or unrecoverable
	if (
		causeCategory === "cleanup" ||
		causeCategory === "cancellation" ||
		causeCategory === "input" ||
		HARD_CODES.has(causeCode) ||
		HARD_UNTYPED.has(errorKind) ||
		HARD_UNTYPED.has(failureReason) ||
		failurePhase === "cleanup"
	) {
		return Object.freeze({
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		});
	}

	// Rule 3a — soft/check_failed
	if (
		causeCategory === "check" ||
		CHECK_CODES.has(causeCode) ||
		errorKind === "check_failed" ||
		failureReason === "check_failed"
	) {
		return Object.freeze({
			severity: "soft",
			reason: "check_failed",
			salvageable: typeof result?.partialWorktree === "string",
		});
	}

	// Rule 3b — soft/empty_diff
	if (failureReason === "empty_diff" || errorKind === "empty_diff") {
		return Object.freeze({
			severity: "soft",
			reason: "empty_diff",
			salvageable: false,
		});
	}

	// Rule 3c — soft/policy_rejected
	if (causeCategory === "policy") {
		return Object.freeze({
			severity: "soft",
			reason: "policy_rejected",
			salvageable: false,
		});
	}

	// Rule 3d — soft/environment_failure (outside baseline — already handled above)
	if (causeCategory === "environment") {
		return Object.freeze({
			severity: "soft",
			reason: "environment_failure",
			salvageable: false,
		});
	}

	// Rule 3e — soft/execution_failed (provider category, unknown, untyped)
	return Object.freeze({
		severity: "soft",
		reason: "execution_failed",
		salvageable: false,
	});
}
