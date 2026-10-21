/** Pure failure decisions shared by classification, routing, attribution and health. */
import { hasAuthoritativeDiagnosticProvenance } from "../adapter/exec-error-metadata.mjs";
import {
	PROVIDER_COOLDOWN_CODES,
	TRANSIENT_CODES,
} from "../router/health-schema.mjs";
import {
	CHECK_REASONS,
	CLEANUP_REASONS,
	CLOSED_CAUSE_CODES,
	DEADLINE_CAUSE_PHASES,
	DIFF_CAPTURE_REASONS,
	DIFF_CAUSE_REASONS,
	ENVIRONMENT_ERRNOS,
	ENVIRONMENT_REASONS,
	LAUNCHER_ENVIRONMENT_REASONS,
	POLICY_REASONS,
	PROVIDER_EXECUTION_REASONS,
	SCOPE_REASONS,
	SNAPSHOT_BASELINE_CODES,
	SNAPSHOT_HARD_CODES,
	SNAPSHOT_HARD_UNTYPED,
	VALIDATION_REASONS,
	VERIFIED_PROVIDER_CODES,
} from "./failure-classifiers.mjs";
import {
	BASELINE_CODES,
	CANCEL_SOURCES,
	CHECK_CODES,
	CHECK_ENVIRONMENT_EXECUTABLE_DETAIL_FIELDS,
	causeCategoryFor,
	DEADLINE_FIT_ROW,
	FAILURE_REGISTRY,
	HARD_CODES,
	HARD_UNTYPED,
	UNCLASSIFIED_ROW,
} from "./failure-registry-data.mjs";
import {
	createProviderReliabilityDiagnostic,
	isProviderReliabilityDiagnostic,
} from "./provider-reliability.mjs";

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

/** Resolve one failure into its frozen registry classification. */
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
	if (reason === "task_estimate_exceeds_budget" && !cancelled && !timedOut)
		return Object.freeze({
			...DEADLINE_FIT_ROW,
			phase,
			errno,
			timedOut: false,
			cancelled: false,
			cancelSource: null,
		});
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

