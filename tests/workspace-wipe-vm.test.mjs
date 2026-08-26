// INV-3 gate test for the Parallels backend.
//
// The reclamation matrix is hermetic: it exercises the backend's exact-name
// and PID-liveness decisions without touching a VM. The live test is only
// entered after Parallels, the stopped golden image, Aqua identity, and the
// shared VM-slot primitive have all been proven available.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
	ParallelsExecutionBackend,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

const GOLDEN_IMAGE = process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE || "";
const AQUA_UID = process.env.SWITCHYARD_PARALLELS_AQUA_UID || "";

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
	if (!/^\d+$/.test(AQUA_UID) || Number(AQUA_UID) <= 0) {
		return "Aqua UID is unavailable; set SWITCHYARD_PARALLELS_AQUA_UID";
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

const prerequisiteReason = await inspectPrerequisites();

describe("workspace wipe — Parallels VM (INV-3)", () => {
	it("reclaims only exact-name VMs owned by proven-dead PIDs", () => {
		const livePid = 424242;
		const deadPid = 424243;
		const entries = [
			{
				uuid: "dead-running",
				status: "running",
				name: buildParallelsWorkingName("dead-run", deadPid),
			},
			{
				uuid: "dead-stopped",
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
		const backend = new ParallelsExecutionBackend({
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "list") return listed(entries);
				return "ok";
			},
			pidIsAlive: (pid) => pid === livePid,
		});

		const result = backend.reclaim();
		deepStrictEqual(
			result.reclaimed.map((entry) => entry.uuid),
			["dead-running", "dead-stopped"],
		);
		deepStrictEqual(
			result.skipped.map((entry) => entry.uuid),
			["live", "partial-live"],
		);
		ok(calls.some((args) => args[0] === "stop" && args[1] === "dead-running"));
		ok(!calls.some((args) => args[1] === "foreign"));
		ok(!calls.some((args) => args[1] === "malformed"));
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
			backend.assertGoldenImageAvailable(GOLDEN_IMAGE);
			vmUuid = backend.create(GOLDEN_IMAGE, {
				runId,
				aquaUid: AQUA_UID,
				linked: false,
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
