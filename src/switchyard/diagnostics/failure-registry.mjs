/**
 * Frozen failure registry.
 *
 * The registry is the single source of truth for how a simple-run failure
 * reason maps onto the persisted provider-reliability cause code, the
 * in-process error kind, the attempt severity bucket and the diff rejection
 * category. The rows are a frozen snapshot of the pre-registry classifiers
 * plus the closed-code rules: a cancelled provider result resolves to
 * `cancelled` for any reason, a timed-out provider result resolves to
 * `provider_deadline_exceeded` (a timed-out check to
 * `acceptance_check_timeout`), and every reason that previously fell through
 * to `unknown` keeps its own closed code. `resolveFailure` is the pure
 * resolver used by reliability.mjs, failure-severity.mjs and
 * provider-reliability.mjs. Every row also declares its detail fields, typed
 * by `DETAIL_FIELD_TYPES`, which the engine persists with the failure. No
 * I/O, no mutation.
 */

import {
	DIFF_CAUSE_REASONS,
	PROVIDER_CAUSED_REASONS,
	SNAPSHOT_BASELINE_CODES,
	SNAPSHOT_CHECK_CODES,
	SNAPSHOT_HARD_CODES,
	SNAPSHOT_HARD_UNTYPED,
	snapshotCauseCode,
	snapshotDiffCategory,
	snapshotErrorKind,
	snapshotSeverity,
} from "./failure-classifiers.mjs";

/** Closed cancel-source enum, threaded from the AbortSignal reason. */
export const CANCEL_SOURCES = Object.freeze([
	"signal_sigterm",
	"signal_sigint",
	"internal_deadline",
	"unspecified",
]);

/**
 * Closed enum of check-session prepare steps. Each step a check session runs
 * before any check executes is tagged with one of these names, so a setup
 * refusal can say which step failed.
 */
export const CHECK_SETUP_STEPS = Object.freeze([
	"remove_session",
	"verify_deadline",
	"allocate_root",
	"clone_checkout",
	"checkout_base",
	"materialize_overlay",
	"stage_tree",
	"verify_base_tree",
	"commit_base",
	"configure_exclude",
	"link_python_venv",
	"resolve_path_dependencies",
	"snapshot_git_control",
	"probe_environment",
	"inspect_manifests",
	"verify_candidate_manifests",
	"provision_dependencies",
	"validate_commands",
]);

const BASE_DETAIL_FIELDS = Object.freeze(["failureReason"]);
const CHECK_DETAIL_FIELDS = Object.freeze([
	"failureReason",
	"checkIndex",
	"checkIdentity",
	"outputPath",
]);
const CHECK_ENVIRONMENT_DETAIL_FIELDS = Object.freeze([
	"failureReason",
	"checkIndex",
	"checkIdentity",
	"checkEnvironmentSignature",
	"outputPath",
]);
// Task 2.8: when the pre-provider dry run can name where the check command's
// first word resolves in the sandbox and on the host, both paths join the row.
const CHECK_ENVIRONMENT_EXECUTABLE_DETAIL_FIELDS = Object.freeze([
	...CHECK_ENVIRONMENT_DETAIL_FIELDS,
	"checkExecutable",
	"hostExecutable",
]);
// Task 2.8: a setup failure names the closed prepare step and, when the step
// threw a system error, its bounded code, syscall and executable basename.
const CHECK_SETUP_DETAIL_FIELDS = Object.freeze([
	"failureReason",
	"checkIndex",
	"checkSetupStep",
	"checkSetupErrorCode",
	"checkSetupSyscall",
	"checkSetupExecutable",
]);
// A deadline stop after the provider ran persists whether the changed-file
// capture that would have named the retained work was available.
const DEADLINE_DETAIL_FIELDS = Object.freeze([
	...CHECK_DETAIL_FIELDS,
	"changedFilesUnavailable",
]);
// Task 2.7: every dependency refusal carries its closed sub-cause; a manifest
// refusal also names the bounded file, a command refusal its position.
const CHECK_DEPENDENCY_DETAIL_FIELDS = Object.freeze([
	"failureReason",
	"checkIndex",
	"checkIdentity",
	"dependencyCheck",
	"manifestName",
]);
const PROVIDER_DETAIL_FIELDS = Object.freeze([
	"failureReason",
	"exitCode",
	"signal",
	"timedOut",
	"cancelled",
	"providerSignature",
	"stderrBytes",
	"stdoutBytes",
	"changedFilesUnavailable",
	"outputPath",
]);
const DIFF_DETAIL_FIELDS = Object.freeze([
	"failureReason",
	"diffRejectionCategory",
	"diffRejectionCount",
	"diffRejectionRule",
	"diffRejectionPaths",
]);

