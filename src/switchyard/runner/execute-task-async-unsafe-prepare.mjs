import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../adapter/constants.mjs";
import { HOST_POWER_STATES, readHostPower } from "../dispatch/host-power.mjs";
import {
	getConfiguredInvocationDescriptor,
	getInvocationDescriptor,
	normalizeProviderName,
	resolveRouteProvenance,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import { brokerRequestForTask, createDispatchBroker } from "./broker.mjs";
import {
	DESCRIPTOR_RECEIPT_INVALID_REASON,
	descriptorFromRoute,
	descriptorReceiptFields,
	dispatchIntentPayload,
	safeNoProviderReason,
	safeSuccessfulRouteReason,
	writeDispatchIntentAsync,
} from "./ledger-reporting.mjs";
import {
	mergeBrokerRouteProvenance,
	normalizeBrokerRoute,
} from "./outcome-writer.mjs";
import { taskPromptForAttempt } from "./retry-transitions.mjs";
import {
	policyDeferredTaskResult,
	readQueueHostPower,
} from "./route-health.mjs";
import {
	declaredPathNotSeededResult,
	dirtyOverlayResult,
	findIgnoredDeclaredPath,
	nonSwitchyardExecutorResult,
	resolveTaskExecutor,
	resolveTaskRequiredCapability,
	selectAdapter,
} from "./task-routing.mjs";

export async function prepareExecuteTaskAsyncUnsafe(task, context) {
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return {
			terminal: nonSwitchyardExecutorResult(task, executor, requiredCapability),
		};
	}
	const overlayFailure = dirtyOverlayResult(task, context, requiredCapability);
	if (overlayFailure) return { terminal: overlayFailure };
	const checkIgnored = context.checkIgnoredPath ?? findIgnoredDeclaredPath;
	const ignoredPath = checkIgnored(
		task.requiredPaths ?? task.files,
		context.projectPath,
	);
	if (ignoredPath) {
		return { terminal: declaredPathNotSeededResult(task, requiredCapability) };
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
		return {
			terminal: policyDeferredTaskResult(
				task,
				hostPower,
				context.taskFileSha256,
			),
		};
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
	const selectedRoute = await broker.selectAndReserve(brokerRequest);
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
	const routeResult = normalizeBrokerRoute(selectedRoute);
	context._activeTaskRoute = routeResult;
	const routeCapability = selectedRoute.capability;
	const provenance = resolveRouteProvenance(
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
			terminal: {
				taskId: task.id,
				success: false,
				provider: routeResult.provider ?? null,
				model: routeResult.model ?? null,
				requiredCapability,
				resolvedTargetId: routeResult.resolvedTargetId ?? null,
				result: "descriptor_receipt_invalid",
				errorKind: "descriptor_receipt",
				reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
			},
		};
	}
	Object.assign(routeResult, descriptorReceiptFields(invocationDescriptor));
	context._activeInvocationDescriptor = invocationDescriptor;
	const resolvedTargetId = routeResult.resolvedTargetId ?? null;
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
			terminal: {
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
			},
		};
	}
	const adapter = selectAdapter(
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
			terminal: {
				...descriptorReceiptFields(invocationDescriptor),
				taskId: task.id,
				success: false,
				provider: routeResult.provider,
				model: invocationDescriptor.selector,
				requiredCapability,
				resolvedTargetId,
				result: "unsupported_provider",
			},
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
			terminal: {
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
			},
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
			terminal: {
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
			},
		};
	}
	return {
		terminal: null,
		state: {
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
			routedModel: routeResult.model ?? null,
			record,
		},
	};
}
