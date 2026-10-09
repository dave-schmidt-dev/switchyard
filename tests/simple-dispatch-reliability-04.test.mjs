import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { updateRunWithRetry } from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { simpleQuarantinePath } from "../src/switchyard/simple/worktree-cleanup.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdirEnv = process.env.TMPDIR;
const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const ORIGINAL_REAL_TMPDIR = realpathSync(tmpdir());
function listRealTmpSimpleDirectoryNames(
	dir = ORIGINAL_REAL_TMPDIR,
	prefix = "switchyard-simple-",
) {
	return new Set(
		readdirSync(dir, { withFileTypes: true })
			.filter((dirent) => dirent.name.startsWith(prefix))
			.map((dirent) => dirent.name),
	);
}
function findNewSimpleRoots(
	initialSnapshot,
	currentEntries,
	prefix = "switchyard-simple-",
) {
	const initialSet =
		initialSnapshot instanceof Set ? initialSnapshot : new Set(initialSnapshot);
	return Array.from(currentEntries).filter(
		(name) => name.startsWith(prefix) && !initialSet.has(name),
	);
}
function assertNoLeakedSimpleRoots(initialSnapshot, currentEntries, prefix) {
	const leaked = findNewSimpleRoots(initialSnapshot, currentEntries, prefix);
	deepStrictEqual(
		leaked,
		[],
		`isolated simple tests leaked real temp roots: ${leaked.join(", ")}`,
	);
}
const initialRealTmpSimpleRoots =
	listRealTmpSimpleDirectoryNames(ORIGINAL_REAL_TMPDIR);
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-suite-tmp-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");

const retainedWorktrees = [];
function makeRepo() {
	const root = tempDir("switchyard-simple-test-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n", "utf8");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change src/a.txt", "utf8");
	return { root, projectPath, promptPath };
}
function options(repo, overrides = {}) {
	return {
		promptPath: repo.promptPath,
		projectPath: repo.projectPath,
		capability: "standard",
		files: ["src/a.txt"],
		checks: ["test -f src/a.txt"],
		deadlineMs: 100_000,
		...overrides,
	};
}

