// Auth walkthrough - checks every provider's real credential state and, for
// any that aren't authenticated, runs its real interactive OAuth login
// directly inside the booted golden image so a human can complete it live.
//
//   npm run auth              full walkthrough: check, then log in anything unauthed
//   npm run auth:check        read-only status report — never attempts a login
//   npm run auth:check:live   the same report, plus one real request per
//                              probeable provider (BWS lanes are unprobed)
//   node src/switchyard/auth/index.mjs --clone [--receipt <path>]
//                             read-only clone qualification: creates one
//                             disposable linked clone, probes every OAuth
//                             provider inside it with presence + live check,
//                             reports BWS lanes as unprobed, emits progress to
//                             stderr, outputs a terminal summary to stdout,
//                             optionally persists a sanitized qualification receipt,
//                             and always destroys the clone.
//
// Every command above boots the golden image, does its work, and stops it
// again — there is no standing credential VM to attach to (see
// withBootedGoldenImage()). That makes even the plain `--check` report a real
// VM boot, not a free status line: isXAuthenticated() has to exec inside a
// running, Aqua-ready guest to read a credential file, the same as a real
// dispatch does. The golden image is also the one artifact every future
// clone is made from, so a login has to run against it directly — logging in
// inside a disposable clone would lose the credential the moment the clone is
// destroyed.
//
// Use --check (npm run auth:check) to just look. It reuses the same
// isXAuthenticated() checks as the walkthrough, so it can't disagree with what
// a real dispatch sees, and it never mutates auth state.
//
// Those checks answer "is there a credential", not "does this session work".
// The difference is not academic: on 2026-08-13 this command reported claude
// and opencode authenticated while every dispatch to them failed, and the
// walkthrough gated its login on the same check, so it skipped the repair too.
// Liveness (auth/liveness.mjs) closes that: the walkthrough always probes, and
// --check does on request. See that file for why each probe's invocation is
// empirical rather than read off a --help page.
// PW-4: Independent login, run directly against the golden image (subscription,
// never API keys).
// TASKS.md Task 24: there is no headless auto-login — every provider's real
// login step requires a human to complete a browser or device-code OAuth
// consent, so this walks the human through each one rather than attempting
// to drive it unattended. Replaces the earlier BWS-credential-injection
// design (`authenticateX()`/`buildAuthContainerScript()`, removed from all
// four adapters).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAgyAuthenticated } from "../adapter/agy.mjs";
import { isClaudeAuthenticated } from "../adapter/claude.mjs";
import { isCodexAuthenticated } from "../adapter/codex.mjs";
import { isCopilotAuthenticated } from "../adapter/copilot.mjs";
import { isCursorAuthenticated } from "../adapter/cursor.mjs";
import { ParallelsExecutionBackend } from "../lifecycle/parallels-execution-backend.mjs";
import { probeLiveness } from "./liveness.mjs";

/**
 * Build the same execution backend a real macOS-platform dispatch would use
 * (mirrors dispatch/index.mjs's executionBackendForRun), so auth never checks
 * or logs in against a different guest shape than a real run executes in.
 * @returns {ParallelsExecutionBackend}
 */
function createExecutionBackend() {
	return new ParallelsExecutionBackend({
		goldenImage: process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE,
		aquaUid: process.env.SWITCHYARD_PARALLELS_AQUA_UID,
		providerUser:
			process.env.SWITCHYARD_PARALLELS_PROVIDER_USER ?? "switchyard",
	});
}

/**
 * Boot the golden image, run `fn` against it, and always stop it again —
 * fails fast, before ever starting the VM, if the environment isn't
 * configured, rather than booting and then discovering `waitForAqua()` has
 * nothing to probe with. Left running, the golden image blocks the next real
 * dispatch: `assertGoldenImageAvailable()`/clone creation both require it.
 * @param {ParallelsExecutionBackend} executionBackend
 * @param {(workspaceId: string) => any} fn
 */
