import { HOST_POWER_STATES, readHostPower } from "../dispatch/host-power.mjs";
import {
	acquireHalfOpenClaimSync,
	createRouteHealthTerminalBinding,
	releaseHalfOpenClaimSync,
	startHalfOpenClaimSync,
} from "../router/health.mjs";
import { releaseCheckpointOwnership } from "./checkpoint-store.mjs";
import { descriptorReceiptFields } from "./ledger-reporting.mjs";

function executionCleanupContext(
	context,
	task,
	descriptorIdentity,
	attemptId = null,
) {
	return Object.freeze({
		runId: context.runId,
		taskId: String(task.id),
		// The lifecycle receipt is matched against the route-health binding by
		// attempt id, so both must derive it from the same checkpoint state.
		attemptId:
			attemptId ??
			context.attemptId ??
			routeHealthAttemptId(context, String(task.id)),
		descriptorIdentity,
		workspaceId: context.workingContainerName,
		processStartIdentity: context.processStartIdentity ?? null,
		operation: "provider",
	});
}
function mergeAttemptCleanupContext(bound, supplied = null) {
	if (!bound) return supplied ? Object.freeze({ ...supplied }) : null;
	const immutable = Object.freeze({ ...bound });
	if (!supplied) return immutable;
	for (const field of [
		"runId",
		"taskId",
		"attemptId",
		"descriptorIdentity",
		"workspaceId",
		"processStartIdentity",
	]) {
		if (field in supplied && supplied[field] !== immutable[field]) {
			throw new Error(`contradictory cleanup context ${field}`);
		}
	}
	const operation = supplied.operation ?? immutable.operation;
	if (!["provider", "helper"].includes(operation)) {
		throw new Error("cleanup context operation must be provider or helper");
	}
	if (immutable.operation === "helper" && operation !== "helper") {
		throw new Error("helper cleanup context cannot become provider context");
	}
	return Object.freeze({ ...immutable, operation });
}
function bindAttemptExecutionBackend(executionBackend, cleanupContext) {
	if (!executionBackend || typeof executionBackend !== "object")
		return executionBackend;
	const bound = Object.freeze({ ...cleanupContext });
	return new Proxy(executionBackend, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property === "execArgv") {
				return (workspaceId, options = {}) => {
					if (workspaceId !== bound.workspaceId) {
						throw new Error("contradictory cleanup context workspaceId");
					}
					return Reflect.apply(value, target, [
						workspaceId,
						{
							...options,
							cleanupContext: mergeAttemptCleanupContext(
								bound,
								options.cleanupContext,
							),
						},
					]);
				};
			}
			if (property === "cleanupProviderProcess") {
				return (command, args, options = {}) => {
					if (
						options.workspaceId !== undefined &&
						options.workspaceId !== bound.workspaceId
					) {
						throw new Error("contradictory cleanup context workspaceId");
					}
					return Reflect.apply(value, target, [
						command,
						args,
						{
							...options,
							workspaceId: bound.workspaceId,
							...mergeAttemptCleanupContext(bound, options),
						},
					]);
				};
			}
			return value.bind(target);
		},
	});
}
function bindAttemptHelperBackend(executionBackend, cleanupContext) {
	return bindAttemptExecutionBackend(
		executionBackend,
		mergeAttemptCleanupContext(cleanupContext, { operation: "helper" }),
	);
}
function routeHealthAttemptId(context, taskId) {
	if (context.healthAttempt !== undefined) return context.healthAttempt;
	const retryState = context.checkpoint?.retryState;
	if (
		retryState?.taskId === taskId &&
		Number.isSafeInteger(retryState.attempt) &&
		retryState.attempt > 0
	)
		return `attempt-${retryState.attempt}`;
	// A completion correction is the same attempt continuing, not a second
	// one: its allocation must not move the binding or the cleanup context
	// to attempt-2, or the continuation's lifecycle receipt can never match.
	const allocation = context.checkpoint?.providerAttemptAllocations?.find(
		(entry) =>
			entry?.taskId === taskId &&
			entry.reason !== "completion_correction" &&
			["allocated", "running"].includes(entry.state),
	);
	return allocation ? "attempt-2" : "attempt-1";
}
function routeHealthAttemptIdentity(context, task, routeResult, descriptor) {
	const decision = context.healthDecision;
	if (typeof decision?.identityFor !== "function") return null;
	// Health evidence and half-open claims are keyed by the run identity. A
	// queue without one (no run store) can neither claim a trial nor publish
	// an ingestible terminal event, so it must never reach the claim path
	// where a missing run id is a schema error instead of a routing outcome.
	if (typeof context.runId !== "string" || context.runId.length === 0)
		return null;
	const identity = decision.identityFor({
		provider: routeResult.provider,
		requiredCapability: routeResult.requiredCapability,
	});
	if (
		!identity ||
		descriptor?.descriptor_identity !== identity.descriptorIdentity
	)
		return null;
	const state = decision({
		provider: routeResult.provider,
		requiredCapability: routeResult.requiredCapability,
	});
	if (!state.available && state.initializable !== true) return null;
	return {
		...identity,
		repairEpoch: state.available ? state.repairEpoch : 0,
		runId: context.runId,
		taskId: String(task.id),
		attempt: routeHealthAttemptId(context, task.id),
		workspaceId: context.workingContainerName,
		descriptorHarness: routeResult.resolved_harness,
		invocationDescriptor: structuredClone(descriptor),
		provider: routeResult.provider,
		model: descriptor.selector,
		mode: decision.mode ?? "shadow",
		suppress: state.suppress === true,
		trialAvailable: state.trialAvailable === true,
		healthStateRoot: decision.healthStateRoot,
		onStatus: context.onStatus,
	};
}
function prepareRouteHealthTrial(context, task, routeResult, descriptor) {
	if (context._completionPin && context._activeRouteHealth) {
		return { allowed: true };
	}
	const binding = routeHealthAttemptIdentity(
		context,
		task,
		routeResult,
		descriptor,
	);
	context._activeRouteHealth = binding;
	if (binding?.suppress === true)
		return {
			allowed: binding.mode !== "enforce",
			reason: "route-health-suppressed",
		};
	if (!binding?.trialAvailable) return { allowed: true };
	// Shadow mode is observational: it never writes a half-open claim, so a
	// shadow queue can neither flip a target to `half-open` for every later
	// reader nor fence this task's fallback launches behind a trial it did
	// not own. Only an enforcing queue claims and starts trials.
	if (binding.mode !== "enforce") {
		context.onStatus?.({
			phase: "route_health",
			event: "half_open_trial_shadowed",
			status: `Task ${task.id} would claim the selected health trial in enforce mode`,
			taskId: task.id,
		});
		return { allowed: true };
	}
	const claimed = acquireHalfOpenClaimSync(binding);
	if (claimed.claimed !== true) {
		context.onStatus?.({
			phase: "route_health",
			event: "half_open_claim_unavailable",
			status: `Task ${task.id} could not claim the selected health trial`,
			taskId: task.id,
		});
		return { allowed: binding.mode !== "enforce", reason: claimed.reason };
	}
	Object.assign(binding, {
		leaseToken: claimed.lease.token,
		leaseRevision: claimed.lease.revision,
		claimRevision: claimed.lease.revision,
	});
	return { allowed: true };
}
function startRouteHealthTrial(context) {
	const binding = context._activeRouteHealth;
	if (binding?.claimStarted) return { allowed: true };
	if (!binding?.leaseToken) return { allowed: true };
	const started = startHalfOpenClaimSync(binding);
	if (started.started === true) {
		binding.claimStarted = true;
		return { allowed: true };
	}
	const released = releaseHalfOpenClaimSync({
		...binding,
		provenNeverStarted: true,
	});
	return {
		allowed: binding.mode !== "enforce",
		reason: released.reason ?? started.reason,
	};
}
function healthDeferredResult(
	task,
	routeResult,
	descriptor,
	requiredCapability,
) {
	return {
		...descriptorReceiptFields(descriptor),
		taskId: task.id,
		success: false,
		provider: routeResult.provider,
		model: descriptor.selector,
		requiredCapability,
		resolvedTargetId: routeResult.resolvedTargetId ?? null,
		result: "route_health_deferred",
		errorKind: null,
		reason: "selected route health trial is already claimed or unavailable",
	};
}
function policyDeferredTaskResult(task, power, taskFileSha256) {
	return {
		taskId: task.id,
		success: false,
		provider: null,
		model: null,
		result: "policy_deferred",
		errorKind: null,
		policyDeferred: {
			version: 1,
			action: "policy_deferred",
			direction: "advance_authorized_fallback",
			reasonCode: "host_on_battery",
			diagnosticCode: power.diagnosticCode ?? "host_on_battery",
			nextTaskId: task.id,
			taskFileSha256,
		},
	};
}
function policyDeferredQueueResult(launch, checkpointPath) {
	const { checkpoint, tasks, policyDeferred } = launch;
	releaseCheckpointOwnership(checkpointPath, checkpoint);
	return {
		results: [],
		totalTasks: tasks.length,
		runnableTasks: policyDeferred.runnableTaskCount,
		processedTasks: 0,
		completedTaskIds: checkpoint.completedTaskIds,
		deferredTaskIds: [policyDeferred.nextTaskId],
		checkpointPath,
		ledgerWritesSettled: Promise.resolve(),
		quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
		retryState: checkpoint.retryState,
		retryTransitionId: checkpoint.retryTransitionId,
		policyDeferred,
	};
}
function reportHostPowerUnknown(onStatus, taskId = null) {
	onStatus?.({
		phase: "policy",
		event: "host_power_unknown",
		status: "Host power state unknown; preserving existing routing",
		diagnosticCode: "host_power_unknown",
		...(typeof taskId === "string" ? { taskId } : {}),
	});
}
function readQueueHostPower(options = {}) {
	if (options.hostPowerPolicyEnabled !== true) {
		return { state: HOST_POWER_STATES.AC, diagnosticCode: null };
	}
	const result = readHostPower(options);
	if (result.state === HOST_POWER_STATES.UNKNOWN) {
		reportHostPowerUnknown(options.onStatus, options.taskId);
	}
	return result;
}
export function isRouteHealthDeferredResult(result) {
	return result?.result === "route_health_deferred";
}
function reportRouteHealthDeferred(result, _onResult, emitStatus) {
	// Deferred work is not a terminal task result. In particular, do not send it
	// through legacy onResult callbacks, whose contract maps success:false to a
	// task_failed event. The status channel is the bounded observation path.
	emitStatus?.({
		phase: "execution",
		event: "route_health_deferred",
		status: `Task ${result.taskId} deferred: route health trial unavailable`,
		taskId: result.taskId,
		provider: result.provider ?? null,
		model: result.model ?? null,
		result: "route_health_deferred",
	});
}
function attachRouteHealthTerminal(result, context) {
	if (isRouteHealthDeferredResult(result)) return result;
	const binding = context._activeRouteHealth;
	if (binding?.claimStarted === true && result) {
		Object.defineProperty(result, "_routeHealthTrialStarted", {
			value: true,
			enumerable: false,
		});
	}
	if (!binding || !result?.invocationDescriptor) return result;
	let hostBinding;
	try {
		hostBinding = createRouteHealthTerminalBinding({
			...binding,
			...result,
			providerExecutionSucceeded:
				context._activeProviderExecutionSucceeded === true,
			lifecycleReceipt: context._activeCompletionLifecycleReceipt ?? null,
		});
	} catch {
		hostBinding = null;
	}
	if (!hostBinding) return result;
	Object.defineProperty(result, "routeHealthBinding", {
		value: hostBinding,
		enumerable: false,
	});
	Object.defineProperty(result, "routeHealthAttempt", {
		value: binding.attempt,
		enumerable: false,
	});
	return result;
}

export {
	attachRouteHealthTerminal,
	bindAttemptExecutionBackend,
	bindAttemptHelperBackend,
	executionCleanupContext,
	healthDeferredResult,
	mergeAttemptCleanupContext,
	policyDeferredQueueResult,
	policyDeferredTaskResult,
	prepareRouteHealthTrial,
	readQueueHostPower,
	reportRouteHealthDeferred,
	startRouteHealthTrial,
};
