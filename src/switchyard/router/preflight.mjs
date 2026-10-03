import { snapshotAdmissionFailure } from "../broker/snapshots.mjs";

import {
	CAPABILITY_CLASS,
	getImplementorPriority,
	hasAutomaticInvocationDescriptor,
	resolveTargetId,
	resolveTargetIdentity,
} from "../roster/index.mjs";

import {
	DEFAULT_FLOOR,
	evaluateCandidateEligibility,
	GOLDEN_IMAGE_VERIFIED_PROVIDERS,
	healthExclusion,
	indexProviders,
	readRosterTargetOrder,
	readSnapshotAtRoute,
	TERMINAL_PREFLIGHT_STATUSES,
} from "./eligibility.mjs";

export function preflightMacosQueue(options = {}) {
	const {
		platform = "macos",
		tasks = [],
		potentialAttemptTasks,
		only = [],
		exclude = [],
		availableProviders,
		floor = DEFAULT_FLOOR,
		nowMs = Date.now(),
		readSnapshot = readSnapshotAtRoute,
		hasInvocationDescriptor = hasAutomaticInvocationDescriptor,
	} = options;

	if (platform !== "macos") {
		const rejection = {
			capability: null,
			excludedProviders: [],
			reason: "invalid_platform",
		};
		return {
			platform,
			eligible: false,
			ok: false,
			reason: rejection.reason,
			checkedCapabilities: [],
			capabilityResults: [],
			rejections: [rejection],
			rejection,
		};
	}

	// route() and routeBlind() both refuse an ambiguous --only/--exclude
	// selector outright, with reason "ambiguous_target". Preflight has to refuse
	// it on the same terms, and has to do so here — before any task or snapshot
	// analysis — because this is a go/no-go for the dispatches that follow. Left
	// to the per-capability loop, an ambiguous name degrades into a per-provider
	// not_in_only_allowlist: the queue is reported as merely having no eligible
	// provider for the tier, when the truth is that route() will reject the
	// selector itself. Placing the guard above the task scan also means an empty
	// queue with an ambiguous selector fails closed rather than returning
	// no_non_terminal_tasks, which is the one case where the two could still
	// have disagreed.
	const ambiguousFilter = [...exclude, ...only].find(
		(identifier) => resolveTargetIdentity(identifier).ambiguous,
	);
	if (ambiguousFilter) {
		const rejection = {
			capability: null,
			excludedProviders: [],
			reason: "ambiguous_target",
			selector: ambiguousFilter,
		};
		return {
			platform,
			eligible: false,
			ok: false,
			reason: rejection.reason,
			checkedCapabilities: [],
			capabilityResults: [],
			rejections: [rejection],
			rejection,
			log: [
				`provider selector ${ambiguousFilter} is ambiguous; use an exact target id`,
			],
			snapshotStatus: "not_checked",
			snapshotMtime: null,
			snapshotAgeMsAtRoute: null,
		};
	}

	const taskTiers = [];
	const tierTasks =
		potentialAttemptTasks === undefined ? tasks : potentialAttemptTasks;
	for (const task of Array.isArray(tierTasks) ? tierTasks : []) {
		const executor = String(task?.executor ?? "switchyard")
			.trim()
			.toLowerCase();
		if (executor !== "switchyard") continue;
		const status = String(task?.status ?? "")
			.trim()
			.toLowerCase();
		if (TERMINAL_PREFLIGHT_STATUSES.has(status)) continue;
		const capability = task?.requiredCapability ?? CAPABILITY_CLASS.standard;
		if (!taskTiers.includes(capability)) taskTiers.push(capability);
	}
	if (taskTiers.length === 0) {
		return {
			platform,
			eligible: true,
			ok: true,
			reason: "no_non_terminal_tasks",
			checkedCapabilities: [],
			capabilityResults: [],
			rejections: [],
			rejection: null,
			snapshotStatus: "not_checked",
			snapshotMtime: null,
			snapshotAgeMsAtRoute: null,
		};
	}

	// This is the only snapshot read in the helper. Do not replace this with
	// route() calls per tier: route() intentionally reads its own live snapshot.
	const snapshotRead = readSnapshot(
		Number.isFinite(nowMs) ? nowMs : Date.now(),
	);
	const snapshot = snapshotRead?.snapshot;

	const rejectionFor = (
		capability,
		reason,
		excludedProviders = [],
		excludedReasons = {},
	) => {
		const providers = [...new Set(excludedProviders)].sort((left, right) =>
			left.localeCompare(right),
		);
		const closedReasons = Object.fromEntries(
			providers
				.filter((provider) => Object.hasOwn(excludedReasons, provider))
				.map((provider) => [provider, excludedReasons[provider]]),
		);
		return {
			capability,
			excludedProviders: providers,
			...(Object.keys(closedReasons).length > 0
				? { excludedReasons: closedReasons }
				: {}),
			reason,
		};
	};
	const baseResult = {
		platform,
		snapshotStatus: snapshotRead?.snapshotStatus ?? "malformed",
		snapshotMtime: snapshotRead?.snapshotMtime ?? null,
		snapshotAgeMsAtRoute: snapshotRead?.snapshotAgeMsAtRoute ?? null,
		checkedCapabilities: [...taskTiers],
	};

	// One admission rule, shared with the broker (`snapshotAdmissionFailure`).
	// Preflight used to refuse only a malformed or missing snapshot, so a stale
	// or future generation passed here and was refused later by the broker --
	// after the queue had already paid for workspace create, provision and seed.
	// Refusing on the same terms puts that cost behind the same gate. Production
	// wires no snapshot refresh hook, so the broker's one refresh attempt cannot
	// rescue a stale read there either; if one is ever wired, mirror it here.
	const admissionFailure = !snapshot
		? "snapshot_malformed"
		: snapshotAdmissionFailure(snapshotRead?.snapshotStatus);
	if (admissionFailure !== null) {
		const reason =
			admissionFailure === "snapshot_future"
				? "routing_snapshot_future"
				: admissionFailure === "snapshot_stale"
					? "routing_snapshot_stale"
					: "routing_snapshot_unavailable";
		const rejections = taskTiers.map((capability) =>
			rejectionFor(capability, reason),
		);
		return {
			...baseResult,
			eligible: rejections.length === 0,
			ok: rejections.length === 0,
			reason:
				rejections.length === 0
					? "no_non_terminal_tasks"
					: "provider_eligibility_preflight_failed",
			capabilityResults: [],
			rejections,
			rejection: rejections[0] ?? null,
		};
	}

	const verifiedProviders =
		options.goldenImageVerifiedProviders ?? GOLDEN_IMAGE_VERIFIED_PROVIDERS;
	const normalizedFloor = Number.isFinite(floor) ? floor : DEFAULT_FLOOR;
	const providers = indexProviders(snapshot);
	const capabilityResults = [];
	const rejections = [];

	for (const capability of taskTiers) {
		if (!Object.hasOwn(CAPABILITY_CLASS, capability)) {
			const rejection = rejectionFor(capability, "invalid_capability", [
				...providers.keys(),
			]);
			capabilityResults.push({
				capability,
				eligible: false,
				providers: [],
				excludedProviders: rejection.excludedProviders,
				reason: rejection.reason,
			});
			rejections.push(rejection);
			continue;
		}

		const excludedProviders = [];
		const excludedReasons = {};
		const eligibleProviders = [];
		for (const [name, provider] of providers) {
			const classification = evaluateCandidateEligibility(name, provider, {
				exclude,
				only,
				availableProviders,
				floor: normalizedFloor,
				platform,
				requiredCapability: capability,
				usageMode: "observed",
				goldenImageVerifiedProviders: verifiedProviders,
				hasInvocationDescriptor,
			});
			const health = classification.eligible
				? healthExclusion(name, provider, {
						...options,
						requiredCapability: capability,
						usageMode: "observed",
					})
				: null;
			if (classification.eligible && !health) {
				eligibleProviders.push(name);
			} else {
				excludedProviders.push(name);
				excludedReasons[name] = health
					? "route_health_suppressed"
					: classification.reason;
			}
		}

		const result = {
			capability,
			eligible: eligibleProviders.length > 0,
			providers: eligibleProviders,
			excludedProviders,
			excludedReasons,
			reason:
				eligibleProviders.length > 0
					? "eligible"
					: "no_golden_image_verified_provider_with_quota_headroom",
		};
		capabilityResults.push(result);
		if (!result.eligible) {
			rejections.push(
				rejectionFor(
					capability,
					result.reason,
					result.excludedProviders,
					result.excludedReasons,
				),
			);
		}
	}

	return {
		...baseResult,
		eligible: rejections.length === 0,
		ok: rejections.length === 0,
		reason:
			rejections.length === 0
				? "provider_eligibility_preflight_passed"
				: "provider_eligibility_preflight_failed",
		capabilityResults,
		rejections,
		rejection: rejections[0] ?? null,
	};
}

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
