/** Waterfall through the production router; the single-attempt engine remains unchanged. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	getImplementorPriority,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { route } from "../router/index.mjs";
import { readRun } from "../run-store/index.mjs";
import { deriveFailureAccountability } from "./failure-accountability.mjs";
import { appendFailureRecord } from "./failure-log.mjs";
import { classifyAttemptFailure } from "./failure-severity.mjs";
import { assertFundedRoute } from "./funding.mjs";
import {
	continuationFields,
	planContinuation,
	sourceSuperseded,
} from "./partial-continuation.mjs";
import { recordRouteExhaustion } from "./route-exhaustion.mjs";
import {
	knownBrokenCheck,
	rememberBrokenCheck,
} from "./routing-check-memory.mjs";
import { discardAndReleasePartial } from "./routing-recovery.mjs";
import {
	canonicalRoutingProject,
	MAX_ATTEMPT_HISTORY,
	openRoutingRun,
	recordAttemptOutcome,
} from "./routing-state.mjs";
import {
	createFailureLogAppender,
	failureAttemptRecord,
	lifecycleFailure,
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

export const MAX_SOFT_ATTEMPTS_PER_TASK = 4;

const FUNDING_UNAVAILABLE = new Set([
	"paid_overage_not_allowed",
	"included_usage_unverified",
]);
/** Selected allocations are durable before route() returns control to the engine. */
export async function runSimpleRoutingTask(options, deps = {}) {
	const origin = options.origin ?? "work";
	if (origin !== "work" && origin !== "qualification") {
		throw Object.assign(new Error("simple_origin_invalid"), {
			code: "simple_origin_invalid",
		});
	}
	const now = deps.now ?? Date.now;
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
		const out = {
			direction: resultDirection,
			origin,
			routingRunId,
			routingRunIdSource,
			attempts: handle.state.attempts,
			failedTargetIds: handle.state.failedTargetIds,
			retainedPartials: retainedPartials(),
			...(releasedPartials.length > 0 ? { releasedPartials } : {}),
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
	const localExcluded = new Set();
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
		if (handle.state.pendingAttempt)
			return answer(
				"stop",
				{
					stopReason: "pending_attempt_exists",
					pendingAttempt: handle.state.pendingAttempt,
				},
				{ log: false },
			);
		if (handle.state.nativeLatch)
			return answer("native_latched", { status: "deferred" }, { log: false });
		if (
			handle.state.attempts.some((attempt) => attempt.partialWorktree !== null)
		)
			return answer(
				"stop",
				{ stopReason: "partial_work_retained" },
				{ log: false },
			);
		if (
			pinned &&
			options.onlyProviders.every((id) =>
				handle.state.failedTargetIds.includes(resolveIdentity(id).targetId),
			)
		)
			return answer(
				"stop",
				{ stopReason: "pinned_target_failed" },
				{ log: false },
			);
		// A check this run already found environment-broken fails every target
		// the same way: answer with the stored evidence, allocate nothing.
		const brokenCheck = knownBrokenCheck(handle.state, options.checks);
		if (brokenCheck)
			return answer(
				"stop",
				{ stopReason: "check_known_broken", brokenCheck },
				{ log: false },
			);
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
			let pending = null;
			let routeCalled = false;
			let allocationFailed = false;
			let noEligible = false;
			const routeAttempt = (input) => {
				routeCalled = true;
				const excluded = new Set([
					...handle.state.failedTargetIds,
					...localExcluded,
				]);
				const availableProviders = (input.availableProviders ?? []).filter(
					(id) => {
						const targetId = resolveIdentity(id).targetId;
						return (
							!excluded.has(targetId) &&
							(pinned || [1, 2].includes(priority(targetId)))
						);
					},
				);
				for (;;) {
					const routed = select({
						...input,
						availableProviders: availableProviders.filter(
							(id) => !localExcluded.has(resolveIdentity(id).targetId),
						),
						exclude: [...(input.exclude ?? []), ...excluded, ...localExcluded],
						runId: routingRunId,
					});
					if (!routed?.provider) {
						noEligible =
							typeof routed?.reason === "string" &&
							/^no_eligible(?:_|$)/u.test(routed.reason);
						if (!noEligible)
							throw Object.assign(new Error("routing_selection_invalid"), {
								code: "routing_selection_invalid",
							});
						return { ...routed, reason: "no_eligible_provider" };
					}
					const targetId = resolveIdentity(routed.provider).targetId;
					if (
						!targetId ||
						!availableProviders.includes(targetId) ||
						excluded.has(targetId) ||
						localExcluded.has(targetId)
					)
						throw Object.assign(new Error("routing_selection_invalid"), {
							code: "routing_selection_invalid",
						});
					try {
						funded(targetId);
					} catch (error) {
						if (!FUNDING_UNAVAILABLE.has(error?.code)) throw error;
						localExcluded.add(targetId);
						continue;
					}
					pending = {
						...allocation,
						targetId,
						capability: options.capability,
						startedAt: new Date(now()).toISOString(),
					};
					try {
						handle.commit({ pendingAttempt: pending });
					} catch (error) {
						allocationFailed = true;
						throw error;
					}
					return routed;
				}
			};
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
					stopReason: allocationFailed
						? "routing_state_write_failed"
						: "engine_threw",
					pendingAttempt: handle.state.pendingAttempt,
				});
			}
			if (allocationFailed)
				return answer("stop", {
					stopReason: "routing_state_write_failed",
					result,
				});
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
				if (result?.lockConflict && result?.disposition) {
					const action = result.disposition.action;
					return answer(
						["defer", "recover"].includes(action) ? action : "stop",
						{
							status: action === "defer" ? "deferred" : "failed",
							stopReason: result.disposition.reasonCode,
							result,
							disposition: result.disposition,
						},
						{ attempt },
					);
				}
				if (
					routeCalled &&
					noEligible &&
					result?.failurePhase === "route" &&
					!deps.signal?.aborted
				)
					return answer(
						pinned ? "stop" : "native_required",
						{
							status: pinned ? "failed" : "deferred",
							stopReason: pinned ? "pinned_target_unavailable" : undefined,
							exhaustionCause: !pinned
								? anyFailed
									? "task_failures"
									: "capacity"
								: undefined,
							result,
						},
						{ attempt },
					);
				return answer(
					"stop",
					{ stopReason: "preflight_failed", result },
					{ attempt },
				);
			}
			let record;
			try {
				record = await (deps.readRun ?? readRun)(pending.runId);
			} catch {
				return answer("stop", {
					stopReason: "lifecycle_unconfirmed",
					lifecycleCheck: "run_record_unreadable",
					result,
					pendingAttempt: pending,
				});
			}
			const lifecycleCheck = lifecycleFailure(
				result,
				pending,
				record,
				projectPath,
				options,
			);
			if (lifecycleCheck)
				return answer("stop", {
					stopReason: "lifecycle_unconfirmed",
					lifecycleCheck,
					result,
					pendingAttempt: pending,
				});
			const failed = result.status !== "succeeded";
			const typed = result.providerReliability !== undefined;
			const diagnosticMatches = isDeepStrictEqual(
				result.providerReliability,
				record.lastFailure?.providerReliability,
			);
			const accountability = deriveFailureAccountability({
				providerReliability: diagnosticMatches
					? record.lastFailure?.providerReliability
					: undefined,
				provenance: record.lastFailure,
			});
			if (typed) result.accountability = accountability;
			// A baseline failure precedes the provider and is not evidence against the target.
			const tried =
				result.failurePhase !== "baseline" &&
				result.recovery.cleanup.writer.state === "stopped";
			const terminal = failed
				? (typed ? accountability.providerMemoryEligible && tried : tried)
					? "failed"
					: "skipped"
				: "succeeded";

			// lifecycle() already proved the writer stopped or never started.
			// Task 2.7: a post-provider dependency refusal stops on its own cause.
			const refusalCode =
				result.providerReliability?.causeCode ?? result.failureReason;
			const postProviderDependencyRefusal =
				failed &&
				result.failurePhase === "checks" &&
				(refusalCode === "check_dependencies_unverified" ||
					refusalCode === "check_manifest_changed_by_diff");
			const classification = failed
				? classifyAttemptFailure({ result, accountability })
				: null;
			const reason = failed ? classification.reason : "succeeded";

			const continued = continuationFields(plan, seeded);
			try {
				recordAttemptOutcome(handle.state, handle.commit, {
					...pending,
					terminal,
					reason,
					closedAt: new Date(now()).toISOString(),
					partialWorktree: result.partialWorktree ?? null,
					...continued,
				});
			} catch (error) {
				return answer("stop", {
					stopReason: routingErrorCode(error, "routing_state_write_failed"),
					result,
					pendingAttempt: pending,
				});
			}
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
			localExcluded.add(pending.targetId);
			anyFailed = true;

			if (classification.severity === "hard") {
				return answer("stop", {
					stopReason: postProviderDependencyRefusal
						? refusalCode
						: "unsafe_failure",
					result,
					classification,
				});
			}
			// A check that cannot run here is the environment's fault, not the
			// target's: remember it (only the pre-provider dry run writes
			// memory) and stop without blaming anyone.
			if (
				result.providerReliability?.causeCode === "check_environment_failed"
			) {
				try {
					rememberBrokenCheck(handle.state, handle.commit, {
						result,
						record,
						now,
					});
				} catch (error) {
					return answer("stop", {
						stopReason: routingErrorCode(error, "routing_state_write_failed"),
						result,
						classification,
					});
				}
				return answer("stop", {
					stopReason: "check_environment_failed",
					result,
					classification,
				});
			}
			if (classification.severity === "baseline") {
				return answer("stop", {
					stopReason: "baseline_failed",
					result,
					classification,
				});
			}
			// severity === "soft" from here
			if (pinned || options.capability === "high") {
				return answer("stop", {
					stopReason: classification.reason,
					result,
					classification,
				});
			}
			softAttempts += 1;
			if (softAttempts >= MAX_SOFT_ATTEMPTS_PER_TASK) {
				return answer("stop", {
					stopReason: "soft_retry_budget_exhausted",
					result,
					classification,
				});
			}
			// A cancelled or expired invocation keeps this attempt's own outcome.
			if (
				deps.signal?.aborted ||
				(Number.isFinite(options.deadlineMs) && options.deadlineMs <= now())
			)
				return answer("stop", {
					stopReason: classification.reason,
					result,
					classification,
				});
			// Continue to the next eligible target (retained clone is independent).
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