/** Classify a single attempt failure into a severity bucket. */
export function classifyAttemptFailure({ result, accountability }) {
	const pr = result?.providerReliability;
	const causeCode = pr?.causeCode ?? accountability?.causeCode;
	const causeCategory = pr?.causeCategory ?? accountability?.causeCategory;
	const phase = pr?.phase;
	const failurePhase = result?.failurePhase;
	const errorKind = result?.errorKind;
	const failureReason = result?.failureReason;

	// Rule 0 — Task 2.7: a dependency refusal after the provider is a hard
	// check fact, never a host baseline fault.
	if (
		failurePhase === "checks" &&
		[causeCode, failureReason].some(
			(code) =>
				code === "check_dependencies_unverified" ||
				code === "check_manifest_changed_by_diff",
		)
	) {
		return Object.freeze({
			severity: "hard",
			reason: "unsafe_failure",
			salvageable: false,
		});
	}

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

const RESPONSIBILITY = Object.freeze({
	environment: ["environment", "investigate_environment"],
	policy: ["contract", "review_contract"],
	input: ["caller", "correct_input"],
	check: ["check_system", "investigate_checks"],
	cancellation: ["caller", "acknowledge_cancellation"],
	cleanup: ["cleanup", "repair_cleanup"],
	unknown: ["unknown", "investigate_unknown"],
});

function closedLifecycleReceipt(lifecycle) {
	return (
		lifecycle?.schemaVersion === 1 &&
		lifecycle.writerLifecycle === "stopped" &&
		lifecycle.cleanupStage === null &&
		["not_required", "succeeded"].includes(lifecycle.cleanupStatus)
	);
}

/** A matching supervisor receipt proves the writer stopped and cleanup settled; adapter diagnostics are not required. */
export function lifecycleBackedProviderFailure(
	providerReliability,
	providerLifecycle,
	providerWriterLifecycle,
) {
	if (
		!isProviderReliabilityDiagnostic(providerReliability) ||
		providerReliability.phase !== "provider" ||
		providerReliability.cancelled === true ||
		providerWriterLifecycle !== "stopped" ||
		!closedLifecycleReceipt(providerLifecycle)
	)
		return false;
	switch (providerReliability.causeCode) {
		case "provider_exit_nonzero":
			return (
				providerLifecycle.terminalStatus === "exited" &&
				Number.isSafeInteger(providerLifecycle.exitCode) &&
				providerLifecycle.exitCode !== 0 &&
				providerReliability.exitCode === providerLifecycle.exitCode
			);
		case "provider_signalled":
			return (
				providerLifecycle.terminalStatus === "exited" &&
				typeof providerLifecycle.signal === "string" &&
				providerReliability.signal === providerLifecycle.signal
			);
		case "provider_deadline_exceeded":
			return (
				providerLifecycle.terminalStatus === "terminated" &&
				providerLifecycle.terminationReason === "deadline" &&
				providerReliability.timedOut === true
			);
		default:
			return false;
	}
}

/** Attribute closed diagnostics using adapter provenance, provider deadlines or a matching closed supervisor lifecycle. */
export function deriveFailureAccountability({
	providerReliability,
	provenance = {},
} = {}) {
	const valid = isProviderReliabilityDiagnostic(providerReliability);
	let category = valid ? providerReliability.causeCategory : "unknown";
	// A provider-caused row whose persisted category stays "unknown" for reader
	// compatibility is attributed to the provider only under the same trust rule.
	if (
		valid &&
		category === "unknown" &&
		FAILURE_REGISTRY.get(providerReliability.causeCode)?.providerCaused === true
	)
		category = "provider";
	if (category === "provider") {
		const diagnosticTrusted =
			provenance.diagnosticCode === providerReliability.causeCode &&
			hasAuthoritativeDiagnosticProvenance(provenance);
		const deadlineTrusted =
			providerReliability.causeCode === "provider_deadline_exceeded" &&
			providerReliability.phase === "provider" &&
			providerReliability.timedOut === true;
		const lifecycleTrusted = lifecycleBackedProviderFailure(
			providerReliability,
			provenance.providerLifecycle,
			provenance.providerWriterLifecycle,
		);
		if (!diagnosticTrusted && !deadlineTrusted && !lifecycleTrusted)
			category = "unknown";
	}
	const [owner, action] =
		category === "provider"
			? ["provider", "investigate_provider"]
			: RESPONSIBILITY[category];
	return {
		version: 1,
		owner,
		action,
		causeCategory: valid ? providerReliability.causeCategory : "unknown",
		causeCode: valid ? providerReliability.causeCode : "unknown",
		providerMemoryEligible: owner === "provider",
	};
}

/** Which recorded attempt failures may blame the target, not the environment. */

/** Attempt reasons that blame the environment, not the target, for this task. */
export const TASK_EXCLUSION_EXEMPT_REASONS = new Set([
	"baseline_failed",
	"environment_failure",
	"lifecycle_recovered",
]);

/** Caller signals and authoritative quota evidence do not prove a target defect. */
export const NON_BLAMING_CAUSES = Object.freeze([
	"caller_cancelled",
	"quota_exhausted",
]);

/** Authoritative quota evidence and caller signals do not blame the target; internal-deadline and unspecified cancellations retain blame. */
export function nonBlamingCause(result, provenance = null) {
	const reliability = result?.providerReliability;
	if (
		reliability?.causeCode === "quota_exhausted" &&
		confirmedProviderCooldownCode({
			...(provenance ?? {}),
			providerReliability: reliability,
		}) === "quota_exhausted"
	)
		return "quota_exhausted";
	if (reliability?.causeCode !== "cancelled") return null;
	const source = reliability.cancelSource ?? result.cancelSource;
	return source === "signal_sigterm" || source === "signal_sigint"
		? "caller_cancelled"
		: null;
}

/** Exclude targets only for this task; baseline, environment, recovery, caller-signal cancellation and trusted quota causes stay eligible. */
export function taskExcludedTargets(attempts, logicalTaskId) {
	const excluded = new Set();
	for (const attempt of attempts) {
		const failedForTask =
			attempt.taskId === logicalTaskId &&
			(attempt.terminal === "failed" || attempt.terminal === "skipped") &&
			!TASK_EXCLUSION_EXEMPT_REASONS.has(attempt.reason) &&
			!NON_BLAMING_CAUSES.includes(attempt.nonBlamingCause);
		if (failedForTask) excluded.add(attempt.targetId);
	}
	return excluded;
}

/** Provider deadline timeouts record skipped so exclusion stays task-local; lifecycle-backed route health owns cross-task cooldown. */
export function failureTerminal(result, providerMemoryEligible) {
	if (
		(result.providerReliability?.causeCode ?? result.failureReason) ===
		"provider_deadline_exceeded"
	)
		return "skipped";
	return providerMemoryEligible ? "failed" : "skipped";
}

export function confirmedProviderCooldownCode(input) {
	const diagnostic = input?.providerReliability;
	if (
		!isProviderReliabilityDiagnostic(diagnostic) ||
		diagnostic.causeCategory !== "provider" ||
		diagnostic.phase !== "provider" ||
		!PROVIDER_COOLDOWN_CODES.has(diagnostic.causeCode) ||
		input.diagnosticCode !== diagnostic.causeCode ||
		input.diagnosticOrigin !== "adapter" ||
		input.diagnosticEvidenceAvailable !== true ||
		input.failurePhase !== "provider_execution" ||
		!hasAuthoritativeDiagnosticProvenance(input)
	)
		return null;
	return diagnostic.causeCode;
}

export function providerLifecycleClosed(input) {
	const lifecycle = input?.providerLifecycle;
	const cleanupClosed =
		input.healthLane === "simple-direct" &&
		lifecycle?.cleanupStage === null &&
		["not_required", "succeeded"].includes(lifecycle?.cleanupStatus);
	if (
		lifecycle?.schemaVersion !== 1 ||
		lifecycle.terminalStatus !== "exited" ||
		lifecycle.writerLifecycle !== "stopped" ||
		!cleanupClosed
	)
		return false;
	if (
		Number.isSafeInteger(input.exitCode) &&
		lifecycle.exitCode !== input.exitCode
	)
		return false;
	if (input.signal !== undefined && input.signal !== lifecycle.signal)
		return false;
	return true;
}

// The persisted event carries the sanitized diagnostic and exit evidence; the
// closed lifecycle itself was verified by the producer and is attested by the
// binding's `lifecycleVerified`. Re-check that the two agree.
export function lifecycleBackedEventCode(event) {
	const diagnostic = event.providerReliability;
	if (
		!isProviderReliabilityDiagnostic(diagnostic) ||
		diagnostic.phase !== "provider" ||
		diagnostic.cancelled === true ||
		!TRANSIENT_CODES.has(diagnostic.causeCode) ||
		FAILURE_REGISTRY.get(diagnostic.causeCode)?.providerCaused !== true
	)
		return null;
	switch (diagnostic.causeCode) {
		case "provider_exit_nonzero":
			return diagnostic.exitCode !== 0 && event.exitCode === diagnostic.exitCode
				? diagnostic.causeCode
				: null;
		case "provider_signalled":
			return diagnostic.signal !== null && event.signal === diagnostic.signal
				? diagnostic.causeCode
				: null;
		case "provider_deadline_exceeded":
			return diagnostic.timedOut === true ? diagnostic.causeCode : null;
		default:
			return null;
	}
}

export function loggedFailureReason(result, accountability, classification) {
	const reliability = result?.providerReliability;
	const confirmedProviderDeadline =
		result?.status === "failed" &&
		result.failurePhase === "execute" &&
		classification.reason === "execution_failed" &&
		isProviderReliabilityDiagnostic(reliability) &&
		reliability.causeCode === "provider_deadline_exceeded" &&
		reliability.phase === "provider" &&
		reliability.timedOut === true &&
		accountability?.owner === "provider" &&
		accountability.causeCode === reliability.causeCode;
	return confirmedProviderDeadline
		? "provider_deadline_exceeded"
		: classification.reason;
}

export function providerInvocationReliability(value, processResult) {
	const cleanupFailed = value.cleanupFailed === true;
	let causeCode = "unknown";
	if (cleanupFailed) causeCode = "provider_cleanup_failed";
	else if (value.cancelled === true) causeCode = "cancelled";
	else if (value.timedOut === true) causeCode = "execution_timed_out";
	else if (value.diagnosticCode === "execution_cancelled")
		causeCode = "cancelled";
	else if (
		[
			"auth_expired",
			"quota_exhausted",
			"model_unavailable",
			"cli_usage_error",
			"provider_signalled",
			"execution_timed_out",
		].includes(value.diagnosticCode) &&
		["adapter", "launcher"].includes(value.diagnosticOrigin)
	)
		causeCode = value.diagnosticCode;
	else if (value.diagnosticCode === "provider_exit_nonzero")
		causeCode = "provider_exit_nonzero";
	else if (value.diagnosticCode === "launch_failed")
		causeCode = "provider_launch_failed";
	else if (processResult.signal) causeCode = "provider_signalled";
	else if (Number.isSafeInteger(processResult.code) && processResult.code !== 0)
		causeCode = "provider_exit_nonzero";
	return createProviderReliabilityDiagnostic({
		causeCode,
		phase: cleanupFailed ? "cleanup" : "provider",
		exitCode: Number.isSafeInteger(value.exitCode)
			? value.exitCode
			: processResult.code,
		signal: value.signal ?? processResult.signal,
		timedOut: value.timedOut === true,
		cancelled: value.cancelled === true,
	});
}

export const TARGET_FAILURE_KINDS = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"execution_failed",
	"execution_timed_out",
	"provider_cleanup_failed",
	"diff_capture_failed",
	"integration_failed",
	"required_paths_missing",
	"undeclared_paths_touched",
	"empty_required_diff",
	"no_op_diff",
	"manifest_review_required",
	"corrupt_patch",
	"conflict",
	"empty_diff",
	"path_escapes_project_root",
	"git_internals_touched",
	"credential_path_touched",
	"symlink_creation_refused",
	"executable_file_refused",
]);
export const ADVANCE_FALLBACK_FAILURE_CODES = new Set([
	"quota_exhausted",
	"provider_exit_nonzero",
	"provider_signalled",
	"empty_diff",
	"empty_required_diff",
]);

