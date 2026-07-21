import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	computeScore,
	jitter,
	resolveSeed,
} from "../src/switchyard/router/scorer.mjs";

describe("scorer", () => {
	describe("jitter", () => {
		it("should return a number in [0, 1)", () => {
			const val = jitter(42, "claude:opus");
			ok(typeof val === "number", "jitter returns a number");
			ok(val >= 0, "jitter >= 0");
			ok(val < 1, "jitter < 1");
		});

		it("should be deterministic for same inputs", () => {
			const a = jitter(100, "claude:opus");
			const b = jitter(100, "claude:opus");
			strictEqual(a, b, "same inputs yield same jitter");
		});

		it("should differ across keys", () => {
			const a = jitter(42, "claude:opus");
			const b = jitter(42, "codex:gpt-5");
			ok(a !== b, "different keys yield different jitter");
		});

		it("should differ across seeds", () => {
			const a = jitter(1, "claude:opus");
			const b = jitter(999, "claude:opus");
			ok(a !== b, "different seeds yield different jitter");
		});
	});

	describe("resolveSeed", () => {
		it("should use explicit seed when provided", () => {
			const result = resolveSeed({ seed: 12345 });
			strictEqual(result.seed, 12345);
		});

		it("should coerce seed to uint32", () => {
			const result = resolveSeed({ seed: -1 });
			strictEqual(result.seed, -1 >>> 0);
		});

		it("should hash runId when no seed", () => {
			const result = resolveSeed({ runId: "run-abc" });
			ok(typeof result.seed === "number", "seed is a number");
			ok(result.seed !== 0, "seed is non-zero for non-empty runId");
		});

		it("should return 0 when neither seed nor runId", () => {
			const result = resolveSeed({});
			strictEqual(result.seed, 0);
		});

		it("should ignore non-finite seed", () => {
			const result = resolveSeed({ seed: Number.NaN });
			strictEqual(result.seed, 0);
		});

		it("should ignore empty runId", () => {
			const result = resolveSeed({ runId: "" });
			strictEqual(result.seed, 0);
		});

		it("should hash runId deterministically", () => {
			const a = resolveSeed({ runId: "run-123" });
			const b = resolveSeed({ runId: "run-123" });
			strictEqual(a.seed, b.seed, "same runId yields same seed");
		});
	});

	describe("computeScore", () => {
		it("should compute score with normPace and jitter", () => {
			const result = computeScore(50, 42, "claude:opus", [0, 100]);
			ok(typeof result.normPace === "number", "normPace is a number");
			ok(typeof result.jitter === "number", "jitter is a number");
			ok(typeof result.score === "number", "score is a number");
		});

		it("should normalize pace correctly", () => {
			const result = computeScore(50, 0, "key", [0, 100]);
			strictEqual(result.normPace, 0.5, "50 is midpoint of [0, 100]");
		});

		it("should return normPace 1.0 when span is 0", () => {
			const result = computeScore(50, 0, "key", [50, 50]);
			strictEqual(result.normPace, 1.0, "zero span normalizes to 1.0");
		});

		it("should weight score as 0.9*normPace + 0.1*jitter", () => {
			const result = computeScore(100, 42, "test:key", [0, 100]);
			const expected = 0.9 * 1.0 + 0.1 * result.jitter;
			strictEqual(result.score, expected, "score formula is correct");
		});
	});
});
