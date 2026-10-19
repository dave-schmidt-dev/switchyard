#!/usr/bin/env node
/**
 * `switchyard-dispatch` entry point.
 *
 * `simple`, the default lane, runs without loading the recovery and
 * route-health modules: every other subcommand imports them from `./cli.mjs`
 * only when it runs, so an import-time defect there cannot stop a simple
 * dispatch.
 * `doctor` loads only its own read-only probes.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { handleSimple } from "../simple/index.mjs";
import { USAGE, UsageError } from "./cli-usage.mjs";

async function main(argv) {
	if (argv.length === 1 && argv[0] === "--version") {
		const packageUrl = new URL("../../../package.json", import.meta.url);
		const { version } = JSON.parse(readFileSync(packageUrl, "utf8"));
		console.log(version);
		return;
	}

	if (argv[0] === "simple") {
		await handleSimple(argv.slice(1));
		return;
	}
	if (argv[0] === "doctor") {
		const { handleDoctor } = await import("../doctor/index.mjs");
		process.exitCode = await handleDoctor(argv.slice(1));
		return;
	}
	const { runDispatchCommand } = await import("./cli.mjs");
	await runDispatchCommand(argv);
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
		if (error instanceof UsageError) {
			console.error(`dispatch: ${error.message}\n`);
			console.error(USAGE);
			process.exitCode = 2;
		} else {
			console.error(formatRunAbort(error));
			process.exitCode = 1;
		}
	}
}

export { formatRunAbort };
