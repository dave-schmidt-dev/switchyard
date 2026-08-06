// Router module - selects provider for task dispatch
// INV-4: Dispatch only to funded providers, spreading load across funded providers
// INV-5: Capability filter applied before spread selection
// Low-capability economics: easy tasks become eligible for cheap/low-cost
// lanes (e.g. opencode-go), while high-capability tasks remain reserved for
// high-capability providers (Claude/Codex).
// INV-4 most-headroom spread selects among eligible lanes without cost-override or fixed ratios.
//
// Reuses review-plugin's capacity scoring (0.9·pace + 0.1·jitter, floor/skip, blind fallback)
// CR-2: EXCLUDED_FAMILIES removed - Claude is routable
// CR-3: Tolerate absent providers - skip, never crash

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CAPABILITY_CLASS,
	getCapabilityClass,
	getImplementorPriority,
	getRightSizedModel,
	hasAutomaticInvocationDescriptor,
	normalizeProviderName,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
	resolveTargetId,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { computeScore, resolveSeed } from "./scorer.mjs";

/**
 * Task C.6/C.9: does `identifier` (an `--only-provider`/`--exclude-provider`
 * value, which per Task B.1 is a roster TARGET id, e.g. "antigravity-claude")
 * refer to the same provider as a live snapshot candidate `name` (a raw
 * display name, e.g. "Antigravity (Claude)")?
 *
 * Prefers target-id identity — the only thing that can tell apart two
 * simultaneously-enabled targets sharing one harness (the two agy buckets) —
 * and falls back to harness-normalized matching only when either side can't
 * be resolved to a target id (roster unavailable, a harness-only identifier
 * like "codex" with no ambiguity to resolve, or a test with no roster
 * loaded). The fallback is what keeps every existing single-target-harness
 * caller's behavior byte-identical.
 * @param {string} identifier
 * @param {string} name
 * @returns {boolean}
 */
function providerMatches(identifier, name) {
	const identifierResolution = resolveTargetIdentity(identifier);
	const nameResolution = resolveTargetIdentity(name);
	if (identifierResolution.ambiguous || nameResolution.ambiguous) return false;
	const identifierTargetId = identifierResolution.targetId;
	const nameTargetId = nameResolution.targetId;
	if (identifierTargetId && nameTargetId) {
		return identifierTargetId === nameTargetId;
	}
	return normalizeProviderName(identifier) === normalizeProviderName(name);
}

// Snapshot path - host-side, code constant (WR-1: routing is host-side)
const SNAPSHOT_PATH = join(
	homedir(),
	"Documents/Projects/gradus/.state/snapshot-v2.json",
);

// Test-only escape hatch: tests/router.test.mjs and tests/runner.test.mjs both
// exercise the real readSnapshot() (the latter indirectly, via runQueue's
// default route()), and node --test runs test files concurrently as separate
// processes. Pointing every test at the same real SNAPSHOT_PATH made them race
// on one shared on-disk file. Read dynamically (inside the function, not
// hoisted to module load) so each test process can set its own unique temp
// path — a value read once at import time would be fixed before a test ever
// gets to set it. Production callers never set this env var, so
// resolveSnapshotPath() always returns the real SNAPSHOT_PATH for them.
function resolveSnapshotPath() {
	return process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE || SNAPSHOT_PATH;
}

const EXPECTED_SCHEMA_VERSION = 2;
const DEFAULT_FLOOR = 5.0; // percent_left floor for skipping exhausted providers
const SNAPSHOT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Snapshot reading

/**
 * Read the path and content used for one route exactly once, while deriving
 * diagnostics from that same read. `snapshotAgeMsAtRoute` is based on the
 * producer timestamp (`updated_at`); `snapshotMtime` remains the filesystem
 * mtime so operators can distinguish a fresh file write from fresh producer
 * data.
 *
 * @param {number} nowMs
 * @returns {{snapshot: object|null, snapshotStatus: string, snapshotMtime: number|null, snapshotAgeMsAtRoute: number|null}}
 */
