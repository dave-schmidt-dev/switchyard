import { deepStrictEqual, match, strictEqual } from "node:assert/strict";

import { describe, it } from "node:test";

import { probeHostProcessIdentity } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

const TEST_BOOT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TEST_RUN_STORE_ROOT = tempDir("switchyard-ownership-store-");

process.env.SWITCHYARD_RUN_STORE_ROOT = TEST_RUN_STORE_ROOT;

function probeChild(value, overrides = {}) {
	return {
		status: 0,
		signal: null,
		stdout: JSON.stringify(value),
		stderr: "ignored fixture stderr",
		...overrides,
	};
}

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
