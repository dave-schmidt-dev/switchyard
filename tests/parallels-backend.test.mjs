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

describe("host creator birth probe", () => {
	it("uses the fixed isolated helper contract and preserves uint64 ticks", () => {
		let invocation;
		const ticks = "18446744073709551615";
		const result = probeHostProcessIdentity(4242, {
			spawnFn: (command, args, options) => {
				invocation = { command, args, options };
				return probeChild({
					version: "switchyard-host-process-v1",
					state: "present",
					pid: "4242",
					bootSessionUuid: TEST_BOOT_UUID,
					startTicks: ticks,
				});
			},
		});
		strictEqual(result.startTicks, ticks);
		strictEqual(
			result.identity,
			`switchyard-host-process-v1:${TEST_BOOT_UUID}:4242:${ticks}`,
		);
		strictEqual(invocation.command, "/usr/bin/python3");
		deepStrictEqual(invocation.args.slice(0, 3), ["-I", "-S", "-c"]);
		strictEqual(invocation.args.at(-1), "4242");
		match(invocation.args[3], /\/usr\/lib\/libproc\.dylib/);
		match(invocation.args[3], /\/usr\/lib\/libSystem\.B\.dylib/);
		match(invocation.args[3], /ctypes\.sizeof\(RusageInfoV0\) != 96/);
		strictEqual(invocation.options.timeout, 2_000);
		strictEqual(invocation.options.killSignal, "SIGKILL");
		strictEqual(invocation.options.maxBuffer, 4_096);
		deepStrictEqual(invocation.options.stdio, ["ignore", "pipe", "ignore"]);
		deepStrictEqual(invocation.options.env, {
			PATH: "/usr/bin:/bin",
			LANG: "C",
			LC_ALL: "C",
		});
	});

	it("accepts only exact ESRCH-shaped absence in the current boot", () => {
		const result = probeHostProcessIdentity(4242, {
			spawnFn: () =>
				probeChild({
					version: "switchyard-host-process-v1",
					state: "absent",
					pid: "4242",
					bootSessionUuid: TEST_BOOT_UUID,
					startTicks: null,
				}),
		});
		deepStrictEqual(result, {
			state: "absent",
			pid: 4242,
			bootSessionUuid: TEST_BOOT_UUID,
			identity: null,
		});
	});

	for (const [label, child] of [
		["timeout", { status: null, signal: "SIGKILL", stdout: "" }],
		["nonzero", { status: 73, signal: null, stdout: "" }],
		["oversized", { status: 0, signal: null, stdout: "x".repeat(4_097) }],
		["malformed", { status: 0, signal: null, stdout: "{" }],
		[
			"extra field",
			probeChild({
				version: "switchyard-host-process-v1",
				state: "present",
				pid: "4242",
				bootSessionUuid: TEST_BOOT_UUID,
				startTicks: "1",
				extra: true,
			}),
		],
		[
			"wrong pid",
			probeChild({
				version: "switchyard-host-process-v1",
				state: "present",
				pid: "7",
				bootSessionUuid: TEST_BOOT_UUID,
				startTicks: "1",
			}),
		],
		[
			"wrong version",
			probeChild({
				version: "switchyard-host-process-v2",
				state: "present",
				pid: "4242",
				bootSessionUuid: TEST_BOOT_UUID,
				startTicks: "1",
			}),
		],
		[
			"missing field",
			probeChild({
				version: "switchyard-host-process-v1",
				state: "present",
				pid: "4242",
				bootSessionUuid: TEST_BOOT_UUID,
			}),
		],
		[
			"zero start tick",
			probeChild({
				version: "switchyard-host-process-v1",
				state: "present",
				pid: "4242",
				bootSessionUuid: TEST_BOOT_UUID,
				startTicks: "0",
			}),
		],
		[
			"overflow",
			probeChild({
				version: "switchyard-host-process-v1",
				state: "present",
				pid: "4242",
				bootSessionUuid: TEST_BOOT_UUID,
				startTicks: "18446744073709551616",
			}),
		],
	]) {
		it(`fails closed on ${label}`, () => {
			deepStrictEqual(
				probeHostProcessIdentity(4242, { spawnFn: () => child }),
				{ state: "unknown" },
			);
		});
	}
});

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

// What the guest reports once `_prepareWorkspace` has done its job: one
// `<owner>:<mode>` line per directory, parent then root.
const WORKSPACE_READY = "switchyard:700\nswitchyard:700\n";
const WORKSPACE_UNAPPLIED = "switchyard:755\nswitchyard:755\n";

/**
 * The exact shape of the defect this suite locks out: prlctl fails on the
 * HOST while reading the guest's result, so it reports 255 for a command the
 * guest may well have run. Measured 2026-08-31 on `/bin/chmod 700`, one call
 * after `mkdir -p` and `chown` succeeded on those same paths.
 */
/**
 * A prlctl failure is now wrapped by `_call` in a `PrlctlCallError` that
 * carries the classification and the original as `cause`, so "this failure was
 * preserved, not masked by a later one" is an assertion about the cause chain
 * rather than about object identity.
 * @param {unknown} error
 * @param {unknown} original
 * @returns {boolean}
 */
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

/**
 * A backend wired for workspace-preparation units: no real sleeping, and a
 * prlctl stub that answers only what this stage asks.
 * @param {(args: string[]) => string} respond
 * @returns {ParallelsExecutionBackend}
 */
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

