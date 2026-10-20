// @test-phase: other
import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import {
	probeSandboxExecUsable,
	runSandboxCanary,
} from "../scripts/sandbox-canary.mjs";
import {
	DEFAULT_CANARY_DEADLINE_MS,
	runCanaryCli,
} from "../scripts/sandbox-canary-daily.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

it("distinguishes availability timeout, signal, spawn error and sandbox denial", () => {
	for (const [result, reason] of [
		[
			{ status: null, error: { code: "ETIMEDOUT" } },
			"sandbox_exec_probe_timed_out",
		],
		[{ status: null, signal: "SIGKILL" }, "sandbox_exec_probe_signalled"],
		[{ status: null, error: { code: "EACCES" } }, "sandbox_exec_spawn_error"],
		[{ status: 71 }, "sandbox_exec_failed_nested_or_restricted"],
		[
			{ status: 0, error: { code: "ETIMEDOUT" } },
			"sandbox_exec_probe_timed_out",
		],
	]) {
		const probe = probeSandboxExecUsable({
			platform: "darwin",
			sandboxExecPath: process.execPath,
			spawn: () => result,
		});
		strictEqual(probe.usable, false);
		strictEqual(probe.reason, reason);
		strictEqual(probe.evidence.timeoutMs, 5000);
		strictEqual(probe.evidence.exitCode, result.status);
	}
});

it("uses remaining canary budget for toolchain checks with live progress and strict failure", () => {
	const scratch = tempDir("gate-canary-");
	try {
		const testFile = join(scratch, "toolchain.test.mjs");
		writeFileSync(testFile, "");
		let toolchain;
		let now = 0;
		const outcome = runSandboxCanary({
			platform: "darwin",
			sandboxExecPath: process.execPath,
			scratchRoot: scratch,
			toolchainTestPath: testFile,
			clock: () => now,
			profileFactory: () => "fixture",
			environmentFactory: () => ({
				CI: "true",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				PATH: "/usr/bin",
			}),
			log: () => {},
			error: () => {},
			spawn(_command, args, options) {
				if (args.includes("--test-reporter=tap")) {
					toolchain = options;
					return { status: null, error: { code: "ETIMEDOUT" }, stdout: "" };
				}
				// Model time spent in the preceding probes, without a host load generator.
				now += 1000;
				if (args.some((a) => a.includes("canary_ok")))
					return { status: 0, stdout: "canary_ok" };
				if (args.some((a) => a.includes("quickCheckSandboxProfile")))
					return {
						status: 0,
						stdout: JSON.stringify({
							passwd: "ERR_SYSTEM_ERROR",
							imported: "function",
						}),
					};
				if (args.some((a) => a.includes("writeDenied")))
					return { status: 0, stdout: '{"writeDenied":true}' };
				return { status: 0 };
			},
		});
		strictEqual(toolchain.timeout, DEFAULT_CANARY_DEADLINE_MS - now);
		ok(toolchain.timeout > 120_000);
		strictEqual(toolchain.forwardOutput, true);
		ok(toolchain.progressLabel);
		strictEqual(outcome.status, "failed");
		const probe = outcome.results.find((p) => p.name === "toolchain-sandbox");
		strictEqual(probe.evidence.timedOut, true);
		strictEqual(probe.status, "failed");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("notification timeout names its tool and never reports canary success", () => {
	const scratch = tempDir("gate-notify-");
	try {
		const errors = [];
		const result = runCanaryCli({
			env: { SWITCHYARD_CANARY_DAILY: "1" },
			stateDir: scratch,
			log: () => {},
			error: (line) => errors.push(line),
			runCanary: () => ({
				status: "failed",
				exitCode: 1,
				reason: "probe_failed",
				results: [],
			}),
			notify: () => ({
				sent: false,
				error: "ETIMEDOUT",
				tool: "/fake/notifier",
			}),
		});
		strictEqual(result.exitCode, 1);
		ok(errors.some((line) => line.includes("ETIMEDOUT; tool=/fake/notifier")));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("logged pre-push preserves exit status, stdin isolation, PATH and Git cleanup", () => {
	const scratch = tempDir("gate-hook-");
	try {
		const bin = join(scratch, "bin");
		mkdirSync(bin);
		mkdirSync(join(scratch, "node_modules/.bin"), { recursive: true });
		writeFileSync(
			join(bin, "git"),
			'#!/bin/sh\ncase "$*" in\n*show-toplevel*) printf "%s\\n" "$HOOK_ROOT";;\n*local-env-vars*) echo GIT_DIR;;\n*short*) echo abc1234;;\nesac\n',
			{ mode: 0o755 },
		);
		writeFileSync(join(bin, "sysctl"), '#!/bin/sh\necho "{ 2 3 4 }"\n', {
			mode: 0o755,
		});
		writeFileSync(
			join(scratch, "node_modules/.bin/npm"),
			'#!/bin/sh\n[ -z "$GIT_DIR" ] || exit 91\n[ "$*" = "run validate:host" ] || exit 92\nif read -r input; then exit 93; fi\necho "not ok 1 - fixture failure"\nexit "$GATE_STATUS"\n',
			{ mode: 0o755 },
		);
		for (const status of [7, 0]) {
			const result = spawnSync("/bin/sh", [resolve(".githooks/pre-push")], {
				cwd: scratch,
				input: "hook input must not reach gate\n",
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					PATH: `${bin}:/usr/bin:/bin`,
					HOOK_ROOT: scratch,
					GIT_DIR: "/invalid",
					GATE_STATUS: String(status),
				},
			});
			strictEqual(result.status, status, result.stderr);
			ok(result.stdout.includes(".logs/pre-push-abc1234.log"));
			ok(
				result.stdout.includes(status ? "gate failed (exit 7)" : "gate passed"),
			);
			if (status) ok(result.stdout.includes("pre-push: load { 2 3 4 }"));
			ok(
				readFileSync(
					join(scratch, ".logs/pre-push-abc1234.log"),
					"utf8",
				).includes("not ok 1"),
			);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