export function isTargetFailure(entry, source) {
	const isFailedEvidence =
		source === "event"
			? entry?.phase === "execution" && entry?.event === "task_failed"
			: entry?.success === false;
	return Boolean(
		entry &&
			isFailedEvidence &&
			(TARGET_FAILURE_KINDS.has(entry.errorKind) ||
				["provider_execution", "provider_cleanup"].includes(
					entry.failurePhase,
				)),
	);
}

/** Only matched authoritative adapter quota evidence writes shared suppression. */
export function shouldRecordRouteExhaustion(result, provenance = null) {
	return (
		result?.status !== "succeeded" &&
		nonBlamingCause(result, provenance) === "quota_exhausted"
	);
}

/** Whether persisted attempts contain failure evidence for this task's exhaustion. */
export function hasTaskFailureEvidence(attempts, logicalTaskId) {
	if (taskExcludedTargets(attempts, logicalTaskId).size > 0) return true;
	// Environment failure counts as task evidence without excluding its target.
	return attempts.some(
		(attempt) =>
			attempt.taskId === logicalTaskId &&
			["failed", "skipped"].includes(attempt.terminal) &&
			attempt.reason === "environment_failure" &&
			!NON_BLAMING_CAUSES.includes(attempt.nonBlamingCause),
	);
}