export function withBootedGoldenImage(executionBackend, fn) {
	if (!executionBackend.goldenImage) {
		throw new Error(
			"SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set to check or run provider auth",
		);
	}
	if (!/^\d+$/.test(String(executionBackend.aquaUid ?? ""))) {
		throw new Error(
			"SWITCHYARD_PARALLELS_AQUA_UID must be set to check or run provider auth",
		);
	}
	// Propagates as-is (e.g. assertGoldenImageAvailable()'s "owned clones
	// exist" refusal) — nothing was started, so there is nothing to stop.
	const booted = executionBackend.bootGoldenImage();
	let bodyError = null;
	let result;
	try {
		result = fn(booted.uuid);
	} catch (error) {
		bodyError = error;
	}

	// Re-assert the posture the build certifies, while the guest is still
	// running and can be read. The golden is the one VM that is not
	// disposable: anything this body left behind survives into every clone
	// taken afterwards, and nothing on this path used to notice. Report only —
	// a repair here would hide the fact that something mutated the image.
	let postureError = null;
	try {
		const violations = executionBackend.describePostureViolations(booted.uuid, {
			aquaUid: executionBackend.aquaUid,
		});
		if (violations.length > 0) {
			postureError = new Error(
				`golden image ${executionBackend.goldenImage} violated its posture on exit: ${violations.join("; ")}`,
			);
		}
	} catch (error) {
		// A check that could not run proves nothing. Treating that as a clean
		// posture is the same false green the check exists to prevent.
		postureError = new Error(
			`golden image ${executionBackend.goldenImage} posture could not be verified on exit: ${error.message}`,
		);
	}

	try {
		executionBackend.stopGoldenImage(booted.uuid);
	} catch (error) {
		console.error(
			`warning: failed to stop the golden image after auth: ${error.message}`,
		);
	}

	// Both causes stay visible. Letting the posture failure replace the body's
	// error — or the reverse — would leave one of two real problems unreported.
	if (bodyError && postureError) {
		const combined = new Error(
			`${bodyError.message}\n\nthe golden image posture check ALSO failed: ${postureError.message}`,
		);
		combined.cause = bodyError;
		combined.postureError = postureError;
		throw combined;
	}
	if (bodyError) throw bodyError;
	if (postureError) throw postureError;
	return result;
}

/**
 * Create a disposable linked clone from the golden image, run `fn(workspaceId)`
 * against it, and always destroy the clone in a finally block — fails fast if the
 * environment isn't configured, and guarantees the clone is destroyed even if
 * `fn` throws.
 *
 * Progress events are emitted exclusively to stderr.
 *
 * @param {ParallelsExecutionBackend} executionBackend
 * @param {(workspaceId: string) => any} fn
 * @param {object} [options]
 * @returns {any}
 */
export function withDisposableClone(executionBackend, fn, options = {}) {
	if (!executionBackend.goldenImage) {
		throw new Error(
			"SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set to check or run provider auth",
		);
	}
	if (!/^\d+$/.test(String(executionBackend.aquaUid ?? ""))) {
		throw new Error(
			"SWITCHYARD_PARALLELS_AQUA_UID must be set to check or run provider auth",
		);
	}
	console.error(
		`Measuring linked-clone lifecycle for golden image ${executionBackend.goldenImage}...`,
	);
	const linkedCloneMeasurement = executionBackend.measureLinkedClone(
		executionBackend.goldenImage,
		{
			aquaUid: executionBackend.aquaUid,
			providerUser: executionBackend.providerUser,
		},
	);
	console.error(
		`Creating disposable linked clone from golden image ${executionBackend.goldenImage}...`,
	);
	let workspaceId;
	try {
		workspaceId = executionBackend.create(executionBackend.goldenImage, {
			...options,
			runId: `auth-qualification-${randomUUID()}`,
			linked: true,
			linkedCloneMeasurement,
			aquaUid: executionBackend.aquaUid,
			providerUser: executionBackend.providerUser,
		});
		console.error(
			`Disposable linked clone created (${workspaceId}), running auth qualification...`,
		);
		return fn(workspaceId);
	} finally {
		if (workspaceId) {
			console.error(`Destroying disposable clone (${workspaceId})...`);
			try {
				executionBackend.destroy(workspaceId);
			} catch (error) {
				console.error(
					`warning: failed to destroy disposable linked clone after auth check: ${error.message}`,
				);
			}
		}
	}
}

/**
 * Run a provider's real login command interactively inside the booted golden
 * image, attached to this process's own TTY so a human can complete whatever
 * the flow needs (visit a URL, paste a device code, approve in a browser).
 * Shares execArgv() — the exact inherit-stdio transport a real dispatch uses
 * — rather than a second one. Never trust this call's exit code as the
 * outcome — a cancelled or timed-out login can exit non-zero even though
 * nothing needs fixing, and a "successful" run doesn't by itself guarantee
 * the account is now authenticated. The caller re-checks via
 * isAuthenticated() afterward, which is the real ground truth (same "don't
 * trust the wrapped command's exit code" principle the old authenticateX()
 * functions used).
 * @param {string[]} loginCommand The CLI command + args to run, e.g. ["claude", "auth", "login"].
 * @param {object} options
 * @param {string} options.workspaceId Booted golden image uuid.
 * @param {ParallelsExecutionBackend} options.executionBackend
 * @param {Record<string, string>} [options.env] Extra env vars for the guest process.
 */