/**
 * Recover the script the guest will actually run. `prlctl exec` cannot carry a
 * byte above 0x7F, so the transport ships a base64 payload; a test that reads
 * the argv without decoding is asserting on the envelope, not the command.
 * @param {string[]} args prlctl argument vector
 * @returns {string}
 */
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
	it("refuses a wait interval that would hang a teardown instead of pacing it", () => {
		// Every one of these values ends up as an argument to `sleepFn`, whose
		// default is a blocking `Atomics.wait`. A NaN or a negative there is not a
		// mistuned poll, it is a teardown that never returns and emits nothing, so
		// the knob is refused where the caller can still see which one it named.
		for (const knob of [
			"aquaTimeoutMs",
			"clipboardSettleMs",
			"workspaceVerifyTimeoutMs",
			"stopSettleTimeoutMs",
			"prlctlRetryBackoffMs",
		]) {
			for (const value of [
				Number.NaN,
				-1,
				1.5,
				"1000",
				Number.POSITIVE_INFINITY,
			]) {
				throws(
					() => new ParallelsExecutionBackend({ aquaUid: 501, [knob]: value }),
					new RegExp(`^Error: ${knob} must be an integer of at least 0ms$`),
				);
			}
			// A zero budget is a real answer for a timeout: do not wait at all.
			ok(new ParallelsExecutionBackend({ aquaUid: 501, [knob]: 0 }));
		}
		throws(
			() => new ParallelsExecutionBackend({ deleteSettlementNowFn: null }),
			/deleteSettlementNowFn must be a function/,
		);
		for (const knob of [
			"aquaPollMs",
			"clipboardPollMs",
			"workspaceVerifyPollMs",
			"stopSettlePollMs",
		]) {
			// A zero poll is not "no wait", it is a busy loop against prlctl.
			for (const value of [Number.NaN, -1, 0]) {
				throws(
					() => new ParallelsExecutionBackend({ aquaUid: 501, [knob]: value }),
					new RegExp(`^Error: ${knob} must be an integer of at least 1ms$`),
				);
			}
			ok(new ParallelsExecutionBackend({ aquaUid: 501, [knob]: 1 }));
		}
	});

	it("builds an Aqua execution prefix with cwd and no Docker flags", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const execution = backend.execArgv("{vm-uuid}", {
			cwd: "/project/subdir",
			argv: ["true"],
		});
		strictEqual(execution.command, "prlctl");
		deepStrictEqual(execution.args.slice(0, 14), [
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
			"/bin/bash",
		]);
		strictEqual(execution.args[2], "--use-advanced-terminal");
		ok(!execution.args.includes("-i"));
		const script = decodeGuestScript(execution.args);
		ok(script.startsWith("cd '/Users/switchyard/.switchyard/project/subdir'"));
		ok(script.endsWith("&& exec 'true'"));
	});

	it("routes only approved API-key models through fixed BWS consumers", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 503 });
		const request = {
			model: "opencode-go/mimo-v2.5",
			invocationArgs: [],
			prompt: "synthetic prompt only",
			idleSeconds: 60,
		};
		const go = backend.ephemeralOpenCodeKeyExecution(WORK_UUID, request);
		strictEqual(
			go.command,
			"/Users/dave/Documents/Projects/bws/bws-secret-exec.py",
		);
		deepStrictEqual(go.args, ["switchyard-opencode-go-dispatch", "--"]);
		deepStrictEqual(JSON.parse(go.input), {
			...request,
			workspaceId: WORK_UUID.slice(1, -1),
		});
		deepStrictEqual(go.cleanupContext, { workspaceId: WORK_UUID });
		const mistral = backend.ephemeralOpenCodeKeyExecution(WORK_UUID, {
			...request,
			model: "mistral/mistral-medium-latest",
		});
		deepStrictEqual(mistral.args, [
			"switchyard-opencode-mistral-dispatch",
			"--",
		]);
		strictEqual(
			backend.ephemeralOpenCodeKeyExecution(WORK_UUID, {
				...request,
				model: "opencode-zen/gpt-5",
			}),
			null,
		);
		throws(
			() => backend.ephemeralOpenCodeKeyExecution("not-a-vm", request),
			/VM UUID/,
		);
	});

	it("records only opted-in provider commands and removes the marker on exit", () => {
		const backend = new ParallelsExecutionBackend({ aquaUid: 501 });
		const workspaceId = `marker-test-${randomUUID()}`;
		const cleanupContext = markerContext("provider", { workspaceId });
		const markerPath = backend.providerPidPath(workspaceId, cleanupContext);
		const controlScript = decodeGuestScript(
			backend.execArgv(workspaceId, { cwd: "/", argv: ["true"] }).args,
		);
		ok(!controlScript.includes(markerPath));

		const providerScript = decodeGuestScript(
			backend.execArgv(workspaceId, {
				cwd: "/",
				recordPid: true,
				cleanupContext,
				argv: [
					"/bin/bash",
					"-c",
					'for _ in {1..100}; do test -s "$1" && break; sleep 0.01; done; test "$(head -n 1 "$1")" = "$$" || exit 9; IFS= read -r value; printf "out:%s\\n" "$value"; printf "err:%s\\n" "$value" >&2; exit 7',
					"provider-test",
					markerPath,
				],
			}).args,
		);
		const result = spawnSync("/bin/bash", ["-c", providerScript], {
			input: "payload\n",
			encoding: "utf8",
		});
		strictEqual(result.status, 7);
		strictEqual(result.stdout, "out:payload\n");
		strictEqual(result.stderr, "err:payload\n");
		strictEqual(existsSync(markerPath), false);
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

	// `prlctl exec` joins its argument vector with spaces and the guest applies
	// exactly one round of shell parsing to the result. Proven live 2026-08-14:
	// a supervised `opencode run` was truncated to its first word, `set`, which
	// dumped the environment and exited 0 — a provider that never ran, reported
	// as a successful execution with an empty diff.
	//
	// So the property under test is not "the arguments are present" but "the
	// arguments survive the joining and re-parse byte for byte". Emulate that
	// trip locally: join the transport argv, hand it to a real `/bin/sh`, and
	// assert the command vector comes back out unchanged.
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

	// `prlctl exec` cannot carry a byte above 0x7F. Proven live 2026-08-14
	// against switchyard-debug-1: an em dash, a curly quote, an accented name,
	// CJK and an emoji each corrupted the command line the guest rebuilt, which
	// surfaced as `unexpected EOF while looking for matching '` rather than as
	// mangled text. One em dash in a comment inside the opencode supervisor was
	// enough to stop the provider from starting at all.
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

	it("quotes bash scripts before passing them through prlctl", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				return "";
			},
		});
		backend.execGuest("{vm-uuid}", "/bin/bash", [
			"-lc",
			"if test -e /tmp/x; then echo yes; fi",
		]);
		strictEqual(calls[0].at(-2), "-lc");
		strictEqual(
			decodeGuestScript(calls[0]),
			"cd '/Users/switchyard/.switchyard/project' && exec '/bin/bash' '-lc' " +
				"'if test -e /tmp/x; then echo yes; fi'",
		);
	});

	// The README's prlctl process-lifetime rule has two halves. The first is
	// "do not provoke it": prlctl 26.4.1 segfaults when a signal reaches it
	// after its parent has exited, jumping to address 0 through `_sigtramp`
	// while blocked in QWaitCondition::wait inside ParallelsVirtualizationSDK
	// (measured 2026-08-14 17:33:00, pid 10735). That half is a discipline, not
	// a mechanism. This is the second half, which is testable: when it does
	// happen, no path may book the crashed transport as success.
	it("never books a signal-killed prlctl as success", () => {
		const signalDeath = () => {
			// The shape execFileSync raises for a child killed by a signal.
			const error = new Error("Command failed: prlctl");
			error.status = null;
			error.signal = "SIGSEGV";
			throw error;
		};
		const calls = [];
		// `list` keeps working so the failure lands where it matters. A crash
		// that takes out handle resolution proves nothing about the paths that
		// catch and escalate.
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			// This VM never stops, so waiting out the settle window would only
			// add real seconds to the assertion being made about escalation.
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args[0]);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							// Destroy refuses a VM outside the reserved name, so an
							// unmanaged name would pass this test for the wrong reason.
							name: buildParallelsWorkingName("crashed-run", process.pid),
						},
					]);
				return signalDeath();
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("crashed-run", process.pid),
		});
		throws(
			() => backend.execGuest(WORK_UUID, "/bin/bash", ["-lc", "true"]),
			/Command failed: prlctl/,
			"a segfaulted prlctl exec returned instead of throwing",
		);
		// destroy escalates stop -> stop --kill -> delete. Every one of those
		// dies the same way here, so the escalation must run out and surface
		// rather than report a VM it never destroyed.
		throws(
			() => backend.destroy(WORK_UUID),
			/Command failed: prlctl/,
			"destroy reported success against a prlctl that never ran",
		);
		ok(
			calls.filter((verb) => verb === "stop").length >= 2,
			`destroy did not exhaust its escalation before failing: ${calls.join(",")}`,
		);
	});

	it("deletes after a failed stop only when an exact stopped state is reprobed", () => {
		const calls = [];
		let deleted = false;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop") {
					if (args[2] === "--kill") throw new Error("stop returned 255");
					throw new Error("stop returned 255");
				}
				if (args[0] === "list")
					return deleted
						? listed([])
						: listed([
								{
									uuid: WORK_UUID,
									status: "stopped",
									name: buildParallelsWorkingName("stopped", process.pid),
								},
							]);
				if (args[0] === "delete") {
					deleted = true;
					return "";
				}
				return "";
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("stopped", process.pid),
		});

		deepStrictEqual(backend.destroy(WORK_UUID), {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("stopped", process.pid),
			forced: true,
		});
		deepStrictEqual(
			calls.map((args) => args[0]),
			["list", "stop", "stop", "list", "delete", "list"],
		);
	});

	it("preserves a failed stop and never deletes while the exact VM is running", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("running", process.pid),
						},
					]);
				throw new Error(`${args[0]} returned 255`);
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("running", process.pid),
		});

		let failure;
		throws(
			() => backend.destroy(WORK_UUID),
			(error) => {
				failure = error;
				return /returned 255/.test(error.message);
			},
		);
		ok(!calls.some((args) => args[0] === "delete"));
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		strictEqual(calls.filter((args) => args[0] === "stop").length, 3);
		ok(failure?.cleanupUncertain);
	});

	it("gives every prlctl call a deadline, and lets an explicit one win", () => {
		// A `prlctl stop --kill` with no timeout hung for 3h32m on 2026-09-08,
		// taking a VM and a harness with it. The default is applied at the _call
		// chokepoint so it covers an injected client too, and any site that
		// already chose its own bound keeps it.
		const options = [];
		const backend = new ParallelsExecutionBackend({
			prlctlCallTimeoutMs: 4_000,
			prlctlFn: (args, opts) => {
				options.push([args[0], opts]);
				return "";
			},
		});

		backend.preflight();
		strictEqual(options[0][1].timeout, 4_000);
		strictEqual(options[0][1].killSignal, "SIGKILL");

		backend._call(["list", "-a"], { timeout: 250 });
		strictEqual(options[1][1].timeout, 250);
	});

	it("surfaces a timed-out prlctl call instead of retrying it as a misfire", () => {
		// A timeout is not a lost SDK job result: retrying it three more times
		// turns one stuck call into four, which is how a bounded call becomes an
		// unbounded one again.
		let attempts = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: () => {
				attempts += 1;
				const error = new Error("Command failed: prlctl list");
				error.code = "ETIMEDOUT";
				error.killed = true;
				throw error;
			},
		});

		throws(
			() => backend.preflight(),
			(error) => {
				strictEqual(error.diagnosticCode, "prlctl_call_timed_out");
				return true;
			},
		);
		strictEqual(attempts, 1);
	});

	it("refuses to report the golden stopped while it is observed running", () => {
		// `prlctl stop` has been seen exiting 0 with the VM still serving. The
		// whole purpose of stopGoldenImage is that the next boot or clone is not
		// blocked by the golden still running, so the postcondition is observed.
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			goldenImage: GOLDEN_UUID,
			// The golden waits its own, longer window; both are zeroed so the
			// test asserts the observation, not the wait.
			stopSettleTimeoutMs: 0,
			goldenStopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				// The whole argv, not args[0]: recording the verb alone made the
				// "never forced" assertion below vacuously true, since a graceful
				// stop and a `stop --kill` are both `stop`.
				calls.push(args.join(" "));
				if (args[0] === "list")
					return listed([
						{ uuid: GOLDEN_UUID, status: "running", name: "golden" },
					]);
				return "";
			},
		});

		throws(
			() => backend.stopGoldenImage(GOLDEN_UUID),
			/still running 0ms after prlctl stop exited 0/,
		);
		// Never forced, and never deleted: the golden is not disposable. The
		// exact sequence is the claim -- one graceful stop, one observation of
		// it, and nothing else.
		deepStrictEqual(calls, [
			// stopGoldenImage resolves the handle before it stops it.
			"list -a -o uuid,status,name",
			`stop ${GOLDEN_UUID}`,
			"list -a -o uuid,status,name",
		]);
	});

	it("observes a force-stop before deleting after a lying graceful stop", () => {
		// The inverse of prlctl_job_misfire: success reported for a mutation that
		// did not happen. Without the observation the false success fell straight
		// through to `delete` on a running VM.
		const calls = [];
		let stopped = false;
		let deleted = false;
		const lyingName = buildParallelsWorkingName("lying-stop", process.pid);
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args.slice(0, 3).join(" "));
				if (args[0] === "stop" && args[2] === "--kill") stopped = true;
				if (args[0] === "list")
					if (deleted) return listed([]);
					else
						return listed([
							{
								uuid: WORK_UUID,
								status: stopped ? "stopped" : "running",
								name: lyingName,
							},
						]);
				if (args[0] === "delete") deleted = true;
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: lyingName,
				status: "running",
			}),
			{ uuid: WORK_UUID, name: lyingName, forced: true },
		);
		// Ordering is the claim, not the mere presence of a kill: the escalation
		// has to follow the observation that the graceful stop did not take.
		deepStrictEqual(calls, [
			`stop ${WORK_UUID}`,
			"list -a -o",
			`stop ${WORK_UUID} --kill`,
			"list -a -o",
			`delete ${WORK_UUID}`,
			"list -a -o",
		]);
	});

	it("retries a false-success force-stop once before deleting", () => {
		const calls = [];
		let killAttempts = 0;
		let deleted = false;
		const sleeps = [];
		const entry = {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("force-retry", process.pid),
			status: "running",
		};
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			sleepFn: (milliseconds) => sleeps.push(milliseconds),
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop" && args[2] === "--kill") {
					killAttempts += 1;
					return "success reported";
				}
				if (args[0] === "list") {
					return deleted
						? listed([])
						: listed([
								{
									...entry,
									status: killAttempts >= 2 ? "stopped" : "running",
								},
							]);
				}
				if (args[0] === "delete") deleted = true;
				return "";
			},
		});

		deepStrictEqual(backend.stopAndDelete(entry, { forceOnly: true }), {
			uuid: WORK_UUID,
			name: entry.name,
			forced: true,
		});
		strictEqual(killAttempts, 2);
		deepStrictEqual(sleeps, [25]);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "stop", "list", "delete", "list"],
		);
	});

	it("fails closed after force-stop exhaustion without deleting", () => {
		const calls = [];
		const entry = {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("force-stuck", process.pid),
			status: "running",
		};
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([{ ...entry, status: "running" }]);
				return "";
			},
		});

		let failure;
		throws(
			() => backend.stopAndDelete(entry, { forceOnly: true }),
			(error) => {
				failure = error;
				return true;
			},
		);
		ok(failure.cleanupUncertain);
		strictEqual(calls.filter((args) => args[0] === "stop").length, 2);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "stop", "list"],
		);
	});

	it("does not retry a force-stop when inventory is ambiguous", () => {
		const calls = [];
		const entry = {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("force-malformed", process.pid),
			status: "running",
		};
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return "not-an-inventory";
				return "";
			},
		});

		let failure;
		throws(
			() => backend.stopAndDelete(entry, { forceOnly: true }),
			(error) => {
				failure = error;
				return true;
			},
		);
		ok(failure.cleanupUncertain);
		strictEqual(calls.filter((args) => args[0] === "stop").length, 1);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
	});

	it("reprobes after delete fallback before retrying deletion", () => {
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
										"delete-fallback",
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
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("delete-fallback", process.pid),
		});

		deepStrictEqual(backend.destroy(WORK_UUID), {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("delete-fallback", process.pid),
			forced: true,
		});
		deepStrictEqual(
			calls.map((args) => args[0]),
			[
				"list",
				"stop",
				"list",
				"delete",
				"stop",
				"list",
				"list",
				"delete",
				"list",
			],
		);
	});

	it("preserves delete failure when fallback stop does not leave the exact VM stopped", () => {
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
							name: buildParallelsWorkingName("delete-running", process.pid),
						},
					]);
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("delete-running", process.pid),
		});

		let failure;
		throws(
			() => backend.destroy(WORK_UUID),
			(error) => {
				failure = error;
				return /still running/.test(error.message);
			},
		);
		ok(failure.cleanupUncertain);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["list", "stop", "list", "stop", "list", "stop", "list"],
		);
	});

	it("does not reprobe stale graceful-stop failure when kill succeeds", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop" && args[2] !== "--kill")
					throw new Error("graceful stop returned 255");
				if (args[0] === "list") return listed([]);
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: "kill-success",
				status: "running",
			}),
			{ uuid: WORK_UUID, name: "kill-success", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "stop", "list", "delete", "list"],
		);
	});

	it("treats an absent exact VM after failed delete as already deleted", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "delete") throw new Error("delete returned 255");
				if (args[0] === "list") return listed([]);
				return "";
			},
		});

		deepStrictEqual(
			backend.stopAndDelete({
				uuid: WORK_UUID,
				name: "absent",
				status: "running",
			}),
			{ uuid: WORK_UUID, name: "absent", forced: true },
		);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "delete", "stop", "list", "list"],
		);
	});

	it("preserves delete failure when exact-state probing fails", () => {
		const calls = [];
		const deleteFailure = new Error("delete returned 255");
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") throw new Error("list unavailable");
				if (args[0] === "delete") throw deleteFailure;
				return "";
			},
		});

		let failure;
		throws(
			() =>
				backend.stopAndDelete({
					uuid: WORK_UUID,
					name: "probe-failure",
					status: "running",
				}),
			(error) => {
				failure = error;
				return /still running/.test(error.message);
			},
		);
		ok(failure.cleanupUncertain);
		deepStrictEqual(
			calls.map((args) => args[0]),
			["stop", "list", "stop", "list"],
		);
	});

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

	it("makes the baseline-commit script itself repeat-safe, not just its JS caller", () => {
		// execGuest retries a prlctl job misfire by default, and a misfire means
		// prlctl lost the RESULT of a command the guest may well have completed --
		// so this script has to survive running a second time. `git init` and
		// `git add` are no-ops on that second pass; an unguarded
		// `commit --allow-empty` is not, and stacks a second baseline.
		//
		// The literal script text is executed against a real repository rather
		// than asserted as a substring, because what is under test is shell
		// semantics: a guard that binds to the wrong side of the `&&` chain reads
		// perfectly and still commits twice. Both project shapes are covered --
		// an empty one is the case `--allow-empty` exists for, and a populated one
		// is the case that actually stages content.
		let script = null;
		seedProjectWithBackend(
			{
				pushTar: () => ({ bytes: 1 }),
				execArgv: (_workspaceId, options) => {
					script = options.argv[2];
					return { command: process.execPath, args: ["-e", ""] };
				},
			},
			"vm-uuid",
			process.cwd(),
		);
		ok(script, "the seed script must reach the execution seam");

		for (const populated of [false, true]) {
			const guestDir = tempDir("switchyard-seed-repeat-");
			try {
				if (populated) writeFileSync(join(guestDir, "README.txt"), "seeded\n");
				const log = () =>
					execFileSync("git", ["-C", guestDir, "log", "--oneline"], {
						encoding: "utf8",
					}).trim();

				execFileSync("/bin/bash", ["-lc", script], { cwd: guestDir });
				const first = log();
				strictEqual(
					first.split("\n").length,
					1,
					`the first run must create exactly one baseline commit (populated=${populated})`,
				);

				// The retried run: same script, same guest, HEAD already exists.
				execFileSync("/bin/bash", ["-lc", script], { cwd: guestDir });
				// Comparing the whole log, not just its length, also catches a
				// retry that replaced the baseline rather than appending to it.
				strictEqual(
					log(),
					first,
					`a retried run must not stack a second baseline commit or move HEAD (populated=${populated})`,
				);
			} finally {
				rmSync(guestDir, { recursive: true, force: true });
			}
		}
	});

	it("uses the reserved run-and-pid grammar and rejects malformed ownership", () => {
		const name = buildParallelsWorkingName("run-with-hyphens", 4321);
		strictEqual(name, `${PARALLELS_WORKING_PREFIX}run-with-hyphens-4321`);
		deepStrictEqual(parseParallelsWorkingName(name), {
			name,
			runId: "run-with-hyphens",
			creatorPid: 4321,
		});
		equal(parseParallelsWorkingName("switchyard-work-foreign"), null);
		equal(parseParallelsWorkingName("switchyard-work-run-0"), null);
		throws(
			() => buildParallelsWorkingName("unsafe/run", 4321),
			/safe identifier/,
		);
	});

	it("requires positive linked-clone measurements", () => {
		deepStrictEqual(
			validateLinkedCloneMeasurement({ diskBytes: 10, cloneToBootMs: 12 }),
			{ diskBytes: 10, cloneToBootMs: 12 },
		);
		throws(
			() => validateLinkedCloneMeasurement({ diskBytes: 0, cloneToBootMs: 12 }),
			/positive disk/,
		);
	});

	it("boots an unmanaged golden image only through the guarded golden path", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
					]);
				}
				return "ready";
			},
		});

		deepStrictEqual(backend.bootGoldenImage("macOS"), {
			uuid: GOLDEN_UUID,
			name: "macOS",
			status: "running",
		});
		ok(calls.some((args) => args[0] === "start" && args[1] === GOLDEN_UUID));
	});

	it("prepares the logical workspace for the non-admin provider", () => {
		const calls = [];
		let cloneName = null;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			goldenImage: "macOS",
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "clone") {
					cloneName = args[3];
					return "";
				}
				if (args[0] === "list" && args[1] === "-a") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
						...(cloneName
							? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
							: []),
					]);
				}
				// A guest with the clipboard agent already gone: launchctl cannot
				// print the label and pgrep matches nothing. `launchctl print
				// gui/501` (Aqua readiness) still succeeds — only the copypaste
				// label is absent.
				if (args.includes(CLIPBOARD_LABEL) || args.includes("/usr/bin/pgrep")) {
					throw new Error("could not find service");
				}
				if (args.includes("/usr/bin/stat")) return WORKSPACE_READY;
				return "ready";
			},
		});
		backend.create("macOS", {
			...ownedOptions("workspace-setup"),
			runId: "workspace-setup",
			creatorPid: process.pid,
			linked: false,
			providerUser: "switchyard",
			clipboardSettleMs: 0,
		});
		ok(
			calls.some(
				(args) =>
					args.includes("/bin/mkdir") &&
					args.some((value) => value.includes("/.switchyard/project")),
			),
		);
		ok(
			calls.some(
				(args) =>
					args.includes("/usr/sbin/chown") && args.includes("switchyard"),
			),
		);
		ok(
			calls.some((args) => args.includes("/bin/chmod") && args.includes("700")),
		);
	});

	it("classifies clone hardening and workspace preparation failures before rollback", () => {
		for (const testCase of [
			{
				stage: "_hardenClone",
				expectedCode: "clone_hardening_failed",
			},
			{
				stage: "_prepareWorkspace",
				expectedCode: "workspace_prepare_failed",
			},
		]) {
			let cloneName = null;
			let rollbackCount = 0;
			const backend = new ParallelsExecutionBackend({
				aquaUid: 501,
				prlctlFn: (args) => {
					if (args[0] === "clone") cloneName = args[3];
					if (args[0] === "list" && args[1] === "-a") {
						return listed([
							{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
							...(cloneName
								? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
								: []),
						]);
					}
					return "ready";
				},
			});
			backend.boot = () => {};
			backend._hardenClone = () => {};
			backend._prepareWorkspace = () => {};
			backend[testCase.stage] = () => {
				throw new Error("sensitive stage detail /host/path provider output");
			};
			backend.rollback = () => {
				rollbackCount += 1;
				return true;
			};

			throws(
				() =>
					backend.create("macOS", {
						...ownedOptions(`stage-${testCase.expectedCode}`),
						runId: `stage-${testCase.expectedCode}`,
						creatorPid: process.pid,
						linked: false,
					}),
				(error) =>
					workerBootStageDiagnosticCode(error) === testCase.expectedCode,
			);
			strictEqual(rollbackCount, 1, `${testCase.stage} failure must roll back`);
		}
	});

	it("never retries a misfired clone: the working name is deterministic and a retry would collide with itself", () => {
		let cloneCalls = 0;
		let rollbackCount = 0;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				if (args[0] === "clone") {
					cloneCalls += 1;
					throw lostExitCode();
				}
				return "";
			},
		});
		backend.rollback = () => {
			rollbackCount += 1;
			return true;
		};

		throws(
			() =>
				backend.create("macOS", {
					...ownedOptions("clone-misfire"),
					runId: "clone-misfire",
					creatorPid: process.pid,
					linked: false,
				}),
			(error) => {
				ok(error instanceof PrlctlCallError);
				strictEqual(error.diagnosticCode, "prlctl_job_misfire");
				strictEqual(error.cleanupUncertain, true);
				return true;
			},
		);
		strictEqual(
			cloneCalls,
			1,
			"a clone misfire must surface, not retry into a name collision",
		);
		strictEqual(
			rollbackCount,
			0,
			"unknown allocation must not be reclaimed by name",
		);
	});

	it("accepts a workspace whose guest state is correct despite a lost exit code", () => {
		const execs = [];
		// Pinned to one attempt so this exercises the repair-pass decision and
		// nothing else. `_call` now retries a job misfire internally, and at the
		// prlctl stub a retry and a repair pass look identical — leaving the
		// default in place would make this assert on both layers at once and
		// fail for a reason it does not test. The retry itself is covered by
		// "absorbs a job misfire" below.
		const backend = workspaceBackend(
			(args) => {
				execs.push(args);
				if (args.includes("/usr/bin/stat")) return WORKSPACE_READY;
				// The silent command prlctl could not read a result for.
				if (args.includes("/bin/chmod")) throw lostExitCode();
				return "";
			},
			{ prlctlRetryAttempts: 1 },
		);

		backend._prepareWorkspace(WORK_UUID, "switchyard");

		strictEqual(
			execs.filter((args) => args.includes("/bin/chmod")).length,
			1,
			"verified-correct state must not trigger a repair pass",
		);
	});

	it("keeps workspace verification parity for string and Buffer output", () => {
		for (const readyOutput of [WORKSPACE_READY, Buffer.from(WORKSPACE_READY)]) {
			let chmodCalls = 0;
			const backend = workspaceBackend(
				(args) => {
					if (args.includes("/bin/chmod")) {
						chmodCalls += 1;
						throw lostExitCode();
					}
					if (args.includes("/usr/bin/stat")) return readyOutput;
					return "";
				},
				{ prlctlRetryAttempts: 1 },
			);

			backend._prepareWorkspace(WORK_UUID, "switchyard");
			strictEqual(chmodCalls, 1);
		}
	});

	it("repairs the workspace when the first layout pass did not apply", () => {
		let chmodCalls = 0;
		const backend = workspaceBackend((args) => {
			if (args.includes("/bin/chmod")) {
				chmodCalls += 1;
				if (chmodCalls === 1) throw lostExitCode();
				return "";
			}
			if (args.includes("/usr/bin/stat")) {
				return chmodCalls >= 2 ? WORKSPACE_READY : WORKSPACE_UNAPPLIED;
			}
			return "";
		});

		backend._prepareWorkspace(WORK_UUID, "switchyard");

		strictEqual(chmodCalls, 2, "a real mismatch must be repaired once");
	});

	it("fails workspace preparation when the guest state stays wrong", () => {
		let cloneName = null;
		const backend = workspaceBackend((args) => {
			if (args[0] === "clone") cloneName = args[3];
			if (args[0] === "list" && args[1] === "-a") {
				return listed([
					{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
					...(cloneName
						? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
						: []),
				]);
			}
			// chmod never takes, and the guest says so every time.
			if (args.includes("/usr/bin/stat")) return WORKSPACE_UNAPPLIED;
			return "ready";
		});
		backend.boot = () => {};
		backend._hardenClone = () => {};
		backend.rollback = () => true;

		throws(
			() =>
				backend.create("macOS", {
					...ownedOptions("workspace-unapplied"),
					runId: "workspace-unapplied",
					creatorPid: process.pid,
					linked: false,
				}),
			(error) =>
				workerBootStageDiagnosticCode(error) === "workspace_prepare_failed",
		);
	});

	it("retries a verification probe that produces no output", () => {
		let statCalls = 0;
		const backend = workspaceBackend((args) => {
			if (args.includes("/usr/bin/stat")) {
				statCalls += 1;
				// An empty result is the probe failing, not a wrong workspace.
				if (statCalls === 1) return "";
				if (statCalls === 2) throw lostExitCode();
				return WORKSPACE_READY;
			}
			return "";
		});

		backend._prepareWorkspace(WORK_UUID, "switchyard");

		strictEqual(statCalls, 3, "the probe must be retried, not believed");
	});

	it("reports the layout failure, not the probe failure, when the guest is unreachable", () => {
		const backend = workspaceBackend(
			(args) => {
				if (args.includes("/bin/chmod")) {
					throw new Error("chmod: /Users/switchyard: Read-only file system");
				}
				if (args.includes("/usr/bin/stat")) throw lostExitCode();
				return "";
			},
			{ workspaceVerifyTimeoutMs: 0 },
		);

		throws(
			() => backend._prepareWorkspace(WORK_UUID, "switchyard"),
			/Read-only file system/,
		);
	});

	// INV-1 is asserted when the golden image is built but consumed at dispatch.
	// A Guest Tools refresh inside the golden on 2026-08-21 restored the
	// package-owned clipboard LaunchAgent the build had renamed away, and every
	// clone taken afterwards leaked the host pasteboard with nothing on the
	// create path to notice. These two tests lock the enforcement in place.
	it("disarms the guest clipboard agent on every clone before the provider user enters", () => {
		const calls = [];
		let cloneName = null;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			goldenImage: "macOS",
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "clone") {
					cloneName = args[3];
					return "";
				}
				if (args[0] === "list" && args[1] === "-a") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
						...(cloneName
							? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
							: []),
					]);
				}
				if (args.includes(CLIPBOARD_LABEL) || args.includes("/usr/bin/pgrep")) {
					throw new Error("could not find service");
				}
				if (args.includes("/usr/bin/stat")) return WORKSPACE_READY;
				return "ready";
			},
		});

		backend.create("macOS", {
			...ownedOptions("clipboard-harden"),
			runId: "clipboard-harden",
			creatorPid: process.pid,
			linked: false,
			providerUser: "switchyard",
			clipboardSettleMs: 0,
		});

		const guest = calls.filter((args) => args[0] === "exec");
		for (const verb of ["bootout", "disable"]) {
			ok(
				guest.some(
					(args) =>
						args.includes("/bin/launchctl") &&
						args.includes(verb) &&
						args.includes(CLIPBOARD_LABEL),
				),
				`create() must ${verb} ${CLIPBOARD_LABEL}`,
			);
		}
		ok(
			guest.some(
				(args) =>
					args.includes("/usr/bin/pkill") && args.includes("prlcopypaste"),
			),
			"create() must kill a running clipboard agent",
		);
		// Proving it, not just asking for it.
		ok(
			guest.some(
				(args) =>
					args.includes("/bin/launchctl") &&
					args.includes("print") &&
					args.includes(CLIPBOARD_LABEL),
			),
			"create() must verify the clipboard label is gone",
		);
		// Ordering is the point: enforcement lands before the workspace the
		// provider user is dropped into.
		const disarmAt = guest.findIndex((args) => args.includes("bootout"));
		const workspaceAt = guest.findIndex((args) => args.includes("/bin/mkdir"));
		ok(
			disarmAt >= 0 && workspaceAt > disarmAt,
			"clipboard teardown must precede workspace preparation",
		);
	});

	it("fails the clone when the clipboard agent survives the teardown", () => {
		let cloneName = null;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			goldenImage: "macOS",
			// The stub never lets the clone reach `stopped`, so the rollback's
			// post-stop observation waits out the whole settle window before it
			// escalates. Zeroed because this test is about the clipboard
			// teardown, not about how long a rollback is willing to wait.
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				if (args[0] === "clone") {
					cloneName = args[3];
					return "";
				}
				if (args[0] === "list" && args[1] === "-a") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
						...(cloneName
							? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
							: []),
					]);
				}
				// The label keeps printing: prltoolsd supervises the agent and
				// launchctl cannot hold it down. Dispatch must stop, not proceed
				// into a guest that still reaches the host pasteboard.
				return "ready";
			},
		});

		throws(
			() =>
				backend.create("macOS", {
					...ownedOptions("clipboard-survives"),
					runId: "clipboard-survives",
					creatorPid: process.pid,
					linked: false,
					providerUser: "switchyard",
					clipboardSettleMs: 0,
				}),
			(error) =>
				workerBootStageDiagnosticCode(error) === "clone_hardening_failed",
		);
	});

	it("refuses to harden a clone without an Aqua uid rather than skipping the teardown", () => {
		const backend = new ParallelsExecutionBackend({
			prlctlFn: () => "ready",
		});
		// Silently skipping enforcement on a missing uid would rebuild the exact
		// "env unset -> silent green" shape this change removes.
		throws(
			() => backend._hardenClone(WORK_UUID, {}),
			/aquaUid must be a positive numeric uid/,
		);
	});

	it("keeps watching for the clipboard agent across the whole settle window", () => {
		// The window exists because prltoolsd supervises the agent and brings it
		// back a few seconds after boot. Sampling once right after the teardown
		// reads clean and misses the respawn, so this runs the real 8s default on a
		// fake clock: the agent reappears on the third poll and the clone must still
		// fail. Collapsing the loop to a single check makes this test stop throwing.
		let printCount = 0;
		let now = 0;
		let slept = 0;
		let cloneName = null;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			goldenImage: "macOS",
			nowFn: () => now,
			deleteSettlementNowFn: () => now,
			sleepFn: (ms) => {
				slept += 1;
				now += ms;
			},
			prlctlFn: (args) => {
				if (args[0] === "clone") {
					cloneName = args[3];
					return "";
				}
				if (args[0] === "list" && args[1] === "-a") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "macOS" },
						...(cloneName
							? [{ uuid: WORK_UUID, status: "running", name: cloneName }]
							: []),
					]);
				}
				if (args.includes("print") && args.includes(CLIPBOARD_LABEL)) {
					printCount += 1;
					// Gone, gone, then supervised back into existence.
					if (printCount >= 3) return "ready";
					throw new Error("could not find service");
				}
				if (args.includes(CLIPBOARD_LABEL) || args.includes("/usr/bin/pgrep")) {
					throw new Error("could not find service");
				}
				return "ready";
			},
		});

		throws(
			() =>
				backend.create("macOS", {
					...ownedOptions("clipboard-respawn"),
					runId: "clipboard-respawn",
					creatorPid: process.pid,
					linked: false,
					providerUser: "switchyard",
				}),
			(error) =>
				workerBootStageDiagnosticCode(error) === "clone_hardening_failed",
		);
		strictEqual(
			printCount,
			3,
			"the settle window must re-sample instead of checking once",
		);
		ok(
			slept >= 2 && now > 0,
			"the settle window must advance the clock between samples",
		);
	});

	it("reclaims only dead owned VMs and force-stops a running one", () => {
		const calls = [];
		const entries = [
			{
				uuid: WORK_UUID,
				status: "running",
				name: buildParallelsWorkingName("dead-run", 999999),
			},
			{
				uuid: GOLDEN_UUID,
				status: "stopped",
				name: buildParallelsWorkingName("dead-stopped", 999998),
			},
			{
				uuid: "{88888888-8888-4888-8888-888888888888}",
				status: "running",
				name: "developer-vm",
			},
		];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return listed(entries);
				if (args[0] === "stop") {
					const current = entries.find((entry) => entry.uuid === args[1]);
					if (current) current.status = "stopped";
				}
				if (args[0] === "delete") {
					const index = entries.findIndex((entry) => entry.uuid === args[1]);
					if (index >= 0) entries.splice(index, 1);
				}
				return "ok";
			},
			pidIsAlive: () => false,
		});
		for (const entry of entries.slice(0, 2)) registerOwnedEntry(backend, entry);

		const result = backend.reclaim({ eligibility: () => true });
		strictEqual(result.reclaimed.length, 2);
		ok(
			calls.some(
				(args) =>
					args[0] === "stop" && args[1] === WORK_UUID && args[2] === "--kill",
			),
		);
		ok(!calls.some((args) => args[1] === "foreign"));
	});

	it("honors an exact reclaim eligibility filter before any VM mutation", () => {
		const calls = [];
		const entries = [
			{
				uuid: WORK_UUID,
				status: "running",
				name: buildParallelsWorkingName("eligible", 999999),
			},
			{
				uuid: GOLDEN_UUID,
				status: "running",
				name: buildParallelsWorkingName("foreign-run", 999998),
			},
		];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return listed(entries);
				if (args[0] === "stop") {
					const current = entries.find((entry) => entry.uuid === args[1]);
					if (current) current.status = "stopped";
				}
				if (args[0] === "delete") {
					const index = entries.findIndex((entry) => entry.uuid === args[1]);
					if (index >= 0) entries.splice(index, 1);
				}
				return "ok";
			},
			pidIsAlive: () => false,
		});
		for (const entry of entries) registerOwnedEntry(backend, entry);

		const result = backend.reclaim({
			eligibility: (entry) => entry.runId === "eligible",
		});
		strictEqual(result.reclaimed.length, 1);
		ok(
			calls.some(
				(args) =>
					args[0] === "stop" && args[1] === WORK_UUID && args[2] === "--kill",
			),
		);
		ok(!calls.some((args) => args[1] === GOLDEN_UUID));
	});

	it("lets the caller authorize terminal-clean ownership despite a live creator PID", () => {
		const calls = [];
		let deleted = false;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					if (deleted) return listed([]);
					return listed([
						{
							uuid: WORK_UUID,
							status: "stopped",
							name: buildParallelsWorkingName("terminal", process.pid),
						},
					]);
				}
				if (args[0] === "delete") deleted = true;
				return "ok";
			},
			pidIsAlive: () => true,
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			status: "stopped",
			name: buildParallelsWorkingName("terminal", process.pid),
		});

		const result = backend.reclaim({
			eligibility: (entry) => entry.runId === "terminal",
		});
		strictEqual(result.reclaimed.length, 1);
		ok(calls.some((args) => args[0] === "delete" && args[1] === WORK_UUID));
	});

	for (const [label, probe] of [
		[
			"PID reuse",
			(pid) => ({
				...fixtureHostProbe(pid),
				identity: fixtureBirth(pid, "999"),
			}),
		],
		[
			"boot mismatch",
			(pid) => ({
				state: "absent",
				pid,
				bootSessionUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				identity: null,
			}),
		],
		["unknown kernel result", () => ({ state: "unknown" })],
	]) {
		it(`refuses reclaim on ${label}`, () => {
			const calls = [];
			const entry = {
				uuid: WORK_UUID,
				status: "stopped",
				name: buildParallelsWorkingName("birth-guard", 999999),
			};
			const backend = new ParallelsExecutionBackend({
				prlctlFn: (args) => {
					calls.push(args);
					return args[0] === "list" ? listed([entry]) : "ok";
				},
				pidIsAlive: () => false,
			});
			registerOwnedEntry(backend, entry);
			backend.hostProcessIdentityProbe = probe;
			const result = backend.reclaim({ eligibility: () => true });
			strictEqual(result.reclaimed.length, 0);
			strictEqual(
				calls.filter((args) => args[0] === "stop" || args[0] === "delete")
					.length,
				0,
			);
		});
	}

	it("fails closed when reclaim eligibility is omitted", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName("dead", 999999),
						},
					]);
				}
				return "ok";
			},
			pidIsAlive: () => false,
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			status: "running",
			name: buildParallelsWorkingName("dead", 999999),
		});
		const result = backend.reclaim();
		strictEqual(result.reclaimed.length, 0);
		strictEqual(result.skipped[0].reason, "ineligible");
		ok(!calls.some((args) => args[0] === "stop" || args[0] === "delete"));
	});

	it("rechecks exact resource identity immediately before reclaim mutation", () => {
		const calls = [];
		let lists = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					lists += 1;
					return listed([
						{
							uuid: WORK_UUID,
							status: "running",
							name: buildParallelsWorkingName(
								lists === 1 ? "original" : "replacement",
								999999,
							),
						},
					]);
				}
				return "ok";
			},
			pidIsAlive: () => false,
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			status: "running",
			name: buildParallelsWorkingName("original", 999999),
		});
		const result = backend.reclaim({ eligibility: () => true });
		strictEqual(result.reclaimed.length, 0);
		strictEqual(result.skipped[0].reason, "identity-or-eligibility-changed");
		ok(!calls.some((args) => args[0] === "stop" || args[0] === "delete"));
	});

	it("rechecks caller liveness eligibility at the final mutation boundary", () => {
		const calls = [];
		const entry = {
			uuid: WORK_UUID,
			status: "running",
			name: buildParallelsWorkingName("liveness-race", 999999),
		};
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				return args[0] === "list" ? listed([entry]) : "ok";
			},
			pidIsAlive: () => false,
		});
		const ownershipContext = registerOwnedEntry(backend, entry);

		const result = backend.reclaim({
			ownershipContext,
			eligibility: (candidate) => candidate.recoveryPhase !== "pre_mutation",
		});

		strictEqual(result.reclaimed.length, 0);
		strictEqual(result.skipped[0].reason, "identity-or-eligibility-changed");
		strictEqual(
			calls.filter((args) => args[0] === "stop" || args[0] === "delete").length,
			0,
		);
	});

	it("preserves well-formed ownership from a different project", () => {
		const calls = [];
		const entry = {
			uuid: WORK_UUID,
			status: "stopped",
			name: buildParallelsWorkingName("project-mismatch", 999999),
		};
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				return args[0] === "list" ? listed([entry]) : "ok";
			},
			pidIsAlive: () => false,
		});
		const stored = registerOwnedEntry(backend, entry, {
			projectRoot: "/private/tmp/foreign-project",
		});

		const result = backend.reclaim({
			ownershipContext: {
				...stored,
				projectRoot: "/private/tmp/authoritative-project",
			},
			eligibility: () => true,
		});

		strictEqual(result.reclaimed.length, 0);
		strictEqual(result.skipped[0].reason, "recovery_evidence_missing");
		strictEqual(
			calls.filter((args) => args[0] === "stop" || args[0] === "delete").length,
			0,
		);
	});

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

