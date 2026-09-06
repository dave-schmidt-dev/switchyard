// Lifecycle module - workspace seeding
// INV-3: The workspace is wiped at project end (see ExecutionBackend.destroy)

import { execFile, execFileSync } from "node:child_process";

const TASK_BASE_REF_PREFIX = "refs/switchyard/task-base";
const ZERO_OBJECT_ID = "0".repeat(40);
const TASK_BASE_PROBE_TIMEOUT_MS = 30_000;

function taskBaseComponent(value, label) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
	) {
		throw new TypeError(`${label} must be a safe task-base identifier`);
	}
	return value;
}

function taskBaseTree(value) {
	if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
		throw new TypeError("task base tree must be a SHA-1 object id");
	}
	return value;
}

function taskBaseProbeOptions(options = {}) {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? TASK_BASE_PROBE_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError("task base probe timeout must be positive");
	}
	return {
		...options,
		now,
		deadlineMs: options.deadlineMs ?? now() + timeoutMs,
	};
}

function probeRemainingMs(options) {
	if (options.signal?.aborted) throw new Error("task base probe aborted");
	const remainingMs = Math.floor(options.deadlineMs - options.now());
	if (remainingMs <= 0) throw new Error("task base probe deadline exhausted");
	return remainingMs;
}

function emitProbeStatus(options, event, stage) {
	try {
		options.onStatus?.({
			phase: "checkpoint",
			event,
			stage,
			status: `${stage} ${event === "task_base_probe_started" ? "started" : event === "task_base_probe_completed" ? "completed" : "failed"}`,
		});
	} catch {
		// Telemetry cannot alter the immutable-base operation.
	}
}

function backendExecution(executionBackend, workspaceId, argv, options) {
	const execution = executionBackend.execArgv(workspaceId, {
		cwd: "/project",
		argv: ["git", ...argv],
		recordPid: true,
		cleanupContext: options.cleanupContext,
	});
	return execution;
}

function backendGit(executionBackend, workspaceId, argv, options, stage) {
	const execution = backendExecution(
		executionBackend,
		workspaceId,
		argv,
		options,
	);
	emitProbeStatus(options, "task_base_probe_started", stage);
	try {
		const output = execFileSync(execution.command, execution.args, {
			encoding: "utf8",
			stdio: "pipe",
			timeout: probeRemainingMs(options),
			killSignal: "SIGKILL",
			signal: options.signal,
		});
		emitProbeStatus(options, "task_base_probe_completed", stage);
		return output;
	} catch (error) {
		emitProbeStatus(options, "task_base_probe_failed", stage);
		throw error;
	}
}

function backendGitAsync(executionBackend, workspaceId, argv, options, stage) {
	const execution = backendExecution(
		executionBackend,
		workspaceId,
		argv,
		options,
	);
	emitProbeStatus(options, "task_base_probe_started", stage);
	let timeout;
	try {
		timeout = probeRemainingMs(options);
	} catch (error) {
		emitProbeStatus(options, "task_base_probe_failed", stage);
		return Promise.reject(error);
	}
	return new Promise((resolve, reject) => {
		execFile(
			execution.command,
			execution.args,
			{
				encoding: "utf8",
				timeout,
				killSignal: "SIGKILL",
				signal: options.signal,
			},
			(error, stdout) => {
				if (error) {
					emitProbeStatus(options, "task_base_probe_failed", stage);
					reject(error);
					return;
				}
				emitProbeStatus(options, "task_base_probe_completed", stage);
				resolve(stdout);
			},
		);
	});
}

/**
 * Create a task-scoped immutable tree anchor after hooks have prepared the
 * workspace. The compare-and-swap creation is intentional: a mutable ref is
 * never accepted as evidence of the host-recorded tree.
 */
export function captureTaskStartTree(
	executionBackend,
	workspaceId,
	{ runId, taskId, ...inputOptions } = {},
) {
	if (!executionBackend || typeof executionBackend.execArgv !== "function") {
		throw new TypeError("execution backend does not support task-base capture");
	}
	const safeRunId = taskBaseComponent(runId, "runId");
	const safeTaskId = taskBaseComponent(taskId, "taskId");
	const options = taskBaseProbeOptions(inputOptions);
	backendGit(
		executionBackend,
		workspaceId,
		["add", "-A"],
		options,
		"task_base_stage",
	);
	const tree = taskBaseTree(
		backendGit(
			executionBackend,
			workspaceId,
			["write-tree"],
			options,
			"task_base_write",
		).trim(),
	);
	const ref = `${TASK_BASE_REF_PREFIX}/${safeRunId}/${safeTaskId}`;
	backendGit(
		executionBackend,
		workspaceId,
		["update-ref", ref, tree, ZERO_OBJECT_ID],
		options,
		"task_base_anchor",
	);
	return { ref, tree };
}

