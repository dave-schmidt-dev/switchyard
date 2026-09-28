const AUTH_FAILURE_SIGNATURES = [
	"oauth session expired", // observed: Claude Code, exit 1, on stdout
	"session expired",
	"failed to authenticate",
	"authentication failed",
	"not authenticated",
	"not logged in",
	"please log in",
	"please login",
	"login expired",
	"token expired",
	"credentials expired",
	"re-authenticate",
	// Measured 2026-09-12 in switchyard-golden-6: codex's terminal line when a
	// rotating OAuth refresh token has been spent by another consumer. None of
	// the phrases above appear anywhere in that output, so the operator's FAIL
	// line read `execution_failed` -- "something went wrong" -- for a failure
	// whose only fix is an interactive re-login.
	"refresh token was already used",
];
const QUOTA_FAILURE_SIGNATURES = Object.freeze({
	agy: /individual[\s.,:;_/-]+quota[\s.,:;_/-]+reached\b/i,
	cursor: {
		usage: /out[\s.,:;_/-]+of[\s.,:;_/-]+usage\b/i,
		limit: /your[\s.,:;_/-]+limit\b/i,
	},
});
const MODEL_UNAVAILABLE_SIGNATURES = Object.freeze({
	agy: /is[\s.,:;_/-]+not[\s.,:;_/-]+recognized[\s.,:;_/-]+as[\s.,:;_/-]+a[\s.,:;_/-]+known[\s.,:;_/-]+model[\s.,:;_/-]+or[\s.,:;_/-]+custom[\s.,:;_/-]+model\b/i,
});
export const PERSISTED_ERROR_KINDS = Object.freeze([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"execution_failed",
	"silence_timeout",
	"execution_timed_out",
	"provider_cleanup_failed",
	"diff_capture_failed",
	"declared_path_not_seeded",
	"integration_failed",
	"required_paths_missing",
	"undeclared_paths_touched",
	"empty_diff",
	"empty_required_diff",
	"no_op_diff",
	"manifest_review_required",
	"corrupt_patch",
	"conflict",
	"no_provider",
	"unsupported_provider",
	"launch_failed",
	"result_fetch_failed",
	"run_store_write_failed",
	"orchestrator_timeout",
	"executor_not_switchyard",
	"unknown_failure",
	"unclassified",
	"task_selection_failed",
	"environment_incomplete",
	"project_lock_failed",
	"permission_denied",
	"environment_failure",
	"validation_failed",
	"policy_violation",
	"check_failed",
	"cleanup_failed",
	"unclassified_failure",
	"ambiguous_combined_rename_spelling",
]);
const CLEANUP_STAGE_DIAGNOSTIC_CODES = Object.freeze({
	cleanup_started: "provider_cleanup_after_cleanup_started",
	pid_observed: "provider_cleanup_after_pid_observed",
	tree_terminated: "provider_cleanup_after_tree_terminated",
	pid_marker_removed: "provider_cleanup_after_pid_marker_removed",
	index_lock_removed: "provider_cleanup_after_index_lock_removed",
});
const WORKER_BOOT_STAGE_DIAGNOSTIC_CODES = new Set([
	"clone_hardening_failed",
	"workspace_prepare_failed",
]);
export class WorkerBootStageError extends Error {
	constructor(diagnosticCode, cause) {
		if (!WORKER_BOOT_STAGE_DIAGNOSTIC_CODES.has(diagnosticCode)) {
			throw new TypeError("unrecognized worker boot stage diagnostic code");
		}
		super(`Worker boot stage failed (${diagnosticCode})`, { cause });
		this.name = "WorkerBootStageError";
		Object.defineProperty(this, "diagnosticCode", {
			value: diagnosticCode,
			enumerable: false,
		});
	}
}
export function workerBootStageDiagnosticCode(error) {
	return error instanceof WorkerBootStageError ? error.diagnosticCode : null;
}
const PRLCTL_DIAGNOSTIC_CODES = Object.freeze(
	new Set([
		"prlctl_job_misfire",
		"prlctl_session_not_ready",
		"prlctl_call_timed_out",
		"prlctl_call_failed",
	]),
);
function childProcessText(value) {
	if (typeof value === "string") return value.trim();
	if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
	return "";
}
export class PrlctlCallError extends Error {
	// Bounded so a runaway guest dump cannot bloat a status line or a log entry.
	static #MAX_DETAIL_CHARS = 400;

