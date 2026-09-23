import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";
import fc from "fast-check";
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

test("normalizes empty findings to clean verdict for changes_requested and findings", () => {
	const changesRequested = sanitizeReviewResult({
		verdict: "changes_requested",
		comments: ["Please address feedback"],
	});
	strictEqual(changesRequested.status, "available");
	strictEqual(changesRequested.verdict, "clean");
	strictEqual(changesRequested.findingCount, 0);
	deepStrictEqual(changesRequested.comments, ["Please address feedback"]);
	strictEqual(isReviewResult(changesRequested), true);

	const emptyFindings = sanitizeReviewResult({
		verdict: "findings",
		findings: [],
	});
	strictEqual(emptyFindings.status, "available");
	strictEqual(emptyFindings.verdict, "clean");
	strictEqual(emptyFindings.findingCount, 0);
	strictEqual(isReviewResult(emptyFindings), true);
});

const PROPERTY_SEED =
	Number.parseInt(process.env.SWITCHYARD_PROPERTY_SEED ?? "1333406745", 10) >>>
	0;

const validVerdictArbitrary = fc.constantFrom(
	"clean",
	"findings",
	"pass",
	"passed",
	"approved",
	"ok",
	"fail",
	"failed",
	"changes_requested",
	"needs_review",
);

const severityArbitrary = fc.constantFrom(
	"critical",
	"high",
	"medium",
	"low",
	"info",
);

const safeTextArbitrary = (maxLen) =>
	fc
		.stringMatching(/^[A-Za-z0-9 _.,-]{1,64}$/u)
		.map((s) => s.slice(0, maxLen).trim())
		.filter((s) => s.length > 0);

const safePathArbitrary = fc
	.tuple(
		fc.stringMatching(/^[a-z0-9_-]{1,16}$/u),
		fc.stringMatching(/^[a-z0-9_-]{1,16}\.(mjs|js|ts|json)$/u),
	)
	.map(([dir, file]) => `${dir}/${file}`);

const findingArbitrary = fc
	.record(
		{
			severity: severityArbitrary,
			summary: safeTextArbitrary(100),
			path: safePathArbitrary,
			line: fc.integer({ min: 1, max: 10_000 }),
			endLine: fc.integer({ min: 1, max: 10_000 }),
			detail: safeTextArbitrary(200),
		},
		{
			requiredKeys: ["summary", "path"],
		},
	)
	.map((f) => {
		if (f.line !== undefined && f.endLine !== undefined && f.endLine < f.line) {
			f.endLine = f.line;
		}
		return f;
	});

const availableReviewResultArbitrary = fc.record(
	{
		verdict: validVerdictArbitrary,
		summary: fc.option(safeTextArbitrary(200), { nil: undefined }),
		findings: fc.option(
			fc.array(findingArbitrary, { minLength: 0, maxLength: 5 }),
			{ nil: undefined },
		),
		comments: fc.option(
			fc.array(safeTextArbitrary(100), { minLength: 0, maxLength: 5 }),
			{ nil: undefined },
		),
	},
	{
		requiredKeys: ["verdict"],
	},
);

test("property: isReviewResult(sanitizeReviewResult(x)) holds for every available result", () => {
	fc.assert(
		fc.property(availableReviewResultArbitrary, (input) => {
			const sanitized = sanitizeReviewResult(input);
			if (sanitized.status !== "available") return;
			strictEqual(isReviewResult(sanitized), true);
			if (sanitized.findings.length === 0) {
				strictEqual(sanitized.verdict, "clean");
			} else {
				strictEqual(sanitized.verdict, "findings");
			}
		}),
		{
			numRuns: 500,
			seed: PROPERTY_SEED,
			endOnFailure: true,
		},
	);
});

test("property: isReviewResult(sanitizeReviewResult(x)) holds for arbitrary inputs", () => {
	fc.assert(
		fc.property(fc.anything(), (input) => {
			const sanitized = sanitizeReviewResult(input);
			strictEqual(isReviewResult(sanitized), true);
		}),
		{
			numRuns: 200,
			seed: PROPERTY_SEED,
			endOnFailure: true,
		},
	);
});
