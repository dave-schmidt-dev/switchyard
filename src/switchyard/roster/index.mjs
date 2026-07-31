// Roster module - provider capability metadata, now roster-backed
// INV-5: Capability filter ensures (provider, model) meets task tier
//
// Task 1.5 (roster-unification plan): the frozen PROVIDER_CAPABILITIES table
// this module used to export has been replaced by a load of the canonical
// roster.json (design brief `roster-design-brief-2026-07-30.md` §4/§6),
// located via SWITCHYARD_ROSTER_PATH. The exports below (PROVIDER_CAPABILITIES,
// passesCapabilityFilter, getRightSizedModel, and friends) keep their exact
// call-compatible shape so router/index.mjs (Task 1.6 migrates it) and every
// existing caller need no changes yet.
//
// Path resolution is env-only for now: SWITCHYARD_ROSTER_PATH -> fail loud.
// The brief's "configured install path" fallback tier is deliberately NOT
// implemented here — that would mean hardcoding an external, non-switchyard
// directory (e.g. ~/.agent) into this repo's source, which switchyard must
// never do. Until Task 1.9's cutover sets SWITCHYARD_ROSTER_PATH globally,
// an unset env var is expected and this module fails loud rather than
// silently guessing a path.
//
// Loading is LAZY and memoized for the life of the process: importing this
// module never touches the filesystem (many existing test files import it
// transitively without ever exercising routing, e.g. runner tests that mock
// `route` entirely), matching the brief's "read at startup, not continuously
// live" (§6) semantics — "startup" here means first use, not module load.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Tier vocabulary. Unchanged from the pre-roster module: this is Layer-1
 * tier vocabulary (brief §1), not roster data, so it needs no roster load.
 */
export const CAPABILITY_CLASS = Object.freeze({
	high: "high",
	standard: "standard",
	low: "low",
});

/**
 * Tier ordering for comparison. Higher tier = more capability required.
 */
export const TIER_ORDER = Object.freeze({
	high: 3,
	standard: 2,
	low: 1,
});

// Internal tier rank used against the roster's own tier names, separate from
// the public TIER_ORDER (which callers compare CAPABILITY_CLASS values
// against). Kept internal so a future roster schema change to TIER_ORDER's
// numbering can't accidentally desync auto-ceiling derivation.
const TIERS = ["low", "standard", "high"];
const TIER_RANK = { low: 0, standard: 1, high: 2 };

const MODEL_STATUSES = new Set(["active", "retired"]);

// Canonical provider/harness keys this module has always exposed via
// PROVIDER_CAPABILITIES (the snapshot-provider namespace router/index.mjs
// normalizes into via normalizeProviderName, NOT the roster's target-id
// namespace). Each key is mapped to the roster target whose `harness` field
// matches it. Task 1.5b introduces a formal target<->usage_provider mapping;
// this is an interim, interface-preserving projection so router/index.mjs
// (Task 1.6) needs no changes to keep working against these exports.
const KNOWN_PROVIDER_HARNESSES = [
	"claude",
	"codex",
	"agy",
	"cursor",
	"vibe",
	"copilot",
	"opencode",
];

let cachedRoster = null;
let cachedProviderCapabilities = null;
let cachedRosterSha = null;

/**
 * Resolve the roster path: SWITCHYARD_ROSTER_PATH env var only. No silent
 * fallback (brief §6/§3.14) — an unset env var is a fail-loud condition.
 * @returns {string}
 */
function resolveRosterPath() {
	const envPath = process.env.SWITCHYARD_ROSTER_PATH;
	if (envPath) return envPath;
	throw new Error(
		"SWITCHYARD_ROSTER_PATH is not set. The roster loader has no configured " +
			"install-path fallback (switchyard must not hardcode an external " +
			"roster location into its own source) and refuses to silently proceed " +
			"without one. Set SWITCHYARD_ROSTER_PATH to a valid roster.json path.",
	);
}

/**
 * The invocation-variant key a slot's qualification record is filed under:
 * `selector`, or `selector@effort` when the slot carries an effort (brief
 * §4: "Qualification is keyed by invocation variant"). Mirrors
 * `_qualification_variant_key` in ~/.agent/rosterlib/validate.py.
 * @param {object} modelEntry
 * @param {object} slot
 * @returns {string|null}
 */
