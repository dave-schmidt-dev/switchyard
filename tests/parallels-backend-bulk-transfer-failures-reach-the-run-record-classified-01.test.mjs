import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";

import { join } from "node:path";

import { describe, it } from "node:test";

import { prlctlFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";

import {
	describeBulkTransferFailure,
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

describe("bulk-transfer failures reach the run record classified", () => {
	it("reads the misfire, the attempt count and prlctl's own exit code", () => {
		const error = describeBulkTransferFailure(
			"bulk transfer failed after 4 attempt(s): prlctl failed (255): " +
				"PrlJob_GetRetCode: Invalid argument. An invalid argument was passed.",
		);

		deepStrictEqual(prlctlFailureMetadata(error), {
			diagnosticCode: "prlctl_job_misfire",
			exitCode: 255,
		});
		strictEqual(error.attempts, 4);
	});

	it("classifies an ordinary transfer failure without inventing metadata", () => {
		// The helper's process exit status is 1 for every failure and is not
		// prlctl's, so nothing may be recorded as an exit code here.
		const error = describeBulkTransferFailure(
			"bulk transfer failed after 1 attempt(s): guest did not upload a tar",
		);

		deepStrictEqual(prlctlFailureMetadata(error), {
			diagnosticCode: "prlctl_call_failed",
		});
		ok(/guest did not upload a tar/.test(error.message), error.message);
	});

	it("still produces a closed code when the helper said nothing", () => {
		const error = describeBulkTransferFailure("");
		strictEqual(error.diagnosticCode, "prlctl_call_failed");
		strictEqual(error.attempts, 1);
		ok(/Parallels bulk transfer failed/.test(error.message), error.message);
	});

	it("reaches prlctl_call_timed_out from the spawn error when the helper never wrote to stderr", () => {
		// A spawnSync-level failure -- killed on a timeout, or its output blew
		// past maxBuffer on a large tar -- never produces the helper's own
		// stderr line, so `spawnError` is the only cause there is. Without
		// forwarding it, this can only ever fall through to the generic
		// prlctl_call_failed code, which is the defect this parameter exists
		// to remove.
		const spawnError = new Error("spawnSync helper ETIMEDOUT");
		spawnError.code = "ETIMEDOUT";
		spawnError.killed = true;

		const error = describeBulkTransferFailure("", spawnError);

		strictEqual(error.diagnosticCode, "prlctl_call_timed_out");
		deepStrictEqual(prlctlFailureMetadata(error), {
			diagnosticCode: "prlctl_call_timed_out",
		});
		strictEqual(error.attempts, 1);
		ok(/ETIMEDOUT/.test(error.message), error.message);
	});

	it("still reports the kill even when the helper also wrote its own stderr line", () => {
		// classifyPrlctlFailure checks spawnError.killed/code unconditionally,
		// after the text-based regexes fail to match -- it is not gated on
		// whether stderr was empty. So a helper that logged a specific reason
		// and was then killed still classifies as timed_out, not as the text's
		// own (weaker) reason; only the message's wording prefers the helper's
		// own words over the spawn error's.
		const spawnError = new Error("spawnSync helper ETIMEDOUT");
		spawnError.code = "ETIMEDOUT";
		spawnError.killed = true;

		const error = describeBulkTransferFailure(
			"bulk transfer failed after 2 attempt(s): guest did not upload a tar",
			spawnError,
		);

		strictEqual(error.diagnosticCode, "prlctl_call_timed_out");
		strictEqual(error.attempts, 2);
		ok(/guest did not upload a tar/.test(error.message), error.message);
	});
});
