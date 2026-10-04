import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { readFailureRecords } from "../src/switchyard/simple/failure-log.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";

const readLog = (stateRoot) => readFailureRecords({ stateRoot });

test("a soft failure followed by success writes exactly one attempt record", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				failureReason: "check_failed",
				failurePhase: "checks",
				errorKind: "check_failed",
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	const records = readLog(f.deps.stateRoot);
	strictEqual(records.length, 1);
	const record = records[0];
	strictEqual(record.recordType, "attempt");
	strictEqual(record.schemaVersion, 1);
	strictEqual(record.project, f.options.projectPath);
	strictEqual(record.routingRunId, "run-1");
	strictEqual(record.targetId, "antigravity-claude");
	strictEqual(record.capability, "standard");
	strictEqual(record.severity, "soft");
	strictEqual(record.reason, "check_failed");
	strictEqual(record.salvageable, false);
	strictEqual(record.partialRetained, false);
	strictEqual(record.causeCode, "unknown");
	strictEqual(record.phase, null);
	strictEqual(record.failurePhase, "checks");
	strictEqual(record.errorKind, "check_failed");
	strictEqual(record.stopReason, null);
	strictEqual(record.exhaustionCause, null);
	ok(record.taskId);
	ok(record.attemptId);
	ok(record.runId);
	ok(record.fingerprint);
});

test("a hard failure writes one attempt record and one stop record", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "cleanup_failed",
					phase: "cleanup",
				}),
				errorKind: "cleanup_failed",
				failureReason: "cleanup_failed",
				failurePhase: "cleanup",
			},
		},
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "unsafe_failure");
	const records = readLog(f.deps.stateRoot);
	strictEqual(records.length, 2);
	strictEqual(records[0].recordType, "attempt");
	strictEqual(records[0].severity, "hard");
	strictEqual(records[0].reason, "unsafe_failure");
	strictEqual(records[0].causeCode, "cleanup_failed");
	strictEqual(records[0].causeCategory, "cleanup");
	strictEqual(records[0].phase, "cleanup");
	strictEqual(records[1].recordType, "stop");
	strictEqual(records[1].stopReason, "unsafe_failure");
	strictEqual(records[1].targetId, "antigravity-claude");
	strictEqual(records[1].attemptId, records[0].attemptId);
	strictEqual(records[1].runId, records[0].runId);
	strictEqual(records[1].taskId, records[0].taskId);
	strictEqual(records[1].reason, null);
	strictEqual(records[1].severity, null);
	strictEqual(records[1].exhaustionCause, null);
});

test("a full success writes no failure records", async () => {
	const f = fixture();
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(readLog(f.deps.stateRoot), []);
	const logFile = `${f.deps.stateRoot}/failure-log/failures.jsonl`;
	strictEqual(existsSync(logFile), false);
});

test("exhaustion writes one stop record carrying the exhaustion cause", async () => {
	const f = fixture({
		"antigravity-claude": { status: "failed" },
		codex: { status: "failed" },
		vibe: { status: "failed" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	const records = readLog(f.deps.stateRoot);
	strictEqual(records.length, 4);
	strictEqual(records.filter((r) => r.recordType === "attempt").length, 3);
	const stop = records[3];
	strictEqual(stop.recordType, "stop");
	strictEqual(stop.stopReason, "native_required");
	strictEqual(stop.exhaustionCause, "task_failures");
	strictEqual(stop.targetId, "vibe");
	strictEqual(stop.attemptId, records[2].attemptId);
});

test("a throwing failure log leaves the answer unchanged and warns once", async () => {
	const overrides = {
		"antigravity-claude": {
			status: "failed",
			result: {
				errorKind: "cleanup_failed",
				failureReason: "cleanup_failed",
				failurePhase: "cleanup",
			},
		},
	};
	const clean = fixture(overrides);
	const expected = await runSimpleRoutingTask(clean.options, clean.deps);
	const f = fixture(overrides);
	const warnings = [];
	f.deps.onRoutingWarning = (message) => warnings.push(message);
	f.deps.failureLog = {
		append: () => {
			throw Object.assign(new Error("log unavailable"), { code: "EACCES" });
		},
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, expected.direction);
	strictEqual(result.stopReason, expected.stopReason);
	strictEqual(result.routingRunId, expected.routingRunId);
	strictEqual(result.attempts.length, expected.attempts.length);
	strictEqual(result.attempts[0].terminal, expected.attempts[0].terminal);
	strictEqual(result.attempts[0].reason, expected.attempts[0].reason);
	strictEqual(result.attempts[0].targetId, expected.attempts[0].targetId);
	deepStrictEqual(result.failedTargetIds, expected.failedTargetIds);
	deepStrictEqual(warnings, ["dispatch: failure log unavailable (EACCES)"]);
});

test("a guard answer on a later dispatch logs nothing new", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			retained: true,
			result: {
				failureReason: "check_failed",
				failurePhase: "checks",
				errorKind: "check_failed",
			},
		},
		codex: { status: "succeeded" },
	});
	strictEqual(
		(await runSimpleRoutingTask(f.options, f.deps)).direction,
		"complete",
	);
	strictEqual(readLog(f.deps.stateRoot).length, 1);
	const again = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(again.stopReason, "partial_work_retained");
	strictEqual(readLog(f.deps.stateRoot).length, 1);
});
