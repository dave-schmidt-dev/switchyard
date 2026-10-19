/**
 * Shared fixtures for the path-dependency grant tests: a project beside a
 * sibling dependency under one temporary parent, and linked worktrees of it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./tempdir.mjs";

export const REFUSED = { code: "check_dependencies_unverified" };
export const refusal = (dependencyCheck) => ({ ...REFUSED, dependencyCheck });

export function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

/**
 * A project beside a sibling path dependency, both under one parent. `sources`
 * may be a function of the fixture paths; `gitDir` names a separate git dir.
 */
export function fixture(
	sources = 'sibling = { path = "../sibling", editable = true }',
	{ gitDir = null } = {},
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
	const declared =
		typeof sources === "function" ? sources({ root, sibling }) : sources;
	writeFileSync(
		join(project, "pyproject.toml"),
		`[project]\nname = "fixture"\n\n[tool.uv.sources]\n${declared}\n`,
	);
	writeFileSync(join(project, ".gitignore"), ".venv\n");
	if (gitDir) mkdirSync(dirname(join(root, gitDir)), { recursive: true });
	git(project, [
		"init",
		"-q",
		...(gitDir ? [`--separate-git-dir=${join(root, gitDir)}`] : []),
	]);
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

/** A linked worktree nested inside the project, as Claude Code places one. */
export function linkedWorktree(repo, name = "wt") {
	const worktree = join(repo.project, ".claude", "worktrees", name);
	git(repo.project, ["worktree", "add", "-q", "--detach", worktree]);
	return worktree;
}

export const absoluteSibling = ({ sibling }) =>
	`sibling = { path = ${JSON.stringify(sibling)}, editable = true }`;
