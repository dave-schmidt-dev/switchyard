import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSimpleCheckSessions } from "../src/switchyard/simple/check-session.mjs";
import {
	declaredPathDependencies,
	uvPathSources,
	venvPathEntries,
} from "../src/switchyard/simple/path-dependencies.mjs";
import { nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const REFUSED = { code: "check_dependencies_unverified" };

// Wilted's Producer/Runtime manifest, verbatim in shape (2026-10-06 field case).
const WILTED_SOURCES = `[tool.uv]
override-dependencies = ["syrupy>=5"]

[tool.uv.sources]
# EDITABLE is required, not cosmetic: the shared GPU lock resolves through
# Path(__file__), so a copied install would break the cross-process guarantee.
# The path is relative to this file so the checkout works from any location.
speech-stack = { path = "../../../speech-stack", editable = true }

[tool.pytest.ini_options]
testpaths = ["tests"]
`;

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

/** A project beside a sibling path dependency, both under one parent. */
function fixture(
	sources = 'sibling = { path = "../sibling", editable = true }',
) {
	const root = tempDir("switchyard-path-deps-");
	const project = join(root, "project");
	const sibling = join(root, "sibling");
	mkdirSync(project);
	mkdirSync(join(sibling, "src", "sibling"), { recursive: true });
	writeFileSync(
		join(sibling, "src", "sibling", "__init__.py"),
		'VALUE = "sibling"\n',
	);
	writeFileSync(
		join(project, "pyproject.toml"),
		`[project]\nname = "fixture"\n\n[tool.uv.sources]\n${sources}\n`,
	);
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
	return { root, project, sibling };
}

function checkSession(repo) {
	return createSimpleCheckSessions({
		taskRoot: tempDir("switchyard-path-deps-task-"),
		projectPath: repo.project,
		baseRevision: git(repo.project, ["rev-parse", "HEAD"]),
		baseTree: git(repo.project, ["rev-parse", "HEAD^{tree}"]),
		files: ["pyproject.toml"],
		commands: [],
		taskId: "path-dependencies",
		deadlineMs: Date.now() + 180_000,
	});
}

// Prefer a uv-managed interpreter, as the toolchain sandbox test does: its
// prefix lies outside every path the sandbox already reads.
function baseInterpreter() {
	const uvRoot = join(homedir(), ".local/share/uv/python");
	try {
		for (const name of readdirSync(uvRoot).sort()) {
			const candidate = join(uvRoot, name, "bin", "python3");
			if (name.startsWith("cpython-3") && existsSync(candidate))
				return candidate;
		}
	} catch {
		// No uv interpreters on this host.
	}
	for (const candidate of ["/opt/homebrew/bin/python3", "/usr/bin/python3"]) {
		const probe = spawnSync(candidate, ["-c", "1"], { encoding: "utf8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function sitePackages(venv) {
	const version = readdirSync(join(venv, "lib")).find((name) =>
		/^python3\.\d+$/u.test(name),
	);
	return join(venv, "lib", version, "site-packages");
}

const python = process.platform === "darwin" ? baseInterpreter() : null;
const sandboxSkip =
	process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")
		? "requires macOS sandbox-exec"
		: false;

describe("uv [tool.uv.sources] parser", () => {
	it("reads Wilted's editable path source past its comment block", () => {
		deepStrictEqual(uvPathSources(WILTED_SOURCES), [
			{ name: "speech-stack", path: "../../../speech-stack" },
		]);
	});

	it("ignores non-path sources, other tables and unsupported spellings", () => {
		const text = [
			'description = """',
			"[tool.uv.sources]",
			'hidden = { path = "../hidden" }',
			'"""',
			"[tool.uv.sources]",
			'httpx = { git = "https://example.invalid/httpx", tag = "1" }',
			"member = { workspace = true }",
			'escaped = { path = "..\\\\escaped" }',
			"dotted.key = { path = '../dotted' }",
			"literal = { path = '../literal' } # trailing comment",
			'"quoted" = { path = "../quoted", editable = false }',
			"[tool.uv.sources.subtable]",
			'path = "../subtable"',
			"[tool.other]",
			'other = { path = "../other" }',
		].join("\n");
		deepStrictEqual(uvPathSources(text), [
			{ name: "literal", path: "../literal" },
			{ name: "quoted", path: "../quoted" },
		]);
	});

	it("reads nothing from text with an unterminated string", () => {
		deepStrictEqual(
			uvPathSources('[tool.uv.sources]\nx = { path = "../x }\n'),
			[],
		);
	});
});

describe("declaredPathDependencies", () => {
	it("accepts a sibling directory and returns its realpath", () => {
		const repo = fixture();
		deepStrictEqual(declaredPathDependencies(repo.project), [
			realpathSync(repo.sibling),
		]);
	});

	it("accepts a package.json file: sibling and ignores registry ranges", () => {
		const repo = fixture("");
		writeFileSync(
			join(repo.project, "package.json"),
			JSON.stringify({
				dependencies: { left: "^1.0.0" },
				devDependencies: { sibling: "file:../sibling" },
			}),
		);
		deepStrictEqual(declaredPathDependencies(repo.project), [
			realpathSync(repo.sibling),
		]);
	});

	it("needs no grant for paths inside the project", () => {
		const repo = fixture(
			'vendored = { path = "vendor/pkg" }\nmissing = { path = "dist/x.whl" }',
		);
		mkdirSync(join(repo.project, "vendor", "pkg"), { recursive: true });
		deepStrictEqual(declaredPathDependencies(repo.project), []);
	});

	it("refuses $HOME/.ssh without naming the path", () => {
		const ssh = join(homedir(), ".ssh");
		const repo = fixture(`keys = { path = ${JSON.stringify(ssh)} }`);
		throws(
			() => declaredPathDependencies(repo.project),
			(error) =>
				error.code === REFUSED.code &&
				error.message.includes("keys") &&
				!error.message.includes(ssh),
		);
	});

	it("refuses a directory outside the project's parent", () => {
		const outside = tempDir("switchyard-path-deps-outside-");
		const repo = fixture(`far = { path = ${JSON.stringify(outside)} }`);
		throws(() => declaredPathDependencies(repo.project), REFUSED);
	});

	it("refuses a symlink in the parent that resolves outside it", () => {
		const outside = tempDir("switchyard-path-deps-outside-");
		const repo = fixture('link = { path = "../link" }');
		symlinkSync(outside, join(repo.root, "link"));
		throws(() => declaredPathDependencies(repo.project), REFUSED);
	});

	for (const name of [".env", ".env.local", ".netrc", "id_ed25519"]) {
		it(`refuses a dependency holding a top-level ${name}`, () => {
			const repo = fixture();
			writeFileSync(join(repo.sibling, name), "not-a-real-secret\n");
			throws(
				() => declaredPathDependencies(repo.project),
				(error) =>
					error.code === REFUSED.code &&
					error.message.includes("sibling") &&
					!error.message.includes(name),
			);
		});
	}

	it("allows .git/config below the dependency's top level", () => {
		const repo = fixture();
		mkdirSync(join(repo.sibling, ".git"));
		writeFileSync(join(repo.sibling, ".git", "config"), "[core]\n");
		deepStrictEqual(declaredPathDependencies(repo.project), [
			realpathSync(repo.sibling),
		]);
	});

	for (const [label, path, setup] of [
		[
			"a dot-directory",
			"../.hidden",
			(root) => mkdirSync(join(root, ".hidden")),
		],
		["the parent itself", "..", () => {}],
		["a missing path", "../missing", () => {}],
		[
			"a file",
			"../wheel.whl",
			(root) => writeFileSync(join(root, "wheel.whl"), ""),
		],
	]) {
		it(`refuses ${label}`, () => {
			const repo = fixture(`dep = { path = ${JSON.stringify(path)} }`);
			setup(repo.root);
			throws(() => declaredPathDependencies(repo.project), REFUSED);
		});
	}
});

describe("venvPathEntries", () => {
	it("accepts only single-line .pth files naming an accepted path", () => {
		const repo = fixture();
		const other = join(repo.root, "other");
		mkdirSync(other);
		const site = join(
			repo.project,
			".venv",
			"lib",
			"python3.12",
			"site-packages",
		);
		mkdirSync(site, { recursive: true });
		const named = join(repo.sibling, "src");
		writeFileSync(join(site, "_sibling.pth"), `${named}\n`);
		writeFileSync(join(site, "_virtualenv.pth"), "import _virtualenv\n");
		writeFileSync(join(site, "_other.pth"), `${other}\n`);
		writeFileSync(join(site, "_twice.pth"), `${named}\n${named}\n`);
		writeFileSync(
			join(site, "__editable__.fixture.pth"),
			`${join(repo.project, "src")}\n`,
		);
		const accepted = declaredPathDependencies(repo.project);
		deepStrictEqual(venvPathEntries(repo.project, accepted), [named]);
		deepStrictEqual(venvPathEntries(repo.project, []), []);
	});
});

describe("sandboxed path dependencies", { skip: sandboxSkip }, () => {
	it("imports the sibling read-only through the project venv", {
		skip: nestedSandboxSkip,
	}, async (t) => {
		if (!python) {
			t.skip("python3 is unavailable on this host");
			return;
		}
		const repo = fixture();
		const venv = join(repo.project, ".venv");
		const created = spawnSync(python, ["-m", "venv", "--without-pip", venv], {
			encoding: "utf8",
		});
		strictEqual(created.status, 0, created.stderr);
		const site = sitePackages(venv);
		// uv's editable install names the dependency's src directory; the
		// unresolved /var path exercises the realpath comparison.
		writeFileSync(join(site, "_sibling.pth"), `${join(repo.sibling, "src")}\n`);
		const other = join(repo.root, "other");
		mkdirSync(join(other, "other"), { recursive: true });
		writeFileSync(join(other, "other", "__init__.py"), "\n");
		writeFileSync(join(other, "secret.txt"), "undeclared\n");
		writeFileSync(join(site, "_other.pth"), `${other}\n`);
		const module = join(repo.sibling, "src", "sibling", "__init__.py");
		const checks = checkSession(repo);
		try {
			await checks.prepare();
			const imported = await checks.run({
				command: '.venv/bin/python3 -c "import sibling; print(sibling.VALUE)"',
			});
			strictEqual(imported.code, 0, String(imported.stderr));
			strictEqual(String(imported.output).trim(), "sibling");
			const undeclaredImport = await checks.run({
				command: '.venv/bin/python3 -c "import other"',
			});
			strictEqual(undeclaredImport.success, false);
			const undeclaredRead = await checks.run({
				command: `cat ${join(other, "secret.txt")}`,
			});
			strictEqual(undeclaredRead.success, false);
			const write = await checks.run({
				command: `echo changed > ${join(repo.sibling, "written.txt")}`,
			});
			strictEqual(write.success, false);
			const append = await checks.run({ command: `echo x >> ${module}` });
			strictEqual(append.success, false);
		} finally {
			checks.remove();
		}
		ok(!existsSync(join(repo.sibling, "written.txt")));
		strictEqual(readFileSync(module, "utf8"), 'VALUE = "sibling"\n');
	});

	it("refuses the check session for a dependency holding .env", async () => {
		const repo = fixture();
		writeFileSync(join(repo.sibling, ".env"), "not-a-real-secret\n");
		const checks = checkSession(repo);
		await rejects(checks.prepare(), REFUSED);
		checks.remove();
	});

	it("refuses a check once an accepted dependency is swapped for a symlink", {
		skip: nestedSandboxSkip,
	}, async () => {
		const repo = fixture();
		const outside = tempDir("switchyard-path-deps-outside-");
		const checks = checkSession(repo);
		try {
			await checks.prepare();
			strictEqual((await checks.run({ command: "true" })).code, 0);
			renameSync(repo.sibling, `${repo.sibling}-moved`);
			symlinkSync(outside, repo.sibling);
			await rejects(checks.run({ command: "true" }), REFUSED);
		} finally {
			checks.remove();
		}
	});

	it("refuses the check session for $HOME/.ssh", async () => {
		const ssh = join(homedir(), ".ssh");
		const repo = fixture(`keys = { path = ${JSON.stringify(ssh)} }`);
		const checks = checkSession(repo);
		await rejects(checks.prepare(), REFUSED);
		checks.remove();
	});
});
