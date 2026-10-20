// @test-phase: other
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findPytestVenv } from "../scripts/pytest-venv.mjs";
import { runQuickChecks } from "../src/switchyard/runner/checks.mjs";
import { verifySharedVenvRoot } from "../src/switchyard/runner/python-venv.mjs";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const explicit = process.env.SWITCHYARD_TEST_PYTEST_VENV;
const installed = explicit ? findPytestVenv({ root: process.cwd() }) : null;
const skip =
	nestedSandboxSkip ||
	(!explicit &&
		"requires explicit SWITCHYARD_TEST_PYTEST_VENV under the trusted account's .venvs");
const command = installed
	? `${installed}/bin/python -m pytest -q test_candidate.py`
	: null;
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
function fixture() {
	assert.ok(installed, "explicit pytest fixture must be usable");
	assert.equal(verifySharedVenvRoot(installed), installed);
	const root = tempDir("shared-python-host-"),
		projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(root, "ungranted.txt"), "fixture");
	writeFileSync(join(projectPath, "pkg.py"), 'VALUE = "owner"\n');
	writeFileSync(
		join(projectPath, "test_candidate.py"),
		`import os, pathlib, pkg\ndef test_candidate(tmp_path):\n    assert pkg.VALUE == "candidate"\n    assert pathlib.Path(pkg.__file__).resolve().is_relative_to(pathlib.Path.cwd().resolve())\n    assert tmp_path.resolve().is_relative_to(pathlib.Path(os.environ["HOME"]).resolve())\n    try:\n        descriptor = os.open(${JSON.stringify(join(installed, "pyvenv.cfg"))}, os.O_WRONLY)\n    except PermissionError:\n        pass\n    else:\n        os.close(descriptor)\n        raise AssertionError("shared venv writable")\n    try:\n        pathlib.Path(${JSON.stringify(join(root, "ungranted.txt"))}).read_text()\n    except PermissionError:\n        pass\n    else:\n        raise AssertionError("undeclared root readable")\n`,
	);
	writeFileSync(
		join(projectPath, "test_probe.mjs"),
		`import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.throws(()=>readFileSync(${JSON.stringify(join(installed, "pyvenv.cfg"))}), /EPERM|EACCES/);`,
	);
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "."]);
	git(projectPath, [
		"-c",
		"user.name=Tests",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	const baseRevision = git(projectPath, ["rev-parse", "HEAD"]),
		baseTree = git(projectPath, ["rev-parse", "HEAD^{tree}"]);
	writeFileSync(join(projectPath, "pkg.py"), 'VALUE = "candidate"\n');
	const diff = git(projectPath, ["diff", "--", "pkg.py"]);
	writeFileSync(join(projectPath, "pkg.py"), 'VALUE = "owner"\n');
	return { root, projectPath, baseRevision, baseTree, diff };
}

test("shared Quick pytest imports candidate bytes and keeps host roots read-only", {
	skip,
}, () => {
	const input = fixture();
	const receipt = runQuickChecks({
		...input,
		taskId: "shared-host",
		attempt: 1,
		allowedPaths: ["pkg.py"],
		checks: [command.split(" ")],
		checkTimeoutMs: HANG_GUARD_MS,
	});
	assert.equal(receipt.status, "passed", JSON.stringify(receipt));
	assert.equal(receipt.cleanup.status, "complete");
});

test("simple shared pytest grants no venv reads to the accompanying node check", {
	skip,
}, async () => {
	const input = fixture();
	const node = "node --test test_probe.mjs";
	const session = createSimpleCheckSessions({
		taskRoot: input.root,
		projectPath: input.projectPath,
		baseRevision: input.baseRevision,
		baseTree: input.baseTree,
		files: ["pkg.py"],
		commands: [command, node],
		taskId: "shared-simple-host",
		deadlineMs: Date.now() + HANG_GUARD_MS * 4,
	});
	try {
		await session.prepare(input.diff);
		assert.equal((await session.run({ command })).success, true);
		assert.equal((await session.run({ command: node })).success, true);
		// An undeclared Python spelling/argv earns no read grant either.
		const undeclared = command.replace(" -q ", " ");
		assert.equal((await session.run({ command: undeclared })).success, false);
	} finally {
		session.remove();
	}
});
