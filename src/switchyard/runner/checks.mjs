// Host-only, captain-authored quick checks. No provider transcript or check output
// crosses this boundary. The worker owns the process group and timeout.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { integrationGate } from "../integrate/index.mjs";
import { settleSimpleWriterProcesses } from "../simple/process-teardown.mjs";
import { MAX_CHECKS, parseCommand } from "./check-contract.mjs";

export { parseQuickChecks } from "./check-contract.mjs";

const SELF = fileURLToPath(import.meta.url);
const MAX_CHECK_MS = 10 * 60_000;
const GIT_ARGS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.attributesFile=/dev/null",
	"-c",
	"diff.external=",
	"-c",
	"diff.trustExitCode=false",
	"-c",
	"filter.lfs.smudge=",
	"-c",
	"filter.lfs.required=false",
];

function sha(value) {
	return createHash("sha256").update(value).digest("hex");
}

function safeEnv(home) {
	home = realpathSync(home);
	return {
		PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
		HOME: home,
		TMPDIR: home,
		XDG_CONFIG_HOME: home,
		CI: "true",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_LFS_SKIP_SMUDGE: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/usr/bin/false",
	};
}

/** Confine provider-edited check scripts to their disposable candidate tree. */
export function quickCheckSandboxProfile(clone, runtime) {
	clone = realpathSync(clone);
	runtime = realpathSync(runtime);
	const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
	const npmRoot = dirname(dirname(realpathSync("/opt/homebrew/bin/npm")));
	const reads = [
		"/System",
		"/usr",
		"/bin",
		"/sbin",
		"/dev",
		"/opt/homebrew/Cellar",
		"/opt/homebrew/opt",
		"/opt/homebrew/etc/openssl@3/openssl.cnf",
		nodeRoot,
		npmRoot,
		"/opt/homebrew/bin/node",
		"/opt/homebrew/bin/npm",
		clone,
		runtime,
	];
	const ancestors = new Set(["/"]);
	for (const path of reads) {
		let current = dirname(path);
		while (current !== "/") {
			ancestors.add(current);
			current = dirname(current);
		}
	}
	const literals = [...ancestors]
		.filter((path) => path !== "/")
		.map((path) => `(literal ${JSON.stringify(path)})`)
		.join(" ");
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow sysctl-read)",
		'(allow file-read* (literal "/"))',
		`(allow file-read-metadata ${literals})`,
		`(allow file-read* ${reads.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})`,
		`(allow file-write* (subpath ${JSON.stringify(clone)}) (subpath ${JSON.stringify(runtime)}) (literal "/dev/null"))`,
	].join("\n");
}

function git(cwd, env, args, input) {
	const result = spawnSync("git", [...GIT_ARGS, ...args], {
		cwd,
		env,
		input,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.status !== 0 || result.error)
		throw new Error("git_operation_failed");
	return result.stdout.trim();
}

function runCommand(cwd, env, argv, timeoutMs) {
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
				profile: quickCheckSandboxProfile(cwd, env.HOME),
			}),
		],
		{
			cwd,
			env,
			encoding: "utf8",
			timeout: timeoutMs + 5_000,
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

function validSnapshotPath(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.includes("\0") &&
		!path.includes("\\") &&
		path
			.split("/")
			.every((part) => part && part !== "." && part !== ".." && part !== ".git")
	);
}

