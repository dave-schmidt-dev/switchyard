import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import { runQuickChecks } from "../src/switchyard/runner/checks.mjs";
import { parseTaskQueue } from "../src/switchyard/runner/index.mjs";

const TEST_DIR = join(cwd(), ".switchyard-quick-check-test");
function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, { cwd: projectPath, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}
afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});
describe("Task 51 quick-check regression", () => {
	it("rejects missing, misspelled, nested, duplicate and unsupported declarations", () => {
		const contract = (declaration) => `### Task 51: Contract
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
${declaration}
`;
		for (const declaration of [
			"",
			"- **Quik checks:** none",
			"  - **Quick checks:** none",
			"- **Quick checks:** none\n- **Quick checks:** none",
			"- **Quick checks:** npm run lint && echo ok",
			"- **Quick checks:** none\n  - npm run lint",
			"- **Quick checks:** none\n- **Quick check setup:** npm ci --ignore-scripts --offline",
		]) {
			throws(() => parseTaskQueue(contract(declaration)), /Quick check/i);
		}
		deepStrictEqual(
			parseTaskQueue(contract("- **Quick checks:** none"))[0].quickChecks
				.checks,
			[],
		);
		deepStrictEqual(
			parseTaskQueue(`### Task 52: Review
- **Status:** pending
- **Type:** review
- **Executor:** switchyard
- **Quick checks:** none
`)[0].quickChecks.checks,
			[],
		);
	});
	it("reconstructs a prior accepted tree without copying an unrelated untracked file", () => {
		const project = join(TEST_DIR, "task-check-base");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
		writeFileSync(join(project, "check.mjs"), "export const check = 1;\n");
		runFixtureGit(project, ["init", "-q"]);
		runFixtureGit(project, ["add", "."]);
		runFixtureGit(project, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"base",
		]);
		writeFileSync(join(project, "a.mjs"), "export const a = 2;\n");
		writeFileSync(join(project, "b.mjs"), "export const b = 1;\n");
		runFixtureGit(project, ["add", "-A"]);
		const baseTree = runFixtureGit(project, ["write-tree"]);
		runFixtureGit(project, ["reset", "-q"]);
		writeFileSync(
			join(project, "local-untracked-secret.txt"),
			"local-only fixture\n",
		);
		writeFileSync(join(project, "check.mjs"), "export const check = 2;\n");
		const diff = runFixtureGit(project, ["diff", "--", "check.mjs"]);
		writeFileSync(join(project, "check.mjs"), "export const check = 1;\n");
		const input = {
			projectPath: project,
			taskId: "54",
			attempt: 1,
			baseTree,
			diff,
			checks: [["node", "--check", "check.mjs"]],
			allowedPaths: ["check.mjs"],
			snapshotPaths: ["a.mjs", "b.mjs"],
		};
		const passed = runQuickChecks(input);
		strictEqual(passed.status, "passed");
		strictEqual(passed.cleanup.status, "complete");
		strictEqual(
			runQuickChecks({ ...input, snapshotPaths: ["a.mjs"] }).failureCode,
			"base_mismatch",
		);
	});
});
