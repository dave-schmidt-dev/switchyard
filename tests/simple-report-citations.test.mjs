// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SIMPLE_USAGE } from "../src/switchyard/simple/args.mjs";
import { checkReportCitations } from "../src/switchyard/simple/report-citations.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function fixture() {
	const root = tempDir("report-citation-");
	mkdirSync(join(root, "src"));
	writeFileSync(
		join(root, "src/source.swift"),
		"let elsewhere = 1\nlet PPRenderingObservation = 2\nlet dashPhase = 3\n--text-secondary: gray;\n",
	);
	return {
		root,
		check: (text) => checkReportCitations(Buffer.from(text), root),
	};
}

function reason(result, expected) {
	strictEqual(result.diagnostics[0].reason, expected, JSON.stringify(result));
}

describe("bounded advisory report citations", () => {
	it("matches exact single lines and inclusive ranges with Markdown links", () => {
		const { check } = fixture();
		const result = check(
			"`PPRenderingObservation` at `src/source.swift:2`.\n`dashPhase` in [source](src/source.swift:2-3).",
		);
		deepStrictEqual(result, {
			advisory: true,
			status: "matched",
			citations: 2,
			matched: 2,
			mismatched: 0,
			unverifiable: 0,
			truncated: false,
			diagnostics: [],
		});
	});

	it("does not add nearby lines, use a basename fallback, or guess identifier suffixes", () => {
		const { check } = fixture();
		for (const text of [
			"`PPRenderingObservation` at `src/source.swift:1`",
			"`Observation` at `src/source.swift:2`",
			"`--secondary` at `src/source.swift:4`",
			"`invented` at `src/source.swift:2`",
		]) {
			const result = check(text);
			strictEqual(result.status, "issues");
			reason(result, "identifier_not_found");
		}
		reason(check("`dashPhase` at `source.swift:3`"), "missing_file");
	});

	it("keeps ports and times unverifiable while retaining real missing-file diagnostics", () => {
		const { check } = fixture();
		for (const text of [
			"Listen on localhost:8080",
			"Starts at 10:30",
			"`foo` at `localhost:8080`",
			"`foo` at `Makefile:1`",
		]) {
			const result = check(text);
			strictEqual(result.status, "unverifiable", text);
			strictEqual(result.mismatched, 0, text);
			strictEqual(result.unverifiable, 1, text);
			reason(result, "unsupported_citation");
		}
		for (const path of ["missing.mjs", "src/missing", "src/missing.mjs"]) {
			const result = check(`\`foo\` at \`${path}:1\``);
			strictEqual(result.mismatched, 1, path);
			reason(result, "missing_file");
		}
	});

	it("checks extensionless files when present instead of guessing they are prose", () => {
		const { root, check } = fixture();
		writeFileSync(join(root, "Makefile"), "foo\n");
		strictEqual(check("`foo` at `Makefile:1`").matched, 1);
		reason(check("`other` at `Makefile:1`"), "identifier_not_found");
		reason(check("`foo` at `Makefile:2`"), "line_out_of_range");
	});

	it("matches single identifiers in member access without matching longer tokens", () => {
		const { root, check } = fixture();
		const lines = [
			"this.foo()",
			"foo.bar",
			"foobar()",
			"barfoo()",
			"foo_bar",
			"foo$bar",
			"foo-bar",
		];
		writeFileSync(join(root, "src/members.mjs"), lines.join("\n"));
		for (let index = 0; index < lines.length; index += 1) {
			const result = check(`\`foo\` at \`src/members.mjs:${index + 1}\``);
			strictEqual(result.matched, index < 2 ? 1 : 0, lines[index]);
			if (index >= 2) reason(result, "identifier_not_found");
		}
	});

	it("keeps qualified identifier boundaries exact", () => {
		const { root, check } = fixture();
		const lines = [
			"foo.bar()",
			"this.foo.bar()",
			"foo.bar.baz",
			"foo.barSuffix",
			"prefixfoo.bar",
		];
		writeFileSync(join(root, "src/qualified.mjs"), lines.join("\n"));
		for (let index = 0; index < lines.length; index += 1) {
			const result = check(`\`foo.bar\` at \`src/qualified.mjs:${index + 1}\``);
			strictEqual(result.matched, index === 0 ? 1 : 0, lines[index]);
			if (index > 0) reason(result, "identifier_not_found");
		}
	});

	it("identifies missing files and exact invalid line ranges, including trailing newlines", () => {
		const { check } = fixture();
		for (const [citation, expected] of [
			["src/missing.swift:2", "missing_file"],
			["src/source.swift:0", "invalid_range"],
			["src/source.swift:3-2", "invalid_range"],
			["src/source.swift:9007199254740992", "invalid_range"],
			["src/source.swift:5", "line_out_of_range"],
			["src/source.swift:3-5", "line_out_of_range"],
		]) {
			const result = check(`\`dashPhase\` at \`${citation}\``);
			strictEqual(result.mismatched, 1);
			reason(result, expected);
		}
	});

	it("keeps absent or ambiguous identifiers unverifiable and does not reuse another citation's token", () => {
		const { check } = fixture();
		reason(check("Source is at `src/source.swift:2`."), "no_identifier");
		reason(
			check(
				"`dashPhase` and `PPRenderingObservation` at `src/source.swift:2-3`.",
			),
			"ambiguous_identifier",
		);
		reason(
			check("`dashPhase` is relevant. Source at `src/source.swift:2`."),
			"no_identifier",
		);
		const result = check(
			"`PPRenderingObservation` at `src/source.swift:2`, then `src/source.swift:3`.",
		);
		strictEqual(result.matched, 1);
		strictEqual(result.unverifiable, 1);
		reason(result, "no_identifier");
	});

	it("does not claim semantic truth from matching text", () => {
		const { check } = fixture();
		const result = check(
			"`dashPhase` proves every view is single ink (`src/source.swift:3`).",
		);
		strictEqual(result.advisory, true);
		strictEqual(result.status, "matched");
		strictEqual(Object.hasOwn(result, "valid"), false);
	});

	it("marks external, absolute, traversal, shorthand, anchor and complex forms unverifiable", () => {
		const { check } = fixture();
		for (const citation of [
			"/etc/passwd:1",
			"../src/source.swift:2",
			"./src/source.swift:2",
			":2",
			"https://example.invalid/a.swift:2",
			"src/source.swift#L2",
			"src/source.swift:2:4",
			"src/some file.swift:2",
		]) {
			const result = check(`\`PPRenderingObservation\` at \`${citation}\``);
			strictEqual(result.status, "unverifiable", citation);
			strictEqual(result.mismatched, 0, citation);
		}
	});

	it("refuses symlink components, secret-bearing names and non-text source", () => {
		const { root, check } = fixture();
		symlinkSync("src", join(root, "alias"));
		symlinkSync("source.swift", join(root, "src/link.swift"));
		writeFileSync(join(root, ".env"), "do not read\n");
		writeFileSync(join(root, "src/binary.dat"), Buffer.from([0xff, 0]));
		for (const path of [
			"alias/source.swift",
			"src/link.swift",
			".env",
			".env-secret",
			"secrets.json",
			"auth.json",
			".aws/credentials",
		])
			reason(check(`\`token\` at \`${path}:1\``), "unsupported_path");
		reason(check("`token` at `src/binary.dat:1`"), "source_unreadable");
		reason(check("`token` at `src:1`"), "unsupported_file");
	});

	it("ignores fenced examples and labels reports without recognizable citations unverifiable", () => {
		const { check } = fixture();
		const result = check(
			"```md\n`invented` at `src/source.swift:1`\n```\nNo citations.",
		);
		strictEqual(result.citations, 0);
		strictEqual(result.status, "unverifiable");
		reason(result, "no_citations");
	});

	it("caps report bytes, source bytes, ranges, citation work and returned diagnostics", () => {
		const { root, check } = fixture();
		const report = check("x".repeat(256 * 1024 + 1));
		strictEqual(report.truncated, true);
		reason(report, "report_limit");
		writeFileSync(join(root, "src/large.swift"), "x".repeat(1024 * 1024 + 1));
		reason(check("`x` at `src/large.swift:1`"), "source_limit");
		reason(check("`dashPhase` at `src/source.swift:1-101`"), "range_limit");
		const citations = check(
			Array.from(
				{ length: 200 },
				() => "`dashPhase` at `src/source.swift:3`",
			).join("\n"),
		);
		strictEqual(citations.citations, 128);
		strictEqual(citations.matched, 128);
		strictEqual(citations.truncated, true);
		strictEqual(citations.status, "unverifiable");
		const issues = check(
			Array.from(
				{ length: 40 },
				() => "`invented` at `src/source.swift:1`",
			).join("\n"),
		);
		strictEqual(issues.mismatched, 40);
		strictEqual(issues.diagnostics.length, 20);
		strictEqual(issues.truncated, true);
	});

	it("caps aggregate source reads and never returns source or identifier text", () => {
		const { root, check } = fixture();
		for (let index = 0; index < 9; index += 1) {
			writeFileSync(
				join(root, `src/large${index}.swift`),
				`privateMarker${" ".repeat(1024 * 1024 - 13)}`,
			);
		}
		const result = check(
			Array.from(
				{ length: 9 },
				(_, index) => `\`privateMarker\` at \`src/large${index}.swift:1\``,
			).join("\n"),
		);
		strictEqual(result.matched, 8);
		strictEqual(result.unverifiable, 1);
		reason(result, "source_limit");
		strictEqual(JSON.stringify(result).includes("privateMarker"), false);
		strictEqual(JSON.stringify(result).includes("large8.swift"), false);
	});

	it("keeps invalid UTF-8 reports unverifiable without returning their text", () => {
		const { root } = fixture();
		const result = checkReportCitations(Buffer.from([0xff]), root);
		reason(result, "report_not_utf8");
		strictEqual(result.status, "unverifiable");
	});

	it("documents differential acceptance and the advisory output contract in simple help", () => {
		strictEqual(
			SIMPLE_USAGE.includes("node --test check already red at baseline"),
			true,
		);
		strictEqual(SIMPLE_USAGE.includes("toleratedBaselineFailures"), true);
		strictEqual(SIMPLE_USAGE.includes("report.citationCheck"), true);
		strictEqual(SIMPLE_USAGE.includes("never semantic truth"), true);
	});
});