describe("linked-clone snapshot sidecar (INV-3 cross-process reclamation)", () => {
	const GOLDEN = "switchyard-golden-test";
	// Predates the sidecar convention. Must survive every path below.
	const FOREIGN_SNAPSHOT = "{51f4e833-0000-4000-8000-000000000000}";
	const CLONE_SNAPSHOT = "{9f6e0d53-0000-4000-8000-000000000000}";

	function snapshotJson(ids) {
		return JSON.stringify(
			Object.fromEntries(ids.map((id) => [id, { name: "snap" }])),
		);
	}

	function makeSidecarRoot() {
		return tempDir("switchyard-sidecar-");
	}

	/**
	 * A backend whose golden image reports `snapshots` and whose clone lands as
	 * `cloneName`. Records every prlctl argv for assertion.
	 */
	function makeCloningBackend(
		sidecarRoot,
		cloneName,
		{
			runId = "run-1",
			deleteRemoves = true,
			deleteFailure = null,
			inventoryFailure = false,
			stopSettleTimeoutMs,
		} = {},
	) {
		const calls = [];
		let snapshots = [FOREIGN_SNAPSHOT];
		// The clone honours `stop`. Destroy observes the postcondition rather
		// than reading the exit code, so a stub whose VM reports `running`
		// forever waits out the settle window and escalates to a kill -- turning
		// a snapshot-cleanup test into a slow test of the forced path.
		let running = true;
		let deleted = false;
		let deleteAttempted = false;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			creatorPid: process.pid,
			goldenImage: GOLDEN,
			snapshotSidecarRoot: sidecarRoot,
			runId,
			...(stopSettleTimeoutMs === undefined ? {} : { stopSettleTimeoutMs }),
			requireLinkedCloneMeasurement: false,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "stop") running = false;
				if (args[0] === "snapshot-list") return snapshotJson(snapshots);
				if (args[0] === "clone") {
					// The clone is what creates the parent snapshot.
					snapshots = [FOREIGN_SNAPSHOT, CLONE_SNAPSHOT];
					return "";
				}
				if (args[0] === "snapshot-delete") {
					snapshots = snapshots.filter((id) => id !== args[3]);
					return "";
				}
				if (args[0] === "list") {
					if (inventoryFailure && deleteAttempted)
						throw new Error("inventory unavailable after delete");
					if (deleted) return listed([]);
					return listed([
						{
							uuid: WORK_UUID,
							status: running ? "running" : "stopped",
							name: cloneName,
						},
					]);
				}
				if (args[0] === "delete") {
					deleteAttempted = true;
					if (deleteFailure) throw deleteFailure;
					if (deleteRemoves) deleted = true;
				}
				return "";
			},
		});
		return { backend, calls, snapshotsNow: () => snapshots };
	}

	it("writes a sidecar at clone time carrying image, snapshots, run id, and creator pid", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("live", process.pid);
		const { backend } = makeCloningBackend(root, name);

		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});

		const record = JSON.parse(
			readFileSync(backend.snapshotSidecarPath(WORK_UUID), "utf8"),
		);
		strictEqual(record.goldenImage, GOLDEN);
		deepStrictEqual(record.snapshotIds, [CLONE_SNAPSHOT]);
		strictEqual(record.runId, "run-1");
		strictEqual(record.creatorPid, process.pid);
		strictEqual(record.vmUuid, WORK_UUID);
		ok(Number.isFinite(record.recordedAt));
		rmSync(root, { recursive: true, force: true });
	});

	it("removes both the snapshots and the sidecar on destroy", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("live", process.pid);
		const { backend, snapshotsNow } = makeCloningBackend(root, name);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(backend, { uuid: WORK_UUID, name, status: "running" });
		const sidecarPath = backend.snapshotSidecarPath(WORK_UUID);
		ok(existsSync(sidecarPath));

		backend.destroy(WORK_UUID);

		ok(!snapshotsNow().includes(CLONE_SNAPSHOT), "clone snapshot must be gone");
		ok(
			snapshotsNow().includes(FOREIGN_SNAPSHOT),
			"a snapshot no sidecar names must survive destroy",
		);
		ok(!existsSync(sidecarPath), "sidecar must be removed after cleanup");
		rmSync(root, { recursive: true, force: true });
	});

	it("preserves sidecar evidence when final VM absence is uncertain", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("uncertain", process.pid);
		const { backend } = makeCloningBackend(root, name, {
			deleteRemoves: false,
			stopSettleTimeoutMs: 0,
		});
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(backend, { uuid: WORK_UUID, name, status: "stopped" });
		const sidecarPath = backend.snapshotSidecarPath(WORK_UUID);

		throws(() => backend.destroy(WORK_UUID), /remained present after delete/);
		ok(existsSync(sidecarPath));
		rmSync(root, { recursive: true, force: true });
	});

	it("deleted VM inventory failure preserves sidecars", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("inventory-failure", process.pid);
		const { backend } = makeCloningBackend(root, name, {
			inventoryFailure: true,
			stopSettleTimeoutMs: 0,
		});
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(backend, { uuid: WORK_UUID, name, status: "stopped" });
		const sidecarPath = backend.snapshotSidecarPath(WORK_UUID);
		const ownershipPath = backend.vmOwnershipPath(
			WORK_UUID,
			join(TEST_RUN_STORE_ROOT, "runs", "inventory-failure", "resources"),
		);

		throws(() => backend.destroy(WORK_UUID), /could not verify absence/);
		ok(existsSync(sidecarPath));
		ok(existsSync(ownershipPath));
		rmSync(root, { recursive: true, force: true });
	});

	it("deleted VM inventory failure reports uncertainty", () => {
		const root = makeSidecarRoot();
		const name = buildParallelsWorkingName("inventory-cause", process.pid);
		const deleteFailure = new Error("delete returned 255");
		const { backend } = makeCloningBackend(root, name, {
			deleteFailure,
			inventoryFailure: true,
			stopSettleTimeoutMs: 0,
		});
		registerOwnedEntry(backend, { uuid: WORK_UUID, name, status: "running" });

		throws(
			() => backend.destroy(WORK_UUID),
			(error) =>
				error.cleanupUncertain === true && causedBy(error, deleteFailure),
		);
		rmSync(root, { recursive: true, force: true });
	});

	it("reclaims a dead owner's snapshots from a fresh backend with an empty map", () => {
		// The whole point: reclaim() runs in a different process from create(),
		// so the in-process map is always empty here. Before the sidecar, this
		// path deleted the VM and left its parent snapshot on the golden
		// forever — one such orphan sat on switchyard-golden-6 for 13 days.
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend: writer } = makeCloningBackend(root, deadName);
		writer.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(writer, {
			uuid: WORK_UUID,
			name: deadName,
			status: "running",
		});

		const { backend: fresh, snapshotsNow } = makeCloningBackend(root, deadName);
		strictEqual(fresh.linkedSnapshotsByUuid.size, 0);

		const result = fresh.reclaim({ eligibility: () => true });

		strictEqual(result.reclaimed.length, 1);
		deepStrictEqual(result.reclaimedSnapshots, [
			{
				name: deadName,
				goldenImage: GOLDEN,
				snapshotIds: [CLONE_SNAPSHOT],
			},
		]);
		ok(!snapshotsNow().includes(CLONE_SNAPSHOT));
		ok(!existsSync(fresh.snapshotSidecarPath(WORK_UUID)));
		rmSync(root, { recursive: true, force: true });
	});

	it("never passes a snapshot absent from every sidecar to a delete call", () => {
		// The absolute rule: reclaim deletes only ids it read from a sidecar,
		// never one discovered by listing. switchyard-golden-26-5 predates the
		// convention and must survive.
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend: writer } = makeCloningBackend(root, deadName);
		// No sidecar written at all, yet the golden carries a snapshot.
		registerOwnedEntry(writer, {
			uuid: WORK_UUID,
			name: deadName,
			status: "running",
		});
		const unrelatedMetadata = join(root, "unrelated-metadata.json");
		writeFileSync(unrelatedMetadata, "{}\n", "utf8");
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, deadName);
		backend.hostProcessIdentityProbe = (pid) => ({
			state: "absent",
			pid,
			bootSessionUuid: TEST_BOOT_UUID,
			identity: null,
		});
		strictEqual(backend.ownedResourcesByUuid.size, 0);
		const ownershipPath = backend.vmOwnershipPath(
			WORK_UUID,
			join(TEST_RUN_STORE_ROOT, "runs", "dead", "resources"),
		);
		ok(existsSync(ownershipPath), "writer must publish durable VM ownership");

		const result = backend.reclaim({ eligibility: () => true });

		strictEqual(result.reclaimed.length, 1, "the VM itself is still reclaimed");
		deepStrictEqual(result.reclaimedSnapshots, []);
		deepStrictEqual(result.skippedSnapshots, [
			{ name: deadName, uuid: WORK_UUID, reason: "no-snapshot-sidecar" },
		]);
		// A reclaimed VM must never also appear in `skipped`: that list answers
		// "which VMs were left alone", and this one was not.
		deepStrictEqual(result.skipped, []);
		ok(
			!calls.some((args) => args[0] === "snapshot-delete"),
			`no snapshot may be deleted: ${JSON.stringify(calls)}`,
		);
		ok(snapshotsNow().includes(FOREIGN_SNAPSHOT));
		ok(!existsSync(ownershipPath), "deleted VM must lose its ownership record");
		ok(existsSync(unrelatedMetadata), "unrelated metadata must survive");
		rmSync(root, { recursive: true, force: true });
	});

	it("does not touch a live owner's clone or its snapshots", () => {
		const root = makeSidecarRoot();
		const liveName = buildParallelsWorkingName("live", process.pid);
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, liveName);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: liveName,
			status: "running",
		});

		const result = backend.reclaim({ eligibility: () => false });

		strictEqual(result.reclaimed.length, 0);
		deepStrictEqual(result.reclaimedSnapshots, []);
		strictEqual(result.skipped[0]?.reason, "ineligible");
		ok(!calls.some((args) => args[0] === "snapshot-delete"));
		deepStrictEqual(
			snapshotsNow(),
			[FOREIGN_SNAPSHOT],
			"the golden's snapshot list must be untouched",
		);
		ok(
			existsSync(backend.snapshotSidecarPath(WORK_UUID)),
			"a live owner's sidecar must survive another process's reclaim",
		);
		rmSync(root, { recursive: true, force: true });
	});

	it("skips a corrupt or unreadable sidecar without throwing and without deleting", () => {
		const root = makeSidecarRoot();
		const deadName = buildParallelsWorkingName("dead", 999_999);
		const { backend, calls, snapshotsNow } = makeCloningBackend(root, deadName);
		mkdirSync(backend.snapshotSidecarDir(), { recursive: true });
		writeFileSync(
			backend.snapshotSidecarPath(WORK_UUID),
			"{not json at all",
			"utf8",
		);
		registerOwnedEntry(backend, {
			uuid: WORK_UUID,
			name: deadName,
			status: "running",
		});
		let sidecarReads = 0;
		const readSnapshotSidecar = backend.readSnapshotSidecar.bind(backend);
		backend.readSnapshotSidecar = (uuid) => {
			sidecarReads += 1;
			return readSnapshotSidecar(uuid);
		};

		const result = backend.reclaim({ eligibility: () => true });

		strictEqual(result.errors.length, 0, JSON.stringify(result.errors));
		strictEqual(
			sidecarReads,
			1,
			"corrupt-sidecar fixture must reach the durable sidecar read",
		);
		deepStrictEqual(result.reclaimedSnapshots, []);
		ok(!calls.some((args) => args[0] === "snapshot-delete"));
		ok(snapshotsNow().includes(FOREIGN_SNAPSHOT));

		// A structurally valid file missing the fields a delete decision needs
		// is the same case, and must not be trusted into a delete either.
		writeFileSync(
			backend.snapshotSidecarPath(WORK_UUID),
			JSON.stringify({ goldenImage: GOLDEN, snapshotIds: [null] }),
			"utf8",
		);
		strictEqual(backend.readSnapshotSidecar(WORK_UUID), null);
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps a uuid from escaping the sidecar directory", () => {
		const root = makeSidecarRoot();
		const { backend } = makeCloningBackend(root, "x");
		const path = backend.snapshotSidecarPath("../../etc/{passwd}");
		ok(
			path.startsWith(backend.snapshotSidecarDir()),
			`sidecar path escaped its directory: ${path}`,
		);
		ok(!path.includes(".."));
		rmSync(root, { recursive: true, force: true });
	});

	it("stays inert when no durable root is injected", () => {
		// A backend with nowhere to write must not throw; destroy() still cleans
		// up from the in-process map, which is the pre-sidecar behavior.
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: () => "",
		});
		strictEqual(backend.snapshotSidecarDir(), null);
		strictEqual(backend.snapshotSidecarPath(WORK_UUID), null);
		strictEqual(backend.readSnapshotSidecar(WORK_UUID), null);
		backend.writeSnapshotSidecar(WORK_UUID, {
			goldenImage: GOLDEN,
			snapshotIds: [CLONE_SNAPSHOT],
		});
		backend.deleteSnapshotSidecar(WORK_UUID);
	});
});