function dependencies(overrides = {}) {
	return {
		now: () => 1_000,
		taskId: "simple-test",
		attemptId: "attempt-1",
		acquireProjectLock: async () => {},
		releaseProjectLock: async () => true,
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
			writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n", "utf8");
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		...overrides,
	};
}
function retain(result, projectPath) {
	if (result.partialWorktree) {
		retainedWorktrees.push({
			projectPath,
			worktreePath: result.partialWorktree,
		});
	}
}
afterEach(() => {
	for (const { worktreePath } of retainedWorktrees.splice(0)) {
		const root = dirname(resolve(worktreePath));
		if (
			dirname(root) === SUITE_TMPDIR &&
			basename(root).startsWith("switchyard-simple-")
		) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {}
		}
	}
	if (existsSync(SUITE_TMPDIR)) {
		for (const entry of readdirSync(SUITE_TMPDIR)) {
			if (/^switchyard-simple-[0-9a-f-]{36}$/u.test(entry)) {
				try {
					rmSync(join(SUITE_TMPDIR, entry), { recursive: true, force: true });
				} catch {}
			}
		}
	}
});
after(() => {
	const ownQuarantineRoots = [];
	const ownRealTmpRoots = [];
	const runsDir = join(SUITE_TMPDIR, "run-store", "runs");
	if (existsSync(runsDir)) {
		for (const entry of readdirSync(runsDir)) {
			const recordPath = join(runsDir, entry, "run.json");
			if (!existsSync(recordPath)) continue;
			const record = JSON.parse(readFileSync(recordPath, "utf8"));
			const recordedPath = record.worktree?.path;
			if (
				typeof recordedPath === "string" &&
				dirname(recordedPath) ===
					join(ORIGINAL_REAL_TMPDIR, "switchyard-simple-roots") &&
				existsSync(recordedPath)
			)
				ownRealTmpRoots.push(recordedPath);
			if (record.worktree?.nonce) {
				const quarantine = simpleQuarantinePath(record.worktree.nonce);
				if (existsSync(quarantine)) ownQuarantineRoots.push(quarantine);
			}
		}
	}
	if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdirEnv;
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	try {
		rmSync(SUITE_TMPDIR, { recursive: true, force: true });
	} catch {}

	const syntheticRoot = "switchyard-simple-synthetic-leak-check";
	deepStrictEqual(
		findNewSimpleRoots(initialRealTmpSimpleRoots, [
			...initialRealTmpSimpleRoots,
			syntheticRoot,
		]),
		[syntheticRoot],
	);
	throws(
		() =>
			assertNoLeakedSimpleRoots(initialRealTmpSimpleRoots, [
				...initialRealTmpSimpleRoots,
				syntheticRoot,
			]),
		/isolated simple tests leaked real temp roots/,
	);

	deepStrictEqual(
		ownRealTmpRoots,
		[],
		"simple tests leaked owned real temp roots",
	);
	deepStrictEqual(
		ownQuarantineRoots,
		[],
		"simple tests leaked owned quarantines",
	);
});
describe("simple local execution path", () => {
	describe("simple dispatch reliability and regression invariants (SW-R1)", () => {
		it("fails at integration when untracked predecessor output drifts on host", async () => {
			const repo = makeRepo();
			const untrackedPath = join(repo.projectPath, "src", "pred.txt");
			const originalContent = "predecessor content\n";
			const predecessor = await runSimpleTask(
				options(repo, {
					files: ["src/pred.txt"],
					checks: ["test -f src/pred.txt"],
				}),
				dependencies({
					taskId: "predecessor-drift-producer",
					runId: "simple-predecessor-drift-producer",
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "pred.txt"),
							originalContent,
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			strictEqual(predecessor.status, "succeeded");
			const receiptPath = join(repo.root, "pred-receipt.json");
			writeFileSync(receiptPath, JSON.stringify(predecessor), "utf8");

			const result = await runSimpleTask(
				options(repo, {
					files: ["src/pred.txt"],
					dirtyOverlay: true,
					predecessorReceipt: receiptPath,
				}),
				dependencies({
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "pred.txt"),
							"provider modification\n",
							"utf8",
						);
						// Host file drifts during provider execution
						writeFileSync(untrackedPath, "host drift content\n", "utf8");
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "dirty_overlay_drift");
			strictEqual(result.failurePhase, "integrate");
		});
		it("run-store write fault before preflight cannot launch provider", async () => {
			const repo = makeRepo();
			let providerLaunched = false;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					initializeRun: async () => {
						throw new Error("disk full");
					},
					executeProvider: async () => {
						providerLaunched = true;
						return { success: true };
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.errorKind, "run_store_write_failed");
			strictEqual(result.failurePhase, "preflight");
			strictEqual(providerLaunched, false);
		});
		it("run-store write fault at terminal success cannot publish success", async () => {
			const repo = makeRepo();
			const durablePatches = [];
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
					updateRunWithRetry: async (_runId, patch) => {
						durablePatches.push(patch);
						if (patch.state === "succeeded") {
							throw new Error("run-store write error");
						}
						return patch;
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.errorKind, "run_store_write_failed");
			strictEqual(result.failurePhase, "cleanup");
			ok(result.partialWorktree);
			strictEqual(existsSync(dirname(result.partialWorktree)), true);
			ok(
				durablePatches.some(
					(patch) =>
						patch.state === "running" &&
						patch.cleanupState === "pending" &&
						patch.terminalSummary?.status === "integration_applied",
				),
				"host integration must be durable before terminal publication",
			);
		});
		it("retains an empty-result root when its failed terminal receipt is not durable", async () => {
			const repo = makeRepo();
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					executeProvider: async () => ({
						success: true,
						code: 0,
						writerLifecycle: "stopped",
						providerLifecycle: {
							terminalStatus: "exited",
							exitCode: 0,
							writerLifecycle: "stopped",
						},
					}),
					updateRunWithRetry: async (runId, patch) => {
						if (patch.state === "failed")
							throw new Error("terminal receipt unavailable");
						return updateRunWithRetry(runId, patch);
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "empty_diff");
			strictEqual(result.providerLifecycle?.exitCode, 0);
			ok(result.partialWorktree);
			strictEqual(existsSync(dirname(result.partialWorktree)), true);
		});
	});
});
