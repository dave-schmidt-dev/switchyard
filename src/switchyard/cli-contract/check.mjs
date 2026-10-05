// Compare every captured call site against the installed CLI's own --help.
//
// A flag a call site passes that the CLI no longer lists is a contract
// violation, reported with the CLI, its version, the help scope that was read,
// the flag and every call site that uses it. That is the drift that broke
// agent-headless when Homebrew moved opencode to 2.x and `opencode run` stopped
// accepting --variant and --dir.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
	LIVENESS_PROBES,
	LIVENESS_PROMPT,
	probeLiveness,
} from "../auth/liveness.mjs";
import { CLI_SUBCOMMANDS, HARNESS_BINARIES } from "./call-sites.mjs";
import {
	argvFlagUses,
	extractCliVersion,
	parseHelpFlags,
} from "./help-flags.mjs";

const HELP_TIMEOUT_MS = 30_000;
const CANARY_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// What a CLI prints when it rejects an argument, across yargs, clap,
// commander and argparse.
// A canary that cannot authenticate says nothing about flags; reported, not fatal.
const AUTH_UNAVAILABLE =
	/not logged in|log ?in required|please (?:log|sign) ?in|authentication (?:required|failed|token)|token (?:found but )?could not be validated|unauthori[sz]ed|\b401\b|missing \w*api_key|api key (?:is )?(?:missing|not set|required)|no credentials/iu;
const FLAG_REJECTION =
	/unrecognized (?:flag|option|argument)|unknown (?:flag|option|argument)|unexpected argument|invalid option|no such option|unrecognized arguments/iu;

function helpEnvironment() {
	// No credentials: reading --help never needs them.
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: process.env.HOME ?? "/tmp",
		LANG: "C",
		NO_COLOR: "1",
		CI: "1",
		TERM: "dumb",
	};
}

/** Locate `name` on PATH (or accept an absolute path); null when absent. */
function resolveBinary(name, path = process.env.PATH ?? "") {
	const candidates = isAbsolute(name)
		? [name]
		: path
				.split(delimiter)
				.filter(Boolean)
				.map((dir) => join(dir, name));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return null;
}

/** Run a CLI for its --help or --version text; never throws. */
function runCliText(binary, args) {
	const result = spawnSync(binary, args, {
		env: helpEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: HELP_TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
	});
	return {
		text: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		status: result.status,
		error: result.error?.code ?? null,
	};
}

const BOGUS_FLAG = "--switchyard-flag-contract-bogus";

function rejects(text, flag) {
	return FLAG_REJECTION.test(text) && text.includes(flag);
}

/**
 * Second witness for a flag --help does not list. Some CLIs accept hidden
 * flags (copilot's --sandbox), so absence from --help alone is not proof.
 * Only a parser that demonstrably rejects an unknown flag in the same position
 * (a strict parser) can vouch that silence means acceptance; a lenient parser
 * gives no evidence either way and the flag stays a violation.
 */
function probeHiddenFlag(binary, use, run, strictByScope) {
	const scopeKey = use.scope.join(" ");
	if (!strictByScope.has(scopeKey)) {
		const calibration = run(binary, [...use.scope, BOGUS_FLAG, "--help"]);
		strictByScope.set(scopeKey, rejects(calibration.text, BOGUS_FLAG));
	}
	if (!strictByScope.get(scopeKey)) return "unknown";
	const probe = run(binary, [
		...use.scope,
		use.flag,
		...(use.next === null ? [] : [use.next]),
		"--help",
	]);
	return rejects(probe.text, use.flag) ? "rejected" : "accepted";
}

function groupSites(sites, binOverrides, resolve) {
	const groups = new Map();
	for (const entry of sites) {
		const binary =
			binOverrides[entry.cli] ?? entry.binary ?? resolve(entry.cli) ?? null;
		const key = `${entry.cli}\0${binary ?? ""}`;
		if (!groups.has(key))
			groups.set(key, { cli: entry.cli, binary, sites: [] });
		groups.get(key).sites.push(entry);
	}
	return [...groups.values()];
}

