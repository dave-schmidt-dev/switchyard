import { execFileSync } from "node:child_process";
import {
	validateTaskStartTree,
	validateTaskStartTreeAsync,
} from "../lifecycle/index.mjs";
import { getWorkspaceExecution } from "./provider-lifecycle-completion.mjs";
import {
	markerContext,
	runProviderProcess,
} from "./provider-lifecycle-process.mjs";
import { validateIdentifier } from "./shell-safety.mjs";

const PRLCTL_LOST_RESULT_SIGNATURE =
	/^PrlJob_(?:GetRetCode|GetResult): Invalid argument(?:\. An invalid argument was passed\.)?\r?\n?$/u;
function extractChildProcessStderr(value) {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return "";
}
function isParallelsLostResultAsync(result) {
	return (
		result?.code === 255 &&
		result?.signal === null &&
		!result?.timedOut &&
		!result?.cancelled &&
		!result?.cleanupFailed &&
		PRLCTL_LOST_RESULT_SIGNATURE.test(extractChildProcessStderr(result?.stderr))
	);
}
function isParallelsLostResultSync(error) {
	if (
		error?.status !== 255 ||
		error?.signal != null ||
		error?.code === "ETIMEDOUT" ||
		error?.killed === true ||
		error?.message === "diff capture deadline exhausted"
	) {
		return false;
	}
	const stderr =
		error?.stderr != null
			? extractChildProcessStderr(error.stderr)
			: typeof error?.message === "string"
				? error.message
				: "";
	return PRLCTL_LOST_RESULT_SIGNATURE.test(stderr);
}
export async function captureProviderDiffAsync(
	workingContainerName,
	options = {},
) {
	const result = await captureProviderDiffDetailedAsync(
		workingContainerName,
		options,
	);
	return result.status === "captured" ? result.diff : null;
}
export async function captureProviderDiffDetailedAsync(
	workingContainerName,
	options = {},
) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return {
			status: "stage_failed",
			diff: null,
			reasonCode: "invalid_workspace",
		};
	}
	const {
		spawnFn,
		timeoutMs = 30_000,
		executionBackend,
		cleanup,
		onStatus,
		cleanupContext,
		taskBase,
		now = Date.now,
		...lifecycleOptions
	} = options;
	const deadlineMs = options.deadlineMs ?? now() + timeoutMs;
	const remainingMs = () => {
		const remaining = Math.floor(deadlineMs - now());
		if (remaining <= 0) {
			throw Object.assign(new Error("diff capture deadline exhausted"), {
				code: "ETIMEDOUT",
			});
		}
		return remaining;
	};
	const timedOut = (error) =>
		error?.code === "ETIMEDOUT" ||
		error?.killed === true ||
		error?.message === "diff capture deadline exhausted";
	const emitCaptureStatus = (event, stage) => {
		try {
			onStatus?.({
				phase: "execution",
				event,
				stage,
				...(event === "diff_capture_probe_recovered" ? { mode: "replay" } : {}),
				status:
					event === "diff_capture_probe_recovered"
						? `${stage} recovered from a Parallels lost result`
						: `${stage} ${event.endsWith("started") ? "started" : event.endsWith("completed") ? "completed" : "failed"}`,
			});
		} catch {
			// Telemetry cannot alter capture.
		}
	};
	const captureCleanup = (command, args) => async () => {
		let backendError = null;
		let backendHandled = false;
		if (typeof executionBackend?.cleanupProviderProcess === "function") {
			try {
				await executionBackend.cleanupProviderProcess(command, args, {
					onStatus,
					workspaceId: workingContainerName,
					...markerContext(cleanupContext, "helper"),
				});
				backendHandled = true;
			} catch (error) {
				backendError = error;
			}
		}
		if (!backendHandled && typeof cleanup === "function") await cleanup();
		if (backendError) throw backendError;
	};
	const lifecycle = {
		...lifecycleOptions,
		spawnFn,
		timeoutMs,
	};
	let stage;
	try {
		stage = getWorkspaceExecution(workingContainerName, {
			...options,
			cleanupContext: markerContext(cleanupContext, "helper"),
			recordPid: true,
			argv: ["git", "add", "-A"],
		});
	} catch {
		return { status: "transport_failed", diff: null };
	}
	emitCaptureStatus("diff_capture_probe_started", "diff_stage");
	let addTimeoutMs;
	try {
		addTimeoutMs = remainingMs();
	} catch {
		emitCaptureStatus("diff_capture_probe_failed", "diff_stage");
		return { status: "timed_out", diff: null };
	}
	let add = await runProviderProcess(stage.command, stage.args, {
		...lifecycle,
		timeoutMs: addTimeoutMs,
		cleanup: captureCleanup(stage.command, stage.args),
	});
	if (!add.success && isParallelsLostResultAsync(add)) {
		emitCaptureStatus("diff_capture_probe_recovered", "diff_stage");
		let replayTimeoutMs;
		try {
			replayTimeoutMs = remainingMs();
		} catch {
			emitCaptureStatus("diff_capture_probe_failed", "diff_stage");
			return { status: "timed_out", diff: null };
		}
		let replayStage;
		try {
			replayStage = getWorkspaceExecution(workingContainerName, {
				...options,
				cleanupContext: markerContext(cleanupContext, "helper"),
				recordPid: true,
				argv: ["git", "add", "-A"],
			});
		} catch {
			emitCaptureStatus("diff_capture_probe_failed", "diff_stage");
			return { status: "transport_failed", diff: null };
		}
		add = await runProviderProcess(replayStage.command, replayStage.args, {
			...lifecycle,
			timeoutMs: replayTimeoutMs,
			cleanup: captureCleanup(replayStage.command, replayStage.args),
		});
	}
	if (!add.success) {
		emitCaptureStatus("diff_capture_probe_failed", "diff_stage");
		return {
			status: add.timedOut
				? "timed_out"
				: add.error || isParallelsLostResultAsync(add)
					? "transport_failed"
					: "stage_failed",
			diff: null,
			...(isParallelsLostResultAsync(add)
				? { reasonCode: "prlctl_job_misfire" }
				: {}),
		};
	}
	emitCaptureStatus("diff_capture_probe_completed", "diff_stage");
	try {
		if (!taskBase) throw new Error("missing task base");
		await validateTaskStartTreeAsync(
			executionBackend,
			workingContainerName,
			taskBase,
			{
				deadlineMs,
				timeoutMs,
				now,
				signal: options.signal,
				onStatus,
				cleanupContext: markerContext(cleanupContext, "helper"),
			},
		);
	} catch (error) {
		return {
			status: timedOut(error) ? "timed_out" : "diff_failed",
			diff: null,
			...(timedOut(error) ? {} : { reasonCode: "task_base_invalid" }),
		};
	}
	let capture;
	try {
		capture = getWorkspaceExecution(workingContainerName, {
			...options,
			cleanupContext: markerContext(cleanupContext, "helper"),
			recordPid: true,
			argv: ["git", "diff", "--cached", taskBase.tree],
		});
	} catch {
		return { status: "transport_failed", diff: null };
	}
	emitCaptureStatus("diff_capture_probe_started", "diff_export");
	let diffTimeoutMs;
	try {
		diffTimeoutMs = remainingMs();
	} catch {
		emitCaptureStatus("diff_capture_probe_failed", "diff_export");
		return { status: "timed_out", diff: null };
	}
	let diff = await runProviderProcess(capture.command, capture.args, {
		...lifecycle,
		timeoutMs: diffTimeoutMs,
		cleanup: captureCleanup(capture.command, capture.args),
	});
	if (!diff.success && isParallelsLostResultAsync(diff)) {
		emitCaptureStatus("diff_capture_probe_recovered", "diff_export");
		let replayTimeoutMs;
		try {
			replayTimeoutMs = remainingMs();
		} catch {
			emitCaptureStatus("diff_capture_probe_failed", "diff_export");
			return { status: "timed_out", diff: null };
		}
		let replayCapture;
		try {
			replayCapture = getWorkspaceExecution(workingContainerName, {
				...options,
				cleanupContext: markerContext(cleanupContext, "helper"),
				recordPid: true,
				argv: ["git", "diff", "--cached", taskBase.tree],
			});
		} catch {
			emitCaptureStatus("diff_capture_probe_failed", "diff_export");
			return { status: "transport_failed", diff: null };
		}
		diff = await runProviderProcess(replayCapture.command, replayCapture.args, {
			...lifecycle,
			timeoutMs: replayTimeoutMs,
			cleanup: captureCleanup(replayCapture.command, replayCapture.args),
		});
	}
	if (!diff.success) {
		emitCaptureStatus("diff_capture_probe_failed", "diff_export");
		return {
			status: diff.timedOut
				? "timed_out"
				: diff.error || isParallelsLostResultAsync(diff)
					? "transport_failed"
					: "diff_failed",
			diff: null,
			...(isParallelsLostResultAsync(diff)
				? { reasonCode: "prlctl_job_misfire" }
				: {}),
		};
	}
	emitCaptureStatus("diff_capture_probe_completed", "diff_export");
	return /\S/u.test(diff.output)
		? { status: "captured", diff: diff.output }
		: { status: "empty", diff: null };
}
export function captureProviderDiffDetailed(
	workingContainerName,
	options = {},
) {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const now = options.now ?? Date.now;
	const deadlineMs = options.deadlineMs ?? now() + timeoutMs;
	const remainingMs = () => {
		const remaining = Math.floor(deadlineMs - now());
		if (remaining <= 0) {
			throw Object.assign(new Error("diff capture deadline exhausted"), {
				code: "ETIMEDOUT",
			});
		}
		return remaining;
	};
	const timedOut = (error) =>
		error?.code === "ETIMEDOUT" ||
		error?.killed === true ||
		error?.message === "diff capture deadline exhausted";
	const emitCaptureStatus = (event, stage) => {
		try {
			options.onStatus?.({
				phase: "execution",
				event,
				stage,
				...(event === "diff_capture_probe_recovered" ? { mode: "replay" } : {}),
				status:
					event === "diff_capture_probe_recovered"
						? `${stage} recovered from a Parallels lost result`
						: `${stage} ${event.endsWith("started") ? "started" : event.endsWith("completed") ? "completed" : "failed"}`,
			});
		} catch {
			// Telemetry cannot alter capture.
		}
	};
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return {
			status: "stage_failed",
			diff: null,
			reasonCode: "invalid_workspace",
		};
	}
	let stage;
	try {
		emitCaptureStatus("diff_capture_probe_started", "diff_stage");
		stage = getWorkspaceExecution(workingContainerName, {
			...options,
			cleanupContext: markerContext(options.cleanupContext, "helper"),
			recordPid: true,
			argv: ["git", "add", "-A"],
		});
		try {
			execFileSync(stage.command, stage.args, {
				stdio: "pipe",
				timeout: remainingMs(),
				killSignal: "SIGKILL",
				signal: options.signal,
			});
		} catch (error) {
			if (!isParallelsLostResultSync(error)) throw error;
			emitCaptureStatus("diff_capture_probe_recovered", "diff_stage");
			const replayTimeoutMs = remainingMs();
			const replayStage = getWorkspaceExecution(workingContainerName, {
				...options,
				cleanupContext: markerContext(options.cleanupContext, "helper"),
				recordPid: true,
				argv: ["git", "add", "-A"],
			});
			execFileSync(replayStage.command, replayStage.args, {
				stdio: "pipe",
				timeout: replayTimeoutMs,
				killSignal: "SIGKILL",
				signal: options.signal,
			});
		}
		emitCaptureStatus("diff_capture_probe_completed", "diff_stage");
	} catch (error) {
		emitCaptureStatus("diff_capture_probe_failed", "diff_stage");
		return {
			status: timedOut(error)
				? "timed_out"
				: error?.status == null || isParallelsLostResultSync(error)
					? "transport_failed"
					: "stage_failed",
			diff: null,
			...(isParallelsLostResultSync(error)
				? { reasonCode: "prlctl_job_misfire" }
				: {}),
		};
	}
	try {
		if (!options.taskBase) throw new Error("missing task base");
		validateTaskStartTree(
			options.executionBackend,
			workingContainerName,
			options.taskBase,
			{
				timeoutMs,
				deadlineMs,
				now,
				signal: options.signal,
				onStatus: options.onStatus,
				cleanupContext: markerContext(options.cleanupContext, "helper"),
			},
		);
	} catch (error) {
		return {
			status: timedOut(error) ? "timed_out" : "diff_failed",
			diff: null,
			...(timedOut(error) ? {} : { reasonCode: "task_base_invalid" }),
		};
	}
	try {
		emitCaptureStatus("diff_capture_probe_started", "diff_export");
		const capture = getWorkspaceExecution(workingContainerName, {
			...options,
			cleanupContext: markerContext(options.cleanupContext, "helper"),
			recordPid: true,
			argv: ["git", "diff", "--cached", options.taskBase.tree],
		});
		let diff;
		try {
			diff = execFileSync(capture.command, capture.args, {
				encoding: "utf8",
				stdio: "pipe",
				timeout: remainingMs(),
				killSignal: "SIGKILL",
				signal: options.signal,
			});
		} catch (error) {
			if (!isParallelsLostResultSync(error)) throw error;
			emitCaptureStatus("diff_capture_probe_recovered", "diff_export");
			const replayTimeoutMs = remainingMs();
			const replayCapture = getWorkspaceExecution(workingContainerName, {
				...options,
				cleanupContext: markerContext(options.cleanupContext, "helper"),
				recordPid: true,
				argv: ["git", "diff", "--cached", options.taskBase.tree],
			});
			diff = execFileSync(replayCapture.command, replayCapture.args, {
				encoding: "utf8",
				stdio: "pipe",
				timeout: replayTimeoutMs,
				killSignal: "SIGKILL",
				signal: options.signal,
			});
		}
		emitCaptureStatus("diff_capture_probe_completed", "diff_export");
		return /\S/u.test(diff)
			? { status: "captured", diff }
			: { status: "empty", diff: null };
	} catch (error) {
		emitCaptureStatus("diff_capture_probe_failed", "diff_export");
		return {
			status: timedOut(error)
				? "timed_out"
				: error?.status == null || isParallelsLostResultSync(error)
					? "transport_failed"
					: "diff_failed",
			diff: null,
			...(isParallelsLostResultSync(error)
				? { reasonCode: "prlctl_job_misfire" }
				: {}),
		};
	}
}
export function captureProviderDiff(workingContainerName, options = {}) {
	const result = captureProviderDiffDetailed(workingContainerName, options);
	return result.status === "captured" ? result.diff : null;
}
