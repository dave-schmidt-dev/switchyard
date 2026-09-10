// Shared asynchronous lifecycle for provider processes.
//
// Provider adapters deliberately own only argv construction and result
// classification. This module owns the process lifetime: bounded output
// capture, heartbeat polling, timeout escalation, cancellation, cleanup, and
// the exactly-once terminal transition.

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import {
	validateTaskStartTree,
	validateTaskStartTreeAsync,
} from "../lifecycle/index.mjs";
import {
	createMutationIntent,
	executeMutation,
} from "../lifecycle/mutation-protocol.mjs";
import {
	CLEANUP_STAGES,
	classifyProviderDiagnostic,
	classifyProviderStreams,
	cleanupDiagnosticCodeFor,
	describeExecError,
	providerDiagnosticCodeForKind,
} from "./exec-error.mjs";
import { validateIdentifier } from "./shell-safety.mjs";

const DEFAULT_MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TERM_GRACE_MS = 250;
const DEFAULT_DIAGNOSTIC_CHARS = 800;
// A provider that has emitted no substantive signal for this bounded interval
// is treated as stalled. The broker/runner may override it for a controlled
// test or a provider-specific policy, but production dispatch never leaves it
// unset.
export const DEFAULT_SILENCE_TIMEOUT_MS = 5 * 60 * 1000;
const PROGRESS_SCHEMA_VERSION = 1;
const PROGRESS_STAGE_VALUES = new Set([
	"queued",
	"starting",
	"configuring",
	"working",
	"running",
	"diff_stage",
	"diff_export",
	"cleanup",
	"completed",
	"failed",
	"cancelled",
	"unknown",
]);
const PROGRESS_OUTCOME_VALUES = new Set([
	"running",
	"success",
	"failure",
	"cancelled",
	"silence_timeout",
	"execution_timed_out",
]);

/**
 * Return the only progress envelope allowed to cross a lifecycle boundary.
 * Provider output, prompts, errors and arbitrary callback fields are never
 * copied into this shape.
 */
export function createProgressSnapshot({
	stage = "unknown",
	elapsedMs = 0,
	lastSubstantiveProgressAt = null,
	lastSubstantiveProgressAgeMs = 0,
	stdoutBytes = 0,
	stderrBytes = 0,
	pollCount = 0,
	progressCount = 0,
	outcome = "running",
} = {}) {
	const safeStage = PROGRESS_STAGE_VALUES.has(stage) ? stage : "unknown";
	const safeOutcome = PROGRESS_OUTCOME_VALUES.has(outcome)
		? outcome
		: "running";
	const bounded = (value, max = Number.MAX_SAFE_INTEGER) =>
		Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
	const safeTimestamp =
		typeof lastSubstantiveProgressAt === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
			lastSubstantiveProgressAt,
		)
			? lastSubstantiveProgressAt
			: null;
	return Object.freeze({
		schemaVersion: PROGRESS_SCHEMA_VERSION,
		stage: safeStage,
		elapsedMs: bounded(elapsedMs),
		lastSubstantiveProgressAt: safeTimestamp,
		lastSubstantiveProgressAgeMs: bounded(lastSubstantiveProgressAgeMs),
		counters: Object.freeze({
			stdoutBytes: bounded(stdoutBytes, DEFAULT_MAX_BUFFER),
			stderrBytes: bounded(stderrBytes, DEFAULT_MAX_BUFFER),
			polls: bounded(pollCount, 1_000_000),
			progressEvents: bounded(progressCount, 1_000_000),
		}),
		outcome: safeOutcome,
	});
}

// Keep the provider's original argv[0] attached to the exact transport args
// array returned to the adapter. VM transports may expose only `prlctl` as the
// host command while carrying a base64 guest argv inside their private args;
// classification must use the original provider binding without decoding or
// trusting caller-supplied transport text.
const WORKSPACE_PROVIDER_COMMANDS = new WeakMap();

const PROOF_ID_RE = /^[A-Za-z0-9._:/-]{1,256}$/;

/**
 * Bound a completion-continuation lifecycle receipt to its exact closed shape.
 *
 * Every execution path that carries a receipt toward
 * `verifyCompletionContinuationSync` must pass it through here first. The
 * verifier compares fields against the live task context, so a malformed
 * receipt could not authorize a continuation on its own; what this adds is
 * that no caller-supplied object reaches the runner context by reference.
 * A partial or free-form receipt becomes null rather than a partial object,
 * and the accepted shape is copied and frozen so it can neither be mutated
 * after the check nor carry extra launcher fields alongside it.
 */