export async function captureTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ runId, taskId, ...inputOptions } = {},
) {
	if (!executionBackend || typeof executionBackend.execArgv !== "function") {
		throw new TypeError("execution backend does not support task-base capture");
	}
	const safeRunId = taskBaseComponent(runId, "runId");
	const safeTaskId = taskBaseComponent(taskId, "taskId");
	const options = taskBaseProbeOptions(inputOptions);
	await backendGitAsync(
		executionBackend,
		workspaceId,
		["add", "-A"],
		options,
		"task_base_stage",
	);
	const tree = taskBaseTree(
		(
			await backendGitAsync(
				executionBackend,
				workspaceId,
				["write-tree"],
				options,
				"task_base_write",
			)
		).trim(),
	);
	const ref = `${TASK_BASE_REF_PREFIX}/${safeRunId}/${safeTaskId}`;
	await backendGitAsync(
		executionBackend,
		workspaceId,
		["update-ref", ref, tree, ZERO_OBJECT_ID],
		options,
		"task_base_anchor",
	);
	return { ref, tree };
}

/** Validate a task base against both the durable expected hash and its ref. */
export function validateTaskStartTree(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const expectedTree = taskBaseTree(tree);
	if (
		typeof ref !== "string" ||
		!new RegExp(
			`^${TASK_BASE_REF_PREFIX}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
			"u",
		).test(ref)
	) {
		throw new TypeError("task base ref must be in refs/switchyard/task-base");
	}
	const actualTree = backendGit(
		executionBackend,
		workspaceId,
		["rev-parse", "--verify", `${ref}^{tree}`],
		options,
		"task_base_validate",
	).trim();
	if (actualTree !== expectedTree) {
		throw new Error("task base ref does not match the recorded tree");
	}
	return { ref, tree: expectedTree };
}

export async function validateTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const expectedTree = taskBaseTree(tree);
	if (
		typeof ref !== "string" ||
		!new RegExp(
			`^${TASK_BASE_REF_PREFIX}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
			"u",
		).test(ref)
	)
		throw new TypeError("task base ref must be in refs/switchyard/task-base");
	const options = taskBaseProbeOptions(inputOptions);
	const actualTree = (
		await backendGitAsync(
			executionBackend,
			workspaceId,
			["rev-parse", "--verify", `${ref}^{tree}`],
			options,
			"task_base_validate",
		)
	).trim();
	if (actualTree !== expectedTree)
		throw new Error("task base ref does not match the recorded tree");
	return { ref, tree: expectedTree };
}

/** Remove a task-base anchor only after that task reaches final disposition. */
export function releaseTaskStartTree(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const base = validateTaskStartTree(
		executionBackend,
		workspaceId,
		{
			ref,
			tree,
		},
		options,
	);
	backendGit(
		executionBackend,
		workspaceId,
		["update-ref", "-d", base.ref, base.tree],
		options,
		"task_base_release",
	);
}

export async function releaseTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const base = await validateTaskStartTreeAsync(
		executionBackend,
		workspaceId,
		{ ref, tree },
		options,
	);
	await backendGitAsync(
		executionBackend,
		workspaceId,
		["update-ref", "-d", base.ref, base.tree],
		options,
		"task_base_release",
	);
}

/**
 * Seed a backend workspace from the host repository's committed tree.
 * `pushTar` is the only payload transfer; the baseline git setup runs through
 * the same backend execution prefix, so this works for any ExecutionBackend
 * implementation without a host mount.
 * @param {import("./execution-backend.mjs").ExecutionBackend} executionBackend
 * @param {string} workspaceId
 * @param {string} projectPath
 * @returns {object} backend transfer receipt
 */
export function seedProjectWithBackend(
	executionBackend,
	workspaceId,
	projectPath,
) {
	if (!executionBackend || typeof executionBackend.pushTar !== "function") {
		throw new TypeError("execution backend does not support tar transfer");
	}
	if (typeof workspaceId !== "string" || workspaceId.length === 0) {
		throw new TypeError("workspaceId must be a non-empty backend handle");
	}
	const tar = execFileSync("git", ["-C", projectPath, "archive", "HEAD"], {
		maxBuffer: 256 * 1024 * 1024,
	});
	const receipt = executionBackend.pushTar(workspaceId, tar, "/project");
	// Repeat-safe on purpose: execGuest retries a prlctl job misfire, so this
	// script can run a second time against a guest that already ran it to
	// completion. `git init` and `git add` are no-ops on the second pass, but an
	// unguarded `commit --allow-empty` would stack a redundant baseline commit,
	// so the commit is gated on HEAD not already existing. `--allow-empty` stays
	// because an empty project still needs a baseline for HEAD to resolve.
	const script =
		"git init -q && git add -A -f && { git rev-parse --verify -q HEAD >/dev/null || git -c user.name=switchyard -c user.email=switchyard@localhost commit --allow-empty -qm baseline; }";
	if (typeof executionBackend.execGuest === "function") {
		executionBackend.execGuest(workspaceId, "/bin/bash", ["-lc", script], {
			cwd: "/project",
		});
	} else {
		const execution = executionBackend.execArgv(workspaceId, {
			cwd: "/project",
			argv: ["/bin/bash", "-lc", script],
		});
		execFileSync(execution.command, execution.args, { stdio: "pipe" });
	}
	return receipt;
}

export * from "./execution-backend.mjs";
export * from "./parallels-execution-backend.mjs";
