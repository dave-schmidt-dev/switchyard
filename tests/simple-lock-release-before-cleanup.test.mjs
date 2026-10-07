import { deepStrictEqual, strictEqual } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
	acquireProjectLock,
	advanceState,
	getStateRoot,
	initializeRun,
	isProjectLockHeld,
	readRun,
	releaseProjectLockIfOwnedBy,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdir = process.env.TMPDIR;
const originalRunStore = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-lock-release-suite-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");

after(() => {
	process.env.TMPDIR = originalTmpdir;
	if (originalRunStore === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStore;
	rmSync(SUITE_TMPDIR, { recursive: true, force: true });
});

function makeRepo() {
	const root = tempDir("switchyard-lock-release-repo-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n", "utf8");
	const git = (...args) =>
		execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
	git("init", "-q");
	git("add", "-A");
	git(
		"-c",
		"user.name=Switchyard Tests",
		"-c",
		"user.email=switchyard@example.invalid",
		"commit",
		"-qm",
		"base",
	);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change src/a.txt", "utf8");
	return { projectPath, promptPath };
}

function runWithThrowingCleanup(repo, runId, { failTerminal, onStatus }) {
	const observed = { lockHeldAtCleanup: null, cleanupCalls: 0 };
	const running = runSimpleTask(
		{
			promptPath: repo.promptPath,
			projectPath: repo.projectPath,
			capability: "standard",
			files: ["src/a.txt"],
			checks: ["test -f src/a.txt"],
			deadlineMs: 100_000,
		},
		{
			now: () => 1_000,
			runId,
			taskId: "simple-lock-release",
			attemptId: "attempt-1",
			onStatus,
			// Real run-store lock functions: the fixture proves on-disk state.
			acquireProjectLock,
			releaseProjectLock: releaseProjectLockIfOwnedBy,
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
				writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
				return { success: true, code: 0, writerLifecycle: "stopped" };
			},
			updateRunWithRetry: async (id, patch) => {
				if (failTerminal && patch.worktree?.state === "active")
					throw new Error("synthetic active-state write failure");
				return updateRunWithRetry(id, patch);
			},
			cleanupSimpleWorktree: async (_id, claim) => {
				observed.cleanupCalls += 1;
				observed.lockHeldAtCleanup = isProjectLockHeld(repo.projectPath);
				rmSync(claim.path, { recursive: true, force: true });
				throw new Error("synthetic worktree cleanup failure");
			},
		},
	);
	return { running, observed };
}

describe("simple run releases the project lock before slow cleanup", () => {
	it("releases before cleanup on a failed run whose cleanup throws", async () => {
		const repo = makeRepo();
		const runId = `simple-lock-release-failed-${Date.now()}`;
		const { running, observed } = runWithThrowingCleanup(repo, runId, {
			failTerminal: true,
		});
		const result = await running;
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "run_store_write_failed");
		strictEqual((await readRun(runId)).state, "failed");
		strictEqual(observed.cleanupCalls, 1);
		strictEqual(observed.lockHeldAtCleanup, false);
		strictEqual(result.recovery.cleanup.projectLock.state, "released");
		strictEqual(isProjectLockHeld(repo.projectPath), false);
		await acquireProjectLock(repo.projectPath, `${runId}-next`);
		strictEqual(
			await releaseProjectLockIfOwnedBy(repo.projectPath, `${runId}-next`),
			true,
		);
	});

	it("releases before cleanup on a succeeded run whose cleanup throws", async () => {
		const repo = makeRepo();
		const runId = `simple-lock-release-succeeded-${Date.now()}`;
		const { running, observed } = runWithThrowingCleanup(repo, runId, {
			failTerminal: false,
		});
		const result = await running;
		strictEqual(result.status, "succeeded");
		strictEqual((await readRun(runId)).state, "succeeded");
		strictEqual(observed.cleanupCalls, 1);
		strictEqual(observed.lockHeldAtCleanup, false);
		strictEqual(result.recovery.cleanup.projectLock.state, "released");
		await acquireProjectLock(repo.projectPath, `${runId}-next`);
		strictEqual(
			await releaseProjectLockIfOwnedBy(repo.projectPath, `${runId}-next`),
			true,
		);
	});

	it("surfaces project_lock_reclaimed when a run reclaims a dead holder's lock", async () => {
		const repo = makeRepo();
		const oldRunId = randomUUID();
		await initializeRun({
			runId: oldRunId,
			tasksFilePath: join(SUITE_TMPDIR, "tasks.md"),
			projectPath: repo.projectPath,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: "test-host",
		});
		await advanceState(oldRunId, "failed");
		const holder = spawn(process.execPath, ["-e", "process.exit(0)"], {
			stdio: "ignore",
		});
		await once(holder, "exit");
		const hash = createHash("sha256")
			.update(`project:${resolve(repo.projectPath)}`)
			.digest("hex");
		mkdirSync(join(getStateRoot(), "locks"), { recursive: true });
		writeFileSync(
			join(getStateRoot(), "locks", `${hash}.lock`),
			JSON.stringify({
				runId: oldRunId,
				createdAt: new Date().toISOString(),
				projectPath: repo.projectPath,
				holderPid: holder.pid,
				holderHost: hostname(),
			}),
			{ mode: 0o600 },
		);
		const statuses = [];
		const runId = `simple-lock-reclaim-${Date.now()}`;
		const { running } = runWithThrowingCleanup(repo, runId, {
			failTerminal: false,
			onStatus: (status) => statuses.push(status),
		});
		const result = await running;
		strictEqual(result.status, "succeeded");
		deepStrictEqual(
			statuses
				.filter((status) => status.milestone === "project_lock_reclaimed")
				.map(({ phase, reclaimedRunId }) => ({ phase, reclaimedRunId })),
			[{ phase: "preflight", reclaimedRunId: oldRunId }],
		);
		strictEqual(isProjectLockHeld(repo.projectPath), false);
	});
});
