import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { tempDir } from "./helpers/tempdir.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const SPLITTER = fileURLToPath(
	new URL("../scripts/split-module.mjs", import.meta.url),
);
const CHECKER = fileURLToPath(
	new URL("../scripts/check-seam-move.mjs", import.meta.url),
);

function write(root, path, contents) {
	const output = join(root, path);
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, contents);
}

function fixture(t, source) {
	const root = tempDir("split-module-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	write(root, "lib/facade.mjs", source);
	execFileSync("git", ["add", "lib/facade.mjs"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	return root;
}

function split(root, spec) {
	write(
		root,
		"manifest.json",
		JSON.stringify({ sources: { "lib/facade.mjs": spec } }),
	);
	const result = spawnSync(
		process.execPath,
		[SPLITTER, "--source", "lib/facade.mjs", "--spec", "manifest.json"],
		{ cwd: root, encoding: "utf8" },
	);
	strictEqual(result.status, 0, result.stderr);
}

function runtimeTrace(root) {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			'globalThis.trace = []; await import("./lib/facade.mjs"); process.stdout.write(JSON.stringify(globalThis.trace));',
		],
		{ cwd: root, encoding: "utf8" },
	);
	strictEqual(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

function check(root) {
	return spawnSync(
		process.execPath,
		[
			CHECKER,
			"--mode",
			"module",
			"--base",
			"HEAD",
			"--source",
			"lib/facade.mjs",
			"--expect",
			"manifest.json",
		],
		{ cwd: root, encoding: "utf8" },
	);
}

function splitTest(root, spec) {
	write(
		root,
		"manifest.json",
		JSON.stringify({ tests: { "tests/suite.test.mjs": spec } }),
	);
	const result = spawnSync(
		process.execPath,
		[
			SPLITTER,
			"--mode",
			"test",
			"--source",
			"tests/suite.test.mjs",
			"--spec",
			"manifest.json",
		],
		{ cwd: root, encoding: "utf8" },
	);
	strictEqual(result.status, 0, result.stderr);
}

function checkTest(root, parts, fixturePath) {
	const args = [
		CHECKER,
		"--mode",
		"test",
		"--base",
		"HEAD",
		"--source",
		"tests/suite.test.mjs",
		"--parts",
		parts.join(","),
	];
	if (fixturePath) args.push("--fixture", fixturePath);
	return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
}

function testFixture(t, source) {
	const root = tempDir("split-module-test-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	write(root, "tests/suite.test.mjs", source);
	execFileSync("git", ["add", "tests/suite.test.mjs"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	return root;
}

describe("split-module", () => {
	it("moves complete declarations, copies imports, and preserves the façade seam", (t) => {
		const root = fixture(
			t,
			[
				'import { external } from "pkg";',
				"export const kept = 1;",
				"const helper = external();",
				"export const value = helper;",
				"console.log(kept);",
				"",
			].join("\n"),
		);
		split(root, {
			targets: { "lib/part.mjs": { names: ["helper", "value"] } },
			facade: { keeps: ["kept"] },
		});
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("keeps an unlisted declaration in the façade", (t) => {
		const root = fixture(
			t,
			"export const left = 1;\nexport const right = 2;\n",
		);
		split(root, {
			targets: { "lib/part.mjs": { names: ["left"] } },
			facade: { keeps: [] },
		});
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("preserves external import evaluation order across a module split", (t) => {
		const root = fixture(
			t,
			[
				'import "./first.mjs";',
				'import "./second.mjs";',
				'export const moved = (globalThis.trace.push("moved"), true);',
				'export const kept = (globalThis.trace.push("kept"), true);',
				"",
			].join("\n"),
		);
		write(root, "lib/first.mjs", 'globalThis.trace.push("first");\n');
		write(root, "lib/second.mjs", 'globalThis.trace.push("second");\n');
		execFileSync("git", ["add", "lib/first.mjs", "lib/second.mjs"], {
			cwd: root,
		});
		execFileSync("git", ["commit", "-qm", "side-effect imports"], {
			cwd: root,
		});
		const before = runtimeTrace(root);

		split(root, {
			targets: { "lib/part.mjs": { names: ["moved"] } },
			facade: { keeps: [] },
		});

		deepStrictEqual(runtimeTrace(root), before);
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("moves a direct writer with its let declaration", (t) => {
		const root = fixture(t, "export let count = 0;\ncount += 1;\n");
		split(root, {
			targets: { "lib/part.mjs": { names: ["count"] } },
			facade: { keeps: [] },
		});
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("keeps a function-local name separate from a façade declaration", (t) => {
		const root = fixture(
			t,
			"export function run() { return 1; }\nexport function helper() { const run = 2; return run; }\n",
		);
		split(root, {
			targets: { "lib/part.mjs": { names: ["helper"] } },
			facade: { keeps: ["run"] },
		});
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("rejects a declaration assigned to multiple targets", (t) => {
		const root = fixture(t, "export const left = 1, right = 2;\n");
		write(
			root,
			"manifest.json",
			JSON.stringify({
				targets: {
					"lib/left.mjs": { names: ["left"] },
					"lib/right.mjs": { names: ["right"] },
				},
				facade: { keeps: [] },
			}),
		);
		const result = spawnSync(
			process.execPath,
			[SPLITTER, "--source", "lib/facade.mjs", "--spec", "manifest.json"],
			{ cwd: root, encoding: "utf8" },
		);
		strictEqual(result.status, 1);
	});

	it("splits test describes, state, scoped subsets, and fixtures", (t) => {
		const root = testFixture(
			t,
			[
				'import { strictEqual } from "node:assert/strict";',
				'import { beforeEach, describe, it } from "node:test";',
				"",
				"const fixtureValue = 2;",
				"let count = 0;",
				"function stateHelper() { return count; }",
				"beforeEach(() => { count = fixtureValue; });",
				"",
				'describe("small", () => {',
				'\tit("one", () => strictEqual(stateHelper(), 2));',
				"});",
				"",
				'describe("giant", () => {',
				"\tconst scoped = stateHelper();",
				'\tit("first", () => strictEqual(scoped, 2));',
				'\tit("second", () => strictEqual(scoped, 2));',
				"});",
				"",
			].join("\n"),
		);
		const spec = {
			fixture: {
				path: "tests/helpers/suite-fixtures.mjs",
				names: ["fixtureValue"],
			},
			perPartState: { names: ["count"] },
			parts: [
				{ path: "tests/parts/small.mjs", items: ["small"] },
				{
					path: "tests/parts/giant-first.mjs",
					items: [{ title: "giant", tests: ["first"], scoped: true }],
				},
				{
					path: "tests/parts/giant-second.mjs",
					items: [{ title: "giant", tests: ["second"], scoped: true }],
				},
			],
		};
		splitTest(root, spec);
		const parts = spec.parts.map((part) => part.path);
		const result = checkTest(root, parts, spec.fixture.path);
		strictEqual(result.status, 0, result.stderr);

		const firstPart = join(root, spec.parts[1].path);
		const original = readFileSync(firstPart, "utf8");
		strictEqual(
			original.includes('const scoped = stateHelper();\nit("first"'),
			true,
		);
		write(
			root,
			spec.parts[1].path,
			original.replace(
				'const scoped = stateHelper();\nit("first", () => strictEqual(scoped, 2));',
				'it("first", () => strictEqual(scoped, 2));\nconst scoped = stateHelper();',
			),
		);
		strictEqual(checkTest(root, parts, spec.fixture.path).status, 1);
	});
	it("retains unselected tests during a partial manifest split", (t) => {
		const root = testFixture(
			t,
			'import { describe, it } from "node:test";\ndescribe("moved", () => { it("first", () => {}); });\ndescribe("later", () => { it("second", () => {}); });\n',
		);
		const spec = {
			perPartState: [],
			parts: [
				{ path: "tests/parts/moved.mjs", items: [{ describe: "moved" }] },
			],
		};
		splitTest(root, spec);
		const source = readFileSync(join(root, "tests/suite.test.mjs"), "utf8");
		strictEqual(source.includes('describe("later"'), true);
		strictEqual(source.includes('describe("moved"'), false);
		const result = checkTest(root, [spec.parts[0].path]);
		strictEqual(result.status, 0, result.stderr);
	});
});

// These two files have the same blobs at d384edc and the Task 0.6 base.
const GOLDEN_REF = "d384edc";
const LEDGER_SOURCE = "src/switchyard/ledger/index.mjs";
const ERROR_TEST_SOURCE = "tests/adapter-exec-error.test.mjs";
const LEDGER_SPEC = {
	facade: {
		est: 223,
		keeps: [
			"resolveLedgerDir",
			"resolveLedgerPath",
			"recordDispatchToStore",
			"recordExternalCompletionToStore",
			"recordDispatchIntentToStore",
			"readLedgerFromStore",
		],
	},
	targets: {
		"src/switchyard/ledger/sanitize.mjs": {
			names: [
				"DEFAULT_LEDGER_PATH",
				"resolveLegacyLedgerPath",
				"ensureLogDir",
				"sanitizeDispatchEntry",
				"INTENT_STRING_FIELDS",
				"INTENT_NUMBER_FIELDS",
				"SAFE_DESCRIPTOR_IDENTITY",
				"SAFE_CAPABILITIES",
				"SAFE_PROVIDERS",
				"SAFE_HARNESSES",
				"INTENT_FINGERPRINT_FIELDS",
				"fingerprintIntentValue",
				"sanitizeIntentString",
				"sanitizeIntentEntry",
				"recordDispatch",
				"readLedger",
				"DEFAULT_LEDGER_MAX_BYTES",
				"DEFAULT_LEDGER_SEGMENTS",
				"ledgerRotationFailures",
				"ledgerRotationWarned",
				"getLedgerRotationFailures",
				"resetLedgerRotationFailures",
				"ledgerMaxBytes",
				"ledgerSegments",
				"segmentPath",
				"retainedSegmentPaths",
				"noteRotationFailure",
				"rotateLedgerIfNeeded",
			],
		},
	},
};
const ERROR_TEST_SPEC = {
	fixture: null,
	perPartState: [],
	parts: [
		{
			path: "tests/adapter-exec-error-closed-pre-provider-failure.test.mjs",
			items: [
				{
					describe: "closed pre-provider failure triples",
				},
				{
					describe: "describeExecError — auth-expiry classification",
				},
				{
					describe: "describeExecError — provider-scoped quota classification",
				},
				{
					describe:
						"describeExecError — provider-scoped unresolvable-model classification",
				},
			],
		},
		{
			path: "tests/adapter-exec-error-describeexecerror-general-diagnosability.test.mjs",
			items: [
				{
					describe: "describeExecError — general diagnosability",
				},
				{
					describe: "describeExecError — streams carried as Buffers",
				},
				{
					describe: "reauthHintFor",
				},
			],
		},
		{
			path: "tests/adapter-exec-error-sanitizefailuremetadata-persistence-boundary.test.mjs",
			items: [
				{
					describe: "sanitizeFailureMetadata — persistence boundary",
				},
			],
		},
	],
};

function goldenFixture(t, source) {
	const root = tempDir("split-golden-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	write(
		root,
		source,
		execFileSync("git", ["show", `${GOLDEN_REF}:${source}`], {
			cwd: REPO,
			encoding: "utf8",
		}),
	);
	execFileSync("git", ["add", source], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: root },
	);
	return root;
}
function goldenCheck(root, mode, source, spec, paths) {
	write(
		root,
		"manifest.json",
		JSON.stringify(
			mode === "module"
				? { sources: { [source]: spec } }
				: { tests: { [source]: spec } },
		),
	);
	const split = spawnSync(
		process.execPath,
		[SPLITTER, "--mode", mode, "--source", source, "--spec", "manifest.json"],
		{ cwd: root, encoding: "utf8" },
	);
	strictEqual(split.status, 0, split.stderr);
	const args = [CHECKER, "--mode", mode, "--base", "HEAD", "--source", source];
	if (mode === "module") args.push("--expect", "manifest.json");
	else args.push("--parts", paths.join(","));
	return {
		args,
		check: () =>
			spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" }),
	};
}
function swapCarried(root, path) {
	const text = readFileSync(join(root, path), "utf8");
	const statements = parseSync(path, text, {
		sourceType: "module",
	}).program.body.filter(
		(statement) =>
			statement.type !== "ImportDeclaration" &&
			statement.type !== "ExportAllDeclaration" &&
			!(statement.type === "ExportNamedDeclaration" && !statement.declaration),
	);
	const [first, second] = statements;
	strictEqual(Boolean(first && second), true);
	write(
		root,
		path,
		text.slice(0, first.start) +
			text.slice(second.start, second.end) +
			text.slice(first.end, second.start) +
			text.slice(first.start, first.end) +
			text.slice(second.end),
	);
}

describe("real-file golden splits", () => {
	it("checks a module split and rejects swapped carried statements", (t) => {
		const root = goldenFixture(t, LEDGER_SOURCE);
		const target = Object.keys(LEDGER_SPEC.targets)[0];
		const golden = goldenCheck(root, "module", LEDGER_SOURCE, LEDGER_SPEC, [
			target,
		]);
		const valid = golden.check();
		strictEqual(valid.status, 0, valid.stderr);
		swapCarried(root, target);
		strictEqual(golden.check().status, 1);
	});
	it("checks a test split and rejects swapped carried statements", (t) => {
		const root = goldenFixture(t, ERROR_TEST_SOURCE);
		const parts = ERROR_TEST_SPEC.parts.map((part) => part.path);
		const golden = goldenCheck(
			root,
			"test",
			ERROR_TEST_SOURCE,
			ERROR_TEST_SPEC,
			parts,
		);
		const valid = golden.check();
		strictEqual(valid.status, 0, valid.stderr);
		swapCarried(root, parts[0]);
		strictEqual(golden.check().status, 1);
	});
});
