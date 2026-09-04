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

import { match, ok } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

const GATES = [
	"tests/no-host-rights-vm.test.mjs",
	"tests/workspace-wipe-vm.test.mjs",
	"tests/detached-dispatch.test.mjs",
];

describe("VM gate prerequisite ladders", () => {
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