/**
 * Check every site's flags against its CLI's --help.
 * @param {Array<{site: string, cli: string, argv: string[], binary?: string, pinnedVersion?: string, subcommands?: object}>} sites
 * @param {object} [options]
 * @param {Record<string,string>} [options.binOverrides] cli -> binary path; wins over a site's own binary.
 * @param {(name: string) => string|null} [options.resolve] binary lookup seam.
 * @param {(binary: string, args: string[]) => {text: string, status: number|null, error: string|null}} [options.run] CLI runner seam.
 * @param {boolean} [options.strict] a CLI that is not installed is a failure, not a skip.
 * @param {string[]} [options.only] restrict to these CLIs.
 */
export function checkFlagContract(sites, options = {}) {
	const {
		binOverrides = {},
		resolve = (name) => resolveBinary(name),
		run = runCliText,
		strict = false,
		only = [],
	} = options;
	const selected = only.length
		? sites.filter((entry) => only.includes(entry.cli))
		: sites;
	const results = [];
	for (const group of groupSites(selected, binOverrides, resolve)) {
		const result = {
			cli: group.cli,
			binary: group.binary,
			version: null,
			status: "ok",
			sites: group.sites.length,
			violations: [],
			notes: [],
		};
		results.push(result);
		if (!group.binary || resolve(group.binary) === null) {
			result.status = strict ? "not_installed" : "skipped";
			continue;
		}
		result.version = extractCliVersion(run(group.binary, ["--version"]).text);
		const helpByScope = new Map();
		const strictByScope = new Map();
		const missing = new Map();
		for (const entry of group.sites) {
			if (
				entry.pinnedVersion &&
				result.version &&
				entry.pinnedVersion !== result.version
			)
				result.notes.push(
					`${entry.site} pins ${group.cli} ${entry.pinnedVersion}; checked ${result.version}`,
				);
			const tree = entry.subcommands ?? CLI_SUBCOMMANDS[group.cli] ?? {};
			for (const use of argvFlagUses(entry.argv, tree)) {
				const scopeKey = use.scope.join(" ");
				if (!helpByScope.has(scopeKey)) {
					const help = run(group.binary, [...use.scope, "--help"]);
					helpByScope.set(scopeKey, parseHelpFlags(help.text));
				}
				const flags = helpByScope.get(scopeKey);
				if (flags.size === 0) {
					result.status = "help_unavailable";
					result.notes.push(
						`"${[group.cli, ...use.scope].join(" ")} --help" listed no flags`,
					);
					continue;
				}
				if (flags.has(use.flag)) continue;
				const probe = probeHiddenFlag(group.binary, use, run, strictByScope);
				if (probe === "accepted") {
					result.notes.push(
						`${[group.cli, ...use.scope].join(" ")} ${use.flag} is not in --help but the parser accepts it (hidden flag)`,
					);
					continue;
				}
				const id = `${scopeKey}\0${use.flag}`;
				if (!missing.has(id))
					missing.set(id, {
						scope: use.scope,
						flag: use.flag,
						sites: new Set(),
					});
				missing.get(id).sites.add(entry.site);
			}
		}
		for (const violation of missing.values())
			result.violations.push({
				...violation,
				sites: [...violation.sites].sort(),
			});
		if (result.violations.length > 0) result.status = "drift";
		result.notes = [...new Set(result.notes)];
	}
	const failing = new Set(["drift", "not_installed", "help_unavailable"]);
	return {
		ok: results.every((result) => !failing.has(result.status)),
		results,
	};
}

/** Canary statuses that fail the run; the rest are reported, not fatal. */
export const FAILING_CANARY_STATUSES = Object.freeze([
	"flag_rejected",
	"not_live",
]);

