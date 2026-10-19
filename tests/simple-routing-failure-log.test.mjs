// @test-phase: other
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { readFailureRecords } from "../src/switchyard/simple/failure-log.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { readRoutingRunState } from "../src/switchyard/simple/routing-state.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";

const readLog = (stateRoot) => readFailureRecords({ stateRoot });

test("failure-log lower bounds require a valid explicit RFC3339 timestamp", () => {
	const f = fixture();
	for (const since of [
		"2999-01-01T00:00:00.123456789123Z",
		"2999-01-01t01:00:00.123456789123+01:00",
		"2999-01-01T01:00:00.123456789123+01:00",
	]) {
		deepStrictEqual(
			readFailureRecords({ stateRoot: f.deps.stateRoot, since }),
			[],
		);
	}
	for (const since of [
		"2025-02-29T00:00:00Z",
		"2025-04-31T00:00:00Z",
		"1970-01-01T24:00:00Z",
		"2025-01-01",
		"2025-01-01T00:00:00",
	]) {
		throws(() => readFailureRecords({ stateRoot: f.deps.stateRoot, since }), {
			code: "failure_log_since_invalid",
		});
	}
});

test("fractional lower bounds exclude the preceding stored millisecond", () => {
	const f = fixture();
	const failureLogDirectory = join(f.deps.stateRoot, "failure-log");
	mkdirSync(failureLogDirectory, { recursive: true });
	const records = [
		{
			recordType: "attempt",
			runId: "preceding-millisecond",
			recordedAt: "1970-01-01T00:00:00.000Z",
			origin: "work",
		},
		{
			recordType: "attempt",
			runId: "next-millisecond",
			recordedAt: "1970-01-01T00:00:00.001Z",
			origin: "work",
		},
	];
	writeFileSync(
		join(failureLogDirectory, "failures.jsonl"),
		`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
		"utf8",
	);
	const readRunIds = (since) =>
		readFailureRecords({ stateRoot: f.deps.stateRoot, since }).map(
			(record) => record.runId,
		);
	deepStrictEqual(readRunIds("1970-01-01T00:00:00.000Z"), [
		"preceding-millisecond",
		"next-millisecond",
	]);
	deepStrictEqual(readRunIds("1970-01-01T00:00:00.000000Z"), [
		"preceding-millisecond",
		"next-millisecond",
	]);
	deepStrictEqual(readRunIds("1970-01-01T00:00:00.000001Z"), [
		"next-millisecond",
	]);
	deepStrictEqual(readRunIds("1970-01-01T01:00:00.000001+01:00"), [
		"next-millisecond",
	]);
});

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

// Regression (2026-10-14): every check-setup cause logged only the coarse
// `baseline_failed`, so the deleted-node stop was indistinguishable from a
// missing `uv` without reading run.json. Since O5 (2026-10-18) the stop itself
// is labelled `check_setup_failed`; the attempt keeps `baseline_failed`, so the
// routing state stays version 1 and the target is still not blamed.
test("a check-setup stop logs the engine reason and setup evidence", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "check_setup_failed",
					phase: "baseline",
				}),
				errorKind: "check_failed",
				failureReason: "ENOENT",
				failurePhase: "prepare",
				failureDetails: {
					checkSetupStep: "probe_environment",
					checkSetupErrorCode: "ENOENT",
					checkSetupExecutable: "node",
				},
			},
		},
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "check_setup_failed");
	strictEqual(result.classification.severity, "baseline");
	strictEqual(result.attempts[0].reason, "baseline_failed");
	strictEqual(result.attempts[0].terminal, "skipped");
	deepStrictEqual(result.failedTargetIds, []);
	const records = readLog(f.deps.stateRoot);
	deepStrictEqual(
		records.map((record) => record.recordType),
		["attempt", "stop"],
	);
	strictEqual(records[1].stopReason, "check_setup_failed");
	for (const record of records) {
		strictEqual(record.causeCode, "check_setup_failed");
		strictEqual(record.failureReason, "ENOENT");
		strictEqual(record.checkSetupStep, "probe_environment");
		strictEqual(record.checkSetupErrorCode, "ENOENT");
		strictEqual(record.checkSetupExecutable, "node");
	}
	strictEqual(records[0].reason, "baseline_failed");
});

test("malformed git-control evidence is omitted from routing state and failure log", async () => {
	for (const gitControlTamper of [
		{ kind: "changed", area: "config", path: "/private/provider-path" },
		{ kind: "provider_value", area: "config" },
		{ kind: "added", area: "provider_path" },
	]) {
		const f = fixture({
			"antigravity-claude": {
				status: "failed",
				result: {
					failureReason: "unsafe_diff",
					failurePhase: "diff",
					errorKind: "policy_violation",
					gitControlTamper,
				},
			},
		});
		await runSimpleRoutingTask(f.options, f.deps);
		const state = readRoutingRunState(f.options.projectPath, "run-1", {
			stateRoot: f.deps.stateRoot,
		});
		strictEqual(Object.hasOwn(state.attempts[0], "gitControlTamper"), false);
		const record = readLog(f.deps.stateRoot).find(
			(item) => item.recordType === "attempt",
		);
		strictEqual(Object.hasOwn(record, "gitControlTamper"), false);
	}
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

// A diff-capture git failure reaches the routing log with its closed cause
// instead of an unclassified `execution_failed` / `unknown` pair.
test("a diff-capture failure logs the closed diff_capture_failed cause", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "diff_capture_failed",
					phase: "diff",
				}),
				errorKind: "environment_failure",
				failureReason: "diff_stage_failed",
				failurePhase: "diff",
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	// Soft environment failure: the next target runs and is not blamed.
	strictEqual(result.direction, "complete");
	strictEqual(result.attempts[0].reason, "environment_failure");
	strictEqual(result.attempts[0].terminal, "skipped");
	const records = readLog(f.deps.stateRoot);
	strictEqual(records.length, 1);
	strictEqual(records[0].recordType, "attempt");
	strictEqual(records[0].reason, "environment_failure");
	strictEqual(records[0].causeCode, "diff_capture_failed");
	strictEqual(records[0].causeCategory, "environment");
	strictEqual(records[0].failureReason, "diff_stage_failed");
});

// An `integration_state_unknown` refusal names the unknown metadata step in
// the routing log, not only in run.json.
test("an integration_state_unknown refusal logs the unknown metadata step", async () => {
	const f = fixture({
		"antigravity-claude": {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "scope_rejected",
					phase: "diff",
				}),
				errorKind: "policy_violation",
				failureReason: "unsafe_diff",
				failurePhase: "diff",
				failureDetails: {
					failureReason: "unsafe_diff",
					diffRejectionRule: "integration_state_unknown",
					diffRejectionUnknownStep: "summary",
					diffRejectionUnknownCause: "exit_nonzero",
				},
			},
		},
		codex: { status: "succeeded" },
	});
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	const records = readLog(f.deps.stateRoot);
	strictEqual(records.length, 1);
	strictEqual(records[0].reason, "policy_rejected");
	strictEqual(records[0].diffRejectionRule, "integration_state_unknown");
	strictEqual(records[0].diffRejectionUnknownStep, "summary");
	strictEqual(records[0].diffRejectionUnknownCause, "exit_nonzero");
});
