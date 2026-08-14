// Auth walkthrough - checks every provider's real credential state and, for
// any that aren't authenticated, runs its real interactive OAuth login
// inside the standing agent container so a human can complete it live.
//
//   npm run auth              full walkthrough: check, then log in anything unauthed
//   npm run auth:check        read-only status report — never attempts a login
//   npm run auth:check:live   the same report, plus one real request per provider
//
// Use --check (npm run auth:check) to just look. It reuses the same
// isXAuthenticated() checks as the walkthrough, so it can't disagree with what
// a real dispatch sees, and it never mutates auth state — the safe replacement
// for hand-rolling a `docker exec ... test -e` credential probe.
//
// Those checks answer "is there a credential", not "does this session work".
// The difference is not academic: on 2026-08-13 this command reported claude
// and opencode authenticated while every dispatch to them failed, and the
// walkthrough gated its login on the same check, so it skipped the repair too.
// Liveness (auth/liveness.mjs) closes that: the walkthrough always probes, and
// --check does on request. See that file for why each probe's invocation is
// empirical rather than read off a --help page.
// PW-4: Independent in-container login (subscription, never API keys).
// TASKS.md Task 24: there is no headless auto-login — every provider's real
// login step requires a human to complete a browser or device-code OAuth
// consent, so this walks the human through each one rather than attempting
// to drive it unattended. Replaces the earlier BWS-credential-injection
// design (`authenticateX()`/`buildAuthContainerScript()`, removed from all
// four adapters).

import { execFileSync } from "node:child_process";
import { isAgyAuthenticated } from "../adapter/agy.mjs";
import { isClaudeAuthenticated } from "../adapter/claude.mjs";
import { isCodexAuthenticated } from "../adapter/codex.mjs";
import { isCopilotAuthenticated } from "../adapter/copilot.mjs";
import { isCursorAuthenticated } from "../adapter/cursor.mjs";
import { isOpencodeAuthenticated } from "../adapter/opencode.mjs";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import { ensureAgentContainer } from "../runner/index.mjs";
import { probeLiveness } from "./liveness.mjs";

/**
 * Run a provider's real login command interactively inside the standing
 * agent container, attached to this process's own TTY so a human can
 * complete whatever the flow needs (visit a URL, paste a device code,
 * approve in a browser). Never trust this call's exit code as the outcome —
 * a cancelled or timed-out login can exit non-zero even though nothing
 * needs fixing, and a "successful" run doesn't by itself guarantee the
 * account is now authenticated. The caller re-checks via isAuthenticated()
 * afterward, which is the real ground truth (same "don't trust the wrapped
 * command's exit code" principle the old authenticateX() functions used).
 * @param {string[]} loginCommand The CLI command + args to run, e.g. ["claude", "auth", "login"].
 * @param {Record<string, string>} [env] Extra env vars to forward via `docker exec -e`.
 */
function runInteractiveLogin(loginCommand, env = {}) {
	// D-10: interactive OAuth remains attached to the standing Docker
	// credential container; the VM execution backend does not replace it.
	const dockerArgs = ["exec", "-it"];
	for (const [key, value] of Object.entries(env)) {
		dockerArgs.push("-e", `${key}=${value}`);
	}
	dockerArgs.push(AGENT_CONTAINER_NAME, ...loginCommand);
	try {
		execFileSync("docker", dockerArgs, { stdio: "inherit" });
	} catch {
		// Expected on Ctrl+C, a declined prompt, or a real login failure — the
		// isAuthenticated() re-check the caller performs is what matters.
	}
}

export const COPILOT_LOGIN_COMMAND = Object.freeze(["copilot", "login"]);

const PROVIDERS = [
	{
		name: "claude",
		isAuthenticated: isClaudeAuthenticated,
		isLive: () => probeLiveness("claude"),
		runLogin: () => runInteractiveLogin(["claude", "auth", "login"]),
	},
	{
		name: "codex",
		// --device-auth: a device-code flow, needs no local browser inside
		// the container.
		isAuthenticated: isCodexAuthenticated,
		isLive: () => probeLiveness("codex"),
		runLogin: () => runInteractiveLogin(["codex", "login", "--device-auth"]),
	},
	{
		name: "agy",
		// agy has no explicit login subcommand — running it unauthenticated
		// auto-triggers a real Google OAuth flow (prints a URL, then waits for
		// a pasted authorization code). Confirmed empirically: a plain
		// `agy --print "hi"` triggers it with no other side effect.
		isAuthenticated: isAgyAuthenticated,
		isLive: () => probeLiveness("agy"),
		runLogin: () => runInteractiveLogin(["agy", "--print", "hi"]),
	},
	{
		name: "cursor",
		// NO_OPEN_BROWSER=1: the CLI's own documented override to avoid trying
		// to launch a GUI browser inside a headless container.
		isAuthenticated: isCursorAuthenticated,
		isLive: () => probeLiveness("cursor"),
		runLogin: () =>
			runInteractiveLogin(["cursor-agent", "login"], {
				NO_OPEN_BROWSER: "1",
			}),
	},
	{
		name: "copilot",
		isAuthenticated: isCopilotAuthenticated,
		isLive: () => probeLiveness("copilot"),
		runLogin: () => runInteractiveLogin(COPILOT_LOGIN_COMMAND),
	},
	{
		name: "opencode",
		isAuthenticated: isOpencodeAuthenticated,
		isLive: () => probeLiveness("opencode"),
		runLogin: () => runInteractiveLogin(["opencode", "auth", "login"]),
	},
];

