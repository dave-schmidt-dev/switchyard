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
	it("uses one delete settle budget across failed-delete retry and final absence", () => {
		const calls = [];
		let now = 0;
		let deleteAttempts = 0;
		let finalPolls = 0;
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 10,
			stopSettlePollMs: 4,
			nowFn: () => now,
			deleteSettlementNowFn: () => now,
			sleepFn: (milliseconds) => {
				now += milliseconds;
			},
			prlctlFn: (args, options) => {
				calls.push({ args, options });
				if (args[0] === "delete" && deleteAttempts++ === 0)
					throw new Error("delete returned 255");
				if (args[0] === "list") {
					finalPolls += 1;
					return finalPolls < 3
						? listed([
								{
									uuid: WORK_UUID,
									status: "stopped",
									name: buildParallelsWorkingName("budgeted", process.pid),
								},
							])
						: listed([]);
				}
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete(
				{
					uuid: WORK_UUID,
					name: buildParallelsWorkingName("budgeted", process.pid),
					status: "stopped",
				},
				{ forceOnly: true },
			),
			{
				uuid: WORK_UUID,
				name: buildParallelsWorkingName("budgeted", process.pid),
				forced: true,
			},
		);
		deepStrictEqual(
			calls
				.filter(({ args }) => args[0] === "list")
				.map(({ options }) => options.timeout),
			[300_000, 10, 10],
		);
		strictEqual(now, 0);
	});

	it("allows one immediate deletion observation for a zero settle timeout", () => {
		const calls = [];
		let listCalls = 0;
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			sleepFn: () => {
				throw new Error("zero-budget deletion must not sleep");
			},
			prlctlFn: (args, options) => {
				calls.push({ args, options });
				if (args[0] === "list") {
					listCalls += 1;
					return listed([
						{ uuid: WORK_UUID, status: "stopped", name: "zero-budget" },
					]);
				}
				return "";
			},
		});

		throws(
			() =>
				backend.stopAndDelete(
					{ uuid: WORK_UUID, name: "zero-budget", status: "stopped" },
					{ forceOnly: true },
				),
			/remained present after delete/,
		);
		strictEqual(listCalls, 1);
		strictEqual(calls.at(-1).options.timeout, 1);
	});

	it("rejects absence returned after a positive deletion budget expires", () => {
		let now = 0;
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 10,
			deleteSettlementNowFn: () => now,
			prlctlFn: (args, options) => {
				calls.push({ args, options });
				if (args[0] === "list") {
					now = 10;
					return listed([]);
				}
				return "";
			},
		});

		throws(
			() =>
				backend.stopAndDelete(
					{ uuid: WORK_UUID, name: "expired-absence", status: "stopped" },
					{ forceOnly: true },
				),
			/could not verify absence/,
		);
		strictEqual(calls.filter(({ args }) => args[0] === "list").length, 1);
		strictEqual(calls.at(-1).options.timeout, 10);
	});

	it("uses the bulk transfer hook without sending tar bytes to prlctl", () => {
		const transfers = [];
		const prlctlCalls = [];
		const backend = new ParallelsExecutionBackend({
			transferHost: "10.211.55.2",
			bulkTransferFn: (descriptor) => {
				transfers.push(descriptor);
				return descriptor.direction === "pull"
					? Buffer.from("pulled-tar")
					: { audited: true };
			},
			prlctlFn: (args) => prlctlCalls.push(args),
		});
		strictEqual(backend.transferListenHost, "10.211.55.2");
		const pushed = Buffer.from("large-enough-for-the-hook");
		const receipt = backend.pushTar("{vm-uuid}", pushed, "/project");
		const pulled = backend.pullTar("{vm-uuid}", "/project/archive.tar");
		deepStrictEqual(receipt, {
			bytes: pushed.length,
			sha256: receipt.sha256,
			audited: true,
		});
		deepStrictEqual(pulled, Buffer.from("pulled-tar"));
		strictEqual(transfers.length, 2);
		deepStrictEqual(transfers[0].tar, pushed);
		ok(transfers[0].guestArgs.some((value) => value.includes("TRANSFER_URL")));
		ok(!transfers[0].pfArgs.some((value) => value.includes(pushed.toString())));
		deepStrictEqual(prlctlCalls.at(-1), [
			"exec",
			"{vm-uuid}",
			"/usr/sbin/chown",
			"-R",
			"switchyard",
			"/Users/switchyard/.switchyard/project",
		]);
	});

	it("writes each measured credential file to its own home-relative path", () => {
		const prlctlCalls = [];
		const pushes = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 503,
			providerUser: "switchyard",
			bulkTransferFn: (descriptor) => {
				pushes.push(descriptor);
				return { audited: true };
			},
			prlctlFn: (args) => prlctlCalls.push(args),
		});
		const receipt = backend.provisionCredentials("{vm-uuid}", {
			provider: "claude",
			credentials: [
				{ file: ".claude/.credentials.json", tar: Buffer.from("cred-a") },
				{ file: ".claude.json", tar: Buffer.from("cred-b") },
			],
			aquaUid: 503,
		});
		deepStrictEqual(
			receipt.files.map((entry) => entry.path),
			[
				"/Users/switchyard/.claude/.credentials.json",
				"/Users/switchyard/.claude.json",
			],
		);
		strictEqual(pushes.length, 2);
		// Every hop runs through the Aqua session, because that is the identity
		// whose Keychain and home the provider actually reads at exec time.
		for (const push of pushes) {
			ok(push.guestArgs.includes("asuser"));
			ok(push.guestArgs.includes("503"));
		}
		ok(
			decodeGuestScript(pushes[0].guestArgs).includes(
				"/Users/switchyard/.claude",
			),
		);
		const chowns = prlctlCalls.filter((args) =>
			args.includes("/usr/sbin/chown"),
		);
		// Named targets, never `-R`: the second file lives at the root of the
		// provider's home, so a recursive chown there would sweep the seeded
		// workspace and everything else the account owns.
		strictEqual(chowns.length, 2);
		for (const chown of chowns) ok(!chown.includes("-R"));
		deepStrictEqual(chowns[1].at(-1), "/Users/switchyard/.claude.json");
		const chmods = prlctlCalls
			.map((args) => (args.at(-2) === "-lc" ? decodeGuestScript(args) : ""))
			.filter((script) => script.includes("'/bin/chmod'"));
		strictEqual(chmods.length, 2);
		for (const chmod of chmods) ok(chmod.includes("'600'"));
	});

	it("refuses a partial or unexpected credential set", () => {
		const backend = new ParallelsExecutionBackend({
			aquaUid: 503,
			bulkTransferFn: () => ({ audited: true }),
			prlctlFn: () => "",
		});
		// Measured in the guest: claude reports `"loggedIn": false` with either
		// file alone, so a half-provisioned home looks provisioned and is not.
		throws(
			() =>
				backend.provisionCredentials("{vm-uuid}", {
					provider: "claude",
					credentials: [{ file: ".claude.json", tar: Buffer.from("cred") }],
				}),
			/missing credential file for claude: \.claude\/\.credentials\.json/,
		);
		throws(
			() =>
				backend.provisionCredentials("{vm-uuid}", {
					provider: "codex",
					credentials: [{ file: "../../etc/passwd", tar: Buffer.from("cred") }],
				}),
			/unexpected credential file for codex/,
		);
		throws(
			() =>
				backend.provisionCredentials("{vm-uuid}", {
					provider: "cursor-agent",
					credentials: [
						{ file: ".cursor/cli-config.json", tar: Buffer.from("cred") },
					],
				}),
			/not tar-provisionable/,
		);
	});

	it("seeds a backend through pushTar and its execution seam", () => {
		const calls = [];
		const backend = {
			pushTar(workspaceId, tar, destination) {
				calls.push({ workspaceId, bytes: tar.length, destination });
				return { bytes: tar.length };
			},
			execArgv(workspaceId, options) {
				calls.push({ workspaceId, options });
				return { command: process.execPath, args: ["-e", ""] };
			},
		};
		const receipt = seedProjectWithBackend(backend, "vm-uuid", process.cwd());
		ok(receipt.bytes > 0);
		strictEqual(calls[0].destination, "/project");
		strictEqual(calls[1].options.cwd, "/project");
		// The baseline commit is handed to the backend as a command vector, not
		// appended to a prefix the backend never sees and so cannot quote.
		deepStrictEqual(calls[1].options.argv.slice(0, 2), ["/bin/bash", "-lc"]);
		ok(calls[1].options.argv[2].startsWith("git init -q"));
		ok(calls[1].options.argv[2].includes("commit --allow-empty -qm baseline"));
	});
});
