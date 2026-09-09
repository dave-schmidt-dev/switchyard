import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	boundCompletionContinuationProof,
	captureProviderDiff,
	captureProviderDiffAsync,
	captureProviderDiffDetailed,
	captureProviderDiffDetailedAsync,
	createProgressSnapshot,
	executeProviderInvocation,
	getWorkspaceExecution,
	runProviderProcess,
	verifyCompletionContinuationSync,
} from "../src/switchyard/adapter/provider-lifecycle.mjs";
import { validateIdentifier } from "../src/switchyard/adapter/shell-safety.mjs";
import {
	captureTaskStartTree,
	captureTaskStartTreeAsync,
	validateTaskStartTree,
	validateTaskStartTreeAsync,
} from "../src/switchyard/lifecycle/index.mjs";
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
	it("uses a closed progress envelope and does not treat polling as substantive progress", async () => {
		const snapshot = createProgressSnapshot({
			stage: "not-a-stage",
			elapsedMs: 4,
			lastSubstantiveProgressAt: "not-a-timestamp",
			lastSubstantiveProgressAgeMs: 3,
			stdoutBytes: 4,
			stderrBytes: 2,
			pollCount: 2,
			progressCount: 1,
			outcome: "not-an-outcome",
		});
		deepStrictEqual(snapshot, {
			schemaVersion: 1,
			stage: "unknown",
			elapsedMs: 4,
			lastSubstantiveProgressAt: null,
			lastSubstantiveProgressAgeMs: 3,
			counters: {
				stdoutBytes: 4,
				stderrBytes: 2,
				polls: 2,
				progressEvents: 1,
			},
			outcome: "running",
		});

		const child = fakeChild();
		const progress = [];
		const result = await runProviderProcess("fake", [], {
			spawnFn: () => child,
			timeoutMs: 100,
			silenceTimeoutMs: 10,
			pollIntervalMs: 1,
			termGraceMs: 1,
			onPoll: () => {},
			onProgress: (value) => progress.push(value),
		});
		strictEqual(result.silenceTimedOut, true);
		strictEqual(result.progress.outcome, "silence_timeout");
		ok(result.progress.counters.polls > 0);
		ok(
			progress.every(
				(value) =>
					value.schemaVersion === 1 &&
					!Object.hasOwn(value, "output") &&
					!Object.hasOwn(value, "error"),
			),
		);
	});

	it("resets silence only on substantive output and preserves the success outcome", async () => {
		const child = fakeChild();
		const progress = [];
		const resultPromise = runProviderProcess("fake", [], {
			spawnFn: () => {
				setTimeout(() => child.stdout.emit("data", "progress"), 4);
				setTimeout(() => child.emit("close", 0, null), 8);
				return child;
			},
			timeoutMs: 100,
			silenceTimeoutMs: 20,
			pollIntervalMs: 1,
			onProgress: (value) => progress.push(value),
		});
		const result = await resultPromise;
		strictEqual(result.success, true);
		strictEqual(result.silenceTimedOut, false);
		strictEqual(result.progress.outcome, "success");
		ok(progress.some((value) => value.counters.progressEvents > 0));
	});

	it("bounds a completion-continuation receipt to its closed frozen shape", () => {
		const valid = {
			version: 1,
			kind: "completion_continuation_lifecycle",
			providerExited: true,
			childrenExited: true,
			cleanupSucceeded: true,
			taskId: "1.1",
			attemptId: "attempt-1",
			descriptorIdentity: "descriptor-1",
			workspaceId: "worker",
		};

		const bound = boundCompletionContinuationProof({
			...valid,
			launcherStdout: "provider output that must not ride along",
		});
		deepStrictEqual(bound, valid);
		ok(Object.isFrozen(bound));
		strictEqual(bound.launcherStdout, undefined);

		// The accepted receipt is a copy, so mutating the caller's object after
		// the bound cannot change what the verifier later reads.
		const source = { ...valid };
		const copied = boundCompletionContinuationProof(source);
		source.cleanupSucceeded = false;
		strictEqual(copied.cleanupSucceeded, true);

		for (const malformed of [
			null,
			undefined,
			true,
			"receipt",
			{ ...valid, version: 2 },
			{ ...valid, kind: "something_else" },
			{ ...valid, providerExited: "true" },
			{ ...valid, childrenExited: 1 },
			{ ...valid, cleanupSucceeded: undefined },
			{ ...valid, taskId: "" },
			{ ...valid, attemptId: "attempt 1 with spaces" },
			{ ...valid, descriptorIdentity: 7 },
			{ ...valid, workspaceId: "w".repeat(257) },
		]) {
			strictEqual(boundCompletionContinuationProof(malformed), null);
		}
	});

	it("keeps completion continuation unavailable without an explicit lifecycle proof", async () => {
		const context = {
			taskId: "1.1",
			attemptId: "attempt-1",
			descriptorIdentity: "descriptor-1",
			workingContainerName: "worker",
			executionBackend: {},
			deadline: "2026-09-06T04:00:00.000Z",
			timeoutMs: 20,
		};
		strictEqual(verifyCompletionContinuationSync({}, context), false);
		const adapter = {
			supportsCompletionContinuation: true,
		};
		context.lifecycleReceipt = {
			version: 1,
			kind: "completion_continuation_lifecycle",
			providerExited: true,
			childrenExited: true,
			cleanupSucceeded: true,
			taskId: "1.1",
			attemptId: "attempt-1",
			descriptorIdentity: "descriptor-1",
			workspaceId: "worker",
		};
		strictEqual(verifyCompletionContinuationSync(adapter, context), true);
		context.lifecycleReceipt = true;
		strictEqual(verifyCompletionContinuationSync(adapter, context), false);
		context.lifecycleReceipt = {
			version: 1,
			kind: "completion_continuation_lifecycle",
			providerExited: true,
			childrenExited: true,
			cleanupSucceeded: true,
			taskId: "1.1",
			attemptId: "attempt-1",
			descriptorIdentity: "wrong-descriptor",
			workspaceId: "worker",
		};
		strictEqual(verifyCompletionContinuationSync(adapter, context), false);
	});

	for (const [mode, validate] of [
		["synchronous", validateTaskStartTree],
		["asynchronous", validateTaskStartTreeAsync],
	]) {
		it(`hard-kills a SIGTERM-ignoring ${mode} host probe at its deadline`, async () => {
			const root = tempDir("switchyard-probe-timeout-");
			const readyPath = join(root, "ready");
			const script = [
				'process.on("SIGTERM", () => {});',
				'require("node:fs").writeFileSync(process.argv[1], "ready");',
				"setTimeout(() => process.exit(0), 1000);",
			].join("");
			const backend = {
				execArgv() {
					return { command: process.execPath, args: ["-e", script, readyPath] };
				},
			};
			const startedAt = Date.now();
			try {
				if (mode === "synchronous") {
					throws(() =>
						validate(backend, "worker", TASK_BASE, { timeoutMs: 250 }),
					);
				} else {
					await rejects(
						validate(backend, "worker", TASK_BASE, { timeoutMs: 250 }),
					);
				}
				ok(existsSync(readyPath), "child installed its handler before timeout");
				ok(
					Date.now() - startedAt < 700,
					"probe returned within its hard budget",
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("bounds and reports an asynchronous task-base probe", async () => {
		const statuses = [];
		await rejects(
			captureTaskStartTreeAsync(
				{
					execArgv() {
						return {
							command: process.execPath,
							args: ["-e", "setInterval(() => {}, 1000)"],
						};
					},
				},
				"worker",
				{
					runId: "timeout-run",
					taskId: "1.1",
					timeoutMs: 10,
					onStatus: (status) => statuses.push(status),
				},
			),
		);
		deepStrictEqual(
			statuses.map(({ event, stage }) => [event, stage]),
			[
				["task_base_probe_started", "task_base_stage"],
				["task_base_probe_failed", "task_base_stage"],
			],
		);
	});

	it("accepts exact Parallels UUID workspace handles but rejects malformed braces", () => {
		validateIdentifier("{11111111-1111-4111-8111-111111111111}", "workspaceId");
		throws(
			() => validateIdentifier("{not-a-vm}", "workspaceId"),
			/unsafe characters/,
		);
	});

	it("captures successful output and emits no terminal duplicate", async () => {
		const child = fakeChild();
		let terminalEvents = 0;
		const promise = runProviderProcess("fake", [], {
			spawnFn: () => child,
			setTimeoutFn: (fn, delay) => setTimeout(fn, delay),
			clearTimeoutFn: clearTimeout,
		});
		child.once("close", () => {
			terminalEvents += 1;
			child.emit("error", new Error("late error"));
		});
		child.stdout.emit("data", "ok\n");
		child.emit("close", 0, null);
		const result = await promise;
		deepStrictEqual(result.success, true);
		strictEqual(result.output, "ok\n");
		strictEqual(terminalEvents, 1);
	});

	it("escalates timeout TERM then KILL and cleans once", async () => {
		const child = fakeChild();
		let cleanups = 0;
		const promise = runProviderProcess("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
			cleanup: () => {
				cleanups += 1;
			},
		});
		const result = await promise;
		strictEqual(result.success, false);
		strictEqual(result.timedOut, true);
		deepStrictEqual(child.signals, ["SIGTERM", "SIGKILL"]);
		strictEqual(cleanups, 1);
	});

	it("cancels through the same cleanup ordering", async () => {
		const child = fakeChild();
		const controller = new AbortController();
		const order = [];
		const promise = runProviderProcess("fake", [], {
			spawnFn: () => child,
			termGraceMs: 1,
			signal: controller.signal,
			cleanup: () => order.push("cleanup"),
		});
		child.kill = (signal) => {
			order.push(signal);
			if (signal === "SIGKILL")
				queueMicrotask(() => child.emit("close", null, signal));
		};
		controller.abort();
		const result = await promise;
		strictEqual(result.cancelled, true);
		deepStrictEqual(order, ["SIGTERM", "SIGKILL", "cleanup"]);
	});

	it("waits for pending cleanup before resolving an early close", async () => {
		const child = fakeChild();
		let cleanupCount = 0;
		let cleanupDone = false;
		const promise = runProviderProcess("fake", [], {
			spawnFn: () => child,
			timeoutMs: 100,
			cleanup: async () => {
				cleanupCount += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
				cleanupDone = true;
			},
		});
		child.emit("close", null, "SIGTERM");
		const result = await promise;
		strictEqual(result.timedOut, false);
		strictEqual(cleanupDone, false, "normal close should not invoke cleanup");
		strictEqual(cleanupCount, 0);

		const timeoutChild = fakeChild();
		cleanupDone = false;
		const timeoutPromise = runProviderProcess("fake", [], {
			spawnFn: () => timeoutChild,
			timeoutMs: 1,
			termGraceMs: 10,
			cleanup: async () => {
				cleanupCount += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
				cleanupDone = true;
			},
		});
		timeoutChild.kill = (signal) => {
			if (signal === "SIGTERM")
				queueMicrotask(() => timeoutChild.emit("close", null, signal));
		};
		const timeoutResult = await timeoutPromise;
		strictEqual(timeoutResult.timedOut, true);
		strictEqual(cleanupDone, true);
		strictEqual(cleanupCount, 1);
	});

	it("opts provider execution into PID recording by default", () => {
		let receivedOptions;
		const executionBackend = {
			execArgv(_workspaceId, options) {
				receivedOptions = options;
				return { command: "fake", args: [] };
			},
		};
		getWorkspaceExecution("worker", {
			executionBackend,
			argv: ["provider"],
		});
		strictEqual(receivedOptions.recordPid, true);
		strictEqual(
			"cleanupContext" in receivedOptions,
			false,
			"legacy callers must not invent an ambiguous marker identity",
		);
	});

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
		const executionBackend = {
			execArgv(_workspaceId, { argv }) {
				if (argv[1] === "rev-parse") {
					return {
						command: process.execPath,
						args: [
							"-e",
							'process.on("SIGTERM", () => {}); setTimeout(() => {}, 1000)',
						],
					};
				}
				return { command: process.execPath, args: ["-e", ""] };
			},
		};
		deepStrictEqual(
			captureProviderDiffDetailed("worker", {
				executionBackend,
				taskBase: TASK_BASE,
				timeoutMs: 20,
			}),
			{ status: "timed_out", diff: null },
		);
	});

	it("prefers a backend's cleanupProviderProcess and skips the adapter's own cleanup on timeout", async () => {
		const child = fakeChild();
		let backendCalls = 0;
		let cleanupOptions = null;
		let adapterCleanups = 0;
		const executionBackend = {
			cleanupProviderProcess: (_command, _args, options) => {
				backendCalls += 1;
				cleanupOptions = options;
			},
		};
		const result = await executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
			executionBackend,
			cleanupContext: { workspaceId: "{bridge-workspace}" },
			cleanup: () => {
				adapterCleanups += 1;
			},
		});
		strictEqual(result.timedOut, true);
		strictEqual(backendCalls, 1);
		strictEqual(
			adapterCleanups,
			0,
			"adapter cleanup must not run once the backend's own cleanup succeeded",
		);
		deepStrictEqual(cleanupOptions, {
			onStatus: undefined,
			workspaceId: "{bridge-workspace}",
		});
	});

	it("falls back to the adapter's cleanup when the backend's cleanupProviderProcess throws", async () => {
		const child = fakeChild();
		let adapterCleanups = 0;
		const executionBackend = {
			cleanupProviderProcess: () => {
				const error = new Error("guest unreachable");
				error.cleanupStage = "tree_terminated";
				throw error;
			},
		};
		const result = await executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
			executionBackend,
			cleanup: () => {
				adapterCleanups += 1;
			},
		});
		strictEqual(result.timedOut, true);
		strictEqual(result.cleanupFailed, true);
		strictEqual(result.cleanupStage, "tree_terminated");
		strictEqual(
			result.diagnosticCode,
			"provider_cleanup_after_tree_terminated",
		);
		strictEqual(result.failurePhase, "provider_cleanup");
		strictEqual(
			adapterCleanups,
			1,
			"adapter cleanup must still run as a backstop when the backend's cleanup fails",
		);
	});

	it("retains a cleanup failure stage through cancellation", async () => {
		const child = fakeChild();
		const controller = new AbortController();
		const executionBackend = {
			cleanupProviderProcess: () => {
				const error = new Error("guest unreachable");
				error.cleanupStage = "pid_observed";
				throw error;
			},
		};
		const resultPromise = executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			termGraceMs: 1,
			signal: controller.signal,
			executionBackend,
		});
		controller.abort();
		const result = await resultPromise;
		strictEqual(result.cancelled, true);
		strictEqual(result.cleanupFailed, true);
		strictEqual(result.errorKind, "provider_cleanup_failed");
		strictEqual(result.cleanupStage, "pid_observed");
		strictEqual(result.diagnosticCode, "provider_cleanup_after_pid_observed");
		strictEqual(result.failurePhase, "provider_cleanup");
		strictEqual(result.diagnosticEvidence.stdoutBytes, 0);
		strictEqual(result.diagnosticEvidence.stderrBytes, 0);
		strictEqual(Object.hasOwn(result.diagnosticEvidence, "stdout"), false);
	});

	it("runs the adapter's cleanup when no backend cleanupProviderProcess is available", async () => {
		const child = fakeChild();
		let adapterCleanups = 0;
		const result = await executeProviderInvocation("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
			cleanup: () => {
				adapterCleanups += 1;
			},
		});
		strictEqual(result.timedOut, true);
		strictEqual(adapterCleanups, 1);
	});

	it("writes an EOF when input is an empty string", async () => {
		const stdinEndArgs = [];
		const child = fakeChild();
		child.stdin = {
			end(...args) {
				stdinEndArgs.push(args);
			},
		};
		const spawnFn = () => {
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		};
		const result = await executeProviderInvocation("fake", [], {
			spawnFn,
			input: "",
		});
		strictEqual(result.success, true);
		strictEqual(stdinEndArgs.length, 1);
		deepStrictEqual(stdinEndArgs[0], [""]);
	});

	it("mints CLI misuse only from an explicit launcher diagnostic", async () => {
		const invoke = async (options = {}) => {
			const child = fakeChild();
			const promise = executeProviderInvocation("fake", [], {
				spawnFn: () => child,
				...options,
			});
			child.stdout.emit("data", "task prose: usage: helper --example\n");
			child.emit("close", options.exitCode ?? 255, null);
			return promise;
		};

		const observedExit = await invoke({ exitCode: 255 });
		strictEqual(observedExit.diagnosticCode, "provider_exit_nonzero");
		strictEqual(observedExit.diagnosticOrigin, "adapter");
		strictEqual(observedExit.diagnosticEvidenceAvailable, false);

		const launcherUsage = await invoke({
			exitCode: 2,
			launcherDiagnosticCode: "cli_usage_error",
		});
		strictEqual(launcherUsage.diagnosticCode, "cli_usage_error");
		strictEqual(launcherUsage.diagnosticOrigin, "launcher");
		strictEqual(launcherUsage.diagnosticEvidenceAvailable, false);
	});

	it("keeps text-derived auth and quota labels informational", async () => {
		for (const [provider, output, expectedKind] of [
			[
				"codex",
				"Test expectation: authentication failed should be displayed",
				"auth_expired",
			],
			[
				"agy",
				"Task fixture: Individual quota reached after the child exits",
				"quota_exhausted",
			],
		]) {
			const child = fakeChild();
			const promise = executeProviderInvocation("fake", [], {
				provider,
				spawnFn: () => child,
			});
			child.stdout.emit("data", output);
			child.emit("close", 1, null);
			const result = await promise;
			strictEqual(result.errorKind, expectedKind);
			strictEqual(result.diagnosticCode, "provider_exit_nonzero");
			strictEqual(result.diagnosticOrigin, "adapter");
			strictEqual(result.diagnosticEvidenceAvailable, false);
		}
	});

	it("accepts a closed provider diagnostic only through the explicit adapter seam", async () => {
		const child = fakeChild();
		const promise = executeProviderInvocation("fake", [], {
			provider: "agy",
			adapterDiagnosticCode: "quota_exhausted",
			spawnFn: () => child,
		});
		child.emit("close", 1, null);
		const result = await promise;
		strictEqual(result.diagnosticCode, "quota_exhausted");
		strictEqual(result.diagnosticOrigin, "adapter");
		strictEqual(result.diagnosticEvidenceAvailable, false);
	});

	it("does not treat an idle exit as success after a silence timeout", async () => {
		const child = fakeChild();
		child.kill = (signal) => {
			child.signals.push(signal);
			if (signal === "SIGKILL")
				queueMicrotask(() => child.emit("close", 0, signal));
		};
		const result = await executeProviderInvocation("fake", [], {
			provider: "vibe",
			idleExitCode: 0,
			silenceTimeoutMs: 1,
			termGraceMs: 1,
			spawnFn: () => child,
		});
		strictEqual(result.success, false);
		strictEqual(result.silenceTimedOut, true);
		strictEqual(result.errorKind, "silence_timeout");
		strictEqual(result.outcome, "silence_timeout");
	});

	it("classifies real provider/binary bindings from separate lifecycle streams", async () => {
		for (const [provider, binary] of [
			["claude", "claude"],
			["codex", "codex"],
			["agy", "agy"],
			["cursor", "cursor-agent"],
			["copilot", "copilot"],
			["opencode", "opencode"],
			["vibe", "vibe"],
		]) {
			const child = fakeChild();
			const promise = executeProviderInvocation(`/usr/bin/${binary}`, [], {
				provider,
				spawnFn: () => child,
			});
			child.stdout.emit("data", "Error: Session expired\n");
			child.stderr.emit("data", "Session expired\n");
			child.emit("close", 1, null);
			const result = await promise;
			strictEqual(
				result.diagnosticCode,
				"auth_expired",
				`${provider}/${binary}`,
			);
			strictEqual(result.diagnosticEvidenceAvailable, false);
			strictEqual(result.diagnosticEvidence.diagnosticKind, "auth_required");
			strictEqual(result.diagnosticEvidence.diagnosticCode, undefined);
			strictEqual(Object.hasOwn(result.diagnosticEvidence, "stdout"), false);
			strictEqual(Object.hasOwn(result.diagnosticEvidence, "stderr"), false);
		}
	});

	it("awaits the durable process-completed callback before returning", async () => {
		const child = fakeChild();
		const order = [];
		const pending = executeProviderInvocation("fake", [], {
			provider: "codex",
			spawnFn: () => child,
			onProcessCompleted: async (fact) => {
				order.push(["persist", fact.success, fact.cleanupFailed]);
				await new Promise((resolve) => setTimeout(resolve, 2));
				order.push("persisted");
			},
		});
		child.emit("close", 0, null);
		const result = await pending;
		deepStrictEqual(order, [["persist", true, false], "persisted"]);
		strictEqual(result.success, true);
	});
});
