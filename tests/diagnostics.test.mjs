import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { Diagnostics } from "../src/switchyard/diagnostics/index.mjs";

describe("diagnostics emit/sink", () => {
	it("emit() calls all registered sinks", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));
		d.sink((e) => received.push(e));

		d.emit({ phase: "execution", event: "task_started", status: "hello" });

		strictEqual(received.length, 2);
		strictEqual(received[0].event, "task_started");
		strictEqual(received[1].event, "task_started");
	});

	it("sink() adds a sink; removeSink() removes it", () => {
		const d = new Diagnostics();
		const received = [];
		const fn = (e) => received.push(e);
		d.sink(fn);
		d.emit({ phase: "seed", event: "terminal", status: "x" });
		strictEqual(received.length, 1);

		d.removeSink(fn);
		d.emit({ phase: "seed", event: "terminal", status: "y" });
		strictEqual(received.length, 1);
	});

	it("multiple sinks receive the same event", () => {
		const d = new Diagnostics();
		const a = [];
		const b = [];
		d.sink((e) => a.push(e));
		d.sink((e) => b.push(e));

		d.emit({ phase: "routing", event: "gate_validated", status: "ok" });

		strictEqual(a.length, 1);
		strictEqual(b.length, 1);
		deepStrictEqual(a[0], b[0]);
	});

	it("timestamp is auto-set if not provided", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		d.emit({ phase: "lifecycle", event: "terminal", status: "done" });

		ok(typeof received[0].timestamp === "string");
		ok(Date.parse(received[0].timestamp) > 0);
	});

	it("does not overwrite an explicit timestamp", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		d.emit({
			phase: "lifecycle",
			event: "terminal",
			status: "done",
			timestamp: "2026-01-15T12:00:00.000Z",
		});

		strictEqual(received[0].timestamp, "2026-01-15T12:00:00.000Z");
	});

	it("sink errors do not propagate", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink(() => {
			throw new Error("sink exploded");
		});
		d.sink((e) => received.push(e));

		d.emit({ phase: "execution", event: "task_completed", status: "ok" });

		strictEqual(received.length, 1);
	});
});

describe("diagnostics error serialization", () => {
	it("only allowlisted fields survive (name, message, code, phase, taskId, provider, model, exitStatus)", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		const err = new Error("something broke");
		err.code = "E_SOMETHING";
		err.stack = "secret-trace";
		err.env = { HOME: "/secret" };
		err.cwd = "/secret/cwd";
		err.cmd = "secret-cmd";
		err.argv = ["secret-arg"];
		err.config = { secret: true };
		err.stderr = "secret-stderr";
		err.stdout = "secret-stdout";
		err.credentials = "secret-creds";
		err.phase = "execution";
		err.taskId = "task-1";
		err.provider = "claude";
		err.model = "claude-sonnet-5";
		err.exitStatus = 1;

		d.emit({
			phase: "execution",
			event: "task_failed",
			status: "broke",
			error: err,
		});

		const serialized = received[0].error;
		strictEqual(serialized.name, "Error");
		strictEqual(serialized.message, "something broke");
		strictEqual(serialized.code, "E_SOMETHING");
		strictEqual(serialized.phase, "execution");
		strictEqual(serialized.taskId, "task-1");
		strictEqual(serialized.provider, "claude");
		strictEqual(serialized.model, "claude-sonnet-5");
		strictEqual(serialized.exitStatus, 1);
		strictEqual(serialized.stack, undefined);
		strictEqual(serialized.env, undefined);
		strictEqual(serialized.cwd, undefined);
		strictEqual(serialized.cmd, undefined);
		strictEqual(serialized.argv, undefined);
		strictEqual(serialized.config, undefined);
		strictEqual(serialized.stderr, undefined);
		strictEqual(serialized.stdout, undefined);
		strictEqual(serialized.credentials, undefined);
	});

	it("strips stack traces", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		const err = new Error("boom");
		err.stack = "Error: boom\n    at file.js:1:2";
		d.emit({
			phase: "execution",
			event: "task_failed",
			status: "broke",
			error: err,
		});

		strictEqual(received[0].error.stack, undefined);
	});

	it("serializes plain object errors (non-Error instances)", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		d.emit({
			phase: "execution",
			event: "task_failed",
			status: "broke",
			error: {
				name: "CustomError",
				message: "plain object boom",
				code: "E_CUSTOM",
				extra: "should not appear",
			},
		});

		strictEqual(received[0].error.name, "CustomError");
		strictEqual(received[0].error.message, "plain object boom");
		strictEqual(received[0].error.code, "E_CUSTOM");
		strictEqual(received[0].error.extra, undefined);
	});

	it("serializes string errors as { message }", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		d.emit({
			phase: "execution",
			event: "task_failed",
			status: "broke",
			error: "plain string error",
		});

		strictEqual(received[0].error.message, "plain string error");
	});

	it("redacts paths from error messages", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		const err = new Error(
			"Failed to read /Users/dave/Projects/switchyard/.env",
		);
		d.emit({
			phase: "cleanup",
			event: "cleanup_failed",
			status: "broke",
			error: err,
		});

		ok(!received[0].error.message.includes("/Users/dave"));
		ok(received[0].error.message.includes("[REDACTED]"));
	});
});

