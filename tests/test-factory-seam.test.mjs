import { strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { testFactorySelector } from "../scripts/split-test.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const CHECKER = fileURLToPath(
	new URL("../scripts/check-seam-move.mjs", import.meta.url),
);
const SPLITTER = fileURLToPath(
	new URL("../scripts/split-module.mjs", import.meta.url),
);
const SUBPROCESS_TIMEOUT_MS = 30_000;

function write(root, path, text) {
	const output = join(root, path);
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, text);
}

function fixture(t, source) {
	const root = tempDir("factory-seam-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], {
		cwd: root,
		timeout: SUBPROCESS_TIMEOUT_MS,
	});
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
		timeout: SUBPROCESS_TIMEOUT_MS,
	});
	execFileSync("git", ["config", "user.name", "Test"], {
		cwd: root,
		timeout: SUBPROCESS_TIMEOUT_MS,
	});
	write(root, "tests/suite.test.mjs", source);
	execFileSync("git", ["add", "tests/suite.test.mjs"], {
		cwd: root,
		timeout: SUBPROCESS_TIMEOUT_MS,
	});
	execFileSync("git", ["commit", "-qm", "base"], {
		cwd: root,
		timeout: SUBPROCESS_TIMEOUT_MS,
	});
	return root;
}

function factory(source) {
	const program = parseSync("tests/suite.test.mjs", source, {
		sourceType: "module",
	}).program;
	const describeStatement = program.body.find(
		(statement) =>
			statement.type === "ExpressionStatement" &&
			statement.expression.callee?.name === "describe",
	);
	const loop = describeStatement.expression.arguments[1].body.body.find(
		(statement) => statement.type === "ForOfStatement",
	);
	return testFactorySelector(source, loop);
}

function run(root, args) {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, args, {
		cwd: root,
		encoding: "utf8",
		env,
		timeout: SUBPROCESS_TIMEOUT_MS,
	});
}

function check(root, parts) {
	return run(root, [
		CHECKER,
		"--mode",
		"test",
		"--base",
		"HEAD",
		"--source",
		"tests/suite.test.mjs",
		"--parts",
		parts.join(","),
	]);
}

function expectCheckerFailure(result, diagnostic) {
	strictEqual(result.status, 1, `${result.stdout}\n${result.stderr}`);
	strictEqual(
		`${result.stdout}\n${result.stderr}`.includes(diagnostic),
		true,
		`${result.stdout}\n${result.stderr}`,
	);
}

