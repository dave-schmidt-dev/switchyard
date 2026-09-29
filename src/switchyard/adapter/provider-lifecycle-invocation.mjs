import { createProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
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
import {
	reconcileProviderTerminalEvidence,
	terminalEvidenceFor,
	WORKSPACE_PROVIDER_COMMANDS,
} from "./provider-lifecycle-completion.mjs";
import {
	markerContext,
	runProviderProcess,
} from "./provider-lifecycle-process.mjs";
import { DEFAULT_DIAGNOSTIC_CHARS } from "./provider-lifecycle-progress.mjs";

function truncateDiagnostic(value, maxChars = DEFAULT_DIAGNOSTIC_CHARS) {
	const text = typeof value === "string" ? value : String(value ?? "");
	return text.length <= maxChars
		? text
		: `${text.slice(0, maxChars)}… (truncated)`;
}
function providerInvocationReliability(value, processResult) {
	const cleanupFailed = value.cleanupFailed === true;
	let causeCode = "unknown";
	if (cleanupFailed) causeCode = "provider_cleanup_failed";
	else if (value.cancelled === true) causeCode = "cancelled";
	else if (value.timedOut === true) causeCode = "execution_timed_out";
	else if (value.diagnosticCode === "execution_cancelled")
		causeCode = "cancelled";
	else if (
		[
			"auth_expired",
			"quota_exhausted",
			"model_unavailable",
			"cli_usage_error",
			"provider_signalled",
			"execution_timed_out",
		].includes(value.diagnosticCode) &&
		["adapter", "launcher"].includes(value.diagnosticOrigin)
	)
		causeCode = value.diagnosticCode;
	else if (value.diagnosticCode === "provider_exit_nonzero")
		causeCode = "provider_exit_nonzero";
	else if (value.diagnosticCode === "launch_failed")
		causeCode = "provider_launch_failed";
	else if (processResult.signal) causeCode = "provider_signalled";
	else if (Number.isSafeInteger(processResult.code) && processResult.code !== 0)
		causeCode = "provider_exit_nonzero";
	return createProviderReliabilityDiagnostic({
		causeCode,
		phase: cleanupFailed ? "cleanup" : "provider",
		exitCode: Number.isSafeInteger(value.exitCode)
			? value.exitCode
			: processResult.code,
		signal: value.signal ?? processResult.signal,
		timedOut: value.timedOut === true,
		cancelled: value.cancelled === true,
	});
}

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
	let result = await runProviderProcess(command, args, {
		...lifecycleOptions,
		cleanup: cleanupWithProtocol,
	});
	let terminalEvidenceStatus = null;
	let terminalEvidenceCleanupStatus = null;
	if (
		result.code === 255 &&
		result.signal === null &&
		!result.timedOut &&
		!result.silenceTimedOut &&
		!result.cancelled &&
		!result.cleanupFailed &&
		typeof executionBackend?.readProviderTerminalEvidence === "function" &&
		cleanupContext?.operation === "provider"
	) {
		const terminal = reconcileProviderTerminalEvidence(args, {
			executionBackend,
			cleanupContext,
			onStatus,
		});
		terminalEvidenceStatus = terminal.status;
		terminalEvidenceCleanupStatus = terminal.cleanupStatus ?? null;
		if (terminal.status === "confirmed") {
			result = {
				...result,
				code: terminal.exitCode,
				error: null,
				terminalEvidenceStatus: "confirmed",
			};
		} else {
			result = { ...result, terminalEvidenceStatus: "uncertain" };
		}
	}
	if (
		terminalEvidenceFor(args) &&
		result.code !== 255 &&
		result.signal === null &&
		!result.timedOut &&
		!result.silenceTimedOut &&
		!result.cancelled &&
		!result.cleanupFailed &&
		terminalEvidenceStatus === null &&
		cleanupContext?.operation === "provider" &&
		typeof executionBackend?.clearProviderTerminalEvidence === "function" &&
		typeof executionBackend?.readProviderTerminalEvidence === "function"
	) {
		try {
			const cleanup = executionBackend.clearProviderTerminalEvidence(
				cleanupContext.workspaceId,
				cleanupContext,
				{ onStatus },
			);
			terminalEvidenceCleanupStatus =
				cleanup?.status === "removed" ? "removed" : "uncertain";
		} catch {
			terminalEvidenceCleanupStatus = "uncertain";
		}
	}
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
				providerLifecycle: result.providerLifecycle,
			});
		}
		const providerReliability =
			value.success === true
				? null
				: providerInvocationReliability(value, result);
		return {
			...value,
			...(providerReliability ? { providerReliability } : {}),
			// Kept as an explicit false compatibility fact: silence is an
			// observation, never a terminal outcome.
			silenceTimedOut: false,
			writerLifecycle: result.writerLifecycle,
			providerLifecycle: result.providerLifecycle,
			pid: result.pid,
			startedAt: result.startedAt,
			deadlineAt: result.deadlineAt,
			lastOutputAt: result.lastOutputAt,
			silenceObserved: result.silenceObserved,
			terminationReason: result.terminationReason,
			terminalStatus: result.terminalStatus,
			cleanupStatus: result.cleanupStatus,
		};
	};
	if (result.success) {
		return complete({
			output: result.output,
			success: true,
			...(terminalEvidenceCleanupStatus
				? { terminalEvidenceCleanupStatus }
				: {}),
		});
	}
	if (result.terminalEvidenceStatus === "confirmed" && result.code === 0) {
		return complete({
			output: result.output,
			success: true,
			terminalEvidenceStatus: "confirmed",
			terminalEvidenceCleanupStatus,
		});
	}
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
	if (result.terminalStatus === "spawn_failed") {
		return complete({
			output: result.output,
			stderr: result.stderr,
			success: false,
			error: truncateDiagnostic(
				result.error?.message ?? "provider process could not be started",
			),
			errorKind: "launch_failed",
			admissionFailed: true,
			diagnosticCode: "launch_failed",
			failurePhase: "provider_execution",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: false,
			exitCode: null,
			signal: null,
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
		terminalEvidenceStatus,
		...(terminalEvidenceCleanupStatus ? { terminalEvidenceCleanupStatus } : {}),
	});
}
