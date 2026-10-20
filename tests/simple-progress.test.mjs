// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { createSimpleProgress } from "../src/switchyard/simple/progress.mjs";

function fixture(overrides = {}) {
	let clock = 1_000;
	const events = [];
	const updates = [];
	const statuses = [];
	const pendingDurability = new Set();
	const progress = createSimpleProgress({
		now: () => clock,
		startedAt: clock,
		taskId: "task",
		runId: "run",
		onStatus: (entry) => statuses.push(entry),
		createEvent: async (_id, entry) => events.push(entry),
		updateRun: async (_id, patch) => updates.push(patch),
		pendingDurability,
		...overrides,
	});
	return {
		progress,
		events,
		updates,
		statuses,
		pendingDurability,
		advance: (ms) => {
			clock += ms;
		},
		state: {
			runInitialized: true,
			firstChangeObserved: false,
			providerStarted: true,
			runTerminalReached: false,
		},
	};
}

test("milestone intervals ignore heartbeats and event persistence strips unapproved details", async () => {
	const f = fixture();
	f.advance(100);
	f.progress.milestone(
		"execute",
		"provider_started",
		{ privateText: "not durable" },
		f.state,
	);
	f.advance(200);
	f.progress.heartbeat("execute", {}, f.state);
	f.advance(300);
	f.progress.milestone(
		"checks",
		"check_completed",
		{
			status: "succeeded",
			checkIndex: 0,
			checkIdentity: "check",
			checkStatus: "passed",
			exitCode: 0,
			signal: null,
			invocationDescriptor: { bad: true },
		},
		{ ...f.state, firstChangeObserved: true },
	);
	await Promise.allSettled([...f.pendingDurability]);
	deepStrictEqual(
		f.events.map((e) => e.elapsedSinceLastMilestoneMs),
		[100, 500],
	);
	strictEqual(f.events[1].elapsedMs, 600);
	strictEqual(f.events[1].firstChangeObserved, true);
	strictEqual(f.events[1].checkStatus, "passed");
	strictEqual(Object.hasOwn(f.events[0], "privateText"), false);
	strictEqual(Object.hasOwn(f.events[1], "invocationDescriptor"), false);
});

test("only live initialized providers persist throttled heartbeat timestamps and known process phases", async () => {
	const f = fixture();
	for (const state of [
		{ ...f.state, runInitialized: false },
		{ ...f.state, providerStarted: false },
		{ ...f.state, runTerminalReached: true },
	])
		f.progress.heartbeat(
			"execute",
			{ processPhase: "provider_running" },
			state,
		);
	strictEqual(f.updates.length, 0);
	f.progress.heartbeat("execute", { processPhase: "unknown" }, f.state);
	deepStrictEqual(f.updates, [
		{
			activeTaskHeartbeatAt: 1_000,
			activeTaskProcessPhase: "provider_running",
		},
	]);
	f.advance(29_999);
	f.progress.heartbeat("checks", { processPhase: "check_running" }, f.state);
	strictEqual(f.updates.length, 1);
	f.advance(1);
	f.progress.heartbeat("checks", {}, f.state);
	deepStrictEqual(f.updates[1], {
		activeTaskHeartbeatAt: 31_000,
		activeTaskProcessPhase: "check_running",
	});
	await Promise.allSettled([...f.pendingDurability]);
	strictEqual(f.pendingDurability.size, 0);
});

test("provider-start write failures return their error while missing initialization makes no write", async () => {
	const error = new Error("disk unavailable");
	const f = fixture({
		updateRun: async () => {
			throw error;
		},
	});
	strictEqual(
		await f.progress.persistProviderStarted({ runInitialized: false }),
		null,
	);
	strictEqual(
		await f.progress.persistProviderStarted({ runInitialized: true }),
		error,
	);
});

test("synchronous event sinks stay contained while reporting continues", () => {
	const f = fixture({
		createEvent: () => {
			throw new Error("event sink unavailable");
		},
	});
	f.progress.milestone("preflight", "route_selected", {}, f.state);
	strictEqual(f.pendingDurability.size, 0);
	strictEqual(f.statuses.length, 1);
});