	/**
	 * Prefer the child's own output over Node's generic "Command failed: prlctl …"
	 * wrapper, which names the command and says nothing about why it failed.
	 * stderr first, then stdout: a provider CLI prints its diagnostic to
	 * whichever it prefers, and the documented OAuth-expiry incident used stdout.
	 * @param {unknown} cause
	 * @returns {string}
	 */
	static #detailOf(cause) {
		const stderr = childProcessText(cause?.stderr);
		const stdout = childProcessText(cause?.stdout);
		const text = stderr || stdout || String(cause?.message ?? "").trim();
		if (!text) return "";
		return text.length <= PrlctlCallError.#MAX_DETAIL_CHARS
			? text
			: `${text.slice(0, PrlctlCallError.#MAX_DETAIL_CHARS)}… (truncated)`;
	}

	/**
	 * @param {object} input
	 * @param {string} input.diagnosticCode Member of `PRLCTL_DIAGNOSTIC_CODES`.
	 * @param {string|null} [input.subcommand] Backend-owned literal, never interpolated input.
	 * @param {number} [input.attempts] Invocations made, including the failure.
	 * @param {number|null} [input.exitCode]
	 * @param {string|null} [input.signal]
	 * @param {boolean} [input.killed] True when the harness killed the child (its own timeout).
	 * @param {unknown} [input.cause]
	 */
	constructor({
		diagnosticCode,
		subcommand = null,
		attempts = 1,
		exitCode = null,
		signal = null,
		killed = false,
		cause,
	}) {
		if (!PRLCTL_DIAGNOSTIC_CODES.has(diagnosticCode)) {
			throw new TypeError("unrecognized prlctl diagnostic code");
		}
		const where = subcommand ? `prlctl ${subcommand}` : "prlctl";
		// The underlying message is kept in this error's own message, not just
		// on `cause`. It is what makes a real guest failure ("chmod: …:
		// Read-only file system") readable at the throw site, and dropping it in
		// favour of a tidy code would trade one opaque error for another — the
		// exact failure mode this class exists to end. Only `diagnosticCode`,
		// `exitCode` and `signal` are ever projected into a persisted record, so
		// carrying the text here does not widen what crosses that boundary.
		const detail = PrlctlCallError.#detailOf(cause);
		super(
			`${where} failed after ${attempts} attempt(s) (${diagnosticCode})` +
				(detail ? `: ${detail}` : ""),
			{ cause },
		);
		this.name = "PrlctlCallError";
		// Non-enumerable so an accidental JSON.stringify of a caught error cannot
		// widen what crosses a persistence boundary; the reviewed accessors below
		// are the only intended readers.
		for (const [key, value] of [
			["diagnosticCode", diagnosticCode],
			["subcommand", subcommand],
			["attempts", attempts],
			["exitCode", exitCode],
			["signal", signal],
			["killed", killed === true],
		]) {
			Object.defineProperty(this, key, { value, enumerable: false });
		}
		// Forward `execFileSync`'s own failure shape. It is not decoration: the
		// rest of the system already reads it. Every adapter routes a provider
		// timeout on `error.code === "ETIMEDOUT"`, and describeExecError recovers
		// the provider's own words from `error.stdout`/`error.stderr` -- its
		// auth/quota/model classification is gated on that text being non-empty.
		// A wrapper that dropped these would disable that classification and
		// misroute a real timeout into a generic execution failure, reintroducing
		// the opaque "Command failed: ..." incident this module exists to end.
		// Non-enumerable for the same reason as the fields above; persistence
		// projects only the closed vocabulary, never this surface.
		for (const key of ["stdout", "stderr", "status", "code"]) {
			const value = cause?.[key];
			if (value === undefined) continue;
			Object.defineProperty(this, key, { value, enumerable: false });
		}
	}
}
export function prlctlFailureMetadata(error) {
	// Reads only the reviewed type and never arbitrary properties, so an error
	// crafted elsewhere cannot inject a code into a persisted record. The walk is
	// bounded so a self-referential or pathologically deep cause chain cannot spin
	// here while a run is already failing.
	for (let current = error, depth = 0; current && depth < 16; depth += 1) {
		if (current instanceof PrlctlCallError) {
			const safe = { diagnosticCode: current.diagnosticCode };
			if (
				Number.isSafeInteger(current.exitCode) &&
				current.exitCode >= 0 &&
				current.exitCode <= 255
			) {
				safe.exitCode = current.exitCode;
			}
			if (PERSISTED_SIGNALS.has(current.signal)) safe.signal = current.signal;
			return safe;
		}
		current = current.cause;
	}
	return null;
}
export function prlctlTrustedCauseCode(error) {
	if (!(error instanceof PrlctlCallError)) return null;
	return ["EACCES", "EPERM", "ENOENT", "ETIMEDOUT"].includes(error.cause?.code)
		? error.cause.code
		: null;
}
export function cleanupDiagnosticCodeFor(cleanupStage) {
	return CLEANUP_STAGE_DIAGNOSTIC_CODES[cleanupStage] ?? null;
}
export const CLEANUP_STAGES = Object.freeze(
	new Set(Object.keys(CLEANUP_STAGE_DIAGNOSTIC_CODES)),
);
export const PERSISTED_SIGNALS = new Set([
	"SIGABRT",
	"SIGHUP",
	"SIGINT",
	"SIGKILL",
	"SIGQUIT",
	"SIGTERM",
]);
export {
	AUTH_FAILURE_SIGNATURES,
	CLEANUP_STAGE_DIAGNOSTIC_CODES,
	childProcessText,
	MODEL_UNAVAILABLE_SIGNATURES,
	QUOTA_FAILURE_SIGNATURES,
};
