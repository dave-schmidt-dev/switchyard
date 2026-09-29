import {
	boundCompletionContinuationProof,
	boundProviderLifecycleSnapshot,
	createProgressSnapshot,
	DEFAULT_SILENCE_TIMEOUT_MS,
	verifyCompletionContinuationSync,
} from "../adapter/provider-lifecycle.mjs";
import { registerBrokerExecutionPolicy } from "../broker/executor.mjs";
import { HOST_POWER_STATES, readHostPower } from "../dispatch/host-power.mjs";
import {
	getConfiguredInvocationDescriptor,
	getInvocationDescriptor,
	normalizeProviderName,
	resolveRouteProvenance,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import { handleExecuteTaskAsyncUnsafeFailure } from "./execute-task-async-unsafe-failure.mjs";
import { prepareExecuteTaskAsyncUnsafe } from "./execute-task-async-unsafe-prepare.mjs";
import { completeExecuteTaskAsyncUnsafe } from "./execute-task-async-unsafe-success.mjs";
import {
	descriptorFromRoute,
	descriptorReceiptFields,
	dispatchIntentPayload,
	writeDispatchIntentAsync,
} from "./ledger-reporting.mjs";
import {
	brokerFailureKind,
	mergeBrokerRouteProvenance,
	normalizeBrokerRoute,
} from "./outcome-writer.mjs";
import {
	isStructuredReviewExecution,
	reviewTaskResult,
	survivingProviderFields,
} from "./review-results.mjs";
import {
	executionCleanupContext,
	healthDeferredResult,
	mergeAttemptCleanupContext,
	policyDeferredTaskResult,
	prepareRouteHealthTrial,
	readQueueHostPower,
	startRouteHealthTrial,
} from "./route-health.mjs";
import { prepareTaskBaseAsync, taskBaseFailure } from "./task-base.mjs";
import { selectAdapter } from "./task-routing.mjs";

export async function executeTaskAsyncUnsafe(task, context) {
	const prepared = await prepareExecuteTaskAsyncUnsafe(task, context);
	if (prepared.terminal !== null) return prepared.terminal;
	let {
		adapter,
		broker,
		brokerRequest,
		provenance,
		releaseSelected,
		routeCapability,
		selectedRoute,
		timeoutMs,
		requiredCapability,
		routeResult,
		invocationDescriptor,
		resolvedTargetId,
		routedModel,
		record,
	} = prepared.state;
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
	if (!execution.success)
		return await handleExecuteTaskAsyncUnsafeFailure(
			task,
			context,
			record,
			execution,
			{
				adapter,
				attemptCleanupContext,
				invocationDescriptor,
				requiredCapability,
				resolvedTargetId,
				routeResult,
			},
		);
	return await completeExecuteTaskAsyncUnsafe(
		task,
		context,
		record,
		execution,
		{
			adapter,
			attemptCleanupContext,
			invocationDescriptor,
			requiredCapability,
			resolvedTargetId,
			routeResult,
		},
	);
}
