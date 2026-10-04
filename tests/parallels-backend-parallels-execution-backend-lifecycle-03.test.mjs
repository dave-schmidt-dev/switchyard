import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
	parseParallelsWorkingName,
	ParallelsExecutionBackend as RealParallelsExecutionBackend,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

const GOLDEN_UUID = "{11111111-1111-4111-8111-111111111111}";

const WORK_UUID = "{22222222-2222-4222-8222-222222222222}";

const TEST_BOOT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TEST_RUN_STORE_ROOT = tempDir("switchyard-ownership-store-");

process.env.SWITCHYARD_RUN_STORE_ROOT = TEST_RUN_STORE_ROOT;

function fixtureBirth(pid, ticks = String(pid * 10 + 1)) {
	return `switchyard-host-process-v1:${TEST_BOOT_UUID}:${pid}:${ticks}`;
}

function fixtureHostProbe(pid) {
	return {
		state: "present",
		pid,
		bootSessionUuid: TEST_BOOT_UUID,
		startTicks: String(pid * 10 + 1),
		identity: fixtureBirth(pid),
	};
}

class ParallelsExecutionBackend extends RealParallelsExecutionBackend {
	constructor(options = {}) {
		super({ hostProcessIdentityProbe: fixtureHostProbe, ...options });
	}
}

function ownedOptions(runId, creatorPid = process.pid, overrides = {}) {
	return {
		runId,
		creatorPid,
		ownershipContext: {
			resourceRoot: join(TEST_RUN_STORE_ROOT, "runs", runId, "resources"),
			runId,
			taskId: "backend-fixture",
			attemptId: "attempt-1",
			projectRoot: "/private/tmp/switchyard-fixture-project",
			purpose: "backend-test",
			creatorPid,
			processStartIdentity: fixtureBirth(creatorPid),
			...overrides,
		},
	};
}

function registerOwnedEntry(backend, entry, overrides = {}) {
	const parsed = parseParallelsWorkingName(entry.name);
	const options = ownedOptions(parsed.runId, parsed.creatorPid, overrides);
	backend.writeVmOwnership(entry.uuid, entry.name, options.ownershipContext);
	backend.hostProcessIdentityProbe = (pid) =>
		backend.pidIsAlive(pid)
			? fixtureHostProbe(pid)
			: {
					state: "absent",
					pid,
					bootSessionUuid: TEST_BOOT_UUID,
					identity: null,
				};
	return options.ownershipContext;
}

function decodeGuestScript(args) {
	const match = /^'eval "\$\(printf %s ([A-Za-z0-9+/=]+) \| .*\)"'$/.exec(
		args.at(-1),
	);
	ok(match, `no base64 payload in ${args.at(-1)}`);
	return Buffer.from(match[1], "base64").toString("utf8");
}

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