export function boundCompletionContinuationProof(proof) {
	if (
		!proof ||
		typeof proof !== "object" ||
		proof.version !== 1 ||
		proof.kind !== "completion_continuation_lifecycle" ||
		typeof proof.providerExited !== "boolean" ||
		typeof proof.childrenExited !== "boolean" ||
		typeof proof.cleanupSucceeded !== "boolean" ||
		![
			proof.taskId,
			proof.attemptId,
			proof.descriptorIdentity,
			proof.workspaceId,
		].every((value) => typeof value === "string" && PROOF_ID_RE.test(value))
	)
		return null;
	return Object.freeze({
		version: 1,
		kind: "completion_continuation_lifecycle",
		providerExited: proof.providerExited,
		childrenExited: proof.childrenExited,
		cleanupSucceeded: proof.cleanupSucceeded,
		taskId: proof.taskId,
		attemptId: proof.attemptId,
		descriptorIdentity: proof.descriptorIdentity,
		workspaceId: proof.workspaceId,
	});
}

/**
 * Verify the narrow lifecycle fact required before a completed provider may
 * be invoked again in the same workspace.  Adapters must opt in explicitly:
 * a process exit alone says nothing about children it may have left behind.
 *
 * This intentionally returns false for legacy adapters.  A caller must not
 * infer support from a PID, heartbeat, or a missing status file.
 */
function completionProofMatches(proof, expected) {
	return (
		proof?.version === 1 &&
		proof?.kind === "completion_continuation_lifecycle" &&
		proof.providerExited === true &&
		proof.childrenExited === true &&
		proof.cleanupSucceeded === true &&
		proof.taskId === expected.taskId &&
		proof.attemptId === expected.attemptId &&
		proof.descriptorIdentity === expected.descriptorIdentity &&
		proof.workspaceId === expected.workingContainerName
	);
}

/** Validate the host-owned lifecycle receipt returned with the completed
 * invocation. This performs no callback, polling or provider I/O. */
export function verifyCompletionContinuationSync(adapter, context) {
	if (adapter?.supportsCompletionContinuation !== true) {
		return false;
	}
	try {
		context.onStatus?.({
			phase: "lifecycle",
			event: "completion_continuation_proof_started",
			status: `Task ${context.taskId} continuation lifecycle proof started`,
			taskId: context.taskId,
		});
		const proof = context.lifecycleReceipt;
		const accepted = completionProofMatches(proof, context);
		context.onStatus?.({
			phase: "lifecycle",
			event: "completion_continuation_proof_completed",
			status: `Task ${context.taskId} continuation lifecycle proof ${accepted ? "accepted" : "declined"}`,
			taskId: context.taskId,
			accepted,
		});
		return accepted;
	} catch {
		return false;
	}
}

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
	{
		executionBackend,
		cwd = "/project",
		argv,
		recordPid = true,
		env,
		cleanupContext,
	} = {},
) {
	if (!executionBackend) {
		throw new TypeError(
			"getWorkspaceExecution requires an executionBackend — none was threaded through",
		);
	}
	const originalProviderCommand =
		Array.isArray(argv) && typeof argv[0] === "string" ? argv[0] : null;
	const execution = executionBackend.execArgv(workspaceId, {
		cwd,
		argv,
		recordPid,
		env,
		...(cleanupContext ? { cleanupContext } : {}),
	});
	const args = [...execution.args];
	if (originalProviderCommand !== null) {
		WORKSPACE_PROVIDER_COMMANDS.set(args, originalProviderCommand);
	}
	return { command: execution.command, args };
}

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
 * @returns {Promise<{success:boolean,output:string,stderr:string,code:number|null,signal:string|null,timedOut:boolean,silenceTimedOut:boolean,cancelled:boolean,elapsedMs:number,progress:object}>}
 */
