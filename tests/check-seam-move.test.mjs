import { strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
	new URL("../scripts/check-seam-move.mjs", import.meta.url),
);
const SOURCE = "lib/facade.mjs";
const TEST_PART = "tests/parts/suite-part.mjs";
const TEST_SOURCE = "tests/suite.test.mjs";

function fixture(t, base, targets = ["lib/part.mjs"]) {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "seam-move-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	write(root, SOURCE, base);
	execFileSync("git", ["add", "."], { cwd: root });
	commit(root, "base");
	write(
		root,
		"manifest.json",
		JSON.stringify({
			sources: {
				[SOURCE]: {
					targets: Object.fromEntries(targets.map((target) => [target, {}])),
				},
			},
		}),
	);
	return root;
}

function commit(root, message) {
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Checker",
			"-c",
			"user.email=checker@example.test",
			"commit",
			"-qm",
			message,
		],
		{ cwd: root },
	);
}

function write(root, path, contents) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), contents);
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
			SOURCE,
			"--expect",
			"manifest.json",
		],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
}

function split(root, facade, targets) {
	write(root, SOURCE, facade);
	for (const [path, contents] of Object.entries(targets))
		write(root, path, contents);
}

function testFixture(t, base) {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "seam-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	write(root, TEST_SOURCE, base);
	execFileSync("git", ["add", "."], { cwd: root });
	commit(root, "base tests");
	return root;
}

function checkTest(
	root,
	{ fixture: fixturePath = null, parts = [TEST_PART] } = {},
) {
	const args = [
		CHECKER,
		"--mode",
		"test",
		"--base",
		"HEAD",
		"--source",
		TEST_SOURCE,
		"--parts",
		parts.join(","),
	];
	if (fixturePath) args.push("--fixture", fixturePath);
	return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
}

function splitTest(root, facade, part) {
	write(root, TEST_SOURCE, facade);
	write(root, TEST_PART, part);
}

const BASE = `export const alpha = 1;
export const beta = 2;
console.log(alpha);
`;
const VALID_FACADE = `import { beta } from "./part.mjs";
export { beta };
export const alpha = 1;
console.log(alpha);
`;
const VALID_TARGET = "export const beta = 2;\n";

function validFixture(t) {
	const root = fixture(t, BASE);
	split(root, VALID_FACADE, { "lib/part.mjs": VALID_TARGET });
	return root;
}

