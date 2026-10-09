import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import {
	BASELINE_CODES,
	CHECK_CODES,
	CODE_CATEGORIES,
	causeCategoryFor,
	FAILURE_REGISTRY,
	FAILURE_ROWS,
	HARD_CODES,
	HARD_UNTYPED,
	resolveFailure,
} from "../src/switchyard/diagnostics/failure-registry.mjs";

// ── Frozen classification oracle ────────────────────────────────────────────
// Independent copies of the Task 1.4 classifiers plus the Task 2.1
// closed-code rules and the Task 2.7 dependency-refusal rules. The registry
// must reproduce these outputs exactly, so this file deliberately does not
// import the production classifiers that now delegate to the registry.

const ORACLE_VERIFIED_PROVIDER_CODES = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"cli_usage_error",
	"execution_timed_out",
	"provider_signalled",
]);

function oracleErrorKind(failureReason, failurePhase, errno) {
	if (errno === "EPERM" || errno === "EACCES") return "permission_denied";
	if (
		[
			"EROFS",
			"ENOSPC",
			"EMFILE",
			"ENFILE",
			"EIO",
			"EDQUOT",
			"ETIMEDOUT",
			"ECONNREFUSED",
			"ENETUNREACH",
			"ENETDOWN",
		].includes(errno)
	)
		return "environment_failure";
	if (
		["launcher_environment_unavailable", "request_log_open_failed"].includes(
			failureReason,
		)
	)
		return "environment_failure";
	if (failureReason === "run_store_write_failed")
		return "run_store_write_failed";
	if (failurePhase === "baseline") return "environment_failure";
	if (failureReason === "check_dependencies_unverified")
		return "environment_failure";
	// Task 2.3: check-session setup failure is environmental.
	if (failureReason === "check_setup_failed") return "environment_failure";
	// Task 2.4: a check that cannot run in this environment.
	if (failureReason === "check_environment_failed")
		return "environment_failure";
	// Task 3.2: a genuine conflict with the host's committed HEAD.
	if (failureReason === "host_concurrency") return "environment_failure";
	// Task 2.7: a candidate-changed dependency manifest is a check fact.
	if (failureReason === "check_manifest_changed_by_diff") return "check_failed";
	if (
		[
			"paid_overage_not_allowed",
			"included_usage_unverified",
			"ambiguous_combined_rename_spelling",
		].includes(failureReason)
	)
		return "policy_violation";
	if (failureReason === "manifest_review_required")
		return failurePhase === "input_validation"
			? "validation_failed"
			: "policy_violation";
	if (failureReason === "empty_diff") return "empty_diff";
	if (
		[
			"invalid_invocation",
			"check_out_of_clone_exec",
			"check_tool_denied",
			"predecessor_receipt_invalid",
			"predecessor_receipt_missing",
			"predecessor_receipt_mismatch",
			"predecessor_receipt_unverified",
		].includes(failureReason) ||
		(failureReason?.startsWith("dirty_overlay_") &&
			failureReason !== "dirty_overlay_drift")
	)
		return "validation_failed";
	if (
		[
			"dirty_overlay_drift",
			"project_head_changed_concurrently",
			"declared_path_changed_concurrently",
			"read_only_input_changed",
			"undeclared_paths_changed",
			"unsafe_diff",
			"integration_failed",
		].includes(failureReason)
	)
		return "policy_violation";
	if (
		failurePhase === "checks" ||
		[
			"check_failed",
			"check_deadline_exceeded",
			"check_silence_timeout",
		].includes(failureReason)
	)
		return "check_failed";
	if (
		[
			"provider_cleanup_failed",
			"worktree_cleanup_failed",
			"project_lock_release_unconfirmed",
		].includes(failureReason) ||
		failurePhase === "cleanup"
	)
		return "cleanup_failed";
	if (
		[
			"provider_silence_timeout",
			"provider_deadline_exceeded",
			"provider_cancelled",
			"provider_signalled",
			"provider_adapter_error",
			"provider_result_inconsistent",
			"provider_exit_nonzero",
			"provider_launch_failed",
		].includes(failureReason) ||
		failurePhase === "execute"
	)
		return "execution_failed";
	if (failureReason === "deadline_expired") {
		if (["preflight", "input_validation"].includes(failurePhase))
			return "validation_failed";
		if (failurePhase === "execute") return "execution_failed";
		if (failurePhase === "checks") return "check_failed";
		if (failurePhase === "cleanup") return "cleanup_failed";
		return "policy_violation";
	}
	if (
		[
			"project_revision_unavailable",
			"workspace_clone_failed",
			"workspace_checkout_failed",
			"dirty_overlay_stage_failed",
			"dirty_overlay_baseline_failed",
		].includes(failureReason)
	)
		return "environment_failure";
	if (failurePhase === "input_validation") return "validation_failed";
	return "unclassified_failure";
}

