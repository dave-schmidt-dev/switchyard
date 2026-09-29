import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fchmodSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
	enforceQuickCheckCompletion,
	invalidCompletedQuickCheckTaskIds,
	isPassingQuickCheckReceipt,
	parseQuickChecks,
	runQuickChecks,
	runQuickChecksAsync,
} from "./checks.mjs";

export { invalidCompletedQuickCheckTaskIds } from "./checks.mjs";

import {
	AGY_SILENCE_TIMEOUT_MS,
	captureDiff as captureAgyDiff,
	captureDiffAsync as captureAgyDiffAsync,
	captureDiffDetailed as captureAgyDiffDetailed,
	captureDiffDetailedAsync as captureAgyDiffDetailedAsync,
	executeAgy,
	executeAgyAsync,
} from "../adapter/agy.mjs";
import {
	captureDiff as captureClaudeDiff,
	captureDiffAsync as captureClaudeDiffAsync,
	captureDiffDetailed as captureClaudeDiffDetailed,
	captureDiffDetailedAsync as captureClaudeDiffDetailedAsync,
	executeClaude,
	executeClaudeAsync,
} from "../adapter/claude.mjs";
import {
	captureDiff as captureCodexDiff,
	captureDiffAsync as captureCodexDiffAsync,
	captureDiffDetailed as captureCodexDiffDetailed,
	captureDiffDetailedAsync as captureCodexDiffDetailedAsync,
	executeCodex,
	executeCodexAsync,
} from "../adapter/codex.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../adapter/constants.mjs";
import {
	captureDiff as captureCopilotDiff,
	captureDiffAsync as captureCopilotDiffAsync,
	captureDiffDetailed as captureCopilotDiffDetailed,
	captureDiffDetailedAsync as captureCopilotDiffDetailedAsync,
	execute as executeCopilot,
	executeAsync as executeCopilotAsync,
} from "../adapter/copilot.mjs";
import {
	captureDiff as captureCursorDiff,
	captureDiffAsync as captureCursorDiffAsync,
	captureDiffDetailed as captureCursorDiffDetailed,
	captureDiffDetailedAsync as captureCursorDiffDetailedAsync,
	executeCursor,
	executeCursorAsync,
} from "../adapter/cursor.mjs";
import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	CLEANUP_STAGES,
	checkpointRemediation,
	INTEGRATION_REFUSAL_KINDS,
	PERSISTED_DIAGNOSTIC_CODES,
	PERSISTED_ERROR_KINDS,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import {
	captureDiff as captureOpencodeDiff,
	captureDiffAsync as captureOpencodeDiffAsync,
	captureDiffDetailed as captureOpencodeDiffDetailed,
	captureDiffDetailedAsync as captureOpencodeDiffDetailedAsync,
	execute as executeOpencode,
	executeAsync as executeOpencodeAsync,
} from "../adapter/opencode.mjs";
import {
	boundCompletionContinuationProof,
	boundProviderLifecycleSnapshot,
	createProgressSnapshot,
	DEFAULT_SILENCE_TIMEOUT_MS,
	verifyCompletionContinuationSync,
} from "../adapter/provider-lifecycle.mjs";
import {
	captureDiff as captureVibeDiff,
	captureDiffAsync as captureVibeDiffAsync,
	captureDiffDetailed as captureVibeDiffDetailed,
	captureDiffDetailedAsync as captureVibeDiffDetailedAsync,
	execute as executeVibe,
	executeAsync as executeVibeAsync,
} from "../adapter/vibe.mjs";
import { createAccountRootResolver } from "../broker/accounts.mjs";
import { registerBrokerExecutionPolicy } from "../broker/executor.mjs";
import { createBroker } from "../broker/index.mjs";
import { createProviderProcessCompletedOutcome } from "../broker/outcome.mjs";
import {
	reviewResultFromExecution,
	unavailableReviewResult,
} from "../diagnostics/review-result.mjs";
import { HOST_POWER_STATES, readHostPower } from "../dispatch/host-power.mjs";
import {
	integrationGate,
	validateExactPathSet,
	validateIntegratedCommitAncestry,
	validateIntegratedCommitPaths,
	validateNoTrackedPathOverlap,
} from "../integrate/index.mjs";
import {
	readLedgerFromStore,
	recordDispatch,
	recordDispatchIntentToStore,
	recordDispatchToStore,
	recordExternalCompletionToStore,
} from "../ledger/index.mjs";
import {
	createExecutionBackend,
	hostBackendDefaults,
} from "../lifecycle/backend-selection.mjs";
import {
	loadWorkspaceLifecycleHooks,
	runWorkspaceLifecycleHook,
} from "../lifecycle/hooks.mjs";
import {
	captureDirtyOverlay,
	captureTaskStartTree,
	captureTaskStartTreeAsync,
	ignoredPath,
	readDirtyOverlayReceipt,
	releaseTaskStartTree,
	releaseTaskStartTreeAsync,
	seedProjectWithBackend,
	validateDirtyOverlayReceipt,
	validateTaskStartTree,
	validateTaskStartTreeAsync,
} from "../lifecycle/index.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import { projectOutcomeReader } from "../outcome/projection.mjs";
import { validateShadowEnvelope } from "../outcome/shadow.mjs";
import {
	artifactTransition,
	failureTransition,
	integrationTransition,
	retryTransition,
	reviewTransition,
	terminalTransition,
} from "../outcome/transitions.mjs";
import { isValidCapabilityClass } from "../roster/classifier.mjs";
import {
	getConfiguredInvocationDescriptor,
	getInvocationDescriptor,
	normalizeProviderName,
	resolveRouteProvenance,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import {
	acquireHalfOpenClaimSync,
	createDefaultRouteHealthDecision,
	createRouteHealthTerminalBinding,
	releaseHalfOpenClaimSync,
	startHalfOpenClaimSync,
} from "../router/health.mjs";
import {
	GOLDEN_IMAGE_VERIFIED_PROVIDERS,
	preflightMacosQueue,
	readSnapshotAtRoute,
	route,
} from "../router/index.mjs";
import {
	acquireVmSlot,
	activateOutcomeWriter,
	appendOutcomeEvent,
	createFencingIdentity,
	createStageOutcome,
	getStateRoot,
	getVmAdmissionRoot,
	isProjectLockOwnedBy,
	readEvents,
	readRun,
	recoverExecutionOutcome,
	releaseVmSlot,
	VmSlotUnavailableError,
} from "../run-store/index.mjs";

function mergeRetryExclusions(base, quarantinedTargetIds) {
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
function persistRetryTransition(
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
function appendRetryAttempt(checkpoint, result, attempt) {
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
function isQuotaRetryCandidate(result, ownsWorkingContainer) {
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
const COMPLETION_CONTINUATION_FAILURES = new Set([
	"empty_required_diff",
	"required_paths_missing",
]);
function ensureProviderAttemptAllocations(checkpoint) {
	if (checkpoint.providerAttemptAllocations === undefined) {
		checkpoint.providerAttemptAllocations = [];
	}
	if (!Array.isArray(checkpoint.providerAttemptAllocations)) {
		throw new Error("providerAttemptAllocations is invalid");
	}
	return checkpoint.providerAttemptAllocations;
}
function allocateExtraProviderInvocation(
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
		...(reason === "completion_correction" ? intent : {}),
	};
	allocations.push(allocation);
	checkpoint.lastUpdatedAt = allocation.allocatedAt;
	saveCheckpoint(checkpointPath, checkpoint);
	return allocation;
}
function recordExtraProviderInvocation(
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
function recordExtraProviderInvocationResult(
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
function startExtraProviderInvocation(checkpoint, checkpointPath, taskId) {
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
function completionContinuationCandidate(result, enabled) {
	return (
		enabled === true &&
		result?.success === false &&
		result.result === "integration_failed" &&
		["captured", "empty"].includes(result.captureStatus) &&
		COMPLETION_CONTINUATION_FAILURES.has(result.diagnosticCode)
	);
}
function machineMissingRequirements(task, result) {
	if (result.diagnosticCode !== "required_paths_missing") return [];
	return (result.missingPaths ?? task.requiredPaths ?? []).filter(
		(path) => typeof path === "string",
	);
}
function taskPromptForAttempt(task, requirements) {
	const prompt = task.prompt || task.description || task.title;
	if (!Array.isArray(requirements) || requirements.length === 0) return prompt;
	return `${prompt}\n\nRequired paths still missing: ${requirements.join(", ")}`;
}
function initializeTaskExecutionBudget(context, task) {
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
function taskExecutionBudget(context, task) {
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
function completionLifecycleContext(context, task) {
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
function runCompletionCorrection(
	task,
	context,
	result,
	checkpoint,
	checkpointPath,
) {
	if (
		context.ownsWorkingContainer !== true ||
		context.completionContinuationMode !== "sync" ||
		!completionContinuationCandidate(
			result,
			context.completionContinuation?.enabled,
		)
	)
		return result;
	const budget = taskExecutionBudget(context, task);
	const pin = context._activeCompletionPin;
	if (!pin || budget.remainingMs <= 0) return result;
	const requirements = machineMissingRequirements(task, result);
	if (
		!verifyCompletionContinuationSync(
			context._activeCompletionAdapter,
			completionLifecycleContext(context, task),
		)
	) {
		return result;
	}
	if (taskExecutionBudget(context, task).remainingMs <= 0) return result;
	const allocation = allocateExtraProviderInvocation(
		checkpoint,
		checkpointPath,
		task.id,
		"completion_correction",
		{
			deadline: pin.deadline,
			descriptorIdentity: pin.descriptorIdentity,
			workspaceId: pin.workspaceId,
			baseTree: pin.baseTree,
			attemptId: pin.attemptId,
		},
	);
	if (!allocation) return result;
	context.onStatus?.({
		phase: "execution",
		event: "completion_correction_allocated",
		status: `Task ${task.id} completion correction allocated`,
		taskId: task.id,
		missingRequirements: requirements,
	});
	recordExtraProviderInvocation(
		checkpoint,
		checkpointPath,
		allocation,
		"running",
	);
	const originalRequirements = context._completionRequirements;
	context._completionPin = pin;
	context._completionRequirements = requirements;
	try {
		const correction = executeTask(task, context);
		correction.extraProviderInvocationUsed = true;
		recordExtraProviderInvocation(
			checkpoint,
			checkpointPath,
			allocation,
			"result_recorded",
		);
		return correction;
	} finally {
		context._completionPin = null;
		context._completionRequirements = originalRequirements;
	}
}
const ALLOWED_INTEGRATION_MESSAGES = Object.freeze(
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
function executeTaskUnsafe(task, context) {
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return nonSwitchyardExecutorResult(task, executor, requiredCapability);
	}
	const overlayFailure = dirtyOverlayResult(task, context, requiredCapability);
	if (overlayFailure) return overlayFailure;
	// Primary and quota-fallback invocations each own their configured timeout.
	// A completion continuation sets _completionPin and intentionally retains the
	// primary invocation's already-running absolute deadline.
	if (!context._completionPin) initializeTaskExecutionBudget(context, task);
	const checkIgnored = context.checkIgnoredPath ?? findIgnoredDeclaredPath;
	const ignoredPath = checkIgnored(
		task.requiredPaths ?? task.files,
		context.projectPath,
	);
	if (ignoredPath) {
		return declaredPathNotSeededResult(task, requiredCapability);
	}
	const hostPower = readQueueHostPower({
		hostPowerProbe: context.hostPowerProbe,
		execFn: context.hostPowerExecFn,
		timeoutMs: context.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: context.hostPowerPolicyEnabled,
		onStatus: context.onStatus,
		taskId: task.id,
	});
	if (hostPower.state === HOST_POWER_STATES.BATTERY) {
		return policyDeferredTaskResult(task, hostPower, context.taskFileSha256);
	}
	const routeResult = context._completionPin
		? structuredClone(context._completionPin.route)
		: context.route({
				requiredCapability,
				availableProviders: Object.keys(context.adapters ?? {}),
				exclude: context.exclude,
				only: context.only,
				platform: context.platform,
				...(context.goldenImageVerifiedProviders !== undefined
					? {
							goldenImageVerifiedProviders:
								context.goldenImageVerifiedProviders,
						}
					: {}),
				...(context.healthDecision
					? { healthDecision: context.healthDecision }
					: {}),
				...(context.onHealthDecision
					? { onHealthDecision: context.onHealthDecision }
					: {}),
				...(context.qualificationAttempt
					? { hasInvocationDescriptor: context.hasInvocationDescriptor }
					: {}),
			});

	// Provenance (Task 1.6, M7/M8): resolve the six roster-provenance fields
	// once, attach them to routeResult, and route every dispatch record through
	// a local `record()` that spreads them in. Doing it here — not at each of
	// the recordDispatch call sites below — means no dispatch record can omit
	// provenance, and adds it in exactly one place per execute path.
	const provenance = resolveRouteProvenance(
		routeResult.provider,
		requiredCapability,
	);
	Object.assign(routeResult, { requiredCapability }, provenance);
	let invocationDescriptor;
	try {
		invocationDescriptor = context._completionPin
			? structuredClone(context._completionPin.invocationDescriptor)
			: descriptorFromRoute(
					routeResult,
					requiredCapability,
					context.resolveDescriptor ??
						(context.qualificationAttempt
							? getConfiguredInvocationDescriptor
							: getInvocationDescriptor),
				);
	} catch {
		try {
			context.recordDispatch({
				...provenance,
				...descriptorReceiptFields(null),
				resolvedTargetId: routeResult.resolvedTargetId ?? null,
				provider: routeResult.provider ?? "none",
				model: routeResult.model ?? null,
				taskId: task.id,
				result: "descriptor_receipt_invalid",
				reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
				requiredCapability,
			});
		} catch (projectionError) {
			reportLegacyProjectionFailure(context, projectionError);
		}
		return {
			...descriptorReceiptFields(null),
			taskId: task.id,
			success: false,
			provider: routeResult.provider ?? null,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			result: "descriptor_receipt_invalid",
			errorKind: "descriptor_receipt",
			reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
		};
	}
	Object.assign(routeResult, descriptorReceiptFields(invocationDescriptor));
	context._activeInvocationDescriptor = invocationDescriptor;
	let projectionFailure = null;
	const record = (dispatch) => {
		try {
			context.recordDispatch({
				...provenance,
				...descriptorReceiptFields(invocationDescriptor),
				resolvedTargetId: routeResult.resolvedTargetId ?? null,
				...dispatch,
				requiredCapability,
			});
		} catch (error) {
			projectionFailure = reportLegacyProjectionFailure(context, error);
		}
	};
	const resolvedTargetId = routeResult.resolvedTargetId ?? null;

	if (!routeResult.provider) {
		const noProviderReason = safeNoProviderReason(routeResult.reason);
		record({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason: noProviderReason,
			errorKind: null,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			requiredCapability,
			resolvedTargetId,
			result: "no_provider",
			reason: noProviderReason,
			errorKind: null,
		};
	}

	const adapter = selectAdapter(
		routeResult.resolved_harness ?? routeResult.provider,
		context.adapters,
	);
	context._activeCompletionAdapter = adapter;
	context._activeCompletionRoute = structuredClone(routeResult);
	if (!adapter) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "unsupported_provider",
			errorKind: null,
			reason: safeSuccessfulRouteReason(routeResult.reason),
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "unsupported_provider",
		};
	}

	// A task's own `Timeout:` field (runner/index.mjs parseTimeoutField)
	// overrides the global default for tasks known to legitimately need more
	// (or less) than PROVIDER_EXECUTION_TIMEOUT_MS.
	const executionBudget = taskExecutionBudget(context, task);
	const timeoutMs = Math.floor(executionBudget.remainingMs);
	if (timeoutMs <= 0) {
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "execution_timed_out",
			errorKind: "execution_timeout",
			timedOut: true,
		};
	}

	// Emitted here, before the blocking adapter.execute call below, so the
	// routed provider/model/deadline are visible immediately rather than only
	// discoverable after the (up to timeoutMs-long) call returns.
	const routedDeadline = executionBudget.deadline;
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "task_routed",
			status: `Task ${task.id} routed to ${routeResult.provider}${routeResult.model ? `/${routeResult.model}` : ""}`,
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			...descriptorReceiptFields(invocationDescriptor),
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}
	if (context.onTaskRouted) {
		context.onTaskRouted({
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			...descriptorReceiptFields(invocationDescriptor),
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}

	const intentFailure = writeDispatchIntent(
		context,
		dispatchIntentPayload(
			task.id,
			routeResult,
			requiredCapability,
			provenance,
			invocationDescriptor,
		),
	);
	if (intentFailure) {
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "intent_receipt_failed",
			errorKind: "intent_receipt",
			...intentFailure,
		};
	}

	const prompt = taskPromptForAttempt(task, context._completionRequirements);
	const routedModel = invocationDescriptor?.selector ?? routeResult.model;
	context.queueBackend?.beforeRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	const cleanupContext = executionCleanupContext(
		context,
		task,
		invocationDescriptor?.descriptor_identity,
	);
	if (!prepareTaskBase(context, task, cleanupContext)) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "task_base_capture_failed",
			errorKind: "diff_capture_failed",
			reason: "immutable task base capture failed",
		});
		return taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const healthPreparation = prepareRouteHealthTrial(
		context,
		task,
		routeResult,
		invocationDescriptor,
	);
	if (!healthPreparation.allowed)
		return healthDeferredResult(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	if (context._completionPin) {
		if (
			context._completionPin.workspaceId !== context.workingContainerName ||
			context._completionPin.baseTree !== context._activeTaskBase?.tree ||
			context._completionPin.descriptorIdentity !==
				invocationDescriptor.descriptor_identity
		) {
			return taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
		}
	} else {
		context._activeCompletionPin = {
			taskId: task.id,
			route: structuredClone(routeResult),
			invocationDescriptor: structuredClone(invocationDescriptor),
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			workspaceId: context.workingContainerName,
			baseTree: context._activeTaskBase.tree,
			attemptId: cleanupContext.attemptId,
			deadline: executionBudget.deadline,
		};
	}
	const captureExecutionBackend = bindAttemptHelperBackend(
		context.executionBackend,
		cleanupContext,
	);
	const launchBudget = taskExecutionBudget(context, task);
	const launchTimeoutMs = Math.floor(launchBudget.remainingMs);
	if (launchTimeoutMs <= 0) {
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "execution_timed_out",
			errorKind: "execution_timeout",
			timedOut: true,
		};
	}
	const healthStart = startRouteHealthTrial(context);
	if (!healthStart.allowed)
		return healthDeferredResult(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	const rawExecution = adapter.execute(prompt, context.workingContainerName, {
		model: routedModel ?? undefined,
		timeoutMs: launchTimeoutMs,
		executionBackend: bindAttemptExecutionBackend(
			context.executionBackend,
			cleanupContext,
		),
		invocationDescriptor,
		descriptorIdentity: invocationDescriptor?.descriptor_identity ?? null,
		descriptorHarness: routeResult.resolved_harness ?? null,
		resolvedTargetId,
		cleanupContext,
	});
	const execution = context.checkpoint
		? normalizeSynchronousProviderExecution(rawExecution)
		: rawExecution;
	context._activeProviderExecutionSucceeded = execution.success === true;
	context._activeCompletionLifecycleReceipt = boundCompletionContinuationProof(
		execution.completionContinuationProof,
	);
	if (execution.cleanupFailed === true && execution.success) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			reason: "provider cleanup is uncertain; recovery required",
			cleanupStage: execution.cleanupStage ?? null,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			...survivingProviderFields(execution),
		};
	}
	if (isStructuredReviewExecution(task, execution)) {
		context.queueBackend?.afterRun?.(
			context.workingContainerName,
			context.projectPath,
			{ onStatus: context.onStatus },
		);
		const review = reviewTaskResult(
			task,
			execution,
			routeResult,
			invocationDescriptor,
			requiredCapability,
			resolvedTargetId,
		);
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: review.result,
			reviewResult: review.reviewResult,
			...(review.success
				? {}
				: { errorKind: review.errorKind, reason: review.reason }),
			...survivingProviderFields(execution),
		});
		return review;
	}

	if (!execution.success) {
		if (execution.timedOut) {
			// The adapter already killed the orphaned in-container process
			// before returning (see adapter/orphan-kill.mjs), so this reads a
			// stable snapshot rather than one still being mutated. Surfaced as
			// a review artifact only — deliberately NOT run through
			// context.integrationGate, so an interrupted (possibly broken,
			// possibly mid-edit) diff can never auto-apply as if the task had
			// succeeded. INV-2: the gate is the only reviewed door back to the
			// host, and this diff has not been reviewed.
			let captureEvidence = null;
			if (retainsFailureDiff(task)) {
				context.onStatus?.({
					phase: "execution",
					event: "diff_capture_started",
					status: `Task ${task.id} partial diff capture started`,
					taskId: task.id,
				});
				try {
					captureEvidence = captureDiffWithEvidence(
						adapter,
						context.workingContainerName,
						{
							executionBackend: captureExecutionBackend,
							taskBase: context._activeTaskBase,
						},
					);
				} catch {
					captureEvidence = { status: "transport_failed", diff: null };
				}
			}
			const partialDiff = captureEvidence?.diff ?? null;
			const captureStatus = captureEvidence?.status;
			const captureFailed =
				captureEvidence !== null &&
				captureStatus !== "captured" &&
				captureStatus !== "empty";
			if (captureEvidence !== null) {
				context.onStatus?.({
					phase: "execution",
					event: "diff_capture_completed",
					status: `Task ${task.id} partial diff capture ${captureStatus}`,
					taskId: task.id,
					captureStatus,
					byteCount: partialDiff?.length ?? 0,
				});
			}
			const cleanupFailed = execution.cleanupFailed === true;
			const resultName = cleanupFailed
				? "execution_timed_out_cleanup_failed"
				: captureFailed
					? "execution_timed_out_capture_failed"
					: "execution_timed_out";
			const errorKind =
				(cleanupFailed && "provider_cleanup_failed") ||
				(captureFailed && "diff_capture_failed") ||
				execution.errorKind ||
				null;
			const safeTimeoutFailure = sanitizeFailureMetadata({
				taskId: task.id,
				result: resultName,
				errorKind,
				timedOut: true,
				diagnosticCode: execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupStage: execution.cleanupStage,
			});
			const error = cleanupFailed
				? (execution.error ??
					safeTimeoutFailure?.reason ??
					"provider cleanup failed after timeout")
				: captureFailed
					? (safeTimeoutFailure?.reason ?? "diff capture failed after timeout")
					: (execution.error ?? null);
			record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: resultName,
				errorKind: safeTimeoutFailure?.errorKind ?? errorKind,
				...(safeTimeoutFailure
					? { reasonCode: safeTimeoutFailure.reasonCode }
					: {}),
				reason: error ?? routeResult.reason,
				...(captureStatus ? { captureStatus } : {}),
				...reviewFailureFields(task, execution),
				percentLeft: routeResult.percentLeft ?? undefined,
				diagnosticCode:
					safeTimeoutFailure?.diagnosticCode ?? execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupStage: execution.cleanupStage,
			});
			return {
				...descriptorReceiptFields(invocationDescriptor),
				taskId: task.id,
				success: false,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
				requiredCapability,
				resolvedTargetId,
				result: resultName,
				error,
				errorKind: safeTimeoutFailure?.errorKind ?? errorKind,
				...(safeTimeoutFailure
					? {
							reasonCode: safeTimeoutFailure.reasonCode,
							reason: safeTimeoutFailure.reason,
						}
					: {}),
				timedOut: true,
				diagnosticCode:
					safeTimeoutFailure?.diagnosticCode ?? execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupFailed,
				cleanupStage: execution.cleanupStage,
				...(captureStatus ? { captureStatus } : {}),
				...reviewFailureFields(task, execution),
				...(partialDiff ? { partialDiff } : {}),
			};
		}

		let captureEvidence = null;
		if (retainsFailureDiff(task)) {
			context.onStatus?.({
				phase: "execution",
				event: "diff_capture_started",
				status: `Task ${task.id} failure diff capture started`,
				taskId: task.id,
			});
			try {
				captureEvidence = captureDiffWithEvidence(
					adapter,
					context.workingContainerName,
					{
						executionBackend: captureExecutionBackend,
						taskBase: context._activeTaskBase,
					},
				);
			} catch {
				captureEvidence = { status: "transport_failed", diff: null };
			}
			context.onStatus?.({
				phase: "execution",
				event: "diff_capture_completed",
				status: `Task ${task.id} failure diff capture ${captureEvidence.status}`,
				taskId: task.id,
				captureStatus: captureEvidence.status,
				byteCount: captureEvidence.diff?.length ?? 0,
			});
		}

		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			errorKind: execution.errorKind ?? null,
			reason: execution.error ?? routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
			diagnosticCode: execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupStage: execution.cleanupStage,
			...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
			...reviewFailureFields(task, execution),
		});

		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor?.selector ?? routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "execution_failed",
			error: execution.error ?? null,
			errorKind: execution.errorKind ?? null,
			diagnosticCode: execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupStage: execution.cleanupStage,
			...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
			...reviewFailureFields(task, execution),
			...(captureEvidence?.diff ? { partialDiff: captureEvidence.diff } : {}),
		};
	}

	context.queueBackend?.afterRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	context.onStatus?.({
		phase: "execution",
		event: "diff_capture_started",
		status: `Task ${task.id} diff capture started`,
		taskId: task.id,
	});
	const captureEvidence = captureDiffWithEvidence(
		adapter,
		context.workingContainerName,
		{
			executionBackend: captureExecutionBackend,
			taskBase: context._activeTaskBase,
		},
	);
	if (!["captured", "empty"].includes(captureEvidence.status)) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "diff_capture_failed",
			errorKind: "diff_capture_failed",
			captureStatus: captureEvidence.status,
			reason: "authoritative host diff capture failed",
		});
		return {
			...taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			),
			result: "diff_capture_failed",
			reason: "authoritative host diff capture failed",
			captureStatus: captureEvidence.status,
		};
	}
	const diff = captureEvidence.diff;
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "diff_captured",
			status: "Diff captured",
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			byteCount: diff ? diff.length : 0,
			captureStatus: captureEvidence.status,
		});
	}

	if (
		!diff &&
		task.requiredPaths === null &&
		(task.quickChecks?.checks?.length ?? 0) === 0
	) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			reason: safeSuccessfulRouteReason(routeResult.reason),
			...survivingProviderFields(execution),
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: true,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "success_no_diff",
			captureStatus: captureEvidence.status,
			...servedModelVerificationFields(execution),
			...survivingProviderFields(execution),
		};
	}

	const quickCheck = quickCheckDecision(task, context, diff);
	const gateResult = !quickCheck.passed
		? { success: false, message: "check_failed" }
		: (dirtyOverlayIntegrationGate(context) ??
			context.integrationGate(diff, context.projectPath, {
				allowedPaths: task.requiredPaths,
				allowSensitiveManifests:
					task.type === "implementation" && task.allowManifests === true,
				integrationIntent: checkpointIntegrationIntent(context, task, diff),
				dirtyOverlayReceiptHash:
					context.dirtyOverlayReceipt?.receiptHash ?? null,
			}));
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const gateSuccess = Boolean(gateResult?.success) || alreadyApplied;
	const success = gateSuccess && quickCheck.passed;
	const terminalResult = !quickCheck.passed
		? "check_failed"
		: gateSuccess
			? "success"
			: "integration_failed";
	const safeGateFailure = !quickCheck.passed
		? {
				errorKind: "check_failed",
				reasonCode: "check_failed",
				reason: "Task check command failed.",
			}
		: !gateSuccess
			? integrationFailureMetadata(
					task.id,
					diff,
					gateResult?.credentialFlagged,
					gateResult,
					!diff && Boolean(boundedGateEvidence(execution.output)),
				)
			: null;
	const gateArtifactRef = opaqueArtifactRef(gateResult?.artifactRef);

	if (context.onStatus) {
		context.onStatus({
			phase: "integration",
			event: "gate_validated",
			status: success
				? alreadyApplied
					? "already applied"
					: "ok"
				: safeGateFailure.reason,
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			outcome: success
				? alreadyApplied
					? "already_applied"
					: "passed"
				: "rejected",
			errorKind: safeGateFailure?.errorKind,
			reasonCode: safeGateFailure?.reasonCode,
			...(safeGateFailure?.diagnosticCode
				? { diagnosticCode: safeGateFailure.diagnosticCode }
				: {}),
			artifactRef: safeGateFailure?.artifactRef ?? gateArtifactRef,
		});
		if (success) {
			context.onStatus({
				phase: "integration",
				event: "gate_applied",
				status: alreadyApplied
					? "Diff already applied; integration gate confirmed terminal state"
					: "Diff applied via integration gate",
				taskId: task.id,
				provider: routeResult.provider,
				model: invocationDescriptor.selector,
			});
		}
	}

	record({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: terminalResult,
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...survivingProviderFields(execution),
		...(success
			? { reason: safeSuccessfulRouteReason(routeResult.reason) }
			: {}),
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	const result = {
		taskId: task.id,
		success,
		...(quickCheck.receipt ? { quickCheckReceipt: quickCheck.receipt } : {}),
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: terminalResult,
		captureStatus: captureEvidence.status,
		...(Array.isArray(gateResult?.missingPaths)
			? { missingPaths: [...gateResult.missingPaths] }
			: {}),
		...servedModelVerificationFields(execution),
		...survivingProviderFields(execution),
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...(projectionFailure
			? { legacyProjectionFailure: projectionFailure }
			: {}),
	};
	if (!success && !gateResult?.credentialFlagged) {
		result.partialDiff = diff;
		// With no diff there is nothing else to keep, and a rejection that keeps
		// nothing is not diagnosable. The provider's own transcript is then the
		// only account of why it changed no files.
		if (!diff) result.gateEvidence = boundedGateEvidence(execution.output);
	}
	return result;
}
export function executeTask(task, context) {
	if (!context._completionPin) {
		context._activeRouteHealth = null;
		context._activeProviderExecutionSucceeded = false;
		context._activeCompletionLifecycleReceipt = null;
	}
	const result = decorateDirtyOverlayResult(
		attachRouteHealthTerminal(executeTaskUnsafe(task, context), context),
		context,
	);
	if (context.recordOutcomeEvent) {
		context._outcomeWriteChain = (
			context._outcomeWriteChain ?? Promise.resolve()
		)
			.then(() => emitTaskStageOutcomes(context, task, result))
			.catch(() => {});
	}
	return result;
}
export async function executeTaskAsync(task, context) {
	clearAsyncTaskContext(context);
	context._activeRouteHealth = null;
	context._activeProviderExecutionSucceeded = false;
	context._activeCompletionLifecycleReceipt = null;
	const requiredCapability = resolveTaskRequiredCapability(task);
	try {
		const result = decorateDirtyOverlayResult(
			attachRouteHealthTerminal(
				await executeTaskAsyncUnsafe(task, context),
				context,
			),
			context,
		);
		await emitTaskStageOutcomes(context, task, result);
		return result;
	} catch (error) {
		const route = context._activeBrokerRoute;
		const routed = context._activeTaskRoute;
		const failure = asyncExecutionFailureMetadata(error, task.id);
		context._activeBrokerRoute = null;
		if (route?.reservation && context.broker?.release) {
			try {
				await context.broker.release(route, "failure");
			} catch {
				// The task failure remains bounded; recovery handles an unavailable ledger.
			}
		}
		if (!context._activeDispatchOutcomeRecorded) {
			try {
				await Promise.resolve(
					context.recordDispatch({
						provider: routed?.provider ?? "none",
						model: routed?.model ?? "none",
						taskId: task.id,
						result: "execution_failed",
						...failure,
						requiredCapability,
						resolvedTargetId: routed?.resolvedTargetId ?? null,
					}),
				);
			} catch {
				// Preserve the bounded task result if outcome projection is unavailable.
			}
		}
		const result = {
			taskId: task.id,
			success: false,
			provider: routed?.provider ?? null,
			model: routed?.model ?? null,
			requiredCapability,
			// Read from the same routed record as provider and model, and from
			// the same expression the ledger entry above already uses. Omitting
			// it here left any throw between routing and completion returning a
			// failed result that no ledger reader or route-health reader could
			// attribute, while the ledger's own copy of the id was intact.
			// Scope, stated precisely: `routed` is `context._activeTaskRoute`,
			// set only after selectAndReserve returns, so this covers throws
			// AFTER routing. A reservation lock timeout raised inside the
			// selector still leaves the id null, because there is no route yet to
			// read one from -- that is a different, unattributed case, not this
			// one. The reproduction is a post-routing ledger throw; no specific
			// production throw has been measured as the source.
			resolvedTargetId: routed?.resolvedTargetId ?? null,
			result: "execution_failed",
			...failure,
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		};
		await emitTaskStageOutcomes(context, task, result);
		return result;
	} finally {
		clearAsyncTaskContext(context);
	}
}
async function emitTaskStageOutcomes(context, task, result) {
	if (
		context?.emitNonProviderOutcomes !== true ||
		!context?.recordOutcomeEvent ||
		!context?.outcomeWriterEpoch
	)
		return;
	const captureStatus = result?.captureStatus ?? null;
	const expectsArtifact = task.type === "implementation";
	const artifactDecision = artifactTransition({
		expectsArtifact,
		captureStatus,
	});
	const artifactAvailable = ["captured", "empty"].includes(captureStatus);
	await emitStageOutcome(context, {
		taskId: task.id,
		attempt: context._activeOutcomeAttempt ?? 1,
		stage: "artifact",
		status: artifactDecision.status,
		producer: "runner",
		code: artifactDecision.code,
		detail: {
			artifactKind: artifactDecision.artifactKind,
			captured: artifactDecision.captured,
			...(artifactDecision.captureStatus
				? { captureStatus: artifactDecision.captureStatus }
				: {}),
		},
	});
	const integrationReached =
		expectsArtifact &&
		artifactAvailable &&
		["success", "integration_failed"].includes(result?.result);
	const integrationDecision = integrationTransition({
		expectsArtifact,
		reached: integrationReached,
		accepted: integrationReached && result?.success === true,
		gateCode: integrationReached ? result.result : "not_observed",
	});
	await emitStageOutcome(context, {
		taskId: task.id,
		attempt: context._activeOutcomeAttempt ?? 1,
		stage: "integration",
		status: integrationDecision.status,
		producer: "runner",
		code: integrationDecision.code,
		detail: {
			gateCode: integrationDecision.gateCode,
			accepted: integrationDecision.accepted,
		},
	});
	await emitStageOutcome(context, {
		taskId: task.id,
		attempt: context._activeOutcomeAttempt ?? 1,
		stage: "postcondition",
		status: result?.success === true ? "succeeded" : "failed",
		producer: "runner",
		code: "task_postcondition",
		detail: {
			commandResult: result?.result ?? "unknown",
			observedState: result?.success === true ? "accepted" : "rejected",
		},
	});
}
function clearAsyncTaskContext(context) {
	context._activeBrokerRoute = null;
	context._activeProcessOutcomeId = null;
	context._activeOutcomeAttempt = null;
	context._activeTaskRoute = null;
	context._activeInvocationDescriptor = null;
	context._activeDispatchOutcomeRecorded = false;
	context._activeTaskPrompt = null;
	context._activeTaskTimeoutMs = null;
	context._activeTaskDeadline = null;
	context._activeTaskTranscript = null;
	context._activeTaskIsReview = false;
}
async function persistCheckpointOutcomeShadow(
	checkpointPath,
	checkpoint,
	runStore,
	runId,
) {
	if (
		!runStore ||
		typeof runStore.readRun !== "function" ||
		typeof runId !== "string"
	)
		return false;
	const run = await runStore.readRun(runId).catch(() => null);
	if (!run) return false;
	const events =
		typeof runStore.readEvents === "function"
			? await runStore.readEvents(runId).catch(() => [])
			: [];
	const outcomeProjection = projectOutcomeReader({ run, events });
	checkpoint.outcomeProjection = null;
	if (outcomeProjection.reader === "reducer")
		checkpoint.outcomeProjection = structuredClone(outcomeProjection);
	checkpoint.outcomeShadow = null;
	if (run.outcomeShadow) {
		try {
			validateShadowEnvelope(run.outcomeShadow);
			checkpoint.outcomeShadow = structuredClone(run.outcomeShadow);
		} catch {
			// Invalid shadow evidence cannot authorize a checkpoint cutover.
		}
	}
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
	return true;
}
function asyncExecutionFailureMetadata(error, taskId) {
	const errorKind = BOUNDED_ERROR_KINDS.has(error?.errorKind)
		? error.errorKind
		: "unknown_failure";
	const failure = sanitizeFailureMetadata({
		taskId,
		result: "execution_failed",
		errorKind,
	});
	const message = typeof error?.message === "string" ? error.message : "";
	const brokerErrorCode =
		error?.code && /^snapshot_[a-z_]+$/.test(error.code)
			? error.code
			: message.includes("fallback already attempted")
				? "fallback_already_attempted"
				: message.includes("timed out acquiring broker reservation lock")
					? "reservation_lock_timeout"
					: null;
	return {
		...failure,
		...(brokerErrorCode
			? {
					ledgerFailure: true,
					ledgerFailurePhase: "broker_precondition",
					ledgerFailureCode: brokerErrorCode,
				}
			: {}),
	};
}
async function executeTaskAsyncUnsafe(task, context) {
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return nonSwitchyardExecutorResult(task, executor, requiredCapability);
	}
	const overlayFailure = dirtyOverlayResult(task, context, requiredCapability);
	if (overlayFailure) return overlayFailure;
	const checkIgnored = context.checkIgnoredPath ?? findIgnoredDeclaredPath;
	const ignoredPath = checkIgnored(
		task.requiredPaths ?? task.files,
		context.projectPath,
	);
	if (ignoredPath) {
		return declaredPathNotSeededResult(task, requiredCapability);
	}
	const hostPower = readQueueHostPower({
		hostPowerProbe: context.hostPowerProbe,
		execFn: context.hostPowerExecFn,
		timeoutMs: context.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: context.hostPowerPolicyEnabled,
		onStatus: context.onStatus,
		taskId: task.id,
	});
	if (hostPower.state === HOST_POWER_STATES.BATTERY) {
		return policyDeferredTaskResult(task, hostPower, context.taskFileSha256);
	}
	let broker = context.broker;
	if (!broker) {
		broker = createDispatchBroker(context, context.brokerDependencies);
		context.broker = broker;
	}
	context._activeTaskPrompt = taskPromptForAttempt(
		task,
		context._completionRequirements,
	);
	context._activeTaskTimeoutMs =
		task.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS;
	// Only a review task has a verdict to derive. Deriving unconditionally would
	// parse an implementation task's transcript and relay text sanitized out of it
	// across the broker boundary, which is the one thing that boundary exists to
	// prevent.
	context._activeTaskIsReview = task.type === "review";
	const brokerRequest = brokerRequestForTask(task, context, requiredCapability);
	let selectedRoute = await broker.selectAndReserve(brokerRequest);
	context._activeBrokerRoute = selectedRoute;
	context._activeDispatchOutcomeRecorded = false;
	const releaseSelected = async (route) => {
		context._activeBrokerRoute = null;
		if (route?.reservation) {
			try {
				await broker.release(route, "failure");
			} catch {
				// Preserve the task failure; recovery handles an unavailable ledger.
			}
		}
	};
	let routeResult = normalizeBrokerRoute(selectedRoute);
	context._activeTaskRoute = routeResult;
	let routeCapability = selectedRoute.capability;
	let provenance = resolveRouteProvenance(
		routeResult.provider,
		routeCapability,
	);
	mergeBrokerRouteProvenance(routeResult, routeCapability, provenance);
	let invocationDescriptor;
	try {
		invocationDescriptor = descriptorFromRoute(
			routeResult,
			routeCapability,
			context.resolveDescriptor ??
				(context.qualificationAttempt
					? getConfiguredInvocationDescriptor
					: getInvocationDescriptor),
		);
	} catch {
		await releaseSelected(selectedRoute);
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider ?? null,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			result: "descriptor_receipt_invalid",
			errorKind: "descriptor_receipt",
			reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
		};
	}
	Object.assign(routeResult, descriptorReceiptFields(invocationDescriptor));
	context._activeInvocationDescriptor = invocationDescriptor;
	let resolvedTargetId = routeResult.resolvedTargetId ?? null;
	const record = async (
		dispatch,
		{
			recordProvenance = provenance,
			recordDescriptor = invocationDescriptor,
			recordResolvedTargetId = resolvedTargetId,
		} = {},
	) => {
		await Promise.resolve(
			context.recordDispatch({
				...recordProvenance,
				...descriptorReceiptFields(recordDescriptor),
				resolvedTargetId: recordResolvedTargetId,
				...dispatch,
				requiredCapability,
			}),
		);
		context._activeDispatchOutcomeRecorded = true;
	};
	if (!routeResult.provider) {
		await releaseSelected(selectedRoute);
		const reason = safeNoProviderReason(routeResult.reason);
		await record({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			requiredCapability,
			resolvedTargetId,
			result: "no_provider",
			reason,
			errorKind: null,
		};
	}
	let adapter = selectAdapter(
		routeResult.resolved_harness ?? routeResult.provider,
		context.adapters,
	);
	context._activeCompletionAdapter = adapter;
	context._activeCompletionRoute = structuredClone(routeResult);
	if (!adapter) {
		await releaseSelected(selectedRoute);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "unsupported_provider",
			reason: safeSuccessfulRouteReason(routeResult.reason),
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "unsupported_provider",
		};
	}
	const timeoutMs = task.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS;
	const routedDeadline = new Date(Date.now() + timeoutMs).toISOString();
	context._activeTaskDeadline = routedDeadline;
	context.onStatus?.({
		phase: "execution",
		event: "task_routed",
		status: `Task ${task.id} routed to ${routeResult.provider}`,
		taskId: task.id,
		provider: routeResult.provider,
		model: invocationDescriptor.selector,
		deadline: routedDeadline,
		resolvedTargetId,
		...descriptorReceiptFields(invocationDescriptor),
	});
	context.onTaskRouted?.({
		taskId: task.id,
		provider: routeResult.provider,
		model: invocationDescriptor.selector,
		deadline: routedDeadline,
		resolvedTargetId,
		...descriptorReceiptFields(invocationDescriptor),
	});
	const intentFailure = await writeDispatchIntentAsync(
		context,
		dispatchIntentPayload(
			task.id,
			routeResult,
			requiredCapability,
			provenance,
			invocationDescriptor,
		),
	);
	if (intentFailure) {
		await releaseSelected(selectedRoute);
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "intent_receipt_failed",
			errorKind: "intent_receipt",
			...intentFailure,
		};
	}
	if (
		typeof adapter.executeAsync !== "function" ||
		typeof adapter.captureDiffAsync !== "function"
	) {
		await releaseSelected(selectedRoute);
		const reason = "adapter async lifecycle unavailable";
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			errorKind: "execution_failed",
			reason,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "execution_failed",
			errorKind: "execution_failed",
			error: reason,
		};
	}
	context.queueBackend?.beforeRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	let attemptCleanupContext = executionCleanupContext(
		context,
		task,
		invocationDescriptor.descriptor_identity,
	);
	if (!(await prepareTaskBaseAsync(context, task, attemptCleanupContext))) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "task_base_capture_failed",
			errorKind: "diff_capture_failed",
			reason: "immutable task base capture failed",
		});
		await releaseSelected(selectedRoute);
		return taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const healthPreparation = prepareRouteHealthTrial(
		context,
		task,
		routeResult,
		invocationDescriptor,
	);
	if (!healthPreparation.allowed) {
		await releaseSelected(selectedRoute);
		return healthDeferredResult(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const healthStart = startRouteHealthTrial(context);
	if (!healthStart.allowed) {
		await releaseSelected(selectedRoute);
		return healthDeferredResult(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	context._outcomeAttemptCursor = (context._outcomeAttemptCursor ?? 0) + 1;
	context._activeOutcomeAttempt = context._outcomeAttemptCursor;
	let clearExecutionPolicy = () => {};
	if (selectedRoute.reservation?.id) {
		clearExecutionPolicy = registerBrokerExecutionPolicy(
			selectedRoute.reservation.id,
			{
				recordOutcome: context.recordOutcomeEvent
					? (outcome) => context.recordOutcomeEvent(outcome)
					: undefined,
				writerEpoch: context.outcomeWriterEpoch ?? null,
				operationId: `operation-${task.id}-execution`,
				causedBy: () => context._activeProcessOutcomeId ?? null,
				attempt: context._activeOutcomeAttempt,
			},
		);
	}
	let brokerExecution;
	try {
		brokerExecution = await broker.execute(brokerRequest, selectedRoute, {
			launcherIdentity: broker.launcherIdentity(selectedRoute),
			signal: context.signal,
			onStatus: context.onStatus,
			onAdapterStatus: context.onStatus,
			onPoll: context.onPoll,
			onTaskHeartbeat: context.onTaskHeartbeat,
		});
	} finally {
		clearExecutionPolicy();
	}
	context._activeBrokerRoute = null;
	if (!brokerExecution.success) {
		const primaryRoute = routeResult;
		const primaryProvenance = provenance;
		const primaryDescriptor = invocationDescriptor;
		const primaryResolvedTargetId = resolvedTargetId;
		const failureKind = brokerFailureKind(brokerExecution);
		const fallbackCapability = {
			low: "low",
			standard: "standard",
			high: "high",
		}[requiredCapability];
		if (
			failureKind &&
			fallbackCapability &&
			context._activeRouteHealth?.claimStarted !== true
		) {
			const fallbackPower = readQueueHostPower({
				hostPowerProbe: context.hostPowerProbe,
				execFn: context.hostPowerExecFn,
				timeoutMs: context.hostPowerProbeTimeoutMs,
				hostPowerPolicyEnabled: context.hostPowerPolicyEnabled,
				onStatus: context.onStatus,
				taskId: task.id,
			});
			if (fallbackPower.state === HOST_POWER_STATES.BATTERY) {
				await releaseSelected(selectedRoute);
				return policyDeferredTaskResult(
					task,
					fallbackPower,
					context.taskFileSha256,
				);
			}
			context._activeBrokerRoute = selectedRoute;
			const fallbackRoute = await broker.fallbackAndReserve(
				brokerRequest,
				selectedRoute,
				{
					failureKind,
					capabilityCeiling: fallbackCapability,
				},
			);
			if (fallbackRoute.provider) {
				await record(
					{
						provider: primaryRoute.provider,
						model: primaryRoute.model ?? "unknown",
						taskId: task.id,
						result: "execution_failed",
						errorKind: brokerExecution.errorKind ?? "execution_failed",
						reason: brokerExecution.reason ?? primaryRoute.reason,
						diagnosticCode: brokerExecution.diagnosticCode,
						exitCode: brokerExecution.exitCode,
						signal: brokerExecution.signal,
						failurePhase: brokerExecution.failurePhase,
						diagnosticOrigin: brokerExecution.diagnosticOrigin,
						diagnosticEvidenceAvailable:
							brokerExecution.diagnosticEvidenceAvailable,
						diagnosticRef: brokerExecution.diagnosticRef,
					},
					{
						recordProvenance: primaryProvenance,
						recordDescriptor: primaryDescriptor,
						recordResolvedTargetId: primaryResolvedTargetId,
					},
				);
				context._activeDispatchOutcomeRecorded = false;
				context._activeBrokerRoute = fallbackRoute;
				context._activeProcessOutcomeId = null;
				context._outcomeAttemptCursor =
					(context._outcomeAttemptCursor ?? 0) + 1;
				context._activeOutcomeAttempt = context._outcomeAttemptCursor;
				selectedRoute = fallbackRoute;
				routeCapability = fallbackRoute.capability;
				routeResult = normalizeBrokerRoute(fallbackRoute);
				context._activeTaskRoute = routeResult;
				provenance = resolveRouteProvenance(
					routeResult.provider,
					routeCapability,
				);
				invocationDescriptor = descriptorFromRoute(
					routeResult,
					routeCapability,
					context.resolveDescriptor ?? getInvocationDescriptor,
				);
				mergeBrokerRouteProvenance(routeResult, routeCapability, provenance);
				Object.assign(
					routeResult,
					descriptorReceiptFields(invocationDescriptor),
				);
				context._activeInvocationDescriptor = invocationDescriptor;
				resolvedTargetId = routeResult.resolvedTargetId ?? null;
				attemptCleanupContext = executionCleanupContext(
					context,
					task,
					invocationDescriptor.descriptor_identity,
				);
				context._activeTaskHelperContext = mergeAttemptCleanupContext(
					attemptCleanupContext,
					{ operation: "helper" },
				);
				adapter = selectAdapter(
					routeResult.resolved_harness ?? routeResult.provider,
					context.adapters,
				);
				context.onStatus?.({
					phase: "broker",
					event: "fallback_reserved",
					status: `Task ${task.id} reserved an authorized fallback route`,
					taskId: task.id,
					provider: routeResult.provider,
					model: routeResult.model,
				});
				context._activeTaskDeadline = new Date(
					Date.now() + timeoutMs,
				).toISOString();
				context.onTaskRouted?.({
					taskId: task.id,
					provider: routeResult.provider,
					model: invocationDescriptor.selector,
					deadline: context._activeTaskDeadline,
					resolvedTargetId,
					...descriptorReceiptFields(invocationDescriptor),
				});
				context.onStatus?.({
					phase: "execution",
					event: "task_routed",
					status: `Task ${task.id} fallback routed to ${routeResult.provider}`,
					taskId: task.id,
					provider: routeResult.provider,
					model: invocationDescriptor.selector,
					deadline: context._activeTaskDeadline,
					resolvedTargetId,
					...descriptorReceiptFields(invocationDescriptor),
				});
				const fallbackIntentFailure = await writeDispatchIntentAsync(
					context,
					dispatchIntentPayload(
						task.id,
						routeResult,
						requiredCapability,
						provenance,
						invocationDescriptor,
					),
				);
				if (fallbackIntentFailure) {
					await releaseSelected(fallbackRoute);
					return {
						...descriptorReceiptFields(invocationDescriptor),
						taskId: task.id,
						success: false,
						provider: routeResult.provider,
						model: invocationDescriptor.selector,
						requiredCapability,
						resolvedTargetId,
						result: "intent_receipt_failed",
						errorKind: "intent_receipt",
						...fallbackIntentFailure,
					};
				}
				context._activeRouteHealth = null;
				const fallbackHealth = prepareRouteHealthTrial(
					context,
					task,
					routeResult,
					invocationDescriptor,
				);
				if (
					!fallbackHealth.allowed ||
					!startRouteHealthTrial(context).allowed
				) {
					await releaseSelected(fallbackRoute);
					return healthDeferredResult(
						task,
						routeResult,
						invocationDescriptor,
						requiredCapability,
					);
				}
				clearExecutionPolicy = () => {};
				if (fallbackRoute.reservation?.id) {
					clearExecutionPolicy = registerBrokerExecutionPolicy(
						fallbackRoute.reservation.id,
						{
							recordOutcome: context.recordOutcomeEvent
								? (outcome) => context.recordOutcomeEvent(outcome)
								: undefined,
							writerEpoch: context.outcomeWriterEpoch ?? null,
							operationId: `operation-${task.id}-execution`,
							causedBy: () => context._activeProcessOutcomeId ?? null,
							attempt: context._activeOutcomeAttempt,
						},
					);
				}
				try {
					brokerExecution = await broker.execute(brokerRequest, fallbackRoute, {
						launcherIdentity: broker.launcherIdentity(fallbackRoute),
						signal: context.signal,
						onStatus: context.onStatus,
						onAdapterStatus: context.onStatus,
						onPoll: context.onPoll,
						onTaskHeartbeat: context.onTaskHeartbeat,
					});
				} finally {
					clearExecutionPolicy();
				}
				context._activeBrokerRoute = null;
			}
		}
	}
	const execution = {
		success: brokerExecution.success,
		timedOut: brokerExecution.timedOut === true,
		silenceTimedOut: brokerExecution.silenceTimedOut === true,
		outcome: brokerExecution.outcome ?? null,
		cleanupFailed: brokerExecution.cleanupFailed === true,
		error: brokerExecution.reason ?? null,
		errorKind: brokerExecution.errorKind ?? brokerExecution.outcome,
		diagnosticCode: brokerExecution.diagnosticCode ?? null,
		exitCode: brokerExecution.exitCode ?? null,
		signal: brokerExecution.signal ?? null,
		failurePhase: brokerExecution.failurePhase ?? null,
		diagnosticOrigin: brokerExecution.diagnosticOrigin ?? null,
		diagnosticEvidenceAvailable:
			brokerExecution.diagnosticEvidenceAvailable === true,
		diagnosticRef:
			brokerExecution.diagnosticEvidenceAvailable === true &&
			typeof brokerExecution.diagnosticRef === "string" &&
			/^diagnostic:[a-f0-9]{32}$/u.test(brokerExecution.diagnosticRef)
				? brokerExecution.diagnosticRef
				: null,
		cleanupStage: brokerExecution.cleanupStage ?? null,
		servedModelVerified: brokerExecution.servedModelVerified ?? null,
		progress: brokerExecution.progress ?? null,
		providerLifecycle: brokerExecution.providerLifecycle ?? null,
		// The broker relays a sanitized verdict and never raw provider bytes, so
		// there is no output to read back on this path; a route that produced no
		// verdict relays null and the review result resolves to an explicit
		// `missing` instead of inheriting a placeholder.
		reviewResult: brokerExecution.reviewResult ?? null,
		executionOutcome: brokerExecution.executionOutcome ?? null,
		outcomePersistenceFailed: brokerExecution.outcomePersistenceFailed === true,
	};
	if (execution.outcomePersistenceFailed) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "recovery_required",
			errorKind: "recovery_incomplete",
			reason: "typed execution outcome persistence failed; recovery required",
			failurePhase: "terminal_reconciliation",
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "recovery_required",
			errorKind: "recovery_incomplete",
			reason: "typed execution outcome persistence failed; recovery required",
			failurePhase: "terminal_reconciliation",
			executionOutcome: execution.executionOutcome,
		};
	}
	context._activeProviderExecutionSucceeded = execution.success === true;
	context._activeCompletionLifecycleReceipt = boundCompletionContinuationProof(
		brokerExecution.completionContinuationProof,
	);
	if (execution.cleanupFailed === true && execution.success) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			reason: "provider cleanup is uncertain; recovery required",
			cleanupStage: execution.cleanupStage ?? null,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			...survivingProviderFields(execution),
		};
	}
	if (isStructuredReviewExecution(task, execution)) {
		context.queueBackend?.afterRun?.(
			context.workingContainerName,
			context.projectPath,
			{ onStatus: context.onStatus },
		);
		const review = reviewTaskResult(
			task,
			execution,
			routeResult,
			invocationDescriptor,
			requiredCapability,
			resolvedTargetId,
		);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: review.result,
			reviewResult: review.reviewResult,
			...(review.success
				? {}
				: { errorKind: review.errorKind, reason: review.reason }),
			...survivingProviderFields(execution),
		});
		return review;
	}
	if (!execution.success) {
		if (!execution.timedOut) {
			let captureEvidence = null;
			if (retainsFailureDiff(task)) {
				context.onStatus?.({
					phase: "execution",
					event: "diff_capture_started",
					status: `Task ${task.id} failure diff capture started`,
					taskId: task.id,
				});
				try {
					captureEvidence = await captureDiffWithEvidenceAsync(
						adapter,
						context.workingContainerName,
						{
							executionBackend: bindAttemptHelperBackend(
								context.executionBackend,
								attemptCleanupContext,
							),
							taskBase: context._activeTaskBase,
							signal: context.signal,
						},
					);
				} catch {
					captureEvidence = { status: "transport_failed", diff: null };
				}
				context.onStatus?.({
					phase: "execution",
					event: "diff_capture_completed",
					status: `Task ${task.id} failure diff capture ${captureEvidence.status}`,
					taskId: task.id,
					captureStatus: captureEvidence.status,
					byteCount: captureEvidence.diff?.length ?? 0,
				});
			}
			await record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: "execution_failed",
				errorKind: execution.errorKind ?? null,
				reason: execution.error ?? routeResult.reason,
				diagnosticCode: execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupStage: execution.cleanupStage,
				...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
				...reviewFailureFields(task, execution),
				...survivingProviderFields(execution),
			});
			return {
				...descriptorReceiptFields(invocationDescriptor),
				taskId: task.id,
				success: false,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
				requiredCapability,
				resolvedTargetId,
				result: "execution_failed",
				error: execution.error ?? null,
				errorKind: execution.errorKind ?? null,
				diagnosticCode: execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupStage: execution.cleanupStage,
				...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
				...reviewFailureFields(task, execution),
				...survivingProviderFields(execution),
				...(captureEvidence?.diff ? { partialDiff: captureEvidence.diff } : {}),
			};
		}

		let captureEvidence = null;
		if (retainsFailureDiff(task)) {
			context.onStatus?.({
				phase: "execution",
				event: "diff_capture_started",
				status: `Task ${task.id} partial diff capture started`,
				taskId: task.id,
			});
			try {
				captureEvidence = await captureDiffWithEvidenceAsync(
					adapter,
					context.workingContainerName,
					{
						executionBackend: bindAttemptHelperBackend(
							context.executionBackend,
							attemptCleanupContext,
						),
						taskBase: context._activeTaskBase,
						signal: context.signal,
					},
				);
			} catch {
				captureEvidence = { status: "transport_failed", diff: null };
			}
		}
		const partialDiff = captureEvidence?.diff ?? null;
		const captureStatus = captureEvidence?.status;
		const captureFailed =
			captureEvidence !== null &&
			captureStatus !== "captured" &&
			captureStatus !== "empty";
		if (captureEvidence !== null) {
			context.onStatus?.({
				phase: "execution",
				event: "diff_capture_completed",
				status: `Task ${task.id} partial diff capture ${captureStatus}`,
				taskId: task.id,
				captureStatus,
				byteCount: partialDiff?.length ?? 0,
			});
		}
		const cleanupFailed = execution.cleanupFailed === true;
		const resultName = cleanupFailed
			? "execution_timed_out_cleanup_failed"
			: captureFailed
				? "execution_timed_out_capture_failed"
				: "execution_timed_out";
		const errorKind =
			(cleanupFailed && "provider_cleanup_failed") ||
			(captureFailed && "diff_capture_failed") ||
			execution.errorKind ||
			null;
		const safeTimeoutFailure = sanitizeFailureMetadata({
			taskId: task.id,
			result: resultName,
			errorKind,
			timedOut: true,
			diagnosticCode: execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupStage: execution.cleanupStage,
			...survivingProviderFields(execution),
		});
		const error = cleanupFailed
			? (execution.error ??
				safeTimeoutFailure?.reason ??
				"provider cleanup failed after timeout")
			: captureFailed
				? (safeTimeoutFailure?.reason ?? "diff capture failed after timeout")
				: (execution.error ?? null);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: resultName,
			errorKind: safeTimeoutFailure?.errorKind ?? errorKind,
			...(safeTimeoutFailure
				? { reasonCode: safeTimeoutFailure.reasonCode }
				: {}),
			reason: error ?? routeResult.reason,
			...(captureStatus ? { captureStatus } : {}),
			...reviewFailureFields(task, execution),
			diagnosticCode:
				safeTimeoutFailure?.diagnosticCode ?? execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupStage: execution.cleanupStage,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: resultName,
			error,
			errorKind: safeTimeoutFailure?.errorKind ?? errorKind,
			...(safeTimeoutFailure
				? {
						reasonCode: safeTimeoutFailure.reasonCode,
						reason: safeTimeoutFailure.reason,
					}
				: {}),
			timedOut: true,
			diagnosticCode:
				safeTimeoutFailure?.diagnosticCode ?? execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupFailed,
			cleanupStage: execution.cleanupStage,
			...(captureStatus ? { captureStatus } : {}),
			...reviewFailureFields(task, execution),
			...survivingProviderFields(execution),
			...(partialDiff ? { partialDiff } : {}),
		};
	}
	context.queueBackend?.afterRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	context.onStatus?.({
		phase: "execution",
		event: "diff_capture_started",
		status: `Task ${task.id} diff capture started`,
		taskId: task.id,
	});
	const captureEvidence = await captureDiffWithEvidenceAsync(
		adapter,
		context.workingContainerName,
		{
			executionBackend: bindAttemptHelperBackend(
				context.executionBackend,
				attemptCleanupContext,
			),
			taskBase: context._activeTaskBase,
			signal: context.signal,
		},
	);
	if (!["captured", "empty"].includes(captureEvidence.status)) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "diff_capture_failed",
			errorKind: "diff_capture_failed",
			captureStatus: captureEvidence.status,
			reason: "authoritative host diff capture failed",
		});
		return {
			...taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			),
			result: "diff_capture_failed",
			reason: "authoritative host diff capture failed",
			captureStatus: captureEvidence.status,
		};
	}
	const diff = captureEvidence.diff;
	context.onStatus?.({
		phase: "execution",
		event: "diff_captured",
		status: "Diff captured",
		taskId: task.id,
		provider: routeResult.provider,
		model: invocationDescriptor.selector,
		byteCount: diff ? diff.length : 0,
		captureStatus: captureEvidence.status,
	});
	if (
		!diff &&
		task.requiredPaths === null &&
		(task.quickChecks?.checks?.length ?? 0) === 0
	) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			reason: safeSuccessfulRouteReason(routeResult.reason),
			...survivingProviderFields(execution),
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: true,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "success_no_diff",
			captureStatus: captureEvidence.status,
			...servedModelVerificationFields(execution),
			...survivingProviderFields(execution),
		};
	}
	const quickCheck = await quickCheckDecisionAsync(task, context, diff);
	const gateResult = !quickCheck.passed
		? { success: false, message: "check_failed" }
		: (dirtyOverlayIntegrationGate(context) ??
			context.integrationGate(diff, context.projectPath, {
				allowedPaths: task.requiredPaths,
				allowSensitiveManifests:
					task.type === "implementation" && task.allowManifests === true,
				integrationIntent: checkpointIntegrationIntent(context, task, diff),
				dirtyOverlayReceiptHash:
					context.dirtyOverlayReceipt?.receiptHash ?? null,
			}));
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const gateSuccess = Boolean(gateResult?.success) || alreadyApplied;
	const success = gateSuccess && quickCheck.passed;
	const terminalResult = !quickCheck.passed
		? "check_failed"
		: gateSuccess
			? "success"
			: "integration_failed";
	const safeGateFailure = !quickCheck.passed
		? {
				errorKind: "check_failed",
				reasonCode: "check_failed",
				reason: "Task check command failed.",
			}
		: !gateSuccess
			? integrationFailureMetadata(
					task.id,
					diff,
					gateResult?.credentialFlagged,
					gateResult,
					!diff && Boolean(context._activeTaskTranscript),
				)
			: null;
	await record({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: terminalResult,
		captureStatus: captureEvidence.status,
		...(Array.isArray(gateResult?.missingPaths)
			? { missingPaths: [...gateResult.missingPaths] }
			: {}),
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...survivingProviderFields(execution),
		...(success
			? { reason: safeSuccessfulRouteReason(routeResult.reason) }
			: {}),
	});
	return {
		...descriptorReceiptFields(invocationDescriptor),
		taskId: task.id,
		success,
		...(quickCheck.receipt ? { quickCheckReceipt: quickCheck.receipt } : {}),
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: terminalResult,
		captureStatus: captureEvidence.status,
		...servedModelVerificationFields(execution),
		...survivingProviderFields(execution),
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(!success && !gateResult?.credentialFlagged
			? {
					partialDiff: diff,
					...(diff
						? {}
						: { gateEvidence: context._activeTaskTranscript ?? null }),
				}
			: {}),
	};
}
async function runQueueAsyncImpl(options) {
	const {
		tasksFilePath,
		projectPath,
		workingContainerName: suppliedWorkingContainerName,
		checkpointPath = getCheckpointPath(tasksFilePath),
		maxTasks = Number.POSITIVE_INFINITY,
		stopOnFailure = true,
		exclude = [],
		only = [],
		taskIds = [],
		platform,
		runOptions = null,
		queueIdentity = null,
		projectRevision = null,
		runStorePath = null,
		runId = null,
		dependencies = {},
	} = options;
	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});
	const emitStatus = _resolveOnStatus(dependencies);
	// Discover the run writer before any queue parsing, backend preflight, or
	// VM admission. Those are authoritative preflight boundaries: if one fails,
	// the run must still receive an explicit typed failure when its lease exists.
	const outcomeWriter = await prepareOutcomeWriter(runId, dependencies);
	const stageContext = {
		runId,
		recordOutcomeEvent:
			dependencies.recordOutcomeEvent ?? outcomeWriter?.record ?? null,
		outcomeWriterEpoch:
			dependencies.outcomeWriterEpoch ?? outcomeWriter?.writerEpoch ?? null,
		onStatus: emitStatus,
	};
	await emitStageOutcome(stageContext, {
		stage: "worker",
		status: "succeeded",
		producer: "runner",
		code: "worker_started",
		detail: { launchVerified: true },
	});
	await emitStageOutcome(stageContext, {
		stage: "run",
		status: "started",
		producer: "runner",
		code: "run_started",
	});
	let launch;
	try {
		launch = prepareQueueLaunch({
			tasksFilePath,
			projectPath,
			checkpointPath,
			maxTasks,
			stopOnFailure,
			exclude,
			only,
			taskIds,
			identityTaskIds: [],
			platform,
			runOptions,
			queueIdentity,
			projectRevision,
			runId,
			dependencies,
			onStatus: emitStatus,
			deferSlotAcquisition: true,
		});
	} catch (error) {
		await emitStageOutcome(stageContext, {
			stage: "preflight",
			status: "failed",
			producer: "runner",
			code: "queue_preflight_failed",
			detail: { eligible: false },
		});
		throw error;
	}
	const {
		queueBackend,
		dirtyOverlayReceipt,
		selectedPlatform,
		tasks,
		checkpoint,
		taskFileSha256,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	if (launch.policyDeferred) {
		await emitStageOutcome(stageContext, {
			stage: "preflight",
			status: "skipped",
			producer: "runner",
			code: "queue_deferred",
			detail: { eligible: false },
		});
		emitStatus?.({
			phase: "policy",
			event: "queue_deferred",
			status: "Queue deferred while host is on battery power",
			taskId: launch.policyDeferred.nextTaskId,
			diagnosticCode: launch.policyDeferred.diagnosticCode,
		});
		return policyDeferredQueueResult(launch, checkpointPath);
	}
	ensureRetryCheckpoint(checkpoint);
	ensureProviderAttemptAllocations(checkpoint);
	let slotLease;
	try {
		slotLease = await acquireQueueSlotAsync({
			queueBackend,
			selectedPlatform,
			runId,
			dependencies,
			onStatus: emitStatus,
		});
	} catch (error) {
		await emitStageOutcome(stageContext, {
			stage: "preflight",
			status: "failed",
			producer: "runner",
			code: isVmSlotUnavailable(error)
				? "vm_slot_unavailable"
				: "queue_admission_failed",
			detail: { eligible: false },
		});
		throw error;
	}
	await emitStageOutcome(stageContext, {
		stage: "preflight",
		status: "succeeded",
		producer: "runner",
		code: "queue_preflight",
		detail: { eligible: true },
	});
	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	let queueResult = null;
	try {
		if (!workingContainerName) {
			assertDirtyOverlayReceiptCurrent(
				projectPath,
				dirtyOverlayReceipt,
				"immediately before allocation",
			);
			queueBackend.ensureAgentContainer();
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: dependencies.onStatus,
			});
			if (!workingContainerName) {
				throw new Error("runQueueAsync: failed to create working container");
			}
			ownsWorkingContainer = true;
			if (!dependencies.signal) {
				uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
					workingContainerName,
					queueBackend.destroy,
				);
			}
			dependencies.onStatus?.({
				phase: "bootstrap",
				event: "container_created",
				status: "Working container created",
			});
			// Credential provisioning and project seeding can be slow. Publish the
			// resolved container before either operation so status is useful during
			// bootstrap rather than looking like a dead launch.
			dependencies.onContainerReady?.({ workingContainerName });
			try {
				queueBackend.provision(workingContainerName);
			} catch (error) {
				console.error(
					`runQueueAsync: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
			queueBackend.seed(workingContainerName, projectPath, {
				dirtyOverlayReceipt,
			});
			queueBackend.afterCreate?.(workingContainerName, projectPath, {
				onStatus: dependencies.onStatus,
			});
		}
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueueAsync: before_remove hook failed: ${hookError.message}`,
					);
				}
				queueBackend.destroy(workingContainerName);
			} catch {
				// Preserve the bootstrap error.
			}
		}
		releaseQueueSlot(queueBackend, slotLease);
		throw error;
	}
	checkpoint.taskBases ??= {};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch:
			dependencies.recordDispatch ??
			((dispatch) =>
				recordDispatchToBothLedgers(
					dispatch,
					(data) => recordDispatchToStore(data, runStorePath),
					ledgerReportingContext(dependencies.onStatus ?? null, dependencies),
				)),
		recordOutcomeEvent:
			dependencies.recordOutcomeEvent ?? outcomeWriter?.record ?? null,
		outcomeWriterEpoch:
			dependencies.outcomeWriterEpoch ?? outcomeWriter?.writerEpoch ?? null,
		_activeProcessOutcomeId: null,
		_activeOutcomeAttempt: null,
		_outcomeAttemptCursor: 0,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ??
			((intent) => recordDispatchIntentToStore(intent, runStorePath)),
		integrationGate: dependencies.integrationGate ?? integrationGate,
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		ownsWorkingContainer,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		platform: selectedPlatform,
		goldenImageVerifiedProviders: dependencies.goldenImageVerifiedProviders,
		healthDecision: resolveQueueHealthDecision(dependencies),
		onHealthDecision: dependencies.onHealthDecision,
		checkpoint,
		dirtyOverlayReceipt,
		checkpointPath,
		taskFileSha256,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
		onStatus: dependencies.onStatus ?? null,
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
		onTaskRouted: dependencies.onTaskRouted ?? null,
		onTaskHeartbeat: dependencies.onTaskHeartbeat ?? null,
		checkIgnoredPath: dependencies.checkIgnoredPath,
		hostPowerProbe: dependencies.hostPowerProbe,
		hostPowerExecFn: dependencies.hostPowerExecFn,
		hostPowerProbeTimeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		exclude: mergeRetryExclusions(
			effectiveExclude,
			checkpoint.quarantinedTargetIds,
		),
		only: effectiveOnly,
		emitNonProviderOutcomes:
			dependencies.enableNonProviderOutcomes === true ||
			typeof dependencies.recordOutcomeEvent !== "function",
		signal: dependencies.signal,
		onPoll: dependencies.onPoll,
		resolveDescriptor: dependencies.resolveDescriptor,
		qualificationAttempt:
			runOptions?.qualificationAttempt === true ||
			options.qualificationAttempt === true,
		hasInvocationDescriptor:
			runOptions?.qualificationAttempt === true ||
			options.qualificationAttempt === true
				? getConfiguredInvocationDescriptor
				: undefined,
		runId: queueBackend.taskBaseRunId ?? runId,
		snapshotSource: dependencies.snapshotSource ?? "gradus-v2",
		completionContinuation: dependencies.completionContinuation ?? {
			enabled: false,
		},
		completionContinuationMode: "unavailable",
		now: dependencies.now ?? Date.now,
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
	};
	const results = [];
	const deferredTaskIds = [];
	let policyDeferred = null;
	// Retained only so a teardown failure can name the failure it displaces.
	let inFlightError = null;
	try {
		context.broker = createDispatchBroker(context, dependencies);
		const initialRunnable = getRunnableTasks(tasks, checkpoint, {
			selectedTaskIds: effectiveTaskIds,
			resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
		});
		const attemptedTaskIds = new Set();
		let resumedRetryTaskId = checkpoint.retryState?.taskId ?? null;
		let processed = 0;
		const projectRetryState = () => {
			dependencies.onRetryStateChanged?.({
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
			});
		};
		reconcileAlreadyCompleteSelection(
			checkpoint,
			checkpointPath,
			results,
			effectiveTaskIds,
			tasks,
			dependencies.onResult,
			dependencies.onStatus,
			dependencies.onCheckpointSaved,
		);
		while (processed < effectiveMaxTasks) {
			context.exclude = mergeRetryExclusions(
				effectiveExclude,
				checkpoint.quarantinedTargetIds,
			);
			const selection = selectNextQueueTask(tasks, checkpoint, {
				selectedTaskIds: effectiveTaskIds,
				resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
				excludedTaskIds: attemptedTaskIds,
				retryTaskId: resumedRetryTaskId,
			});
			const task = selection.task;
			if (!task) break;
			resumedRetryTaskId = selection.retryTaskId;
			attemptedTaskIds.clear();
			for (const taskId of selection.excludedTaskIds)
				attemptedTaskIds.add(taskId);
			dependencies.onTaskStart?.(task);
			const retryState =
				checkpoint.retryState?.taskId === task.id
					? checkpoint.retryState
					: null;
			const priorExtraAllocation = ensureProviderAttemptAllocations(
				checkpoint,
			).find((entry) => entry?.taskId === task.id);
			let result;
			if (!retryState && priorExtraAllocation) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason: "persisted extra provider invocation already consumed",
				};
			} else if (retryState && !hasTrustedQuotaRetryEvidence(retryState)) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					resolvedTargetId: retryState.resolvedTargetId ?? null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason:
						"historical retry state lacks trusted quota diagnostic provenance",
				};
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "finalized",
					taskId: task.id,
					attempt: retryState.attempt,
					resolvedTargetId: retryState.resolvedTargetId,
					clearState: true,
					save: false,
				});
				projectRetryState();
			} else if (
				retryState &&
				["retry_started", "retry_halted"].includes(retryState.phase)
			) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					resolvedTargetId: retryState.resolvedTargetId ?? null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason:
						"persisted retry state already consumed the bounded retry attempt",
				};
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "finalized",
					taskId: task.id,
					attempt: retryState.attempt,
					provider: retryState.provider,
					model: retryState.model,
					resolvedTargetId: retryState.resolvedTargetId,
					invocationDescriptor: retryState.invocationDescriptor,
					descriptorIdentity: retryState.descriptorIdentity,
					descriptorHarness: retryState.descriptorHarness,
					clearState: true,
					save: false,
				});
				projectRetryState();
			} else if (retryState) {
				const retryTargetId = normalizeRetryTargetId(
					retryState.resolvedTargetId,
				);
				if (
					retryTargetId &&
					!checkpoint.quarantinedTargetIds.includes(retryTargetId)
				) {
					checkpoint.quarantinedTargetIds.push(retryTargetId);
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "target_quarantined",
						taskId: task.id,
						attempt: 1,
						resolvedTargetId: retryTargetId,
						invocationDescriptor: retryState.invocationDescriptor,
						descriptorIdentity: retryState.descriptorIdentity,
						descriptorHarness: retryState.descriptorHarness,
					});
					projectRetryState();
				}
				let retryHalt = null;
				if (retryState.phase !== "reset_completed") {
					retryHalt = resetBeforeQuotaRetry({
						result: {
							taskId: task.id,
							provider: null,
							model: null,
							resolvedTargetId: retryState.resolvedTargetId,
							invocationDescriptor: retryState.invocationDescriptor,
							descriptorIdentity: retryState.descriptorIdentity,
							descriptorHarness: retryState.descriptorHarness,
						},
						checkpoint,
						checkpointPath,
						workingContainerName,
						resetWorkingTreeFn: queueBackend.reset,
						emitStatus: dependencies.onStatus,
					});
					projectRetryState();
				}
				if (retryHalt) {
					result = retryHalt;
				} else {
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "retry_started",
						taskId: task.id,
						attempt: 2,
						resolvedTargetId: retryState.resolvedTargetId,
						invocationDescriptor: retryState.invocationDescriptor,
						descriptorIdentity: retryState.descriptorIdentity,
						descriptorHarness: retryState.descriptorHarness,
					});
					projectRetryState();
					context.exclude = mergeRetryExclusions(
						effectiveExclude,
						checkpoint.quarantinedTargetIds,
					);
					startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
					result = await executeTaskAsync(task, context);
					appendRetryAttempt(checkpoint, result, 2);
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "finalized",
						taskId: task.id,
						attempt: 2,
						provider: result.provider,
						model: result.model,
						resolvedTargetId:
							result.invocationDescriptor?.target_id ??
							normalizeRetryTargetId(result.resolvedTargetId) ??
							retryTargetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
						clearState: true,
						save: false,
					});
					projectRetryState();
				}
			} else {
				result = await executeTaskAsync(task, context);
			}
			if (result?.result === "policy_deferred") {
				policyDeferred = result.policyDeferred;
				deferredTaskIds.push(result.taskId);
				break;
			}
			decorateDirtyOverlayResult(result, context);
			if (
				!retryState &&
				result._routeHealthTrialStarted !== true &&
				result.extraProviderInvocationUsed !== true &&
				isQuotaRetryCandidate(result, ownsWorkingContainer) &&
				allocateExtraProviderInvocation(
					checkpoint,
					checkpointPath,
					task.id,
					"quota_fallback",
				)
			) {
				const targetId = normalizeRetryTargetId(result.resolvedTargetId);
				appendRetryAttempt(checkpoint, result, 1);
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "attempt_recorded",
					taskId: task.id,
					attempt: 1,
					provider: result.provider,
					model: result.model,
					resolvedTargetId: targetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
					diagnosticCode: result.diagnosticCode,
					diagnosticOrigin: result.diagnosticOrigin,
					diagnosticEvidenceAvailable: result.diagnosticEvidenceAvailable,
					diagnosticRef: result.diagnosticRef,
					failurePhase: result.failurePhase,
				});
				projectRetryState();
				checkpoint.quarantinedTargetIds = [
					...new Set([...checkpoint.quarantinedTargetIds, targetId]),
				];
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "target_quarantined",
					taskId: task.id,
					attempt: 1,
					provider: result.provider,
					model: result.model,
					resolvedTargetId: targetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
				});
				projectRetryState();
				const retryHalt = resetBeforeQuotaRetry({
					result,
					checkpoint,
					checkpointPath,
					workingContainerName,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus: dependencies.onStatus,
				});
				if (retryHalt) {
					result = retryHalt;
				} else {
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "retry_started",
						taskId: task.id,
						attempt: 2,
						provider: result.provider,
						model: result.model,
						resolvedTargetId: targetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
					});
					projectRetryState();
					context.exclude = mergeRetryExclusions(
						effectiveExclude,
						checkpoint.quarantinedTargetIds,
					);
					startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
					result = await executeTaskAsync(task, context);
					appendRetryAttempt(checkpoint, result, 2);
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "finalized",
						taskId: task.id,
						attempt: 2,
						provider: result.provider,
						model: result.model,
						resolvedTargetId:
							result.invocationDescriptor?.target_id ??
							normalizeRetryTargetId(result.resolvedTargetId) ??
							targetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
						clearState: true,
						save: false,
					});
					projectRetryState();
				}
			}
			recordExtraProviderInvocationResult(checkpoint, checkpointPath, task.id);
			if (isRouteHealthDeferredResult(result)) {
				deferredTaskIds.push(result.taskId);
				reportRouteHealthDeferred(
					result,
					dependencies.onResult,
					dependencies.onStatus,
				);
				continue;
			}
			const resultAttempt = reserveTaskAttempt(
				checkpoint,
				checkpointPath,
				result.taskId,
			);
			enforceQuickCheckCompletion(task, result, resultAttempt, checkpoint);
			persistAsyncResultArtifacts({
				result,
				checkpointPath,
				resultAttempt,
				onStatus: dependencies.onStatus,
			});
			persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
			results.push(result);
			dependencies.onResult?.(result);
			const safeFailure = failureMetadataFor(result, result.partialDiffPath);
			checkpoint.results.push({
				taskId: result.taskId,
				attempt: resultAttempt,
				provider: result.provider,
				model: result.model,
				...(result.invocationDescriptor
					? {
							dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity:
								result.invocationDescriptor.descriptor_identity,
							descriptorHarness: result.descriptorHarness ?? null,
							resolvedTargetId: result.resolvedTargetId ?? null,
						}
					: {}),
				result: result.result,
				...(result.quickCheckReceipt
					? { quickCheckReceipt: result.quickCheckReceipt }
					: {}),
				...(typeof result.servedModelVerified === "boolean"
					? { servedModelVerified: result.servedModelVerified }
					: {}),
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				// Presence is the signal: these are written only when the provider
				// outlived its kill, so a resumed run and `switchyard status` can see
				// that an otherwise successful task left a process in the guest.
				...(result.cleanupFailed === true
					? {
							cleanupFailed: true,
							cleanupStage: result.cleanupStage ?? null,
						}
					: {}),
				success: result.success,
				dirtyOverlayReceiptHash: result.dirtyOverlayReceiptHash ?? null,
				timedOut: Boolean(result.timedOut),
				// The host path is transient; safeFailure carries only its opaque
				// artifactRef into the durable checkpoint.
				partialDiffPath: null,
				...(safeFailure ?? {}),
				...(opaqueArtifactRef(result.artifactRef)
					? { artifactRef: opaqueArtifactRef(result.artifactRef) }
					: {}),
				timestamp: new Date().toISOString(),
			});
			checkpoint.lastTaskId = result.taskId;
			if (result.success) checkpoint.completedTaskIds.push(result.taskId);
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
			dependencies.onCheckpointSaved?.(checkpoint);
			let haltResult =
				result.cleanupFailed === true ? providerCleanupHalt(result) : null;
			if (!haltResult)
				haltResult = commitOrResetWorkingContainer(result, {
					ownsWorkingContainer,
					workingContainerName,
					stopOnFailure: effectiveStopOnFailure,
					commitWorkingTreeFn: queueBackend.commit,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus: dependencies.onStatus,
					logPrefix: "runQueueAsync: ",
				});
			if (!haltResult) {
				haltResult = await finalizeTaskBaseAsync(
					context,
					result.taskId,
					checkpoint,
					checkpointPath,
				);
			}
			processed += 1;
			if (haltResult) {
				recordHalt(
					checkpoint,
					checkpointPath,
					results,
					haltResult,
					dependencies.onStatus,
				);
				break;
			}
			if (
				!result.success &&
				!isRouteHealthDeferredResult(result) &&
				effectiveStopOnFailure
			)
				break;
		}
		// Keep ownership until the terminal reducer projection has been observed
		// and copied into the checkpoint. Shadow persistence is additive evidence:
		// a read/write failure must never change the queue result or strand the
		// checkpoint lease.
		let checkpointShadowSettled = Promise.resolve();
		if (checkpoint.version === CHECKPOINT_VERSION) {
			const checkpointRunStore = dependencies.runStore ?? {
				readRun,
				readEvents,
			};
			checkpointShadowSettled = Promise.resolve(
				context._outcomeWriteChain ?? Promise.resolve(),
			)
				.then(() =>
					persistCheckpointOutcomeShadow(
						checkpointPath,
						checkpoint,
						checkpointRunStore,
						runId,
					).catch(() => false),
				)
				.catch(() => false)
				.finally(() => {
					try {
						releaseCheckpointOwnership(checkpointPath, checkpoint);
					} catch {
						// Checkpoint shadow/release failures are best effort and must
						// not alter the established async caller result.
					}
				});
			await checkpointShadowSettled;
		}
		queueResult = {
			results,
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			deferredTaskIds,
			policyDeferred,
			checkpointPath,
			ledgerWritesSettled: checkpointShadowSettled,
			quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
			retryState: checkpoint.retryState,
			retryTransitionId: checkpoint.retryTransitionId,
		};
		return queueResult;
	} catch (error) {
		inFlightError = error;
		throw error;
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		let cleanupError = null;
		try {
			if (ownsWorkingContainer) {
				// The detached worker must durably mark cleanup as pending before
				// destroying the workspace. This gives its run-store telemetry a
				// clear lifecycle boundary and prevents a late heartbeat from
				// describing a provider that no longer has a workspace.
				try {
					await dependencies.onCleanupStarted?.();
				} catch (error) {
					console.error(
						`runQueueAsync: cleanup-started hook failed: ${error?.message ?? "unknown error"}`,
					);
				}
				try {
					try {
						queueBackend.beforeRemove?.(workingContainerName, projectPath);
					} catch (hookError) {
						console.error(
							`runQueueAsync: before_remove hook failed: ${hookError.message}`,
						);
					}
					queueBackend.destroy(workingContainerName);
				} catch {
					// Never retain or forward the backend error: it may contain host paths
					// or provider-controlled text. The fixed event and error below carry
					// the only evidence terminal finalization needs.
					console.error("runQueueAsync: queue backend teardown failed");
					try {
						dependencies.onStatus?.({
							phase: "cleanup",
							event: "cleanup_failed",
							status: "Cleanup failed; recovery required",
						});
					} catch {
						// A progress callback cannot replace the closed cleanup failure.
					}
					cleanupError = new QueueCleanupError(queueResult, inFlightError);
				}
			}
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
		}
		if (cleanupError) {
			// biome-ignore lint/correctness/noUnsafeFinally: teardown failure must override both a nominal queue return and an in-flight failure so callers cannot finalize success over a leaked workspace; the displaced failure's diagnostic code rides along on cleanupError
			throw cleanupError;
		}
	}
}
async function executeTaskWithOrchestratorUnsafe(task, context) {
	context._activeRouteHealth = null;
	context._activeProviderExecutionSucceeded = false;
	context._activeCompletionLifecycleReceipt = null;
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return nonSwitchyardExecutorResult(task, executor, requiredCapability);
	}
	const overlayFailure = dirtyOverlayResult(task, context, requiredCapability);
	if (overlayFailure) return overlayFailure;
	const checkIgnored = context.checkIgnoredPath ?? findIgnoredDeclaredPath;
	const ignoredPath = checkIgnored(
		task.requiredPaths ?? task.files,
		context.projectPath,
	);
	if (ignoredPath) {
		return declaredPathNotSeededResult(task, requiredCapability);
	}
	const hostPower = readQueueHostPower({
		hostPowerProbe: context.hostPowerProbe,
		execFn: context.hostPowerExecFn,
		timeoutMs: context.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: context.hostPowerPolicyEnabled,
		onStatus: context.onStatus,
		taskId: task.id,
	});
	if (hostPower.state === HOST_POWER_STATES.BATTERY) {
		return policyDeferredTaskResult(task, hostPower, context.taskFileSha256);
	}
	const routeResult = context.route({
		requiredCapability,
		availableProviders: Object.keys(context.adapters ?? {}),
		exclude: context.exclude,
		only: context.only,
		platform: context.platform,
		...(context.goldenImageVerifiedProviders !== undefined
			? { goldenImageVerifiedProviders: context.goldenImageVerifiedProviders }
			: {}),
		...(context.healthDecision
			? { healthDecision: context.healthDecision }
			: {}),
		...(context.onHealthDecision
			? { onHealthDecision: context.onHealthDecision }
			: {}),
		...(context.qualificationAttempt
			? { hasInvocationDescriptor: context.hasInvocationDescriptor }
			: {}),
	});

	// Provenance (Task 1.6, M7/M8) — same treatment as executeTask: resolve the
	// six fields once, attach to routeResult, and route every dispatch record
	// through the provenance-injecting `record()`.
	const provenance = resolveRouteProvenance(
		routeResult.provider,
		requiredCapability,
	);
	Object.assign(routeResult, { requiredCapability }, provenance);
	let invocationDescriptor;
	try {
		invocationDescriptor = descriptorFromRoute(
			routeResult,
			requiredCapability,
			context.resolveDescriptor ??
				(context.qualificationAttempt
					? getConfiguredInvocationDescriptor
					: getInvocationDescriptor),
		);
	} catch {
		try {
			await context.recordDispatch({
				...provenance,
				...descriptorReceiptFields(null),
				resolvedTargetId: routeResult.resolvedTargetId ?? null,
				provider: routeResult.provider ?? "none",
				model: routeResult.model ?? null,
				taskId: task.id,
				result: "descriptor_receipt_invalid",
				reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
				requiredCapability,
			});
		} catch (projectionError) {
			reportLegacyProjectionFailure(context, projectionError);
		}
		return {
			...descriptorReceiptFields(null),
			taskId: task.id,
			success: false,
			provider: routeResult.provider ?? null,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			result: "descriptor_receipt_invalid",
			errorKind: "descriptor_receipt",
			reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
		};
	}
	Object.assign(routeResult, descriptorReceiptFields(invocationDescriptor));
	context._activeInvocationDescriptor = invocationDescriptor;
	const resolvedTargetId = routeResult.resolvedTargetId ?? null;
	let projectionFailure = null;
	const record = async (dispatch) => {
		try {
			await context.recordDispatch({
				...provenance,
				...descriptorReceiptFields(invocationDescriptor),
				resolvedTargetId,
				...dispatch,
				requiredCapability,
			});
		} catch (error) {
			projectionFailure = reportLegacyProjectionFailure(context, error);
		}
	};

	if (!routeResult.provider) {
		const noProviderReason = safeNoProviderReason(routeResult.reason);
		await record({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason: noProviderReason,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			requiredCapability,
			resolvedTargetId,
			result: "no_provider",
			reason: noProviderReason,
			errorKind: null,
		};
	}

	const routedDeadline = null;
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "task_routed",
			status: `Task ${task.id} routed to ${routeResult.provider}${routeResult.model ? `/${routeResult.model}` : ""}`,
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			...descriptorReceiptFields(invocationDescriptor),
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}
	if (context.onTaskRouted) {
		context.onTaskRouted({
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			...descriptorReceiptFields(invocationDescriptor),
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}

	const intentFailure = await writeDispatchIntentAsync(
		context,
		dispatchIntentPayload(
			task.id,
			routeResult,
			requiredCapability,
			provenance,
			invocationDescriptor,
		),
	);
	if (intentFailure) {
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "intent_receipt_failed",
			errorKind: "intent_receipt",
			...intentFailure,
		};
	}

	const captureCleanupContext = executionCleanupContext(
		context,
		task,
		invocationDescriptor.descriptor_identity,
	);
	let jobId;
	try {
		context.queueBackend?.beforeRun?.(
			context.workingContainerName,
			context.projectPath,
			{ onStatus: context.onStatus },
		);
		if (!(await prepareTaskBaseAsync(context, task, captureCleanupContext))) {
			await record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: "task_base_capture_failed",
				errorKind: "diff_capture_failed",
				reason: "immutable task base capture failed",
			});
			return taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
		}
		const healthPreparation = prepareRouteHealthTrial(
			context,
			task,
			routeResult,
			invocationDescriptor,
		);
		if (!healthPreparation.allowed)
			return healthDeferredResult(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
		const healthStart = startRouteHealthTrial(context);
		if (!healthStart.allowed)
			return healthDeferredResult(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
		jobId = await context.orchestrator.launch({
			payloadVersion: ORCHESTRATOR_PAYLOAD_VERSION,
			contractVersion: ORCHESTRATOR_PAYLOAD_VERSION,
			dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			invocationDescriptor,
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			descriptorHarness: routeResult.resolved_harness ?? null,
			resolvedTargetId,
			prompt: taskPromptForAttempt(task, context._completionRequirements),
			workingContainerName: context.workingContainerName,
			taskBase: context._activeTaskBase,
		});
	} catch (error) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "launch_failed",
			reason: error?.message ?? "orchestrator launch failed",
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "launch_failed",
			errorKind: null,
		};
	}

	const waited = await waitForJobCompletion({
		jobId,
		orchestrator: context.orchestrator,
		pollIntervalMs: context.pollIntervalMs,
		maxPolls: context.maxPolls,
		now: context.now,
		sleepFn: context.sleepFn,
		onPoll: (poll) => {
			const progress = boundedProgressProjection(poll?.status?.progress);
			if (progress) {
				context.onStatus?.({
					phase: "execution",
					event: "execution_progress",
					status: "orchestrator progress",
					taskId: task.id,
					progress,
				});
			}
			context.onPoll?.(poll);
		},
	});

	if (waited.state !== "done") {
		const progress = boundedProgressProjection(waited.status?.progress);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: `orchestrator_${waited.state}`,
			reason: waited.timedOut
				? "orchestrator timed out"
				: "orchestrator ended before done",
			...(progress ? { progress } : {}),
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: `orchestrator_${waited.state}`,
			errorKind: null,
			// Propagate the wait result's timeout verdict so the durable
			// checkpoint record (timedOut: Boolean(result.timedOut)) is
			// truthful for an orchestrator_timed_out outcome.
			timedOut: waited.timedOut,
			...(progress ? { progress } : {}),
		};
	}

	let jobResult;
	try {
		jobResult = await context.orchestrator.result(jobId);
	} catch (error) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "result_fetch_failed",
			reason: error?.message ?? "orchestrator result failed",
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "result_fetch_failed",
			errorKind: null,
		};
	}
	const progress = boundedProgressProjection(jobResult?.progress);
	if (jobResult?.cleanupFailed === true) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			reason: "provider cleanup is uncertain; recovery required",
			cleanupStage: jobResult.cleanupStage ?? null,
			...(progress ? { progress } : {}),
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			cleanupFailed: true,
			cleanupStage: jobResult.cleanupStage ?? null,
			...(progress ? { progress } : {}),
		};
	}
	if (isStructuredReviewExecution(task, jobResult)) {
		context.queueBackend?.afterRun?.(
			context.workingContainerName,
			context.projectPath,
			{ onStatus: context.onStatus },
		);
		const review = reviewTaskResult(
			task,
			jobResult,
			routeResult,
			invocationDescriptor,
			requiredCapability,
			resolvedTargetId,
		);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: review.result,
			reviewResult: review.reviewResult,
			...(progress ? { progress } : {}),
			...(review.success
				? {}
				: { errorKind: review.errorKind, reason: review.reason }),
		});
		return { ...review, ...(progress ? { progress } : {}) };
	}
	if (!jobResult?.success) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			reason: jobResult?.error ?? "orchestrator job failed",
			...(progress ? { progress } : {}),
			...reviewFailureFields(task, jobResult),
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "execution_failed",
			errorKind: jobResult?.errorKind ?? null,
			...(progress ? { progress } : {}),
			...reviewFailureFields(task, jobResult),
		};
	}
	context._activeProviderExecutionSucceeded = true;
	context._activeCompletionLifecycleReceipt = boundCompletionContinuationProof(
		jobResult.completionContinuationProof,
	);

	context.queueBackend?.afterRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	if (
		jobResult.taskBase !== undefined &&
		!taskBaseMatches(jobResult.taskBase, context._activeTaskBase)
	) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "task_base_capture_failed",
			errorKind: "diff_capture_failed",
			reason: "immutable task base capture failed",
		});
		return taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const adapter = selectAdapter(
		routeResult.resolved_harness ?? routeResult.provider,
		context.adapters,
	);
	context._activeCompletionAdapter = adapter;
	context._activeCompletionRoute = structuredClone(routeResult);
	let captureEvidence;
	try {
		captureEvidence = await captureDiffWithEvidenceAsync(
			adapter,
			context.workingContainerName,
			{
				executionBackend: bindAttemptHelperBackend(
					context.executionBackend,
					captureCleanupContext,
				),
				taskBase: context._activeTaskBase,
				signal: context.signal,
				onStatus: context.onStatus,
			},
		);
	} catch {
		captureEvidence = { status: "transport_failed", diff: null };
	}
	if (!["captured", "empty"].includes(captureEvidence.status)) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "diff_capture_failed",
			errorKind: "diff_capture_failed",
			reason: "authoritative host diff capture failed",
		});
		return {
			...taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			),
			result: "diff_capture_failed",
			reason: "authoritative host diff capture failed",
			captureStatus: captureEvidence.status,
		};
	}
	const diff =
		captureEvidence.status === "captured" ? captureEvidence.diff.trim() : "";
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "diff_captured",
			status: "Diff captured",
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			byteCount: diff.length,
		});
	}

	if (
		!diff &&
		task.requiredPaths === null &&
		(task.quickChecks?.checks?.length ?? 0) === 0
	) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			...(progress ? { progress } : {}),
			reason: safeSuccessfulRouteReason(routeResult.reason),
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: true,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "success_no_diff",
			...(progress ? { progress } : {}),
		};
	}

	const quickCheck = await quickCheckDecisionAsync(task, context, diff);
	const gateResult = !quickCheck.passed
		? { success: false, message: "check_failed" }
		: (dirtyOverlayIntegrationGate(context) ??
			context.integrationGate(diff, context.projectPath, {
				allowedPaths: task.requiredPaths,
				allowSensitiveManifests:
					task.type === "implementation" && task.allowManifests === true,
				integrationIntent: checkpointIntegrationIntent(context, task, diff),
				dirtyOverlayReceiptHash:
					context.dirtyOverlayReceipt?.receiptHash ?? null,
			}));
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const gateSuccess = Boolean(gateResult?.success) || alreadyApplied;
	const success = gateSuccess && quickCheck.passed;
	const terminalResult = !quickCheck.passed
		? "check_failed"
		: gateSuccess
			? "success"
			: "integration_failed";
	const safeGateFailure = !quickCheck.passed
		? {
				errorKind: "check_failed",
				reasonCode: "check_failed",
				reason: "Task check command failed.",
			}
		: !gateSuccess
			? integrationFailureMetadata(
					task.id,
					diff,
					gateResult?.credentialFlagged,
					gateResult,
				)
			: null;
	const gateArtifactRef = opaqueArtifactRef(gateResult?.artifactRef);

	if (context.onStatus) {
		context.onStatus({
			phase: "integration",
			event: "gate_validated",
			status: success
				? alreadyApplied
					? "already applied"
					: "ok"
				: safeGateFailure.reason,
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			outcome: success
				? alreadyApplied
					? "already_applied"
					: "passed"
				: "rejected",
			errorKind: safeGateFailure?.errorKind,
			reasonCode: safeGateFailure?.reasonCode,
			...(safeGateFailure?.diagnosticCode
				? { diagnosticCode: safeGateFailure.diagnosticCode }
				: {}),
			artifactRef: safeGateFailure?.artifactRef ?? gateArtifactRef,
		});
		if (success) {
			context.onStatus({
				phase: "integration",
				event: "gate_applied",
				status: alreadyApplied
					? "Diff already applied; integration gate confirmed terminal state"
					: "Diff applied via integration gate",
				taskId: task.id,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
			});
		}
	}

	await record({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: terminalResult,
		...(progress ? { progress } : {}),
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...(success
			? { reason: safeSuccessfulRouteReason(routeResult.reason) }
			: {}),
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	const result = {
		taskId: task.id,
		success,
		...(quickCheck.receipt ? { quickCheckReceipt: quickCheck.receipt } : {}),
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: terminalResult,
		captureStatus: captureEvidence.status,
		...(Array.isArray(gateResult?.missingPaths)
			? { missingPaths: [...gateResult.missingPaths] }
			: {}),
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...(projectionFailure
			? { legacyProjectionFailure: projectionFailure }
			: {}),
	};
	if (!success && !gateResult?.credentialFlagged) {
		result.partialDiff = diff;
	}
	return result;
}
function _resolveOnStatus(deps) {
	const diagnostics = deps.diagnostics ?? null;
	const onStatus = deps.onStatus ?? null;

	if (!onStatus && !diagnostics) return null;

	return (event) => {
		if (diagnostics && typeof diagnostics.emit === "function") {
			diagnostics.emit(event);
		}
		if (onStatus && typeof onStatus === "function") {
			onStatus(event);
		}
	};
}
function resolveQueueHealthDecision(dependencies) {
	if (dependencies.healthDecision) return dependencies.healthDecision;
	const environmentMode = process.env.SWITCHYARD_ROUTE_HEALTH_MODE;
	return createDefaultRouteHealthDecision({
		healthStateRoot:
			dependencies.healthStateRoot ??
			process.env.SWITCHYARD_ROUTE_HEALTH_STATE_ROOT,
		mode: dependencies.healthMode ?? environmentMode ?? "shadow",
		qualifiedProviders:
			dependencies.goldenImageVerifiedProviders ??
			GOLDEN_IMAGE_VERIFIED_PROVIDERS,
		goldenImageReference:
			dependencies.goldenImage ??
			process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE ??
			"golden-image-unconfigured",
	});
}
function _safeError(error) {
	if (error == null) return { message: "unknown error" };
	if (typeof error === "string") return { message: error };
	if (error instanceof Error) {
		const out = { name: error.name, message: error.message };
		if (error.code !== undefined) out.code = error.code;
		return out;
	}
	const out = {};
	if (error.name !== undefined) out.name = error.name;
	if (error.message !== undefined) out.message = error.message;
	if (error.code !== undefined) out.code = error.code;
	return out;
}
function boundedProgressProjection(value) {
	if (!value || typeof value !== "object") return null;
	return createProgressSnapshot({
		stage: value.stage,
		elapsedMs: value.elapsedMs,
		lastSubstantiveProgressAt: value.lastSubstantiveProgressAt,
		lastSubstantiveProgressAgeMs: value.lastSubstantiveProgressAgeMs,
		stdoutBytes: value.counters?.stdoutBytes,
		stderrBytes: value.counters?.stderrBytes,
		pollCount: value.counters?.polls,
		progressCount: value.counters?.progressEvents,
		outcome: value.outcome,
	});
}
function _formatCheckpointActionError(error) {
	if (
		error instanceof Error &&
		typeof error.message === "string" &&
		error.message.length > 0
	) {
		return error.message;
	}
	return "unknown error";
}
function _haltResult(result, actionLabel, error) {
	return {
		taskId: result.taskId,
		success: false,
		provider: result.provider ?? null,
		model: result.model ?? null,
		result: `halted_after_${actionLabel}_failure`,
		action: actionLabel,
		// Bounded: only a real Error's message is kept; a non-Error throw
		// value (including a plain object's `message`) never rides along.
		error: error instanceof Error ? error.message : null,
		reason: `${actionLabel} failed after task ${result.taskId}: ${_formatCheckpointActionError(error)}`,
	};
}
function commitOrResetWorkingContainer(result, deps) {
	const {
		ownsWorkingContainer,
		workingContainerName,
		stopOnFailure,
		commitWorkingTreeFn,
		resetWorkingTreeFn,
		emitStatus,
		logPrefix,
	} = deps;

	if (!ownsWorkingContainer) return null;

	if (result.success) {
		try {
			commitWorkingTreeFn(workingContainerName);
		} catch (error) {
			const message = _formatCheckpointActionError(error);
			console.error(
				`${logPrefix} could not checkpoint working container after task ${result.taskId}: ${message}`,
			);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_failed",
					status: `Checkpoint commit failed: ${message}`,
					taskId: result.taskId,
					error: _safeError(error),
				});
			}
			return _haltResult(result, "commit", error);
		}
	} else if (!stopOnFailure) {
		try {
			resetWorkingTreeFn(workingContainerName);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "state_reset",
					status: `Reset working tree after failed task ${result.taskId}`,
					taskId: result.taskId,
				});
			}
		} catch (error) {
			const message = _formatCheckpointActionError(error);
			console.error(
				`${logPrefix} could not reset working container after task ${result.taskId}: ${message}`,
			);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_failed",
					status: `Checkpoint reset failed: ${message}`,
					taskId: result.taskId,
					error: _safeError(error),
				});
			}
			return _haltResult(result, "reset", error);
		}
	}

	return null;
}
function resetBeforeQuotaRetry({
	result,
	checkpoint,
	checkpointPath,
	workingContainerName,
	resetWorkingTreeFn,
	emitStatus,
}) {
	if (emitStatus) {
		emitStatus({
			phase: "checkpoint",
			event: "retry_reset_started",
			status: `Resetting the working tree before retrying task ${result.taskId}`,
			taskId: result.taskId,
			provider: result.provider ?? null,
			model: result.model ?? null,
			resolvedTargetId: result.resolvedTargetId ?? null,
		});
	}
	try {
		resetWorkingTreeFn(workingContainerName);
	} catch (error) {
		const haltResult = _haltResult(result, "reset", error);
		persistRetryTransition(checkpoint, checkpointPath, {
			type: "retry_halted",
			taskId: result.taskId,
			attempt: 1,
			provider: result.provider,
			model: result.model,
			resolvedTargetId: result.resolvedTargetId,
			invocationDescriptor: result.invocationDescriptor,
			descriptorIdentity: result.descriptorIdentity,
			descriptorHarness: result.descriptorHarness,
			clearState: true,
		});
		if (emitStatus) {
			emitStatus({
				phase: "checkpoint",
				event: "checkpoint_failed",
				status: `Checkpoint reset failed: ${_formatCheckpointActionError(error)}`,
				taskId: result.taskId,
				error: _safeError(error),
			});
		}
		return haltResult;
	}

	persistRetryTransition(checkpoint, checkpointPath, {
		type: "reset_completed",
		taskId: result.taskId,
		attempt: 1,
		provider: result.provider,
		model: result.model,
		resolvedTargetId: result.resolvedTargetId,
		invocationDescriptor: result.invocationDescriptor,
		descriptorIdentity: result.descriptorIdentity,
		descriptorHarness: result.descriptorHarness,
	});
	if (emitStatus) {
		emitStatus({
			phase: "checkpoint",
			event: "state_reset",
			status: `Reset working tree before retrying task ${result.taskId}`,
			taskId: result.taskId,
		});
	}
	return null;
}
function recordHalt(
	checkpoint,
	checkpointPath,
	results,
	haltResult,
	emitStatus,
) {
	const safeFailure = failureMetadataFor(haltResult);
	results.push(haltResult);
	checkpoint.results.push({
		taskId: haltResult.taskId,
		provider: haltResult.provider,
		model: haltResult.model,
		result: haltResult.result,
		action: haltResult.action,
		success: haltResult.success,
		timedOut: false,
		partialDiffPath: null,
		...(safeFailure ?? {}),
		timestamp: new Date().toISOString(),
	});
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
	if (emitStatus) {
		emitStatus({
			phase: "lifecycle",
			event: "queue_halted",
			status: `Queue halted after task ${haltResult.taskId}: ${safeFailure?.reason ?? "The queue halted after a checkpoint action failure."}`,
			taskId: haltResult.taskId,
			error: safeFailure ? { message: safeFailure.reason } : undefined,
			errorKind: safeFailure?.errorKind,
			reasonCode: safeFailure?.reasonCode,
		});
	}
}
function _installOwnedContainerSignalCleanup(containerName, wipeFn) {
	const handler = (signal) => {
		try {
			wipeFn(containerName);
		} catch {
			/* best effort — recover is the backstop */
		}
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
		// Re-raise with default disposition so the exit status reflects the signal.
		process.kill(process.pid, signal);
	};
	process.on("SIGINT", handler);
	process.on("SIGTERM", handler);
	return () => {
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
	};
}
function throwOnEmptyParse(tasksFilePath, checkpointPath, emitStatus) {
	const message =
		`runQueue: no tasks parsed from ${tasksFilePath} — 0 headings matching ` +
		`"### Task <id>: <title>" were found. Expected format:\n` +
		`### Task <id>: <title>\n- **Status:** pending\n- **Description:** ...`;
	const failureCheckpoint = createEmptyCheckpoint(tasksFilePath);
	failureCheckpoint.parseError = {
		message: "no tasks parsed",
		tasksFilePath,
		detectedHeadings: 0,
		expectedFormat: "### Task <id>: <title>",
	};
	failureCheckpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, failureCheckpoint);
	if (emitStatus) {
		emitStatus({
			phase: "bootstrap",
			event: "parse_failed",
			status: message,
			error: { tasksFilePath, detectedHeadings: 0 },
		});
	}
	throw new Error(message);
}
export const DEFAULT_ADAPTERS = {
	claude: {
		execute: executeClaude,
		executeAsync: executeClaudeAsync,
		captureDiff: captureClaudeDiff,
		captureDiffAsync: captureClaudeDiffAsync,
		captureDiffDetailed: captureClaudeDiffDetailed,
		captureDiffDetailedAsync: captureClaudeDiffDetailedAsync,
	},
	codex: {
		execute: executeCodex,
		executeAsync: executeCodexAsync,
		captureDiff: captureCodexDiff,
		captureDiffAsync: captureCodexDiffAsync,
		captureDiffDetailed: captureCodexDiffDetailed,
		captureDiffDetailedAsync: captureCodexDiffDetailedAsync,
	},
	agy: {
		execute: executeAgy,
		executeAsync: executeAgyAsync,
		captureDiff: captureAgyDiff,
		captureDiffAsync: captureAgyDiffAsync,
		captureDiffDetailed: captureAgyDiffDetailed,
		captureDiffDetailedAsync: captureAgyDiffDetailedAsync,
	},
	cursor: {
		execute: executeCursor,
		executeAsync: executeCursorAsync,
		captureDiff: captureCursorDiff,
		captureDiffAsync: captureCursorDiffAsync,
		captureDiffDetailed: captureCursorDiffDetailed,
		captureDiffDetailedAsync: captureCursorDiffDetailedAsync,
	},
	copilot: {
		execute: executeCopilot,
		executeAsync: executeCopilotAsync,
		captureDiff: captureCopilotDiff,
		captureDiffAsync: captureCopilotDiffAsync,
		captureDiffDetailed: captureCopilotDiffDetailed,
		captureDiffDetailedAsync: captureCopilotDiffDetailedAsync,
	},
	opencode: {
		execute: executeOpencode,
		executeAsync: executeOpencodeAsync,
		captureDiff: captureOpencodeDiff,
		captureDiffAsync: captureOpencodeDiffAsync,
		captureDiffDetailed: captureOpencodeDiffDetailed,
		captureDiffDetailedAsync: captureOpencodeDiffDetailedAsync,
	},
	vibe: {
		execute: executeVibe,
		executeAsync: executeVibeAsync,
		captureDiff: captureVibeDiff,
		captureDiffAsync: captureVibeDiffAsync,
		captureDiffDetailed: captureVibeDiffDetailed,
		captureDiffDetailedAsync: captureVibeDiffDetailedAsync,
	},
};
function launchReviewResult(execution) {
	const derived = reviewResultFromExecution(execution);
	return derived.reason === "missing" ? null : derived;
}
export function createBrokerAdapterLauncher({
	adapter,
	executionBackend,
	workingContainerName,
	prompt,
	timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
	silenceTimeoutMs,
	onTranscript = null,
	cleanupContext = null,
	deriveReviewResult = false,
	onProcessCompleted = null,
}) {
	if (!adapter || typeof adapter.executeAsync !== "function") {
		throw new TypeError("broker adapter requires executeAsync");
	}
	return async function launch({
		request,
		route,
		invocationDescriptor,
		launcherIdentity,
		signal,
		onAdapterStatus,
		onPoll,
		onProgress,
	}) {
		if (
			!launcherIdentity ||
			launcherIdentity.provider !== route.provider ||
			launcherIdentity.resolvedTarget !== route.resolvedTarget ||
			launcherIdentity.harness !== route.harness ||
			launcherIdentity.model !== route.model ||
			launcherIdentity.effort !== route.effort ||
			launcherIdentity.descriptorIdentity !==
				invocationDescriptor.descriptor_identity ||
			launcherIdentity.reservationId !== route.reservation?.id
		) {
			throw new Error("broker launcher identity drift at spawn");
		}
		const requestCleanupContext = mergeAttemptCleanupContext(cleanupContext, {
			taskId: String(request.taskId),
			attemptId: cleanupContext?.attemptId ?? request.attemptId ?? "attempt-1",
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			operation: "provider",
		});
		const execution = await adapter.executeAsync(
			typeof prompt === "string" && prompt.length > 0 ? prompt : request.taskId,
			workingContainerName,
			{
				model: route.model,
				timeoutMs,
				silenceTimeoutMs:
					silenceTimeoutMs ??
					(route.harness === "agy"
						? AGY_SILENCE_TIMEOUT_MS
						: DEFAULT_SILENCE_TIMEOUT_MS),
				executionBackend: bindAttemptExecutionBackend(
					executionBackend,
					requestCleanupContext,
				),
				cleanupContext: requestCleanupContext,
				signal,
				onStatus: onAdapterStatus,
				onPoll,
				onProgress,
				onProcessCompleted,
				invocationDescriptor,
				descriptorIdentity: invocationDescriptor.descriptor_identity,
				descriptorHarness: route.harness,
				resolvedTargetId: route.resolvedTarget,
			},
		);
		// The bounded return shape below stays closed. The raw transcript is
		// handed back in-process instead of crossing it, so an evidence-free
		// gate rejection still has the provider's own account behind it.
		onTranscript?.(execution?.output);
		return {
			success: execution?.success === true,
			cancelled: signal?.aborted === true,
			reason: execution?.error ?? null,
			actualConsumption: execution?.actualConsumption,
			timedOut: execution?.timedOut === true,
			silenceTimedOut: execution?.silenceTimedOut === true,
			outcome: execution?.outcome ?? null,
			// The verdict, not the transcript it was parsed out of. Omitting it here
			// left every review dispatched through the broker with no result to act
			// on, so each one terminated as an undiagnosed `review_unavailable`.
			reviewResult: deriveReviewResult ? launchReviewResult(execution) : null,
			cleanupFailed: execution?.cleanupFailed === true,
			// Which kill step failed, bounded to the backend-owned vocabulary.
			// Omitting it here left `execution.cleanupStage` permanently null on
			// the async path, so a cleanup failure was recorded without naming
			// the stage that failed - the fact that makes it actionable.
			cleanupStage: CLEANUP_STAGES.has(execution?.cleanupStage)
				? execution.cleanupStage
				: null,
			failureKind:
				execution?.failureKind === "transient" ||
				execution?.failureKind === "provider"
					? execution.failureKind
					: null,
			errorKind: BOUNDED_ERROR_KINDS.has(execution?.errorKind)
				? execution.errorKind
				: execution?.errorKind === "silence_timeout"
					? "silence_timeout"
					: null,
			diagnosticCode: execution?.diagnosticCode ?? null,
			exitCode: execution?.exitCode ?? null,
			signal: execution?.signal ?? null,
			failurePhase: execution?.failurePhase ?? null,
			diagnosticOrigin: execution?.diagnosticOrigin ?? null,
			diagnosticEvidenceAvailable:
				execution?.diagnosticEvidenceAvailable === true,
			diagnosticRef:
				typeof execution?.diagnosticRef === "string" &&
				/^diagnostic:[a-f0-9]{32}$/u.test(execution.diagnosticRef)
					? execution.diagnosticRef
					: null,
			diagnosticEvidence: execution?.diagnosticEvidence ?? null,
			// A bounded fact, not the guest-supplied model name: whether the
			// adapter could affirmatively read back what the provider served.
			servedModelVerified:
				execution?.servedModel === undefined
					? null
					: Boolean(execution.servedModel),
			progress: execution?.progress ?? null,
			providerLifecycle: execution?.providerLifecycle ?? null,
		};
	};
}
function createDispatchBroker(context, dependencies = {}) {
	if (dependencies.broker) return dependencies.broker;
	const adapters = context.adapters ?? DEFAULT_ADAPTERS;
	const contextOnly = Array.isArray(context.only) ? context.only : [];
	const snapshotSources = dependencies.snapshotSources ?? { "gradus-v2": null };
	if (
		typeof context.projectPath !== "string" ||
		context.projectPath.trim() === ""
	) {
		throw new Error(
			"broker runner requires projectPath for its reservation ledger",
		);
	}
	const projectLedgerRoot = join(
		context.projectPath,
		".logs",
		"switchyard",
		"broker",
	);
	const usesProductionRouter = context.route === route;
	const brokerResolveTargetIdentity =
		dependencies.resolveTargetIdentity ?? resolveTargetIdentity;
	return createBroker({
		adapters,
		route: ({
			runId,
			requiredCapability,
			availableProviders,
			snapshotSource,
			snapshotRead,
			exclude = [],
			platform,
			goldenImageVerifiedProviders,
		}) =>
			context.route({
				runId,
				requiredCapability,
				availableProviders,
				snapshotSource,
				snapshotRead,
				exclude: [
					...(Array.isArray(context.exclude) ? context.exclude : []),
					...exclude,
				],
				only: contextOnly,
				platform,
				...(goldenImageVerifiedProviders !== undefined
					? { goldenImageVerifiedProviders }
					: {}),
				...(context.qualificationAttempt
					? { hasInvocationDescriptor: context.hasInvocationDescriptor }
					: {}),
				...(context.healthDecision
					? { healthDecision: context.healthDecision }
					: {}),
				...(context.onHealthDecision
					? { onHealthDecision: context.onHealthDecision }
					: {}),
			}),
		resolveTargetIdentity: brokerResolveTargetIdentity,
		getInvocationDescriptor:
			context.resolveDescriptor ??
			(context.qualificationAttempt
				? getConfiguredInvocationDescriptor
				: getInvocationDescriptor),
		reservations: dependencies.brokerReservations,
		reservationOptions: dependencies.brokerReservationOptions ?? {
			root: projectLedgerRoot,
			// Null unless shared account accounting is switched on, in which case
			// capacity for a provider is decided against the account root shared by
			// every project on this host instead of this project's ledger alone.
			// The account resolver reads identity through the same seam the broker
			// does, so a caller that injected one never gets a second answer from
			// the host roster behind its back.
			accountRootFor: createAccountRootResolver({
				resolveTargetIdentity: brokerResolveTargetIdentity,
			}),
		},
		snapshotSources,
		readSnapshot: usesProductionRouter
			? (dependencies.readSnapshot ??
				(({ source, nowMs }) => {
					if (!Object.hasOwn(snapshotSources, source)) {
						const error = new Error("snapshot_source_unknown");
						error.code = "snapshot_source_unknown";
						throw error;
					}
					const sourcePath = snapshotSources[source];
					if (sourcePath !== null && typeof sourcePath !== "string") {
						throw new TypeError(
							"configured snapshot source must be a path or null",
						);
					}
					return readSnapshotAtRoute(nowMs, sourcePath ?? undefined);
				}))
			: dependencies.readSnapshot,
		refreshSnapshot: dependencies.refreshSnapshot,
		ownerId: context.runId ? `runner:${context.runId}` : undefined,
		platform: context.platform,
		...(context.goldenImageVerifiedProviders !== undefined
			? {
					goldenImageVerifiedProviders: context.goldenImageVerifiedProviders,
				}
			: {}),
		executor: async ({
			request,
			route: selectedRoute,
			invocationDescriptor,
			launcherIdentity,
			signal,
			onStatus,
			onAdapterStatus,
			onPoll,
			onProgress,
			onTaskHeartbeat,
		}) => {
			const adapter = selectAdapter(selectedRoute.harness, adapters);
			if (!adapter) {
				throw new Error(
					`broker route harness '${selectedRoute.harness}' has no runner adapter`,
				);
			}
			const launchResult = await createBrokerAdapterLauncher({
				adapter,
				executionBackend: context.executionBackend,
				workingContainerName: context.workingContainerName,
				prompt: context._activeTaskPrompt,
				timeoutMs: context._activeTaskTimeoutMs,
				deriveReviewResult: context._activeTaskIsReview === true,
				onTranscript: (output) => {
					context._activeTaskTranscript = boundedGateEvidence(output);
				},
				cleanupContext: executionCleanupContext(
					context,
					{ id: request.taskId },
					invocationDescriptor.descriptor_identity,
					request.attemptId ?? null,
				),
				onProcessCompleted:
					typeof context.recordOutcomeEvent === "function"
						? async (processResult) => {
								const processOutcome = createProviderProcessCompletedOutcome({
									request,
									route: selectedRoute,
									processResult,
									writerEpoch: context.outcomeWriterEpoch ?? null,
									operationId: `operation-${request.taskId}-process`,
									attempt: context._activeOutcomeAttempt ?? 1,
								});
								await context.recordOutcomeEvent(processOutcome);
								context._activeProcessOutcomeId = processOutcome.outcomeId;
							}
						: null,
			})({
				request,
				route: selectedRoute,
				invocationDescriptor,
				launcherIdentity,
				signal,
				onAdapterStatus,
				onProgress,
				onPoll: (poll) => {
					onStatus?.(poll);
					onPoll?.(poll);
					const heartbeat = {
						taskId: request.taskId,
						provider: selectedRoute.provider,
						model: invocationDescriptor.selector ?? selectedRoute.model,
						deadline: context._activeTaskDeadline ?? null,
						elapsedMs: Number.isFinite(poll?.elapsedMs)
							? Math.max(0, poll.elapsedMs)
							: 0,
						processPhase: "provider_transport_running",
						resolvedTargetId: selectedRoute.resolvedTarget,
						descriptorIdentity: invocationDescriptor.descriptor_identity,
						descriptorHarness: selectedRoute.harness,
					};
					onTaskHeartbeat?.(heartbeat);
				},
			});
			const inProcessEvidence = launchResult?.diagnosticEvidence;
			const hasInProcessEvidence =
				inProcessEvidence && typeof inProcessEvidence === "object";
			let diagnosticRef = null;
			if (
				launchResult?.success !== true &&
				hasInProcessEvidence &&
				typeof context.persistDiagnosticArtifact === "function"
			) {
				try {
					const persisted =
						await context.persistDiagnosticArtifact(inProcessEvidence);
					if (
						typeof persisted === "string" &&
						/^diagnostic:[a-f0-9]{32}$/u.test(persisted)
					) {
						diagnosticRef = persisted;
					}
				} catch {
					diagnosticRef = null;
				}
			}
			// Raw streams are producer-local and must not reach the broker result,
			// checkpoint, event, or status projections.
			delete launchResult.diagnosticEvidence;
			if (hasInProcessEvidence) {
				launchResult.diagnosticRef = diagnosticRef;
				launchResult.diagnosticEvidenceAvailable = diagnosticRef !== null;
			} else {
				launchResult.diagnosticRef = null;
				launchResult.diagnosticEvidenceAvailable = false;
			}
			return launchResult;
		},
	});
}
function brokerRequestForTask(task, context, requiredCapability) {
	return {
		schemaVersion: 1,
		capability: requiredCapability,
		dataClass: "repository",
		estimatedConsumption:
			typeof task.estimatedConsumption === "number" &&
			Number.isFinite(task.estimatedConsumption) &&
			task.estimatedConsumption > 0
				? task.estimatedConsumption
				: 1,
		runId: context.runId ?? `runner-${process.pid}`,
		taskId: task.id,
		snapshotSource: context.snapshotSource ?? "gradus-v2",
		availableAdapters: Object.keys(context.adapters ?? DEFAULT_ADAPTERS),
	};
}
function normalizeBrokerRoute(result) {
	return {
		provider: result.provider,
		model: result.model,
		resolvedTargetId: result.resolvedTarget,
		resolved_harness: result.harness,
		requiredCapability: result.capability,
		reason: result.reason,
		snapshotStatus: result.snapshotIdentity.status,
		snapshotMtime: result.snapshotIdentity.mtime,
		snapshotAgeMsAtRoute: result.snapshotIdentity.ageMs,
	};
}
export async function prepareOutcomeWriter(runId, dependencies) {
	if (
		typeof runId !== "string" ||
		runId.length === 0 ||
		dependencies.enableTypedOutcomes === false
	)
		return null;
	let current;
	try {
		current = await readRun(runId);
	} catch {
		return null;
	}
	if (!Number.isSafeInteger(current.workerPid) || current.workerPid < 1)
		return null;
	if (current.workerPid !== process.pid) {
		const error = new Error(
			"typed outcome writer lease belongs to another process",
		);
		error.code = "OUTCOME_WRITER_LEASE_STALE";
		throw error;
	}
	const activated = await activateOutcomeWriter(runId, {
		pid: current.workerPid,
		startToken: current.workerStartToken,
		nonce: current.workerNonce,
		writerEpoch:
			dependencies.outcomeWriterEpoch ??
			current.outcomeWriterEpoch ??
			`epoch-${runId}-${current.revision + 1}`,
		minimumReaderVersion: dependencies.minimumOutcomeReaderVersion ?? 1,
	});
	const owner = {
		pid: activated.workerPid,
		startToken: activated.workerStartToken,
		nonce: activated.workerNonce,
	};
	while (
		(await recoverExecutionOutcome(runId, {
			writerEpoch: activated.outcomeWriterEpoch,
			owner,
			minimumReaderVersion: activated.minimumOutcomeReaderVersion ?? 1,
		})) !== null
	) {
		// Recover every durable process fact whose execution fact was interrupted.
	}
	return {
		writerEpoch: activated.outcomeWriterEpoch,
		owner,
		record: (outcome) =>
			appendOutcomeEvent(runId, outcome, {
				writerEpoch: activated.outcomeWriterEpoch,
				owner,
				minimumReaderVersion: activated.minimumOutcomeReaderVersion ?? 1,
			}),
	};
}
export async function emitStageOutcome(context, options = {}) {
	if (
		!context ||
		typeof context.recordOutcomeEvent !== "function" ||
		typeof context.outcomeWriterEpoch !== "string"
	)
		return null;
	try {
		const outcome = createStageOutcome({
			runId: context.runId,
			writerEpoch: context.outcomeWriterEpoch,
			causedBy: context._activeProcessOutcomeId ?? null,
			resumesOutcomeId: context._activeProcessOutcomeId ?? null,
			...options,
		});
		await context.recordOutcomeEvent(outcome);
		return outcome;
	} catch {
		// Typed outcomes are shadow writes in this phase. A failed typed write
		// cannot erase the already-authoritative legacy event or result.
		context.onStatus?.({
			phase: options.stage ?? "run",
			event: "outcome_write_unavailable",
			status: "Typed stage evidence unavailable",
		});
		return null;
	}
}
function mergeBrokerRouteProvenance(routeResult, capability, provenance) {
	Object.assign(routeResult, { requiredCapability: capability });
	for (const [key, value] of Object.entries(provenance)) {
		if (key === "resolved_target" && routeResult.resolvedTargetId != null) {
			routeResult[key] = routeResult.resolvedTargetId;
			continue;
		}
		if (key === "resolved_harness" && routeResult.resolved_harness != null) {
			continue;
		}
		if (key === "resolved_selector" && routeResult.model != null) {
			routeResult[key] = routeResult.model;
			continue;
		}
		if (value != null || routeResult[key] == null) routeResult[key] = value;
	}
}
const BROKER_PEER_RETRY_ERROR_KINDS = new Set();
function brokerFailureKind(result) {
	if (result?.outcome !== "failure" || result?.timedOut === true) {
		return null;
	}
	return BROKER_PEER_RETRY_ERROR_KINDS.has(result.errorKind)
		? "transient"
		: null;
}
function runBackendGitCommand(executionBackend, workspaceId, script) {
	if (typeof executionBackend.execGuest === "function") {
		executionBackend.execGuest(workspaceId, "/bin/bash", ["-lc", script], {
			cwd: "/project",
		});
		return { status: 0 };
	}
	const execution = executionBackend.execArgv(workspaceId, {
		cwd: "/project",
		argv: ["/bin/bash", "-lc", `cd /project && ${script}`],
	});
	const result = spawnSync(execution.command, execution.args, {
		stdio: "pipe",
	});
	if (result.status !== 0) {
		throw new Error(
			`backend workspace command failed (${result.status ?? result.signal ?? "unknown"})`,
		);
	}
	return result;
}
function formatQueuePreflightFailure(result) {
	const details = (result.rejections ?? []).map((rejection) => {
		const capability = rejection.capability ?? "unknown";
		// A selector-level rejection is not about any one capability tier, so the
		// excluded-provider list would be empty and misleading. Name the selector
		// instead: it is the only thing the operator can act on.
		if (rejection.selector) {
			return `${capability}: ${rejection.reason} (selector: ${rejection.selector}; use an exact target id)`;
		}
		const excluded = rejection.excludedProviders?.length
			? rejection.excludedProviders.join(", ")
			: "none";
		const providerReasons = Object.entries(rejection.excludedReasons ?? {})
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([provider, reason]) => `${provider}: ${reason}`);
		const reasonDetails = providerReasons.length
			? `; reasons: ${providerReasons.join(", ")}`
			: "";
		return `${capability}: ${rejection.reason} (excluded: ${excluded}${reasonDetails})`;
	});
	return `macOS queue provider preflight failed: ${details.join("; ") || result.reason}`;
}
export function sanitizeQueuePreflightDetail(result) {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
	const isPlainObject = (value) =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	const boundedText = (value, limit = 160) =>
		typeof value === "string"
			? value.replace(/[\p{Cc}]/gu, " ").slice(0, limit)
			: null;
	return {
		reason: boundedText(result?.reason) ?? "unknown",
		rejections: (Array.isArray(result.rejections) ? result.rejections : [])
			.filter(isPlainObject)
			.slice(0, 8)
			.map((rejection) => ({
				capability: boundedText(rejection.capability, 80),
				reason: boundedText(rejection.reason, 160) ?? "unknown",
				...(rejection.selector
					? { selector: boundedText(rejection.selector, 160) }
					: {}),
				...(Array.isArray(rejection.excludedProviders) &&
				rejection.excludedProviders.length
					? {
							excludedProviders: rejection.excludedProviders
								.slice(0, 16)
								.map((provider) => boundedText(provider, 80))
								.filter(Boolean),
						}
					: {}),
				...(isPlainObject(rejection.excludedReasons)
					? {
							excludedReasons: Object.entries(rejection.excludedReasons)
								.slice(0, 16)
								.reduce((reasons, [provider, reason]) => {
									const safeProvider = boundedText(provider, 80);
									const safeReason = boundedText(reason, 160);
									if (safeProvider && safeReason)
										reasons[safeProvider] = safeReason;
									return reasons;
								}, {}),
						}
					: {}),
			})),
	};
}
function queuePreflightDetail(result) {
	return sanitizeQueuePreflightDetail(result);
}
export class QueuePreflightError extends Error {
	constructor(message, detail = null) {
		super(message);
		this.name = "QueuePreflightError";
		this.preflightDetail = sanitizeQueuePreflightDetail(detail);
	}
}
function createDefaultQueuePreflight({ selectedPlatform, dependencies }) {
	if (selectedPlatform !== "macos") return () => ({ ok: true, eligible: true });

	const adapters = dependencies.adapters ?? DEFAULT_ADAPTERS;
	return (input = {}) => {
		const result = preflightMacosQueue({
			...input,
			platform: selectedPlatform,
			availableProviders: Object.keys(adapters),
			...(Object.hasOwn(dependencies, "goldenImageVerifiedProviders")
				? {
						goldenImageVerifiedProviders:
							dependencies.goldenImageVerifiedProviders,
					}
				: {}),
			...(dependencies.preflightReadSnapshot
				? { readSnapshot: dependencies.preflightReadSnapshot }
				: {}),
			...(dependencies.healthDecision
				? { healthDecision: dependencies.healthDecision }
				: {}),
			...(dependencies.onHealthDecision
				? { onHealthDecision: dependencies.onHealthDecision }
				: {}),
			...(dependencies.qualificationAttempt === true
				? { hasInvocationDescriptor: getConfiguredInvocationDescriptor }
				: {}),
		});
		if (!result.ok)
			throw new QueuePreflightError(
				formatQueuePreflightFailure(result),
				queuePreflightDetail(result),
			);
		return result;
	};
}
function createQueueBootstrapStatusEmitter(onStatus) {
	if (typeof onStatus !== "function") return undefined;
	return (event) => {
		if (event?.type === "aqua-wait") {
			onStatus({
				phase: "bootstrap",
				event: "aqua_wait",
				status: "Waiting for Aqua session to become ready",
				...(event.uuid !== undefined ? { uuid: event.uuid } : {}),
				...(event.domain !== undefined ? { domain: event.domain } : {}),
				...(event.elapsedMs !== undefined
					? { elapsedMs: event.elapsedMs }
					: {}),
			});
			return;
		}
		if (event?.type === "aqua-ready") {
			onStatus({
				phase: "bootstrap",
				event: "aqua_ready",
				status: "Aqua session ready",
				...(event.uuid !== undefined ? { uuid: event.uuid } : {}),
				...(event.domain !== undefined ? { domain: event.domain } : {}),
			});
			return;
		}
		if (event?.type === "host-readiness") {
			onStatus({
				phase: "bootstrap",
				event: event.event,
				status: event.status,
				...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
				...(event.elapsedMs !== undefined
					? { elapsedMs: event.elapsedMs }
					: {}),
				...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
				...(event.inventoryCount !== undefined
					? { inventoryCount: event.inventoryCount }
					: {}),
			});
			return;
		}
		// Preserve any future backend lifecycle events rather than dropping
		// visibility when the backend grows its status vocabulary.
		onStatus(event);
	};
}
function queueOwnershipContext({
	projectPath,
	runId,
	taskId = "queue-bootstrap",
	attemptId = "bootstrap",
	purpose = "dispatch",
	processStartIdentity = null,
}) {
	const runStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
	if (!runStoreRoot) {
		throw new Error(
			"macos queue requires SWITCHYARD_RUN_STORE_ROOT for VM ownership metadata",
		);
	}
	if (typeof runId !== "string" || !runId) {
		throw new Error("macos queue requires a runId for VM ownership metadata");
	}
	return {
		resourceRoot: join(resolve(runStoreRoot), "runs", runId, "resources"),
		runId,
		taskId,
		attemptId,
		projectRoot: resolve(projectPath),
		creatorPid: process.pid,
		processStartIdentity,
		purpose,
	};
}
export function createQueueBackend({
	platform = "macos",
	dependencies = {},
	projectPath,
	runId = null,
	runOptions = null,
} = {}) {
	const taskBaseRunId =
		typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)
			? runId
			: `queue-${createHash("sha256")
					.update(String(projectPath ?? "project"))
					.digest("hex")
					.slice(0, 24)}`;
	const selectedPlatform = normalizeQueuePlatform(platform);
	const defaultQueuePreflight = createDefaultQueuePreflight({
		selectedPlatform,
		dependencies: {
			...dependencies,
			qualificationAttempt: runOptions?.qualificationAttempt === true,
		},
	});
	const configuredQueuePreflight =
		dependencies.queuePreflight ?? defaultQueuePreflight;
	const factory = dependencies.backendFactory;
	const supplied = factory?.({
		platform: selectedPlatform,
		projectPath,
		runId,
		runOptions,
	});
	if (supplied && typeof supplied === "object") {
		if (
			supplied.platform &&
			normalizeQueuePlatform(supplied.platform) !== selectedPlatform
		) {
			throw new Error("backendFactory returned a different queue platform");
		}
		if (
			supplied.create &&
			supplied.destroy &&
			supplied.seed &&
			supplied.commit &&
			supplied.reset
		) {
			const suppliedReadiness =
				supplied.readiness ?? supplied.executionBackend?.probeHostReadiness;
			return {
				platform: selectedPlatform,
				...supplied,
				taskBaseRunId,
				create: (path, options = {}) =>
					supplied.create(path, {
						...options,
						onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
					}),
				ensureAgentContainer: supplied.ensureAgentContainer ?? (() => {}),
				readiness: (options = {}) => {
					if (typeof suppliedReadiness !== "function") {
						throw new Error(
							"backendFactory must provide readiness() for macOS queue admission",
						);
					}
					return suppliedReadiness.call(
						supplied.readiness ? supplied : supplied.executionBackend,
						{
							...options,
							onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
						},
					);
				},
				provision: supplied.provision ?? (() => null),
				preflight: supplied.preflight ?? configuredQueuePreflight,
				acquireSlot: supplied.acquireSlot ?? (() => null),
				releaseSlot: supplied.releaseSlot ?? (() => {}),
				captureTaskBase:
					supplied.captureTaskBase ??
					((workspaceId, { taskId, ...options } = {}) =>
						captureTaskStartTree(supplied.executionBackend, workspaceId, {
							runId: taskBaseRunId,
							taskId,
							...options,
						})),
				captureTaskBaseAsync:
					supplied.captureTaskBaseAsync ??
					(async (workspaceId, options = {}) =>
						(
							supplied.captureTaskBase ??
							((id, input) =>
								captureTaskStartTreeAsync(supplied.executionBackend, id, {
									runId: taskBaseRunId,
									...input,
								}))
						)(workspaceId, options)),
				validateTaskBase:
					supplied.validateTaskBase ??
					((workspaceId, base, options = {}) =>
						validateTaskStartTree(
							supplied.executionBackend,
							workspaceId,
							base,
							options,
						)),
				validateTaskBaseAsync:
					supplied.validateTaskBaseAsync ??
					(async (workspaceId, base, options = {}) =>
						(
							supplied.validateTaskBase ??
							((id, value, input) =>
								validateTaskStartTreeAsync(
									supplied.executionBackend,
									id,
									value,
									input,
								))
						)(workspaceId, base, options)),
				releaseTaskBase:
					supplied.releaseTaskBase ??
					((workspaceId, base, options = {}) =>
						releaseTaskStartTree(
							supplied.executionBackend,
							workspaceId,
							base,
							options,
						)),
				releaseTaskBaseAsync:
					supplied.releaseTaskBaseAsync ??
					(async (workspaceId, base, options = {}) =>
						(
							supplied.releaseTaskBase ??
							((id, value, input) =>
								releaseTaskStartTreeAsync(
									supplied.executionBackend,
									id,
									value,
									input,
								))
						)(workspaceId, base, options)),
			};
		}
	}

	const executionBackend =
		supplied?.executionBackend ??
		supplied?.backend ??
		dependencies.executionBackend ??
		createExecutionBackend({
			...hostBackendDefaults(dependencies),
			// Durable record of which golden-image snapshots each clone creates,
			// so a later process can reclaim them after this one dies.
			snapshotSidecarRoot: getVmAdmissionRoot(),
			runId: dependencies.runId ?? process.env.SWITCHYARD_RUN_ID ?? null,
			...(dependencies.hostProcessIdentityProbe
				? {
						hostProcessIdentityProbe: dependencies.hostProcessIdentityProbe,
					}
				: {}),
		});

	const { goldenImage, aquaUid, providerUser } =
		hostBackendDefaults(dependencies);
	return {
		platform: selectedPlatform,
		taskBaseRunId,
		executionBackend,
		ensureAgentContainer: () => {},
		readiness: (options = {}) => {
			if (typeof executionBackend.probeHostReadiness !== "function") {
				throw new Error(
					"Parallels execution backend does not provide host readiness",
				);
			}
			return executionBackend.probeHostReadiness({
				...options,
				onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
			});
		},
		create: (_path, options = {}) => {
			if (!goldenImage) {
				throw new Error(
					"macos queue requires SWITCHYARD_PARALLELS_GOLDEN_IMAGE",
				);
			}
			if (!/^\d+$/u.test(String(aquaUid ?? "")) || Number(aquaUid) <= 0) {
				throw new Error(
					"macos queue requires SWITCHYARD_PARALLELS_AQUA_UID to be a positive numeric uid",
				);
			}
			return executionBackend.create(goldenImage, {
				runId: options.runId ?? runId,
				aquaUid,
				providerUser,
				onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
				// Linked-clone measurement/admission is owned by its later task.
				linked: !!dependencies.linkedCloneMeasurement,
				...(dependencies.linkedCloneMeasurement
					? { linkedCloneMeasurement: dependencies.linkedCloneMeasurement }
					: {}),
				ownershipContext: queueOwnershipContext({
					projectPath: _path,
					runId: options.runId ?? runId,
					taskId: options.taskId ?? "queue-bootstrap",
					attemptId: options.attemptId ?? "bootstrap",
					processStartIdentity: dependencies.processStartIdentity ?? null,
				}),
			});
		},
		// Provider auth is baked into the golden image and survives cloning
		// (verified for codex — see TASKS.md's clone-survival test), so there is
		// no runtime credential-provisioning step; each adapter's own auth
		// check decides at exec time.
		provision: dependencies.provisionCredentials ?? (() => null),
		seed: (workspaceId, path, options = {}) =>
			seedProjectWithBackend(executionBackend, workspaceId, path, options),
		afterCreate: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"after_create",
				options,
			),
		beforeRun: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"before_run",
				options,
			),
		afterRun: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"after_run",
				options,
			),
		beforeRemove: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"before_remove",
				options,
			),
		commit: (workspaceId) =>
			runBackendGitCommand(
				executionBackend,
				workspaceId,
				"git add -A && (git diff --cached --quiet || git commit -q -m switchyard-task)",
			),
		reset: (workspaceId) =>
			runBackendGitCommand(
				executionBackend,
				workspaceId,
				"git reset --hard && git clean -fd",
			),
		captureTaskBase: (workspaceId, { taskId, ...options } = {}) =>
			captureTaskStartTree(executionBackend, workspaceId, {
				runId: taskBaseRunId,
				taskId,
				...options,
			}),
		captureTaskBaseAsync: (workspaceId, { taskId, ...options } = {}) =>
			captureTaskStartTreeAsync(executionBackend, workspaceId, {
				runId: taskBaseRunId,
				taskId,
				...options,
			}),
		validateTaskBase: (workspaceId, base, options = {}) =>
			validateTaskStartTree(executionBackend, workspaceId, base, options),
		validateTaskBaseAsync: (workspaceId, base, options = {}) =>
			validateTaskStartTreeAsync(executionBackend, workspaceId, base, options),
		releaseTaskBase: (workspaceId, base, options = {}) =>
			releaseTaskStartTree(executionBackend, workspaceId, base, options),
		releaseTaskBaseAsync: (workspaceId, base, options = {}) =>
			releaseTaskStartTreeAsync(executionBackend, workspaceId, base, options),
		destroy: (workspaceId) => executionBackend.destroy(workspaceId),
		preflight: configuredQueuePreflight,
		acquireSlot: dependencies.acquireVmSlot ?? acquireVmSlot,
		releaseSlot: dependencies.releaseVmSlot ?? releaseVmSlot,
	};
}
function queuePlatform(options) {
	return normalizeQueuePlatform(
		options.runOptions?.platform ?? options.platform,
	);
}
function prepareDirtyOverlayReceipt({
	projectPath,
	tasks,
	potentialAttemptTasks,
	runOptions,
	dependencies,
}) {
	if (
		runOptions?.dirtyOverlay !== true &&
		dependencies.dirtyOverlay !== true &&
		!dependencies.dirtyOverlayReceipt
	)
		return null;
	const supplied = dependencies.dirtyOverlayReceipt;
	const receipt =
		supplied ??
		(runOptions?.dirtyOverlayReceiptPath
			? readDirtyOverlayReceipt(runOptions.dirtyOverlayReceiptPath)
			: null);
	const paths = [
		...new Set(
			(potentialAttemptTasks.length > 0
				? potentialAttemptTasks
				: tasks
			).flatMap((task) => task.requiredPaths ?? []),
		),
	];
	if (paths.length === 0)
		throw new Error("dirty overlay requires exact declared task paths");
	if (!receipt) return captureDirtyOverlay(projectPath, paths);
	const validation = validateDirtyOverlayReceipt(projectPath, receipt, paths);
	if (!validation.ok)
		throw new Error(`dirty overlay receipt rejected: ${validation.reason}`);
	return receipt;
}
function assertDirtyOverlayReceiptCurrent(projectPath, receipt, phase) {
	if (!receipt) return;
	const validation = validateDirtyOverlayReceipt(projectPath, receipt);
	if (!validation.ok)
		throw new Error(`dirty overlay drift ${phase}: ${validation.reason}`);
}
function prepareQueueLaunch({
	tasksFilePath,
	projectPath,
	checkpointPath,
	maxTasks,
	stopOnFailure,
	exclude,
	only,
	taskIds,
	identityTaskIds = taskIds,
	platform,
	runOptions,
	queueIdentity,
	projectRevision,
	runId,
	dependencies,
	onStatus,
	deferSlotAcquisition = false,
}) {
	const selectedPlatform = queuePlatform({ platform, runOptions });
	const taskFileSha256 = hashBytes(readFileSync(tasksFilePath, "utf8"));
	const tasks = loadTaskQueue(tasksFilePath);
	validateProjectFileEntries(tasks, projectPath);
	if (tasks.length === 0) {
		throwOnEmptyParse(tasksFilePath, checkpointPath, onStatus);
	}
	let dirtyOverlayReceipt = null;
	// Read the checkpoint before backend selection so malformed or stale queue
	// state fails without creating a workspace or reserving a VM slot.
	const checkpointExisted = existsSync(checkpointPath);
	const observedCheckpoint = loadCheckpoint(checkpointPath, tasksFilePath);
	let identity = resolveQueueIdentity(
		{
			tasksFilePath,
			projectPath,
			checkpointPath,
			maxTasks,
			stopOnFailure,
			exclude,
			only,
			taskIds: identityTaskIds,
			platform: selectedPlatform,
			runOptions,
			queueIdentity,
			projectRevision,
		},
		tasks,
	);
	const effectiveMaxTasks = identity.runOptions
		? (identity.runOptions.maxTasks ?? Number.POSITIVE_INFINITY)
		: maxTasks;
	const effectiveStopOnFailure = identity.runOptions
		? identity.runOptions.stopOnFailure
		: stopOnFailure;
	const effectiveExclude = identity.runOptions
		? identity.runOptions.excludeProviders
		: exclude;
	const effectiveOnly = identity.runOptions
		? identity.runOptions.onlyProviders
		: only;
	const effectiveTaskIds = identity.runOptions
		? identity.runOptions.taskIds
		: taskIds;
	const checkpointOwner = checkpointOwnerFor(
		checkpointPath,
		runId ?? identity.queueIdentity,
		dependencies.checkpointOwner,
	);
	const expectedCheckpointIdentity = identity.enabled
		? {
				queueIdentity: identity.queueIdentity,
				runOptions: identity.runOptions,
			}
		: null;
	if (
		checkpointExisted &&
		observedCheckpoint.version === CHECKPOINT_VERSION &&
		(observedCheckpoint.ownershipReleased ||
			!sameCheckpointOwner(observedCheckpoint.owner, checkpointOwner))
	) {
		claimCheckpointOwnership(
			checkpointPath,
			tasksFilePath,
			expectedCheckpointIdentity,
			checkpointOwner,
		);
	}
	const checkpoint = loadCheckpoint(
		checkpointPath,
		tasksFilePath,
		identity.enabled
			? {
					queueIdentity: identity.queueIdentity,
					runOptions: identity.runOptions,
					checkpointOwner,
				}
			: {
					checkpointOwner,
				},
	);
	assertCompletedQuickChecks(tasks, checkpoint);
	ensureRetryCheckpoint(checkpoint);
	ensureProviderAttemptAllocations(checkpoint);
	validateRetryDescriptorEvidence(checkpoint);
	assertCheckpointRecoverySafe(checkpoint);
	let potentialAttemptTasks;
	try {
		potentialAttemptTasks = planPotentialAttemptTasks(tasks, checkpoint, {
			selectedTaskIds: effectiveTaskIds,
			maxTasks: effectiveMaxTasks,
			resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
		});
	} catch (error) {
		// Selection/dependency errors remain owned by the execution transition;
		// admission must not move their established failure point or teardown
		// semantics. No task can be safely claimed for provider eligibility.
		if (!(error instanceof TaskSelectionError)) throw error;
		potentialAttemptTasks = [];
	}
	dirtyOverlayReceipt = prepareDirtyOverlayReceipt({
		projectPath,
		tasks,
		potentialAttemptTasks,
		runOptions: identity.runOptions ?? runOptions,
		dependencies,
	});
	if (
		dirtyOverlayReceipt &&
		(identity.runOptions?.dirtyOverlayReceiptHash ?? null) !==
			dirtyOverlayReceipt.receiptHash
	) {
		runOptions = {
			...(runOptions ?? {}),
			dirtyOverlayReceiptHash: dirtyOverlayReceipt.receiptHash,
		};
		identity = resolveQueueIdentity(
			{
				tasksFilePath,
				projectPath,
				checkpointPath,
				maxTasks,
				stopOnFailure,
				exclude,
				only,
				taskIds: identityTaskIds,
				platform: selectedPlatform,
				runOptions,
				queueIdentity,
				projectRevision,
			},
			tasks,
		);
	}
	const hostPower = readQueueHostPower({
		hostPowerProbe: dependencies.hostPowerProbe,
		execFn: dependencies.hostPowerExecFn,
		timeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		onStatus,
	});
	if (
		hostPower.state === HOST_POWER_STATES.BATTERY &&
		potentialAttemptTasks.length > 0
	) {
		return {
			selectedPlatform,
			tasks,
			checkpoint,
			identity,
			queueBackend: null,
			slotLease: null,
			effectiveMaxTasks,
			effectiveStopOnFailure,
			effectiveExclude,
			effectiveOnly,
			effectiveTaskIds,
			policyDeferred: {
				version: 1,
				action: "policy_deferred",
				direction: "advance_authorized_fallback",
				reasonCode: "host_on_battery",
				diagnosticCode: "host_on_battery",
				nextTaskId: potentialAttemptTasks[0].id,
				taskFileSha256,
				runnableTaskCount: potentialAttemptTasks.length,
			},
		};
	}
	const queueBackend = createQueueBackend({
		platform: selectedPlatform,
		dependencies,
		projectPath,
		runId,
		runOptions: identity.runOptions ?? runOptions,
	});
	queueBackend.preflight({
		platform: selectedPlatform,
		tasks,
		potentialAttemptTasks,
		checkpoint,
		maxTasks: effectiveMaxTasks,
		selectedTaskIds: effectiveTaskIds,
		exclude: effectiveExclude,
		only: effectiveOnly,
		runId,
		projectPath,
		runOptions: identity.runOptions,
	});
	if (selectedPlatform === "macos") {
		queueBackend.readiness({
			platform: selectedPlatform,
			tasks,
			checkpoint,
			runId,
			projectPath,
			onStatus,
		});
	}
	assertDirtyOverlayReceiptCurrent(
		projectPath,
		dirtyOverlayReceipt,
		"before allocation",
	);
	const slotLease =
		selectedPlatform === "macos" && !deferSlotAcquisition
			? queueBackend.acquireSlot({ runId })
			: null;
	return {
		selectedPlatform,
		tasks,
		checkpoint,
		taskFileSha256,
		identity,
		queueBackend,
		dirtyOverlayReceipt,
		slotLease,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	};
}
function releaseQueueSlot(queueBackend, slotLease) {
	if (!slotLease) return;
	try {
		queueBackend.releaseSlot(slotLease);
	} catch {
		// The queue outcome is authoritative; release is best effort but always
		// attempted from the enclosing finally block.
	}
}
function isVmSlotUnavailable(error) {
	return (
		error instanceof VmSlotUnavailableError ||
		error?.code === "VM_SLOT_UNAVAILABLE"
	);
}
function throwIfQueueAdmissionAborted(signal) {
	if (!signal?.aborted) return;
	if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
	throw signal.reason ?? new Error("VM slot admission wait aborted");
}
function waitForVmSlotRetry(delayMs, signal, sleepFn) {
	throwIfQueueAdmissionAborted(signal);
	const delay = Promise.resolve().then(() => sleepFn(delayMs));
	if (typeof signal?.addEventListener !== "function") return delay;
	return new Promise((resolveDelay, rejectDelay) => {
		const abort = () => {
			signal.removeEventListener?.("abort", abort);
			try {
				throwIfQueueAdmissionAborted(signal);
			} catch (error) {
				rejectDelay(error);
			}
		};
		signal.addEventListener("abort", abort, { once: true });
		delay.then(
			(value) => {
				signal.removeEventListener?.("abort", abort);
				resolveDelay(value);
			},
			(error) => {
				signal.removeEventListener?.("abort", abort);
				rejectDelay(error);
			},
		);
	});
}
async function acquireQueueSlotAsync({
	queueBackend,
	selectedPlatform,
	runId,
	dependencies,
	onStatus,
}) {
	if (selectedPlatform !== "macos") return null;
	const timeoutMs = dependencies.vmSlotWaitTimeoutMs ?? VM_SLOT_WAIT_TIMEOUT_MS;
	const intervalMs =
		dependencies.vmSlotWaitIntervalMs ?? VM_SLOT_WAIT_INTERVAL_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new RangeError("vmSlotWaitTimeoutMs must be a non-negative number");
	}
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new RangeError("vmSlotWaitIntervalMs must be a positive number");
	}
	// VM admission must not be extended or shortened by wall-clock adjustments.
	// `nowFn` remains injectable for deterministic tests, but production uses the
	// monotonic process clock.
	const now = dependencies.nowFn ?? performance.now.bind(performance);
	const sleepFn = dependencies.sleepFn ?? sleep;
	const signal = dependencies.signal;
	const deadline = now() + timeoutMs;

	for (;;) {
		throwIfQueueAdmissionAborted(signal);
		try {
			return queueBackend.acquireSlot({ runId });
		} catch (error) {
			if (!isVmSlotUnavailable(error)) throw error;
			const remainingMs = Math.max(0, deadline - now());
			const elapsedMs = timeoutMs - remainingMs;
			onStatus?.({
				phase: "bootstrap",
				event: "vm_slot_wait",
				status: "Waiting for VM admission capacity",
				elapsedMs,
			});
			if (remainingMs === 0) throw error;
			await waitForVmSlotRetry(
				Math.min(intervalMs, remainingMs),
				signal,
				sleepFn,
			);
		}
	}
}
function recordDispatchToBothLedgers(
	dispatch,
	recordDispatchToStoreFn = recordDispatchToStore,
	reporting = {},
) {
	return Promise.resolve()
		.then(() => recordDispatchToStoreFn(dispatch))
		.catch((error) => {
			reportOutcomeProjectionFailure(reporting, error);
		})
		.then(() => {
			try {
				recordDispatch(dispatch);
			} catch (error) {
				reportLegacyProjectionFailure(reporting, error);
			}
		});
}
function runQueueImpl(options) {
	const {
		tasksFilePath,
		projectPath,
		workingContainerName: suppliedWorkingContainerName,
		checkpointPath = getCheckpointPath(tasksFilePath),
		maxTasks = Number.POSITIVE_INFINITY,
		stopOnFailure = true,
		exclude = [],
		only = [],
		taskIds = [],
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId = null,
		dependencies = {},
	} = options;

	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});
	const onTaskStart = dependencies.onTaskStart ?? null;
	const onTaskRouted = dependencies.onTaskRouted ?? null;
	const onResult = dependencies.onResult ?? null;
	const onCheckpointSaved = dependencies.onCheckpointSaved ?? null;
	const onRetryStateChanged = dependencies.onRetryStateChanged ?? null;
	const onContainerReady = dependencies.onContainerReady ?? null;
	const runStore = dependencies.runStore ?? null;
	const runStorePath = dependencies.runStorePath ?? null;
	const emitStatus = _resolveOnStatus(dependencies);
	const launch = prepareQueueLaunch({
		tasksFilePath,
		projectPath,
		checkpointPath,
		maxTasks,
		stopOnFailure,
		exclude,
		only,
		taskIds,
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId,
		dependencies,
		onStatus: emitStatus,
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
	});
	const {
		queueBackend,
		dirtyOverlayReceipt,
		selectedPlatform,
		slotLease,
		tasks,
		checkpoint,
		taskFileSha256,
		identity,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	if (launch.policyDeferred) {
		emitStatus?.({
			phase: "policy",
			event: "queue_deferred",
			status: "Queue deferred while host is on battery power",
			taskId: launch.policyDeferred.nextTaskId,
			diagnosticCode: launch.policyDeferred.diagnosticCode,
		});
		return policyDeferredQueueResult(launch, checkpointPath);
	}
	ensureProviderAttemptAllocations(checkpoint);

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	try {
		if (!workingContainerName) {
			assertDirtyOverlayReceiptCurrent(
				projectPath,
				dirtyOverlayReceipt,
				"immediately before allocation",
			);
			queueBackend.ensureAgentContainer();
			// Pass runId so the cloned VM's name embeds it (see
			// buildParallelsWorkingName) — that embedding is the only ownership
			// record `recover`/reclaim has, so a missing runId here is invisible
			// to leak reclamation.
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: emitStatus,
			});
			if (!workingContainerName) {
				throw new Error("runQueue: failed to create working container");
			}
			ownsWorkingContainer = true;
			if (!dependencies.signal) {
				uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
					workingContainerName,
					queueBackend.destroy,
				);
			}
			if (emitStatus) {
				emitStatus({
					phase: "bootstrap",
					event: "container_created",
					status: "Working container created",
					provider: null,
					model: null,
				});
			}
			try {
				queueBackend.provision(workingContainerName);
			} catch (error) {
				console.error(
					`runQueue: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
		}

		// Fires once the workspace handle holds its final value, whether it was
		// supplied by the caller or created by this queue.
		if (onContainerReady) onContainerReady({ workingContainerName });
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueue: before_remove hook failed: ${hookError.message}`,
					);
				}
				queueBackend.destroy(workingContainerName);
			} catch {
				// Preserve the bootstrap error.
			}
		}
		releaseQueueSlot(queueBackend, slotLease);
		throw error;
	}

	const recordDispatchToStoreFn =
		dependencies.recordDispatchToStore ?? recordDispatchToStore;
	const recordDispatchIntentFn =
		dependencies.recordDispatchIntent ?? recordDispatchIntentToStore;
	const ledgerReporting = ledgerReportingContext(
		emitStatus,
		dependencies,
		"runQueue",
	);
	// The project-local outcome write is async; executeTask() and runQueue are
	// both synchronous. Writes are therefore queued onto one chain that keeps
	// them in dispatch order, and nothing in this function can await it --
	// making runQueue async would duplicate runQueueAsync, which exists for
	// exactly that reason.
	//
	// What the chain cannot do on its own is guarantee durability before the
	// caller acts on the return value: a caller that exits the process as soon
	// as runQueue returns drops any write still in flight. The chain is
	// returned as `ledgerWritesSettled` so such a caller can drain it. The
	// authoritative pre-dispatch intent receipt is unaffected -- it is written
	// synchronously by recordDispatchIntentToStore, before the provider runs,
	// and never goes through this chain.
	let storeWriteChain = Promise.resolve();
	const defaultRecordDispatch = (dispatch) => {
		storeWriteChain = storeWriteChain
			.then(() => recordDispatchToStoreFn(dispatch, runStorePath))
			.catch((error) => {
				reportOutcomeProjectionFailure(ledgerReporting, error);
			})
			.then(() => {
				try {
					recordDispatch(dispatch);
				} catch (error) {
					reportLegacyProjectionFailure(ledgerReporting, error);
				}
			})
			// Both handlers above call caller-supplied code (`onStatus`,
			// `diagnostics.emit`, `onLedgerProjectionFailure`), none of which is
			// guarded against throwing. Everywhere else in this runner such a
			// throw propagates synchronously and is the caller's own visible
			// bug; here it would instead reject a chain that the documented
			// normal case ignores, turning a best-effort ledger warning into an
			// unhandled rejection -- fatal on current Node, and raised after
			// runQueue has already returned success. So the chain is kept
			// non-rejecting: `ledgerWritesSettled` always settles, which is also
			// what a caller draining it before exit needs. console.warn is the
			// only channel left once the status surface is the thing that broke.
			.catch((error) => {
				console.warn(
					`runQueue: dispatch-ledger failure reporting threw (${error?.name ?? "Error"}); the ledger write itself is unaffected`,
				);
			});
	};
	const defaultRecordDispatchIntent = (intent) => {
		recordDispatchIntentFn(intent, runStorePath);
	};
	checkpoint.taskBases ??= {};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		recordOutcomeEvent: dependencies.recordOutcomeEvent ?? null,
		outcomeWriterEpoch: dependencies.outcomeWriterEpoch ?? null,
		_activeProcessOutcomeId: null,
		_activeOutcomeAttempt: 1,
		_outcomeAttemptCursor: 0,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ?? defaultRecordDispatchIntent,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		ownsWorkingContainer,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		platform: selectedPlatform,
		goldenImageVerifiedProviders: dependencies.goldenImageVerifiedProviders,
		healthDecision: resolveQueueHealthDecision(dependencies),
		onHealthDecision: dependencies.onHealthDecision,
		checkpoint,
		checkpointPath,
		taskFileSha256,
		runId: queueBackend.taskBaseRunId ?? runId,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
		onStatus: emitStatus,
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
		onTaskRouted,
		onLedgerProjectionFailure: dependencies.onLedgerProjectionFailure,
		onIntentReceiptFailure: dependencies.onIntentReceiptFailure,
		resolveDescriptor: dependencies.resolveDescriptor,
		checkIgnoredPath: dependencies.checkIgnoredPath,
		hostPowerProbe: dependencies.hostPowerProbe,
		hostPowerExecFn: dependencies.hostPowerExecFn,
		hostPowerProbeTimeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		completionContinuation: dependencies.completionContinuation ?? {
			enabled: false,
		},
		completionContinuationMode: "sync",
		now: dependencies.now ?? Date.now,
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
		exclude,
		only,
		emitNonProviderOutcomes:
			dependencies.enableNonProviderOutcomes === true ||
			typeof dependencies.recordOutcomeEvent !== "function",
	};
	if (context.recordOutcomeEvent && context.outcomeWriterEpoch) {
		context._outcomeWriteChain = Promise.resolve()
			.then(() =>
				emitStageOutcome(context, {
					stage: "preflight",
					status: "succeeded",
					producer: "runner",
					code: "queue_preflight",
					detail: { eligible: true },
				}),
			)
			.then(() =>
				emitStageOutcome(context, {
					stage: "run",
					status: "started",
					producer: "runner",
					code: "run_started",
				}),
			)
			.then(() =>
				emitStageOutcome(context, {
					stage: "worker",
					status: "started",
					producer: "runner",
					code: "worker_started",
					detail: { launchVerified: true },
				}),
			)
			.catch(() => {});
	}

	try {
		if (ownsWorkingContainer) {
			try {
				queueBackend.seed(workingContainerName, projectPath, {
					dirtyOverlayReceipt,
				});
				queueBackend.afterCreate?.(workingContainerName, projectPath, {
					onStatus: emitStatus,
				});
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "bootstrap",
						event: "seed_failed",
						status: `Seed failed: ${error.message}`,
						error: _safeError(error),
					});
				}
				throw error;
			}
		}

		context.exclude = effectiveExclude;
		context.only = effectiveOnly;
		const projectRetryState = () => {
			if (
				(!runStore && !onRetryStateChanged) ||
				(checkpoint.retryTransitionId === 0 &&
					checkpoint.retryState === null &&
					checkpoint.quarantinedTargetIds.length === 0)
			) {
				return;
			}
			const projection = {
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
			};
			if (runStore) runStore.updateRun(projection).catch(() => {});
			if (onRetryStateChanged) onRetryStateChanged(projection);
		};
		const selectionOptions = identity.enabled
			? { selectedTaskIds: effectiveTaskIds }
			: {};
		context.exclude = mergeRetryExclusions(
			effectiveExclude,
			checkpoint.quarantinedTargetIds,
		);
		const initialRunnable = getRunnableTasks(
			tasks,
			checkpoint,
			selectionOptions,
		);
		const attemptedTaskIds = new Set();
		const results = [];
		const deferredTaskIds = [];
		let policyDeferred = null;
		reconcileAlreadyCompleteSelection(
			checkpoint,
			checkpointPath,
			results,
			effectiveTaskIds,
			tasks,
			onResult,
			emitStatus,
			onCheckpointSaved,
		);
		let processed = 0;
		let halted = false;
		let resumedRetryTaskId = checkpoint.retryState?.taskId ?? null;

		while (processed < effectiveMaxTasks) {
			const selection = selectNextQueueTask(tasks, checkpoint, {
				...selectionOptions,
				excludedTaskIds: attemptedTaskIds,
				retryTaskId: resumedRetryTaskId,
			});
			const task = selection.task;
			if (!task) break;
			resumedRetryTaskId = selection.retryTaskId;
			attemptedTaskIds.clear();
			for (const taskId of selection.excludedTaskIds)
				attemptedTaskIds.add(taskId);
			const retryState =
				checkpoint.retryState?.taskId === task.id
					? checkpoint.retryState
					: null;
			const priorExtraAllocation = ensureProviderAttemptAllocations(
				checkpoint,
			).find((entry) => entry?.taskId === task.id);
			context._activeInvocationDescriptor = null;

			if (onTaskStart) onTaskStart(task);
			if (runStore) {
				runStore
					.updateRun({ activeTaskId: task.id })
					.then((upd) => {
						runStore._rev = upd.revision;
					})
					.catch(() => {});
			}
			if (emitStatus) {
				emitStatus({
					phase: "execution",
					event: "task_started",
					status: `Starting task ${task.id}`,
					taskId: task.id,
				});
			}
			context.exclude = mergeRetryExclusions(
				effectiveExclude,
				checkpoint.quarantinedTargetIds,
			);
			let result;
			let retryHaltResult = null;
			let retryUsed = Boolean(retryState);
			let retryTargetId = retryState?.resolvedTargetId ?? null;
			const retryEvidenceMissing =
				Boolean(retryState) && !hasTrustedQuotaRetryEvidence(retryState);
			if (!retryState && priorExtraAllocation) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason: "persisted extra provider invocation already consumed",
				};
			} else if (retryEvidenceMissing) {
				// Historical model-only retry state is readable, but it cannot
				// authorize a retry against an exact descriptor/target. Halt before
				// reset, reroute, or adapter invocation; the normal finally path
				// still releases the run/project locks.
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					resolvedTargetId: retryState.resolvedTargetId ?? null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason:
						"historical retry state lacks trusted quota diagnostic provenance",
				};
			} else if (retryState) {
				const resumedTargetId = normalizeRetryTargetId(
					retryState.resolvedTargetId,
				);
				if (
					resumedTargetId &&
					!checkpoint.quarantinedTargetIds.includes(resumedTargetId)
				) {
					// A crash can land after attempt_recorded but before the
					// separate quarantine transition. Reconstruct the safety
					// invariant before any reset/reroute so resume cannot select
					// the exhausted target again.
					checkpoint.quarantinedTargetIds = [
						...checkpoint.quarantinedTargetIds,
						resumedTargetId,
					];
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "target_quarantined",
						taskId: task.id,
						attempt: 1,
						resolvedTargetId: resumedTargetId,
						invocationDescriptor: retryState.invocationDescriptor,
						descriptorIdentity: retryState.descriptorIdentity,
						descriptorHarness: retryState.descriptorHarness,
					});
					projectRetryState();
				}
				if (retryState.phase === "retry_halted") {
					result = {
						taskId: task.id,
						success: false,
						provider: null,
						model: null,
						result: "unknown_failure",
						errorKind: "unknown_failure",
					};
				} else if (retryState.phase === "retry_started") {
					// A provider may already have run when the process died after
					// this transition. Never spend a third attempt; fail closed.
					result = {
						taskId: task.id,
						success: false,
						provider: null,
						model: null,
						result: "unknown_failure",
						errorKind: "unknown_failure",
					};
				} else {
					if (retryState.phase !== "reset_completed") {
						retryHaltResult = resetBeforeQuotaRetry({
							result: {
								taskId: task.id,
								provider: null,
								model: null,
								resolvedTargetId: retryState.resolvedTargetId,
								invocationDescriptor: retryState.invocationDescriptor,
								descriptorIdentity: retryState.descriptorIdentity,
								descriptorHarness: retryState.descriptorHarness,
							},
							checkpoint,
							checkpointPath,
							workingContainerName,
							resetWorkingTreeFn: queueBackend.reset,
							emitStatus,
						});
						projectRetryState();
					}
					if (!retryHaltResult) {
						persistRetryTransition(checkpoint, checkpointPath, {
							type: "retry_started",
							taskId: task.id,
							attempt: 2,
							resolvedTargetId: retryState.resolvedTargetId,
							invocationDescriptor: retryState.invocationDescriptor,
							descriptorIdentity: retryState.descriptorIdentity,
							descriptorHarness: retryState.descriptorHarness,
						});
						projectRetryState();
						context.exclude = mergeRetryExclusions(
							effectiveExclude,
							checkpoint.quarantinedTargetIds,
						);
						startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
						result = executeTask(task, context);
					}
				}
			} else {
				result = executeTask(task, context);
				if (context._activeInvocationDescriptor) {
					Object.assign(
						result,
						descriptorReceiptFields(context._activeInvocationDescriptor),
					);
				}
				result = runCompletionCorrection(
					task,
					context,
					result,
					checkpoint,
					checkpointPath,
				);
				if (
					result._routeHealthTrialStarted !== true &&
					result.extraProviderInvocationUsed !== true &&
					isQuotaRetryCandidate(result, ownsWorkingContainer) &&
					allocateExtraProviderInvocation(
						checkpoint,
						checkpointPath,
						task.id,
						"quota_fallback",
					)
				) {
					const targetId = normalizeRetryTargetId(result.resolvedTargetId);
					retryUsed = true;
					retryTargetId = targetId;
					appendRetryAttempt(checkpoint, result, 1);
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "attempt_recorded",
						taskId: task.id,
						attempt: 1,
						provider: result.provider,
						model: result.model,
						resolvedTargetId: targetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
						diagnosticCode: result.diagnosticCode,
						diagnosticOrigin: result.diagnosticOrigin,
						diagnosticEvidenceAvailable: result.diagnosticEvidenceAvailable,
						diagnosticRef: result.diagnosticRef,
						failurePhase: result.failurePhase,
					});
					projectRetryState();
					checkpoint.quarantinedTargetIds = [
						...new Set([...checkpoint.quarantinedTargetIds, targetId]),
					];
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "target_quarantined",
						taskId: task.id,
						attempt: 1,
						provider: result.provider,
						model: result.model,
						resolvedTargetId: targetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
					});
					projectRetryState();
					if (emitStatus) {
						emitStatus({
							phase: "execution",
							event: "target_quarantined",
							status: `Quarantined ${targetId} after quota exhaustion`,
							taskId: task.id,
							provider: result.provider,
							model: result.model,
							resolvedTargetId: targetId,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity: result.descriptorIdentity,
							descriptorHarness: result.descriptorHarness,
						});
					}
					retryHaltResult = resetBeforeQuotaRetry({
						result,
						checkpoint,
						checkpointPath,
						workingContainerName,
						resetWorkingTreeFn: queueBackend.reset,
						emitStatus,
					});
					projectRetryState();
					if (!retryHaltResult) {
						persistRetryTransition(checkpoint, checkpointPath, {
							type: "retry_started",
							taskId: task.id,
							attempt: 2,
							provider: result.provider,
							model: result.model,
							resolvedTargetId: targetId,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity: result.descriptorIdentity,
							descriptorHarness: result.descriptorHarness,
						});
						projectRetryState();
						context.exclude = mergeRetryExclusions(
							effectiveExclude,
							checkpoint.quarantinedTargetIds,
						);
						startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
						result = executeTask(task, context);
					}
				}
			}

			if (retryHaltResult) {
				recordHalt(
					checkpoint,
					checkpointPath,
					results,
					retryHaltResult,
					emitStatus,
				);
				processed += 1;
				halted = true;
				break;
			}
			if (retryUsed) {
				appendRetryAttempt(checkpoint, result, 2);
			}
			recordExtraProviderInvocationResult(checkpoint, checkpointPath, task.id);
			if (context._activeInvocationDescriptor) {
				Object.assign(
					result,
					descriptorReceiptFields(context._activeInvocationDescriptor),
				);
			}
			if (result?.result === "policy_deferred") {
				deferredTaskIds.push(result.taskId);
				policyDeferred = result.policyDeferred;
				break;
			}
			decorateDirtyOverlayResult(result, context);
			if (isRouteHealthDeferredResult(result)) {
				deferredTaskIds.push(result.taskId);
				reportRouteHealthDeferred(result, onResult, emitStatus);
				continue;
			}
			const resultAttempt = reserveTaskAttempt(
				checkpoint,
				checkpointPath,
				result.taskId,
			);
			enforceQuickCheckCompletion(task, result, resultAttempt, checkpoint);
			if (result.partialDiff) {
				try {
					result.partialDiffPath = savePartialDiff(
						checkpointPath,
						result.taskId,
						result.partialDiff,
						resultAttempt,
					);
					if (emitStatus) {
						emitStatus({
							phase: "execution",
							event: "partial_diff_captured",
							status: result.timedOut
								? `Task ${result.taskId} timed out; partial diff saved for review (not applied)`
								: `Task ${result.taskId} was rejected (${result.result}); diff saved for review (not applied)`,
							taskId: result.taskId,
							partialDiffPath: result.partialDiffPath,
							byteCount: result.partialDiff.length,
						});
					}
				} catch (error) {
					console.error(
						`runQueue: could not save diff artifact for task ${result.taskId}: ${error.message}`,
					);
				}
				// Raw diff text stays out of checkpoint.json / onResult payloads —
				// the artifact on disk (partialDiffPath) is the single copy.
				result.partialDiff = undefined;
			} else if (result.timedOut && result.captureStatus !== "empty") {
				// The rescue attempt itself came up empty (no edits were made
				// before the kill, or diff capture failed — e.g. a container in a
				// state git couldn't diff). Distinct from the diff-captured case so
				// this doesn't collapse into a generic task_failed: an operator
				// needs to know whether their in-progress work was actually saved,
				// not just that the task didn't finish.
				if (emitStatus) {
					emitStatus({
						phase: "execution",
						event: "partial_diff_capture_failed",
						status: `Task ${result.taskId} timed out; no diff was recovered (${result.captureStatus ?? "unknown"})`,
						taskId: result.taskId,
						captureStatus: result.captureStatus ?? "unknown",
					});
				}
			}
			if (result.gateEvidence) {
				try {
					result.gateEvidencePath = saveGateEvidence(
						checkpointPath,
						result.taskId,
						result.gateEvidence,
						resultAttempt,
					);
				} catch (error) {
					console.error(
						`runQueue: could not save gate evidence for task ${result.taskId}: ${error.message}`,
					);
					result.gateEvidencePath = null;
				}
				// Same rule as the diff above: host-only bytes, never onResult.
				result.gateEvidence = undefined;
			}
			persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
			if (onResult) onResult(result);
			const safeFailure = failureMetadataFor(result, result.partialDiffPath);
			if (emitStatus) {
				if (result.success) {
					emitStatus({
						phase: "execution",
						event: "task_completed",
						status: `Task ${result.taskId} completed`,
						taskId: result.taskId,
						provider: result.provider ?? null,
						model: result.model ?? null,
					});
				} else {
					emitStatus({
						phase: "execution",
						event: "task_failed",
						status: `Task ${result.taskId} failed: ${result.result}`,
						taskId: result.taskId,
						provider: result.provider ?? null,
						model: result.model ?? null,
						error: safeFailure ? { message: safeFailure.reason } : undefined,
						errorKind: safeFailure?.errorKind,
						reasonCode: safeFailure?.reasonCode,
						reason: safeFailure?.reason,
						artifactRef: safeFailure?.artifactRef,
						...(safeFailure?.diagnosticCode
							? { diagnosticCode: safeFailure.diagnosticCode }
							: {}),
						...(safeFailure?.diagnosticOrigin
							? {
									diagnosticOrigin: safeFailure.diagnosticOrigin,
									diagnosticEvidenceAvailable:
										safeFailure.diagnosticEvidenceAvailable,
								}
							: {}),
						...(safeFailure?.diagnosticRef
							? { diagnosticRef: safeFailure.diagnosticRef }
							: {}),
					});
				}
			}
			results.push(result);
			checkpoint.results.push({
				taskId: result.taskId,
				attempt: resultAttempt,
				provider: result.provider,
				model: result.model,
				...(result.invocationDescriptor
					? {
							dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity:
								result.invocationDescriptor.descriptor_identity,
							descriptorHarness: result.descriptorHarness ?? null,
							resolvedTargetId: result.resolvedTargetId ?? null,
						}
					: {}),
				result: result.result,
				...(result.quickCheckReceipt
					? { quickCheckReceipt: result.quickCheckReceipt }
					: {}),
				...(typeof result.servedModelVerified === "boolean"
					? { servedModelVerified: result.servedModelVerified }
					: {}),
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				// Presence is the signal: these are written only when the provider
				// outlived its kill, so a resumed run and `switchyard status` can see
				// that an otherwise successful task left a process in the guest.
				...(result.cleanupFailed === true
					? {
							cleanupFailed: true,
							cleanupStage: result.cleanupStage ?? null,
						}
					: {}),
				success: result.success,
				dirtyOverlayReceiptHash: result.dirtyOverlayReceiptHash ?? null,
				timedOut: Boolean(result.timedOut),
				partialDiffPath: null,
				...(safeFailure ?? {}),
				...(opaqueArtifactRef(result.artifactRef)
					? { artifactRef: opaqueArtifactRef(result.artifactRef) }
					: {}),
				timestamp: new Date().toISOString(),
			});
			checkpoint.lastTaskId = result.taskId;
			checkpoint.lastUpdatedAt = new Date().toISOString();

			if (result.success) {
				checkpoint.completedTaskIds.push(result.taskId);
			}
			if (retryUsed) {
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "finalized",
					taskId: result.taskId,
					attempt: 2,
					provider: result.provider,
					model: result.model,
					resolvedTargetId:
						result.invocationDescriptor?.target_id ??
						normalizeRetryTargetId(result.resolvedTargetId) ??
						retryTargetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
					clearState: true,
					save: false,
				});
			}

			try {
				saveCheckpoint(checkpointPath, checkpoint);
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "checkpoint",
						event: "checkpoint_failed",
						status: `Checkpoint save failed: ${error.message}`,
						taskId: result.taskId,
						error: _safeError(error),
					});
				}
				throw error;
			}
			projectRetryState();
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_saved",
					status: `Checkpoint saved after task ${result.taskId}`,
					taskId: result.taskId,
				});
			}
			if (onCheckpointSaved) onCheckpointSaved();

			// The checkpoint/result bookkeeping block above runs ahead of the
			// working-container commit/reset below: a commit or reset failure (or
			// a crash mid-commit) must never leave a task whose execute succeeded
			// missing from the durable checkpoint (INV-6). The result and
			// completedTaskIds are on disk before commit is even attempted.
			let haltResult =
				result.cleanupFailed === true ? providerCleanupHalt(result) : null;
			if (!haltResult)
				haltResult = commitOrResetWorkingContainer(result, {
					ownsWorkingContainer,
					workingContainerName,
					stopOnFailure: effectiveStopOnFailure,
					commitWorkingTreeFn: queueBackend.commit,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus,
					logPrefix: "runQueue: ",
				});
			if (!haltResult) {
				haltResult = finalizeTaskBase(
					context,
					result.taskId,
					checkpoint,
					checkpointPath,
				);
			}
			if (runStore) {
				runStore.updateRun({}).catch(() => {});
			}
			processed += 1;

			// A commit/reset failure leaves the owned working container in a
			// state INV-3 forbids reusing (an unadvanced baseline or a failed
			// task's un-reset changes), so the run must halt here — after this
			// task's checkpoint/bookkeeping and failure handling — before the
			// next task's execute/gate/capture can begin. The completed task's
			// checkpoint stays durable for a later invocation on a fresh
			// container; the halt itself is recorded as a distinct outcome.
			if (haltResult) {
				recordHalt(checkpoint, checkpointPath, results, haltResult, emitStatus);
				halted = true;
				break;
			}

			if (!result.success && effectiveStopOnFailure) {
				break;
			}
		}

		if (emitStatus) {
			emitStatus({
				phase: "lifecycle",
				event: "terminal",
				status: `Queue ${halted ? "halted" : "complete"}: ${processed} tasks processed`,
			});
		}
		if (runStore) {
			const terminalDecision = terminalTransition({
				results,
				totalTasks: tasks.length,
				runnableTasks: initialRunnable.length,
				processedTasks: processed,
				completedTaskIds: checkpoint.completedTaskIds,
				deferredTaskIds,
				failedCount: results.filter((result) => !result.success).length,
			});
			const lastFailed = results.findLast((r) => !r.success);
			const lastFailure = lastFailed
				? failureMetadataFor(lastFailed, lastFailed.partialDiffPath)
				: null;
			const terminalProjection = {
				state: terminalDecision.state,
				activeTaskId: null,
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
				cleanupState: "complete",
				terminalSummary: terminalDecision.terminalSummary,
				terminalizedBy: "worker",
				...(lastFailure ? { lastFailure } : {}),
				...(policyDeferred ? { policyDeferred } : {}),
			};
			let writePromise;
			try {
				writePromise = Promise.resolve(
					runStore.updateRun(terminalProjection),
				).catch((error) => {
					reportOutcomeProjectionFailure(ledgerReporting, error);
				});
			} catch (error) {
				reportOutcomeProjectionFailure(ledgerReporting, error);
				writePromise = Promise.resolve();
			}
			storeWriteChain = storeWriteChain.then(() => writePromise);
		}

		// Guarantee a checkpoint file exists at the path this return value
		// reports, even when the per-task loop above never ran (e.g. every
		// task was already completed by a prior checkpoint) — the caller must
		// never be handed a checkpointPath with nothing on disk behind it.
		// A halt entry was already persisted by recordHalt before the
		// queue_halted event fired; this final save is a no-op for that entry
		// and remains for the other fields/zero-runnable path.
		let checkpointShadowSettled = null;
		if (
			checkpoint.version === CHECKPOINT_VERSION &&
			runStore &&
			typeof runStore.readRun === "function" &&
			typeof runId === "string"
		) {
			// runQueue is intentionally synchronous. Defer checkpoint release to
			// the returned drain boundary so terminal shadow evidence observes both
			// the terminal run update and the final typed outcome writes.
			checkpointShadowSettled = Promise.all([
				storeWriteChain,
				context._outcomeWriteChain ?? Promise.resolve(),
			])
				.then(() =>
					persistCheckpointOutcomeShadow(
						checkpointPath,
						checkpoint,
						runStore,
						runId,
					).catch(() => false),
				)
				.catch(() => false)
				.finally(() => {
					try {
						releaseCheckpointOwnership(checkpointPath, checkpoint);
					} catch {
						// Shadow/release failures are best effort and must not alter
						// the established synchronous caller result.
					}
				});
		}
		if (checkpoint.version === CHECKPOINT_VERSION && !checkpointShadowSettled) {
			releaseCheckpointOwnership(checkpointPath, checkpoint);
		}

		return {
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			deferredTaskIds,
			lastTaskId: checkpoint.lastTaskId,
			checkpointPath,
			// The drain boundary for the async outcome writes queued above. A
			// caller that terminates on return (or that reads the ledger right
			// after it) must await this; every other caller can ignore it, which
			// is why runQueue's own signature stays synchronous.
			ledgerWritesSettled: Promise.all([
				storeWriteChain,
				context._outcomeWriteChain ?? Promise.resolve(),
				checkpointShadowSettled ?? Promise.resolve(),
			]),
			...(identity.enabled
				? {
						queueIdentity: identity.queueIdentity,
						runOptions: identity.runOptions,
						projectRevision: identity.projectRevision,
					}
				: {}),
			results,
			...(policyDeferred ? { policyDeferred } : {}),
		};
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		try {
			if (ownsWorkingContainer) {
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_started",
						status: "Wiping working container",
					});
				}
				try {
					try {
						queueBackend.beforeRemove?.(workingContainerName, projectPath);
					} catch (hookError) {
						console.error(
							`runQueue: before_remove hook failed: ${hookError.message}`,
						);
					}
					queueBackend.destroy(workingContainerName);
					if (emitStatus) {
						emitStatus({
							phase: "cleanup",
							event: "cleanup_complete",
							status: "Cleanup complete",
						});
					}
				} catch (error) {
					if (emitStatus) {
						emitStatus({
							phase: "cleanup",
							event: "cleanup_failed",
							status: `Cleanup failed: ${error.message}`,
							error: _safeError(error),
						});
					}
					// biome-ignore lint/correctness/noUnsafeFinally: re-throwing the same error the bare wipe call would throw
					throw error;
				}
			}
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
		}
	}
}
export async function executeTaskWithOrchestrator(task, context) {
	const result = decorateDirtyOverlayResult(
		await executeTaskWithOrchestratorUnsafe(task, context),
		context,
	);
	if (context?.recordOutcomeEvent && context?.outcomeWriterEpoch) {
		await emitTaskStageOutcomes(context, task, result);
	}
	return result;
}
async function runQueueWithOrchestratorImpl(options) {
	const {
		tasksFilePath,
		projectPath,
		workingContainerName: suppliedWorkingContainerName,
		checkpointPath = getCheckpointPath(tasksFilePath),
		maxTasks = Number.POSITIVE_INFINITY,
		stopOnFailure = true,
		exclude = [],
		only = [],
		taskIds = [],
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		pollIntervalMs = 10_000,
		maxPolls = 1_000,
		runId = null,
		dependencies = {},
	} = options;

	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});
	const onTaskStart = dependencies.onTaskStart ?? null;
	const onTaskRouted = dependencies.onTaskRouted ?? null;
	const onResult = dependencies.onResult ?? null;
	const onCheckpointSaved = dependencies.onCheckpointSaved ?? null;
	const runStore = dependencies.runStore ?? null;
	const runStorePath = dependencies.runStorePath ?? null;
	const emitStatus = _resolveOnStatus(dependencies);
	const launch = prepareQueueLaunch({
		tasksFilePath,
		projectPath,
		checkpointPath,
		maxTasks,
		stopOnFailure,
		exclude,
		only,
		taskIds,
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId,
		dependencies,
		onStatus: emitStatus,
	});
	const {
		queueBackend,
		dirtyOverlayReceipt,
		selectedPlatform,
		slotLease,
		tasks,
		checkpoint,
		taskFileSha256,
		identity,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	if (launch.policyDeferred) {
		emitStatus?.({
			phase: "policy",
			event: "queue_deferred",
			status: "Queue deferred while host is on battery power",
			taskId: launch.policyDeferred.nextTaskId,
			diagnosticCode: launch.policyDeferred.diagnosticCode,
		});
		return policyDeferredQueueResult(launch, checkpointPath);
	}
	ensureProviderAttemptAllocations(checkpoint);

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	try {
		if (!workingContainerName) {
			assertDirtyOverlayReceiptCurrent(
				projectPath,
				dirtyOverlayReceipt,
				"immediately before allocation",
			);
			queueBackend.ensureAgentContainer();
			// Pass runId so the container is labeled managed + run_id (see runQueue).
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: emitStatus,
			});
			if (!workingContainerName) {
				throw new Error(
					"runQueueWithOrchestrator: failed to create working container",
				);
			}
			ownsWorkingContainer = true;
			if (!dependencies.signal) {
				uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
					workingContainerName,
					queueBackend.destroy,
				);
			}
			if (emitStatus) {
				emitStatus({
					phase: "bootstrap",
					event: "container_created",
					status: "Working container created",
					provider: null,
					model: null,
				});
			}
			try {
				queueBackend.provision(workingContainerName);
			} catch (error) {
				console.error(
					`runQueueWithOrchestrator: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
		}
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueueWithOrchestrator: before_remove hook failed: ${hookError.message}`,
					);
				}
				queueBackend.destroy(workingContainerName);
			} catch {
				// Preserve the bootstrap error.
			}
		}
		releaseQueueSlot(queueBackend, slotLease);
		throw error;
	}

	const recordDispatchToStoreFn =
		dependencies.recordDispatchToStore ?? recordDispatchToStore;
	const recordDispatchIntentFn =
		dependencies.recordDispatchIntent ?? recordDispatchIntentToStore;
	const defaultRecordDispatch = async (dispatch) => {
		await recordDispatchToBothLedgers(
			dispatch,
			(data) => recordDispatchToStoreFn(data, runStorePath),
			ledgerReportingContext(emitStatus, dependencies),
		);
	};
	const defaultRecordDispatchIntent = (intent) =>
		recordDispatchIntentFn(intent, runStorePath);
	checkpoint.taskBases ??= {};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		recordOutcomeEvent: dependencies.recordOutcomeEvent ?? null,
		outcomeWriterEpoch: dependencies.outcomeWriterEpoch ?? null,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ?? defaultRecordDispatchIntent,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		orchestrator: resolveOrchestrator(dependencies),
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		ownsWorkingContainer,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		platform: selectedPlatform,
		goldenImageVerifiedProviders: dependencies.goldenImageVerifiedProviders,
		healthDecision: resolveQueueHealthDecision(dependencies),
		onHealthDecision: dependencies.onHealthDecision,
		checkpoint,
		dirtyOverlayReceipt,
		checkpointPath,
		taskFileSha256,
		runId: queueBackend.taskBaseRunId ?? runId,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
		pollIntervalMs,
		maxPolls,
		now: dependencies.now ?? Date.now,
		sleepFn: dependencies.sleepFn ?? sleep,
		onPoll: dependencies.onPoll ?? null,
		onStatus: emitStatus,
		onTaskRouted,
		onLedgerProjectionFailure: dependencies.onLedgerProjectionFailure,
		onIntentReceiptFailure: dependencies.onIntentReceiptFailure,
		resolveDescriptor: dependencies.resolveDescriptor,
		checkIgnoredPath: dependencies.checkIgnoredPath,
		hostPowerProbe: dependencies.hostPowerProbe,
		hostPowerExecFn: dependencies.hostPowerExecFn,
		hostPowerProbeTimeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		completionContinuation: dependencies.completionContinuation ?? {
			enabled: false,
		},
		completionContinuationMode: "unavailable",
		emitNonProviderOutcomes:
			dependencies.enableNonProviderOutcomes === true ||
			typeof dependencies.recordOutcomeEvent !== "function",
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
	};

	try {
		if (ownsWorkingContainer) {
			try {
				queueBackend.seed(workingContainerName, projectPath, {
					dirtyOverlayReceipt,
				});
				queueBackend.afterCreate?.(workingContainerName, projectPath, {
					onStatus: emitStatus,
				});
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "bootstrap",
						event: "seed_failed",
						status: `Seed failed: ${error.message}`,
						error: _safeError(error),
					});
				}
				throw error;
			}
		}

		context.exclude = effectiveExclude;
		context.only = effectiveOnly;
		if (checkpoint.retryState !== null) {
			const reason = hasTrustedQuotaRetryEvidence(checkpoint.retryState)
				? "orchestrator mode cannot resume persisted retry state until an audited retry-resume state machine is implemented"
				: "historical retry state lacks trusted quota diagnostic provenance";
			throw new Error(`runQueueWithOrchestrator: ${reason}`);
		}
		const selectionOptions = identity.enabled
			? { selectedTaskIds: effectiveTaskIds }
			: {};
		const initialRunnable = getRunnableTasks(
			tasks,
			checkpoint,
			selectionOptions,
		);
		const attemptedTaskIds = new Set();
		const results = [];
		const deferredTaskIds = [];
		let policyDeferred = null;
		reconcileAlreadyCompleteSelection(
			checkpoint,
			checkpointPath,
			results,
			effectiveTaskIds,
			tasks,
			onResult,
			emitStatus,
			onCheckpointSaved,
		);
		let processed = 0;
		let halted = false;

		while (processed < effectiveMaxTasks) {
			const runnable = getRunnableTasks(tasks, checkpoint, {
				excludedTaskIds: attemptedTaskIds,
				...selectionOptions,
			});
			const task = runnable[0];
			if (!task) break;
			attemptedTaskIds.add(task.id);
			context._activeInvocationDescriptor = null;

			if (onTaskStart) onTaskStart(task);
			if (runStore) {
				runStore
					.updateRun({ activeTaskId: task.id })
					.then((upd) => {
						runStore._rev = upd.revision;
					})
					.catch(() => {});
			}
			if (emitStatus) {
				emitStatus({
					phase: "execution",
					event: "task_started",
					status: `Starting task ${task.id}`,
					taskId: task.id,
				});
			}

			const priorExtraAllocation = ensureProviderAttemptAllocations(
				checkpoint,
			).find((entry) => entry?.taskId === task.id);
			let result;
			if (priorExtraAllocation) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason: "persisted extra provider invocation already consumed",
				};
			} else {
				// eslint-disable-next-line no-await-in-loop
				result = await executeTaskWithOrchestrator(task, context);
			}
			if (context._activeInvocationDescriptor) {
				Object.assign(
					result,
					descriptorReceiptFields(context._activeInvocationDescriptor),
				);
			}
			if (result?.result === "policy_deferred") {
				deferredTaskIds.push(result.taskId);
				policyDeferred = result.policyDeferred;
				break;
			}
			decorateDirtyOverlayResult(result, context);

			if (isRouteHealthDeferredResult(result)) {
				deferredTaskIds.push(result.taskId);
				reportRouteHealthDeferred(result, onResult, emitStatus);
				continue;
			}

			const resultAttempt = reserveTaskAttempt(
				checkpoint,
				checkpointPath,
				result.taskId,
			);
			enforceQuickCheckCompletion(task, result, resultAttempt, checkpoint);
			persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
			attachRouteHealthTerminal(result, context);
			if (onResult) onResult(result);
			const safeFailure = failureMetadataFor(result, result.partialDiffPath);
			if (emitStatus) {
				if (result.success) {
					emitStatus({
						phase: "execution",
						event: "task_completed",
						status: `Task ${result.taskId} completed`,
						taskId: result.taskId,
						provider: result.provider ?? null,
						model: result.model ?? null,
					});
				} else {
					emitStatus({
						phase: "execution",
						event: "task_failed",
						status: `Task ${result.taskId} failed: ${result.result}`,
						taskId: result.taskId,
						provider: result.provider ?? null,
						model: result.model ?? null,
						error: safeFailure ? { message: safeFailure.reason } : undefined,
						errorKind: safeFailure?.errorKind,
						reasonCode: safeFailure?.reasonCode,
						reason: safeFailure?.reason,
						artifactRef: safeFailure?.artifactRef,
						...(safeFailure?.diagnosticCode
							? { diagnosticCode: safeFailure.diagnosticCode }
							: {}),
						...(safeFailure?.diagnosticOrigin
							? {
									diagnosticOrigin: safeFailure.diagnosticOrigin,
									diagnosticEvidenceAvailable:
										safeFailure.diagnosticEvidenceAvailable,
								}
							: {}),
						...(safeFailure?.diagnosticRef
							? { diagnosticRef: safeFailure.diagnosticRef }
							: {}),
					});
				}
			}

			results.push(result);
			checkpoint.results.push({
				taskId: result.taskId,
				attempt: resultAttempt,
				provider: result.provider,
				model: result.model,
				...(result.invocationDescriptor
					? {
							dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity:
								result.invocationDescriptor.descriptor_identity,
							descriptorHarness: result.descriptorHarness ?? null,
							resolvedTargetId: result.resolvedTargetId ?? null,
						}
					: {}),
				result: result.result,
				...(result.quickCheckReceipt
					? { quickCheckReceipt: result.quickCheckReceipt }
					: {}),
				...(typeof result.servedModelVerified === "boolean"
					? { servedModelVerified: result.servedModelVerified }
					: {}),
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				...(result.cleanupFailed === true
					? {
							cleanupFailed: true,
							cleanupStage: result.cleanupStage ?? null,
						}
					: {}),
				success: result.success,
				dirtyOverlayReceiptHash: result.dirtyOverlayReceiptHash ?? null,
				timedOut: Boolean(result.timedOut),
				partialDiffPath: null,
				...(safeFailure ?? {}),
				...(opaqueArtifactRef(result.artifactRef)
					? { artifactRef: opaqueArtifactRef(result.artifactRef) }
					: {}),
				timestamp: new Date().toISOString(),
			});
			checkpoint.lastTaskId = result.taskId;
			checkpoint.lastUpdatedAt = new Date().toISOString();

			if (result.success) {
				checkpoint.completedTaskIds.push(result.taskId);
			}

			try {
				saveCheckpoint(checkpointPath, checkpoint);
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "checkpoint",
						event: "checkpoint_failed",
						status: `Checkpoint save failed: ${error.message}`,
						taskId: result.taskId,
						error: _safeError(error),
					});
				}
				throw error;
			}
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_saved",
					status: `Checkpoint saved after task ${result.taskId}`,
					taskId: result.taskId,
				});
			}
			if (onCheckpointSaved) onCheckpointSaved();

			// Same INV-6 ordering as runQueue: the checkpoint is on disk before
			// the working-container commit/reset is attempted.
			let haltResult =
				result.cleanupFailed === true ? providerCleanupHalt(result) : null;
			if (!haltResult)
				haltResult = commitOrResetWorkingContainer(result, {
					ownsWorkingContainer,
					workingContainerName,
					stopOnFailure: effectiveStopOnFailure,
					commitWorkingTreeFn: queueBackend.commit,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus,
					logPrefix: "runQueueWithOrchestrator: ",
				});
			if (!haltResult) {
				haltResult = await finalizeTaskBaseAsync(
					context,
					result.taskId,
					checkpoint,
					checkpointPath,
				);
			}
			if (runStore) {
				runStore.updateRun({}).catch(() => {});
			}
			processed += 1;

			// Same INV-3 halt as runQueue: a commit/reset failure makes the
			// container non-reusable, so the run stops before the next task's
			// launch/status/result cycle instead of reusing an unadvanced or
			// un-reset baseline. The completed task's checkpoint stays durable.
			if (haltResult) {
				recordHalt(checkpoint, checkpointPath, results, haltResult, emitStatus);
				halted = true;
				break;
			}

			if (!result.success && effectiveStopOnFailure) {
				break;
			}
		}

		if (emitStatus) {
			emitStatus({
				phase: "lifecycle",
				event: "terminal",
				status: `Queue ${halted ? "halted" : "complete"}: ${processed} tasks processed`,
			});
		}
		if (runStore) {
			const terminalDecision = terminalTransition({
				results,
				totalTasks: tasks.length,
				runnableTasks: initialRunnable.length,
				processedTasks: processed,
				completedTaskIds: checkpoint.completedTaskIds,
				deferredTaskIds,
				failedCount: results.filter((result) => !result.success).length,
			});
			const lastFailed = results.findLast((r) => !r.success);
			const lastFailure = lastFailed
				? failureMetadataFor(lastFailed, lastFailed.partialDiffPath)
				: null;
			const terminalProjection = {
				state: terminalDecision.state,
				activeTaskId: null,
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
				cleanupState: "complete",
				terminalSummary: terminalDecision.terminalSummary,
				terminalizedBy: "worker",
				...(lastFailure ? { lastFailure } : {}),
				...(policyDeferred ? { policyDeferred } : {}),
			};
			try {
				await runStore.updateRun(terminalProjection);
			} catch (error) {
				reportOutcomeProjectionFailure(
					ledgerReportingContext(
						emitStatus,
						dependencies,
						"runQueueWithOrchestrator",
					),
					error,
				);
			}
			// Shadow evidence is strictly additive. Isolate its failure from the
			// legacy terminal update and caller result.
			try {
				await persistCheckpointOutcomeShadow(
					checkpointPath,
					checkpoint,
					runStore,
					runId,
				);
			} catch {
				// Best effort only: release below still completes the legacy path.
			}
		}

		// Guarantee a checkpoint file exists at the path this return value
		// reports, even when the per-task loop above never ran (e.g. every
		// task was already completed by a prior checkpoint) — the caller must
		// never be handed a checkpointPath with nothing on disk behind it.
		// A halt entry was already persisted by recordHalt before the
		// queue_halted event fired; this final save is a no-op for that entry
		// and remains for the other fields/zero-runnable path.
		if (checkpoint.version === CHECKPOINT_VERSION)
			releaseCheckpointOwnership(checkpointPath, checkpoint);

		return {
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			deferredTaskIds,
			lastTaskId: checkpoint.lastTaskId,
			checkpointPath,
			...(identity.enabled
				? {
						queueIdentity: identity.queueIdentity,
						runOptions: identity.runOptions,
						projectRevision: identity.projectRevision,
					}
				: {}),
			results,
			...(policyDeferred ? { policyDeferred } : {}),
		};
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		try {
			if (ownsWorkingContainer) {
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_started",
						status: "Wiping working container",
					});
				}
				try {
					try {
						queueBackend.beforeRemove?.(workingContainerName, projectPath);
					} catch (hookError) {
						console.error(
							`runQueueWithOrchestrator: before_remove hook failed: ${hookError.message}`,
						);
					}
					queueBackend.destroy(workingContainerName);
					if (emitStatus) {
						emitStatus({
							phase: "cleanup",
							event: "cleanup_complete",
							status: "Cleanup complete",
						});
					}
				} catch (error) {
					if (emitStatus) {
						emitStatus({
							phase: "cleanup",
							event: "cleanup_failed",
							status: `Cleanup failed: ${error.message}`,
							error: _safeError(error),
						});
					}
					// biome-ignore lint/correctness/noUnsafeFinally: re-throwing the same error the bare wipe call would throw
					throw error;
				}
			}
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
		}
	}
}
export async function runQueueAsync(options) {
	let failed = true;
	try {
		const result = await runQueueAsyncImpl(options);
		failed = false;
		return result;
	} finally {
		if (failed) reportCheckpointReleaseFailure(options);
	}
}
export function runQueue(options) {
	let failed = true;
	try {
		const result = runQueueImpl(options);
		failed = false;
		return result;
	} finally {
		if (failed) reportCheckpointReleaseFailure(options);
	}
}
export async function runQueueWithOrchestrator(options) {
	let failed = true;
	try {
		const result = await runQueueWithOrchestratorImpl(options);
		failed = false;
		return result;
	} finally {
		if (failed) reportCheckpointReleaseFailure(options);
	}
}
export function runProjectQueue(
	projectRoot,
	tasksFileName,
	workingContainerName,
) {
	return runQueue({
		tasksFilePath: join(projectRoot, tasksFileName),
		projectPath: projectRoot,
		workingContainerName,
	});
}
export { CHECKPOINT_VERSION };

