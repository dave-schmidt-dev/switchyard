// Classifier module - lightweight task-tier classifier
// CR-5: The per-task difficulty tier is assigned by a lightweight classifier
// since implement-protocol assigns tiers at Phase-3 runtime, not board-build.
//
// Conservative default: unknown tier => high-capability only

import { CAPABILITY_CLASS } from "./index.mjs";

/**
 * Keywords that indicate a high-tier (complex) task.
 */
const HIGH_TIER_KEYWORDS = Object.freeze([
	"integration",
	"migration",
	"schema",
	"architecture",
	"design",
	"refactor",
	"complex",
	"cross-cutting",
	"database",
	"api",
	"service",
	"infrastructure",
	"authentication",
	"authorization",
	"security",
	"performance",
	"scaling",
]);

/**
 * Keywords that indicate a standard-tier task.
 */
const STANDARD_TIER_KEYWORDS = Object.freeze([
	"review",
	"test",
	"fix",
	"bug",
	"feature",
	"endpoint",
	"function",
	"module",
	"class",
	"component",
	"validation",
	"optimization",
	"debug",
]);

/**
 * Keywords that indicate a low-tier (mechanical) task.
 */
const LOW_TIER_KEYWORDS = Object.freeze([
	"format",
	"lint",
	"cleanup",
	"typo",
	"comment",
	"doc",
	"documentation",
	"readme",
	"chore",
	"rename",
	"move",
	"delete",
	"remove",
	"trivial",
	"simple",
	"minor",
]);

/**
 * Classify a task's difficulty tier from its description.
 * Uses keyword matching against task description (case-insensitive).
 *
 * @param {string} description Task description
 * @returns {string} Tier: 'high', 'standard', or 'low'
 */
export function classifyTask(description) {
	if (!description || typeof description !== "string") {
		return CAPABILITY_CLASS.high; // Conservative default
	}

	const lowerDesc = description.toLowerCase();

	// Check for high-tier keywords first (most specific)
	for (const keyword of HIGH_TIER_KEYWORDS) {
		if (lowerDesc.includes(keyword)) {
			return CAPABILITY_CLASS.high;
		}
	}

	// Check for low-tier keywords
	for (const keyword of LOW_TIER_KEYWORDS) {
		if (lowerDesc.includes(keyword)) {
			return CAPABILITY_CLASS.low;
		}
	}

	// Check for standard-tier keywords
	for (const keyword of STANDARD_TIER_KEYWORDS) {
		if (lowerDesc.includes(keyword)) {
			return CAPABILITY_CLASS.standard;
		}
	}

	// Default: standard tier for unknown
	// Conservative: if we can't determine, assume standard
	// (but high-tier tasks should be explicitly marked)
	return CAPABILITY_CLASS.standard;
}

/**
 * Batch classify multiple task descriptions.
 * @param {string[]} descriptions Array of task descriptions
 * @returns {string[]} Array of tier classifications
 */
export function classifyTasks(descriptions) {
	return descriptions.map(classifyTask);
}

/**
 * Validate that a tier is one of the known capability classes.
 * @param {string} tier
 * @returns {boolean}
 */
export function isValidTier(tier) {
	return Object.values(CAPABILITY_CLASS).includes(tier);
}

export { CAPABILITY_CLASS };
