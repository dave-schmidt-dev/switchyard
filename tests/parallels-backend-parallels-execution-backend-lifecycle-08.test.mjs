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
});