import "./constants.mjs";
import "./checkpoint-errors.mjs";
import "./task-fields.mjs";
import "./task-queue.mjs";
import "./ledger-reporting.mjs";
import "./review-results.mjs";
import "./quick-checks.mjs";
import "./checkpoint-store.mjs";
import "./checkpoint-load.mjs";
import {
	assertCommittedDeclaredFiles,
	CallerInputValidationError,
	CallerInputValidationUnavailableError,
	CHECKPOINT_IDENTITY_CODES,
	CHECKPOINT_IDENTITY_REMEDIES,
	CheckpointIdentityError,
	getProjectRevision,
	QueueCleanupError,
	relativeProjectPath,
	resolveQueueIdentity,
	sleep,
	TaskSelectionError,
} from "./checkpoint-errors.mjs";
import {
	claimCheckpointOwnership,
	loadCheckpoint,
	reportCheckpointReleaseFailure,
	validateCheckpointV3,
} from "./checkpoint-load.mjs";
import {
	acquireCheckpointLease,
	assertCheckpointLease,
	checkpointOwnerFor,
	createEmptyCheckpoint,
	getCheckpointPath,
	releaseCheckpointLease,
	releaseCheckpointOwnership,
	sameCheckpointOwner,
	saveCheckpoint,
	validateCheckpointTaskBases,
} from "./checkpoint-store.mjs";
import {
	BOUNDED_ERROR_KINDS,
	CHECKPOINT_VERSION,
	createQueueIdentity,
	DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
	EXTERNAL_COMPLETION_MAX_RECEIPT_BYTES,
	EXTERNAL_COMPLETION_VERSION,
	KNOWN_TASK_STATUSES,
	normalizeIds,
	normalizeQueuePlatform,
	normalizeRunOptions,
	ORCHESTRATOR_PAYLOAD_VERSION,
	RECONCILIATION_INTENT_MAX_BYTES,
	RECONCILIATION_INTENT_STATES,
	RECONCILIATION_INTENT_VERSION,
	RUNNABLE_TASK_STATUSES,
	stableStringify,
	TERMINAL_JOB_STATES,
	VM_SLOT_WAIT_INTERVAL_MS,
	VM_SLOT_WAIT_TIMEOUT_MS,
} from "./constants.mjs";
import {
	DESCRIPTOR_RECEIPT_INVALID_REASON,
	descriptorFromRoute,
	descriptorReceiptFields,
	dispatchIntentPayload,
	ledgerReportingContext,
	reportLegacyProjectionFailure,
	reportOutcomeProjectionFailure,
	resolveOrchestrator,
	safeNoProviderReason,
	safeSuccessfulRouteReason,
	writeDispatchIntent,
	writeDispatchIntentAsync,
} from "./ledger-reporting.mjs";
import {
	assertCompletedQuickChecks,
	ensureRetryCheckpoint,
	failureMetadataFor,
	hasTrustedQuotaRetryEvidence,
	normalizeRetryTargetId,
	quickCheckDecision,
	quickCheckDecisionAsync,
	validateRetryDescriptorEvidence,
} from "./quick-checks.mjs";
import {
	captureDiffWithEvidence,
	captureDiffWithEvidenceAsync,
	integrationOperation,
	isStructuredReviewExecution,
	normalizeSynchronousProviderExecution,
	opaqueArtifactRef,
	persistedTaskBaseHelperContext,
	retainsFailureDiff,
	reviewFailureFields,
	reviewTaskResult,
	servedModelVerificationFields,
	survivingProviderFields,
	taskBaseProbeOptions,
} from "./review-results.mjs";
import { validateProjectFileEntries } from "./task-fields.mjs";
import {
	computeQueueIdentityFromFile,
	loadTaskQueue,
	parseTaskQueue,
	validateTaskGraph,
} from "./task-queue.mjs";