/** Pre-change error-kind classifier, copied verbatim from reliability.mjs. */
export function snapshotErrorKind(failureReason, failurePhase, errno) {
	if (errno === "EPERM" || errno === "EACCES") return "permission_denied";
	if (ENVIRONMENT_ERRNOS.includes(errno)) return "environment_failure";
	if (LAUNCHER_ENVIRONMENT_REASONS.includes(failureReason))
		return "environment_failure";
	if (failureReason === "run_store_write_failed")
		return "run_store_write_failed";
	if (failurePhase === "baseline") return "environment_failure";
	if (failureReason === "check_dependencies_unverified")
		return "environment_failure";
	// Task 2.3: a failure while preparing the check session is environmental.
	if (failureReason === "check_setup_failed") return "environment_failure";
	// Task 2.4: a check that cannot run in this environment.
	if (failureReason === "check_environment_failed")
		return "environment_failure";
	// Task 3.2: the host moved under the run; that is the environment's fault.
	if (failureReason === "host_concurrency") return "environment_failure";
	// Task 2.7: a dependency manifest changed by the candidate's own diff is a
	// check fact, not an environment fault.
	if (failureReason === "check_manifest_changed_by_diff") return "check_failed";
	if (POLICY_REASONS.includes(failureReason)) return "policy_violation";
	if (failureReason === "manifest_review_required")
		return failurePhase === "input_validation"
			? "validation_failed"
			: "policy_violation";
	if (failureReason === "empty_diff") return "empty_diff";
	if (
		VALIDATION_REASONS.includes(failureReason) ||
		(failureReason?.startsWith("dirty_overlay_") &&
			failureReason !== "dirty_overlay_drift")
	)
		return "validation_failed";
	if (SCOPE_REASONS.includes(failureReason)) return "policy_violation";
	if (failurePhase === "checks" || CHECK_REASONS.includes(failureReason))
		return "check_failed";
	if (CLEANUP_REASONS.includes(failureReason) || failurePhase === "cleanup")
		return "cleanup_failed";
	if (
		PROVIDER_EXECUTION_REASONS.includes(failureReason) ||
		failurePhase === "execute"
	)
		return "execution_failed";
	if (failureReason === "deadline_expired") {
		if (["preflight", "input_validation"].includes(failurePhase))
			return "validation_failed";
		if (failurePhase === "execute") return "execution_failed";
		if (["checks", "check"].includes(failurePhase)) return "check_failed";
		if (failurePhase === "cleanup") return "cleanup_failed";
		// The run's deadline ran out in a Switchyard step (route, prepare,
		// diff capture, repair or integration), not in the candidate's scope.
		return "environment_failure";
	}
	if (ENVIRONMENT_REASONS.includes(failureReason)) return "environment_failure";
	if (failurePhase === "input_validation") return "validation_failed";
	return "unclassified_failure";
}

