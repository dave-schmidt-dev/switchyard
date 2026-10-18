// @test-phase: other
import { deepStrictEqual, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCodeArgs } from "../ops/simple-claude-code-launcher.mjs";
import { vibeCodeArgs } from "../ops/simple-vibe-code-launcher.mjs";
import {
	CLI_CONTRACTS,
	cliContractForTarget,
} from "../src/switchyard/cli-contract/canary.mjs";
import { argvFlags } from "../src/switchyard/cli-contract/help-flags.mjs";
import { buildSimpleProviderInvocation } from "../src/switchyard/simple/provider-invocation.mjs";
import { SIMPLE_TARGET_ADAPTERS } from "../src/switchyard/simple/target-adapters.mjs";
import {
	runFake,
	seatbeltBlocked,
	setup,
} from "./helpers/keyless-bridge-fixtures.mjs";

const PROMPT = "a prompt with spaces";
const WORKTREE = "/tmp/worktree";

/**
 * Every flag `argv` passes must be one the CLI's contract row requires, for
 * the row's own scope or, given `scope`, the matching extra subcommand.
 */
function assertCovered(cli, argv, scope = null) {
	const row = CLI_CONTRACTS.find((candidate) => candidate.cli === cli);
	ok(row, `${cli} has no contract row`);
	const sub = row.subcommands?.find((item) => item.scope.join(" ") === scope);
	ok(scope === null || sub, `${cli} row does not check ${scope}`);
	const required = new Set(
		sub ? sub.flags : [...row.flags, ...row.hiddenFlags],
	);
	const uncovered = argvFlags(argv).filter((flag) => !required.has(flag));
	deepStrictEqual(uncovered, [], `${cli} passes flags its canary never checks`);
}

test("every simple target adapter maps to the contract row of the CLI it execs", () => {
	const expected = {
		codex: "codex",
		antigravity: "agy",
		"antigravity-claude": "agy",
		"copilot-student": "copilot",
		"claude-code": "claude",
		vibe: "vibe",
		"vibe-code": "vibe",
		"opencode-go": "opencode",
	};
	deepStrictEqual(
		Object.fromEntries(
			SIMPLE_TARGET_ADAPTERS.map((adapter) => [
				adapter.targetId,
				cliContractForTarget(adapter.targetId)?.cli ?? null,
			]),
		),
		expected,
	);
});

test("the canary checks every flag the in-process argv builders emit", () => {
	const codex = buildSimpleProviderInvocation(
		"codex",
		{
			target_id: "codex",
			selector: "gpt-5.3-codex-spark",
			invocation_args: ["-c", "model_reasoning_effort=low"],
		},
		PROMPT,
		WORKTREE,
		"codex",
	);
	// The scope subcommand is not a flag; the rest must all be checked.
	deepStrictEqual(codex.args.slice(0, 1), ["exec"]);
	assertCovered("codex", codex.args);
	for (const [targetId, selector] of [
		["antigravity", "gemini-3.8-flash-medium"],
		["antigravity-claude", "claude-sonnet-4-6"],
	])
		assertCovered(
			"agy",
			buildSimpleProviderInvocation(
				"agy",
				{ target_id: targetId, selector },
				PROMPT,
				WORKTREE,
				targetId,
			).args,
		);
	assertCovered(
		"copilot",
		buildSimpleProviderInvocation(
			"copilot",
			{ target_id: "copilot-student", selector: "auto" },
			PROMPT,
			WORKTREE,
			"copilot-student",
		).args,
	);
	assertCovered(
		"claude",
		claudeCodeArgs({ model: "claude-sonnet-5-5", effort: "medium" }),
	);
	assertCovered("vibe", vibeCodeArgs(WORKTREE));
});

for (const [target, cli] of [
	["vibe", "vibe"],
	["opencode-go", "opencode"],
])
	test(`the canary checks every flag the keyless bridge passes ${cli}`, async (t) => {
		if (seatbeltBlocked()) {
			t.skip("host Seatbelt unavailable under outer sandbox");
			return;
		}
		const item = setup();
		const lines = (file) =>
			readFileSync(join(item.worktree, file), "utf8")
				.split("\n")
				.filter((line) => line !== "");
		try {
			await runFake(item, `printf '%s\\n' "$@" > argv.txt`, { target });
			const argv = lines("argv.txt");
			ok(argv.length > 0, `${target} bridge passed no argv`);
			assertCovered(cli, argv);
			if (target === "opencode-go") {
				const serve = lines("serve-argv.txt");
				deepStrictEqual(serve[0], "serve");
				assertCovered(cli, serve, "serve");
			}
		} finally {
			item.cleanup();
		}
	});
