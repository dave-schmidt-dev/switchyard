// INV-1 gate test for the Parallels macOS backend.
//
// The host-side Parallels inspection is the direct filesystem proof: host
// shared folders must be disabled. The guest-side mount probe is retained as
// an independent observable check for a mount that the host report missed.
// The network and clipboard probes are also guest-side observations. They
// prove the golden image's C-3 posture, not host isolation: guest root can
// still change guest policy, and no guest probe can certify the host itself.

import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
	ParallelsExecutionBackend,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

const GOLDEN_IMAGE = process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE || "macOS";
const PROVIDER_USER =
	process.env.SWITCHYARD_PARALLELS_PROVIDER_USER || "switchyard";
const AQUA_UID = process.env.SWITCHYARD_PARALLELS_AQUA_UID || "";
// The four blocked endpoints are explicit because a passing probe against a
// closed port is not evidence of C-3. The manifest must name two host
// identities, the LAN gateway, and a guest-subnet service known to be live.
const C3_HOST_ENDPOINTS = parseEndpoints(
	process.env.SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS,
);
const C3_GATEWAY_ENDPOINT = parseEndpoint(
	process.env.SWITCHYARD_PARALLELS_C3_GATEWAY_ENDPOINT,
);
const C3_GUEST_SUBNET_ENDPOINT = parseEndpoint(
	process.env.SWITCHYARD_PARALLELS_C3_GUEST_SUBNET_ENDPOINT,
);
const C3_REACHABLE_ENDPOINT = parseEndpoint(
	process.env.SWITCHYARD_PARALLELS_C3_REACHABLE_ENDPOINT,
);
const C3_DNS_NAME = process.env.SWITCHYARD_PARALLELS_C3_DNS_NAME || "apple.com";

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

function parseEndpoint(value) {
	if (typeof value !== "string") return null;
	const match = /^([A-Za-z0-9._:-]+):(\d{1,5})$/.exec(value);
	if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
		return null;
	}
	return { value, host: match[1], port: match[2] };
}

function parseEndpoints(value) {
	if (!value) return [];
	return value
		.split(",")
		.map((endpoint) => parseEndpoint(endpoint.trim()))
		.filter(Boolean);
}

