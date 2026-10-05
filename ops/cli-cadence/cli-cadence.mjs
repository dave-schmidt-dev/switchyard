#!/usr/bin/env node
// Scheduled provider-CLI cadence (see ops/cli-cadence/README.md).
//
//   cli-cadence.mjs [--mode check|stage|promote] [--log-dir DIR] [--no-notify] [--json]
//
// check:   read each CLI's stable channel, report host drift against the pins
//          and check the host's installed CLIs against the flag contract.
// stage:   also install each newer stable release in scratch and run the flag
//          contract (strict) plus one live canary against it. (default)
// promote: also update the host for passing candidates, re-check what was
//          installed, and commit their pins on a local branch. Held candidates
//          are never written, installed or committed.
//
// Exit 0 when everything passed, 1 when anything needs the owner, 2 on usage.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatCadenceReport, runCadence } from "./cadence-core.mjs";
import { createHostIo, notifyOwner } from "./host-io.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODES = new Set(["check", "stage", "promote"]);

export function parseCadenceArgs(argv) {
	const options = {
		mode: "stage",
		logDir: join(REPO, ".logs/cli-cadence"),
		notify: true,
		json: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--mode") {
			options.mode = argv[++index];
			if (!MODES.has(options.mode))
				throw new Error(`--mode must be check, stage or promote`);
		} else if (arg === "--log-dir") {
			options.logDir = resolve(argv[++index] ?? "");
		} else if (arg === "--no-notify") options.notify = false;
		else if (arg === "--json") options.json = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

function log(line) {
	process.stderr.write(`[cli-cadence ${new Date().toISOString()}] ${line}\n`);
}

export async function main(argv = process.argv.slice(2)) {
	let options;
	try {
		options = parseCadenceArgs(argv);
	} catch (error) {
		process.stderr.write(`cli-cadence: ${error.message}\n`);
		return 2;
	}
	mkdirSync(options.logDir, { recursive: true });
	// One run at a time: a second launchd fire or a manual run waits its turn.
	const lock = join(options.logDir, "run.lock");
	try {
		mkdirSync(lock);
	} catch {
		log(`another cadence run holds ${lock}; exiting`);
		return 1;
	}
	const scratch = mkdtempSync(join(tmpdir(), "switchyard-cli-cadence-"));
	try {
		const startedAt = new Date().toISOString();
		log(`mode ${options.mode}; scratch ${scratch}`);
		const io = createHostIo({
			repo: REPO,
			scratch,
			log,
			agentContractPath:
				process.env.SWITCHYARD_AGENT_FLAG_CONTRACT ??
				join(homedir(), ".agent/cli-flag-contract.json"),
		});
		let report;
		try {
			report = await runCadence({ mode: options.mode, startedAt }, io);
		} catch (error) {
			report = null;
			const failure = {
				title: "Switchyard CLI cadence FAIL",
				body: `cadence run aborted: ${error.message}`,
			};
			log(failure.body);
			if (options.notify)
				await notifyOwner(failure, {
					notifier: process.env.SWITCHYARD_CLI_CADENCE_NOTIFY,
					log,
				});
			return 1;
		}
		const summary = formatCadenceReport(report);
		const stamp = startedAt.replace(/[:.]/gu, "-");
		writeFileSync(
			join(options.logDir, `${stamp}.json`),
			`${JSON.stringify(report, null, 2)}\n`,
		);
		writeFileSync(join(options.logDir, "latest.txt"), `${summary.body}\n`);
		process.stdout.write(
			options.json
				? `${JSON.stringify(report, null, 2)}\n`
				: `${summary.body}\n`,
		);
		if (options.notify)
			await notifyOwner(summary, {
				notifier: process.env.SWITCHYARD_CLI_CADENCE_NOTIFY,
				log,
			});
		return report.ok ? 0 : 1;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(lock, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().then((code) => {
		process.exitCode = code;
	});