function qualificationVariantKey(modelEntry, slot) {
	const selector = modelEntry?.selector;
	if (typeof selector !== "string" || !selector) return null;
	const effort = slot?.effort;
	if (typeof effort === "string" && effort) return `${selector}@${effort}`;
	return selector;
}

/**
 * A reasonable subset of ~/.agent/rosterlib/validate.py's structural
 * checklist (brief §4b) — just what this loader actually reads: valid JSON
 * object shape, every model has a status, every target names a harness, and
 * every slot's model_ref resolves in the catalog. Not a full port of the
 * Python validator (that lives in ~/.agent and isn't reachable from this
 * repo); the shared module stays the single source of truth for `roster
 * validate`/`roster install`. This is the loader's own fail-loud floor.
 * @param {unknown} data
 * @returns {string[]} violations; empty = structurally usable
 */
function validateRosterStructure(data) {
	const violations = [];
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return ["roster root must be a JSON object"];
	}

	const models = data.models;
	if (!models || typeof models !== "object" || Array.isArray(models)) {
		violations.push("top-level 'models' must be an object");
	} else {
		for (const [key, entry] of Object.entries(models)) {
			if (!entry || typeof entry !== "object") {
				violations.push(`models['${key}'] must be an object`);
				continue;
			}
			if (!MODEL_STATUSES.has(entry.status)) {
				violations.push(
					`models['${key}'].status must be 'active' or 'retired', got ${JSON.stringify(entry.status)}`,
				);
			}
		}
	}
	const modelsDict =
		models && typeof models === "object" && !Array.isArray(models)
			? models
			: {};

	const targets = data.targets;
	if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
		violations.push("top-level 'targets' must be an object");
		return violations; // nothing further can be safely checked
	}

	for (const [targetId, target] of Object.entries(targets)) {
		if (!target || typeof target !== "object") {
			violations.push(`targets['${targetId}'] must be an object`);
			continue;
		}
		if (typeof target.harness !== "string" || !target.harness) {
			violations.push(
				`targets['${targetId}'].harness must be a non-empty string`,
			);
		}

		const slots = target.slots;
		if (slots === undefined) continue;
		if (typeof slots !== "object" || slots === null || Array.isArray(slots)) {
			violations.push(`targets['${targetId}'].slots must be an object`);
			continue;
		}

		for (const tier of TIERS) {
			const slotList = slots[tier];
			if (slotList === undefined) continue;
			if (!Array.isArray(slotList)) {
				violations.push(
					`targets['${targetId}'].slots.${tier} must be an array`,
				);
				continue;
			}
			slotList.forEach((slot, idx) => {
				const where = `targets['${targetId}'].slots.${tier}[${idx}]`;
				if (!slot || typeof slot !== "object") {
					violations.push(`${where} must be an object`);
					return;
				}
				if (typeof slot.model_ref !== "string" || !slot.model_ref) {
					violations.push(`${where}.model_ref must be a non-empty string`);
				} else if (!(slot.model_ref in modelsDict)) {
					violations.push(
						`${where}.model_ref '${slot.model_ref}' does not resolve to any catalog model in 'models'`,
					);
				}
			});
		}
	}

	return violations;
}

/**
 * Read, parse, and structurally validate the roster at SWITCHYARD_ROSTER_PATH.
 * Fails loud (throws) on a missing path, unreadable file, malformed JSON, or
 * a broken structural contract — never a silent fallback.
 * @returns {object}
 */
function loadRosterData() {
	const path = resolveRosterPath();

	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(
			`failed to read roster at SWITCHYARD_ROSTER_PATH='${path}': ${err.message}`,
		);
	}

	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw new Error(`roster at '${path}' is not valid JSON: ${err.message}`);
	}

	const violations = validateRosterStructure(data);
	if (violations.length > 0) {
		throw new Error(
			`roster at '${path}' failed structural validation:\n` +
				violations.map((v) => `  - ${v}`).join("\n"),
		);
	}

	return data;
}

function getRoster() {
	if (!cachedRoster) {
		cachedRoster = loadRosterData();
	}
	return cachedRoster;
}

/**
 * Derive `auto_routing_ceiling` for a target (brief §3.3/§9.2 — DERIVED,
 * never stored): the highest tier among the target's slots that are active
 * (catalog status == "active") + qualified (qualification.status ==
 * "qualified") + non-`manual_only`, on an `enabled` target. Mirrors
 * `_auto_routing_ceiling` in ~/.agent/bin/roster. Returns null if nothing
 * qualifies yet (untested/disabled) — the expected pre-smoke state, not an
 * error on its own.
 * @param {object} target
 * @param {object} models
 * @returns {string|null}
 */
