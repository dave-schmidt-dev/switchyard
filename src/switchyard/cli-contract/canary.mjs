// Provider CLI contract canary (audit S7).
//
// Homebrew upgrades the provider CLIs unattended. A release that drops a flag
// a lane passes (OpenCode 2.x dropped `run --variant`) used to surface only as
// a failed provider run. The canary asks each CLI the lane actually execs for
// `--version` and `--help`, offline and with no credentials, and reports a
// typed result before the first attempt. It never enforces a version pin: the
// version only has to parse.

import { spawn } from "node:child_process";
import {
	accessSync,
	constants,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { extractCliVersion, parseHelpFlags } from "./help-flags.mjs";

/** Closed result statuses. Only `ok` passes; `unavailable` is inconclusive. */
export const CLI_CONTRACT_STATUSES = Object.freeze([
	"ok",
	"not_installed",
	"version_unreadable",
	"help_unreadable",
	"flags_missing",
	"unavailable",
]);
export const CLI_CONTRACT_FAILURE_REASON = "provider_cli_contract_failed";

const VIBE = "/Users/dave/.local/share/uv/tools/mistral-vibe/bin/vibe";
// The keyless bridge (ops/simple-provider-keyless-bridge.mjs) execs this.
const BRIDGE_OPENCODE = "/opt/homebrew/bin/opencode";

/**
 * One row per CLI binary a simple lane execs. `flags` must each appear on an
 * option-definition line of `<binary> <scope...> --help`. `hiddenFlags` are
 * required flags the CLI accepts but does not list; each is verified by a
 * parse probe against a parser shown to reject an unknown flag. Every flag a
 * lane's argv builder emits is covered (tests/cli-contract-coverage.test.mjs).
 * `subcommands` lists any further `{scope, flags}` the lane also execs.
 */
export const CLI_CONTRACTS = Object.freeze([
	Object.freeze({
		cli: "codex",
		targets: Object.freeze(["codex"]),
		binary: "codex",
		scope: Object.freeze(["exec"]),
		flags: Object.freeze([
			"--ephemeral",
			"--ignore-user-config",
			"--ignore-rules",
			"-c",
			"--config",
			"-C",
			"-s",
			"-m",
		]),
		hiddenFlags: Object.freeze([]),
	}),
	Object.freeze({
		cli: "agy",
		targets: Object.freeze(["antigravity", "antigravity-claude"]),
		binary: "agy",
		scope: Object.freeze([]),
		flags: Object.freeze([
			"--new-project",
			"--mode",
			"--dangerously-skip-permissions",
			"--sandbox",
			"--model",
			"--add-dir",
			"--output-format",
			"--print-timeout",
			"--print",
		]),
		hiddenFlags: Object.freeze([]),
	}),
	Object.freeze({
		cli: "copilot",
		targets: Object.freeze(["copilot-student"]),
		binary: "copilot",
		scope: Object.freeze([]),
		flags: Object.freeze([
			"--experimental",
			"-C",
			"--model",
			"--available-tools",
			"--allow-tool",
			"--disallow-temp-dir",
			"--disable-builtin-mcps",
			"--no-custom-instructions",
			"--no-ask-user",
			"--no-auto-update",
			"--output-format",
			"--stream",
			"-p",
		]),
		// Accepted by copilot's strict parser but not listed in --help.
		hiddenFlags: Object.freeze(["--sandbox"]),
	}),
	Object.freeze({
		cli: "claude",
		targets: Object.freeze(["claude-code"]),
		binary: "/opt/homebrew/bin/claude",
		scope: Object.freeze([]),
		flags: Object.freeze([
			"-p",
			"--model",
			"--effort",
			"--restricted",
			"--tools",
			"--disallowedTools",
			"--strict-mcp-config",
			"--permission-mode",
			"--permission-prompts",
			"--no-session-persistence",
			"--disable-slash-commands",
			"--output-format",
		]),
		hiddenFlags: Object.freeze([]),
	}),
	Object.freeze({
		cli: "vibe",
		targets: Object.freeze(["vibe", "vibe-code"]),
		binary: VIBE,
		scope: Object.freeze([]),
		flags: Object.freeze([
			"-p",
			"--agent",
			"--auto-approve",
			"--trust",
			"--workdir",
			"--output",
			"--enabled-tools",
		]),
		hiddenFlags: Object.freeze([]),
	}),
	Object.freeze({
		cli: "opencode",
		targets: Object.freeze(["opencode-go"]),
		binary: BRIDGE_OPENCODE,
		scope: Object.freeze(["run"]),
		flags: Object.freeze([
			"--server",
			"--agent",
			"--auto",
			"--title",
			"--model",
		]),
		hiddenFlags: Object.freeze([]),
		// The bridge starts its own loopback server for `run --server`.
		subcommands: Object.freeze([
			Object.freeze({
				scope: Object.freeze(["serve"]),
				flags: Object.freeze(["--hostname", "--port"]),
			}),
		]),
	}),
]);

// A cold launch on a loaded host stalled 6 to 10 s (audit §6.5); the bound is
// generous, and a step that still overruns is inconclusive, never drift.
const STEP_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const BOGUS_FLAG = "--switchyard-cli-canary-bogus";
// What a CLI prints when it rejects an argument, across yargs, clap,
// commander and argparse.
const FLAG_REJECTION =
	/unrecognized (?:flag|option|argument)|unknown (?:flag|option|argument)|unexpected argument|invalid option|no such option|unrecognized arguments/iu;

/** The contract row for a simple target id, or null when it has none. */
export function cliContractForTarget(targetId) {
	return CLI_CONTRACTS.find((row) => row.targets.includes(targetId)) ?? null;
}

/** Locate `binary` the way spawn does (absolute, or the first PATH hit). */
function resolveCliBinary(binary, path = process.env.PATH ?? "") {
	const candidates = isAbsolute(binary)
		? [binary]
		: path
				.split(delimiter)
				.filter((dir) => isAbsolute(dir))
				.map((dir) => join(dir, binary));
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

/**
 * Run one CLI for its --version or --help text in a disposable HOME, with no
 * credentials and no stdin. Never throws; a timeout or a non-ENOENT spawn
 * error is reported as `unavailable`.
 */
export function runCliText(binary, args, { timeoutMs, home, signal } = {}) {
	return new Promise((done) => {
		let child;
		try {
			child = spawn(binary, args, {
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: home,
					TMPDIR: home,
					LANG: "C",
					LC_ALL: "C",
					NO_COLOR: "1",
					CI: "1",
					TERM: "dumb",
				},
				cwd: home,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
		} catch (error) {
			done({ text: "", status: null, error: error?.code ?? "spawn_failed" });
			return;
		}
		const chunks = [];
		let size = 0;
		let settled = false;
		let timedOut = false;
		const killGroup = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// already gone
			}
		};
		const collect = (chunk) => {
			size += chunk.length;
			if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
			else killGroup();
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, timeoutMs);
		const onAbort = () => killGroup();
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			done(result);
		};
		child.once("error", (error) =>
			finish({ text: "", status: null, error: error?.code ?? "spawn_failed" }),
		);
		child.once("close", (status) =>
			finish({
				text: Buffer.concat(chunks).toString("utf8"),
				status,
				error: timedOut
					? "timeout"
					: signal?.aborted
						? "aborted"
						: size > MAX_OUTPUT_BYTES
							? "output_too_large"
							: null,
			}),
		);
	});
}

