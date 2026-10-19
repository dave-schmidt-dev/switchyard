// @test-phase: other
import { deepStrictEqual, throws } from "node:assert";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { declaredPathDependencies } from "../src/switchyard/simple/path-dependencies.mjs";
import {
	absoluteSibling,
	fixture,
	git,
	linkedWorktree,
	refusal,
} from "./helpers/path-dependency-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const UNVERIFIED = "path_dependency_worktree_unverified";

function commitAll(cwd) {
	git(cwd, ["add", "-A"]);
	git(cwd, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"change",
	]);
}

describe("declaredPathDependencies from a linked worktree", () => {
	it("grants a worktree exactly its main checkout's sibling", () => {
		const repo = fixture(absoluteSibling);
		const worktree = linkedWorktree(repo);
		const sibling = [realpathSync(repo.sibling)];
		deepStrictEqual(declaredPathDependencies(worktree), sibling);
		deepStrictEqual(declaredPathDependencies(repo.project), sibling);
	});

	it("still refuses a dependency outside the main checkout's parent", () => {
		const outside = tempDir("switchyard-path-deps-outside-");
		const repo = fixture(`far = { path = ${JSON.stringify(outside)} }`);
		throws(
			() => declaredPathDependencies(linkedWorktree(repo)),
			refusal("path_dependency_outside_project_parent"),
		);
	});

	it("gives a worktree of a common dir not named .git no outside grant", () => {
		const repo = fixture(absoluteSibling, { gitDir: "store.git" });
		deepStrictEqual(declaredPathDependencies(repo.project), [
			realpathSync(repo.sibling),
		]);
		throws(
			() => declaredPathDependencies(linkedWorktree(repo)),
			refusal(UNVERIFIED),
		);
	});

	// Git names the main working tree by stripping `/.git` from the common dir,
	// so `storage` below would pass for the main checkout without the manifest
	// check (stability follow-up review, 2026-10-19).
	it("ignores a separate git dir named .git outside the checkout", () => {
		const repo = fixture(absoluteSibling, { gitDir: "storage/.git" });
		throws(
			() => declaredPathDependencies(linkedWorktree(repo)),
			refusal(UNVERIFIED),
		);
	});

	it("ignores a bare repository named .git", () => {
		const repo = fixture(absoluteSibling);
		const bare = join(repo.root, "hold", ".git");
		git(repo.root, ["clone", "-q", "--bare", repo.project, bare]);
		writeFileSync(join(repo.root, "hold", "pyproject.toml"), "");
		const worktree = join(repo.root, "worktrees", "wt");
		git(bare, ["worktree", "add", "-q", "--detach", worktree]);
		throws(() => declaredPathDependencies(worktree), refusal(UNVERIFIED));
	});

	it("ignores a .git file that borrows a registered worktree's admin dir", () => {
		const repo = fixture(absoluteSibling);
		const registered = linkedWorktree(repo);
		const forged = join(repo.project, ".claude", "worktrees", "forged");
		mkdirSync(forged);
		writeFileSync(
			join(forged, "pyproject.toml"),
			readFileSync(join(registered, "pyproject.toml")),
		);
		const admin = git(registered, [
			"rev-parse",
			"--path-format=absolute",
			"--git-dir",
		]);
		writeFileSync(join(forged, ".git"), `gitdir: ${admin}\n`);
		throws(() => declaredPathDependencies(forged), refusal(UNVERIFIED));
	});

	// Falling back to the worktree's own parent would grant `outer/lib`, which
	// its main checkout never could (Codex acceptance review, 2026-10-19).
	it("gives an unverified worktree no grant rather than its own parent", () => {
		const repo = fixture("");
		git(repo.project, ["rm", "-q", "pyproject.toml"]);
		writeFileSync(join(repo.project, "package.json"), "{}\n");
		commitAll(repo.project);
		const outer = tempDir("switchyard-path-deps-outer-");
		const worktree = join(outer, "wt");
		git(repo.project, ["worktree", "add", "-q", "--detach", worktree]);
		const lib = join(outer, "lib");
		mkdirSync(lib);
		// The worktree swaps the main checkout's manifest for a new one.
		unlinkSync(join(worktree, "package.json"));
		writeFileSync(
			join(worktree, "pyproject.toml"),
			`[tool.uv.sources]\nlib = { path = ${JSON.stringify(lib)} }\n`,
		);
		throws(() => declaredPathDependencies(worktree), refusal(UNVERIFIED));
	});

	it("maps a worktree subdirectory to the same directory in the main checkout", () => {
		const repo = fixture("");
		const shared = join(repo.project, "shared");
		mkdirSync(join(repo.project, "pkg"));
		mkdirSync(shared);
		writeFileSync(join(shared, "README"), "shared\n");
		const declare = (path) =>
			`[tool.uv.sources]\ndep = { path = ${JSON.stringify(path)} }\n`;
		writeFileSync(join(repo.project, "pkg", "pyproject.toml"), declare(shared));
		commitAll(repo.project);
		const worktree = linkedWorktree(repo);
		const pkg = join(worktree, "pkg");
		deepStrictEqual(declaredPathDependencies(pkg), [realpathSync(shared)]);
		// The main checkout's pkg/ may not read the sibling, so neither may the
		// worktree's.
		writeFileSync(join(pkg, "pyproject.toml"), declare(repo.sibling));
		throws(
			() => declaredPathDependencies(pkg),
			refusal("path_dependency_outside_project_parent"),
		);
	});

	// A subpackage's relative dependency on its own checkout resolves inside
	// the worktree, not the main checkout, and stays granted as before.
	it("keeps a subpackage's relative dependency on its own checkout", () => {
		const repo = fixture("");
		mkdirSync(join(repo.project, "pkg"));
		mkdirSync(join(repo.project, "shared"));
		writeFileSync(join(repo.project, "shared", "README"), "shared\n");
		const relativeShared = `[tool.uv.sources]\ndep = { path = "../shared" }\n`;
		writeFileSync(join(repo.project, "pkg", "pyproject.toml"), relativeShared);
		commitAll(repo.project);
		const outer = tempDir("switchyard-path-deps-outer-");
		const worktree = join(outer, "wt");
		git(repo.project, ["worktree", "add", "-q", "--detach", worktree]);
		const pkg = join(worktree, "pkg");
		deepStrictEqual(declaredPathDependencies(pkg), [
			realpathSync(join(worktree, "shared")),
		]);
		// Unverified (the main checkout's pkg/ lacks this manifest): the read
		// stays inside the worktree's own checkout, so it is still granted.
		unlinkSync(join(pkg, "pyproject.toml"));
		writeFileSync(
			join(pkg, "package.json"),
			'{"dependencies":{"dep":"file:../shared"}}\n',
		);
		deepStrictEqual(declaredPathDependencies(pkg), [
			realpathSync(join(worktree, "shared")),
		]);
		// Under .claude/worktrees the resolved path holds a dot-directory, which
		// refuses exactly as it did before worktrees were mapped.
		const pkgInDot = join(linkedWorktree(repo), "pkg");
		throws(
			() => declaredPathDependencies(pkgInDot),
			refusal("path_dependency_dot_directory"),
		);
	});
});
