// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
	observeSimpleProcessIdentity,
	settleSimpleWriterProcesses,
} from "../src/switchyard/simple/process-teardown.mjs";
import { fakeClock } from "./helpers/fake-clock.mjs";

// A process group this user may not signal: its presence probe answers
// neither "present" nor "gone", which is the fail-closed wait path. Only
// signal 0 is ever sent to it, and only after EPERM proves no other signal
// could reach it.
function foreignProcessGroup() {
	if (process.getuid?.() === 0) return null;
	const listed = spawnSync("ps", ["-axo", "pgid=,uid="], { encoding: "utf8" });
	if (listed.status !== 0) return null;
	for (const line of listed.stdout.split("\n")) {
		const [pgid, uid] = line.trim().split(/\s+/u).map(Number);
		if (uid !== 0 || !Number.isSafeInteger(pgid) || pgid <= 1) continue;
		try {
			process.kill(-pgid, 0);
		} catch (error) {
			if (error?.code === "EPERM") return pgid;
		}
	}
	return null;
}

test("an unprobeable writer group waits its full window on the clock, not the host", async (t) => {
	const pgid = foreignProcessGroup();
	if (pgid === null) {
		t.skip("no root-owned process group answers EPERM here");
		return;
	}
	const clock = fakeClock(1_000_000);
	let progress = 0;
	const state = await settleSimpleWriterProcesses({
		processGroupId: pgid,
		onProgress: () => {
			progress += 1;
		},
		clock,
	});
	strictEqual(state, "unavailable");
	strictEqual(clock.now(), 1_005_000);
	strictEqual(clock.sleeps.length, 100);
	strictEqual(new Set(clock.sleeps).size, 1);
	strictEqual(clock.sleeps[0], 50);
	strictEqual(progress, 100);
});

test("a writer group that is already gone settles without a clock wait", async () => {
	const exited = spawnSync(process.execPath, ["-e", ""]);
	strictEqual(exited.status, 0);
	const clock = fakeClock();
	const state = await settleSimpleWriterProcesses({
		processGroupId: exited.pid,
		clock,
	});
	strictEqual(state, "stopped");
	deepStrictEqual(clock.sleeps, []);
	strictEqual(clock.now(), 0);
});

test("bounded identity observation exposes actual group and honestly weak start precision", () => {
	let args;
	const observed = observeSimpleProcessIdentity(123, {
		spawnSyncFn: (_command, argv) => {
			args = argv;
			return { status: 0, stdout: "Tue Oct 20 12:00:00 2026 S 123\n" };
		},
	});
	strictEqual(observed.processGroupId, 123);
	strictEqual(observed.stamp, "Tue Oct 20 12:00:00 2026");
	deepStrictEqual(args, [
		"-o",
		"lstart=",
		"-o",
		"stat=",
		"-o",
		"pgid=",
		"-p",
		"123",
	]);
	for (const result of [
		{ status: 1, stdout: "" },
		{ error: { code: "EPERM" } },
		{ status: 0, stdout: "malformed" },
		{ status: 0, stdout: "Tue Oct 20 12:00:00 2026 S NaN" },
	]) {
		strictEqual(
			observeSimpleProcessIdentity(123, { spawnSyncFn: () => result }),
			result.status === 1 ? false : null,
		);
	}
	strictEqual(observeSimpleProcessIdentity(null), null);
});
