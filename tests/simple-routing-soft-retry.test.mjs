import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	NON_BLAMING_CAUSES,
	nonBlamingCause,
	TASK_EXCLUSION_EXEMPT_REASONS,
} from "../src/switchyard/simple/attempt-blame.mjs";
import {
	MAX_SOFT_ATTEMPTS_PER_TASK,
	runSimpleRoutingTask,
} from "../src/switchyard/simple/routing-run.mjs";
import {
	openRoutingRun,
	readRoutingRunState,
	recordAttemptOutcome,
} from "../src/switchyard/simple/routing-state.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// (a) check_failed with retained partial on A continues to B, which succeeds.
test("(a) check_failed with retained partial continues to next target and succeeds", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			retained: true,
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "acceptance_check_failed",
					phase: "check",
				}),
				failureReason: "check_failed",
				failurePhase: "checks",
				errorKind: "check_failed",
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
	// attempt A: terminal skipped, reason check_failed, no failedTargetIds entry
	const attemptA = result.attempts.find(
		(a) => a.targetId === "antigravity-claude",
	);
	ok(attemptA, "attempt A must be recorded");
	strictEqual(attemptA.terminal, "skipped");
	strictEqual(attemptA.reason, "check_failed");
	deepStrictEqual(result.failedTargetIds, []);
	// retainedPartials lists A
	strictEqual(result.retainedPartials.length, 1);
	strictEqual(result.retainedPartials[0].targetId, "antigravity-claude");
	strictEqual(result.retainedPartials[0].reason, "check_failed");
	ok(typeof result.retainedPartials[0].partialWorktree === "string");
});

// (b) cleanup failure stops immediately with unsafe_failure and makes no second engine call.
test("(b) cleanup failure stops with unsafe_failure, no second engine call", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "cleanup_failed",
					phase: "provider",
				}),
				errorKind: "cleanup_failed",
				failureReason: "cleanup_failed",
				failurePhase: "cleanup",
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "unsafe_failure");
	strictEqual(f.calls.length, 1);
});

// (c) baseline failure stops with baseline_failed, no second call.
test("(c) baseline failure stops with baseline_failed, no second engine call", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				failurePhase: "baseline",
				failureReason: "baseline_check_failed",
				errorKind: "environment_failure",
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "baseline_failed");
	strictEqual(f.calls.length, 1);
});

// (d) trusted provider auth_expired puts A in failedTargetIds and continues to B.
test("(d) trusted provider auth_expired puts target in failedTargetIds and continues", async () => {
	const providerReliability = createProviderReliabilityDiagnostic({
		causeCode: "auth_expired",
		phase: "provider",
	});
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: { providerReliability },
			record: {
				lastFailure: {
					errorKind: "execution_failed",
					providerReliability,
					diagnosticCode: "auth_expired",
					diagnosticOrigin: "adapter",
					diagnosticEvidenceAvailable: true,
					failurePhase: "provider_execution",
				},
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
	deepStrictEqual(result.failedTargetIds, ["antigravity-claude"]);
});

// (e) all eligible targets soft-fail → native_required with exhaustionCause "task_failures".
test("(e) all targets soft-fail → native_required with exhaustionCause task_failures", async () => {
	const f = fixture({
		"antigravity-claude": { status: "failed" },
		codex: { status: "failed" },
		vibe: { status: "failed" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "task_failures");
});

test("(e2) typed check failures on every target report task_failures without poisoning memory", async () => {
	const checkFailed = {
		status: "failed",
		result: {
			providerReliability: createProviderReliabilityDiagnostic({
				causeCode: "acceptance_check_failed",
				phase: "check",
			}),
			failureReason: "check_failed",
			failurePhase: "checks",
			errorKind: "check_failed",
		},
	};
	const f = fixture({
		"antigravity-claude": checkFailed,
		codex: checkFailed,
		vibe: checkFailed,
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "task_failures");
	deepStrictEqual(result.failedTargetIds, []);
	strictEqual(
		result.attempts.every((attempt) => attempt.reason === "check_failed"),
		true,
	);
});

// (f) five eligible targets all soft-failing stop after 4 with soft_retry_budget_exhausted.
test("(f) five soft-failing targets stop after 4 with soft_retry_budget_exhausted", async () => {
	strictEqual(MAX_SOFT_ATTEMPTS_PER_TASK, 4);
	const targets = [
		"antigravity-claude",
		"codex",
		"vibe",
		"copilot",
		"copilot-student",
	];
	const overrides = Object.fromEntries(
		targets.map((t) => [t, { status: "failed" }]),
	);
	overrides.__targets = targets;
	const f = fixture(overrides);
	// identity resolver so routing-run uses raw IDs as targetIds
	f.deps.resolveTargetIdentity = (id) => ({
		targetId: id,
		harnessKey: id,
		ambiguous: false,
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "soft_retry_budget_exhausted");
	strictEqual(f.calls.length, MAX_SOFT_ATTEMPTS_PER_TASK);
});

// (g) a pinned soft failure stops with its reason and no second call.
test("(g) pinned soft failure stops with classification reason, no second engine call", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				failureReason: "empty_diff",
				failurePhase: "diff",
				errorKind: "empty_diff",
			},
		},
	});
	f.options.onlyProviders = ["antigravity-claude"];
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "empty_diff");
	strictEqual(f.calls.length, 1);
});

