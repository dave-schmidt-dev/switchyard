// Shared classifier for a FAILED in-container provider invocation.
//
// Every adapter's execute() catch block returns the same result shape. Before
// this module they all set `error: error.message`, which for a non-zero exit is
// Node's generic "Command failed: docker exec … <argv>" — it names the command
// and says nothing about *why* it failed. The provider's real diagnostic goes
// to its own stdout/stderr, which execFileSync attaches to the thrown error as
// `error.stdout`/`error.stderr`; the adapters captured `stdout` into `output`
// but then discarded it from the surfaced reason. So a real incident (an
// expired Claude OAuth session: the CLI printed
// "Failed to authenticate: OAuth session expired and could not be refreshed"
// to stdout and exited 1) landed in the ledger as an opaque
// "Command failed: docker exec …" and cost a cross-session investigation to
// re-diagnose.
//
// This centralizes turning that thrown error into a *diagnosable* result:
//
//   1. Prefer the provider's own captured output (stdout ∪ stderr) over the
//      generic wrapper, so ANY failure — not just a recognized signature — is
//      diagnosable straight from the ledger reason instead of needing a live
//      repro.
//   2. Recognize an expired/failed auth session as a distinct `errorKind` and
//      prepend an actionable re-auth hint. The pre-flight credential check is
//      presence-only (README: "an expired-but-still-present token reads as
//      authenticated"), so this class of failure otherwise surfaces only at
//      dispatch time, as an opaque generic error.
//
// INV-1 note: the credential VALUE never appears in provider stdout/stderr —
// the CLIs print human status text ("session expired"), not tokens — so
// surfacing provider output here does not leak secrets to the host.

import { createHash } from "node:crypto";

// Broad, case-insensitive substrings that mark an expired/unusable session
// across provider CLIs. Kept deliberately loose: exact wording varies by CLI
// and version. A false positive only adds a (possibly unneeded) re-auth hint to
// an already-failing result — `errorKind` is informational and does not, on its
// own, change dispatch control flow — so over-matching is cheap and
// under-matching (missing a real expiry) is the costly direction.
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
];

// Provider-specific quota signatures are intentionally narrow. These are
// derived from sanitized provider-boundary evidence, not from generic words
// such as "quota", "exhausted", "429", or "rate limit" that also occur in
// transient and transport failures. Keep the provider gate here so a phrase
// from one CLI cannot quarantine an unrelated provider.
const QUOTA_FAILURE_SIGNATURES = Object.freeze({
	agy: /individual[\s.,:;_/-]+quota[\s.,:;_/-]+reached\b/i,
	cursor: {
		usage: /out[\s.,:;_/-]+of[\s.,:;_/-]+usage\b/i,
		limit: /your[\s.,:;_/-]+limit\b/i,
	},
});

// A model the provider CLI cannot resolve at all. Observed 2026-08-13: a
// working container rejected a model the standing container dispatches fine —
// every such dispatch failed as a generic execution_failed, and the ledger's
// static reason ("Provider execution failed before a reviewed integration")
// could not distinguish it from a model that ran and failed.
//
// What the CLI is doing when it says this is now measured. agy resolves its
// model catalog by fetching it live, and falls back to the list compiled into
// the binary when that fetch does not succeed — the fallback is real (the
// 1.1.12 binary in `switchyard-agent:latest` contains `gemini-3.6` literals and
// zero `gemini-3.7`) and, critically, SILENT: there is no error, only a shorter
// catalog, so the next dispatch fails as an unknown model rather than as a
// failed fetch. That substitution is the whole reason this kind has to exist.
//
// What it is NOT is a provisioning gap, which is what this comment claimed
// until 2026-08-14. That was disproved by running switchyard's own
// createWorkingContainer + provisionCredentials and probing the result: a
// token-only working container fetches the live catalog and dispatches
// `gemini-3.7-flash-medium` successfully, on the image's own agy 1.1.12 and on
// 1.1.13, and does so even when the copied OAuth envelope is already past its
// expiry (agy refreshes it in place from the refresh_token that travels in the
// same file). So the persisted reason below says "did not resolve" and stops
// there: this classifier sees only the CLI's refusal, and the reason behind a
// failed fetch — network, vendor-side, or an expired credential — is not
// visible from here and must not be guessed at in a persisted string.
//
// Provider-scoped and narrow, for the same reason the quota signatures are:
// this is verbatim provider-boundary evidence, not the generic words "model" or
// "not recognized" that appear in ordinary provider output.
const MODEL_UNAVAILABLE_SIGNATURES = Object.freeze({
	agy: /is[\s.,:;_/-]+not[\s.,:;_/-]+recognized[\s.,:;_/-]+as[\s.,:;_/-]+a[\s.,:;_/-]+known[\s.,:;_/-]+model[\s.,:;_/-]+or[\s.,:;_/-]+custom[\s.,:;_/-]+model\b/i,
});

