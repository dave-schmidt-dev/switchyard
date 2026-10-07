import { notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import {
	FAILURE_REGISTRY,
	resolveFailure,
} from "../src/switchyard/diagnostics/failure-registry.mjs";
import { deriveFailureAccountability } from "../src/switchyard/simple/failure-accountability.mjs";
import {
	cancelSourceForAbortSignal,
	classifyExecutionFailure,
} from "../src/switchyard/simple/provider-invocation.mjs";
import {
	classifySimpleErrorKind,
	createSimpleProviderReliabilityDiagnostic,
} from "../src/switchyard/simple/reliability.mjs";

// ── Synthetic fixtures ──────────────────────────────────────────────────────
// Run ids appear in test names only; every fixture below is synthetic.

const cancelledBySigterm = {
	success: false,
	code: null,
	signal: "SIGTERM",
	timedOut: false,
	cancelled: true,
	cancelSource: "signal_sigterm",
};

const cancelledAndTimedOut = {
	success: false,
	code: null,
	signal: null,
	timedOut: true,
	cancelled: true,
	cancelSource: "signal_sigterm",
};

// Vibe exits 76 when it hits its internal deadline; no OS signal is involved.
const vibeExit76TimedOut = {
	success: false,
	code: 76,
	signal: null,
	timedOut: true,
	cancelled: false,
};

const vibeExit76Plain = {
	success: false,
	code: 76,
	signal: null,
	timedOut: false,
	cancelled: false,
};

// ── S6: cancellation closes every provider-failure reason ───────────────────

test("run simple-a3d92099: a cancelled provider result resolves to cancelled despite reason provider_signalled", () => {
	const resolved = resolveFailure({
		reason: "provider_signalled",
		phase: "execute",
		providerResult: cancelledBySigterm,
	});
	strictEqual(resolved.causeCode, "cancelled");
	strictEqual(resolved.causeCategory, "cancellation");
	strictEqual(resolved.cancelled, true);
	strictEqual(resolved.cancelSource, "signal_sigterm");
});

test("run simple-dcc50666: a cancelled provider result resolves to cancelled despite reason provider_silence_timeout", () => {
	const resolved = resolveFailure({
		reason: "provider_silence_timeout",
		phase: "execute",
		providerResult: cancelledBySigterm,
	});
	strictEqual(resolved.causeCode, "cancelled");
	strictEqual(resolved.causeCategory, "cancellation");
	strictEqual(resolved.cancelSource, "signal_sigterm");
});

test("run simple-1ea3a183: a cancelled provider result resolves to cancelled for any reason, including an unregistered one", () => {
	for (const reason of [
		"provider_signalled",
		"provider_silence_timeout",
		"provider_deadline_exceeded",
		"provider_timed_out",
		"provider_exit_nonzero",
		"provider_cancelled",
		"simple_execution_failed",
	]) {
		const resolved = resolveFailure({
			reason,
			phase: "execute",
			providerResult: cancelledBySigterm,
		});
		strictEqual(resolved.causeCode, "cancelled", reason);
		strictEqual(resolved.causeCategory, "cancellation", reason);
		strictEqual(resolved.cancelSource, "signal_sigterm", reason);
	}
	// Cancellation also wins when the result is both cancelled and timed out.
	const resolved = resolveFailure({
		reason: "provider_timed_out",
		phase: "execute",
		providerResult: cancelledAndTimedOut,
	});
	strictEqual(resolved.causeCode, "cancelled");
	strictEqual(resolved.cancelSource, "signal_sigterm");
});

test("cancelSource maps the AbortSignal reason onto the closed enum", () => {
	const captainKill = new AbortController();
	captainKill.abort("SIGTERM");
	strictEqual(cancelSourceForAbortSignal(captainKill.signal), "signal_sigterm");
	// A caller deadline arrives as SIGTERM too and stays signal_sigterm.
	const callerDeadline = new AbortController();
	callerDeadline.abort("SIGTERM");
	strictEqual(
		cancelSourceForAbortSignal(callerDeadline.signal),
		"signal_sigterm",
	);
	const interrupt = new AbortController();
	interrupt.abort("SIGINT");
	strictEqual(cancelSourceForAbortSignal(interrupt.signal), "signal_sigint");
	const internalDeadline = new AbortController();
	internalDeadline.abort(
		Object.assign(new Error("deadline_expired"), {
			code: "deadline_expired",
		}),
	);
	strictEqual(
		cancelSourceForAbortSignal(internalDeadline.signal),
		"internal_deadline",
	);
	const plainAbort = new AbortController();
	plainAbort.abort();
	strictEqual(cancelSourceForAbortSignal(plainAbort.signal), "unspecified");
	strictEqual(
		cancelSourceForAbortSignal(new AbortController().signal),
		"unspecified",
	);
	strictEqual(cancelSourceForAbortSignal(null), "unspecified");
});

test("a cancelled resolution validates cancelSource against the closed enum", () => {
	strictEqual(
		resolveFailure({
			reason: "provider_cancelled",
			phase: "execute",
			providerResult: { success: false, cancelled: true },
		}).cancelSource,
		"unspecified",
	);
	strictEqual(
		resolveFailure({
			reason: "provider_cancelled",
			phase: "execute",
			providerResult: {
				success: false,
				cancelled: true,
				cancelSource: "not_a_cancel_source",
			},
		}).cancelSource,
		"unspecified",
	);
	strictEqual(
		resolveFailure({
			reason: "provider_cancelled",
			phase: "execute",
			cancelled: true,
			cancelSource: "signal_sigint",
		}).cancelSource,
		"signal_sigint",
	);
	// A non-cancelled resolution carries no cancel source.
	strictEqual(
		resolveFailure({
			reason: "provider_exit_nonzero",
			phase: "execute",
			providerResult: vibeExit76Plain,
		}).cancelSource,
		null,
	);
});

// ── Deadline fingerprints: one fingerprint, one code ────────────────────────

test("run simple-a6fd1a19: vibe exit 76 with timedOut and no signal resolves to provider_deadline_exceeded from every entry point", () => {
	// Entry point 1: the failure code computed from the provider result.
	const failureCode = classifyExecutionFailure(vibeExit76TimedOut);
	strictEqual(failureCode, "provider_deadline_exceeded");
	strictEqual(
		createSimpleProviderReliabilityDiagnostic({
			failureReason: failureCode,
			failurePhase: "execute",
			providerResult: vibeExit76TimedOut,
		}).causeCode,
		"provider_deadline_exceeded",
	);
	// Entry point 2: the errorKind from classifySimpleErrorKind fed back into
	// the registry, as the engine's typed failure paths do.
	const errorKind = classifySimpleErrorKind(failureCode, "execute", null);
	strictEqual(errorKind, "execution_failed");
	strictEqual(
		resolveFailure({
			reason: failureCode,
			phase: "execute",
			errorKind,
			providerResult: vibeExit76TimedOut,
		}).causeCode,
		"provider_deadline_exceeded",
	);
	// Entry point 3: the index.mjs catch path, where the reason arrives from
	// error.code while the provider result still carries the fingerprint.
	strictEqual(
		resolveFailure({
			reason: "provider_exit_nonzero",
			phase: "execute",
			providerResult: vibeExit76TimedOut,
		}).causeCode,
		"provider_deadline_exceeded",
	);
	// timedOut also wins over a verified adapter diagnostic.
	strictEqual(
		resolveFailure({
			reason: "provider_exit_nonzero",
			phase: "execute",
			providerResult: {
				...vibeExit76TimedOut,
				diagnosticCode: "auth_expired",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
			},
		}).causeCode,
		"provider_deadline_exceeded",
	);
});

test("run simple-d63b7a07: timedOut wins over provider_exit_nonzero and reaches routing memory via the deadline path", () => {
	const diagnostic = createSimpleProviderReliabilityDiagnostic({
		failureReason: "provider_exit_nonzero",
		failurePhase: "execute",
		providerResult: vibeExit76TimedOut,
	});
	strictEqual(diagnostic.causeCode, "provider_deadline_exceeded");
	strictEqual(diagnostic.causeCategory, "provider");
	strictEqual(diagnostic.timedOut, true);
	const accountability = deriveFailureAccountability({
		providerReliability: diagnostic,
		provenance: {},
	});
	strictEqual(accountability.owner, "provider");
	strictEqual(accountability.providerMemoryEligible, true);
	// Without the timedOut fingerprint the same exit code stays provider_exit_nonzero.
	strictEqual(
		createSimpleProviderReliabilityDiagnostic({
			failureReason: "provider_exit_nonzero",
			failurePhase: "execute",
			providerResult: vibeExit76Plain,
		}).causeCode,
		"provider_exit_nonzero",
	);
});

test("run simple-6969459f: a timed-out check resolves to acceptance_check_timeout", () => {
	strictEqual(
		resolveFailure({
			reason: "check_failed",
			phase: "checks",
			timedOut: true,
		}).causeCode,
		"acceptance_check_timeout",
	);
	strictEqual(
		resolveFailure({
			reason: "check_deadline_exceeded",
			phase: "checks",
			timedOut: true,
		}).causeCode,
		"acceptance_check_timeout",
	);
	strictEqual(
		resolveFailure({
			reason: "check_failed",
			phase: "checks",
			providerResult: { timedOut: true, cancelled: false },
		}).causeCode,
		"acceptance_check_timeout",
	);
	// Without the timedOut fingerprint a failed check keeps its own code.
	strictEqual(
		resolveFailure({ reason: "check_failed", phase: "checks" }).causeCode,
		"acceptance_check_failed",
	);
});

// ── Closed codes for every reason that previously fell to unknown ────────────

test("every reason that previously fell to unknown now resolves to a closed cause code", () => {
	const expectations = [
		["provider_silence_timeout", "provider_silence_timeout", "provider"],
		["provider_signalled", "provider_signalled", "provider"],
		["provider_adapter_error", "provider_adapter_error", "provider"],
		["provider_launch_failed", "provider_launch_failed", "provider"],
		[
			"provider_result_inconsistent",
			"provider_result_inconsistent",
			"provider",
		],
		["provider_group_unconfirmed", "provider_group_unconfirmed", "cleanup"],
		["provider_verdict_rejected", "provider_verdict_rejected", "provider"],
		["simple_execution_failed", "simple_execution_failed", "unknown"],
		["check_group_unconfirmed", "check_group_unconfirmed", "cleanup"],
		["check_session_cleanup_failed", "check_session_cleanup_failed", "cleanup"],
		[
			"check_environment_unavailable",
			"check_environment_unavailable",
			"environment",
		],
		["check_candidate_rejected", "check_candidate_rejected", "check"],
		[
			"check_session_base_mismatch",
			"check_session_base_mismatch",
			"environment",
		],
		["check_session_unavailable", "check_session_unavailable", "environment"],
		[
			"project_lock_release_unconfirmed",
			"project_lock_release_unconfirmed",
			"cleanup",
		],
		["project_lock_failed", "project_lock_failed", "environment"],
		["project_lock_owner_live", "project_lock_owner_live", "environment"],
		["project_lock_owner_dead", "project_lock_owner_dead", "environment"],
		["declared_path_has_owner_edits", "declared_path_has_owner_edits", "input"],
		["worktree_allocation_failed", "worktree_allocation_failed", "environment"],
		["worktree_ownership_failed", "worktree_ownership_failed", "cleanup"],
		["git_control_tampered", "git_control_tampered", "environment"],
		[
			"target_identity_unavailable",
			"target_identity_unavailable",
			"environment",
		],
		[
			"invocation_descriptor_unavailable",
			"invocation_descriptor_unavailable",
			"environment",
		],
		[
			"local_descriptor_model_unavailable",
			"local_descriptor_model_unavailable",
			"environment",
		],
		[
			"local_descriptor_args_unsafe",
			"local_descriptor_args_unsafe",
			"environment",
		],
	];
	for (const [reason, causeCode, causeCategory] of expectations) {
		const row = FAILURE_REGISTRY.get(reason);
		ok(row, `${reason} is registered`);
		strictEqual(row.causeCode, causeCode, `${reason} row causeCode`);
		const resolved = resolveFailure({ reason });
		notStrictEqual(resolved.causeCode, "unknown", reason);
		strictEqual(resolved.causeCode, causeCode, `${reason} causeCode`);
		strictEqual(resolved.causeCategory, causeCategory, `${reason} category`);
	}
	// deadline_expired closes per phase: execute and checks.
	strictEqual(
		resolveFailure({ reason: "deadline_expired", phase: "execute" }).causeCode,
		"provider_deadline_exceeded",
	);
	strictEqual(
		resolveFailure({ reason: "deadline_expired", phase: "checks" }).causeCode,
		"acceptance_check_timeout",
	);
});

// ── provider_exit_nonzero accountability ─────────────────────────────────────

test("provider_exit_nonzero is provider-caused and reaches routing memory only when provenance-trusted", () => {
	const row = FAILURE_REGISTRY.get("provider_exit_nonzero");
	ok(row, "provider_exit_nonzero is registered");
	// The persisted category stays "unknown" for committed-reader compatibility.
	strictEqual(row.causeCategory, "unknown");
	strictEqual(row.providerCaused, true);
	const diagnostic = createSimpleProviderReliabilityDiagnostic({
		failureReason: "provider_exit_nonzero",
		failurePhase: "execute",
		providerResult: vibeExit76Plain,
	});
	strictEqual(diagnostic.causeCode, "provider_exit_nonzero");
	strictEqual(diagnostic.causeCategory, "unknown");
	const untrusted = deriveFailureAccountability({
		providerReliability: diagnostic,
		provenance: {},
	});
	strictEqual(untrusted.owner, "unknown");
	strictEqual(untrusted.providerMemoryEligible, false);
	const mismatched = deriveFailureAccountability({
		providerReliability: diagnostic,
		provenance: {
			diagnosticCode: "auth_expired",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
		},
	});
	strictEqual(mismatched.owner, "unknown");
	strictEqual(mismatched.providerMemoryEligible, false);
	const trusted = deriveFailureAccountability({
		providerReliability: diagnostic,
		provenance: {
			diagnosticCode: "provider_exit_nonzero",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
		},
	});
	strictEqual(trusted.owner, "provider");
	strictEqual(trusted.providerMemoryEligible, true);
});

// ── Baseline and venv rows ──────────────────────────────────────────────────

test("baseline_check_unavailable keeps its own baseline code, distinct from baseline_check_failed", () => {
	const unavailable = resolveFailure({
		reason: "baseline_check_unavailable",
		phase: "baseline",
		errorKind: "environment_failure",
	});
	strictEqual(unavailable.causeCode, "baseline_check_unavailable");
	strictEqual(unavailable.causeCategory, "environment");
	strictEqual(unavailable.severity, "baseline");
	const failed = resolveFailure({
		reason: "baseline_check_failed",
		phase: "baseline",
		errorKind: "environment_failure",
	});
	strictEqual(failed.causeCode, "baseline_check_failed");
	notStrictEqual(unavailable.causeCode, failed.causeCode);
});

test("check_venv_outside_project remains a registry row with its own environment code", () => {
	const row = FAILURE_REGISTRY.get("check_venv_outside_project");
	ok(row, "check_venv_outside_project is registered");
	strictEqual(row.causeCode, "check_venv_outside_project");
	strictEqual(row.causeCategory, "environment");
	strictEqual(
		resolveFailure({
			reason: "check_venv_outside_project",
			phase: "checks",
		}).causeCode,
		"check_venv_outside_project",
	);
});
