// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

test("a soft failure below the reroute floor stops without reaching the next target", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	let current = 0;
	f.deps.now = () => current;
	f.options.deadlineMs = 30 * 60_000;
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		if (result.targetId === "antigravity-claude")
			current = f.options.deadlineMs - 100_000;
		return result;
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "execution_failed");
	strictEqual(result.stopReason, result.attempts[0].reason);
	strictEqual(result.attempts.length, 1);
	deepStrictEqual(f.calls, ["antigravity-claude"]);
});

test("a soft failure above the reroute floor continues to the next target", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	let current = 0;
	f.deps.now = () => current;
	f.options.deadlineMs = 30 * 60_000;
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		if (result.targetId === "antigravity-claude")
			current = f.options.deadlineMs - 200_000;
		return result;
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
});

test("a short task still reroutes below the module floor while above its own floor", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	let current = 0;
	f.deps.now = () => current;
	f.options.deadlineMs = 10_000;
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		if (result.targetId === "antigravity-claude")
			current = f.options.deadlineMs - 5_000;
		return result;
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
});

test("a first attempt still starts with only 30 s left of a 30-minute deadline", async () => {
	const f = fixture({ __targets: ["antigravity-claude", "codex"] });
	const current = 30 * 60_000 - 30_000;
	f.deps.now = () => current;
	f.options.deadlineMs = 30 * 60_000;
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude"]);
});

const DEADLINE_MS = 30 * 60_000;
const FIT_REFUSAL = "task_estimate_exceeds_budget";

/**
 * Two targets; the first soft-fails and the clock then leaves 200 s: above the
 * 120 s reroute floor, below estimate + check reserve (60 s) + margin (90 s)
 * for a 5-minute estimate (a 50 s budget). `refuseRetry` makes any second
 * engine call answer like the real engine's pre-allocation refusal.
 */
function lateFailureFixture({ estimateMinutes, refuseRetry = false } = {}) {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	let current = 0;
	f.deps.now = () => current;
	f.options.deadlineMs = DEADLINE_MS;
	if (estimateMinutes !== undefined)
		f.options.estimateMinutes = estimateMinutes;
	const rows = [];
	f.deps.failureLog = { append: (row) => rows.push(row) };
	const engine = f.deps.runSimpleTask;
	const engineCalls = [];
	f.deps.runSimpleTask = async (opts, context) => {
		engineCalls.push(context.attemptId);
		if (engineCalls.length > 1 && refuseRetry)
			return {
				status: "failed",
				runId: context.runId,
				taskId: context.taskId,
				attemptId: context.attemptId,
				failurePhase: "route",
				failureReason: FIT_REFUSAL,
				errorKind: "validation_failed",
			};
		const result = await engine(opts, context);
		if (result.targetId === "antigravity-claude")
			current = DEADLINE_MS - 200_000;
		return result;
	};
	return { ...f, rows, engineCalls };
}

test("a reroute that cannot fit the estimate stops with the failed attempt's outcome", async () => {
	const f = lateFailureFixture({ estimateMinutes: 5, refuseRetry: true });
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(f.engineCalls.length, 1);
	strictEqual(result.attempts.length, 1);
	strictEqual(result.stopReason, result.attempts[0].reason);
	strictEqual(result.stopReason, "execution_failed");
	strictEqual(result.result.targetId, "antigravity-claude");
	strictEqual(result.retrySkipped.reason, FIT_REFUSAL);
	strictEqual(result.retrySkipped.deadlineConsumedMs, 1_600_000);
	const fit = result.retrySkipped.deadlineFit;
	strictEqual(fit.deadlineFitSource, "caller_estimate");
	strictEqual(fit.deadlineFitEstimateMs, 300_000);
	strictEqual(fit.deadlineFitRemainingMs, 200_000);
	strictEqual(fit.deadlineFitBudgetMs, 50_000);
	ok(fit.deadlineFitEstimateMs > fit.deadlineFitBudgetMs);
	// The doomed call never ran, so the log holds the one real attempt and its stop.
	deepStrictEqual(
		f.rows.map((row) => [row.recordType, row.reason ?? row.stopReason]),
		[
			["attempt", "execution_failed"],
			["stop", "execution_failed"],
		],
	);
	ok(f.rows.every((row) => row.severity !== "hard"));
});

