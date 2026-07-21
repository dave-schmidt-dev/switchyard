// Roster module - provider capability metadata
// INV-5: Capability filter ensures (provider, model) meets task tier
// Defines capability_class per harness and tier -> model mapping

/**
 * Capability classes for providers.
 * high: Complex integration, schema/migration work
 * standard: Bounded judgment tasks
 * low: Mechanical, isolated, deterministic tasks
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

/**
 * Provider capability definitions.
 * Each provider has a capability_class and a mapping of tiers to models.
 * INV-5: A provider with capability_class below the task tier is filtered out.
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
	claude: {
		capability_class: CAPABILITY_CLASS.high,
		models: {
			high: "claude-opus-4-8",
			standard: "claude-sonnet-5",
			low: "claude-haiku",
		},
	},
	codex: {
		capability_class: CAPABILITY_CLASS.high,
		models: {
			high: "gpt-5.6-sol",
			standard: "gpt-5.6-terra",
			low: "gpt-5.6-luna",
		},
	},
	agy: {
		capability_class: CAPABILITY_CLASS.standard,
		models: {
			high: "Gemini 3.1 Pro (High)",
			standard: "Gemini 3.5 Flash (Medium)",
			low: "Gemini 3.5 Flash (Low)",
		},
	},
	cursor: {
		capability_class: CAPABILITY_CLASS.standard,
		models: {
			high: "claude-opus-4-8-xhigh",
			standard: "composer-2.5",
			low: "gpt-5.6-luna-medium",
		},
	},
	vibe: {
		capability_class: CAPABILITY_CLASS.low,
		models: {
			high: "mistral-medium-3.5",
			standard: "mistral-medium-3.5",
			low: "devstral-small",
		},
	},
	copilot: {
		capability_class: CAPABILITY_CLASS.low,
		models: {
			high: "copilot-gpt-4",
			standard: "copilot-gpt-4",
			low: "copilot-gpt-3.5",
		},
	},
});

/**
 * Get the capability class for a provider.
 * @param {string} providerName
 * @returns {string|null} capability class or null if unknown
 */
export function getCapabilityClass(providerName) {
	const provider = PROVIDER_CAPABILITIES[providerName?.toLowerCase()];
	return provider?.capability_class ?? null;
}

/**
 * Get the model for a provider at a given tier.
 * @param {string} providerName
 * @param {string} tier
 * @returns {string|null} model name or null if not found
 */
export function getModelForTier(providerName, tier) {
	const provider = PROVIDER_CAPABILITIES[providerName?.toLowerCase()];
	return provider?.models?.[tier] ?? null;
}

/**
 * Capability filter - INV-5.
 * A (provider, model) below the task's tier is not a candidate.
 * @param {string} providerName
 * @param {string} taskTier
 * @returns {boolean} true if provider meets or exceeds the tier
 */
export function passesCapabilityFilter(providerName, taskTier) {
	const providerClass = getCapabilityClass(providerName);
	const taskTierValue = TIER_ORDER[taskTier] ?? 0;
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