// Closed cause codes for every reason that previously fell through the
// classifier chain to "unknown"; mirrors the registry's closed-code table.
const ORACLE_CLOSED_CAUSE_CODES = new Map([
	["provider_silence_timeout", "provider_silence_timeout"],
	["provider_signalled", "provider_signalled"],
	["provider_adapter_error", "provider_adapter_error"],
	["provider_launch_failed", "provider_launch_failed"],
	["provider_result_inconsistent", "provider_result_inconsistent"],
	["provider_group_unconfirmed", "provider_group_unconfirmed"],
	["provider_verdict_rejected", "provider_verdict_rejected"],
	["simple_execution_failed", "simple_execution_failed"],
	["check_group_unconfirmed", "check_group_unconfirmed"],
	["check_session_cleanup_failed", "check_session_cleanup_failed"],
	["check_environment_unavailable", "check_environment_unavailable"],
	["check_candidate_rejected", "check_candidate_rejected"],
	["check_session_base_mismatch", "check_session_base_mismatch"],
	["check_session_unavailable", "check_session_unavailable"],
	["project_lock_release_unconfirmed", "project_lock_release_unconfirmed"],
	["project_lock_failed", "project_lock_failed"],
	["project_lock_owner_live", "project_lock_owner_live"],
	["project_lock_owner_dead", "project_lock_owner_dead"],
	["declared_path_has_owner_edits", "declared_path_has_owner_edits"],
	["worktree_allocation_failed", "worktree_allocation_failed"],
	["worktree_missing", "worktree_missing"],
	["worktree_ownership_failed", "worktree_ownership_failed"],
	["git_control_tampered", "git_control_tampered"],
	["target_identity_unavailable", "target_identity_unavailable"],
	["invocation_descriptor_unavailable", "invocation_descriptor_unavailable"],
	["local_descriptor_model_unavailable", "local_descriptor_model_unavailable"],
	["local_descriptor_args_unsafe", "local_descriptor_args_unsafe"],
	// Task 2.3: route dead ends and bridge request-ledger errors.
	["no_eligible", "no_route_available"],
	["no_eligible_provider", "no_route_available"],
	["route_health_blocked", "no_route_available"],
	["local_adapter_unavailable", "no_route_available"],
	["routing_selection_invalid", "no_route_available"],
	["request_event_end_invalid", "request_evidence_invalid"],
	["request_event_end_missing", "request_evidence_invalid"],
	["request_event_truncated", "request_evidence_invalid"],
	["request_event_invalid", "request_evidence_invalid"],
	["request_event_after_end", "request_evidence_invalid"],
	["request_event_line_too_long", "request_evidence_invalid"],
	["request_event_write_failed", "request_evidence_invalid"],
	["request_event_close_failed", "request_evidence_invalid"],
]);