test("a reroute that fits the estimate still happens", async () => {
	const f = lateFailureFixture({ estimateMinutes: 0.5 });
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	strictEqual(result.retrySkipped, undefined);
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
});

test("without an estimate the same late failure still reroutes", async () => {
	const f = lateFailureFixture();
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	strictEqual(result.retrySkipped, undefined);
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
});

test("a pre-allocation fit refusal that reaches the engine stops as the fit refusal", async () => {
	const f = fixture({ __targets: ["antigravity-claude", "codex"] });
	f.deps.runSimpleTask = async (_options, context) => ({
		status: "failed",
		runId: context.runId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		failurePhase: "route",
		failureReason: FIT_REFUSAL,
		errorKind: "validation_failed",
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, FIT_REFUSAL);
});

test("a start-admission fit refusal after allocation stops as the fit refusal", async () => {
	// The real engine types this refusal as an input failure, which is hard.
	const providerReliability = createSimpleProviderReliabilityDiagnostic({
		errorKind: "validation_failed",
		failureReason: FIT_REFUSAL,
		failurePhase: "route",
	});
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": {
			status: "failed",
			result: {
				failurePhase: "route",
				failureReason: FIT_REFUSAL,
				errorKind: "validation_failed",
				providerReliability,
			},
			record: {
				lastFailure: { errorKind: "validation_failed", providerReliability },
			},
		},
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, FIT_REFUSAL);
	strictEqual(result.attempts[0].reason, "unsafe_failure");
	deepStrictEqual(f.calls, ["antigravity-claude"]);
});

test("the simple CLI passes retrySkipped and retained partials through", async () => {
	const project = realpathSync(tempDir("reroute-budget-cli-project-"));
	const stateRoot = realpathSync(tempDir("reroute-budget-cli-state-"));
	strictEqual(spawnSync("git", ["init", "-q", project]).status, 0);
	writeFileSync(join(project, "prompt.txt"), "Implement bounded file edit");
	writeFileSync(join(project, "a.txt"), "baseline");
	const argv = [
		join(project, "prompt.txt"),
		"--project",
		project,
		"--capability",
		"standard",
		"--file",
		"a.txt",
		"--check",
		"true",
		"--routing-run-id",
		"reroute-budget-run",
		"--deadline",
		new Date(Date.now() + 60_000).toISOString(),
	];
	const run = async (routing) => {
		const output = [];
		await handleSimple(argv, {
			stateRoot,
			signalProcess: new EventEmitter(),
			onStatus: () => {},
			writeWarning: () => {},
			runSimpleRoutingTask: async () => ({
				direction: "stop",
				routingRunId: "reroute-budget-run",
				routingRunIdSource: "flag",
				attempts: [],
				failedTargetIds: [],
				result: { status: "failed", failureReason: "check_failed" },
				stopReason: "check_failed",
				...routing,
			}),
			writeResult: (value) => output.push(JSON.parse(value)),
		});
		return output[0];
	};
	const retrySkipped = {
		reason: FIT_REFUSAL,
		deadlineFit: {
			deadlineFitEstimateMs: 300_000,
			deadlineFitBudgetMs: 50_000,
		},
		deadlineConsumedMs: 1_600_000,
	};
	const retainedPartials = [
		{
			attemptId: "a1",
			targetId: "antigravity-claude",
			reason: "check_failed",
			partialWorktree: "/scratch/partial",
		},
	];
	const passed = await run({ retrySkipped, retainedPartials });
	deepStrictEqual(passed.retrySkipped, retrySkipped);
	deepStrictEqual(passed.retainedPartials, retainedPartials);
	strictEqual(passed.stopReason, "check_failed");
	const plain = await run({ retainedPartials: [] });
	strictEqual("retrySkipped" in plain, false);
	strictEqual("retainedPartials" in plain, false);
});