function prepareExactBase(clone, projectPath, env, baseTree, snapshotPaths) {
	if (
		!Array.isArray(snapshotPaths) ||
		snapshotPaths.length > 4096 ||
		!snapshotPaths.every(validSnapshotPath)
	)
		throw new Error("base_mismatch");
	const trusted = new Set(snapshotPaths);
	const observed = spawnSync(
		"git",
		[
			...GIT_ARGS,
			"status",
			"--porcelain=v1",
			"--no-renames",
			"-z",
			"--untracked-files=all",
		],
		{
			cwd: projectPath,
			env,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (
		observed.status !== 0 ||
		observed.error ||
		typeof observed.stdout !== "string"
	)
		throw new Error("base_mismatch");
	for (const row of observed.stdout.split("\0").filter(Boolean)) {
		const changedPath = row.slice(3);
		if (row.length < 4) throw new Error("base_mismatch");
		if (row.startsWith("?? ")) continue;
		if (!trusted.has(changedPath)) throw new Error("base_mismatch");
	}
	git(clone, env, ["read-tree", "HEAD"]);
	if (trusted.size) {
		git(
			clone,
			{ ...env, GIT_WORK_TREE: projectPath, GIT_LITERAL_PATHSPECS: "1" },
			["add", "-A", "--", ...trusted],
		);
	}
	if (git(clone, env, ["write-tree"]) !== baseTree)
		throw new Error("base_mismatch");
	git(clone, env, ["checkout-index", "-a", "-f"]);
	git(clone, env, ["diff", "--quiet"]);
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

/** Build a fresh clone from the exact base tree, apply the gated patch, and check it. */
export function runQuickChecks({
	projectPath,
	taskId,
	attempt,
	baseTree,
	diff,
	checks,
	setup = null,
	allowedPaths = null,
	allowSensitiveManifests = false,
	snapshotPaths = [],
	ownedRoot = null,
	onStatus,
}) {
	if (
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
			const outcome = runCommand(clone, env, setup, 5 * 60_000);
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
			const outcome = runCommand(clone, env, argv, MAX_CHECK_MS);
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

/** Keep the production event loop and detached status writer live during checks. */
export function runQuickChecksAsync(input) {
	return new Promise((resolve) => {
		const root = mkdtempSync(join(tmpdir(), "switchyard-quick-check-"));
		const launchedAt = Date.now();
		const maxMs =
			(input.checks?.length ?? MAX_CHECKS) * MAX_CHECK_MS +
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
				onStatus: undefined,
				onRunnerStarted: undefined,
			}),
		);
	});
}

/** Exact, closed passing receipt for the current candidate only. */
export function isPassingQuickCheckReceipt(
	receipt,
	{ taskId, attempt, baseTree, diff, checks, setup = null },
) {
	return (
		receipt?.version === 1 &&
		receipt.status === "passed" &&
		Object.keys(receipt).sort().join(",") ===
			"attempt,baseTree,candidateTree,checks,cleanup,commandSetSha256,diffSha256,setup,status,taskId,version" &&
		Object.keys(receipt.cleanup ?? {}).join(",") === "status" &&
		receipt.cleanup?.status === "complete" &&
		receipt.taskId === taskId &&
		Number.isSafeInteger(attempt) &&
		attempt > 0 &&
		receipt.attempt === attempt &&
		/^[a-f0-9]{40,64}$/u.test(baseTree ?? "") &&
		receipt.baseTree === baseTree &&
		/^[a-f0-9]{40,64}$/u.test(receipt.candidateTree ?? "") &&
		/^[a-f0-9]{64}$/u.test(receipt.diffSha256 ?? "") &&
		(diff === undefined ||
			receipt.diffSha256 === sha(diff.endsWith("\n") ? diff : `${diff}\n`)) &&
		receipt.commandSetSha256 === sha(JSON.stringify({ setup, checks })) &&
		Array.isArray(receipt.checks) &&
		receipt.checks.length === checks.length &&
		receipt.checks.every(
			(item, index) =>
				Object.keys(item).sort().join(",") ===
					"commandSha256,exitCode,groupCleanup,index,signal,timedOut" &&
				item.index === index &&
				item.commandSha256 === sha(JSON.stringify(checks[index])) &&
				item.exitCode === 0 &&
				item.signal === null &&
				item.timedOut === false &&
				item.groupCleanup === "complete",
		) &&
		(setup === null
			? receipt.setup === null
			: Object.keys(receipt.setup ?? {})
					.sort()
					.join(",") ===
					"commandSha256,exitCode,groupCleanup,signal,timedOut" &&
				receipt.setup?.commandSha256 === sha(JSON.stringify(setup)) &&
				receipt.setup.exitCode === 0 &&
				receipt.setup.signal === null &&
				receipt.setup.timedOut === false &&
				receipt.setup.groupCleanup === "complete")
	);
}

/** A missing or stale check receipt cannot become a completed task. */
export function enforceQuickCheckCompletion(task, result, attempt, checkpoint) {
	if (result.success !== true || (task.quickChecks?.checks?.length ?? 0) === 0)
		return;
	const integration = checkpoint.integrationIntents?.[task.id];
	const intent = integration?.operation;
	if (
		integration?.status === "completed" &&
		intent?.taskId === task.id &&
		intent.attempt === attempt &&
		intent.baseTree === checkpoint.taskBases?.[task.id]?.tree &&
		result.quickCheckReceipt?.diffSha256 === intent.patchHash &&
		isPassingQuickCheckReceipt(result.quickCheckReceipt, {
			taskId: task.id,
			attempt,
			baseTree: intent.baseTree,
			checks: task.quickChecks.checks,
			setup: task.quickChecks.setup,
		})
	)
		return;
	result.success = false;
	result.result = "check_failed";
	result.errorKind = "check_failed";
	result.reasonCode = "check_failed";
	result.reason = "Task check receipt missing or invalid.";
}

/** Identify historical completed rows that lack exact candidate evidence. */
export function invalidCompletedQuickCheckTaskIds(tasks, checkpoint) {
	const invalid = [];
	for (const task of tasks) {
		if (
			!checkpoint.completedTaskIds?.includes(task.id) ||
			(task.quickChecks?.checks?.length ?? 0) === 0
		)
			continue;
		const entry = [...(checkpoint.results ?? [])]
			.reverse()
			.find((item) => item.taskId === task.id && item.success === true);
		const integration = checkpoint.integrationIntents?.[task.id];
		const intent = integration?.operation;
		if (
			!entry ||
			integration?.status !== "completed" ||
			!intent ||
			intent.taskId !== task.id ||
			intent.attempt !== entry.attempt ||
			entry.quickCheckReceipt?.diffSha256 !== intent.patchHash ||
			!isPassingQuickCheckReceipt(entry.quickCheckReceipt, {
				taskId: task.id,
				attempt: entry.attempt,
				baseTree: intent.baseTree,
				checks: task.quickChecks.checks,
				setup: task.quickChecks.setup,
			})
		)
			invalid.push(task.id);
	}
	return invalid;
}

if (process.argv[2] === "--quick-check-worker") {
	let payload;
	try {
		payload = JSON.parse(process.argv[3]);
	} catch {
		process.exit(2);
	}
	const [command, ...args] = payload.argv;
	const child = spawn(
		"/usr/bin/sandbox-exec",
		["-p", payload.profile, "--", command, ...args],
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
