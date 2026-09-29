import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureProviderDiff,
	captureProviderDiffAsync,
	captureProviderDiffDetailed,
	captureProviderDiffDetailedAsync,
	executeProviderInvocation,
	getWorkspaceExecution,
} from "../src/switchyard/adapter/provider-lifecycle.mjs";
import { captureTaskStartTree } from "../src/switchyard/lifecycle/index.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TASK_BASE = {
	ref: "refs/switchyard/task-base/test-run/1.1",
	tree: "1".repeat(40),
};

function taskBaseValidationCommand(argv) {
	return argv[1] === "rev-parse"
		? {
				command: process.execPath,
				args: ["-e", `process.stdout.write(${JSON.stringify(TASK_BASE.tree)})`],
			}
		: null;
}

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end() {} };
	child.signals = [];
	child.kill = (signal) => {
		child.signals.push(signal);
		if (signal === "SIGKILL")
			queueMicrotask(() => child.emit("close", null, signal));
		return true;
	};
	return child;
}

describe("provider process lifecycle", () => {
	it("retains the guest provider binding across a VM transport command", async () => {
		const executionBackend = {
			execArgv(_workspaceId, options) {
				options.argv[0] = "prlctl";
				return {
					command: "prlctl",
					args: ["exec", "fixture-vm", "base64-guest-argv"],
				};
			},
		};
		const execution = getWorkspaceExecution("worker", {
			executionBackend,
			argv: ["claude", "--print", "prompt"],
		});
		const child = fakeChild();
		const promise = executeProviderInvocation(
			execution.command,
			execution.args,
			{
				provider: "claude",
				executionBackend,
				spawnFn: () => child,
			},
		);
		child.stdout.emit("data", "Error: Session expired\n");
		child.stderr.emit("data", "Session expired\n");
		child.emit("close", 1, null);
		const result = await promise;
		strictEqual(execution.command, "prlctl");
		strictEqual(result.diagnosticCode, "auth_expired");
		strictEqual(result.diagnosticEvidence.diagnosticKind, "auth_required");
		strictEqual(result.diagnosticEvidence.diagnosticCode, undefined);
	});

	it("captures add and diff asynchronously through PID-safe transport", async () => {
		const calls = [];
		const backendOptions = [];
		// getWorkspaceExecution now requires an executionBackend with no
		// default (the removed DEFAULT_EXECUTION_BACKEND used to fill this
		// in). This test only cares that the argv tail reaches spawnFn
		// unchanged, so a minimal passthrough is enough -- no real Docker
		// transport needed here.
		const passthroughExecutionBackend = {
			execArgv(_workspaceId, options = {}) {
				backendOptions.push(options);
				const { argv } = options;
				const validation = taskBaseValidationCommand(argv);
				if (validation) return validation;
				return { command: "fake", args: [...argv] };
			},
		};
		const result = await captureProviderDiffAsync("worker", {
			executionBackend: passthroughExecutionBackend,
			taskBase: TASK_BASE,
			spawnFn: (_command, args) => {
				calls.push(args.at(-1));
				const child = fakeChild();
				queueMicrotask(() => {
					if (args.at(-1) === "-A") child.emit("close", 0, null);
					else {
						child.stdout.emit("data", "diff --git a/a b/a\n");
						child.emit("close", 0, null);
					}
				});
				return child;
			},
		});
		strictEqual(typeof result, "string");
		deepStrictEqual(calls, ["-A", TASK_BASE.tree]);
		deepStrictEqual(
			backendOptions.map((options) => options.recordPid),
			[true, true, true],
		);
	});

	it("reports bounded async diff-capture outcomes without raw process output", async () => {
		const backend = {
			execArgv(_workspaceId, { argv }) {
				const validation = taskBaseValidationCommand(argv);
				if (validation) return validation;
				return { command: "fake", args: [...argv] };
			},
		};
		const run = (exitCode, output = "") =>
			captureProviderDiffDetailedAsync("worker", {
				executionBackend: backend,
				taskBase: TASK_BASE,
				spawnFn: (_command, _args) => {
					const child = fakeChild();
					queueMicrotask(() => {
						if (output) child.stdout.emit("data", output);
						child.emit("close", exitCode, null);
					});
					return child;
				},
			});
		strictEqual((await run(0, "diff")).status, "captured");
		strictEqual((await run(0)).status, "empty");
		strictEqual((await run(7)).status, "stage_failed");

		let call = 0;
		const diffFailed = await captureProviderDiffDetailedAsync("worker", {
			executionBackend: backend,
			taskBase: TASK_BASE,
			spawnFn: (_command, _args) => {
				const child = fakeChild();
				queueMicrotask(() => child.emit("close", call++ === 0 ? 0 : 9, null));
				return child;
			},
		});
		strictEqual(diffFailed.status, "diff_failed");

		const transportFailed = await captureProviderDiffDetailedAsync("worker", {
			executionBackend: backend,
			taskBase: TASK_BASE,
			spawnFn: () => {
				throw new Error("transport detail must not escape");
			},
		});
		strictEqual(transportFailed.status, "transport_failed");

		const timedOut = await captureProviderDiffDetailedAsync("worker", {
			executionBackend: backend,
			taskBase: TASK_BASE,
			timeoutMs: 1,
			termGraceMs: 1,
			spawnFn: () => fakeChild(),
		});
		strictEqual(timedOut.status, "timed_out");
	});

	it("cleans a timed-out PID-recorded capture through the backend seam", async () => {
		const cleanupCalls = [];
		const timers = new Set();
		const setTimeoutFn = (fn) => {
			const timer = { fn };
			timers.add(timer);
			queueMicrotask(() => {
				if (!timers.delete(timer)) return;
				fn();
			});
			return timer;
		};
		const clearTimeoutFn = (timer) => timers.delete(timer);
		let spawnedChild = null;
		const backend = {
			execArgv(_workspaceId, { argv }) {
				return { command: "fake", args: [...argv] };
			},
			cleanupProviderProcess(command, args, context) {
				cleanupCalls.push({ command, args, context });
			},
		};
		const result = await captureProviderDiffDetailedAsync("worker", {
			executionBackend: backend,
			timeoutMs: 50,
			termGraceMs: 50,
			setTimeoutFn,
			clearTimeoutFn,
			spawnFn: () => {
				spawnedChild = fakeChild();
				return spawnedChild;
			},
		});

		strictEqual(result.status, "timed_out");
		ok(
			spawnedChild,
			"the fake child spawned before the deterministic deadline",
		);
		deepStrictEqual(spawnedChild.signals, ["SIGTERM", "SIGKILL"]);
		strictEqual(cleanupCalls.length, 1);
		deepStrictEqual(cleanupCalls[0], {
			command: "fake",
			args: ["git", "add", "-A"],
			context: { onStatus: undefined, workspaceId: "worker" },
		});
	});

	it("captures add and diff synchronously through PID-safe transport", () => {
		const backendOptions = [];
		const executionBackend = {
			execArgv(_workspaceId, options = {}) {
				backendOptions.push(options);
				const validation = taskBaseValidationCommand(options.argv);
				if (validation) return validation;
				const isCapture = options.argv.at(-1) === TASK_BASE.tree;
				return {
					command: process.execPath,
					args: ["-e", isCapture ? 'process.stdout.write("diff")' : ""],
				};
			},
		};
		strictEqual(
			captureProviderDiff("worker", { executionBackend, taskBase: TASK_BASE }),
			"diff",
		);
		deepStrictEqual(
			backendOptions.map((options) => options.recordPid),
			[true, true, true],
		);
	});

	it("validates a persisted base through the current authorized helper identity", () => {
		const argumentBuilder = new ParallelsExecutionBackend({ aquaUid: 501 });
		const seen = [];
		const baseCleanupContext = {
			runId: "base-run",
			taskId: "1.1",
			attemptId: "base-attempt",
			descriptorIdentity: "base-descriptor",
			workspaceId: "worker",
			processStartIdentity: null,
			operation: "helper",
		};
		const captureCleanupContext = {
			...baseCleanupContext,
			attemptId: "retry-attempt",
			descriptorIdentity: "retry-descriptor",
		};
		const executionBackend = {
			execArgv(workspaceId, options) {
				argumentBuilder.execArgv(workspaceId, options);
				seen.push({
					argv: options.argv,
					cleanupContext: options.cleanupContext,
				});
				const validation = taskBaseValidationCommand(options.argv);
				if (validation) return validation;
				const isCapture = options.argv.at(-1) === TASK_BASE.tree;
				return {
					command: process.execPath,
					args: ["-e", isCapture ? 'process.stdout.write("diff")' : ""],
				};
			},
		};
		strictEqual(
			captureProviderDiff("worker", {
				executionBackend,
				taskBase: { ...TASK_BASE, cleanupContext: baseCleanupContext },
				cleanupContext: captureCleanupContext,
			}),
			"diff",
		);
		strictEqual(seen[0].cleanupContext.attemptId, "retry-attempt");
		strictEqual(seen[1].argv[1], "rev-parse");
		strictEqual(seen[1].cleanupContext.attemptId, "retry-attempt");
		strictEqual(seen[2].cleanupContext.attemptId, "retry-attempt");
		for (const entry of seen)
			strictEqual(entry.cleanupContext.operation, "helper");
	});

	it("exports a worker commit against an anchored task-start tree and rejects a replaced anchor", () => {
		const projectPath = tempDir("switchyard-task-base-");
		try {
			writeFileSync(join(projectPath, "tracked.txt"), "before\n");
			writeFileSync(join(projectPath, "deleted.txt"), "delete me\n");
			writeFileSync(join(projectPath, "rename-old.txt"), "rename me\n");
			for (const args of [
				["init", "-q"],
				["config", "user.name", "Test"],
				["config", "user.email", "test@example.invalid"],
				["add", "."],
				["commit", "-qm", "baseline"],
			]) {
				execFileSync("git", args, { cwd: projectPath });
			}
			const executionBackend = {
				execArgv(_workspaceId, { argv }) {
					return {
						command: "git",
						args: ["-C", projectPath, ...argv.slice(1)],
					};
				},
			};
			const taskBase = captureTaskStartTree(executionBackend, "worker", {
				runId: "test-run",
				taskId: "1.1",
			});
			writeFileSync(join(projectPath, "tracked.txt"), "after\n");
			execFileSync("git", ["add", "tracked.txt"], { cwd: projectPath });
			execFileSync("git", ["commit", "-qm", "worker edit"], {
				cwd: projectPath,
			});
			writeFileSync(join(projectPath, "tracked.txt"), "after unstaged\n");
			writeFileSync(join(projectPath, "new.txt"), "new file\n");
			execFileSync("git", ["add", "new.txt"], { cwd: projectPath });
			unlinkSync(join(projectPath, "deleted.txt"));
			renameSync(
				join(projectPath, "rename-old.txt"),
				join(projectPath, "rename-new.txt"),
			);
			execFileSync("git", ["gc", "--prune=now"], { cwd: projectPath });
			const diff = captureProviderDiff("worker", {
				executionBackend,
				taskBase,
			});
			ok(diff?.includes("+after unstaged"), "unstaged worker edit must export");
			ok(diff?.includes("new.txt"), "staged new file must export");
			ok(diff?.includes("deleted.txt"), "deleted file must export");
			ok(diff?.includes("rename-new.txt"), "renamed file must export");
			execFileSync("git", ["update-ref", "-d", taskBase.ref], {
				cwd: projectPath,
			});
			strictEqual(
				captureProviderDiff("worker", { executionBackend, taskBase }),
				null,
				"a deleted task-base ref must stop capture rather than using HEAD",
			);
			const replacement = execFileSync("git", ["write-tree"], {
				cwd: projectPath,
				encoding: "utf8",
			}).trim();
			execFileSync("git", ["update-ref", taskBase.ref, replacement], {
				cwd: projectPath,
			});
			strictEqual(
				captureProviderDiff("worker", { executionBackend, taskBase }),
				null,
				"a replaced task-base ref must stop capture rather than using HEAD",
			);
		} finally {
			rmSync(projectPath, { recursive: true, force: true });
		}
	});

	it("classifies synchronous detailed diff-capture outcomes", () => {
		const cases = [
			{
				name: "captured",
				stageExit: 0,
				diffExit: 0,
				diffOutput: "diff --git a/a b/a\n",
				expectedStatus: "captured",
			},
			{
				name: "empty",
				stageExit: 0,
				diffExit: 0,
				diffOutput: "",
				expectedStatus: "empty",
			},
			{
				name: "stage failure",
				stageExit: 7,
				diffExit: 0,
				diffOutput: "",
				expectedStatus: "stage_failed",
			},
			{
				name: "diff failure",
				stageExit: 0,
				diffExit: 9,
				diffOutput: "",
				expectedStatus: "diff_failed",
			},
			{
				name: "transport failure",
				expectedStatus: "transport_failed",
				transportCall: 1,
			},
		];

		for (const testCase of cases) {
			let calls = 0;
			const executionBackend = {
				execArgv(_workspaceId, { argv }) {
					const validation = taskBaseValidationCommand(argv);
					if (validation) return validation;
					calls += 1;
					if (calls === testCase.transportCall) {
						throw new Error("transport detail must not escape");
					}
					const isCapture = argv.at(-1) === TASK_BASE.tree;
					const exitCode = isCapture ? testCase.diffExit : testCase.stageExit;
					const script =
						exitCode === 0
							? isCapture
								? `process.stdout.write(${JSON.stringify(testCase.diffOutput ?? "")})`
								: ""
							: `process.exit(${exitCode})`;
					return { command: process.execPath, args: ["-e", script] };
				},
			};

			const result = captureProviderDiffDetailed("worker", {
				executionBackend,
				taskBase: TASK_BASE,
			});
			strictEqual(result.status, testCase.expectedStatus, testCase.name);
			strictEqual(
				result.diff,
				testCase.expectedStatus === "captured" ? testCase.diffOutput : null,
				testCase.name,
			);
		}
	});

	it("classifies a synchronous host execution deadline as timed_out", () => {
		const executionBackend = {
			execArgv(_workspaceId, { argv }) {
				const validation = taskBaseValidationCommand(argv);
				if (validation) return validation;
				return {
					command: process.execPath,
					args: [
						"-e",
						'process.on("SIGTERM", () => {}); setTimeout(() => {}, 1000)',
					],
				};
			},
		};
		const startedAt = Date.now();
		deepStrictEqual(
			captureProviderDiffDetailed("worker", {
				executionBackend,
				taskBase: TASK_BASE,
				timeoutMs: 20,
			}),
			{ status: "timed_out", diff: null },
		);
		ok(Date.now() - startedAt < 500, "capture returned within its hard budget");
	});

	it("preserves timed_out when synchronous task-base validation exhausts the budget", () => {
		// The budget is spent by an injected clock rather than by real elapsed
		// time: it jumps past the deadline exactly when validation asks the
		// backend for its command, which is the call before the probe reads what
		// is left. The wall-clock version of this test decided its outcome by
		// machine load, and never reached validation at all -- a 20ms budget was
		// already gone by the time the staging probe returned.
		let clock = 1_000_000;
		const executionBackend = {
			execArgv(_workspaceId, { argv }) {
				if (argv[1] === "rev-parse") clock += 60_000;
				return { command: process.execPath, args: ["-e", ""] };
			},
		};
		deepStrictEqual(
			captureProviderDiffDetailed("worker", {
				executionBackend,
				taskBase: TASK_BASE,
				timeoutMs: 30_000,
				now: () => clock,
			}),
			{ status: "timed_out", diff: null },
		);
	});
});
