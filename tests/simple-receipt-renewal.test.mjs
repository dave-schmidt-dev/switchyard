// @test-phase: other
// The dispatch-side half of automatic receipt renewal, run by `simple`.
//
// A `dispatch_qualified` receipt expires after 30 days, and until 2026-09-18 the
// only way to refresh one was a human running a canary per target. When a batch
// promoted together aged out together, six targets became un-dispatchable while
// every one of them still answered a direct call. `renewDispatchReceipts` closes
// that by treating a completed dispatch as the evidence it is.
//
// What is under test here is only the trigger: that a succeeded run shells out to
// the single roster writer, reports what it renewed, and -- above all -- never
// converts a bookkeeping failure into a failed dispatch. Whether a given receipt
// *should* renew is `rosterlib.renew`'s decision and is tested there
// (~/.agent/tests/test_roster_renew.py); duplicating that judgement in JS would
// recreate the second writer the delegation exists to avoid.
//
// Each test installs a fake `~/.agent/bin/roster` under a scratch HOME, so
// nothing here can reach the live roster.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { renewDispatchReceipts } from "../src/switchyard/simple/receipt-renewal.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

describe("renewDispatchReceipts", () => {
	let home;
	let realHome;
	let calls;
	let reported;

	const report = (line) => reported.push(line);

	/** Install a fake `roster` that records its argv and replays `script`. */
	function installRoster(script) {
		mkdirSync(join(home, ".agent", "bin"), { recursive: true });
		const cli = join(home, ".agent", "bin", "roster");
		writeFileSync(
			cli,
			`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(calls)}\n${script}\n`,
		);
		chmodSync(cli, 0o755);
		return cli;
	}

	const argv = () =>
		readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);

	/** Write a run record for `runId` and return renewal options that find it. */
	function recordRun(runId) {
		mkdirSync(join(home, "runs", runId), { recursive: true });
		writeFileSync(join(home, "runs", runId, "run.json"), "{}");
		return {
			runRoot: (id) => join(home, "runs", id),
			rosterPath: "/fixture/roster.json",
		};
	}
	const runRecord = (runId) => join(home, "runs", runId, "run.json");

	beforeEach(() => {
		realHome = process.env.HOME;
		home = tempDir("sy-renewal-");
		process.env.HOME = home;
		calls = join(home, "calls.txt");
		writeFileSync(calls, "");
		reported = [];
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("asks the roster CLI to renew exactly this run's record in the routing roster", async () => {
		installRoster(
			"echo 'renewed  antigravity-claude.standard 5db604e3907f -> 2026-09-18T21:21:22.121Z'",
		);
		await renewDispatchReceipts("simple-a", report, recordRun("simple-a"));

		deepStrictEqual(argv(), [
			"renew",
			runRecord("simple-a"),
			"--file",
			"/fixture/roster.json",
		]);
		deepStrictEqual(reported, [
			"dispatch: renewed  antigravity-claude.standard 5db604e3907f -> 2026-09-18T21:21:22.121Z",
		]);
	});

	it("reports every renewal the roster CLI made, and nothing else", async () => {
		// Skips are the normal case -- a dispatch routinely runs descriptors
		// whose slots have moved -- so surfacing them as run output would train
		// the reader to ignore the line that matters.
		installRoster(
			"echo 'renewed  a.standard 111111111111 -> 2026-09-18T00:00:00.000Z'\n" +
				"echo 'renewed  b.low 222222222222 -> 2026-09-18T00:00:01.000Z'\n" +
				"echo 'skipped  c 333333333333 (slot_moved)'",
		);
		await renewDispatchReceipts("simple-b", report, recordRun("simple-b"));

		deepStrictEqual(reported, [
			"dispatch: renewed  a.standard 111111111111 -> 2026-09-18T00:00:00.000Z",
			"dispatch: renewed  b.low 222222222222 -> 2026-09-18T00:00:01.000Z",
		]);
	});

	it("says nothing when the run renewed nothing", async () => {
		installRoster("echo 'roster renew: nothing renewable in this run record'");
		await renewDispatchReceipts("simple-c", report, recordRun("simple-c"));
		deepStrictEqual(reported, []);
	});

	it("steps over a refusing roster CLI instead of failing the finished run", async () => {
		// The dispatch has already succeeded and its result is already durable.
		// Failing it over a bookkeeping write would be a worse regression than
		// the expiry renewal exists to prevent.
		installRoster(
			"echo 'roster.json is already invalid (2 violation(s))' >&2\nexit 1",
		);
		await renewDispatchReceipts("simple-d", report, recordRun("simple-d"));

		strictEqual(reported.length, 1);
		ok(
			reported[0].startsWith("dispatch: receipt renewal skipped ("),
			`unexpected report: ${reported[0]}`,
		);
		ok(
			reported[0].includes("already invalid"),
			`refusal not surfaced: ${reported[0]}`,
		);
	});

	it("still reports a skip when a failing CLI explains itself on neither stream", async () => {
		installRoster("exit 3");
		await renewDispatchReceipts("simple-e", report, recordRun("simple-e"));
		deepStrictEqual(reported, [
			"dispatch: receipt renewal skipped (roster renew failed)",
		]);
	});

	it("is a no-op when no roster CLI is installed", async () => {
		// Switchyard runs on hosts with no `~/.agent` at all; renewal is an
		// enhancement there, not a dependency.
		await renewDispatchReceipts("simple-f", report, recordRun("simple-f"));
		deepStrictEqual(reported, []);
	});

	it("does not invoke the CLI without a run or its durable record", async () => {
		installRoster(
			"echo 'renewed  a.standard 111111111111 -> 2026-09-18T00:00:00.000Z'",
		);
		const options = recordRun("simple-g");
		await renewDispatchReceipts(undefined, report, options);
		await renewDispatchReceipts("", report, options);
		await renewDispatchReceipts("simple-unrecorded", report, options);
		deepStrictEqual(argv(), []);
		deepStrictEqual(reported, []);
	});

	it("reports a slow roster CLI while it runs and bounds it", async () => {
		installRoster("sleep 5");
		const started = Date.now();
		await renewDispatchReceipts("simple-h", report, {
			...recordRun("simple-h"),
			progressMs: 50,
			timeoutMs: 400,
		});
		ok(Date.now() - started < 4_000, "renewal was not bounded");
		ok(reported.includes("dispatch: receipt renewal still running"));
		strictEqual(
			reported.at(-1),
			"dispatch: receipt renewal skipped (roster renew failed)",
		);
	});
});

describe("simple CLI renewal trigger", () => {
	function invocation() {
		const project = realpathSync(tempDir("renewal-cli-project-"));
		const stateRoot = realpathSync(tempDir("renewal-cli-state-"));
		strictEqual(spawnSync("git", ["init", "-q", project]).status, 0);
		writeFileSync(join(project, "prompt.txt"), "Implement bounded file edit");
		writeFileSync(join(project, "a.txt"), "baseline");
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
			"--routing-run-id",
			"renewal-run",
			"--deadline",
			new Date(Date.now() + 60_000).toISOString(),
		];
		return { argv, stateRoot };
	}

	for (const [status, renews] of [
		["succeeded", true],
		["failed", false],
	]) {
		it(`${renews ? "renews after" : "skips renewal for"} a ${status} run, after the result is written`, async () => {
			const { argv, stateRoot } = invocation();
			const events = [];
			await handleSimple(argv, {
				stateRoot,
				signalProcess: new EventEmitter(),
				onStatus: () => {},
				writeWarning: () => {},
				runSimpleRoutingTask: async () => ({
					direction: status === "succeeded" ? "complete" : "stop",
					stopReason: status === "succeeded" ? undefined : "check_failed",
					routingRunId: "renewal-run",
					routingRunIdSource: "flag",
					attempts: [],
					failedTargetIds: [],
					result: { status, runId: "simple-renewal-run" },
				}),
				renewDispatchReceipts: async (runId) => events.push(["renew", runId]),
				writeResult: () => events.push(["result"]),
			});
			deepStrictEqual(
				events,
				renews ? [["result"], ["renew", "simple-renewal-run"]] : [["result"]],
			);
		});
	}
});
