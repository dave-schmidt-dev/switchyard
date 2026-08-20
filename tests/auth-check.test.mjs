import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	AGY_LOGIN_COMMAND,
	CLAUDE_LOGIN_HINT,
	COPILOT_LOGIN_COMMAND,
	ensureProvidersAuthenticated,
	PROVIDERS,
	reportProviderStatus,
	runCheck,
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

	it("uses agy's plain interactive login invocation", () => {
		deepStrictEqual(AGY_LOGIN_COMMAND, ["agy"]);
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

	it("defaults to the real six adapters when no providers are injected", () => {
		strictEqual(PROVIDERS.length, 6);
		deepStrictEqual(PROVIDERS.map((p) => p.name).sort(), [
			"agy",
			"claude",
			"codex",
			"copilot",
			"cursor",
			"opencode",
		]);
		for (const provider of PROVIDERS) {
			if (provider.authMode === "ephemeral_api_key_dispatch") continue;
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

// ---------------------------------------------------------------------------
// Liveness. Presence answers "is there a credential"; these cover the gap
// between that and "does this session work" — the gap that let `npm run auth`
// report success six times while every dispatch to claude failed auth_expired.
// ---------------------------------------------------------------------------

function liveProvider(name, { authenticated, live, kind = null }) {
	let runLoginCalls = 0;
	let liveCalls = 0;
	return {
		name,
		isAuthenticated: () => authenticated,
		isLive: () => {
			liveCalls += 1;
			return { live, reason: live ? null : "provider did not answer", kind };
		},
		runLogin: () => {
			runLoginCalls += 1;
		},
		getRunLoginCalls: () => runLoginCalls,
		getLiveCalls: () => liveCalls,
	};
}

describe("liveness gating", () => {
	it("regression: runs the login for a provider whose credential is present but dead", () => {
		// The defect this closes. An expired OAuth session leaves the credential
		// file exactly where it was, so presence kept answering "already
		// authenticated" and the walkthrough skipped the one provider that needed
		// it — a presence check does not merely fail to detect the failure, it
		// also gates the repair.
		const stale = liveProvider("stale", { authenticated: true, live: false });

		const results = ensureProvidersAuthenticated([stale]);

		strictEqual(
			stale.getRunLoginCalls(),
			1,
			"a dead session must trigger the login",
		);
		strictEqual(results[0].wasAuthenticated, false);
	});

	it("does not probe a provider with no credential at all", () => {
		// The probe spends real quota. A missing credential already answers the
		// question, so there is nothing to buy by asking the provider.
		const missing = liveProvider("missing", {
			authenticated: false,
			live: false,
		});

		ensureProvidersAuthenticated([missing]);

		strictEqual(missing.getLiveCalls(), 0);
		strictEqual(missing.getRunLoginCalls(), 1);
	});

	it("skips the login when the provider is authenticated but out of quota", () => {
		// A login cannot fix a quota, and sending a human through an OAuth flow
		// to try is the same wrong-direction lie in reverse.
		const throttled = liveProvider("throttled", {
			authenticated: true,
			live: false,
			kind: "quota_exhausted",
		});

		const results = ensureProvidersAuthenticated([throttled]);

		strictEqual(throttled.getRunLoginCalls(), 0);
		strictEqual(results[0].authenticated, true);
		strictEqual(results[0].wasAuthenticated, true);
	});

	// The same argument as the quota case above, for the kind added when
	// describeExecError() learned to classify an unresolvable model. `kind` is
	// forwarded from that classifier verbatim rather than being an enum of its
	// own, so every new kind lands here and has to be answered: is this
	// something a login fixes? A model the CLI cannot resolve is not.
	it("skips the login when the probe's own model is what is unavailable", () => {
		const logs = [];
		const originalLog = console.log;
		console.log = (message) => logs.push(message);
		const blocked = liveProvider("catalog-gap", {
			authenticated: true,
			live: false,
			kind: "model_unavailable",
		});

		try {
			const results = ensureProvidersAuthenticated([blocked]);

			strictEqual(blocked.getRunLoginCalls(), 0);
			strictEqual(results[0].authenticated, true);
			strictEqual(results[0].wasAuthenticated, true);
			// Reporting it as plain "authenticated" would read as success and
			// hide the actual blocker, so the human is told which one it is.
			ok(
				logs.some((line) => line.includes("cannot resolve the probe's model")),
				`expected the model_unavailable clause, got ${JSON.stringify(logs)}`,
			);
		} finally {
			console.log = originalLog;
		}
	});

	it("re-checks liveness after a login, not just presence", () => {
		// A login that "succeeded" and left an unusable session is exactly the
		// state this walkthrough used to report as fixed.
		let live = false;
		const provider = {
			name: "half-fixed",
			isAuthenticated: () => true,
			isLive: () => ({ live, reason: live ? null : "still dead", kind: null }),
			runLogin: () => {},
		};

		const [failed] = ensureProvidersAuthenticated([provider]);
		strictEqual(
			failed.authenticated,
			false,
			"a login that did not restore the session is not success",
		);

		live = true;
		const [fixed] = ensureProvidersAuthenticated([provider]);
		strictEqual(fixed.authenticated, true);
	});

	it("keeps the read-only report free of live probes unless asked", () => {
		const provider = liveProvider("quiet", {
			authenticated: true,
			live: false,
		});

		deepStrictEqual(reportProviderStatus([provider]), [
			{ name: "quiet", authenticated: true },
		]);
		strictEqual(
			provider.getLiveCalls(),
			0,
			"--check must stay cheap by default",
		);
		strictEqual(provider.getRunLoginCalls(), 0);
	});

	it("distinguishes authenticated-but-dead from authenticated when probing", () => {
		const dead = liveProvider("dead", { authenticated: true, live: false });
		const alive = liveProvider("alive", { authenticated: true, live: true });
		const absent = liveProvider("absent", {
			authenticated: false,
			live: false,
		});

		const results = reportProviderStatus([dead, alive, absent], { live: true });

		deepStrictEqual(results, [
			{
				name: "dead",
				authenticated: true,
				live: false,
				reason: "provider did not answer",
			},
			{ name: "alive", authenticated: true, live: true, reason: null },
			// `live: null` — not `false`. "We did not look" and "we looked and it
			// did not answer" must not collapse into the same word.
			{ name: "absent", authenticated: false, live: null, reason: null },
		]);
		strictEqual(
			dead.getRunLoginCalls(),
			0,
			"the report must never log in, even probing",
		);
		strictEqual(absent.getLiveCalls(), 0);
	});

	it("every real provider carries a liveness probe", () => {
		for (const provider of PROVIDERS) {
			if (provider.authMode === "ephemeral_api_key_dispatch") continue;
			strictEqual(
				typeof provider.isLive,
				"function",
				`${provider.name} must be probeable`,
			);
		}
	});

	it("fails closed when live mode has an unprobed BWS lane", () => {
		const output = [];
		const originalLog = console.log;
		const originalExitCode = process.exitCode;
		console.log = (...args) => output.push(args.join(" "));
		process.exitCode = undefined;
		const backend = {
			goldenImage: "golden",
			aquaUid: "501",
			bootGoldenImage: () => ({ uuid: "workspace" }),
			stopGoldenImage: () => {},
		};
		try {
			runCheck(backend, true, [
				{
					name: "opencode",
					authMode: "ephemeral_api_key_dispatch",
				},
			]);
			strictEqual(process.exitCode, 1);
			ok(
				output.some((line) => line.includes("BWS lanes remain unprobed")),
				`live header must disclose unprobed BWS lanes: ${JSON.stringify(output)}`,
			);
			ok(
				output.some((line) => line.includes("live status unprobed")),
				`BWS status must be explicit: ${JSON.stringify(output)}`,
			);
			ok(
				!output.some((line) =>
					line.includes("each provider was sent one real request"),
				),
				"live header must not claim every provider was probed",
			);
		} finally {
			console.log = originalLog;
			process.exitCode = originalExitCode;
		}
	});
});
