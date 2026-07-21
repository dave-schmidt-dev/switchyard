// Router module - selects provider for task dispatch
// INV-4: Dispatch only to funded providers, spreading load across funded providers
// INV-5: Capability filter applied before spread selection
//
// Reuses review-plugin's capacity scoring (0.9·pace + 0.1·jitter, floor/skip, blind fallback)
// CR-2: EXCLUDED_FAMILIES removed - Claude is routable
// CR-3: Tolerate absent providers - skip, never crash

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CAPABILITY_CLASS,
	getRightSizedModel,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
} from "../roster/index.mjs";
import { computeScore, resolveSeed } from "./scorer.mjs";

// Snapshot path - host-side, code constant (WR-1: routing is host-side)
const SNAPSHOT_PATH = join(
	homedir(),
	"Documents/Projects/ai_monitor/.state/snapshot-v2.json",
);

const EXPECTED_SCHEMA_VERSION = 2;
const DEFAULT_FLOOR = 5.0; // percent_left floor for skipping exhausted providers

// ---------------------------------------------------------------------------
// Snapshot reading

/**
 * Read snapshot from host-side path. Tolerates missing file (CR-3).
 * @returns {object|null} Snapshot or null if unreadable
 */
function readSnapshot() {
	try {
		return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
	} catch {
		return null; // CR-3: tolerate absent/malformed snapshot
	}
}

/**
 * Check if snapshot is valid (not null, correct schema, parseable).
 */
function isValidSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== "object") return false;
	if (snapshot.schema_version !== EXPECTED_SCHEMA_VERSION) return false;
	return true;
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
 * Model: right-sized to task tier (INV-5).
 *
 * @param {object} options
 * @param {number} [options.seed] Explicit seed
 * @param {string} [options.runId] Run ID for seed derivation
 * @param {string[]} [options.exclude] Provider names to explicitly exclude
 * @param {number} [options.floor] Percent left floor (default: DEFAULT_FLOOR)
 * @param {string} [options.tier] Task difficulty tier (high/standard/low) for INV-5
 * @param {string[]} [options.availableProviders] Restrict candidates to providers
 *   the caller can actually dispatch to (e.g. the runner's registered adapters).
 *   Omit to consider every roster/snapshot provider (existing behavior).
 * @returns {{provider: string|null, model: string|null, percentLeft: number|null,
 *   reason: string, log: string[]}} Routing result
 */
export function route(options = {}) {
	const {
		seed,
		runId,
		exclude = [],
		floor = DEFAULT_FLOOR,
		tier,
		availableProviders,
	} = options;
	// Resolve the routing seed up front; it feeds the scorer's deterministic
	// tie-break below (Task 11: equal-headroom candidates are decided by
	// computeScore, not by roster iteration order).
	const { seed: routeSeed } = resolveSeed({ seed, runId });
	const log = [];

	// Default tier is high for conservative routing (unknown tier => high-capability only)
	const effectiveTier = tier ?? CAPABILITY_CLASS.high;
	const isAvailable = (name) =>
		!availableProviders || availableProviders.includes(name);

	// Read snapshot host-side (WR-1)
	const snapshot = readSnapshot();

	if (!isValidSnapshot(snapshot)) {
		log.push("snapshot invalid or missing — routing blind");
		// Wire the blind fallback into the real path: a missing/broken snapshot
		// must not silently halt every task behind it. Candidates are ordered
		// by roster declaration order (highest capability first) and still
		// respect the capability filter and caller-supplied availability/exclude.
		const blindOrder = Object.keys(PROVIDER_CAPABILITIES).filter(
			(name) =>
				isAvailable(name) && passesCapabilityFilter(name, effectiveTier),
		);
		const blind = routeBlind(blindOrder, exclude);
		const model = blind.provider
			? getRightSizedModel(blind.provider, effectiveTier)
			: null;
		return {
			...blind,
			model,
			percentLeft: null,
			log: [...log, `blind candidates: ${blindOrder.join(", ") || "none"}`],
		};
	}

	const providers = indexProviders(snapshot);
	const scored = [];

	// Score each provider by headroom (percent_left)
	for (const [name, provider] of providers) {
		// CR-3: tolerate absent providers - but we're iterating present ones,
		// absent providers simply won't be in the map. This is the tolerance.

		if (!isAvailable(name)) {
			log.push(`provider ${name}: no adapter available for this dispatcher`);
			continue;
		}

		if (exclude.includes(name)) {
			log.push(`provider ${name}: explicitly excluded`);
			continue;
		}

		// INV-5: Capability filter - skip providers below task tier
		if (!passesCapabilityFilter(name, effectiveTier)) {
			log.push(
				`provider ${name}: below capability threshold for tier ${effectiveTier}`,
			);
			continue;
		}

		if (!provider.ok) {
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
			log.push(`provider ${name}: no valid windows`);
			continue;
		}

		// Health = MIN across valid windows (worst window vetoes).
		// Task 10: reduce instead of Math.min(...spread) — an oversized windows
		// array (tens of thousands of entries) would blow the call stack.
		const minPercentLeft = windows.reduce(
			(min, w) => Math.min(min, w.percent_left),
			Infinity,
		);

		if (minPercentLeft < floor) {
			log.push(
				`provider ${name}: exhausted (${minPercentLeft}% < ${floor}% floor)`,
			);
			continue; // INV-4: skip exhausted providers
		}

		// Use pace_delta for spread scoring (review-plugin's approach)
		// All finite pace_deltas from valid windows
		const paces = windows
			.map((w) => w.pace_delta)
			.filter((p) => typeof p === "number" && Number.isFinite(p));

		// Task 10: reduce instead of Math.min(...spread); keep the empty guard so
		// a provider with no finite paces still scores 0 (not Infinity).
		const pace =
			paces.length > 0
				? paces.reduce((min, p) => Math.min(min, p), Infinity)
				: 0;

		scored.push({
			name,
			percentLeft: minPercentLeft,
			pace,
		});

		log.push(
			`provider ${name}: eligible (${minPercentLeft}% left, pace=${pace})`,
		);
	}

	if (scored.length === 0) {
		log.push("no eligible providers");
		return {
			provider: null,
			model: null,
			percentLeft: null,
			reason: "no_eligible",
			log,
		};
	}

	// Spread: favor most remaining headroom (highest percent_left)
	// This differs from review-plugin's pace-based spread because switchyard
	// wants to drain aggregate capacity, not optimize for pace.
	// The plan says: "favors the most remaining headroom rather than draining
	// one provider before touching the next"
	let winner = scored[0];
	for (const s of scored) {
		// Primary: highest percent_left (most headroom)
		if (s.percentLeft > winner.percentLeft) {
			winner = s;
		}
	}

	// Task 11: tie-break with the documented scorer, not roster iteration order.
	// Multiple providers can share the top percent_left; before this the winner
	// was simply scored[0] (array order). Decide equal-headroom candidates with
	// computeScore (0.9·normPace + 0.1·jitter) seeded by the resolved routeSeed,
	// so the tie-break is deterministic and actually spreads (INV-4).
	const topPercentLeft = winner.percentLeft;
	const tied = scored.filter((s) => s.percentLeft === topPercentLeft);
	if (tied.length > 1) {
		const allPaces = tied.map((s) => s.pace);
		let bestScore = Number.NEGATIVE_INFINITY;
		for (const s of tied) {
			const model = getRightSizedModel(s.name, effectiveTier);
			const key = `${s.name}:${model ?? effectiveTier}`;
			const { score } = computeScore(s.pace, routeSeed, key, allPaces);
			if (score > bestScore) {
				bestScore = score;
				winner = s;
			}
		}
		log.push(
			`tie at ${topPercentLeft}% among ${tied.map((s) => s.name).join(", ")} — scorer picked ${winner.name}`,
		);
	}

	// CR-2 regression
	log.push(`winner: ${winner.name} with ${winner.percentLeft}% left`);

	// INV-5: Model right-sizing
	const model = getRightSizedModel(winner.name, effectiveTier);
	if (!model) {
		log.push(`no model for ${winner.name} at tier ${effectiveTier}`);
	}

	return {
		provider: winner.name,
		model,
		percentLeft: winner.percentLeft,
		reason: "spread",
		log,
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
 * @returns {{provider: string|null, model: null, reason: string}} Result
 */
export function routeBlind(providerOrder, exclude = []) {
	for (const name of providerOrder) {
		if (!exclude.includes(name)) {
			return { provider: name, model: null, reason: "blind_fallback" };
		}
	}
	return { provider: null, model: null, reason: "no_eligible_blind" };
}

export { DEFAULT_FLOOR, EXPECTED_SCHEMA_VERSION, SNAPSHOT_PATH };
