#!/usr/bin/env node
/** Strict host confinement and real toolchain probes. */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	quickCheckSandboxProfile,
	safeEnv,
} from "../src/switchyard/runner/checks-sandbox.mjs";
import { withHermeticTestEnv } from "./hermetic-test-env.mjs";
import {
	CANARY_DEADLINE_ENV,
	CANARY_SANDBOX_EXEC_ENV,
	DEFAULT_CANARY_DEADLINE_MS,
	resolveDeadlineMs,
	runCanaryCli,
	supervisedSpawn,
} from "./sandbox-canary-daily.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
export function probeSandboxExecUsable({
	spawn = supervisedSpawn,
	sandboxExecPath = "/usr/bin/sandbox-exec",
	platform = process.platform,
	timeoutMs = 5000,
	log,
} = {}) {
	if (platform !== "darwin") {
		return { usable: false, reason: "unsupported_platform_not_darwin" };
	}
	if (!existsSync(sandboxExecPath)) {
		return { usable: false, reason: "sandbox_exec_missing" };
	}
	try {
		if (typeof log === "function") {
			log("Probing sandbox-exec availability...");
		}
		const result = spawn(
			sandboxExecPath,
			["-p", "(version 1)(allow default)", "/usr/bin/true"],
			{ stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" },
		);
		if (result.status === 0) {
			return { usable: true, reason: null };
		}
		return {
			usable: false,
			reason: "sandbox_exec_failed_nested_or_restricted",
		};
	} catch (err) {
		return {
			usable: false,
			reason: err?.code ?? "sandbox_exec_spawn_error",
		};
	}
}
export function parseTapResults(stdout = "") {
	let passedCount = 0;
	let failedCount = 0;
	let skippedCount = 0;
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (/^ok\s+\d+\s+-/i.test(trimmed)) {
			if (/#\s*SKIP\b/i.test(trimmed) || /#\s*TODO\b/i.test(trimmed)) {
				skippedCount += 1;
			} else {
				passedCount += 1;
			}
		} else if (/^not ok\s+\d+\s+-/i.test(trimmed)) {
			failedCount += 1;
		}
	}
	const passMatch = stdout.match(/^#\s*pass\s+(\d+)/m);
	const failMatch = stdout.match(/^#\s*fail\s+(\d+)/m);
	const summaryPassed = passMatch ? Number.parseInt(passMatch[1], 10) : null;
	const summaryFailed = failMatch ? Number.parseInt(failMatch[1], 10) : null;
	const summaryCount = (name) => {
		const match = stdout.match(new RegExp(`^#\\s*${name}\\s+(\\d+)`, "m"));
		return match ? Number.parseInt(match[1], 10) : null;
	};
	return {
		passedCount,
		failedCount,
		skippedCount,
		summaryPassed,
		summaryFailed,
		summarySkipped: summaryCount("skipped"),
		summaryCancelled: summaryCount("cancelled"),
		summaryTodo: summaryCount("todo"),
	};
}
export function evaluateCanaryResults(results) {
	const passed = results.filter((result) => result?.status === "passed");
	const failed = results.filter((result) => result?.status === "failed");
	const skipped = results.filter((result) =>
		["skipped", "unavailable"].includes(result?.status),
	);
	const invalid = results.filter(
		(result) =>
			!["passed", "failed", "skipped", "unavailable"].includes(result?.status),
	);
	let reason = null;
	if (failed.length)
		reason = `probe_failed: ${failed.map((result) => result.name).join(", ")}`;
	else if (invalid.length) reason = "probe_invalid_status";
	else if (!passed.length) reason = "all_skipped_or_unavailable";
	else if (skipped.length) reason = "probe_skipped_or_unavailable";
	return {
		status: reason ? "failed" : "passed",
		exitCode: reason ? 1 : 0,
		reason,
		passedCount: passed.length,
		failedCount: failed.length,
		skippedCount: skipped.length,
		invalidCount: invalid.length,
		results,
	};
}
function parseJsonReport(result, accept) {
	if (result.status !== 0) {
		return {
			passed: false,
			error: result.stderr || `exit ${result.status}`,
		};
	}
	try {
		const report = JSON.parse(result.stdout);
		return accept(report)
			? { passed: true, error: null }
			: { passed: false, error: `unexpected report: ${result.stdout}` };
	} catch {
		return { passed: false, error: `invalid json output: ${result.stdout}` };
	}
}
export function runSandboxCanary({
	root = ROOT,
	scratchRoot,
	spawn = supervisedSpawn,
	sandboxExecPath = "/usr/bin/sandbox-exec",
	log = console.log,
	error = console.error,
	probes,
	platform = process.platform,
	toolchainTestPath,
	toolchainTimeoutMs = 120_000,
	deadlineMs = DEFAULT_CANARY_DEADLINE_MS,
	clock = Date.now,
	profileFactory = quickCheckSandboxProfile,
	environmentFactory = safeEnv,
} = {}) {
	if (Array.isArray(probes)) {
		const results = [];
		for (const probe of probes) {
			try {
				const res = probe.run();
				results.push({
					name: probe.name,
					status:
						res?.status ??
						(res === true ? "passed" : res === false ? "failed" : "invalid"),
					...(res?.error ? { error: res.error } : {}),
					...(res?.reason ? { reason: res.reason } : {}),
				});
			} catch (err) {
				results.push({
					name: probe.name,
					status: "failed",
					error: err?.message ?? "probe_threw_exception",
				});
			}
		}
		const evaluation = evaluateCanaryResults(results);
		log(
			`Sandbox canary summary: ${evaluation.status} (${evaluation.passedCount} passed, ${evaluation.failedCount} failed, ${evaluation.skippedCount} skipped/unavailable)`,
		);
		return evaluation;
	}
	const startedAt = clock();
	const remainingMs = () => deadlineMs - (clock() - startedAt);
	const budget = (requested) => Math.max(1, Math.min(requested, remainingMs()));
	const deadlineExceeded = () => remainingMs() <= 0;
	const deadlineFailure = (name) => ({
		name,
		status: "failed",
		error: "canary_deadline_exceeded",
		evidence: { deadlineExceeded: true, passed: false },
	});
	const probeState = deadlineExceeded()
		? { usable: false, reason: "canary_deadline_exceeded" }
		: probeSandboxExecUsable({
				spawn,
				sandboxExecPath,
				platform,
				timeoutMs: budget(5000),
				log,
			});
	if (!probeState.usable) {
		const evaluation = evaluateCanaryResults([
			{
				name: "sandbox-exec-availability",
				status: "unavailable",
				reason: probeState.reason,
			},
		]);
		error(
			`Sandbox canary unavailable: ${probeState.reason} (ALL-skipped/unavailable is never a successful host canary)`,
		);
		return evaluation;
	}
	let ownedScratch = null;
	if (!scratchRoot)
		ownedScratch = mkdtempSync(join(tmpdir(), "switchyard-canary-"));
	const scratchDir = scratchRoot ?? ownedScratch;
	try {
		const clone = join(scratchDir, "clone");
		const runtime = join(scratchDir, "runtime");
		const outside = join(scratchDir, "outside-marker");
		mkdirSync(clone, { recursive: true });
		mkdirSync(runtime, { recursive: true });
		writeFileSync(outside, "host-marker\n");
		const checksSandboxPath = resolve(
			root,
			"src/switchyard/runner/checks-sandbox.mjs",
		);
		// The module and its one relative import are the self-host read set.
		const nodeRuntimePath = resolve(root, "src/switchyard/node-runtime.mjs");
		const profile = profileFactory(clone, runtime, [
			checksSandboxPath,
			nodeRuntimePath,
		]);
		const safeEnvironment = environmentFactory(runtime);
		const results = [];
		const confinedProbe = ({ name, timeoutMs, run }) => {
			if (deadlineExceeded()) {
				log(`Skipping probe: ${name} (canary deadline exceeded)`);
				results.push(deadlineFailure(name));
				return;
			}
			log(`Running probe: ${name}...`);
			const timeout = budget(timeoutMs);
			const result = run(timeout);
			results.push({
				...result,
				evidence: { ...(result.evidence ?? {}), timeoutMs: timeout },
			});
		};
		const nodeProbe = ({ name, timeoutMs, script, parse }) => {
			confinedProbe({
				name,
				timeoutMs,
				run: (timeout) => {
					const result = spawn(
						sandboxExecPath,
						["-p", profile, process.execPath, "-e", script],
						{
							cwd: clone,
							env: safeEnvironment,
							encoding: "utf8",
							timeout,
							killSignal: "SIGKILL",
							maxBuffer: 262144,
						},
					);
					const outcome = parse(result);
					return {
						name,
						status: outcome.passed ? "passed" : "failed",
						...(outcome.passed ? {} : { error: outcome.error }),
						evidence: { exitCode: result.status, passed: outcome.passed },
					};
				},
			});
		};
		nodeProbe({
			name: "basic-process",
			timeoutMs: 15_000,
			script: 'process.stdout.write("canary_ok")',
			parse: (result) => ({
				passed: result.status === 0 && result.stdout === "canary_ok",
				error: result.stderr || `exit ${result.status}`,
			}),
		});
		nodeProbe({
			name: "module-self-host",
			timeoutMs: 20_000,
			script: `
let passwd = "ok";
try { require("node:os").userInfo(); } catch (error) { passwd = error.code; }
const done = (imported) => process.stdout.write(JSON.stringify({ passwd, imported }));
import(${JSON.stringify(pathToFileURL(checksSandboxPath).href)}).then(
	(loaded) => done(typeof loaded.quickCheckSandboxProfile),
	(error) => done(error.code ?? error.message),
);
`,
			parse: (result) =>
				parseJsonReport(
					result,
					(report) =>
						report.passwd === "ERR_SYSTEM_ERROR" &&
						report.imported === "function",
				),
		});
		nodeProbe({
			name: "confinement-write-denial",
			timeoutMs: 15_000,
			script: `
const fs = require("node:fs");
let writeDenied = false;
try {
	fs.writeFileSync(${JSON.stringify(outside)}, "corrupted");
} catch (error) {
	if (["EPERM", "EACCES"].includes(error.code)) writeDenied = true;
}
process.stdout.write(JSON.stringify({ writeDenied }));
`,
			parse: (result) =>
				parseJsonReport(result, (report) => report.writeDenied === true),
		});
		confinedProbe({
			name: "safe-env-inspection",
			timeoutMs: 1_000,
			run: () => {
				const safeEnvCheck =
					safeEnvironment.CI === "true" &&
					safeEnvironment.GIT_CONFIG_GLOBAL === "/dev/null" &&
					safeEnvironment.GIT_CONFIG_NOSYSTEM === "1" &&
					typeof safeEnvironment.PATH === "string" &&
					safeEnvironment.PATH.length > 0;
				return {
					name: "safe-env-inspection",
					status: safeEnvCheck ? "passed" : "failed",
					...(safeEnvCheck
						? {}
						: { error: "safeEnv missing required isolation settings" }),
					evidence: {
						passed: safeEnvCheck,
						mode: "configuration-inspection",
					},
				};
			},
		});
		const resolvedToolchainTest =
			toolchainTestPath ??
			resolve(root, "tests/runner-quick-checks-toolchain-sandbox.test.mjs");
		if (deadlineExceeded()) {
			log("Skipping probe: toolchain-sandbox (canary deadline exceeded)");
			results.push(deadlineFailure("toolchain-sandbox"));
		} else if (!existsSync(resolvedToolchainTest)) {
			log("Running probe: toolchain-sandbox...");
			results.push({
				name: "toolchain-sandbox",
				status: "failed",
				error: `toolchain test file missing: ${resolvedToolchainTest}`,
				evidence: {
					exists: false,
					passed: false,
				},
			});
		} else {
			const timeout = budget(toolchainTimeoutMs);
			log(
				`Running probe: toolchain-sandbox (invoking ${resolvedToolchainTest})...`,
			);
			// A hermetic env also drops the parent's test-child marker, which a
			// fresh node:test runner must not inherit.
			const toolchainRes = withHermeticTestEnv(
				{ ...process.env, CI: "true" },
				(toolchainEnv) =>
					spawn(
						process.execPath,
						["--test", "--test-reporter=tap", resolvedToolchainTest],
						{
							cwd: root,
							env: toolchainEnv,
							encoding: "utf8",
							timeout,
							killSignal: "SIGKILL",
							maxBuffer: 262144,
						},
					),
			);
			const tapReport = parseTapResults(toolchainRes.stdout || "");
			const timedOut = Boolean(
				toolchainRes.error?.code === "ETIMEDOUT" ||
					toolchainRes.signal === "SIGTERM",
			);
			let toolchainPassed = false;
			let toolchainErr = null;
			if (timedOut) {
				toolchainErr = `toolchain test process timed out after ${timeout}ms`;
			} else if (toolchainRes.status !== 0) {
				toolchainErr =
					toolchainRes.stderr ||
					`toolchain test exited with status ${toolchainRes.status} (failed cases: ${tapReport.failedCount})`;
			} else {
				const actualExecuted = tapReport.summaryPassed ?? tapReport.passedCount;
				if (
					actualExecuted === 0 ||
					tapReport.failedCount > 0 ||
					tapReport.summaryFailed > 0 ||
					tapReport.skippedCount > 0 ||
					tapReport.summarySkipped > 0 ||
					tapReport.summaryCancelled > 0 ||
					tapReport.summaryTodo > 0
				) {
					toolchainErr =
						"toolchain_suite_skipped_or_zero_executed_cases (skipped/unavailable suite is not proof)";
				} else {
					toolchainPassed = true;
				}
			}
			results.push({
				name: "toolchain-sandbox",
				status: toolchainPassed ? "passed" : "failed",
				executedCases: tapReport.summaryPassed ?? tapReport.passedCount,
				...(toolchainPassed ? {} : { error: toolchainErr }),
				evidence: {
					exitCode: toolchainRes.status,
					executedCases: tapReport.summaryPassed ?? tapReport.passedCount,
					failedCases: tapReport.failedCount,
					skippedCases: Math.max(
						tapReport.skippedCount,
						tapReport.summarySkipped ?? 0,
					),
					cancelledCases: tapReport.summaryCancelled ?? 0,
					todoCases: tapReport.summaryTodo ?? 0,
					timedOut,
					timeoutMs: timeout,
					passed: toolchainPassed,
					...(toolchainErr ? { error: toolchainErr } : {}),
				},
			});
		}
		const evaluation = evaluateCanaryResults(results);
		log(
			`Sandbox canary summary: ${evaluation.status} (${evaluation.passedCount} passed, ${evaluation.failedCount} failed, ${evaluation.skippedCount} skipped/unavailable)`,
		);
		return evaluation;
	} finally {
		if (ownedScratch) {
			rmSync(ownedScratch, { recursive: true, force: true });
		}
	}
}

if (
	process.argv[1] &&
	(fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
		(existsSync(process.argv[1]) &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href))
) {
	const result = runCanaryCli({
		argv: process.argv.slice(2),
		runCanary: () =>
			runSandboxCanary({
				sandboxExecPath:
					process.env[CANARY_SANDBOX_EXEC_ENV] || "/usr/bin/sandbox-exec",
				deadlineMs: resolveDeadlineMs(process.env[CANARY_DEADLINE_ENV]),
			}),
	});
	if (result.exitCode !== 0) {
		const reason = result.outcome?.reason ?? "failed";
		console.error(`sandbox canary failed: ${reason}`);
		process.exit(result.exitCode || 1);
	}
	process.exit(0);
}
