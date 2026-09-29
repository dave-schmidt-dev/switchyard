import {
	boundCompletionContinuationProof,
	boundProviderLifecycleSnapshot,
	createProgressSnapshot,
	DEFAULT_SILENCE_TIMEOUT_MS,
	verifyCompletionContinuationSync,
} from "../adapter/provider-lifecycle.mjs";
import { handleExecuteTaskUnsafeFailure } from "./execute-task-unsafe-failure.mjs";
import { prepareExecuteTaskUnsafe } from "./execute-task-unsafe-prepare.mjs";
import { completeExecuteTaskUnsafe } from "./execute-task-unsafe-success.mjs";
import { descriptorReceiptFields } from "./ledger-reporting.mjs";
import {
	integrationFailureMetadata,
	taskExecutionBudget,
} from "./retry-transitions.mjs";
import {
	isStructuredReviewExecution,
	normalizeSynchronousProviderExecution,
	reviewTaskResult,
	survivingProviderFields,
} from "./review-results.mjs";
import {
	bindAttemptExecutionBackend,
	bindAttemptHelperBackend,
	executionCleanupContext,
	healthDeferredResult,
	prepareRouteHealthTrial,
	startRouteHealthTrial,
} from "./route-health.mjs";
import { prepareTaskBase, taskBaseFailure } from "./task-base.mjs";

export function executeTaskUnsafe(task, context) {
	const prepared = prepareExecuteTaskUnsafe(task, context);
	if (prepared.terminal !== null) return prepared.terminal;
	const {
		adapter,
		executionBudget,
		prompt,
		projectionFailure,
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

	if (!execution.success)
		return handleExecuteTaskUnsafeFailure(task, context, record, execution, {
			adapter,
			captureExecutionBackend,
			invocationDescriptor,
			requiredCapability,
			resolvedTargetId,
			routeResult,
		});

	return completeExecuteTaskUnsafe(task, context, record, execution, {
		adapter,
		captureExecutionBackend,
		integrationFailureMetadata,
		invocationDescriptor,
		projectionFailure,
		requiredCapability,
		resolvedTargetId,
		routeResult,
	});
}