function runInteractiveLogin(
	loginCommand,
	{ workspaceId, executionBackend, env = {} },
) {
	const { command, args } = executionBackend.execArgv(workspaceId, {
		argv: loginCommand,
		// Never /project: that resolves to a per-task workspace directory that
		// only exists inside a provisioned clone, not the golden image itself.
		cwd: "/",
		env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
	});
	try {
		execFileSync(command, args, { stdio: "inherit" });
	} catch {
		// Expected on Ctrl+C, a declined prompt, or a real login failure — the
		// isAuthenticated() re-check the caller performs is what matters.
	}
}

// The desktop OAuth flow starts a loopback callback listener. Inside the
// Parallels guest, the host browser cannot reach that guest-local listener,
// so use the documented device-code flow instead.
export const COPILOT_LOGIN_COMMAND = Object.freeze([
	"copilot",
	"login",
	"--device-code",
]);

export const AGY_LOGIN_COMMAND = Object.freeze(["agy"]);

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
		// agy has no explicit login subcommand. Current CLI releases begin the
		// Google OAuth flow only when invoked plainly; `--print` is an execution
		// flag and can fail before the credential UI is reached.
		isAuthenticated: isAgyAuthenticated,
		isLive: (workspaceId, executionBackend) =>
			probeLiveness("agy", { workspaceId, executionBackend }),
		runLogin: (workspaceId, executionBackend) =>
			runInteractiveLogin(AGY_LOGIN_COMMAND, {
				workspaceId,
				executionBackend,
			}),
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
 * @param {{name: string, isAuthenticated: (workspaceId?: string, executionBackend?: ParallelsExecutionBackend) => boolean, isLive?: (workspaceId?: string, executionBackend?: ParallelsExecutionBackend) => {live: boolean, reason: string|null, kind: string|null}}} provider
 * @param {boolean} probe Run the live probe when presence passes.
 * @param {string} [workspaceId] Booted golden image uuid — forwarded to the
 *   provider's own check functions, which ignore it if injected as a test
 *   double.
 * @param {ParallelsExecutionBackend} [executionBackend]
 * @returns {{authenticated: boolean, live: boolean|null, reason: string|null, kind: string|null}}
 */
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

/**
 * Walk a human through authenticating every provider that isn't already
 * authenticated: check real credential state first (skip anything already
 * good), then hand the terminal to the real login (run directly against the
 * golden image) for anything that isn't, and re-check afterward.
 *
 * Pure with respect to VM lifecycle — it does not boot or stop anything
 * itself, only threads `workspaceId`/`executionBackend` through to each
 * provider's check/login functions. The caller (main(), or a test injecting
 * fake providers) owns booting the golden image beforehand; that keeps this
 * function's tested contract free of a real Parallels dependency.
 * @param {Array<{name: string, isAuthenticated: (workspaceId?: string, executionBackend?: ParallelsExecutionBackend) => boolean, runLogin: (workspaceId?: string, executionBackend?: ParallelsExecutionBackend) => void, loginHint?: string}>} [providers]
 * @param {object} [options]
 * @param {string} [options.workspaceId] Booted golden image uuid.
 * @param {ParallelsExecutionBackend} [options.executionBackend]
 * @returns {Array<{name: string, wasAuthenticated: boolean, ranLogin: boolean, authenticated: boolean}>}
 */
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
 * `{live: true}` additionally asks each authenticated, probeable provider to
 * answer a real one-word request, which is the only thing that distinguishes a
 * credential from a working session. Ephemeral BWS API-key lanes are not
 * probeable by this command because their keys exist only inside a disposable
 * dispatch process; they remain explicitly unprobed. Live mode is opt-in
 * because it spends real quota, and stays read-only either way. The plain form
 * is honest about its limits rather than silently cheap: it reports a
 * credential, and a credential is not a session. (It is not free either — see
 * withBootedGoldenImage(): even the plain form needs a running guest to read a
 * credential file from.)
 *
 * Pure with respect to VM lifecycle, same as ensureProvidersAuthenticated().
 * @param {Array<{name: string, isAuthenticated: (workspaceId?: string, executionBackend?: ParallelsExecutionBackend) => boolean, isLive?: (workspaceId?: string, executionBackend?: ParallelsExecutionBackend) => object}>} [providers]
 * @param {{live?: boolean, workspaceId?: string, executionBackend?: ParallelsExecutionBackend}} [options]
 * @returns {Array<{name: string, authenticated: boolean, live?: boolean|null, reason?: string|null}>}
 */