function oracleCauseCode(reason, phase, providerResult, errorKind) {
	if (
		["launcher_environment_unavailable", "request_log_open_failed"].includes(
			reason,
		)
	)
		return "environment_failure";
	if (reason === "run_store_write_failed") return "run_store_write_failed";
	if (reason === "check_dependencies_unverified") return reason;
	// Task 2.3: wins over the generic environment_failure rule.
	if (reason === "check_setup_failed") return reason;
	// Task 2.4: wins over the generic environment_failure rule too.
	if (reason === "check_environment_failed") return reason;
	// Task 3.2: wins over the generic rules as well.
	if (reason === "host_concurrency") return reason;
	// Task 2.7: a candidate-changed dependency manifest has its own check cause.
	if (reason === "check_manifest_changed_by_diff") return reason;
	if (phase === "baseline") {
		if (reason === "baseline_mutation") return "baseline_mutation";
		if (reason === "baseline_check_unavailable")
			return "baseline_check_unavailable";
		return "baseline_check_failed";
	}
	if (["environment_failure", "permission_denied"].includes(errorKind))
		return "environment_failure";
	if (reason === "provider_cancelled") return "cancelled";
	if (reason === "provider_deadline_exceeded")
		return "provider_deadline_exceeded";
	if (
		phase === "execute" &&
		ORACLE_VERIFIED_PROVIDER_CODES.has(providerResult?.diagnosticCode) &&
		["adapter", "launcher"].includes(providerResult?.diagnosticOrigin) &&
		providerResult?.diagnosticEvidenceAvailable === true
	)
		return providerResult.diagnosticCode;
	if (reason === "provider_exit_nonzero") return "provider_exit_nonzero";
	if (reason === "check_failed") return "acceptance_check_failed";
	if (
		reason === "check_deadline_exceeded" ||
		reason === "check_silence_timeout"
	)
		return "acceptance_check_timeout";
	if (reason === "check_repair_succeeded") return "check_repair_succeeded";
	if (reason === "check_repair_failed") return "check_repair_failed";
	if (reason === "empty_diff") return "diff_rejected";
	if (
		[
			"undeclared_paths_changed",
			"read_only_input_changed",
			"unsafe_diff",
			"manifest_review_required",
			"dirty_overlay_drift",
			"project_head_changed_concurrently",
			"declared_path_changed_concurrently",
		].includes(reason)
	)
		return "scope_rejected";
	if (reason === "provider_cleanup_failed" || phase === "cleanup")
		return "cleanup_failed";
	if (errorKind === "policy_violation") return "scope_rejected";
	if (phase === "input_validation" || errorKind === "validation_failed")
		return "input_rejected";
	if (reason === "deadline_expired") {
		if (phase === "execute") return "provider_deadline_exceeded";
		if (phase === "checks" || phase === "check")
			return "acceptance_check_timeout";
	}
	return ORACLE_CLOSED_CAUSE_CODES.get(reason) ?? "unknown";
}

function oracleDiffCategory(reason) {
	if (reason === "empty_diff") return "empty";
	if (reason === "undeclared_paths_changed") return "undeclared";
	if (reason === "read_only_input_changed") return "read_only_input";
	if (reason === "manifest_review_required") return "manifest_review";
	if (reason === "unsafe_diff") return "unsafe";
	if (reason === "declared_path_changed_concurrently")
		return "concurrent_change";
	// Task 2.2: integrate-phase scope rejections gained a category.
	if (reason === "dirty_overlay_drift") return "concurrent_change";
	if (reason === "project_head_changed_concurrently")
		return "concurrent_change";
	// Task 3.2.
	if (reason === "host_concurrency") return "concurrent_change";
	if (reason === "ambiguous_combined_rename_spelling") return "integration";
	if (reason === "integration_failed") return "integration";
	return null;
}

const ORACLE_BASELINE_CODES = new Set([
	"baseline_check_failed",
	"baseline_check_unavailable",
	"baseline_mutation",
	"check_dependencies_unverified",
	// Task 2.3: setup precedes any baseline check but still stops the waterfall.
	"check_setup_failed",
	// Task 2.4: an environment-broken check fails every provider the same way.
	"check_environment_failed",
]);
const ORACLE_HARD_CODES = new Set([
	"run_store_write_failed",
	"project_lock_failed",
	// Task 2.7: a candidate-changed dependency manifest stops the run.
	"check_manifest_changed_by_diff",
	// A vanished disposable checkout stops the run without blaming the provider.
	"worktree_missing",
]);
const ORACLE_HARD_UNTYPED = new Set([
	...ORACLE_HARD_CODES,
	"cleanup_failed",
	"provider_cleanup_failed",
	"provider_cancelled",
	"cancelled",
]);
const ORACLE_CHECK_CODES = new Set([
	"acceptance_check_failed",
	"acceptance_check_timeout",
	"check_repair_failed",
]);

