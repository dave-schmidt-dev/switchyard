// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Scarecrow 0.4.0 beta (2026-10-09): a provider exhausted its quota
// mid-task, the retry returned deferred native_required, and the answer
// described only the retry; the first attempt's partial worktree was visible
// only through `routing-run inspect`.
const providerReliability = createProviderReliabilityDiagnostic({
	causeCode: "quota_exhausted",
	phase: "provider",
});
const quotaFailure = {
	status: "failed",
	retained: true,
	result: {
		providerReliability,
	},
	record: {
		lastFailure: {
			errorKind: "execution_failed",
			providerReliability,
			diagnosticCode: "quota_exhausted",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
		},
	},
};

test("a quota exhaustion mid-task summarizes the earlier attempt and its retained partial", async () => {
	const f = fixture({
		__targets: ["antigravity-claude"],
		"antigravity-claude": quotaFailure,
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	// Existing fields are unchanged.
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "capacity");
	strictEqual(result.attempts.length, 1);
	strictEqual(result.retainedPartials.length, 1);
	deepStrictEqual(result.priorAttempts, [
		{
			attemptId: result.attempts[0].attemptId,
			targetId: "antigravity-claude",
			terminal: result.attempts[0].terminal,
			reason: result.attempts[0].reason,
			failureReason: "provider_exit_nonzero",
			causeCode: "quota_exhausted",
			partialWorktree: join(f.options.projectPath, "retained"),
		},
	]);
});

test("a completed reroute lists only the attempts before the one it reports", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	strictEqual(result.result.targetId, "codex");
	deepStrictEqual(
		result.priorAttempts.map((attempt) => [
			attempt.targetId,
			attempt.failureReason,
			attempt.causeCode,
			attempt.partialWorktree,
		]),
		[["antigravity-claude", "provider_exit_nonzero", null, null]],
	);
});

test("a stop on a later attempt lists only the earlier attempts", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": quotaFailure,
		codex: {
			status: "failed",
			result: {
				failurePhase: "baseline",
				failureReason: "baseline_check_failed",
				errorKind: "environment_failure",
			},
		},
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.result.targetId, "codex");
	deepStrictEqual(
		result.priorAttempts.map((attempt) => attempt.targetId),
		["antigravity-claude"],
	);
});

test("a single attempt adds no priorAttempts field", async () => {
	const f = fixture({ __targets: ["codex"] });
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	ok(!Object.hasOwn(result, "priorAttempts"));
});

test("an earlier task's attempts are not this task's prior attempts", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	await runSimpleRoutingTask(f.options, f.deps);
	const second = await runSimpleRoutingTask(
		{ ...f.options, files: ["b.txt"] },
		f.deps,
	);
	strictEqual(second.direction, "complete");
	strictEqual(second.attempts.length, 3);
	ok(!Object.hasOwn(second, "priorAttempts"));
});

test("the simple CLI result carries the earlier attempts beside the retry's own fields", async () => {
	const f = fixture({
		__targets: ["antigravity-claude"],
		"antigravity-claude": quotaFailure,
	});
	const routing = await runSimpleRoutingTask(f.options, f.deps);
	const project = realpathSync(tempDir("prior-attempts-cli-project-"));
	strictEqual(spawnSync("git", ["init", "-q", project]).status, 0);
	writeFileSync(join(project, "prompt.txt"), "Implement bounded file edit");
	writeFileSync(join(project, "a.txt"), "baseline");
	const run = async (answer) => {
		const output = [];
		await handleSimple(
			[
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
				"prior-attempts-run",
				"--deadline",
				new Date(Date.now() + 60_000).toISOString(),
			],
			{
				stateRoot: realpathSync(tempDir("prior-attempts-cli-state-")),
				signalProcess: new EventEmitter(),
				onStatus: () => {},
				writeWarning: () => {},
				runSimpleRoutingTask: async () => answer,
				writeResult: (value) => output.push(JSON.parse(value)),
			},
		);
		return output[0];
	};
	const top = await run(routing);
	// The retry's own fields are unchanged.
	strictEqual(top.status, "deferred");
	strictEqual(top.failureReason, "native_required");
	// The retry never ran a provider, so it has no partial of its own.
	strictEqual(top.partialWorktree ?? null, null);
	deepStrictEqual(top.attempts, routing.attempts);
	deepStrictEqual(top.retainedPartials, routing.retainedPartials);
	deepStrictEqual(top.priorAttempts, routing.priorAttempts);
	strictEqual(top.priorAttempts[0].causeCode, "quota_exhausted");
	const { priorAttempts: _omitted, ...single } = routing;
	strictEqual("priorAttempts" in (await run(single)), false);
});
