/**
 * Legacy `switchyard-dispatch` subcommands and the dispatch library surface.
 *
 * Only `./index.mjs` loads this module at run time, and only for a subcommand
 * other than `simple`, so the default lane never imports the queue, VM or
 * detached code it reaches.
 */

/**
 * Run one non-simple `switchyard-dispatch` invocation.
 *
 * @param {string[]} argv - Arguments after the executable; `argv[0]` is the
 *   subcommand, or the first positional of a backwards-compatible run.
 */
export async function runDispatchCommand(argv) {
	// A subcommand is only recognized in argv[0]. Treating a later positional
	// as a command silently reinterprets task paths and options.
	const [subcommand, ...subArgs] = argv;

	if (KNOWN_SUBCOMMANDS.has(subcommand)) {
		switch (subcommand) {
			case "run": {
				await handleRun(subArgs, {}, subcommand === "run" ? USAGE_RUN : USAGE);
				break;
			}
			case "launch": {
				await handleLaunch(subArgs);
				break;
			}
			case "validate-inputs": {
				await handleValidateInputs(subArgs);
				break;
			}
			case "backend-health": {
				await handleBackendHealth(subArgs);
				break;
			}
			case "status": {
				await handleStatus(subArgs);
				break;
			}
			case "result": {
				await handleResult(subArgs);
				break;
			}
			case "recover": {
				await handleRecover(subArgs);
				break;
			}
			case "health": {
				await handleHealth(subArgs);
				break;
			}
			case "remediate-orphaned-locks": {
				await handleOrphanLockRemediation(subArgs);
				break;
			}
			case "routing-run": {
				const { handleRoutingRun } = await import("../simple/routing-cli.mjs");
				await handleRoutingRun(subArgs);
				break;
			}
			default:
				throw new UsageError(`unknown subcommand: ${subcommand}`);
		}
	} else {
		// Backwards compat: positional dispatch (no explicit subcommand)
		await handleRun(argv, {}, USAGE);
	}
}

export {
	parseDispatchArgs,
	parseHealthArgs,
	parseLaunchArgs,
	parseOrphanLockRemediationArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
} from "./cli-args.mjs";
export { markLauncherReadyIfLaunching } from "./cli-handlers.mjs";
export {
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
	USAGE_VALIDATE_INPUTS,
} from "./cli-usage.mjs";
export { captureHostFingerprint } from "./launch-support.mjs";
export { handleRecover } from "./recover.mjs";
export { resolveIsRunDead } from "./recover-liveness.mjs";
export {
	assessRecoveryEntry,
	sweepManagedOrphans,
} from "./recover-reclaim.mjs";
export { runDispatch } from "./run-dispatch.mjs";
export { probeProviderProcess } from "./status-envelope.mjs";
export { handleLaunch, handleRun };

import "./cli-usage.mjs";
import "./cli-args.mjs";
import "./cli-handlers.mjs";
import "./run-dispatch.mjs";
import "./launch-support.mjs";
import "./launch.mjs";
import "./status-envelope.mjs";
import "./result.mjs";
import "./recover-liveness.mjs";
import "./recover-reclaim.mjs";
import { guardRoutingLaunch } from "../simple/routing-cli.mjs";
import {
	handleBackendHealth,
	handleHealth,
	handleOrphanLockRemediation,
	handleValidateInputs,
} from "./cli-handlers.mjs";
import {
	KNOWN_SUBCOMMANDS,
	USAGE,
	USAGE_RUN,
	UsageError,
} from "./cli-usage.mjs";
import {
	handleLaunch as launchDetached,
	handleRun as launchRun,
} from "./launch.mjs";

async function handleRun(argv, deps = {}, usage) {
	const guarded = guardRoutingLaunch(argv, deps);
	if (!guarded.blocked) return launchRun(guarded.argv, deps, usage);
}
async function handleLaunch(argv, deps = {}) {
	const guarded = guardRoutingLaunch(argv, deps);
	if (!guarded.blocked) return launchDetached(guarded.argv, deps);
}

import { handleResult, handleStatus } from "./result.mjs";

export { handleBackendHealth } from "./cli-handlers.mjs";

import "./recover.mjs";
import "./gc-roots.mjs";
import { handleRecover } from "./recover.mjs";
