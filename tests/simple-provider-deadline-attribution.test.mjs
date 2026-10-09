import { strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import { runProviderProcess } from "../src/switchyard/adapter/provider-lifecycle-process.mjs";
import { lifecycleBackedProviderFailure } from "../src/switchyard/simple/failure-accountability.mjs";
import {
	classifyExecutionFailure,
	defaultExecuteProvider,
} from "../src/switchyard/simple/provider-invocation.mjs";
import { createSimpleProviderReliabilityDiagnostic } from "../src/switchyard/simple/reliability.mjs";

const START_MS = 1_700_000_000_000;
const CALLER_DEADLINE_MS = START_MS + 60_000;
const PROVIDER_TIMER_MS = 30 * 60 * 1000;

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end() {} };
	child.kill = () => true;
	return child;
}

function manualTimers() {
	const pending = new Map();
	let nextId = 1;
	return {
		setTimeoutFn(fn, delay) {
			const id = nextId;
			nextId += 1;
			pending.set(id, { fn, delay });
			return id;
		},
		clearTimeoutFn(id) {
			pending.delete(id);
		},
		runNext() {
			for (const [id, timer] of pending) {
				pending.delete(id);
				timer.fn();
				return true;
			}
			return false;
		},
	};
}

test("an exit at the caller deadline is a deadline, not a provider fault", async (t) => {
	mock.timers.enable({ apis: ["Date"], now: START_MS });
	t.after(() => mock.timers.reset());
	const child = fakeChild();
	const resultPromise = defaultExecuteProvider({
		targetId: "codex",
		harness: "codex",
		descriptor: {
			target_id: "codex",
			selector: "gpt-5.3-codex-spark",
			invocation_args: [],
		},
		capability: "standard",
		prompt: "test",
		worktreePath: "/tmp/switchyard-deadline-attribution",
		timeoutMs: PROVIDER_TIMER_MS,
		deadlineMs: CALLER_DEADLINE_MS,
		spawnFn: () => child,
	});
	// The routing-run terminator acts at the shared deadline while the host
	// provider timer is still thirty minutes out: exit 76, no signal.
	mock.timers.setTime(CALLER_DEADLINE_MS);
	child.emit("close", 76, null);
	const result = await resultPromise;
	strictEqual(result.code, 76);
	strictEqual(result.signal, null);
	strictEqual(result.timedOut, true);
	strictEqual(result.cancelled, false);
	strictEqual(result.providerLifecycle.terminalStatus, "exited");
	strictEqual(result.providerLifecycle.terminationReason, "deadline");
	const failureReason = classifyExecutionFailure(result);
	strictEqual(failureReason, "provider_deadline_exceeded");
	const diagnostic = createSimpleProviderReliabilityDiagnostic({
		failureReason,
		failurePhase: "execute",
		providerResult: result,
	});
	strictEqual(diagnostic.causeCode, "provider_deadline_exceeded");
	strictEqual(diagnostic.timedOut, true);
	strictEqual(
		lifecycleBackedProviderFailure(
			diagnostic,
			result.providerLifecycle,
			result.writerLifecycle,
		),
		false,
	);
});

test("an exit a few seconds before the caller deadline also counts", async () => {
	const child = fakeChild();
	let clock = START_MS;
	const resultPromise = runProviderProcess("fake", [], {
		spawnFn: () => child,
		timeoutMs: PROVIDER_TIMER_MS,
		deadlineMs: CALLER_DEADLINE_MS,
		now: () => clock,
		setTimeoutFn: () => null,
		clearTimeoutFn: () => {},
	});
	clock = CALLER_DEADLINE_MS - 2_000;
	child.emit("close", 76, null);
	const result = await resultPromise;
	strictEqual(result.timedOut, true);
	strictEqual(result.providerLifecycle.terminalStatus, "exited");
	strictEqual(result.providerLifecycle.terminationReason, "deadline");
	strictEqual(classifyExecutionFailure(result), "provider_deadline_exceeded");
});

test("a clean exit at the caller deadline is still a completion", async () => {
	const child = fakeChild();
	let clock = START_MS;
	const resultPromise = runProviderProcess("fake", [], {
		spawnFn: () => child,
		timeoutMs: PROVIDER_TIMER_MS,
		deadlineMs: CALLER_DEADLINE_MS,
		now: () => clock,
		setTimeoutFn: () => null,
		clearTimeoutFn: () => {},
	});
	clock = CALLER_DEADLINE_MS - 1_000;
	child.emit("close", 0, null);
	const result = await resultPromise;
	strictEqual(result.timedOut, false);
	strictEqual(result.providerLifecycle.terminationReason, "completed");
});

test("an exit well before every deadline stays provider_exit_nonzero", async () => {
	const child = fakeChild();
	let clock = START_MS;
	const resultPromise = runProviderProcess("fake", [], {
		spawnFn: () => child,
		timeoutMs: PROVIDER_TIMER_MS,
		deadlineMs: CALLER_DEADLINE_MS,
		now: () => clock,
		setTimeoutFn: () => null,
		clearTimeoutFn: () => {},
	});
	clock = START_MS + 1_000;
	child.emit("close", 76, null);
	const result = await resultPromise;
	strictEqual(result.timedOut, false);
	strictEqual(result.providerLifecycle.terminalStatus, "exited");
	strictEqual(result.providerLifecycle.terminationReason, "completed");
	const failureReason = classifyExecutionFailure(result);
	strictEqual(failureReason, "provider_exit_nonzero");
	const diagnostic = createSimpleProviderReliabilityDiagnostic({
		failureReason,
		failurePhase: "execute",
		providerResult: result,
	});
	strictEqual(diagnostic.causeCode, "provider_exit_nonzero");
	strictEqual(diagnostic.timedOut, false);
});

test("the host provider timer keeps its lifecycle-backed deadline path", async () => {
	const child = fakeChild();
	child.kill = (signal) => {
		if (signal === "SIGKILL")
			queueMicrotask(() => child.emit("close", null, signal));
		return true;
	};
	const timers = manualTimers();
	const resultPromise = runProviderProcess("fake", [], {
		spawnFn: () => child,
		timeoutMs: 1_000,
		deadlineMs: CALLER_DEADLINE_MS,
		now: () => START_MS,
		setTimeoutFn: timers.setTimeoutFn,
		clearTimeoutFn: timers.clearTimeoutFn,
	});
	// First the provider timer requests termination, then the escalation
	// window expires and SIGKILL closes the fake child.
	strictEqual(timers.runNext(), true);
	strictEqual(timers.runNext(), true);
	const result = await resultPromise;
	strictEqual(result.timedOut, true);
	strictEqual(result.signal, "SIGKILL");
	strictEqual(result.providerLifecycle.terminalStatus, "terminated");
	strictEqual(result.providerLifecycle.terminationReason, "deadline");
	const failureReason = classifyExecutionFailure(result);
	strictEqual(failureReason, "provider_deadline_exceeded");
	const diagnostic = createSimpleProviderReliabilityDiagnostic({
		failureReason,
		failurePhase: "execute",
		providerResult: result,
	});
	strictEqual(diagnostic.causeCode, "provider_deadline_exceeded");
	strictEqual(diagnostic.timedOut, true);
	strictEqual(
		lifecycleBackedProviderFailure(
			diagnostic,
			result.providerLifecycle,
			result.writerLifecycle,
		),
		true,
	);
});
