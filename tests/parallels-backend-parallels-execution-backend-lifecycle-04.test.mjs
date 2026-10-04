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

const CLIPBOARD_LABEL = "gui/501/com.parallels.copypaste";

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

function probeChild(value, overrides = {}) {
	return {
		status: 0,
		signal: null,
		stdout: JSON.stringify(value),
		stderr: "ignored fixture stderr",
		...overrides,
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

function markerContext(operation = "provider", overrides = {}) {
	return {
		runId: "marker-run",
		taskId: "1.4",
		attemptId: "attempt-1",
		descriptorIdentity: "descriptor-1",
		workspaceId: WORK_UUID,
		processStartIdentity: "fixture-birth:marker-run",
		operation,
		...overrides,
	};
}

const WORKSPACE_READY = "switchyard:700\nswitchyard:700\n";

const WORKSPACE_UNAPPLIED = "switchyard:755\nswitchyard:755\n";

function causedBy(error, original) {
	for (let current = error, depth = 0; current && depth < 16; depth += 1) {
		if (current === original) return true;
		current = current.cause;
	}
	return false;
}

function lostExitCode() {
	const error = new Error(
		"Command failed: prlctl exec\nPrlJob_GetRetCode: Invalid argument. An invalid argument was passed.",
	);
	error.status = 255;
	error.stderr = "PrlJob_GetRetCode: Invalid argument.";
	error.stdout = "";
	return error;
}

function workspaceBackend(respond, options = {}) {
	return new ParallelsExecutionBackend({
		hostProcessIdentityProbe: fixtureHostProbe,
		aquaUid: 501,
		sleepFn: () => {},
		workspaceVerifyPollMs: 1,
		prlctlFn: (args) => respond(args),
		...options,
	});
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
	it("retries a false-success force-stop once before deleting", () => {
		const calls = [];
		let killAttempts = 0;
		let deleted = false;
		const sleeps = [];
		const entry = {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("force-retry", process.pid),
			status: "running",
		};
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			sleepFn: (milliseconds) => sleeps.push(milliseconds),
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop" && args[2] === "--kill") {
					killAttempts += 1;
					return "success reported";
				}
				if (args[0] === "list") {
					return deleted
						? listed([])
						: listed([
								{
									...entry,
									status: killAttempts >= 2 ? "stopped" : "running",
								},
							]);
				}
				if (args[0] === "delete") deleted = true;
				return "";
			},
		});

		deepStrictEqual(backend.stopAndDelete(entry, { forceOnly: true }), {
			uuid: WORK_UUID,
			name: entry.name,
			forced: true,
		});
		strictEqual(killAttempts, 2);
		deepStrictEqual(sleeps, [25]);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "stop", "list", "delete", "list"],
		);
	});

	it("fails closed after force-stop exhaustion without deleting", () => {
		const calls = [];
		const entry = {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("force-stuck", process.pid),
			status: "running",
		};
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([{ ...entry, status: "running" }]);
				return "";
			},
		});

		let failure;
		throws(
			() => backend.stopAndDelete(entry, { forceOnly: true }),
			(error) => {
				failure = error;
				return true;
			},
		);
		ok(failure.cleanupUncertain);
		strictEqual(calls.filter((args) => args[0] === "stop").length, 2);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "stop", "list"],
		);
	});

	it("does not retry a force-stop when inventory is ambiguous", () => {
		const calls = [];
		const entry = {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("force-malformed", process.pid),
			status: "running",
		};
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return "not-an-inventory";
				return "";
			},
		});

		let failure;
		throws(
			() => backend.stopAndDelete(entry, { forceOnly: true }),
			(error) => {
				failure = error;
				return true;
			},
		);
		ok(failure.cleanupUncertain);
		strictEqual(calls.filter((args) => args[0] === "stop").length, 1);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
	});

	it("reprobes after delete fallback before retrying deletion", () => {
		const calls = [];
		let deleteAttempts = 0;
		let deleted = false;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return deleted
						? listed([])
						: listed([
								{
									uuid: WORK_UUID,
									status: "stopped",
									name: buildParallelsWorkingName(
										"delete-fallback",
										process.pid,
									),
								},
							]);
				if (args[0] === "delete") {
					if (deleteAttempts++ === 0) throw new Error("delete returned 255");
					deleted = true;
				}
				return "";
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("delete-fallback", process.pid),
		});

		deepStrictEqual(backend.destroy(WORK_UUID), {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("delete-fallback", process.pid),
			forced: true,
		});
		deepStrictEqual(
			calls.map((args) => args[0]),
			[
				"list",
				"stop",
				"list",
				"delete",
				"stop",
				"list",
				"list",
				"delete",
				"list",
			],
		);
	});

	it("preserves delete failure when fallback stop does not leave the exact VM stopped", () => {
		const calls = [];
		const deleteFailure = new Error("delete returned 255");
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("delete-running", process.pid),
						},
					]);
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("delete-running", process.pid),
		});

		let failure;
		throws(
			() => backend.destroy(WORK_UUID),
			(error) => {
				failure = error;
				return /still running/.test(error.message);
			},
		);
		ok(failure.cleanupUncertain);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["list", "stop", "list", "stop", "list", "stop", "list"],
		);
	});

	it("does not reprobe stale graceful-stop failure when kill succeeds", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop" && args[2] !== "--kill")
					throw new Error("graceful stop returned 255");
				if (args[0] === "list") return listed([]);
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: "kill-success",
				status: "running",
			}),
			{ uuid: WORK_UUID, name: "kill-success", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "stop", "list", "delete", "list"],
		);
	});

	it("treats an absent exact VM after failed delete as already deleted", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "delete") throw new Error("delete returned 255");
				if (args[0] === "list") return listed([]);
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: "absent",
				status: "running",
			}),
			{ uuid: WORK_UUID, name: "absent", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "delete", "stop", "list", "list"],
		);
	});

	it("preserves delete failure when exact-state probing fails", () => {
		const calls = [];
		const deleteFailure = new Error("delete returned 255");
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") throw new Error("list unavailable");
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});

		let failure;
		throws(
			() =>
				backend.stopAndDelete({
					uuid: WORK_UUID,
					name: "probe-failure",
					status: "running",
				}),
			(error) => {
				failure = error;
				return /still running/.test(error.message);
			},
		);
		ok(failure.cleanupUncertain);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "stop", "list"],
		);
	});
});
