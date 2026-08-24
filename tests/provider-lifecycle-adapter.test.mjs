import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	captureProviderDiff,
	captureProviderDiffAsync,
	executeProviderInvocation,
	getWorkspaceExecution,
	runProviderProcess,
} from "../src/switchyard/adapter/provider-lifecycle.mjs";
import { validateIdentifier } from "../src/switchyard/adapter/shell-safety.mjs";

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
	});

	it("captures add and diff asynchronously through spawn", async () => {
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
				return { command: "fake", args: [...argv] };
			},
		};
		const result = await captureProviderDiffAsync("worker", {
			executionBackend: passthroughExecutionBackend,
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
		deepStrictEqual(calls, ["-A", "HEAD"]);
		deepStrictEqual(
			backendOptions.map((options) => options.recordPid),
			[false, false],
		);
	});

	it("captures add and diff synchronously without PID recording", () => {
		const backendOptions = [];
		const executionBackend = {
			execArgv(_workspaceId, options = {}) {
				backendOptions.push(options);
				const isCapture = options.argv.at(-1) === "HEAD";
				return {
					command: process.execPath,
					args: ["-e", isCapture ? 'process.stdout.write("diff")' : ""],
				};
			},
		};
		strictEqual(captureProviderDiff("worker", { executionBackend }), "diff");
		deepStrictEqual(
			backendOptions.map((options) => options.recordPid),
			[false, false],
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
});
