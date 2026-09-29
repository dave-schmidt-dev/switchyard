import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { integrationGate } from "../integrate/index.mjs";
import { settleSimpleWriterProcesses } from "../simple/process-teardown.mjs";
import { MAX_CHECKS, parseCommand } from "./check-contract.mjs";
import { trustedOfflineNpmEnv } from "./check-dependencies.mjs";

export { parseQuickChecks } from "./check-contract.mjs";

const SELF = fileURLToPath(import.meta.url);
const MAX_CHECK_MS = 10 * 60_000;
function runCommand(cwd, env, argv, timeoutMs, { sandbox = true } = {}) {
	if (process.platform !== "darwin")
		return {
			exitCode: null,
			signal: null,
			timedOut: false,
			groupCleanup: "unknown",
		};
	const result = spawnSync(
		process.execPath,
		[
			SELF,
			"--quick-check-worker",
			JSON.stringify({
				cwd,
				argv,
				timeoutMs,
				sandbox,
				profile: sandbox ? quickCheckSandboxProfile(cwd, env.HOME) : null,
			}),
		],
		{
			cwd,
			env,
			encoding: "utf8",
			timeout: timeoutMs + 10_000,
			maxBuffer: 1024,
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	if (result.error || result.status !== 0)
		return {
			exitCode: null,
			signal: null,
			timedOut: true,
			groupCleanup: "unknown",
		};
	try {
		const parsed = JSON.parse(result.stdout);
		if (Number.isInteger(parsed.exitCode) || typeof parsed.signal === "string")
			return parsed;
	} catch {
		/* closed unknown receipt */
	}
	return {
		exitCode: null,
		signal: null,
		timedOut: true,
		groupCleanup: "unknown",
	};
}
function settleScopedChecksSync(root, launchedAt) {
	const result = spawnSync(
		process.execPath,
		[SELF, "--quick-check-settle", JSON.stringify({ root, launchedAt })],
		{
			env: safeEnv(root),
			encoding: "utf8",
			timeout: 12_000,
			maxBuffer: 64,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	return result.status === 0 && result.stdout === "stopped";
}
function gateCandidate(cwd, env, diff, allowedPaths, allowSensitiveManifests) {
	const result = spawnSync(process.execPath, [SELF, "--quick-check-gate"], {
		cwd,
		env,
		input: JSON.stringify({ diff, allowedPaths, allowSensitiveManifests }),
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024,
		stdio: ["pipe", "pipe", "ignore"],
	});
	return result.status === 0 && result.stdout === "passed";
}
export function runQuickChecks({
	projectPath,
	taskId,
	attempt,
	baseTree,
	diff,
	checks,
	setup = null,
	checkTimeoutMs = MAX_CHECK_MS,
	hostNpmCache = join(homedir(), ".npm"),
	allowedPaths = null,
	allowSensitiveManifests = false,
	snapshotPaths = [],
	ownedRoot = null,
	onStatus,
}) {
	if (
		!Number.isSafeInteger(checkTimeoutMs) ||
		checkTimeoutMs < 100 ||
		checkTimeoutMs > MAX_CHECK_MS ||
		!Array.isArray(checks) ||
		checks.length < 1 ||
		checks.length > MAX_CHECKS ||
		!checks.every(
			(argv) =>
				Array.isArray(argv) &&
				JSON.stringify(parseCommand(argv.join(" "), taskId, false)) ===
					JSON.stringify(argv),
		) ||
		(setup &&
			JSON.stringify(parseCommand(setup.join(" "), taskId, true)) !==
				JSON.stringify(setup))
	)
		throw new Error("invalid Quick checks input");
	const root =
		ownedRoot ?? mkdtempSync(join(tmpdir(), "switchyard-quick-check-"));
	const launchedAt = Date.now();
	const clone = join(root, "candidate");
	const env = safeEnv(root);
	const receipt = {
		version: 1,
		taskId,
		attempt,
		baseTree,
		diffSha256: sha(diff.endsWith("\n") ? diff : `${diff}\n`),
		candidateTree: null,
		commandSetSha256: sha(JSON.stringify({ setup, checks })),
		setup: null,
		checks: [],
		status: "unknown",
		cleanup: { status: "pending" },
	};
	try {
		onStatus?.({
			phase: "checks",
			event: "clone_started",
			status: `Task ${taskId} preparing isolated checks`,
			taskId,
		});
		git(root, env, [
			"clone",
			"--quiet",
			"--no-local",
			"--no-hardlinks",
			"--no-checkout",
			"--",
			projectPath,
			clone,
		]);
		prepareExactBase(clone, projectPath, env, baseTree, snapshotPaths);
		const patch = diff.endsWith("\n") ? diff : `${diff}\n`;
		if (
			!gateCandidate(clone, env, patch, allowedPaths, allowSensitiveManifests)
		)
			throw new Error("gate_failed");
		git(clone, env, ["add", "-A"]);
		receipt.candidateTree = git(clone, env, ["write-tree"]);
		if (setup) {
			onStatus?.({
				phase: "checks",
				event: "setup_started",
				status: `Task ${taskId} installing declared dependencies`,
				taskId,
			});
			const setupEnv = trustedOfflineNpmEnv(
				projectPath,
				clone,
				env,
				hostNpmCache,
			);
			if (!setupEnv) throw new Error("setup_unavailable");
			const outcome = runCommand(clone, setupEnv, setup, 5 * 60_000, {
				sandbox: false,
			});
			receipt.setup = { commandSha256: sha(JSON.stringify(setup)), ...outcome };
			if (outcome.exitCode !== 0 || outcome.groupCleanup !== "complete")
				throw new Error("setup_failed");
		}
		for (const [index, argv] of checks.entries()) {
			onStatus?.({
				phase: "checks",
				event: "check_started",
				status: `Task ${taskId} check ${index + 1}/${checks.length} running`,
				taskId,
			});
			const outcome = runCommand(clone, env, argv, checkTimeoutMs);
			receipt.checks.push({
				index,
				commandSha256: sha(JSON.stringify(argv)),
				...outcome,
			});
			if (outcome.exitCode !== 0 || outcome.groupCleanup !== "complete")
				throw new Error("check_failed");
		}
		git(clone, env, ["add", "-A"]);
		if (git(clone, env, ["write-tree"]) !== receipt.candidateTree)
			throw new Error("candidate_changed");
		receipt.status = "passed";
	} catch (error) {
		receipt.status =
			error.message === "check_failed" || error.message === "setup_failed"
				? "failed"
				: "unknown";
		receipt.failureCode = [
			"base_mismatch",
			"setup_failed",
			"setup_unavailable",
			"check_failed",
		].includes(error.message)
			? error.message
			: "candidate_unavailable";
	} finally {
		onStatus?.({
			phase: "checks",
			event: "check_cleanup_progress",
			status: `Task ${taskId} isolated check cleanup running`,
			taskId,
		});
		const stopped = settleScopedChecksSync(root, launchedAt);
		if (!stopped) {
			receipt.cleanup.status = "failed";
			receipt.status = "unknown";
		} else if (!ownedRoot) {
			try {
				rmSync(root, { recursive: true, force: true });
				receipt.cleanup.status = "complete";
			} catch {
				receipt.cleanup.status = "failed";
				receipt.status = "unknown";
			}
		}
		onStatus?.({
			phase: "checks",
			event: "checks_finished",
			status: `Task ${taskId} checks ${receipt.status}`,
			taskId,
		});
	}
	return receipt;
}
if (process.argv[2] === "--quick-check-settle") {
	let input;
	try {
		input = JSON.parse(process.argv[3]);
	} catch {
		process.exit(2);
	}
	const state = await settleSimpleWriterProcesses({
		processGroupId: null,
		processScopePath: input.root,
		launchedAt: input.launchedAt,
	});
	process.stdout.write(state);
}
export function runQuickChecksAsync(input) {
	return new Promise((resolve) => {
		const root = mkdtempSync(join(tmpdir(), "switchyard-quick-check-"));
		const launchedAt = Date.now();
		const maxMs =
			(input.checks?.length ?? MAX_CHECKS) *
				(input.checkTimeoutMs ?? MAX_CHECK_MS) +
			(input.setup ? 5 * 60_000 : 0) +
			90_000;
		let child;
		try {
			child = spawn(process.execPath, [SELF, "--quick-check-runner"], {
				env: safeEnv(root),
				stdio: ["pipe", "pipe", "ignore"],
				detached: true,
				shell: false,
			});
		} catch {
			rmSync(root, { recursive: true, force: true });
			resolve(null);
			return;
		}
		input.onRunnerStarted?.(child.pid, root);
		let output = "";
		let settled = false;
		const finish = async (receipt = null) => {
			if (settled) return;
			settled = true;
			clearInterval(progress);
			clearTimeout(timeout);
			const stopped = Number.isSafeInteger(child.pid)
				? (await settleSimpleWriterProcesses({
						processGroupId: child.pid,
						processScopePath: root,
						launchedAt,
						onProgress: () =>
							input.onStatus?.({
								phase: "checks",
								event: "check_cleanup_progress",
								status: `Task ${input.taskId} isolated check cleanup running`,
								taskId: input.taskId,
							}),
					})) === "stopped"
				: true;
			let removed = false;
			if (stopped) {
				try {
					rmSync(root, { recursive: true, force: true });
					removed = true;
				} catch {
					/* retain for diagnosis */
				}
			}
			if (
				receipt &&
				stopped &&
				removed &&
				receipt.cleanup?.status === "pending"
			) {
				receipt.cleanup.status = "complete";
				resolve(receipt);
			} else resolve(null);
		};
		const progress = setInterval(
			() =>
				input.onStatus?.({
					phase: "checks",
					event: "check_progress",
					status: `Task ${input.taskId} isolated checks still running`,
					taskId: input.taskId,
				}),
			5_000,
		);
		const timeout = setTimeout(() => {
			void finish();
		}, maxMs);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.length > 16_384) void finish();
		});
		child.on("error", () => {
			void finish();
		});
		child.stdin.on("error", () => {
			void finish();
		});
		child.on("exit", (code) => {
			if (code !== 0) {
				void finish();
				return;
			}
			try {
				void finish(JSON.parse(output));
			} catch {
				void finish();
			}
		});
		child.stdin.end(
			JSON.stringify({
				...input,
				ownedRoot: root,
				hostNpmCache: join(homedir(), ".npm"),
				onStatus: undefined,
				onRunnerStarted: undefined,
			}),
		);
	});
}
if (process.argv[2] === "--quick-check-worker") {
	let payload;
	try {
		payload = JSON.parse(process.argv[3]);
	} catch {
		process.exit(2);
	}
	const [command, ...args] = payload.argv;
	const sandboxed = payload.sandbox !== false;
	const child = spawn(
		sandboxed ? "/usr/bin/sandbox-exec" : command,
		sandboxed ? ["-p", payload.profile, "--", command, ...args] : args,
		{
			cwd: payload.cwd,
			env: process.env,
			stdio: "ignore",
			detached: true,
			shell: false,
		},
	);
	let timedOut = false;
	const progress = setInterval(
		() => process.stderr.write("switchyard: isolated check still running\n"),
		5_000,
	);
	const timeout = setTimeout(() => {
		timedOut = true;
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			/* already exited */
		}
		setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* already exited */
			}
		}, 1_000).unref();
	}, payload.timeoutMs);
	const cleanupGroup = () => {
		if (!Number.isInteger(child.pid)) return "unknown";
		try {
			process.kill(-child.pid, "SIGKILL");
			return "complete";
		} catch (error) {
			return error?.code === "ESRCH" ? "complete" : "unknown";
		}
	};
	child.on("error", () => {
		clearInterval(progress);
		clearTimeout(timeout);
		process.stdout.write(
			JSON.stringify({
				exitCode: null,
				signal: null,
				timedOut: false,
				groupCleanup: cleanupGroup(),
			}),
		);
	});
	child.on("exit", (code, signal) => {
		clearInterval(progress);
		clearTimeout(timeout);
		process.stdout.write(
			JSON.stringify({
				exitCode: code,
				signal,
				timedOut,
				groupCleanup: cleanupGroup(),
			}),
		);
	});
}
if (process.argv[2] === "--quick-check-gate") {
	let raw = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		raw += chunk;
		if (raw.length > 8 * 1024 * 1024) process.exit(2);
	});
	process.stdin.on("end", () => {
		try {
			const { diff, allowedPaths, allowSensitiveManifests } = JSON.parse(raw);
			const result = integrationGate(diff, process.cwd(), {
				allowedPaths,
				allowSensitiveManifests,
			});
			process.stdout.write(result.success === true ? "passed" : "rejected");
		} catch {
			process.stdout.write("rejected");
		}
	});
}
if (process.argv[2] === "--quick-check-runner") {
	let raw = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		raw += chunk;
		if (raw.length > 8 * 1024 * 1024) process.exit(2);
	});
	process.stdin.on("end", () => {
		try {
			const receipt = runQuickChecks(JSON.parse(raw));
			process.stdout.write(JSON.stringify(receipt));
		} catch {
			process.exitCode = 2;
		}
	});
}

import "./checks-sandbox.mjs";
import "./checks-receipts.mjs";
import {
	git,
	prepareExactBase,
	quickCheckSandboxProfile,
	safeEnv,
	sha,
} from "./checks-sandbox.mjs";

export {
	enforceQuickCheckCompletion,
	invalidCompletedQuickCheckTaskIds,
	isPassingQuickCheckReceipt,
} from "./checks-receipts.mjs";
export { quickCheckSandboxProfile } from "./checks-sandbox.mjs";