export {
	CallerInputValidationError,
	CHECKPOINT_IDENTITY_CODES,
	CHECKPOINT_IDENTITY_REMEDIES,
	CheckpointHistoricalCheckpointError,
	CheckpointIdentityError,
	CheckpointMissingQueueIdentityError,
	CheckpointQueueIdentityMismatchError,
	CheckpointRunOptionsMismatchError,
	CheckpointTaskFileMismatchError,
	getProjectRevision,
	IntegrationStateUnknownError,
	QueueCleanupError,
	TaskSelectionError,
} from "./checkpoint-errors.mjs";
export {
	claimCheckpointOwnership,
	loadCheckpoint,
	migrateLegacyCheckpoint,
} from "./checkpoint-load.mjs";
export {
	acquireCheckpointLease,
	createEmptyCheckpoint,
	getCheckpointPath,
	releaseCheckpointLease,
	releaseCheckpointOwnership,
	saveCheckpoint,
} from "./checkpoint-store.mjs";
export {
	createQueueIdentity,
	DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
	normalizeQueuePlatform,
	normalizeRunOptions,
	ORCHESTRATOR_PAYLOAD_VERSION,
	QUEUE_PLATFORMS,
} from "./constants.mjs";
export {
	createCliOrchestrator,
	resolveOrchestrator,
	writeDispatchIntent,
	writeDispatchIntentAsync,
} from "./ledger-reporting.mjs";
export { validateProjectFileEntries } from "./task-fields.mjs";
export {
	computeQueueIdentityFromFile,
	loadTaskQueue,
	parseTaskQueue,
	validateTaskGraph,
} from "./task-queue.mjs";

