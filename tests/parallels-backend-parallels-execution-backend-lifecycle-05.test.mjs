import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";

import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
	ParallelsExecutionBackend as RealParallelsExecutionBackend,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

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

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

describe("Parallels execution backend lifecycle", () => {
	it("treats an absent exact VM after retry-delete failure as already deleted", () => {
		const calls = [];
		let deleteAttempts = 0;
		let listAttempts = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "delete") {
					deleteAttempts += 1;
					throw new Error(`delete attempt ${deleteAttempts} returned 255`);
				}
				if (args[0] === "list") {
					listAttempts += 1;
					// Two present-and-stopped answers, not one: the first is
					// consumed by the post-stop settle probe. Absence has to fall
					// on the reprobe after the retry delete or this test stops
					// covering the path it is named for.
					return listAttempts <= 2
						? listed([
								{
									uuid: WORK_UUID,
									status: "stopped",
									name: buildParallelsWorkingName("retry-present", process.pid),
								},
							])
						: listed([]);
				}
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: buildParallelsWorkingName("retry-present", process.pid),
				status: "running",
			}),
			{
				uuid: WORK_UUID,
				name: buildParallelsWorkingName("retry-present", process.pid),
				forced: true,
			},
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "delete", "stop", "list", "list"],
		);
	});

	it("reprobes a forced VM after delete failure without issuing a second kill", () => {
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
										"forced-stopped",
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

		deepStrictEqual(
			backend.stopAndDelete(
				{
					uuid: WORK_UUID,
					name: buildParallelsWorkingName("forced-stopped", process.pid),
					status: "running",
				},
				{ forceOnly: true },
			),
			{
				uuid: WORK_UUID,
				name: buildParallelsWorkingName("forced-stopped", process.pid),
				forced: true,
			},
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "delete", "list", "delete", "list"],
		);
	});

	it("preserves forced delete failure while the exact VM remains running", () => {
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
							name: buildParallelsWorkingName("forced-running", process.pid),
						},
					]);
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});

		let failure;
		throws(
			() =>
				backend.stopAndDelete(
					{
						uuid: WORK_UUID,
						name: buildParallelsWorkingName("forced-running", process.pid),
						status: "running",
					},
					{ forceOnly: true },
				),
			(error) => {
				failure = error;
				return /force-stop failed/.test(error.message);
			},
		);
		ok(failure.cleanupUncertain);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "stop", "list"],
		);
	});

	it("waits out the shutdown settle window instead of racing its own stop", () => {
		// The sequence measured on the INV-1 gate 2026-08-31: the stop reported
		// success, the delete issued straight after it was refused because
		// Parallels still had the VM running, and the VM reported stopped a
		// moment later. Sampling that state once decides the race by coin flip
		// and leaks the VM on the losing side.
		//
		// Since 2026-09-08 the settle window is waited on the stop rather than on
		// the refused delete, so the racing delete is no longer how the wait gets
		// entered. The stub still fails the first delete, which is what keeps the
		// old reconciliation path covered here as well.
		const calls = [];
		const sleeps = [];
		let listAttempts = 0;
		let deleteAttempts = 0;
		let deleted = false;
		const backend = new ParallelsExecutionBackend({
			sleepFn: (ms) => sleeps.push(ms),
			stopSettlePollMs: 1,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					listAttempts += 1;
					if (deleted) return listed([]);
					return listed([
						{
							uuid: WORK_UUID,
							status: listAttempts < 3 ? "running" : "stopped",
							name: buildParallelsWorkingName("settling", process.pid),
						},
					]);
				}
				if (args[0] === "delete") {
					if (deleteAttempts++ === 0) {
						const error = new Error("Command failed: prlctl delete");
						error.status = 255;
						error.stderr =
							"Failed to remove the VM: Unable to perform the action because the virtual machine is busy. The virtual machine is currently running. Please try again later.";
						throw error;
					}
					deleted = true;
				}
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: buildParallelsWorkingName("settling", process.pid),
				status: "running",
			}),
			{
				uuid: WORK_UUID,
				name: buildParallelsWorkingName("settling", process.pid),
				forced: true,
			},
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			[
				"stop",
				"list",
				"list",
				"list",
				"delete",
				"stop",
				"list",
				"list",
				"delete",
				"list",
			],
		);
		strictEqual(sleeps.length, 2);
	});

	it("preserves the delete failure when the VM never settles", () => {
		const calls = [];
		const deleteFailure = new Error("delete returned 255");
		let now = 0;
		const backend = new ParallelsExecutionBackend({
			nowFn: () => now,
			deleteSettlementNowFn: () => now,
			sleepFn: (ms) => {
				now += ms;
			},
			stopSettleTimeoutMs: 3_000,
			stopSettlePollMs: 1_000,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("stuck", process.pid),
						},
					]);
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});

		let failure;
		throws(
			() =>
				backend.stopAndDelete({
					uuid: WORK_UUID,
					name: buildParallelsWorkingName("stuck", process.pid),
					status: "running",
				}),
			(error) => {
				failure = error;
				return /still running/.test(error.message);
			},
		);
		ok(failure.cleanupUncertain);
		// It waited the full window before giving up, and never deleted a VM it
		// had just observed running.
		// The failed-delete observation reuses the one delete-settlement window;
		// it does not start a second full settle period.
		strictEqual(calls.filter((args) => args[0] === "list").length, 12);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
	});

	it("fails closed on malformed deletion inventory", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args, options) => {
				calls.push({ args, options });
				if (args[0] === "list") return "not-a-complete-inventory-row";
				return "";
			},
		});

		throws(
			() =>
				backend.stopAndDelete(
					{ uuid: WORK_UUID, name: "malformed", status: "stopped" },
					{ forceOnly: true },
				),
			/error|remained present|inventory/i,
		);
		strictEqual(calls.filter(({ args }) => args[0] === "delete").length, 1);
		strictEqual(calls.filter(({ args }) => args[0] === "list").length, 1);
		strictEqual(calls.at(-1).options.timeout, 1);
	});
});
