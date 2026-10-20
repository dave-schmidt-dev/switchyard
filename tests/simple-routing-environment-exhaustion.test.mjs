// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";
import { unroutedStop } from "../src/switchyard/simple/routing-attempt-outcome.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { readRoutingRunState } from "../src/switchyard/simple/routing-state.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";

const cases = [
	{ failureReason: "environment_failure", failurePhase: "prepare" },
	...["route", "prepare", "diff", "repair", "integrate"].map(
		(failurePhase) => ({
			failureReason: "deadline_expired",
			failurePhase,
		}),
	),
];
for (const failure of cases) {
	test(`${failure.failureReason} at ${failure.failurePhase} counts task failures across invocations without removing providers`, async () => {
		const providerReliability = createSimpleProviderReliabilityDiagnostic({
			...failure,
			errorKind: "environment_failure",
		});
		strictEqual(providerReliability.causeCategory, "environment");
		const overrides = {
			__targets: ["codex"],
			codex: {
				status: "failed",
				result: {
					...failure,
					errorKind: "environment_failure",
					providerReliability,
				},
			},
		};
		const f = fixture(overrides);
		f.options.taskId = "environment-task";
		const first = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(first.direction, "native_required");
		strictEqual(first.exhaustionCause, "task_failures");
		strictEqual(first.attempts[0].reason, "environment_failure");
		strictEqual(first.attempts[0].terminal, "skipped");
		deepStrictEqual(first.failedTargetIds, []);
		// All providers become unavailable before a second invocation of this task.
		overrides.__targets = [];
		const replay = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(replay.direction, "native_required");
		strictEqual(replay.exhaustionCause, "task_failures");
		deepStrictEqual(f.calls, ["codex"]);
		const state = readRoutingRunState(
			f.options.projectPath,
			f.options.routingRunId,
			{ stateRoot: f.deps.stateRoot },
		);
		strictEqual(state.nativeLatch, false);
		deepStrictEqual(state.failedTargetIds, []);
		// A different task with no attempts still reports ordinary capacity.
		f.options.taskId = "unrelated-task";
		const unrelatedCapacity = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(unrelatedCapacity.exhaustionCause, "capacity");
		// Both the failed environment's target and an unrelated provider remain usable.
		overrides.__targets = ["codex", "vibe"];
		const unrelated = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(unrelated.direction, "complete");
		strictEqual(unrelated.result.targetId, "vibe");
		deepStrictEqual(f.calls, ["codex", "codex", "vibe"]);
	});
}

test("persisted capacity, caller cancellation, and baseline evidence keep their prior exhaustion rules", () => {
	for (const [reason, nonBlamingCause, expected] of [
		["environment_failure", undefined, "task_failures"],
		["baseline_failed", undefined, "capacity"],
		["lifecycle_recovered", undefined, "capacity"],
		["execution_failed", "quota_exhausted", "capacity"],
		["unsafe_failure", "caller_cancelled", "capacity"],
		["environment_failure", "quota_exhausted", "capacity"],
		["check_failed", undefined, "task_failures"],
	]) {
		const answer = unroutedStop({
			result: { failurePhase: "route" },
			attempts: [
				{
					taskId: "task",
					targetId: "codex",
					terminal: "skipped",
					reason,
					nonBlamingCause,
				},
			],
			logicalTaskId: "task",
			anyFailed: false,
			routeCalled: true,
			noEligible: true,
			pinned: false,
		});
		strictEqual(answer.extra.exhaustionCause, expected);
	}
});
