import {
	getCapabilityClass,
	getModelForCapability,
	getRoster,
} from "./cache.mjs";
import {
	findTargetEntryForDescriptor,
	isAutomaticRoutingTarget,
	slotInvocationIsSupported,
} from "./capabilities.mjs";
import {
	computeQualificationStatus,
	currentQualificationSignature,
	resolveConfiguredDispatchDescriptor,
	resolveCurrentDispatchDescriptor,
} from "./qualification.mjs";
import {
	CAPABILITY_CLASS_ORDER,
	QUALIFICATION_STATUS,
	ROSTER_CAPABILITY_CLASSES,
	STALE_MAX_AGE_SECONDS,
} from "./schema.mjs";
export function evaluateRealRosterCoherence(
	rosterData = getRoster(),
	{
		nowIso = new Date().toISOString(),
		maxAgeSeconds = STALE_MAX_AGE_SECONDS,
	} = {},
) {
	const models =
		rosterData?.models && typeof rosterData.models === "object"
			? rosterData.models
			: {};
	const targets =
		rosterData?.targets && typeof rosterData.targets === "object"
			? rosterData.targets
			: {};
	const enabledClasses = new Set();
	const eligibleByClass = Object.fromEntries(
		ROSTER_CAPABILITY_CLASSES.map((capabilityClass) => [capabilityClass, []]),
	);
	const excludedTargets = [];
	const unsupportedSlots = [];

	for (const [targetId, target] of Object.entries(targets)) {
		if (!target || typeof target !== "object") continue;
		if (!isAutomaticRoutingTarget(target, targetId)) {
			if (
				targetId === "antigravity" ||
				targetId === "vibe" ||
				target.harness === "vibe"
			) {
				excludedTargets.push(targetId);
			}
			continue;
		}
		for (const capabilityClass of ROSTER_CAPABILITY_CLASSES) {
			const slots = target.slots?.[capabilityClass];
			if (!Array.isArray(slots)) continue;
			for (const slot of slots) {
				if (!slot || typeof slot !== "object" || slot.manual_only) continue;
				const model = models[slot.model_ref];
				if (model?.status !== "active") continue;
				enabledClasses.add(capabilityClass);
				if (!slotInvocationIsSupported(target.harness, slot)) {
					unsupportedSlots.push({
						targetId,
						capabilityClass,
						intent: {
							effort: slot.effort ?? null,
							variant: slot.variant ?? null,
						},
					});
					continue;
				}
				const descriptor = resolveCurrentDispatchDescriptor(
					targetId,
					target,
					models,
					slot,
					{ nowIso, maxAgeSeconds },
				);
				if (descriptor) {
					eligibleByClass[capabilityClass].push({
						targetId,
						descriptorIdentity: descriptor.descriptor_identity,
					});
				}
			}
		}
	}

	const noEnabledClasses = enabledClasses.size === 0;
	// The automatic ladder has a fixed low/standard/high baseline. A roster
	// that accidentally drops an entire class must fail closed rather than
	// treating the remaining class set as a vacuous success.
	const missingClasses = ROSTER_CAPABILITY_CLASSES.filter(
		(capabilityClass) => eligibleByClass[capabilityClass].length === 0,
	);
	return {
		ok: !noEnabledClasses && missingClasses.length === 0,
		enabledClasses: [...ROSTER_CAPABILITY_CLASSES],
		missingClasses,
		noEnabledClasses,
		eligibleByClass,
		excludedTargets: [...new Set(excludedTargets)].sort(),
		unsupportedSlots,
	};
}
export function formatRealRosterCoherenceFailure(report) {
	if (report?.ok) return "real-roster coherence passed";
	const missing = report?.missingClasses?.join(", ") || "none";
	const enabled = report?.enabledClasses?.join(", ") || "none";
	const unsupported = report?.unsupportedSlots?.length ?? 0;
	return (
		`real-roster coherence failed; missing current exact dispatch_qualified ` +
		`automatic coverage for: ${missing}; enabled classes: ${enabled}. ` +
		`Unsupported automatic slots disabled: ${unsupported}. ` +
		"Run an explicitly authorized dispatch qualification canary for each " +
		"missing descriptor; legacy qualified/probe evidence is insufficient."
	);
}
export function assertRealRosterCoherence(
	rosterData = getRoster(),
	options = {},
) {
	const report = evaluateRealRosterCoherence(rosterData, options);
	if (!report.ok) throw new Error(formatRealRosterCoherenceFailure(report));
	return report;
}
export function getInvocationDescriptor(providerName, capabilityClass) {
	return getDescriptorForCapability(providerName, capabilityClass, true);
}
export function getConfiguredInvocationDescriptor(
	providerName,
	capabilityClass,
) {
	return getDescriptorForCapability(providerName, capabilityClass, false);
}
function getDescriptorForCapability(
	providerName,
	capabilityClass,
	requireQualification,
) {
	if (!Object.hasOwn(CAPABILITY_CLASS_ORDER, capabilityClass)) {
		throw new Error(
			`getDescriptorForCapability: unrecognized capability ${JSON.stringify(capabilityClass)}`,
		);
	}
	const roster = getRoster();
	const models =
		roster.models && typeof roster.models === "object" ? roster.models : {};
	const targets =
		roster.targets && typeof roster.targets === "object" ? roster.targets : {};
	const entry = findTargetEntryForDescriptor(targets, providerName);
	if (!entry) return null;
	const slots = entry.target.slots?.[capabilityClass];
	if (!Array.isArray(slots)) return null;
	const candidates = [];
	for (const slot of slots) {
		if (!slot || typeof slot !== "object" || slot.manual_only) continue;
		const model = models[slot.model_ref];
		if (model?.status !== "active") continue;
		const descriptor = requireQualification
			? resolveCurrentDispatchDescriptor(entry.id, entry.target, models, slot)
			: resolveConfiguredDispatchDescriptor(
					entry.id,
					entry.target,
					models,
					slot,
				);
		if (!descriptor) continue;
		candidates.push({
			priority: Number.isInteger(slot.priority)
				? slot.priority
				: Number.POSITIVE_INFINITY,
			descriptor,
		});
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => a.priority - b.priority);
	return candidates[0].descriptor;
}
export const DESCRIPTOR_GAP = Object.freeze({
	// No owner-configured slot resolves a descriptor at all: no slot for this
	// capability, an inactive model, a manual-only slot, or an invocation the
	// harness cannot express. Not a qualification problem — roster data.
	NOT_CONFIGURED: "not_configured",
	// A descriptor is configured but the target carries no dispatch receipt of
	// any kind. Remedy: run an authorized qualification canary.
	QUALIFICATION_MISSING: "qualification_missing",
	// Dispatch receipts exist, but none for the identity this slot resolves
	// today — the slot's model, selector, effort or argv moved after the last
	// canary. The old evidence is permanently dead; remedy is a canary against
	// the new descriptor, not a refresh of the old one.
	QUALIFICATION_SUPERSEDED: "qualification_superseded",
	// An exact receipt for today's identity exists but is stale: past the age
	// window, or its recorded signature no longer matches the live one.
	// Remedy: re-run the same canary and promote the refreshed receipt.
	QUALIFICATION_EXPIRED: "qualification_expired",
	// An exact, non-stale receipt exists but cannot authorize dispatch —
	// a non-atomic or otherwise malformed promotion receipt, or evidence
	// explicitly marked untransmittable or temporarily unavailable.
	QUALIFICATION_INVALID: "qualification_invalid",
});
export function describeDescriptorGap(
	providerName,
	capabilityClass,
	options = {},
) {
	try {
		if (getInvocationDescriptor(providerName, capabilityClass)) return null;
	} catch {
		// getInvocationDescriptor throws only on an unrecognized capability
		// class. Nothing is configured for a capability that does not exist,
		// and saying so beats propagating into the preflight loop.
		return DESCRIPTOR_GAP.NOT_CONFIGURED;
	}
	try {
		const roster = getRoster();
		const models =
			roster.models && typeof roster.models === "object" ? roster.models : {};
		const targets =
			roster.targets && typeof roster.targets === "object"
				? roster.targets
				: {};
		const entry = findTargetEntryForDescriptor(targets, providerName);
		if (!entry) return DESCRIPTOR_GAP.NOT_CONFIGURED;

		// The configured descriptors this slot resolves today, in the same
		// priority order getDescriptorForCapability would have preferred.
		const slots = entry.target.slots?.[capabilityClass];
		const configured = [];
		for (const slot of Array.isArray(slots) ? slots : []) {
			if (!slot || typeof slot !== "object" || slot.manual_only) continue;
			const model = models[slot.model_ref];
			if (model?.status !== "active") continue;
			const descriptor = resolveConfiguredDispatchDescriptor(
				entry.id,
				entry.target,
				models,
				slot,
			);
			if (!descriptor) continue;
			configured.push({
				priority: Number.isInteger(slot.priority)
					? slot.priority
					: Number.POSITIVE_INFINITY,
				descriptor,
				slot,
				model,
			});
		}
		if (configured.length === 0) return DESCRIPTOR_GAP.NOT_CONFIGURED;
		configured.sort((a, b) => a.priority - b.priority);

		const qualifications =
			entry.target.qualifications &&
			typeof entry.target.qualifications === "object"
				? entry.target.qualifications
				: {};
		const dispatchRecords = Object.values(qualifications).filter(
			(record) =>
				record &&
				typeof record === "object" &&
				record.status === QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
		);
		if (dispatchRecords.length === 0)
			return DESCRIPTOR_GAP.QUALIFICATION_MISSING;

		// Classify against the highest-priority configured descriptor: that is
		// the one the operator would re-canary, so its state is the one worth
		// naming. A lower-priority slot in a different state does not change
		// the remedy for this capability.
		const { descriptor, slot, model } = configured[0];
		const exact = dispatchRecords.filter(
			(record) => record.descriptor_identity === descriptor.descriptor_identity,
		);
		if (exact.length === 0) return DESCRIPTOR_GAP.QUALIFICATION_SUPERSEDED;

		const currentSignature = currentQualificationSignature(
			entry.target,
			slot,
			model,
			descriptor,
		);
		const nowIso = options.nowIso ?? new Date().toISOString();
		const maxAgeSeconds = options.maxAgeSeconds ?? STALE_MAX_AGE_SECONDS;
		const anyStale = exact.some(
			(record) =>
				computeQualificationStatus(
					record,
					currentSignature,
					nowIso,
					maxAgeSeconds,
				) !== QUALIFICATION_STATUS.DISPATCH_QUALIFIED ||
				record.freshness === "stale" ||
				record.freshness?.status === "stale",
		);
		return anyStale
			? DESCRIPTOR_GAP.QUALIFICATION_EXPIRED
			: DESCRIPTOR_GAP.QUALIFICATION_INVALID;
	} catch {
		return DESCRIPTOR_GAP.QUALIFICATION_MISSING;
	}
}
export function hasAutomaticInvocationDescriptor(
	providerName,
	capabilityClass,
) {
	return getInvocationDescriptor(providerName, capabilityClass) !== null;
}
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
export function getRightSizedModel(providerName, capabilityClass) {
	return getModelForCapability(providerName, capabilityClass);
}
export function filterByCapability(providerNames, requiredCapability) {
	return providerNames.filter((name) =>
		passesCapabilityFilter(name, requiredCapability),
	);
}
