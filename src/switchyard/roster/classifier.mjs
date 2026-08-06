// Classifier module - legacy keyword-based task-capability classifier.
// New task-contract records default an omitted RequiredCapability to standard
// in the runner/router. This helper remains available for older callers that
// still classify descriptions directly, preserving their high/low behavior.

import { CAPABILITY_CLASS } from "./index.mjs";

/**
 * Security-critical high-capability keywords. A task touching these is never
 * safe to downgrade just because it also happens to contain a low-capability word like
 * "minor" or "quick". These are matched by plain case-insensitive SUBSTRING
 * (see buildSubstringPattern) rather than word boundaries, so inflected and
 * compound forms ("credentials", "sessions", "unauthorized", "authoring") also
 * classify high. Over-classifying related work is just cost; under-classifying
 * security work to a weak provider is the dangerous direction.
 */
const SECURITY_CRITICAL_KEYWORDS = Object.freeze([
	"authentication",
	"authorization",
	"jwt",
	"crypto",
	"encryption",
	"security-audit",
	"vulnerability",
	"penetration",
]);

/**
 * High-capability tasks requiring flagship reasoning models: debugging,
 * root-cause investigation, planning, architecture.
 */
const STRUCTURAL_CAPABILITY_KEYWORDS = Object.freeze([
	"debug",
	"debugging",
	"root-cause",
	"investigate",
	"investigation",
	"troubleshoot",
	"plan",
	"planning",
	"architecture",
	"system-design",
	"cross-cutting",
	"infrastructure",
	"scaling",
	"threat-model",
	"disaster-recovery",
]);

/**
 * Keywords that indicate a standard-capability task (bounded implementation & feature work).
 */
const STANDARD_CAPABILITY_KEYWORDS = Object.freeze([
	"implement",
	"implementation",
	"build",
	"integration",
	"migration",
	"schema",
	"refactor",
	"database",
	"sqlite",
	"store",
	"persistence",
	"auth",
	"session",
	"credential",
	"permission",
	"secret",
	"security",
	"api",
	"service",
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
]);

/**
 * Keywords that indicate a low-capability (mechanical) task.
 */
const LOW_CAPABILITY_KEYWORDS = Object.freeze([
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
const STRUCTURAL_CAPABILITY_PATTERN = buildKeywordPattern(
	STRUCTURAL_CAPABILITY_KEYWORDS,
);
const STANDARD_CAPABILITY_PATTERN = buildKeywordPattern(
	STANDARD_CAPABILITY_KEYWORDS,
);
const LOW_CAPABILITY_PATTERN = buildKeywordPattern(LOW_CAPABILITY_KEYWORDS);

/**
 * A task requires high capability if it matches EITHER the security-critical substring
 * pattern OR the structural word-boundary pattern.
 * @param {string} description
 * @returns {boolean}
 */
function requiresHighCapability(description) {
	return (
		SECURITY_CRITICAL_PATTERN.test(description) ||
		STRUCTURAL_CAPABILITY_PATTERN.test(description)
	);
}

/**
 * Classify a task's required capability from its description.
 * Uses whole-word keyword matching (case-insensitive). Checked in order
 * high -> standard -> low: a task that mentions any standard-capability signal
 * (e.g. "fix", "bug", "endpoint") is never downgraded to low just because
 * it also contains a low-capability word (e.g. "fix the bug and add a comment"
 * is standard, not low) — under-classifying real work to a weak provider
 * is the dangerous direction; over-classifying trivial work is just cost.
 *
 * @param {string} description Task description
 * @returns {string} Required capability: 'high', 'standard', or 'low'
 */
export function classifyTask(description) {
	if (!description || typeof description !== "string" || !description.trim()) {
		return CAPABILITY_CLASS.high; // Conservative default (unknown => high-capability only)
	}

	if (requiresHighCapability(description)) {
		return CAPABILITY_CLASS.high;
	}

	if (STANDARD_CAPABILITY_PATTERN.test(description)) {
		return CAPABILITY_CLASS.standard;
	}

	if (LOW_CAPABILITY_PATTERN.test(description)) {
		return CAPABILITY_CLASS.low;
	}

	// Legacy default: no recognized signal at all => high-capability only.
	return CAPABILITY_CLASS.high;
}

/**
 * Batch classify multiple task descriptions.
 * @param {string[]} descriptions Array of task descriptions
 * @returns {string[]} Array of required capability classifications
 */
export function classifyTasks(descriptions) {
	return descriptions.map(classifyTask);
}

/**
 * Validate that a required capability is one of the known capability classes.
 * @param {string} capabilityClass
 * @returns {boolean}
 */
export function isValidCapabilityClass(capabilityClass) {
	return Object.values(CAPABILITY_CLASS).includes(capabilityClass);
}