// Probe outcomes that prove the credentials work and that a login would not
// change. Keyed by the classification describeExecError() produced, so this
// grows with PERSISTED_ERROR_KINDS rather than duplicating it: auth_expired is
// deliberately absent, since that is exactly the case a login does fix. The
// value is the clause shown to the human, which has to name the real blocker —
// "authenticated, but ..." is the only thing distinguishing these from success.
const LOGIN_CANNOT_HELP = Object.freeze({
	quota_exhausted: "the provider reports quota exhausted",
	model_unavailable: "the provider CLI cannot resolve the probe's model",
});

/**
 * Presence, then liveness — and only in that order, because the probe costs a
 * real request against a real quota and a missing credential file already
 * answers the question.
 *
 * A provider with no `isLive` is reported on presence alone and said to be
 * unprobed. Injected providers (this module's tested seam) rely on that, and so
 * does any future provider whose live invocation has not been confirmed by
 * actually running it — a guessed probe is worse than no probe, because it
 * fails for flag reasons and calls a working provider dead.
 * @param {{name: string, isAuthenticated: () => boolean, isLive?: () => {live: boolean, reason: string|null, kind: string|null}}} provider
 * @param {boolean} probe Run the live probe when presence passes.
 * @returns {{authenticated: boolean, live: boolean|null, reason: string|null, kind: string|null}}
 */
function inspectProvider(provider, probe) {
	const authenticated = provider.isAuthenticated();
	if (!authenticated || !probe || typeof provider.isLive !== "function") {
		return { authenticated, live: null, reason: null, kind: null };
	}
	const result = provider.isLive();
	return {
		authenticated,
		live: result.live === true,
		reason: result.reason ?? null,
		kind: result.kind ?? null,
	};
}

/**
 * Walk a human through authenticating every provider that isn't already
 * authenticated: check real credential state first (skip anything already
 * good), then hand the terminal to the real in-container login for anything
 * that isn't, and re-check afterward.
 * @param {Array<{name: string, isAuthenticated: () => boolean, runLogin: () => void}>} [providers]
 * @returns {Array<{name: string, wasAuthenticated: boolean, ranLogin: boolean, authenticated: boolean}>}
 */
export function ensureProvidersAuthenticated(providers = PROVIDERS) {
	return providers.map((provider) => {
		let wasAuthenticated = false;
		let ranLogin = false;
		try {
			const state = inspectProvider(provider, true);
			// An expired session leaves the credential file exactly where it was,
			// so presence alone kept answering "already authenticated" and this
			// walkthrough skipped the one provider that needed it — claude, for a
			// whole session, while every dispatch to it failed `auth_expired`.
			// Liveness is what decides whether to run the login.
			if (LOGIN_CANNOT_HELP[state.kind]) {
				// Credentials are fine and a login cannot help; saying otherwise
				// would send a human through an OAuth flow to fix a quota — or,
				// since `kind` forwards describeExecError()'s classification
				// verbatim, to fix a model the CLI cannot resolve.
				console.log(
					`\n--- ${provider.name}: authenticated, but ${LOGIN_CANNOT_HELP[state.kind]} — skipping login (${state.reason}) ---\n`,
				);
				return {
					name: provider.name,
					wasAuthenticated: true,
					ranLogin: false,
					authenticated: true,
				};
			}
			wasAuthenticated = state.authenticated && state.live !== false;
			if (wasAuthenticated) {
				return {
					name: provider.name,
					wasAuthenticated: true,
					ranLogin: false,
					authenticated: true,
				};
			}
			console.log(
				state.authenticated
					? `\n--- ${provider.name}: credential present but the provider did not answer (${state.reason}) — starting interactive login, follow the prompts ---\n`
					: `\n--- ${provider.name}: not authenticated — starting interactive login, follow the prompts ---\n`,
			);
			ranLogin = true;
			provider.runLogin();
			// Re-check the same way, not the cheap way: a login that "succeeded"
			// and left an unusable session is the exact state this walkthrough was
			// reporting as fixed.
			const after = inspectProvider(provider, true);
			return {
				name: provider.name,
				wasAuthenticated: false,
				ranLogin: true,
				authenticated: after.authenticated && after.live !== false,
			};
		} catch (error) {
			// A provider's isAuthenticated()/runLogin() throwing must not abort
			// the walkthrough for every other provider — this function's own
			// tested contract (see "processes every provider even when an
			// earlier one fails to authenticate" in auth-check.test.mjs)
			// already promises one provider's problem can't stop the rest, and
			// a throw inside Array#map would otherwise abort iteration
			// entirely, silently skipping every later provider. Real adapters
			// never throw here today (runInteractiveLogin swallows exec
			// errors, and every isXAuthenticated() has its own try/catch), but
			// this function accepts injected providers as its tested seam, so
			// a throwing provider is a real input to its contract, not a
			// can't-happen guard.
			console.error(
				`\n--- ${provider.name}: auth check threw, treating as not authenticated: ${error.message} ---\n`,
			);
			return {
				name: provider.name,
				wasAuthenticated,
				ranLogin,
				authenticated: false,
			};
		}
	});
}

