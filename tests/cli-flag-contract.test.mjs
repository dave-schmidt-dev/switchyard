import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CLI_SUBCOMMANDS,
	collectSwitchyardCallSites,
	HARNESS_BINARIES,
	providerArgvFrom,
} from "../src/switchyard/cli-contract/call-sites.mjs";
import {
	checkFlagContract,
	formatFlagContractReport,
} from "../src/switchyard/cli-contract/check.mjs";
import {
	argvFlagUses,
	parseHelpFlags,
} from "../src/switchyard/cli-contract/help-flags.mjs";

// Excerpts of real --help output, one per parser family the providers use.
const YARGS_OPENCODE_1 = `opencode run [message..]

Options:
  -h, --help         show help                                       [boolean]
  -v, --version      show version number                             [boolean]
      --pure         run without external plugins                    [boolean]
  -m, --model        model to use in the format of provider/model     [string]
      --agent        agent to use                                     [string]
      --dir          directory to run in, path on remote server if attaching
      --variant      model variant (provider-specific reasoning effort, e.g., high, max, minimal)
      --auto         auto-approve permissions that are not explicitly denied (dangerous!)
`;
const CLAP_CODEX_EXEC = `Usage: codex exec [OPTIONS] [PROMPT]

Options:
  -c, --config <key=value>
          Override a configuration value. Examples: - \`-c model="o3"\`

  -m, --model <MODEL>
          Model the agent should use

      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing
`;
const COMMANDER_CLAUDE = `Usage: claude [options] [command] [prompt]

Options:
  --bg, --background                    Start the session in the background and
                                        --resume <session-id>, continues that
  -p, --print                           Print response and exit
  --permission-mode <mode>              Permission mode to use for the session
  --effort <level>                      Effort level for the current session
  --[no-]chrome                         Enable Claude in Chrome integration
`;
const ARGPARSE_VIBE = `usage: vibe [-h] [-v] [-p [TEXT]]

options:
  -h, --help            show this help message and exit
  -p [TEXT], --prompt [TEXT]
                        Run in programmatic mode. Pass --auto-
                        approve or --yolo to allow all tool calls.
  --output {text,json,streaming}
                        Output format for programmatic mode (-p).
  --auto-approve, --yolo
                        Approves all tool calls without prompting.
`;

describe("parseHelpFlags", () => {
	it("reads option-definition lines from yargs, clap, commander and argparse", () => {
		const yargs = parseHelpFlags(YARGS_OPENCODE_1);
		for (const flag of [
			"--pure",
			"-m",
			"--model",
			"--variant",
			"--dir",
			"--auto",
		])
			assert.ok(yargs.has(flag), `yargs ${flag}`);
		const clap = parseHelpFlags(CLAP_CODEX_EXEC);
		for (const flag of [
			"-c",
			"--config",
			"--dangerously-bypass-approvals-and-sandbox",
		])
			assert.ok(clap.has(flag), `clap ${flag}`);
		const commander = parseHelpFlags(COMMANDER_CLAUDE);
		for (const flag of [
			"--bg",
			"--background",
			"-p",
			"--print",
			"--effort",
			"--chrome",
			"--no-chrome",
		])
			assert.ok(commander.has(flag), `commander ${flag}`);
		const argparse = parseHelpFlags(ARGPARSE_VIBE);
		for (const flag of [
			"-p",
			"--prompt",
			"--output",
			"--auto-approve",
			"--yolo",
		])
			assert.ok(argparse.has(flag), `argparse ${flag}`);
	});

	it("ignores flags that are only named in prose or wrapped descriptions", () => {
		assert.equal(parseHelpFlags(COMMANDER_CLAUDE).has("--resume"), false);
		assert.equal(parseHelpFlags(CLAP_CODEX_EXEC).has("--model=o3"), false);
		assert.equal(parseHelpFlags("Use --variant to pick effort.\n").size, 0);
	});
});

