// The dispatch-side half of automatic receipt renewal.
//
// A `dispatch_qualified` receipt expires after 30 days, and until 2026-09-18 the
// only way to refresh one was a human running a canary per target. When a batch
// promoted together aged out together, six targets became un-dispatchable while
// every one of them still answered a direct call. `renewDispatchReceipts` closes
// that by treating a completed dispatch as the evidence it is.
//
// What is under test here is only the trigger: that a finished run shells out to
// the single roster writer, reports what it renewed, and -- above all -- never
// converts a bookkeeping failure into a failed dispatch. Whether a given receipt
// *should* renew is `rosterlib.renew`'s decision and is tested there
// (~/.agent/tests/test_roster_renew.py); duplicating that judgement in JS would
// recreate the second writer the delegation exists to avoid.
//
// Each test installs a fake `~/.agent/bin/roster` under a scratch HOME, so
// nothing here can reach the live roster.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renewDispatchReceipts } from "../src/switchyard/dispatch/index.mjs";
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

	it("asks the roster CLI to renew exactly the checkpoint this run wrote", () => {
		installRoster(
			"echo 'renewed  antigravity-claude.standard 5db604e3907f -> 2026-09-18T21:21:22.121Z'",
		);
		renewDispatchReceipts("/queue/tasks.md.checkpoint.json", report);

		deepStrictEqual(argv(), ["renew", "/queue/tasks.md.checkpoint.json"]);
		deepStrictEqual(reported, [
			"dispatch: renewed  antigravity-claude.standard 5db604e3907f -> 2026-09-18T21:21:22.121Z",
		]);
	});

	it("reports every renewal a multi-target queue earned, and nothing else", () => {
		// Skips are the normal case -- a queue routinely dispatches descriptors
		// whose slots have moved -- so surfacing them as run output would train
		// the reader to ignore the line that matters.
		installRoster(
			"echo 'renewed  a.standard 111111111111 -> 2026-09-18T00:00:00.000Z'\n" +
				"echo 'renewed  b.low 222222222222 -> 2026-09-18T00:00:01.000Z'\n" +
				"echo 'skipped  c 333333333333 (slot_moved)'",
		);
		renewDispatchReceipts("/queue/ckpt.json", report);

		deepStrictEqual(reported, [
			"dispatch: renewed  a.standard 111111111111 -> 2026-09-18T00:00:00.000Z",
			"dispatch: renewed  b.low 222222222222 -> 2026-09-18T00:00:01.000Z",
		]);
	});

	it("says nothing when the checkpoint renewed nothing", () => {
		installRoster(
			"echo 'roster renew: no successful dispatches in this checkpoint'",
		);
		renewDispatchReceipts("/queue/ckpt.json", report);
		deepStrictEqual(reported, []);
	});

	it("steps over a refusing roster CLI instead of failing the finished run", () => {
		// The dispatch has already succeeded and its result is already durable.
		// Failing it over a bookkeeping write would be a worse regression than
		// the expiry renewal exists to prevent.
		installRoster(
			"echo 'roster.json is already invalid (2 violation(s))' >&2\nexit 1",
		);
		renewDispatchReceipts("/queue/ckpt.json", report);

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

	it("still reports a skip when a failing CLI explains itself on neither stream", () => {
		installRoster("exit 3");
		renewDispatchReceipts("/queue/ckpt.json", report);
		deepStrictEqual(reported, [
			"dispatch: receipt renewal skipped (roster renew failed)",
		]);
	});

	it("is a no-op when no roster CLI is installed", () => {
		// Switchyard runs on hosts with no `~/.agent` at all; renewal is an
		// enhancement there, not a dependency.
		renewDispatchReceipts("/queue/ckpt.json", report);
		deepStrictEqual(reported, []);
	});

	it("does not invoke the CLI when the run produced no checkpoint", () => {
		installRoster(
			"echo 'renewed  a.standard 111111111111 -> 2026-09-18T00:00:00.000Z'",
		);
		renewDispatchReceipts(undefined, report);
		renewDispatchReceipts("", report);
		deepStrictEqual(argv(), []);
		deepStrictEqual(reported, []);
	});
});
