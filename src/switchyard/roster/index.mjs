// Roster module - provider capability metadata, now roster-backed
// INV-5: Capability filter ensures (provider, model) meets task required capability
//
// Task 1.5 (roster-unification plan): the frozen PROVIDER_CAPABILITIES table
// this module used to export has been replaced by a load of the canonical
// roster.json (design brief `roster-design-brief-2026-07-30.md` §4/§6),
// located via SWITCHYARD_ROSTER_PATH or the canonical ~/.agent/roster.json
// default. The exports below (PROVIDER_CAPABILITIES, passesCapabilityFilter,
// getRightSizedModel, and friends) keep their exact call-compatible shape so
// router/index.mjs (Task 1.6 migrates it) and every existing caller need no
// changes yet.
//
// Path resolution: default canonical path is ~/.agent/roster.json (via os.homedir()),
// overridable by SWITCHYARD_ROSTER_PATH env var. Fails loud if missing or malformed.
//
// Loading is LAZY and memoized for the life of the process: importing this
// module never touches the filesystem (many existing test files import it
// transitively without ever exercising routing, e.g. runner tests that mock
// `route` entirely), matching the brief's "read at startup, not continuously
// live" (§6) semantics — "startup" here means first use, not module load.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Capability-class vocabulary. Unchanged from the pre-roster module: this is
 * Layer-1 capability vocabulary (brief §1), not roster data, so it needs no
 * roster load.
 */
export const CAPABILITY_CLASS = Object.freeze({
	high: "high",
	standard: "standard",
	low: "low",
});

/**
 * Capability-class ordering for comparison. Higher class = more capability
 * required.
 */
export const CAPABILITY_CLASS_ORDER = Object.freeze({
	high: 3,
	standard: 2,
	low: 1,
});

// Internal capability-class rank used against the roster's slot keys,
// separate from the public CAPABILITY_CLASS_ORDER (which callers compare
// CAPABILITY_CLASS values against). Kept internal so a future roster schema
// change to CAPABILITY_CLASS_ORDER's numbering can't accidentally desync
// auto-ceiling derivation.
const ROSTER_CAPABILITY_CLASSES = ["low", "standard", "high"];
const CAPABILITY_CLASS_RANK = { low: 0, standard: 1, high: 2 };

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
let cachedSnapshotNameCapabilities = null;
let cachedRosterSha = null;

/**
 * Resolve the roster path: canonical ~/.agent/roster.json using os.homedir(),
 * with SWITCHYARD_ROSTER_PATH env var taking precedence as an explicit override.
 * @returns {string}
 */