/**
 * The host-side SDK job misfire, and the boundary around absorbing it.
 *
 * Measured 2026-09-01 against the golden image with switchyard entirely out of
 * the picture: a plain shell loop saw 5 of 150 serial `prlctl exec` calls fail
 * with `PrlJob_GetRetCode`/`GetResult: Invalid argument`, 14 of 100 under four
 * concurrent callers, and every serial misfire cleared on the very next call.
 * Before this suite, one such misfire anywhere in a boot sequence killed the
 * whole run and left no exit code, signal, or attempt count behind.
 */
describe("VM ownership metadata", () => {
	it("retains allocation intent evidence across crash fixtures", () => {
		const root = tempDir("switchyard-allocation-crash-");
		const runId = "crash-after-intent";
		const resourceRoot = join(root, "runs", runId, "resources");
		const context = ownedOptions(runId, 5151, {
			resourceRoot,
		}).ownershipContext;
		const name = buildParallelsWorkingName(runId, 5151);
		const backend = new ParallelsExecutionBackend({ prlctlFn: () => "" });

		try {
			// Crash before the clone call: intent is the only durable evidence and
			// must remain auditable without invoking a mutating command.
			backend.writeAllocationIntent(name, context);
			const intentPath = backend.allocationIntentPath(name, resourceRoot);
			ok(existsSync(intentPath));
			strictEqual(
				statSync(resourceRoot).mode & 0o777,
				0o700,
				"allocation metadata must be written beneath an owner-only resource root",
			);
			const fresh = new ParallelsExecutionBackend({
				prlctlFn: () => {
					throw new Error("allocation audit must remain read-only");
				},
			});
			deepStrictEqual(
				fresh.auditAllocationIntents({
					knownResourceRoots: [
						{
							resourceRoot,
							runId,
							runRecordStatus: "valid",
							projectPath: context.projectRoot,
							cleanupState: "pending",
							liveness: "dead",
						},
					],
				}),
				[
					{
						file: `parallels-allocation-${createHash("sha256")
							.update(name)
							.digest("hex")}.intent.json`,
						runId,
						vmName: name,
						classification: "stale",
						reason: "stale_run",
					},
				],
			);

			// Crash after a clone side effect but before a UUID receipt: preserve
			// the explicit uncertainty rather than inventing an allocation identity.
			backend.writeAllocationUncertainty(
				name,
				context,
				"allocation_identity_unknown",
			);
			const persisted = JSON.parse(readFileSync(intentPath, "utf8"));
			strictEqual(persisted.state, "cleanup_uncertain");
			strictEqual(persisted.reasonCode, "allocation_identity_unknown");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds every Parallels call and preserves the production backend bytes", () => {
		const sourcePath = new URL(
			"../src/switchyard/lifecycle/parallels-execution-backend.mjs",
			import.meta.url,
		);
		const source = readFileSync(sourcePath, "utf8");
		strictEqual(
			createHash("sha256").update(source, "utf8").digest("hex"),
			"16c8104c0654f6376edd7a78e7e8898c4dd4ed852186def824e2ad4e6898edf2",
		);

		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlCallTimeoutMs: 321,
			prlctlFn: (args, options) => {
				calls.push({ args, options });
				return "ok";
			},
		});
		strictEqual(backend._call(["list", "-a"]), "ok");
		strictEqual(calls[0].options.timeout, 321);
		strictEqual(calls[0].options.killSignal, "SIGKILL");
	});

	it("uses the exact UUID when a false-success delete leaves a similarly named VM", () => {
		const calls = [];
		const otherUuid = "{33333333-3333-4333-8333-333333333333}";
		const entry = {
			uuid: WORK_UUID,
			name: buildParallelsWorkingName("uuid-proof", process.pid),
			status: "running",
		};
		const backend = new ParallelsExecutionBackend({
			stopSettleTimeoutMs: 0,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([
						{ ...entry, status: "running" },
						{ uuid: otherUuid, status: "stopped", name: entry.name },
					]);
				if (args[0] === "delete") deleted = true;
				return "";
			},
		});

		throws(
			() => backend.stopAndDelete(entry, { forceOnly: true }),
			(error) => error.cleanupUncertain === true,
		);
		strictEqual(calls.filter((args) => args[0] === "delete").length, 0);
		ok(
			calls
				.filter((args) => args[0] === "list")
				.every((args) => args[1] === "-a"),
		);
	});

	it("audits known allocation intents as valid, stale, malformed, or unknown without mutation", () => {
		const root = tempDir("switchyard-allocation-audit-");
		const projectRoot = "/private/tmp/switchyard-fixture-project";
		let mutations = 0;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: () => {
				mutations += 1;
				return "";
			},
		});
		const descriptors = [];
		for (const [runId, liveness, runRecordStatus] of [
			["active-intent", "live", "valid"],
			["stale-intent", "dead", "valid"],
			["unknown-intent", "unknown", "missing"],
		]) {
			const resourceRoot = join(root, "runs", runId, "resources");
			const context = ownedOptions(runId, 5151, {
				resourceRoot,
				projectRoot,
			}).ownershipContext;
			backend.writeAllocationIntent(
				buildParallelsWorkingName(runId, 5151),
				context,
			);
			descriptors.push({
				resourceRoot,
				runId,
				runRecordStatus,
				projectPath: projectRoot,
				cleanupState: "pending",
				liveness,
			});
		}
		const malformedRoot = join(root, "runs", "malformed", "resources");
		mkdirSync(malformedRoot, { recursive: true });
		writeFileSync(
			join(
				malformedRoot,
				"parallels-allocation-0000000000000000000000000000000000000000000000000000000000000000.intent.json",
			),
			"{not-json",
			"utf8",
		);
		descriptors.push({
			resourceRoot: malformedRoot,
			runId: "malformed",
			runRecordStatus: "valid",
			projectPath: projectRoot,
			cleanupState: "pending",
			liveness: "dead",
		});

		const audit = backend.auditAllocationIntents({
			knownResourceRoots: descriptors,
		});
		deepStrictEqual(
			audit.map(({ runId, classification, reason }) => ({
				runId,
				classification,
				reason,
			})),
			[
				{
					runId: "active-intent",
					classification: "valid",
					reason: "active_run",
				},
				{
					runId: "stale-intent",
					classification: "stale",
					reason: "stale_run",
				},
				{
					runId: "unknown-intent",
					classification: "unknown",
					reason: "run_missing",
				},
				{
					runId: null,
					classification: "malformed",
					reason: "intent_malformed",
				},
			],
		);
		strictEqual(mutations, 0, "the allocation-intent audit is read-only");
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses an unproven bare handle before any VM mutation", () => {
		const calls = [];
		const name = buildParallelsWorkingName("bare-handle", 5151);
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list")
					return listed([{ uuid: WORK_UUID, status: "stopped", name }]);
				return "";
			},
		});
		throws(() => backend.destroy(WORK_UUID), /recovery_evidence_missing/);
		strictEqual(
			calls.filter((args) => ["stop", "delete"].includes(args[0])).length,
			0,
		);
	});

	it("refuses allocation before clone when authoritative ownership context is absent", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			requireLinkedCloneMeasurement: false,
			prlctlFn: (args) => {
				calls.push(args);
				return "";
			},
		});
		throws(
			() =>
				backend.create("macOS", { linked: false, runId: "missing-context" }),
			/ownership context/,
		);
		strictEqual(
			calls.length,
			0,
			"metadata refusal must precede clone mutation",
		);
	});

	it("resolves a fresh backend targeted destroy from registered UUID ownership", () => {
		const name = buildParallelsWorkingName("fresh-destroy", 5151);
		const context = ownedOptions("fresh-destroy", 5151).ownershipContext;
		const writer = new ParallelsExecutionBackend({ prlctlFn: () => "" });
		writer.writeVmOwnership(WORK_UUID, name, context);
		const calls = [];
		let destroyed = false;
		const fresh = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					if (destroyed) return listed([]);
					return listed([{ uuid: WORK_UUID, status: "stopped", name }]);
				}
				if (args[0] === "delete") destroyed = true;
				return "";
			},
		});
		const handle = {
			uuid: WORK_UUID,
			name,
			runId: "fresh-destroy",
			taskId: context.taskId,
			attemptId: context.attemptId,
			processStartIdentity: context.processStartIdentity,
		};
		fresh.destroy(handle);
		ok(calls.some((args) => args[0] === "delete" && args[1] === WORK_UUID));

		writer.writeVmOwnership(WORK_UUID, name, context);
		destroyed = false;
		const beforeMismatch = calls.length;
		throws(
			() => fresh.destroy({ ...handle, processStartIdentity: "other-birth" }),
			/identity changed/,
		);
		strictEqual(
			calls
				.slice(beforeMismatch)
				.filter((args) => ["stop", "delete"].includes(args[0])).length,
			0,
		);
	});

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

