import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SimpleUsageError } from "../src/switchyard/simple/args.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

function createProjectFixture() {
	const root = realpathSync(tempDir("simple-cli-error-detail-"));
	const project = join(root, "project");
	mkdirSync(project);
	strictEqual(
		spawnSync("git", ["init", "-q", project], {
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
			},
		}).status,
		0,
	);
	writeFileSync(
		join(project, "prompt.txt"),
		"RequiredCapability: standard\nPerform task",
	);
	writeFileSync(join(project, "a.txt"), "content");
	return { root, project };
}

describe("simple CLI usage and preflight error detail", () => {
	it("returns usageError naming the deadline rule and writes stderr when deadline is more than 30 minutes ahead with --json", async () => {
		const { project } = createProjectFixture();
		const now = 1_700_000_000_000;
		const deadline = new Date(now + 31 * 60 * 1000).toISOString();
		const argv = [
			join(project, "prompt.txt"),
			"--project",
			project,
			"--capability",
			"standard",
			"--file",
			"a.txt",
			"--check",
			"true",
			"--deadline",
			deadline,
			"--json",
		];
		let resultJson = null;
		const stderrLines = [];
		const signalProcess = new EventEmitter();
		signalProcess.exitCode = 0;

		await handleSimple(argv, {
			now: () => now,
			signalProcess,
			writeResult: (val) => {
				resultJson = JSON.parse(val);
			},
			writeStderr: (line) => {
				stderrLines.push(line);
			},
		});

		ok(resultJson !== null);
		strictEqual(resultJson.status, "failed");
		strictEqual(resultJson.failureReason, "invalid_invocation");
		strictEqual(resultJson.failurePhase, "preflight");
		strictEqual(resultJson.errorKind, "validation_failed");
		strictEqual(resultJson.preflightCode, undefined);
		strictEqual(
			resultJson.usageError,
			"--deadline may be at most 30 minutes ahead",
		);
		strictEqual(signalProcess.exitCode, 2);
		deepStrictEqual(stderrLines, [
			"switchyard simple: --deadline may be at most 30 minutes ahead\n",
		]);
	});

	it("returns preflightCode and writes stderr line when injected dependency throws with safe code routing_state_locked", async () => {
		const { project } = createProjectFixture();
		const now = 1_700_000_000_000;
		const deadline = new Date(now + 10 * 60 * 1000).toISOString();
		const argv = [
			join(project, "prompt.txt"),
			"--project",
			project,
			"--capability",
			"standard",
			"--file",
			"a.txt",
			"--check",
			"true",
			"--deadline",
			deadline,
			"--json",
		];
		let resultJson = null;
		const stderrLines = [];
		const signalProcess = new EventEmitter();
		signalProcess.exitCode = 0;

		await handleSimple(argv, {
			now: () => now,
			signalProcess,
			writeResult: (val) => {
				resultJson = JSON.parse(val);
			},
			writeStderr: (line) => {
				stderrLines.push(line);
			},
			openRoutingRun: () => {
				const err = new Error("routing state lock conflict");
				err.code = "routing_state_locked";
				throw err;
			},
		});

		ok(resultJson !== null);
		strictEqual(resultJson.status, "failed");
		strictEqual(resultJson.failureReason, "preflight_failed");
		strictEqual(resultJson.failurePhase, "preflight");
		strictEqual(resultJson.errorKind, "unclassified_failure");
		strictEqual(resultJson.usageError, undefined);
		strictEqual(resultJson.preflightCode, "routing_state_locked");
		strictEqual(signalProcess.exitCode, 1);
		deepStrictEqual(stderrLines, [
			"switchyard simple: preflight failed (routing_state_locked)\n",
		]);
	});

	it("returns preflightCode uncoded and writes constructor name to stderr for error without safe code", async () => {
		const { project } = createProjectFixture();
		const now = 1_700_000_000_000;
		const deadline = new Date(now + 10 * 60 * 1000).toISOString();
		const argv = [
			join(project, "prompt.txt"),
			"--project",
			project,
			"--capability",
			"standard",
			"--file",
			"a.txt",
			"--check",
			"true",
			"--deadline",
			deadline,
		];
		let resultJson = null;
		const stderrLines = [];
		const signalProcess = new EventEmitter();

		await handleSimple(argv, {
			now: () => now,
			signalProcess,
			writeResult: (val) => {
				resultJson = JSON.parse(val);
			},
			writeStderr: (line) => {
				stderrLines.push(line);
			},
			openRoutingRun: () => {
				throw new TypeError("invalid route configuration");
			},
		});

		ok(resultJson !== null);
		strictEqual(resultJson.status, "failed");
		strictEqual(resultJson.failureReason, "preflight_failed");
		strictEqual(resultJson.failurePhase, "preflight");
		strictEqual(resultJson.errorKind, "unclassified_failure");
		strictEqual(resultJson.usageError, undefined);
		strictEqual(resultJson.preflightCode, "uncoded");
		strictEqual(signalProcess.exitCode, 1);
		deepStrictEqual(stderrLines, [
			"switchyard simple: preflight failed (TypeError)\n",
		]);
	});

	it("falls back to uncoded for error with unsafe code format", async () => {
		const { project } = createProjectFixture();
		const now = 1_700_000_000_000;
		const deadline = new Date(now + 10 * 60 * 1000).toISOString();
		const argv = [
			join(project, "prompt.txt"),
			"--project",
			project,
			"--capability",
			"standard",
			"--file",
			"a.txt",
			"--check",
			"true",
			"--deadline",
			deadline,
		];
		let resultJson = null;
		const stderrLines = [];
		const signalProcess = new EventEmitter();

		await handleSimple(argv, {
			now: () => now,
			signalProcess,
			writeResult: (val) => {
				resultJson = JSON.parse(val);
			},
			writeStderr: (line) => {
				stderrLines.push(line);
			},
			openRoutingRun: () => {
				const err = new Error("unsafe error");
				err.code = "bad code with whitespace!";
				throw err;
			},
		});

		ok(resultJson !== null);
		strictEqual(resultJson.preflightCode, "uncoded");
		deepStrictEqual(stderrLines, [
			"switchyard simple: preflight failed (Error)\n",
		]);
	});

	it("sanitizes control characters and truncates usageError to 300 characters", async () => {
		const { project } = createProjectFixture();
		const now = 1_700_000_000_000;
		const deadline = new Date(now + 10 * 60 * 1000).toISOString();
		const argv = [
			join(project, "prompt.txt"),
			"--project",
			project,
			"--capability",
			"standard",
			"--file",
			"a.txt",
			"--check",
			"true",
			"--deadline",
			deadline,
		];
		let resultJson = null;
		const stderrLines = [];
		const signalProcess = new EventEmitter();

		const longMessage = `prefix\x00\x07\r\n${"x".repeat(350)}`;
		await handleSimple(argv, {
			now: () => now,
			signalProcess,
			writeResult: (val) => {
				resultJson = JSON.parse(val);
			},
			writeStderr: (line) => {
				stderrLines.push(line);
			},
			openRoutingRun: () => {
				throw new SimpleUsageError(longMessage);
			},
		});

		ok(resultJson !== null);
		strictEqual(resultJson.usageError.length, 300);
		ok(!/[\p{Cc}]/u.test(resultJson.usageError));
		strictEqual(resultJson.usageError, `prefix${"x".repeat(294)}`);
		deepStrictEqual(stderrLines, [
			`switchyard simple: prefix${"x".repeat(294)}\n`,
		]);
	});

	it("writes to process.stderr.write by default when writeStderr is not supplied", async () => {
		const { project } = createProjectFixture();
		const now = 1_700_000_000_000;
		const deadline = new Date(now + 35 * 60 * 1000).toISOString();
		const argv = [
			join(project, "prompt.txt"),
			"--project",
			project,
			"--capability",
			"standard",
			"--file",
			"a.txt",
			"--check",
			"true",
			"--deadline",
			deadline,
			"--json",
		];
		const captured = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = (chunk) => {
			captured.push(String(chunk));
			return true;
		};
		try {
			await handleSimple(argv, {
				now: () => now,
				signalProcess: new EventEmitter(),
				writeResult: () => {},
			});
		} finally {
			process.stderr.write = originalWrite;
		}
		deepStrictEqual(captured, [
			"switchyard simple: --deadline may be at most 30 minutes ahead\n",
		]);
	});
});