describe("argvFlagUses", () => {
	it("scopes flags to the subcommand they follow", () => {
		const uses = argvFlagUses(
			[
				"codex",
				"-c",
				"model_reasoning_effort=high",
				"exec",
				"--model",
				"m",
				"-",
			],
			CLI_SUBCOMMANDS.codex,
		);
		assert.deepEqual(uses, [
			{ flag: "-c", scope: [], next: "model_reasoning_effort=high" },
			{ flag: "--model", scope: ["exec"], next: "m" },
		]);
	});

	it("skips values, prompts and the stdin dash", () => {
		const uses = argvFlagUses(
			[
				"opencode",
				"run",
				"--agent",
				"build",
				"--auto",
				"--model",
				"x",
				"- hi there",
				"-",
			],
			CLI_SUBCOMMANDS.opencode,
		);
		assert.deepEqual(
			uses.map((use) => `${use.scope.join(" ")} ${use.flag}`),
			["run --agent", "run --auto", "run --model"],
		);
	});

	it("strips =value from a flag", () => {
		assert.equal(argvFlagUses(["x", "--format=json"])[0].flag, "--format");
	});
});

describe("collectSwitchyardCallSites", () => {
	const sites = collectSwitchyardCallSites();

	it("captures a call site for every provider CLI", () => {
		const clis = new Set(sites.map((entry) => entry.cli));
		for (const cli of Object.values(HARNESS_BINARIES))
			assert.ok(clis.has(cli), `no call site for ${cli}`);
		for (const entry of sites) assert.equal(entry.argv[0], entry.cli);
	});

	it("includes every roster invocation_args template", () => {
		const flat = sites.map((entry) => entry.argv.join(" "));
		assert.ok(flat.some((argv) => /^claude .*--effort max/u.test(argv)));
		assert.ok(
			flat.some((argv) =>
				/^codex -c model_reasoning_effort=xhigh exec/u.test(argv),
			),
		);
		assert.ok(flat.some((argv) => /^opencode run .*--variant max/u.test(argv)));
	});

	it("covers each lane: adapters, auth probes, liveness, simple lane and both bridges", () => {
		const prefixes = new Set(sites.map((entry) => entry.site.split(":")[0]));
		for (const prefix of [
			"adapter",
			"auth-probe",
			"liveness",
			"simple",
			"simple-keyless-bridge",
			"opencode-api-key-bridge",
		])
			assert.ok(prefixes.has(prefix), `no ${prefix} sites`);
	});

	it("checks the simple lane's vendored OpenCode, not PATH opencode", () => {
		const keyless = sites.filter((entry) =>
			entry.site.startsWith("simple-keyless-bridge:opencode-go"),
		);
		assert.equal(keyless.length, 2);
		for (const entry of keyless) {
			assert.match(entry.binary, /\.tools\/opencode-v1\.18\.30\/opencode$/u);
			assert.equal(entry.pinnedVersion, "1.18.30");
			assert.ok(entry.argv.includes("--variant"));
		}
	});

	it("unwraps transport wrappers to the provider argv", () => {
		assert.deepEqual(
			providerArgvFrom([
				"sh",
				"-c",
				"script text",
				"sh",
				"60",
				"/x/bin/opencode",
				"run",
			]),
			["opencode", "run"],
		);
		assert.equal(providerArgvFrom(["/bin/bash", "-lc", "true"]), null);
	});
});

// A fake CLI runner: `help` maps "scope" -> help text; `strict` makes unknown
// flags (not in help, not in `hidden`) rejected the way clap and opencode 2.x
// reject them.
function fakeCli({ version, help, strict = false, hidden = [] }) {
	return (_binary, args) => {
		if (args.length === 1 && args[0] === "--version")
			return { text: `${version}\n`, status: 0, error: null };
		const scope = [];
		const flags = [];
		for (const arg of args.slice(0, -1))
			(arg.startsWith("-") ? flags : scope).push(arg);
		const key = scope
			.filter((part) => Object.hasOwn(help, [part].join(" ")))
			.join(" ");
		const known = parseHelpFlags(help[key] ?? "");
		const unknown = flags.find(
			(flag) => !known.has(flag) && !hidden.includes(flag),
		);
		if (strict && unknown)
			return {
				text: `Error: Unrecognized flag: ${unknown}\n`,
				status: 1,
				error: null,
			};
		return { text: help[key] ?? "", status: 0, error: null };
	};
}

const OPENCODE_2_RUN_HELP = `opencode run [message..]

Options:
  -h, --help         show help
  -v, --version      show version number
      --pure         run without external plugins
  -m, --model        model to use as provider/model[#variant]
      --agent        agent to use
      --auto         auto-approve permissions
      --format       default or json
`;

