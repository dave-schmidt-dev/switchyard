import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deriveFailureAccountability } from "../src/switchyard/simple/failure-accountability.mjs";
import {
	appendFailureRecord,
	failureLogPath,
	readFailureRecords,
	summarizeFailures,
} from "../src/switchyard/simple/failure-log.mjs";
import { classifyAttemptFailure } from "../src/switchyard/simple/failure-severity.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";
import { failureAttemptRecord } from "../src/switchyard/simple/routing-stop-record.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const root = () => realpathSync(tempDir("failure-log-"));
const attempt = (over = {}) => ({
	recordType: "attempt",
	project: "/review/project",
	routingRunId: "run-1",
	taskId: "task-1",
	attemptId: "attempt-1",
	runId: "simple-1",
	targetId: "codex",
	capability: "standard",
	severity: "soft",
	reason: "check_failed",
	causeCode: "acceptance_check_failed",
	phase: "check",
	...over,
});

test("appendFailureRecord keeps only allowlisted fields and nulls unsafe values", () => {
	const stateRoot = root();
	const record = appendFailureRecord(
		{
			...attempt(),
			prompt: "SECRET PROMPT",
			output: "provider output",
			argv: ["--secret"],
			environment: { HOME: "/home" },
			checkCommand: "cat /etc/passwd",
			fileContents: "file body",
			taskId: "t".repeat(257),
			errorKind: "bad\nkind",
			salvageable: "yes",
			partialRetained: 1,
		},
		{ stateRoot },
	);
	deepStrictEqual(Object.keys(record).sort(), [
		"attemptId",
		"capability",
		"causeCategory",
		"causeCode",
		"errorKind",
		"exhaustionCause",
		"failurePhase",
		"fingerprint",
		"origin",
		"partialRetained",
		"phase",
		"project",
		"reason",
		"recordType",
		"recordedAt",
		"routingRunId",
		"runId",
		"salvageable",
		"schemaVersion",
		"severity",
		"stopReason",
		"targetId",
		"taskId",
	]);
	strictEqual(record.schemaVersion, 1);
	strictEqual(record.recordType, "attempt");
	strictEqual(record.origin, "work");
	strictEqual(record.taskId, null);
	strictEqual(record.errorKind, null);
	strictEqual(record.salvageable, null);
	strictEqual(record.partialRetained, null);
	strictEqual(record.stopReason, null);
	strictEqual(record.exhaustionCause, null);
	strictEqual(record.causeCategory, null);
	strictEqual(record.failurePhase, null);
	strictEqual(Number.isNaN(Date.parse(record.recordedAt)), false);
	const raw = readFileSync(failureLogPath({ stateRoot }), "utf8");
	strictEqual(raw.includes("SECRET"), false);
	strictEqual(raw.includes("provider output"), false);
	strictEqual(raw.includes("--secret"), false);
	strictEqual(raw.includes("file body"), false);
	deepStrictEqual(JSON.parse(raw.trim()), record);
});

test("appendFailureRecord rejects unknown record types and nulls booleans", () => {
	const stateRoot = root();
	throws(() => appendFailureRecord({ recordType: "other" }, { stateRoot }), {
		code: "failure_log_record_type_invalid",
	});
	const record = appendFailureRecord(
		{ recordType: "stop", targetId: "codex", stopReason: "unsafe_failure" },
		{ stateRoot },
	);
	strictEqual(record.salvageable, null);
	strictEqual(record.partialRetained, null);
	const kept = appendFailureRecord(
		{
			recordType: "attempt",
			targetId: "codex",
			salvageable: true,
			partialRetained: false,
		},
		{ stateRoot },
	);
	strictEqual(kept.salvageable, true);
	strictEqual(kept.partialRetained, false);
});

test("failure log directory and file are created with restrictive modes", () => {
	const stateRoot = root();
	const path = failureLogPath({ stateRoot });
	strictEqual(path, join(stateRoot, "failure-log", "failures.jsonl"));
	strictEqual(statSync(join(stateRoot, "failure-log")).mode & 0o777, 0o700);
	strictEqual(statSync(path).mode & 0o777, 0o600);
	strictEqual(failureLogPath({ stateRoot }), path);
});

