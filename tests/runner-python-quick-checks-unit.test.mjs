import assert from "node:assert/strict";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	parseCommand,
	parseQuickChecks,
} from "../src/switchyard/runner/check-contract.mjs";
import {
	isPythonCheck,
	preparePythonChecks,
	pythonCheckEnv,
	verifyPythonCheckLink,
	verifyPythonManifests,
} from "../src/switchyard/runner/python-checks.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function fixture() {
	const root = tempDir("quick-python-unit-");
	const project = join(root, "project"),
		clone = join(root, "clone");
	const base = join(root, "base", "bin");
	for (const path of [
		join(project, ".venv", "bin"),
		join(clone, ".git", "info"),
		base,
	])
		mkdirSync(path, { recursive: true });
	writeFileSync(join(base, "python3"), "fixture", { mode: 0o755 });
	symlinkSync(join(base, "python3"), join(project, ".venv", "bin", "python"));
	writeFileSync(join(project, ".venv", "pyvenv.cfg"), `home = ${base}\n`);
	return { root, project, clone, base };
}
const parse = (command) => parseCommand(command, "python", false);

test("only bounded pytest argv and simple explicit node ids are admitted", () => {
	for (const command of [
		".venv/bin/python -m pytest test_a.py",
		".venv/bin/python -m pytest -q tests/test_a.py::TestClass::test_method",
		".venv/bin/python -m pytest a.py b.py c.py d.py e.py f.py g.py h.py",
	])
		assert.equal(isPythonCheck(parse(command)), true);
	for (const suffix of [
		"",
		"-q",
		"-v a.py",
		"--collect-only a.py",
		"/a.py",
		"../a.py",
		"x/../a.py",
		"x//a.py",
		"./a.py",
		"a.py::",
		"a.py::test[one]",
		"a.py -q",
		"a.txt",
		"a.py b.py c.py d.py e.py f.py g.py h.py i.py",
		"a.py; touch x",
		"a.py && true",
		"a.py $(whoami)",
	]) {
		assert.throws(
			() => parse(`.venv/bin/python -m pytest ${suffix}`),
			/Quick check/,
		);
	}
	for (const command of [
		"pytest a.py",
		"python3 -m pytest a.py",
		"uv run pytest a.py",
		".venv/bin/python -m pip install pytest",
		`.venv/bin/python -m pytest ${"a".repeat(300)}.py`,
	])
		assert.throws(() => parse(command));
	assert.equal(
		isPythonCheck([
			".venv/bin/python",
			"-m",
			"pytest",
			`${"a".repeat(300)}.py`,
		]),
		false,
	);
});

test("npm/node forms, mixed tools, baseline and fixed offline setup remain admitted", () => {
	const block =
		"- **Quick checks:** npm test; .venv/bin/python -m pytest a.py; node --check x.mjs\n- **Quick check setup:** npm ci --ignore-scripts --offline\n- **Baseline checks:** node --check x.mjs; .venv/bin/python -m pytest a.py\n- **Repair checks:** .venv/bin/python -m pytest a.py";
	const result = parseQuickChecks(block, "python");
	assert.equal(result.checks.length, 3);
	assert.deepEqual(result.setup, [
		"npm",
		"ci",
		"--ignore-scripts",
		"--offline",
	]);
	assert.equal(result.baselineChecks.length, 2);
	assert.equal(result.repairChecks.length, 1);
	assert.deepEqual(parse("npm run lint"), ["npm", "run", "lint"]);
	assert.throws(() =>
		parseQuickChecks(
			block.replace("npm ci --ignore-scripts --offline", "uv sync"),
			"python",
		),
	);
});

