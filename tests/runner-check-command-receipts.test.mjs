// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { after, describe, it } from "node:test";
import { runCommand } from "../src/switchyard/runner/reliability.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// The quick-check worker receipt `runCommand` returns to provider
// qualification. Kept from the retired queue reliability contract (O1): the
// receipt shape is the only thing the caller trusts about a check process.

const TEST_DIR = tempDir("switchyard-check-receipts-");

function commandFromScript(
	script,
	{ timeout = HANG_GUARD_MS, maxBuffer = 1024 } = {},
) {
	mkdirSync(TEST_DIR, { recursive: true });
	return runCommand(TEST_DIR, process.env, ["node", "--version"], 100, {
		sandbox: false,
		spawnSync: (_command, _args, options) =>
			spawnSync(process.execPath, ["-e", script], {
				...options,
				timeout,
				maxBuffer,
			}),
	});
}
after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("quick-check command receipts", () => {
	it("distinguishes an outer timeout from worker overflow and nonzero exit", () => {
		const timeout = commandFromScript("setTimeout(() => {}, 60_000)", {
			timeout: 50,
		});
		strictEqual(timeout.timedOut, true);
		strictEqual(timeout.groupCleanup, "unknown");

		const overflow = commandFromScript(
			'process.stdout.write("x".repeat(100_000))',
		);
		strictEqual(overflow.timedOut, false);
		strictEqual(overflow.groupCleanup, "unknown");

		const nonzero = commandFromScript("process.exitCode = 7");
		strictEqual(nonzero.timedOut, false);
		strictEqual(nonzero.groupCleanup, "unknown");
	});

	it("accepts only closed worker receipts and drops malformed ones", () => {
		const value = {
			exitCode: null,
			signal: "SIGTERM",
			timedOut: true,
			groupCleanup: "complete",
		};
		const closed = runCommand(
			TEST_DIR,
			process.env,
			["node", "--version"],
			100,
			{
				sandbox: false,
				spawnSync: () => ({ status: 0, stdout: JSON.stringify(value) }),
			},
		);
		deepStrictEqual(closed, value);

		const malformed = runCommand(
			TEST_DIR,
			process.env,
			["node", "--version"],
			100,
			{
				sandbox: false,
				spawnSync: () => ({
					status: 0,
					stdout: JSON.stringify({
						...value,
						transcript: "private worker output",
					}),
				}),
			},
		);
		deepStrictEqual(malformed, {
			exitCode: null,
			signal: null,
			timedOut: false,
			groupCleanup: "unknown",
		});
		strictEqual(
			JSON.stringify(malformed).includes("private worker output"),
			false,
		);
	});
});
