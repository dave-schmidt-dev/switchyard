// Shared asynchronous lifecycle for provider processes.
//
// Provider adapters deliberately own only argv construction and result
// classification. This module owns the process lifetime: bounded output
// capture, heartbeat polling, timeout escalation, cancellation, cleanup, and
// the exactly-once terminal transition.

import { spawn as nodeSpawn } from "node:child_process";
import { describeExecError } from "./exec-error.mjs";
import { validateIdentifier } from "./shell-safety.mjs";

const DEFAULT_MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TERM_GRACE_MS = 250;
const DEFAULT_DIAGNOSTIC_CHARS = 800;

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
				success: !timedOut && !cancelled && !error && code === 0,
				output: stdout,
				stderr,
				code,
				signal: exitSignal,
				timedOut,
				cancelled,
				elapsedMs,
				error,
			});
		};

		const runCleanup = async () => {
			if (cleanupPromise) return cleanupPromise;
			cleanupPromise = Promise.resolve()
				.then(() => (typeof cleanup === "function" ? cleanup() : undefined))
				.catch(() => {
					// Cleanup is best effort; the provider result remains authoritative.
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
	const { provider, cleanup, ...lifecycleOptions } = options;
	const result = await runProviderProcess(command, args, {
		...lifecycleOptions,
		cleanup,
	});
	if (result.success) return { output: result.output, success: true };
	if (result.timedOut) {
		return {
			output: result.output,
			success: false,
			error: "provider execution timed out (ETIMEDOUT)",
			timedOut: true,
		};
	}
	if (result.cancelled) {
		return {
			output: result.output,
			success: false,
			error: "provider execution cancelled",
			cancelled: true,
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
		errorKind: described.errorKind,
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
	const add = await runProviderProcess(
		"docker",
		["exec", "-w", "/project", workingContainerName, "git", "add", "-A"],
		lifecycle,
	);
	if (!add.success) return null;
	const diff = await runProviderProcess(
		"docker",
		[
			"exec",
			"-w",
			"/project",
			workingContainerName,
			"git",
			"diff",
			"--cached",
			"HEAD",
		],
		lifecycle,
	);
	return diff.success && /\S/u.test(diff.output) ? diff.output : null;
}