describe("test factory seam", () => {
	it("moves one selected literal-array factory unchanged and rejects loss or drift", (t) => {
		const source = [
			'import { beforeEach, describe, it } from "node:test";',
			'import { strictEqual } from "node:assert/strict";',
			"let observed = 0;",
			"beforeEach(() => { observed += 1; });",
			'describe("factory", () => {',
			"\tfor (const success of [true, false]) {",
			"\t\tit(`factory $" +
				'{success}`, () => strictEqual(observed > 0 && typeof success, "boolean"));',
			"\t}",
			'\tit("direct", () => strictEqual(1, 1));',
			"});",
			"",
		].join("\n");
		const root = fixture(t, source);
		const selector = factory(source);
		const spec = {
			tests: {
				"tests/suite.test.mjs": {
					perPartState: [],
					parts: [
						{
							path: "tests/parts/factory.mjs",
							items: [
								{
									title: "factory",
									tests: [],
									scoped: true,
									factories: [selector],
								},
							],
						},
					],
				},
			},
		};
		write(root, "manifest.json", JSON.stringify(spec));
		const split = run(root, [
			SPLITTER,
			"--mode",
			"test",
			"--source",
			"tests/suite.test.mjs",
			"--spec",
			"manifest.json",
		]);
		strictEqual(split.status, 0, split.stderr);
		const part = "tests/parts/factory.mjs";
		const output = readFileSync(join(root, part), "utf8");
		strictEqual(output.includes("for (const success of [true, false])"), true);
		strictEqual(
			readFileSync(join(root, "tests/suite.test.mjs"), "utf8").includes(
				"for (const success",
			),
			false,
		);
		strictEqual(
			readFileSync(join(root, "tests/suite.test.mjs"), "utf8").includes(
				'it("direct"',
			),
			true,
		);
		strictEqual(check(root, [part]).status, 0);
		const runtime = run(root, [
			"--test",
			"--test-reporter=tap",
			"tests/suite.test.mjs",
			part,
		]);
		strictEqual(runtime.status, 0, `${runtime.stdout}\n${runtime.stderr}`);
		const runtimeOutput = `${runtime.stdout}\n${runtime.stderr}`;
		strictEqual(runtimeOutput.includes("# pass 3"), true, runtimeOutput);

		write(
			root,
			part,
			output.replace("beforeEach(() => { observed += 1; });\n", ""),
		);
		expectCheckerFailure(
			check(root, [part]),
			"hook carried statement occurrence count differs in a part",
		);
		write(root, part, output.replace("let observed = 0;\n", ""));
		expectCheckerFailure(
			check(root, [part]),
			"state carried statement occurrence count differs in a part",
		);
		const loop = output.match(/for \(const success[\s\S]*?\n\t\}/u)[0];
		write(root, part, output.replace(loop, ""));
		expectCheckerFailure(
			check(root, [part]),
			"test factory statements do not match the base multiset",
		);
		write(root, part, `${output}\n${loop}\n`);
		expectCheckerFailure(
			check(root, [part]),
			"test factory statements do not match the base multiset",
		);
		write(root, part, output.replace("[true, false]", "[true, true]"));
		expectCheckerFailure(
			check(root, [part]),
			"test factory statements do not match the base multiset",
		);
	});

	it("rejects duplicate and stale factory selectors", (t) => {
		const source = [
			'import { describe, it } from "node:test";',
			'describe("factory", () => {',
			'\tfor (const name of ["one", "two"]) {',
			"\t\tit(name, () => {});",
			"\t}",
			"});",
			"",
		].join("\n");
		const root = fixture(t, source);
		const selector = factory(source);
		const item = { title: "factory", tests: [], factories: [selector] };
		write(
			root,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [
							{ path: "tests/parts/one.mjs", items: [item] },
							{ path: "tests/parts/two.mjs", items: [item] },
						],
					},
				},
			}),
		);
		strictEqual(
			run(root, [
				SPLITTER,
				"--mode",
				"test",
				"--source",
				"tests/suite.test.mjs",
				"--spec",
				"manifest.json",
			]).status,
			1,
		);
		item.factories[0].sha256 = "0".repeat(64);
		write(
			root,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [{ path: "tests/parts/stale.mjs", items: [item] }],
					},
				},
			}),
		);
		strictEqual(
			run(root, [
				SPLITTER,
				"--mode",
				"test",
				"--source",
				"tests/suite.test.mjs",
				"--spec",
				"manifest.json",
			]).status,
			1,
		);
		const unsupported = source.replace("it(name,", "it.skip(name,");
		const unsupportedRoot = fixture(t, unsupported);
		write(
			unsupportedRoot,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [
							{
								path: "tests/parts/unsupported.mjs",
								items: [
									{
										title: "factory",
										tests: [],
										factories: [factory(unsupported)],
									},
								],
							},
						],
					},
				},
			}),
		);
		strictEqual(
			run(unsupportedRoot, [
				SPLITTER,
				"--mode",
				"test",
				"--source",
				"tests/suite.test.mjs",
				"--spec",
				"manifest.json",
			]).status,
			1,
		);
	});

	it("keeps unselected direct tests when a factory selector omits tests", (t) => {
		const source = [
			'import { describe, it } from "node:test";',
			'describe("factory", () => {',
			'\tfor (const name of ["one", "two"]) {',
			"\t\tit(name, () => {});",
			"\t}",
			'\tit("remaining", () => {});',
			"});",
			"",
		].join("\n");
		const root = fixture(t, source);
		write(
			root,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [
							{
								path: "tests/parts/factory-only.mjs",
								items: [{ title: "factory", factories: [factory(source)] }],
							},
						],
					},
				},
			}),
		);
		const split = run(root, [
			SPLITTER,
			"--mode",
			"test",
			"--source",
			"tests/suite.test.mjs",
			"--spec",
			"manifest.json",
		]);
		strictEqual(split.status, 0, split.stderr);
		const part = "tests/parts/factory-only.mjs";
		strictEqual(check(root, [part]).status, 0);
		strictEqual(
			readFileSync(join(root, "tests/suite.test.mjs"), "utf8").includes(
				'it("remaining"',
			),
			true,
		);
	});

	it("rejects partial unsupported registration loops and retains whole describes", (t) => {
		const source = [
			'import { beforeEach, describe, it } from "node:test";',
			"let observed = 0;",
			"const initialized = initialize();",
			"function initialize() { observed += 1; return true; }",
			"beforeEach(() => { observed += 1; });",
			'describe("factory", () => {',
			'\tconst cases = ["dynamic"];',
			'\tfor (const [label, expected] of [["tuple", 1]]) {',
			"\t\tit(label, () => strictEqual(expected, 1));",
			"\t}",
			"\tfor (const value of cases) {",
			'\t\tit(value, () => strictEqual(value, "dynamic"));',
			"\t}",
			'\t["inline"].forEach((value) => it(value, () => {}));',
			'\tit("direct", () => {});',
			"});",
			"",
		].join("\n");
		const partialRoot = fixture(t, source);
		write(
			partialRoot,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [
							{
								path: "tests/parts/direct.mjs",
								items: [{ title: "factory", tests: ["direct"] }],
							},
						],
					},
				},
			}),
		);
		strictEqual(
			run(partialRoot, [
				SPLITTER,
				"--mode",
				"test",
				"--source",
				"tests/suite.test.mjs",
				"--spec",
				"manifest.json",
			]).status,
			1,
		);
		const wholeRoot = fixture(t, source);
		write(
			wholeRoot,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [{ path: "tests/parts/whole.mjs", items: ["factory"] }],
					},
				},
			}),
		);
		const whole = run(wholeRoot, [
			SPLITTER,
			"--mode",
			"test",
			"--source",
			"tests/suite.test.mjs",
			"--spec",
			"manifest.json",
		]);
		strictEqual(whole.status, 0, whole.stderr);
		const output = readFileSync(
			join(wholeRoot, "tests/parts/whole.mjs"),
			"utf8",
		);
		strictEqual(output.includes("for (const [label, expected]"), true);
		strictEqual(output.includes("for (const value of cases)"), true);
		strictEqual(check(wholeRoot, ["tests/parts/whole.mjs"]).status, 0);
		const firstOpaque = output.match(/\tfor \(const \[label[\s\S]*?\n\t\}/u)[0];
		const secondOpaque = output.match(/\tfor \(const value[\s\S]*?\n\t\}/u)[0];
		const inlineOpaque = output.match(
			/\t\["inline"\]\.forEach\(\(value\) => it\(value, \(\) => \{\}\)\);/u,
		)[0];
		write(wholeRoot, "tests/parts/whole.mjs", output.replace(firstOpaque, ""));
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/whole.mjs"]),
			"opaque registration statements do not match the base multiset",
		);
		write(wholeRoot, "tests/parts/whole.mjs", `${output}\n${firstOpaque}\n`);
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/whole.mjs"]),
			"opaque registration statements do not match the base multiset",
		);
		write(wholeRoot, "tests/parts/whole.mjs", output.replace(inlineOpaque, ""));
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/whole.mjs"]),
			"opaque registration statements do not match the base multiset",
		);
		write(wholeRoot, "tests/parts/whole.mjs", `${output}\n${inlineOpaque}\n`);
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/whole.mjs"]),
			"opaque registration statements do not match the base multiset",
		);
		write(
			wholeRoot,
			"tests/parts/whole.mjs",
			output.replace(
				'it(value, () => strictEqual(value, "dynamic"))',
				'it("edited", () => {})',
			),
		);
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/whole.mjs"]),
			"opaque registration statements do not match the base multiset",
		);
		write(
			wholeRoot,
			"tests/parts/whole.mjs",
			output
				.replace(firstOpaque, "__first_opaque__")
				.replace(secondOpaque, firstOpaque)
				.replace("__first_opaque__", secondOpaque),
		);
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/whole.mjs"]),
			"carried statements are out of source order",
		);
		const carriedState = [
			'import { beforeEach, describe, it } from "node:test";',
			"let observed = 0;",
			"const initialized = initialize();",
			"function initialize() { observed += 1; return true; }",
			"beforeEach(() => { observed += 1; });",
		].join("\n");
		const opaqueOnly = [
			carriedState,
			'describe("factory", () => {',
			'\tconst cases = ["dynamic"];',
			'\tfor (const [label, expected] of [["tuple", 1]]) {',
			"\t\tit(label, () => strictEqual(expected, 1));",
			"\t}",
			"\tfor (const value of cases) {",
			'\t\tit(value, () => strictEqual(value, "dynamic"));',
			"\t}",
			'\t["inline"].forEach((value) => it(value, () => {}));',
			"});",
			"",
		].join("\n");
		const directOnly = [
			carriedState,
			'describe("factory", () => {',
			'\tconst cases = ["dynamic"];',
			'\tit("direct", () => {});',
			"});",
			"",
		].join("\n");
		write(wholeRoot, "tests/parts/opaque.mjs", opaqueOnly);
		write(wholeRoot, "tests/parts/direct.mjs", directOnly);
		strictEqual(
			check(wholeRoot, ["tests/parts/opaque.mjs", "tests/parts/direct.mjs"])
				.status,
			0,
		);
		write(
			wholeRoot,
			"tests/parts/opaque.mjs",
			opaqueOnly.replace("beforeEach(() => { observed += 1; });\n", ""),
		);
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/opaque.mjs", "tests/parts/direct.mjs"]),
			"hook carried statement occurrence count differs in a part",
		);
		write(
			wholeRoot,
			"tests/parts/opaque.mjs",
			opaqueOnly.replace("let observed = 0;\n", ""),
		);
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/opaque.mjs", "tests/parts/direct.mjs"]),
			"state carried statement occurrence count differs in a part",
		);
		write(
			wholeRoot,
			"tests/parts/opaque.mjs",
			opaqueOnly.replace("const initialized = initialize();\n", ""),
		);
		expectCheckerFailure(
			check(wholeRoot, ["tests/parts/opaque.mjs", "tests/parts/direct.mjs"]),
			"state carried statement occurrence count differs in a part",
		);
		const memberSource = [
			'import { describe, it } from "node:test";',
			'describe("member-loop", () => {',
			"\tfor (let index = 0; index < 1; index += 1) {",
			'\t\tif (index === 0) it.skip("conditional", () => {});',
			"\t}",
			'\tit("direct", () => {});',
			"});",
			"",
		].join("\n");
		const memberPartialRoot = fixture(t, memberSource);
		write(
			memberPartialRoot,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [
							{
								path: "tests/parts/direct.mjs",
								items: [{ title: "member-loop", tests: ["direct"] }],
							},
						],
					},
				},
			}),
		);
		strictEqual(
			run(memberPartialRoot, [
				SPLITTER,
				"--mode",
				"test",
				"--source",
				"tests/suite.test.mjs",
				"--spec",
				"manifest.json",
			]).status,
			1,
		);
		const memberWholeRoot = fixture(t, memberSource);
		write(
			memberWholeRoot,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [{ path: "tests/parts/whole.mjs", items: ["member-loop"] }],
					},
				},
			}),
		);
		const memberWhole = run(memberWholeRoot, [
			SPLITTER,
			"--mode",
			"test",
			"--source",
			"tests/suite.test.mjs",
			"--spec",
			"manifest.json",
		]);
		strictEqual(memberWhole.status, 0, memberWhole.stderr);
		strictEqual(
			readFileSync(
				join(memberWholeRoot, "tests/parts/whole.mjs"),
				"utf8",
			).includes("it.skip"),
			true,
		);
		const topLevelSource = [
			'import { describe, it } from "node:test";',
			'for (const generated of ["outside"]) it(generated, () => {});',
			'describe("regular", () => {',
			'\tit("direct", () => {});',
			"});",
			"",
		].join("\n");
		const topLevelRoot = fixture(t, topLevelSource);
		write(
			topLevelRoot,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [
							{
								path: "tests/parts/direct.mjs",
								items: [{ title: "regular", tests: ["direct"] }],
							},
						],
					},
				},
			}),
		);
		const topLevel = run(topLevelRoot, [
			SPLITTER,
			"--mode",
			"test",
			"--source",
			"tests/suite.test.mjs",
			"--spec",
			"manifest.json",
		]);
		strictEqual(topLevel.status, 1, `${topLevel.stdout}\n${topLevel.stderr}`);
		strictEqual(
			`${topLevel.stdout}\n${topLevel.stderr}`.includes(
				"top-level unsupported registration shape cannot be split",
			),
			true,
		);
		strictEqual(
			existsSync(join(topLevelRoot, "tests/parts/direct.mjs")),
			false,
		);
	});

	it("keeps an eight-leaf static-object factory atomic at runtime", (t) => {
		const source = [
			'import { describe, it } from "node:test";',
			'import { strictEqual } from "node:assert/strict";',
			'describe("locks", () => {',
			"\tfor (const fixture of [",
			'\t\t{ name: "lock-live", holderLiveness: "live" },',
			'\t\t{ name: "lock-startup-grace", holderLiveness: "startup_grace" },',
			'\t\t{ name: "lock-cleanup-failed", holderLiveness: "cleanup_failed" },',
			'\t\t{ name: "lock-malformed", holderLiveness: "malformed" },',
			'\t\t{ name: "lock-terminal", holderLiveness: "terminal" },',
			'\t\t{ name: "lock-stale", holderLiveness: "stale" },',
			'\t\t{ name: "lock-missing", holderLiveness: "missing" },',
			'\t\t{ name: "lock-owned", holderLiveness: "owned" },',
			"\t]) {",
			'\t\tit(fixture.name, () => strictEqual(typeof fixture.holderLiveness, "string"));',
			"\t}",
			"});",
			"",
		].join("\n");
		const root = fixture(t, source);
		write(
			root,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [
							{
								path: "tests/parts/locks.mjs",
								items: [
									{ title: "locks", tests: [], factories: [factory(source)] },
								],
							},
						],
					},
				},
			}),
		);
		const split = run(root, [
			SPLITTER,
			"--mode",
			"test",
			"--source",
			"tests/suite.test.mjs",
			"--spec",
			"manifest.json",
		]);
		strictEqual(split.status, 0, split.stderr);
		const part = "tests/parts/locks.mjs";
		strictEqual(check(root, [part]).status, 0);
		const runtime = run(root, ["--test", "--test-reporter=tap", part]);
		strictEqual(runtime.status, 0, `${runtime.stdout}\n${runtime.stderr}`);
		const runtimeOutput = `${runtime.stdout}\n${runtime.stderr}`;
		strictEqual(runtimeOutput.includes("# pass 8"), true, runtimeOutput);
	});
});
