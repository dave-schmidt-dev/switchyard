import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	ensureProvidersAuthenticated,
	PROVIDERS,
} from "../src/switchyard/auth/index.mjs";

function fakeProvider(name, { authenticated, authenticateResult }) {
	let authenticateCalls = 0;
	return {
		name,
		isAuthenticated: () => authenticated,
		authenticate: () => {
			authenticateCalls += 1;
			return authenticateResult;
		},
		getAuthenticateCalls: () => authenticateCalls,
	};
}

describe("ensureProvidersAuthenticated", () => {
	it("skips authenticate() for providers already authenticated", () => {
		const provider = fakeProvider("already-ok", { authenticated: true });
		const results = ensureProvidersAuthenticated([provider]);

		deepStrictEqual(results, [
			{
				name: "already-ok",
				wasAuthenticated: true,
				ranAuth: false,
				authenticated: true,
			},
		]);
		strictEqual(provider.getAuthenticateCalls(), 0);
	});

	it("runs authenticate() for a provider that isn't authenticated yet", () => {
		const provider = fakeProvider("needs-auth", {
			authenticated: false,
			authenticateResult: true,
		});
		const results = ensureProvidersAuthenticated([provider]);

		deepStrictEqual(results, [
			{
				name: "needs-auth",
				wasAuthenticated: false,
				ranAuth: true,
				authenticated: true,
			},
		]);
		strictEqual(provider.getAuthenticateCalls(), 1);
	});

	it("reports a failed headless auth without throwing", () => {
		const provider = fakeProvider("broken", {
			authenticated: false,
			authenticateResult: false,
		});
		const results = ensureProvidersAuthenticated([provider]);

		deepStrictEqual(results, [
			{
				name: "broken",
				wasAuthenticated: false,
				ranAuth: true,
				authenticated: false,
			},
		]);
	});

	it("processes every provider even when an earlier one fails to authenticate", () => {
		const broken = fakeProvider("broken", {
			authenticated: false,
			authenticateResult: false,
		});
		const healthy = fakeProvider("healthy", {
			authenticated: false,
			authenticateResult: true,
		});
		const results = ensureProvidersAuthenticated([broken, healthy]);

		strictEqual(results.length, 2);
		strictEqual(results[0].authenticated, false);
		strictEqual(results[1].authenticated, true);
		strictEqual(healthy.getAuthenticateCalls(), 1);
	});

	it("defaults to the real four adapters when no providers are injected", () => {
		strictEqual(PROVIDERS.length, 4);
		deepStrictEqual(PROVIDERS.map((p) => p.name).sort(), [
			"agy",
			"claude",
			"codex",
			"cursor",
		]);
		for (const provider of PROVIDERS) {
			strictEqual(typeof provider.isAuthenticated, "function");
			strictEqual(typeof provider.authenticate, "function");
		}
	});
});
