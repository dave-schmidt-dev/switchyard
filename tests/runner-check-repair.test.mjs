// @test-phase: other
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { checkRepairPlan } from "../src/switchyard/runner/check-repair.mjs";
import { taskRepairScopeIdentity } from "../src/switchyard/runner/reliability.mjs";
import {
	executionCleanupContext,
	markRouteHealthObservationSettled,
} from "../src/switchyard/runner/route-health.mjs";
import { runQueueAsyncLoop } from "../src/switchyard/runner/run-queue-async-loop.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

const task = {
	id: "1.1",
	status: "pending",
	title: "repair check",
	prompt: "Implement the requested change.",
	type: "implementation",
	requiredPaths: ["src/a.mjs"],
	quickChecks: {
		checks: [["node", "--test"]],
		repairChecks: [["node", "--test"]],
	},
};
const tree = "a".repeat(40);
const descriptor = {
	descriptor_identity: "b".repeat(64),
	selector: "codex-standard",
	target_id: "codex-target",
};
const quotaCheckIdentity = "e".repeat(64);
const quotaProviderDiagnostic = createProviderReliabilityDiagnostic({
	causeCode: "quota_exhausted",
	phase: "provider",
	exitCode: 75,
	timedOut: false,
	baselineStatus: "passed",
	checkIndex: 1,
	checkIdentity: quotaCheckIdentity,
});
const pin = {
	taskId: task.id,
	route: {
		provider: "codex",
		resolvedTargetId: "codex-target",
		resolved_harness: "codex",
	},
	invocationDescriptor: descriptor,
	provider: "codex",
	resolvedTargetId: descriptor.target_id,
	selector: descriptor.selector,
	descriptorIdentity: descriptor.descriptor_identity,
	workspaceId: "owned-container",
	baseTree: tree,
	attemptId: "attempt-1",
	deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
	scopeIdentity: taskRepairScopeIdentity(task),
};
function assertQuotaRepairDiagnostic(result) {
	const diagnostic = result.providerReliability;
	assert.equal(diagnostic.causeCode, "quota_exhausted");
	assert.equal(diagnostic.phase, "provider");
	assert.equal(diagnostic.exitCode, 75);
	assert.equal(diagnostic.timedOut, false);
	assert.equal(diagnostic.baselineStatus, "passed");
	assert.equal(diagnostic.checkIndex, 1);
	assert.equal(diagnostic.checkIdentity, quotaCheckIdentity);
	assert.equal(diagnostic.repairCount, 1);
	assert.equal(diagnostic.repairStatus, "failed");
}

function fixture() {
	const context = {
		ownsWorkingContainer: true,
		workingContainerName: pin.workspaceId,
		_activeTaskBase: { tree },
		_activeCompletionPin: pin,
		_activeTaskBudget: {
			taskId: task.id,
			wallDeadlineMs: Date.parse(pin.deadline),
			monotonicDeadlineMs: 30 * 60_000,
			deadline: pin.deadline,
		},
		now: () => Date.now(),
		monotonicNow: () => 0,
		checkpoint: {
			ownershipReleased: false,
			owner: { runId: "run-1" },
			integrationIntents: {},
			taskBases: {
				[task.id]: {
					tree,
					cleanupContext: {
						taskId: task.id,
						attemptId: pin.attemptId,
						workspaceId: pin.workspaceId,
						descriptorIdentity: pin.descriptorIdentity,
					},
				},
			},
		},
		runId: "run-1",
	};
	const commandSha256 = createHash("sha256")
		.update(JSON.stringify(task.quickChecks.checks[0]))
		.digest("hex");
	const result = {
		taskId: task.id,
		provider: pin.provider,
		resolvedTargetId: pin.resolvedTargetId,
		invocationDescriptor: descriptor,
		descriptorHarness: "codex",
		result: "check_failed",
		success: false,
		providerLifecycle: {
			writerLifecycle: "stopped",
			terminalStatus: "exited",
			cleanupStatus: "succeeded",
			cleanupStage: "index_lock_removed",
		},
		quickCheckReceipt: {
			status: "failed",
			cleanup: { status: "complete" },
			checks: [
				{
					index: 0,
					commandSha256,
					exitCode: 1,
					signal: null,
					timedOut: false,
					groupCleanup: "complete",
				},
			],
		},
	};
	return { context, result };
}

