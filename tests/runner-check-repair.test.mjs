import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	checkRepairPlan,
	runCheckRepairSync,
} from "../src/switchyard/runner/check-repair.mjs";
import { executeTaskUnsafe } from "../src/switchyard/runner/execute-task-unsafe.mjs";
import { prepareExecuteTaskUnsafe } from "../src/switchyard/runner/execute-task-unsafe-prepare.mjs";
import { taskRepairScopeIdentity } from "../src/switchyard/runner/reliability.mjs";
import {
	executionCleanupContext,
	markRouteHealthObservationSettled,
} from "../src/switchyard/runner/route-health.mjs";
import { runQueueAsyncLoop } from "../src/switchyard/runner/run-queue-async-loop.mjs";
import { attemptRunQueueTask } from "../src/switchyard/runner/run-queue-task-attempt.mjs";
import { tempDir, tempDirAsync } from "./helpers/tempdir.mjs";

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
function syncPinnedContext(nowValues) {
	const { context } = fixture();
	let nowIndex = 0;
	context._completionPin = pin;
	context.attemptId = pin.attemptId;
	context.checkIgnoredPath = () => null;
	context.projectPath = process.cwd();
	context.adapters = {
		codex: { execute: () => assert.fail("provider must not launch") },
	};
	context.queueBackend = {
		beforeRun: () => {},
		captureTaskBase: () => ({ tree }),
	};
	context.recordDispatch = () => {};
	context.recordDispatchIntent = () => null;
	context.now = () => nowValues[Math.min(nowIndex++, nowValues.length - 1)];
	return context;
}
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

test("sync expired pinned execution reports the canonical timeout kind at each prelaunch fence", () => {
	const deadline = Date.parse(pin.deadline);
	const expiredRepair = syncPinnedContext([deadline + 1]);
	expiredRepair._checkRepairPin = pin;
	expiredRepair._checkRepairBudget = { providerTimeoutMs: 30_000 };
	const repairTimeout = prepareExecuteTaskUnsafe(task, expiredRepair).terminal;
	assert.equal(repairTimeout.result, "execution_timed_out");
	assert.equal(repairTimeout.errorKind, "execution_timed_out");
	assert.equal(repairTimeout.timedOut, true);

	const expiredPreparation = syncPinnedContext([
		deadline - 1_000,
		deadline + 1,
	]);
	const preparationTimeout = prepareExecuteTaskUnsafe(
		task,
		expiredPreparation,
	).terminal;
	assert.equal(preparationTimeout.result, "execution_timed_out");
	assert.equal(preparationTimeout.errorKind, "execution_timed_out");
	assert.equal(preparationTimeout.timedOut, true);

	const expiredLaunch = syncPinnedContext([
		deadline - 1_000,
		deadline - 1_000,
		deadline + 1,
	]);
	const launchTimeout = executeTaskUnsafe(task, expiredLaunch);
	assert.equal(launchTimeout.result, "execution_timed_out");
	assert.equal(launchTimeout.errorKind, "execution_timed_out");
	assert.equal(launchTimeout.timedOut, true);
});

test("sync repair throw keeps its allocation consumed and clears transient context", () => {
	const { context, result } = fixture();
	context._activeRouteHealth = { claimStarted: false };
	const checkpoint = context.checkpoint;
	checkpoint.version = 3;
	checkpoint.revision = 0;
	checkpoint.owner = {
		runId: "run-1",
		processStartIdentity: "test-process",
		nonce: "test-nonce",
	};
	checkpoint.providerAttemptAllocations = [];
	const root = tempDir("switchyard-check-repair-throw-");
	const checkpointPath = join(root, "checkpoint.json");
	const providerFailure = new Error("provider execution threw");
	let executions = 0;
	const run = () =>
		runCheckRepairSync({
			task,
			result,
			context,
			checkpoint,
			checkpointPath,
			execute: () => {
				executions += 1;
				throw providerFailure;
			},
		});

	assert.throws(run, (error) => error === providerFailure);
	assert.equal(executions, 1);
	assert.equal(checkpoint.providerAttemptAllocations.length, 1);
	assert.equal(checkpoint.providerAttemptAllocations[0].state, "running");
	const persisted = JSON.parse(readFileSync(checkpointPath, "utf8"));
	assert.equal(persisted.providerAttemptAllocations.length, 1);
	assert.equal(persisted.providerAttemptAllocations[0].state, "running");
	assert.equal(persisted.providerAttemptAllocations[0].reason, "check_repair");
	assert.equal(context._checkRepairPin, null);
	assert.equal(context._checkRepairFeedback, null);
	assert.equal(context._checkRepairBudget, null);
	assert.equal(context.healthAttempt, undefined);

	assert.equal(run(), result);
	assert.equal(executions, 1);
	assert.equal(checkpoint.providerAttemptAllocations.length, 1);
	assert.equal(checkpoint.providerAttemptAllocations[0].state, "running");
});

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