describe("prlctl job-misfire tolerance", () => {
	it("absorbs a job misfire and returns the retried result", () => {
		let calls = 0;
		const backend = workspaceBackend(() => {
			calls += 1;
			if (calls === 1) throw lostExitCode();
			return "second-attempt-output";
		});

		strictEqual(backend._call(["list", "-a"]), "second-attempt-output");
		strictEqual(calls, 2, "the misfire must cost exactly one extra call");
	});

	it("stops at the bounded attempt count instead of retrying forever, pausing on a linear backoff between attempts", () => {
		let calls = 0;
		const sleeps = [];
		const backend = workspaceBackend(
			() => {
				calls += 1;
				throw lostExitCode();
			},
			{
				prlctlRetryAttempts: 3,
				prlctlRetryBackoffMs: 250,
				sleepFn: (ms) => sleeps.push(ms),
			},
		);

		throws(
			() => backend._call(["list", "-a"]),
			(error) => {
				ok(error instanceof PrlctlCallError);
				strictEqual(error.diagnosticCode, "prlctl_job_misfire");
				strictEqual(error.attempts, 3);
				strictEqual(error.exitCode, 255, "the real exit code must survive");
				return true;
			},
		);
		strictEqual(calls, 3, "a persistent misfire must not retry unbounded");
		// Linear backoff (backoffMs * attempt), and no pause after the attempt
		// that finally gives up -- that would just be added latency on a path
		// that is already throwing.
		deepStrictEqual(sleeps, [250, 500]);
	});

	it("validates the retry-attempt count the same way it validates every other duration knob", () => {
		// A distinct validator from validateDurationMs (attempts are a count, not
		// a duration), so it earns its own boundary check: the floor is 1, not 0,
		// because "no retry" is a legitimate caller choice (see execGuest's
		// opt-out) while zero attempts would mean _call never even tries once.
		for (const value of [0, -1, 1.5, Number.NaN, "3"]) {
			throws(
				() => workspaceBackend(() => "", { prlctlRetryAttempts: value }),
				/prlctlRetryAttempts must be an integer >= 1/,
			);
		}
		ok(workspaceBackend(() => "", { prlctlRetryAttempts: 1 }));
	});

	it("retries a misfired control command run through execGuest", () => {
		// execGuest is the small-control-command route: read a marker, set a
		// mode, `rm -f`, confirm a tree is gone, ask a CLI its version. All of it
		// is safe to repeat, so a misfire is absorbed here instead of surfacing
		// as a failed boot or a healthy provider that looks dead.
		let calls = 0;
		const backend = workspaceBackend(() => {
			calls += 1;
			if (calls < 2) throw lostExitCode();
			return "ok";
		});

		strictEqual(
			String(backend.execGuest(WORK_UUID, "/bin/cat", ["/tmp/pid"])),
			"ok",
		);
		strictEqual(calls, 2, "the misfire must be absorbed, not surfaced");
	});

	it("honors an explicit retry opt-out at an execGuest call site", () => {
		// The escape hatch the route's contract promises a caller whose command
		// is not repeat-safe. It has to beat the route's own default.
		let calls = 0;
		const backend = workspaceBackend(() => {
			calls += 1;
			throw lostExitCode();
		});

		throws(
			() =>
				backend.execGuest(WORK_UUID, "/usr/local/bin/codex", ["exec"], {
					prlctlOptions: { retry: false },
				}),
			(error) => error instanceof PrlctlCallError,
		);
		strictEqual(calls, 1, "an opt-out must be attempted once only");
	});

	it("keeps start on the legacy retry path until lost-result reconciliation is explicitly enabled", () => {
		const calls = [];
		let starts = 0;
		const backend = workspaceBackend((args) => {
			calls.push(args);
			if (args[0] === "list") {
				return listed([
					{
						uuid: WORK_UUID,
						status: "stopped",
						name: buildParallelsWorkingName("legacy-start", 1234),
					},
				]);
			}
			if (args[0] === "start") {
				starts += 1;
				if (starts === 1) throw lostExitCode();
				return "";
			}
			if (args[0] === "exec") return "ready";
			throw new Error(`unexpected call: ${args.join(" ")}`);
		});

		backend.boot(WORK_UUID);
		strictEqual(starts, 2);
		strictEqual(
			calls.filter((args) => args[0] === "list").length,
			1,
			"default-off reconciliation must not add a postcondition probe",
		);
	});

	function registerOwnedVm(backend, name, runId, creatorPid = 1234) {
		backend.ownedResourcesByUuid.set(
			WORK_UUID,
			Object.freeze({
				vmUuid: WORK_UUID,
				vmName: name,
				runId,
				creatorPid,
			}),
		);
	}

	it("reconciles a lost start only from the exact owned VM and emits bounded progress", () => {
		const calls = [];
		const statuses = [];
		let starts = 0;
		const name = buildParallelsWorkingName("lost-start", 1234);
		const backend = workspaceBackend(
			(args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{ uuid: WORK_UUID, status: starts ? "running" : "stopped", name },
					]);
				}
				if (args[0] === "start") {
					starts += 1;
					throw lostExitCode();
				}
				if (args[0] === "exec") return "ready";
				throw new Error(`unexpected call: ${args.join(" ")}`);
			},
			{
				enableLostMutationReconciliation: true,
				lostMutationReconciliationTimeoutMs: 100,
				lostMutationNowFn: () => 0,
				onStatus: (event) => statuses.push(event),
			},
		);
		registerOwnedVm(backend, name, "lost-start");

		backend.boot({ uuid: WORK_UUID, name });
		strictEqual(starts, 1);
		strictEqual(calls.filter((args) => args[0] === "list").length, 2);
		deepStrictEqual(
			statuses
				.filter((event) => event.type === "lost-mutation-reconciliation")
				.map(({ event, operation }) => ({ event, operation })),
			[
				{ event: "start", operation: "start" },
				{ event: "probe", operation: "start" },
				{ event: "complete", operation: "start" },
			],
		);
		ok(statuses.every((event) => !("argv" in event) && !("output" in event)));
	});

	it("preserves the lost start cause when the strict probe budget is zero, exhausted by inventory, or rolls back", () => {
		for (const fixture of [
			"zero",
			"fractional",
			"inventory-exhausted",
			"rollback",
		]) {
			let starts = 0;
			let lists = 0;
			const name = buildParallelsWorkingName(`budget-${fixture}`, 1234);
			const clock =
				fixture === "zero"
					? [0, 0]
					: fixture === "fractional"
						? [0, 0.2]
						: fixture === "inventory-exhausted"
							? [0, 0, 0, 100]
							: [10, 10, 9];
			let clockIndex = 0;
			const backend = workspaceBackend(
				(args) => {
					if (args[0] === "list") {
						lists += 1;
						return listed([{ uuid: WORK_UUID, status: "running", name }]);
					}
					if (args[0] === "start") {
						starts += 1;
						throw lostExitCode();
					}
					throw new Error(`unexpected call: ${args.join(" ")}`);
				},
				{
					enableLostMutationReconciliation: true,
					lostMutationReconciliationTimeoutMs:
						fixture === "zero" ? 0 : fixture === "fractional" ? 1 : 50,
					lostMutationNowFn: () =>
						clock[Math.min(clockIndex++, clock.length - 1)],
				},
			);
			registerOwnedVm(backend, name, `budget-${fixture}`);

			throws(
				() => backend.boot(WORK_UUID),
				(error) => error instanceof PrlctlCallError,
			);
			strictEqual(starts, 1, `${fixture}: start must not replay`);
			strictEqual(
				lists,
				fixture === "inventory-exhausted" ? 2 : 1,
				`${fixture}: no read may start without remaining budget`,
			);
		}
	});

	it("rejects mismatched compound handles and displaced ownership without another mutation", () => {
		let starts = 0;
		let lists = 0;
		const name = buildParallelsWorkingName("owned-start", 1234);
		const backend = workspaceBackend(
			(args) => {
				if (args[0] === "list") {
					lists += 1;
					if (lists === 3) backend.ownedResourcesByUuid.delete(WORK_UUID);
					return listed([{ uuid: WORK_UUID, status: "running", name }]);
				}
				if (args[0] === "start") {
					starts += 1;
					throw lostExitCode();
				}
				throw new Error(`unexpected call: ${args.join(" ")}`);
			},
			{
				enableLostMutationReconciliation: true,
				lostMutationReconciliationTimeoutMs: 100,
				lostMutationNowFn: () => 0,
			},
		);
		registerOwnedVm(backend, name, "owned-start");

		throws(
			() => backend.boot({ uuid: WORK_UUID, name: "other-vm" }),
			/does not identify/,
		);
		strictEqual(starts, 0);
		throws(
			() => backend.boot(WORK_UUID),
			(error) => error instanceof PrlctlCallError,
		);
		strictEqual(starts, 1, "ownership displacement must not replay start");
	});

	it("reconciles lost snapshot deletion with --json and the exact golden identity", () => {
		const calls = [];
		let deletes = 0;
		const snapshotId = "{9f6e0d53-0000-4000-8000-000000000000}";
		const backend = workspaceBackend(
			(args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "golden-fixture" },
					]);
				}
				if (args[0] === "snapshot-delete") {
					deletes += 1;
					throw lostExitCode();
				}
				if (args[0] === "snapshot-list")
					return JSON.stringify({ snapshots: [] });
				throw new Error(`unexpected call: ${args.join(" ")}`);
			},
			{
				enableLostMutationReconciliation: true,
				lostMutationReconciliationTimeoutMs: 100,
				lostMutationNowFn: () => 0,
			},
		);

		backend.deleteSnapshots({ uuid: GOLDEN_UUID, name: "golden-fixture" }, [
			snapshotId,
		]);
		strictEqual(deletes, 1);
		deepStrictEqual(calls.at(-1), ["snapshot-list", GOLDEN_UUID, "--json"]);
	});

	it("distinguishes strict snapshot parse rejection from a bounded still-present result", () => {
		for (const fixture of [
			"malformed",
			"empty-output",
			"conflicting-identity",
			"still-present",
		]) {
			let deletes = 0;
			let snapshotProbes = 0;
			let clock = 0;
			const sleeps = [];
			const statuses = [];
			const snapshotId = "{9f6e0d53-0000-4000-8000-000000000000}";
			const backend = workspaceBackend(
				(args) => {
					if (args[0] === "list") {
						return listed([
							{
								uuid: GOLDEN_UUID,
								status: "stopped",
								name:
									fixture === "conflicting-identity" && deletes
										? "other-golden"
										: "golden-fixture",
							},
						]);
					}
					if (args[0] === "snapshot-delete") {
						deletes += 1;
						throw lostExitCode();
					}
					if (args[0] === "snapshot-list") {
						snapshotProbes += 1;
						if (fixture === "still-present") {
							return JSON.stringify({ snapshots: [{ id: snapshotId }] });
						}
						return fixture === "empty-output" ? "" : "{}";
					}
					throw new Error(`unexpected call: ${args.join(" ")}`);
				},
				{
					enableLostMutationReconciliation: true,
					lostMutationReconciliationTimeoutMs: 500,
					lostMutationNowFn: () => clock,
					sleepFn: (ms) => {
						sleeps.push(ms);
						clock += ms;
					},
					onStatus: (event) => statuses.push(event),
				},
			);

			throws(
				() => backend.deleteSnapshots("golden-fixture", [snapshotId]),
				(error) => error instanceof PrlctlCallError,
			);
			strictEqual(deletes, 1, `${fixture}: deletion must not replay`);
			strictEqual(
				snapshotProbes,
				fixture === "conflicting-identity"
					? 0
					: fixture === "still-present"
						? 2
						: 1,
				`${fixture}: probe count must identify the rejection boundary`,
			);
			deepStrictEqual(
				sleeps,
				fixture === "still-present" ? [250, 250] : [],
				`${fixture}: malformed evidence must reject immediately`,
			);
			strictEqual(statuses.at(-1)?.event, "unavailable");
		}
	});

	it("does not start snapshot-list when the exact VM inventory consumes the budget", () => {
		let deletes = 0;
		let snapshotProbes = 0;
		const statuses = [];
		const clock = [0, 0, 0, 100];
		let clockIndex = 0;
		const snapshotId = "{9f6e0d53-0000-4000-8000-000000000000}";
		const backend = workspaceBackend(
			(args) => {
				if (args[0] === "list") {
					return listed([
						{ uuid: GOLDEN_UUID, status: "stopped", name: "golden-fixture" },
					]);
				}
				if (args[0] === "snapshot-delete") {
					deletes += 1;
					throw lostExitCode();
				}
				if (args[0] === "snapshot-list") {
					snapshotProbes += 1;
					return JSON.stringify({ snapshots: [] });
				}
				throw new Error(`unexpected call: ${args.join(" ")}`);
			},
			{
				enableLostMutationReconciliation: true,
				lostMutationReconciliationTimeoutMs: 50,
				lostMutationNowFn: () =>
					clock[Math.min(clockIndex++, clock.length - 1)],
				onStatus: (event) => statuses.push(event),
			},
		);

		throws(
			() => backend.deleteSnapshots("golden-fixture", [snapshotId]),
			(error) => error instanceof PrlctlCallError,
		);
		strictEqual(deletes, 1);
		strictEqual(snapshotProbes, 0);
		strictEqual(statuses.at(-1)?.event, "unavailable");
	});

	it("keeps snapshot deletion on the legacy retry path until reconciliation is enabled", () => {
		let deletes = 0;
		const backend = workspaceBackend((args) => {
			if (args[0] !== "snapshot-delete")
				throw new Error(`unexpected call: ${args.join(" ")}`);
			deletes += 1;
			if (deletes === 1) throw lostExitCode();
			return "";
		});
		backend.deleteSnapshots("golden-fixture", [
			"{9f6e0d53-0000-4000-8000-000000000000}",
		]);
		strictEqual(deletes, 2);
	});

	it("keeps paid provider execution off the retrying route entirely", () => {
		// The structural half of the contract. Adapters run a provider through
		// the execArgv descriptor, which only builds argv -- it never calls
		// prlctl, so a paid task cannot reach _call's retry at all. That is why
		// the route above can default to retrying without risking a repeat.
		let calls = 0;
		const backend = workspaceBackend(() => {
			calls += 1;
			throw lostExitCode();
		});

		const execution = backend.execArgv(WORK_UUID, {
			argv: ["/usr/local/bin/codex", "exec"],
		});
		strictEqual(execution.command, "prlctl");
		const payload = /printf %s ([A-Za-z0-9+/=]+)/.exec(
			execution.args.join(" "),
		);
		ok(payload, "the descriptor must carry an encoded guest payload");
		ok(
			Buffer.from(payload[1], "base64")
				.toString()
				.includes("/usr/local/bin/codex"),
			"the provider command must be carried, not executed",
		);
		strictEqual(calls, 0, "building a descriptor must not invoke prlctl");
	});

	it("classifies a not-yet-booted guest separately and does not retry it", () => {
		// A distinct, informative condition on a different timescale: 48 of the
		// first 100 calls after `prlctl start` returned this. The readiness
		// pollers own the wait; retrying here would mask an unbootable guest.
		let calls = 0;
		const notReady = new Error(
			"Unable to open new session in this virtual machine. Make sure your virtual machine has finished boot",
		);
		notReady.status = 255;
		const backend = workspaceBackend(() => {
			calls += 1;
			throw notReady;
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/usr/bin/true"]),
			(error) => {
				strictEqual(error.diagnosticCode, "prlctl_session_not_ready");
				return true;
			},
		);
		strictEqual(calls, 1, "readiness is polled, not retried inside a call");
	});

	it("records that the harness itself killed the child on a timeout", () => {
		const timedOut = new Error("spawnSync prlctl ETIMEDOUT");
		timedOut.code = "ETIMEDOUT";
		timedOut.killed = true;
		timedOut.signal = "SIGTERM";
		const backend = workspaceBackend(() => {
			throw timedOut;
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/sbin/mount"]),
			(error) => {
				strictEqual(error.diagnosticCode, "prlctl_call_timed_out");
				strictEqual(error.killed, true);
				strictEqual(error.signal, "SIGTERM");
				return true;
			},
		);
	});

	it("keeps the guest's own message readable on an ordinary failure", () => {
		const denied = new Error("Command failed: prlctl exec");
		denied.status = 1;
		denied.stderr = "chmod: /Users/switchyard: Read-only file system";
		const backend = workspaceBackend(() => {
			throw denied;
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/bin/chmod"]),
			(error) => {
				strictEqual(error.diagnosticCode, "prlctl_call_failed");
				ok(
					/Read-only file system/.test(error.message),
					`diagnosable text was lost: ${error.message}`,
				);
				return true;
			},
		);
	});

	it("records a persisted subcommand only from the closed allowlist, never echoing argv", () => {
		// The literal this file passes to `_call` is safe to persist; a value
		// `_call` merely happened to be invoked with is not the same guarantee,
		// so an unrecognized args[0] must come through as null rather than
		// whatever string was actually there.
		const backend = workspaceBackend(() => {
			throw lostExitCode();
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/bin/true"], { retry: false }),
			(error) => {
				strictEqual(error.subcommand, "exec");
				return true;
			},
		);
		throws(
			() => backend._call(["not-a-real-prlctl-subcommand"], { retry: false }),
			(error) => {
				strictEqual(error.subcommand, null);
				return true;
			},
		);
	});

	it("drops a signal outside the persistable set instead of forwarding it verbatim", () => {
		// Mirrors adapter/exec-error.mjs's PERSISTED_SIGNALS allowlist. SIGSEGV is
		// real (README's prlctl process-lifetime note) but is not one of the six
		// this module will carry into a run record.
		const segfault = new Error("Command failed: prlctl");
		segfault.status = null;
		segfault.signal = "SIGSEGV";
		const backend = workspaceBackend(() => {
			throw segfault;
		});

		throws(
			() => backend._call(["exec", WORK_UUID, "/bin/true"], { retry: false }),
			(error) => {
				strictEqual(error.signal, null);
				return true;
			},
		);
	});

	it("surfaces the misfire code through a wrapping boot-stage error", () => {
		// What the run record actually reads. "workspace_prepare_failed" says
		// which stage died; the misfire code says why, and only the why
		// distinguishes a transient host fault from a real provisioning problem.
		const misfire = new PrlctlCallError({
			diagnosticCode: "prlctl_job_misfire",
			subcommand: "exec",
			attempts: 4,
			exitCode: 255,
		});
		const staged = new WorkerBootStageError(
			"workspace_prepare_failed",
			misfire,
		);

		deepStrictEqual(prlctlFailureMetadata(staged), {
			diagnosticCode: "prlctl_job_misfire",
			exitCode: 255,
		});
		strictEqual(
			workerBootStageDiagnosticCode(staged),
			"workspace_prepare_failed",
			"the stage code must remain available alongside the cause",
		);
	});

	it("reports nothing for an error that is not a reviewed prlctl failure", () => {
		strictEqual(prlctlFailureMetadata(new Error("unrelated")), null);
		strictEqual(prlctlFailureMetadata(null), null);
	});

	it("refuses an unrecognized diagnostic code", () => {
		throws(
			() => new PrlctlCallError({ diagnosticCode: "prlctl_made_up" }),
			TypeError,
		);
	});
});

describe("prlctl failures stay diagnosable downstream", () => {
	// The wrapper introduced for job-misfire tolerance sits between the child
	// process and every consumer that classifies a failure. Adapter tests inject
	// a mock backend, so nothing else exercises the real-`_call`-error seam --
	// which is exactly how a wrapper that swallowed `stdout` and `code` would
	// ship green.

	/**
	 * The shape `execFileSync` throws: captured output plus an exit status.
	 * @param {object} fields
	 * @returns {Error}
	 */
	function childFailure(fields) {
		return Object.assign(
			new Error("Command failed: prlctl exec {vm} claude -p ..."),
			{ stdout: "", stderr: "", status: 1, ...fields },
		);
	}

	/**
	 * @param {Error} cause
	 * @returns {Error} whatever `_call` lets escape for that cause
	 */
	function thrownByCall(cause) {
		const backend = workspaceBackend(() => {
			throw cause;
		});
		try {
			backend.execGuest("vm-1", "claude", ["-p", "task"], { cwd: "/" });
		} catch (error) {
			return error;
		}
		throw new Error("execGuest was expected to fail");
	}

	it("keeps an expired provider session classifiable as auth_expired", () => {
		// The documented incident: the CLI printed its diagnostic to stdout and
		// exited 1. If the wrapper hides stdout, describeExecError sees an empty
		// haystack, every signature check is gated off, and the run record gets
		// "Command failed: prlctl exec ..." back -- the opaque reason that cost a
		// cross-session investigation the first time.
		const escaped = thrownByCall(
			childFailure({
				stdout:
					"Failed to authenticate: OAuth session expired and could not be refreshed\n",
			}),
		);
		const described = describeExecError(escaped, { provider: "claude" });

		strictEqual(described.errorKind, "auth_expired");
		ok(
			described.output.includes("OAuth session expired"),
			`provider stdout was dropped: ${JSON.stringify(described.output)}`,
		);
		ok(
			described.error.includes("OAuth session expired"),
			`the surfaced reason lost the provider's words: ${described.error}`,
		);
	});

	it("keeps a provider timeout routable on error.code", () => {
		// Every adapter branches on `error.code === "ETIMEDOUT"` to reach its
		// timeout path. Losing it does not fail loudly -- it misroutes a real
		// timeout into a generic execution failure.
		const escaped = thrownByCall(
			childFailure({ code: "ETIMEDOUT", killed: true, status: null }),
		);

		strictEqual(escaped.code, "ETIMEDOUT");
		strictEqual(escaped.diagnosticCode, "prlctl_call_timed_out");
	});

	it("still prefers the child's own words over Node's wrapper", () => {
		const stderrOnly = thrownByCall(
			childFailure({ stderr: "chmod: /x: Read-only file system\n" }),
		);
		ok(/Read-only file system/.test(stderrOnly.message), stderrOnly.message);

		// stdout is the fallback: a CLI picks whichever stream it likes.
		const stdoutOnly = thrownByCall(
			childFailure({ stdout: "model 'gemini-3.7' not found\n" }),
		);
		ok(/gemini-3\.7/.test(stdoutOnly.message), stdoutOnly.message);
	});

	it("still reads the child's output when execFileSync hands it back as a Buffer", () => {
		// execFileSync returns Buffers instead of strings whenever a caller
		// overrides the backend's utf8 encoding, and an injected prlctlFn is free
		// to do that. A detail reader that only accepted strings would drop the
		// text here -- silently, since a wrapped error with no detail still looks
		// like a normal, successful classification.
		const bufferOnly = thrownByCall(
			childFailure({
				stderr: Buffer.from("chmod: /x: Read-only file system\n"),
			}),
		);
		ok(/Read-only file system/.test(bufferOnly.message), bufferOnly.message);
	});

	it("does not widen what an accidental serialization would carry", () => {
		// The forwarded fields can hold provider output; they are diagnostic
		// surface for reviewed readers, not record fields. `name` is enumerable
		// (a plain assignment, as on any Error subclass) but is a fixed literal.
		const escaped = thrownByCall(childFailure({ stdout: "guest-only text\n" }));
		deepStrictEqual(Object.keys(escaped), ["name"]);
		strictEqual(JSON.stringify(escaped), '{"name":"PrlctlCallError"}');
	});
});

describe("bulk-transfer helper misfire tolerance", () => {
	// The helper runs prlctl in its OWN process, so none of it reaches `_call`
	// and none of the backend's retry applies by inheritance. That is how a
	// misfire here reached a run record as a bare `worker_boot_exception`,
	// naming the stage and not the cause. `bulkTransferFn` is the seam every
	// other test injects at, so this is the only coverage of the real spawn.

	const MISFIRE_LINE =
		"PrlJob_GetRetCode: Invalid argument. An invalid argument was passed.";

	/**
	 * A `prlctl` that fails its first `STUB_FAIL_UNTIL` invocations with the
	 * misfire signature and succeeds after. The count is a file so it survives
	 * across the separate processes the helper spawns; the bound comes from the
	 * environment the helper passes down.
	 * @param {string} root
	 * @returns {{binDir: string, counterPath: string, invocations: () => number}}
	 */
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

	/**
	 * Drive the real helper the way `_runBulkTransfer` does.
	 * @param {{failUntil: number, retryAttempts: number}} input
	 */
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