test("manifests are optional but every present supported manifest must match", () => {
	const { project, clone } = fixture();
	assert.equal(verifyPythonManifests(project, clone), true);
	for (const name of [
		"pyproject.toml",
		"uv.lock",
		"requirements.txt",
		"setup.py",
		"setup.cfg",
	]) {
		writeFileSync(join(project, name), "manifest\n");
		assert.equal(
			verifyPythonManifests(project, clone),
			false,
			`${name} missing`,
		);
		writeFileSync(join(clone, name), "manifest\n");
		assert.equal(verifyPythonManifests(project, clone), true);
		writeFileSync(join(clone, name), "changed\n");
		assert.equal(verifyPythonManifests(project, clone), false, `${name} drift`);
		rmSync(join(clone, name));
		rmSync(join(project, name));
		writeFileSync(join(clone, name), "candidate only\n");
		assert.equal(verifyPythonManifests(project, clone), false);
		rmSync(join(clone, name));
	}
	writeFileSync(join(project, "source"), "manifest\n");
	symlinkSync(join(project, "source"), join(project, "pyproject.toml"));
	writeFileSync(join(clone, "pyproject.toml"), "manifest\n");
	assert.equal(verifyPythonManifests(project, clone), false);
});

test("trusted venv reuses P0 grants and ignores only its fixed dependency link", () => {
	const { project, clone, root } = fixture();
	const grants = preparePythonChecks(project, clone);
	assert.ok(lstatSync(join(clone, ".venv")).isSymbolicLink());
	assert.equal(verifyPythonCheckLink(project, clone), true);
	assert.ok(grants.includes(join(root, "base")));
	assert.ok(!grants.includes(project));
	assert.equal(
		readFileSync(join(clone, ".git", "info", "exclude"), "utf8"),
		"\n/.venv\n",
	);
	rmSync(join(clone, ".venv"));
	assert.equal(verifyPythonCheckLink(project, clone), false);
});

test("candidate venv files, directories, forged links and dangling links refuse", () => {
	for (const type of ["file", "directory", "link", "dangling"]) {
		const { project, clone } = fixture();
		const path = join(clone, ".venv");
		if (type === "file") writeFileSync(path, "forged");
		else if (type === "directory") mkdirSync(path);
		else
			symlinkSync(
				type === "link" ? join(project, ".venv") : join(project, "missing"),
				path,
			);
		assert.throws(() => preparePythonChecks(project, clone), {
			code: "setup_unavailable",
		});
	}
});

test("missing, escaping or invalid owner prerequisites refuse with closed codes", () => {
	for (const kind of ["missing", "escape", "config", "python", "mode"]) {
		const { project, clone, root, base } = fixture();
		if (["missing", "escape"].includes(kind)) {
			rmSync(join(project, ".venv"), { recursive: true });
			if (kind === "escape")
				symlinkSync(join(root, "base"), join(project, ".venv"));
		} else if (kind === "config")
			writeFileSync(join(project, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
		else if (kind === "python") rmSync(join(project, ".venv", "bin", "python"));
		else {
			rmSync(join(base, "python3"));
			writeFileSync(join(base, "python3"), "not executable", { mode: 0o600 });
		}
		assert.throws(() => preparePythonChecks(project, clone), {
			code:
				kind === "escape" ? "check_venv_outside_project" : "setup_unavailable",
		});
	}
});

test("Python imports and caches are runtime-confined without inherited PYTHONPATH", () => {
	const env = pythonCheckEnv(
		"/candidate",
		{
			HOME: "/runtime",
			PATH: "/bin",
			PYTHONPATH: "/owner",
			PYTEST_ADDOPTS: "unsafe",
		},
		"/runtime",
	);
	assert.equal(env.PYTHONPATH, "/candidate/src:/candidate");
	assert.equal(env.PYTHONNOUSERSITE, "1");
	assert.equal(Object.hasOwn(env, "PYTEST_DISABLE_PLUGIN_AUTOLOAD"), false);
	assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
	assert.equal(env.PYTHONPYCACHEPREFIX, "/runtime/python-cache");
	assert.match(env.PYTEST_ADDOPTS, /cache_dir=.*runtime\/pytest-cache/u);
	assert.match(env.PYTEST_ADDOPTS, /basetemp=.*runtime\/pytest-tmp/u);
	assert.equal(env.XDG_CACHE_HOME, "/runtime/cache");
});
