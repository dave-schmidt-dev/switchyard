import { isAgyAuthenticated } from "../adapter/agy.mjs";
import { isClaudeAuthenticated } from "../adapter/claude.mjs";
import { isCodexAuthenticated } from "../adapter/codex.mjs";
import { isCopilotAuthenticated } from "../adapter/copilot.mjs";
import { isCursorAuthenticated } from "../adapter/cursor.mjs";
import { isVibeAuthenticated } from "../adapter/vibe.mjs";
import { probeLiveness } from "./liveness.mjs";
import { runInteractiveLogin, WALKTHROUGH_INTERRUPTED } from "./sessions.mjs";
export const COPILOT_LOGIN_COMMAND = Object.freeze([
	"copilot",
	"login",
	"--device-code",
]);
export const AGY_LOGIN_UNAVAILABLE = Object.freeze({
	reason:
		"agy has no login subcommand and its Keychain credential needs a GUI session",
	remediation:
		"open the golden image in the Parallels window, sign in to agy there once, then re-run this walkthrough",
});
export const CLAUDE_LOGIN_HINT =
	"Claude login: when the browser shows an Authentication code, copy/paste that code back into this terminal; browser authorization alone does not complete VM login.";
const PROVIDERS = [
	{
		name: "claude",
		isAuthenticated: isClaudeAuthenticated,
		isLive: (workspaceId, executionBackend) =>
			probeLiveness("claude", { workspaceId, executionBackend }),
		loginHint: CLAUDE_LOGIN_HINT,
		runLogin: (workspaceId, executionBackend) =>
			runInteractiveLogin(["claude", "auth", "login"], {
				workspaceId,
				executionBackend,
			}),
	},
	{
		name: "codex",
		// --device-auth: a device-code flow, needs no local browser inside
		// the guest.
		isAuthenticated: isCodexAuthenticated,
		isLive: (workspaceId, executionBackend) =>
			probeLiveness("codex", { workspaceId, executionBackend }),
		runLogin: (workspaceId, executionBackend) =>
			runInteractiveLogin(["codex", "login", "--device-auth"], {
				workspaceId,
				executionBackend,
			}),
	},
	{
		name: "agy",
		isAuthenticated: isAgyAuthenticated,
		isLive: (workspaceId, executionBackend) =>
			probeLiveness("agy", { workspaceId, executionBackend }),
		// No runLogin: see AGY_LOGIN_UNAVAILABLE. Reported and stepped over
		// rather than attempted, so the providers after it still get their turn.
		loginUnavailable: AGY_LOGIN_UNAVAILABLE,
	},
	{
		name: "cursor",
		// NO_OPEN_BROWSER=1: the CLI's own documented override to avoid trying
		// to launch a GUI browser inside a headless guest.
		isAuthenticated: isCursorAuthenticated,
		isLive: (workspaceId, executionBackend) =>
			probeLiveness("cursor", { workspaceId, executionBackend }),
		runLogin: (workspaceId, executionBackend) =>
			runInteractiveLogin(["cursor-agent", "login"], {
				workspaceId,
				executionBackend,
				env: { NO_OPEN_BROWSER: "1" },
			}),
	},
	{
		name: "copilot",
		isAuthenticated: isCopilotAuthenticated,
		isLive: (workspaceId, executionBackend) =>
			probeLiveness("copilot", { workspaceId, executionBackend }),
		runLogin: (workspaceId, executionBackend) =>
			runInteractiveLogin(COPILOT_LOGIN_COMMAND, {
				workspaceId,
				executionBackend,
			}),
	},
	{
		name: "opencode",
		// The active OpenCode targets are Go and Mistral API-key lanes. Their
		// fixed BWS consumers inject keys only into a disposable dispatch, so an
		// OAuth login would create irrelevant persistent auth.json state and can
		// not repair either lane. Qualification belongs to the dispatch bridge.
		authMode: "ephemeral_api_key_dispatch",
	},
	{
		name: "vibe",
		isAuthenticated: isVibeAuthenticated,
		isLive: (workspaceId, executionBackend) =>
			probeLiveness("vibe", { workspaceId, executionBackend }),
		runLogin: (workspaceId, executionBackend) =>
			runInteractiveLogin(["vibe", "--setup"], {
				workspaceId,
				executionBackend,
			}),
	},
];
const LOGIN_CANNOT_HELP = Object.freeze({
	quota_exhausted: "the provider reports quota exhausted",
	model_unavailable: "the provider CLI cannot resolve the probe's model",
});
function inspectProvider(provider, probe, workspaceId, executionBackend) {
	const authenticated = provider.isAuthenticated(workspaceId, executionBackend);
	if (!authenticated || !probe || typeof provider.isLive !== "function") {
		return { authenticated, live: null, reason: null, kind: null };
	}
	const result = provider.isLive(workspaceId, executionBackend);
	return {
		authenticated,
		live: result.live === true,
		reason: result.reason ?? null,
		kind: result.kind ?? null,
	};
}
export function ensureProvidersAuthenticated(
	providers = PROVIDERS,
	{ workspaceId, executionBackend } = {},
) {
	return providers.map((provider) => {
		let wasAuthenticated = false;
		let ranLogin = false;
		try {
			if (provider.authMode === "ephemeral_api_key_dispatch") {
				console.log(
					`\n--- ${provider.name}: API-key dispatch is BWS-backed; skipping interactive OAuth ---\n`,
				);
				return {
					name: provider.name,
					wasAuthenticated: true,
					ranLogin: false,
					authenticated: true,
				};
			}
			const state = inspectProvider(
				provider,
				true,
				workspaceId,
				executionBackend,
			);
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
			// A present credential with a failed probe that has no classification
			// is neither a known auth failure nor proof that the provider is dead.
			// If this provider has no runnable login, preserve that uncertainty for
			// the caller instead of collapsing it into "not authenticated".
			if (
				provider.loginUnavailable &&
				state.authenticated &&
				state.live === false &&
				state.kind === null
			) {
				console.log(
					`\n--- ${provider.name}: INCONCLUSIVE — credential present, but the provider did not answer (${state.reason}); no login can be run here (${provider.loginUnavailable.reason}) ---\n`,
				);
				console.log(
					`\n--- ${provider.name}: to resolve it, ${provider.loginUnavailable.remediation} ---\n`,
				);
				return {
					name: provider.name,
					ranLogin: false,
					inconclusive: true,
					loginUnavailable: provider.loginUnavailable.reason,
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
			// A provider with no login to run is reported and stepped over. The
			// alternative is what agy did: hand the terminal to a command that
			// never returns, which costs not just this provider but every one
			// ordered after it. Reported as unauthenticated, because it is —
			// this is a named dead end, not a pass.
			if (provider.loginUnavailable) {
				console.log(
					`\n--- ${provider.name}: ${state.authenticated ? `credential present but the provider did not answer (${state.reason})` : "not authenticated"}, and no login can be run here (${provider.loginUnavailable.reason}) ---\n`,
				);
				console.log(
					`\n--- ${provider.name}: to fix it, ${provider.loginUnavailable.remediation} ---\n`,
				);
				return {
					name: provider.name,
					wasAuthenticated: false,
					ranLogin: false,
					authenticated: false,
					loginUnavailable: provider.loginUnavailable.reason,
				};
			}
			console.log(
				state.authenticated
					? `\n--- ${provider.name}: credential present but the provider did not answer (${state.reason}) — starting interactive login, follow the prompts ---\n`
					: `\n--- ${provider.name}: not authenticated — starting interactive login, follow the prompts ---\n`,
			);
			if (provider.loginHint) {
				console.log(`\n--- ${provider.loginHint} ---\n`);
			}
			ranLogin = true;
			provider.runLogin(workspaceId, executionBackend);
			// Re-check the same way, not the cheap way: a login that "succeeded"
			// and left an unusable session is the exact state this walkthrough was
			// reporting as fixed.
			const after = inspectProvider(
				provider,
				true,
				workspaceId,
				executionBackend,
			);
			return {
				name: provider.name,
				wasAuthenticated: false,
				ranLogin: true,
				authenticated: after.authenticated && after.live !== false,
			};
		} catch (error) {
			// The one exception to the "keep walking" contract below: an operator
			// who interrupted this provider's login wants out of the walkthrough,
			// not a prompt for the next provider. Rethrown out of the map so
			// withBootedGoldenImage stops the guest and main() reports 128+signo.
			if (error?.code === WALKTHROUGH_INTERRUPTED) throw error;
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
export function authWalkthroughExitCode(results) {
	if (results.some((result) => result.authenticated === false)) return 1;
	return results.some((result) => result.inconclusive === true) ? 2 : 0;
}
export { inspectProvider, PROVIDERS };
