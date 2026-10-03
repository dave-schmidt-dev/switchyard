import { PERSISTED_SIGNALS } from "../adapter/exec-error-kinds.mjs";

const PROVIDER_RELIABILITY_VERSION = 1;

const PHASES = new Set([
	"preflight",
	"route",
	"prepare",
	"baseline",
	"provider",
	"diff",
	"check",
	"repair",
	"integrate",
	"cleanup",
	"unknown",
]);
const BASELINE_STATES = new Set([
	"not_requested",
	"pending",
	"passed",
	"failed",
	"mutation_detected",
	"unknown",
	"cancelled",
]);
const DIFF_REJECTIONS = new Set([
	"empty",
	"undeclared",
	"read_only_input",
	"unsafe",
	"manifest_review",
	"concurrent_change",
	"integration",
]);
const REPAIR_STATES = new Set([
	"not_requested",
	"not_started",
	"attempted",
	"passed",
	"failed",
	"ineligible",
	"unknown",
]);
const CODE_CATEGORY = new Map([
	["auth_expired", "provider"],
	["quota_exhausted", "provider"],
	["model_unavailable", "provider"],
	["cli_usage_error", "provider"],
	["execution_timed_out", "provider"],
	["provider_deadline_exceeded", "provider"],
	["provider_signalled", "provider"],
	["provider_exit_nonzero", "unknown"],
	["provider_launch_failed", "unknown"],
	["launch_failed", "unknown"],
	["provider_verdict_rejected", "unknown"],
	["check_repair_succeeded", "check"],
	["check_repair_failed", "check"],
	["baseline_check_failed", "environment"],
	["baseline_mutation", "environment"],
	["environment_failure", "environment"],
	["check_dependencies_unverified", "environment"],
	["run_store_write_failed", "environment"],
	["project_lock_failed", "environment"],
	["acceptance_check_failed", "check"],
	["acceptance_check_timeout", "check"],
	["diff_rejected", "policy"],
	["scope_rejected", "policy"],
	["input_rejected", "input"],
	["provider_cleanup_failed", "cleanup"],
	["cleanup_failed", "cleanup"],
	["cancelled", "cancellation"],
	["unknown", "unknown"],
]);

function nullableSafeInteger(
	value,
	minimum = 0,
	maximum = Number.MAX_SAFE_INTEGER,
) {
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum
		? value
		: null;
}

export function createProviderReliabilityDiagnostic(input = {}) {
	const requestedCode =
		typeof input.causeCode === "string" && CODE_CATEGORY.has(input.causeCode)
			? input.causeCode
			: "unknown";
	const category = CODE_CATEGORY.get(requestedCode) ?? "unknown";
	const phase = PHASES.has(input.phase) ? input.phase : "unknown";
	const baselineStatus = BASELINE_STATES.has(input.baselineStatus)
		? input.baselineStatus
		: "not_requested";
	const diffRejectionCategory = DIFF_REJECTIONS.has(input.diffRejectionCategory)
		? input.diffRejectionCategory
		: null;
	const repairStatus = REPAIR_STATES.has(input.repairStatus)
		? input.repairStatus
		: "not_requested";
	const checkIdentity =
		typeof input.checkIdentity === "string" &&
		/^(?:sha256:)?[a-f0-9]{64}$/u.test(input.checkIdentity)
			? input.checkIdentity.replace(/^sha256:/u, "")
			: null;
	return {
		version: PROVIDER_RELIABILITY_VERSION,
		causeCategory: category,
		causeCode: requestedCode,
		phase,
		exitCode: nullableSafeInteger(input.exitCode, 0, 255),
		signal: PERSISTED_SIGNALS.has(input.signal) ? input.signal : null,
		timedOut: typeof input.timedOut === "boolean" ? input.timedOut : null,
		cancelled: typeof input.cancelled === "boolean" ? input.cancelled : null,
		checkIndex: nullableSafeInteger(input.checkIndex, 1, 16),
		checkIdentity,
		baselineStatus,
		diffRejectionCategory,
		diffRejectionCount: nullableSafeInteger(input.diffRejectionCount, 0, 4096),
		repairCount: nullableSafeInteger(input.repairCount, 0, 1) ?? 0,
		repairStatus,
	};
}

export function isProviderReliabilityDiagnostic(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const expected = createProviderReliabilityDiagnostic(value);
	return (
		Object.keys(value).length === Object.keys(expected).length &&
		Object.keys(expected).every((key) => value[key] === expected[key]) &&
		value.version === PROVIDER_RELIABILITY_VERSION
	);
}
