import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";

// Helper: build an accountability-like object mirroring deriveFailureAccountability output.
function acct({ causeCode = "unknown", causeCategory = "unknown" } = {}) {
	return { causeCode, causeCategory };
}

// Helper: build a providerReliability diagnostic fragment.
function pr({ causeCode, causeCategory, phase = "provider" } = {}) {
	return { causeCode, causeCategory, phase };
}

const TABLE = [
	// ── Rule 1: baseline ────────────────────────────────────────────────────
	{
		label: "baseline via failurePhase",
		input: {
			result: { failurePhase: "baseline", errorKind: "environment_failure" },
			accountability: acct(),
		},
		expected: {
			severity: "baseline",
			reason: "baseline_failed",
			salvageable: false,
		},
	},
	{
		label: "baseline via providerReliability.phase",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "baseline_check_failed",
					causeCategory: "environment",
					phase: "baseline",
				}),
			},
			accountability: acct({
				causeCode: "baseline_check_failed",
				causeCategory: "environment",
			}),
		},
		expected: {
			severity: "baseline",
			reason: "baseline_failed",
			salvageable: false,
		},
	},
	{
		label: "baseline via causeCode baseline_check_failed",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "baseline_check_failed",
					causeCategory: "environment",
				}),
			},
			accountability: acct({
				causeCode: "baseline_check_failed",
				causeCategory: "environment",
			}),
		},
		expected: {
			severity: "baseline",
			reason: "baseline_failed",
			salvageable: false,
		},
	},
	{
		label: "baseline via causeCode baseline_mutation",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "baseline_mutation",
					causeCategory: "environment",
				}),
			},
			accountability: acct({
				causeCode: "baseline_mutation",
				causeCategory: "environment",
			}),
		},
		expected: {
			severity: "baseline",
			reason: "baseline_failed",
			salvageable: false,
		},
	},
	{
		label:
			"baseline via causeCode check_dependencies_unverified (providerReliability absent, falls back to accountability)",
		input: {
			result: { failureReason: "check_dependencies_unverified" },
			accountability: acct({
				causeCode: "check_dependencies_unverified",
				causeCategory: "environment",
			}),
		},
		expected: {
			severity: "baseline",
			reason: "baseline_failed",
			salvageable: false,
		},
	},
	{
		label:
			"baseline via failureReason check_dependencies_unverified (no providerReliability, no accountability causeCode)",
		input: {
			result: { failureReason: "check_dependencies_unverified" },
			accountability: acct(),
		},
		expected: {
			severity: "baseline",
			reason: "baseline_failed",
			salvageable: false,
		},
	},

	// ── Rule 2: hard ────────────────────────────────────────────────────────
	{
		label: "hard via causeCategory cleanup",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "cleanup_failed",
					causeCategory: "cleanup",
				}),
			},
			accountability: acct({
				causeCode: "cleanup_failed",
				causeCategory: "cleanup",
			}),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label: "hard via causeCategory cancellation",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "cancelled",
					causeCategory: "cancellation",
				}),
			},
			accountability: acct({
				causeCode: "cancelled",
				causeCategory: "cancellation",
			}),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label: "hard via causeCategory input",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "input_rejected",
					causeCategory: "input",
				}),
			},
			accountability: acct({
				causeCode: "input_rejected",
				causeCategory: "input",
			}),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label:
			"hard via causeCode run_store_write_failed (fallback: no providerReliability)",
		input: {
			result: {},
			accountability: acct({
				causeCode: "run_store_write_failed",
				causeCategory: "environment",
			}),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label: "hard via causeCode project_lock_failed",
		input: {
			result: {},
			accountability: acct({
				causeCode: "project_lock_failed",
				causeCategory: "environment",
			}),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label: "hard via errorKind cleanup_failed (no providerReliability)",
		input: {
			result: { errorKind: "cleanup_failed" },
			accountability: acct(),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},

	// ── Rule 3a: soft/check_failed ──────────────────────────────────────────
	{
		label: "soft/check_failed via causeCategory check",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "acceptance_check_failed",
					causeCategory: "check",
				}),
				partialWorktree: null,
			},
			accountability: acct({
				causeCode: "acceptance_check_failed",
				causeCategory: "check",
			}),
		},
		expected: { severity: "soft", reason: "check_failed", salvageable: false },
	},
	{
		label:
			"soft/check_failed via causeCode acceptance_check_failed — salvageable when partialWorktree set",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "acceptance_check_failed",
					causeCategory: "check",
				}),
				partialWorktree: "/tmp/worktree",
			},
			accountability: acct({
				causeCode: "acceptance_check_failed",
				causeCategory: "check",
			}),
		},
		expected: { severity: "soft", reason: "check_failed", salvageable: true },
	},
	{
		label: "soft/check_failed via causeCode acceptance_check_timeout",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "acceptance_check_timeout",
					causeCategory: "check",
				}),
				partialWorktree: null,
			},
			accountability: acct({
				causeCode: "acceptance_check_timeout",
				causeCategory: "check",
			}),
		},
		expected: { severity: "soft", reason: "check_failed", salvageable: false },
	},
	{
		label: "soft/check_failed via causeCode check_repair_failed",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "check_repair_failed",
					causeCategory: "check",
				}),
				partialWorktree: null,
			},
			accountability: acct({
				causeCode: "check_repair_failed",
				causeCategory: "check",
			}),
		},
		expected: { severity: "soft", reason: "check_failed", salvageable: false },
	},
	{
		label:
			"soft/check_failed via errorKind check_failed (no providerReliability)",
		input: {
			result: { errorKind: "check_failed", partialWorktree: null },
			accountability: acct(),
		},
		expected: { severity: "soft", reason: "check_failed", salvageable: false },
	},
	{
		label:
			"soft/check_failed via failureReason check_failed (no providerReliability)",
		input: {
			result: { failureReason: "check_failed", partialWorktree: null },
			accountability: acct(),
		},
		expected: { severity: "soft", reason: "check_failed", salvageable: false },
	},
	{
		label:
			"soft/check_failed via failureReason check_failed — salvageable when string partialWorktree",
		input: {
			result: { failureReason: "check_failed", partialWorktree: "/work/tree" },
			accountability: acct(),
		},
		expected: { severity: "soft", reason: "check_failed", salvageable: true },
	},

	// ── Rule 3b: soft/empty_diff ─────────────────────────────────────────────
	{
		label: "soft/empty_diff via failureReason",
		input: {
			result: { failureReason: "empty_diff" },
			accountability: acct(),
		},
		expected: { severity: "soft", reason: "empty_diff", salvageable: false },
	},
	{
		label: "soft/empty_diff via errorKind",
		input: {
			result: { errorKind: "empty_diff" },
			accountability: acct(),
		},
		expected: { severity: "soft", reason: "empty_diff", salvageable: false },
	},

	// ── Rule 3c: soft/policy_rejected ───────────────────────────────────────
	{
		label: "soft/policy_rejected via diff_rejected",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "diff_rejected",
					causeCategory: "policy",
				}),
			},
			accountability: acct({
				causeCode: "diff_rejected",
				causeCategory: "policy",
			}),
		},
		expected: {
			severity: "soft",
			reason: "policy_rejected",
			salvageable: false,
		},
	},
	{
		label: "soft/policy_rejected via scope_rejected",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "scope_rejected",
					causeCategory: "policy",
				}),
			},
			accountability: acct({
				causeCode: "scope_rejected",
				causeCategory: "policy",
			}),
		},
		expected: {
			severity: "soft",
			reason: "policy_rejected",
			salvageable: false,
		},
	},

	// ── Rule 3d: soft/environment_failure ───────────────────────────────────
	{
		label:
			"soft/environment_failure via causeCategory environment (non-baseline code)",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "environment_failure",
					causeCategory: "environment",
				}),
			},
			accountability: acct({
				causeCode: "environment_failure",
				causeCategory: "environment",
			}),
		},
		expected: {
			severity: "soft",
			reason: "environment_failure",
			salvageable: false,
		},
	},

	// ── Rule 3e: soft/execution_failed (catch-all) ───────────────────────────
	{
		label: "soft/execution_failed — provider_exit_nonzero (unknown category)",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "provider_exit_nonzero",
					causeCategory: "unknown",
				}),
			},
			accountability: acct({
				causeCode: "provider_exit_nonzero",
				causeCategory: "unknown",
			}),
		},
		expected: {
			severity: "soft",
			reason: "execution_failed",
			salvageable: false,
		},
	},
	{
		label: "soft/execution_failed — untyped result, no providerReliability",
		input: {
			result: {
				failureReason: "provider_silence_timeout",
				errorKind: "execution_failed",
			},
			accountability: acct(),
		},
		expected: {
			severity: "soft",
			reason: "execution_failed",
			salvageable: false,
		},
	},
	{
		label:
			"soft/execution_failed — auth_expired without accountability (providerReliability present but category provider → falls to catch-all when not matched earlier)",
		input: {
			result: {
				providerReliability: pr({
					causeCode: "auth_expired",
					causeCategory: "provider",
				}),
			},
			accountability: acct({
				causeCode: "auth_expired",
				causeCategory: "provider",
			}),
		},
		expected: {
			severity: "soft",
			reason: "execution_failed",
			salvageable: false,
		},
	},
	{
		label:
			"hard via untyped failureReason run_store_write_failed (production accountability is unknown)",
		input: {
			result: { failureReason: "run_store_write_failed" },
			accountability: acct(),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label:
			"hard via untyped failureReason project_lock_failed (production accountability is unknown)",
		input: {
			result: { failureReason: "project_lock_failed" },
			accountability: acct(),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label:
			"hard via untyped failureReason provider_cancelled (production accountability is unknown)",
		input: {
			result: { failureReason: "provider_cancelled" },
			accountability: acct(),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label:
			"hard via untyped errorKind provider_cleanup_failed (production accountability is unknown)",
		input: {
			result: { errorKind: "provider_cleanup_failed" },
			accountability: acct(),
		},
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label:
			"hard via untyped errorKind cleanup_failed (production accountability is unknown)",
		input: { result: { errorKind: "cleanup_failed" }, accountability: acct() },
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
	{
		label: "hard via untyped cleanup phase",
		input: { result: { failurePhase: "cleanup" }, accountability: acct() },
		expected: {
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		},
	},
];

for (const { label, input, expected } of TABLE) {
	test(label, () => {
		const result = classifyAttemptFailure(input);
		// Verify the object is frozen.
		strictEqual(Object.isFrozen(result), true, "result must be frozen");
		deepStrictEqual(
			{
				severity: result.severity,
				reason: result.reason,
				salvageable: result.salvageable,
			},
			expected,
		);
	});
}
