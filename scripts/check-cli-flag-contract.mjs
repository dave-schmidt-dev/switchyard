#!/usr/bin/env node
// Assert every flag Switchyard (and any --contract file) passes to a provider
// CLI is listed by that CLI's installed --help; optionally run one tiny live
// canary per CLI. Exit 0 pass, 1 contract failure, 2 usage error.
//
//   node scripts/check-cli-flag-contract.mjs                 installed CLIs only
//   node scripts/check-cli-flag-contract.mjs --strict        missing CLI fails
//   node scripts/check-cli-flag-contract.mjs --contract ~/.agent/cli-flag-contract.json
//   node scripts/check-cli-flag-contract.mjs --bin opencode=/opt/homebrew/bin/opencode --only opencode
//   node scripts/check-cli-flag-contract.mjs --canary [--json]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	collectSwitchyardCallSites,
	HARNESS_BINARIES,
	parseContractSites,
} from "../src/switchyard/cli-contract/call-sites.mjs";
import {
	checkFlagContract,
	FAILING_CANARY_STATUSES,
	formatFlagContractReport,
	runCanaries,
} from "../src/switchyard/cli-contract/check.mjs";

const USAGE = `Usage: check-cli-flag-contract.mjs [--strict] [--json] [--canary]
       [--no-switchyard] [--contract FILE]... [--bin CLI=PATH]... [--only CLI]...`;

export function parseArgs(argv) {
	const options = {
		strict: false,
		json: false,
		canary: false,
		switchyard: true,
		contracts: [],
		binOverrides: {},
		only: [],
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = () => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--"))
				throw new Error(`${arg} needs a value`);
			index += 1;
			return next;
		};
		if (arg === "--strict") options.strict = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--canary") options.canary = true;
		else if (arg === "--no-switchyard") options.switchyard = false;
		else if (arg === "--contract") options.contracts.push(resolve(value()));
		else if (arg === "--only") options.only.push(value());
		else if (arg === "--bin") {
			const pair = value();
			const at = pair.indexOf("=");
			if (at < 1 || !pair.slice(at + 1).startsWith("/"))
				throw new Error(`--bin expects CLI=/absolute/path, got ${pair}`);
			options.binOverrides[pair.slice(0, at)] = pair.slice(at + 1);
		} else throw new Error(`unknown argument: ${arg}`);
	}
	if (!options.switchyard && options.contracts.length === 0)
		throw new Error("--no-switchyard needs at least one --contract");
	return options;
}

export async function main(argv = process.argv.slice(2)) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		process.stderr.write(
			`check-cli-flag-contract: ${error.message}\n${USAGE}\n`,
		);
		return 2;
	}
	const sites = [
		...(options.switchyard ? collectSwitchyardCallSites() : []),
		...options.contracts.flatMap((path) =>
			parseContractSites(readFileSync(path, "utf8"), path),
		),
	];
	const report = checkFlagContract(sites, options);
	let canaries = [];
	if (options.canary) {
		const clis = new Set(report.results.map((result) => result.cli));
		const names = Object.entries(HARNESS_BINARIES)
			.filter(([, cli]) => clis.has(cli))
			.map(([name]) => name);
		canaries = await runCanaries({ names, binOverrides: options.binOverrides });
	}
	const canariesOk = canaries.every(
		(outcome) =>
			!FAILING_CANARY_STATUSES.includes(outcome.status) &&
			!(options.strict && outcome.status === "not_installed"),
	);
	const ok = report.ok && canariesOk;
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({ ok, ...report, canaries }, null, 2)}\n`,
		);
	} else {
		process.stdout.write(`${formatFlagContractReport(report)}\n`);
		for (const outcome of canaries)
			process.stdout.write(
				`CANARY ${FAILING_CANARY_STATUSES.includes(outcome.status) ? "FAIL" : "ok"} ${outcome.cli}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}\n`,
			);
		process.stdout.write(`flag contract ${ok ? "PASSED" : "FAILED"}\n`);
	}
	return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().then((code) => {
		process.exitCode = code;
	});
