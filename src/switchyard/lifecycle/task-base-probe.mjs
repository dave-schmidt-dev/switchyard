import { execFile, execFileSync } from "node:child_process";
import {
	PRLCTL_LOST_RESULT,
	TASK_BASE_PROBE_TIMEOUT_MS,
} from "./overlay-paths.mjs";

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
	if (remainingMs <= 0) {
		// Carries the same code a killed child would: a caller classifying the
		// failure must read "out of budget", not "this task base is invalid".
		throw Object.assign(new Error("task base probe deadline exhausted"), {
			code: "ETIMEDOUT",
		});
	}
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
function isParallelsLostResult(error) {
	return PRLCTL_LOST_RESULT.test(
		[String(error?.stderr ?? ""), String(error?.message ?? "")].join("\n"),
	);
}
function emitTaskBaseRecovery(options, stage, mode) {
	try {
		options.onStatus?.({
			phase: "checkpoint",
			event: "task_base_probe_recovered",
			stage,
			mode,
			status: `${stage} recovered from a Parallels lost result`,
		});
	} catch {
		// Status cannot alter immutable-base capture.
	}
}
function backendGit(
	executionBackend,
	workspaceId,
	argv,
	options,
	stage,
	{ retryLostResult = false } = {},
) {
	emitProbeStatus(options, "task_base_probe_started", stage);
	try {
		const run = () => {
			const execution = backendExecution(
				executionBackend,
				workspaceId,
				argv,
				options,
			);
			return execFileSync(execution.command, execution.args, {
				encoding: "utf8",
				stdio: "pipe",
				timeout: probeRemainingMs(options),
				killSignal: "SIGKILL",
				signal: options.signal,
			});
		};
		let output;
		try {
			output = run();
		} catch (error) {
			if (!retryLostResult || !isParallelsLostResult(error)) throw error;
			emitTaskBaseRecovery(options, stage, "replay");
			output = run();
		}
		emitProbeStatus(options, "task_base_probe_completed", stage);
		return output;
	} catch (error) {
		emitProbeStatus(options, "task_base_probe_failed", stage);
		throw error;
	}
}
function backendGitAsync(
	executionBackend,
	workspaceId,
	argv,
	options,
	stage,
	{ retryLostResult = false } = {},
) {
	emitProbeStatus(options, "task_base_probe_started", stage);
	const run = () => {
		const execution = backendExecution(
			executionBackend,
			workspaceId,
			argv,
			options,
		);
		return new Promise((resolve, reject) => {
			execFile(
				execution.command,
				execution.args,
				{
					encoding: "utf8",
					timeout: probeRemainingMs(options),
					killSignal: "SIGKILL",
					signal: options.signal,
				},
				(error, stdout) => {
					if (error) {
						reject(error);
						return;
					}
					resolve(stdout);
				},
			);
		});
	};
	return Promise.resolve()
		.then(run)
		.catch(async (error) => {
			if (!retryLostResult || !isParallelsLostResult(error)) throw error;
			emitTaskBaseRecovery(options, stage, "replay");
			return run();
		})
		.then((output) => {
			emitProbeStatus(options, "task_base_probe_completed", stage);
			return output;
		})
		.catch((error) => {
			emitProbeStatus(options, "task_base_probe_failed", stage);
			throw error;
		});
}

export {
	backendGit,
	backendGitAsync,
	emitTaskBaseRecovery,
	isParallelsLostResult,
	taskBaseComponent,
	taskBaseProbeOptions,
	taskBaseTree,
};
