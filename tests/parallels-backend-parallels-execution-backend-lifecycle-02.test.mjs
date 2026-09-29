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
	it("fails closed for stale, malformed, oversized, or mismatched terminal evidence", () => {
		const context = markerContext("provider");
		const token = "11111111-1111-4111-8111-111111111111";
		let response = JSON.stringify({
			schemaVersion: 1,
			kind: "switchyard_provider_terminal",
			token,
			status: "stopped",
			exitCode: 17,
		});
		const calls = [];
		const backend = workspaceBackend((args) => {
			calls.push(args);
			return response;
		});
		strictEqual(
			backend.readProviderTerminalEvidence(WORK_UUID, context, { token })
				.status,
			"confirmed",
		);
		response = JSON.stringify({
			schemaVersion: 1,
			kind: "switchyard_provider_terminal",
			token: "22222222-2222-4222-8222-222222222222",
			status: "stopped",
			exitCode: 17,
		});
		strictEqual(
			backend.readProviderTerminalEvidence(WORK_UUID, context, { token })
				.reason,
			"evidence_mismatched",
		);
		strictEqual(
			backend.readProviderTerminalEvidence(WORK_UUID, context, {
				token: "333333333333333333333333333333333333",
			}).reason,
			"evidence_identity_unavailable",
		);
		response = "{";
		strictEqual(
			backend.readProviderTerminalEvidence(WORK_UUID, context, { token })
				.reason,
			"evidence_malformed",
		);
		response = "x".repeat(1025);
		strictEqual(
			backend.readProviderTerminalEvidence(WORK_UUID, context, { token })
				.reason,
			"evidence_oversized",
		);
		strictEqual(
			backend.readProviderTerminalEvidence(
				WORK_UUID,
				{
					...context,
					operation: "helper",
				},
				{ token },
			).reason,
			"evidence_identity_unavailable",
		);
		strictEqual(
			backend.readProviderTerminalEvidence(
				"{33333333-3333-4333-8333-333333333333}",
				context,
				{ token },
			).reason,
			"evidence_identity_unavailable",
		);
		strictEqual(
			calls.length,
			4,
			"identity validation must avoid an unsafe guest read",
		);
	});

	it("reports terminal evidence cleanup removal or uncertainty", () => {
		const context = markerContext("provider");
		const calls = [];
		const statuses = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			onStatus: (status) => statuses.push(status),
		});
		backend.execGuest = (...args) => {
			calls.push(args);
			return "";
		};
		deepStrictEqual(backend.clearProviderTerminalEvidence(WORK_UUID, context), {
			status: "removed",
		});
		strictEqual(calls.length, 1);
		strictEqual(statuses.at(-1)?.event, "provider_terminal_evidence_removed");
		backend.execGuest = () => {
			throw new Error("transport unavailable");
		};
		deepStrictEqual(backend.clearProviderTerminalEvidence(WORK_UUID, context), {
			status: "uncertain",
			reason: "evidence_cleanup_uncertain",
		});
		deepStrictEqual(
			backend.clearProviderTerminalEvidence(WORK_UUID, {
				...context,
				operation: "helper",
			}),
			{
				status: "uncertain",
				reason: "evidence_cleanup_uncertain",
			},
		);
	});

	it("separates helper markers and refuses signaling without guest birth proof", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		backend.execGuest = (...args) => calls.push(args);
		const provider = markerContext("provider");
		const helper = markerContext("helper");
		notStrictEqual(
			backend.providerPidPath(WORK_UUID, provider),
			backend.providerPidPath(WORK_UUID, helper),
		);
		notStrictEqual(
			backend.providerPidPath(WORK_UUID, provider),
			backend.providerPidPath(WORK_UUID, {
				...provider,
				attemptId: "attempt-2",
			}),
		);
		throws(
			() =>
				backend.cleanupProviderProcess("prlctl", ["exec", WORK_UUID], provider),
			/process-start identity is unknown/,
		);
		deepStrictEqual(
			calls,
			[],
			"unknown guest birth identity must produce no probe or signal",
		);
	});

	it("emits completed VM cleanup stages and preserves the last stage on failure", () => {
		const events = [];
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		backend.getGuestPid = () => 4242;
		backend.execGuest = () => {};
		const cleaned = backend.cleanupProviderProcess(
			"prlctl",
			["exec", WORK_UUID],
			{ ...markerContext(), onStatus: (event) => events.push(event) },
		);
		strictEqual(cleaned.cleanupStage, "index_lock_removed");
		deepStrictEqual(
			events.map((event) => event.event),
			[
				"provider_cleanup_started",
				"provider_pid_observed",
				"provider_tree_gone",
				"provider_pid_marker_removed",
				"provider_index_lock_removed",
				"provider_cleanup_complete",
			],
		);

		backend.execGuest = (_workspaceId, command, args) => {
			if (
				command === "/bin/rm" &&
				args.includes(backend.providerPidPath(WORK_UUID, markerContext()))
			) {
				throw new Error("marker removal failed");
			}
		};
		throws(
			() =>
				backend.cleanupProviderProcess(
					"prlctl",
					["exec", WORK_UUID],
					markerContext(),
				),
			(error) => error.cleanupStage === "tree_terminated",
		);
	});

	it("carries the stage and exit status on provider_cleanup_failed (Task 6.3)", () => {
		// The recorded Antigravity failure emitted provider_cleanup_started and
		// provider_pid_observed, then provider_cleanup_failed with nothing but
		// a fixed status string. Two causes produce that ordering and need
		// different fixes — the guest kill script ran and found survivors, or
		// the guest exec never ran — so the event has to name which.
		const events = [];
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		backend.getGuestPid = () => 4242;
		backend.execGuest = () => {
			// What execFileSync throws when the kill script completes and its
			// closing `[ -z "$survivors" ]` fails.
			throw Object.assign(new Error("survivors after SIGKILL"), {
				status: 1,
				signal: null,
			});
		};
		throws(() =>
			backend.cleanupProviderProcess("prlctl", ["exec", WORK_UUID], {
				...markerContext(),
				onStatus: (event) => events.push(event),
			}),
		);
		const failure = events.find(
			(event) => event.event === "provider_cleanup_failed",
		);
		ok(failure, "provider_cleanup_failed must still be emitted");
		strictEqual(
			failure.cleanupStage,
			"pid_observed",
			"the last stage reached is the whole fault localization",
		);
		strictEqual(failure.exitCode, 1);
		ok(
			!("stderr" in failure) && !("output" in failure),
			"INV-2: no provider text may ride out on the cleanup event",
		);
	});

	it("round-trips a command vector through prlctl's join-and-reparse", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const argv = [
			"sh",
			"-c",
			"set -u\nprintf '%s\\n' \"$@\"\n",
			"sh",
			"a prompt with spaces",
			"it's got a single quote",
			"and\na newline",
			"$(touch /tmp/pwned)",
			"x".repeat(4096),
		];
		const { args } = backend.execArgv("{vm-uuid}", { argv });
		// Emulate the whole trip, not just the tail: prlctl joins *every*
		// argument into one string, so an unquoted newline anywhere terminates
		// the guest's command line and turns the remainder into separate
		// commands. Parsing only one slice would not observe that.
		const envelope = execFileSync(
			"/bin/sh",
			["-c", `printf '%s\\0' ${args.join(" ")}`],
			{ encoding: "utf8", maxBuffer: 1024 * 1024 },
		)
			.split("\0")
			.slice(0, -1);
		// One command, one word per transport argument.
		strictEqual(envelope.length, args.length);
		// The provider account's environment is established as argv, before bash
		// starts, so `-l` reads the right profile and providers do not fall back
		// to a read-only `/` for their caches.
		deepStrictEqual(envelope.slice(0, 13), [
			"exec",
			"{vm-uuid}",
			"--use-advanced-terminal",
			"launchctl",
			"asuser",
			"501",
			"sudo",
			"-u",
			"switchyard",
			"/usr/bin/env",
			"HOME=/Users/switchyard",
			"USER=switchyard",
			"LOGNAME=switchyard",
		]);
		// And the decoded payload parses to the command vector byte for byte.
		const script = decodeGuestScript(args);
		const launch = script.slice(
			script.indexOf(" && exec '") + " && exec ".length,
		);
		const recovered = execFileSync(
			"/bin/sh",
			["-c", `printf '%s\\0' ${launch}`],
			{ encoding: "utf8", maxBuffer: 1024 * 1024 },
		)
			.split("\0")
			.slice(0, -1);
		deepStrictEqual(recovered, argv);
	});

	it("keeps every transport byte inside ASCII", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const argv = [
			"opencode",
			"run",
			"Rewrite café — 日本 🙂 and don't drop the ’curly’ quotes",
		];
		const { args } = backend.execArgv("{vm-uuid}", { argv });
		for (const entry of args) {
			// One UTF-8 byte per code unit is true only when every byte is ASCII.
			ok(
				Buffer.byteLength(entry, "utf8") === entry.length,
				`non-ASCII byte reached prlctl argv: ${JSON.stringify(entry)}`,
			);
		}
		ok(decodeGuestScript(args).endsWith(`'${argv[2].replace(/'/g, "'\\''")}'`));
	});

	it("refuses a transport with no command vector", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		throws(() => backend.execArgv("{vm-uuid}", {}), /non-empty argv/);
		throws(() => backend.execArgv("{vm-uuid}", { argv: [] }), /non-empty argv/);
		throws(
			() => backend.execArgv("{vm-uuid}", { argv: ["ok", 7] }),
			/must be strings/,
		);
	});
});