function binaryIdentity(path) {
	try {
		const real = realpathSync(path);
		const stat = statSync(real);
		return `${real}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`;
	} catch {
		return null;
	}
}

function outcome(row, fields) {
	return Object.freeze({
		cli: row.cli,
		binary: row.binary,
		resolvedPath: null,
		version: null,
		status: "ok",
		missingFlags: Object.freeze([]),
		detail: null,
		...fields,
	});
}

/**
 * Check one contract row against the installed CLI.
 * @param {object} row - A CLI_CONTRACTS row.
 * @param {object} [options]
 * @param {(binary: string, args: string[], opts: object) => Promise<{text: string, status: number|null, error: string|null}>} [options.run] - CLI runner seam.
 * @param {(binary: string) => string|null} [options.resolve] - Binary lookup seam.
 * @param {number} [options.deadlineMs] - Absolute deadline; no step outlives it.
 * @param {() => number} [options.now]
 * @param {AbortSignal} [options.signal]
 * @param {() => void} [options.onProgress] - Called at each step and every 5 s.
 * @returns {Promise<object>} A frozen result with a closed `status`.
 */
export async function checkCliContract(row, options = {}) {
	const {
		run = runCliText,
		resolve = resolveCliBinary,
		deadlineMs = Number.POSITIVE_INFINITY,
		now = Date.now,
		signal,
		onProgress,
	} = options;
	const resolvedPath = resolve(row.binary);
	if (resolvedPath === null)
		return outcome(row, { status: "not_installed", detail: "not_found" });
	let home;
	const timer = onProgress
		? setInterval(() => onProgress(), PROGRESS_INTERVAL_MS)
		: null;
	try {
		home = mkdtempSync(join(tmpdir(), "switchyard-cli-canary-"));
		const step = async (args) => {
			const timeoutMs = Math.min(STEP_TIMEOUT_MS, deadlineMs - now());
			if (signal?.aborted) return { text: "", status: null, error: "aborted" };
			if (timeoutMs <= 0) return { text: "", status: null, error: "deadline" };
			onProgress?.();
			return run(resolvedPath, args, { timeoutMs, home, signal });
		};
		const inconclusive = (result, version = null) =>
			result.error === "ENOENT" || result.error === "EACCES"
				? outcome(row, {
						resolvedPath,
						version,
						status: "not_installed",
						detail: result.error,
					})
				: result.error
					? outcome(row, {
							resolvedPath,
							version,
							status: "unavailable",
							detail: result.error,
						})
					: null;
		const versionRun = await step(["--version"]);
		const versionStop = inconclusive(versionRun);
		if (versionStop) return versionStop;
		const version =
			versionRun.status === 0 ? extractCliVersion(versionRun.text) : null;
		if (version === null)
			return outcome(row, {
				resolvedPath,
				status: "version_unreadable",
				detail: `exit_${versionRun.status ?? "signal"}`,
			});
		const helpRun = await step([...row.scope, "--help"]);
		const helpStop = inconclusive(helpRun, version);
		if (helpStop) return helpStop;
		const listed = parseHelpFlags(helpRun.text);
		if (listed.size === 0)
			return outcome(row, {
				resolvedPath,
				version,
				status: "help_unreadable",
				detail: `exit_${helpRun.status ?? "signal"}`,
			});
		const missing = row.flags.filter((flag) => !listed.has(flag));
		for (const sub of row.subcommands ?? []) {
			const subRun = await step([...sub.scope, "--help"]);
			const subStop = inconclusive(subRun, version);
			if (subStop) return subStop;
			const subListed = parseHelpFlags(subRun.text);
			if (subListed.size === 0)
				return outcome(row, {
					resolvedPath,
					version,
					status: "help_unreadable",
					detail: `exit_${subRun.status ?? "signal"}`,
				});
			for (const flag of sub.flags)
				if (!subListed.has(flag))
					missing.push(`${sub.scope.join(" ")} ${flag}`);
		}
		if (row.hiddenFlags.length > 0) {
			// Silence about a flag proves acceptance only from a strict parser.
			const calibration = await step([...row.scope, BOGUS_FLAG, "--help"]);
			const calibrationStop = inconclusive(calibration, version);
			if (calibrationStop) return calibrationStop;
			const strict =
				FLAG_REJECTION.test(calibration.text) &&
				calibration.text.includes(BOGUS_FLAG);
			for (const flag of row.hiddenFlags) {
				if (listed.has(flag)) continue;
				if (!strict) {
					missing.push(flag);
					continue;
				}
				const probe = await step([...row.scope, flag, "--help"]);
				const probeStop = inconclusive(probe, version);
				if (probeStop) return probeStop;
				if (FLAG_REJECTION.test(probe.text) && probe.text.includes(flag))
					missing.push(flag);
			}
		}
		return outcome(row, {
			resolvedPath,
			version,
			status: missing.length === 0 ? "ok" : "flags_missing",
			missingFlags: Object.freeze(missing),
		});
	} catch (error) {
		return outcome(row, {
			resolvedPath,
			status: "unavailable",
			detail: typeof error?.code === "string" ? error.code : "canary_threw",
		});
	} finally {
		if (timer) clearInterval(timer);
		if (home) rmSync(home, { recursive: true, force: true });
	}
}

