// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	canaryExitCode,
	main as cliCanaryMain,
	formatCanaryRow,
} from "../scripts/cli-canary.mjs";
import {
	CLI_CONTRACT_FAILURE_REASON,
	CLI_CONTRACT_STATUSES,
	CLI_CONTRACTS,
	checkCliContract,
	checkTargetCliContract,
	cliContractForTarget,
	cliContractPreflightDetail,
	resetCliContractCache,
	runCliCanary,
	runCliText,
} from "../src/switchyard/cli-contract/canary.mjs";
import {
	argvFlags,
	extractCliVersion,
	parseHelpFlags,
} from "../src/switchyard/cli-contract/help-flags.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const ROW = Object.freeze({
	cli: "fake",
	targets: Object.freeze(["fake-target"]),
	binary: "/opt/fake/bin/fake",
	scope: Object.freeze(["run"]),
	flags: Object.freeze(["--model", "--auto"]),
	hiddenFlags: Object.freeze([]),
});
const HELP =
	"USAGE\n  fake run [flags]\n\nFLAGS\n  --model, -m string  Model\n  --auto              Auto-approve\n";

/** A runner seam answering by argv, recording every call. */
function fakeRun(answers) {
	const calls = [];
	const run = async (binary, args, options) => {
		calls.push({ binary, args, options });
		const key = args.join(" ");
		const answer = answers[key] ?? { text: "", status: 2, error: null };
		return typeof answer === "function" ? answer() : answer;
	};
	return { run, calls };
}
const resolveTo = (path) => () => path;

test("version extraction accepts each installed CLI's real --version text", () => {
	for (const [text, expected] of [
		["codex-cli 0.163.0", "0.163.0"],
		[
			"WARNING: proceeding, even though we could not create PATH aliases\ncodex-cli 0.163.0",
			"0.163.0",
		],
		["1.4.2", "1.4.2"],
		[
			"GitHub Copilot CLI 1.0.96.\nRun 'copilot update' to check for updates.",
			"1.0.96",
		],
		["2.1.302 (Claude Code)", "2.1.302"],
		["vibe 2.25.0", "2.25.0"],
		["opencode v2.0.32", "2.0.32"],
		["1.18.30", "1.18.30"],
		["V3.1", "3.1"],
		["vibe version", null],
		["v", null],
		["", null],
	])
		strictEqual(extractCliVersion(text), expected, JSON.stringify(text));
});

test("help parsing reads definition lines only, and argv flags skip values", () => {
	const flags = parseHelpFlags(
		`${HELP}      --wrapped  requires --continue\n  -p, --print [PROMPT]  Print\n  --[no-]color  Color\n`,
	);
	for (const flag of ["--model", "-m", "--auto", "-p", "--print", "--color"])
		ok(flags.has(flag), flag);
	ok(flags.has("--no-color"));
	ok(!flags.has("--continue"));
	deepStrictEqual(
		argvFlags([
			"-p",
			"--model",
			"m",
			"--model=x",
			"-",
			"--",
			"a b",
			"-c",
			"k=v",
		]),
		["-p", "--model", "-c"],
	);
});

test("every simple target that execs a CLI has exactly one contract row", () => {
	const seen = new Set();
	for (const row of CLI_CONTRACTS)
		for (const target of row.targets) {
			ok(!seen.has(target), `${target} has two rows`);
			seen.add(target);
		}
	for (const target of [
		"codex",
		"antigravity",
		"antigravity-claude",
		"copilot-student",
		"claude-code",
		"vibe",
		"vibe-code",
		"opencode-go",
	])
		strictEqual(cliContractForTarget(target)?.targets.includes(target), true);
	strictEqual(cliContractForTarget("cursor"), null);
});

