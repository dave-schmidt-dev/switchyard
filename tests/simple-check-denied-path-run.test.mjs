// @test-phase: other
import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	isPersistentFailureDetails,
	sanitizeFailureDetails,
} from "../src/switchyard/adapter/exec-error.mjs";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import {
	appendFailureRecord,
	readFailureRecords,
} from "../src/switchyard/simple/failure-log.mjs";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { failureAttemptRecord } from "../src/switchyard/simple/routing-stop-record.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-denied-path-run-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function repoFixture() {
	const root = tempDir("switchyard-denied-path-repo-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "."]);
	git(projectPath, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	// Outside every checker grant: only the checker's clone and runtime are
	// writable.
	return { root, projectPath, promptPath, outside: join(root, "outside.txt") };
}

async function run(repo, checks) {
	let providerCalls = 0;
	const result = await runSimpleTask(
		{
			root: repo.root,
			projectPath: repo.projectPath,
			promptPath: repo.promptPath,
			capability: "standard",
			files: ["a.txt"],
			checks,
			deadlineMs: Date.now() + 180_000,
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
				providerCalls += 1;
				writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
	return { result, providerCalls };
}

function loggedAttempt(result) {
	const stateRoot = tempDir("switchyard-denied-path-log-");
	appendFailureRecord(
		failureAttemptRecord({
			project: "/review/project",
			routingRunId: "routing-1",
			attempt: {
				taskId: result.taskId,
				attemptId: result.attemptId,
				runId: result.runId,
				targetId: "codex",
				capability: "standard",
			},
			result,
			accountability: result.accountability,
			classification: classifyAttemptFailure({
				result,
				accountability: result.accountability,
			}),
		}),
		{ stateRoot },
	);
	return readFailureRecords({ stateRoot })[0];
}

test("the persisted denied path is an absolute path bounded like other references", () => {
	const deep = `/${"d".repeat(400)}/out`;
	strictEqual(
		sanitizeFailureDetails({ sandboxDeniedPath: deep })?.sandboxDeniedPath,
		deep,
	);
	ok(isPersistentFailureDetails({ sandboxDeniedPath: deep }));
	strictEqual(sanitizeFailureDetails({ sandboxDeniedPath: "out" }), null);
	strictEqual(
		sanitizeFailureDetails({ sandboxDeniedPath: `/${"d".repeat(1024)}` }),
		null,
	);
});

test("a dry-run check denied a write names the path in the result, run record and failure log", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = repoFixture();
	const { result, providerCalls } = await run(repo, [
		`sh -c 'echo x > ${repo.outside}'`,
	]);
	strictEqual(providerCalls, 0);
	strictEqual(result.failureReason, "check_environment_failed");
	strictEqual(existsSync(repo.outside), false);
	strictEqual(
		result.failureDetails.checkEnvironmentSignature,
		"sandbox_denial",
	);
	strictEqual(result.failureDetails.sandboxDeniedPath, repo.outside);
	const record = await readRun(result.runId);
	strictEqual(record.failureDetails.sandboxDeniedPath, repo.outside);
	ok(isPersistentFailureDetails(record.failureDetails));
	strictEqual(loggedAttempt(result).sandboxDeniedPath, repo.outside);
});

test("a check denied a write only after the provider still names the path", {
	skip: nestedSandboxSkip,
}, async () => {
	const repo = repoFixture();
	const { result, providerCalls } = await run(repo, [
		`sh -c 'grep -q base a.txt || echo x > ${repo.outside}'`,
	]);
	strictEqual(providerCalls, 1);
	// Post-provider message text never proves an environment fault, so the
	// failure keeps its ordinary code and only gains the evidence.
	strictEqual(result.failureReason, "check_failed");
	strictEqual(result.failureDetails.sandboxDeniedPath, repo.outside);
	strictEqual(
		(await readRun(result.runId)).failureDetails.sandboxDeniedPath,
		repo.outside,
	);
	strictEqual(loggedAttempt(result).sandboxDeniedPath, repo.outside);
});
