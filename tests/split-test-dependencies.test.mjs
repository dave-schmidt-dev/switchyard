import { strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tempdir.mjs";

const SPLITTER = fileURLToPath(
	new URL("../scripts/split-module.mjs", import.meta.url),
);
const CHECKER = fileURLToPath(
	new URL("../scripts/check-seam-move.mjs", import.meta.url),
);
const SUBPROCESS_TIMEOUT_MS = 30_000;

function write(root, path, text) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
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

describe("split test dependencies", () => {
	it("uses selected emitted nodes for closure while retaining ordered state and effects", (t) => {
		const root = tempDir("split-test-dependencies-");
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
		const source = [
			'import { beforeEach, describe, it } from "node:test";',
			'import { strictEqual } from "node:assert/strict";',
			"let shared = 0;",
			"let effectCount = 0;",
			"const prerequisite = initialize();",
			"function initialize() { effectCount += 1; return true; }",
			"function selectedHelper() { return selectedHelperStage(); }",
			"function selectedHelperStage() { return shared; }",
			"function unrelatedStateHelper() { return shared + 98; }",
			"beforeEach(() => { shared = 1; });",
			'describe("suite", () => {',
			'\tit("selected", () => { strictEqual(selectedHelper(), 1); strictEqual(effectCount, 1); });',
			'\tit("unselected", () => strictEqual(unrelatedStateHelper(), 99));',
			"});",
			"",
		].join("\n");
		write(root, "tests/suite.test.mjs", source);
		execFileSync("git", ["add", "tests/suite.test.mjs"], {
			cwd: root,
			timeout: SUBPROCESS_TIMEOUT_MS,
		});
		execFileSync("git", ["commit", "-qm", "base"], {
			cwd: root,
			timeout: SUBPROCESS_TIMEOUT_MS,
		});
		write(
			root,
			"manifest.json",
			JSON.stringify({
				tests: {
					"tests/suite.test.mjs": {
						perPartState: [],
						parts: [
							{
								path: "tests/parts/selected.mjs",
								items: [{ title: "suite", tests: ["selected"], scoped: true }],
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
		const part = readFileSync(join(root, "tests/parts/selected.mjs"), "utf8");
		strictEqual(part.includes("unrelatedStateHelper"), false);
		strictEqual(part.includes('it("unselected"'), false);
		for (const text of [
			"let shared",
			"let effectCount",
			"const prerequisite",
			"function initialize",
			"beforeEach",
			"function selectedHelper",
			"function selectedHelperStage",
		])
			strictEqual(part.includes(text), true, text);
		const indexes = [
			"let shared",
			"let effectCount",
			"const prerequisite",
			"function initialize",
		].map((text) => part.indexOf(text));
		indexes.push(part.lastIndexOf("beforeEach("));
		strictEqual(
			indexes.every(
				(index, position) => position === 0 || index > indexes[position - 1],
			),
			true,
			`${indexes.join(",")}\n${part}`,
		);
		strictEqual(check(root, ["tests/parts/selected.mjs"]).status, 0);
		write(
			root,
			"tests/parts/selected.mjs",
			part.replace("const prerequisite = initialize();\n", ""),
		);
		const missingEffect = check(root, ["tests/parts/selected.mjs"]);
		strictEqual(
			missingEffect.status,
			1,
			`${missingEffect.stdout}\n${missingEffect.stderr}`,
		);
		strictEqual(
			`${missingEffect.stdout}\n${missingEffect.stderr}`.includes(
				"state carried statement occurrence count differs in a part",
			),
			true,
			`${missingEffect.stdout}\n${missingEffect.stderr}`,
		);
		write(root, "tests/parts/selected.mjs", part);
		const runtime = run(root, [
			"--test",
			"--test-reporter=tap",
			"tests/suite.test.mjs",
			"tests/parts/selected.mjs",
		]);
		strictEqual(runtime.status, 0, `${runtime.stdout}\n${runtime.stderr}`);
		const runtimeOutput = `${runtime.stdout}\n${runtime.stderr}`;
		strictEqual(runtimeOutput.includes("# pass 2"), true, runtimeOutput);
	});
});
