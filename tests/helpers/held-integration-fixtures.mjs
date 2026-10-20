// Shared fixtures for the held-integration tests: a one-file repository and a
// `simple --integrate hold` run whose provider and checks are doubles.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSimpleTask } from "../../src/switchyard/simple/index.mjs";
import { tempDir } from "./tempdir.mjs";

export function git(path, args) {
	return execFileSync("git", args, {
		cwd: path,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	}).trim();
}

export function commit(path, message = "fixture") {
	git(path, ["add", "."]);
	git(path, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		message,
	]);
}

export function heldFixture(prefix = "switchyard-held-") {
	const root = tempDir(prefix);
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	writeFileSync(join(projectPath, "b.txt"), "unrelated\n");
	git(projectPath, ["init", "-q"]);
	commit(projectPath);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

/** Run one simple task in hold mode; the provider rewrites a.txt. */
export function runHeld(repo, options = {}, dependencies = {}) {
	return runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["grep -q candidate a.txt"],
			deadlineMs: Date.now() + 120_000,
			integrateMode: "hold",
			...options,
		},
		{
			tmpdir: repo.root,
			route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
			resolveTargetIdentity: () => ({
				targetId: "codex",
				harnessKey: "codex",
				ambiguous: false,
			}),
			getInvocationDescriptor: () => ({
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: [],
			}),
			assertFundedRoute: () => {},
			executeProvider: async ({ worktreePath }) => {
				writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
				return { success: true, writerLifecycle: "stopped" };
			},
			runCheck: async () => ({ success: true, exitCode: 0 }),
			...dependencies,
		},
	);
}