describe("diagnostics secret canary", () => {
	it("redacts any field value containing SECRET_CANARY_", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		d.emit({
			phase: "execution",
			event: "task_failed",
			status: "SECRET_CANARY_abc123",
			taskId: "task-1",
		});

		strictEqual(received[0].status, "[REDACTED]");
		strictEqual(received[0].event, "task_failed");
		strictEqual(received[0].taskId, "task-1");
	});

	it("does not redact values without the canary pattern", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		d.emit({
			phase: "execution",
			event: "task_started",
			status: "normal status",
			taskId: "CANARY_OK",
		});

		strictEqual(received[0].status, "normal status");
		strictEqual(received[0].taskId, "CANARY_OK");
	});

	it("redacts canary in nested error object fields", () => {
		const d = new Diagnostics();
		const received = [];
		d.sink((e) => received.push(e));

		d.emit({
			phase: "execution",
			event: "task_failed",
			status: "broke",
			error: {
				name: "Error",
				message: "SECRET_CANARY_leaked_value",
				code: "OK",
			},
		});

		strictEqual(received[0].error.message, "[REDACTED]");
		strictEqual(received[0].error.code, "OK");
	});
});

describe("diagnostics createRejectionRecord", () => {
	it("contains only allowed fields, no diff text", () => {
		const record = Diagnostics.createRejectionRecord({
			taskId: "task-1",
			runId: "run-abc",
			gateCode: "FILE_COUNT_EXCEEDED",
			byteCount: 5000,
			hunkCount: 3,
			fileCount: 2,
			diffSha256: "abc123def456",
			normalizedPaths: [
				"/Users/dave/Projects/foo/src/a.js",
				"/tmp/scratch/b.js",
			],
			dumpPath: "/Users/dave/.logs/switchyard/dump.json",
		});

		strictEqual(record.schemaVersion, 1);
		strictEqual(record.taskId, "task-1");
		strictEqual(record.runId, "run-abc");
		strictEqual(record.gateCode, "FILE_COUNT_EXCEEDED");
		strictEqual(record.byteCount, 5000);
		strictEqual(record.hunkCount, 3);
		strictEqual(record.fileCount, 2);
		strictEqual(record.diffSha256, "abc123def456");
		strictEqual(typeof record.timestamp, "string");

		ok(record.normalizedPaths[0].includes("[REDACTED]"));
		ok(record.normalizedPaths[1].includes("[REDACTED]"));

		strictEqual(record.patchText, undefined);
		strictEqual(record.hunkBodies, undefined);
		strictEqual(record.lineContext, undefined);
		strictEqual(record.rawPaths, undefined);
		strictEqual(record.env, undefined);
		strictEqual(record.promptText, undefined);
	});

	it("excludes undefined fields from output", () => {
		const record = Diagnostics.createRejectionRecord({
			taskId: "task-2",
		});

		strictEqual(record.schemaVersion, 1);
		strictEqual(record.taskId, "task-2");
		strictEqual(record.runId, undefined);
		strictEqual(record.gateCode, undefined);
		strictEqual(record.byteCount, undefined);
		strictEqual(record.normalizedPaths, undefined);
	});
});