test("fingerprints are stable, derived from the identity fields, and stop-aware", () => {
	const stateRoot = root();
	const first = appendFailureRecord(attempt(), { stateRoot });
	const second = appendFailureRecord(attempt({ runId: "simple-2" }), {
		stateRoot,
	});
	strictEqual(first.fingerprint, second.fingerprint);
	strictEqual(
		first.fingerprint,
		createHash("sha256")
			.update("codex|check_failed|acceptance_check_failed|check")
			.digest("hex")
			.slice(0, 16),
	);
	const otherReason = appendFailureRecord(attempt({ reason: "empty_diff" }), {
		stateRoot,
	});
	strictEqual(otherReason.fingerprint === first.fingerprint, false);
	const stop = appendFailureRecord(
		{
			recordType: "stop",
			targetId: "codex",
			stopReason: "unsafe_failure",
			causeCode: "cleanup_failed",
			phase: "cleanup",
			reason: "check_failed",
		},
		{ stateRoot },
	);
	strictEqual(
		stop.fingerprint,
		createHash("sha256")
			.update("codex|unsafe_failure|cleanup_failed|cleanup")
			.digest("hex")
			.slice(0, 16),
	);
});

test("rotation moves records into retained segments and reads stay chronological", () => {
	const stateRoot = root();
	const previous = process.env.SWITCHYARD_LEDGER_MAX_BYTES;
	process.env.SWITCHYARD_LEDGER_MAX_BYTES = "1";
	try {
		appendFailureRecord(attempt({ targetId: "codex" }), { stateRoot });
		appendFailureRecord(attempt({ targetId: "vibe" }), { stateRoot });
	} finally {
		if (previous === undefined) delete process.env.SWITCHYARD_LEDGER_MAX_BYTES;
		else process.env.SWITCHYARD_LEDGER_MAX_BYTES = previous;
	}
	const path = failureLogPath({ stateRoot });
	strictEqual(existsSync(`${path}.1`), true);
	const records = readFailureRecords({ stateRoot });
	strictEqual(records.length, 2);
	strictEqual(records[0].targetId, "codex");
	strictEqual(records[1].targetId, "vibe");
});

test("readFailureRecords skips malformed lines and honors since", () => {
	const stateRoot = root();
	const path = failureLogPath({ stateRoot });
	appendFileSync(
		path,
		`${[
			JSON.stringify({
				...attempt(),
				recordedAt: "2026-10-01T00:00:00.000Z",
				fingerprint: "aaa",
			}),
			"{not json",
			JSON.stringify({
				recordType: "stop",
				recordedAt: "2026-10-02T00:00:00.000Z",
				targetId: "vibe",
				stopReason: "unsafe_failure",
				fingerprint: "bbb",
			}),
			"",
		].join("\n")}\n`,
	);
	const all = readFailureRecords({ stateRoot });
	strictEqual(all.length, 2);
	strictEqual(all[0].targetId, "codex");
	strictEqual(all[1].targetId, "vibe");
	const since = readFailureRecords({
		stateRoot,
		since: "2026-10-01T12:00:00Z",
	});
	strictEqual(since.length, 1);
	strictEqual(since[0].targetId, "vibe");
	const future = readFailureRecords({
		stateRoot,
		since: "2999-01-01T00:00:00Z",
	});
	strictEqual(future.length, 0);
	throws(() => readFailureRecords({ stateRoot, since: "nonsense" }), {
		code: "failure_log_since_invalid",
	});
});

test("summarizeFailures groups by fingerprint, orders by count then recency", () => {
	const stateRoot = root();
	appendFailureRecord(attempt({ project: "/review/p1", runId: "simple-1" }), {
		stateRoot,
	});
	appendFailureRecord(
		attempt({ project: "/review/p2", runId: "simple-2", capability: "high" }),
		{ stateRoot },
	);
	appendFailureRecord(
		attempt({
			targetId: "vibe",
			reason: "empty_diff",
			causeCode: null,
			phase: null,
			runId: "simple-3",
		}),
		{ stateRoot },
	);
	const summary = summarizeFailures(readFailureRecords({ stateRoot }));
	strictEqual(summary.groups.length, 2);
	const top = summary.groups[0];
	strictEqual(top.count, 2);
	strictEqual(top.recordType, "attempt");
	strictEqual(top.targetId, "codex");
	strictEqual(top.reason, "check_failed");
	strictEqual(top.causeCode, "acceptance_check_failed");
	strictEqual(top.phase, "check");
	strictEqual(top.projects, 2);
	deepStrictEqual(top.capabilities, ["high", "standard"]);
	deepStrictEqual(top.sampleRunIds, ["simple-1", "simple-2"]);
	strictEqual(summary.groups[1].count, 1);
	strictEqual(summary.groups[1].targetId, "vibe");
	strictEqual(summary.totals.byTargetId.codex, 2);
	strictEqual(summary.totals.byTargetId.vibe, 1);
	strictEqual(summary.totals.byReason.check_failed, 2);
	strictEqual(summary.totals.byReason.empty_diff, 1);
});