const CONDITIONS = Object.freeze({
	not_installed: (r) => `${r.cli} is not installed at ${r.binary}`,
	version_unreadable: (r) => `${r.cli} --version printed no version`,
	help_unreadable: (r) => `${r.cli} --help listed no flags`,
	flags_missing: (r) =>
		`${r.cli} ${r.version} no longer accepts ${r.missingFlags.join(", ")}`,
});

/** The bounded, closed preflight detail a failed canary leaves on the run. */
export function cliContractPreflightDetail(result) {
	return {
		code: CLI_CONTRACT_FAILURE_REASON,
		condition: (CONDITIONS[result.status] ?? CONDITIONS.help_unreadable)(
			result,
		),
		remedy:
			"port the adapter to the installed CLI or reinstall the qualified release; npm run cli:canary reports every adapter",
		cli: result.cli,
		status: result.status,
		version: result.version,
		missingFlags: [...result.missingFlags],
	};
}

const cache = new Map();

/**
 * Cached canary for the CLI a simple target execs. Definitive results are
 * cached per process, keyed by the binary's canonical path, inode, size and
 * mtime, so a Homebrew upgrade mid-process forces a re-check. An inconclusive
 * (`unavailable`) result is never cached. A target with no contract row
 * passes.
 * @returns {Promise<object|null>} The result, or null for a target with no row.
 */
export async function checkTargetCliContract(targetId, options = {}) {
	const row = cliContractForTarget(targetId);
	if (!row) return null;
	const resolve = options.resolve ?? resolveCliBinary;
	const resolvedPath = resolve(row.binary);
	const identity = resolvedPath === null ? null : binaryIdentity(resolvedPath);
	const key = identity === null ? null : `${row.cli}\0${identity}`;
	if (key !== null && cache.has(key)) return cache.get(key);
	const result = await checkCliContract(row, { ...options, resolve });
	if (key !== null && result.status !== "unavailable") cache.set(key, result);
	return result;
}

/** Forget cached results (tests). */
export function resetCliContractCache() {
	cache.clear();
}

/**
 * Run the canary over every contract row, for `npm run cli:canary` and
 * `doctor`. Rows run one at a time so progress stays readable.
 * @returns {Promise<object[]>} One frozen result per row, with its targets.
 */
export async function runCliCanary(options = {}) {
	const rows = options.only?.length
		? CLI_CONTRACTS.filter((row) => options.only.includes(row.cli))
		: CLI_CONTRACTS;
	const results = [];
	for (const row of rows) {
		options.onRow?.(row);
		const result = await checkCliContract(row, options);
		results.push(Object.freeze({ ...result, targets: row.targets }));
	}
	return results;
}