export function runProviderProcess(command, args, options = {}) {
	const {
		input,
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
		let silenceTimedOut = false;
		let cancelled = false;
		let pollCount = 0;
		let progressCount = 0;
		let lastSubstantiveProgressAt = null;
		let timeoutTimer = null;
		let silenceTimer = null;
		let escalationTimer = null;
		let pollTimer = null;

		const clearTimers = () => {
			if (timeoutTimer !== null) clearTimeoutFn(timeoutTimer);
			if (silenceTimer !== null) clearTimeoutFn(silenceTimer);
			if (escalationTimer !== null) clearTimeoutFn(escalationTimer);
			if (pollTimer !== null) clearIntervalFn(pollTimer);
			timeoutTimer = null;
			silenceTimer = null;
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
			const outcome = silenceTimedOut
				? "silence_timeout"
				: timedOut
					? "execution_timed_out"
					: cancelled
						? "cancelled"
						: code === 0 && !error && !cleanupError
							? "success"
							: "failure";
			resolve({
				success:
					!timedOut &&
					!silenceTimedOut &&
					!cancelled &&
					!error &&
					!cleanupError &&
					code === 0,
				output: stdout,
				stderr,
				code,
				signal: exitSignal,
				timedOut,
				silenceTimedOut,
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

		const emitProgress = (substantive = false) => {
			const timestamp = now();
			if (substantive) {
				lastSubstantiveProgressAt = timestamp;
				progressCount += 1;
				armSilenceTimer();
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

		const armSilenceTimer = () => {
			if (!(Number.isFinite(silenceTimeoutMs) && silenceTimeoutMs > 0)) return;
			if (silenceTimer !== null) clearTimeoutFn(silenceTimer);
			silenceTimer = safeTimer(
				() => requestTermination("silence"),
				silenceTimeoutMs,
				setTimeoutFn,
			);
		};

		const requestTermination = (reason) => {
			if (terminationRequested || settled) return;
			terminationRequested = true;
			timedOut = reason === "timeout";
			silenceTimedOut = reason === "silence";
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
			emitProgress(true);
		});
		child.stderr?.on?.("data", (chunk) => {
			stderr = appendBounded(stderr, chunk, maxBuffer);
			emitProgress(true);
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
		armSilenceTimer();
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
		cleanupMutation,
		idleExitCode,
		launcherDiagnosticCode,
		adapterDiagnosticCode,
		onProcessCompleted,
		...lifecycleOptions
	} = options;
	const classificationCommand =
		WORKSPACE_PROVIDER_COMMANDS.get(args) ?? command;
	let cleanupFailure = null;
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
						...markerContext(cleanupContext, "provider"),
					},
				);
				backendHandled = true;
				const normalized = backendResult ?? {
					cleanupFailed: false,
					postcondition: true,
				};
				if (normalized?.cleanupFailed === true) cleanupFailure = normalized;
				return normalized;
			} catch (error) {
				backendError = error;
				cleanupFailure = error;
			}
		}
		if (!backendHandled && typeof cleanup === "function") {
			let cleanupResult;
			try {
				cleanupResult = await cleanup();
			} catch (error) {
				if (!backendError) cleanupFailure = error;
			}
			if (backendError) throw backendError;
			if (cleanupFailure) throw cleanupFailure;
			const normalized = cleanupResult ?? {
				cleanupFailed: false,
				postcondition: true,
			};
			if (normalized?.cleanupFailed === true) cleanupFailure = normalized;
			return normalized;
		}
		if (backendError) throw backendError;
		return { cleanupFailed: true, postcondition: false };
	};
	const cleanupPolicy = cleanupMutation ?? {
		operation: "provider_cleanup",
		resource: cleanupContext?.attemptId ?? "provider-cleanup",
		policy: {
			maxAttempts: 1,
			idempotency: "conditional",
			reconcile: true,
		},
	};
	const operation = cleanupPolicy.operation ?? "provider_cleanup";
	const resource = cleanupPolicy.resource ?? "provider-cleanup";
	const policy = cleanupPolicy.policy ?? {};
	const operationId =
		cleanupPolicy.operationId ??
		createMutationIntent({ operation, resource, policy }).operationId;
	const cleanupWithProtocol = async () => {
		let cleanupStore = null;
		let resume = cleanupPolicy.resume ?? null;
		if (cleanupContext?.runId) {
			cleanupStore = await import("../run-store/index.mjs");
			if (!resume) {
				try {
					resume = await cleanupStore.readMutationOperation(
						cleanupContext.runId,
						operationId,
					);
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
				}
			}
		}
		const mutation = await executeMutation({
			...cleanupPolicy,
			operation,
			resource,
			operationId,
			policy,
			resume,
			command: cleanupMutation?.command ?? (() => cleanupWithBackend()),
			observe:
				cleanupMutation?.observe ??
				((result) =>
					result?.postcondition === true || result?.cleanupFailed === false
						? { status: "confirmed", ownership: "confirmed" }
						: { status: "ambiguous", ownership: "unknown" }),
			persist:
				cleanupMutation?.persist ??
				(cleanupStore
					? async (record) => {
							await cleanupStore.recordMutationOperation(
								cleanupContext.runId,
								record,
							);
						}
					: undefined),
			onStatus: cleanupMutation?.onStatus ?? onStatus,
		});
		if (mutation.state !== "completed") {
			const error = new Error("provider cleanup postcondition is uncertain");
			error.code = "provider_cleanup_uncertain";
			if (cleanupFailure && typeof cleanupFailure === "object") {
				for (const field of ["cleanupStage", "status", "signal"]) {
					if (cleanupFailure[field] !== undefined)
						error[field] = cleanupFailure[field];
				}
			}
			throw error;
		}
		return mutation;
	};
	const result = await runProviderProcess(command, args, {
		...lifecycleOptions,
		cleanup: cleanupWithProtocol,
	});
	const complete = async (value) => {
		if (typeof onProcessCompleted === "function") {
			await onProcessCompleted({
				success: value.success === true,
				cancelled: value.cancelled === true,
				timedOut: value.timedOut === true,
				silenceTimedOut: value.silenceTimedOut === true,
				cleanupFailed: value.cleanupFailed === true,
				cleanupStage: CLEANUP_STAGES.has(value.cleanupStage)
					? value.cleanupStage
					: null,
				code: Number.isSafeInteger(value.code) ? value.code : null,
				signal: typeof value.signal === "string" ? value.signal : null,
			});
		}
		return value;
	};
	if (result.success) return complete({ output: result.output, success: true });
	// A provider whose container-side supervisor reports this reserved exit code
	// finished its work but could not exit on its own (see opencode.mjs). The
	// work is in the working tree, so it is mapped to success and the captured
	// diff still passes through the integration gate.
	if (
		typeof idleExitCode === "number" &&
		result.code === idleExitCode &&
		!result.timedOut &&
		!result.silenceTimedOut &&
		!result.cancelled &&
		!result.error
	) {
		return complete({
			output: result.output,
			stderr: result.stderr,
			success: true,
			idleTerminated: true,
		});
	}
	if (result.timedOut) {
		return complete({
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
			diagnosticOrigin: "adapter",
			// Raw streams are still in-process evidence.  They become authoritative
			// only after the run-store producer returns a resolved opaque reference.
			diagnosticEvidenceAvailable: false,
			exitCode: Number.isSafeInteger(result.code) ? result.code : null,
			signal: result.signal ?? null,
			diagnosticEvidence: classifyProviderStreams({
				stdout: result.output,
				stderr: result.stderr,
				code: result.code,
				provider,
				command: classificationCommand,
			}),
		});
	}
	if (result.silenceTimedOut) {
		return complete({
			output: result.output,
			success: false,
			error:
				"provider made no substantive progress before the silence deadline",
			errorKind: "silence_timeout",
			timedOut: false,
			silenceTimedOut: true,
			outcome: "silence_timeout",
			diagnosticCode: "silence_timeout",
			failurePhase: "provider_execution",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: false,
			progress: result.progress,
		});
	}
	if (result.cancelled) {
		const cleanupFailed = result.cleanupFailed === true;
		return complete({
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
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: false,
			cleanupStage: result.cleanupStage,
			exitCode: Number.isSafeInteger(result.code) ? result.code : null,
			signal: result.signal ?? null,
			diagnosticEvidence: classifyProviderStreams({
				stdout: result.output,
				stderr: result.stderr,
				code: result.code,
				provider,
				command: classificationCommand,
			}),
		});
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
	const explicitDiagnosticCode =
		launcherDiagnosticCode === "cli_usage_error"
			? launcherDiagnosticCode
			: adapterDiagnosticCode;
	const diagnosticOrigin =
		launcherDiagnosticCode === "cli_usage_error" ? "launcher" : "adapter";
	const diagnosticEvidence = classifyProviderStreams({
		stdout: result.output,
		stderr: result.stderr,
		code: result.code,
		provider,
		command: classificationCommand,
	});
	const parsedDiagnosticCode = providerDiagnosticCodeForKind(
		diagnosticEvidence.diagnosticKind,
	);
	return complete({
		output: described.output,
		success: false,
		error: truncateDiagnostic(described.error),
		errorKind: described.errorKind ?? "execution_failed",
		diagnosticCode: classifyProviderDiagnostic({
			diagnosticCode: explicitDiagnosticCode ?? parsedDiagnosticCode,
			diagnosticOrigin,
			diagnosticEvidenceAvailable: true,
			failurePhase: "provider_execution",
			exitCode: result.code,
			signal: result.signal,
		}),
		failurePhase: "provider_execution",
		diagnosticOrigin,
		// The adapter cannot claim durable evidence before the run-store boundary.
		diagnosticEvidenceAvailable: false,
		exitCode: Number.isSafeInteger(result.code) ? result.code : null,
		signal: result.signal ?? null,
		diagnosticEvidence,
	});
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
	const result = await captureProviderDiffDetailedAsync(
		workingContainerName,
		options,
	);
	return result.status === "captured" ? result.diff : null;
}

/**
 * Capture a diff while retaining a bounded, non-content outcome classification.
 * The legacy captureProviderDiffAsync API intentionally remains string/null.
 *
 * @returns {Promise<{status: "captured"|"empty"|"stage_failed"|"diff_failed"|"transport_failed"|"timed_out", diff: string|null, reasonCode?: string}>}
 */
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
		...lifecycleOptions
	} = options;
	const deadlineMs = options.deadlineMs ?? Date.now() + timeoutMs;
	const remainingMs = () => {
		const remaining = Math.floor(deadlineMs - Date.now());
		if (remaining <= 0) throw new Error("diff capture deadline exhausted");
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
				status: `${stage} ${event.endsWith("started") ? "started" : event.endsWith("completed") ? "completed" : "failed"}`,
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
	const add = await runProviderProcess(stage.command, stage.args, {
		...lifecycle,
		timeoutMs: addTimeoutMs,
		cleanup: captureCleanup(stage.command, stage.args),
	});
	if (!add.success) {
		emitCaptureStatus("diff_capture_probe_failed", "diff_stage");
		return {
			status: add.timedOut
				? "timed_out"
				: add.error
					? "transport_failed"
					: "stage_failed",
			diff: null,
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
	const diff = await runProviderProcess(capture.command, capture.args, {
		...lifecycle,
		timeoutMs: diffTimeoutMs,
		cleanup: captureCleanup(capture.command, capture.args),
	});
	if (!diff.success) {
		emitCaptureStatus("diff_capture_probe_failed", "diff_export");
		return {
			status: diff.timedOut
				? "timed_out"
				: diff.error
					? "transport_failed"
					: "diff_failed",
			diff: null,
		};
	}
	emitCaptureStatus("diff_capture_probe_completed", "diff_export");
	return /\S/u.test(diff.output)
		? { status: "captured", diff: diff.output }
		: { status: "empty", diff: null };
}

/** Capture a working-container diff synchronously with bounded outcome evidence. */
export function captureProviderDiffDetailed(
	workingContainerName,
	options = {},
) {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const deadlineMs = options.deadlineMs ?? Date.now() + timeoutMs;
	const remainingMs = () => {
		const remaining = Math.floor(deadlineMs - Date.now());
		if (remaining <= 0) throw new Error("diff capture deadline exhausted");
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
				status: `${stage} ${event.endsWith("started") ? "started" : event.endsWith("completed") ? "completed" : "failed"}`,
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
		execFileSync(stage.command, stage.args, {
			stdio: "pipe",
			timeout: remainingMs(),
			killSignal: "SIGKILL",
			signal: options.signal,
		});
		emitCaptureStatus("diff_capture_probe_completed", "diff_stage");
	} catch (error) {
		emitCaptureStatus("diff_capture_probe_failed", "diff_stage");
		return {
			status: timedOut(error)
				? "timed_out"
				: error?.status == null
					? "transport_failed"
					: "stage_failed",
			diff: null,
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
		const diff = execFileSync(capture.command, capture.args, {
			encoding: "utf8",
			stdio: "pipe",
			timeout: remainingMs(),
			killSignal: "SIGKILL",
			signal: options.signal,
		});
		emitCaptureStatus("diff_capture_probe_completed", "diff_export");
		return /\S/u.test(diff)
			? { status: "captured", diff }
			: { status: "empty", diff: null };
	} catch (error) {
		emitCaptureStatus("diff_capture_probe_failed", "diff_export");
		return {
			status: timedOut(error)
				? "timed_out"
				: error?.status == null
					? "transport_failed"
					: "diff_failed",
			diff: null,
		};
	}
}

/** Capture a working-container diff synchronously through the backend seam. */
export function captureProviderDiff(workingContainerName, options = {}) {
	const result = captureProviderDiffDetailed(workingContainerName, options);
	return result.status === "captured" ? result.diff : null;
}
