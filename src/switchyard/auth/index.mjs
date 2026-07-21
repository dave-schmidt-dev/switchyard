// Auth module - checks every provider adapter's auth status and runs its
// headless login flow for any that aren't yet authenticated.
// PW-4: Independent in-container login, ensured per provider.

import { authenticateAgy, isAgyAuthenticated } from "../adapter/agy.mjs";
import {
	authenticateClaude,
	isClaudeAuthenticated,
} from "../adapter/claude.mjs";
import { authenticateCodex, isCodexAuthenticated } from "../adapter/codex.mjs";
import {
	authenticateCursor,
	isCursorAuthenticated,
} from "../adapter/cursor.mjs";

const PROVIDERS = [
	{
		name: "claude",
		isAuthenticated: isClaudeAuthenticated,
		authenticate: authenticateClaude,
	},
	{
		name: "codex",
		isAuthenticated: isCodexAuthenticated,
		authenticate: authenticateCodex,
	},
	{
		name: "agy",
		isAuthenticated: isAgyAuthenticated,
		authenticate: authenticateAgy,
	},
	{
		name: "cursor",
		isAuthenticated: isCursorAuthenticated,
		authenticate: authenticateCursor,
	},
];

/**
 * Check every provider adapter's auth status and run its headless auth flow
 * for any that aren't yet authenticated. Attempts every provider regardless
 * of an earlier one's outcome — one broken/unauthenticated provider must not
 * block checking or authenticating the others.
 * @param {Array<{name: string, isAuthenticated: () => boolean, authenticate: () => boolean}>} [providers]
 * @returns {Array<{name: string, wasAuthenticated: boolean, ranAuth: boolean, authenticated: boolean}>}
 */
export function ensureProvidersAuthenticated(providers = PROVIDERS) {
	return providers.map((provider) => {
		const wasAuthenticated = provider.isAuthenticated();
		if (wasAuthenticated) {
			return {
				name: provider.name,
				wasAuthenticated: true,
				ranAuth: false,
				authenticated: true,
			};
		}
		const authenticated = provider.authenticate();
		return {
			name: provider.name,
			wasAuthenticated: false,
			ranAuth: true,
			authenticated,
		};
	});
}

function main() {
	const results = ensureProvidersAuthenticated();
	for (const result of results) {
		const status = result.authenticated ? "authenticated" : "FAILED";
		const action = result.wasAuthenticated
			? "already authenticated"
			: "ran headless auth";
		console.log(`${result.name}: ${status} (${action})`);
	}
	process.exitCode = results.some((result) => !result.authenticated) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

export { PROVIDERS };
