import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultMeasureApfsPrivateBytes } from "../src/switchyard/dispatch/index.mjs";
import {
	__dirname,
	ROSTER_FIXTURE_PATH,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	// Set env var so direct run-store calls in tests target the temp dir
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	rmSync(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});
describe("gc subcommand (T62)", () => {
	it("apfs-private-bytes.py standalone helper respects file count bound and returns valid JSON", async () => {
		const rawParent = tempDir("gc-helper-parent-");
		const parent = realpathSync(rawParent);

		const candidate = "switchyard-simple-helper-bound";
		const rootPath = join(parent, candidate);
		mkdirSync(rootPath, { recursive: true });
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(rootPath, `file-${i}.bin`), Buffer.alloc(1024, 0x62));
		}

		// When maxFiles is 2, visiting 5 files must trigger file_count_exceeded bound
		const result = await defaultMeasureApfsPrivateBytes(
			[rootPath],
			{ maxFiles: 2 },
			{},
		);
		ok(result.roots[rootPath]);
		if (process.platform === "darwin") {
			strictEqual(result.roots[rootPath].measurable, false);
			strictEqual(result.roots[rootPath].bytes, null);
			strictEqual(result.totalBytes, null);
			strictEqual(
				result.roots[rootPath].unavailableReason,
				"file_count_exceeded",
			);
		}
	});
	it("rejects malformed APFS helper stdin instead of reporting an empty success", () => {
		const helper = resolve(__dirname, "..", "scripts", "apfs-private-bytes.py");
		const result = spawnSync("/usr/bin/python3", [helper, "--stdin"], {
			input: "{invalid",
			encoding: "utf8",
		});
		strictEqual(result.status, 2);
		ok(result.stderr.includes("Invalid root list on stdin"));
		strictEqual(result.stdout, "");
	});
	it("forces a hung measurement helper to stop after its timeout", async () => {
		const kills = [];
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { end() {} };
		child.killed = false;
		child.kill = (signal) => {
			kills.push(signal);
			child.killed = true;
			if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
			return true;
		};
		const result = await defaultMeasureApfsPrivateBytes(
			["/disposable-test-root"],
			{ timeoutMs: 5, termGraceMs: 5 },
			{ spawnFn: () => child, stderr: { write() {} } },
		);
		strictEqual(result.status, "timeout");
		deepStrictEqual(kills, ["SIGTERM", "SIGKILL"]);
	});
	it("handles an asynchronous stdin EPIPE when measurement exits early", async () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = new EventEmitter();
		child.stdin.end = () => {
			queueMicrotask(() => {
				child.stdin.emit("error", new Error("EPIPE"));
				child.emit("close", 1);
			});
		};
		const roots = Array.from({ length: 51 }, (_, i) => `/fixture-${i}`);
		const result = await defaultMeasureApfsPrivateBytes(
			roots,
			{},
			{
				spawnFn: () => child,
				stderr: { write() {} },
			},
		);
		strictEqual(result.status, "error");
	});
	it("decodes split UTF-8 output and escalates an overflowing helper", async () => {
		const unicodePath = "/fixture-ü";
		const payload = Buffer.from(
			JSON.stringify({
				status: "ok",
				roots: { [unicodePath]: { measurable: true, bytes: 1 } },
			}),
		);
		const split = payload.indexOf(Buffer.from("ü")) + 1;
		const decoded = new EventEmitter();
		decoded.stdout = new EventEmitter();
		decoded.stderr = new EventEmitter();
		decoded.stdin = { end() {} };
		queueMicrotask(() => {
			decoded.stdout.emit("data", payload.subarray(0, split));
			decoded.stdout.emit("data", payload.subarray(split));
			decoded.emit("close", 0);
		});
		const result = await defaultMeasureApfsPrivateBytes(
			[unicodePath],
			{},
			{
				spawnFn: () => decoded,
				stderr: { write() {} },
			},
		);
		strictEqual(result.roots[unicodePath].bytes, 1);

		const hung = new EventEmitter();
		hung.stdout = new EventEmitter();
		hung.stderr = new EventEmitter();
		hung.stdin = { end() {} };
		const kills = [];
		hung.kill = (signal) => {
			kills.push(signal);
			if (signal === "SIGKILL") queueMicrotask(() => hung.emit("close", null));
			return true;
		};
		queueMicrotask(() => hung.stdout.emit("data", Buffer.alloc(16)));
		const overflow = await defaultMeasureApfsPrivateBytes(
			[unicodePath],
			{
				maxOutputBytes: 1,
				timeoutMs: 500,
				termGraceMs: 5,
			},
			{ spawnFn: () => hung, stderr: { write() {} } },
		);
		strictEqual(overflow.status, "output_exceeded");
		deepStrictEqual(kills, ["SIGTERM", "SIGKILL"]);
	});
});
