import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";

import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
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

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

describe("VM ownership metadata", () => {
	it("rejects partial or noncanonical durable ownership before destruction", () => {
		const name = buildParallelsWorkingName("partial-record", 5151);
		const context = ownedOptions("partial-record", 5151).ownershipContext;
		const writer = new ParallelsExecutionBackend({ prlctlFn: () => "" });
		writer.writeVmOwnership(WORK_UUID, name, context);
		const path = writer.vmOwnershipPath(WORK_UUID, context.resourceRoot);
		const partial = JSON.parse(readFileSync(path, "utf8"));
		delete partial.taskId;
		partial.resourceRoot = join(context.resourceRoot, "other");
		writeFileSync(path, `${JSON.stringify(partial)}\n`, "utf8");
		const calls = [];
		const fresh = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([{ uuid: WORK_UUID, status: "stopped", name }]);
				return "";
			},
		});
		throws(
			() => fresh.destroy({ uuid: WORK_UUID, name, runId: "partial-record" }),
			/recovery_evidence_missing/,
		);
		strictEqual(
			calls.filter((args) => ["stop", "delete"].includes(args[0])).length,
			0,
		);
	});

	it("raw linked measurement refuses before clone when ownership context is absent", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				return "";
			},
		});
		throws(
			() => backend.measureLinkedCloneLifecycle("macOS"),
			/ownership context/,
		);
		deepStrictEqual(calls, []);
	});

	it("records cleanup uncertainty when a raw measurement allocation has no UUID", () => {
		const runId = "measure-unknown";
		const options = ownedOptions(runId, 5151);
		const golden = "golden-measurement";
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				if (args[0] === "list")
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: golden },
					]);
				if (args[0] === "snapshot-list") return "{}";
				return "";
			},
		});
		throws(
			() => backend.measureLinkedCloneLifecycle(golden, options),
			(error) => error.cleanupUncertain === true,
		);
		const name = buildParallelsWorkingName(runId, 5151);
		const intent = JSON.parse(
			readFileSync(
				backend.allocationIntentPath(
					name,
					options.ownershipContext.resourceRoot,
				),
				"utf8",
			),
		);
		strictEqual(intent.state, "cleanup_uncertain");
		strictEqual(intent.reasonCode, "allocation_identity_unknown");
	});

	it("records cleanup uncertainty when a known raw measurement clone cannot be rolled back", () => {
		const runId = "measure-cleanup-failed";
		const options = ownedOptions(runId, 5151);
		const golden = "golden-measurement";
		const probeName = buildParallelsWorkingName(runId, 5151);
		let cloned = false;
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				if (args[0] === "clone") {
					cloned = true;
					return "";
				}
				if (args[0] === "snapshot-list") return "{}";
				if (args[0] === "list" && args[1] === "-i") return "size=1 B";
				if (args[0] === "list")
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: golden },
						...(cloned
							? [{ uuid: WORK_UUID, status: "running", name: probeName }]
							: []),
					]);
				if (args[0] === "stop") throw new Error("rollback failed");
				return "";
			},
		});
		backend.boot = () => {
			throw new Error("measurement boot failed");
		};
		let failure;
		try {
			backend.measureLinkedCloneLifecycle(golden, options);
		} catch (error) {
			failure = error;
		}
		strictEqual(failure?.message, "measurement boot failed");
		strictEqual(failure?.cleanupUncertain, true);
		ok(failure?.rollbackError instanceof Error);
		const intent = JSON.parse(
			readFileSync(
				backend.allocationIntentPath(
					probeName,
					options.ownershipContext.resourceRoot,
				),
				"utf8",
			),
		);
		strictEqual(intent.state, "cleanup_uncertain");
		strictEqual(intent.reasonCode, "known_allocation_cleanup_failed");
	});
});
