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

describe("Parallels execution backend lifecycle", () => {
	it("rolls back a clone when Aqua readiness never appears", () => {
		const calls = [];
		let now = 0;
		let deleted = false;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			aquaTimeoutMs: 10,
			aquaPollMs: 5,
			nowFn: () => now,
			sleepFn: (ms) => {
				now += ms;
			},
			measureLinkedCloneFn: () => ({ diskBytes: 1, cloneToBootMs: 1 }),
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
						...(deleted
							? []
							: [
									{
										uuid: WORK_UUID,
										status: "stopped",
										name: buildParallelsWorkingName("run", 1234),
									},
								]),
					]);
				}
				if (args[0] === "delete") deleted = true;
				if (args[0] === "exec") throw new Error("Aqua is not ready");
				return "ok";
			},
		});

		const measurementOptions = ownedOptions("run", 1234);
		const measurement = backend.measureLinkedClone("macOS", measurementOptions);
		throws(
			() =>
				backend.create("macOS", {
					...measurementOptions,
					runId: "run",
					creatorPid: 1234,
					linkedCloneMeasurement: measurement,
				}),
			/Aqua domain gui\/501 was not ready/,
		);
	});

	it("enforces prompt-size guard before macOS-lane spawn and rejects oversized payloads", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				return "ok";
			},
		});

		// (a) a normal-size command passes through unchanged
		const normalArgv = ["echo", "hello world"];
		const normalResult = backend.execGuest("{vm-uuid}", "/bin/echo", [
			"hello world",
		]);
		strictEqual(normalResult, "ok");
		strictEqual(calls.length, 1);
		const { args } = backend.execArgv("{vm-uuid}", { argv: normalArgv });
		ok(Array.isArray(args));
		const normalScript = decodeGuestScript(args);
		ok(normalScript.includes("exec 'echo' 'hello world'"));

		// (b) a synthetic oversized argv throws the named error instead of reaching prlctlFn/execFn
		const oversizedPayload = "x".repeat(MAX_AQUA_EXEC_ARGV_BYTES);
		const oversizedArgv = ["echo", oversizedPayload];
		throws(
			() => backend.execGuest("{vm-uuid}", "echo", [oversizedPayload]),
			(error) => {
				strictEqual(error instanceof Error, true);
				return (
					error.message.includes(
						"guest command exceeds the macOS ARG_MAX-safe limit",
					) &&
					error.message.includes(`> ${MAX_AQUA_EXEC_ARGV_BYTES} bytes`) &&
					error.message.includes(
						"this VM lane cannot execute a payload this large",
					)
				);
			},
		);
		// prlctlFn must never have been called for the oversized command
		strictEqual(calls.length, 1);

		throws(
			() => backend.execArgv("{vm-uuid}", { argv: oversizedArgv }),
			(error) => {
				strictEqual(error instanceof Error, true);
				return (
					error.message.includes(
						"guest command exceeds the macOS ARG_MAX-safe limit",
					) &&
					error.message.includes(`> ${MAX_AQUA_EXEC_ARGV_BYTES} bytes`) &&
					error.message.includes(
						"this VM lane cannot execute a payload this large",
					)
				);
			},
		);

		// Also verify with execFn constructor parameter
		let execFnCalled = false;
		const backendWithExecFn = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => {
				execFnCalled = true;
				return "ok";
			},
		});
		throws(
			() =>
				backendWithExecFn.execGuest("{vm-uuid}", "echo", [oversizedPayload]),
			/guest command exceeds the macOS ARG_MAX-safe limit/,
		);
		strictEqual(execFnCalled, false);
	});
});