// Task 2.7: dependency refusals before the provider keep the baseline
// environment severity; after the provider starts they are hard check stops.
const ORACLE_PRE_PROVIDER_PHASES = new Set([
	"preflight",
	"route",
	"prepare",
	"baseline",
]);

function oracleSeverity(reason, phase, causeCode, causeCategory, errorKind) {
	if (
		(reason === "check_dependencies_unverified" ||
			causeCode === "check_dependencies_unverified") &&
		!ORACLE_PRE_PROVIDER_PHASES.has(phase)
	)
		return "hard";
	if (
		phase === "baseline" ||
		ORACLE_BASELINE_CODES.has(causeCode) ||
		ORACLE_BASELINE_CODES.has(reason)
	)
		return "baseline";
	if (
		["cleanup", "cancellation", "input"].includes(causeCategory) ||
		ORACLE_HARD_CODES.has(causeCode) ||
		ORACLE_HARD_UNTYPED.has(errorKind) ||
		ORACLE_HARD_UNTYPED.has(reason) ||
		phase === "cleanup"
	)
		return "hard";
	return "soft";
}

const ORACLE_CODE_CATEGORY = new Map([
	["auth_expired", "provider"],
	["quota_exhausted", "provider"],
	["model_unavailable", "provider"],
	["cli_usage_error", "provider"],
	["execution_timed_out", "provider"],
	["provider_deadline_exceeded", "provider"],
	["provider_signalled", "provider"],
	["provider_silence_timeout", "provider"],
	["provider_adapter_error", "provider"],
	["provider_launch_failed", "provider"],
	["provider_result_inconsistent", "provider"],
	["provider_group_unconfirmed", "cleanup"],
	["provider_verdict_rejected", "provider"],
	["provider_exit_nonzero", "unknown"],
	["launch_failed", "unknown"],
	["check_repair_succeeded", "check"],
	["check_repair_failed", "check"],
	["check_group_unconfirmed", "cleanup"],
	["check_session_cleanup_failed", "cleanup"],
	["check_environment_unavailable", "environment"],
	["check_candidate_rejected", "check"],
	["check_session_base_mismatch", "environment"],
	["check_session_unavailable", "environment"],
	["baseline_check_failed", "environment"],
	["baseline_check_unavailable", "environment"],
	["baseline_mutation", "environment"],
	["environment_failure", "environment"],
	["check_dependencies_unverified", "environment"],
	["run_store_write_failed", "environment"],
	["project_lock_failed", "environment"],
	["project_lock_owner_live", "environment"],
	["project_lock_owner_dead", "environment"],
	["project_lock_release_unconfirmed", "cleanup"],
	["acceptance_check_failed", "check"],
	["acceptance_check_timeout", "check"],
	["diff_rejected", "policy"],
	["scope_rejected", "policy"],
	["input_rejected", "input"],
	["declared_path_has_owner_edits", "input"],
	["worktree_allocation_failed", "environment"],
	["worktree_missing", "environment"],
	["worktree_ownership_failed", "cleanup"],
	["git_control_tampered", "environment"],
	["target_identity_unavailable", "environment"],
	["invocation_descriptor_unavailable", "environment"],
	["local_descriptor_model_unavailable", "environment"],
	["local_descriptor_args_unsafe", "environment"],
	// Task 2.3: new closed codes.
	["check_setup_failed", "environment"],
	["check_environment_failed", "environment"],
	// Task 2.7: a candidate-changed dependency manifest is a check fact.
	["check_manifest_changed_by_diff", "check"],
	["no_route_available", "environment"],
	["request_evidence_invalid", "environment"],
	// Task 3.2.
	["host_concurrency", "environment"],
	["simple_execution_failed", "unknown"],
	["provider_cleanup_failed", "cleanup"],
	["cleanup_failed", "cleanup"],
	["cancelled", "cancellation"],
	["unknown", "unknown"],
]);