// Verify retainedPartials is always present on every answer, including native_required.
test("retainedPartials present on native_required response", async () => {
	const f = fixture({
		"antigravity-claude": { status: "failed" },
		codex: { status: "failed" },
		vibe: { status: "failed" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	ok(Array.isArray(result.retainedPartials));
	strictEqual(result.retainedPartials.length, 0);
});

// Verify retainedPartials accumulates across multiple soft-fail attempts with retained clones.
test("retainedPartials accumulates multiple retained clones across soft iterations", async () => {
	const targets = ["antigravity-claude", "codex", "vibe"];
	const overrides = Object.fromEntries(
		targets.map((t) => [
			t,
			{
				status: "failed",
				retained: true,
				result: {
					failureReason: "check_failed",
					failurePhase: "checks",
					errorKind: "check_failed",
				},
			},
		]),
	);
	const f = fixture(overrides);
	const result = await runSimpleRoutingTask(f.options, f.deps);
	// All three soft-failed; no more eligible → native_required
	strictEqual(result.direction, "native_required");
	strictEqual(result.retainedPartials.length, 3);
	for (const rp of result.retainedPartials) {
		ok(targets.includes(rp.targetId));
		strictEqual(rp.reason, "check_failed");
		ok(typeof rp.partialWorktree === "string");
	}
});

// host_concurrency integration refusal with a retained partial stops instead of
// rerouting: the passed work is applied to the moved HEAD, not redone.
test("host_concurrency integration refusal with retained partial stops without rerouting", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			retained: true,
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "host_concurrency",
					phase: "integrate",
				}),
				failureReason: "host_concurrency",
				failurePhase: "integrate",
				errorKind: "environment_failure",
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(f.calls.length, 1);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "host_concurrency");
	strictEqual(result.retainedPartials.length, 1);
	strictEqual(result.retainedPartials[0].targetId, "antigravity-claude");
	ok(typeof result.retainedPartials[0].partialWorktree === "string");
});

// The same integration refusal without retained work keeps the soft-retry reroute.
test("host_concurrency integration refusal without retained partial reroutes", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "host_concurrency",
					phase: "integrate",
				}),
				failureReason: "host_concurrency",
				failurePhase: "integrate",
				errorKind: "environment_failure",
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
	strictEqual(result.direction, "complete");
});

// Only a caller SIGTERM/SIGINT cancellation and a live quota error are
// non-blaming; internal-deadline and unspecified cancels keep their blame.
test("attempt-blame marks only caller cancellations and live quota non-blaming", () => {
	deepStrictEqual(NON_BLAMING_CAUSES, ["caller_cancelled", "quota_exhausted"]);
	ok(TASK_EXCLUSION_EXEMPT_REASONS.has("environment_failure"));
	const cancelled = (cancelSource) => ({
		providerReliability: { causeCode: "cancelled", cancelSource },
	});
	for (const source of ["signal_sigterm", "signal_sigint"]) {
		strictEqual(nonBlamingCause(cancelled(source)), "caller_cancelled");
	}
	for (const source of ["internal_deadline", "unspecified"]) {
		strictEqual(nonBlamingCause(cancelled(source)), null);
	}
	strictEqual(
		nonBlamingCause({
			providerReliability: { causeCode: "quota_exhausted" },
		}),
		"quota_exhausted",
	);
	strictEqual(nonBlamingCause({}), null);
});