/**
 * Read-only auth status: report each provider's real credential state WITHOUT
 * attempting any login. This is the "just look" primitive —
 * ensureProvidersAuthenticated() instead starts an interactive login for
 * anything unauthenticated, so it can't be used to merely inspect state. A
 * pure check that never mutates anything is the correct thing to script
 * against, and the safe replacement for a hand-rolled `docker exec` credential
 * probe (whose fragility is exactly what a first-class command exists to
 * avoid). Reuses the same isXAuthenticated() functions the real walkthrough
 * trusts, so status and login can never disagree.
 *
 * `{live: true}` additionally asks each authenticated provider to answer a real
 * one-word request, which is the only thing that distinguishes a credential
 * from a working session. It is opt-in because it spends real quota, six
 * requests at a time, on a command people run casually — and stays read-only
 * either way. The plain form is honest about its limits rather than silently
 * cheap: it reports a credential, and a credential is not a session.
 * @param {Array<{name: string, isAuthenticated: () => boolean, isLive?: () => object}>} [providers]
 * @param {{live?: boolean}} [options]
 * @returns {Array<{name: string, authenticated: boolean, live?: boolean|null, reason?: string|null}>}
 */
export function reportProviderStatus(
	providers = PROVIDERS,
	{ live = false } = {},
) {
	return providers.map((provider) => {
		try {
			const state = inspectProvider(provider, live);
			// `live` stays absent unless a probe actually ran, so a caller can
			// never mistake "we did not look" for "we looked and it answered".
			return live
				? {
						name: provider.name,
						authenticated: state.authenticated,
						live: state.live,
						reason: state.reason,
					}
				: { name: provider.name, authenticated: state.authenticated };
		} catch (error) {
			// Same fail-soft contract as ensureProvidersAuthenticated: one
			// provider's check throwing must not abort the report for the rest,
			// and a check that can't complete is reported as not-authenticated,
			// never as a crash.
			console.error(
				`\n--- ${provider.name}: auth check threw, treating as not authenticated: ${error.message} ---\n`,
			);
			return { name: provider.name, authenticated: false };
		}
	});
}

/**
 * Print the read-only status report and set the exit code (1 if any provider
 * is unauthenticated — or, with `--live`, if any authenticated provider failed
 * to answer) — no login is ever attempted.
 * @param {boolean} [live] Probe each authenticated provider with a real request.
 */
function runCheck(live = false) {
	const statuses = reportProviderStatus(PROVIDERS, { live });
	console.log(
		live
			? "=== Auth status (read-only — no login attempted; each provider was sent one real request) ==="
			: "=== Auth status (read-only — credential presence only; add --live to probe) ===",
	);
	for (const status of statuses) {
		if (!status.authenticated) {
			console.log(`${status.name}: NOT AUTHENTICATED`);
			continue;
		}
		if (!live || status.live === null) {
			console.log(`${status.name}: authenticated`);
			continue;
		}
		console.log(
			status.live
				? `${status.name}: authenticated (live)`
				: `${status.name}: AUTHENTICATED BUT NOT LIVE — ${status.reason}`,
		);
	}
	process.exitCode = statuses.some(
		(status) => !status.authenticated || status.live === false,
	)
		? 1
		: 0;
}

function main(argv = process.argv.slice(2)) {
	try {
		ensureAgentContainer();
	} catch (error) {
		console.error(error.message);
		console.error(
			"The agent container must be built and running before auth can proceed.",
		);
		process.exitCode = 1;
		return;
	}

	// `--check`: read-only status, never a login. The default (no flag) is the
	// full walkthrough, which logs in anything unauthenticated. `--live` adds a
	// real request per authenticated provider; the walkthrough always probes,
	// because a wrong answer there costs an hour rather than a status line.
	if (argv.includes("--check")) {
		runCheck(argv.includes("--live"));
		return;
	}

	const results = ensureProvidersAuthenticated();
	console.log("\n=== Auth summary ===");
	for (const result of results) {
		const status = result.authenticated ? "authenticated" : "NOT AUTHENTICATED";
		const action = result.wasAuthenticated
			? "already authenticated"
			: result.ranLogin
				? "ran interactive login"
				: "auth check failed";
		console.log(`${result.name}: ${status} (${action})`);
	}
	process.exitCode = results.some((result) => !result.authenticated) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

export { PROVIDERS };
