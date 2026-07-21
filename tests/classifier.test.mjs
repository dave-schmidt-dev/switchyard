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
			strictEqual(classifyTask("typo in the readme file"), "low");
			strictEqual(classifyTask("cleanup comments"), "low");
			strictEqual(classifyTask("rename variable"), "low");
			strictEqual(classifyTask("simple trivial minor change"), "low");
		});

		it("should default to high for unrecognized descriptions", () => {
			// Conservative default: no recognized signal at all => high-capability
			// only (a prior version fell through to "standard" here, contradicting
			// its own documented contract).
			strictEqual(classifyTask("do the thing"), "high");
			strictEqual(classifyTask("random words here"), "high");
		});

		it("never downgrades a task to low when it also contains standard-tier signal", () => {
			// Regression: LOW was checked before STANDARD, so "fix the bug and
			// add a clarifying comment" classified low ("comment" beat "fix"/
			// "bug"). Under-classifying real work to a weak provider is the
			// dangerous direction; STANDARD now takes priority over LOW.
			strictEqual(
				classifyTask("fix the bug and add a clarifying comment"),
				"standard",
			);
			strictEqual(
				classifyTask(
					"remove the deprecated login endpoint and add input validation",
				),
				"standard",
			);
			strictEqual(
				classifyTask("debug the flaky test and document the fix"),
				"standard",
			);
		});

		it("does not false-match a keyword as a substring of an unrelated word", () => {
			// "api" must not match inside "rapid"/"capital"; "design" must not
			// match inside "redesignate"; "move" must not match inside "movement".
			// None of these actually contain a recognized keyword once the false
			// substring matches are removed, so they land on the conservative
			// high default rather than the (wrong) keyword tier a prior version
			// assigned via the accidental substring hit.
			strictEqual(classifyTask("make the UI feel more rapid"), "high");
			strictEqual(classifyTask("update the capital gains calculator"), "high");
			strictEqual(classifyTask("redesignate the owner column"), "high");
			strictEqual(classifyTask("track user movement heatmaps"), "high");
		});

		it("treats auth/session/crypto terms as high-tier regardless of other words", () => {
			// Regression: "minor tweak to the JWT session handling" classified
			// low ("minor" matched, no HIGH_TIER_KEYWORDS entry recognized
			// "jwt"/"session"/"auth" at all).
			strictEqual(
				classifyTask("minor tweak to the JWT session handling"),
				"high",
			);
			strictEqual(classifyTask("quick fix to the auth flow"), "high");
			strictEqual(classifyTask("simple change to session credentials"), "high");
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
