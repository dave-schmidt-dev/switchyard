// @test-phase: serial
import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	evaluateCanaryResults,
	parseTapResults,
	probeSandboxExecUsable,
	runSandboxCanary,
} from "../scripts/sandbox-canary.mjs";
import {
	quickCheckSandboxProfile,
	safeEnv,
} from "../src/switchyard/runner/checks-sandbox.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

describe("sandbox canary evaluation contract", () => {
	it("evaluates to passed when all probes pass", () => {
		const results = [
			{ name: "p1", status: "passed" },
			{ name: "p2", status: "passed" },
		];
		const evalResult = evaluateCanaryResults(results);
		strictEqual(evalResult.status, "passed");
		strictEqual(evalResult.exitCode, 0);
		strictEqual(evalResult.passedCount, 2);
		strictEqual(evalResult.failedCount, 0);
		strictEqual(evalResult.skippedCount, 0);
	});

	it("evaluates to failed when any probe fails", () => {
		const results = [
			{ name: "p1", status: "passed" },
			{ name: "p2", status: "failed", error: "denied" },
		];
		const evalResult = evaluateCanaryResults(results);
		strictEqual(evalResult.status, "failed");
		strictEqual(evalResult.exitCode, 1);
		ok(evalResult.reason.includes("probe_failed: p2"));
	});

	it("strictly fails when ALL probes are skipped or unavailable", () => {
		const results = [
			{ name: "p1", status: "skipped", reason: "no darwin" },
			{ name: "p2", status: "unavailable", reason: "nested sandbox" },
		];
		const evalResult = evaluateCanaryResults(results);
		strictEqual(evalResult.status, "failed");
		strictEqual(evalResult.exitCode, 1);
		strictEqual(evalResult.reason, "all_skipped_or_unavailable");
	});

	it("fails when a required probe is skipped despite another passing", () => {
		const results = [
			{ name: "p1", status: "passed" },
			{ name: "p2", status: "skipped" },
		];
		const evalResult = evaluateCanaryResults(results);
		strictEqual(evalResult.status, "failed");
		strictEqual(evalResult.exitCode, 1);
		strictEqual(evalResult.reason, "probe_skipped_or_unavailable");
		strictEqual(evalResult.passedCount, 1);
		strictEqual(evalResult.skippedCount, 1);
	});
});

describe("parseTapResults helper", () => {
	it("parses passing TAP test output with summary", () => {
		const tap = `
TAP version 13
# Subtest: quick-check toolchain sandbox
    ok 1 - runs toolchain
    ok 2 - reads openssl
    ok 3 - denies write
    1..3
ok 1 - quick-check toolchain sandbox
1..1
# tests 3
# suites 1
# pass 3
# fail 0
`;
		const parsed = parseTapResults(tap);
		strictEqual(parsed.summaryPassed, 3);
		strictEqual(parsed.summaryFailed, 0);
		strictEqual(parsed.passedCount, 4); // 3 tests + 1 suite
	});

	it("parses skipped suite with 0 passing tests", () => {
		const tap = `
TAP version 13
ok 1 - quick-check toolchain sandbox # SKIP requires Xcode
1..1
# tests 0
# suites 1
# pass 0
# fail 0
`;
		const parsed = parseTapResults(tap);
		strictEqual(parsed.summaryPassed, 0);
		strictEqual(parsed.summaryFailed, 0);
		strictEqual(parsed.skippedCount, 1);
	});

	it("parses failing TAP test output", () => {
		const tap = `
TAP version 13
not ok 1 - test failed
# fail 1
# pass 0
`;
		const parsed = parseTapResults(tap);
		strictEqual(parsed.failedCount, 1);
		strictEqual(parsed.summaryFailed, 1);
		strictEqual(parsed.summaryPassed, 0);
	});
});

