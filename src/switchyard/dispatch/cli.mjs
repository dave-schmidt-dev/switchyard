/**
 * `switchyard-dispatch` subcommands other than `simple`.
 *
 * Only `./index.mjs` loads this module at run time, and only for a subcommand
 * other than `simple`, so the default lane never imports the recovery and
 * route-health code it reaches.
 */
import { handleHealth, handleOrphanLockRemediation } from "./cli-handlers.mjs";
import { KNOWN_SUBCOMMANDS, USAGE, UsageError } from "./cli-usage.mjs";
import { handleRecover } from "./recover.mjs";

/**
 * Run one non-simple `switchyard-dispatch` invocation.
 *
 * @param {string[]} argv - Arguments after the executable; `argv[0]` is the
 *   subcommand.
 */
export async function runDispatchCommand(argv) {
	// A subcommand is only recognized in argv[0]. Treating a later positional
	// as a command silently reinterprets task paths and options.
	const [subcommand, ...subArgs] = argv;
	if (subcommand === "--help") {
		console.log(USAGE);
		return;
	}
	if (subcommand === undefined) throw new UsageError("missing subcommand");
	if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
		throw new UsageError(`unknown subcommand: ${subcommand}`);
	}
	switch (subcommand) {
		case "recover":
			await handleRecover(subArgs);
			break;
		case "health":
			await handleHealth(subArgs);
			break;
		case "remediate-orphaned-locks":
			await handleOrphanLockRemediation(subArgs);
			break;
		case "routing-run": {
			const { handleRoutingRun } = await import("../simple/routing-cli.mjs");
			await handleRoutingRun(subArgs);
			break;
		}
		default:
			throw new UsageError(`unknown subcommand: ${subcommand}`);
	}
}

export {
	parseHealthArgs,
	parseOrphanLockRemediationArgs,
	parseRecoverArgs,
} from "./cli-args.mjs";
export { USAGE, USAGE_RECOVER } from "./cli-usage.mjs";
export { handleRecover };
