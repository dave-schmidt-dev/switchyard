import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runQuickChecks } from "../src/switchyard/runner/checks.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Test input only: never install packages or search the caller's Python path.
function hasInstalledPytest(path) {
	try {
		return (
			existsSync(join(path, "pyvenv.cfg")) &&
			existsSync(join(path, "bin", "python")) &&
			readdirSync(join(path, "lib")).some(
				(version) =>
					/^python[0-9.]+$/u.test(version) &&
					existsSync(
						join(
							path,
							"lib",
							version,
							"site-packages",
							"pytest",
							"__init__.py",
						),
					) &&
					existsSync(
						join(
							path,
							"lib",
							version,
							"site-packages",
							"_pytest",
							"__init__.py",
						),
					),
			)
		);
	} catch {
		return false;
	}
}
const testDirectory = dirname(fileURLToPath(import.meta.url));
const candidates = process.env.SWITCHYARD_TEST_PYTEST_VENV
	? [resolve(process.env.SWITCHYARD_TEST_PYTEST_VENV)]
	: [resolve(testDirectory, "../.venv"), resolve(testDirectory, "../../.venv")];
const installedVenv = candidates.find(hasInstalledPytest);
const fixtureUnavailable = installedVenv
	? false
	: "Python host fixture unavailable: set SWITCHYARD_TEST_PYTEST_VENV to an existing venv with installed pytest (no packages are installed by this suite)";

function git(cwd, args) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	}).trim();
}
function fixture(
	testBody = 'import pkg\ndef test_candidate():\n    assert pkg.VALUE == "candidate"\n',
) {
	const root = tempDir("quick-python-host-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	cpSync(installedVenv, join(projectPath, ".venv"), {
		recursive: true,
		dereference: false,
	});
	writeFileSync(join(projectPath, ".gitignore"), ".venv/\n");
	writeFileSync(join(projectPath, "pkg.py"), 'VALUE = "owner"\n');
	writeFileSync(join(projectPath, "test_candidate.py"), testBody);
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "."]);
	git(projectPath, [
		"-c",
		"user.name=Tests",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
	const baseTree = git(projectPath, ["rev-parse", "HEAD^{tree}"]);
	writeFileSync(join(projectPath, "pkg.py"), 'VALUE = "candidate"\n');
	const diff = git(projectPath, ["diff", "--", "pkg.py"]);
	writeFileSync(join(projectPath, "pkg.py"), 'VALUE = "owner"\n');
	return { root, projectPath, baseTree, diff };
}
function run(input, overrides = {}) {
	return runQuickChecks({
		...input,
		taskId: "python-host",
		attempt: 1,
		allowedPaths: ["pkg.py"],
		checks: [[".venv/bin/python", "-m", "pytest", "-q", "test_candidate.py"]],
		checkTimeoutMs: 30000,
		...overrides,
	});
}

describe("Python Quick host confinement", {
	skip:
		nestedSandboxSkip ||
		(!process.env.SWITCHYARD_TEST_PYTEST_VENV && fixtureUnavailable),
}, () => {
	if (!installedVenv) {
		it("requires the explicitly configured real pytest fixture", () =>
			assert.fail(fixtureUnavailable));
		return;
	}
	it("executes installed pytest, imports candidate code and redirects caches", () => {
		const input = fixture(
			'import os, pathlib, pkg\ndef test_candidate(tmp_path):\n    assert pkg.VALUE == "candidate"\n    cwd = pathlib.Path.cwd().resolve()\n    assert pathlib.Path(pkg.__file__).resolve().is_relative_to(cwd)\n    assert [pathlib.Path(entry).resolve() for entry in os.environ["PYTHONPATH"].split(":")] == [cwd / "src", cwd]\n    assert tmp_path.resolve().is_relative_to(pathlib.Path(os.environ["HOME"]).resolve())\n',
		);
		const receipt = run(input);
		assert.equal(receipt.status, "passed", JSON.stringify(receipt));
		assert.equal(receipt.checks[0].exitCode, 0);
		assert.equal(receipt.cleanup.status, "complete");
		assert.equal(
			readFileSync(join(input.projectPath, "pkg.py"), "utf8"),
			'VALUE = "owner"\n',
		);
	});
	it("detects candidate mutations even in cache and node_modules paths", () => {
		const input = fixture(
			'import pathlib\ndef test_mutation():\n    for name in ["__pycache__", "node_modules", ".pytest_cache"]:\n        p=pathlib.Path(name); p.mkdir(exist_ok=True); (p/"tamper").write_text("changed")\n',
		);
		const receipt = run(input);
		assert.notEqual(receipt.status, "passed");
		assert.equal(receipt.checks[0].exitCode, 0);
		assert.equal(receipt.failureCode, "candidate_unavailable");
		assert.equal(receipt.cleanup.status, "complete");
	});
	for (const kind of [
		"missing",
		"escaping",
		"invalid-config",
		"manifest-drift",
	]) {
		it(`refuses ${kind} prerequisites without executing pytest`, () => {
			const input = fixture();
			if (kind === "missing" || kind === "escaping") {
				rmSync(join(input.projectPath, ".venv"), { recursive: true });
				if (kind === "escaping")
					symlinkSync(installedVenv, join(input.projectPath, ".venv"));
			} else if (kind === "invalid-config")
				writeFileSync(
					join(input.projectPath, ".venv", "pyvenv.cfg"),
					"home = /usr/bin\n",
				);
			else
				writeFileSync(
					join(input.projectPath, "requirements.txt"),
					"unmatched\n",
				);
			const receipt = run(input);
			assert.equal(receipt.status, "unknown");
			assert.equal(
				receipt.failureCode,
				kind === "escaping"
					? "check_venv_outside_project"
					: "setup_unavailable",
			);
			assert.equal(receipt.checks.length, 0);
			assert.equal(receipt.cleanup.status, "complete");
		});
	}
});
