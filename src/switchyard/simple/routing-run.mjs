/** Waterfall through the production router; the single-attempt engine remains unchanged. */
import { randomUUID } from "node:crypto";
import { sanitizeGitControlTamper } from "../diagnostics/failure-registry.mjs";
import {
	getImplementorPriority,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { route } from "../router/index.mjs";
import { readRun } from "../run-store/run-records.mjs";
import { appendFailureRecord } from "./failure-log.mjs";
import { assertFundedRoute } from "./funding.mjs";
import {
	continuationFields,
	planContinuation,
	sourceSuperseded,
} from "./partial-continuation.mjs";
import { routeDiagnosticPatch } from "./route-evidence.mjs";
import { recordRouteExhaustion } from "./route-exhaustion.mjs";
import {
	closedAttemptCodes,
	evaluateAttempt,
	failedAttemptStop,
	preflightStop,
	priorAttemptSummaries,
	unroutedStop,
} from "./routing-attempt-outcome.mjs";
import { discardAndReleasePartial } from "./routing-recovery.mjs";
import { createRefusalAccumulator } from "./routing-refusals.mjs";
import { createRouteAttempt } from "./routing-route-attempt.mjs";
import {
	canonicalRoutingProject,
	MAX_ATTEMPT_HISTORY,
	openRoutingRun,
	recordAttemptOutcome,
} from "./routing-state.mjs";
import { appendRouteRefusals } from "./routing-state-refusals.mjs";
import {
	createFailureLogAppender,
	failureAttemptRecord,
	routingErrorCode,
	stopRecord,
	unroutedAttempt,
	unroutedAttemptRecord,
} from "./routing-stop-record.mjs";
import {
	finishTaskBinding,
	openRoutingTaskRun,
	releaseTaskRunResources,
} from "./routing-task-state.mjs";

/** @public Preserve the historical limit import path for callers. */
export { MAX_SOFT_ATTEMPTS_PER_TASK } from "./routing-reroute-policy.mjs";

/** Selected allocations are durable before route() returns control to the engine. */
export async function runSimpleRoutingTask(options, deps = {}) {
	const origin = options.origin ?? "work";
	if (origin !== "work" && origin !== "qualification") {
		throw Object.assign(new Error("simple_origin_invalid"), {
			code: "simple_origin_invalid",
		});
	}
	const now = deps.now ?? Date.now;
	// Captured once before any target starts so the reroute floor reflects the
	// budget the task was given, not the time left by the first failure.
	const initialBudgetMs = options.deadlineMs - now();
	const suppliedId = options.routingRunId;
	const environmentId = process.env.SWITCHYARD_ROUTING_RUN_ID;
	const routingRunId = suppliedId ?? environmentId ?? randomUUID();
	const routingRunIdSource =
		suppliedId != null
			? options.routingRunIdSource === "environment"
				? "environment"
				: "flag"
			: environmentId != null
				? "environment"
				: "generated";
	if (routingRunIdSource === "generated") {
		(deps.onRoutingWarning ?? console.error)(
			"dispatch: simple generated a standalone routing ID; use --routing-run-id or SWITCHYARD_ROUTING_RUN_ID to share failure memory across tasks",
		);
	}
	const projectPath = canonicalRoutingProject(options.projectPath);
	const engine = deps.runSimpleTask;
	if (typeof engine !== "function")
		throw Object.assign(new Error("routing_engine_required"), {
			code: "routing_engine_required",
		});
	const prepared = openRoutingTaskRun({
		options,
		project: projectPath,
		origin,
		routingRunId,
		routingRunIdSource,
		stateRoot: deps.stateRoot,
		now,
		openRun: deps.openRoutingRun ?? openRoutingRun,
	});
	if (prepared.stop) return prepared.stop;
	const { handle, binding: taskBinding } = prepared;
	const retainedPartials = () =>
		handle.state.attempts
			.filter((a) => a.partialWorktree !== null)
			.map(({ attemptId, targetId, reason, partialWorktree }) => ({
				attemptId,
				targetId,
				reason,
				partialWorktree,
			}));
	const appendFailureLog = createFailureLogAppender({
		origin,
		deps,
		appendFailureRecord,
	});
	// Guard answers re-report state an earlier invocation already logged, so
	// they pass { log: false }. Stop identity comes only from this
	// invocation's own attempts, never from an earlier task's attempt; an
	// unrouted failure names itself through { attempt }.
	let settledAnswer = null;
	// This invocation's closed attempts and the last one closed, so an answer
	// can summarize the attempts its top-level result does not describe.
	const ownClosed = new Map();
	let lastClosed = null;
	const answer = (direction, extra = {}, { log = true, attempt } = {}) => {
		if (direction !== "complete" && log) {
			const own = (item) => item?.taskId === logicalTaskId;
			const last =
				attempt ??
				(own(handle.state.pendingAttempt)
					? handle.state.pendingAttempt
					: (handle.state.attempts.findLast(own) ?? null));
			appendFailureLog(
				stopRecord({
					project: projectPath,
					routingRunId,
					attempt: last,
					direction,
					extra,
				}),
			);
		}
		const { resultDirection, resultExtra } = finishTaskBinding(
			taskBinding,
			handle,
			logicalTaskId,
			direction,
			extra,
		);
		const priorAttempts = priorAttemptSummaries(
			handle.state.attempts,
			ownClosed,
			lastClosed && extra.result === lastClosed.result
				? lastClosed.attemptId
				: null,
		);
		const out = {
			direction: resultDirection,
			origin,
			routingRunId,
			routingRunIdSource,
			attempts: handle.state.attempts,
			failedTargetIds: handle.state.failedTargetIds,
			retainedPartials: retainedPartials(),
			...(releasedPartials.length > 0 ? { releasedPartials } : {}),
			...(priorAttempts.length > 0 ? { priorAttempts } : {}),
			...routingDiagnostics,
			...routeDiagnosticPatch(resultExtra.result),
			...resultExtra,
		};
		settledAnswer = out;
		return out;
	};
	const pinned = (options.onlyProviders ?? []).length > 0;
	// Explicit injected routers are a synthetic single-attempt compatibility seam.
	// Production uses roster tiers and the production router.
	const priority =
		deps.getImplementorPriority ??
		(deps.route ? () => 1 : getImplementorPriority);
	const resolveIdentity = deps.resolveTargetIdentity ?? resolveTargetIdentity;
	const select = deps.route ?? route;
	const funded = deps.assertFundedRoute ?? assertFundedRoute;
	// Targets this invocation removed, each with the closed reason it reports.
	const localExcluded = new Map();
	const refusals = createRefusalAccumulator();
	// Refusal records are diagnostic: a failed write warns and never changes
	// the route.
	const recordRefusals = (record) => {
		try {
			appendRouteRefusals(handle.runDir, record);
		} catch (error) {
			(deps.onRoutingWarning ?? console.error)(
				`dispatch: route refusal record unavailable (${typeof error?.code === "string" && /^[a-z_]+$/u.test(error.code) ? error.code : "unknown"})`,
			);
		}
	};
	let routingDiagnostics = {};
	const logicalTaskId = taskBinding?.taskId ?? deps.taskId ?? randomUUID();
	// Task 3.11: the newest retained partial this invocation may carry, and
	// the sources released once their continuation superseded them.
	let carrySource = null;
	const releasedPartials = [];
	let softAttempts = 0;
	let anyFailed = false;
	let iteration = 0;
	let pendingError = null;
	try {
		const early = preflightStop({
			handle,
			options,
			pinned,
			resolveIdentity,
			logicalTaskId,
		});
		if (early) return answer(early.direction, early.extra, { log: false });
		for (;;) {
			if (deps.signal?.aborted)
				return answer("stop", { stopReason: "provider_cancelled" });
			if (Number.isFinite(options.deadlineMs) && options.deadlineMs <= now())
				return answer("stop", { stopReason: "deadline_expired" });
			if (handle.state.attempts.length >= MAX_ATTEMPT_HISTORY)
				return answer("stop", {
					stopReason: "routing_attempt_history_cap_exceeded",
				});
			const allocation = {
				taskId: logicalTaskId,
				attemptId:
					iteration === 0 ? (deps.attemptId ?? randomUUID()) : randomUUID(),
				runId:
					iteration === 0
						? (deps.runId ?? `simple-${randomUUID()}`)
						: `simple-${randomUUID()}`,
			};
			iteration += 1;
			const { routeAttempt, state: routeState } = createRouteAttempt({
				handle,
				options,
				allocation,
				routingRunId,
				logicalTaskId,
				pinned,
				priority,
				resolveIdentity,
				select,
				funded,
				localExcluded,
				refusals,
				recordRefusals,
				now,
				setDiagnostics: (patch) => {
					routingDiagnostics = patch;
				},
			});
			const plan = carrySource
				? planContinuation({ source: carrySource, options, projectPath })
				: null;
			let seeded = null;
			let verifiedDiff = null;
			let result;
			try {
				result = await engine(
					{ ...options, projectPath, origin },
					{
						...deps,
						...allocation,
						now,
						route: routeAttempt,
						continuation: plan && !plan.skipped ? plan : undefined,
						onContinuation: (outcome) => {
							seeded = outcome;
						},
						onVerifiedDiff: (captured) => {
							verifiedDiff = captured;
						},
					},
				);
			} catch {
				return answer("stop", {
					stopReason: routeState.allocationFailed
						? "routing_state_write_failed"
						: "engine_threw",
					pendingAttempt: handle.state.pendingAttempt,
				});
			}
			if (routeState.allocationFailed)
				return answer("stop", {
					stopReason: "routing_state_write_failed",
					result,
				});
			const { pending } = routeState;
			if (!pending) {
				// A failed engine call with no target has no attempt of its own yet;
				// log it so its run and cause are never lost to the stop record.
				const attempt = unroutedAttempt(result, allocation, options.capability);
				if (attempt)
					appendFailureLog(
						unroutedAttemptRecord({
							project: projectPath,
							routingRunId,
							attempt,
							result,
						}),
					);
				const stop = unroutedStop({
					result,
					attempts: handle.state.attempts,
					logicalTaskId,
					anyFailed,
					routeCalled: routeState.routeCalled,
					noEligible: routeState.noEligible,
					pinned,
					signal: deps.signal,
				});
				return answer(stop.direction, stop.extra, { attempt });
			}
			const evaluated = await evaluateAttempt({
				result,
				pending,
				projectPath,
				options,
				readRunRecord: deps.readRun ?? readRun,
			});
			if (evaluated.stop) return answer("stop", evaluated.stop);
			const {
				record,
				failed,
				accountability,
				terminal,
				refusalCode,
				postProviderDependencyRefusal,
				classification,
				reason,
				nonBlaming,
			} = evaluated;

			const continued = continuationFields(plan, seeded);
			const gitControlTamper = sanitizeGitControlTamper(
				result?.gitControlTamper,
			);
			try {
				recordAttemptOutcome(handle.state, handle.commit, {
					...pending,
					terminal,
					reason,
					closedAt: new Date(now()).toISOString(),
					partialWorktree: result.partialWorktree ?? null,
					...(nonBlaming ? { nonBlamingCause: nonBlaming } : {}),
					...(gitControlTamper ? { gitControlTamper } : {}),
					...continued,
				});
			} catch (error) {
				return answer("stop", {
					stopReason: routingErrorCode(error, "routing_state_write_failed"),
					result,
					pendingAttempt: pending,
				});
			}
			ownClosed.set(pending.attemptId, closedAttemptCodes(result));
			lastClosed = { attemptId: pending.attemptId, result };
			// The source partial is released only now that its continuation is
			// terminal, and only when the continuation holds the carried work.
			// It is discarded from disk through the run claim; a failed discard keeps
			// it recorded and only warns, the outcome stands.
			if (sourceSuperseded(continued, result)) {
				try {
					await discardAndReleasePartial(
						handle,
						handle.state.attempts.find(
							(item) => item.attemptId === plan.sourceAttemptId,
						),
						{ projectPath, discard: true, deps },
					);
					releasedPartials.push({
						attemptId: plan.sourceAttemptId,
						partialWorktree: carrySource.partialWorktree,
					});
				} catch (error) {
					(deps.onRoutingWarning ?? console.error)(
						`dispatch: continuation source partial kept (${typeof error?.code === "string" && /^[a-z_]+$/u.test(error.code) ? error.code : "release_failed"})`,
					);
				}
			}
			if (typeof result.partialWorktree === "string")
				carrySource = {
					attemptId: pending.attemptId,
					partialWorktree: result.partialWorktree,
					result,
					record,
					captured: verifiedDiff,
				};
			if (failed) {
				appendFailureLog(
					failureAttemptRecord({
						project: projectPath,
						routingRunId,
						attempt: pending,
						result,
						accountability,
						classification,
					}),
				);
			}
			// A live quota error exhausts the target's route eligibility for
			// an hour; the durable marker outlives this run's Gradus snapshot.
			if (
				failed &&
				result.providerReliability?.causeCode === "quota_exhausted"
			) {
				try {
					recordRouteExhaustion(pending.targetId, {
						stateRoot: deps.stateRoot,
						now,
					});
				} catch (error) {
					(deps.onRoutingWarning ?? console.error)(
						`dispatch: route exhaustion record unavailable (${error?.code ?? "unknown"})`,
					);
				}
			}

			if (!failed) return answer("complete", { result });

			// Always exclude from this invocation's local set regardless of severity.
			localExcluded.set(pending.targetId, "failed_this_task");
			// Capacity and caller cancellations are not task failures, so they must
			// not turn a later no-eligible stop into task_failures.
			if (nonBlaming === null) anyFailed = true;

			const stop = failedAttemptStop({
				result,
				record,
				classification,
				accountability,
				refusalCode,
				postProviderDependencyRefusal,
				handle,
				options,
				pinned,
				signal: deps.signal,
				initialBudgetMs,
				softAttemptCount: softAttempts + 1,
				now,
			});
			if (stop) return answer("stop", stop);
			softAttempts += 1;
		}
	} catch (error) {
		pendingError = { error };
	} finally {
		const override = releaseTaskRunResources(handle, {
			taskBinding,
			settledAnswer,
			pendingError,
		});
		// biome-ignore lint/correctness/noUnsafeFinally: intentional override on binding-only release refusal
		if (override) return override;
	}
}
/** @public Preserve the historical recovery import path for callers. */
export {
	closePendingAttempt,
	releaseRetainedPartial,
} from "./routing-recovery.mjs";
