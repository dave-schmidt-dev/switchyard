import {
	createProviderReliabilityDiagnostic,
	isProviderReliabilityDiagnostic,
} from "../diagnostics/provider-reliability.mjs";
import { ingestRouteHealthEvents } from "../router/health-observations.mjs";
import { createRouteHealthEvent, getRunRoot } from "../run-store/index.mjs";
import {
	checkRepairCandidate,
	checkRepairFeedback,
	providerRepairLifecycleSafe,
	repairDiagnostic,
	taskRepairScopeIdentity,
} from "./reliability.mjs";
import {
	allocateExtraProviderInvocation,
	recordExtraProviderInvocationResult,
	startExtraProviderInvocation,
	taskExecutionBudget,
} from "./retry-transitions.mjs";
import { markRouteHealthObservationSettled } from "./route-health.mjs";

const MIN_PROVIDER_TIMEOUT_MS = 30_000;
const MIN_CHECK_RESERVE_MS = 60_000;
const CHECK_RESERVE_PER_COMMAND_MS = 30_000;

function exactPinResult(task, result, pin) {
	return (
		pin?.taskId === task.id &&
		result?.taskId === task.id &&
		result.provider === pin.provider &&
		result.resolvedTargetId === pin.resolvedTargetId &&
		result.invocationDescriptor?.descriptor_identity ===
			pin.descriptorIdentity &&
		result.invocationDescriptor?.selector === pin.selector &&
		result.invocationDescriptor?.target_id === pin.resolvedTargetId &&
		result.descriptorHarness === pin.route?.resolved_harness
	);
}

function repairBudget(context, task, pin) {
	const budget =
		context._activeTaskBudget?.taskId === task.id
			? taskExecutionBudget(context, task)
			: null;
	const checks = task.quickChecks?.checks;
	if (
		!budget ||
		!Number.isFinite(Date.parse(pin?.deadline ?? "")) ||
		budget.deadline !== pin.deadline ||
		!Array.isArray(checks) ||
		checks.length < 1
	)
		return null;
	const checkReserveMs = Math.max(
		MIN_CHECK_RESERVE_MS,
		CHECK_RESERVE_PER_COMMAND_MS *
			(checks.length + (task.quickChecks.setup ? 1 : 0)),
	);
	const providerTimeoutMs = Math.floor(budget.remainingMs - checkReserveMs);
	if (providerTimeoutMs < MIN_PROVIDER_TIMEOUT_MS) return null;
	return { providerTimeoutMs, checkReserveMs };
}

export function checkRepairPlan(task, result, context, { async = false } = {}) {
	const feedback = checkRepairCandidate(task, result);
	if (!feedback) return null;
	const pin = context._activeCompletionPin;
	const budget = pin ? repairBudget(context, task, pin) : null;
	if (
		!pin ||
		!budget ||
		!exactPinResult(task, result, pin) ||
		!providerRepairLifecycleSafe(task, context, pin)
	)
		return null;
	if (!async && context._activeRouteHealth?.claimStarted === true) return null;
	const repairTask = checkRepairFeedback(task, feedback);
	if (!repairTask) return null;
	return { feedback, pin, repairTask, budget };
}

function allocationIntent(task, pin) {
	return {
		deadline: pin.deadline,
		descriptorIdentity: pin.descriptorIdentity,
		workspaceId: pin.workspaceId,
		baseTree: pin.baseTree,
		attemptId: pin.attemptId,
		scopeIdentity: taskRepairScopeIdentity(task),
	};
}

function allocateRepair(task, plan, checkpoint, checkpointPath, dependencies) {
	const allocate =
		dependencies.allocateExtraProviderInvocation ??
		allocateExtraProviderInvocation;
	const allocation = allocate(
		checkpoint,
		checkpointPath,
		task.id,
		"check_repair",
		allocationIntent(task, plan.pin),
	);
	if (!allocation) return false;
	(dependencies.startExtraProviderInvocation ?? startExtraProviderInvocation)(
		checkpoint,
		checkpointPath,
		task.id,
	);
	return true;
}

function annotateRepairResult(
	result,
	feedback,
	checkpoint,
	checkpointPath,
	taskId,
	dependencies,
) {
	result.extraProviderInvocationUsed = true;
	const repair = repairDiagnostic(
		feedback,
		result.success ? "passed" : "failed",
	);
	const existing = isProviderReliabilityDiagnostic(result.providerReliability)
		? result.providerReliability
		: repair;
	result.providerReliability = createProviderReliabilityDiagnostic({
		...existing,
		repairCount: repair.repairCount,
		repairStatus: repair.repairStatus,
	});
	(
		dependencies.recordExtraProviderInvocationResult ??
		recordExtraProviderInvocationResult
	)(checkpoint, checkpointPath, taskId);
	return result;
}

