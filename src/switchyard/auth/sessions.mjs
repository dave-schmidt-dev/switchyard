import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createExecutionBackend as createResolvedExecutionBackend,
	hostBackendDefaults,
} from "../lifecycle/backend-selection.mjs";

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
function createExecutionBackend() {
	return createResolvedExecutionBackend(hostBackendDefaults());
}
const INTERRUPT_EXIT_CODES = Object.freeze({
	SIGINT: 130,
	SIGTERM: 143,
	SIGHUP: 129,
});
const WALKTHROUGH_INTERRUPTED = "WALKTHROUGH_INTERRUPTED";
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

export {
	createExecutionBackend,
	INTERRUPT_EXIT_CODES,
	runInteractiveLogin,
	WALKTHROUGH_INTERRUPTED,
};
