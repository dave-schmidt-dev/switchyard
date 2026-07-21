import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	classifyTask,
	classifyTasks,
	isValidTier,
} from "../src/switchyard/roster/classifier.mjs";

describe("classifier", () => {
	describe("classifyTask", () => {
		it("should classify high-tier tasks from keywords", () => {
			strictEqual(classifyTask("implement integration tests"), "high");
			strictEqual(classifyTask("database migration schema"), "high");
			strictEqual(classifyTask("architecture design refactor"), "high");
			strictEqual(classifyTask("security authentication fix"), "high");
			strictEqual(classifyTask("performance scaling api"), "high");
		});

		it("should classify standard-tier tasks from keywords", () => {
			strictEqual(classifyTask("review the feature"), "standard");
			strictEqual(classifyTask("fix the bug in endpoint"), "standard");
			strictEqual(classifyTask("add validation to function"), "standard");
			strictEqual(classifyTask("optimize the module"), "standard");
		});

		it("should classify low-tier tasks from keywords", () => {
			strictEqual(classifyTask("format the code"), "low");
			strictEqual(classifyTask("fix typo in readme"), "low");
			strictEqual(classifyTask("cleanup comments"), "low");
			strictEqual(classifyTask("rename variable"), "low");
			strictEqual(classifyTask("simple trivial minor change"), "low");
		});

		it("should default to standard for unknown descriptions", () => {
			strictEqual(classifyTask("do the thing"), "standard");
			strictEqual(classifyTask("random words here"), "standard");
		});

		it("should default to high for null/undefined input", () => {
			strictEqual(classifyTask(null), "high");
			strictEqual(classifyTask(undefined), "high");
		});

		it("should default to high for non-string input", () => {
			strictEqual(classifyTask(42), "high");
			strictEqual(classifyTask({}), "high");
		});

		it("should default to high for empty string", () => {
			strictEqual(classifyTask(""), "high");
		});

		it("should be case-insensitive", () => {
			strictEqual(classifyTask("INTEGRATION work"), "high");
			strictEqual(classifyTask("FORMAT code"), "low");
			strictEqual(classifyTask("REVIEW feature"), "standard");
		});

		it("should prioritize high over low when both match", () => {
			// "security" (high) + "simple" (low) → high wins
			strictEqual(classifyTask("simple security fix"), "high");
		});
	});

	describe("classifyTasks", () => {
		it("should classify multiple descriptions", () => {
			const results = classifyTasks([
				"integration work",
				"format code",
				"review feature",
			]);
			strictEqual(results[0], "high");
			strictEqual(results[1], "low");
			strictEqual(results[2], "standard");
		});

		it("should return empty array for empty input", () => {
			const results = classifyTasks([]);
			strictEqual(results.length, 0);
		});
	});

	describe("isValidTier", () => {
		it("should accept valid tiers", () => {
			strictEqual(isValidTier("high"), true);
			strictEqual(isValidTier("standard"), true);
			strictEqual(isValidTier("low"), true);
		});

		it("should reject invalid tiers", () => {
			strictEqual(isValidTier("medium"), false);
			strictEqual(isValidTier(""), false);
			strictEqual(isValidTier(null), false);
		});
	});
});