export function runCheckRepairSync({
	task,
	result,
	context,
	checkpoint,
	checkpointPath,
	execute,
	dependencies = {},
}) {
	const plan = checkRepairPlan(task, result, context);
	if (
		!plan ||
		!allocateRepair(task, plan, checkpoint, checkpointPath, dependencies)
	)
		return result;
	context._checkRepairPin = plan.pin;
	context._checkRepairFeedback = plan.feedback;
	context._checkRepairBudget = plan.budget;
	context.healthAttempt = "provider-2";
	try {
		return annotateRepairResult(
			execute(plan.repairTask, context),
			plan.feedback,
			checkpoint,
			checkpointPath,
			task.id,
			dependencies,
		);
	} finally {
		context._checkRepairPin = null;
		context._checkRepairFeedback = null;
		context._checkRepairBudget = null;
		context.healthAttempt = undefined;
	}
}

function matchingObservation(observations, binding, result, attempt) {
	return observations.find(
		(observation) =>
			observation.runId === binding.runId &&
			observation.taskId === String(result.taskId) &&
			observation.attempt === attempt &&
			observation.targetId === binding.targetId &&
			observation.descriptorIdentity === binding.descriptorIdentity &&
			observation.publicConfigurationEpoch ===
				binding.publicConfigurationEpoch &&
			observation.repairEpoch === binding.repairEpoch &&
			(observation.accepted === true ||
				observation.reason === "duplicate-attempt"),
	);
}

async function settleCheckRepairHealth(result, context, dependencies = {}) {
	const hostBinding = result?.routeHealthBinding;
	const binding = context._activeRouteHealth;
	const attempt = result?.routeHealthAttempt;
	if (!hostBinding || !binding || !attempt || !context.runId) return false;
	const append = dependencies.createRouteHealthEvent ?? createRouteHealthEvent;
	const ingest =
		dependencies.ingestRouteHealthEvents ?? ingestRouteHealthEvents;
	const runRoot = dependencies.getRunRoot ?? getRunRoot;
	const event = {
		phase: "execution",
		event: "provider_attempt_terminal",
		status: result.success ? "completed" : "failed",
		taskId: String(result.taskId),
		attempt,
		provider: result.provider,
		model: result.model,
		resolvedTargetId: result.resolvedTargetId,
		descriptorHarness: result.descriptorHarness,
		descriptorIdentity: result.descriptorIdentity,
		invocationDescriptor: result.invocationDescriptor,
		...(typeof result.servedModelVerified === "boolean"
			? { servedModelVerified: result.servedModelVerified }
			: {}),
		...(typeof result.diagnosticCode === "string"
			? { diagnosticCode: result.diagnosticCode }
			: {}),
		...(typeof result.diagnosticOrigin === "string"
			? { diagnosticOrigin: result.diagnosticOrigin }
			: {}),
		...(typeof result.diagnosticEvidenceAvailable === "boolean"
			? { diagnosticEvidenceAvailable: result.diagnosticEvidenceAvailable }
			: {}),
		...(typeof result.failurePhase === "string"
			? { failurePhase: result.failurePhase }
			: {}),
		...(Number.isSafeInteger(result.exitCode)
			? { exitCode: result.exitCode }
			: {}),
		...(typeof result.signal === "string" ? { signal: result.signal } : {}),
	};
	await append(context.runId, event, hostBinding);
	const observations = await ingest({
		authorisedRuns: [{ runId: context.runId, runRoot: runRoot(context.runId) }],
		healthStateRoot: context.healthDecision?.healthStateRoot,
		onStatus: context.onStatus,
	});
	const observation = matchingObservation(
		observations,
		binding,
		result,
		attempt,
	);
	if (!observation) return false;
	const settled = (
		dependencies.markSettled ?? markRouteHealthObservationSettled
	)(context, observation);
	return context._activeRouteHealth?.claimStarted === true ? settled : true;
}

export async function runCheckRepairAsync({
	task,
	result,
	context,
	checkpoint,
	checkpointPath,
	execute,
	dependencies = {},
}) {
	const plan = checkRepairPlan(task, result, context, { async: true });
	if (!plan || !(await settleCheckRepairHealth(result, context, dependencies)))
		return result;
	const settledPlan = checkRepairPlan(task, result, context, { async: true });
	if (
		!settledPlan ||
		settledPlan.pin !== plan.pin ||
		!allocateRepair(task, settledPlan, checkpoint, checkpointPath, dependencies)
	)
		return result;
	context._checkRepairPin = settledPlan.pin;
	context._checkRepairFeedback = settledPlan.feedback;
	context._checkRepairBudget = settledPlan.budget;
	context.healthAttempt = "provider-2";
	try {
		return annotateRepairResult(
			await execute(settledPlan.repairTask, context),
			settledPlan.feedback,
			checkpoint,
			checkpointPath,
			task.id,
			dependencies,
		);
	} finally {
		context._checkRepairPin = null;
		context._checkRepairFeedback = null;
		context._checkRepairBudget = null;
		context.healthAttempt = undefined;
	}
}