/**
 * Typed map of every registered detail field. The run.json failure sanitizer
 * and the failure-log record derive their allowlists from this map, so a
 * detail registered here is persisted without editing those boundaries.
 */
export const DETAIL_FIELD_TYPES = Object.freeze({
	failureReason: "string",
	exitCode: "integer",
	signal: "string",
	timedOut: "boolean",
	cancelled: "boolean",
	// Task 3.12: the closed cancellation origin, registered only for a
	// cancelled outcome and validated against CANCEL_SOURCES at the boundary.
	cancelSource: "string",
	checkIndex: "integer",
	checkIdentity: "string",
	checkEnvironmentSignature: "string",
	outputPath: "string",
	dependencyCheck: "string",
	manifestName: "string",
	// Task 2.8: check-setup and dry-run executable provenance.
	checkSetupStep: "string",
	checkSetupErrorCode: "string",
	checkSetupSyscall: "string",
	checkSetupExecutable: "string",
	checkExecutable: "string",
	hostExecutable: "string",
	diffRejectionCategory: "string",
	diffRejectionCount: "integer",
	diffRejectionRule: "string",
	diffRejectionPaths: "stringArray",
	providerSignature: "string",
	stderrBytes: "integer",
	stdoutBytes: "integer",
	// Precise providerReliability cause code when run.json stores a frozen
	// stand-in in `lastFailure` (see projectRunFailureForDisk).
	causeCode: "string",
	changedFilesUnavailable: "boolean",
});

const REGISTRY_PHASES = Object.freeze([
	"preflight",
	"route",
	"prepare",
	"baseline",
	"execute",
	"provider",
	"diff",
	"checks",
	"check",
	"repair",
	"integrate",
	"input_validation",
	"cleanup",
	"unknown",
]);

/** Frozen code -> category table, reproducing provider-reliability.mjs. */
export const CODE_CATEGORIES = new Map([
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
	// Persisted category stays "unknown" so committed readers keep accepting the
	// diagnostic; the row's providerCaused flag carries the provider attribution.
	["provider_exit_nonzero", "unknown"],
	["launch_failed", "unknown"],
	["check_repair_succeeded", "check"],
	["check_repair_failed", "check"],
	["check_group_unconfirmed", "cleanup"],
	["check_session_cleanup_failed", "cleanup"],
	["check_environment_unavailable", "environment"],
	// Task 3.2: a genuine conflict with the host's committed HEAD.
	["host_concurrency", "environment"],
	["check_candidate_rejected", "check"],
	// Task 2.7: a candidate-changed dependency manifest is a check fact.
	["check_manifest_changed_by_diff", "check"],
	["check_session_base_mismatch", "environment"],
	["check_session_unavailable", "environment"],
	["baseline_check_failed", "environment"],
	["baseline_check_unavailable", "environment"],
	["baseline_mutation", "environment"],
	["environment_failure", "environment"],
	["check_dependencies_unverified", "environment"],
	["check_setup_failed", "environment"],
	["check_environment_failed", "environment"],
	["check_venv_outside_project", "environment"],
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
	["no_route_available", "environment"],
	["request_evidence_invalid", "environment"],
	["simple_execution_failed", "unknown"],
	["provider_cleanup_failed", "cleanup"],
	["cleanup_failed", "cleanup"],
	["cancelled", "cancellation"],
	["unknown", "unknown"],
]);

