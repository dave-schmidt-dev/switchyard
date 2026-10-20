// @test-phase: other
// The hold flag, the routing-run apply command, inspect's held view, the
// check-only integration gate and a real sandboxed recheck at a moved HEAD.
import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import { readRun } from "../src/switchyard/run-store/run-records.mjs";
import {
	parseSimpleArgs,
	SIMPLE_USAGE,
} from "../src/switchyard/simple/args.mjs";
import { applyHeldIntegration } from "../src/switchyard/simple/held-apply.mjs";
import { inspectHeldIntegrations } from "../src/switchyard/simple/held-integration.mjs";
import { handleRoutingRun } from "../src/switchyard/simple/routing-cli.mjs";
import {
	commit,
	git,
	heldFixture,
	runHeld,
} from "./helpers/held-integration-fixtures.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("switchyard-held-cli-store-"),
	"runs",
);

function argv(repo, ...extra) {
	return [
		repo.promptPath,
		"--project",
		repo.projectPath,
		"--capability",
		"standard",
		"--file",
		"a.txt",
		"--check",
		"true",
		"--timeout",
		"5",
		...extra,
	];
}

test("--integrate parses hold and apply and refuses other values and modes", () => {
	const repo = heldFixture();
	strictEqual(parseSimpleArgs(argv(repo)).integrateMode, "apply");
	strictEqual(
		parseSimpleArgs(argv(repo, "--integrate", "hold")).integrateMode,
		"hold",
	);
	throws(
		() => parseSimpleArgs(argv(repo, "--integrate", "later")),
		/--integrate must be apply or hold/,
	);
	throws(
		() => parseSimpleArgs(argv(repo, "--integrate", "hold", "--dirty-overlay")),
		/mutually exclusive with --dirty-overlay/,
	);
	throws(
		() =>
			parseSimpleArgs([
				repo.promptPath,
				"--project",
				repo.projectPath,
				"--capability",
				"standard",
				"--report",
				"r.md",
				"--integrate",
				"hold",
				"--timeout",
				"5",
			]),
		/mutually exclusive with --report/,
	);
	ok(SIMPLE_USAGE.includes("--integrate <apply|hold>"));
	ok(SIMPLE_USAGE.includes("routing-run apply --run-id"));
});

test("the check-only gate verifies without writing and reports a conflict", () => {
	const repo = heldFixture();
	const diff = [
		"diff --git a/a.txt b/a.txt",
		"--- a/a.txt",
		"+++ b/a.txt",
		"@@ -1 +1 @@",
		"-base",
		"+candidate",
		"",
	].join("\n");
	const verified = integrationGate(diff, repo.projectPath, {
		allowedPaths: ["a.txt"],
		checkOnly: true,
	});
	deepStrictEqual(verified, {
		success: true,
		message: "Diff verified",
		checkOnly: true,
	});
	strictEqual(readFileSync(join(repo.projectPath, "a.txt"), "utf8"), "base\n");
	writeFileSync(join(repo.projectPath, "a.txt"), "moved\n");
	const conflict = integrationGate(diff, repo.projectPath, {
		allowedPaths: ["a.txt"],
		checkOnly: true,
	});
	strictEqual(conflict.success, false);
	strictEqual(conflict.message, "Diff apply failed");
	strictEqual(conflict.reasonKind, "conflict");
	const scope = integrationGate(diff, repo.projectPath, {
		allowedPaths: ["b.txt"],
		checkOnly: true,
	});
	strictEqual(scope.message, "undeclared_paths_touched");
});

test("routing-run apply prints one result, reports progress and exits 1 on refusal", async () => {
	const repo = heldFixture();
	const result = await runHeld(repo);
	const io = () => {
		const out = { lines: [], progress: [], signalProcess: {} };
		out.deps = {
			writeResult: (line) => out.lines.push(JSON.parse(line)),
			writeProgress: (line) => out.progress.push(line),
			signalProcess: out.signalProcess,
		};
		return out;
	};
	const first = io();
	await handleRoutingRun(
		["apply", "--project", repo.projectPath, "--run-id", result.runId],
		first.deps,
	);
	strictEqual(first.lines[0].state, "applied", JSON.stringify(first.lines));
	strictEqual(first.signalProcess.exitCode, undefined);
	ok(first.progress.some((line) => line.endsWith("phase=integrate")));
	const second = io();
	await handleRoutingRun(
		["apply", "--project", repo.projectPath, "--run-id", result.runId],
		second.deps,
	);
	strictEqual(second.lines[0].reason, "held_receipt_consumed");
	strictEqual(second.signalProcess.exitCode, 1);
	for (const args of [
		["apply", "--project", repo.projectPath],
		[
			"apply",
			"--project",
			repo.projectPath,
			"--run-id",
			"x",
			"--timeout",
			"31",
		],
		["inspect", "--project", repo.projectPath, "--run-id", "x"],
	])
		await rejects(handleRoutingRun(args, first.deps), {
			code: "invalid_invocation",
		});
});

test("inspect lists held and applied integrations of succeeded attempts", async () => {
	const repo = heldFixture();
	const result = await runHeld(repo);
	const state = {
		attempts: [
			{
				attemptId: result.attemptId,
				taskId: result.taskId,
				runId: result.runId,
				terminal: "succeeded",
			},
			{ attemptId: "a2", taskId: "t2", runId: "simple-x", terminal: "failed" },
		],
	};
	const [heldView] = await inspectHeldIntegrations(state, readRun);
	strictEqual(heldView.state, "held");
	strictEqual(heldView.receiptPath, result.integration.receiptPath);
	await applyHeldIntegration({
		projectPath: repo.projectPath,
		runId: result.runId,
		deadlineMs: Date.now() + 60_000,
	});
	const views = await inspectHeldIntegrations(state, readRun);
	strictEqual(views.length, 1);
	strictEqual(views[0].state, "applied");
	strictEqual(
		views[0].appliedHead,
		git(repo.projectPath, ["rev-parse", "HEAD"]),
	);
});

test("a real recheck at a moved HEAD applies on pass and refuses on failure", {
	skip: nestedSandboxSkip,
}, async () => {
	for (const [check, expected] of [
		["grep -q candidate a.txt", "applied"],
		["grep -q never-present a.txt", "refused"],
	]) {
		const repo = heldFixture();
		// The hold-time check is a double, so the receipt carries a check the
		// real recheck either passes or fails.
		const result = await runHeld(repo, { checks: [check] });
		strictEqual(result.status, "succeeded", JSON.stringify(result));
		writeFileSync(join(repo.projectPath, "b.txt"), "peer\n");
		commit(repo.projectPath, "peer");
		const outcome = await applyHeldIntegration(
			{
				projectPath: repo.projectPath,
				runId: result.runId,
				deadlineMs: Date.now() + 120_000,
			},
			{ tmpdir: repo.root },
		);
		strictEqual(outcome.state, expected, JSON.stringify(outcome));
		const content = readFileSync(join(repo.projectPath, "a.txt"), "utf8");
		strictEqual(content, expected === "applied" ? "candidate\n" : "base\n");
		if (expected === "refused")
			strictEqual(outcome.reason, "held_recheck_failed");
		const applyRecord = await readRun(outcome.applyRunId);
		strictEqual(applyRecord.worktree.state, "removed");
	}
});
