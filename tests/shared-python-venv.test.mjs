// @test-phase: other
import assert from "node:assert/strict";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
	parseCommand,
	parseQuickChecks,
} from "../src/switchyard/runner/check-contract.mjs";
import { runQuickChecks } from "../src/switchyard/runner/checks.mjs";
import { quickCheckSandboxProfile } from "../src/switchyard/runner/checks-sandbox.mjs";
import {
	declaredSharedVenv,
	preparePythonChecks,
	verifyPythonCheckLink,
} from "../src/switchyard/runner/python-checks.mjs";
import {
	linkPythonVenv,
	sharedVenvReadProof,
	sharedVenvRoot,
	verifySharedVenvRoot,
} from "../src/switchyard/runner/python-venv.mjs";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import { validateCheckCommand } from "../src/switchyard/simple/check-validation.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const os = createRequire(import.meta.url)("node:os");
const originalUserInfo = os.userInfo;
let trustedHome;
os.userInfo = (...args) => ({
	...originalUserInfo(...args),
	homedir: trustedHome ?? originalUserInfo().homedir,
});
syncBuiltinESMExports();
after(() => {
	os.userInfo = originalUserInfo;
	syncBuiltinESMExports();
});
const parse = (command) => parseCommand(command, "shared", false);
const command = (root) => `${root}/bin/python -m pytest -q tests/test_a.py`;

function fixture() {
	const root = tempDir("shared-python-");
	const home = join(root, "owner"),
		venv = join(home, ".venvs", "shared");
	const project = join(root, "project"),
		clone = join(root, "clone"),
		base = join(root, "base", "bin");
	for (const path of [
		join(venv, "bin"),
		project,
		join(clone, ".git", "info"),
		base,
	])
		mkdirSync(path, { recursive: true });
	writeFileSync(join(base, "python3"), "fixture", { mode: 0o755 });
	symlinkSync(join(base, "python3"), join(venv, "bin", "python"));
	writeFileSync(join(venv, "pyvenv.cfg"), `home = ${base}\n`);
	trustedHome = home;
	return { root, home, venv, project, clone, base };
}

test("exact bounded interpreter declares one root without account lookup at parse", () => {
	const path = "/Users/owner/.venvs/shared";
	trustedHome = "/does-not-exist";
	assert.equal(sharedVenvRoot(`${path}/bin/python`), path);
	assert.equal(declaredSharedVenv([parse(command(path))]), path);
	assert.equal(
		parseQuickChecks(`- **Quick checks:** ${command(path)}`, "shared").checks
			.length,
		1,
	);
	assert.doesNotThrow(() => validateCheckCommand(command(path), "/project"));
	for (const executable of [
		"~/.venvs/shared/bin/python",
		"/Users/owner/.venvs/../bin/python",
		"/Users/owner/.venvs/shared/../other/bin/python",
		"/Users/owner/.venvs/shared/nested/bin/python",
		"/Users/owner/.venvs//shared/bin/python",
		"/Users/owner/.venvs/shared/bin/pytest",
		"/Users/owner/.venvs/shared/bin/python3",
	]) {
		assert.throws(() => parse(`${executable} -m pytest tests/test_a.py`));
		assert.throws(() =>
			validateCheckCommand(
				`${executable.startsWith("~") ? "/Users/owner/other/bin/python" : executable} -m pytest tests/test_a.py`,
				"/project",
			),
		);
	}
	for (const suffix of [
		"-m pip install pytest",
		"-c 1",
		"-m pytest ../escape.py",
		"-m pytest tests",
		"-m pytest --collect-only a.py",
		"-m pytest a.py && true",
	]) {
		assert.throws(() => parse(`${path}/bin/python ${suffix}`));
		assert.throws(() =>
			validateCheckCommand(`${path}/bin/python ${suffix}`, "/project"),
		);
	}
	for (const raw of ["uv run pytest a.py", "uv sync --offline --frozen"])
		assert.throws(() => parse(raw));
	assert.throws(() =>
		parseQuickChecks(
			`- **Quick checks:** ${command(path)}\n- **Quick check setup:** uv sync --offline --frozen`,
			"shared",
		),
	);
});

test("multiple roots and mixed relative interpreters refuse throughout declaration surfaces", () => {
	const a = command("/Users/owner/.venvs/a"),
		b = command("/Users/owner/.venvs/b"),
		local = ".venv/bin/python -m pytest a.py";
	for (const other of [b, local]) {
		assert.throws(() => declaredSharedVenv([parse(a), parse(other)]), {
			code: "setup_unavailable",
		});
		assert.throws(() =>
			parseQuickChecks(`- **Quick checks:** ${a}; ${other}`, "shared"),
		);
		assert.throws(() =>
			parseQuickChecks(
				`- **Quick checks:** ${a}\n- **Baseline checks:** ${other}`,
				"shared",
			),
		);
		assert.throws(
			() =>
				runQuickChecks({
					taskId: "shared",
					checks: [parse(a), parse(other)],
					diff: "",
					projectPath: "/unused",
				}),
			{ code: "setup_unavailable" },
		);
		assert.throws(() => createSimpleCheckSessions({ commands: [a, other] }), {
			code: "setup_unavailable",
		});
	}
});