export function causeCategoryFor(causeCode) {
	return CODE_CATEGORIES.get(causeCode) ?? "unknown";
}

export const BASELINE_CODES = Object.freeze(
	new Set([...SNAPSHOT_BASELINE_CODES, "check_venv_outside_project"]),
);
export const HARD_CODES = Object.freeze(new Set(SNAPSHOT_HARD_CODES));
export const HARD_UNTYPED = Object.freeze(new Set(SNAPSHOT_HARD_UNTYPED));
export const CHECK_CODES = Object.freeze(new Set(SNAPSHOT_CHECK_CODES));

const UNCLASSIFIED_ROW = Object.freeze({
	reason: null,
	causeCode: "unknown",
	causeCategory: "unknown",
	errorKind: "unclassified_failure",
	severity: "soft",
	diffCategory: null,
	providerCaused: false,
	detailFields: BASE_DETAIL_FIELDS,
});

function providerCausedFor(reason) {
	return PROVIDER_CAUSED_REASONS.has(reason);
}

function detailFieldsFor(reason, causeCode) {
	if (reason === "baseline_check_failed") return CHECK_DETAIL_FIELDS;
	if (
		reason === "check_environment_failed" ||
		causeCode === "check_environment_failed"
	)
		return CHECK_ENVIRONMENT_DETAIL_FIELDS;
	if (reason === "deadline_expired") return DEADLINE_DETAIL_FIELDS;
	if (
		reason === "check_manifest_changed_by_diff" ||
		causeCode === "check_manifest_changed_by_diff" ||
		reason === "check_dependencies_unverified" ||
		causeCode === "check_dependencies_unverified"
	)
		return CHECK_DEPENDENCY_DETAIL_FIELDS;
	if (reason === "check_setup_failed" || causeCode === "check_setup_failed")
		return CHECK_SETUP_DETAIL_FIELDS;
	if (PROVIDER_CAUSED_REASONS.has(reason) || causeCode.startsWith("provider"))
		return PROVIDER_DETAIL_FIELDS;
	if (
		reason?.startsWith("check_") ||
		[
			"acceptance_check_failed",
			"acceptance_check_timeout",
			"check_repair_failed",
			"check_repair_succeeded",
		].includes(causeCode)
	)
		return CHECK_DETAIL_FIELDS;
	if (
		DIFF_CAUSE_REASONS.includes(reason) ||
		["diff_rejected", "scope_rejected"].includes(causeCode)
	)
		return DIFF_DETAIL_FIELDS;
	return BASE_DETAIL_FIELDS;
}

function buildRow(reason) {
	const defaultKind = snapshotErrorKind(reason, null, null);
	const defaultCode = snapshotCauseCode(reason, null, null, defaultKind);
	const defaultCategory = causeCategoryFor(defaultCode);
	const byPhase = {};
	for (const phase of REGISTRY_PHASES) {
		const errorKind = snapshotErrorKind(reason, phase, null);
		const causeCode = snapshotCauseCode(reason, phase, null, errorKind);
		if (errorKind === defaultKind && causeCode === defaultCode) continue;
		byPhase[phase] = Object.freeze({
			...(errorKind === defaultKind ? {} : { errorKind }),
			...(causeCode === defaultCode ? {} : { causeCode }),
		});
	}
	return Object.freeze({
		reason,
		...(Object.keys(byPhase).length ? { byPhase: Object.freeze(byPhase) } : {}),
		causeCode: defaultCode,
		causeCategory: defaultCategory,
		errorKind: defaultKind,
		severity: snapshotSeverity(
			reason,
			null,
			defaultCode,
			defaultCategory,
			defaultKind,
		),
		diffCategory: snapshotDiffCategory(reason),
		providerCaused: providerCausedFor(reason),
		detailFields: detailFieldsFor(reason, defaultCode),
	});
}

