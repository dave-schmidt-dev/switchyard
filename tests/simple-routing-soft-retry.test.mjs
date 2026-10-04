import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	MAX_SOFT_ATTEMPTS_PER_TASK,
	runSimpleRoutingTask,
} from "../src/switchyard/simple/routing-run.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";

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
