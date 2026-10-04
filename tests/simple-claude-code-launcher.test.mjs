import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	claudeCodeArgs,
	claudeCodeDiagnostic,
	claudeCodeEnvironment,
	claudeCodeSeatbeltProfile,
	parseLauncherArgs,
	runClaudeCode,
} from "../ops/simple-claude-code-launcher.mjs";

function setup() {
	const root = join(
		realpathSync(tmpdir()),
		`switchyard-simple-${randomUUID()}`,
	);
	const worktree = join(root, "worktree");
	mkdirSync(join(worktree, ".git"), { recursive: true });
	writeFileSync(join(root, ".switchyard-cleanup-owner.json"), "{}\n");
	const keychains = join(root, "keychains");
	mkdirSync(keychains);
	return {
		root,
		worktree,
		keychains,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

// Per-run runtimes left beside the worktree; every path must remove its own.
function runtimes(root) {
	return readdirSync(root).filter((name) =>
		name.startsWith(".switchyard-claudecode-"),
	);
}

function fakeExecutable(path, output, code = 0) {
	writeFileSync(
		path,
		`#!/bin/sh
cat >/dev/null
printf '%s' '${output.replaceAll("'", "'\\''")}'
exit ${code}
`,
		{ mode: 0o755 },
	);
}

test("Claude launcher validates its fixed arguments", () => {
	const item = setup();
	try {
		assert.deepEqual(
			parseLauncherArgs([
				"--model",
				"claude-haiku-4-5-20251001",
				"--effort",
				"high",
				"--worktree",
				item.worktree,
			]),
			{
				model: "claude-haiku-4-5-20251001",
				effort: "high",
				worktree: item.worktree,
			},
		);
		for (const args of [
			["--model", "other", "--effort", "high", "--worktree", item.worktree],
			[
				"--model",
				"claude-opus-5-5",
				"--effort",
				"other",
				"--worktree",
				item.worktree,
			],
			[
				"--model",
				"claude-opus-5-5",
				"--model",
				"claude-sonnet-5-5",
				"--worktree",
				item.worktree,
			],
			[
				"--model",
				"claude-opus-5-5",
				"--effort",
				"high",
				"--worktree",
				tmpdir(),
			],
		])
			assert.throws(() => parseLauncherArgs(args));
	} finally {
		item.cleanup();
	}
});

test("Claude arguments, environment, and profile are restricted", () => {
	assert.deepEqual(
		claudeCodeArgs({ model: "claude-opus-5-5", effort: "max" }),
		[
			"-p",
			"--model",
			"claude-opus-5-5",
			"--effort",
			"max",
			"--restricted",
			"--tools",
			"Read,Edit,Write,Glob,Grep",
			"--disallowedTools",
			"Bash,WebFetch,WebSearch,Agent,mcp__*",
			"--strict-mcp-config",
			"--permission-mode",
			"acceptEdits",
			"--permission-prompts",
			"none",
			"--no-session-persistence",
			"--disable-slash-commands",
			"--output-format",
			"json",
		],
	);
	const env = claudeCodeEnvironment("/r");
	assert.equal(
		Object.keys(env).some((key) =>
			/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|AWS_)/u.test(key),
		),
		false,
	);
	assert.equal(env.HOME, "/r/home");
	const profile = claudeCodeSeatbeltProfile({
		worktree: "/w",
		runtime: "/r",
		keychains: "/k",
		cliRoot: "/cli",
	});
	assert.match(profile, /\(subpath "\/cli"\)/u);
	assert.match(profile, /file-write\* \(subpath "\/w"\) \(subpath "\/r"\)/u);
	assert.doesNotMatch(profile, /file-write\* .*?\(subpath "\/cli"\)/u);
});

test("runClaudeCode verifies JSON model usage, diagnostics, and cleanup", async () => {
	const item = setup();
	const sandbox = join(item.root, "sandbox");
	const fake = join(item.root, "fake-claude");
	writeFileSync(sandbox, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
	try {
		fakeExecutable(
			fake,
			'{"type":"result","is_error":false,"modelUsage":{"claude-opus-5-5":{}},"result":"ok"}',
		);
		const result = await runClaudeCode({
			model: "claude-opus-5-5",
			effort: "high",
			worktree: item.worktree,
			prompt: "task",
			cliPath: fake,
			cliRoot: item.root,
			keychains: item.keychains,
			sandboxExec: sandbox,
		});
		assert.equal(result.code, 0);
		assert.deepEqual(runtimes(item.root), []);
		fakeExecutable(
			fake,
			'{"type":"result","is_error":false,"modelUsage":{"other":{}},"result":"bad"}',
		);
		await assert.rejects(
			runClaudeCode({
				model: "claude-opus-5-5",
				effort: "high",
				worktree: item.worktree,
				prompt: "task",
				cliPath: fake,
				cliRoot: item.root,
				keychains: item.keychains,
				sandboxExec: sandbox,
			}),
			/requested model/,
		);
		assert.deepEqual(runtimes(item.root), []);
		fakeExecutable(
			fake,
			'{"type":"result","is_error":true,"subtype":"rate_limit","api_error_status":429,"result":"usage limit"}',
			1,
		);
		const error = await runClaudeCode({
			model: "claude-opus-5-5",
			effort: "high",
			worktree: item.worktree,
			prompt: "task",
			cliPath: fake,
			cliRoot: item.root,
			keychains: item.keychains,
			sandboxExec: sandbox,
		});
		assert.equal(error.code, 76);
		assert.equal(
			error.stderr,
			"SWITCHYARD_CLAUDE_CODE_DIAG_V1 subtype=rate_limit api_status=429 limit=1\n",
		);
		assert.deepEqual(runtimes(item.root), []);
	} finally {
		item.cleanup();
	}
});

test("Claude diagnostics fail closed", () => {
	assert.deepEqual(
		claudeCodeDiagnostic({ subtype: "x", api_error_status: 401, result: "" }),
		{ subtype: "x", apiStatus: 401, limit: false },
	);
	assert.deepEqual(
		claudeCodeDiagnostic({
			subtype: "bad subtype",
			api_error_status: 99,
			result: "hit your limit",
		}),
		{ subtype: "unknown", apiStatus: null, limit: true },
	);
});
