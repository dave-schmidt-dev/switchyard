import { CLEANUP_STAGES } from "./exec-error.mjs";

const DEFAULT_MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TERM_GRACE_MS = 250;
const DEFAULT_DIAGNOSTIC_CHARS = 800;
export const DEFAULT_SILENCE_TIMEOUT_MS = 5 * 60 * 1000;
const PROGRESS_SCHEMA_VERSION = 1;
const PROGRESS_STAGE_VALUES = new Set([
	"queued",
	"starting",
	"configuring",
	"working",
	"running",
	"diff_stage",
	"diff_export",
	"cleanup",
	"completed",
	"failed",
	"cancelled",
	"unknown",
]);
const PROGRESS_OUTCOME_VALUES = new Set([
	"running",
	"success",
	"failure",
	"cancelled",
	"silence_timeout",
	"execution_timed_out",
]);
export function createProgressSnapshot({
	stage = "unknown",
	elapsedMs = 0,
	lastSubstantiveProgressAt = null,
	lastSubstantiveProgressAgeMs = 0,
	stdoutBytes = 0,
	stderrBytes = 0,
	pollCount = 0,
	progressCount = 0,
	outcome = "running",
} = {}) {
	const safeStage = PROGRESS_STAGE_VALUES.has(stage) ? stage : "unknown";
	const safeOutcome = PROGRESS_OUTCOME_VALUES.has(outcome)
		? outcome
		: "running";
	const bounded = (value, max = Number.MAX_SAFE_INTEGER) =>
		Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
	const safeTimestamp =
		typeof lastSubstantiveProgressAt === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
			lastSubstantiveProgressAt,
		)
			? lastSubstantiveProgressAt
			: null;
	return Object.freeze({
		schemaVersion: PROGRESS_SCHEMA_VERSION,
		stage: safeStage,
		elapsedMs: bounded(elapsedMs),
		lastSubstantiveProgressAt: safeTimestamp,
		lastSubstantiveProgressAgeMs: bounded(lastSubstantiveProgressAgeMs),
		counters: Object.freeze({
			stdoutBytes: bounded(stdoutBytes, DEFAULT_MAX_BUFFER),
			stderrBytes: bounded(stderrBytes, DEFAULT_MAX_BUFFER),
			polls: bounded(pollCount, 1_000_000),
			progressEvents: bounded(progressCount, 1_000_000),
		}),
		outcome: safeOutcome,
	});
}
const LIFECYCLE_TERMINAL_STATUSES = new Set([
	"running",
	"exited",
	"terminated",
	"spawn_failed",
	"unobserved",
]);
const LIFECYCLE_TERMINATION_REASONS = new Set([
	"none",
	"completed",
	"deadline",
	"cancelled",
	"admission",
	"unobserved",
]);
const LIFECYCLE_CLEANUP_STATUSES = new Set([
	"not_required",
	"succeeded",
	"failed",
	"uncertain",
]);
function lifecycleTimestamp(value) {
	if (Number.isFinite(value)) return new Date(value).toISOString();
	if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
		return new Date(Date.parse(value)).toISOString();
	}
	return null;
}
function lifecyclePid(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function createProviderLifecycleSnapshot({
	pid = null,
	startedAt = null,
	deadlineAt = null,
	lastOutputAt = null,
	silenceObserved = false,
	silenceTimeoutMs = null,
	terminalStatus = "unobserved",
	terminationReason = "none",
	exitCode = null,
	signal = null,
	writerLifecycle = "unavailable",
	cleanupStatus = "not_required",
	cleanupStage = null,
} = {}) {
	const safeSignal =
		typeof signal === "string" && /^[A-Z0-9_:-]{1,32}$/u.test(signal)
			? signal
			: null;
	const safeCode = Number.isSafeInteger(exitCode) ? exitCode : null;
	const safeWriter = new Set(["stopped", "never_started", "unavailable"]).has(
		writerLifecycle,
	)
		? writerLifecycle
		: "unavailable";
	const safeCleanupStage = CLEANUP_STAGES.has(cleanupStage)
		? cleanupStage
		: null;
	const safeSilenceTimeout =
		Number.isFinite(silenceTimeoutMs) && silenceTimeoutMs > 0
			? Math.min(Math.max(0, silenceTimeoutMs), Number.MAX_SAFE_INTEGER)
			: null;
	return Object.freeze({
		schemaVersion: 1,
		pid: lifecyclePid(pid),
		startedAt: lifecycleTimestamp(startedAt),
		deadlineAt: lifecycleTimestamp(deadlineAt),
		lastOutputAt: lifecycleTimestamp(lastOutputAt),
		silenceObserved: silenceObserved === true,
		silenceTimeoutMs: safeSilenceTimeout,
		terminalStatus: LIFECYCLE_TERMINAL_STATUSES.has(terminalStatus)
			? terminalStatus
			: "unobserved",
		terminationReason: LIFECYCLE_TERMINATION_REASONS.has(terminationReason)
			? terminationReason
			: "none",
		exitCode: safeCode,
		signal: safeSignal,
		writerLifecycle: safeWriter,
		cleanupStatus: LIFECYCLE_CLEANUP_STATUSES.has(cleanupStatus)
			? cleanupStatus
			: "uncertain",
		cleanupStage: safeCleanupStage,
	});
}
export function boundProviderLifecycleSnapshot(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return createProviderLifecycleSnapshot(value);
}
export {
	createProviderLifecycleSnapshot,
	DEFAULT_DIAGNOSTIC_CHARS,
	DEFAULT_MAX_BUFFER,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_TERM_GRACE_MS,
};