// ── Matrix ──────────────────────────────────────────────────────────────────

const MATRIX_PHASES = [
	"route",
	"prepare",
	"baseline",
	"execute",
	"provider",
	"diff",
	"checks",
	"integrate",
];

const REGISTRY_PHASES = [
	"preflight",
	...MATRIX_PHASES,
	"check",
	"repair",
	"input_validation",
	"cleanup",
	"unknown",
];

const ROW_FIELDS = [
	"reason",
	"causeCode",
	"causeCategory",
	"errorKind",
	"severity",
	"diffCategory",
	"providerCaused",
	"detailFields",
];

test("golden parity: registry reproduces the frozen classifiers over every reason and phase", () => {
	for (const row of FAILURE_ROWS) {
		if (row.reason === "check_venv_outside_project") continue;
		for (const phase of MATRIX_PHASES) {
			const expectedKind = oracleErrorKind(row.reason, phase, null);
			const expectedCode = oracleCauseCode(
				row.reason,
				phase,
				null,
				expectedKind,
			);
			const expectedCategory =
				ORACLE_CODE_CATEGORY.get(expectedCode) ?? "unknown";
			const resolved = resolveFailure({ reason: row.reason, phase });
			ok(Object.isFrozen(resolved), `${row.reason}/${phase} frozen`);
			strictEqual(
				resolved.errorKind,
				expectedKind,
				`${row.reason}/${phase} errorKind`,
			);
			strictEqual(
				resolved.causeCode,
				expectedCode,
				`${row.reason}/${phase} causeCode`,
			);
			strictEqual(
				resolved.causeCategory,
				expectedCategory,
				`${row.reason}/${phase} causeCategory`,
			);
			strictEqual(
				resolved.diffCategory,
				oracleDiffCategory(row.reason),
				`${row.reason}/${phase} diffCategory`,
			);
			strictEqual(
				resolved.severity,
				oracleSeverity(
					row.reason,
					phase,
					expectedCode,
					expectedCategory,
					expectedKind,
				),
				`${row.reason}/${phase} severity`,
			);
		}
	}
});

test("golden parity: verified provider diagnostics keep their pre-change precedence", () => {
	const verified = (diagnosticCode, diagnosticOrigin = "adapter") => ({
		diagnosticCode,
		diagnosticOrigin,
		diagnosticEvidenceAvailable: true,
	});
	for (const diagnosticCode of [
		"auth_expired",
		"quota_exhausted",
		"model_unavailable",
		"cli_usage_error",
		"execution_timed_out",
		"provider_signalled",
	]) {
		for (const reason of [
			"provider_exit_nonzero",
			"provider_silence_timeout",
			"provider_cleanup_failed",
			"provider_signalled",
			"check_failed",
			"empty_diff",
			"unsafe_diff",
			"run_store_write_failed",
			"provider_cancelled",
			"provider_deadline_exceeded",
			"check_dependencies_unverified",
			"deadline_expired",
		]) {
			const providerResult = verified(diagnosticCode);
			const errorKind = oracleErrorKind(reason, "execute", null);
			strictEqual(
				resolveFailure({
					reason,
					phase: "execute",
					providerResult,
					errorKind,
				}).causeCode,
				oracleCauseCode(reason, "execute", providerResult, errorKind),
				`${reason}/${diagnosticCode}`,
			);
		}
	}
	for (const providerResult of [
		verified("auth_expired", "provider"),
		verified("auth_expired", "harness"),
		{ diagnosticCode: "auth_expired", diagnosticOrigin: "adapter" },
		{ diagnosticCode: "not_a_code", diagnosticOrigin: "adapter" },
		null,
	]) {
		const errorKind = oracleErrorKind("provider_exit_nonzero", "execute", null);
		strictEqual(
			resolveFailure({
				reason: "provider_exit_nonzero",
				phase: "execute",
				providerResult,
				errorKind,
			}).causeCode,
			oracleCauseCode(
				"provider_exit_nonzero",
				"execute",
				providerResult,
				errorKind,
			),
		);
	}
	strictEqual(
		resolveFailure({
			reason: "provider_exit_nonzero",
			phase: "checks",
			providerResult: verified("auth_expired"),
		}).causeCode,
		oracleCauseCode(
			"provider_exit_nonzero",
			"checks",
			verified("auth_expired"),
			oracleErrorKind("provider_exit_nonzero", "checks", null),
		),
	);
});

