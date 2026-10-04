import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	authWalkthroughExitCode,
	ensureProvidersAuthenticated,
	PROVIDERS,
	reportProviderStatus,
	runCheck,
} from "../src/switchyard/auth/index.mjs";

const AUTH_TEST_RUN_STORE_ROOT = join(
	tmpdir(),
	`switchyard-auth-run-store-${process.pid}-${randomUUID()}`,
);
process.env.SWITCHYARD_RUN_STORE_ROOT = AUTH_TEST_RUN_STORE_ROOT;

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
	it("preserves an unclassified liveness failure without a runnable login as inconclusive", () => {
		const unresolved = {
			name: "unresolved",
			isAuthenticated: () => true,
			isLive: () => ({
				live: false,
				reason: "probe transport failed",
				kind: null,
			}),
			loginUnavailable: {
				reason: "no supported login command",
				remediation: "sign in from the provider console",
			},
		};

		const [result] = ensureProvidersAuthenticated([unresolved]);

		deepStrictEqual(result, {
			name: "unresolved",
			ranLogin: false,
			inconclusive: true,
			loginUnavailable: "no supported login command",
		});
		strictEqual("authenticated" in result, false);
		strictEqual("wasAuthenticated" in result, false);
		strictEqual(authWalkthroughExitCode([result]), 2);
	});

	it("keeps exit 1 for known failures when inconclusive results also exist", () => {
		strictEqual(
			authWalkthroughExitCode([
				{ inconclusive: true },
				{ authenticated: false },
			]),
			1,
		);
		strictEqual(authWalkthroughExitCode([{ authenticated: true }]), 0);
	});

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
			isLive: () => ({
				live,
				reason: live ? null : "still dead",
				kind: live ? null : "auth_expired",
			}),
			runLogin: () => {},
		};

		const [failed] = ensureProvidersAuthenticated([provider]);
		strictEqual(
			failed.authenticated,
			false,
			"a login that did not restore the session is not success",
		);
		strictEqual(
			failed.ranLogin,
			true,
			"an expired session with a runnable login must attempt that login",
		);
		strictEqual(authWalkthroughExitCode([failed]), 1);

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
			// Required, not optional: withBootedGoldenImage treats a posture
			// check it cannot run as a failure, so a backend that omits this
			// fails rather than silently skipping the assertion.
			describePostureViolations: () => [],
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