function autoRoutingCeiling(target, models) {
	if (!target?.enabled) return null; // a disabled target auto-routes nothing
	const qualifications =
		target.qualifications && typeof target.qualifications === "object"
			? target.qualifications
			: {};

	let best = null;
	for (const tier of TIERS) {
		const slotList = target.slots?.[tier];
		if (!Array.isArray(slotList)) continue;
		for (const slot of slotList) {
			if (!slot || typeof slot !== "object" || slot.manual_only) continue;
			const modelEntry = models[slot.model_ref];
			if (modelEntry?.status !== "active") continue;
			const variantKey = qualificationVariantKey(modelEntry, slot);
			const qual = variantKey ? qualifications[variantKey] : null;
			if (qual?.status !== "qualified") continue;
			if (best === null || TIER_RANK[tier] > TIER_RANK[best]) best = tier;
		}
	}
	return best;
}

/**
 * The highest-priority active+qualified non-`manual_only` slot at EXACTLY
 * the given tier, on an `enabled` target (brief §4: "getRightSizedModel
 * returns the highest-priority active+qualified non-manual_only slot for
 * the tier"). Returns the model's selector, or null if nothing qualifies.
 * @param {object} target
 * @param {object} models
 * @param {string} tier
 * @returns {string|null}
 */
function resolveSlotModel(target, models, tier) {
	if (!target?.enabled) return null;
	const slotList = target.slots?.[tier];
	if (!Array.isArray(slotList)) return null;
	const qualifications =
		target.qualifications && typeof target.qualifications === "object"
			? target.qualifications
			: {};

	const candidates = [];
	for (const slot of slotList) {
		if (!slot || typeof slot !== "object" || slot.manual_only) continue;
		const modelEntry = models[slot.model_ref];
		if (modelEntry?.status !== "active") continue;
		const variantKey = qualificationVariantKey(modelEntry, slot);
		const qual = variantKey ? qualifications[variantKey] : null;
		if (qual?.status !== "qualified") continue;
		const priority = Number.isInteger(slot.priority)
			? slot.priority
			: Number.POSITIVE_INFINITY;
		candidates.push({ priority, selector: modelEntry.selector });
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => a.priority - b.priority);
	return candidates[0].selector ?? null;
}

/**
 * Pick the roster target ENTRY (id + object) that backs a given
 * provider/harness key, preferring an `enabled` target when more than one
 * target shares a harness (e.g. opencode-go vs opencode-zen both carry
 * `harness: "opencode"`). Returns the id alongside the target so provenance
 * (Task 1.6, M7/M8) can record which concrete target was resolved, not just
 * the shared harness.
 * @param {object} targets
 * @param {string} harnessKey
 * @returns {{id: string, target: object}|null}
 */
function findTargetEntryForHarness(targets, harnessKey) {
	let fallback = null;
	for (const [id, target] of Object.entries(targets)) {
		if (!target || typeof target !== "object" || target.harness !== harnessKey)
			continue;
		if (target.enabled) return { id, target };
		if (!fallback) fallback = { id, target };
	}
	return fallback;
}

/**
 * Pick the roster target that backs a given provider/harness key, preferring
 * an `enabled` target when more than one target shares a harness. Thin wrapper
 * over findTargetEntryForHarness for callers that only need the target object.
 * @param {object} targets
 * @param {string} harnessKey
 * @returns {object|null}
 */
function findTargetForHarness(targets, harnessKey) {
	return findTargetEntryForHarness(targets, harnessKey)?.target ?? null;
}

/**
 * Build the PROVIDER_CAPABILITIES-shaped map from the loaded roster: one
 * entry per known provider/harness key with a `capability_class` (the
 * computed auto_routing_ceiling) and a `models` map of tier -> selector.
 * @returns {object}
 */