function readSnapshotAtRoute(nowMs) {
	const path = resolveSnapshotPath();
	let snapshotMtime = null;
	let raw;
	try {
		const stat = statSync(path);
		snapshotMtime = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return {
			snapshot: null,
			snapshotStatus: error?.code === "ENOENT" ? "missing" : "malformed",
			snapshotMtime,
			snapshotAgeMsAtRoute: null,
		};
	}

	let snapshot;
	try {
		snapshot = JSON.parse(raw);
	} catch {
		return {
			snapshot: null,
			snapshotStatus: "malformed",
			snapshotMtime,
			snapshotAgeMsAtRoute: null,
		};
	}

	if (!isValidSnapshot(snapshot)) {
		return {
			snapshot: null,
			snapshotStatus: "malformed",
			snapshotMtime,
			snapshotAgeMsAtRoute: null,
		};
	}

	const updatedAtMs = Date.parse(snapshot.updated_at);
	if (!Number.isFinite(updatedAtMs)) {
		return {
			snapshot,
			snapshotStatus: "malformed",
			snapshotMtime,
			snapshotAgeMsAtRoute: null,
		};
	}

	const snapshotAgeMsAtRoute = nowMs - updatedAtMs;
	const snapshotStatus =
		snapshotAgeMsAtRoute < 0
			? "future"
			: snapshotAgeMsAtRoute >= SNAPSHOT_STALE_THRESHOLD_MS
				? "stale"
				: "fresh";
	return {
		snapshot,
		snapshotStatus,
		snapshotMtime,
		snapshotAgeMsAtRoute,
	};
}

/**
 * Check if snapshot is valid (not null, correct schema, parseable).
 */
function isValidSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== "object") return false;
	if (snapshot.schema_version !== EXPECTED_SCHEMA_VERSION) return false;
	return Array.isArray(snapshot.providers);
}

/**
 * Index providers by name for quick lookup.
 */
