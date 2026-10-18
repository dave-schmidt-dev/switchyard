// @test-phase: other
import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	linkPythonVenv,
	venvBaseInterpreterPrefix,
} from "../src/switchyard/runner/python-venv.mjs";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import { sourceText } from "./helpers/source-text.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const OUTSIDE_PROJECT = { code: "check_venv_outside_project" };

function git(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	});
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

/** A project with a clone destination beside it, both under one root. */
function fixture() {
	const root = tempDir("switchyard-python-venv-");
	const project = join(root, "project");
	mkdirSync(project);
	const clonePath = join(root, "clone");
	mkdirSync(clonePath);
	return { root, project, clonePath };
}

/**
 * A venv under `project` pointing at a base interpreter whose bin holds
 * `names`. `config: null` leaves pyvenv.cfg out entirely.
 */
function baseFixture({ config, names = ["python3"] } = {}) {
	const { root, project, clonePath } = fixture();
	const bin = join(root, "base", "bin");
	mkdirSync(bin, { recursive: true });
	for (const name of names) writeFileSync(join(bin, name), "");
	const venv = join(project, ".venv");
	mkdirSync(venv);
	if (config !== null)
		writeFileSync(join(venv, "pyvenv.cfg"), config ?? `home = ${bin}\n`);
	return { root, project, clonePath, bin, venv };
}

describe("linkPythonVenv", () => {
	it("links a trusted venv into the clone and grants its base prefix", () => {
		const { project, clonePath, bin, venv } = baseFixture();
		const linked = join(clonePath, ".venv");
		deepStrictEqual(linkPythonVenv(project, clonePath), [
			realpathSync(venv),
			dirname(bin),
		]);
		strictEqual(realpathSync(linked), realpathSync(venv));
	});

	it("does not replace an existing clone venv entry", () => {
		const { root, project, clonePath, bin, venv } = baseFixture();
		const marker = join(root, "marker");
		mkdirSync(marker);
		symlinkSync(marker, join(clonePath, ".venv"));
		deepStrictEqual(linkPythonVenv(project, clonePath), [
			realpathSync(venv),
			dirname(bin),
		]);
		strictEqual(readlinkSync(join(clonePath, ".venv")), marker);
	});

	it("returns no grants and creates nothing without a project venv", () => {
		const { project, clonePath } = fixture();
		deepStrictEqual(linkPythonVenv(project, clonePath), []);
		strictEqual(existsSync(join(clonePath, ".venv")), false);
	});

	for (const target of ["outside", "sibling-project"]) {
		it(`refuses a venv that resolves outside the project (${target})`, () => {
			const { root, project, clonePath } = fixture();
			const outside = join(root, target);
			mkdirSync(outside);
			symlinkSync(outside, join(project, ".venv"));
			throws(() => linkPythonVenv(project, clonePath), OUTSIDE_PROJECT);
			strictEqual(existsSync(join(clonePath, ".venv")), false);
		});
	}

	it("refuses a venv that resolves to the project root itself", () => {
		const { project, clonePath } = fixture();
		// A trailing separator boundary: the realpath must be strictly inside
		// the project, not merely a string prefix of it.
		symlinkSync(project, join(project, ".venv"));
		throws(() => linkPythonVenv(project, clonePath), OUTSIDE_PROJECT);
		strictEqual(existsSync(join(clonePath, ".venv")), false);
	});
});

