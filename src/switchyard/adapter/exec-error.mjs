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
	"task_selection_failed",
	"environment_incomplete",
	"project_lock_failed",
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
 * Read one of a child process's text fields as a string.
 *
 * `execFileSync` hands `stdout`/`stderr` back as Buffers whenever the caller
 * does not ask for utf8, and callers here do exactly that: the bulk-transfer
 * helper is spawned with `encoding: null`, and an injected `prlctlFn` is free
 * to choose. A bare `typeof x === "string"` check drops the text in precisely
 * that case, which is how a real diagnostic becomes an empty one.
 * @param {unknown} value
 * @returns {string}
 */
function childProcessText(value) {
	if (typeof value === "string") return value.trim();
	if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
	return "";
}

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

/**
 * Project a reviewed prlctl failure into the persisted-metadata fields.
 * Returns null for anything that is not a `PrlctlCallError`.
 * @param {unknown} error
 * @returns {{diagnosticCode: string, exitCode?: number, signal?: string}|null}
 */
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

/** Return a closed host errno from the actual cause of a reviewed prlctl error. */
export function prlctlTrustedCauseCode(error) {
	if (!(error instanceof PrlctlCallError)) return null;
	return ["EACCES", "EPERM", "ENOENT", "ETIMEDOUT"].includes(error.cause?.code)
		? error.cause.code
		: null;
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
	"integration_state_unknown",
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
	"integration_state_unknown",
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
	"vm_admission_permission_denied",
	"vm_admission_storage_failed",
	"vm_admission_unavailable",
	"vm_slot_unavailable",
	"vm_host_inventory_permission_denied",
	"vm_host_inventory_unavailable",
	"vm_host_service_degraded",
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
	"task_selection_failed",
	"environment_incomplete",
	// A run that ends `failed` must say why. These two name the cases where the
	// answer used to be nothing at all: the queue resolving without a result and
	// without throwing, and a failed task result carrying no classifiable
	// metadata. Both previously produced `lastFailure: null` on a failed run.
	"queue_returned_no_result",
	"terminal_without_failure_metadata",
	"project_lock_held",
	"project_lock_recovery_in_progress",
	"project_lock_ownership_failed",
	"project_lock_ownership_displaced",
	"project_lock_claim_cleanup_failed",
	"project_lock_recovery_claim_blocks_execution",
]);

const PERSISTED_FAILURE_PHASES = new Set([
	"adapter_validation",
	"provider_execution",
	"provider_cleanup",
	"terminal_reconciliation",
	"worker_boot",
	"task_selection",
	"queue_preflight",
	"checkpoint_validation",
	"project_lock",
]);

const CHECKPOINT_DIAGNOSTIC_CODES = new Set([
	"checkpoint_task_file_mismatch",
	"checkpoint_tasks_file_mismatch",
	"checkpoint_missing_queue_identity",
	"checkpoint_queue_identity_missing",
	"checkpoint_queue_identity_mismatch",
	"checkpoint_run_options_mismatch",
	"checkpoint_historical_checkpoint",
	"checkpoint_historical_state",
]);

const LOCK_DIAGNOSTIC_CODES = Object.freeze({
	PROJECT_LOCK_HELD: "project_lock_held",
	PROJECT_LOCK_RECOVERY_IN_PROGRESS: "project_lock_recovery_in_progress",
	PROJECT_LOCK_OWNERSHIP_FAILED: "project_lock_ownership_failed",
	PROJECT_LOCK_OWNERSHIP_DISPLACED: "project_lock_ownership_displaced",
	PROJECT_LOCK_CLAIM_CLEANUP_FAILED: "project_lock_claim_cleanup_failed",
	PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION:
		"project_lock_recovery_claim_blocks_execution",
});