describe("runSandboxCanary with injected fixtures", () => {
	it("executes injected probes and reports passed", () => {
		const outcome = runSandboxCanary({
			probes: [
				{ name: "mock-probe-1", run: () => ({ status: "passed" }) },
				{ name: "mock-probe-2", run: () => ({ status: "passed" }) },
			],
			log: () => {},
		});
		strictEqual(outcome.status, "passed");
		strictEqual(outcome.exitCode, 0);
		strictEqual(outcome.passedCount, 2);
	});

	it("executes injected probes and reports failed on probe failure", () => {
		const outcome = runSandboxCanary({
			probes: [
				{
					name: "failing-probe",
					run: () => ({ status: "failed", error: "simulated failure" }),
				},
			],
			log: () => {},
		});
		strictEqual(outcome.status, "failed");
		strictEqual(outcome.exitCode, 1);
		strictEqual(outcome.failedCount, 1);
	});

	it("strictly fails when all injected probes are skipped", () => {
		const outcome = runSandboxCanary({
			probes: [
				{
					name: "skipped-probe-1",
					run: () => ({ status: "skipped", reason: "unavailable" }),
				},
				{
					name: "skipped-probe-2",
					run: () => ({ status: "unavailable", reason: "offline" }),
				},
			],
			log: () => {},
		});
		strictEqual(outcome.status, "failed");
		strictEqual(outcome.exitCode, 1);
		strictEqual(outcome.reason, "all_skipped_or_unavailable");
	});

	it("handles an injected probe that throws an exception", () => {
		const outcome = runSandboxCanary({
			probes: [
				{
					name: "throwing-probe",
					run: () => {
						throw new Error("unhandled crash");
					},
				},
			],
			log: () => {},
		});
		strictEqual(outcome.status, "failed");
		strictEqual(outcome.exitCode, 1);
		strictEqual(outcome.failedCount, 1);
	});

	it("detects probeSandboxExecUsable non-darwin or missing binary", () => {
		const linuxProbe = probeSandboxExecUsable({ platform: "linux" });
		strictEqual(linuxProbe.usable, false);
		strictEqual(linuxProbe.reason, "unsupported_platform_not_darwin");

		const missingProbe = probeSandboxExecUsable({
			platform: "darwin",
			sandboxExecPath: "/nonexistent/sandbox-exec",
		});
		strictEqual(missingProbe.usable, false);
		strictEqual(missingProbe.reason, "sandbox_exec_missing");
	});

	it("bounds probeSandboxExecUsable with timeout and logs progress", () => {
		const logged = [];
		let capturedTimeout = null;
		const mockSpawn = (_cmd, _args, opts) => {
			capturedTimeout = opts?.timeout;
			return { status: 0 };
		};
		const probe = probeSandboxExecUsable({
			platform: "darwin",
			sandboxExecPath: "/usr/bin/sandbox-exec",
			spawn: mockSpawn,
			timeoutMs: 3000,
			log: (msg) => logged.push(msg),
		});
		strictEqual(probe.usable, true);
		strictEqual(capturedTimeout, 3000);
		ok(logged.some((m) => m.includes("Probing sandbox-exec availability")));
	});

	it("executes toolchain test probe, parses TAP, and requires executed cases", () => {
		const scratch = tempDir("sy-canary-mock-test-");
		const testFile = join(scratch, "dummy.test.mjs");
		writeFileSync(testFile, "console.log('mock test file');");

		const logs = [];
		const mockSpawn = (cmd, args) => {
			if (cmd === "/usr/bin/sandbox-exec") {
				if (
					args.includes("-e") &&
					args.includes('process.stdout.write("canary_ok")')
				) {
					return { status: 0, stdout: "canary_ok" };
				}
				if (
					args.some(
						(a) =>
							typeof a === "string" && a.includes("quickCheckSandboxProfile"),
					)
				) {
					return {
						status: 0,
						stdout: JSON.stringify({
							passwd: "ERR_SYSTEM_ERROR",
							imported: "function",
						}),
					};
				}
				if (
					args.some((a) => typeof a === "string" && a.includes("writeDenied"))
				) {
					return { status: 0, stdout: JSON.stringify({ writeDenied: true }) };
				}
				return { status: 0 };
			}
			if (args?.includes("--test-reporter=tap")) {
				return {
					status: 0,
					stdout:
						"TAP version 13\nok 1 - toolchain passed\n# pass 1\n# fail 0\n",
				};
			}
			return { status: 0 };
		};

		try {
			const outcome = runSandboxCanary({
				scratchRoot: scratch,
				spawn: mockSpawn,
				profileFactory: () => "fixture-only",
				environmentFactory: () => ({
					CI: "true",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					PATH: "/usr/bin",
				}),
				platform: "darwin",
				toolchainTestPath: testFile,
				log: (msg) => logs.push(msg),
			});

			strictEqual(outcome.status, "passed");
			strictEqual(outcome.failedCount, 0);
			const toolchainProbe = outcome.results.find(
				(r) => r.name === "toolchain-sandbox",
			);
			ok(toolchainProbe);
			strictEqual(toolchainProbe.status, "passed");
			strictEqual(toolchainProbe.executedCases, 1);
			ok(toolchainProbe.evidence);
			strictEqual(toolchainProbe.evidence.passed, true);
			ok(logs.some((m) => m.includes("Running probe: toolchain-sandbox")));
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("strictly fails when toolchain test suite executes 0 cases (skipped suite)", () => {
		const scratch = tempDir("sy-canary-mock-skip-");
		const testFile = join(scratch, "dummy.test.mjs");
		writeFileSync(testFile, "console.log('mock test file');");

		const mockSpawn = (cmd, args) => {
			if (cmd === "/usr/bin/sandbox-exec") {
				if (
					args.includes("-e") &&
					args.includes('process.stdout.write("canary_ok")')
				) {
					return { status: 0, stdout: "canary_ok" };
				}
				if (
					args.some(
						(a) =>
							typeof a === "string" && a.includes("quickCheckSandboxProfile"),
					)
				) {
					return {
						status: 0,
						stdout: JSON.stringify({
							passwd: "ERR_SYSTEM_ERROR",
							imported: "function",
						}),
					};
				}
				if (
					args.some((a) => typeof a === "string" && a.includes("writeDenied"))
				) {
					return { status: 0, stdout: JSON.stringify({ writeDenied: true }) };
				}
				return { status: 0 };
			}
			if (args?.includes("--test-reporter=tap")) {
				return {
					status: 0,
					stdout:
						"TAP version 13\nok 1 - toolchain skipped # SKIP no xcode\n# pass 0\n# fail 0\n",
				};
			}
			return { status: 0 };
		};

		try {
			const outcome = runSandboxCanary({
				scratchRoot: scratch,
				spawn: mockSpawn,
				profileFactory: () => "fixture-only",
				environmentFactory: () => ({
					CI: "true",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					PATH: "/usr/bin",
				}),
				platform: "darwin",
				toolchainTestPath: testFile,
				log: () => {},
				error: () => {},
			});

			strictEqual(outcome.status, "failed");
			const toolchainProbe = outcome.results.find(
				(r) => r.name === "toolchain-sandbox",
			);
			ok(toolchainProbe);
			strictEqual(toolchainProbe.status, "failed");
			ok(
				toolchainProbe.error.includes(
					"toolchain_suite_skipped_or_zero_executed_cases",
				),
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("strictly fails when toolchain test subprocess times out or exits non-zero", () => {
		const scratch = tempDir("sy-canary-mock-fail-");
		const testFile = join(scratch, "dummy.test.mjs");
		writeFileSync(testFile, "console.log('mock test file');");

		const mockSpawn = (cmd, args) => {
			if (cmd === "/usr/bin/sandbox-exec") {
				if (
					args.includes("-e") &&
					args.includes('process.stdout.write("canary_ok")')
				) {
					return { status: 0, stdout: "canary_ok" };
				}
				if (
					args.some(
						(a) =>
							typeof a === "string" && a.includes("quickCheckSandboxProfile"),
					)
				) {
					return {
						status: 0,
						stdout: JSON.stringify({
							passwd: "ERR_SYSTEM_ERROR",
							imported: "function",
						}),
					};
				}
				if (
					args.some((a) => typeof a === "string" && a.includes("writeDenied"))
				) {
					return { status: 0, stdout: JSON.stringify({ writeDenied: true }) };
				}
				return { status: 0 };
			}
			if (args?.includes("--test-reporter=tap")) {
				return {
					status: 1,
					stderr: "cargo check failed",
					stdout: "TAP version 13\nnot ok 1 - test\n# pass 0\n# fail 1\n",
				};
			}
			return { status: 0 };
		};

		try {
			const outcome = runSandboxCanary({
				scratchRoot: scratch,
				spawn: mockSpawn,
				profileFactory: () => "fixture-only",
				environmentFactory: () => ({
					CI: "true",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					PATH: "/usr/bin",
				}),
				platform: "darwin",
				toolchainTestPath: testFile,
				log: () => {},
				error: () => {},
			});

			strictEqual(outcome.status, "failed");
			const toolchainProbe = outcome.results.find(
				(r) => r.name === "toolchain-sandbox",
			);
			ok(toolchainProbe);
			strictEqual(toolchainProbe.status, "failed");
			ok(toolchainProbe.evidence);
			strictEqual(toolchainProbe.evidence.exitCode, 1);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("host canary environment and profile configuration", {
	skip: nestedSandboxSkip,
}, () => {
	it("generates valid safeEnv with required git and isolation settings", () => {
		const scratch = tempDir("sy-canary-env-test-");
		try {
			const env = safeEnv(scratch);
			strictEqual(env.CI, "true");
			strictEqual(env.GIT_CONFIG_NOSYSTEM, "1");
			strictEqual(env.GIT_CONFIG_GLOBAL, "/dev/null");
			strictEqual(env.GIT_TERMINAL_PROMPT, "0");
			strictEqual(env.CARGO_NET_OFFLINE, "true");
			ok(env.TMPDIR.endsWith(scratch.split("/").pop()));
			ok(typeof env.PATH === "string" && env.PATH.length > 0);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("generates quickCheckSandboxProfile denying write outside clone and runtime", () => {
		const scratch = tempDir("sy-canary-prof-test-");
		try {
			const clone = join(scratch, "clone");
			const runtime = join(scratch, "runtime");
			mkdirSync(clone, { recursive: true });
			mkdirSync(runtime, { recursive: true });
			const profile = quickCheckSandboxProfile(clone, runtime);
			ok(profile.includes("(version 1)"));
			ok(profile.includes("(deny default)"));
			ok(profile.includes("(allow process-exec)"));
			ok(profile.includes("(allow process-fork)"));
			ok(!profile.includes("network-outbound"));
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("real host profile probe (captain gate)", {
	skip: nestedSandboxSkip,
}, () => {
	it("executes real host sandbox canary probes outside confinement", () => {
		const outcome = runSandboxCanary();
		strictEqual(outcome.status, "passed");
		strictEqual(outcome.exitCode, 0);
		ok(outcome.passedCount >= 4);
	});
});

it("reports toolchain timeout as closed failure and bounds every subprocess", () => {
	const scratch = tempDir("sy-canary-timeout-");
	const timeouts = [];
	let calls = 0;
	try {
		const outcome = runSandboxCanary({
			scratchRoot: scratch,
			platform: "darwin",
			profileFactory: () => "fixture",
			environmentFactory: () => ({
				CI: "true",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				PATH: "/usr/bin",
			}),
			toolchainTestPath: import.meta.filename,
			deadlineMs: 500,
			log: () => {},
			spawn: (_command, _args, options) => {
				timeouts.push(options.timeout);
				calls++;
				if (calls === 1) return { status: 0 };
				if (calls === 2) return { status: 0, stdout: "canary_ok" };
				if (calls === 3)
					return {
						status: 0,
						stdout: JSON.stringify({
							passwd: "ERR_SYSTEM_ERROR",
							imported: "function",
						}),
					};
				if (calls === 4)
					return { status: 0, stdout: JSON.stringify({ writeDenied: true }) };
				return {
					status: null,
					error: { code: "ETIMEDOUT" },
					signal: "SIGKILL",
				};
			},
		});
		strictEqual(outcome.status, "failed");
		const probe = outcome.results.find(
			(result) => result.name === "toolchain-sandbox",
		);
		strictEqual(probe.evidence.timedOut, true);
		strictEqual(probe.evidence.passed, false);
		ok(timeouts.every((timeout) => timeout > 0 && timeout <= 500));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("starts nested toolchain tests without NODE_TEST_CONTEXT and preserves CI", () => {
	const scratch = tempDir("sy-canary-test-context-");
	const previousContext = process.env.NODE_TEST_CONTEXT;
	const previousCI = process.env.CI;
	let childEnvironment;
	let calls = 0;
	process.env.NODE_TEST_CONTEXT = "child-v8";
	process.env.CI = "false";
	try {
		const outcome = runSandboxCanary({
			scratchRoot: scratch,
			platform: "darwin",
			profileFactory: () => "fixture",
			environmentFactory: () => ({
				CI: "true",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				PATH: "/usr/bin",
			}),
			toolchainTestPath: import.meta.filename,
			log: () => {},
			spawn: (_command, args, options) => {
				calls++;
				if (args.includes("--test")) {
					childEnvironment = options.env;
					return {
						status: 0,
						stdout:
							"TAP version 13\nok 1 - executed case\n# pass 1\n# fail 0\n",
					};
				}
				if (calls === 1) return { status: 0 };
				if (calls === 2) return { status: 0, stdout: "canary_ok" };
				if (calls === 3)
					return {
						status: 0,
						stdout: JSON.stringify({
							passwd: "ERR_SYSTEM_ERROR",
							imported: "function",
						}),
					};
				return { status: 0, stdout: JSON.stringify({ writeDenied: true }) };
			},
		});
		strictEqual(outcome.status, "passed");
		ok(childEnvironment);
		strictEqual(Object.hasOwn(childEnvironment, "NODE_TEST_CONTEXT"), false);
		strictEqual(childEnvironment.CI, "true");
		strictEqual(childEnvironment.PATH, process.env.PATH);
		strictEqual(process.env.NODE_TEST_CONTEXT, "child-v8");
		strictEqual(process.env.CI, "false");
	} finally {
		if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
		else process.env.NODE_TEST_CONTEXT = previousContext;
		if (previousCI === undefined) delete process.env.CI;
		else process.env.CI = previousCI;
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("fails closed on empty, unavailable and malformed required probe results", () => {
	const malformed = runSandboxCanary({
		probes: [{ name: "malformed", run: () => ({}) }],
		log: () => {},
	});
	strictEqual(malformed.status, "failed");
	strictEqual(malformed.reason, "probe_invalid_status");
	strictEqual(evaluateCanaryResults([]).exitCode, 1);
	for (const result of [
		null,
		{},
		{ status: "unknown" },
		{ status: "passed " },
	]) {
		const evaluation = evaluateCanaryResults([
			{ name: "valid", status: "passed" },
			result,
		]);
		strictEqual(evaluation.status, "failed");
		strictEqual(evaluation.reason, "probe_invalid_status");
		strictEqual(evaluation.invalidCount, 1);
	}
	const unavailable = evaluateCanaryResults([
		{ status: "passed" },
		{ status: "unavailable" },
	]);
	strictEqual(unavailable.status, "failed");
	strictEqual(unavailable.reason, "probe_skipped_or_unavailable");
});
for (const variant of [
	"skip",
	"todo",
	"summarySkipped",
	"summaryCancelled",
	"summaryTodo",
]) {
	it(`rejects a partially passing toolchain with ${variant} cases`, () => {
		const scratch = tempDir("sy-canary-partial-");
		const fixture = join(scratch, "partial.test.mjs");
		writeFileSync(
			fixture,
			`import {test} from 'node:test';test('executed',()=>{});test('omitted',{${variant === "todo" ? "todo" : "skip"}:true},()=>{});`,
		);
		let calls = 0;
		try {
			const outcome = runSandboxCanary({
				scratchRoot: scratch,
				platform: "darwin",
				toolchainTestPath: fixture,
				profileFactory: () => "fixture",
				environmentFactory: () => ({
					CI: "true",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					PATH: "/usr/bin",
				}),
				log: () => {},
				spawn: (command, args, options) => {
					calls++;
					if (args.includes("--test")) {
						if (variant.startsWith("summary"))
							return {
								status: 0,
								stdout: `TAP version 13\nok 1 - executed\n# pass 1\n# fail 0\n# ${variant.slice(7).toLowerCase()} 1\n`,
							};
						return spawnSync(command, args, options);
					}
					if (calls === 1) return { status: 0 };
					if (calls === 2) return { status: 0, stdout: "canary_ok" };
					if (calls === 3)
						return {
							status: 0,
							stdout: JSON.stringify({
								passwd: "ERR_SYSTEM_ERROR",
								imported: "function",
							}),
						};
					return { status: 0, stdout: JSON.stringify({ writeDenied: true }) };
				},
			});
			strictEqual(outcome.status, "failed");
			const probe = outcome.results.find(
				(result) => result.name === "toolchain-sandbox",
			);
			strictEqual(probe.status, "failed");
			strictEqual(probe.executedCases, 1);
			strictEqual(probe.evidence.passed, false);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}