describe("check-seam-move module mode", () => {
	it("accepts a correct split", (t) => {
		const result = check(validFixture(t));
		strictEqual(result.status, 0, result.stderr);
	});
	it("accepts a copied parent import from the base source", (t) => {
		const root = fixture(
			t,
			'import { parent } from "../parent.mjs";\nexport const alpha = 1;\nexport const beta = parent;\n',
		);
		split(
			root,
			'import "./part.mjs";\nexport { beta } from "./part.mjs";\nimport { parent } from "../parent.mjs";\nexport const alpha = 1;\n',
			{
				"lib/part.mjs":
					'import { parent } from "../parent.mjs";\nexport const beta = parent;\n',
			},
		);
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	it("accepts a pre-existing export star", (t) => {
		const root = fixture(
			t,
			'export * from "./peer.mjs";\nexport const alpha = 1;\nexport const beta = 2;\n',
		);
		split(
			root,
			'import "./part.mjs";\nexport { beta } from "./part.mjs";\nexport * from "./peer.mjs";\nexport const alpha = 1;\n',
			{ "lib/part.mjs": "export const beta = 2;\n" },
		);
		const result = check(root);
		strictEqual(result.status, 0, result.stderr);
	});

	for (const [name, mutate] of [
		[
			"dropped statement",
			(root) =>
				split(
					root,
					`import { beta } from "./part.mjs";\nexport { beta };\nexport const alpha = 1;\n`,
					{ "lib/part.mjs": "" },
				),
		],
		[
			"duplicated statement",
			(root) =>
				split(root, `${VALID_FACADE}export const beta = 2;\n`, {
					"lib/part.mjs": VALID_TARGET,
				}),
		],
		[
			"edited body",
			(root) =>
				split(root, VALID_FACADE, {
					"lib/part.mjs": "export const beta = 3;\n",
				}),
		],
		[
			"renamed export",
			(root) =>
				split(
					root,
					`import { renamed } from "./part.mjs";\nexport { renamed as beta };\nexport const alpha = 1;\nconsole.log(alpha);\n`,
					{ "lib/part.mjs": "export const renamed = 2;\n" },
				),
		],
		[
			"lost façade export",
			(root) =>
				split(
					root,
					`import { beta } from "./part.mjs";\nexport const alpha = 1;\nconsole.log(alpha);\n`,
					{ "lib/part.mjs": VALID_TARGET },
				),
		],
		[
			"export star",
			(root) =>
				split(
					root,
					`import { beta } from "./part.mjs";\nexport * from "./part.mjs";\nexport const alpha = 1;\nconsole.log(alpha);\n`,
					{ "lib/part.mjs": VALID_TARGET },
				),
		],
		[
			"import cycle",
			(root) =>
				split(root, `${VALID_FACADE}`, {
					"lib/part.mjs":
						'import { alpha } from "./facade.mjs";\nexport const beta = 2;\n',
				}),
		],
		[
			"out-of-directory target import",
			(root) =>
				split(root, VALID_FACADE, {
					"lib/part.mjs": 'import "../outside.mjs";\nexport const beta = 2;\n',
				}),
		],
		[
			"altered pin line",
			(root) => {
				const base = `const pin = import.meta.url;\nexport const beta = 2;\n`;
				write(root, SOURCE, base);
				execFileSync("git", ["add", SOURCE], { cwd: root });
				commit(root, "pinned");
				split(
					root,
					`import { beta } from "./part.mjs";\nexport { beta };\nconst pin = import.meta.url + "";\n`,
					{ "lib/part.mjs": VALID_TARGET },
				);
			},
		],
		[
			"unreachable target",
			(root) => {
				write(
					root,
					"manifest.json",
					JSON.stringify({
						sources: {
							[SOURCE]: {
								targets: { "lib/part.mjs": {}, "lib/unreachable.mjs": {} },
							},
						},
					}),
				);
				split(root, `export const alpha = 1;\nconsole.log(alpha);\n`, {
					"lib/part.mjs": VALID_TARGET,
					"lib/unreachable.mjs": "",
				});
			},
		],
		[
			"kept environment assignment before moved impure declaration",
			(root) => {
				const base = `process.env.FLAG = "on";\nexport const value = resolveValue();\n`;
				write(root, SOURCE, base);
				execFileSync("git", ["add", SOURCE], { cwd: root });
				commit(root, "effects");
				split(
					root,
					`import { value } from "./part.mjs";\nexport { value };\nprocess.env.FLAG = "on";\n`,
					{ "lib/part.mjs": "export const value = resolveValue();\n" },
				);
			},
		],
		[
			"swapped statements inside a target",
			(root) =>
				split(
					root,
					`import { alpha, beta } from "./part.mjs";\nexport { alpha, beta };\nconsole.log(alpha);\n`,
					{
						"lib/part.mjs": "export const beta = 2;\nexport const alpha = 1;\n",
					},
				),
		],
		[
			"effectful targets imported in reverse source order",
			(root) => {
				const base = `export const first = sideEffect("first");\nexport const second = sideEffect("second");\n`;
				write(root, SOURCE, base);
				execFileSync("git", ["add", SOURCE], { cwd: root });
				commit(root, "order");
				write(
					root,
					"manifest.json",
					JSON.stringify({
						sources: {
							[SOURCE]: {
								targets: { "lib/first.mjs": {}, "lib/second.mjs": {} },
							},
						},
					}),
				);
				split(
					root,
					`import { second } from "./second.mjs";\nimport { first } from "./first.mjs";\nexport { first, second };\n`,
					{
						"lib/first.mjs": 'export const first = sideEffect("first");\n',
						"lib/second.mjs": 'export const second = sideEffect("second");\n',
					},
				);
			},
		],
	]) {
		it(`rejects a ${name}`, (t) => {
			const root = validFixture(t);
			mutate(root);
			strictEqual(check(root).status, 1);
		});
	}
});

const BASE_TEST = [
	'import { strictEqual } from "node:assert/strict";',
	'import { describe, it, test } from "node:test";',
	"",
	"const helper = 1;",
	'describe("group", () => {',
	'\tit("first", () => strictEqual(helper, 1));',
	'\ttest("second", () => strictEqual(helper, 1));',
	"});",
	"",
].join("\n");
const TEST_FACADE = 'import "./parts/suite-part.mjs";\n';
const TEST_PART_CONTENTS = [
	"const helper = 1;",
	'describe("group", () => {',
	'\tit("first", () => strictEqual(helper, 1));',
	'\ttest("second", () => strictEqual(helper, 1));',
	"});",
	"",
].join("\n");

describe("check-seam-move test mode", () => {
	it("accepts a correct split", (t) => {
		const root = testFixture(t, BASE_TEST);
		splitTest(root, TEST_FACADE, TEST_PART_CONTENTS);
		const result = checkTest(root);
		strictEqual(result.status, 0, result.stderr);
	});

	for (const [name, contents] of [
		[
			"lost test",
			[
				"const helper = 1;",
				'describe("group", () => {',
				'\tit("first", () => strictEqual(helper, 1));',
				"});",
				"",
			].join("\n"),
		],
		[
			"duplicated test",
			`${TEST_PART_CONTENTS}it("first", () => strictEqual(helper, 1));\n`,
		],
		[
			"edited assertion",
			TEST_PART_CONTENTS.replace(
				"strictEqual(helper, 1));",
				"strictEqual(helper, 2));",
			),
		],
		["changed describe title", TEST_PART_CONTENTS.replace("group", "other")],
		[
			"altered repeated helper",
			TEST_PART_CONTENTS.replace("helper = 1", "helper = 2"),
		],
		[
			"swapped tests inside one part",
			[
				"const helper = 1;",
				'describe("group", () => {',
				'\ttest("second", () => strictEqual(helper, 1));',
				'\tit("first", () => strictEqual(helper, 1));',
				"});",
				"",
			].join("\n"),
		],
	]) {
		it(`rejects a ${name}`, (t) => {
			const root = testFixture(t, BASE_TEST);
			splitTest(root, TEST_FACADE, contents);
			strictEqual(checkTest(root).status, 1);
		});
	}

	it("rejects a moved fixture import.meta statement", (t) => {
		const root = testFixture(
			t,
			`${BASE_TEST}const location = import.meta.url;\n`,
		);
		splitTest(root, TEST_FACADE, TEST_PART_CONTENTS);
		write(
			root,
			"tests/helpers/sample-fixtures.mjs",
			"export const location = import.meta.url;\n",
		);
		strictEqual(
			checkTest(root, { fixture: "tests/helpers/sample-fixtures.mjs" }).status,
			1,
		);
	});

	it("accepts the resolve-based fixture __dirname rebase", (t) => {
		const root = testFixture(
			t,
			'const __dirname = resolve(fileURLToPath(import.meta.url), "..");\ntest("kept", () => __dirname);\n',
		);
		splitTest(root, TEST_FACADE, 'test("kept", () => __dirname);\n');
		write(
			root,
			"tests/helpers/sample-fixtures.mjs",
			'const __dirname = resolve(fileURLToPath(import.meta.url), "..", "..");\nexport { __dirname };\n',
		);
		const result = checkTest(root, {
			fixture: "tests/helpers/sample-fixtures.mjs",
		});
		strictEqual(result.status, 0, result.stderr);
	});

	it("rejects an unsanctioned fixture __dirname path rewrite", (t) => {
		const root = testFixture(
			t,
			'const __dirname = fileURLToPath(new URL(".", import.meta.url));\ntest("kept", () => __dirname);\n',
		);
		splitTest(root, TEST_FACADE, 'test("kept", () => __dirname);\n');
		write(
			root,
			"tests/helpers/sample-fixtures.mjs",
			'const __dirname = fileURLToPath(new URL("../", import.meta.url));\nexport { __dirname };\n',
		);
		strictEqual(
			checkTest(root, { fixture: "tests/helpers/sample-fixtures.mjs" }).status,
			1,
		);
	});

	it("accepts a fixture __dirname rebase and exported fixture import", (t) => {
		const base = [
			'import { fileURLToPath } from "node:url";',
			'import { test } from "node:test";',
			'const __dirname = fileURLToPath(new URL(".", import.meta.url));',
			'test("kept", () => strictEqual(__dirname.length > 0, true));',
			"",
		].join("\n");
		const root = testFixture(t, base);
		splitTest(
			root,
			[
				'import { fixtureValue } from "./helpers/sample-fixtures.mjs";',
				'import "./parts/suite-part.mjs";',
				"",
			].join("\n"),
			'test("kept", () => strictEqual(__dirname.length > 0, true));\n',
		);
		write(
			root,
			"tests/helpers/sample-fixtures.mjs",
			[
				'import { fileURLToPath } from "node:url";',
				"export const fixtureValue = 1;",
				'const __dirname = fileURLToPath(new URL("..", import.meta.url));',
				"",
			].join("\n"),
		);
		const result = checkTest(root, {
			fixture: "tests/helpers/sample-fixtures.mjs",
		});
		strictEqual(result.status, 0, result.stderr);
	});
});