function resolveRosterPath() {
	const envPath = process.env.SWITCHYARD_ROSTER_PATH;
	if (envPath) return envPath;
	return join(homedir(), ".agent", "roster.json");
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

		for (const capabilityClass of ROSTER_CAPABILITY_CLASSES) {
			const slotList = slots[capabilityClass];
			if (slotList === undefined) continue;
			if (!Array.isArray(slotList)) {
				violations.push(
					`targets['${targetId}'].slots.${capabilityClass} must be an array`,
				);
				continue;
			}
			slotList.forEach((slot, idx) => {
				const where = `targets['${targetId}'].slots.${capabilityClass}[${idx}]`;
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
 * Read, parse, and structurally validate the roster at the resolved roster path.
 * Fails loud (throws) on a missing path, unreadable file, malformed JSON, or
 * a broken structural contract — never a silent fallback to an empty roster.
 * @returns {object}
 */
function loadRosterData() {
	const path = resolveRosterPath();

	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`failed to read roster at '${path}': ${err.message}`);
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
 * never stored): the highest capability class among the target's slots that are active
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
	for (const capabilityClass of ROSTER_CAPABILITY_CLASSES) {
		const slotList = target.slots?.[capabilityClass];
		if (!Array.isArray(slotList)) continue;
		for (const slot of slotList) {
			if (!slot || typeof slot !== "object" || slot.manual_only) continue;
			const modelEntry = models[slot.model_ref];
			if (modelEntry?.status !== "active") continue;
			const variantKey = qualificationVariantKey(modelEntry, slot);
			const qual = variantKey ? qualifications[variantKey] : null;
			if (qual?.status !== "qualified") continue;
			if (
				best === null ||
				CAPABILITY_CLASS_RANK[capabilityClass] > CAPABILITY_CLASS_RANK[best]
			)
				best = capabilityClass;
		}
	}
	return best;
}

/**
 * The highest-priority active+qualified non-`manual_only` slot at EXACTLY
 * the given capability class, on an `enabled` target (brief §4:
 * "getRightSizedModel returns the highest-priority active+qualified
 * non-manual_only slot for the capability class"). Returns the model's
 * selector, or null if nothing qualifies.
 * @param {object} target
 * @param {object} models
 * @param {string} capabilityClass
 * @returns {string|null}
 */
function resolveSlotModel(target, models, capabilityClass) {
	if (!target?.enabled) return null;
	const slotList = target.slots?.[capabilityClass];
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
 * provider/harness key. Multiple targets sharing one harness is the STEADY
 * STATE this function exists for (Task C.3), not a rare edge case — it
 * covers two distinct shapes:
 *
 *  1. Exclusive alternatives, only one enabled at a time (opencode-go vs
 *     opencode-zen, a billing-account swap): the enabled-tie-break below is
 *     both necessary and sufficient — whichever target is `enabled` IS the
 *     one the caller means, and `snapshotName` is unneeded.
 *  2. Simultaneously-enabled targets that both stay live at once (the
 *     Antigravity / Antigravity (Claude) buckets, Task C.2): the harness
 *     alone is ambiguous between them, so the enabled-tie-break cannot be
 *     the answer — routing identity (which target) has to be resolved from
 *     something more specific than the harness. That "something" is the
 *     snapshot's own raw provider display name (e.g. "Antigravity
 *     (Claude)"): pass it as `snapshotName` and a target whose own
 *     `snapshot_name` field matches exactly is returned in preference to
 *     the tie-break (Task C.4/C.6). Execution identity (which adapter
 *     process actually runs the task) stays harness-keyed regardless —
 *     both targets here still dispatch through the one `agy` adapter
 *     (Task C.7) — only ROUTING identity needs the extra disambiguation.
 *
 * `snapshotName` is optional and purely additive: every existing caller
 * that omits it, and every target that never sets `snapshot_name` (every
 * harness except the two agy targets, today), gets byte-identical behavior
 * to before this parameter existed. Returns the id alongside the target so
 * provenance (Task 1.6, M7/M8; Task C.8) can record which concrete target
 * was resolved, not just the shared harness.
 * @param {object} targets
 * @param {string} harnessKey
 * @param {string} [snapshotName]
 * @returns {{id: string, target: object}|null}
 */
function findTargetEntryForHarness(targets, harnessKey, snapshotName) {
	if (snapshotName) {
		for (const [id, target] of Object.entries(targets)) {
			if (
				target &&
				typeof target === "object" &&
				target.harness === harnessKey &&
				target.enabled &&
				target.snapshot_name === snapshotName
			) {
				return { id, target };
			}
		}
	}
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
 * @param {string} [snapshotName]
 * @returns {object|null}
 */
function findTargetForHarness(targets, harnessKey, snapshotName) {
	return (
		findTargetEntryForHarness(targets, harnessKey, snapshotName)?.target ?? null
	);
}

/**
 * Normalize a target's raw `implementor_priority` field (implementor-
 * priority-waterfall-routing plan) to either a positive integer or `null`.
 * The field is optional roster data (unknown-field-permissive per
 * ~/.agent/rosterlib/validate.py R4/R5 — no schema change needed there): a
 * missing field, `0`, a negative number, or a non-integer all normalize to
 * `null` ("unranked"), matching how an absent field behaves for every target
 * that never sets it.
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeImplementorPriority(value) {
	return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Compute one PROVIDER_CAPABILITIES-shaped entry (`capability_class` +
 * `models` + `implementor_priority` per capability class) for a single target. Shared by
 * the harness-keyed table (buildProviderCapabilities) and the
 * snapshot-name-keyed table (buildSnapshotNameCapabilities) so both stay
 * byte-identical in shape.
 * @param {object} target
 * @param {object} models
 * @returns {{capability_class: string|null, models: object, implementor_priority: number|null}}
 */
function buildCapabilityEntry(target, models) {
	const modelsByCapabilityClass = {};
	for (const capabilityClass of ROSTER_CAPABILITY_CLASSES) {
		modelsByCapabilityClass[capabilityClass] = resolveSlotModel(
			target,
			models,
			capabilityClass,
		);
	}
	return {
		capability_class: autoRoutingCeiling(target, models),
		models: modelsByCapabilityClass,
		implementor_priority: normalizeImplementorPriority(
			target?.implementor_priority,
		),
	};
}

/**
 * Build the PROVIDER_CAPABILITIES-shaped map from the loaded roster: one
 * entry per known provider/harness key with a `capability_class` (the
 * computed auto_routing_ceiling) and a `models` map of capability class -> selector.
 *
 * Deliberately stays harness-keyed with exactly one entry per harness, even
 * when two targets share a harness (Task C.5) — router/index.mjs's blind
 * fallback reads `Object.keys(PROVIDER_CAPABILITIES)` directly to build its
 * candidate list, and that list must never enumerate one harness twice.
 * Disambiguating a specific snapshot-named target (e.g. "Antigravity
 * (Claude)" vs "Antigravity") is buildSnapshotNameCapabilities's job, a
 * separate table consulted BEFORE this one falls back — see
 * getCapabilityClass/getModelForCapability below.
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
		result[harnessKey] = buildCapabilityEntry(target, models);
	}
	return result;
}

/**
 * Build a SEPARATE capabilities map keyed by each target's own
 * `snapshot_name` (Task C.5/C.6) — only targets that declare that field are
 * included, which today means the two agy targets. Kept out of
 * PROVIDER_CAPABILITIES's own key set on purpose (see that function's
 * docstring); getCapabilityClass/getModelForCapability consult this table first,
 * by the RAW provider name they were called with, before normalizing to a
 * harness and falling back to the harness-keyed table.
 * @returns {object}
 */
function buildSnapshotNameCapabilities() {
	const roster = getRoster();
	const models =
		roster.models && typeof roster.models === "object" ? roster.models : {};
	const targets =
		roster.targets && typeof roster.targets === "object" ? roster.targets : {};

	const result = {};
	for (const target of Object.values(targets)) {
		if (
			target &&
			typeof target === "object" &&
			typeof target.snapshot_name === "string" &&
			target.snapshot_name
		) {
			result[target.snapshot_name] = buildCapabilityEntry(target, models);
		}
	}
	return result;
}

function getProviderCapabilities() {
	if (!cachedProviderCapabilities) {
		cachedProviderCapabilities = buildProviderCapabilities();
	}
	return cachedProviderCapabilities;
}

function getSnapshotNameCapabilities() {
	if (!cachedSnapshotNameCapabilities) {
		cachedSnapshotNameCapabilities = buildSnapshotNameCapabilities();
	}
	return cachedSnapshotNameCapabilities;
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
		getSnapshotNameCapabilities()[providerName] ??
		getProviderCapabilities()[normalizeProviderName(providerName)];
	return provider?.capability_class ?? null;
}

/**
 * Get the model for a provider at a given capability class — roster-backed.
 *
 * Task C.5/C.6: tries an EXACT match against a target's own `snapshot_name`
 * first (disambiguates two targets sharing one harness, e.g. the two agy
 * targets), falling back to the harness-keyed table when no target declares
 * that snapshot name — i.e. every provider except the two agy targets today,
 * completely unaffected.
 * @param {string} providerName
 * @param {string} capabilityClass
 * @returns {string|null} model selector or null if not found
 */
export function getModelForCapability(providerName, capabilityClass) {
	const provider =
		getSnapshotNameCapabilities()[providerName] ??
		getProviderCapabilities()[normalizeProviderName(providerName)];
	return provider?.models?.[capabilityClass] ?? null;
}

/**
 * Get the implementor-priority rank for a provider (implementor-priority-
 * waterfall-routing plan) — a positive integer where lower drains first, or
 * `null` when the backing roster target doesn't set `implementor_priority`
 * (the unranked/spread-pool default for every target that doesn't opt in).
 * Same snapshot-name-then-harness lookup order as getCapabilityClass/
 * getModelForCapability, so the two simultaneously-enabled agy targets each carry
 * their own rank rather than colliding on the shared "agy" harness key.
 * @param {string} providerName
 * @returns {number|null}
 */
export function getImplementorPriority(providerName) {
	const provider =
		getSnapshotNameCapabilities()[providerName] ??
		getProviderCapabilities()[normalizeProviderName(providerName)];
	return provider?.implementor_priority ?? null;
}

/**
 * Capability filter - INV-5.
 * A (provider, model) below the task's required capability is not a candidate.
 *
 * Task 2.1: `requiredCapability` must be a recognized capability class — an
 * unknown/typo'd value is REJECTED (thrown), not coerced to `0` (the
 * lowest/least-restrictive capability). Coercing to 0 was a real INV-5 bypass:
 * an invalid capability
 * would previously pass the filter against every provider regardless of
 * capability. `providerClass` still falls back to `0` on purpose — an
 * unqualified/unknown *provider* class is a normal "doesn't meet any
 * capability"
 * state, not a caller error.
 * @param {string} providerName
 * @param {string} requiredCapability
 * @returns {boolean} true if provider meets or exceeds the required capability
 * @throws {Error} if requiredCapability is not one of CAPABILITY_CLASS_ORDER's known keys
 */
export function passesCapabilityFilter(providerName, requiredCapability) {
	const providerClass = getCapabilityClass(providerName);
	if (!Object.hasOwn(CAPABILITY_CLASS_ORDER, requiredCapability)) {
		throw new Error(
			`passesCapabilityFilter: unrecognized required capability ${JSON.stringify(requiredCapability)} (expected one of: ${Object.keys(CAPABILITY_CLASS_ORDER).join(", ")}) — refusing to silently treat it as the lowest capability`,
		);
	}
	const requiredCapabilityValue = CAPABILITY_CLASS_ORDER[requiredCapability];
	const providerCapabilityValue = CAPABILITY_CLASS_ORDER[providerClass] ?? 0;
	return providerCapabilityValue >= requiredCapabilityValue;
}

/**
 * Get right-sized model - INV-5.
 * Within the chosen harness, pick the model mapped to the task's required capability.
 * @param {string} providerName
 * @param {string} capabilityClass
 * @returns {string|null} model name or null if not found
 */
export function getRightSizedModel(providerName, capabilityClass) {
	return getModelForCapability(providerName, capabilityClass);
}

/**
 * Filter providers by capability.
 * @param {string[]} providerNames
 * @param {string} requiredCapability
 * @returns {string[]} filtered list of provider names
 */
export function filterByCapability(providerNames, requiredCapability) {
	return providerNames.filter((name) =>
		passesCapabilityFilter(name, requiredCapability),
	);
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
 * Resolve an arbitrary provider identifier — a roster target id (e.g.
 * "antigravity-claude", the B.1-pinned `--only-provider`/`--exclude-provider`
 * value), a raw snapshot display name (e.g. "Antigravity (Claude)"), or a
 * harness key (e.g. "codex") — to the target id it refers to (Task C.6).
 *
 * This is the target-id-aware resolution path allowlist/denylist matching
 * needs: a harness alone (`normalizeProviderName`'s output) cannot
 * distinguish two simultaneously-enabled targets sharing one harness, but a
 * target id can. Tries, in order: (1) the identifier IS already a target id
 * — return it directly; (2) it's a snapshot display name that some target
 * declares as its own `snapshot_name` — return that target's id; (3)
 * otherwise fall back to the harness-keyed enabled-tie-break (preserves
 * existing behavior for every single-target harness). Returns null if the
 * roster can't be loaded or nothing matches — callers must treat that as "no
 * target-id-level opinion, fall back to harness-level matching," never as a
 * hard failure (this is a matching aid, not a routing gate).
 * @param {string} identifier
 * @returns {string|null}
 */
export function resolveTargetId(identifier) {
	if (!identifier) return null;
	try {
		const roster = getRoster();
		const targets =
			roster.targets && typeof roster.targets === "object"
				? roster.targets
				: {};
		if (Object.hasOwn(targets, identifier)) return identifier;
		const harnessKey = normalizeProviderName(identifier);
		const entry = harnessKey
			? findTargetEntryForHarness(targets, harnessKey, identifier)
			: null;
		return entry?.id ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the concrete target a provider/harness routes to at a given capability class,
 * for provenance. All four fields are sourced from the ONE resolved target so
 * they stay mutually truthful (advisor guidance): `resolved_target` is the
 * target id, `resolved_harness` its `harness`, `resolved_selector` the right-
 * sized slot selector for the capability class, `resolved_credential_profile` its
 * `credential_profile`. When no target backs the provider, target and
 * selector are null but the normalized harness is still returned (so adapter
 * selection can fall back to it).
 * @param {string} providerName
 * @param {string} [capabilityClass]
 * @returns {{resolved_target: string|null, resolved_harness: string|null, resolved_selector: string|null, resolved_credential_profile: string|null}}
 */
export function resolveTargetProvenance(providerName, capabilityClass) {
	const roster = getRoster();
	const models =
		roster.models && typeof roster.models === "object" ? roster.models : {};
	const targets =
		roster.targets && typeof roster.targets === "object" ? roster.targets : {};

	const harnessKey = normalizeProviderName(providerName);
	// Task C.8: pass the RAW providerName through as the snapshot-name
	// disambiguator, so a harness shared by two simultaneously-enabled targets
	// (the agy buckets) resolves to the target the caller actually meant,
	// not whichever wins the enabled-tie-break.
	const entry = harnessKey
		? findTargetEntryForHarness(targets, harnessKey, providerName)
		: null;

	if (!entry) {
		return {
			resolved_target: null,
			resolved_harness: harnessKey || null,
			resolved_selector: null,
			resolved_credential_profile: null,
		};
	}

	const selector = capabilityClass
		? resolveSlotModel(entry.target, models, capabilityClass)
		: null;
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
 * gate. If the roster can't be loaded — an unset SWITCHYARD_ROSTER_PATH
 * resolves to the canonical ~/.agent/roster.json default (Task 4.1), so an
 * unavailable roster means the resolved path (override or default) failed to
 * read, parse, or validate — every field degrades to null rather than
 * throwing, so a dispatch that would otherwise succeed is never aborted just
 * because provenance couldn't be computed. Whenever the real `route` ran, it
 * already loaded the same roster, so the populated path and the route path are
 * always consistent.
 * @param {string} providerName
 * @param {string} [capabilityClass]
 * @returns {{roster_schema_version: number|null, roster_sha256: string|null, resolved_target: string|null, resolved_harness: string|null, resolved_selector: string|null, resolved_credential_profile: string|null}}
 */
export function resolveRouteProvenance(providerName, capabilityClass) {
	try {
		return {
			...getRosterProvenance(),
			...resolveTargetProvenance(providerName, capabilityClass),
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
	cachedSnapshotNameCapabilities = null;
	cachedRosterSha = null;
}
