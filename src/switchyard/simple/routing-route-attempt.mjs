/** Per-attempt route seam handed to the simple engine by the routing waterfall. */

import { taskExcludedTargets } from "./attempt-blame.mjs";
import { routeDiagnosticPatch } from "./route-evidence.mjs";
import {
	createRefusalAccumulator,
	withoutRemovalArtifacts,
	withRefusalEvidence,
} from "./routing-refusals.mjs";
import { FUNDING_UNAVAILABLE } from "./routing-reroute-policy.mjs";

/**
 * Build the `route` callback for one engine call. Selected allocations are
 * durable before it returns control to the engine. The returned `state` is
 * read after the engine call: `pending` is the committed allocation,
 * `routeCalled` and `noEligible` describe the selection, and `allocationFailed`
 * marks a refused pending-attempt commit.
 *
 * `localExcluded` maps each target this invocation removed to the closed
 * reason it was removed for. Every route call hands its own refusals to
 * `recordRefusals`, which persists them without affecting the selection.
 */
export function createRouteAttempt({
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
	setDiagnostics,
}) {
	const state = {
		pending: null,
		routeCalled: false,
		allocationFailed: false,
		noEligible: false,
	};
	const routeAttempt = (input) => {
		state.routeCalled = true;
		const runState = handle.state;
		const taskExcluded = taskExcludedTargets(runState.attempts, logicalTaskId);
		const excluded = new Set([
			...runState.failedTargetIds,
			...localExcluded.keys(),
			...taskExcluded,
		]);
		// Why the routing run removed a target itself, most specific first.
		const exclusionReason = (targetId) =>
			localExcluded.get(targetId) ??
			(taskExcluded.has(targetId)
				? "failed_this_task"
				: "failed_in_routing_run");
		// This call's own refusals, including those the caller already knows;
		// `refusals` keeps the invocation-wide set the result envelope reports.
		const callRefusals = createRefusalAccumulator(
			Array.isArray(input.refusals) ? input.refusals : [],
		);
		const refuse = (targetId, reason, bucket = null) => {
			refusals.add(targetId, reason, bucket);
			callRefusals.add(targetId, reason, bucket);
		};
		const record = (selectedTargetId) =>
			recordRefusals({
				taskId: logicalTaskId,
				attemptId: allocation.attemptId,
				at: new Date(now()).toISOString(),
				selectedTargetId,
				excluded: callRefusals.entries(),
			});
		const removedHere = new Set();
		const availableProviders = (input.availableProviders ?? []).filter((id) => {
			const targetId = resolveIdentity(id).targetId;
			const tierAllowed = pinned || [1, 2].includes(priority(targetId));
			if (excluded.has(targetId)) refuse(targetId, exclusionReason(targetId));
			else if (!tierAllowed) refuse(targetId, "tier_excluded");
			const kept = !excluded.has(targetId) && tierAllowed;
			if (!kept) removedHere.add(targetId);
			return kept;
		});
		const removedByThisRun = (id) => {
			const targetId = resolveIdentity(id).targetId;
			return removedHere.has(targetId) || localExcluded.has(targetId);
		};
		for (;;) {
			let routed = withoutRemovalArtifacts(
				select({
					...input,
					availableProviders: availableProviders.filter(
						(id) => !localExcluded.has(resolveIdentity(id).targetId),
					),
					exclude: [
						...(input.exclude ?? []),
						...excluded,
						...localExcluded.keys(),
					],
					runId: routingRunId,
				}),
				removedByThisRun,
			);
			for (const entry of routeDiagnosticPatch(routed).routeEvidence
				?.excluded ?? [])
				refuse(entry.targetId, entry.reason, entry.bucket);
			routed = withRefusalEvidence(routed, refusals.entries());
			setDiagnostics(routeDiagnosticPatch(routed));
			if (!routed?.provider) {
				state.noEligible =
					typeof routed?.reason === "string" &&
					/^no_eligible(?:_|$)/u.test(routed.reason);
				if (!state.noEligible)
					throw Object.assign(new Error("routing_selection_invalid"), {
						code: "routing_selection_invalid",
					});
				record(null);
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
				refuse(targetId, error.code);
				localExcluded.set(targetId, error.code);
				continue;
			}
			state.pending = {
				...allocation,
				targetId,
				capability: options.capability,
				startedAt: new Date(now()).toISOString(),
			};
			try {
				handle.commit({ pendingAttempt: state.pending });
			} catch (error) {
				state.allocationFailed = true;
				throw error;
			}
			record(targetId);
			return routed;
		}
	};
	return { routeAttempt, state };
}