function buildProviderCapabilities() {
	const roster = getRoster();
	const models =
		roster.models && typeof roster.models === "object" ? roster.models : {};
	const targets =
		roster.targets && typeof roster.targets === "object" ? roster.targets : {};

	const result = {};
	for (const harnessKey of KNOWN_PROVIDER_HARNESSES) {
		const target = findTargetForHarness(targets, harnessKey);
		if (!target) continue; // no roster target uses this harness

		const modelsByTier = {};
		for (const tier of TIERS) {
			modelsByTier[tier] = resolveSlotModel(target, models, tier);
		}

		result[harnessKey] = {
			capability_class: autoRoutingCeiling(target, models),
			models: modelsByTier,
		};
	}
	return result;
}

function getProviderCapabilities() {
	if (!cachedProviderCapabilities) {
		cachedProviderCapabilities = buildProviderCapabilities();
	}
	return cachedProviderCapabilities;
}

/**
 * Provider capability definitions, now roster-backed and lazily loaded on
 * first access. Kept as a Proxy (not a plain object built at import time) so
 * that merely importing this module — as many existing test files do
 * transitively, without ever exercising routing — never touches the
 * filesystem or throws. `Object.keys(PROVIDER_CAPABILITIES)` (used by
 * router/index.mjs's blind fallback) and direct property access both work
 * through the trapped `ownKeys`/`getOwnPropertyDescriptor`/`get`.
 */
export const PROVIDER_CAPABILITIES = new Proxy(
	{},
	{
		get(_target, prop, receiver) {
			return Reflect.get(getProviderCapabilities(), prop, receiver);
		},
		has(_target, prop) {
			return Reflect.has(getProviderCapabilities(), prop);
		},
		ownKeys() {
			return Reflect.ownKeys(getProviderCapabilities());
		},
		getOwnPropertyDescriptor(_target, prop) {
			const desc = Reflect.getOwnPropertyDescriptor(
				getProviderCapabilities(),
				prop,
			);
			if (!desc) return desc;
			// The Proxy's own target is `{}` (extensible, no matching own props),
			// so descriptors reported for it must be configurable or a "reports a
			// non-existent property as non-configurable" invariant violation
			// throws. The underlying data is conceptually frozen (roster-derived);
			// callers are never expected to mutate it, so this is cosmetic only.
			return { ...desc, configurable: true };
		},
		set() {
			throw new TypeError(
				"PROVIDER_CAPABILITIES is derived from the roster and read-only",
			);
		},
		defineProperty() {
			throw new TypeError(
				"PROVIDER_CAPABILITIES is derived from the roster and read-only",
			);
		},
		deleteProperty() {
			throw new TypeError(
				"PROVIDER_CAPABILITIES is derived from the roster and read-only",
			);
		},
	},
);

/**
 * Normalize provider display names (e.g. "OpenCode Go", "Antigravity", "Codex") to canonical harness keys.
 * Unchanged from the pre-roster module — pure vocabulary, no roster data involved.
 * @param {string} name
 * @returns {string}
 */
export function normalizeProviderName(name) {
	if (!name) return "";
	const lower = name.toLowerCase().trim();
	if (lower.includes("opencode")) return "opencode";
	if (lower.includes("antigravity") || lower === "agy") return "agy";
	if (lower.includes("cursor")) return "cursor";
	if (lower.includes("claude")) return "claude";
	if (lower.includes("codex")) return "codex";
	if (lower.includes("copilot")) return "copilot";
	return lower;
}

/**
 * Get the capability class for a provider — now the roster-computed
 * `auto_routing_ceiling` of the target backing that provider/harness.
 * @param {string} providerName
 * @returns {string|null} capability class or null if unknown/unqualified
 */
export function getCapabilityClass(providerName) {
	const provider =
		getProviderCapabilities()[normalizeProviderName(providerName)];
	return provider?.capability_class ?? null;
}

/**
 * Get the model for a provider at a given tier — roster-backed.
 * @param {string} providerName
 * @param {string} tier
 * @returns {string|null} model selector or null if not found
 */
export function getModelForTier(providerName, tier) {
	const provider =
		getProviderCapabilities()[normalizeProviderName(providerName)];
	return provider?.models?.[tier] ?? null;
}

/**
 * Capability filter - INV-5.
 * A (provider, model) below the task's tier is not a candidate.
 *
 * Task 2.1: `taskTier` must be a recognized tier name — an unknown/typo'd
 * value is REJECTED (thrown), not coerced to `0` (the lowest/least-
 * restrictive tier). Coercing to 0 was a real INV-5 bypass: an invalid tier
 * would previously pass the filter against every provider regardless of
 * capability. `providerClass` still falls back to `0` on purpose — an
 * unqualified/unknown *provider* class is a normal "doesn't meet any tier"
 * state, not a caller error.
 * @param {string} providerName
 * @param {string} taskTier
 * @returns {boolean} true if provider meets or exceeds the tier
 * @throws {Error} if taskTier is not one of TIER_ORDER's known keys
 */