describe("checkFlagContract", () => {
	const installed = () => "/fake/bin/opencode";
	const opencodeSites = [
		{
			site: "agent-headless:opencode",
			cli: "opencode",
			argv: [
				"opencode",
				"run",
				"--agent",
				"plan",
				"--variant",
				"max",
				"--dir",
				"/w",
				"--model",
				"m",
			],
		},
		{
			site: "adapter:opencode:max",
			cli: "opencode",
			argv: [
				"opencode",
				"run",
				"--agent",
				"build",
				"--auto",
				"--variant",
				"max",
				"--model",
				"m",
				"PROMPT",
			],
		},
	];

	it("fails loud on the 2026-10-02 opencode 2.x drift (--variant and --dir removed)", () => {
		const report = checkFlagContract(opencodeSites, {
			resolve: installed,
			run: fakeCli({
				version: "2.0.20",
				help: { run: OPENCODE_2_RUN_HELP },
				strict: true,
			}),
		});
		assert.equal(report.ok, false);
		const [result] = report.results;
		assert.equal(result.status, "drift");
		assert.equal(result.version, "2.0.20");
		assert.deepEqual(
			result.violations.map((violation) => [violation.flag, violation.sites]),
			[
				["--variant", ["adapter:opencode:max", "agent-headless:opencode"]],
				["--dir", ["agent-headless:opencode"]],
			],
		);
		const text = formatFlagContractReport(report);
		assert.match(
			text,
			/FLAG-CONTRACT FAIL opencode 2\.0\.20: "opencode run --help" does not list --variant \(used by adapter:opencode:max, agent-headless:opencode; \/fake\/bin\/opencode\)/u,
		);
	});

	it("passes the same call sites against opencode 1.18.30", () => {
		const report = checkFlagContract(opencodeSites, {
			resolve: installed,
			run: fakeCli({ version: "1.18.30", help: { run: YARGS_OPENCODE_1 } }),
		});
		assert.equal(report.ok, true, formatFlagContractReport(report));
	});

	it("accepts a hidden flag only when a strict parser vouches for it", () => {
		const sites = [
			{
				site: "simple:copilot",
				cli: "copilot",
				argv: ["copilot", "--sandbox", "-p", "x"],
			},
		];
		const help = { "": "Options:\n  -p, --prompt <text>  prompt\n" };
		const strict = checkFlagContract(sites, {
			resolve: () => "/fake/copilot",
			run: fakeCli({
				version: "1.0.89",
				help,
				strict: true,
				hidden: ["--sandbox"],
			}),
		});
		assert.equal(strict.ok, true);
		assert.match(
			strict.results[0].notes[0],
			/--sandbox is not in --help but the parser accepts it/u,
		);
		// A lenient parser ignores unknown flags, so its silence proves nothing.
		const lenient = checkFlagContract(sites, {
			resolve: () => "/fake/copilot",
			run: fakeCli({ version: "1.0.89", help, hidden: ["--sandbox"] }),
		});
		assert.equal(lenient.ok, false);
		assert.equal(lenient.results[0].violations[0].flag, "--sandbox");
	});

	it("skips an absent CLI by default and fails it under --strict", () => {
		const sites = [{ site: "s", cli: "agy", argv: ["agy", "--print", "x"] }];
		const missing = {
			resolve: () => null,
			run: () => assert.fail("must not run"),
		};
		assert.equal(checkFlagContract(sites, missing).ok, true);
		const strict = checkFlagContract(sites, { ...missing, strict: true });
		assert.equal(strict.ok, false);
		assert.equal(strict.results[0].status, "not_installed");
	});

	it("fails when --help lists nothing at all", () => {
		const report = checkFlagContract(
			[{ site: "s", cli: "agy", argv: ["agy", "--print", "x"] }],
			{
				resolve: () => "/fake/agy",
				run: () => ({ text: "", status: 1, error: null }),
			},
		);
		assert.equal(report.ok, false);
		assert.equal(report.results[0].status, "help_unavailable");
	});

	it("notes a vendored pin that differs from the version checked", () => {
		const report = checkFlagContract(
			[
				{
					site: "simple-keyless-bridge:opencode-go:max",
					cli: "opencode",
					binary: "/v/opencode",
					pinnedVersion: "1.18.30",
					argv: ["opencode", "run", "--pure"],
				},
			],
			{
				binOverrides: { opencode: "/candidate/opencode" },
				resolve: (path) => path,
				run: fakeCli({ version: "1.18.34", help: { run: YARGS_OPENCODE_1 } }),
			},
		);
		assert.equal(report.results[0].binary, "/candidate/opencode");
		assert.match(
			report.results[0].notes[0],
			/pins opencode 1\.18\.30; checked 1\.18\.34/u,
		);
	});
});
