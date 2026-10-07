import { strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSimpleArgs } from "../src/switchyard/simple/args.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-format-step-tests-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function commit(path) {
	git(path, ["add", "."]);
	git(path, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
}

// The formatter trims the candidate and rewrites it upper-cased with one
// newline; the check accepts only that exact formatted shape.
const FORMAT_SCRIPT = [
	'import { readFileSync, writeFileSync } from "node:fs";',
	'const value = readFileSync("a.txt", "utf8").trim();',
	'writeFileSync("a.txt", value.toUpperCase() + "\\n");',
	"",
].join("\n");
const CHECK_SCRIPT = [
	'import { readFileSync } from "node:fs";',
	'if (readFileSync("a.txt", "utf8") !== "CANDIDATE\\n") process.exit(1);',
	"",
].join("\n");
const MANIFEST_SCRIPT = [
	'import { writeFileSync } from "node:fs";',
	'writeFileSync("package.json", \'{"name":"injected"}\\n\');',
	"",
].join("\n");

function fixture({ formatScript = FORMAT_SCRIPT } = {}) {
	const root = tempDir("switchyard-format-step-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	writeFileSync(join(projectPath, "verify-format.mjs"), CHECK_SCRIPT);
	writeFileSync(join(projectPath, "apply-format.mjs"), formatScript);
	git(projectPath, ["init", "-q"]);
	commit(projectPath);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

function dispatch(repo, options = {}) {
	return runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["node verify-format.mjs"],
			deadlineMs: Date.now() + 180_000,
			...options,
		},
		{
			tmpdir: repo.root,
			route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
			resolveTargetIdentity: () => ({
				targetId: "codex",
				harnessKey: "codex",
				ambiguous: false,
			}),
			getInvocationDescriptor: () => ({
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: [],
			}),
			assertFundedRoute: () => {},
			executeProvider: async ({ worktreePath }) => {
				writeFileSync(join(worktreePath, "a.txt"), "candidate");
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
}

test("--format rewrites a format-only candidate before checks and integration", async () => {
	const repo = fixture();
	const result = await dispatch(repo, { format: "node apply-format.mjs" });
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	strictEqual(result.formatStatus, "passed");
	strictEqual(result.changedFiles.join(","), "a.txt");
	strictEqual(
		readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
		"CANDIDATE\n",
	);
});

test("a nonzero format exit is advisory and still lands the formatted bytes", async () => {
	const repo = fixture({
		formatScript: `${FORMAT_SCRIPT}process.exit(1);\n`,
	});
	const result = await dispatch(repo, { format: "node apply-format.mjs" });
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	strictEqual(result.formatStatus, "failed");
	strictEqual(
		readFileSync(join(repo.projectPath, "a.txt"), "utf8"),
		"CANDIDATE\n",
	);
});

test("a format edit to an undeclared ineligible path fails closed", async () => {
	const repo = fixture({ formatScript: MANIFEST_SCRIPT });
	const result = await dispatch(repo, { format: "node apply-format.mjs" });
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "undeclared_paths_changed");
	strictEqual(result.failurePhase, "diff");
	strictEqual(result.formatStatus, "passed");
	strictEqual(readFileSync(join(repo.projectPath, "a.txt"), "utf8"), "base\n");
	strictEqual(existsSync(join(repo.projectPath, "package.json")), false);
});

test("parseSimpleArgs accepts one bounded --format and rejects unsafe or repeated commands", () => {
	const repo = fixture();
	const deadline = new Date(Date.now() + 120_000).toISOString();
	const base = [
		repo.promptPath,
		"--project",
		repo.projectPath,
		"--capability",
		"standard",
		"--file",
		"a.txt",
		"--check",
		"node verify-format.mjs",
		"--deadline",
		deadline,
	];
	const parsed = parseSimpleArgs([
		...base,
		"--format",
		"node apply-format.mjs",
	]);
	strictEqual(parsed.format, "node apply-format.mjs");
	strictEqual(parseSimpleArgs(base).format, null);
	throws(
		() =>
			parseSimpleArgs([
				...base,
				"--format",
				"node apply-format.mjs",
				"--format",
				"node apply-format.mjs",
			]),
		/--format requires one non-empty bounded command/,
	);
	throws(
		() => parseSimpleArgs([...base, "--format", "node -e $(pwd)"]),
		/unsupported shell grammar/,
	);
});
