import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";

test("a soft failure below the reroute floor stops without reaching the next target", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	let current = 0;
	f.deps.now = () => current;
	f.options.deadlineMs = 30 * 60_000;
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		if (result.targetId === "antigravity-claude")
			current = f.options.deadlineMs - 100_000;
		return result;
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	strictEqual(result.stopReason, "execution_failed");
	strictEqual(result.stopReason, result.attempts[0].reason);
	strictEqual(result.attempts.length, 1);
	deepStrictEqual(f.calls, ["antigravity-claude"]);
});

test("a soft failure above the reroute floor continues to the next target", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	let current = 0;
	f.deps.now = () => current;
	f.options.deadlineMs = 30 * 60_000;
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		if (result.targetId === "antigravity-claude")
			current = f.options.deadlineMs - 200_000;
		return result;
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
});

test("a short task still reroutes below the module floor while above its own floor", async () => {
	const f = fixture({
		__targets: ["antigravity-claude", "codex"],
		"antigravity-claude": { status: "failed" },
	});
	let current = 0;
	f.deps.now = () => current;
	f.options.deadlineMs = 10_000;
	const runSimpleTask = f.deps.runSimpleTask;
	f.deps.runSimpleTask = async (...args) => {
		const result = await runSimpleTask(...args);
		if (result.targetId === "antigravity-claude")
			current = f.options.deadlineMs - 5_000;
		return result;
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
});

test("a first attempt still starts with only 30 s left of a 30-minute deadline", async () => {
	const f = fixture({ __targets: ["antigravity-claude", "codex"] });
	const current = 30 * 60_000 - 30_000;
	f.deps.now = () => current;
	f.options.deadlineMs = 30 * 60_000;
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude"]);
});
