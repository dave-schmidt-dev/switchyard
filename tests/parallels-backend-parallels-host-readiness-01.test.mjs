import {
	deepStrictEqual,
	equal,
	match,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";

import { execFileSync, spawnSync } from "node:child_process";

import { createHash, randomUUID } from "node:crypto";

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	describeExecError,
	PrlctlCallError,
	prlctlFailureMetadata,
	WorkerBootStageError,
	workerBootStageDiagnosticCode,
} from "../src/switchyard/adapter/exec-error.mjs";

import { seedProjectWithBackend } from "../src/switchyard/lifecycle/index.mjs";

import {
	BULK_TRANSFER_HELPER,
	buildParallelsWorkingName,
	describeBulkTransferFailure,
	MAX_AQUA_EXEC_ARGV_BYTES,
	PARALLELS_WORKING_PREFIX,
	ParallelsHostReadinessError,
	parseParallelsWorkingName,
	probeHostProcessIdentity,
	ParallelsExecutionBackend as RealParallelsExecutionBackend,
	validateLinkedCloneMeasurement,
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

describe("Parallels host readiness", () => {
	it("requires a complete read-only inventory rather than a version check", () => {
		const calls = [];
		const statuses = [];
		const backend = new ParallelsExecutionBackend({
			hostReadinessNowFn: () => 1_000,
			prlctlFn: (args, options) => {
				calls.push({ args, options });
				return `${WORK_UUID}\trunning\tswitchyard-work-run-1\n`;
			},
		});

		deepStrictEqual(
			backend.probeHostReadiness({ onStatus: (event) => statuses.push(event) }),
			{
				inventoryCount: 1,
			},
		);
		deepStrictEqual(calls, [
			{
				args: ["list", "-a", "-o", "uuid,status,name"],
				options: {
					timeout: 2_000,
					killSignal: "SIGKILL",
					maxBuffer: 1024 * 1024,
				},
			},
		]);
		deepStrictEqual(
			statuses.map(({ event, elapsedMs }) => ({ event, elapsedMs })),
			[
				{ event: "host_readiness_probe", elapsedMs: 0 },
				{ event: "host_readiness_ready", elapsedMs: 0 },
			],
		);
	});

	it("accepts an exact header-only empty inventory but rejects blank output", () => {
		const empty = new ParallelsExecutionBackend({
			prlctlFn: () => "UUID\tSTATUS\tNAME\n",
		});
		deepStrictEqual(empty.probeHostReadiness(), { inventoryCount: 0 });

		const blank = new ParallelsExecutionBackend({ prlctlFn: () => " \n" });
		throws(
			() => blank.probeHostReadiness(),
			(error) => error.code === "vm_host_inventory_unavailable",
		);
	});

	it("rejects malformed inventory as unavailable instead of treating it as empty", () => {
		const backend = new ParallelsExecutionBackend({
			hostReadinessAttempts: 1,
			prlctlFn: () => "not-a-complete-inventory-row",
		});

		throws(
			() => backend.probeHostReadiness(),
			(error) =>
				error instanceof ParallelsHostReadinessError &&
				error.code === "vm_host_inventory_unavailable",
		);
	});

	it("does not retry a denied inventory boundary", () => {
		let calls = 0;
		const denied = Object.assign(new Error("denied"), { code: "EACCES" });
		const backend = new ParallelsExecutionBackend({
			hostReadinessAttempts: 2,
			prlctlFn: () => {
				calls += 1;
				throw denied;
			},
		});

		throws(
			() => backend.probeHostReadiness(),
			(error) =>
				error instanceof ParallelsHostReadinessError &&
				error.code === "vm_host_inventory_permission_denied" &&
				error.boundary === "parallels_vm_inventory",
		);
		strictEqual(calls, 1);
	});

	it("classifies a sandbox-denied ps probe from the prlctl wrapper as permission denied", () => {
		let calls = 0;
		const backend = new ParallelsExecutionBackend({
			hostReadinessAttempts: 2,
			prlctlFn: () => {
				calls += 1;
				const denied = new Error("wrapper refused host process inspection");
				denied.status = 7;
				denied.stderr =
					"/usr/local/bin/prlctl: line 82: /bin/ps: Operation not permitted\n";
				throw denied;
			},
		});

		throws(
			() => backend.probeHostReadiness(),
			(error) =>
				error instanceof ParallelsHostReadinessError &&
				error.code === "vm_host_inventory_permission_denied",
		);
		strictEqual(calls, 1);
	});

	it("uses its bounded read-only retry budget only for qualified transient codes", () => {
		let calls = 0;
		let now = 0;
		const waits = [];
		const statuses = [];
		const backend = new ParallelsExecutionBackend({
			hostReadinessAttempts: 2,
			hostReadinessBackoffMs: 10,
			hostReadinessJitterFn: () => 0.5,
			hostReadinessNowFn: () => now,
			sleepFn: (delayMs) => {
				waits.push(delayMs);
				now += delayMs;
			},
			prlctlFn: () => {
				calls += 1;
				throw new Error("PrlJob_GetRetCode: Invalid argument");
			},
		});

		throws(
			() =>
				backend.probeHostReadiness({
					onStatus: (event) => statuses.push(event),
				}),
			(error) =>
				error instanceof ParallelsHostReadinessError &&
				error.code === "vm_host_service_degraded",
		);
		strictEqual(calls, 2, "the readiness-specific budget bounds list retries");
		deepStrictEqual(waits, [15]);
		deepStrictEqual(
			statuses.map(({ event, elapsedMs, delayMs }) => ({
				event,
				elapsedMs,
				...(delayMs === undefined ? {} : { delayMs }),
			})),
			[
				{ event: "host_readiness_probe", elapsedMs: 0 },
				{ event: "host_readiness_wait", elapsedMs: 0, delayMs: 15 },
				{ event: "host_readiness_probe", elapsedMs: 15 },
			],
		);
	});

	it("does not retry an unknown service failure", () => {
		let calls = 0;
		const backend = new ParallelsExecutionBackend({
			hostReadinessAttempts: 2,
			prlctlFn: () => {
				calls += 1;
				throw new Error("synthetic unknown failure");
			},
		});
		throws(
			() => backend.probeHostReadiness(),
			(error) => error.code === "vm_host_service_degraded",
		);
		strictEqual(calls, 1);
	});

	it("shares one absolute timeout across retries", () => {
		let now = 100;
		const timeouts = [];
		const backend = new ParallelsExecutionBackend({
			hostReadinessAttempts: 2,
			hostReadinessBackoffMs: 25,
			hostReadinessTimeoutMs: 100,
			hostReadinessJitterFn: () => 0,
			hostReadinessNowFn: () => now,
			sleepFn: (delayMs) => {
				now += delayMs;
			},
			prlctlFn: (_args, options) => {
				timeouts.push(options.timeout);
				now += 20;
				throw new Error("Unable to open new session in this virtual machine");
			},
		});
		throws(() => backend.probeHostReadiness(), /service is degraded/);
		deepStrictEqual(timeouts, [100, 55]);
	});
});