test("check repair plan closes failed-check feedback and pins the original provider attempt", () => {
	const { context, result } = fixture();
	const plan = checkRepairPlan(task, result, context);
	assert.ok(plan);
	assert.match(plan.repairTask.prompt, /check 1 \(acceptance_check_failed\)/u);
	assert.doesNotMatch(
		plan.repairTask.prompt,
		/exitCode|commandSha256|stdout|stderr/u,
	);
	assert.equal(plan.pin, pin);
	assert.deepEqual(plan.budget, {
		providerTimeoutMs: plan.budget.providerTimeoutMs,
		checkReserveMs: 60_000,
	});
	assert.ok(plan.budget.providerTimeoutMs >= 30_000);
});

async function exerciseAsyncLoop(
	repairSucceeds,
	settlementSucceeds = true,
	elapsedAtSettlement = false,
) {
	const { context, result } = fixture();
	const checkpoint = context.checkpoint;
	checkpoint.version = 3;
	checkpoint.revision = 0;
	checkpoint.owner = {
		runId: "run-1",
		processStartIdentity: "test-process",
		nonce: "test-nonce",
	};
	checkpoint.results = [];
	checkpoint.taskAttempts = {};
	checkpoint.completedTaskIds = [];
	checkpoint.providerAttemptAllocations = [];
	context.queueBackend = {
		commit: () => {},
		reset: () => {},
		releaseTaskBaseAsync: async () => {},
	};
	context._activeTaskHelperContext = {
		operation: "helper",
		runId: context.runId,
		taskId: task.id,
		attemptId: pin.attemptId,
		workspaceId: pin.workspaceId,
		descriptorIdentity: pin.descriptorIdentity,
		processStartIdentity: null,
	};
	checkpoint.taskBases[task.id].ref = "task-base-ref";
	checkpoint.taskBases[task.id].cleanupContext = {
		...context._activeTaskHelperContext,
	};
	context._activeRouteHealth = { claimStarted: true };
	const diffSha256 = createHash("sha256").update("patch\n").digest("hex");
	const commandSha256 = createHash("sha256")
		.update(JSON.stringify(task.quickChecks.checks[0]))
		.digest("hex");
	const binding = {
		runId: "run-1",
		taskId: task.id,
		attempt: "provider-1",
		targetId: pin.resolvedTargetId,
		descriptorIdentity: pin.descriptorIdentity,
		publicConfigurationEpoch: "c".repeat(64),
		repairEpoch: 0,
	};
	const order = [];
	const results = [];
	const providerTasks = [];
	const dependencies = {
		executeTaskAsync: async (attemptTask, executionContext) => {
			providerTasks.push(attemptTask);
			if (providerTasks.length === 1) {
				executionContext._activeRouteHealth = {
					...binding,
					claimStarted: true,
				};
				return {
					...result,
					routeHealthBinding: binding,
					routeHealthAttempt: "provider-1",
				};
			}
			assert.equal(
				attemptTask.prompt.includes("check 1 (acceptance_check_failed)"),
				true,
			);
			assert.equal(executionContext._checkRepairPin, pin);
			assert.equal(executionContext.healthAttempt, "provider-2");
			assert.equal(executionContext._checkRepairBudget.checkReserveMs, 60_000);
			assert.ok(
				executionContext._checkRepairBudget.providerTimeoutMs >= 30_000,
			);
			if (!repairSucceeds) {
				return {
					taskId: task.id,
					success: false,
					result: "execution_failed",
					provider: pin.provider,
					model: pin.selector,
					providerReliability: quotaProviderDiagnostic,
				};
			}
			checkpoint.taskAttempts[task.id] = 1;
			checkpoint.integrationIntents[task.id] = {
				status: "completed",
				operation: {
					taskId: task.id,
					attempt: 1,
					baseTree: tree,
					patchHash: diffSha256,
					paths: ["src/a.mjs"],
				},
			};
			return {
				taskId: task.id,
				success: true,
				result: "success",
				provider: pin.provider,
				model: pin.selector,
				resolvedTargetId: pin.resolvedTargetId,
				invocationDescriptor: descriptor,
				descriptorHarness: "codex",
				quickCheckReceipt: {
					version: 1,
					taskId: task.id,
					attempt: 1,
					baseTree: tree,
					diffSha256,
					candidateTree: "d".repeat(40),
					commandSetSha256: createHash("sha256")
						.update(
							JSON.stringify({ setup: null, checks: task.quickChecks.checks }),
						)
						.digest("hex"),
					setup: null,
					status: "passed",
					cleanup: { status: "complete" },
					checks: [
						{
							index: 0,
							commandSha256,
							exitCode: 0,
							groupCleanup: "complete",
							signal: null,
							timedOut: false,
						},
					],
				},
			};
		},
		createRouteHealthEvent: async (_runId, event, hostBinding) => {
			order.push("append");
			assert.equal(event.event, "provider_attempt_terminal");
			assert.equal(Object.hasOwn(event, "result"), false);
			assert.equal(Object.hasOwn(event, "errorKind"), false);
			assert.equal(hostBinding, binding);
		},
		getRunRoot: () => "/run-root",
		ingestRouteHealthEvents: async ({ authorisedRuns }) => {
			order.push("ingest");
			assert.equal(authorisedRuns[0].runRoot, "/run-root");
			return [
				{ ...binding, taskId: task.id, attempt: "provider-1", accepted: true },
			];
		},
		markSettled: (healthContext, observation) => {
			order.push("settle");
			assert.equal(healthContext, context);
			assert.equal(observation.attempt, "provider-1");
			const settled = settlementSucceeds
				? markRouteHealthObservationSettled(healthContext, observation)
				: false;
			if (elapsedAtSettlement) {
				healthContext.now = () => Date.parse(pin.deadline) - 89_000;
			}
			return settled;
		},
	};
	const root = await tempDirAsync("switchyard-check-repair-async-");
	try {
		await runQueueAsyncLoop(
			{
				checkpoint,
				effectiveMaxTasks: 1,
				effectiveExclude: [],
				effectiveTaskIds: [],
				tasks: [task],
				attemptedTaskIds: new Set(),
				dependencies,
				checkpointPath: join(root, "checkpoint.json"),
				workingContainerName: pin.workspaceId,
				queueBackend: context.queueBackend,
				ownsWorkingContainer: true,
				results,
				deferredTaskIds: [],
				emitStatus: null,
				effectiveStopOnFailure: true,
				projectRetryState: () => {},
				context,
			},
			{
				processed: 0,
				resumedRetryTaskId: null,
				policyDeferred: null,
				deferredTaskIds: [],
			},
		);
		assert.deepEqual(order, ["append", "ingest", "settle"]);
		const repairRuns = settlementSucceeds && !elapsedAtSettlement;
		assert.equal(providerTasks.length, repairRuns ? 2 : 1);
		assert.equal(results.length, 1);
		assert.equal(results[0].success, repairRuns ? repairSucceeds : false);
		if (repairRuns) {
			assert.equal(
				results[0].providerReliability.repairStatus,
				repairSucceeds ? "passed" : "failed",
			);
			assert.equal(results[0].extraProviderInvocationUsed, true);
			assert.equal(checkpoint.providerAttemptAllocations.length, 1);
			if (!repairSucceeds) assertQuotaRepairDiagnostic(results[0]);
			assert.equal(
				checkpoint.providerAttemptAllocations[0].reason,
				"check_repair",
			);
			assert.equal(
				checkpoint.providerAttemptAllocations[0].state,
				"result_recorded",
			);
		} else {
			assert.deepEqual(checkpoint.providerAttemptAllocations, []);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("async queue loop settles health before one pinned repair success", () =>
	exerciseAsyncLoop(true));
test("async queue loop settles health before one pinned repair failure", () =>
	exerciseAsyncLoop(false));
test("async queue loop rechecks positive original deadline after health settlement", () =>
	exerciseAsyncLoop(true, true, true));

test("cleanup identity keeps scoped repair pins distinct from retries and fallbacks", () => {
	const allocation = {
		taskId: task.id,
		reason: "check_repair",
		state: "running",
		attemptId: pin.attemptId,
		workspaceId: pin.workspaceId,
		baseTree: pin.baseTree,
		descriptorIdentity: pin.descriptorIdentity,
		scopeIdentity: pin.scopeIdentity,
	};
	const context = {
		runId: "run-1",
		workingContainerName: pin.workspaceId,
		_activeTaskBase: { tree: pin.baseTree },
		_activeInvocationDescriptor: descriptor,
		_checkRepairPin: pin,
		checkpoint: { providerAttemptAllocations: [allocation] },
	};
	assert.equal(
		executionCleanupContext(context, task, descriptor.descriptor_identity)
			.attemptId,
		pin.attemptId,
	);
	assert.equal(
		executionCleanupContext(
			{ ...context, healthAttempt: "provider-2" },
			task,
			descriptor.descriptor_identity,
		).attemptId,
		pin.attemptId,
	);
	assert.equal(
		executionCleanupContext(
			{
				...context,
				checkpoint: {
					...context.checkpoint,
					retryState: { taskId: task.id, attempt: 3 },
				},
			},
			task,
			descriptor.descriptor_identity,
		).attemptId,
		"attempt-3",
	);
	assert.equal(
		executionCleanupContext(
			{
				...context,
				_checkRepairPin: { ...pin, taskId: "1.2", attemptId: "attempt-9" },
			},
			task,
			descriptor.descriptor_identity,
		).attemptId,
		"attempt-2",
	);
	assert.equal(
		executionCleanupContext(
			{
				...context,
				checkpoint: {
					providerAttemptAllocations: [
						{ ...allocation, reason: "quota_fallback" },
					],
				},
			},
			task,
			descriptor.descriptor_identity,
		).attemptId,
		"attempt-2",
	);
});

test("check repair refuses unknown lifecycle, integration, drift, expired deadline, and sync half-open claim", () => {
	const cases = [
		({ context, result }) => {
			result.providerLifecycle.writerLifecycle = "unknown";
			return [task, result, context];
		},
		({ context, result }) => {
			result.providerLifecycle.cleanupStatus = "failed";
			return [task, result, context];
		},
		({ context, result }) => {
			result.providerLifecycle.cleanupStatus = "uncertain";
			return [task, result, context];
		},
		({ context, result }) => {
			context.checkpoint.integrationIntents[task.id] = {};
			return [task, result, context];
		},
		({ context, result }) => {
			result.invocationDescriptor = { ...descriptor, selector: "changed" };
			return [task, result, context];
		},
		({ context, result }) => {
			context.now = () => Date.parse(pin.deadline) + 1;
			return [task, result, context];
		},
		({ context, result }) => {
			context._activeRouteHealth = { claimStarted: true };
			return [task, result, context];
		},
		({ context, result }) => {
			const drifted = { ...task, requiredPaths: ["src/other.mjs"] };
			return [drifted, result, context];
		},
	];
	for (const mutate of cases) {
		const fixtureValue = fixture();
		const [candidateTask, candidateResult, context] = mutate(fixtureValue);
		assert.equal(
			checkRepairPlan(candidateTask, candidateResult, context),
			null,
		);
	}
});