const CHECK_VENV_ROW = Object.freeze({
	reason: "check_venv_outside_project",
	causeCode: "check_venv_outside_project",
	causeCategory: "environment",
	errorKind: "environment_failure",
	severity: "baseline",
	diffCategory: null,
	providerCaused: false,
	detailFields: CHECK_DETAIL_FIELDS,
});

/** Every reason the simple engine can hand to the failure classifiers. */
const FAILURE_REASONS = Object.freeze([
	"baseline_check_failed",
	"baseline_check_unavailable",
	"baseline_failed",
	"baseline_mutation",
	"cancelled",
	"check_candidate_rejected",
	"check_dependencies_unverified",
	"check_environment_unavailable",
	"check_environment_failed",
	"check_failed",
	"check_group_unconfirmed",
	"check_known_broken",
	"check_manifest_changed_by_diff",
	"check_out_of_clone_exec",
	"check_repair_failed",
	"check_repair_succeeded",
	"check_session_base_mismatch",
	"check_session_base_unavailable",
	"check_session_cleanup_failed",
	"check_session_unavailable",
	"check_setup_failed",
	"check_silence_timeout",
	"check_tool_denied",
	"check_deadline_exceeded",
	"check_venv_outside_project",
	"cleanup_state_ambiguous",
	"cli_usage_error",
	"deadline_expired",
	"declared_path_changed_concurrently",
	"declared_path_has_owner_edits",
	"diff_capture_failed",
	"diff_names_failed",
	"diff_stage_failed",
	"dirty_overlay_baseline_failed",
	"dirty_overlay_baseline_revision_unavailable",
	"dirty_overlay_deleted",
	"dirty_overlay_drift",
	"dirty_overlay_ignored",
	"dirty_overlay_not_regular",
	"dirty_overlay_oversized",
	"dirty_overlay_preflight_failed",
	"dirty_overlay_secret_path",
	"dirty_overlay_stage_failed",
	"dirty_overlay_symlink",
	"dirty_overlay_untracked",
	"discard_required",
	"empty_diff",
	"engine_threw",
	"ambiguous_combined_rename_spelling",
	"execution_timed_out",
	"git_control_tampered",
	"host_concurrency",
	"included_usage_unverified",
	"integration_failed",
	"invalid_invocation",
	"invalid_routing_project",
	"invalid_routing_run_id",
	"invalid_task_id",
	"invocation_descriptor_unavailable",
	"launcher_environment_unavailable",
	// Task 3.1: recovering a dangling pending attempt, and the closed checks
	// that gate the recovery.
	"lifecycle_recovered",
	"lifecycle_unconfirmed",
	"local_adapter_unavailable",
	"local_descriptor_args_unsafe",
	"local_descriptor_model_unavailable",
	"manifest_review_required",
	"model_unavailable",
	"native_ack_conflict",
	"no_eligible",
	"no_eligible_provider",
	"paid_overage_not_allowed",
	"partial_work_retained",
	"partial_worktree_claim_mismatch",
	"partial_worktree_not_recorded",
	"partial_worktree_symlink",
	"partial_worktree_unavailable",
	"pending_attempt_exists",
	"pending_attempt_missing",
	"pinned_target_failed",
	"pinned_target_unavailable",
	"predecessor_receipt_invalid",
	"predecessor_receipt_mismatch",
	"predecessor_receipt_missing",
	"predecessor_receipt_unverified",
	"preflight_failed",
	"project_head_changed_concurrently",
	"project_lock_failed",
	"project_lock_held",
	"project_lock_owner_dead",
	"project_lock_owner_live",
	"project_lock_release_unconfirmed",
	"project_revision_unavailable",
	"provider_adapter_error",
	"provider_cancelled",
	"provider_cleanup_failed",
	"provider_deadline_exceeded",
	"provider_exit_nonzero",
	"provider_group_unconfirmed",
	"provider_launch_failed",
	"provider_result_inconsistent",
	"provider_signalled",
	"provider_silence_timeout",
	"provider_verdict_rejected",
	"quota_exhausted",
	"read_only_input_changed",
	"receipt_identity_mismatch",
	"recovery_evidence_unavailable",
	"report_missing",
	"request_event_after_end",
	"request_event_close_failed",
	"request_event_end_invalid",
	"request_event_end_missing",
	"request_event_invalid",
	"request_event_line_too_long",
	"request_event_truncated",
	"request_event_write_failed",
	"request_log_open_failed",
	"roster_unavailable",
	"route_health_blocked",
	"routing_attempt_history_cap_exceeded",
	"routing_engine_required",
	"routing_lock_claim_recovery_failed",
	"routing_lock_identity_changed",
	"routing_lock_malformed",
	"routing_pending_identity_mismatch",
	"routing_run_lock_contention",
	"routing_run_already_released",
	"routing_run_not_found",
	"routing_selection_invalid",
	"routing_state_malformed",
	"routing_state_missing",
	"routing_state_nonmonotonic",
	"routing_state_write_failed",
	"routing_task_binding_malformed",
	"routing_task_binding_missing",
	"routing_task_binding_source_mismatch",
	"routing_task_binding_source_unavailable",
	"routing_task_binding_write_failed",
	"routing_task_identity_lock_changed",
	"routing_task_identity_lock_contention",
	"routing_task_identity_source_unavailable",
	"routing_unsafe_directory",
	"routing_unsafe_file",
	"run_state_not_terminal",
	"run_store_write_failed",
	"simple_execution_failed",
	"soft_retry_budget_exhausted",
	"target_identity_unavailable",
	"task_identity_invalid",
	"task_identity_lock_contention",
	"task_identity_state_invalid",
	"task_identity_state_release_failed",
	"task_identity_state_unavailable",
	"task_identity_state_write_failed",
	"task_retry_linked_to_previous_run",
	"undeclared_paths_changed",
	"unsafe_diff",
	"unsafe_failure",
	"worker_not_stopped",
	"worktree_allocation_failed",
	"worktree_cleanup_failed",
	"worktree_missing",
	"worktree_ownership_failed",
	"workspace_checkout_failed",
	"workspace_clone_failed",
]);

