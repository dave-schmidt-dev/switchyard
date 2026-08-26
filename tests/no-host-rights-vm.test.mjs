// INV-1 gate test for the Parallels macOS backend.
//
// The host-side Parallels inspection is the direct filesystem proof: host
// shared folders must be disabled. The guest-side mount probe is retained as
// an independent observable check for a mount that the host report missed.
// The network and clipboard probes are also guest-side observations. They
// prove the golden image's C-3 posture, not host isolation: guest root can
// still change guest policy, and no guest probe can certify the host itself.
//
// The C-3 endpoint manifest is DERIVED and host-verified per run rather than
// configured, so the gate holds on any network this Mac attaches to. It is not
// a skip condition: a manifest that proves no block rule fails the gate.

import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { describe, it } from "node:test";

import {
	buildParallelsWorkingName,
	ParallelsExecutionBackend,
} from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { deriveC3Manifest, probeTcp } from "./helpers/c3-manifest.mjs";

const GOLDEN_IMAGE = process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE || "";
const PROVIDER_USER =
	process.env.SWITCHYARD_PARALLELS_PROVIDER_USER || "switchyard";
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

let configurationFault = null;

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
	if (!/^stopped$/i.test(golden[1])) {
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
	if (!(await loadSlotPrimitive()))
		return "shared VM-slot primitive is unavailable";
	// The C-3 manifest is deliberately absent from this ladder. It is derived
	// inside the gate and asserted there, so a derivation gap fails loudly
	// instead of reporting green through a skip.
	return null;
}

const prerequisiteReason = await inspectPrerequisites();

describe("no host rights — Parallels VM (INV-1)", () => {
	it("proves host sharing, guest mounts, C-3 networking, and clipboard behavior", {
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
		let vmName;
		let originalClipboard;
		let manifest;

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

			progress("deriving and host-verifying the C-3 endpoint manifest");
			manifest = await deriveC3Manifest();
			for (const entry of manifest.dropped) {
				progress(`C-3 candidate dropped (${entry.reason}): ${entry.value}`);
			}
			ok(
				manifest.coverage.length > 0,
				`C-3 manifest proved no block rule. Every candidate was dropped: ${
					manifest.dropped.map((entry) => entry.value).join(", ") ||
					"none found"
				}`,
			);
			// A reachable control the HOST cannot reach makes the guest's
			// allow-side probe meaningless, so verify it before trusting it.
			ok(
				await probeTcp(manifest.reachable.host, manifest.reachable.port, 5000),
				`C-3 reachable control ${manifest.reachable.value} is unreachable from the host`,
			);
			// Recorded, not implied: two of C-3's four block rules (172.16/12 and
			// 169.254/16) usually have no live target from any host, so a passing
			// gate is not evidence that the whole ruleset was exercised.
			progress(
				`C-3 blocked endpoints: ${manifest.blocked.map((endpoint) => `${endpoint.value} [${endpoint.cidr}]`).join(", ")}`,
			);
			progress(
				`C-3 block rules proven: ${manifest.coverage.join(", ")}; unproven: ${manifest.unproven.map((entry) => `${entry.label} (${entry.reason})`).join(", ") || "none"}`,
			);
			progress("running guest mount and C-3 network probes");
			const networkScript = [
				"set -eu",
				'probe_blocked() { ! /usr/bin/nc -G 3 -w 3 -z "$1" "$2" >/dev/null 2>&1; }',
				'probe_reachable() { /usr/bin/nc -G 5 -w 5 -z "$1" "$2" >/dev/null 2>&1; }',
				...manifest.blocked.map(
					(endpoint) =>
						`probe_blocked ${shellQuote(endpoint.host)} ${shellQuote(endpoint.port)}`,
				),
				`probe_reachable ${shellQuote(manifest.reachable.host)} ${shellQuote(manifest.reachable.port)}`,
				`/usr/bin/dscacheutil -q host -a name ${shellQuote(manifest.dnsName)} | /usr/bin/grep -q '^ip_address:'`,
			].join("\n");
			backend.execGuest(vmUuid, "/bin/bash", ["-lc", networkScript], {
				cwd: "/",
				aquaUid: AQUA_UID,
				providerUser: PROVIDER_USER,
			});

			originalClipboard = execFileSync("pbpaste", [], { encoding: "utf8" });
			progress("running the behavioral clipboard probe");
			// A per-run unique sentinel. A fixed literal cannot distinguish a live
			// leak from a stale value an earlier run left on the guest pasteboard,
			// so the probe would report the same verdict for two different faults.
			const sentinel = `switchyard-clipboard-sentinel-${randomUUID()}`;
			execFileSync("pbcopy", [], { input: sentinel });
			// The hardened image disables the Parallels clipboard agent, so an
			// empty guest pasteboard may make pbpaste exit non-zero. The gate is
			// sentinel non-visibility, matching the golden-image assertion.
			//
			// The probe reports its verdict on stdout and always exits 0, so a
			// transport failure cannot masquerade as a clipboard leak. Signalling
			// through the exit code made both surface as the same opaque
			// `Command failed` with empty output, which is unactionable.
			const clipboardProbe = outputText(
				backend.execGuest(
					vmUuid,
					"/bin/bash",
					[
						"-lc",
						`set +e
paste="$(/usr/bin/pbpaste 2>/dev/null)"
origin=guest
test -e ${shellQuote(homedir())} && origin=HOST
user="$(/usr/bin/whoami)"
if printf %s "$paste" | /usr/bin/grep -Fq ${shellQuote(sentinel)}; then
	verdict=sentinel-visible
else
	verdict=sentinel-absent
fi
printf 'clipboard-probe: %s origin=%s user=%s bytes=%s\\n' "$verdict" "$origin" "$user" "$(printf %s "$paste" | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
exit 0`,
					],
					{ cwd: "/", aquaUid: AQUA_UID, providerUser: PROVIDER_USER },
				),
			);
			// Read the origin first. A probe that accidentally observed the HOST
			// pasteboard would report the sentinel byte-for-byte and be
			// indistinguishable from a real guest leak, so separate the two.
			//
			// Absence of the host home is necessary but not sufficient on its own,
			// so pair it with a positive identity: guest execution runs as the
			// non-admin provider account, which the host session never is.
			match(
				clipboardProbe,
				new RegExp(`user=${PROVIDER_USER}\\b`),
				`clipboard probe did not run as the provider account; it reported: ${JSON.stringify(clipboardProbe.trim())}`,
			);
			match(
				clipboardProbe,
				/origin=guest/,
				`clipboard probe did not execute in the guest; it reported: ${JSON.stringify(clipboardProbe.trim())}`,
			);
			match(
				clipboardProbe,
				/clipboard-probe: sentinel-absent/,
				`host clipboard must not be visible in the guest; probe reported: ${JSON.stringify(clipboardProbe.trim())}`,
			);
		} finally {
			if (manifest) {
				try {
					await manifest.close();
				} catch {
					// Never let listener teardown strand the working VM or the
					// shared slot released further down this chain.
				}
			}
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
