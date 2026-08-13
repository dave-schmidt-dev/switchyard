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
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";

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

// This is the only error vocabulary allowed to cross a persistence boundary.
// Keep provider text at the adapter edge; callers persist only one of these
// enum values plus the static metadata below. quota_exhausted is intentionally
// allowlisted here, but only the provider-scoped classifier below may request
// it from a transient adapter result.
export const PERSISTED_ERROR_KINDS = Object.freeze([
	"auth_expired",
	"quota_exhausted",
	"execution_failed",
	"execution_timed_out",
	"integration_failed",
	"no_provider",
	"unsupported_provider",
	"launch_failed",
	"result_fetch_failed",
	"orchestrator_timeout",
	"executor_not_switchyard",
	"unknown_failure",
]);

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
	execution_failed: Object.freeze({
		reasonCode: "execution_failed",
		reason: "Provider execution failed before a reviewed integration.",
	}),
	execution_timed_out: Object.freeze({
		reasonCode: "execution_timed_out",
		reason: "Provider execution exceeded its bounded deadline.",
	}),
	integration_failed: Object.freeze({
		reasonCode: "integration_failed",
		reason: "The reviewed integration gate rejected the task result.",
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
});

const SUCCESS_RESULTS = new Set(["success", "success_no_diff"]);

const RESULT_TO_ERROR_KIND = Object.freeze({
	execution_failed: "execution_failed",
	execution_timed_out: "execution_timed_out",
	integration_failed: "integration_failed",
	no_provider: "no_provider",
	unsupported_provider: "unsupported_provider",
	launch_failed: "launch_failed",
	result_fetch_failed: "result_fetch_failed",
	orchestrator_timed_out: "orchestrator_timeout",
	executor_not_switchyard: "executor_not_switchyard",
	halted_after_commit_failure: "unknown_failure",
	halted_after_reset_failure: "unknown_failure",
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
} = {}) {
	if (!result || SUCCESS_RESULTS.has(result)) return null;
	const requestedKind = normalizePersistentErrorKind(errorKind);
	const kind =
		requestedKind ??
		(timedOut
			? "execution_timed_out"
			: (RESULT_TO_ERROR_KIND[result] ?? "unknown_failure"));
	const metadata = PERSISTED_ERROR_METADATA[kind];
	const safe = {
		errorKind: kind,
		reasonCode: metadata.reasonCode,
		reason: metadata.reason,
	};
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
	return true;
}

// Cap the surfaced reason so a runaway provider dump can't bloat the ledger
// line (JSONL, one object per line) or a status surface.
const MAX_REASON_CHARS = 800;

// D-10: per-provider re-auth command, matching README's documented recovery step.
// An expired-but-present token is NOT fixed by `npm run auth` (it skips any
// credential that already passes the presence check), so the hint points at a
// direct interactive login against the standing agent container — which needs a
// real TTY (`-it`), so it cannot be run from this non-interactive dispatch
// path. These mirror the login commands in auth/index.mjs verbatim.
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
	return `${provider} session may have expired — re-auth from a real terminal: docker exec -it ${AGENT_CONTAINER_NAME} ${login}`;
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
 * Turn a thrown execFileSync error from a provider invocation into a
 * diagnosable adapter-result fragment. Intended for NON-timeout failures only —
 * the timeout path keeps `error.message` so the ETIMEDOUT signal survives.
 * @param {(Error & {stdout?: string, stderr?: string, code?: string|number})} error
 * @param {object} [opts]
 * @param {string} [opts.provider] Provider name; attaches a re-auth hint on an auth failure.
 * @returns {{output: string, error: string, errorKind: ("auth_expired"|"quota_exhausted"|null)}}
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
				: null,
	};
}