/** Complete closed output set of classifyPreProviderFailure. */
export const PRE_PROVIDER_FAILURE_TRIPLES = Object.freeze([
	Object.freeze({
		diagnosticCode: "integration_state_unknown",
		errorKind: "integration_failed",
		failurePhase: "checkpoint_validation",
	}),
	Object.freeze({
		diagnosticCode: "task_selection_failed",
		errorKind: "task_selection_failed",
		failurePhase: "task_selection",
	}),
	Object.freeze({
		diagnosticCode: "environment_incomplete",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	Object.freeze({
		diagnosticCode: "vm_admission_permission_denied",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	Object.freeze({
		diagnosticCode: "vm_admission_storage_failed",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	Object.freeze({
		diagnosticCode: "vm_admission_unavailable",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	Object.freeze({
		diagnosticCode: "vm_slot_unavailable",
		errorKind: "environment_incomplete",
		failurePhase: "queue_preflight",
	}),
	...[
		"vm_host_inventory_permission_denied",
		"vm_host_inventory_unavailable",
		"vm_host_service_degraded",
	].map((diagnosticCode) =>
		Object.freeze({
			diagnosticCode,
			errorKind: "environment_incomplete",
			failurePhase: "queue_preflight",
		}),
	),
	...[...CHECKPOINT_DIAGNOSTIC_CODES].map((diagnosticCode) =>
		Object.freeze({
			diagnosticCode,
			errorKind: "launch_failed",
			failurePhase: "worker_boot",
		}),
	),
	...Object.values(LOCK_DIAGNOSTIC_CODES).map((diagnosticCode) =>
		Object.freeze({
			diagnosticCode,
			errorKind: "project_lock_failed",
			failurePhase: "project_lock",
		}),
	),
	...[
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
	].map((diagnosticCode) =>
		Object.freeze({
			diagnosticCode,
			errorKind: "launch_failed",
			failurePhase: "worker_boot",
		}),
	),
]);

const PRE_PROVIDER_TRIPLE_BY_CODE = new Map(
	PRE_PROVIDER_FAILURE_TRIPLES.map((triple) => [triple.diagnosticCode, triple]),
);

/**
 * Classify known failures before provider execution without retaining error text.
 * Arbitrary codes and messages are ignored.
 */
export function classifyPreProviderFailure(error) {
	if (!error || typeof error !== "object") return null;
	let diagnosticCode = null;
	if (error.name === "TaskSelectionError") {
		diagnosticCode = "task_selection_failed";
	} else if (
		error.name === "IntegrationStateUnknownError" &&
		error.code === "INTEGRATION_STATE_UNKNOWN"
	) {
		diagnosticCode = "integration_state_unknown";
	} else if (error.name === "QueuePreflightError") {
		diagnosticCode = "environment_incomplete";
	} else if (CHECKPOINT_DIAGNOSTIC_CODES.has(error.code)) {
		diagnosticCode = error.code;
	} else if (
		error.name === "LockError" &&
		Object.hasOwn(LOCK_DIAGNOSTIC_CODES, error.code)
	) {
		diagnosticCode = LOCK_DIAGNOSTIC_CODES[error.code];
	} else if (
		error.name === "VmAdmissionPermissionDeniedError" &&
		error.code === "VM_ADMISSION_PERMISSION_DENIED"
	) {
		diagnosticCode = "vm_admission_permission_denied";
	} else if (
		error.name === "VmAdmissionStorageError" &&
		error.code === "VM_ADMISSION_STORAGE_FAILED"
	) {
		diagnosticCode = "vm_admission_storage_failed";
	} else if (
		error.name === "VmAdmissionUnavailableError" &&
		error.code === "VM_ADMISSION_UNAVAILABLE"
	) {
		diagnosticCode = "vm_admission_unavailable";
	} else if (
		error.name === "VmSlotUnavailableError" &&
		error.code === "VM_SLOT_UNAVAILABLE"
	) {
		diagnosticCode = "vm_slot_unavailable";
	} else if (
		error.name === "ParallelsHostReadinessError" &&
		[
			"vm_host_inventory_permission_denied",
			"vm_host_inventory_unavailable",
			"vm_host_service_degraded",
		].includes(error.code)
	) {
		diagnosticCode = error.code;
	} else {
		const prlctl = prlctlFailureMetadata(error);
		diagnosticCode =
			prlctl?.diagnosticCode ?? workerBootStageDiagnosticCode(error) ?? null;
	}
	return PRE_PROVIDER_TRIPLE_BY_CODE.get(diagnosticCode) ?? null;
}
/** Signal names that may be persisted; anything else is dropped. */
export const PERSISTED_SIGNALS = new Set([
	"SIGABRT",
	"SIGHUP",
	"SIGINT",
	"SIGKILL",
	"SIGQUIT",
	"SIGTERM",
]);

export const CHECKPOINT_REMEDIATION_MESSAGES = Object.freeze({
	checkpoint_task_file_mismatch:
		"checkpoint task file mismatch: tasksFilePath does not match; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_tasks_file_mismatch:
		"checkpoint task file mismatch: tasksFilePath does not match; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_missing_queue_identity:
		"checkpoint v2 is missing queueIdentity; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_queue_identity_missing:
		"checkpoint v2 is missing queueIdentity; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_queue_identity_mismatch:
		"checkpoint queue identity mismatch; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_run_options_mismatch:
		"checkpoint run options mismatch: normalized run options changed; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_historical_checkpoint:
		"checkpoint is historical state without queue identity; create a fresh checkpoint explicitly or use an audited migration",
	checkpoint_historical_state:
		"checkpoint is historical state without queue identity; create a fresh checkpoint explicitly or use an audited migration",
});

export const CHECKPOINT_IDENTITY_DIMENSIONS = new Set([
	"tasksFilePath",
	"queueIdentity",
	"runOptions",
	"checkpointVersion",
	"taskIds",
	"excludeProviders",
	"onlyProviders",
	"maxTasks",
	"stopOnFailure",
]);

function normalizedCheckpointDimensions(dimensions) {
	if (!Array.isArray(dimensions)) return [];
	return [
		...new Set(
			dimensions.filter(
				(dimension) =>
					typeof dimension === "string" &&
					CHECKPOINT_IDENTITY_DIMENSIONS.has(dimension),
			),
		),
	];
}

function checkpointDimensionsFromReason(code, reason) {
	const prefix = CHECKPOINT_REMEDIATION_MESSAGES[code];
	const marker = `${prefix} changed: `;
	const suffix =
		". Example fresh checkpoint: switchyard-fresh.checkpoint.json.";
	if (typeof reason !== "string" || !reason.startsWith(marker)) return [];
	if (!reason.endsWith(suffix)) return [];
	return normalizedCheckpointDimensions(
		reason
			.slice(marker.length, -suffix.length)
			.replace(/\.$/u, "")
			.split(", ")
			.filter(Boolean),
	);
}

export function checkpointRemediation(code, { dimensions = [] } = {}) {
	const changed = normalizedCheckpointDimensions(dimensions);
	const suffix = changed.length > 0 ? ` changed: ${changed.join(", ")}.` : "";
	return `${CHECKPOINT_REMEDIATION_MESSAGES[code] ?? "create a fresh checkpoint explicitly"}${suffix} Example fresh checkpoint: switchyard-fresh.checkpoint.json.`;
}

// A diagnostic is authoritative only when a reviewed host boundary minted it.
// Provider/model/task output is evidence for people, never a routing authority.
// In particular, `usage:` and `invalid value` are ordinary prose in prompts and
// child-tool output, so they must not be promoted to CLI misuse by matching text.
const DIAGNOSTIC_ORIGINS = Object.freeze([
	"adapter",
	"launcher",
	"worker_boot",
	"integration",
]);
const DIAGNOSTIC_ORIGIN_SET = new Set(DIAGNOSTIC_ORIGINS);

const ADAPTER_PROVIDER_EXECUTION_CODES = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
	"provider_exit_nonzero",
	"provider_signalled",
	"execution_timed_out",
	"execution_cancelled",
]);
const ADAPTER_PROVIDER_CLEANUP_CODES = new Set([
	"provider_cleanup_failed",
	...Object.values(CLEANUP_STAGE_DIAGNOSTIC_CODES),
]);
const INTEGRATION_DIAGNOSTIC_CODES = new Set([
	"integration_failed",
	"required_paths_missing",
	"undeclared_paths_touched",
	"empty_required_diff",
	"no_op_diff",
	...INTEGRATION_REFUSAL_KINDS,
]);

/** True only for code/origin/phase combinations minted by a reviewed host boundary. */
export function hasAuthoritativeDiagnosticProvenance({
	diagnosticCode,
	diagnosticOrigin,
	diagnosticEvidenceAvailable,
	failurePhase,
} = {}) {
	if (
		diagnosticEvidenceAvailable !== true ||
		!DIAGNOSTIC_ORIGIN_SET.has(diagnosticOrigin)
	) {
		return false;
	}
	if (diagnosticOrigin === "launcher") {
		return (
			diagnosticCode === "cli_usage_error" &&
			failurePhase === "provider_execution"
		);
	}
	if (diagnosticOrigin === "adapter") {
		return (
			(failurePhase === "provider_execution" &&
				ADAPTER_PROVIDER_EXECUTION_CODES.has(diagnosticCode)) ||
			(failurePhase === "provider_cleanup" &&
				ADAPTER_PROVIDER_CLEANUP_CODES.has(diagnosticCode))
		);
	}
	if (diagnosticOrigin === "worker_boot") {
		const triple = PRE_PROVIDER_TRIPLE_BY_CODE.get(diagnosticCode);
		return Boolean(triple && triple.failurePhase === failurePhase);
	}
	return (
		diagnosticOrigin === "integration" &&
		failurePhase === "adapter_validation" &&
		INTEGRATION_DIAGNOSTIC_CODES.has(diagnosticCode)
	);
}

function trustedLauncherUsageDiagnostic({
	diagnosticCode,
	diagnosticOrigin,
	diagnosticEvidenceAvailable,
	failurePhase,
}) {
	return (
		diagnosticCode === "cli_usage_error" &&
		diagnosticOrigin === "launcher" &&
		diagnosticEvidenceAvailable === true &&
		failurePhase === "provider_execution"
	);
}

const TRUSTED_ADAPTER_DIAGNOSTIC_CODES = new Set([
	"auth_expired",
	"quota_exhausted",
	"model_unavailable",
]);

/** Convert provider execution evidence into a content-free diagnostic code. */
export function classifyProviderDiagnostic({
	diagnosticCode,
	diagnosticOrigin,
	diagnosticEvidenceAvailable = false,
	failurePhase = "provider_execution",
	exitCode,
	signal,
	timedOut = false,
	cancelled = false,
} = {}) {
	// `cli_usage_error` is intentionally the sole launcher-minted code. It
	// cannot be inferred from text supplied by a provider or task.
	if (
		trustedLauncherUsageDiagnostic({
			diagnosticCode,
			diagnosticOrigin,
			diagnosticEvidenceAvailable,
			failurePhase,
		})
	) {
		return "cli_usage_error";
	}
	if (
		diagnosticOrigin !== "adapter" ||
		diagnosticEvidenceAvailable !== true ||
		failurePhase !== "provider_execution"
	) {
		return null;
	}
	if (cancelled) return "execution_cancelled";
	if (timedOut) return "execution_timed_out";
	if (TRUSTED_ADAPTER_DIAGNOSTIC_CODES.has(diagnosticCode)) {
		return diagnosticCode;
	}
	if (typeof signal === "string" && signal) return "provider_signalled";
	if (Number.isSafeInteger(exitCode) && exitCode !== 0) {
		return "provider_exit_nonzero";
	}
	return null;
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
		reason: "Diff capture failed.",
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
	integration_state_unknown: Object.freeze({
		reasonCode: "integration_state_unknown",
		reason:
			"Durable integration evidence cannot prove whether the patch was applied.",
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
	task_selection_failed: Object.freeze({
		reasonCode: "task_selection_failed",
		reason: "The requested task selection does not satisfy the queue contract.",
	}),
	environment_incomplete: Object.freeze({
		reasonCode: "environment_incomplete",
		reason: "The selected queue environment did not pass preflight.",
	}),
	project_lock_failed: Object.freeze({
		reasonCode: "project_lock_failed",
		reason: "Project lock acquisition or ownership validation failed.",
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
	integration_state_unknown: "integration_state_unknown",
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
 * @param {string} [input.result]
 * @param {string|null} [input.errorKind]
 * @param {boolean} [input.timedOut]
 * @param {string} [input.artifactRef] storage-returned opaque reference
 * @returns {{errorKind: string, reasonCode: string, reason: string, artifactRef?: string}|null}
 */
export function sanitizeFailureMetadata({
	result,
	errorKind,
	timedOut = false,
	artifactRef,
	diagnosticCode,
	diagnosticOrigin,
	diagnosticEvidenceAvailable,
	exitCode,
	signal,
	failurePhase,
	cleanupStage,
	resolvedTargetId,
	descriptorIdentity,
	descriptorHarness,
	diagnosticRef,
	checkpointCode,
	checkpointDimensions,
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
	const normalizedCheckpointCode =
		typeof checkpointCode === "string" &&
		Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, checkpointCode)
			? checkpointCode
			: null;
	const normalizedDimensions =
		normalizedCheckpointDimensions(checkpointDimensions);
	if (normalizedCheckpointCode) {
		safe.reasonCode = normalizedCheckpointCode;
		safe.reason = checkpointRemediation(normalizedCheckpointCode, {
			dimensions: normalizedDimensions,
		});
		safe.checkpointCode = normalizedCheckpointCode;
		safe.checkpointDimensions = normalizedDimensions;
	}
	const safeCleanupDiagnostic = cleanupDiagnosticCodeFor(cleanupStage);
	const closedDiagnosticCode = PERSISTED_DIAGNOSTIC_CODES.includes(
		diagnosticCode,
	)
		? diagnosticCode
		: safeCleanupDiagnostic;
	const hasProvenanceInput =
		diagnosticOrigin !== undefined || diagnosticEvidenceAvailable !== undefined;
	const authoritativeProvenance = hasAuthoritativeDiagnosticProvenance({
		diagnosticCode: closedDiagnosticCode,
		diagnosticOrigin,
		diagnosticEvidenceAvailable,
		failurePhase,
	});
	const trustedDiagnosticShape = hasAuthoritativeDiagnosticProvenance({
		diagnosticCode: closedDiagnosticCode,
		diagnosticOrigin,
		diagnosticEvidenceAvailable: true,
		failurePhase,
	});
	if (
		closedDiagnosticCode &&
		(!hasProvenanceInput || authoritativeProvenance || trustedDiagnosticShape)
	) {
		safe.diagnosticCode = closedDiagnosticCode;
	}
	if (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
		safe.exitCode = exitCode;
	}
	if (PERSISTED_SIGNALS.has(signal)) safe.signal = signal;
	if (PERSISTED_FAILURE_PHASES.has(failurePhase)) {
		safe.failurePhase = failurePhase;
	}
	if (
		(authoritativeProvenance || trustedDiagnosticShape) &&
		diagnosticEvidenceAvailable === true
	) {
		safe.diagnosticOrigin = diagnosticOrigin;
		safe.diagnosticEvidenceAvailable = true;
	}
	if (diagnosticEvidenceAvailable === false) {
		safe.diagnosticEvidenceAvailable = false;
	}
	if (
		typeof artifactRef === "string" &&
		/^artifact:[a-f0-9]{24}$/u.test(artifactRef)
	) {
		safe.artifactRef = artifactRef;
	}
	if (trustedDiagnosticShape && diagnosticEvidenceAvailable !== true) {
		safe.diagnosticOrigin = diagnosticOrigin;
	}
	if (
		typeof diagnosticRef === "string" &&
		/^diagnostic:[a-f0-9]{32}$/u.test(diagnosticRef) &&
		diagnosticEvidenceAvailable === true
	) {
		safe.diagnosticRef = diagnosticRef;
	}
	// Route identity is additive, bounded provenance. It is deliberately
	// independent from raw invocation arguments so it is safe in public state.
	if (
		typeof resolvedTargetId === "string" &&
		resolvedTargetId.length > 0 &&
		resolvedTargetId.length <= 256 &&
		!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(resolvedTargetId) &&
		typeof descriptorIdentity === "string" &&
		/^sha256:[a-f0-9]{64}$/.test(descriptorIdentity) &&
		typeof descriptorHarness === "string" &&
		descriptorHarness.length > 0 &&
		descriptorHarness.length <= 128 &&
		!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(descriptorHarness)
	) {
		safe.resolvedTargetId = resolvedTargetId;
		safe.descriptorIdentity = descriptorIdentity;
		safe.descriptorHarness = descriptorHarness;
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
		"diagnosticOrigin",
		"diagnosticEvidenceAvailable",
		"resolvedTargetId",
		"descriptorIdentity",
		"descriptorHarness",
		"diagnosticRef",
		"checkpointCode",
		"checkpointDimensions",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
	const expected = sanitizeFailureMetadata({
		result: "execution_failed",
		errorKind: value.errorKind,
	});
	if (!expected) return false;
	const checkpointCode =
		typeof value.checkpointCode === "string" &&
		Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, value.checkpointCode)
			? value.checkpointCode
			: typeof value.reasonCode === "string" &&
					Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, value.reasonCode)
				? value.reasonCode
				: null;
	const checkpointDimensions =
		value.checkpointDimensions !== undefined
			? normalizedCheckpointDimensions(value.checkpointDimensions)
			: checkpointDimensionsFromReason(checkpointCode, value.reason);
	const checkpointReason = checkpointCode
		? checkpointRemediation(checkpointCode, {
				dimensions: checkpointDimensions,
			})
		: null;
	if (
		(value.reasonCode !== expected.reasonCode &&
			value.reasonCode !== checkpointCode) ||
		(value.reason !== expected.reason && value.reason !== checkpointReason) ||
		(checkpointCode && value.reasonCode !== checkpointCode) ||
		(checkpointCode && value.reason !== checkpointReason) ||
		(value.checkpointDimensions !== undefined &&
			(!Array.isArray(value.checkpointDimensions) ||
				value.checkpointDimensions.length !== checkpointDimensions.length)) ||
		(value.checkpointCode !== undefined &&
			value.checkpointCode !== checkpointCode)
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
	if (
		value.diagnosticRef !== undefined &&
		(typeof value.diagnosticRef !== "string" ||
			!/^diagnostic:[a-f0-9]{32}$/u.test(value.diagnosticRef))
	)
		return false;
	const safeDiagnostics = sanitizeFailureMetadata({
		result: "execution_failed",
		diagnosticCode: value.diagnosticCode,
		exitCode: value.exitCode,
		signal: value.signal,
		failurePhase: value.failurePhase,
		diagnosticOrigin: value.diagnosticOrigin,
		diagnosticEvidenceAvailable: value.diagnosticEvidenceAvailable,
		resolvedTargetId: value.resolvedTargetId,
		descriptorIdentity: value.descriptorIdentity,
		descriptorHarness: value.descriptorHarness,
		diagnosticRef: value.diagnosticRef,
		checkpointCode: value.checkpointCode,
		checkpointDimensions: value.checkpointDimensions,
	});
	for (const field of [
		"diagnosticCode",
		"exitCode",
		"signal",
		"failurePhase",
		"diagnosticOrigin",
		"diagnosticEvidenceAvailable",
		"resolvedTargetId",
		"descriptorIdentity",
		"descriptorHarness",
		"diagnosticRef",
		"checkpointCode",
		"checkpointDimensions",
	]) {
		if (field === "checkpointDimensions") {
			if (value[field] === undefined && safeDiagnostics?.[field] === undefined)
				continue;
			if (
				!Array.isArray(value[field]) ||
				!Array.isArray(safeDiagnostics?.[field]) ||
				value[field].length !== safeDiagnostics[field].length ||
				value[field].some(
					(dimension, index) => dimension !== safeDiagnostics[field][index],
				)
			)
				return false;
			continue;
		}
		if (value[field] !== safeDiagnostics?.[field]) return false;
	}
	return true;
}

// Cap the surfaced reason so a runaway provider dump can't bloat the ledger
// line (JSONL, one object per line) or a status surface.
const MAX_REASON_CHARS = 800;

// Durable provider evidence is deliberately stricter than the legacy human
// diagnostic helper above.  Only complete, provider-owned lines may mint a
// closed diagnostic code; mixed or partially matching streams remain unknown.
const STRICT_PROVIDER_LINES = Object.freeze({
	auth_required:
		/^(?:Error:\s*)?(?:Authentication required|Not logged in|Session expired)$/iu,
	usage_exhausted:
		/^(?:Error:\s*)?(?:Usage limit reached|Quota exhausted|Rate limit exceeded)$/iu,
	model_unsupported:
		/^(?:Error:\s*)?(?:Model unavailable|Unsupported model|Model not found)$/iu,
	permission_denied: /^(?:Error:\s*)?(?:Permission denied|EACCES)$/iu,
	network_unreachable:
		/^(?:Error:\s*)?(?:Network unreachable|Connection refused|Connection error|ENOTFOUND)$/iu,
});

const PROVIDER_DIAGNOSTIC_KIND_TO_RUNTIME_CODE = Object.freeze({
	auth_required: "auth_expired",
	usage_exhausted: "quota_exhausted",
	model_unsupported: "model_unavailable",
	cli_usage_error: "cli_usage_error",
});

/** Map only established provider artifact kinds into legacy runtime codes. */
export function providerDiagnosticCodeForKind(kind) {
	return PROVIDER_DIAGNOSTIC_KIND_TO_RUNTIME_CODE[kind] ?? null;
}

const PROVIDER_BINARIES = Object.freeze({
	claude: new Set(["claude"]),
	codex: new Set(["codex"]),
	agy: new Set(["agy"]),
	cursor: new Set(["cursor", "cursor-agent"]),
	copilot: new Set(["copilot"]),
	opencode: new Set(["opencode"]),
	vibe: new Set(["vibe"]),
});

function streamBytes(value) {
	if (Buffer.isBuffer(value)) return value;
	return typeof value === "string"
		? Buffer.from(value, "utf8")
		: Buffer.alloc(0);
}

/**
 * Parse real stdout/stderr independently for the durable diagnostic channel.
 * Unknown and mixed content is represented only by byte counts and SHA-256
 * digests; no provider text crosses this boundary.
 */
export function classifyProviderStreams({
	stdout = "",
	stderr = "",
	code = null,
	provider = null,
	command = null,
} = {}) {
	const outBytes = streamBytes(stdout);
	const errBytes = streamBytes(stderr);
	const out = outBytes.toString("utf8");
	const err = errBytes.toString("utf8");
	const digest = (bytes) =>
		`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const result = {
		stdoutBytes: outBytes.length,
		stderrBytes: errBytes.length,
		stdoutDigest: digest(outBytes),
		stderrDigest: digest(errBytes),
	};
	const lines = (text) =>
		text
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);
	const all = [...lines(out), ...lines(err)];
	if (all.length === 0) return result;
	const binary =
		typeof command === "string" ? command.split(/[\\/]/u).at(-1) : null;
	const providerKey =
		typeof provider === "string" ? provider.toLowerCase() : null;
	const approvedPair =
		providerKey !== null &&
		binary !== null &&
		PROVIDER_BINARIES[providerKey]?.has(binary) === true;
	if (
		code === 2 &&
		all.length > 0 &&
		approvedPair &&
		all[0].startsWith(`Usage: ${binary}`)
	) {
		return { ...result, diagnosticKind: "cli_usage_error" };
	}
	if (approvedPair) {
		let matchedKind = null;
		for (const line of all) {
			const lineKind = Object.entries(STRICT_PROVIDER_LINES).find(
				([, pattern]) => pattern.test(line),
			)?.[0];
			if (!lineKind || (matchedKind !== null && lineKind !== matchedKind)) {
				return result;
			}
			matchedKind ??= lineKind;
		}
		if (matchedKind !== null) {
			return { ...result, diagnosticKind: matchedKind };
		}
	}
	return result;
}

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
	// Decoded rather than type-checked: a Buffer here would empty `combined`,
	// and every classification below is gated on `combined.length > 0`. The
	// failure mode is quiet and expensive -- the reason string still reads
	// correctly, because #detailOf already lifted the text into the message, but
	// `errorKind` comes back null and auth/index.mjs keys its headless re-login
	// on `errorKind`. An expired session would present as an unclassified error
	// and never trigger the re-auth that would have fixed it.
	const stdout = childProcessText(error?.stdout);
	const stderr = childProcessText(error?.stderr);
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