for (const repairSucceeds of [true, false]) {
	test(`sync queue attempt records one pinned repair ${repairSucceeds ? "success" : "failure"}`, () => {
		const { context, result } = fixture();
		context._activeRouteHealth = { claimStarted: false };
		const checkpoint = context.checkpoint;
		checkpoint.version = 3;
		checkpoint.revision = 0;
		checkpoint.owner = {
			runId: "run-1",
			processStartIdentity: "test-process",
			nonce: "test-nonce",
		};
		checkpoint.results = [];
		checkpoint.providerAttemptAllocations = [];
		const root = tempDir("switchyard-check-repair-sync-");
		try {
			let calls = 0;
			const queueState = { resumedRetryTaskId: null };
			const attemptedTaskIds = new Set();
			const outcome = attemptRunQueueTask(
				{
					checkpoint,
					selectionOptions: {},
					tasks: [task],
					attemptedTaskIds,
					effectiveExclude: [],
					checkpointPath: join(root, "checkpoint.json"),
					workingContainerName: pin.workspaceId,
					queueBackend: { reset: () => {} },
					ownsWorkingContainer: true,
					projectRetryState: () => {},
					context,
					executeTask: (attemptTask, executionContext) => {
						calls += 1;
						if (calls === 1) return result;
						assert.equal(
							attemptTask.prompt.includes("check 1 (acceptance_check_failed)"),
							true,
						);
						assert.equal(executionContext._checkRepairPin, pin);
						assert.equal(executionContext.healthAttempt, "provider-2");
						assert.equal(
							executionContext._checkRepairBudget.checkReserveMs,
							60_000,
						);
						assert.ok(
							executionContext._checkRepairBudget.providerTimeoutMs >= 30_000,
						);
						const repairResult = {
							taskId: task.id,
							success: repairSucceeds,
							result: repairSucceeds ? "success" : "execution_failed",
							provider: "codex",
						};
						if (!repairSucceeds) {
							repairResult.providerReliability = quotaProviderDiagnostic;
						}
						return repairResult;
					},
				},
				queueState,
			);
			assert.equal(outcome.action, "settle");
			assert.equal(calls, 2);
			assert.equal(queueState.attempt.result.success, repairSucceeds);
			assert.equal(
				queueState.attempt.result.providerReliability.repairStatus,
				repairSucceeds ? "passed" : "failed",
			);
			assert.equal(queueState.attempt.result.extraProviderInvocationUsed, true);
			assert.equal(checkpoint.providerAttemptAllocations.length, 1);
			if (!repairSucceeds) {
				assertQuotaRepairDiagnostic(queueState.attempt.result);
			}
			assert.equal(
				checkpoint.providerAttemptAllocations[0].reason,
				"check_repair",
			);
			assert.equal(
				checkpoint.providerAttemptAllocations[0].state,
				"result_recorded",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

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

test("sync queue attempt refuses repair after the shared invocation allocation is consumed", () => {
	const { context, result } = fixture();
	context.checkpoint.providerAttemptAllocations = [
		{
			taskId: task.id,
			reason: "completion_correction",
			state: "result_recorded",
		},
	];
	let calls = 0;
	const state = { resumedRetryTaskId: null };
	const outcome = attemptRunQueueTask(
		{
			checkpoint: context.checkpoint,
			selectionOptions: {},
			tasks: [task],
			attemptedTaskIds: new Set(),
			effectiveExclude: [],
			checkpointPath: "unused",
			workingContainerName: pin.workspaceId,
			queueBackend: { reset: () => {} },
			ownsWorkingContainer: true,
			projectRetryState: () => {},
			context,
			executeTask: () => {
				calls += 1;
				return result;
			},
		},
		state,
	);
	assert.equal(outcome.action, "settle");
	assert.equal(calls, 0);
	assert.equal(state.attempt.result.result, "unknown_failure");
});

test("sync queue attempt refuses allocation with positive but insufficient repair budget", () => {
	const { context, result } = fixture();
	context.now = () => Date.parse(pin.deadline) - 89_000;
	const checkpoint = context.checkpoint;
	checkpoint.providerAttemptAllocations = [];
	let calls = 0;
	const outcome = attemptRunQueueTask(
		{
			checkpoint,
			selectionOptions: {},
			tasks: [task],
			attemptedTaskIds: new Set(),
			effectiveExclude: [],
			checkpointPath: "unused",
			workingContainerName: pin.workspaceId,
			queueBackend: { reset: () => {} },
			ownsWorkingContainer: true,
			projectRetryState: () => {},
			context,
			executeTask: () => {
				calls += 1;
				return result;
			},
		},
		{ resumedRetryTaskId: null },
	);
	assert.equal(Date.parse(pin.deadline) - context.now(), 89_000);
	assert.equal(outcome.action, "settle");
	assert.equal(calls, 1);
	assert.deepEqual(checkpoint.providerAttemptAllocations, []);
});