test("summary ordering breaks ties by lastSeen and caps sampleRunIds at three", () => {
	const record = (over) => ({
		recordType: "attempt",
		recordedAt: "2026-10-04T00:00:00.000Z",
		targetId: "codex",
		reason: "check_failed",
		causeCode: "acceptance_check_failed",
		phase: "check",
		project: "/review/project",
		capability: "standard",
		...over,
	});
	const summary = summarizeFailures([
		record({ recordedAt: "2026-10-01T00:00:00.000Z", runId: "run-1" }),
		record({ recordedAt: "2026-10-03T00:00:00.000Z", runId: "run-2" }),
		record({
			targetId: "vibe",
			reason: "empty_diff",
			causeCode: null,
			phase: null,
			recordedAt: "2026-10-02T00:00:00.000Z",
			runId: "run-3",
		}),
		record({
			targetId: "vibe",
			reason: "empty_diff",
			causeCode: null,
			phase: null,
			recordedAt: "2026-10-04T00:00:00.000Z",
			runId: "run-4",
		}),
		record({
			targetId: "vibe",
			reason: "empty_diff",
			causeCode: null,
			phase: null,
			recordedAt: "2026-10-05T00:00:00.000Z",
			runId: "run-5",
		}),
		record({
			targetId: "vibe",
			reason: "empty_diff",
			causeCode: null,
			phase: null,
			recordedAt: "2026-10-05T00:00:00.000Z",
			runId: "run-7",
		}),
		record({
			recordType: "stop",
			targetId: "vibe",
			stopReason: "unsafe_failure",
			reason: null,
			causeCode: null,
			phase: null,
			recordedAt: "2026-10-06T00:00:00.000Z",
			runId: "run-6",
		}),
		record({
			recordType: "stop",
			targetId: "vibe",
			stopReason: "unsafe_failure",
			reason: null,
			causeCode: null,
			phase: null,
			recordedAt: "2026-10-07T00:00:00.000Z",
			runId: "run-8",
		}),
	]);
	strictEqual(summary.groups.length, 3);
	strictEqual(summary.groups[0].count, 4);
	strictEqual(summary.groups[0].targetId, "vibe");
	strictEqual(summary.groups[0].lastSeen, "2026-10-05T00:00:00.000Z");
	strictEqual(summary.groups[0].firstSeen, "2026-10-02T00:00:00.000Z");
	deepStrictEqual(summary.groups[0].sampleRunIds, ["run-3", "run-4", "run-5"]);
	// count 2 groups tie; the more recently seen one comes first.
	strictEqual(summary.groups[1].count, 2);
	strictEqual(summary.groups[1].lastSeen, "2026-10-07T00:00:00.000Z");
	strictEqual(summary.groups[1].firstSeen, "2026-10-06T00:00:00.000Z");
	strictEqual(summary.groups[1].reason, "unsafe_failure");
	strictEqual(summary.groups[1].recordType, "stop");
	strictEqual(summary.groups[2].count, 2);
	strictEqual(summary.groups[2].lastSeen, "2026-10-03T00:00:00.000Z");
	strictEqual(summary.totals.byReason.unsafe_failure, 2);
	strictEqual(summary.totals.byReason.empty_diff, 4);
	strictEqual(summary.totals.byReason.check_failed, 2);
	strictEqual(summary.totals.byTargetId.vibe, 6);
	strictEqual(summary.totals.byTargetId.codex, 2);
});

test("appendFailureRecord validates closed origins and defaults to work", () => {
	const stateRoot = root();
	const workRec = appendFailureRecord(attempt({ origin: "work" }), {
		stateRoot,
	});
	strictEqual(workRec.origin, "work");

	const qualRec = appendFailureRecord(
		attempt({ origin: "qualification", runId: "qual-1" }),
		{ stateRoot },
	);
	strictEqual(qualRec.origin, "qualification");

	throws(
		() =>
			appendFailureRecord(attempt({ origin: "unrecognized" }), { stateRoot }),
		{ code: "failure_log_origin_invalid" },
	);
});

test("readFailureRecords defaults missing origin to work for legacy records", () => {
	const stateRoot = root();
	const path = failureLogPath({ stateRoot });
	appendFileSync(
		path,
		`${JSON.stringify({
			...attempt(),
			recordedAt: "2026-10-01T00:00:00.000Z",
			fingerprint: "legacy-fingerprint",
		})}\n`,
	);
	const records = readFailureRecords({ stateRoot });
	strictEqual(records.length, 1);
	strictEqual(records[0].origin, "work");
});

