import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	boundCompletionContinuationProof,
	createProgressSnapshot,
	executeProviderInvocation,
	getWorkspaceExecution,
	runProviderProcess,
	verifyCompletionContinuationSync,
} from "../src/switchyard/adapter/provider-lifecycle.mjs";
import { validateIdentifier } from "../src/switchyard/adapter/shell-safety.mjs";
import {
	captureTaskStartTreeAsync,
	validateTaskStartTree,
	validateTaskStartTreeAsync,
} from "../src/switchyard/lifecycle/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TASK_BASE = {
	ref: "refs/switchyard/task-base/test-run/1.1",
	tree: "1".repeat(40),
};

function _taskBaseValidationCommand(argv) {
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
	it("binds a provider process to the disposable worktree cwd", async () => {
		const child = fakeChild();
		let spawnOptions = null;
		const result = await runProviderProcess("fake", [], {
			cwd: "/tmp/disposable-worktree",
			spawnFn: (_command, _args, options) => {
				spawnOptions = options;
				queueMicrotask(() => child.emit("close", 0, null));
				return child;
			},
		});
		strictEqual(result.success, true);
		strictEqual(spawnOptions.cwd, "/tmp/disposable-worktree");
	});

	it("forwards an explicit minimal environment without inheriting host variables", async () => {
		const child = fakeChild();
		const env = { PATH: "/usr/bin:/bin", HOME: "/trusted/runtime" };
		let observed;
		await runProviderProcess("fake", [], {
			env,
			spawnFn: (_command, _args, options) => {
				observed = options.env;
				queueMicrotask(() => child.emit("close", 0, null));
				return child;
			},
		});
		strictEqual(observed, env);
	});

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
		strictEqual(result.silenceTimedOut, false);
		strictEqual(result.timedOut, true);
		strictEqual(result.progress.outcome, "execution_timed_out");
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
		let polls = 0;
		const result = await runProviderProcess("fake", [], {
			spawnFn: () => child,
			timeoutMs: 10_000,
			silenceTimeoutMs: 20,
			pollIntervalMs: 1,
			onPoll: () => {
				// The supervisor's own poll cadence drives the fake: substantive
				// output lands on the first observed poll and close on the next,
				// so no wall-clock sleep decides the outcome.
				polls += 1;
				if (polls === 1) child.stdout.emit("data", "progress");
				if (polls === 2) child.emit("close", 0, null);
			},
			onProgress: (value) => progress.push(value),
		});
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
				'require("node:fs").writeFileSync(process.argv[1], String(process.pid));',
				"setInterval(() => {}, 1000);",
			].join("");
			const backend = {
				execArgv() {
					return { command: process.execPath, args: ["-e", script, readyPath] };
				},
			};
			const startedAt = Date.now();
			let helperPid = null;
			let helperGone = false;
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
				helperPid = Number(readFileSync(readyPath, "utf8"));
				// The never-completing fake ignores SIGTERM, so wait on its actual
				// disappearance rather than an elapsed-time window: a TERM-only kill
				// would leave it running past the probe's hard budget.
				while (Date.now() - startedAt < 15_000) {
					try {
						process.kill(helperPid, 0);
					} catch (error) {
						if (error?.code !== "ESRCH") throw error;
						helperGone = true;
						break;
					}
					await new Promise((resolveWait) => setTimeout(resolveWait, 10));
				}
				ok(helperGone, "probe hard-killed the SIGTERM-ignoring host");
			} finally {
				if (helperPid !== null && !helperGone) {
					try {
						process.kill(helperPid, "SIGKILL");
					} catch {
						// The helper exited between the observation and this kill.
					}
				}
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("bounds and reports an asynchronous task-base probe", async () => {
		const statuses = [];
		let clockReads = 0;
		await rejects(
			captureTaskStartTreeAsync(
				{
					execArgv() {
						// A helper that would never complete: only the probe's own
						// deadline can end it.
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
					timeoutMs: 10_000,
					// Spend the budget through the injected clock at the first
					// command construction instead of waiting out the bound.
					now: () => (clockReads++ === 0 ? 0 : 10_001),
					onStatus: (status) => statuses.push(status),
				},
			),
			/task base probe deadline exhausted/,
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
		strictEqual(result.writerLifecycle, "stopped");
	});

	it("retains bounded process identity, deadline, silence observation, and cleanup outcome", async () => {
		const child = fakeChild();
		child.pid = 4242;
		let clock = 0;
		const promise = runProviderProcess("fake", [], {
			spawnFn: () => child,
			timeoutMs: 100,
			silenceTimeoutMs: 1,
			now: () => clock,
			cleanup: () => ({ cleanupFailed: true, cleanupStage: "tree_terminated" }),
		});
		child.stdout.emit("data", "buffered\n");
		// Advance the injected clock past the silence window rather than sleeping.
		clock = 2;
		child.emit("close", 1, null);
		const result = await promise;
		strictEqual(result.success, false);
		strictEqual(result.providerLifecycle.schemaVersion, 1);
		strictEqual(result.providerLifecycle.pid, 4242);
		ok(typeof result.providerLifecycle.startedAt === "string");
		ok(typeof result.providerLifecycle.deadlineAt === "string");
		ok(typeof result.providerLifecycle.lastOutputAt === "string");
		strictEqual(result.providerLifecycle.silenceObserved, true);
		strictEqual(result.providerLifecycle.terminalStatus, "exited");
		strictEqual(result.providerLifecycle.terminationReason, "completed");
		strictEqual(result.providerLifecycle.writerLifecycle, "stopped");
		strictEqual(result.providerLifecycle.cleanupStatus, "not_required");
		strictEqual(result.silenceTimedOut, false);
	});

	it("classifies a spawn admission failure separately and redacts lifecycle output", async () => {
		const result = await executeProviderInvocation("fake", [], {
			provider: "vibe",
			spawnFn: () => {
				throw new Error("SECRET_CANARY spawn unavailable");
			},
		});
		strictEqual(result.success, false);
		strictEqual(result.admissionFailed, true);
		strictEqual(result.errorKind, "launch_failed");
		strictEqual(result.diagnosticCode, "launch_failed");
		strictEqual(result.providerLifecycle.terminalStatus, "spawn_failed");
		strictEqual(
			JSON.stringify(result.providerLifecycle).includes("SECRET_CANARY"),
			false,
		);
	});

	it("distinguishes never-started spawn failures from an unobserved timeout", async () => {
		const neverStarted = await runProviderProcess("fake", [], {
			spawnFn: () => {
				throw new Error("spawn failed");
			},
		});
		strictEqual(neverStarted.writerLifecycle, "never_started");

		const child = fakeChild();
		child.kill = () => true;
		const unresolvedStop = await runProviderProcess("fake", [], {
			spawnFn: () => child,
			timeoutMs: 1,
			termGraceMs: 1,
		});
		strictEqual(unresolvedStop.timedOut, true);
		strictEqual(unresolvedStop.writerLifecycle, "unavailable");
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

	it("never spawns for an already-aborted signal and returns bounded cancellation evidence", async () => {
		const controller = new AbortController();
		controller.abort();
		let spawnCalls = 0;
		const result = await runProviderProcess("fake", [], {
			signal: controller.signal,
			now: () => 1000,
			timeoutMs: 5000,
			spawnFn: () => {
				spawnCalls += 1;
				return fakeChild();
			},
		});
		strictEqual(spawnCalls, 0);
		strictEqual(result.success, false);
		strictEqual(result.cancelled, true);
		strictEqual(result.writerLifecycle, "never_started");
		strictEqual(result.code, null);
		strictEqual(result.signal, null);
		strictEqual(result.output, "");
		strictEqual(result.stderr, "");
		strictEqual(result.providerLifecycle.pid, null);
		strictEqual(result.providerLifecycle.writerLifecycle, "never_started");
		strictEqual(result.providerLifecycle.terminationReason, "cancelled");
		strictEqual(result.providerLifecycle.cleanupStatus, "not_required");
		strictEqual(result.progress.outcome, "cancelled");
		strictEqual(result.progress.counters.polls, 0);
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
});
