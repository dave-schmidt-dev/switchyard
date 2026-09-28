import {
	CAPABILITY_CLASS_RANK,
	PROVIDER_INVOCATION_VOCABULARY,
	qualificationVariantKey,
	ROSTER_CAPABILITY_CLASSES,
} from "./schema.mjs";

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
function isAutomaticRoutingTarget(target, targetId) {
	if (!target || typeof target !== "object" || !target.enabled) return false;
	void targetId;
	return true;
}
function resolveTargetIdentityFromTargets(targets, identifier) {
	if (typeof identifier !== "string" || identifier.length === 0) {
		return { targetId: null, harnessKey: null, ambiguous: false };
	}

	const exactTarget = targets[identifier];
	if (exactTarget && typeof exactTarget === "object") {
		return {
			targetId: identifier,
			harnessKey:
				typeof exactTarget.harness === "string" ? exactTarget.harness : null,
			ambiguous: false,
		};
	}

	for (const [id, target] of Object.entries(targets)) {
		if (
			target &&
			typeof target === "object" &&
			target.snapshot_name === identifier
		) {
			return {
				targetId: id,
				harnessKey: typeof target.harness === "string" ? target.harness : null,
				ambiguous: false,
			};
		}
	}

	const harnessKey = normalizeProviderName(identifier);
	if (!harnessKey) {
		return { targetId: null, harnessKey: null, ambiguous: false };
	}

	const enabledEntries = Object.entries(targets).filter(
		([id, target]) =>
			target &&
			typeof target === "object" &&
			target.enabled &&
			target.harness === harnessKey &&
			isAutomaticRoutingTarget(target, id),
	);
	if (enabledEntries.length === 1) {
		return {
			targetId: enabledEntries[0][0],
			harnessKey,
			ambiguous: false,
		};
	}
	if (enabledEntries.length > 1) {
		return { targetId: null, harnessKey, ambiguous: true };
	}

	return { targetId: null, harnessKey, ambiguous: false };
}
function findTargetEntryForDescriptor(targets, identifier) {
	const identity = resolveTargetIdentityFromTargets(targets, identifier);
	if (!identity.targetId || identity.ambiguous) return null;
	const target = targets[identity.targetId];
	if (!isAutomaticRoutingTarget(target, identity.targetId)) return null;
	return { id: identity.targetId, target };
}
function normalizeImplementorPriority(value) {
	return Number.isInteger(value) && value > 0 ? value : null;
}
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
export function getProviderInvocationVocabulary(providerOrHarness) {
	const harness = normalizeProviderName(providerOrHarness);
	return PROVIDER_INVOCATION_VOCABULARY[harness] ?? null;
}
export function mapInvocationArgs(providerOrHarness, intent = {}) {
	const vocabulary = getProviderInvocationVocabulary(providerOrHarness);
	if (!vocabulary || !intent || typeof intent !== "object") return null;
	const effort = intent.effort ?? null;
	const variant = intent.variant ?? null;
	if (effort !== null && variant !== null) return null;
	if (effort !== null) {
		if (!vocabulary.effort.includes(effort)) return null;
		if (
			providerOrHarness &&
			normalizeProviderName(providerOrHarness) === "codex"
		) {
			return Object.freeze(["-c", `model_reasoning_effort=${effort}`]);
		}
		return Object.freeze(["--effort", effort]);
	}
	if (variant !== null) {
		if (!vocabulary.variant.includes(variant)) return null;
		// OpenCode's "default" is the absence of a provider override. Passing
		// `--variant default` asks the selected model to support a literal
		// variant it may not offer (GLM-5.2 exposes only high/max), so preserve
		// the roster intent while emitting no variant argv.
		if (
			normalizeProviderName(providerOrHarness) === "opencode" &&
			variant === "default"
		) {
			return Object.freeze([]);
		}
		return Object.freeze(["--variant", variant]);
	}
	return Object.freeze([]);
}
function slotInvocationIsSupported(harness, slot) {
	if (!slot || typeof slot !== "object") return false;
	const expected = mapInvocationArgs(harness, slot);
	if (expected === null) return false;
	const actual = slot.invocation_args ?? [];
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((value, index) => value === expected[index])
	);
}

export {
	buildCapabilityEntry,
	findTargetEntryForDescriptor,
	isAutomaticRoutingTarget,
	resolveSlotModel,
	resolveTargetIdentityFromTargets,
	slotInvocationIsSupported,
};
