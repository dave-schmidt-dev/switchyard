#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CallerInputValidationError } from "../runner/index.mjs";
import { handleSimple, SIMPLE_USAGE } from "../simple/index.mjs";

async function main(argv) {
	if (argv.length === 1 && argv[0] === "--version") {
		const packageUrl = new URL("../../../package.json", import.meta.url);
		const { version } = JSON.parse(readFileSync(packageUrl, "utf8"));
		console.log(version);
		return;
	}

	// A subcommand is only recognized in argv[0]. Treating a later positional
	// as a command silently reinterprets task paths and options.
	const [subcommand, ...subArgs] = argv;

	if (KNOWN_SUBCOMMANDS.has(subcommand)) {
		switch (subcommand) {
			case "simple": {
				await handleSimple(subArgs);
				break;
			}
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
function formatRunAbort(error) {
	const runAddress = error.switchyardRunId
		? ` (run ${error.switchyardRunId})`
		: "";
	return `dispatch: run aborted${runAddress}: ${error.message}`;
}
if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		if (
			error instanceof UsageError ||
			error instanceof CallerInputValidationError ||
			error?.name === "CheckpointIdentityError"
		) {
			console.error(`dispatch: ${error.message}\n`);
			console.error(USAGE);
			process.exitCode = 2;
		} else {
			console.error(formatRunAbort(error));
			process.exitCode = 1;
		}
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
export {
	handleHealth,
	handleOrphanLockRemediation,
	handleValidateInputs,
	markLauncherReadyIfLaunching,
} from "./cli-handlers.mjs";
export {
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
	USAGE_VALIDATE_INPUTS,
} from "./cli-usage.mjs";
export {
	captureHostFingerprint,
	renewDispatchReceipts,
} from "./launch-support.mjs";
export { handleRecover } from "./recover.mjs";
export { resolveIsRunDead } from "./recover-liveness.mjs";
export {
	assessRecoveryEntry,
	auditKnownAllocationIntents,
	sweepManagedOrphans,
} from "./recover-reclaim.mjs";
export { handleResult, handleStatus } from "./result.mjs";
export { runDispatch } from "./run-dispatch.mjs";
export { probeProviderProcess } from "./status-envelope.mjs";
export { formatRunAbort, handleLaunch, handleRun, SIMPLE_USAGE };

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