export const FAILURE_ROWS = Object.freeze(
	FAILURE_REASONS.map((reason) =>
		reason === CHECK_VENV_ROW.reason ? CHECK_VENV_ROW : buildRow(reason),
	),
);

export const FAILURE_REGISTRY = new Map(
	FAILURE_ROWS.map((row) => [row.reason, row]),
);

// Task 2.7: phases that run before any provider starts. A dependency refusal
// here is a host baseline fault; once the provider has started it is a hard
// check fact instead.
const PRE_PROVIDER_PHASES = new Set([
	"preflight",
	"route",
	"prepare",
	"baseline",
]);

function resolveSeverity(reason, phase, causeCode, causeCategory, errorKind) {
	if (reason === "check_venv_outside_project") return "baseline";
	if (
		(reason === "check_dependencies_unverified" ||
			causeCode === "check_dependencies_unverified") &&
		!PRE_PROVIDER_PHASES.has(phase)
	)
		return "hard";
	return snapshotSeverity(reason, phase, causeCode, causeCategory, errorKind);
}

function cancelSourceFor(input, providerResult) {
	const raw = input.cancelSource ?? providerResult?.cancelSource;
	return typeof raw === "string" && CANCEL_SOURCES.includes(raw)
		? raw
		: "unspecified";
}

/**
 * Resolve one failure into its frozen registry classification.
 *
 * Pure: derives only from the arguments. `phase` accepts the engine's
 * failure phase; `errno` accepts an already-extracted errno code; `errorKind`
 * is an explicit caller override used by the engine's typed failure paths.
 * A provider result with `cancelled: true` resolves to the `cancelled`
 * cause code for any reason; one with `timedOut: true` resolves to
 * `provider_deadline_exceeded` (or `acceptance_check_timeout` for a check)
 * when no more specific rule matched. `cancelSource` is threaded from the
 * AbortSignal reason via the provider result and validated against the
 * closed enum. `checkExecutable`/`hostExecutable`, when supplied for a
 * `check_environment_failed` classification, extend that row's detail fields
 * with the dry run's two resolved paths.
 */