test("shared interpreter reuses executable proof and the fixed clone link", () => {
	const { home, venv, project, clone, root } = fixture();
	assert.equal(verifySharedVenvRoot(venv, home), venv);
	const reads = preparePythonChecks(project, clone, venv);
	assert.deepEqual(reads, [venv, join(root, "base")]);
	assert.equal(verifyPythonCheckLink(project, clone, venv), true);
	assert.equal(verifyPythonCheckLink(project, clone), false);
	assert.equal(lstatSync(join(clone, ".venv")).isSymbolicLink(), true);
	assert.equal(realpathSync(join(clone, ".venv")), venv);
	assert.equal(
		readFileSync(join(clone, ".git", "info", "exclude"), "utf8"),
		"\n/.venv\n",
	);
});

test("shared root requires trusted home, regular directories and unescaped interpreter", () => {
	for (const kind of [
		"wrong-home",
		"symlink-root",
		"symlink-parent",
		"config-link",
		"base-mismatch",
		"broad-base",
		"no-base",
		"not-executable",
	]) {
		const { home, venv, project, clone, root, base } = fixture();
		if (kind === "wrong-home") trustedHome = join(root, "other");
		if (kind === "symlink-root") {
			renameSync(venv, join(root, "outside"));
			symlinkSync(join(root, "outside"), venv);
		}
		if (kind === "symlink-parent") {
			renameSync(dirname(venv), join(root, "outside"));
			symlinkSync(join(root, "outside"), dirname(venv));
		}
		if (kind === "config-link") {
			renameSync(join(venv, "pyvenv.cfg"), join(root, "config"));
			symlinkSync(join(root, "config"), join(venv, "pyvenv.cfg"));
		}
		if (kind === "base-mismatch") {
			writeFileSync(join(root, "other-python"), "fixture", { mode: 0o755 });
			rmSync(join(venv, "bin", "python"));
			symlinkSync(join(root, "other-python"), join(venv, "bin", "python"));
		}
		if (kind === "broad-base")
			writeFileSync(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
		if (kind === "no-base")
			writeFileSync(join(venv, "pyvenv.cfg"), "home = missing\n");
		if (kind === "not-executable") chmodSync(join(base, "python3"), 0o600);
		assert.throws(
			() => preparePythonChecks(project, clone, venv),
			{ code: "setup_unavailable" },
			kind,
		);
		if (kind !== "wrong-home")
			assert.throws(
				() => verifySharedVenvRoot(venv, home),
				{ code: "setup_unavailable" },
				kind,
			);
	}
});

test("proof notices root replacement, interpreter retargeting and config drift", () => {
	for (const kind of ["root", "symlink", "interpreter", "config"]) {
		const { venv, home, root, base } = fixture(),
			proof = sharedVenvReadProof(venv, home);
		proof.verify();
		if (kind === "root" || kind === "symlink") {
			renameSync(venv, join(root, "old"));
			if (kind === "symlink") symlinkSync(join(root, "old"), venv);
			else {
				mkdirSync(join(venv, "bin"), { recursive: true });
				writeFileSync(join(venv, "pyvenv.cfg"), `home = ${base}\n`);
				symlinkSync(join(base, "python3"), join(venv, "bin", "python"));
			}
		}
		if (kind === "interpreter") {
			writeFileSync(join(base, "python3.12"), "replacement", { mode: 0o755 });
			rmSync(join(venv, "bin", "python"));
			symlinkSync(join(base, "python3.12"), join(venv, "bin", "python"));
		}
		if (kind === "config")
			writeFileSync(
				join(venv, "pyvenv.cfg"),
				`home = ${base}\nprompt = changed\n`,
			);
		assert.throws(() => proof.verify(), { code: "setup_unavailable" }, kind);
	}
});

test("read-only sandbox profile grants exact root and base, never their parents", () => {
	const { venv, home, project, clone, root } = fixture(),
		reads = linkPythonVenv(project, clone, venv);
	const runtime = join(root, "runtime");
	mkdirSync(runtime);
	const profile = quickCheckSandboxProfile(clone, runtime, reads);
	assert.ok(profile.includes(`(subpath ${JSON.stringify(venv)})`));
	assert.ok(
		profile.includes(`(subpath ${JSON.stringify(join(root, "base"))})`),
	);
	const write = profile
		.split("\n")
		.find((line) => line.startsWith("(allow file-write*"));
	for (const path of [venv, home, dirname(venv), join(root, "base")])
		assert.ok(!write.includes(JSON.stringify(path)));
	const read = profile
		.split("\n")
		.find((line) => line.startsWith("(allow file-read* (subpath"));
	assert.ok(!read.includes(`(subpath ${JSON.stringify(home)})`));
	assert.ok(!read.includes(`(subpath ${JSON.stringify(dirname(venv))})`));
	assert.ok(
		!read.includes(
			`(subpath ${JSON.stringify(join(dirname(venv), "undeclared"))})`,
		),
	);
});
