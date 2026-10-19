import {
	CAPABILITY_CLASS,
	getImplementorPriority,
	resolveTargetId,
	resolveTargetIdentity,
} from "../roster/index.mjs";

import {
	evaluateCandidateEligibility,
	healthExclusion,
	readRosterTargetOrder,
} from "./eligibility.mjs";

export function routeBlind(
	providerOrder,
	exclude = [],
	requiredCapability = CAPABILITY_CLASS.standard,
	options = {},
) {
	const only = options.only ?? [];
	const ambiguousFilter = [...exclude, ...only].find(
		(identifier) => resolveTargetIdentity(identifier).ambiguous,
	);
	if (ambiguousFilter) {
		return {
			provider: null,
			model: null,
			resolvedTargetId: null,
			reason: "ambiguous_target",
		};
	}

	const survivors = [];
	for (const [providerOrderIndex, name] of providerOrder.entries()) {
		const eligibility = evaluateCandidateEligibility(name, null, {
			...options,
			exclude,
			only,
			requiredCapability,
			usageMode: "unknown",
		});
		if (!eligibility.eligible) {
			options.evidenceCapture?.exclude(name, eligibility.reason);
			if (eligibility.reason === "target_identity_unavailable") {
				const identity = resolveTargetIdentity(name);
				if (!identity.ambiguous) continue;
				return {
					provider: null,
					model: null,
					resolvedTargetId: null,
					reason: "quarantine_unresolvable",
				};
			}
			continue;
		}
		const health = healthExclusion(name, null, {
			...options,
			requiredCapability,
			usageMode: "unknown",
		});
		if (health) {
			options.evidenceCapture?.exclude(name, "route_health_suppressed");
			continue;
		}
		options.evidenceCapture?.candidate(name, [], getImplementorPriority(name));
		survivors.push({
			name,
			priority: getImplementorPriority(name),
			providerOrderIndex,
		});
	}

	if (survivors.length > 0) {
		const rosterOrder = readRosterTargetOrder();
		const priorityOrder = (candidate) => {
			if (candidate.priority === 1) return 1;
			if (candidate.priority === 2) return 2;
			if (candidate.priority === 3) return 3;
			if (candidate.priority !== null) return 4;
			return 5;
		};
		const winner = survivors.toSorted((left, right) => {
			const tierDelta = priorityOrder(left) - priorityOrder(right);
			if (tierDelta !== 0) return tierDelta;
			if (left.priority === 1) {
				const leftId = resolveTargetId(left.name) ?? "";
				const rightId = resolveTargetId(right.name) ?? "";
				const rosterDelta =
					(rosterOrder.get(leftId) ?? Number.POSITIVE_INFINITY) -
					(rosterOrder.get(rightId) ?? Number.POSITIVE_INFINITY);
				if (rosterDelta !== 0) return rosterDelta;
				const idDelta = leftId.localeCompare(rightId);
				if (idDelta !== 0) return idDelta;
			}
			if (
				left.priority !== null &&
				right.priority !== null &&
				left.priority !== right.priority
			) {
				return left.priority - right.priority;
			}
			return left.providerOrderIndex - right.providerOrderIndex;
		})[0];
		return {
			provider: winner.name,
			model: null,
			resolvedTargetId: resolveTargetId(winner.name),
			reason: "blind_fallback",
		};
	}
	return {
		provider: null,
		model: null,
		resolvedTargetId: null,
		reason: "no_eligible_blind",
	};
}
