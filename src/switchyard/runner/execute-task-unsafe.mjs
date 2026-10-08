import { boundCompletionContinuationProof } from "../adapter/provider-lifecycle.mjs";
import { runQuickChecks } from "./checks.mjs";
import { handleExecuteTaskUnsafeFailure } from "./execute-task-unsafe-failure.mjs";
import { prepareExecuteTaskUnsafe } from "./execute-task-unsafe-prepare.mjs";
import { completeExecuteTaskUnsafe } from "./execute-task-unsafe-success.mjs";
import { descriptorReceiptFields } from "./ledger-reporting.mjs";
import { baselineReceiptMatchesPin } from "./quick-checks.mjs";
import {
	createTaskProviderPin,
	providerRepairLifecycleSafe,
	runTaskBaselineChecks,
	taskRepairScopeIdentity,
} from "./reliability.mjs";
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
	if (
		context._checkRepairPin &&
		(!providerRepairLifecycleSafe(task, context, context._checkRepairPin) ||
			cleanupContext.attemptId !== context._checkRepairPin.attemptId)
	) {
		return taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const baselinePin = context._checkRepairPin ?? context._completionPin;
	if (
		baselinePin &&
		(task.quickChecks?.baselineChecks?.length ?? 0) > 0 &&
		!baselineReceiptMatchesPin(task, baselinePin, context._baselineCheckReceipt)
	) {
		return taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const baseline =
		baselinePin && (task.quickChecks?.baselineChecks?.length ?? 0) === 0
			? null
			: baselinePin &&
					baselineReceiptMatchesPin(
						task,
						baselinePin,
						context._baselineCheckReceipt,
					)
				? null
				: runTaskBaselineChecks(task, context, runQuickChecks);
	if (baseline) {
		context._baselineCheckReceipt = baseline.receipt;
		if (!baseline.passed) {
			const result = baseline.mutation
				? "baseline_mutation"
				: "baseline_check_failed";
			record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result,
				errorKind: "check_failed",
				reason: "baseline checks did not pass on the captured task base",
				failurePhase: "baseline",
				providerReliability: baseline.diagnostic,
			});
			return {
				...descriptorReceiptFields(invocationDescriptor),
				taskId: task.id,
				success: false,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
				requiredCapability,
				resolvedTargetId,
				result,
				errorKind: "check_failed",
				reason: "baseline checks did not pass on the captured task base",
				failurePhase: "baseline",
				providerLifecycle: null,
				providerReliability: baseline.diagnostic,
				...(baseline.receipt ? { baselineCheckReceipt: baseline.receipt } : {}),
			};
		}
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
	if (baselinePin) {
		if (
			baselinePin.taskId !== task.id ||
			baselinePin.workspaceId !== context.workingContainerName ||
			baselinePin.baseTree !== context._activeTaskBase?.tree ||
			baselinePin.attemptId !== cleanupContext.attemptId ||
			baselinePin.deadline !== executionBudget.deadline ||
			baselinePin.scopeIdentity !== taskRepairScopeIdentity(task) ||
			baselinePin.provider !== routeResult.provider ||
			baselinePin.resolvedTargetId !== resolvedTargetId ||
			baselinePin.descriptorIdentity !==
				invocationDescriptor.descriptor_identity ||
			baselinePin.selector !== invocationDescriptor.selector
		) {
			return taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
		}
	} else {
		context._activeCompletionPin = createTaskProviderPin(
			task,
			context,
			routeResult,
			invocationDescriptor,
			cleanupContext.attemptId,
			executionBudget.deadline,
		);
	}
	const captureExecutionBackend = bindAttemptHelperBackend(
		context.executionBackend,
		cleanupContext,
	);
	const launchBudget = taskExecutionBudget(context, task);
	const launchTimeoutMs = Math.floor(
		Math.min(
			launchBudget.remainingMs,
			context._checkRepairPin
				? (context._checkRepairBudget?.providerTimeoutMs ?? 0)
				: Number.POSITIVE_INFINITY,
		),
	);
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
			errorKind: "execution_timed_out",
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
