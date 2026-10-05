import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { getRunRoot } from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-failure-evidence-tests-");
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

function fixture() {
	const root = tempDir("switchyard-failure-evidence-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	git(projectPath, ["init", "-q"]);
	commit(projectPath);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

function run(repo, options = {}, provider = null, extra = {}) {
	return runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["test -f a.txt"],
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
			executeProvider: async (context) => {
				if (provider) return provider(context);
				writeFileSync(join(context.worktreePath, "a.txt"), "candidate\n");
				return { success: true, writerLifecycle: "stopped" };
			},
			...extra,
		},
	);
}

const stubbedCheck = async () => ({
	success: true,
	writerLifecycle: "stopped",
});

test("failing acceptance check retains a bounded owner-only output tail", async () => {
	const repo = fixture();
	const stdoutTail = "STDOUT_TAIL";
	const stderrTail = "STDERR_TAIL";
	const command = `node -e 'const fs=require("fs");fs.writeSync(1,Buffer.alloc(20000,120));fs.writeSync(1,"${stdoutTail}");fs.writeSync(2,Buffer.alloc(20000,121));fs.writeSync(2,"${stderrTail}");process.exit(3)'`;
	const result = await run(repo, { checks: [command] });
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "check_failed");
	const entry = result.checks[0];
	strictEqual(entry.status, "failed");
	strictEqual(entry.exitCode, 3);
	ok(
		entry.outputPath,
		"failed acceptance check result carries an evidence path",
	);
	const evidenceDir = join(getRunRoot(result.runId), "check-evidence");
	strictEqual(dirname(entry.outputPath), evidenceDir);
	strictEqual(basename(entry.outputPath), "1-1.log");
	strictEqual(statSync(evidenceDir).mode & 0o777, 0o700);
	const stats = statSync(entry.outputPath);
	strictEqual(stats.mode & 0o777, 0o600);
	strictEqual(stats.size, 32 * 1024);
	const content = readFileSync(entry.outputPath);
	ok(
		content.equals(
			Buffer.concat([
				Buffer.concat([Buffer.alloc(16373, 0x78), Buffer.from(stdoutTail)]),
				Buffer.concat([Buffer.alloc(16373, 0x79), Buffer.from(stderrTail)]),
			]),
		),
		"only the last 16 KiB of each stream is retained",
	);
	const serialized = JSON.stringify(result);
	ok(!serialized.includes(stdoutTail), "result never carries the check stdout");
	ok(!serialized.includes(stderrTail), "result never carries the check stderr");
	const eventsPath = join(getRunRoot(result.runId), "events.jsonl");
	if (existsSync(eventsPath)) {
		const events = readFileSync(eventsPath, "utf8");
		ok(!events.includes(stdoutTail), "events never carry the check stdout");
		ok(!events.includes(stderrTail), "events never carry the check stderr");
	}
});

test("failing baseline check retains evidence outside the result checks", async () => {
	const repo = fixture();
	const command = `node -e 'const fs=require("fs");fs.writeSync(1,"BASELINE_TAIL");process.exit(2)'`;
	const result = await run(repo, { baselineChecks: [command] });
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "baseline_check_failed");
	strictEqual(result.checks.length, 0);
	const evidenceDir = join(getRunRoot(result.runId), "check-evidence");
	strictEqual(statSync(evidenceDir).mode & 0o777, 0o700);
	strictEqual(readdirSync(evidenceDir).sort().join(","), "0-1.log");
	const evidencePath = join(evidenceDir, "0-1.log");
	strictEqual(statSync(evidencePath).mode & 0o777, 0o600);
	ok(readFileSync(evidencePath, "utf8").includes("BASELINE_TAIL"));
});

test("scope rejection reports the offending undeclared paths", async () => {
	const repo = fixture();
	const result = await run(
		repo,
		{},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			writeFileSync(join(worktreePath, "extra.txt"), "extra\n");
			return { success: true, writerLifecycle: "stopped" };
		},
		{ runCheck: stubbedCheck },
	);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "undeclared_paths_changed");
	strictEqual(result.diffRejection.rule, "undeclared_paths_changed");
	ok(result.diffRejection.paths.includes("extra.txt"));
	ok(result.diffRejection.paths.length <= 5);
});

test("validateDiff rejection reports a closed rule for an unsafe declared change", async () => {
	const repo = fixture();
	const result = await run(
		repo,
		{},
		async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
			chmodSync(join(worktreePath, "a.txt"), 0o755);
			return { success: true, writerLifecycle: "stopped" };
		},
		{ runCheck: stubbedCheck },
	);
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "unsafe_diff");
	strictEqual(result.diffRejection.rule, "executable_file_refused");
	ok(Array.isArray(result.diffRejection.paths));
	ok(result.diffRejection.paths.length <= 5);
});
