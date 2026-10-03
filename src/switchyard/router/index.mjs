import {
	CAPABILITY_CLASS,
	getImplementorPriority,
	getRightSizedModel,
	normalizeProviderName,
	PROVIDER_CAPABILITIES,
	resolveTargetId,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { createRouteEvidenceCapture } from "../simple/route-evidence.mjs";
import {
	DEFAULT_FLOOR,
	evaluateCandidateEligibility,
	healthExclusion,
	indexProviders,
	readRosterTargetOrder,
	readSnapshotAtRoute,
} from "./eligibility.mjs";
import { routeBlind } from "./preflight.mjs";
import { computeScore, resolveSeed } from "./scorer.mjs";

export function route(options = {}) {
	const {
		seed,
		runId,
		exclude = [],
		only = [],
		floor = DEFAULT_FLOOR,
		requiredCapability,
		availableProviders,
		platform = "direct",
		goldenImageVerifiedProviders,
		nowMs = Date.now(),
		snapshotRead: suppliedSnapshotRead,
	} = options;
	// Resolve the routing seed up front; it feeds the scorer's deterministic
	// tie-break below (Task 11: equal-headroom candidates are decided by
	// computeScore, not by roster iteration order).
	const { seed: routeSeed } = resolveSeed({ seed, runId });
	const log = [];

	// Missing task-contract capability is the standard lane. Explicit values
	// are validated by the runner boundary (and by the roster filter below).
	const effectiveCapabilityClass =
		requiredCapability ?? CAPABILITY_CLASS.standard;
	const modelForCapability = options.modelForCapability ?? getRightSizedModel;

	// Read snapshot host-side (WR-1). All route-time diagnostics below come
	// from this one resolved path/content read, so status, mtime, and age cannot
	// describe different snapshot generations.
	const snapshotRead =
		suppliedSnapshotRead ??
		readSnapshotAtRoute(Number.isFinite(nowMs) ? nowMs : Date.now());
	const { snapshot, snapshotStatus, snapshotMtime, snapshotAgeMsAtRoute } =
		snapshotRead;
	const snapshotDiagnostics = {
		snapshotStatus,
		snapshotMtime,
		snapshotAgeMsAtRoute,
	};
	const evidence = createRouteEvidenceCapture(snapshotDiagnostics);

	if (platform !== "direct" && platform !== "macos") {
		return evidence.finish({
			provider: null,
			model: null,
			percentLeft: null,
			resolvedTargetId: null,
			requiredCapability: effectiveCapabilityClass,
			reason: "invalid_platform",
			log: [`invalid routing platform: ${platform}`],
			...snapshotDiagnostics,
		});
	}

	const ambiguousFilter = [...exclude, ...only].find(
		(identifier) => resolveTargetIdentity(identifier).ambiguous,
	);
	if (ambiguousFilter) {
		return evidence.finish({
			provider: null,
			model: null,
			percentLeft: null,
			resolvedTargetId: null,
			requiredCapability: effectiveCapabilityClass,
			reason: "ambiguous_target",
			log: [
				`provider selector ${ambiguousFilter} is ambiguous; use an exact target id`,
			],
			...snapshotDiagnostics,
		});
	}

	if (!snapshot) {
		log.push(`snapshot ${snapshotStatus} — routing blind`);
		// Wire the blind fallback into the real path: a missing/broken snapshot
		// must not silently halt every task behind it. Candidates are ordered
		// by roster declaration order (highest capability first) and still
		// respect the capability filter and caller-supplied availability/exclude.
		const blindOrder = Object.keys(PROVIDER_CAPABILITIES);
		const blind = routeBlind(blindOrder, exclude, effectiveCapabilityClass, {
			only,
			availableProviders,
			platform,
			goldenImageVerifiedProviders,
			hasInvocationDescriptor: options.hasInvocationDescriptor,
			healthDecision: options.healthDecision,
			onHealthDecision: options.onHealthDecision,
			evidenceCapture: evidence,
		});
		const model = blind.provider
			? modelForCapability(blind.provider, effectiveCapabilityClass)
			: null;
		return evidence.finish({
			...blind,
			model,
			percentLeft: null,
			resolvedTargetId: blind.provider ? resolveTargetId(blind.provider) : null,
			requiredCapability: effectiveCapabilityClass,
			reason: blind.reason,
			log: [...log, `blind candidates: ${blindOrder.join(", ") || "none"}`],
			...snapshotDiagnostics,
		});
	}

	const providers = indexProviders(snapshot);

	// Task D.3 (diagnosable no-eligible outcomes): classify every skip so that
	// when nothing scores we can tell a deterministic INV-5 capability-ceiling
	// exhaustion (expected, not actionable) from an upstream-unavailable case
	// (a provider that WOULD be eligible but is unreachable — actionable, go
	// check credentials/upstream status). `ceilingSkips` counts the INV-5
	// capability-filter rejections, `otherSkips` every other non-unavailable
	// rejection (no-adapter, excluded, exhausted, no-windows, ranked-provider
	// drained, ac/ap exhausted), and `firstUnavailable` captures the first
	// `ok:false` provider (in iteration order) with its snapshot `error`
	// string, which is already redacted/capped upstream and safe to surface.
	let ceilingSkips = 0;
	let otherSkips = 0;
	let firstUnavailable = null;
	let unresolvedTargetSkips = 0;
	let ambiguousTargetSkips = 0;

	// Implementor-priority routing partitions survivors by roster-declared tier.
	// Tier 1 picks the eligible target furthest ahead of pace (roster order
	// breaks ties); tiers 2 and 3 spread within their own tier.
	// Other numeric priorities remain in the legacy ranked pool so older roster
	// entries retain their prior behavior.
	//   - unrankedPool: every other funded provider (Claude, Codex,
	//     opencode-go, ...), using the EXACT pre-existing floor+spread
	//     semantics, byte-identical to today.
	//   - lastResortPool: Cursor's `ap` (API) window alone, gated by the
	//     ordinary DEFAULT_FLOOR — only reachable once both pools above are
	//     empty (see the winner-resolution precedence below).
	const tierPools = new Map([
		[1, []],
		[2, []],
		[3, []],
	]);
	const legacyRankedPool = [];
	const unrankedPool = [];
	const lastResortPool = [];
	const rosterTargetOrder = readRosterTargetOrder();

	function rosterOrderOf(name) {
		const identity = resolveTargetIdentity(name);
		return {
			index:
				rosterTargetOrder.get(identity.targetId) ?? Number.POSITIVE_INFINITY,
			targetId: identity.targetId ?? "",
			name,
		};
	}

	// Minimum finite pace_delta across a set of windows — Task 10's
	// reduce-based min (never Math.min(...spread), which blows the call stack
	// on an oversized windows array), 0 fallback when none is finite. Shared
	// by every pool: the unranked pool uses it over all of a provider's
	// windows (unchanged), the ranked pool the same way, and Cursor's ac/ap
	// candidates each pass their own single-window array.
	function computePace(windowSet) {
		const paces = windowSet
			.map((w) => w.pace_delta)
			.filter((p) => typeof p === "number" && Number.isFinite(p));
		return paces.length > 0
			? paces.reduce((min, p) => Math.min(min, p), Infinity)
			: 0;
	}

	// Classify each provider by eligibility, then add it to the appropriate
	// policy tier. Snapshot iteration order is never used for tier-1 choice.
	for (const [name, provider] of providers) {
		// CR-3: tolerate absent providers - but we're iterating present ones,
		// absent providers simply won't be in the map. This is the tolerance.
		const eligibility = evaluateCandidateEligibility(name, provider, {
			requiredCapability: effectiveCapabilityClass,
			exclude,
			only,
			availableProviders,
			floor,
			platform,
			usageMode: "observed",
			goldenImageVerifiedProviders,
			hasInvocationDescriptor: options.hasInvocationDescriptor,
		});
		if (!eligibility.eligible) {
			evidence.exclude(name, eligibility.reason);
			if (eligibility.reason === "below_required_capability") {
				ceilingSkips += 1;
			} else if (eligibility.reason === "provider_unavailable") {
				if (firstUnavailable === null) {
					firstUnavailable = { name, error: provider.error ?? null };
				}
			} else {
				otherSkips += 1;
				if (eligibility.reason === "target_identity_unavailable") {
					unresolvedTargetSkips += 1;
					if (resolveTargetIdentity(name).ambiguous) ambiguousTargetSkips += 1;
				}
			}
			const rejectionLog = {
				target_identity_unavailable: `provider ${name}: target identity unavailable`,
				adapter_unavailable: `provider ${name}: no adapter available for this dispatcher`,
				explicitly_excluded: `provider ${name}: explicitly excluded`,
				not_in_only_allowlist: `provider ${name}: not in --only-provider allowlist`,
				below_required_capability: `provider ${name}: below required capability ${effectiveCapabilityClass}`,
				no_invocation_descriptor: `provider ${name}: no usable invocation descriptor for ${effectiveCapabilityClass}`,
				not_configured: `provider ${name}: no ${effectiveCapabilityClass} slot resolves a descriptor (roster data, not qualification)`,
				qualification_missing: `provider ${name}: never dispatch-qualified; run an authorized canary for ${effectiveCapabilityClass}`,
				qualification_superseded: `provider ${name}: dispatch receipts exist but none for today's ${effectiveCapabilityClass} descriptor; the slot moved — re-canary the new one`,
				qualification_expired: `provider ${name}: ${effectiveCapabilityClass} dispatch receipt no longer describes this environment (aged out, or CLI/wrapper/credential drift); re-run the canary and promote the refreshed receipt`,
				qualification_invalid: `provider ${name}: ${effectiveCapabilityClass} dispatch receipt cannot authorize dispatch (missing promotion receipt or untransmittable evidence)`,
				provider_unavailable: `provider ${name}: unavailable (ok=false)`,
			};
			log.push(
				rejectionLog[eligibility.reason] ??
					`provider ${name}: ${eligibility.reason}`,
			);
			continue;
		}
		const health = healthExclusion(name, provider, {
			...options,
			requiredCapability: effectiveCapabilityClass,
			usageMode: "observed",
		});
		if (health) {
			evidence.exclude(name, "route_health_suppressed");
			otherSkips += 1;
			log.push(`provider ${name}: route health ${health.state}`);
			continue;
		}

		const windows = (provider.windows ?? []).filter(
			(w) =>
				typeof w?.percent_left === "number" && Number.isFinite(w.percent_left),
		);

		if (windows.length === 0) {
			evidence.exclude(name, "no_valid_windows");
			otherSkips += 1;
			log.push(`provider ${name}: no valid windows`);
			continue;
		}

		const priority = getImplementorPriority(name);
		const isCursor = normalizeProviderName(name) === "cursor";

		if (isCursor) {
			// Cursor's `ac` (auto/1st-party) and `ap` (API) windows are no
			// longer pooled: `ac` alone is the rank-3 priority-fill candidate
			// (0% floor, matched by w.id, never array position), `ap` alone is
			// a separate last-resort candidate gated by the ordinary
			// DEFAULT_FLOOR regardless of the caller-supplied floor — reserved,
			// almost never used.
			const acWindow = windows.find((w) => w.id === "ac");
			const apWindow = windows.find((w) => w.id === "ap");

			if (acWindow && priority !== null) {
				if (acWindow.percent_left > 0) {
					const candidate = {
						name,
						percentLeft: acWindow.percent_left,
						pace: computePace([acWindow]),
						priority,
						rosterOrder: rosterOrderOf(name),
						// The bucket this candidate would actually draw on. Cursor's
						// ac and ap are separate accounts, so the reservation must be
						// keyed to the one that wins, not to both.
						accountingWindows: [acWindow],
					};
					if (tierPools.has(priority)) tierPools.get(priority).push(candidate);
					else legacyRankedPool.push(candidate);
					log.push(
						`provider ${name}: eligible for priority fill via ac (${acWindow.percent_left}% left, priority ${priority})`,
					);
				} else {
					otherSkips += 1;
					evidence.exclude(name, "quota_exhausted", "ac");
					log.push(
						`provider ${name}: ac window drained (${acWindow.percent_left}% <= 0% floor)`,
					);
				}
			} else {
				otherSkips += 1;
				evidence.exclude(name, "accounting_bucket_unavailable", "ac");
				log.push(
					`provider ${name}: no ac window (or no roster implementor_priority) for priority fill`,
				);
			}

			if (apWindow) {
				if (apWindow.percent_left >= DEFAULT_FLOOR) {
					lastResortPool.push({
						name,
						percentLeft: apWindow.percent_left,
						pace: computePace([apWindow]),
						accountingWindows: [apWindow],
					});
					log.push(
						`provider ${name}: eligible as last-resort via ap (${apWindow.percent_left}% left)`,
					);
				} else {
					otherSkips += 1;
					evidence.exclude(name, "quota_exhausted", "ap");
					log.push(
						`provider ${name}: ap exhausted (${apWindow.percent_left}% < ${DEFAULT_FLOOR}% floor)`,
					);
				}
			} else {
				otherSkips += 1;
				evidence.exclude(name, "accounting_bucket_unavailable", "ap");
				log.push(`provider ${name}: no ap window for last-resort fallback`);
			}

			continue;
		}

		// Health = MIN across valid windows (worst window vetoes) — unchanged
		// for every non-Cursor provider.
		const minPercentLeft = windows.reduce(
			(min, w) => Math.min(min, w.percent_left),
			Infinity,
		);

		if (priority !== null) {
			// Ranked ("cheap implementor") provider: hardcoded 0% floor,
			// regardless of the caller-supplied floor option — a deliberate
			// policy override, not just a new default.
			if (minPercentLeft > 0) {
				const candidate = {
					name,
					percentLeft: minPercentLeft,
					pace: computePace(windows),
					priority,
					rosterOrder: rosterOrderOf(name),
					accountingWindows: windows,
				};
				if (tierPools.has(priority)) tierPools.get(priority).push(candidate);
				else legacyRankedPool.push(candidate);
				log.push(
					`provider ${name}: eligible for priority fill (${minPercentLeft}% left, priority ${priority})`,
				);
			} else {
				otherSkips += 1;
				evidence.exclude(name, "quota_exhausted");
				log.push(
					`provider ${name}: ranked provider drained (${minPercentLeft}% <= 0% floor)`,
				);
			}
			continue;
		}

		// Unranked: exact pre-existing floor + spread semantics.
		if (minPercentLeft < floor) {
			otherSkips += 1;
			evidence.exclude(name, "quota_exhausted");
			log.push(
				`provider ${name}: exhausted (${minPercentLeft}% < ${floor}% floor)`,
			);
			continue; // INV-4: skip exhausted providers
		}

		const pace = computePace(windows);
		unrankedPool.push({
			name,
			percentLeft: minPercentLeft,
			pace,
			accountingWindows: windows,
		});
		log.push(
			`provider ${name}: eligible (${minPercentLeft}% left, pace=${pace})`,
		);
	}

	const candidatePools = [
		...tierPools.values(),
		legacyRankedPool,
		unrankedPool,
		lastResortPool,
	];
	for (const pool of candidatePools) {
		for (const candidate of pool)
			evidence.candidate(
				candidate.name,
				candidate.accountingWindows,
				candidate.priority,
			);
	}

	// Resolve a load-balanced pool by best metric (highest percentLeft),
	// tie-breaking equal metrics with the documented scorer.
	function resolveWinner(pool, metricOf, isBetter, describeMetric) {
		let best = pool[0];
		for (const item of pool) {
			if (isBetter(metricOf(item), metricOf(best))) best = item;
		}
		const bestMetric = metricOf(best);
		const tied = pool.filter((item) => metricOf(item) === bestMetric);
		if (tied.length > 1) {
			const allPaces = tied.map((s) => s.pace);
			let bestScore = Number.NEGATIVE_INFINITY;
			for (const s of tied) {
				const model = getRightSizedModel(s.name, effectiveCapabilityClass);
				const key = `${s.name}:${model ?? effectiveCapabilityClass}`;
				const { score } = computeScore(s.pace, routeSeed, key, allPaces);
				if (score > bestScore) {
					bestScore = score;
					best = s;
				}
			}
			log.push(
				`tie ${describeMetric(bestMetric)} among ${tied.map((s) => s.name).join(", ")} — scorer picked ${best.name}`,
			);
		}
		return best;
	}

	// Tier 1 picks the eligible target furthest ahead of pace (highest
	// minimum Gradus pace_delta across its windows). It deliberately does
	// not inspect headroom, jitter, seed, or snapshot order once eligibility
	// has been established. The roster target order is the policy's stable
	// tie-break; target id/name keeps malformed or synthetic rosters
	// deterministic.
	function resolveTierOneWinner(pool) {
		// Unknown pace ranks below any measured pace.
		const paceKey = (candidate) =>
			(candidate.accountingWindows ?? []).some(
				(w) =>
					typeof w.pace_delta === "number" && Number.isFinite(w.pace_delta),
			)
				? candidate.pace
				: -Infinity;

		return pool.reduce((best, candidate) => {
			const candidateKey = paceKey(candidate);
			const bestKey = paceKey(best);
			if (candidateKey !== bestKey) {
				return candidateKey > bestKey ? candidate : best;
			}
			const current = candidate.rosterOrder;
			const incumbent = best.rosterOrder;
			if (current.index !== incumbent.index) {
				return current.index < incumbent.index ? candidate : best;
			}
			if (current.targetId !== incumbent.targetId) {
				return current.targetId < incumbent.targetId ? candidate : best;
			}
			return current.name < incumbent.name ? candidate : best;
		});
	}

	let winner;
	let reason;

	if (tierPools.get(1).length > 0) {
		winner = resolveTierOneWinner(tierPools.get(1));
		reason = "priority_fill";
	} else if (tierPools.get(2).length > 0) {
		winner = resolveWinner(
			tierPools.get(2),
			(s) => s.percentLeft,
			(a, b) => a > b,
			(metric) => `tier 2 at ${metric}%`,
		);
		reason = "priority_fill";
	} else if (tierPools.get(3).length > 0) {
		winner = resolveWinner(
			tierPools.get(3),
			(s) => s.percentLeft,
			(a, b) => a > b,
			(metric) => `tier 3 at ${metric}%`,
		);
		reason = "priority_fill";
	} else if (legacyRankedPool.length > 0) {
		winner = resolveWinner(
			legacyRankedPool,
			(s) => s.priority,
			(a, b) => a < b,
			(metric) => `legacy priority ${metric}`,
		);
		reason = "priority_fill";
	} else if (unrankedPool.length > 0) {
		// Spread: favor most remaining headroom (highest percent_left).
		// This differs from review-plugin's pace-based spread because
		// switchyard wants to drain aggregate capacity, not optimize for pace.
		winner = resolveWinner(
			unrankedPool,
			(s) => s.percentLeft,
			(a, b) => a > b,
			(metric) => `at ${metric}%`,
		);
		reason = "spread";
	} else if (lastResortPool.length > 0) {
		// At most one candidate (Cursor's ap window) — trivial, no tie-break.
		winner = lastResortPool[0];
		reason = "last_resort_fallback";
	} else {
		log.push("no eligible providers");
		// Task D.3: replace the bare generic reason with the most actionable
		// classification, in this exact precedence:
		//   1. an upstream-unavailable provider (ok=false) — actionable, go
		//      check credentials/upstream status. Surface the FIRST such
		//      provider in iteration order with its (already redacted) error.
		//   2. otherwise, if every skip was the deterministic INV-5 capability
		//      ceiling (zero unavailable, zero other skips) — expected, not
		//      actionable.
		//   3. otherwise keep the generic no_eligible unchanged (mixed or
		//      non-ceiling skips: exhausted-floor, excluded, no-adapter,
		//      no-windows, ranked-drained, ac/ap-exhausted) — relied on by the
		//      existing exhaustion-floor test.
		let noEligibleReason = "no_eligible";
		if (firstUnavailable !== null) {
			const error = firstUnavailable.error ?? "unknown error";
			noEligibleReason = `no_eligible_upstream_unavailable: ${firstUnavailable.name} — ${error}`;
		} else if (ceilingSkips > 0 && otherSkips === 0) {
			noEligibleReason = "no_eligible_capability_ceiling";
		} else if (
			ambiguousTargetSkips > 0 &&
			unresolvedTargetSkips === otherSkips
		) {
			noEligibleReason = "quarantine_unresolvable";
		}
		return evidence.finish({
			provider: null,
			model: null,
			percentLeft: null,
			resolvedTargetId: null,
			requiredCapability: effectiveCapabilityClass,
			reason: noEligibleReason,
			log,
			...snapshotDiagnostics,
		});
	}

	// CR-2 regression
	log.push(`winner: ${winner.name} with ${winner.percentLeft}% left`);

	// INV-5: Model right-sizing
	const model = modelForCapability(winner.name, effectiveCapabilityClass);
	if (!model) {
		log.push(
			`no model for ${winner.name} at required capability ${effectiveCapabilityClass}`,
		);
	}

	return evidence.finish({
		provider: winner.name,
		model,
		percentLeft: winner.percentLeft,
		resolvedTargetId: resolveTargetId(winner.name),
		requiredCapability: effectiveCapabilityClass,
		// The exact quota buckets this selection draws on, carried so the broker
		// can key a reservation to the real accounting window instead of to the
		// snapshot file's mtime. Observation metadata stays in
		// `snapshotDiagnostics`; this is billing identity.
		accountingWindows: winner.accountingWindows ?? null,
		reason,
		log,
		...snapshotDiagnostics,
	});
}

export {
	evaluateCandidateEligibility,
	GOLDEN_IMAGE_VERIFIED_PROVIDERS,
	readSnapshotAtRoute,
	resolveSnapshotPath,
	SNAPSHOT_PATH,
} from "./eligibility.mjs";

export { preflightMacosQueue, routeBlind } from "./preflight.mjs";
