import { ok, strictEqual } from "node:assert/strict";

import { spawnSync } from "node:child_process";

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { describe, it } from "node:test";

import { BULK_TRANSFER_HELPER } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";

import { tempDir } from "./helpers/tempdir.mjs";

const TEST_RUN_STORE_ROOT = tempDir("switchyard-ownership-store-");

process.env.SWITCHYARD_RUN_STORE_ROOT = TEST_RUN_STORE_ROOT;

describe("bulk-transfer helper misfire tolerance", () => {
	const MISFIRE_LINE =
		"PrlJob_GetRetCode: Invalid argument. An invalid argument was passed.";

	function stubPrlctl(root) {
		const binDir = join(root, "bin");
		const counterPath = join(root, "invocations");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(counterPath, "0");
		writeFileSync(
			join(binDir, "prlctl"),
			[
				"#!/bin/sh",
				'n=$(cat "$STUB_COUNTER")',
				"n=$((n+1))",
				'printf %s "$n" > "$STUB_COUNTER"',
				'if [ "$n" -le "$STUB_FAIL_UNTIL" ]; then',
				`  echo "${MISFIRE_LINE}" >&2`,
				"  exit 255",
				"fi",
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		return {
			binDir,
			counterPath,
			invocations: () => Number(readFileSync(counterPath, "utf8")),
		};
	}

	function runHelper({ failUntil, retryAttempts }) {
		const root = tempDir("switchyard-bulk-helper-");
		try {
			const stub = stubPrlctl(root);
			const payload = Buffer.from("payload-bytes");
			const config = {
				direction: "push",
				transferHost: "127.0.0.1",
				listenHost: "127.0.0.1",
				maxBytes: 1024 * 1024,
				misfireSource: "PrlJob_(?:GetRetCode|GetResult):\\s*Invalid argument",
				retryAttempts,
				retryBackoffMs: 1,
				guestArgs: ["exec", "vm-1", "/usr/bin/curl", "TRANSFER_URL"],
				pfArgs: ["exec", "vm-1", "/sbin/pfctl", "-a", "anchor", "-f", "-"],
				cleanupArgs: [
					"exec",
					"vm-1",
					"/sbin/pfctl",
					"-a",
					"anchor",
					"-F",
					"all",
				],
			};
			const result = spawnSync(
				process.execPath,
				["--input-type=module", "-e", BULK_TRANSFER_HELPER],
				{
					input: Buffer.concat([
						Buffer.from(`${JSON.stringify(config)}\n`, "utf8"),
						payload,
					]),
					encoding: null,
					env: {
						...process.env,
						PATH: `${stub.binDir}:${process.env.PATH}`,
						STUB_COUNTER: stub.counterPath,
						STUB_FAIL_UNTIL: String(failUntil),
					},
				},
			);
			return {
				status: result.status,
				stdout: (result.stdout ?? Buffer.alloc(0)).toString("utf8"),
				stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
				invocations: stub.invocations(),
				payloadBytes: payload.length,
			};
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("absorbs a misfire and completes the transfer", () => {
		// Two misfires, then the pf load lands on the third try; the guest call
		// and the anchor flush then succeed. Five invocations for three commands
		// is the retry doing its job.
		const run = runHelper({ failUntil: 2, retryAttempts: 4 });

		strictEqual(run.status, 0, run.stderr);
		strictEqual(run.invocations, 5);
		const receipt = JSON.parse(run.stdout.split("\n")[0]);
		strictEqual(receipt.bytes, run.payloadBytes);
	});

	it("stops at the configured attempt bound and reports what it tried", () => {
		// A misfire that never clears is a real failure, and the run record has
		// to be able to say so rather than retry forever.
		const run = runHelper({ failUntil: 99, retryAttempts: 3 });

		strictEqual(run.status, 1);
		ok(
			/bulk transfer failed after 3 attempt\(s\)/.test(run.stderr),
			`attempt count was not reported: ${run.stderr}`,
		);
		ok(/PrlJob_GetRetCode/.test(run.stderr), run.stderr);
		// Three pf attempts plus the best-effort cleanup, which is not retried.
		strictEqual(run.invocations, 4);
	});

	it("does not retry a failure that is not a misfire", () => {
		const run = runHelper({ failUntil: 0, retryAttempts: 4 });
		strictEqual(run.status, 0, run.stderr);
		strictEqual(run.invocations, 3);
	});
});
