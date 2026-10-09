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
import { open, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	getRunRoot,
	readRun,
	runStoreTesting,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
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
		for (const fault of ["file", "directory"]) {
			it(`does not allocate a root when intent ${fault} sync fails`, async () => {
				const repo = makeRepo();
				const runId = `simple-sync-${fault}-${Date.now()}`;
				let mkdirCalled = false;
				let providerCalled = false;
				let injected = false;
				let candidatePath;
				const result = await runSimpleTask(
					options(repo),
					dependencies({
						runId,
						updateRunWithRetry: async (id, patch) => {
							if (patch.worktree?.state !== "allocating")
								return updateRunWithRetry(id, patch);
							candidatePath = patch.worktree.path;
							const current = await readRun(id);
							return runStoreTesting.writeRunAtomically(
								join(getRunRoot(id), "run.json"),
								{
									...current,
									...patch,
									revision: current.revision + 1,
								},
								{
									rename,
									unlink,
									open: async (path, flags, mode) => {
										const handle = await open(path, flags, mode);
										return {
											writeFile: (...args) => handle.writeFile(...args),
											close: () => handle.close(),
											sync: async () => {
												if ((flags === "r") === (fault === "directory")) {
													injected = true;
													throw Object.assign(
														new Error("injected sync failure"),
														{ code: "EIO" },
													);
												}
												await handle.sync();
											},
										};
									},
								},
							);
						},
						mkdirSync: () => {
							mkdirCalled = true;
						},
						executeProvider: async () => {
							providerCalled = true;
						},
					}),
				);
				strictEqual(injected, true);
				strictEqual(result.status, "failed");
				strictEqual(result.failureReason, "run_store_write_failed");
				strictEqual(result.failurePhase, "prepare");
				strictEqual(mkdirCalled, false);
				strictEqual(providerCalled, false);
				strictEqual(existsSync(candidatePath), false);
			});
		}
		it("persists final cleanup for an initialized route failure with no clone", async () => {
			const repo = makeRepo();
			const runId = `simple-no-clone-${Date.now()}`;
			const patches = [];
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					runId,
					route: () => {
						throw new Error("synthetic route failure");
					},
					updateRunWithRetry: async (id, patch) => {
						patches.push(structuredClone(patch));
						return updateRunWithRetry(id, patch);
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.recovery.cleanup.worktree.state, "not_created");
			const terminal = patches.find((patch) => patch.state === "failed");
			strictEqual(terminal.cleanupState, "pending");
			strictEqual(patches.at(-1).cleanupState, "complete");
			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.cleanupState, "complete");
			strictEqual(run.worktree, null);
		});
		it("retains an allocated candidate when terminal persistence fails", async () => {
			const repo = makeRepo();
			const runId = `simple-terminal-write-failed-${Date.now()}`;
			let removed = false;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					runId,
					updateRunWithRetry: async (id, patch) => {
						if (patch.worktree?.state === "active" || patch.state === "failed")
							throw new Error("synthetic persistence failure");
						return updateRunWithRetry(id, patch);
					},
					rmSync: () => {
						removed = true;
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, "failed");
			strictEqual(removed, false);
			ok(existsSync(dirname(result.partialWorktree)));
			const run = await readRun(runId);
			strictEqual(run.cleanupState, "pending");
			strictEqual(run.worktree.state, "retained");
			strictEqual(result.cleanupState, "pending");
		});
		it("waits for terminal cleanup intent before removing an allocated candidate", async () => {
			const repo = makeRepo();
			const runId = `simple-interrupted-terminal-${Date.now()}`;
			let terminalResolve;
			let terminalObserved;
			const terminalStarted = new Promise((resolve) => {
				terminalObserved = resolve;
			});
			let removed = false;
			let observedCleanup;
			const running = runSimpleTask(
				options(repo),
				dependencies({
					runId,
					updateRunWithRetry: async (id, patch) => {
						if (patch.worktree?.state === "active")
							throw new Error("synthetic active-state failure");
						if (patch.state === "failed") {
							terminalObserved();
							await new Promise((resolve) => {
								terminalResolve = resolve;
							});
						}
						return updateRunWithRetry(id, patch);
					},
					cleanupSimpleWorktree: async (_id, claim) => {
						const run = await readRun(runId);
						observedCleanup = {
							state: run.state,
							cleanupState: run.cleanupState,
						};
						removed = true;
						rmSync(claim.path, { recursive: true, force: true });
						return { removed: true, path: claim.path };
					},
				}),
			);
			await terminalStarted;
			strictEqual(removed, false);
			strictEqual((await readRun(runId)).worktree.state, "allocating");
			terminalResolve();
			const result = await running;
			strictEqual(result.status, "failed");
			strictEqual(removed, true);
			deepStrictEqual(observedCleanup, {
				state: "failed",
				cleanupState: "pending",
			});
			strictEqual((await readRun(runId)).cleanupState, "complete");
		});
		it("leaves durable cleanup pending when final no-clone disposition cannot be written", async () => {
			const repo = makeRepo();
			const runId = `simple-cleanup-write-failed-${Date.now()}`;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					runId,
					route: () => {
						throw new Error("synthetic route failure");
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.cleanupState === "complete")
							throw new Error("synthetic cleanup write failure");
						return updateRunWithRetry(id, patch);
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.cleanupState, "pending");
			strictEqual((await readRun(runId)).cleanupState, "pending");
		});
		it("preserves applied success and complete cleanup", async () => {
			const repo = makeRepo();
			const runId = `simple-success-finalization-${Date.now()}`;
			const result = await runSimpleTask(
				options(repo, { checks: [] }),
				dependencies({ runId }),
			);
			strictEqual(result.status, "succeeded");
			strictEqual(
				readFileSync(join(repo.projectPath, "src/a.txt"), "utf8"),
				"provider\n",
			);
			const run = await readRun(runId);
			strictEqual(run.state, "succeeded");
			strictEqual(run.cleanupState, "complete");
			strictEqual(run.worktree.state, "removed");
		});
		it("keeps the failed checker intact when terminal persistence fails", async () => {
			const repo = makeRepo();
			const runId = `simple-checker-terminal-failed-${Date.now()}`;
			const result = await runSimpleTask(
				options(repo, { checks: ["false"] }),
				dependencies({
					runId,
					updateRunWithRetry: async (id, patch) => {
						if (patch.state === "failed")
							throw new Error("synthetic terminal write failure");
						return updateRunWithRetry(id, patch);
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.failureReason, "check_failed");
			ok(result.partialWorktree);
			const root = dirname(result.partialWorktree);
			ok(
				readdirSync(root).some((name) => name.startsWith("checker-")),
				"failed terminal write must preserve the disposable checker",
			);
			strictEqual((await readRun(runId)).cleanupState, "pending");
		});
		it("reflects unreleased project lock independently on no-clone failure", async () => {
			const repo = makeRepo();
			const runId = `simple-no-clone-lock-${Date.now()}`;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					runId,
					route: () => {
						throw new Error("synthetic route failure");
					},
					releaseProjectLock: async () => false,
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.recovery.cleanup.projectLock.state, "unavailable");
			strictEqual(result.recovery.cleanup.worktree.state, "not_created");
			strictEqual((await readRun(runId)).cleanupState, "failed");
		});
		it("retains salvage and records retained worktree state when checks fail", async () => {
			const repo = makeRepo();
			const taskId = `worktree-salvage-${Date.now()}`;
			const runId = `simple-${taskId}`;

			const result = await runSimpleTask(
				options(repo, { checks: ["false"] }),
				dependencies({
					taskId,
					runId,
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "check_failed");
			ok(result.partialWorktree);

			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.worktree.state, "retained");
			strictEqual(run.worktree.reason, "check_failed");
			ok(typeof run.worktree.retainedAt === "string");
			strictEqual(run.cleanupState, "pending");
			strictEqual(join(run.worktree.path, "worktree"), result.partialWorktree);
			strictEqual(existsSync(run.worktree.path), true);
		});
		it("persists bounded cleanup failure when finally retains a failed run worktree", async () => {
			const repo = makeRepo();
			const runId = `simple-finally-cleanup-failure-${Date.now()}`;
			let cleanupPatch;

			const result = await runSimpleTask(
				options(repo),
				dependencies({
					runId,
					updateRunWithRetry: async (id, patch) => {
						if (patch.worktree?.state === "active")
							throw new Error("synthetic active-state write failure");
						if (patch.cleanupState === "failed")
							cleanupPatch = structuredClone(patch);
						return updateRunWithRetry(id, patch);
					},
					cleanupSimpleWorktree: async (_id, claim) => ({
						removed: false,
						reason: "synthetic_cleanup_rejection",
						path: claim.path,
					}),
				}),
			);
			retain(result, repo.projectPath);

			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "run_store_write_failed");
			ok(result.partialWorktree);
			ok(cleanupPatch, "finally attempted the terminal cleanup write");

			const run = await readRun(runId);
			strictEqual(run.cleanupState, "failed");
			strictEqual(run.cleanupFailure.errorKind, "cleanup_failed");
			strictEqual(run.cleanupFailure.failurePhase, "cleanup");
			strictEqual(run.cleanupFailure.result, "worktree_cleanup_failed");
			deepStrictEqual(Object.keys(run.cleanupFailure).sort(), [
				"errorKind",
				"failurePhase",
				"reason",
				"reasonCode",
				"result",
			]);
			ok(run.cleanupFailure.reason.length <= 256);
			strictEqual(run.worktree.state, "retained");
			strictEqual(run.worktree.reason, "synthetic_cleanup_rejection");
			strictEqual(join(run.worktree.path, "worktree"), result.partialWorktree);
			ok(typeof run.worktree.retainedAt === "string");
			strictEqual(existsSync(run.worktree.path), true);
		});
	});
});