describe("Parallels execution backend lifecycle", () => {
	it("quotes bash scripts before passing them through prlctl", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				return "";
			},
		});
		backend.execGuest("{vm-uuid}", "/bin/bash", [
			"-lc",
			"if test -e /tmp/x; then echo yes; fi",
		]);
		strictEqual(calls[0].at(-2), "-lc");
		strictEqual(
			decodeGuestScript(calls[0]),
			`cd '/Users/switchyard/.switchyard/project' && exec '/bin/bash' '-lc' 'if test -e /tmp/x; then echo yes; fi'`,
		);
	});

	it("never books a signal-killed prlctl as success", () => {
		const signalDeath = () => {
			// The shape execFileSync raises for a child killed by a signal.
			const error = new Error("Command failed: prlctl");
			error.status = null;
			error.signal = "SIGSEGV";
			throw error;
		};
		const calls = [];
		// `list` keeps working so the failure lands where it matters. A crash
		// that takes out handle resolution proves nothing about the paths that
		// catch and escalate.
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			// This VM never stops, so waiting out the settle window would only
			// add real seconds to the assertion being made about escalation.
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args[0]);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							// Destroy refuses a VM outside the reserved name, so an
							// unmanaged name would pass this test for the wrong reason.
							name: buildParallelsWorkingName("crashed-run", process.pid),
						},
					]);
				return signalDeath();
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("crashed-run", process.pid),
		});
		throws(
			() => backend.execGuest(WORK_UUID, "/bin/bash", ["-lc", "true"]),
			/Command failed: prlctl/,
			"a segfaulted prlctl exec returned instead of throwing",
		);
		// destroy escalates stop -> stop --kill -> delete. Every one of those
		// dies the same way here, so the escalation must run out and surface
		// rather than report a VM it never destroyed.
		throws(
			() => backend.destroy(WORK_UUID),
			/Command failed: prlctl/,
			"destroy reported success against a prlctl that never ran",
		);
		ok(
			calls.filter((verb) => verb === "stop").length >= 2,
			`destroy did not exhaust its escalation before failing: ${calls.join(",")}`,
		);
	});

	it("deletes after a failed stop only when an exact stopped state is reprobed", () => {
		const calls = [];
		let deleted = false;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop") {
					if (args[2] === "--kill") throw new Error("stop returned 255");
					throw new Error("stop returned 255");
				}
				if (args[0] === "list")
					return deleted
						? listed([])
						: listed([
								{
									uuid: WORK_UUID,
									status: "stopped",
									name: buildParallelsWorkingName("stopped", process.pid),
								},
							]);
				if (args[0] === "delete") {
					deleted = true;
					return "";
				}
				return "";
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("stopped", process.pid),
		});

		deepStrictEqual(backend.destroy(WORK_UUID), {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("stopped", process.pid),
			forced: true,
		});
		deepStrictEqual(
			calls.map((args) => args[0]),
			["list", "stop", "stop", "list", "delete", "list"],
		);
	});

	it("preserves a failed stop and never deletes while the exact VM is running", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("running", process.pid),
						},
					]);
				throw new Error(`${args[0]} returned 255`);
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("running", process.pid),
		});

		let failure;
		throws(
			() => backend.destroy(WORK_UUID),
			(error) => {
				failure = error;
				return /returned 255/.test(error.message);
			},
		);
		ok(!calls.some((args) => args[0] === "delete"));
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		strictEqual(calls.filter((args) => args[0] === "stop").length, 3);
		ok(failure?.cleanupUncertain);
	});

	it("gives every prlctl call a deadline, and lets an explicit one win", () => {
		// A `prlctl stop --kill` with no timeout hung for 3h32m on 2026-09-08,
		// taking a VM and a harness with it. The default is applied at the _call
		// chokepoint so it covers an injected client too, and any site that
		// already chose its own bound keeps it.
		const options = [];
		const backend = new ParallelsExecutionBackend({
			prlctlCallTimeoutMs: 4_000,
			prlctlFn: (args, opts) => {
				options.push([args[0], opts]);
				return "";
			},
		});

		backend.preflight();
		strictEqual(options[0][1].timeout, 4_000);
		strictEqual(options[0][1].killSignal, "SIGKILL");

		backend._call(["list", "-a"], { timeout: 250 });
		strictEqual(options[1][1].timeout, 250);
	});

	it("surfaces a timed-out prlctl call instead of retrying it as a misfire", () => {
		// A timeout is not a lost SDK job result: retrying it three more times
		// turns one stuck call into four, which is how a bounded call becomes an
		// unbounded one again.
		let attempts = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: () => {
				attempts += 1;
				const error = new Error("Command failed: prlctl list");
				error.code = "ETIMEDOUT";
				error.killed = true;
				throw error;
			},
		});

		throws(
			() => backend.preflight(),
			(error) => {
				strictEqual(error.diagnosticCode, "prlctl_call_timed_out");
				return true;
			},
		);
		strictEqual(attempts, 1);
	});

	it("refuses to report the golden stopped while it is observed running", () => {
		// `prlctl stop` has been seen exiting 0 with the VM still serving. The
		// whole purpose of stopGoldenImage is that the next boot or clone is not
		// blocked by the golden still running, so the postcondition is observed.
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			goldenImage: GOLDEN_UUID,
			// The golden waits its own, longer window; both are zeroed so the
			// test asserts the observation, not the wait.
			stopSettleTimeoutMs: 0,
			goldenStopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				// The whole argv, not args[0]: recording the verb alone made the
				// "never forced" assertion below vacuously true, since a graceful
				// stop and a `stop --kill` are both `stop`.
				calls.push(args.join(" "));
				if (args[0] === "list")
					return listed([
						{ uuid: GOLDEN_UUID, status: "running", name: "golden" },
					]);
				return "";
			},
		});

		throws(
			() => backend.stopGoldenImage(GOLDEN_UUID),
			/still running 0ms after prlctl stop exited 0/,
		);
		// Never forced, and never deleted: the golden is not disposable. The
		// exact sequence is the claim -- one graceful stop, one observation of
		// it, and nothing else.
		deepStrictEqual(calls, [
			// stopGoldenImage resolves the handle before it stops it.
			"list -a -o uuid,status,name",
			`stop ${GOLDEN_UUID}`,
			"list -a -o uuid,status,name",
		]);
	});

	it("observes a force-stop before deleting after a lying graceful stop", () => {
		// The inverse of prlctl_job_misfire: success reported for a mutation that
		// did not happen. Without the observation the false success fell straight
		// through to `delete` on a running VM.
		const calls = [];
		let stopped = false;
		let deleted = false;
		const lyingName = buildParallelsWorkingName("lying-stop", process.pid);
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args.slice(0, 3).join(" "));
				if (args[0] === "stop" && args[2] === "--kill") stopped = true;
				if (args[0] === "list")
					if (deleted) return listed([]);
					else
						return listed([
							{
								uuid: WORK_UUID,
								status: stopped ? "stopped" : "running",
								name: lyingName,
							},
						]);
				if (args[0] === "delete") deleted = true;
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: lyingName,
				status: "running",
			}),
			{ uuid: WORK_UUID, name: lyingName, forced: true },
		);
		// Ordering is the claim, not the mere presence of a kill: the escalation
		// has to follow the observation that the graceful stop did not take.
		deepStrictEqual(calls, [
			`stop ${WORK_UUID}`,
			"list -a -o",
			`stop ${WORK_UUID} --kill`,
			"list -a -o",
			`delete ${WORK_UUID}`,
			"list -a -o",
		]);
	});
});
