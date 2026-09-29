import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import { verifyCompletionContinuationSync } from "../adapter/provider-lifecycle.mjs";
import { projectOutcomeReader } from "../outcome/projection.mjs";
import { validateShadowEnvelope } from "../outcome/shadow.mjs";
import {
	artifactTransition,
	integrationTransition,
} from "../outcome/transitions.mjs";
import { saveCheckpoint } from "./checkpoint-store.mjs";
import { BOUNDED_ERROR_KINDS } from "./constants.mjs";
import { executeTaskAsyncUnsafe } from "./execute-task-async-unsafe.mjs";
import { executeTaskUnsafe } from "./execute-task-unsafe.mjs";
import { emitStageOutcome } from "./outcome-writer.mjs";
import {
	allocateExtraProviderInvocation,
	completionContinuationCandidate,
	completionLifecycleContext,
	machineMissingRequirements,
	recordExtraProviderInvocation,
	taskExecutionBudget,
} from "./retry-transitions.mjs";
import { attachRouteHealthTerminal } from "./route-health.mjs";
import {
	decorateDirtyOverlayResult,
	resolveTaskRequiredCapability,
} from "./task-routing.mjs";

const ROUTE_HEALTH_RESULT_FIELDS = Object.freeze([
	"_routeHealthTrialStarted",
	"routeHealthBinding",
	"routeHealthAttempt",
]);

function projectTaskResult(result, extra = {}) {
	const projected = { ...result, ...extra };
	for (const field of ROUTE_HEALTH_RESULT_FIELDS) {
		const descriptor = Object.getOwnPropertyDescriptor(result, field);
		if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
		Object.defineProperty(projected, field, {
			value: descriptor.value,
			enumerable: false,
		});
	}
	return projected;
}

export function runCompletionCorrection(
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

export function executeTask(task, context) {
	context._activeRouteHealth = null;
	context._activeProviderExecutionSucceeded = false;
	context._activeCompletionLifecycleReceipt = null;
	if (!context._completionPin) {
		if (!context._checkRepairPin && !context._completionPin)
			context._baselineCheckReceipt = null;
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
	return projectTaskResult(result, {
		...(context._baselineCheckReceipt
			? { baselineCheckReceipt: context._baselineCheckReceipt }
			: {}),
	});
}

export async function executeTaskAsync(task, context) {
	if (!context._checkRepairPin && !context._completionPin)
		context._baselineCheckReceipt = null;
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
		const withBaseline = projectTaskResult(result, {
			...(context._baselineCheckReceipt
				? { baselineCheckReceipt: context._baselineCheckReceipt }
				: {}),
		});
		await emitTaskStageOutcomes(context, task, withBaseline);
		return withBaseline;
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

export async function emitTaskStageOutcomes(context, task, result) {
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

export function clearAsyncTaskContext(context) {
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

export async function persistCheckpointOutcomeShadow(
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

export function asyncExecutionFailureMetadata(error, taskId) {
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
