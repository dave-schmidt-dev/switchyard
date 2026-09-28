import { getRoster, getRosterProvenance } from "./cache.mjs";
import {
	normalizeProviderName,
	resolveSlotModel,
	resolveTargetIdentityFromTargets,
} from "./capabilities.mjs";
export function resolveTargetId(identifier) {
	if (!identifier) return null;
	try {
		const roster = getRoster();
		const targets =
			roster.targets && typeof roster.targets === "object"
				? roster.targets
				: {};
		return resolveTargetIdentityFromTargets(targets, identifier).targetId;
	} catch {
		return null;
	}
}
export function resolveTargetIdentity(identifier) {
	if (!identifier) {
		return { targetId: null, harnessKey: null, ambiguous: false };
	}
	try {
		const roster = getRoster();
		const targets =
			roster.targets && typeof roster.targets === "object"
				? roster.targets
				: {};
		return resolveTargetIdentityFromTargets(targets, identifier);
	} catch {
		return { targetId: null, harnessKey: null, ambiguous: false };
	}
}
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
	const entry = resolveTargetIdentityFromTargets(targets, providerName).targetId
		? (() => {
				const targetId = resolveTargetIdentityFromTargets(
					targets,
					providerName,
				).targetId;
				return targetId ? { id: targetId, target: targets[targetId] } : null;
			})()
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
