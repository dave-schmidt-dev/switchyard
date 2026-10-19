// @test-phase: other
// A simple attempt whose diff capture fails in host git ends with the closed
// cause `diff_capture_failed` (category environment) in the result,
// run.json's lastFailure and the failure-log attempt record, instead of an
// unclassified `unknown` cause.
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { resolveFailure } from "../src/switchyard/diagnostics/failure-registry.mjs";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import {
	appendFailureRecord,
	readFailureRecords,
} from "../src/switchyard/simple/failure-log.mjs";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { failureAttemptRecord } from "../src/switchyard/simple/routing-stop-record.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-diff-capture-failure-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function fixture() {
	const root = tempDir("switchyard-diff-capture-failure-repo-");
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
	return { root, projectPath, promptPath };
}

// After the provider has run, the first worktree `git add -A` is the diff
// capture's staging step; it exits nonzero as a broken host git would.
async function runWithFailingCapture() {
	const repo = fixture();
	const cp = createRequire(import.meta.url)("node:child_process");
	const original = cp.spawnSync;
	let providerRan = false;
	cp.spawnSync = (command, args, options) =>
		providerRan &&
		command === "git" &&
		args?.includes("--work-tree") &&
		args.includes("add") &&
		args.includes("-A")
			? { status: 128, signal: null, stdout: "", stderr: "fatal: fixture\n" }
			: original(command, args, options);
	syncBuiltinESMExports();
	try {
		return await runSimpleTask(
			{
				...repo,
				capability: "standard",
				files: ["a.txt"],
				checks: ["test -f a.txt"],
				deadlineMs: Date.now() + 120_000,
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
					writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
					providerRan = true;
					return { success: true, writerLifecycle: "stopped" };
				},
				runCheck: async () => ({ success: true, exitCode: 0 }),
			},
		);
	} finally {
		cp.spawnSync = original;
		syncBuiltinESMExports();
	}
}

test("every diff-capture reason resolves to the closed environment cause", () => {
	for (const reason of [
		"diff_stage_failed",
		"diff_names_failed",
		"diff_capture_failed",
	]) {
		const resolved = resolveFailure({ reason, phase: "diff" });
		strictEqual(resolved.causeCode, "diff_capture_failed", reason);
		strictEqual(resolved.causeCategory, "environment", reason);
		strictEqual(resolved.errorKind, "environment_failure", reason);
	}
});

test("a diff-capture git failure carries diff_capture_failed in the result, lastFailure and failure log", async () => {
	const result = await runWithFailingCapture();
	strictEqual(result.status, "failed");
	strictEqual(result.failurePhase, "diff");
	strictEqual(result.failureReason, "diff_stage_failed");
	strictEqual(result.errorKind, "environment_failure");
	strictEqual(result.providerReliability.causeCode, "diff_capture_failed");
	strictEqual(result.providerReliability.causeCategory, "environment");

	const run = await readRun(result.runId);
	strictEqual(run.failureDetails.failureReason, "diff_stage_failed");
	strictEqual(run.lastFailure.errorKind, "environment_failure");
	strictEqual(run.lastFailure.reasonCode, "environment_failure");
	strictEqual(
		run.lastFailure.providerReliability.causeCode,
		"diff_capture_failed",
	);

	const stateRoot = tempDir("switchyard-diff-capture-failure-log-");
	const classification = classifyAttemptFailure({
		result,
		accountability: result.accountability,
	});
	strictEqual(classification.reason, "environment_failure");
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
			classification,
		}),
		{ stateRoot },
	);
	const [record] = readFailureRecords({ stateRoot });
	strictEqual(record.reason, "environment_failure");
	strictEqual(record.causeCode, "diff_capture_failed");
	strictEqual(record.causeCategory, "environment");
	strictEqual(record.failureReason, "diff_stage_failed");
});
