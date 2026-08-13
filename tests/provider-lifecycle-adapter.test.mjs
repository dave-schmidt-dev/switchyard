import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	captureProviderDiffAsync,
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

	it("captures add and diff asynchronously through spawn", async () => {
		const calls = [];
		const result = await captureProviderDiffAsync("worker", {
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
	});
});
