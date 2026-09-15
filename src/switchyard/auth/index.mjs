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
//                             disposable full clone, probes every OAuth
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgyAuthenticated } from "../adapter/agy.mjs";
import { isClaudeAuthenticated } from "../adapter/claude.mjs";
import { isCodexAuthenticated } from "../adapter/codex.mjs";
import { isCopilotAuthenticated } from "../adapter/copilot.mjs";
import { isCursorAuthenticated } from "../adapter/cursor.mjs";
import { isVibeAuthenticated } from "../adapter/vibe.mjs";
import {
	createExecutionBackend as createResolvedExecutionBackend,
	hostBackendDefaults,
} from "../lifecycle/backend-selection.mjs";
import { probeLiveness } from "./liveness.mjs";

const AUTH_PROJECT_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const AUTH_RUN_STORE_ROOT = join(AUTH_PROJECT_ROOT, ".logs", "switchyard");

function authOwnershipContext(options, runId) {
	const supplied = options.ownershipContext;
	if (supplied) return { ...supplied, runId, purpose: "auth-qualification" };
	const runStoreRoot =
		process.env.SWITCHYARD_RUN_STORE_ROOT || AUTH_RUN_STORE_ROOT;
	return {
		resourceRoot: join(resolve(runStoreRoot), "runs", runId, "resources"),
		runId,
		taskId: "auth-qualification",
		attemptId: "qualification",
		projectRoot: AUTH_PROJECT_ROOT,
		creatorPid: process.pid,
		processStartIdentity: null,
		purpose: "auth-qualification",
	};
}

/**
 * Build the same execution backend a real macOS-platform dispatch would use
 * (mirrors dispatch/index.mjs's executionBackendForRun), so auth never checks
 * or logs in against a different guest shape than a real run executes in.
 * @returns {ParallelsExecutionBackend}
 */
function createExecutionBackend() {
	return createResolvedExecutionBackend(hostBackendDefaults());
}

// The shell convention (128 + signo) and the single source of truth for both
// the interrupt handlers below and main()'s exit code, so an operator who
// interrupts a walkthrough gets the same code whichever path noticed.
const INTERRUPT_EXIT_CODES = Object.freeze({
	SIGINT: 130,
	SIGTERM: 143,
	SIGHUP: 129,
});

// Thrown when a login's own child process was killed by one of those signals.
// The signal-aware shell wrapper converts Ctrl+C into the conventional
// 128+signo status after killing the exact prlctl transport. execFileSync still
// blocks Node while that happens, so the status is the in-band evidence that
// stops the walk at the interrupted provider instead of marching on to the
// next one and demanding another Ctrl+C for each.
const WALKTHROUGH_INTERRUPTED = "WALKTHROUGH_INTERRUPTED";

// Keep job control disabled: the child stays in the terminal's foreground
// process group and can read interactive input, while the shell can still trap
// the same signal and terminate that exact child if it refuses to exit.
const SIGNAL_AWARE_LOGIN_WRAPPER = `"$@" <&0 &
child=$!
interrupt() {
  status=$1
  kill -KILL "$child" 2>/dev/null || :
  wait "$child" 2>/dev/null || :
  exit "$status"
}
trap 'interrupt 129' HUP
trap 'interrupt 130' INT
trap 'interrupt 143' TERM
wait "$child"
status=$?
trap - HUP INT TERM
exit "$status"`;

function interruptedSignalForStatus(status) {
	for (const [signal, code] of Object.entries(INTERRUPT_EXIT_CODES)) {
		if (status === code) return signal;
	}
	return null;
}

