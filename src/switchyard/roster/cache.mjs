import {
	buildCapabilityEntry,
	isAutomaticRoutingTarget,
	normalizeProviderName,
	resolveTargetIdentityFromTargets,
} from "./capabilities.mjs";
import { computeRosterSha } from "./descriptor-identity.mjs";
import { KNOWN_PROVIDER_HARNESSES, loadRosterData } from "./schema.mjs";

let cachedRoster = null;
let cachedProviderCapabilities = null;
let cachedSnapshotNameCapabilities = null;
let cachedRosterSha = null;
function getRoster() {
	if (!cachedRoster) {
		cachedRoster = loadRosterData();
	}
	return cachedRoster;
}
function buildProviderCapabilities() {
	const roster = getRoster();
	const models =
		roster.models && typeof roster.models === "object" ? roster.models : {};
	const targets =
		roster.targets && typeof roster.targets === "object" ? roster.targets : {};

	const result = {};
	for (const harnessKey of KNOWN_PROVIDER_HARNESSES) {
		const entry = Object.entries(targets).find(
			([id, target]) =>
				target?.harness === harnessKey && isAutomaticRoutingTarget(target, id),
		);
		const target = entry?.[1];
		if (!target) continue; // no roster target uses this harness
		result[harnessKey] = buildCapabilityEntry(target, models);
	}
	return result;
}
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
			const targetId = Object.entries(targets).find(
				([, candidate]) => candidate === target,
			)?.[0];
			if (targetId && !isAutomaticRoutingTarget(target, targetId)) continue;
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
function getCapabilityEntry(providerName) {
	const snapshotEntry = getSnapshotNameCapabilities()[providerName];
	if (snapshotEntry) return snapshotEntry;

	try {
		const roster = getRoster();
		const targets =
			roster.targets && typeof roster.targets === "object"
				? roster.targets
				: {};
		const identity = resolveTargetIdentityFromTargets(targets, providerName);
		if (identity.targetId) {
			const target = targets[identity.targetId];
			if (!isAutomaticRoutingTarget(target, identity.targetId)) return null;
			// An exact target id owns its own entry. The harness-keyed fallback
			// below returns the first target of that harness, which is the wrong
			// target (or none) when several targets share a harness.
			if (identity.targetId === providerName) {
				const models =
					roster.models && typeof roster.models === "object"
						? roster.models
						: {};
				return buildCapabilityEntry(target, models);
			}
		}
	} catch {
		// Preserve the existing roster-unavailable fallback behavior below.
	}

	return getProviderCapabilities()[normalizeProviderName(providerName)] ?? null;
}
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
export function getCapabilityClass(providerName) {
	const provider = getCapabilityEntry(providerName);
	return provider?.capability_class ?? null;
}
export function getModelForCapability(providerName, capabilityClass) {
	const provider = getCapabilityEntry(providerName);
	return provider?.models?.[capabilityClass] ?? null;
}
export function getImplementorPriority(providerName) {
	const provider = getCapabilityEntry(providerName);
	return provider?.implementor_priority ?? null;
}
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
export function __resetRosterCacheForTests() {
	cachedRoster = null;
	cachedProviderCapabilities = null;
	cachedSnapshotNameCapabilities = null;
	cachedRosterSha = null;
}
export { getRoster };