describe("venvBaseInterpreterPrefix", () => {
	it("grants the real prefix and the declared alias for a symlinked home", () => {
		const { root, project, clonePath } = fixture();
		const real = join(root, "python");
		mkdirSync(join(real, "bin"), { recursive: true });
		writeFileSync(join(real, "bin", "python3.12"), "");
		const alias = join(root, "python-alias");
		symlinkSync(real, alias);
		const venv = join(project, ".venv");
		mkdirSync(venv);
		writeFileSync(join(venv, "pyvenv.cfg"), `home = ${join(alias, "bin")}\n`);
		deepStrictEqual(venvBaseInterpreterPrefix(venv), [real, alias]);
		deepStrictEqual(linkPythonVenv(project, clonePath), [
			realpathSync(venv),
			real,
			alias,
		]);
	});

	it("grants only the venv itself when pyvenv.cfg is missing", () => {
		const { project, clonePath, venv } = baseFixture({ config: null });
		deepStrictEqual(venvBaseInterpreterPrefix(venv), []);
		deepStrictEqual(linkPythonVenv(project, clonePath), [realpathSync(venv)]);
	});

	it("grants only the venv itself for a relative home", () => {
		const { project, clonePath, venv } = baseFixture({
			config: "home = base/bin\n",
		});
		deepStrictEqual(venvBaseInterpreterPrefix(venv), []);
		deepStrictEqual(linkPythonVenv(project, clonePath), [realpathSync(venv)]);
	});

	it("grants only the venv itself when home does not exist", () => {
		const { root, project, clonePath, venv } = baseFixture({ config: null });
		writeFileSync(
			join(venv, "pyvenv.cfg"),
			`home = ${join(root, "absent", "bin")}\n`,
		);
		deepStrictEqual(venvBaseInterpreterPrefix(venv), []);
		deepStrictEqual(linkPythonVenv(project, clonePath), [realpathSync(venv)]);
	});

	it("grants only the venv itself when home holds no interpreter", () => {
		const { project, clonePath, venv } = baseFixture({
			names: ["python3-config", "python3x", "python-config"],
		});
		deepStrictEqual(venvBaseInterpreterPrefix(venv), []);
		deepStrictEqual(linkPythonVenv(project, clonePath), [realpathSync(venv)]);
	});

	it("accepts a versioned python3 name in the base home", () => {
		const { project, clonePath, bin, venv } = baseFixture({
			names: ["python3.12"],
		});
		deepStrictEqual(linkPythonVenv(project, clonePath), [
			realpathSync(venv),
			dirname(bin),
		]);
	});

	it("refuses a base interpreter directly under / or /usr", () => {
		const fs = createRequire(import.meta.url)("node:fs");
		const original = fs.readdirSync;
		fs.readdirSync = (path, ...args) =>
			path === "/bin" || path === "/usr/bin"
				? ["python3"]
				: original(path, ...args);
		syncBuiltinESMExports();
		try {
			const { project, clonePath, venv } = baseFixture({ config: null });
			for (const home of ["/bin", "/usr/bin"]) {
				writeFileSync(join(venv, "pyvenv.cfg"), `home = ${home}\n`);
				deepStrictEqual(venvBaseInterpreterPrefix(venv), []);
				deepStrictEqual(linkPythonVenv(project, clonePath), [
					realpathSync(venv),
				]);
			}
		} finally {
			fs.readdirSync = original;
			syncBuiltinESMExports();
		}
	});
});

describe("check session seam", () => {
	it("refuses an escaping venv at the link step before any sandbox", async () => {
		const root = tempDir("switchyard-python-venv-session-");
		const project = join(root, "project");
		mkdirSync(project);
		writeFileSync(join(project, "a.txt"), "base\n");
		writeFileSync(join(project, ".gitignore"), ".venv\n");
		git(project, ["init", "-q"]);
		git(project, ["add", "."]);
		git(project, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"base",
		]);
		mkdirSync(join(root, "outside"));
		symlinkSync(join(root, "outside"), join(project, ".venv"));
		const session = createSimpleCheckSessions({
			taskRoot: root,
			projectPath: project,
			baseRevision: git(project, ["rev-parse", "HEAD"]),
			baseTree: git(project, ["rev-parse", "HEAD^{tree}"]),
			files: ["a.txt"],
			commands: ["test -f a.txt"],
			taskId: "python-venv-proof",
			deadlineMs: Date.now() + 60_000,
		});
		try {
			await rejects(
				session.prepare(),
				(error) =>
					error.code === "check_venv_outside_project" &&
					error.checkSetupStep === "link_python_venv",
			);
			strictEqual(session.writerLifecycle, "never_started");
		} finally {
			session.remove();
		}
		strictEqual(
			readdirSync(root).some((name) => name.startsWith("checker-")),
			false,
		);
	});

	it("consumes the extracted seam instead of keeping a local copy", () => {
		const session = sourceText("src/switchyard/simple/check-session.mjs");
		ok(session.includes('from "../runner/python-venv.mjs"'));
		ok(session.includes("linkPythonVenv(projectPath, active.path)"));
		strictEqual(/function\s+linkPythonVenv\b/u.test(session), false);
		strictEqual(/function\s+venvBaseInterpreterPrefix\b/u.test(session), false);
	});
});