export function passesCapabilityFilter(providerName, taskTier) {
	const providerClass = getCapabilityClass(providerName);
	if (!Object.hasOwn(TIER_ORDER, taskTier)) {
		throw new Error(
			`passesCapabilityFilter: unrecognized task tier ${JSON.stringify(taskTier)} (expected one of: ${Object.keys(TIER_ORDER).join(", ")}) — refusing to silently treat it as the lowest tier`,
		);
	}
	const taskTierValue = TIER_ORDER[taskTier];
	const providerTierValue = TIER_ORDER[providerClass] ?? 0;
	return providerTierValue >= taskTierValue;
}

/**
 * Get right-sized model - INV-5.
 * Within the chosen harness, pick the model mapped to the task's tier.
 * @param {string} providerName
 * @param {string} tier
 * @returns {string|null} model name or null if not found
 */
export function getRightSizedModel(providerName, tier) {
	return getModelForTier(providerName, tier);
}

/**
 * Filter providers by capability.
 * @param {string[]} providerNames
 * @param {string} taskTier
 * @returns {string[]} filtered list of provider names
 */
export function filterByCapability(providerNames, taskTier) {
	return providerNames.filter((name) => passesCapabilityFilter(name, taskTier));
}

// ---------------------------------------------------------------------------
// Provenance (Task 1.6, M7/M8) — dispatch records carry the roster identity
// and the concrete target/harness/selector a route resolved to.

/**
 * Deterministically canonicalize a JSON-serializable value: object keys are
 * emitted in sorted order, arrays keep their order, scalars pass through. Feed
 * the result to JSON.stringify (no spacing arg) for a stable, whitespace-free
 * byte string. This mirrors Python's
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"))` so a future
 * cross-language reimplementation *could* reproduce the same hash for
 * ASCII-only roster content (the only content this roster carries). Byte parity
 * with Python is NOT relied on here — see computeRosterSha.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalizeForHash(value) {
	if (Array.isArray(value)) return value.map(canonicalizeForHash);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = canonicalizeForHash(value[key]);
		}
		return out;
	}
	return value;
}

/**
 * Compute the provenance roster hash over the catalog (`models`) and
 * `targets`, EXCLUDING every target's mutable `qualifications` block (brief
 * PM-12/SR-4). Excluding qualifications is what makes this hash *routing-
 * stable*: `roster smoke` writes qualification status back into the roster
 * continuously, and a dispatch's provenance sha must not move just because a
 * smoke run flipped a slot's qualification — only a real catalog/target/slot
 * change should.
 *
 * NOTE: this is deliberately a DIFFERENT computation from the Python
 * `roster resolve` contract sha (`~/.agent/bin/roster`, which hashes the exact
 * whole-file bytes INCLUDING qualifications and is locked to that by
 * test_roster_resolve.py::test_roster_sha256_is_exact_file_bytes_hash). Same
 * field name, different jobs: the contract sha is a whole-file resolution
 * receipt; this provenance sha is a routing-stable identity. They are not
 * expected to match, and must NOT be "reconciled" to be equal — making this
 * hash whole-file would reintroduce qualification churn into dispatch
 * provenance, and making the contract sha catalog-only would break its
 * byte-exact lock. Two contracts, two values, on purpose. (See Task 1.6
 * report / PM-12/SR-4.)
 *
 * Pure function of its argument — no filesystem or cache access — so it can be
 * unit-tested by calling it twice on two objects that differ only in
 * qualifications and asserting the hashes are equal.
 * @param {object} rosterData
 * @returns {string} hex sha256
 */
