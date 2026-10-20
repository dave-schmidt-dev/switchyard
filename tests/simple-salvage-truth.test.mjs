// @test-phase: other
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { retainedWorktreeLoss } from "../src/switchyard/simple/failure-finalization.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Regression for simple-19592032 (2026-10-15): the result advertised
// `salvage_retained` and a partialWorktree whose directory did not exist, so
// the provider's diff was lost while the record still claimed it was kept.
// A retained claim now needs the checkout to exist at terminal time.

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const suite = tempDir("switchyard-salvage-truth-tests-");
process.env.SWITCHYARD_RUN_STORE_ROOT = join(suite, "runs");

function git(path, args) {
	execFileSync("git", args, { cwd: path, stdio: "ignore" });
}

function fixture() {
	const root = tempDir("switchyard-salvage-truth-");
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

// The provider leaves an undeclared manifest, so the diff is refused and the
// checkout would be retained; `afterCapture` runs once the diff is captured.
async function runRefusedDiff(afterCapture, { edit = true, ...extra } = {}) {
	const repo = fixture();
	const milestones = [];
	let worktreePath;
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
			runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
			onStatus: (event) => {
				if (event.milestone) milestones.push(event.milestone);
			},
			executeProvider: async (context) => {
				worktreePath = context.worktreePath;
				if (edit) {
					writeFileSync(join(worktreePath, "a.txt"), "candidate\n");
					writeFileSync(join(worktreePath, "extra.sh"), "extra\n");
				}
				return { success: true, writerLifecycle: "stopped" };
			},
			onVerifiedDiff: () => afterCapture?.(worktreePath),
			...extra,
		},
	);
	return { result, milestones, worktreePath };
}

test("a refused diff whose checkout still exists keeps its salvage claim", async () => {
	const { result, milestones, worktreePath } = await runRefusedDiff();
	strictEqual(result.failureReason, "undeclared_paths_changed");
	strictEqual(result.partialWorktree, worktreePath);
	ok(existsSync(worktreePath));
	strictEqual("partialWorktreeLoss" in result, false);
	ok(milestones.includes("salvage_retained"));
	strictEqual(milestones.includes("salvage_lost"), false);
	const record = await readRun(result.runId);
	strictEqual(record.worktree.state, "retained");
	rmSync(dirname(worktreePath), { recursive: true, force: true });
});

test("a checkout deleted before the terminal record is reported lost, not retained", async () => {
	let deletedRoot;
	const { result, milestones } = await runRefusedDiff((worktreePath) => {
		deletedRoot = dirname(worktreePath);
		rmSync(deletedRoot, { recursive: true, force: true });
	});
	// The refusal keeps its own machine reason; only the salvage claim changes.
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "undeclared_paths_changed");
	strictEqual(result.partialWorktree, null);
	strictEqual(result.partialWorktreeLoss, "worktree_missing");
	strictEqual(milestones.includes("salvage_retained"), false);
	ok(milestones.includes("salvage_lost"));
	strictEqual(result.recovery.cleanup.worktree.state, "removed");
	strictEqual(result.recovery.cleanup.worktree.path, null);
	const record = await readRun(result.runId);
	strictEqual(record.worktree.state, "removed");
	strictEqual(record.worktree.reason, "worktree_missing");
	strictEqual(record.worktree.retainedAt, null);
	strictEqual(record.cleanupState, "complete");
	strictEqual(existsSync(deletedRoot), false);
});

test("a checkout whose worktree alone vanished is lost and its root removed", async () => {
	let root;
	const { result } = await runRefusedDiff((worktreePath) => {
		root = dirname(worktreePath);
		rmSync(worktreePath, { recursive: true, force: true });
	});
	strictEqual(result.partialWorktree, null);
	strictEqual(result.partialWorktreeLoss, "worktree_missing");
	const record = await readRun(result.runId);
	strictEqual(record.worktree.state, "removed");
	strictEqual(record.worktree.reason, "worktree_missing");
	strictEqual(existsSync(root), false, "the leftover root is cleaned up");
});

test("a root that vanishes during a failed cleanup is recorded removed, not retained", async () => {
	let deletedRoot;
	const { result } = await runRefusedDiff(undefined, {
		edit: false,
		// The guarded cleanup loses the root yet reports a rejection, so the
		// one cleanup attempt is spent before the terminal backstop runs.
		cleanupSimpleWorktree: async (_id, claim) => {
			deletedRoot = claim.path;
			rmSync(claim.path, { recursive: true, force: true });
			return { removed: false, reason: "synthetic_cleanup_rejection" };
		},
	});
	strictEqual(result.status, "failed");
	strictEqual(result.failureReason, "empty_diff");
	strictEqual(existsSync(deletedRoot), false);
	strictEqual(result.partialWorktree, null);
	strictEqual(result.partialWorktreeLoss, "worktree_missing");
	strictEqual(result.recovery.cleanup.worktree.state, "removed");
	const record = await readRun(result.runId);
	strictEqual(record.worktree.state, "removed");
	strictEqual(record.worktree.reason, "worktree_missing");
	strictEqual(record.worktree.retainedAt, null);
});

test("only a proven-missing root or materialized worktree counts as lost", () => {
	const root = tempDir("switchyard-salvage-truth-probe-");
	const path = join(root, "worktree");
	const loss = (input) => retainedWorktreeLoss({ path, root, ...input });
	// Before the clone, the allocated root alone is the retained claim.
	strictEqual(loss({ materialized: false }), null);
	strictEqual(loss({ materialized: true }), "worktree_missing");
	mkdirSync(path);
	strictEqual(loss({ materialized: true }), null);
	strictEqual(
		loss({ root: join(root, "gone"), materialized: false }),
		"worktree_missing",
	);
	deepStrictEqual(
		[undefined, null, "", 42].map((value) =>
			retainedWorktreeLoss({ path: value, root: join(root, "gone") }),
		),
		[null, null, null, null],
	);
});
