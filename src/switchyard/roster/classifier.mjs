// Classifier module - lightweight task-tier classifier
// CR-5: The per-task difficulty tier is assigned by a lightweight classifier
// since implement-protocol assigns tiers at Phase-3 runtime, not board-build.
//
// Conservative default: unknown tier => high-capability only

import { CAPABILITY_CLASS } from "./index.mjs";

/**
 * Security-critical high-tier keywords. A task touching these is never safe to
 * downgrade just because it also happens to contain a low-tier word like
 * "minor" or "quick". These are matched by plain case-insensitive SUBSTRING
 * (see buildSubstringPattern) rather than word boundaries, so inflected and
 * compound forms ("credentials", "sessions", "unauthorized", "authoring") also
 * classify high. Over-classifying related work is just cost; under-classifying
 * security work to a weak provider is the dangerous direction.
 */
const SECURITY_CRITICAL_KEYWORDS = Object.freeze([
	"authentication",
	"authorization",
	"auth",
	"jwt",
	"session",
	"crypto",
	"encryption",
	"credential",
	"permission",
	"secret",
	"security",
]);

/**
 * Structural/complexity high-tier keywords. These are general-purpose words
 * ("api", "design", "service") that DO false-match as substrings of unrelated
 * words ("api" in "rapid", "design" in "redesignate"), so they stay on
 * word-boundary matching (see buildKeywordPattern).
 */
const STRUCTURAL_TIER_KEYWORDS = Object.freeze([
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

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a single word-boundary regex from a keyword list. Plain substring
 * matching (the prior implementation) false-matched "api" inside "rapid",
 * "design" inside "redesignate", and "move" inside "movement" — as well as
 * false-negating the reverse: "move" failed to signal on "movement" at all
 * once boundaries are added, which is intentional (a whole different word).
 * @param {readonly string[]} keywords
 * @returns {RegExp}
 */
function buildKeywordPattern(keywords) {
	return new RegExp(`\\b(${keywords.map(escapeRegExp).join("|")})\\b`, "i");
}

/**
 * Build a case-insensitive SUBSTRING regex from a keyword list — no word
 * boundaries. Used only for the security-critical subset, where matching
 * inflected/compound forms ("credentials", "unauthorized") is intended: the
 * cost of over-classifying is trivial, and under-classifying security work to
 * a weak provider is the dangerous direction.
 * @param {readonly string[]} keywords
 * @returns {RegExp}
 */
function buildSubstringPattern(keywords) {
	return new RegExp(`(${keywords.map(escapeRegExp).join("|")})`, "i");
}

const SECURITY_CRITICAL_PATTERN = buildSubstringPattern(
	SECURITY_CRITICAL_KEYWORDS,
);
const STRUCTURAL_TIER_PATTERN = buildKeywordPattern(STRUCTURAL_TIER_KEYWORDS);
const STANDARD_TIER_PATTERN = buildKeywordPattern(STANDARD_TIER_KEYWORDS);
const LOW_TIER_PATTERN = buildKeywordPattern(LOW_TIER_KEYWORDS);

/**
 * A task is high-tier if it matches EITHER the security-critical substring
 * pattern OR the structural word-boundary pattern.
 * @param {string} description
 * @returns {boolean}
 */
function isHighTier(description) {
	return (
		SECURITY_CRITICAL_PATTERN.test(description) ||
		STRUCTURAL_TIER_PATTERN.test(description)
	);
}

/**
 * Classify a task's difficulty tier from its description.
 * Uses whole-word keyword matching (case-insensitive). Checked in order
 * high -> standard -> low: a task that mentions any standard-tier signal
 * (e.g. "fix", "bug", "endpoint") is never downgraded to low just because
 * it also contains a low-tier word (e.g. "fix the bug and add a comment"
 * is standard, not low) — under-classifying real work to a weak provider
 * is the dangerous direction; over-classifying trivial work is just cost.
 *
 * @param {string} description Task description
 * @returns {string} Tier: 'high', 'standard', or 'low'
 */
export function classifyTask(description) {
	if (!description || typeof description !== "string" || !description.trim()) {
		return CAPABILITY_CLASS.high; // Conservative default (unknown => high-capability only)
	}

	if (isHighTier(description)) {
		return CAPABILITY_CLASS.high;
	}

	if (STANDARD_TIER_PATTERN.test(description)) {
		return CAPABILITY_CLASS.standard;
	}

	if (LOW_TIER_PATTERN.test(description)) {
		return CAPABILITY_CLASS.low;
	}

	// Conservative default: no recognized signal at all => high-capability only.
	return CAPABILITY_CLASS.high;
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
