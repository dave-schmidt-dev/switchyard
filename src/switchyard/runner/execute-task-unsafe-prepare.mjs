import { HOST_POWER_STATES } from "../dispatch/host-power.mjs";
import {
	getConfiguredInvocationDescriptor,
	getInvocationDescriptor,
	resolveRouteProvenance,
} from "../roster/index.mjs";
import {
	DESCRIPTOR_RECEIPT_INVALID_REASON,
	descriptorFromRoute,
	descriptorReceiptFields,
	dispatchIntentPayload,
	reportLegacyProjectionFailure,
	safeNoProviderReason,
	safeSuccessfulRouteReason,
	writeDispatchIntent,
} from "./ledger-reporting.mjs";
import { taskRepairScopeIdentity } from "./reliability.mjs";
import {
	initializeTaskExecutionBudget,
	taskExecutionBudget,
	taskPromptForAttempt,
} from "./retry-transitions.mjs";
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

export function prepareExecuteTaskUnsafe(task, context) {
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return {
			terminal: nonSwitchyardExecutorResult(task, executor, requiredCapability),
		};
	}
	const overlayFailure = dirtyOverlayResult(task, context, requiredCapability);
	if (overlayFailure) return { terminal: overlayFailure };
	// Primary and quota-fallback invocations each own their configured timeout.
	// A pinned continuation must retain the original absolute deadline.
	const providerPin = context._checkRepairPin ?? context._completionPin;
	if (!providerPin) initializeTaskExecutionBudget(context, task);
	else {
		const budget = context._activeTaskBudget;
		const remaining =
			budget?.taskId === task.id
				? taskExecutionBudget(context, task).remainingMs
				: 0;
		if (
			providerPin.taskId !== task.id ||
			providerPin.scopeIdentity !== taskRepairScopeIdentity(task) ||
			providerPin.workspaceId !== context.workingContainerName ||
			providerPin.deadline !== budget?.deadline ||
			(context._checkRepairPin &&
				(!Number.isSafeInteger(context._checkRepairBudget?.providerTimeoutMs) ||
					context._checkRepairBudget.providerTimeoutMs < 30_000)) ||
			!Number.isFinite(remaining) ||
			remaining <= 0
		) {
			return {
				terminal: {
					taskId: task.id,
					success: false,
					provider: providerPin.provider ?? null,
					model: providerPin.selector ?? null,
					resolvedTargetId: providerPin.resolvedTargetId ?? null,
					result:
						remaining <= 0 ? "execution_timed_out" : "check_repair_ineligible",
					errorKind: remaining <= 0 ? "execution_timed_out" : "unknown_failure",
					timedOut: remaining <= 0,
				},
			};
		}
	}
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
	const routeResult = providerPin
		? structuredClone(providerPin.route)
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
		invocationDescriptor = providerPin
			? structuredClone(providerPin.invocationDescriptor)
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
			terminal: {
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
			},
		};
	}
	Object.assign(routeResult, descriptorReceiptFields(invocationDescriptor));
	context._activeInvocationDescriptor = invocationDescriptor;
	if (
		providerPin &&
		(routeResult.provider !== providerPin.provider ||
			routeResult.resolvedTargetId !== providerPin.resolvedTargetId ||
			invocationDescriptor.descriptor_identity !==
				providerPin.descriptorIdentity ||
			invocationDescriptor.selector !== providerPin.selector)
	) {
		return {
			terminal: {
				taskId: task.id,
				success: false,
				provider: providerPin.provider ?? null,
				model: providerPin.selector ?? null,
				resolvedTargetId: providerPin.resolvedTargetId ?? null,
				result: "check_repair_ineligible",
				errorKind: "unknown_failure",
			},
		};
	}
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
			terminal: {
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

	// A task's own `Timeout:` field (runner/index.mjs parseTimeoutField)
	// overrides the global default for tasks known to legitimately need more
	// (or less) than PROVIDER_EXECUTION_TIMEOUT_MS.
	const executionBudget = taskExecutionBudget(context, task);
	const timeoutMs = Math.floor(
		Math.min(
			executionBudget.remainingMs,
			context._checkRepairPin
				? context._checkRepairBudget.providerTimeoutMs
				: Number.POSITIVE_INFINITY,
		),
	);
	if (timeoutMs <= 0) {
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

	const prompt = taskPromptForAttempt(task, context._completionRequirements);
	return {
		terminal: null,
		state: {
			adapter,
			executionBudget,
			prompt,
			projectionFailure,
			requiredCapability,
			routeResult,
			invocationDescriptor,
			resolvedTargetId,
			routedModel: routeResult.model ?? null,
			record,
		},
	};
}
