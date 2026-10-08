import { descriptorReceiptFields } from "./ledger-reporting.mjs";
import { baselineReceiptMatchesPin } from "./quick-checks.mjs";
import {
	createTaskProviderPin,
	providerRepairLifecycleSafe,
	runTaskBaselineChecksAsync,
	taskRepairScopeIdentity,
} from "./reliability.mjs";
import {
	healthDeferredResult,
	prepareRouteHealthTrial,
	startRouteHealthTrial,
} from "./route-health.mjs";
import { taskBaseFailure } from "./task-base.mjs";

/**
 * Validate a pinned continuation, run its baseline checks, and start the
 * provider health trial only after the captured base is proven unchanged.
 */
export async function prepareAsyncProviderInvocation({
	task,
	context,
	routeResult,
	invocationDescriptor,
	resolvedTargetId,
	requiredCapability,
	selectedRoute,
	releaseSelected,
	record,
	attemptCleanupContext,
	timeoutMs,
	runQuickChecksAsync,
}) {
	const failBase = () =>
		taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	if (
		context._checkRepairPin &&
		(!providerRepairLifecycleSafe(task, context, context._checkRepairPin) ||
			attemptCleanupContext.attemptId !== context._checkRepairPin.attemptId)
	) {
		await releaseSelected(selectedRoute);
		return { terminal: failBase() };
	}
	const completionPin = context._completionPin;
	if (
		completionPin &&
		(completionPin.taskId !== task.id ||
			completionPin.workspaceId !== context.workingContainerName ||
			completionPin.baseTree !== context._activeTaskBase?.tree ||
			completionPin.attemptId !== attemptCleanupContext.attemptId ||
			completionPin.descriptorIdentity !==
				invocationDescriptor.descriptor_identity ||
			completionPin.scopeIdentity !== taskRepairScopeIdentity(task) ||
			completionPin.provider !== routeResult.provider ||
			completionPin.resolvedTargetId !== resolvedTargetId ||
			completionPin.selector !== invocationDescriptor.selector)
	) {
		await releaseSelected(selectedRoute);
		return { terminal: failBase() };
	}
	const baselinePin = context._checkRepairPin ?? completionPin;
	if (
		baselinePin &&
		(task.quickChecks?.baselineChecks?.length ?? 0) > 0 &&
		!baselineReceiptMatchesPin(task, baselinePin, context._baselineCheckReceipt)
	) {
		await releaseSelected(selectedRoute);
		return { terminal: failBase() };
	}
	const baseline =
		baselinePin &&
		((task.quickChecks?.baselineChecks?.length ?? 0) === 0 ||
			baselineReceiptMatchesPin(
				task,
				baselinePin,
				context._baselineCheckReceipt,
			))
			? null
			: await runTaskBaselineChecksAsync(task, context, runQuickChecksAsync);
	if (baseline) {
		context._baselineCheckReceipt = baseline.receipt;
		if (!baseline.passed) {
			const result = baseline.mutation
				? "baseline_mutation"
				: "baseline_check_failed";
			await record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result,
				errorKind: "check_failed",
				reason: "baseline checks did not pass on the captured task base",
				failurePhase: "baseline",
				providerReliability: baseline.diagnostic,
			});
			await releaseSelected(selectedRoute);
			return {
				terminal: {
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
					...(baseline.receipt
						? { baselineCheckReceipt: baseline.receipt }
						: {}),
				},
			};
		}
	}
	if (baselinePin) {
		const remainingMs = Date.parse(baselinePin.deadline) - Date.now();
		if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
			await releaseSelected(selectedRoute);
			return {
				terminal: {
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
				},
			};
		}
		timeoutMs = Math.min(timeoutMs, Math.floor(remainingMs));
		context._activeTaskTimeoutMs = timeoutMs;
		context._activeTaskDeadline = baselinePin.deadline;
	}
	const healthPreparation = prepareRouteHealthTrial(
		context,
		task,
		routeResult,
		invocationDescriptor,
	);
	if (!healthPreparation.allowed) {
		await releaseSelected(selectedRoute);
		return {
			terminal: healthDeferredResult(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			),
		};
	}
	const healthStart = startRouteHealthTrial(context);
	if (!healthStart.allowed) {
		await releaseSelected(selectedRoute);
		return {
			terminal: healthDeferredResult(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			),
		};
	}
	if (!context._checkRepairPin && !context._completionPin) {
		context._activeCompletionPin = createTaskProviderPin(
			task,
			context,
			routeResult,
			invocationDescriptor,
			attemptCleanupContext.attemptId,
			context._activeTaskDeadline,
		);
	}
	return { terminal: null, timeoutMs };
}
