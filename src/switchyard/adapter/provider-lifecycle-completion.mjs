import { describeExecError } from "./exec-error.mjs";

const WORKSPACE_PROVIDER_COMMANDS = new WeakMap();
const WORKSPACE_PROVIDER_TERMINAL_EVIDENCE = new WeakMap();
function terminalEvidenceFor(args) {
	return WORKSPACE_PROVIDER_TERMINAL_EVIDENCE.get(args) ?? null;
}
function reconcileProviderTerminalEvidence(
	args,
	{ executionBackend, cleanupContext, onStatus },
) {
	const evidence = terminalEvidenceFor(args);
	let reconciled;
	try {
		reconciled = executionBackend.readProviderTerminalEvidence(
			cleanupContext.workspaceId,
			cleanupContext,
			{ token: evidence?.token, onStatus },
		);
	} catch {
		return { status: "uncertain" };
	}
	if (reconciled?.status !== "confirmed") {
		return { status: "uncertain" };
	}
	let cleanupStatus = "uncertain";
	try {
		const cleanup = executionBackend.clearProviderTerminalEvidence(
			cleanupContext.workspaceId,
			cleanupContext,
			{ onStatus },
		);
		if (cleanup?.status === "removed") cleanupStatus = "removed";
	} catch {
		// The provider result remains exact, but sidecar removal is unavailable.
	}
	return {
		status: "confirmed",
		exitCode: reconciled.exitCode,
		cleanupStatus,
	};
}
export function reconcileSynchronousProviderExit(
	error,
	args,
	{ provider, executionBackend, cleanupContext, onStatus } = {},
) {
	if (
		error?.code === "ETIMEDOUT" ||
		error?.status !== 255 ||
		error?.signal != null ||
		typeof executionBackend?.readProviderTerminalEvidence !== "function" ||
		cleanupContext?.operation !== "provider"
	) {
		return null;
	}
	const terminal = reconcileProviderTerminalEvidence(args, {
		executionBackend,
		cleanupContext,
		onStatus,
	});
	const described = describeExecError(error, { provider });
	if (terminal.status === "confirmed" && terminal.exitCode === 0) {
		return {
			output: described.output,
			success: true,
			terminalEvidenceStatus: "confirmed",
			terminalEvidenceCleanupStatus: terminal.cleanupStatus,
		};
	}
	return {
		output: described.output,
		success: false,
		error: described.error,
		errorKind: described.errorKind,
		timedOut: false,
		exitCode:
			terminal.status === "confirmed" ? terminal.exitCode : error.status,
		terminalEvidenceStatus: terminal.status,
		...(terminal.cleanupStatus
			? { terminalEvidenceCleanupStatus: terminal.cleanupStatus }
			: {}),
	};
}
export function completeSynchronousProviderExit(
	output,
	args,
	{ executionBackend, cleanupContext, onStatus } = {},
) {
	if (
		!terminalEvidenceFor(args) ||
		cleanupContext?.operation !== "provider" ||
		typeof executionBackend?.clearProviderTerminalEvidence !== "function"
	) {
		return { output, success: true };
	}
	let cleanupStatus = "uncertain";
	try {
		const cleanup = executionBackend.clearProviderTerminalEvidence(
			cleanupContext.workspaceId,
			cleanupContext,
			{ onStatus },
		);
		if (cleanup?.status === "removed") cleanupStatus = "removed";
	} catch {
		// Direct provider success stands; only sidecar cleanup is unavailable.
	}
	return {
		output,
		success: true,
		terminalEvidenceCleanupStatus: cleanupStatus,
	};
}
const PROOF_ID_RE = /^[A-Za-z0-9._:/-]{1,256}$/;
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
		if (execution.terminalEvidence) {
			WORKSPACE_PROVIDER_TERMINAL_EVIDENCE.set(
				args,
				execution.terminalEvidence,
			);
		}
	}
	return { command: execution.command, args };
}
export {
	reconcileProviderTerminalEvidence,
	terminalEvidenceFor,
	WORKSPACE_PROVIDER_COMMANDS,
};