function outputText(value) {
	return Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function progress(message) {
	console.error(`[no-host-rights-vm] ${message}`);
}

function listInfo(name) {
	return execFileSync("prlctl", ["list", "-i", name], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function listGoldenImage() {
	const output = execFileSync(
		"prlctl",
		["list", "-a", "-o", "uuid,status,name"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split(/\s+/))
		.find(
			(fields) =>
				fields.length >= 3 && fields.slice(2).join(" ") === GOLDEN_IMAGE,
		);
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

async function inspectPrerequisites() {
	if (!commandAvailable("prlctl")) return "Parallels prlctl is unavailable";
	for (const command of ["pbcopy", "pbpaste"]) {
		if (!commandAvailable(command))
			return `host clipboard tool ${command} is unavailable`;
	}
	try {
		execFileSync("prlctl", ["--version"], { stdio: "ignore" });
	} catch {
		return "Parallels Desktop is unavailable to prlctl";
	}
	let golden;
	try {
		golden = listGoldenImage();
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	if (!golden) return `golden image ${GOLDEN_IMAGE} is unavailable`;
	if (!/^stopped$/i.test(golden[1])) {
		return `golden image ${GOLDEN_IMAGE} is not stopped`;
	}
	if (!/^\d+$/.test(AQUA_UID) || Number(AQUA_UID) <= 0) {
		return "Aqua UID is unavailable; set SWITCHYARD_PARALLELS_AQUA_UID";
	}
	if (!(await loadSlotPrimitive()))
		return "shared VM-slot primitive is unavailable";
	const blockedEndpoints = [
		...C3_HOST_ENDPOINTS,
		C3_GATEWAY_ENDPOINT,
		C3_GUEST_SUBNET_ENDPOINT,
	];
	if (
		blockedEndpoints.some((endpoint) => !endpoint) ||
		new Set(blockedEndpoints.map((endpoint) => endpoint.value)).size !== 4 ||
		!C3_REACHABLE_ENDPOINT ||
		!C3_DNS_NAME
	) {
		return "C-3 endpoint manifest is unavailable";
	}
	return null;
}

const prerequisiteReason = await inspectPrerequisites();

describe("no host rights — Parallels VM (INV-1)", () => {
	it("proves host sharing, guest mounts, C-3 networking, and clipboard behavior", {
		skip: prerequisiteReason ? `VM gate skipped: ${prerequisiteReason}` : false,
	}, async (testContext) => {
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
		let vmName;
		let originalClipboard;

		try {
			progress("acquiring the shared VM slot");
			try {
				slotLease = await slotPrimitive.acquire({
					platform: "macos",
					purpose: "inv-1-vm-gate",
				});
			} catch (error) {
				const message = String(error?.message ?? "");
				if (
					error?.code === "VM_SLOT_UNAVAILABLE" ||
					/slot.*(held|available|capacity)/i.test(message)
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
				providerUser: PROVIDER_USER,
			});
			backend.assertGoldenImageAvailable(GOLDEN_IMAGE);
			const runId = `inv1-${process.pid}-${randomUUID()}`;
			vmName = buildParallelsWorkingName(runId, process.pid);
			progress("creating and booting a full-copy working VM");
			vmUuid = backend.create(GOLDEN_IMAGE, {
				runId,
				aquaUid: AQUA_UID,
				providerUser: PROVIDER_USER,
				linked: false,
			});
			ok(vmUuid, "working VM must have a Parallels UUID handle");

			const info = listInfo(vmUuid);
			match(info, /Host Shared Folders:\s*\(-\)/);
			match(info, /Host defined sharing:\s*Off/);
			match(info, /Shared Profile:\s*\(-\)/);

			const mountOutput = outputText(
				backend.execGuest(vmUuid, "/sbin/mount", [], {
					cwd: "/",
					aquaUid: AQUA_UID,
					providerUser: PROVIDER_USER,
				}),
			);
			ok(
				!mountOutput.includes(homedir()),
				"guest mounts must not expose the host home",
			);
			ok(
				!/shared\s+folders|prl[_-]?(?:fs|shfs)/i.test(mountOutput),
				"guest mount table must not expose Parallels shared folders",
			);
			const hostPathProbe = outputText(
				backend.execGuest(
					vmUuid,
					"/bin/bash",
					[
						"-lc",
						`test ! -e ${shellQuote(homedir())} && test ! -e /var/run/docker.sock`,
					],
					{ cwd: "/", aquaUid: AQUA_UID, providerUser: PROVIDER_USER },
				),
			);
			strictEqual(
				hostPathProbe,
				"",
				"guest host-path probe must succeed without output",
			);

			const blockedEndpoints = [
				...C3_HOST_ENDPOINTS,
				C3_GATEWAY_ENDPOINT,
				C3_GUEST_SUBNET_ENDPOINT,
			];
			progress("running guest mount and C-3 network probes");
			const networkScript = [
				"set -eu",
				'probe_blocked() { ! /usr/bin/nc -G 3 -w 3 -z "$1" "$2" >/dev/null 2>&1; }',
				'probe_reachable() { /usr/bin/nc -G 5 -w 5 -z "$1" "$2" >/dev/null 2>&1; }',
				...blockedEndpoints.map(
					(endpoint) =>
						`probe_blocked ${shellQuote(endpoint.host)} ${shellQuote(endpoint.port)}`,
				),
				`probe_reachable ${shellQuote(C3_REACHABLE_ENDPOINT.host)} ${shellQuote(C3_REACHABLE_ENDPOINT.port)}`,
				`/usr/bin/dscacheutil -q host -a name ${shellQuote(C3_DNS_NAME)} | /usr/bin/grep -q '^ip_address:'`,
			].join("\n");
			backend.execGuest(vmUuid, "/bin/bash", ["-lc", networkScript], {
				cwd: "/",
				aquaUid: AQUA_UID,
				providerUser: PROVIDER_USER,
			});

			originalClipboard = execFileSync("pbpaste", [], { encoding: "utf8" });
			progress("running the behavioral clipboard probe");
			const sentinel = "switchyard-clipboard-sentinel";
			execFileSync("pbcopy", [], { input: sentinel });
			// The hardened image disables the Parallels clipboard agent, so an
			// empty guest pasteboard may make pbpaste exit non-zero. The gate is
			// sentinel non-visibility, matching the golden-image assertion.
			backend.execGuest(
				vmUuid,
				"/bin/bash",
				[
					"-lc",
					`set +e
/usr/bin/pbpaste 2>/dev/null | /usr/bin/grep -Fq ${shellQuote(sentinel)}
status=$?
if [ "$status" -eq 0 ]; then exit 1; fi
exit 0`,
				],
				{ cwd: "/", aquaUid: AQUA_UID, providerUser: PROVIDER_USER },
			);
		} finally {
			if (originalClipboard !== undefined) {
				try {
					execFileSync("pbcopy", [], { input: originalClipboard });
				} catch {
					// Preserve the original assertion failure if clipboard restoration fails.
				}
			}
			try {
				if (backend && vmUuid && vmName) {
					backend.rollback(vmName, vmUuid);
				}
			} finally {
				if (slotLease !== undefined && slotLease !== null) {
					if (typeof slotLease.release === "function")
						await slotLease.release();
					else await slotPrimitive.release(slotLease);
				}
			}
		}
	});
});