function interruptedError(signal) {
	const error = new Error(`walkthrough interrupted by ${signal}`);
	error.code = WALKTHROUGH_INTERRUPTED;
	error.signal = signal;
	return error;
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
	// Ctrl+C is the documented escape from a login that will not finish, and
	// until this existed it killed node before anything stopped the guest —
	// leaving the golden image running with baked credentials, which blocks
	// the next dispatch (assertGoldenImageAvailable) until someone notices.
	// Registered after the boot, so an interrupt arriving before it still
	// falls through to node's default with nothing started to leak, and
	// removed only after the normal-path stop, so a signal that libuv queued
	// while a synchronous child held the event loop still finds a live handler
	// instead of node's default if the wrapper did not consume it first.
	let stopped = false;
	const stopOnce = (why) => {
		if (stopped) return;
		stopped = true;
		// INV-1: stopGoldenImage is a synchronous `prlctl stop` that can take
		// tens of seconds. Without this the terminal goes silent right after an
		// interrupt, which reads as a hang at exactly the moment the operator is
		// already reaching for a second Ctrl+C. stderr, not stdout: the summary
		// on stdout is the command's output, this is progress.
		console.error(`stopping the golden image after ${why}...`);
		try {
			executionBackend.stopGoldenImage(booted.uuid);
		} catch (error) {
			console.error(
				`warning: failed to stop the golden image after ${why}: ${error.message}`,
			);
		}
	};
	// Exits rather than re-raising: the point is that the guest is stopped
	// before this process goes away, and 128+signo are the conventional shell
	// codes. This handler covers the signals that arrive while the event loop
	// is free. It does NOT cover the common case on its own: a signal arriving
	// while a synchronous child holds the loop (every login runs through
	// execFileSync) is queued, not delivered, and is then discarded when the
	// normal path removes these listeners -- which on its own would absorb the
	// operator's Ctrl+C and march on to the next provider. runInteractiveLogin
	// is what closes that: it reads the wrapper's signal-derived exit status and
	// throws, so the walk stops at the provider that was interrupted and unwinds
	// through the stop below. Registering here still matters, because without
	// it node's default disposition kills the process on the spot with the
	// guest running. SIGHUP is included because closing the terminal on a stuck
	// login is how this actually leaked.
	const signalHandlers = Object.entries(INTERRUPT_EXIT_CODES).map(
		([signal, code]) => [
			signal,
			() => {
				stopOnce(signal);
				process.exit(code);
			},
		],
	);
	for (const [signal, handler] of signalHandlers) process.on(signal, handler);
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

	// Name the real reason in the progress line: "after auth" is a lie when the
	// body is unwinding from the operator's Ctrl+C, and that line is the only
	// thing on screen during a stop that takes tens of seconds.
	stopOnce(
		bodyError?.code === WALKTHROUGH_INTERRUPTED ? bodyError.signal : "auth",
	);
	for (const [signal, handler] of signalHandlers) process.off(signal, handler);

	// Both causes stay visible. Letting the posture failure replace the body's
	// error — or the reverse — would leave one of two real problems unreported.
	if (bodyError && postureError) {
		const combined = new Error(
			`${bodyError.message}\n\nthe golden image posture check ALSO failed: ${postureError.message}`,
		);
		combined.cause = bodyError;
		combined.postureError = postureError;
		// Carry the interrupt marker onto the wrapper. main() reads `code` off
		// what it catches and does not walk `cause`, so without this an operator
		// who interrupts a walkthrough that ALSO leaves the posture violated gets
		// exit 1 -- indistinguishable from a provider that failed to authenticate
		// -- for the one path where both things went wrong at once.
		if (bodyError.code === WALKTHROUGH_INTERRUPTED) {
			combined.code = bodyError.code;
			combined.signal = bodyError.signal;
		}
		throw combined;
	}
	if (bodyError) throw bodyError;
	if (postureError) throw postureError;
	return result;
}