test("a CLI listing every lane flag passes with its parsed version", async () => {
	const { run, calls } = fakeRun({
		"--version": { text: "fake v4.2.0\n", status: 0, error: null },
		"run --help": { text: HELP, status: 0, error: null },
	});
	let progress = 0;
	const result = await checkCliContract(ROW, {
		run,
		resolve: resolveTo(ROW.binary),
		onProgress: () => {
			progress += 1;
		},
	});
	strictEqual(result.status, "ok");
	strictEqual(result.version, "4.2.0");
	deepStrictEqual(result.missingFlags, []);
	deepStrictEqual(
		calls.map((call) => call.args),
		[["--version"], ["run", "--help"]],
	);
	// Each step runs in one disposable HOME and reports progress.
	strictEqual(calls[0].options.home, calls[1].options.home);
	ok(calls[0].options.home.includes("switchyard-cli-canary-"));
	strictEqual(progress, 2);
	ok(CLI_CONTRACT_STATUSES.includes(result.status));
});

test("a dropped flag fails typed with the flags it no longer lists", async () => {
	const { run } = fakeRun({
		"--version": { text: "fake 2.0.0", status: 0, error: null },
		"run --help": {
			text: "  --model string  Model\n  --standalone  Private server\n",
			status: 0,
			error: null,
		},
	});
	const result = await checkCliContract(ROW, {
		run,
		resolve: resolveTo(ROW.binary),
	});
	strictEqual(result.status, "flags_missing");
	deepStrictEqual(result.missingFlags, ["--auto"]);
	const detail = cliContractPreflightDetail(result);
	strictEqual(detail.code, CLI_CONTRACT_FAILURE_REASON);
	strictEqual(detail.condition, "fake 2.0.0 no longer accepts --auto");
	deepStrictEqual(detail.missingFlags, ["--auto"]);
	ok(detail.remedy.includes("npm run cli:canary"));
});

test("a lane's extra subcommand is checked too, its drift named by scope", async () => {
	const row = Object.freeze({
		...ROW,
		subcommands: Object.freeze([
			Object.freeze({ scope: ["serve"], flags: ["--hostname", "--port"] }),
		]),
	});
	const answers = (serveHelp) =>
		fakeRun({
			"--version": { text: "fake 2.0.0", status: 0, error: null },
			"run --help": { text: HELP, status: 0, error: null },
			"serve --help": { text: serveHelp, status: 0, error: null },
		});
	const passing = answers("  --hostname string  Host\n  --port number  Port\n");
	const passed = await checkCliContract(row, {
		run: passing.run,
		resolve: resolveTo(row.binary),
	});
	strictEqual(passed.status, "ok");
	deepStrictEqual(
		passing.calls.map((call) => call.args),
		[["--version"], ["run", "--help"], ["serve", "--help"]],
	);
	const dropped = await checkCliContract(row, {
		run: answers("  --hostname string  Host\n  --stdio  Pipe\n").run,
		resolve: resolveTo(row.binary),
	});
	strictEqual(dropped.status, "flags_missing");
	deepStrictEqual(dropped.missingFlags, ["serve --port"]);
	strictEqual(
		cliContractPreflightDetail(dropped).condition,
		"fake 2.0.0 no longer accepts serve --port",
	);
	const helpless = await checkCliContract(row, {
		run: answers("no flags here\n").run,
		resolve: resolveTo(row.binary),
	});
	strictEqual(helpless.status, "help_unreadable");
});

test("absent, versionless and helpless CLIs each fail with their own status", async () => {
	const missing = await checkCliContract(ROW, { resolve: () => null });
	strictEqual(missing.status, "not_installed");
	strictEqual(
		cliContractPreflightDetail(missing).condition,
		"fake is not installed at /opt/fake/bin/fake",
	);
	const gone = await checkCliContract(ROW, {
		resolve: resolveTo(ROW.binary),
		run: fakeRun({ "--version": { text: "", status: null, error: "ENOENT" } })
			.run,
	});
	strictEqual(gone.status, "not_installed");
	for (const versionRun of [
		{ text: "fake 1.0.0", status: 1, error: null },
		{ text: "fake version unknown", status: 0, error: null },
	]) {
		const result = await checkCliContract(ROW, {
			resolve: resolveTo(ROW.binary),
			run: fakeRun({ "--version": versionRun }).run,
		});
		strictEqual(result.status, "version_unreadable");
	}
	const helpless = await checkCliContract(ROW, {
		resolve: resolveTo(ROW.binary),
		run: fakeRun({
			"--version": { text: "1.0.0", status: 0, error: null },
			"run --help": { text: "no flags here", status: 0, error: null },
		}).run,
	});
	strictEqual(helpless.status, "help_unreadable");
	strictEqual(helpless.version, "1.0.0");
});