test("golden parity: errno classification beats reason and phase defaults", () => {
	for (const errno of [
		"EPERM",
		"EACCES",
		"EROFS",
		"ENOSPC",
		"ETIMEDOUT",
		"ENOENT",
		"NOT_AN_ERRNO",
	]) {
		for (const reason of [
			"simple_execution_failed",
			"run_store_write_failed",
			"launcher_environment_unavailable",
			"unsafe_diff",
			"empty_diff",
			"check_failed",
			"provider_exit_nonzero",
		]) {
			for (const phase of ["prepare", "baseline", "execute", "checks"]) {
				const expectedKind = oracleErrorKind(reason, phase, errno);
				const expectedCode = oracleCauseCode(reason, phase, null, expectedKind);
				const resolved = resolveFailure({ reason, phase, errno });
				strictEqual(
					resolved.errorKind,
					expectedKind,
					`${reason}/${phase}/${errno} errorKind`,
				);
				strictEqual(
					resolved.causeCode,
					expectedCode,
					`${reason}/${phase}/${errno} causeCode`,
				);
			}
		}
	}
});

test("golden parity: explicit engine error kinds keep their pre-change mappings", () => {
	for (const [reason, errorKind] of [
		["worktree_allocation_failed", "environment_failure"],
		["worktree_ownership_failed", "cleanup_failed"],
		["included_usage_unverified", "policy_violation"],
		["manifest_review_required", "validation_failed"],
		["provider_group_unconfirmed", "cleanup_failed"],
		["check_group_unconfirmed", "cleanup_failed"],
		["unsafe_diff", "policy_violation"],
		["provider_cancelled", "execution_failed"],
		["EACCES", "permission_denied"],
	]) {
		for (const phase of MATRIX_PHASES) {
			strictEqual(
				resolveFailure({ reason, phase, errorKind }).causeCode,
				oracleCauseCode(reason, phase, null, errorKind),
				`${reason}/${phase}/${errorKind}`,
			);
		}
	}
});

test("frozen rows agree with resolveFailure across every registry phase", () => {
	for (const row of FAILURE_ROWS) {
		ok(Object.isFrozen(row), `${row.reason} row frozen`);
		for (const field of ROW_FIELDS)
			ok(field in row, `${row.reason} has ${field}`);
		for (const phase of REGISTRY_PHASES) {
			const override = row.byPhase?.[phase] ?? {};
			const resolved = resolveFailure({ reason: row.reason, phase });
			strictEqual(
				resolved.causeCode,
				override.causeCode ?? row.causeCode,
				`${row.reason}/${phase} table causeCode`,
			);
			strictEqual(
				resolved.errorKind,
				override.errorKind ?? row.errorKind,
				`${row.reason}/${phase} table errorKind`,
			);
			strictEqual(
				resolved.causeCategory,
				causeCategoryFor(override.causeCode ?? row.causeCode),
				`${row.reason}/${phase} table causeCategory`,
			);
		}
	}
});