export function resolveFailure(input = {}) {
	const reason =
		typeof input.reason === "string" && input.reason.length > 0
			? input.reason
			: null;
	const phase =
		typeof input.phase === "string" && input.phase.length > 0
			? input.phase
			: null;
	const errno =
		typeof input.errno === "string" && /^[A-Z0-9]+$/u.test(input.errno)
			? input.errno
			: null;
	const providerResult = input.providerResult ?? null;
	const cancelled =
		input.cancelled === true || providerResult?.cancelled === true;
	const timedOut = input.timedOut === true || providerResult?.timedOut === true;
	const isCheckVenv = reason === "check_venv_outside_project";
	const classificationReason = isCheckVenv
		? "check_dependencies_unverified"
		: reason;
	const errorKind =
		typeof input.errorKind === "string"
			? input.errorKind
			: snapshotErrorKind(classificationReason, phase, errno);
	let causeCode = snapshotCauseCode(
		classificationReason,
		phase,
		providerResult,
		errorKind,
		cancelled,
		timedOut,
	);
	if (isCheckVenv && causeCode === "check_dependencies_unverified")
		causeCode = "check_venv_outside_project";
	const causeCategory = causeCategoryFor(causeCode);
	const row = FAILURE_REGISTRY.get(reason) ?? UNCLASSIFIED_ROW;
	// Task 2.8: a caller that already resolved the check command's sandbox and
	// host executables adds both registered paths to the row's persisted
	// details; every other resolve keeps the frozen row shape.
	const executableDetailsRequested =
		(causeCode === "check_environment_failed" ||
			reason === "check_environment_failed") &&
		(typeof input.checkExecutable === "string" ||
			typeof input.hostExecutable === "string");
	const rowDetailFields = executableDetailsRequested
		? CHECK_ENVIRONMENT_EXECUTABLE_DETAIL_FIELDS
		: row.detailFields;
	// A cancelled outcome adds its closed origin. Every other resolution keeps
	// the frozen row shape, so a non-cancelled failure never registers the field.
	const detailFields =
		causeCode === "cancelled" && !rowDetailFields.includes("cancelSource")
			? Object.freeze([...rowDetailFields, "cancelSource"])
			: rowDetailFields;
	return Object.freeze({
		reason,
		phase,
		errno,
		causeCode,
		causeCategory,
		errorKind,
		severity: resolveSeverity(
			reason,
			phase,
			causeCode,
			causeCategory,
			errorKind,
		),
		diffCategory: row.diffCategory,
		providerCaused: row.providerCaused,
		detailFields,
		timedOut,
		cancelled,
		cancelSource:
			causeCode === "cancelled" ? cancelSourceFor(input, providerResult) : null,
	});
}

/**
 * Informational events: registered next to the failure rows so their names
 * and payload fields are closed, but they never resolve as failures and have
 * no row in `FAILURE_REGISTRY`. `fields` is the complete payload allowlist
 * beyond the event name.
 *
 * - `project_lock_reclaimed`: acquire removed the project lock of a provably
 *   dead holder; carries only the reclaimed (old) run id.
 */
export const INFORMATIONAL_EVENTS = Object.freeze(
	new Map([
		[
			"project_lock_reclaimed",
			Object.freeze({
				kind: "informational",
				fields: Object.freeze(["reclaimedRunId"]),
			}),
		],
	]),
);

/**
 * Build one informational event payload restricted to its registered fields.
 *
 * @param {string} name registered informational event name
 * @param {object} values candidate field values; unregistered keys are dropped
 * @returns {Readonly<object>} `{ event, ...registeredFields }`
 * @throws {TypeError} when `name` is not a registered informational event
 */
export function informationalEvent(name, values = {}) {
	const row = INFORMATIONAL_EVENTS.get(name);
	if (!row) throw new TypeError(`unregistered informational event: ${name}`);
	const event = { event: name };
	for (const field of row.fields) {
		if (values[field] !== undefined) event[field] = values[field];
	}
	return Object.freeze(event);
}
