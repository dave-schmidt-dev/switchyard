import assert from "node:assert";
import test from "node:test";
import { validateModelArg } from "../src/switchyard/adapter/shell-safety.mjs";

test("validateModelArg - rejects leading dash", () => {
	// Single leading dash
	assert.throws(
		() => validateModelArg("-x", "model"),
		/contains unsafe characters/,
		"should reject value starting with single dash",
	);

	// Double leading dash (flag-like)
	assert.throws(
		() => validateModelArg("--dangerous-flag", "model"),
		/contains unsafe characters/,
		"should reject value starting with double dash",
	);
});

test("validateModelArg - accepts embedded dash", () => {
	// Hyphenated model name (embedded dash)
	assert.doesNotThrow(
		() => validateModelArg("gpt-5.5-turbo", "model"),
		"should accept value with embedded dashes",
	);

	// Multiple embedded dashes
	assert.doesNotThrow(
		() => validateModelArg("claude-3-5-sonnet", "model"),
		"should accept value with multiple embedded dashes",
	);
});

test("validateModelArg - accepts legitimate display-name string", () => {
	// Display-name with spaces and parentheses
	assert.doesNotThrow(
		() => validateModelArg("Gemini 3.6 Flash (High)", "model"),
		"should accept legitimate display-name string",
	);

	// Another realistic display-name variant
	assert.doesNotThrow(
		() => validateModelArg("GPT-4 (2024-08-06)", "model"),
		"should accept display-name with embedded dash and parentheses",
	);
});

test("validateModelArg - rejects empty string", () => {
	assert.throws(
		() => validateModelArg("", "model"),
		/must be a non-empty string/,
		"should reject empty string",
	);
});

test("validateModelArg - rejects non-string types", () => {
	assert.throws(
		() => validateModelArg(null, "model"),
		/must be a non-empty string/,
		"should reject null",
	);

	assert.throws(
		() => validateModelArg(undefined, "model"),
		/must be a non-empty string/,
		"should reject undefined",
	);

	assert.throws(
		() => validateModelArg(123, "model"),
		/must be a non-empty string/,
		"should reject number",
	);

	assert.throws(
		() => validateModelArg({}, "model"),
		/must be a non-empty string/,
		"should reject object",
	);
});