function indexProviders(snapshot) {
	const map = new Map();
	for (const provider of snapshot.providers ?? []) {
		map.set(provider.name, provider);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Routing with spread selection (INV-4)

/**
 * Route to the provider with most remaining headroom.
 * Filters: not absent from snapshot (CR-3), not exhausted (below floor),
 * capability filter (INV-5) applied before spread selection.
 * Spread: pick highest headroom among eligible.
 * Model: right-sized to the task's required capability (INV-5).
 *
 * @param {object} options
 * @param {number} [options.seed] Explicit seed
 * @param {string} [options.runId] Run ID for seed derivation
 * @param {string[]} [options.exclude] Provider names to explicitly exclude
 * @param {string[]} [options.only] Provider names/target ids to restrict routing to. Mutually exclusive with exclude at the CLI layer, which rejects that combination before it reaches here; if both were passed directly to route() anyway, exclude is checked first and wins for any name present in both lists.
 * @param {number} [options.floor] Percent left floor (default: DEFAULT_FLOOR)
 * @param {string} [options.requiredCapability] Required capability class
 *   (high/standard/low) for INV-5. Omitted values use standard.
 * @param {string[]} [options.availableProviders] Restrict candidates to providers
 *   the caller can actually dispatch to (e.g. the runner's registered adapters).
 *   Omit to consider every roster/snapshot provider (existing behavior).
 * @returns {{provider: string|null, model: string|null, percentLeft: number|null,
 *   requiredCapability: string, reason: string, log: string[]}} Routing result
 */
export function route(options = {}) {
	const {
		seed,
		runId,
		exclude = [],
		only = [],
		floor = DEFAULT_FLOOR,
		requiredCapability,
		availableProviders,
		nowMs = Date.now(),
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
	const isAvailable = (name) => {
		if (!availableProviders) return true;
		/*
		 * A snapshot display name can identify a target whose harness is shared
		 * with another target (for example `Vibe` and `OpenCode Go` both use the
		 * OpenCode adapter). Resolve the display name to its declared harness
		 * before comparing it with the adapter registry; normalizing `Vibe` to a
		 * fictional `vibe` adapter would incorrectly reject the OpenCode-backed
		 * implementation route.
		 */
		const requestedIdentity = resolveTargetIdentity(name);
		const requestedHarness = requestedIdentity.targetId
			? requestedIdentity.harnessKey
			: normalizeProviderName(name);
		return availableProviders.some((provider) => {
			const providerIdentity = resolveTargetIdentity(provider);
			const availableHarness = providerIdentity.targetId
				? providerIdentity.harnessKey
				: normalizeProviderName(provider);
			return availableHarness === requestedHarness;
		});
	};

	// Read snapshot host-side (WR-1). All route-time diagnostics below come
	// from this one resolved path/content read, so status, mtime, and age cannot
	// describe different snapshot generations.
	const snapshotRead = readSnapshotAtRoute(
		Number.isFinite(nowMs) ? nowMs : Date.now(),
	);
	const { snapshot, snapshotStatus, snapshotMtime, snapshotAgeMsAtRoute } =
		snapshotRead;
	const snapshotDiagnostics = {
		snapshotStatus,
		snapshotMtime,
		snapshotAgeMsAtRoute,
	};

	const ambiguousFilter = [...exclude, ...only].find(
		(identifier) => resolveTargetIdentity(identifier).ambiguous,
	);
	if (ambiguousFilter) {
		return {
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
		};
	}

	if (!snapshot) {
		log.push(`snapshot ${snapshotStatus} — routing blind`);
		// Wire the blind fallback into the real path: a missing/broken snapshot
		// must not silently halt every task behind it. Candidates are ordered
		// by roster declaration order (highest capability first) and still
		// respect the capability filter and caller-supplied availability/exclude.
		const unresolvedBlind = [];
		const blindOrder = Object.keys(PROVIDER_CAPABILITIES).filter((name) => {
			const identity = resolveTargetIdentity(name);
			if (!identity.targetId) {
				if (identity.ambiguous) unresolvedBlind.push(name);
				return false;
			}
			return (
				isAvailable(name) &&
				passesCapabilityFilter(name, effectiveCapabilityClass) &&
				hasAutomaticInvocationDescriptor(name, effectiveCapabilityClass) &&
				(only.length === 0 || only.some((o) => providerMatches(o, name)))
			);
		});
		const blind = routeBlind(blindOrder, exclude, effectiveCapabilityClass);
		const model = blind.provider
			? getRightSizedModel(blind.provider, effectiveCapabilityClass)
			: null;
		return {
			...blind,
			model,
			percentLeft: null,
			resolvedTargetId: blind.provider ? resolveTargetId(blind.provider) : null,
			requiredCapability: effectiveCapabilityClass,
			reason:
				blind.provider || unresolvedBlind.length === 0
					? blind.reason
					: "quarantine_unresolvable",
			log: [
				...log,
				...(unresolvedBlind.length > 0
					? [`ambiguous blind targets skipped: ${unresolvedBlind.join(", ")}`]
					: []),
				`blind candidates: ${blindOrder.join(", ") || "none"}`,
			],
			...snapshotDiagnostics,
		};
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

	// implementor-priority-waterfall-routing plan: survivors of the checks
	// above partition into three pools instead of one flat scored array.
	//   - rankedPool: providers whose roster target sets implementor_priority
	//     (the "cheap implementor" waterfall — Antigravity's two buckets,
	//     Copilot, Cursor's `ac` window). Drained to a hardcoded 0% floor,
	//     strictly in priority order — INV-4's headroom spread does not apply
	//     WITHIN this pool.
	//   - unrankedPool: every other funded provider (Claude, Codex,
	//     opencode-go, ...), using the EXACT pre-existing floor+spread
	//     semantics, byte-identical to today.
	//   - lastResortPool: Cursor's `ap` (API) window alone, gated by the
	//     ordinary DEFAULT_FLOOR — only reachable once both pools above are
	//     empty (see the winner-resolution precedence below).
	const rankedPool = [];
	const unrankedPool = [];
	const lastResortPool = [];

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

	// Score each provider by headroom (percent_left)
	for (const [name, provider] of providers) {
		// CR-3: tolerate absent providers - but we're iterating present ones,
		// absent providers simply won't be in the map. This is the tolerance.
		const targetIdentity = resolveTargetIdentity(name);
		if (!targetIdentity.targetId) {
			otherSkips += 1;
			unresolvedTargetSkips += 1;
			if (targetIdentity.ambiguous) ambiguousTargetSkips += 1;
			log.push(
				`provider ${name}: target identity unavailable${targetIdentity.ambiguous ? " (ambiguous harness)" : ""}`,
			);
			continue;
		}

		if (!isAvailable(name)) {
			otherSkips += 1;
			log.push(`provider ${name}: no adapter available for this dispatcher`);
			continue;
		}

		if (exclude.some((excluded) => providerMatches(excluded, name))) {
			otherSkips += 1;
			log.push(`provider ${name}: explicitly excluded`);
			continue;
		}

		if (only.length > 0 && !only.some((o) => providerMatches(o, name))) {
			otherSkips += 1;
			log.push(`provider ${name}: not in --only-provider allowlist`);
			continue;
		}

		// INV-5: Capability filter - skip providers below the task's required
		// capability.
		if (!passesCapabilityFilter(name, effectiveCapabilityClass)) {
			ceilingSkips += 1;
			log.push(
				`provider ${name}: below required capability ${effectiveCapabilityClass}`,
			);
			continue;
		}

		// Selector-only compatibility qualifications can describe an eligible
		// capability lane, but automatic dispatch needs current, exact evidence
		// for the target/model/argv it would transmit. Keep an explicitly named
		// target distinct: it is rejected here rather than falling through to a
		// sibling that shares its harness.
		if (!hasAutomaticInvocationDescriptor(name, effectiveCapabilityClass)) {
			otherSkips += 1;
			log.push(
				`provider ${name}: no current exact invocation descriptor for ${effectiveCapabilityClass}`,
			);
			continue;
		}

		if (!provider.ok) {
			if (firstUnavailable === null) {
				firstUnavailable = { name, error: provider.error ?? null };
			}
			log.push(`provider ${name}: unavailable (ok=false)`);
			continue;
		}

		// Task 13: require finite percent_left, matching the pace filter below.
		// typeof NaN === "number", so a NaN'd window would otherwise pass here,
		// propagate through minPercentLeft, and (NaN < floor === false) evade the
		// exhausted-skip — an INV-4 bypass.
		const windows = (provider.windows ?? []).filter(
			(w) =>
				typeof w?.percent_left === "number" && Number.isFinite(w.percent_left),
		);

		if (windows.length === 0) {
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
					rankedPool.push({
						name,
						percentLeft: acWindow.percent_left,
						pace: computePace([acWindow]),
						priority,
					});
					log.push(
						`provider ${name}: eligible for priority fill via ac (${acWindow.percent_left}% left, priority ${priority})`,
					);
				} else {
					otherSkips += 1;
					log.push(
						`provider ${name}: ac window drained (${acWindow.percent_left}% <= 0% floor)`,
					);
				}
			} else {
				otherSkips += 1;
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
					});
					log.push(
						`provider ${name}: eligible as last-resort via ap (${apWindow.percent_left}% left)`,
					);
				} else {
					otherSkips += 1;
					log.push(
						`provider ${name}: ap exhausted (${apWindow.percent_left}% < ${DEFAULT_FLOOR}% floor)`,
					);
				}
			} else {
				otherSkips += 1;
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
				rankedPool.push({
					name,
					percentLeft: minPercentLeft,
					pace: computePace(windows),
					priority,
				});
				log.push(
					`provider ${name}: eligible for priority fill (${minPercentLeft}% left, priority ${priority})`,
				);
			} else {
				otherSkips += 1;
				log.push(
					`provider ${name}: ranked provider drained (${minPercentLeft}% <= 0% floor)`,
				);
			}
			continue;
		}

		// Unranked: exact pre-existing floor + spread semantics.
		if (minPercentLeft < floor) {
			otherSkips += 1;
			log.push(
				`provider ${name}: exhausted (${minPercentLeft}% < ${floor}% floor)`,
			);
			continue; // INV-4: skip exhausted providers
		}

		const pace = computePace(windows);
		unrankedPool.push({ name, percentLeft: minPercentLeft, pace });
		log.push(
			`provider ${name}: eligible (${minPercentLeft}% left, pace=${pace})`,
		);
	}

	// Resolve the winner of a pool by best metric (lowest for priority rank,
	// highest for percentLeft headroom), tie-breaking equal-metric candidates
	// with the documented scorer (0.9·normPace + 0.1·jitter, Task 11) — the
	// SAME mechanism the pre-existing equal-percentLeft tie-break used, now
	// shared by both the unranked spread pool and the ranked priority pool.
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

	let winner;
	let reason;

	if (rankedPool.length > 0) {
		// True waterfall: strictly lowest implementor_priority wins, never
		// compared against headroom across ranks (rank 1 wins over rank 2 even
		// with less headroom left). Equal-priority candidates (the two
		// Antigravity buckets, both priority 1) fall to the scorer.
		winner = resolveWinner(
			rankedPool,
			(s) => s.priority,
			(a, b) => a < b,
			(metric) => `at priority ${metric}`,
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
		return {
			provider: null,
			model: null,
			percentLeft: null,
			resolvedTargetId: null,
			requiredCapability: effectiveCapabilityClass,
			reason: noEligibleReason,
			log,
			...snapshotDiagnostics,
		};
	}

	// CR-2 regression
	log.push(`winner: ${winner.name} with ${winner.percentLeft}% left`);

	// INV-5: Model right-sizing
	const model = getRightSizedModel(winner.name, effectiveCapabilityClass);
	if (!model) {
		log.push(
			`no model for ${winner.name} at required capability ${effectiveCapabilityClass}`,
		);
	}

	return {
		provider: winner.name,
		model,
		percentLeft: winner.percentLeft,
		resolvedTargetId: resolveTargetId(winner.name),
		requiredCapability: effectiveCapabilityClass,
		reason,
		log,
		...snapshotDiagnostics,
	};
}

