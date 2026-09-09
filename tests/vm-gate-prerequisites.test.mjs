// Guards the VM gates' prerequisite ladders against the
// env-var-unset-means-silent-green shape.
//
// Every one of these gates reads SWITCHYARD_PARALLELS_AQUA_UID. Until 2026-08-26
// an unset or malformed value returned a SKIP reason, so the INV-1 clipboard,
// mount, and C-3 assertions reported green having proven nothing. It passed
// locally only because ~/.zshrc exports the variable, which means any
// non-interactive shell, CI runner, or launchd context silently lost the gate.
//
// Two assertions, deliberately: a source guard that always runs, and a
// behavioral probe that runs only where the ladder can actually reach the Aqua
// rung. The source guard exists so this file can never itself go vacuously
// green on a host without Parallels.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const { acquireVmSlotForTest, projectVmGateOutcome } = await import(
	"../src/switchyard/run-store/index.mjs"
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

const GATES = [
	"tests/no-host-rights-vm.test.mjs",
	"tests/workspace-wipe-vm.test.mjs",
	"tests/detached-dispatch.test.mjs",
];

describe("VM gate prerequisite ladders", () => {
	it("waits with bounded observable progress and uses the production slot result", async () => {
		let now = 0;
		let attempts = 0;
		const statuses = [];
		const result = await acquireVmSlotForTest({
			runId: "vm-gate-wait",
			timeoutMs: 20,
			intervalMs: 5,
			nowFn: () => now,
			sleepFn: (delayMs) => {
				now += delayMs;
			},
			onStatus: (event) => statuses.push(event),
			acquireFn: () => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("capacity");
					error.code = "VM_SLOT_UNAVAILABLE";
					throw error;
				}
				return { token: "test-lease" };
			},
		});

		strictEqual(result.status, "executed");
		strictEqual(result.lease.token, "test-lease");
		deepStrictEqual(
			statuses.map((event) => event.elapsedMs),
			[0, 5],
		);
		strictEqual(attempts, 3);
	});

	it("returns unavailable-with-proof only after the bounded wait expires", async () => {
		let now = 0;
		const statuses = [];
		const result = await acquireVmSlotForTest({
			runId: "vm-gate-timeout",
			timeoutMs: 10,
			intervalMs: 5,
			nowFn: () => now,
			sleepFn: (delayMs) => {
				now += delayMs;
			},
			onStatus: (event) => statuses.push(event),
			acquireFn: () => {
				const error = new Error("capacity");
				error.code = "VM_SLOT_UNAVAILABLE";
				throw error;
			},
		});

		strictEqual(result.status, "unavailable-with-proof");
		strictEqual(result.reason, "vm_slot_unavailable");
		strictEqual(result.elapsedMs, 10);
		strictEqual(statuses.length, 3);
	});

	it("does not treat an idle host with no gate execution as a green result", () => {
		deepStrictEqual(projectVmGateOutcome({ executed: true }), {
			status: "executed",
		});
		deepStrictEqual(
			projectVmGateOutcome({ unavailableReason: "both VM slots are held" }),
			{ status: "unavailable-with-proof", reason: "both VM slots are held" },
		);
		deepStrictEqual(projectVmGateOutcome(), {
			status: "failed",
			reason: "missing-unavailability-proof",
		});
	});

	it("never returns a skip reason derived from the Aqua uid", () => {
		for (const gate of GATES) {
			const source = readFileSync(resolve(PKG_ROOT, gate), "utf8");
			ok(
				/AQUA_UID/.test(source),
				`${gate} must still read the Aqua uid for this guard to mean anything`,
			);
			// A `return` carrying the Aqua uid's name is the exact regression:
			// the ladder's return value becomes node:test's `skip` reason.
			const skipReturn =
				/return\s+[`"'][^`"']*(?:Aqua|AQUA_UID)[^`"']*[`"']\s*;/.test(source);
			ok(
				!skipReturn,
				`${gate} returns a skip reason for the Aqua uid; it must assign a configuration fault instead`,
			);
			ok(
				/onfigurationFault\s*=/.test(source),
				`${gate} must assign a configuration fault`,
			);
		}
	});

	it("fails rather than skips when the Aqua uid is unset", (testContext) => {
		const golden = "switchyard-vm-gate-prerequisite-test";
		const binDir = tempDir("switchyard-prlctl-");
		const prlctl = join(binDir, "prlctl");
		writeFileSync(
			prlctl,
			`#!/bin/sh
case "$1" in
  --version) exit 0 ;;
  list) printf 'test-uuid stopped ${golden}\\n' ;;
esac
`,
		);
		chmodSync(prlctl, 0o755);
		testContext.after(() => rmSync(binDir, { force: true, recursive: true }));

		const env = { ...process.env };
		env.PATH = `${binDir}:${env.PATH || ""}`;
		env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE = golden;
		delete env.SWITCHYARD_SKIP_LIVE_VM_TESTS;
		// Unset, not empty: an empty string is a different rung.
		delete env.SWITCHYARD_PARALLELS_AQUA_UID;
		// node:test marks child processes it spawns via NODE_TEST_CONTEXT, which
		// makes the child report to the parent runner and exit 0 regardless of
		// its own failures. Without this the probe passes vacuously.
		delete env.NODE_TEST_CONTEXT;

		const result = spawnSync(
			process.execPath,
			["--test", "tests/no-host-rights-vm.test.mjs"],
			{ cwd: PKG_ROOT, env, encoding: "utf8", timeout: 120_000 },
		);
		const output = `${result.stdout || ""}${result.stderr || ""}`;
		ok(
			result.status !== 0,
			`the gate must exit non-zero with the Aqua uid unset, got ${result.status}`,
		);
		match(
			output,
			/SWITCHYARD_PARALLELS_AQUA_UID must be set/,
			"the failure must name the missing variable",
		);
		ok(
			!/# skipped 1/.test(output) || /# fail [1-9]/.test(output),
			"the gate must report a failure, not a skip",
		);
	});
});
