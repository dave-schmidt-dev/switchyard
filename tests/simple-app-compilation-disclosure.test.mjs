// @test-phase: other
import { deepStrictEqual, match, strictEqual, throws } from "node:assert";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { validateCheckCommand } from "../src/switchyard/simple/check-validation.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { terminalResult } from "../src/switchyard/simple/recovery.mjs";
import { repoFixture } from "./helpers/check-dry-run-repo.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("switchyard-app-disclosure-store-"),
	"runs",
);
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

const DISCLOSURE =
	"App-target compilation is unverified: passing checks (including package builds) do not establish that app targets were compiled. Verify with a native app-target build.";
const base = {
	taskId: "app-disclosure",
	attemptId: "attempt-1",
	startedAt: 0,
	now: () => 1,
	checkCount: 1,
};

test("passing checks disclose the app compilation boundary without changing acceptance", () => {
	for (const differential of [
		undefined,
		{ verdict: "accepted", after: { failedCount: 2 } },
	]) {
		const checks = [
			{ index: 1, status: "passed", ...(differential ? { differential } : {}) },
		];
		const result = terminalResult(base, { status: "succeeded", checks });
		deepStrictEqual(result.checks, checks);
		strictEqual(result.status, "succeeded");
		strictEqual(
			result.checkAcceptance,
			differential ? "differential" : "strict",
		);
		deepStrictEqual(result.checkLimitations, [DISCLOSURE]);
	}
});

test("failed and incomplete check sets retain the disclosure without claiming acceptance", () => {
	for (const checks of [
		[{ index: 1, status: "failed", exitCode: 1 }],
		[{ index: 1, status: "passed" }],
	]) {
		const result = terminalResult(
			{ ...base, checkCount: 2 },
			{
				checks,
				failureReason: "check_failed",
			},
		);
		strictEqual(result.status, "failed");
		strictEqual(result.checkAcceptance, undefined);
		deepStrictEqual(result.checkLimitations, [DISCLOSURE]);
	}
});

test("a failure before any acceptance check does not imply checks ran", () => {
	for (const checks of [undefined, []]) {
		const result = terminalResult(base, {
			checks,
			failureReason: "check_setup_failed",
		});
		strictEqual(result.checkLimitations, undefined);
		deepStrictEqual(result.checks, []);
	}
});

async function checkedTask({ pass = true, held = false } = {}) {
	const repo = repoFixture();
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			// Fake check execution only: these checks never compile an app.
			checks: [
				"git diff --check",
				"swift build --build-system native --disable-sandbox --scratch-path .sy/b --cache-path .sy/c",
			],
			repairChecks: false,
			integrateMode: held ? "hold" : "apply",
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
			runCheck: async () => ({
				success: pass,
				code: pass ? 0 : 1,
				writerLifecycle: "stopped",
			}),
			executeProvider: async ({ worktreePath }) => {
				writeFileSync(join(worktreePath, "a.txt"), "changed\n");
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
	return { repo, result, run: await readRun(result.runId) };
}

test("package-check success carries the same limitation into run.json and CLI JSON", async () => {
	const { repo, result, run } = await checkedTask();
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	strictEqual(result.checkAcceptance, "strict");
	deepStrictEqual(result.checkLimitations, [DISCLOSURE]);
	deepStrictEqual(
		run.terminalSummary.checkLimitations,
		result.checkLimitations,
	);
	strictEqual(run.terminalSummary.checkAcceptance, "strict");
	let printed;
	const signalProcess = new EventEmitter();
	await handleSimple(
		[
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"standard",
			"--file",
			"a.txt",
			"--check",
			"git diff --check",
			"--timeout",
			"2",
		],
		{
			signalProcess,
			quickDoctor: async () => null,
			renewDispatchReceipts: async () => {},
			runSimpleRoutingTask: async () => ({
				direction: "complete",
				routingRunId: "disclosure-route",
				result,
				attempts: [],
				failedTargetIds: [],
			}),
			writeResult: (json) => {
				printed = JSON.parse(json);
			},
		},
	);
	strictEqual(printed.status, "succeeded");
	deepStrictEqual(printed.checkLimitations, [DISCLOSURE]);
	deepStrictEqual(printed.checks, result.checks);
	strictEqual(signalProcess.exitCode, undefined);
});

test("a failed check retains the limitation in the result and durable summary", async () => {
	const { result, run } = await checkedTask({ pass: false });
	strictEqual(result.status, "failed", JSON.stringify(result));
	strictEqual(result.failureReason, "check_failed");
	strictEqual(result.checkAcceptance, undefined);
	deepStrictEqual(result.checkLimitations, [DISCLOSURE]);
	deepStrictEqual(
		run.terminalSummary.checkLimitations,
		result.checkLimitations,
	);
});

test("held integration discloses the same unverified compilation boundary", async () => {
	const { result, run } = await checkedTask({ held: true });
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	strictEqual(result.integration.state, "held");
	deepStrictEqual(result.checkLimitations, [DISCLOSURE]);
	deepStrictEqual(
		run.terminalSummary.checkLimitations,
		result.checkLimitations,
	);
});

test("the disclosure does not grant build-for-testing or simulator tests", () => {
	for (const action of ["build-for-testing", "test"]) {
		throws(
			() =>
				validateCheckCommand(`xcodebuild -scheme App ${action}`, "/fixture"),
			(error) => {
				strictEqual(error.code, "check_tool_denied");
				match(error.message, /xcodebuild/u);
				return true;
			},
		);
	}
});