/** Preserve legacy rule order: cancellation wins, timeouts follow specific causes, and closed-code fallbacks replace unknown results. */
export function snapshotCauseCode(
	reason,
	phase,
	providerResult,
	errorKind,
	cancelled = false,
	timedOut = false,
) {
	if (cancelled) return "cancelled";
	// Task 3.2: a genuine host-concurrency conflict is an environment stop,
	// never a scope/policy rejection by the provider.
	if (reason === "host_concurrency") return "host_concurrency";
	if (LAUNCHER_ENVIRONMENT_REASONS.includes(reason))
		return "environment_failure";
	if (reason === "run_store_write_failed") return "run_store_write_failed";
	if (reason === "check_dependencies_unverified") return reason;
	// Task 2.3: wins over the generic environment_failure rule below.
	if (reason === "check_setup_failed") return reason;
	if (reason === "check_environment_failed") return reason;
	// Task 2.7: a candidate-changed dependency manifest has its own check cause.
	if (reason === "check_manifest_changed_by_diff") return reason;
	if (phase === "baseline") {
		if (reason === "baseline_mutation") return "baseline_mutation";
		if (reason === "baseline_check_unavailable")
			return "baseline_check_unavailable";
		return "baseline_check_failed";
	}
	// Outside the baseline, every diff-capture git failure shares one closed
	// environment cause.
	if (DIFF_CAPTURE_REASONS.includes(reason)) return "diff_capture_failed";
	// A deadline outside the provider, check, caller-input and cleanup phases
	// has its own closed environment cause, never scope_rejected.
	if (reason === "deadline_expired" && !DEADLINE_CAUSE_PHASES.includes(phase))
		return "deadline_expired";
	if (["environment_failure", "permission_denied"].includes(errorKind))
		return "environment_failure";
	if (reason === "provider_cancelled") return "cancelled";
	if (reason === "provider_deadline_exceeded")
		return "provider_deadline_exceeded";
	if (timedOut) {
		if (
			phase === "checks" ||
			phase === "check" ||
			CHECK_REASONS.includes(reason)
		)
			return "acceptance_check_timeout";
		return "provider_deadline_exceeded";
	}
	if (
		phase === "execute" &&
		VERIFIED_PROVIDER_CODES.has(providerResult?.diagnosticCode) &&
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
	if (DIFF_CAUSE_REASONS.includes(reason)) return "scope_rejected";
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
	return CLOSED_CAUSE_CODES.get(reason) ?? "unknown";
}

/** Pre-change diff category classifier, copied verbatim from reliability.mjs. */
export function snapshotDiffCategory(reason) {
	if (reason === "empty_diff") return "empty";
	if (reason === "undeclared_paths_changed") return "undeclared";
	if (reason === "read_only_input_changed") return "read_only_input";
	if (reason === "manifest_review_required") return "manifest_review";
	if (reason === "unsafe_diff") return "unsafe";
	if (reason === "declared_path_changed_concurrently")
		return "concurrent_change";
	// Integrate-phase scope rejections keep a category instead of falling
	// through to null, so a drift or concurrent-head stop is tunable.
	if (reason === "dirty_overlay_drift") return "concurrent_change";
	if (reason === "project_head_changed_concurrently")
		return "concurrent_change";
	if (reason === "host_concurrency") return "concurrent_change";
	if (reason === "ambiguous_combined_rename_spelling") return "integration";
	if (reason === "integration_failed") return "integration";
	return null;
}

/** Pre-change attempt severity bucket (first-match-wins), from failure-severity. */
export function snapshotSeverity(
	reason,
	phase,
	causeCode,
	causeCategory,
	errorKind,
) {
	if (
		phase === "baseline" ||
		SNAPSHOT_BASELINE_CODES.has(causeCode) ||
		SNAPSHOT_BASELINE_CODES.has(reason)
	)
		return "baseline";
	if (
		["cleanup", "cancellation", "input"].includes(causeCategory) ||
		SNAPSHOT_HARD_CODES.has(causeCode) ||
		SNAPSHOT_HARD_UNTYPED.has(errorKind) ||
		SNAPSHOT_HARD_UNTYPED.has(reason) ||
		phase === "cleanup"
	)
		return "hard";
	return "soft";
}