export function reportProviderStatus(
	providers = PROVIDERS,
	{ live = false, workspaceId, executionBackend } = {},
) {
	return providers.map((provider) => {
		try {
			if (provider.authMode === "ephemeral_api_key_dispatch") {
				return {
					name: provider.name,
					authenticated: true,
					...(live ? { live: null, reason: null } : {}),
					authMode: provider.authMode,
				};
			}
			const state = inspectProvider(
				provider,
				live,
				workspaceId,
				executionBackend,
			);
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
 * is unauthenticated — or, with `--live`, if any provider was not positively
 * live-probed) — no login is ever attempted. Boots the golden image for the
 * duration of the report (see withBootedGoldenImage()).
 * @param {ParallelsExecutionBackend} executionBackend
 * @param {boolean} [live] Probe each authenticated provider with a real request.
 */
export function runCheck(
	executionBackend,
	live = false,
	providers = PROVIDERS,
) {
	let statuses;
	try {
		statuses = withBootedGoldenImage(executionBackend, (workspaceId) =>
			reportProviderStatus(providers, { live, workspaceId, executionBackend }),
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
		return;
	}
	console.log(
		live
			? "=== Auth status (read-only — no login attempted; live probes run only for probeable providers; BWS lanes remain unprobed) ==="
			: "=== Auth status (read-only — credential presence only; add --live to probe) ===",
	);
	for (const status of statuses) {
		if (status.authMode === "ephemeral_api_key_dispatch") {
			console.log(
				live
					? `${status.name}: BWS runtime dispatch (no OAuth login; live status unprobed)`
					: `${status.name}: BWS runtime dispatch (no OAuth login)`,
			);
			continue;
		}
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
		(status) => !status.authenticated || (live && status.live !== true),
	)
		? 1
		: 0;
}

/**
 * Qualify provider auth inside a disposable clone: creates one disposable
 * linked clone, checks every OAuth-backed provider with presence + live logic,
 * reports BWS API-key lanes as unprobed, and guarantees clone destruction.
 *
 * Progress is emitted only via stderr; the return value is the list of provider
 * qualification results.
 *
 * @param {ParallelsExecutionBackend} executionBackend
 * @param {Array<object>} [providers]
 * @param {object} [options]
 * @returns {Array<{name: string, authenticated: boolean, live?: boolean|null, reason?: string|null, authMode?: string}>}
 */
export function qualifyCloneAuth(
	executionBackend,
	providers = PROVIDERS,
	options = {},
) {
	return withDisposableClone(
		executionBackend,
		(workspaceId) =>
			reportProviderStatus(providers, {
				live: true,
				workspaceId,
				executionBackend,
			}),
		options,
	);
}

export const CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION = 1;

export const CLONE_RECEIPT_ERROR_KINDS = Object.freeze([
	"clone_qualification_failed",
	"clone_execution_failed",
]);

/**
 * Format a strictly sanitized clone qualification receipt.
 * Contains only fixed schemaVersion, sanitized provider entries (name, authenticated,
 * live, authMode), and a static terminal errorKind.
 * Deliberately excludes and drops reasons, error messages, raw output, workspace IDs,
 * VM names, and credentials.
 *
 * @param {Array<object>} [statuses]
 * @param {string|null} [errorKind]
 * @returns {{schemaVersion: number, providers: Array<{name: string, authenticated: boolean, live: boolean|null, authMode?: string}>, errorKind: string|null}}
 */
export function formatCloneReceipt(statuses = [], errorKind = null) {
	const sanitizedProviders = (statuses || []).map((status) => {
		const entry = {
			name: String(status?.name ?? ""),
			authenticated: status?.authenticated === true,
			live: typeof status?.live === "boolean" ? status.live : null,
		};
		if (typeof status?.authMode === "string") {
			entry.authMode = status.authMode;
		}
		return entry;
	});

	return {
		schemaVersion: CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
		providers: sanitizedProviders,
		errorKind: errorKind ?? null,
	};
}

/**
 * Write a sanitized clone qualification receipt to disk atomically.
 * Writes to a unique temporary file in the destination directory and renames
 * it over the destination path.
 *
 * @param {string} receiptPath Destination file path.
 * @param {object} receipt The receipt object to write.
 */
export function writeCloneReceipt(receiptPath, receipt) {
	if (!receiptPath || typeof receiptPath !== "string") {
		throw new TypeError("receiptPath must be a non-empty string");
	}
	mkdirSync(dirname(receiptPath), { recursive: true });
	const tmpPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	try {
		renameSync(tmpPath, receiptPath);
	} catch (error) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// ignore cleanup error
		}
		throw error;
	}
}

/**
 * Run clone qualification, print progress to stderr and terminal provider summary
 * to stdout, optionally persist a sanitized qualification receipt, and set the exit code
 * (1 if any provider is unauthenticated or not positively live-probed, or if BWS lanes
 * remain unprobed; 0 only if all pass).
 *
 * @param {ParallelsExecutionBackend} executionBackend
 * @param {Array<object>} [providers]
 * @param {object} [options]
 * @param {string} [options.receipt] File path to persist sanitized qualification receipt.
 * @param {string} [options.receiptPath] Alias for options.receipt.
 */
export function runCloneCheck(
	executionBackend,
	providers = PROVIDERS,
	options = {},
) {
	const receiptPath = options.receipt ?? options.receiptPath ?? null;
	let statuses;
	try {
		statuses = qualifyCloneAuth(executionBackend, providers, options);
	} catch (error) {
		console.error(error.message);
		if (receiptPath) {
			try {
				writeCloneReceipt(
					receiptPath,
					formatCloneReceipt([], "clone_execution_failed"),
				);
			} catch (receiptError) {
				console.error(
					`warning: failed to write qualification receipt: ${receiptError.message}`,
				);
			}
		}
		process.exitCode = 1;
		return;
	}
	console.log(
		"=== Clone auth qualification (read-only disposable clone — live probes run for OAuth providers; BWS lanes remain unprobed) ===",
	);
	for (const status of statuses) {
		if (status.authMode === "ephemeral_api_key_dispatch") {
			console.log(
				`${status.name}: BWS runtime dispatch (no OAuth login; live status unprobed)`,
			);
			continue;
		}
		if (!status.authenticated) {
			console.log(`${status.name}: NOT AUTHENTICATED`);
			continue;
		}
		if (status.live === null) {
			console.log(`${status.name}: authenticated`);
			continue;
		}
		console.log(
			status.live
				? `${status.name}: authenticated (live)`
				: `${status.name}: AUTHENTICATED BUT NOT LIVE — ${status.reason}`,
		);
	}
	const hasFailure = statuses.some(
		(status) => !status.authenticated || status.live !== true,
	);
	if (receiptPath) {
		try {
			writeCloneReceipt(
				receiptPath,
				formatCloneReceipt(
					statuses,
					hasFailure ? "clone_qualification_failed" : null,
				),
			);
		} catch (receiptError) {
			console.error(
				`warning: failed to write qualification receipt: ${receiptError.message}`,
			);
		}
	}
	process.exitCode = hasFailure ? 1 : 0;
}

export function parseCloneArgs(argv) {
	let receipt = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--receipt" && i + 1 < argv.length) {
			receipt = argv[i + 1];
			i++;
		} else if (arg.startsWith("--receipt=")) {
			receipt = arg.slice("--receipt=".length);
		}
	}
	return { receipt };
}

function main(argv = process.argv.slice(2)) {
	const executionBackend = createExecutionBackend();

	// `--clone`: read-only clone qualification against a disposable clone, never
	// a login. Measures then creates one disposable linked clone, checks presence + liveness,
	// emits progress on stderr, prints terminal summary on stdout, optionally writes
	// a sanitized receipt, and destroys the clone.
	if (argv.includes("--clone")) {
		const { receipt } = parseCloneArgs(argv);
		runCloneCheck(executionBackend, PROVIDERS, receipt ? { receipt } : {});
		return;
	}

	// `--check`: read-only status, never a login. The default (no flag) is the
	// full walkthrough, which logs in anything unauthenticated. `--live` adds a
	// real request per authenticated, probeable provider; the walkthrough always
	// probes, because a wrong answer there costs an hour rather than a status
	// line.
	if (argv.includes("--check")) {
		runCheck(executionBackend, argv.includes("--live"));
		return;
	}

	let results;
	try {
		results = withBootedGoldenImage(executionBackend, (workspaceId) =>
			ensureProvidersAuthenticated(PROVIDERS, {
				workspaceId,
				executionBackend,
			}),
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
		return;
	}
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
