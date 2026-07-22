// Auth walkthrough - checks every provider's real credential state and, for
// any that aren't authenticated, runs its real interactive OAuth login
// inside the standing agent container so a human can complete it live.
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
import { isCursorAuthenticated } from "../adapter/cursor.mjs";
import { AGENT_CONTAINER_NAME } from "../container/index.mjs";
import { ensureAgentContainer } from "../runner/index.mjs";

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

const PROVIDERS = [
	{
		name: "claude",
		isAuthenticated: isClaudeAuthenticated,
		runLogin: () => runInteractiveLogin(["claude", "auth", "login"]),
	},
	{
		name: "codex",
		// --device-auth: a device-code flow, needs no local browser inside
		// the container.
		isAuthenticated: isCodexAuthenticated,
		runLogin: () => runInteractiveLogin(["codex", "login", "--device-auth"]),
	},
	{
		name: "agy",
		// agy has no explicit login subcommand — running it unauthenticated
		// auto-triggers a real Google OAuth flow (prints a URL, then waits for
		// a pasted authorization code). Confirmed empirically: a plain
		// `agy --print "hi"` triggers it with no other side effect.
		isAuthenticated: isAgyAuthenticated,
		runLogin: () => runInteractiveLogin(["agy", "--print", "hi"]),
	},
	{
		name: "cursor",
		// NO_OPEN_BROWSER=1: the CLI's own documented override to avoid trying
		// to launch a GUI browser inside a headless container.
		isAuthenticated: isCursorAuthenticated,
		runLogin: () =>
			runInteractiveLogin(["cursor-agent", "login"], {
				NO_OPEN_BROWSER: "1",
			}),
	},
];

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
			wasAuthenticated = provider.isAuthenticated();
			if (wasAuthenticated) {
				return {
					name: provider.name,
					wasAuthenticated: true,
					ranLogin: false,
					authenticated: true,
				};
			}
			console.log(
				`\n--- ${provider.name}: not authenticated — starting interactive login, follow the prompts ---\n`,
			);
			ranLogin = true;
			provider.runLogin();
			const authenticated = provider.isAuthenticated();
			return {
				name: provider.name,
				wasAuthenticated: false,
				ranLogin: true,
				authenticated,
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

function main() {
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
