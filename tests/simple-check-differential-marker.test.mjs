// @test-phase: other
// How a result says its checks were accepted, and how a HEAD-advance recheck
// inherits the original base's differential baselines.
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import {
	checkAcceptanceOf,
	createDifferentialChecks,
} from "../src/switchyard/simple/check-differential.mjs";
import {
	appendFailureRecord,
	readFailureRecords,
} from "../src/switchyard/simple/failure-log.mjs";
import { failureAttemptRecord } from "../src/switchyard/simple/routing-stop-record.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const accepted = (baselineFailed, afterFailed) => ({
	index: 1,
	status: "passed",
	differential: {
		runner: "node",
		verdict: "accepted",
		reason: null,
		baseline: { total: 4, failedCount: baselineFailed, failed: [] },
		after: { total: 5, failedCount: afterFailed, failed: [], newFailures: [] },
		targeted: { total: 1, passed: 1 },
	},
});

test("only a finished set of passing checks carries an acceptance marker", () => {
	deepStrictEqual(checkAcceptanceOf([], 0), {});
	deepStrictEqual(checkAcceptanceOf(undefined, 1), {});
	deepStrictEqual(
		checkAcceptanceOf(
			[
				{ index: 1, status: "passed" },
				{ index: 2, status: "failed" },
			],
			2,
		),
		{},
	);
	deepStrictEqual(checkAcceptanceOf([{ index: 1, status: "passed" }], 1), {
		checkAcceptance: "strict",
		toleratedBaselineFailures: 0,
	});
	// A passing prefix (a deadline or error before the next check) is not a
	// finished acceptance, whichever rule the prefix passed under.
	deepStrictEqual(checkAcceptanceOf([{ index: 1, status: "passed" }], 2), {});
	deepStrictEqual(checkAcceptanceOf([accepted(2, 2)], 2), {});
	deepStrictEqual(checkAcceptanceOf([{ index: 1, status: "passed" }]), {});
});

test("tolerated failures count what still fails after the change, not the baseline", () => {
	// Two baseline failures sat in a declared file and had to pass; one
	// unrelated failure was tolerated.
	deepStrictEqual(
		checkAcceptanceOf([{ index: 1, status: "passed" }, accepted(3, 1)], 2),
		{ checkAcceptance: "differential", toleratedBaselineFailures: 1 },
	);
	deepStrictEqual(checkAcceptanceOf([accepted(2, 2), accepted(4, 3)], 2), {
		checkAcceptance: "differential",
		toleratedBaselineFailures: 5,
	});
	// A refused record on a passing entry is not an acceptance.
	const refused = accepted(1, 1);
	refused.differential.verdict = "refused";
	deepStrictEqual(checkAcceptanceOf([refused], 1), {
		checkAcceptance: "strict",
		toleratedBaselineFailures: 0,
	});
});

const SHELL = { kind: "shell" };
const CMD = "node --test tests";
const failedRun = { success: false, code: 1, writerLifecycle: "stopped" };

function capture(entries) {
	const runtime = tempDir("switchyard-differential-marker-runtime-");
	const checkout = tempDir("switchyard-differential-marker-checkout-");
	const checks = createDifferentialChecks({
		declaredFiles: ["tests/feature.test.mjs"],
	});
	const plan = checks.plan({
		command: CMD,
		execution: SHELL,
		baseRun: true,
		testBaseline: true,
		runtime,
		checkout,
	});
	writeFileSync(
		plan.reportPath,
		`${[
			...entries.map(([name, status, abnormal = false]) => ({
				path: [name],
				file: `${checkout}/tests/legacy.test.mjs`,
				type: "test",
				status,
				abnormal,
			})),
			{ end: true, count: entries.length },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	checks.judge(plan, CMD, failedRun);
	return checks;
}

test("a clean red baseline qualifies; an abnormal or unread one does not", () => {
	strictEqual(capture([["clock", "failed"]]).qualifies(CMD), true);
	const abnormal = capture([["clock", "failed", true]]);
	ok(abnormal.baselines().get(CMD).tests, "the report was read");
	strictEqual(abnormal.qualifies(CMD), false);
	strictEqual(capture([["clock", "failed"]]).qualifies("pytest"), false);
	const unread = createDifferentialChecks({ declaredFiles: [] });
	strictEqual(unread.qualifies(CMD), false);
});

test("a recheck session seeded with the original baselines judges against them", () => {
	const original = capture([
		["clock", "failed"],
		["green", "passed"],
	]);
	const copy = original.baselines();
	ok(copy.get(CMD).tests.size === 2);
	// The copy is detached: changing it never changes the original.
	copy.get(CMD).tests.clear();
	strictEqual(original.baselines().get(CMD).tests.size, 2);

	const recheck = createDifferentialChecks({
		declaredFiles: ["tests/feature.test.mjs"],
		baselines: original.baselines(),
	});
	strictEqual(recheck.qualifies(CMD), true);
	const runtime = tempDir("switchyard-differential-marker-runtime-");
	const checkout = tempDir("switchyard-differential-marker-checkout-");
	const plan = recheck.plan({
		command: CMD,
		execution: SHELL,
		baseRun: false,
		runtime,
		checkout,
	});
	strictEqual(plan.phase, "after");
	notStrictEqual(plan.shellCommand, null);
	// Without the seed the same candidate run has no baseline: strict.
	const unseeded = createDifferentialChecks({ declaredFiles: [] });
	strictEqual(
		unseeded.plan({
			command: CMD,
			execution: SHELL,
			baseRun: false,
			runtime,
			checkout,
		}),
		null,
	);
});

test("a failed attempt's log record keeps its closed check-acceptance marker", () => {
	const stateRoot = tempDir("switchyard-differential-marker-log-");
	const attempt = {
		taskId: "task-1",
		attemptId: "attempt-1",
		runId: "run-1",
		targetId: "codex",
		capability: "standard",
	};
	for (const [checkAcceptance, tolerated] of [
		["differential", 2],
		["lenient", 1],
		["differential", 4097],
		["strict", -1],
	])
		appendFailureRecord(
			failureAttemptRecord({
				project: "/review/project",
				routingRunId: "routing-1",
				attempt,
				result: {
					status: "failed",
					failureReason: "host_concurrency",
					failurePhase: "integrate",
					partialWorktree: null,
					checkAcceptance,
					toleratedBaselineFailures: tolerated,
				},
				accountability: null,
				classification: {
					severity: "soft",
					reason: "host_concurrency",
					salvageable: false,
				},
			}),
			{ stateRoot },
		);
	appendFailureRecord(
		{ recordType: "attempt", reason: "check_failed" },
		{ stateRoot },
	);
	const [differential, unknown, large, negative, absent] = readFailureRecords({
		stateRoot,
	});
	strictEqual(differential.checkAcceptance, "differential");
	strictEqual(differential.toleratedBaselineFailures, 2);
	strictEqual(unknown.checkAcceptance, null);
	// The tally is not capped like a bounded detail integer.
	strictEqual(large.toleratedBaselineFailures, 4097);
	strictEqual(negative.toleratedBaselineFailures, null);
	strictEqual("checkAcceptance" in absent, false);
	strictEqual("toleratedBaselineFailures" in absent, false);
});