// (h) A SIGTERM cancellation blames the caller, so a later invocation for the
// same task and routing run tries the same target again.
test("(h) caller cancellation keeps the target eligible for a task retry", async () => {
	const f = fixture({
		__targets: ["codex", "vibe"],
		codex: {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "cancelled",
					phase: "provider",
					cancelled: true,
				}),
				cancelSource: "signal_sigterm",
				failureReason: "cancelled",
				failurePhase: "execute",
				errorKind: "cancelled",
			},
		},
	});
	f.options.taskId = "cancel-retry";
	const first = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(first.direction, "stop");
	strictEqual(first.stopReason, "unsafe_failure");
	deepStrictEqual(f.calls, ["codex"]);
	const retry = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(retry.direction, "stop");
	strictEqual(retry.stopReason, "unsafe_failure");
	deepStrictEqual(f.calls, ["codex", "codex"]);
	const attempt = readRoutingRunState(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	}).attempts[0];
	strictEqual(attempt.terminal, "skipped");
	strictEqual(attempt.reason, "unsafe_failure");
	strictEqual(attempt.nonBlamingCause, "caller_cancelled");
});

// (i) An internal-deadline cancellation keeps its blame, so the target stays
// excluded from the rest of the task.
test("(i) internal-deadline cancellation still excludes the target for the task", async () => {
	const f = fixture({
		__targets: ["codex", "vibe"],
		codex: {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "cancelled",
					phase: "provider",
					cancelled: true,
				}),
				cancelSource: "internal_deadline",
				failureReason: "cancelled",
				failurePhase: "execute",
				errorKind: "cancelled",
			},
		},
	});
	f.options.taskId = "internal-deadline-retry";
	const first = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(first.stopReason, "unsafe_failure");
	deepStrictEqual(f.calls, ["codex"]);
	const retry = await runSimpleRoutingTask(f.options, f.deps);
	deepStrictEqual(f.calls, ["codex", "vibe"]);
	strictEqual(
		retry.attempts.find((attempt) => attempt.targetId === "codex")
			.nonBlamingCause,
		undefined,
	);
});

// (j) Quota failures exhaust capacity, not the task: no target failed it.
test("(j) quota-only exhaustion reports capacity, not task failures", async () => {
	const quotaFailure = {
		status: "failed",
		result: {
			providerReliability: createProviderReliabilityDiagnostic({
				causeCode: "quota_exhausted",
				phase: "provider",
			}),
		},
	};
	const f = fixture({
		__targets: ["antigravity-claude", "codex", "vibe"],
		"antigravity-claude": quotaFailure,
		codex: quotaFailure,
		vibe: quotaFailure,
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "capacity");
	deepStrictEqual(result.failedTargetIds, []);
	strictEqual(
		result.attempts.every(
			(attempt) => attempt.nonBlamingCause === "quota_exhausted",
		),
		true,
	);
});

// (k) One ordinary soft failure still makes the exhaustion a task failure.
test("(k) a quota failure mixed with an ordinary failure reports task_failures", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "quota_exhausted",
					phase: "provider",
				}),
			},
		},
		codex: { status: "failed" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "task_failures");
});

// Legacy attempts without a non-blaming cause keep their exact key set, while
// an out-of-enum value is rejected like an invalid continuation.
test("legacy attempts load and an out-of-enum nonBlamingCause is rejected", () => {
	const projectPath = tempDir("routing-blame-project-");
	const stateRoot = tempDir("routing-blame-state-");
	const handle = openRoutingRun(projectPath, "run-blame", {
		stateRoot,
		now: Date.now,
	});
	const allocation = {
		attemptId: "attempt-1",
		taskId: "task-1",
		runId: "run-1",
		targetId: "codex",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	handle.commit({ pendingAttempt: allocation });
	recordAttemptOutcome(handle.state, handle.commit, {
		...allocation,
		terminal: "skipped",
		reason: "unsafe_failure",
		closedAt: new Date().toISOString(),
		partialWorktree: null,
	});
	const legacy = readRoutingRunState(projectPath, "run-blame", { stateRoot });
	ok(!Object.hasOwn(legacy.attempts[0], "nonBlamingCause"));
	const second = { ...allocation, attemptId: "attempt-2", runId: "run-2" };
	handle.commit({ pendingAttempt: second });
	throws(
		() =>
			recordAttemptOutcome(handle.state, handle.commit, {
				...second,
				terminal: "skipped",
				reason: "unsafe_failure",
				closedAt: new Date().toISOString(),
				partialWorktree: null,
				nonBlamingCause: "internal_deadline",
			}),
		{ code: "routing_state_malformed" },
	);
	handle.release();
});
