import { spawn as nodeSpawn } from "node:child_process";
import {
	createProgressSnapshot,
	createProviderLifecycleSnapshot,
	DEFAULT_MAX_BUFFER,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_TERM_GRACE_MS,
} from "./provider-lifecycle-progress.mjs";

function markerContext(cleanupContext, operation) {
	if (!cleanupContext || typeof cleanupContext !== "object")
		return cleanupContext;
	return typeof cleanupContext.runId === "string" &&
		typeof cleanupContext.taskId === "string" &&
		typeof cleanupContext.attemptId === "string" &&
		typeof cleanupContext.descriptorIdentity === "string"
		? { ...cleanupContext, operation }
		: cleanupContext;
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
export function runProviderProcess(command, args, options = {}) {
	const {
		input,
		cwd,
		timeoutMs = 30 * 60 * 1000,
		maxBuffer = DEFAULT_MAX_BUFFER,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		silenceTimeoutMs = null,
		progressStage = "running",
		onProgress,
		termGraceMs = DEFAULT_TERM_GRACE_MS,
		spawnFn = nodeSpawn,
		cleanup,
		signal,
		onPoll,
		onStderrChunk,
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
		let pollCount = 0;
		let progressCount = 0;
		// This is intentionally tri-state. A normal close proves that the child
		// stopped; a spawn throw proves that it never started. Timeout/cancel
		// escalation is not proof when the child never emits close.
		let writerLifecycle = "unavailable";
		let lastSubstantiveProgressAt = null;
		let lastOutputAt = null;
		let silenceObserved = false;
		let terminalStatus = "running";
		let terminationReason = "none";
		let cleanupStatus = "not_required";
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
			if (
				Number.isFinite(silenceTimeoutMs) &&
				silenceTimeoutMs > 0 &&
				now() - (lastOutputAt ?? startedAt) >= silenceTimeoutMs
			) {
				silenceObserved = true;
			}
			const outcome = timedOut
				? "execution_timed_out"
				: cancelled
					? "cancelled"
					: code === 0 &&
							!error &&
							!cleanupError &&
							cleanupResult?.cleanupFailed !== true
						? "success"
						: "failure";
			if (terminalStatus === "running") {
				terminalStatus = terminationRequested ? "unobserved" : "exited";
			}
			if (cleanupError || cleanupResult?.cleanupFailed === true) {
				cleanupStatus = "failed";
			}
			const lifecycle = createProviderLifecycleSnapshot({
				pid: child?.pid,
				startedAt,
				deadlineAt: Number.isFinite(timeoutMs)
					? startedAt + Math.max(0, timeoutMs)
					: null,
				lastOutputAt,
				silenceObserved,
				silenceTimeoutMs,
				terminalStatus,
				terminationReason,
				exitCode: code,
				signal: exitSignal,
				writerLifecycle,
				cleanupStatus,
				cleanupStage:
					cleanupError?.cleanupStage ?? cleanupResult?.cleanupStage ?? null,
			});
			resolve({
				success:
					!timedOut &&
					!cancelled &&
					!error &&
					!cleanupError &&
					cleanupResult?.cleanupFailed !== true &&
					code === 0,
				output: stdout,
				stderr,
				code,
				signal: exitSignal,
				timedOut,
				// Legacy projection only; silence never independently terminates.
				silenceTimedOut: false,
				cancelled,
				elapsedMs,
				progress: createProgressSnapshot({
					stage: outcome === "success" ? "completed" : progressStage,
					elapsedMs,
					lastSubstantiveProgressAt:
						lastSubstantiveProgressAt === null
							? null
							: new Date(lastSubstantiveProgressAt).toISOString(),
					lastSubstantiveProgressAgeMs: Math.max(
						0,
						now() - (lastSubstantiveProgressAt ?? startedAt),
					),
					stdoutBytes: Buffer.byteLength(stdout),
					stderrBytes: Buffer.byteLength(stderr),
					pollCount,
					progressCount,
					outcome,
				}),
				error: cleanupError ?? error,
				cleanupFailed:
					Boolean(cleanupError) || cleanupResult?.cleanupFailed === true,
				cleanupStage:
					cleanupError?.cleanupStage ?? cleanupResult?.cleanupStage ?? null,
				writerLifecycle,
				providerLifecycle: lifecycle,
				pid: lifecycle.pid,
				startedAt: lifecycle.startedAt,
				deadlineAt: lifecycle.deadlineAt,
				lastOutputAt: lifecycle.lastOutputAt,
				silenceObserved: lifecycle.silenceObserved,
				terminationReason: lifecycle.terminationReason,
				terminalStatus: lifecycle.terminalStatus,
				cleanupStatus: lifecycle.cleanupStatus,
			});
		};

		const runCleanup = async () => {
			if (cleanupPromise) return cleanupPromise;
			cleanupPromise = Promise.resolve()
				.then(async () => {
					cleanupResult =
						typeof cleanup === "function" ? await cleanup() : undefined;
					cleanupStatus =
						typeof cleanup !== "function"
							? "not_required"
							: cleanupResult?.cleanupFailed === true
								? "failed"
								: "succeeded";
				})
				.catch((error) => {
					cleanupError = error;
					cleanupStatus = "failed";
				});
			return cleanupPromise;
		};

		const finishAfterCleanup = async (details) => {
			await runCleanup();
			await terminal(details);
		};

		const emitProgress = (substantive = false) => {
			const timestamp = now();
			if (
				Number.isFinite(silenceTimeoutMs) &&
				silenceTimeoutMs > 0 &&
				timestamp - (lastOutputAt ?? startedAt) >= silenceTimeoutMs
			) {
				silenceObserved = true;
			}
			if (substantive) {
				lastOutputAt = timestamp;
				silenceObserved = false;
				lastSubstantiveProgressAt = timestamp;
				progressCount += 1;
			}
			try {
				onProgress?.(
					createProgressSnapshot({
						stage: progressStage,
						elapsedMs: Math.max(0, timestamp - startedAt),
						lastSubstantiveProgressAt:
							lastSubstantiveProgressAt === null
								? null
								: new Date(lastSubstantiveProgressAt).toISOString(),
						lastSubstantiveProgressAgeMs: Math.max(
							0,
							timestamp - (lastSubstantiveProgressAt ?? startedAt),
						),
						stdoutBytes: Buffer.byteLength(stdout),
						stderrBytes: Buffer.byteLength(stderr),
						pollCount,
						progressCount,
						outcome: "running",
					}),
				);
			} catch {
				// Progress is observational and cannot alter execution.
			}
		};

		const requestTermination = (reason) => {
			if (terminationRequested || settled) return;
			terminationRequested = true;
			timedOut = reason === "timeout";
			cancelled = reason === "cancel";
			terminationReason = timedOut ? "deadline" : "cancelled";
			if (
				timedOut &&
				Number.isFinite(silenceTimeoutMs) &&
				silenceTimeoutMs > 0 &&
				now() - (lastOutputAt ?? startedAt) >= silenceTimeoutMs
			) {
				silenceObserved = true;
			}
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
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			writerLifecycle = "never_started";
			terminalStatus = "spawn_failed";
			terminationReason = "admission";
			void terminal({ error });
			return;
		}

		child.stdout?.on?.("data", (chunk) => {
			stdout = appendBounded(stdout, chunk, maxBuffer);
			emitProgress(true);
		});
		child.stderr?.on?.("data", (chunk) => {
			stderr = appendBounded(stderr, chunk, maxBuffer);
			try {
				onStderrChunk?.(chunk);
			} catch {
				// Diagnostic consumers must not alter provider execution.
			}
			emitProgress(true);
		});
		child.once?.("error", (error) => {
			if (terminationRequested) return;
			terminalStatus = "spawn_failed";
			terminationReason = "admission";
			void terminal({ error });
		});
		child.once?.("close", (code, exitSignal) => {
			if (settled) return;
			writerLifecycle = "stopped";
			if (terminationRequested) {
				terminalStatus = "terminated";
				void finishAfterCleanup({ code, signal: exitSignal });
				return;
			}
			terminalStatus = "exited";
			terminationReason = "completed";
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
				pollCount += 1;
				try {
					onPoll({
						elapsedMs,
						stdoutBytes: Buffer.byteLength(stdout),
						stderrBytes: Buffer.byteLength(stderr),
					});
				} catch {
					// Telemetry must never alter provider execution.
				}
				emitProgress(false);
			}, pollIntervalMs);
		}
	});
}
export { markerContext };