export function computeRosterSha(rosterData) {
	const models =
		rosterData?.models && typeof rosterData.models === "object"
			? rosterData.models
			: {};
	const targetsIn =
		rosterData?.targets && typeof rosterData.targets === "object"
			? rosterData.targets
			: {};

	const targets = {};
	for (const [id, target] of Object.entries(targetsIn)) {
		if (!target || typeof target !== "object") {
			targets[id] = target;
			continue;
		}
		// Drop the mutable qualifications block; keep everything else.
		const { qualifications, ...rest } = target;
		void qualifications;
		targets[id] = rest;
	}

	const canonical = JSON.stringify(canonicalizeForHash({ models, targets }));
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Roster-identity provenance: the schema version and the routing-stable
 * roster sha (memoized for the process life alongside the roster cache).
 * @returns {{roster_schema_version: number|null, roster_sha256: string}}
 */
export function getRosterProvenance() {
	const roster = getRoster();
	if (cachedRosterSha === null) {
		cachedRosterSha = computeRosterSha(roster);
	}
	return {
		roster_schema_version:
			typeof roster.schema_version === "number" ? roster.schema_version : null,
		roster_sha256: cachedRosterSha,
	};
}

/**
 * Resolve the concrete target a provider/harness routes to at a given tier,
 * for provenance. All four fields are sourced from the ONE resolved target so
 * they stay mutually truthful (advisor guidance): `resolved_target` is the
 * target id, `resolved_harness` its `harness`, `resolved_selector` the right-
 * sized slot selector for the tier, `resolved_credential_profile` its
 * `credential_profile`. When no target backs the provider, target and
 * selector are null but the normalized harness is still returned (so adapter
 * selection can fall back to it).
 * @param {string} providerName
 * @param {string} [tier]
 * @returns {{resolved_target: string|null, resolved_harness: string|null, resolved_selector: string|null, resolved_credential_profile: string|null}}
 */
export function resolveTargetProvenance(providerName, tier) {
	const roster = getRoster();
	const models =
		roster.models && typeof roster.models === "object" ? roster.models : {};
	const targets =
		roster.targets && typeof roster.targets === "object" ? roster.targets : {};

	const harnessKey = normalizeProviderName(providerName);
	const entry = harnessKey
		? findTargetEntryForHarness(targets, harnessKey)
		: null;

	if (!entry) {
		return {
			resolved_target: null,
			resolved_harness: harnessKey || null,
			resolved_selector: null,
			resolved_credential_profile: null,
		};
	}

	const selector = tier ? resolveSlotModel(entry.target, models, tier) : null;
	return {
		resolved_target: entry.id,
		resolved_harness: entry.target.harness ?? harnessKey ?? null,
		resolved_selector: selector,
		// Metadata only (Task 1.6, M1b): the target's credential profile is
		// RECORDED for provenance so a future change can route credentials by
		// it, but it is deliberately NOT threaded into adapter.execute yet —
		// that adapter signature change is out of scope for this task.
		resolved_credential_profile: entry.target.credential_profile ?? null,
	};
}

/**
 * The full six-field provenance a dispatch record carries (Task 1.6): the
 * roster identity (schema version + routing-stable sha) plus the concrete
 * target/harness/selector/credential_profile this route resolved to.
 *
 * Best-effort: provenance is a record-keeping enhancement, never a dispatch
 * gate. If the roster can't be loaded (e.g. SWITCHYARD_ROSTER_PATH unset in a
 * unit test whose `route` is mocked), every field degrades to null rather than
 * throwing — a dispatch that would otherwise succeed must not be aborted just
 * because provenance couldn't be computed. Whenever the real `route` ran, it
 * already loaded the same roster, so the populated path and the route path are
 * always consistent.
 * @param {string} providerName
 * @param {string} [tier]
 * @returns {{roster_schema_version: number|null, roster_sha256: string|null, resolved_target: string|null, resolved_harness: string|null, resolved_selector: string|null, resolved_credential_profile: string|null}}
 */
export function resolveRouteProvenance(providerName, tier) {
	try {
		return {
			...getRosterProvenance(),
			...resolveTargetProvenance(providerName, tier),
		};
	} catch {
		return {
			roster_schema_version: null,
			roster_sha256: null,
			resolved_target: null,
			resolved_harness: null,
			resolved_selector: null,
			resolved_credential_profile: null,
		};
	}
}

/**
 * Test-only: clear the memoized roster + derived capability map so a test
 * can point SWITCHYARD_ROSTER_PATH at a different value and observe a fresh
 * load. Production code never calls this — the roster is read once per
 * process (brief §6: "read at startup, not continuously live").
 */
export function __resetRosterCacheForTests() {
	cachedRoster = null;
	cachedProviderCapabilities = null;
	cachedRosterSha = null;
}