/**
 * Create a disposable full clone from the golden image, run `fn(workspaceId)`
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
		`Creating disposable full clone from golden image ${executionBackend.goldenImage}...`,
	);
	let workspaceId;
	const runId = `auth-qualification-${randomUUID()}`;
	let ownershipContext = authOwnershipContext(options, runId);
	if (typeof executionBackend.captureCreatorOwnership === "function") {
		ownershipContext = executionBackend.captureCreatorOwnership({
			...options,
			runId,
			creatorPid: ownershipContext.creatorPid,
			ownershipContext,
		});
	}
	try {
		workspaceId = executionBackend.create(executionBackend.goldenImage, {
			...options,
			runId,
			linked: false,
			aquaUid: executionBackend.aquaUid,
			providerUser: executionBackend.providerUser,
			ownershipContext,
		});
		console.error(
			`Disposable full clone created (${workspaceId}), running auth qualification...`,
		);
		return fn(workspaceId);
	} finally {
		if (workspaceId) {
			console.error(`Destroying disposable clone (${workspaceId})...`);
			try {
				executionBackend.destroy(workspaceId);
			} catch (error) {
				console.error(
					`warning: failed to destroy disposable full clone after auth check: ${error.message}`,
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
		// execFileSync still blocks Node while the login runs. The wrapper is a
		// separate foreground process that receives the process-group signal while
		// its exact prlctl child is blocked. It kills that child on the first
		// signal, so a guest login that traps or ignores SIGINT cannot hold the
		// walkthrough.
		execFileSync(
			"/bin/sh",
			["-c", SIGNAL_AWARE_LOGIN_WRAPPER, "switchyard-login", command, ...args],
			{ stdio: "inherit" },
		);
	} catch (error) {
		// Ctrl+C reaches the whole foreground process group. The wrapper traps it,
		// kills the exact login transport, and exits with the signal-derived code;
		// node's own handler for the same signal is queued behind this synchronous
		// call. Rethrown so the caller stops walking; swallowing it is what forced
		// an operator to interrupt every remaining provider one at a time.
		const signal = INTERRUPT_EXIT_CODES[error?.signal]
			? error.signal
			: interruptedSignalForStatus(error?.status);
		if (signal) {
			throw interruptedError(signal);
		}
		// Everything else -- a declined prompt, a nonzero exit, a real login
		// failure — is expected here: the isAuthenticated() re-check the caller
		// performs is what decides the outcome.
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

// agy 1.2.2 has no login or auth subcommand (confirmed against the installed
// CLI's own --help, not from documentation): invoked plainly it opens a
// full-screen interactive TUI. Over `prlctl exec` that TUI never presents a
// credential prompt and never returns, so the walkthrough hung on agy and
// every provider ordered after it — cursor, copilot, vibe — became
// unreachable. The credential it would have to produce is a macOS Keychain
// item (`security find-generic-password -s gemini -a antigravity`, see
// adapter/agy.mjs), which needs an unlocked login keychain and therefore a
// real GUI session; a non-interactive guest exec has neither. So there is no
// login to run here, and pretending otherwise costs the whole walkthrough.
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
 *
 * A provider may declare `loginUnavailable` instead of a `runLogin` (agy).
 * When a present credential has an unclassified failed liveness probe, that
 * result is inconclusive rather than being mistaken for a known missing
 * credential or a known failed authentication.
 * One provider failing never stops the walk — except an interrupted login,
 * which rethrows so the operator's Ctrl+C ends the walkthrough.
 * @param {Array<{name: string, isAuthenticated: (workspaceId?: string, executionBackend?: ParallelsExecutionBackend) => boolean, runLogin?: (workspaceId?: string, executionBackend?: ParallelsExecutionBackend) => void, loginUnavailable?: {reason: string, remediation: string}, loginHint?: string}>} [providers]
 * @param {object} [options]
 * @param {string} [options.workspaceId] Booted golden image uuid.
 * @param {ParallelsExecutionBackend} [options.executionBackend]
 * @returns {Array<{name: string, wasAuthenticated?: boolean, ranLogin: boolean, authenticated?: boolean, inconclusive?: true, loginUnavailable?: string}>}
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

/**
 * Derive the walkthrough's process status without conflating an inconclusive
 * probe with a known failed authentication. Known failures take precedence so
 * existing callers continue to receive exit 1 when both conditions occur.
 * @param {Array<{authenticated?: boolean, inconclusive?: boolean}>} results
 * @returns {0|1|2}
 */
export function authWalkthroughExitCode(results) {
	if (results.some((result) => result.authenticated === false)) return 1;
	return results.some((result) => result.inconclusive === true) ? 2 : 0;
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
 * full clone, checks every probeable provider with presence + live logic,
 * reports BWS API-key lanes as unprobed, and guarantees clone destruction.
 * Probeability is decided by `authMode`, not by OAuth: keychain-backed Vibe is
 * probed like the OAuth providers; only the BWS lane is skipped.
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
		"=== Clone auth qualification (read-only disposable clone — live probes run for probeable providers; BWS lanes remain unprobed) ===",
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
	// a login. Creates one disposable full clone, checks presence + liveness,
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
		// An interrupted walkthrough is not an auth failure, and reporting it as
		// exit 1 would make "someone pressed Ctrl+C" indistinguishable from "a
		// provider is unauthenticated" to anything scripting this.
		process.exitCode =
			INTERRUPT_EXIT_CODES[
				error?.code === WALKTHROUGH_INTERRUPTED ? error.signal : ""
			] ?? 1;
		return;
	}
	console.log("\n=== Auth summary ===");
	for (const result of results) {
		const status = result.inconclusive
			? "INCONCLUSIVE"
			: result.authenticated
				? "authenticated"
				: "NOT AUTHENTICATED";
		const action = result.inconclusive
			? `no login available here: ${result.loginUnavailable}`
			: result.wasAuthenticated
				? "already authenticated"
				: result.ranLogin
					? "ran interactive login"
					: result.loginUnavailable
						? `no login available here: ${result.loginUnavailable}`
						: "auth check failed";
		console.log(`${result.name}: ${status} (${action})`);
	}
	process.exitCode = authWalkthroughExitCode(results);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

export { PROVIDERS };
