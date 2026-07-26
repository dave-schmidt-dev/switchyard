import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	ensureProvidersAuthenticated,
	PROVIDERS,
	reportProviderStatus,
} from "../src/switchyard/auth/index.mjs";

function fakeProvider(name, { authenticatedSequence }) {
	let call = 0;
	let runLoginCalls = 0;
	return {
		name,
		isAuthenticated: () => {
			const result =
				authenticatedSequence[Math.min(call, authenticatedSequence.length - 1)];
			call += 1;
			return result;
		},
		runLogin: () => {
			runLoginCalls += 1;
		},
		getRunLoginCalls: () => runLoginCalls,
	};
}

describe("ensureProvidersAuthenticated", () => {
	it("skips runLogin() for providers already authenticated", () => {
		const provider = fakeProvider("already-ok", {
			authenticatedSequence: [true],
		});
		const results = ensureProvidersAuthenticated([provider]);

		deepStrictEqual(results, [
			{
				name: "already-ok",
				wasAuthenticated: true,
				ranLogin: false,
				authenticated: true,
			},
		]);
		strictEqual(provider.getRunLoginCalls(), 0);
	});

	it("runs runLogin() for a provider that isn't authenticated yet, then re-checks", () => {
		const provider = fakeProvider("needs-auth", {
			authenticatedSequence: [false, true],
		});
		const results = ensureProvidersAuthenticated([provider]);

		deepStrictEqual(results, [
			{
				name: "needs-auth",
				wasAuthenticated: false,
				ranLogin: true,
				authenticated: true,
			},
		]);
		strictEqual(provider.getRunLoginCalls(), 1);
	});

	it("reports a still-failed login without throwing", () => {
		const provider = fakeProvider("broken", {
			authenticatedSequence: [false, false],
		});
		const results = ensureProvidersAuthenticated([provider]);

		deepStrictEqual(results, [
			{
				name: "broken",
				wasAuthenticated: false,
				ranLogin: true,
				authenticated: false,
			},
		]);
	});

	it("processes every provider even when an earlier one fails to authenticate", () => {
		const broken = fakeProvider("broken", {
			authenticatedSequence: [false, false],
		});
		const healthy = fakeProvider("healthy", {
			authenticatedSequence: [false, true],
		});
		const results = ensureProvidersAuthenticated([broken, healthy]);

		strictEqual(results.length, 2);
		strictEqual(results[0].authenticated, false);
		strictEqual(results[1].authenticated, true);
		strictEqual(healthy.getRunLoginCalls(), 1);
	});

	it("regression: processes every remaining provider even when an earlier one's runLogin() throws", () => {
		// Before the fix, ensureProvidersAuthenticated()'s Array#map callback
		// had no try/catch, so a throwing runLogin() propagated straight out
		// of map(), aborting iteration entirely — every later provider was
		// silently never checked or logged in, and the exception surfaced
		// uncaught all the way through main(). This directly violates the
		// "processes every provider even when an earlier one fails" contract
		// the test above already establishes, just via throw instead of a
		// still-failed re-check.
		const throwing = {
			name: "throwing",
			isAuthenticated: () => false,
			runLogin: () => {
				throw new Error("boom: login crashed");
			},
		};
		const healthy = fakeProvider("healthy", {
			authenticatedSequence: [false, true],
		});

		const results = ensureProvidersAuthenticated([throwing, healthy]);

		strictEqual(
			results.length,
			2,
			"a throwing provider must not stop the remaining providers from being processed",
		);
		strictEqual(results[0].name, "throwing");
		strictEqual(results[0].authenticated, false);
		strictEqual(results[1].name, "healthy");
		strictEqual(results[1].authenticated, true);
		strictEqual(
			healthy.getRunLoginCalls(),
			1,
			"the healthy provider after the throwing one must still get its login run",
		);
	});

	it("regression: reports authenticated:false when isAuthenticated() itself throws, without aborting later providers", () => {
		// Same failure mode, but from the initial ground-truth check rather
		// than runLogin() — every real isXAuthenticated() has its own
		// try/catch today, but this function's contract covers any injected
		// provider, not just the four real adapters.
		const throwing = {
			name: "throwing-check",
			isAuthenticated: () => {
				throw new Error("boom: docker exec failed unexpectedly");
			},
			runLogin: () => {},
		};
		const healthy = fakeProvider("healthy", {
			authenticatedSequence: [true],
		});

		const results = ensureProvidersAuthenticated([throwing, healthy]);

		strictEqual(results.length, 2);
		strictEqual(results[0].authenticated, false);
		strictEqual(results[0].wasAuthenticated, false);
		strictEqual(results[1].authenticated, true);
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
			strictEqual(typeof provider.runLogin, "function");
		}
	});
});

describe("reportProviderStatus (read-only auth check)", () => {
	it("reports each provider's authenticated state without ever attempting a login", () => {
		// The whole point of the read-only check: it must NEVER call runLogin,
		// even for an unauthenticated provider. This is the property the fragile
		// ad-hoc `docker exec` probe was reaching for — reuse the real check,
		// mutate nothing.
		const authed = fakeProvider("authed", { authenticatedSequence: [true] });
		const unauthed = fakeProvider("unauthed", {
			authenticatedSequence: [false],
		});

		const results = reportProviderStatus([authed, unauthed]);

		deepStrictEqual(results, [
			{ name: "authed", authenticated: true },
			{ name: "unauthed", authenticated: false },
		]);
		strictEqual(authed.getRunLoginCalls(), 0);
		strictEqual(
			unauthed.getRunLoginCalls(),
			0,
			"an unauthenticated provider must NOT trigger a login in read-only mode",
		);
	});

	it("checks each provider exactly once (no re-check, since it never logs in)", () => {
		// ensureProvidersAuthenticated calls isAuthenticated twice for an
		// unauthed provider (before + after login). The read-only report has no
		// login step, so it must check exactly once and take the first answer.
		// A second call to isAuthenticated would advance the sequence; assert the
		// report used only the first element by re-running against a divergent
		// sequence and checking the reported value is the first, not the second.
		const flip = fakeProvider("flip", { authenticatedSequence: [false, true] });
		const [result] = reportProviderStatus([flip]);
		strictEqual(
			result.authenticated,
			false,
			"read-only report must take the first isAuthenticated() answer, never re-check",
		);
	});

	it("reports authenticated:false when a provider's check throws, without aborting later providers", () => {
		// Same fail-soft contract as ensureProvidersAuthenticated: one throwing
		// check can't take down the whole report.
		const throwing = {
			name: "throwing",
			isAuthenticated: () => {
				throw new Error("boom: docker exec failed");
			},
		};
		const healthy = fakeProvider("healthy", { authenticatedSequence: [true] });

		const results = reportProviderStatus([throwing, healthy]);

		deepStrictEqual(results, [
			{ name: "throwing", authenticated: false },
			{ name: "healthy", authenticated: true },
		]);
	});
});
