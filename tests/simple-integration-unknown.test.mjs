// @test-phase: other
// A diff refused as `integration_state_unknown` names the `git apply` metadata
// step that was unknown and how it failed, in the result, run.json and the
// failure-log attempt record (BUG_REPORTS/2026-10-15, section 2).
import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { sanitizeFailureDetails } from "../src/switchyard/adapter/exec-error.mjs";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import {
	appendFailureRecord,
	readFailureRecords,
} from "../src/switchyard/simple/failure-log.mjs";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { failureAttemptRecord } from "../src/switchyard/simple/routing-stop-record.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const suite = tempDir("switchyard-integration-unknown-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function fixture() {
	const root = tempDir("switchyard-integration-unknown-repo-");
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

// Every `git apply --summary` exits nonzero with no diagnostic, the shape that
// leaves the integration state unknown with no path to name.
async function runWithFailingSummary() {
	const repo = fixture();
	const cp = createRequire(import.meta.url)("node:child_process");
	const original = cp.spawnSync;
	cp.spawnSync = (command, args, options) =>
		command === "git" && args?.includes("apply") && args.includes("--summary")
			? { status: 1, signal: null, stdout: "", stderr: "" }
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

test("integration_state_unknown names the unknown metadata step in the result, run.json and failure log", async () => {
	const result = await runWithFailingSummary();
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "unsafe_diff");
	strictEqual(result.diffRejection.rule, "integration_state_unknown");
	strictEqual(result.diffRejection.unknownStep, "summary");
	strictEqual(result.diffRejection.unknownCause, "exit_nonzero");
	strictEqual(result.failureDetails.diffRejectionUnknownStep, "summary");
	strictEqual(result.failureDetails.diffRejectionUnknownCause, "exit_nonzero");

	const run = await readRun(result.runId);
	strictEqual(
		run.failureDetails.diffRejectionRule,
		"integration_state_unknown",
	);
	strictEqual(run.failureDetails.diffRejectionUnknownStep, "summary");
	strictEqual(run.failureDetails.diffRejectionUnknownCause, "exit_nonzero");

	const stateRoot = tempDir("switchyard-integration-unknown-log-");
	const classification = classifyAttemptFailure({
		result,
		accountability: result.accountability,
	});
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
	ok(record, "the attempt record was written");
	strictEqual(record.diffRejectionRule, "integration_state_unknown");
	strictEqual(record.diffRejectionUnknownStep, "summary");
	strictEqual(record.diffRejectionUnknownCause, "exit_nonzero");
});

test("an unknown step or cause outside the closed sets is dropped at both boundaries", () => {
	const valid = {
		diffRejectionUnknownStep: "numstat",
		diffRejectionUnknownCause: "timeout",
	};
	const invalid = {
		diffRejectionUnknownStep: "not_a_step",
		diffRejectionUnknownCause: "not_a_cause",
	};
	strictEqual(
		JSON.stringify(sanitizeFailureDetails({ failureReason: "x", ...valid })),
		JSON.stringify({ failureReason: "x", ...valid }),
	);
	strictEqual(
		JSON.stringify(sanitizeFailureDetails({ failureReason: "x", ...invalid })),
		JSON.stringify({ failureReason: "x" }),
	);

	const stateRoot = tempDir("switchyard-integration-unknown-closed-");
	for (const fields of [valid, invalid])
		appendFailureRecord({ recordType: "attempt", ...fields }, { stateRoot });
	const [kept, dropped] = readFailureRecords({ stateRoot });
	strictEqual(kept.diffRejectionUnknownStep, "numstat");
	strictEqual(kept.diffRejectionUnknownCause, "timeout");
	strictEqual(dropped.diffRejectionUnknownStep, null);
	strictEqual(dropped.diffRejectionUnknownCause, null);
});