import "./reconciliation-intent.mjs";
import "./reconciliation-validate.mjs";
import "./external-completion.mjs";
import "./artifacts.mjs";
import "./queue-selection.mjs";
import "./caller-inputs.mjs";
import "./task-routing.mjs";
import "./route-health.mjs";
import "./task-base.mjs";
import {
	boundedGateEvidence,
	persistAsyncResultArtifacts,
	reserveTaskAttempt,
	saveGateEvidence,
	savePartialDiff,
} from "./artifacts.mjs";
import {
	getRunnableTasks,
	planPotentialAttemptTasks,
	reconcileAlreadyCompleteSelection,
	selectNextQueueTask,
} from "./queue-selection.mjs";
import { hashBytes } from "./reconciliation-intent.mjs";
import {
	attachRouteHealthTerminal,
	bindAttemptExecutionBackend,
	bindAttemptHelperBackend,
	executionCleanupContext,
	healthDeferredResult,
	isRouteHealthDeferredResult,
	mergeAttemptCleanupContext,
	policyDeferredQueueResult,
	policyDeferredTaskResult,
	prepareRouteHealthTrial,
	readQueueHostPower,
	reportRouteHealthDeferred,
	startRouteHealthTrial,
} from "./route-health.mjs";
import {
	assertCheckpointRecoverySafe,
	checkpointIntegrationIntent,
	finalizeTaskBase,
	finalizeTaskBaseAsync,
	persistProviderCleanupUncertain,
	prepareTaskBase,
	prepareTaskBaseAsync,
	providerCleanupHalt,
	taskBaseFailure,
	taskBaseMatches,
} from "./task-base.mjs";
import {
	declaredPathNotSeededResult,
	decorateDirtyOverlayResult,
	dirtyOverlayIntegrationGate,
	dirtyOverlayResult,
	findIgnoredDeclaredPath,
	nonSwitchyardExecutorResult,
	resolveTaskExecutor,
	resolveTaskRequiredCapability,
	selectAdapter,
	waitForJobCompletion,
} from "./task-routing.mjs";

export { persistAsyncResultArtifacts } from "./artifacts.mjs";
export { validateCallerInputs } from "./caller-inputs.mjs";
export { reconcileExternalCompletion } from "./external-completion.mjs";
export {
	deriveQueueDiagnostics,
	getRunnableTasks,
	planPotentialAttemptTasks,
	selectNextQueueTask,
	validateTaskSelection,
} from "./queue-selection.mjs";
export { isRouteHealthDeferredResult } from "./route-health.mjs";
export {
	findIgnoredDeclaredPath,
	parseExpectedBy,
	waitForJobCompletion,
} from "./task-routing.mjs";