test("a timeout, a spawn error or an expired deadline is inconclusive, never drift", async () => {
	for (const error of ["timeout", "EAGAIN", "aborted"]) {
		const result = await checkCliContract(ROW, {
			resolve: resolveTo(ROW.binary),
			run: fakeRun({ "--version": { text: "", status: null, error } }).run,
		});
		strictEqual(result.status, "unavailable");
		strictEqual(result.detail, error);
	}
	const { run, calls } = fakeRun({});
	const expired = await checkCliContract(ROW, {
		resolve: resolveTo(ROW.binary),
		run,
		deadlineMs: 1_000,
		now: () => 1_000,
	});
	strictEqual(expired.status, "unavailable");
	strictEqual(expired.detail, "deadline");
	strictEqual(calls.length, 0);
	// The step bound never outlives the caller's deadline.
	const bounded = fakeRun({
		"--version": { text: "1.0.0", status: 0, error: null },
		"run --help": { text: HELP, status: 0, error: null },
	});
	await checkCliContract(ROW, {
		resolve: resolveTo(ROW.binary),
		run: bounded.run,
		deadlineMs: 1_250,
		now: () => 1_000,
	});
	strictEqual(bounded.calls[0].options.timeoutMs, 250);
});

test("a hidden flag passes only when a strict parser accepts it", async () => {
	const row = {
		...ROW,
		scope: [],
		flags: ["--model"],
		hiddenFlags: ["--sandbox"],
	};
	const base = {
		"--version": { text: "1.0.96", status: 0, error: null },
		"--help": { text: "  --model <m>  Model\n", status: 0, error: null },
	};
	const strictReject = {
		text: "error: unexpected argument '--switchyard-cli-canary-bogus' found",
		status: 2,
		error: null,
	};
	const accepted = await checkCliContract(row, {
		resolve: resolveTo(row.binary),
		run: fakeRun({
			...base,
			"--switchyard-cli-canary-bogus --help": strictReject,
			"--sandbox --help": { text: "Usage: fake", status: 0, error: null },
		}).run,
	});
	strictEqual(accepted.status, "ok");
	const rejected = await checkCliContract(row, {
		resolve: resolveTo(row.binary),
		run: fakeRun({
			...base,
			"--switchyard-cli-canary-bogus --help": strictReject,
			"--sandbox --help": {
				text: "error: unexpected argument '--sandbox' found",
				status: 2,
				error: null,
			},
		}).run,
	});
	deepStrictEqual(rejected.missingFlags, ["--sandbox"]);
	// A lenient parser accepts anything, so its silence vouches for nothing.
	const lenient = await checkCliContract(row, {
		resolve: resolveTo(row.binary),
		run: fakeRun({
			...base,
			"--switchyard-cli-canary-bogus --help": {
				text: "Usage: fake",
				status: 0,
				error: null,
			},
		}).run,
	});
	strictEqual(lenient.status, "flags_missing");
	deepStrictEqual(lenient.missingFlags, ["--sandbox"]);
});

