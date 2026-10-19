// @test-phase: other
import { ok, strictEqual } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	quickCheckSandboxProfile,
	safeEnv,
} from "../src/switchyard/runner/checks-sandbox.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const PYTHON = "/opt/homebrew/bin/python3";
// Reads KERN_PROCARGS2 (49) and KERN_PROCARGS (38) of one pid by numeric MIB,
// the way `ps -E` does, and reports only how often the marker appears.
const PROBE = `
import ctypes, json, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
pid, marker = int(sys.argv[1]), sys.argv[2].encode()
argmax = ctypes.c_int(0)
size = ctypes.c_size_t(ctypes.sizeof(argmax))
if libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0 or argmax.value <= 0:
    argmax.value = 1 << 18
report = {}
for name, oid in (("procargs2", 49), ("procargs", 38)):
    size = ctypes.c_size_t(argmax.value)
    buffer = ctypes.create_string_buffer(size.value)
    rc = libc.sysctl((ctypes.c_int * 3)(1, oid, pid), 3, buffer, ctypes.byref(size), None, 0)
    report[name] = {"rc": rc, "markers": buffer.raw[: size.value].count(marker) if rc == 0 else 0}
print(json.dumps(report))
`;

const root = tempDir("sy-check-procargs-");
// The marker stands in for a secret a host process holds in its environment
// (for example a child of bws-secret-exec). It is never printed, only counted.
const marker = `SWY_PROCARGS_MARKER_${randomBytes(12).toString("hex")}`;
let host;

function probe(pid, profile) {
	const clone = join(root, "clone");
	const runtime = join(root, "runtime");
	mkdirSync(clone, { recursive: true });
	mkdirSync(runtime, { recursive: true });
	const argv = [PYTHON, "-I", "-c", PROBE, String(pid), marker];
	const result = profile
		? spawnSync(
				"/usr/bin/sandbox-exec",
				["-p", profile(clone, runtime), ...argv],
				{
					cwd: clone,
					env: safeEnv(runtime),
					encoding: "utf8",
					timeout: HANG_GUARD_MS,
				},
			)
		: spawnSync(argv[0], argv.slice(1), {
				encoding: "utf8",
				timeout: HANG_GUARD_MS,
			});
	strictEqual(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

describe("quick-check sandbox and other processes' arguments", {
	skip: nestedSandboxSkip,
}, () => {
	before(async () => {
		host = spawn(
			process.execPath,
			["-e", `setTimeout(() => {}, ${HANG_GUARD_MS}) // ${marker}`],
			{ env: { ...process.env, [marker]: "1" }, stdio: "ignore" },
		);
		await new Promise((resolve, reject) => {
			host.once("spawn", resolve);
			host.once("error", reject);
		});
	});
	after(() => {
		host?.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	});

	it("reads the host marker process's arguments outside the sandbox", () => {
		// Positive control: without it a broken probe would pass the checks below.
		const report = probe(host.pid);
		strictEqual(report.procargs2.rc, 0);
		ok(report.procargs2.markers >= 2, "argv and environment both visible");
	});

	// Known gap, accepted by the owner on 2026-10-19 (README threat model):
	// Seatbelt does not mediate these reads, and any sysctl-read allow puts the
	// numeric sysctl syscall back in the mask. A fix must move the check to
	// another uid, so this probe would then go through the engine's launch.
	const todo =
		"known gap: Seatbelt cannot block KERN_PROCARGS2 (README threat model)";
	for (const [name, command] of [
		["the base profile", undefined],
		["the xcodebuild build profile", "xcodebuild build"],
	]) {
		it(`hides a host process's argv and environment under ${name}`, {
			todo,
		}, () => {
			const report = probe(host.pid, (clone, runtime) =>
				quickCheckSandboxProfile(clone, runtime, [], { command }),
			);
			strictEqual(report.procargs2.markers, 0, "KERN_PROCARGS2 leaked");
			strictEqual(report.procargs.markers, 0, "KERN_PROCARGS leaked");
		});
	}
});
