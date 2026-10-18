import { deepStrictEqual, match, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	findPytestVenv,
	gatePrerequisiteProblems,
	PYTHON_HOST_SUITE,
} from "../scripts/pytest-venv.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const REPO = join(import.meta.dirname, "..");

function fakeVenv(root) {
	const site = join(root, "lib", "python3.13", "site-packages");
	for (const file of [
		join(root, "pyvenv.cfg"),
		join(root, "bin", "python"),
		join(site, "pytest", "__init__.py"),
		join(site, "_pytest", "__init__.py"),
	]) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "");
	}
	return root;
}

test("the explicit venv wins, and a repository .venv is the fallback", () => {
	const root = realpathSync(tempDir("sy-prereq-"));
	const explicit = fakeVenv(join(root, "explicit"));
	strictEqual(
		findPytestVenv({ root, env: { SWITCHYARD_TEST_PYTEST_VENV: explicit } }),
		explicit,
	);
	strictEqual(findPytestVenv({ root, env: {} }), null);
	const local = fakeVenv(join(root, ".venv"));
	strictEqual(findPytestVenv({ root, env: {} }), local);
	// An explicit but unusable venv never falls back to the local one.
	strictEqual(
		findPytestVenv({
			root,
			env: { SWITCHYARD_TEST_PYTEST_VENV: join(root, "missing") },
		}),
		null,
	);
});

test("only a gate that requires the Python host suite needs the venv", () => {
	const root = realpathSync(tempDir("sy-prereq-"));
	deepStrictEqual(
		gatePrerequisiteProblems(["tests/other.test.mjs"], { root, env: {} }),
		[],
	);
	const [problem, ...rest] = gatePrerequisiteProblems([PYTHON_HOST_SUITE], {
		root,
		env: {},
	});
	match(problem, /SWITCHYARD_TEST_PYTEST_VENV/u);
	deepStrictEqual(rest, []);
});

// Regression (2026-10-18 baseline): a fresh-shell validate failed on its
// last step after 28 min 47 s because the skipped Python host suite fails
// the contract gate. The host gate now refuses before running any phase.
test("validate:host refuses in its first second without the pytest fixture", () => {
	const root = realpathSync(tempDir("sy-prereq-"));
	const started = Date.now();
	const result = spawnSync(
		process.execPath,
		[join(REPO, "scripts", "run-host-validation.mjs")],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 30_000,
			env: { PATH: process.env.PATH, HOME: process.env.HOME },
		},
	);
	strictEqual(result.status, 1, result.stderr);
	match(result.stderr, /validate:host: Python host fixture unavailable/u);
	strictEqual(result.stdout.includes("phase"), false);
	strictEqual(Date.now() - started < 10_000, true);
});
