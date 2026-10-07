import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert/strict";

import { execFileSync } from "node:child_process";

import { describe, it } from "node:test";

import { ParallelsExecutionBackend as RealParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

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

	it("removes the stale Git index lock without guest PID authority", () => {
		const calls = [];
		const events = [];
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
		deepStrictEqual(
			backend.cleanupProviderProcess("prlctl", ["exec", WORK_UUID], {
				...provider,
				onStatus: (event) => events.push(event),
			}),
			{ cleanupStage: "index_lock_removed", workspaceId: WORK_UUID },
		);
		deepStrictEqual(
			calls,
			[
				[
					WORK_UUID,
					"/bin/rm",
					["-f", "--", "/project/.git/index.lock"],
					{ cwd: "/" },
				],
			],
			"cleanup must make exactly one PID-independent lock removal",
		);
		deepStrictEqual(
			events.map((event) => event.event),
			[
				"provider_cleanup_started",
				"provider_index_lock_removed",
				"provider_cleanup_complete",
			],
		);
	});

	it("annotates a lock-removal failure with the reached cleanup stage", () => {
		const events = [];
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		backend.execGuest = () => {
			// What execFileSync throws when the guest rm ran and exited
			// non-zero, as opposed to a transport failure with no status.
			throw Object.assign(new Error("index lock removal failed"), {
				status: 1,
				signal: null,
			});
		};
		throws(
			() =>
				backend.cleanupProviderProcess("prlctl", ["exec", WORK_UUID], {
					...markerContext(),
					onStatus: (event) => events.push(event),
				}),
			(error) => error.cleanupStage === "cleanup_started",
		);
		const failure = events.find(
			(event) => event.event === "provider_cleanup_failed",
		);
		ok(failure, "provider_cleanup_failed must still be emitted");
		strictEqual(
			failure.cleanupStage,
			"cleanup_started",
			"the last stage reached is the whole fault localization",
		);
		strictEqual(failure.exitCode, 1);
		ok(
			!("stderr" in failure) && !("output" in failure),
			"INV-2: no provider text may ride out on the cleanup event",
		);
	});

	it("makes no guest exec when a timeout or cancel defers to the VM destroy", () => {
		const calls = [];
		const events = [];
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		backend.execGuest = (...args) => calls.push(args);
		for (const reason of ["timeout", "cancel"]) {
			events.length = 0;
			deepStrictEqual(
				backend.cleanupProviderProcess("prlctl", ["exec", WORK_UUID], {
					...markerContext(),
					reason,
					onStatus: (event) => events.push(event),
				}),
				{ cleanupStage: "destroy_pending", workspaceId: WORK_UUID },
			);
			deepStrictEqual(
				events.map((event) => event.event),
				["provider_cleanup_started", "provider_cleanup_complete"],
			);
		}
		deepStrictEqual(
			calls,
			[],
			"a surviving provider may still hold the lock, so no guest exec may be made",
		);
	});

	it("returns null for a command outside the VM execution lane", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		backend.execGuest = () => {
			throw new Error("no guest exec may be made");
		};
		strictEqual(
			backend.cleanupProviderProcess(
				"docker",
				["exec", WORK_UUID],
				markerContext(),
			),
			null,
		);
	});

	it("clears the lock through the production exec route with no override", () => {
		const calls = [];
		const backend = workspaceBackend((args) => {
			calls.push(args);
			return "ok";
		});
		deepStrictEqual(
			backend.cleanupProviderProcess(
				"prlctl",
				["exec", WORK_UUID],
				markerContext(),
			),
			{ cleanupStage: "index_lock_removed", workspaceId: WORK_UUID },
		);
		strictEqual(
			calls.length,
			1,
			"exactly one prlctl exec may reach the transport",
		);
		const script = decodeGuestScript(calls[0]);
		ok(
			script.includes("/bin/rm") && script.includes("/project/.git/index.lock"),
			"the one guest exec must be the PID-independent index lock removal",
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
