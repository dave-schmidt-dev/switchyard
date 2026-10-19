#!/usr/bin/env node
/**
 * Report whether each provider CLI a simple lane execs still honors its
 * contract (audit S7). Offline, no credentials. Exit 0 when every row is ok,
 * 1 when any row is drifted or missing, 2 when only inconclusive rows remain.
 *
 * Usage: npm run cli:canary [-- --json] [-- --only codex,vibe]
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCliCanary } from "../src/switchyard/cli-contract/canary.mjs";

/** One human-readable line for one canary result. */
export function formatCanaryRow(result) {
	const head = `${result.cli.padEnd(9)} ${result.status.padEnd(18)} ${result.version ?? "-"}`;
	const tail =
		result.missingFlags.length > 0
			? ` missing ${result.missingFlags.join(" ")}`
			: result.detail
				? ` (${result.detail})`
				: "";
	return `${head}${tail}  [${result.targets.join(", ")}] ${result.resolvedPath ?? result.binary}`;
}

/** Exit status for a set of results; drift outranks an inconclusive row. */
export function canaryExitCode(results) {
	if (results.some((r) => !["ok", "unavailable"].includes(r.status))) return 1;
	return results.some((r) => r.status === "unavailable") ? 2 : 0;
}

export async function main(argv = process.argv.slice(2), options = {}) {
	const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
	const progress = options.progress ?? ((text) => process.stderr.write(text));
	const json = argv.includes("--json");
	const onlyIndex = argv.indexOf("--only");
	const only = onlyIndex === -1 ? [] : (argv[onlyIndex + 1] ?? "").split(",");
	let started = false;
	const results = await runCliCanary({
		...options,
		only,
		onRow: (row) => {
			progress(`${started ? "\n" : ""}checking ${row.cli} `);
			started = true;
		},
		onProgress: () => progress("."),
	});
	if (started) progress("\n");
	if (json) write(JSON.stringify(results, null, 2));
	else for (const result of results) write(formatCanaryRow(result));
	return canaryExitCode(results);
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
	process.exitCode = await main();
