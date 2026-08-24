// Shared asynchronous lifecycle for provider processes.
//
// Provider adapters deliberately own only argv construction and result
// classification. This module owns the process lifetime: bounded output
// capture, heartbeat polling, timeout escalation, cancellation, cleanup, and
// the exactly-once terminal transition.

import { execFileSync, spawn as nodeSpawn } from "node:child_process";

import {
	classifyProviderDiagnostic,
	cleanupDiagnosticCodeFor,
	describeExecError,
} from "./exec-error.mjs";
import { validateIdentifier } from "./shell-safety.mjs";

const DEFAULT_MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TERM_GRACE_MS = 250;
const DEFAULT_DIAGNOSTIC_CHARS = 800;

/**
 * Resolve the complete transport invocation for one provider command. The
 * backend owns the command, the workspace prefix, any transport option needed
 * to deliver stdin, and — on a transport that re-parses its argument vector in
 * the guest — the quoting of `argv`. Callers hand over the whole command
 * vector and never splice VM-specific flags into the result.
 *
 * `argv` is mandatory. An adapter that builds the prefix and appends its own
 * command is silently word-split on the VM lane, so the seam refuses the
 * shape rather than letting it reach a guest. `executionBackend` is likewise
 * mandatory (no default): runner/index.mjs's createQueueBackend always
 * threads a real one, so a missing backend here means a call site failed to
 * thread it, and that must fail loudly rather than construct an
 * unconfigured backend with no golden image / Aqua identity.
 */
export function getWorkspaceExecution(
	workspaceId,
	{ executionBackend, cwd = "/project", argv, recordPid = true } = {},
) {
	if (!executionBackend) {
		throw new TypeError(
			"getWorkspaceExecution requires an executionBackend — none was threaded through",
		);
	}
	const execution = executionBackend.execArgv(workspaceId, {
		cwd,
		argv,
		recordPid,
	});
	return { command: execution.command, args: [...execution.args] };
}

function appendBounded(current, chunk, maxBuffer) {
	const text = Buffer.isBuffer(chunk)
		? chunk.toString("utf8")
		: String(chunk ?? "");
	if (!text) return current;
	const remaining = maxBuffer - Buffer.byteLength(current, "utf8");
	if (remaining <= 0) return current;
	return current + text.slice(0, remaining);
}

function safeTimer(fn, delay, setTimeoutFn) {
	try {
		return setTimeoutFn(fn, Math.max(0, delay));
	} catch {
		return null;
	}
}

/**
 * Spawn a provider command and supervise it without blocking the event loop.
 *
 * `cleanup` runs after TERM/KILL escalation and before a timeout/cancellation
 * result is resolved. Every exit path passes through one guarded terminal
 * transition, so a late `close`/`error` event cannot emit a second result or
 * heartbeat after terminalization.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @returns {Promise<{success:boolean,output:string,stderr:string,code:number|null,signal:string|null,timedOut:boolean,cancelled:boolean,elapsedMs:number}>}
 */