test("registry severity sets reproduce the frozen tables", () => {
	for (const code of ORACLE_BASELINE_CODES) ok(BASELINE_CODES.has(code), code);
	strictEqual(BASELINE_CODES.has("check_venv_outside_project"), true);
	for (const code of ORACLE_HARD_CODES) ok(HARD_CODES.has(code), code);
	for (const code of ORACLE_HARD_UNTYPED) ok(HARD_UNTYPED.has(code), code);
	for (const code of ORACLE_CHECK_CODES) ok(CHECK_CODES.has(code), code);
	strictEqual(causeCategoryFor("check_venv_outside_project"), "environment");
});

test("registry code categories reproduce the frozen table plus the venv code", () => {
	const expected = new Map([
		...ORACLE_CODE_CATEGORY,
		["check_venv_outside_project", "environment"],
	]);
	deepStrictEqual(CODE_CATEGORIES, expected);
	strictEqual(causeCategoryFor("not_a_registered_code"), "unknown");
});

test("check_venv_outside_project is classified exactly like check_dependencies_unverified", () => {
	const row = FAILURE_REGISTRY.get("check_venv_outside_project");
	const dependencyRow = FAILURE_REGISTRY.get("check_dependencies_unverified");
	ok(row, "venv row exists");
	ok(dependencyRow, "dependency row exists");
	strictEqual(row.causeCode, "check_venv_outside_project");
	strictEqual(row.causeCategory, "environment");
	strictEqual(row.severity, "baseline");
	strictEqual(row.errorKind, dependencyRow.errorKind);
	strictEqual(row.diffCategory, null);
	for (const phase of [
		"preflight",
		"route",
		"prepare",
		"baseline",
		"execute",
		"provider",
		"diff",
		"checks",
		"integrate",
		"cleanup",
		"unknown",
	]) {
		const resolved = resolveFailure({
			reason: "check_venv_outside_project",
			phase,
		});
		strictEqual(resolved.causeCode, "check_venv_outside_project");
		strictEqual(resolved.causeCategory, "environment");
		strictEqual(
			resolved.errorKind,
			oracleErrorKind("check_dependencies_unverified", phase, null),
		);
		strictEqual(resolved.severity, "baseline");
	}
});

// ── Task 2.7: dependency refusal causes and details ─────────────────────────

test("check_manifest_changed_by_diff is a hard check row, never environment", () => {
	const row = FAILURE_REGISTRY.get("check_manifest_changed_by_diff");
	ok(row, "manifest row exists");
	strictEqual(row.causeCode, "check_manifest_changed_by_diff");
	strictEqual(row.causeCategory, "check");
	strictEqual(row.errorKind, "check_failed");
	strictEqual(row.severity, "hard");
	strictEqual(row.providerCaused, false);
	ok(row.detailFields.includes("dependencyCheck"));
	ok(row.detailFields.includes("manifestName"));
	for (const phase of ["diff", "checks", "check", "cleanup", "unknown"]) {
		const resolved = resolveFailure({
			reason: "check_manifest_changed_by_diff",
			phase,
		});
		strictEqual(resolved.causeCode, "check_manifest_changed_by_diff", phase);
		strictEqual(resolved.causeCategory, "check", phase);
		strictEqual(resolved.severity, "hard", phase);
	}
});

test("check_dependencies_unverified is baseline before the provider and hard after", () => {
	const row = FAILURE_REGISTRY.get("check_dependencies_unverified");
	strictEqual(row.providerCaused, false);
	ok(row.detailFields.includes("dependencyCheck"));
	ok(row.detailFields.includes("manifestName"));
	for (const phase of ["preflight", "route", "prepare", "baseline"]) {
		const resolved = resolveFailure({
			reason: "check_dependencies_unverified",
			phase,
		});
		strictEqual(resolved.severity, "baseline", phase);
		strictEqual(resolved.causeCode, "check_dependencies_unverified", phase);
		strictEqual(resolved.causeCategory, "environment", phase);
	}
	for (const phase of ["execute", "provider", "diff", "checks"]) {
		const resolved = resolveFailure({
			reason: "check_dependencies_unverified",
			phase,
		});
		strictEqual(resolved.severity, "hard", phase);
		strictEqual(resolved.causeCode, "check_dependencies_unverified", phase);
	}
});
