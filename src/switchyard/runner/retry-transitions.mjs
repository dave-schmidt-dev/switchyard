import { performance } from "node:perf_hooks";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../adapter/constants.mjs";
import {
	INTEGRATION_REFUSAL_KINDS,
	PERSISTED_DIAGNOSTIC_CODES,
	PERSISTED_ERROR_KINDS,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { retryTransition } from "../outcome/transitions.mjs";
import { saveCheckpoint } from "./checkpoint-store.mjs";
import {
	failureMetadataFor,
	hasTrustedQuotaRetryEvidence,
	normalizeRetryTargetId,
} from "./quick-checks.mjs";
import { executionCleanupContext } from "./route-health.mjs";

export function mergeRetryExclusions(base, quarantinedTargetIds) {
	return [
		...new Set([
			...(Array.isArray(base) ? base : []),
			...(Array.isArray(quarantinedTargetIds)
				? quarantinedTargetIds.filter(
						(targetId) => normalizeRetryTargetId(targetId) !== null,
					)
				: []),
		]),
	];
}

export function persistRetryTransition(
	checkpoint,
	checkpointPath,
	{
		type,
		taskId,
		attempt,
		provider = null,
		model = null,
		resolvedTargetId = null,
		invocationDescriptor = null,
		descriptorIdentity = null,
		descriptorHarness = null,
		diagnosticCode = checkpoint.retryState?.diagnosticCode ?? null,
		diagnosticOrigin = checkpoint.retryState?.diagnosticOrigin ?? null,
		diagnosticEvidenceAvailable = checkpoint.retryState
			?.diagnosticEvidenceAvailable ?? false,
		diagnosticRef = checkpoint.retryState?.diagnosticRef ?? null,
		failurePhase = checkpoint.retryState?.failurePhase ?? null,
		phase = type,
		clearState = false,
		save = true,
	},
) {
	const retryDecision = retryTransition({
		kind: type,
		taskId,
		attempt,
		provider,
		model,
		resolvedTargetId,
		invocationDescriptor,
		descriptorIdentity,
		descriptorHarness,
		diagnosticCode,
		diagnosticOrigin,
		diagnosticEvidenceAvailable,
		diagnosticRef,
		failurePhase,
		phase,
		clearState,
	});
	const targetId = retryDecision.resolvedTargetId;
	const transitionId = checkpoint.retryTransitionId + 1;
	const transition = {
		transitionId,
		type: retryDecision.kind,
		taskId: retryDecision.taskId,
		attempt: retryDecision.attempt,
		provider: retryDecision.provider,
		model: retryDecision.model,
		resolvedTargetId: targetId,
		invocationDescriptor: retryDecision.invocationDescriptor,
		descriptorIdentity: retryDecision.descriptorIdentity,
		descriptorHarness: retryDecision.descriptorHarness,
		diagnosticCode: retryDecision.diagnosticCode,
		diagnosticOrigin: retryDecision.diagnosticOrigin,
		diagnosticEvidenceAvailable: retryDecision.diagnosticEvidenceAvailable,
		diagnosticRef: retryDecision.diagnosticRef,
		failurePhase: retryDecision.failurePhase,
		timestamp: new Date().toISOString(),
	};
	checkpoint.retryTransitionId = transitionId;
	checkpoint.retryTransitions.push(transition);
	checkpoint.retryState = clearState
		? null
		: {
				taskId: retryDecision.taskId,
				attempt: retryDecision.attempt,
				phase: retryDecision.phase,
				resolvedTargetId: targetId,
				invocationDescriptor: retryDecision.invocationDescriptor,
				descriptorIdentity: retryDecision.descriptorIdentity,
				descriptorHarness: retryDecision.descriptorHarness,
				diagnosticCode: retryDecision.diagnosticCode,
				diagnosticOrigin: retryDecision.diagnosticOrigin,
				diagnosticEvidenceAvailable: retryDecision.diagnosticEvidenceAvailable,
				diagnosticRef: retryDecision.diagnosticRef,
				failurePhase: retryDecision.failurePhase,
			};
	checkpoint.lastUpdatedAt = transition.timestamp;
	if (save) saveCheckpoint(checkpointPath, checkpoint);
	return transition;
}

export function appendRetryAttempt(checkpoint, result, attempt) {
	const safeFailure = failureMetadataFor(result);
	checkpoint.retryAttempts.push({
		taskId: result.taskId,
		attempt,
		provider: result.provider ?? null,
		model: result.model ?? null,
		resolvedTargetId: normalizeRetryTargetId(result.resolvedTargetId),
		invocationDescriptor: result.invocationDescriptor ?? null,
		descriptorIdentity: result.descriptorIdentity ?? null,
		descriptorHarness: result.descriptorHarness ?? null,
		result: result.result,
		success: Boolean(result.success),
		timedOut: Boolean(result.timedOut),
		...(safeFailure ?? {}),
	});
}

export function isQuotaRetryCandidate(result, ownsWorkingContainer) {
	if (
		!ownsWorkingContainer ||
		!result ||
		result.result !== "execution_failed" ||
		!hasTrustedQuotaRetryEvidence(result)
	) {
		return false;
	}
	return true;
}

export const COMPLETION_CONTINUATION_FAILURES = new Set([
	"empty_required_diff",
	"required_paths_missing",
]);

export function ensureProviderAttemptAllocations(checkpoint) {
	if (checkpoint.providerAttemptAllocations === undefined) {
		checkpoint.providerAttemptAllocations = [];
	}
	if (!Array.isArray(checkpoint.providerAttemptAllocations)) {
		throw new Error("providerAttemptAllocations is invalid");
	}
	return checkpoint.providerAttemptAllocations;
}

export function allocateExtraProviderInvocation(
	checkpoint,
	checkpointPath,
	taskId,
	reason,
	intent = null,
) {
	const allocations = ensureProviderAttemptAllocations(checkpoint);
	const legacyUsed = (checkpoint.retryAttempts ?? []).some(
		(entry) => entry?.taskId === taskId,
	);
	if (legacyUsed || allocations.some((entry) => entry?.taskId === taskId)) {
		return null;
	}
	const allocation = {
		taskId,
		reason,
		state: "allocated",
		allocatedAt: new Date().toISOString(),
		...(["completion_correction", "check_repair"].includes(reason)
			? intent
			: {}),
	};
	allocations.push(allocation);
	checkpoint.lastUpdatedAt = allocation.allocatedAt;
	saveCheckpoint(checkpointPath, checkpoint);
	return allocation;
}

export function recordExtraProviderInvocation(
	checkpoint,
	checkpointPath,
	allocation,
	state,
) {
	if (!allocation || !["running", "result_recorded"].includes(state)) return;
	allocation.state = state;
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
}

export function recordExtraProviderInvocationResult(
	checkpoint,
	checkpointPath,
	taskId,
) {
	const allocation = ensureProviderAttemptAllocations(checkpoint).find(
		(entry) => entry?.taskId === taskId,
	);
	if (allocation?.state === "allocated" || allocation?.state === "running") {
		recordExtraProviderInvocation(
			checkpoint,
			checkpointPath,
			allocation,
			"result_recorded",
		);
	}
}

export function startExtraProviderInvocation(
	checkpoint,
	checkpointPath,
	taskId,
) {
	const allocation = ensureProviderAttemptAllocations(checkpoint).find(
		(entry) => entry?.taskId === taskId,
	);
	if (allocation?.state === "allocated") {
		recordExtraProviderInvocation(
			checkpoint,
			checkpointPath,
			allocation,
			"running",
		);
	}
}

export function completionContinuationCandidate(result, enabled) {
	return (
		enabled === true &&
		result?.success === false &&
		result.result === "integration_failed" &&
		["captured", "empty"].includes(result.captureStatus) &&
		COMPLETION_CONTINUATION_FAILURES.has(result.diagnosticCode)
	);
}

export function machineMissingRequirements(task, result) {
	if (result.diagnosticCode !== "required_paths_missing") return [];
	return (result.missingPaths ?? task.requiredPaths ?? []).filter(
		(path) => typeof path === "string",
	);
}

export function taskPromptForAttempt(task, requirements) {
	const prompt = task.prompt || task.description || task.title;
	if (!Array.isArray(requirements) || requirements.length === 0) return prompt;
	return `${prompt}\n\nRequired paths still missing: ${requirements.join(", ")}`;
}

export function initializeTaskExecutionBudget(context, task) {
	const timeoutMs = task.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS;
	const wallDeadlineMs = (context.now?.() ?? Date.now()) + timeoutMs;
	const monotonicDeadlineMs =
		(context.monotonicNow?.() ?? performance.now()) + timeoutMs;
	context._activeTaskBudget = {
		taskId: task.id,
		wallDeadlineMs,
		monotonicDeadlineMs,
		deadline: new Date(wallDeadlineMs).toISOString(),
	};
	return { ...context._activeTaskBudget, remainingMs: timeoutMs };
}

export function taskExecutionBudget(context, task) {
	if (context._activeTaskBudget?.taskId === task.id) {
		const wallRemaining =
			context._activeTaskBudget.wallDeadlineMs -
			(context.now?.() ?? Date.now());
		const monotonicRemaining =
			context._activeTaskBudget.monotonicDeadlineMs -
			(context.monotonicNow?.() ?? performance.now());
		return {
			...context._activeTaskBudget,
			remainingMs: Math.max(0, Math.min(wallRemaining, monotonicRemaining)),
		};
	}
	return initializeTaskExecutionBudget(context, task);
}

export function completionLifecycleContext(context, task) {
	const cleanupContext =
		context._activeTaskHelperContext ??
		executionCleanupContext(
			context,
			task,
			context._activeInvocationDescriptor?.descriptor_identity,
		);
	const budget = taskExecutionBudget(context, task);
	return {
		taskId: task.id,
		attemptId: cleanupContext.attemptId,
		descriptorIdentity: cleanupContext.descriptorIdentity,
		workingContainerName: context.workingContainerName,
		executionBackend: context.executionBackend,
		cleanupContext,
		deadline: budget.deadline,
		timeoutMs: budget.remainingMs,
		onStatus: context.onStatus,
		lifecycleReceipt: context._activeCompletionLifecycleReceipt,
	};
}

export const ALLOWED_INTEGRATION_MESSAGES = Object.freeze(
	new Set([
		"empty_required_diff",
		"required_paths_missing",
		"undeclared_paths_touched",
		"no_op_diff",
		...INTEGRATION_REFUSAL_KINDS.filter(
			(kind) => kind !== "integration_state_unknown",
		),
	]),
);

export function integrationFailureMetadata(
	taskId,
	diff,
	credentialFlagged,
	gateResult = null,
	hasGateEvidence = false,
) {
	const errorKind =
		gateResult?.errorKind &&
		PERSISTED_ERROR_KINDS.includes(gateResult.errorKind)
			? gateResult.errorKind
			: "integration_failed";
	const rawDiagnosticCode = PERSISTED_DIAGNOSTIC_CODES.includes(
		gateResult?.reasonKind,
	)
		? gateResult.reasonKind
		: ALLOWED_INTEGRATION_MESSAGES.has(gateResult?.message)
			? gateResult.message
			: undefined;
	const diagnosticCode = PERSISTED_DIAGNOSTIC_CODES.includes(rawDiagnosticCode)
		? rawDiagnosticCode
		: undefined;
	return sanitizeFailureMetadata({
		taskId,
		result: "integration_failed",
		errorKind,
		diagnosticCode,
		// The queue saves this diff as `<taskId>.diff`; derive the opaque pointer
		// before recording the dispatch so the ledger can carry the same safe
		// artifact identity without receiving the host path or diff body.
		partialDiffPath:
			typeof diff === "string" && diff.length > 0 && !credentialFlagged
				? `${taskId}.diff`
				: undefined,
		// An empty-diff rejection has no diff to point at. When the provider
		// transcript was kept instead, name it here so the record and the
		// ledger carry evidence rather than a bare reason code.
		gateEvidencePath:
			hasGateEvidence && !credentialFlagged ? `${taskId}.output` : undefined,
	});
}
