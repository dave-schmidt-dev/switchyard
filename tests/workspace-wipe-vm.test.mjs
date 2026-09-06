// INV-3 gate test for the Parallels backend.
//
// The reclamation matrix is hermetic: it exercises the backend's exact-name
// and PID-liveness decisions without touching a VM. The live test is only
// entered after Parallels, the stopped golden image, Aqua identity, and the
// shared VM-slot primitive have all been proven available.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
	ParallelsExecutionBackend,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const GOLDEN_IMAGE = process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE || "";
const AQUA_UID = process.env.SWITCHYARD_PARALLELS_AQUA_UID || "";
const SKIP_LIVE_VM_TESTS = process.env.SWITCHYARD_SKIP_LIVE_VM_TESTS === "1";
const TEST_BOOT_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function fixtureBirth(pid) {
	return `switchyard-host-process-v1:${TEST_BOOT_UUID}:${pid}:${pid * 10 + 1}`;
}

function absentHostProbe(pid) {
	return {
		state: "absent",
		pid,
		bootSessionUuid: TEST_BOOT_UUID,
		identity: null,
	};
}

function commandAvailable(command) {
	try {
		execFileSync("/usr/bin/which", [command], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

function listGoldenImage() {
	const output = execFileSync(
		"prlctl",
		["list", "-a", "-o", "uuid,status,name"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 },
	);
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const fields = line.includes("\t")
				? line.split("\t").map((field) => field.trim())
				: line.split(/\s+/);
			return fields.length >= 3
				? {
						uuid: fields[0],
						status: fields[1],
						name: fields.slice(2).join(" "),
					}
				: null;
		})
		.find((entry) => entry?.name === GOLDEN_IMAGE);
}

async function loadSlotPrimitive() {
	let module;
	try {
		module = await import("../src/switchyard/run-store/index.mjs");
	} catch {
		return null;
	}
	const acquire = module.acquireVmSlot ?? module.acquireMacosVmSlot;
	const release = module.releaseVmSlot ?? module.releaseMacosVmSlot;
	return typeof acquire === "function" && typeof release === "function"
		? { acquire, release }
		: null;
}

let configurationFault = null;

async function inspectPrerequisites() {
	if (!commandAvailable("prlctl")) return "Parallels prlctl is unavailable";
	try {
		execFileSync("prlctl", ["--version"], { stdio: "ignore", timeout: 5_000 });
	} catch {
		return "Parallels Desktop is unavailable to prlctl";
	}
	// Parallels is installed but the operator has not said which VM to clone.
	// That is a configuration fault, not an absent dependency, so it FAILS the gate
	// instead of skipping it. The previous `|| "macOS"` fallback pointed at the
	// unhardened Task 1.1 base VM, which is present and stopped on this host: with
	// the variable unset the gate would have cloned and asserted against a VM that
	// was never hardened. Production already refuses to guess (README.md: "no
	// default -- guessing at which VM to clone is not a safe default").
	if (!GOLDEN_IMAGE) {
		configurationFault =
			"SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set to run the VM gate";
		return null;
	}
	let golden;
	try {
		golden = listGoldenImage();
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	if (!golden) return `golden image ${GOLDEN_IMAGE} is unavailable`;
	if (!/^stopped$/i.test(golden.status)) {
		return `golden image ${GOLDEN_IMAGE} is not stopped`;
	}
	// An unset or malformed Aqua uid is a configuration fault, not an absent
	// dependency, so it FAILS the gate instead of skipping it. Returning a skip
	// reason here made the gate report green having proven nothing: it passes
	// locally only because ~/.zshrc exports the variable, so any non-interactive
	// shell, CI runner, or launchd context silently lost the INV-1 assertions.
	if (!AQUA_UID) {
		configurationFault =
			"SWITCHYARD_PARALLELS_AQUA_UID must be set to run the VM gate";
		return null;
	}
	if (!/^\d+$/.test(AQUA_UID) || Number(AQUA_UID) <= 0) {
		configurationFault = `SWITCHYARD_PARALLELS_AQUA_UID must be a positive integer uid, got ${JSON.stringify(AQUA_UID.slice(0, 32))}`;
		return null;
	}
	if (!(await loadSlotPrimitive())) {
		return "shared VM-slot primitive is unavailable";
	}
	try {
		if (new ParallelsExecutionBackend().listManaged().length > 0) {
			return "a Switchyard working VM is active";
		}
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	return null;
}

function listed(entries) {
	return [
		"uuid\tstatus\tname",
		...entries.map((entry) => `${entry.uuid}\t${entry.status}\t${entry.name}`),
	].join("\n");
}

const prerequisiteReason = SKIP_LIVE_VM_TESTS
	? "fixture-only: SWITCHYARD_SKIP_LIVE_VM_TESTS=1"
	: await inspectPrerequisites();

describe("workspace wipe — Parallels VM (INV-3)", () => {
	it("reclaims only exact-name VMs owned by proven-dead PIDs", () => {
		const livePid = 424242;
		const deadPid = 424243;
		const deadRunningUuid = "{11111111-1111-4111-8111-111111111111}";
		const deadStoppedUuid = "{22222222-2222-4222-8222-222222222222}";
		const entries = [
			{
				uuid: deadRunningUuid,
				status: "running",
				name: buildParallelsWorkingName("dead-run", deadPid),
			},
			{
				uuid: deadStoppedUuid,
				status: "stopped",
				name: buildParallelsWorkingName("dead-stopped", deadPid),
			},
			{
				uuid: "live",
				status: "running",
				name: buildParallelsWorkingName("live-run", livePid),
			},
			{
				uuid: "partial-live",
				status: "stopped",
				name: buildParallelsWorkingName("partial-create", livePid),
			},
			{ uuid: "foreign", status: "running", name: "developer-vm" },
			{
				uuid: "malformed",
				status: "running",
				name: "switchyard-work-not-a-pid",
			},
		];
		const calls = [];
		const resourceRoot = tempDir("switchyard-inv3-ownership-");
		const previousRunStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = resourceRoot;
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return listed(entries);
				return "ok";
			},
			pidIsAlive: (pid) => pid === livePid,
			hostProcessIdentityProbe: (pid) =>
				pid === livePid
					? {
							state: "present",
							pid,
							bootSessionUuid: TEST_BOOT_UUID,
							startTicks: String(pid * 10 + 1),
							identity: fixtureBirth(pid),
						}
					: absentHostProbe(pid),
		});

		const ownershipContext = {
			resourceRoot: join(resourceRoot, "runs", "dead-run", "resources"),
			runId: "dead-run",
			taskId: "reclaim-fixture",
			attemptId: "attempt-1",
			projectRoot: resolve("/private/tmp"),
			purpose: "workspace-wipe-test",
			creatorPid: deadPid,
			processStartIdentity: fixtureBirth(deadPid),
		};
		backend.writeVmOwnership(
			deadRunningUuid,
			entries[0].name,
			ownershipContext,
		);
		backend.writeVmOwnership(deadStoppedUuid, entries[1].name, {
			...ownershipContext,
			resourceRoot: join(resourceRoot, "runs", "dead-stopped", "resources"),
			runId: "dead-stopped",
			creatorPid: deadPid,
		});
		const omitted = backend.reclaim();
		strictEqual(
			omitted.reclaimed.length,
			0,
			"omitted eligibility must make zero destructive calls",
		);
		strictEqual(
			calls.filter((args) => args[0] === "stop" || args[0] === "delete").length,
			0,
		);
		const result = backend.reclaim({
			eligibility: (entry) =>
				entry.ownership.processStartIdentity === fixtureBirth(deadPid),
		});
		deepStrictEqual(
			result.reclaimed.map((entry) => entry.uuid),
			[deadRunningUuid, deadStoppedUuid],
		);
		deepStrictEqual(
			result.skipped.map((entry) => entry.uuid),
			["live", "partial-live"],
		);
		ok(calls.some((args) => args[0] === "stop" && args[1] === deadRunningUuid));
		ok(!calls.some((args) => args[1] === "foreign"));
		ok(!calls.some((args) => args[1] === "malformed"));
		if (previousRunStoreRoot === undefined)
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
	});

	it("normal destroy stops and deletes the owned VM", () => {
		const name = buildParallelsWorkingName("normal", 424244);
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") {
					return listed([{ uuid: "normal", status: "running", name }]);
				}
				return "ok";
			},
		});
		const resourceRoot = tempDir("switchyard-normal-destroy-");
		backend.writeVmOwnership("normal", name, {
			resourceRoot,
			runId: "normal",
			taskId: "normal-destroy",
			attemptId: "attempt-1",
			projectRoot: resolve("/private/tmp"),
			purpose: "workspace-wipe-test",
			creatorPid: 424244,
			processStartIdentity: fixtureBirth(424244),
		});

		deepStrictEqual(backend.destroy(name), {
			uuid: "normal",
			name,
			forced: false,
		});
		deepStrictEqual(calls, [
			["list", "-a", "-o", "uuid,status,name"],
			["stop", "normal"],
			["delete", "normal"],
		]);
	});

	it("creates and normally destroys a real VM when all prerequisites are available", {
		skip: prerequisiteReason ? `VM gate skipped: ${prerequisiteReason}` : false,
	}, async (testContext) => {
		if (configurationFault) throw new Error(configurationFault);
		const slotPrimitive = await loadSlotPrimitive();
		if (!slotPrimitive) {
			testContext.skip(
				"VM gate skipped: shared VM-slot primitive is unavailable",
			);
			return;
		}
		let slotLease;
		let backend;
		let vmUuid;
		let destroyed = false;
		const resourceRoot = tempDir("switchyard-inv3-live-");
		const runId = `inv3-${process.pid}-${randomUUID()}`;

		try {
			try {
				slotLease = await slotPrimitive.acquire({
					platform: "macos",
					purpose: "inv-3-vm-gate",
				});
			} catch (error) {
				if (
					error?.code === "VM_SLOT_UNAVAILABLE" ||
					/slot.*(held|available|capacity)/i.test(String(error?.message ?? ""))
				) {
					testContext.skip("VM gate skipped: both VM slots are held");
					return;
				}
				throw error;
			}
			if (!slotLease) {
				testContext.skip("VM gate skipped: both VM slots are held");
				return;
			}

			backend = new ParallelsExecutionBackend({
				aquaUid: AQUA_UID,
				goldenImage: GOLDEN_IMAGE,
			});
			// Re-check under the lease: the prerequisite ladder above runs once
			// at module load, so a dispatch that starts between then and here
			// would still hit assertGoldenImageAvailable's hard refusal. That is
			// the race that rejected a push on 2026-08-27.
			const owned = backend.listManaged();
			if (owned.length > 0) {
				testContext.skip(
					`VM gate skipped: a Switchyard working VM is active (${owned.map((entry) => entry.name).join(", ")})`,
				);
				return;
			}
			backend.assertGoldenImageAvailable(GOLDEN_IMAGE);
			vmUuid = backend.create(GOLDEN_IMAGE, {
				runId,
				aquaUid: AQUA_UID,
				linked: false,
				ownershipContext: {
					resourceRoot,
					runId,
					taskId: "inv-3-vm-gate",
					attemptId: "fixture-1",
					projectRoot: resolve("/private/tmp"),
					processStartIdentity: null,
				},
			});
			const result = backend.destroy(vmUuid);
			destroyed = true;
			strictEqual(result.uuid, vmUuid);
			strictEqual(
				backend
					.listAll()
					.some(
						(entry) =>
							entry.name === buildParallelsWorkingName(runId, process.pid),
					),
				false,
				"normal destroy must remove the working VM",
			);
		} finally {
			if (backend && vmUuid && !destroyed) {
				try {
					backend.destroy(vmUuid);
				} catch {
					// Preserve the primary assertion or creation failure.
				}
			}
			if (slotLease !== undefined && slotLease !== null) {
				if (typeof slotLease.release === "function") await slotLease.release();
				else await slotPrimitive.release(slotLease);
			}
		}
	});
});
