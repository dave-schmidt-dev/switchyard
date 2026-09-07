import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";
import {
	isReviewResult,
	reviewResultFromExecution,
	sanitizeReviewResult,
} from "../src/switchyard/diagnostics/review-result.mjs";

test("sanitizes bounded review results and redacts provider text", () => {
	const result = sanitizeReviewResult({
		verdict: "changes_requested",
		summary: "A bounded summary",
		findings: [
			{
				severity: "high",
				path: "src/example.mjs",
				line: 12,
				summary: "Handle the empty response",
				detail: "The consumer can otherwise retry forever.",
			},
		],
		comments: ["Looks bounded"],
		transcript: "PROVIDER_SECRET_CANARY",
	});

	strictEqual(result.status, "available");
	strictEqual(result.verdict, "findings");
	strictEqual(result.findingCount, 1);
	strictEqual(result.commentCount, 1);
	strictEqual(result.sourceMutationCount, 0);
	strictEqual(JSON.stringify(result).includes("PROVIDER_SECRET_CANARY"), false);
	strictEqual(isReviewResult(result), true);
});

test("invalid finding references become unavailable without retaining input", () => {
	const result = sanitizeReviewResult({
		verdict: "findings",
		findings: [{ path: "../../secret", summary: "PROVIDER_SECRET_CANARY" }],
	});
	strictEqual(result.status, "unavailable");
	strictEqual(result.reason, "malformed");
	strictEqual(JSON.stringify(result).includes("PROVIDER_SECRET_CANARY"), false);
});

test("malformed or non-structured provider output becomes unavailable", () => {
	const result = reviewResultFromExecution({
		output: "PROVIDER_SECRET_CANARY: not JSON",
	});
	deepStrictEqual(result.findings, []);
	strictEqual(result.status, "unavailable");
	strictEqual(result.reason, "malformed");
	strictEqual(result.sourceMutationCount, 0);
	strictEqual(JSON.stringify(result).includes("PROVIDER_SECRET_CANARY"), false);
});