/** One line per violation: CLI, version, help scope, flag, call sites. */
export function formatFlagContractReport(report) {
	const lines = [];
	for (const result of report.results) {
		const label = `${result.cli} ${result.version ?? "unknown-version"}`;
		if (result.status === "ok") {
			lines.push(
				`FLAG-CONTRACT ok ${label} (${result.sites} call sites, ${result.binary})`,
			);
		} else if (result.status === "skipped") {
			lines.push(
				`FLAG-CONTRACT skip ${result.cli}: not installed (${result.binary ?? "PATH"})`,
			);
		} else if (result.status === "not_installed") {
			lines.push(
				`FLAG-CONTRACT FAIL ${result.cli}: not installed (${result.binary ?? "PATH"})`,
			);
		}
		for (const violation of result.violations)
			lines.push(
				`FLAG-CONTRACT FAIL ${label}: "${[result.cli, ...violation.scope].join(" ")} --help" does not list ${violation.flag} (used by ${violation.sites.join(", ")}; ${result.binary})`,
			);
		if (result.status === "help_unavailable")
			lines.push(
				`FLAG-CONTRACT FAIL ${label}: --help unreadable (${result.binary})`,
			);
		for (const note of result.notes) lines.push(`  note: ${note}`);
	}
	return lines.join("\n");
}

function runCanaryProcess(binary, spec, { timeoutMs, onHeartbeat }) {
	return new Promise((done) => {
		const env = { ...process.env, NO_COLOR: "1" };
		for (const pair of spec.env ?? []) {
			const at = pair.indexOf("=");
			env[pair.slice(0, at)] = pair.slice(at + 1);
		}
		const child = spawn(binary, spec.args.slice(1), {
			cwd: spec.cwd ?? "/tmp",
			env,
			stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
		});
		if (spec.stdin) child.stdin.end(spec.input);
		const started = Date.now();
		const heartbeat = setInterval(
			() => onHeartbeat?.(Math.round((Date.now() - started) / 1000)),
			HEARTBEAT_MS,
		);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
		}, timeoutMs);
		const finish = (status, error) => {
			clearInterval(heartbeat);
			clearTimeout(timer);
			done({ status, stdout, stderr, timedOut, error });
		};
		child.once("error", (error) => finish(null, error));
		child.once("close", (status) => finish(status, null));
	});
}

/**
 * One tiny live request per CLI through the same argv the liveness probes use.
 * Costs one short completion per provider, so it is opt-in. A provider whose
 * auth is absent is reported as such, separately from a rejected flag.
 */
export async function runCanaries({
	names = Object.keys(HARNESS_BINARIES),
	binOverrides = {},
	resolve = (name) => resolveBinary(name),
	timeoutMs = CANARY_TIMEOUT_MS,
	log = (line) => process.stderr.write(`${line}\n`),
	runProcess = runCanaryProcess,
} = {}) {
	const outcomes = [];
	for (const name of names) {
		const cli = HARNESS_BINARIES[name] ?? name;
		const binary = binOverrides[cli] ?? resolve(cli);
		if (!binary) {
			outcomes.push({ name, cli, status: "not_installed", reason: null });
			continue;
		}
		log(`canary: ${cli} starting (timeout ${Math.round(timeoutMs / 1000)}s)`);
		const spec = LIVENESS_PROBES[name](LIVENESS_PROMPT);
		const observed = await runProcess(
			binary,
			{ ...spec, input: LIVENESS_PROMPT },
			{
				timeoutMs,
				onHeartbeat: (seconds) =>
					log(`canary: ${cli} still running (${seconds}s)`),
			},
		);
		// probeLiveness owns the verdict (positive OK match, error
		// classification); it is handed the finished process through its seam.
		const verdict = probeLiveness(name, {
			timeoutMs,
			run: () => {
				if (observed.timedOut)
					throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
				if (observed.status !== 0)
					throw Object.assign(
						new Error(
							`${cli} exited ${observed.status ?? observed.error?.code}`,
						),
						{ stdout: observed.stdout, stderr: observed.stderr },
					);
				return `${observed.stdout}\n${observed.stderr}`;
			},
		});
		const text = `${observed.stdout}\n${observed.stderr}`;
		const status = verdict.live
			? "live"
			: FLAG_REJECTION.test(text)
				? "flag_rejected"
				: verdict.kind === "auth_expired" || AUTH_UNAVAILABLE.test(text)
					? "auth_unavailable"
					: verdict.kind === "quota_exhausted"
						? "quota_unavailable"
						: "not_live";
		log(`canary: ${cli} ${status}`);
		outcomes.push({
			name,
			cli,
			status,
			reason: verdict.reason,
			kind: verdict.kind,
		});
	}
	return outcomes;
}