export function runProviderProcess(command, args, options = {}) {
	const {
		input,
		timeoutMs = 30 * 60 * 1000,
		maxBuffer = DEFAULT_MAX_BUFFER,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		termGraceMs = DEFAULT_TERM_GRACE_MS,
		spawnFn = nodeSpawn,
		cleanup,
		signal,
		onPoll,
		now = Date.now,
		setTimeoutFn = setTimeout,
		clearTimeoutFn = clearTimeout,
		setIntervalFn = setInterval,
		clearIntervalFn = clearInterval,
	} = options;

	return new Promise((resolve) => {
		const startedAt = now();
		let child;
		let stdout = "";
		let stderr = "";
		let settled = false;
		let terminationRequested = false;
		let cleanupPromise = null;
		let cleanupError = null;
		let cleanupResult = null;
		let timedOut = false;
		let cancelled = false;
		let timeoutTimer = null;
		let escalationTimer = null;
		let pollTimer = null;

		const clearTimers = () => {
			if (timeoutTimer !== null) clearTimeoutFn(timeoutTimer);
			if (escalationTimer !== null) clearTimeoutFn(escalationTimer);
			if (pollTimer !== null) clearIntervalFn(pollTimer);
			timeoutTimer = null;
			escalationTimer = null;
			pollTimer = null;
		};

		const terminal = async ({
			code = null,
			signal: exitSignal = null,
			error,
		} = {}) => {
			if (settled) return;
			settled = true;
			clearTimers();
			if (typeof signal?.removeEventListener === "function") {
				signal.removeEventListener("abort", abort);
			}
			const elapsedMs = Math.max(0, now() - startedAt);
			resolve({
				success:
					!timedOut && !cancelled && !error && !cleanupError && code === 0,
				output: stdout,
				stderr,
				code,
				signal: exitSignal,
				timedOut,
				cancelled,
				elapsedMs,
				error: cleanupError ?? error,
				cleanupFailed: Boolean(cleanupError),
				cleanupStage:
					cleanupError?.cleanupStage ?? cleanupResult?.cleanupStage ?? null,
			});
		};

		const runCleanup = async () => {
			if (cleanupPromise) return cleanupPromise;
			cleanupPromise = Promise.resolve()
				.then(async () => {
					cleanupResult =
						typeof cleanup === "function" ? await cleanup() : undefined;
				})
				.catch((error) => {
					cleanupError = error;
				});
			return cleanupPromise;
		};

		const finishAfterCleanup = async (details) => {
			await runCleanup();
			await terminal(details);
		};

		const requestTermination = (reason) => {
			if (terminationRequested || settled) return;
			terminationRequested = true;
			timedOut = reason === "timeout";
			cancelled = reason === "cancel";
			try {
				child?.kill?.("SIGTERM");
			} catch {
				// Escalation below still attempts SIGKILL.
			}
			escalationTimer = safeTimer(
				() => {
					try {
						child?.kill?.("SIGKILL");
					} catch {
						// The child may have exited between TERM and KILL.
					}
					// A fake or detached child may never emit close. Resolve after the
					// escalation window while keeping close/error idempotent.
					void finishAfterCleanup({
						code: null,
						signal: "SIGKILL",
						error: timedOut
							? new Error("provider execution timed out")
							: new Error("provider execution cancelled"),
					});
				},
				termGraceMs,
				setTimeoutFn,
			);
		};

		const abort = () => requestTermination("cancel");

		try {
			child = spawnFn(command, args, {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			void terminal({ error });
			return;
		}

		child.stdout?.on?.("data", (chunk) => {
			stdout = appendBounded(stdout, chunk, maxBuffer);
		});
		child.stderr?.on?.("data", (chunk) => {
			stderr = appendBounded(stderr, chunk, maxBuffer);
		});
		child.once?.("error", (error) => {
			if (terminationRequested) return;
			void terminal({ error });
		});
		child.once?.("close", (code, exitSignal) => {
			if (settled) return;
			if (terminationRequested) {
				void finishAfterCleanup({ code, signal: exitSignal });
				return;
			}
			void terminal({ code, signal: exitSignal });
		});

		if (input !== undefined && child.stdin) {
			child.stdin.end(input);
		}
		if (typeof signal?.addEventListener === "function") {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
		timeoutTimer = safeTimer(
			() => requestTermination("timeout"),
			timeoutMs,
			setTimeoutFn,
		);
		if (typeof onPoll === "function" && pollIntervalMs > 0) {
			pollTimer = setIntervalFn(() => {
				if (settled) return;
				const elapsedMs = Math.max(0, now() - startedAt);
				try {
					onPoll({
						elapsedMs,
						stdoutBytes: Buffer.byteLength(stdout),
						stderrBytes: Buffer.byteLength(stderr),
					});
				} catch {
					// Telemetry must never alter provider execution.
				}
			}, pollIntervalMs);
		}
	});
}

/** Truncate a diagnostic before it crosses an adapter/status boundary. */
function truncateDiagnostic(value, maxChars = DEFAULT_DIAGNOSTIC_CHARS) {
	const text = typeof value === "string" ? value : String(value ?? "");
	return text.length <= maxChars
		? text
		: `${text.slice(0, maxChars)}… (truncated)`;
}

/**
 * Run a provider invocation and map the supervised process into the adapter's
 * established result shape. Provider-specific diagnostics are classified at
 * this boundary and remain bounded before callers can persist/report them.
 */
export async function executeProviderInvocation(command, args, options = {}) {
	const {
		provider,
		cleanup,
		executionBackend,
		onStatus,
		cleanupContext,
		idleExitCode,
		...lifecycleOptions
	} = options;
	// A backend that implements cleanupProviderProcess() (currently only
	// ParallelsExecutionBackend) is authoritative for its own transport — the
	// adapter's `cleanup` (killOrphanedProcessesAsync, Docker-only) would be a
	// guaranteed-to-fail no-op against a VM workspace id, so it only runs as a
	// fallback: when no such backend method exists, or when it throws.
	const cleanupWithBackend = async () => {
		let backendError = null;
		let backendHandled = false;
		if (typeof executionBackend?.cleanupProviderProcess === "function") {
			try {
				const backendResult = await executionBackend.cleanupProviderProcess(
					command,
					args,
					{
						onStatus,
						...(cleanupContext ?? {}),
					},
				);
				backendHandled = true;
				return backendResult;
			} catch (error) {
				backendError = error;
			}
		}
		if (!backendHandled && typeof cleanup === "function") {
			await cleanup();
		}
		if (backendError) throw backendError;
	};
	const result = await runProviderProcess(command, args, {
		...lifecycleOptions,
		cleanup: cleanupWithBackend,
	});
	if (result.success) return { output: result.output, success: true };
	// A provider whose container-side supervisor reports this reserved exit code
	// finished its work but could not exit on its own (see opencode.mjs). The
	// work is in the working tree, so it is mapped to success and the captured
	// diff still passes through the integration gate.
	if (
		typeof idleExitCode === "number" &&
		result.code === idleExitCode &&
		!result.timedOut &&
		!result.cancelled &&
		!result.error
	) {
		return {
			output: result.output,
			stderr: result.stderr,
			success: true,
			idleTerminated: true,
		};
	}
	if (result.timedOut) {
		return {
			output: result.output,
			success: false,
			error: result.cleanupFailed
				? truncateDiagnostic(
						result.error?.message ?? "provider cleanup failed after timeout",
					)
				: "provider execution timed out (ETIMEDOUT)",
			timedOut: true,
			cleanupFailed: result.cleanupFailed,
			diagnosticCode: result.cleanupFailed
				? (cleanupDiagnosticCodeFor(result.cleanupStage) ??
					"provider_cleanup_failed")
				: "execution_timed_out",
			cleanupStage: result.cleanupStage,
			failurePhase: result.cleanupFailed
				? "provider_cleanup"
				: "provider_execution",
			exitCode: Number.isSafeInteger(result.code) ? result.code : null,
			signal: result.signal ?? null,
		};
	}
	if (result.cancelled) {
		const cleanupFailed = result.cleanupFailed === true;
		return {
			output: result.output,
			success: false,
			error: cleanupFailed
				? "provider cleanup failed after cancellation"
				: "provider execution cancelled",
			cancelled: true,
			cleanupFailed,
			errorKind: cleanupFailed ? "provider_cleanup_failed" : undefined,
			diagnosticCode: cleanupFailed
				? (cleanupDiagnosticCodeFor(result.cleanupStage) ??
					"provider_cleanup_failed")
				: "execution_cancelled",
			failurePhase: cleanupFailed ? "provider_cleanup" : "provider_execution",
			cleanupStage: result.cleanupStage,
			exitCode: Number.isSafeInteger(result.code) ? result.code : null,
			signal: result.signal ?? null,
		};
	}
	const error = Object.assign(
		new Error(
			result.error?.message ??
				(result.signal
					? `provider exited via ${result.signal}`
					: `provider exited with code ${result.code ?? "unknown"}`),
		),
		{ stdout: result.output, stderr: result.stderr, code: result.code },
	);
	const described = describeExecError(error, { provider });
	return {
		output: described.output,
		success: false,
		error: truncateDiagnostic(described.error),
		errorKind: described.errorKind ?? "execution_failed",
		diagnosticCode: classifyProviderDiagnostic({
			errorKind: described.errorKind,
			text: `${result.output ?? ""}\n${result.stderr ?? ""}`,
			exitCode: result.code,
			signal: result.signal,
		}),
		failurePhase: "provider_execution",
		exitCode: Number.isSafeInteger(result.code) ? result.code : null,
		signal: result.signal ?? null,
	};
}

/**
 * Capture a working-container diff without blocking the host event loop.
 * Both git operations use the shared supervised process lifecycle, allowing
 * hermetic callers to inject a fake spawn implementation.
 */
export async function captureProviderDiffAsync(
	workingContainerName,
	options = {},
) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return null;
	}
	const { spawnFn, timeoutMs = 30_000, ...lifecycleOptions } = options;
	const lifecycle = {
		...lifecycleOptions,
		spawnFn,
		timeoutMs,
	};
	const stage = getWorkspaceExecution(workingContainerName, {
		...options,
		recordPid: false,
		argv: ["git", "add", "-A"],
	});
	const add = await runProviderProcess(stage.command, stage.args, lifecycle);
	if (!add.success) return null;
	const capture = getWorkspaceExecution(workingContainerName, {
		...options,
		recordPid: false,
		argv: ["git", "diff", "--cached", "HEAD"],
	});
	const diff = await runProviderProcess(
		capture.command,
		capture.args,
		lifecycle,
	);
	return diff.success && /\S/u.test(diff.output) ? diff.output : null;
}

/** Capture a working-container diff synchronously through the backend seam. */
export function captureProviderDiff(workingContainerName, options = {}) {
	try {
		validateIdentifier(workingContainerName, "workingContainerName");
	} catch {
		return null;
	}
	try {
		const stage = getWorkspaceExecution(workingContainerName, {
			...options,
			recordPid: false,
			argv: ["git", "add", "-A"],
		});
		execFileSync(stage.command, stage.args, { stdio: "pipe" });
		const capture = getWorkspaceExecution(workingContainerName, {
			...options,
			recordPid: false,
			argv: ["git", "diff", "--cached", "HEAD"],
		});
		const diff = execFileSync(capture.command, capture.args, {
			encoding: "utf8",
			stdio: "pipe",
		});
		return /\S/u.test(diff) ? diff : null;
	} catch {
		return null;
	}
}
