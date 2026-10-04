import { ok, strictEqual } from "node:assert/strict";

import { spawnSync } from "node:child_process";

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, it } from "node:test";

import {
	BULK_TRANSFER_HELPER,
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

describe("bulk-transfer helper misfire tolerance", () => {
	const MISFIRE_LINE =
		"PrlJob_GetRetCode: Invalid argument. An invalid argument was passed.";

	function stubPrlctl(root) {
		const binDir = join(root, "bin");
		const counterPath = join(root, "invocations");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(counterPath, "0");
		writeFileSync(
			join(binDir, "prlctl"),
			[
				"#!/bin/sh",
				'n=$(cat "$STUB_COUNTER")',
				"n=$((n+1))",
				'printf %s "$n" > "$STUB_COUNTER"',
				'if [ "$n" -le "$STUB_FAIL_UNTIL" ]; then',
				`  echo "${MISFIRE_LINE}" >&2`,
				"  exit 255",
				"fi",
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		return {
			binDir,
			counterPath,
			invocations: () => Number(readFileSync(counterPath, "utf8")),
		};
	}

	function runHelper({ failUntil, retryAttempts }) {
		const root = tempDir("switchyard-bulk-helper-");
		try {
			const stub = stubPrlctl(root);
			const payload = Buffer.from("payload-bytes");
			const config = {
				direction: "push",
				transferHost: "127.0.0.1",
				listenHost: "127.0.0.1",
				maxBytes: 1024 * 1024,
				misfireSource: "PrlJob_(?:GetRetCode|GetResult):\\s*Invalid argument",
				retryAttempts,
				retryBackoffMs: 1,
				guestArgs: ["exec", "vm-1", "/usr/bin/curl", "TRANSFER_URL"],
				pfArgs: ["exec", "vm-1", "/sbin/pfctl", "-a", "anchor", "-f", "-"],
				cleanupArgs: [
					"exec",
					"vm-1",
					"/sbin/pfctl",
					"-a",
					"anchor",
					"-F",
					"all",
				],
			};
			const result = spawnSync(
				process.execPath,
				["--input-type=module", "-e", BULK_TRANSFER_HELPER],
				{
					input: Buffer.concat([
						Buffer.from(`${JSON.stringify(config)}\n`, "utf8"),
						payload,
					]),
					encoding: null,
					env: {
						...process.env,
						PATH: `${stub.binDir}:${process.env.PATH}`,
						STUB_COUNTER: stub.counterPath,
						STUB_FAIL_UNTIL: String(failUntil),
					},
				},
			);
			return {
				status: result.status,
				stdout: (result.stdout ?? Buffer.alloc(0)).toString("utf8"),
				stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
				invocations: stub.invocations(),
				payloadBytes: payload.length,
			};
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("absorbs a misfire and completes the transfer", () => {
		// Two misfires, then the pf load lands on the third try; the guest call
		// and the anchor flush then succeed. Five invocations for three commands
		// is the retry doing its job.
		const run = runHelper({ failUntil: 2, retryAttempts: 4 });

		strictEqual(run.status, 0, run.stderr);
		strictEqual(run.invocations, 5);
		const receipt = JSON.parse(run.stdout.split("\n")[0]);
		strictEqual(receipt.bytes, run.payloadBytes);
	});

	it("stops at the configured attempt bound and reports what it tried", () => {
		// A misfire that never clears is a real failure, and the run record has
		// to be able to say so rather than retry forever.
		const run = runHelper({ failUntil: 99, retryAttempts: 3 });

		strictEqual(run.status, 1);
		ok(
			/bulk transfer failed after 3 attempt\(s\)/.test(run.stderr),
			`attempt count was not reported: ${run.stderr}`,
		);
		ok(/PrlJob_GetRetCode/.test(run.stderr), run.stderr);
		// Three pf attempts plus the best-effort cleanup, which is not retried.
		strictEqual(run.invocations, 4);
	});

	it("does not retry a failure that is not a misfire", () => {
		const run = runHelper({ failUntil: 0, retryAttempts: 4 });
		strictEqual(run.status, 0, run.stderr);
		strictEqual(run.invocations, 3);
	});
});
