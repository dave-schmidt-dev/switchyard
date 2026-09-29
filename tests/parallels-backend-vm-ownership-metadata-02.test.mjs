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
