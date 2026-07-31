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

// Cap the surfaced reason so a runaway provider dump can't bloat the ledger
// line (JSONL, one object per line) or a status surface.
const MAX_REASON_CHARS = 800;

// Per-provider re-auth command, matching README's documented recovery step.
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
	copilot: "copilot auth login",
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
 * Turn a thrown execFileSync error from a provider invocation into a
 * diagnosable adapter-result fragment. Intended for NON-timeout failures only —
 * the timeout path keeps `error.message` so the ETIMEDOUT signal survives.
 * @param {(Error & {stdout?: string, stderr?: string, code?: string|number})} error
 * @param {object} [opts]
 * @param {string} [opts.provider] Provider name; attaches a re-auth hint on an auth failure.
 * @returns {{output: string, error: string, errorKind: ("auth_expired"|null)}}
 */
export function describeExecError(error, { provider } = {}) {
	const stdout = typeof error?.stdout === "string" ? error.stdout : "";
	const stderr = typeof error?.stderr === "string" ? error.stderr : "";
	const combined = `${stdout}\n${stderr}`.trim();
	const haystack = combined.toLowerCase();
	const authExpired =
		combined.length > 0 &&
		AUTH_FAILURE_SIGNATURES.some((sig) => haystack.includes(sig));

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
		errorKind: authExpired ? "auth_expired" : null,
	};
}
