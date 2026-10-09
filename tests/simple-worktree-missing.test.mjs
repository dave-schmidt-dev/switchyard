import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { createSimpleRouteHealthController } from "../src/switchyard/simple/health.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { SIMPLE_ROOTS_DIRNAME } from "../src/switchyard/simple/simple-root.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Regression for 2026-10-09: an outside `rm -rf` of the shared temp directory
// deleted a live checkout mid-run, and the run blamed the provider with
// `provider_group_unconfirmed`. A vanished root must report `worktree_missing`.

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const suite = tempDir("switchyard-worktree-missing-tests-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	execFileSync("git", args, { cwd: path, stdio: "ignore" });
}

function fixture() {
	const root = tempDir("switchyard-worktree-missing-");
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "a.txt"), "base\n");
	git(projectPath, ["init", "-q"]);
	git(projectPath, ["add", "."]);
	git(projectPath, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Change a.txt");
	return { root, projectPath, promptPath };
}

async function runWithVanishingRoot(providerSucceeds) {
	const repo = fixture();
	let deletedRoot;
	const healthTerminals = [];
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["a.txt"],
			checks: ["test -f a.txt"],
			deadlineMs: Date.now() + 180_000,
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
			createSimpleRouteHealthController: (options) => {
				const real = createSimpleRouteHealthController(options);
				const terminal = async (evidence) => {
					healthTerminals.push(evidence);
					return real.terminal(evidence);
				};
				// The controller is frozen, so observe it through a delegating copy.
				const observed = Object.create(null);
				for (const key of Object.keys(real))
					Object.defineProperty(observed, key, {
						get: () => (key === "terminal" ? terminal : real[key]),
					});
				return observed;
			},
			executeProvider: async ({ worktreePath }) => {
				deletedRoot = dirname(worktreePath);
				rmSync(deletedRoot, { recursive: true, force: true });
				return providerSucceeds
					? { success: true, writerLifecycle: "stopped" }
					: { success: false, code: 1, writerLifecycle: "stopped" };
			},
		},
	);
	return { result, repo, deletedRoot, healthTerminals };
}

for (const providerSucceeds of [true, false]) {
	test(`a checkout deleted mid-run reports worktree_missing (provider success=${providerSucceeds})`, async () => {
		const { result, repo, deletedRoot, healthTerminals } =
			await runWithVanishingRoot(providerSucceeds);
		// Route health sees the outside deletion, never a provider fault.
		strictEqual(healthTerminals.length, 1);
		const charged = healthTerminals[0].providerReliability;
		if (providerSucceeds) strictEqual(charged, null);
		else {
			strictEqual(charged.causeCode, "worktree_missing");
			strictEqual(charged.causeCategory, "environment");
		}
		strictEqual(result.providerReliability.causeCode, "worktree_missing");
		strictEqual(result.providerReliability.causeCategory, "environment");
		const record = await readRun(result.runId);
		strictEqual(record.cleanupState, "complete");
		strictEqual(record.worktree.state, "removed");
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "worktree_missing");
		strictEqual(dirname(deletedRoot), join(repo.root, SIMPLE_ROOTS_DIRNAME));
		strictEqual(existsSync(deletedRoot), false);
		strictEqual(
			readdirSync(join(repo.root, SIMPLE_ROOTS_DIRNAME)).length,
			0,
			"no replacement root is left behind",
		);
	});
}
