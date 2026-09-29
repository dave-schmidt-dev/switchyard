import { strict as assert } from "node:assert";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runProviderProcess } from "../src/switchyard/adapter/provider-lifecycle.mjs";
import {
	createBridgeRequestRecorder,
	parseBridgeRequestEvent,
	REQUEST_END_PREFIX,
	REQUEST_EVENT_PREFIX,
} from "../src/switchyard/simple/request-evidence.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const event = (sequence, outcome = "upstream_http_success") => ({
	sequence,
	elapsedMs: sequence * 10,
	durationMs: 8,
	outcome,
	httpStatus: 200,
	upstreamStatus: 200,
});
const end = (requests) =>
	`${REQUEST_END_PREFIX}${JSON.stringify({ requests })}\n`;

test("request evidence persists safe per-request records across stream chunks", () => {
	const root = tempDir("switchyard-request-evidence-");
	try {
		const path = join(root, "provider-requests.jsonl");
		const recorder = createBridgeRequestRecorder(path);
		const first = `${REQUEST_EVENT_PREFIX}${JSON.stringify(event(1))}\n`;
		const second = `${REQUEST_EVENT_PREFIX}${JSON.stringify(event(2, "upstream_http_error"))}\n`;
		recorder.accept(Buffer.from(first.slice(0, 30)));
		recorder.accept(
			Buffer.from(`${first.slice(30)}bridge heartbeat\n${second}`),
		);
		recorder.accept(Buffer.from(end(2)));
		assert.deepEqual(recorder.close(), { count: 2, error: null });
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.deepEqual(
			readFileSync(path, "utf8").trim().split("\n").map(JSON.parse),
			[event(1), event(2, "upstream_http_error"), { type: "end", requests: 2 }],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("request evidence rejects unexpected fields and detects missing requests", () => {
	const root = tempDir("switchyard-request-evidence-");
	try {
		assert.equal(
			parseBridgeRequestEvent(
				`${REQUEST_EVENT_PREFIX}${JSON.stringify({ ...event(1), authorization: "secret" })}`,
			),
			null,
		);
		const path = join(root, "provider-requests.jsonl");
		const recorder = createBridgeRequestRecorder(path);
		recorder.accept(
			Buffer.from(`${REQUEST_EVENT_PREFIX}${JSON.stringify(event(2))}\n`),
		);
		assert.deepEqual(recorder.close(), {
			count: 1,
			error: "request_event_end_missing",
		});
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), event(2));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("request evidence accepts concurrent completions out of sequence", () => {
	const root = tempDir("switchyard-request-evidence-");
	try {
		const recorder = createBridgeRequestRecorder(
			join(root, "provider-requests.jsonl"),
		);
		recorder.accept(
			Buffer.from(`${REQUEST_EVENT_PREFIX}${JSON.stringify(event(2))}\n`),
		);
		recorder.accept(
			Buffer.from(`${REQUEST_EVENT_PREFIX}${JSON.stringify(event(1))}\n`),
		);
		recorder.accept(Buffer.from(end(2)));
		assert.deepEqual(recorder.close(), { count: 2, error: null });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("request evidence marks an abruptly ended bridge log incomplete", () => {
	const root = tempDir("switchyard-request-evidence-");
	try {
		const recorder = createBridgeRequestRecorder(
			join(root, "provider-requests.jsonl"),
		);
		recorder.accept(
			Buffer.from(`${REQUEST_EVENT_PREFIX}${JSON.stringify(event(1))}\n`),
		);
		assert.deepEqual(recorder.close(), {
			count: 1,
			error: "request_event_end_missing",
		});
		const mismatch = createBridgeRequestRecorder(join(root, "mismatch.jsonl"));
		mismatch.accept(
			Buffer.from(
				`${REQUEST_EVENT_PREFIX}${JSON.stringify(event(1))}\n${end(2)}`,
			),
		);
		assert.deepEqual(mismatch.close(), {
			count: 1,
			error: "request_event_end_invalid",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("provider process streams bridge evidence into the durable recorder", async () => {
	const root = tempDir("switchyard-request-evidence-");
	try {
		const path = join(root, "provider-requests.jsonl");
		const recorder = createBridgeRequestRecorder(path);
		const line = `${REQUEST_EVENT_PREFIX}${JSON.stringify(event(1))}\n`;
		const result = await runProviderProcess(
			process.execPath,
			["-e", `process.stderr.write(${JSON.stringify(line + end(1))})`],
			{ onStderrChunk: recorder.accept, timeoutMs: 5000 },
		);
		assert.equal(result.success, true);
		assert.deepEqual(recorder.close(), { count: 1, error: null });
		assert.deepEqual(
			readFileSync(path, "utf8").trim().split("\n").map(JSON.parse),
			[event(1), { type: "end", requests: 1 }],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