test("summarizeFailures separates work versus qualification failure statistics", () => {
	const stateRoot = root();
	appendFailureRecord(
		attempt({
			targetId: "codex",
			runId: "work-1",
			origin: "work",
			reason: "check_failed",
		}),
		{ stateRoot },
	);
	appendFailureRecord(
		attempt({
			targetId: "codex",
			runId: "work-2",
			origin: "work",
			reason: "check_failed",
		}),
		{ stateRoot },
	);
	appendFailureRecord(
		attempt({
			targetId: "codex",
			runId: "qual-1",
			origin: "qualification",
			reason: "check_failed",
		}),
		{ stateRoot },
	);

	const records = readFailureRecords({ stateRoot });

	// Default summary: work origin only, excluding qualification
	const defaultSummary = summarizeFailures(records);
	strictEqual(defaultSummary.groups.length, 1);
	strictEqual(defaultSummary.groups[0].count, 2);
	strictEqual(defaultSummary.totals.byTargetId.codex, 2);
	deepStrictEqual(defaultSummary.groups[0].sampleRunIds, ["work-1", "work-2"]);

	// Explicit qualification summary
	const qualSummary = summarizeFailures(records, { origin: "qualification" });
	strictEqual(qualSummary.groups.length, 1);
	strictEqual(qualSummary.groups[0].count, 1);
	strictEqual(qualSummary.totals.byTargetId.codex, 1);
	deepStrictEqual(qualSummary.groups[0].sampleRunIds, ["qual-1"]);

	// All origins summary
	const allSummary = summarizeFailures(records, { origin: "all" });
	strictEqual(allSummary.groups.length, 1);
	strictEqual(allSummary.groups[0].count, 3);
	strictEqual(allSummary.totals.byTargetId.codex, 3);

	// Invalid origin filter throws
	throws(() => summarizeFailures(records, { origin: "invalid" }), {
		code: "failure_log_origin_invalid",
	});
});

test("invalid persisted origins are excluded while legacy work remains counted", () => {
	const stateRoot = root();
	const valid = appendFailureRecord(attempt(), { stateRoot });
	const invalid = { ...valid, origin: "unrecognized", runId: "invalid-origin" };
	appendFileSync(failureLogPath({ stateRoot }), `${JSON.stringify(invalid)}\n`);
	strictEqual(readFailureRecords({ stateRoot }).length, 1);
	const legacy = { ...valid, runId: "legacy-origin" };
	delete legacy.origin;
	const summary = summarizeFailures([valid, invalid, legacy]);
	strictEqual(summary.totals.byTargetId.codex, 2);
});

test("failure log uses only matching timed-out provider evidence for deadline reason", () => {
	const stateRoot = root();
	const result = (timedOut) => ({
		status: "failed",
		failureReason: "provider_exit_nonzero",
		failurePhase: "execute",
		errorKind: "execution_failed",
		partialWorktree: null,
		providerReliability: createSimpleProviderReliabilityDiagnostic({
			failureReason: "provider_exit_nonzero",
			failurePhase: "execute",
			errorKind: "execution_failed",
			providerResult: { code: 76, timedOut },
		}),
	});
	const appendAttempt = (failure, accountability) => {
		const classification = classifyAttemptFailure({
			result: failure,
			accountability,
		});
		strictEqual(classification.reason, "execution_failed");
		return appendFailureRecord(
			failureAttemptRecord({
				project: "/review/project",
				routingRunId: "run-1",
				attempt: attempt(),
				result: failure,
				accountability,
				classification,
			}),
			{ stateRoot },
		);
	};
	const timedOut = result(true);
	const deadlineAccountability = deriveFailureAccountability({
		providerReliability: timedOut.providerReliability,
	});
	appendAttempt(timedOut, deadlineAccountability);
	const ordinary = result(false);
	const ordinaryAccountability = deriveFailureAccountability({
		providerReliability: ordinary.providerReliability,
	});
	appendAttempt(ordinary, ordinaryAccountability);
	appendAttempt(
		{ ...ordinary, providerReliability: undefined },
		deriveFailureAccountability({}),
	);
	appendAttempt(timedOut, ordinaryAccountability);
	deepStrictEqual(
		readFailureRecords({ stateRoot }).map(({ reason, causeCode }) => ({
			reason,
			causeCode,
		})),
		[
			{
				reason: "provider_deadline_exceeded",
				causeCode: "provider_deadline_exceeded",
			},
			{ reason: "execution_failed", causeCode: "provider_exit_nonzero" },
			{ reason: "execution_failed", causeCode: "unknown" },
			{ reason: "execution_failed", causeCode: "provider_deadline_exceeded" },
		],
	);
});
