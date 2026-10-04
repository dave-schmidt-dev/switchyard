/** Waterfall through the production router; the single-attempt engine remains unchanged. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	getImplementorPriority,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { route } from "../router/index.mjs";
import { readRun } from "../run-store/index.mjs";
import { deriveFailureAccountability } from "./failure-accountability.mjs";
import { classifyAttemptFailure } from "./failure-severity.mjs";
import { assertFundedRoute } from "./funding.mjs";
import {
	canonicalRoutingProject,
	MAX_ATTEMPT_HISTORY,
	openRoutingRun,
	recordAttemptOutcome,
} from "./routing-state.mjs";

export const MAX_SOFT_ATTEMPTS_PER_TASK = 4;

const FUNDING_UNAVAILABLE = new Set([
	"paid_overage_not_allowed",
	"included_usage_unverified",
]);
const errorCode = (error, fallback) =>
	typeof error?.code === "string" && /^routing_[a-z_]+$/u.test(error.code)
		? error.code
		: fallback;
function lifecycle(result, pending, record, project, options) {
	const hash = (value) =>
		`sha256:${createHash("sha256").update(value).digest("hex")}`;
	const scope = {
		files: options.files,
		checks: (options.checks ?? []).map((command, index) => ({
			index: index + 1,
			digest: hash(command),
		})),
	};
	scope.digest = hash(JSON.stringify(scope));
	const cleanup = result?.recovery?.cleanup;
	const identity = result?.recovery?.identity;
	if (
		result?.recovery?.schemaVersion !== 1 ||
		JSON.stringify(identity?.scope) !== JSON.stringify(scope) ||
		result.recovery?.result?.status !== result.status ||
		result.recovery?.result?.failureReason !== result.failureReason ||
		result.recovery?.result?.failurePhase !== result.failurePhase ||
		result.runId !== pending.runId ||
		result.taskId !== pending.taskId ||
		result.attemptId !== pending.attemptId ||
		result.targetId !== pending.targetId ||
		!identity ||
		identity.taskId !== pending.taskId ||
		identity.attemptId !== pending.attemptId ||
		!["succeeded", "failed"].includes(result.status) ||
		!["stopped", "never_started"].includes(cleanup?.writer?.state) ||
		!["released", "not_acquired"].includes(cleanup?.projectLock?.state) ||
		!["removed", "not_created", "retained"].includes(cleanup?.worktree?.state)
	)
		return false;
	if (
		!record ||
		record.runId !== pending.runId ||
		record.projectPath !== project ||
		JSON.stringify(record.orderedTaskIds) !==
			JSON.stringify([pending.taskId]) ||
		record.resolvedTargetId !== pending.targetId ||
		record.state !== result.status ||
		(result.status === "failed" &&
			record.lastFailure?.errorKind !== result.errorKind)
	)
		return false;
	if (cleanup.worktree.state === "not_created")
		return (
			record.worktree == null &&
			cleanup.writer.state === "never_started" &&
			!result.partialWorktree
		);
	return (
		record.worktree?.state === cleanup.worktree.state &&
		record.worktree.writerStopped === true &&
		(cleanup.worktree.state === "retained"
			? typeof result.partialWorktree === "string" &&
				result.partialWorktree === cleanup.worktree.path
			: record.cleanupState === "complete" && !result.partialWorktree)
	);
}
/** Selected allocations are durable before route() returns control to the engine. */
export async function runSimpleRoutingTask(options, deps = {}) {
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
	const handle = (deps.openRoutingRun ?? openRoutingRun)(
		projectPath,
		routingRunId,
		{ stateRoot: deps.stateRoot, now },
	);
	const retainedPartials = () =>
		handle.state.attempts
			.filter((a) => a.partialWorktree !== null)
			.map(({ attemptId, targetId, reason, partialWorktree }) => ({
				attemptId,
				targetId,
				reason,
				partialWorktree,
			}));
	const answer = (direction, extra = {}) => ({
		direction,
		routingRunId,
		routingRunIdSource,
		attempts: handle.state.attempts,
		failedTargetIds: handle.state.failedTargetIds,
		retainedPartials: retainedPartials(),
		...extra,
	});
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
	const logicalTaskId = deps.taskId ?? randomUUID();
	let softAttempts = 0;
	let anyFailed = false;
	let iteration = 0;
	try {
		if (handle.state.pendingAttempt)
			return answer("stop", {
				stopReason: "pending_attempt_exists",
				pendingAttempt: handle.state.pendingAttempt,
			});
		if (handle.state.nativeLatch)
			return answer("native_latched", { status: "deferred" });
		if (
			handle.state.attempts.some((attempt) => attempt.partialWorktree !== null)
		)
			return answer("stop", { stopReason: "partial_work_retained" });
		if (
			pinned &&
			options.onlyProviders.every((id) =>
				handle.state.failedTargetIds.includes(resolveIdentity(id).targetId),
			)
		)
			return answer("stop", { stopReason: "pinned_target_failed" });
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
			let result;
			try {
				result = await engine(
					{ ...options, projectPath },
					{ ...deps, ...allocation, now, route: routeAttempt },
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
					);
				}
				if (
					routeCalled &&
					noEligible &&
					result?.failurePhase === "route" &&
					!deps.signal?.aborted
				)
					return answer(pinned ? "stop" : "native_required", {
						status: pinned ? "failed" : "deferred",
						stopReason: pinned ? "pinned_target_unavailable" : undefined,
						exhaustionCause: !pinned
							? anyFailed
								? "task_failures"
								: "capacity"
							: undefined,
						result,
					});
				return answer("stop", { stopReason: "preflight_failed", result });
			}
			let record;
			try {
				record = await (deps.readRun ?? readRun)(pending.runId);
			} catch {
				return answer("stop", {
					stopReason: "lifecycle_unconfirmed",
					result,
					pendingAttempt: pending,
				});
			}
			if (!lifecycle(result, pending, record, projectPath, options))
				return answer("stop", {
					stopReason: "lifecycle_unconfirmed",
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
			const classification = failed
				? classifyAttemptFailure({ result, accountability })
				: null;
			const reason = failed ? classification.reason : "succeeded";

			try {
				recordAttemptOutcome(handle.state, handle.commit, {
					...pending,
					terminal,
					reason,
					closedAt: new Date(now()).toISOString(),
					partialWorktree: result.partialWorktree ?? null,
				});
			} catch (error) {
				return answer("stop", {
					stopReason: errorCode(error, "routing_state_write_failed"),
					result,
					pendingAttempt: pending,
				});
			}

			if (!failed) return answer("complete", { result });

			// Always exclude from this invocation's local set regardless of severity.
			localExcluded.add(pending.targetId);
			anyFailed = true;

			if (classification.severity === "hard") {
				return answer("stop", {
					stopReason: "unsafe_failure",
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
	} finally {
		handle.release();
	}
}