// ---------------------------------------------------------------------------
// Blind fallback when snapshot is unavailable

/**
 * Blind fallback: use explicit provider order when snapshot unavailable.
 * Still enforces INV-4's floor concept by returning null if all are exhausted
 * (though in blind mode we can't know that).
 *
 * @param {string[]} providerOrder Ordered list of provider names to try
 * @param {string[]} [exclude] Providers to exclude
 * @param {string} [requiredCapability] Capability class already resolved by route()
 * @returns {{provider: string|null, model: null, reason: string}} Result
 */
export function routeBlind(
	providerOrder,
	exclude = [],
	requiredCapability = CAPABILITY_CLASS.standard,
) {
	const ambiguousFilter = exclude.find(
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

	for (const name of providerOrder) {
		const identity = resolveTargetIdentity(name);
		if (!identity.targetId) {
			if (identity.ambiguous) {
				return {
					provider: null,
					model: null,
					resolvedTargetId: null,
					reason: "quarantine_unresolvable",
				};
			}
			continue;
		}
		// Blind callers may provide an explicit order, so repeat the roster's
		// automatic-eligibility gates here. An explicitly disabled or
		// selector-only target cannot bypass route()'s generated blindOrder.
		if (getCapabilityClass(name) === null) continue;
		if (!hasAutomaticInvocationDescriptor(name, requiredCapability)) continue;
		const excluded = exclude.some((excludedName) =>
			providerMatches(excludedName, name),
		);
		if (!excluded) {
			return {
				provider: name,
				model: null,
				resolvedTargetId: identity.targetId,
				reason: "blind_fallback",
			};
		}
	}
	return {
		provider: null,
		model: null,
		resolvedTargetId: null,
		reason: "no_eligible_blind",
	};
}
