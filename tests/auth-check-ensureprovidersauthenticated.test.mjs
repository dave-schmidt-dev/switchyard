import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	AGY_LOGIN_UNAVAILABLE,
	CLAUDE_LOGIN_HINT,
	COPILOT_LOGIN_COMMAND,
	ensureProvidersAuthenticated,
	PROVIDERS,
	reportProviderStatus,
} from "../src/switchyard/auth/index.mjs";

const TEST_BOOT_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function fixtureHostProbe(pid) {
	const startTicks = String(pid * 10 + 1);
	return {
		state: "present",
		pid,
		bootSessionUuid: TEST_BOOT_UUID,
		startTicks,
		identity: `switchyard-host-process-v1:${TEST_BOOT_UUID}:${pid}:${startTicks}`,
	};
}

const AUTH_TEST_RUN_STORE_ROOT = join(
	tmpdir(),
	`switchyard-auth-run-store-${process.pid}-${randomUUID()}`,
);
process.env.SWITCHYARD_RUN_STORE_ROOT = AUTH_TEST_RUN_STORE_ROOT;

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
	it("skips interactive OAuth for BWS-backed API-key dispatch", () => {
		let checked = 0;
		let loggedIn = 0;
		const [result] = ensureProvidersAuthenticated([
			{
				name: "opencode",
				authMode: "ephemeral_api_key_dispatch",
				isAuthenticated: () => {
					checked += 1;
					return false;
				},
				runLogin: () => {
					loggedIn += 1;
				},
			},
		]);
		deepStrictEqual(result, {
			name: "opencode",
			wasAuthenticated: true,
			ranLogin: false,
			authenticated: true,
		});
		strictEqual(checked, 0);
		strictEqual(loggedIn, 0);
	});

	// Task 44. The bare `agy` invocation this used to assert opened a
	// full-screen TUI inside the guest over `prlctl exec`, which never
	// prompted and never returned, so the walkthrough hung here and never
	// reached cursor, copilot or vibe.
	it("declares agy's login unavailable instead of running one that cannot finish", () => {
		const agy = PROVIDERS.find((provider) => provider.name === "agy");
		strictEqual(typeof agy.runLogin, "undefined");
		strictEqual(agy.loginUnavailable, AGY_LOGIN_UNAVAILABLE);
		ok(AGY_LOGIN_UNAVAILABLE.reason.length > 0);
		ok(AGY_LOGIN_UNAVAILABLE.remediation.length > 0);
	});

	it("reports a provider whose login is unavailable and keeps walking the rest", () => {
		const logs = [];
		const originalLog = console.log;
		console.log = (line) => logs.push(String(line));
		let laterProviderChecked = 0;
		let results;
		try {
			results = ensureProvidersAuthenticated([
				{
					name: "stuck",
					isAuthenticated: () => false,
					loginUnavailable: {
						reason: "no login subcommand exists",
						remediation: "sign in from the console once",
					},
				},
				{
					name: "after",
					isAuthenticated: () => {
						laterProviderChecked += 1;
						return true;
					},
				},
			]);
		} finally {
			console.log = originalLog;
		}
		deepStrictEqual(results[0], {
			name: "stuck",
			wasAuthenticated: false,
			ranLogin: false,
			authenticated: false,
			loginUnavailable: "no login subcommand exists",
		});
		strictEqual(results[1].authenticated, true);
		// The whole point: one provider with no runnable login must not cost
		// every provider ordered after it.
		strictEqual(laterProviderChecked, 1);
		const printed = logs.join("\n");
		match(printed, /no login can be run here \(no login subcommand exists\)/);
		match(printed, /sign in from the console once/);
	});

	it("uses the supported Copilot CLI login subcommand", () => {
		deepStrictEqual(COPILOT_LOGIN_COMMAND, [
			"copilot",
			"login",
			"--device-code",
		]);
	});

	it("prints the Claude browser-code hint before interactive login", () => {
		const output = [];
		const originalLog = console.log;
		console.log = (...args) => output.push(args.join(" "));
		try {
			ensureProvidersAuthenticated([
				{
					name: "claude",
					loginHint: CLAUDE_LOGIN_HINT,
					isAuthenticated: (() => {
						let calls = 0;
						return () => calls++ > 0;
					})(),
					runLogin: () => {},
				},
			]);
		} finally {
			console.log = originalLog;
		}
		ok(
			output.some((line) => line.includes(CLAUDE_LOGIN_HINT)),
			"Claude's login hint must be shown before the login command",
		);
	});

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

	it("defaults to every real provider when none are injected", () => {
		strictEqual(PROVIDERS.length, 7);
		deepStrictEqual(PROVIDERS.map((p) => p.name).sort(), [
			"agy",
			"claude",
			"codex",
			"copilot",
			"cursor",
			"opencode",
			"vibe",
		]);
		for (const provider of PROVIDERS) {
			if (provider.authMode === "ephemeral_api_key_dispatch") continue;
			strictEqual(typeof provider.isAuthenticated, "function");
			// Every provider offers exactly one of the two: a login to run, or
			// a named reason there is none. Neither would leave the walkthrough
			// with nothing to say about a provider it cannot authenticate.
			strictEqual(
				(typeof provider.runLogin === "function") !==
					(typeof provider.loginUnavailable?.reason === "string"),
				true,
				`${provider.name} must declare exactly one of runLogin and loginUnavailable`,
			);
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

	it("marks ephemeral BWS dispatch as unprobed in live mode", () => {
		deepStrictEqual(
			reportProviderStatus(
				[
					{
						name: "opencode",
						authMode: "ephemeral_api_key_dispatch",
					},
				],
				{ live: true },
			),
			[
				{
					name: "opencode",
					authenticated: true,
					live: null,
					reason: null,
					authMode: "ephemeral_api_key_dispatch",
				},
			],
		);
	});
});