// This is the only error vocabulary allowed to cross a persistence boundary.
// Keep provider text at the adapter edge; callers persist only one of these
// enum values plus the static metadata below. quota_exhausted is intentionally
// allowlisted here, but only the provider-scoped classifier below may request
// it from a transient adapter result.
export const PERSISTED_ERROR_KINDS = Object.freeze([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"execution_failed",
	"execution_timed_out",
	"provider_cleanup_failed",
	"diff_capture_failed",
	"declared_path_not_seeded",
	"integration_failed",
	"required_paths_missing",
	"undeclared_paths_touched",
	"empty_required_diff",
	"no_op_diff",
	"manifest_review_required",
	"corrupt_patch",
	"conflict",
	"no_provider",
	"unsupported_provider",
	"launch_failed",
	"result_fetch_failed",
	"orchestrator_timeout",
	"executor_not_switchyard",
	"unknown_failure",
	"unclassified",
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

/** A closed, content-free worker-boot stage failure. */
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

/** Return a stage code only from the reviewed error type, never arbitrary properties. */
export function workerBootStageDiagnosticCode(error) {
	return error instanceof WorkerBootStageError ? error.diagnosticCode : null;
}

/**
 * Closed vocabulary for a failed host-side `prlctl` invocation.
 *
 * `prlctl_job_misfire` is the measured one. Parallels 27.0.0 loses the result
 * of a host-side SDK job at a low but non-zero rate and reports it as
 * `PrlJob_GetRetCode`/`PrlJob_GetResult: Invalid argument` on exit 255. Measured
 * 2026-09-01 on an otherwise idle host, switchyard entirely out of the picture:
 * 5 of 150 serial `prlctl exec` calls misfired (~3.3%), rising to 14 of 100
 * under four concurrent callers, and all 5 serial misfires succeeded on
 * immediate retry. It is a transient per-call fault, not a wedged dispatcher.
 *
 * `prlctl_session_not_ready` is a DIFFERENT condition that must not be folded
 * into the one above: a guest that has not finished booting refuses the session
 * with its own message, and 48 of the first 100 calls after `prlctl start`
 * returned it. Retrying it on the misfire's timescale would hide a genuinely
 * unbootable guest behind a retry loop, so the readiness pollers own it.
 */
const PRLCTL_DIAGNOSTIC_CODES = Object.freeze(
	new Set([
		"prlctl_job_misfire",
		"prlctl_session_not_ready",
		"prlctl_call_timed_out",
		"prlctl_call_failed",
	]),
);

/**
 * A failed `prlctl` invocation, classified and carrying persistable metadata.
 *
 * Before this existed, every one of the backend's `_call` sites surfaced a bare
 * `Command failed: prlctl …` and the run record recorded no exit code, no
 * signal, and no indication of whether Node had killed the child on its own
 * `timeout`. That is the "no metadata recorded" failure mode. Every field here
 * is either a closed enum member or a bounded integer, so the whole object is
 * safe to project into a persisted failure record.
 */
export class PrlctlCallError extends Error {
	// Bounded so a runaway guest dump cannot bloat a status line or a log entry.
	static #MAX_DETAIL_CHARS = 400;

	/**
	 * Prefer the child's stderr over Node's generic "Command failed: prlctl …"
	 * wrapper, which names the command and says nothing about why it failed.
	 * @param {unknown} cause
	 * @returns {string}
	 */
	static #detailOf(cause) {
		const stderr = typeof cause?.stderr === "string" ? cause.stderr.trim() : "";
		const text = stderr || String(cause?.message ?? "").trim();
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
	}
}

/**
 * Return a prlctl diagnostic code from the reviewed error type, walking the
 * `cause` chain so a misfire wrapped by a boot-stage error is still reported.
 *
 * Like `workerBootStageDiagnosticCode`, this reads only the reviewed type and
 * never arbitrary properties, so an error crafted elsewhere cannot inject a
 * code into a persisted record.
 * @param {unknown} error
 * @returns {string|null}
 */
export function prlctlDiagnosticCodeFor(error) {
	// Bounded so a self-referential or pathologically deep cause chain cannot
	// spin here while a run is already failing.
	for (let current = error, depth = 0; current && depth < 16; depth += 1) {
		if (current instanceof PrlctlCallError) return current.diagnosticCode;
		current = current.cause;
	}
	return null;
}

/**
 * Project a reviewed prlctl failure into the persisted-metadata fields.
 * Returns null for anything that is not a `PrlctlCallError`.
 * @param {unknown} error
 * @returns {{diagnosticCode: string, exitCode?: number, signal?: string}|null}
 */
export function prlctlFailureMetadata(error) {
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

/** Return the durable diagnostic code for the last completed cleanup stage. */
export function cleanupDiagnosticCodeFor(cleanupStage) {
	return CLEANUP_STAGE_DIAGNOSTIC_CODES[cleanupStage] ?? null;
}

/**
 * Every cleanup stage a backend may report reaching before it failed.
 *
 * Derived from the diagnostic-code map above rather than restated, so the
 * vocabulary an event forwarder validates against cannot drift from the
 * vocabulary that has a durable diagnostic code. Closed by construction:
 * a stage name is backend-owned, never interpolated from provider output,
 * which is what makes it safe to persist under INV-2.
 */
export const CLEANUP_STAGES = Object.freeze(
	new Set(Object.keys(CLEANUP_STAGE_DIAGNOSTIC_CODES)),
);

/**
 * Every category the reviewed integration gate may refuse a diff under.
 *
 * A closed enum by construction: INV-2 forbids persisting raw provider output,
 * and these values reach `run.json`, `events.jsonl`, and the checkpoint. A
 * member is a fixed gate-owned category, never an interpolated message, so no
 * path, diff hunk, or provider text can ride out on this channel.
 */
export const INTEGRATION_REFUSAL_KINDS = Object.freeze([
	"empty_diff",
	"path_escapes_project_root",
	"git_internals_touched",
	"credential_path_touched",
	"symlink_creation_refused",
	"executable_file_refused",
	"manifest_review_required",
	"corrupt_patch",
	"conflict",
]);

export const PERSISTED_DIAGNOSTIC_CODES = Object.freeze([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"cli_usage_error",
	"provider_exit_nonzero",
	"provider_signalled",
	"provider_output_unclassified",
	"execution_timed_out",
	"execution_cancelled",
	"provider_cleanup_failed",
	...Object.values(CLEANUP_STAGE_DIAGNOSTIC_CODES),
	"diff_capture_failed",
	"declared_path_not_seeded",
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
	"worker_nonce_mismatch",
	"worker_fingerprint_mismatch",
	"worker_contract_unsupported",
	"worker_boot_exception",
	"clone_hardening_failed",
	"workspace_prepare_failed",
	"prlctl_job_misfire",
	"prlctl_session_not_ready",
	"prlctl_call_timed_out",
	"prlctl_call_failed",
	"recovery_incomplete",
	"checkpoint_task_file_mismatch",
	"checkpoint_tasks_file_mismatch",
	"checkpoint_missing_queue_identity",
	"checkpoint_queue_identity_missing",
	"checkpoint_queue_identity_mismatch",
	"checkpoint_run_options_mismatch",
	"checkpoint_historical_checkpoint",
	"checkpoint_historical_state",
]);

const PERSISTED_FAILURE_PHASES = new Set([
	"adapter_validation",
	"provider_execution",
	"provider_cleanup",
	"terminal_reconciliation",
	"worker_boot",
]);
/** Signal names that may be persisted; anything else is dropped. */
export const PERSISTED_SIGNALS = new Set([
	"SIGABRT",
	"SIGHUP",
	"SIGINT",
	"SIGKILL",
	"SIGQUIT",
	"SIGTERM",
]);
const CLI_USAGE_SIGNATURE =
	/\b(?:unexpected argument|unrecognized (?:option|argument)|unknown (?:option|argument)|invalid value|usage:)\b/i;

/** Convert transient provider output into a content-free diagnostic code. */
export function classifyProviderDiagnostic({
	errorKind,
	text,
	exitCode,
	signal,
	timedOut = false,
	cancelled = false,
} = {}) {
	if (cancelled) return "execution_cancelled";
	if (timedOut) return "execution_timed_out";
	if (
		["auth_expired", "quota_exhausted", "model_unavailable"].includes(errorKind)
	) {
		return errorKind;
	}
	if (typeof text === "string" && CLI_USAGE_SIGNATURE.test(text)) {
		return "cli_usage_error";
	}
	if (typeof signal === "string" && signal) return "provider_signalled";
	if (typeof text === "string" && text.trim()) {
		return "provider_output_unclassified";
	}
	return Number.isSafeInteger(exitCode) ? "provider_exit_nonzero" : null;
}

const PERSISTED_ERROR_METADATA = Object.freeze({
	auth_expired: Object.freeze({
		reasonCode: "auth_expired",
		reason:
			"Provider authentication expired; interactive re-authentication is required.",
	}),
	quota_exhausted: Object.freeze({
		reasonCode: "quota_exhausted",
		reason:
			"Provider quota is exhausted; the target is unavailable for this attempt.",
	}),
	model_unavailable: Object.freeze({
		reasonCode: "model_unavailable",
		reason:
			"The provider CLI did not resolve the dispatched model; its resolvable catalog is stale or incomplete for this attempt.",
	}),
	execution_failed: Object.freeze({
		reasonCode: "execution_failed",
		reason: "Provider execution failed before a reviewed integration.",
	}),
	execution_timed_out: Object.freeze({
		reasonCode: "execution_timed_out",
		reason: "Provider execution exceeded its bounded deadline.",
	}),
	provider_cleanup_failed: Object.freeze({
		reasonCode: "provider_cleanup_failed",
		reason: "Working container cleanup failed after execution timeout.",
	}),
	diff_capture_failed: Object.freeze({
		reasonCode: "diff_capture_failed",
		reason: "Partial diff capture failed after execution timeout.",
	}),
	declared_path_not_seeded: Object.freeze({
		reasonCode: "declared_path_not_seeded",
		reason:
			"The task declared a Git-ignored path that cannot be seeded or captured.",
	}),
	integration_failed: Object.freeze({
		reasonCode: "integration_failed",
		reason: "The reviewed integration gate rejected the task result.",
	}),
	required_paths_missing: Object.freeze({
		reasonCode: "required_paths_missing",
		reason: "Declared required paths were not touched by the task diff.",
	}),
	undeclared_paths_touched: Object.freeze({
		reasonCode: "undeclared_paths_touched",
		reason:
			"The task diff touched paths not declared in its Files specification.",
	}),
	empty_required_diff: Object.freeze({
		reasonCode: "empty_required_diff",
		reason: "The task required file modifications but produced an empty diff.",
	}),
	no_op_diff: Object.freeze({
		reasonCode: "no_op_diff",
		reason: "The task diff produced no net change in the repository tree.",
	}),
	manifest_review_required: Object.freeze({
		reasonCode: "manifest_review_required",
		reason:
			"The task diff touches execution manifests requiring explicit review.",
	}),
	corrupt_patch: Object.freeze({
		reasonCode: "corrupt_patch",
		reason: "The patch format is corrupt or unparseable by git apply.",
	}),
	conflict: Object.freeze({
		reasonCode: "conflict",
		reason:
			"The patch could not be applied due to conflicting workspace state.",
	}),
	empty_diff: Object.freeze({
		reasonCode: "empty_diff",
		reason: "The task produced no diff for the integration gate to review.",
	}),
	path_escapes_project_root: Object.freeze({
		reasonCode: "path_escapes_project_root",
		reason: "The task diff touches a path outside the project root.",
	}),
	git_internals_touched: Object.freeze({
		reasonCode: "git_internals_touched",
		reason: "The task diff touches Git internals under a .git directory.",
	}),
	credential_path_touched: Object.freeze({
		reasonCode: "credential_path_touched",
		reason: "The task diff touches a path matching a credential convention.",
	}),
	symlink_creation_refused: Object.freeze({
		reasonCode: "symlink_creation_refused",
		reason: "The task diff creates a symbolic link.",
	}),
	executable_file_refused: Object.freeze({
		reasonCode: "executable_file_refused",
		reason: "The task diff introduces a file with the executable bit set.",
	}),
	no_provider: Object.freeze({
		reasonCode: "no_provider",
		reason: "No eligible provider was available for this task.",
	}),
	unsupported_provider: Object.freeze({
		reasonCode: "unsupported_provider",
		reason: "The selected provider has no supported execution adapter.",
	}),
	launch_failed: Object.freeze({
		reasonCode: "launch_failed",
		reason: "The headless provider job could not be launched.",
	}),
	result_fetch_failed: Object.freeze({
		reasonCode: "result_fetch_failed",
		reason: "The headless provider result could not be fetched.",
	}),
	orchestrator_timeout: Object.freeze({
		reasonCode: "orchestrator_timeout",
		reason: "The headless provider job exceeded its bounded wait.",
	}),
	executor_not_switchyard: Object.freeze({
		reasonCode: "executor_not_switchyard",
		reason: "This task is assigned to a non-Switchyard executor.",
	}),
	unknown_failure: Object.freeze({
		reasonCode: "unknown_failure",
		reason: "The task failed for an unclassified reason.",
	}),
	unclassified: Object.freeze({
		reasonCode: "unclassified",
		reason: "The task failed for an unclassified reason.",
	}),
});

const SUCCESS_RESULTS = new Set(["success", "success_no_diff"]);

const RESULT_TO_ERROR_KIND = Object.freeze({
	execution_failed: "execution_failed",
	execution_timed_out: "execution_timed_out",
	execution_timed_out_cleanup_failed: "provider_cleanup_failed",
	execution_timed_out_capture_failed: "diff_capture_failed",
	provider_cleanup_failed: "provider_cleanup_failed",
	diff_capture_failed: "diff_capture_failed",
	declared_path_not_seeded: "declared_path_not_seeded",
	integration_failed: "integration_failed",
	required_paths_missing: "required_paths_missing",
	undeclared_paths_touched: "undeclared_paths_touched",
	empty_required_diff: "empty_required_diff",
	no_op_diff: "no_op_diff",
	manifest_review_required: "manifest_review_required",
	corrupt_patch: "corrupt_patch",
	conflict: "conflict",
	empty_diff: "empty_diff",
	path_escapes_project_root: "path_escapes_project_root",
	git_internals_touched: "git_internals_touched",
	credential_path_touched: "credential_path_touched",
	symlink_creation_refused: "symlink_creation_refused",
	executable_file_refused: "executable_file_refused",
	no_provider: "no_provider",
	unsupported_provider: "unsupported_provider",
	launch_failed: "launch_failed",
	result_fetch_failed: "result_fetch_failed",
	orchestrator_timed_out: "orchestrator_timeout",
	orchestrator_timeout: "orchestrator_timeout",
	executor_not_switchyard: "executor_not_switchyard",
	halted_after_commit_failure: "unknown_failure",
	halted_after_reset_failure: "unknown_failure",
	unclassified: "unclassified",
});

/**
 * Return the allowlisted persistent kind or null. This deliberately does not
 * accept arbitrary provider/orchestrator strings as durable classifications.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizePersistentErrorKind(value) {
	return typeof value === "string" && PERSISTED_ERROR_KINDS.includes(value)
		? value
		: null;
}

/**
 * Build static, content-free failure metadata for persistence.
 * @param {object} input
 * @param {string} [input.taskId]
 * @param {string} [input.result]
 * @param {string|null} [input.errorKind]
 * @param {boolean} [input.timedOut]
 * @param {string} [input.partialDiffPath] transient path, never returned
 * @returns {{errorKind: string, reasonCode: string, reason: string, artifactRef?: string}|null}
 */
export function sanitizeFailureMetadata({
	taskId,
	result,
	errorKind,
	timedOut = false,
	partialDiffPath,
	diagnosticCode,
	exitCode,
	signal,
	failurePhase,
	cleanupStage,
} = {}) {
	if (!result || SUCCESS_RESULTS.has(result)) return null;
	const requestedKind = normalizePersistentErrorKind(errorKind);
	const kind =
		requestedKind ??
		RESULT_TO_ERROR_KIND[result] ??
		(timedOut ? "execution_timed_out" : "unknown_failure");
	const metadata = PERSISTED_ERROR_METADATA[kind];
	const safe = {
		errorKind: kind,
		reasonCode: metadata.reasonCode,
		reason: metadata.reason,
	};
	const safeCleanupDiagnostic = cleanupDiagnosticCodeFor(cleanupStage);
	if (PERSISTED_DIAGNOSTIC_CODES.includes(diagnosticCode)) {
		safe.diagnosticCode = diagnosticCode;
	} else if (safeCleanupDiagnostic) {
		safe.diagnosticCode = safeCleanupDiagnostic;
	}
	if (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
		safe.exitCode = exitCode;
	}
	if (PERSISTED_SIGNALS.has(signal)) safe.signal = signal;
	if (PERSISTED_FAILURE_PHASES.has(failurePhase)) {
		safe.failurePhase = failurePhase;
	}
	if (partialDiffPath && typeof taskId === "string" && taskId) {
		const digest = createHash("sha256")
			.update(`${taskId}.diff`)
			.digest("hex")
			.slice(0, 24);
		safe.artifactRef = `artifact:${digest}`;
	}
	return safe;
}

/**
 * Validate metadata before it is accepted from an untrusted projection.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPersistentFailureMetadata(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const allowedKeys = new Set([
		"errorKind",
		"reasonCode",
		"reason",
		"artifactRef",
		"diagnosticCode",
		"exitCode",
		"signal",
		"failurePhase",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
	const expected = sanitizeFailureMetadata({
		result: "execution_failed",
		errorKind: value.errorKind,
	});
	if (!expected) return false;
	if (
		value.reasonCode !== expected.reasonCode ||
		value.reason !== expected.reason
	) {
		return false;
	}
	if (value.artifactRef !== undefined) {
		if (
			typeof value.artifactRef !== "string" ||
			!/^artifact:[a-f0-9]{24}$/.test(value.artifactRef)
		) {
			return false;
		}
	}
	const safeDiagnostics = sanitizeFailureMetadata({
		result: "execution_failed",
		diagnosticCode: value.diagnosticCode,
		exitCode: value.exitCode,
		signal: value.signal,
		failurePhase: value.failurePhase,
	});
	for (const field of [
		"diagnosticCode",
		"exitCode",
		"signal",
		"failurePhase",
	]) {
		if (value[field] !== safeDiagnostics?.[field]) return false;
	}
	return true;
}

// Cap the surfaced reason so a runaway provider dump can't bloat the ledger
// line (JSONL, one object per line) or a status surface.
const MAX_REASON_CHARS = 800;

// D-10: per-provider re-auth command, matching README's documented recovery step.
// An expired-but-present token IS fixed by `npm run auth` now — liveness
// gating (auth/liveness.mjs) means a dead-but-present session no longer skips
// the login the way a presence-only check used to. That command boots the
// golden image, runs each unauthenticated provider's real login directly
// against it (a real TTY is required, so this cannot run from this
// non-interactive dispatch path), and stops the golden image again — see
// auth/index.mjs. These mirror the login commands run there verbatim.
const REAUTH_LOGIN = {
	claude: "claude auth login",
	codex: "codex login --device-auth",
	agy: "agy --print hi",
	cursor: "NO_OPEN_BROWSER=1 cursor-agent login",
	copilot: "copilot login",
	opencode: "opencode auth login",
};

/**
 * Actionable re-auth hint for a provider whose session looks expired.
 * @param {string} provider
 * @returns {string|null} null for an unknown provider (no guessed command)
 */
export function reauthHintFor(provider) {
	const login = REAUTH_LOGIN[provider];
	if (!login) return null;
	return `${provider} session may have expired — re-auth with \`npm run auth\` (runs \`${login}\` against the golden image)`;
}

function truncate(text) {
	if (text.length <= MAX_REASON_CHARS) return text;
	return `${text.slice(0, MAX_REASON_CHARS)}… (truncated)`;
}

/**
 * Classify only verified provider-specific quota signatures.
 * @param {string} text Combined provider output.
 * @param {unknown} provider Adapter provider key.
 * @returns {boolean}
 */
function isQuotaExhausted(text, provider) {
	const providerKey =
		typeof provider === "string" ? provider.toLowerCase() : "";
	if (providerKey === "agy") {
		return QUOTA_FAILURE_SIGNATURES.agy.test(text);
	}
	if (providerKey === "cursor") {
		return (
			QUOTA_FAILURE_SIGNATURES.cursor.usage.test(text) &&
			QUOTA_FAILURE_SIGNATURES.cursor.limit.test(text)
		);
	}
	return false;
}

/**
 * Classify only verified provider-specific unresolvable-model signatures.
 * @param {string} text Combined provider output.
 * @param {unknown} provider Adapter provider key.
 * @returns {boolean}
 */
function isModelUnavailable(text, provider) {
	const providerKey =
		typeof provider === "string" ? provider.toLowerCase() : "";
	const signature = MODEL_UNAVAILABLE_SIGNATURES[providerKey];
	return signature ? signature.test(text) : false;
}

/**
 * Turn a thrown execFileSync error from a provider invocation into a
 * diagnosable adapter-result fragment. Intended for NON-timeout failures only —
 * the timeout path keeps `error.message` so the ETIMEDOUT signal survives.
 * @param {(Error & {stdout?: string, stderr?: string, code?: string|number})} error
 * @param {object} [opts]
 * @param {string} [opts.provider] Provider name; attaches a re-auth hint on an auth failure.
 * @returns {{output: string, error: string, errorKind: ("auth_expired"|"quota_exhausted"|"model_unavailable"|null)}}
 */
export function describeExecError(error, { provider } = {}) {
	const stdout = typeof error?.stdout === "string" ? error.stdout : "";
	const stderr = typeof error?.stderr === "string" ? error.stderr : "";
	const combined = `${stdout}\n${stderr}`.trim();
	const haystack = combined.toLowerCase();
	const authExpired =
		combined.length > 0 &&
		AUTH_FAILURE_SIGNATURES.some((sig) => haystack.includes(sig));
	// Auth takes precedence if a provider emits both an auth and quota phrase;
	// an expired session is not evidence that the account quota is exhausted.
	const quotaExhausted =
		!authExpired && combined.length > 0 && isQuotaExhausted(combined, provider);
	// Last in precedence: an expired session or an exhausted quota can produce
	// odd downstream output, and neither is a catalog problem. Only classify the
	// model as unavailable when nothing better explains the failure.
	const modelUnavailable =
		!authExpired &&
		!quotaExhausted &&
		combined.length > 0 &&
		isModelUnavailable(combined, provider);

	// Prefer the provider's own words; fall back to Node's wrapper only when the
	// provider printed nothing (e.g. it was killed before it could output).
	let reason = truncate(
		combined || error?.message || "unknown execution failure",
	);

	if (authExpired) {
		const hint = provider ? reauthHintFor(provider) : null;
		if (hint) reason = `${hint} | provider output: ${reason}`;
	}

	return {
		output: stdout,
		error: reason,
		errorKind: authExpired
			? "auth_expired"
			: quotaExhausted
				? "quota_exhausted"
				: modelUnavailable
					? "model_unavailable"
					: null,
	};
}