test("definitive results are cached per binary identity; inconclusive ones are not", async () => {
	resetCliContractCache();
	const dir = tempDir("cli-canary-cache-");
	const binary = join(dir, "codex");
	writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
	const row = cliContractForTarget("codex");
	const help = row.flags.map((flag) => `  ${flag}  x`).join("\n");
	let version = 0;
	const { run, calls } = fakeRun({
		"--version": () => {
			version += 1;
			return { text: `codex-cli 0.${version}.0`, status: 0, error: null };
		},
		"exec --help": { text: help, status: 0, error: null },
	});
	const options = { run, resolve: () => binary };
	strictEqual((await checkTargetCliContract("codex", options)).status, "ok");
	strictEqual(
		(await checkTargetCliContract("codex", options)).version,
		"0.1.0",
	);
	strictEqual(calls.length, 2);
	// An upgrade in place changes the identity and forces a re-check.
	writeFileSync(binary, "#!/bin/sh\n# upgraded\n", { mode: 0o755 });
	utimesSync(binary, new Date(), new Date(Date.now() + 5_000));
	strictEqual(
		(await checkTargetCliContract("codex", options)).version,
		"0.2.0",
	);
	strictEqual(calls.length, 4);
	resetCliContractCache();
	let attempts = 0;
	const flaky = async () => {
		attempts += 1;
		return { text: "", status: null, error: "timeout" };
	};
	for (let i = 0; i < 2; i += 1)
		strictEqual(
			(
				await checkTargetCliContract("codex", {
					run: flaky,
					resolve: () => binary,
				})
			).status,
			"unavailable",
		);
	strictEqual(attempts, 2);
	strictEqual(await checkTargetCliContract("cursor"), null);
	resetCliContractCache();
});

test("the canary reports every row with its targets", async () => {
	const seen = [];
	const results = await runCliCanary({
		resolve: () => null,
		onRow: (row) => seen.push(row.cli),
	});
	deepStrictEqual(
		seen,
		CLI_CONTRACTS.map((row) => row.cli),
	);
	ok(results.every((result) => result.status === "not_installed"));
	deepStrictEqual(results[0].targets, CLI_CONTRACTS[0].targets);
	const only = await runCliCanary({ resolve: () => null, only: ["vibe"] });
	deepStrictEqual(
		only.map((result) => result.cli),
		["vibe"],
	);
});

test("the real runner isolates HOME, kills a hung CLI's group and reports ENOENT", async () => {
	const dir = tempDir("cli-canary-runner-");
	const home = tempDir("cli-canary-home-");
	const probe = join(dir, "probe");
	writeFileSync(
		probe,
		'#!/bin/sh\nprintf "%s|%s|%s\\n" "$HOME" "$OPENAI_API_KEY" "$1"\n',
		{ mode: 0o755 },
	);
	process.env.OPENAI_API_KEY = "sk-canary-must-not-leak";
	try {
		const result = await runCliText(probe, ["--version"], {
			timeoutMs: HANG_GUARD_MS,
			home,
		});
		strictEqual(result.status, 0);
		strictEqual(result.error, null);
		strictEqual(result.text.trim(), `${home}||--version`);
	} finally {
		delete process.env.OPENAI_API_KEY;
	}
	const hung = join(dir, "hung");
	writeFileSync(hung, "#!/bin/sh\nsleep 30 &\nsleep 30\n", { mode: 0o755 });
	const started = Date.now();
	const timedOut = await runCliText(hung, ["--help"], { timeoutMs: 200, home });
	strictEqual(timedOut.error, "timeout");
	ok(Date.now() - started < HANG_GUARD_MS);
	const absent = await runCliText(join(dir, "absent"), ["--version"], {
		timeoutMs: HANG_GUARD_MS,
		home,
	});
	strictEqual(absent.error, "ENOENT");
});

test("npm run cli:canary prints one line per row and exits on the worst status", async () => {
	const lines = [];
	const code = await cliCanaryMain(["--only", "codex,vibe"], {
		resolve: () => null,
		write: (line) => lines.push(line),
		progress: () => {},
	});
	strictEqual(code, 1);
	strictEqual(lines.length, 2);
	ok(lines[0].startsWith("codex     not_installed"));
	ok(lines[1].includes("[vibe, vibe-code]"));
	const row = { cli: "x", targets: ["t"], binary: "/b", resolvedPath: "/b" };
	strictEqual(
		formatCanaryRow({
			...row,
			status: "flags_missing",
			version: "2.0.32",
			missingFlags: ["--pure", "--variant"],
			detail: null,
		}),
		"x         flags_missing      2.0.32 missing --pure --variant  [t] /b",
	);
	strictEqual(canaryExitCode([{ status: "ok" }]), 0);
	strictEqual(canaryExitCode([{ status: "ok" }, { status: "unavailable" }]), 2);
	strictEqual(
		canaryExitCode([{ status: "unavailable" }, { status: "flags_missing" }]),
		1,
	);
});
