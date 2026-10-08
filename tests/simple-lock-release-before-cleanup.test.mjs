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

function waitForCleanupReady(child, timeoutMs) {
	return new Promise((resolveReady, rejectReady) => {
		let output = "";
		const finish = (error, value) => {
			clearTimeout(timer);
			child.stdout.off("data", onData);
			child.off("exit", onExit);
			child.off("error", onError);
			if (error) rejectReady(error);
			else resolveReady(value);
		};
		const onData = (chunk) => {
			output += chunk.toString("utf8");
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			try {
				finish(null, JSON.parse(output.slice(0, newline)));
			} catch {
				finish(new Error("cleanup_ready_marker_invalid"));
			}
		};
		const onExit = () =>
			finish(new Error("child_exited_before_cleanup_marker"));
		const onError = () => finish(new Error("child_start_failed"));
		const timer = setTimeout(
			() => finish(new Error("cleanup_ready_marker_timeout")),
			timeoutMs,
		);
		child.stdout.on("data", onData);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function waitForChildExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	return new Promise((resolveExit, rejectExit) => {
		const finish = (error, value) => {
			clearTimeout(timer);
			child.off("exit", onExit);
			child.off("error", onError);
			if (error) rejectExit(error);
			else resolveExit(value);
		};
		const onExit = (code, signal) => finish(null, { code, signal });
		const onError = () => finish(new Error("child_wait_failed"));
		const timer = setTimeout(
			() => finish(new Error("child_exit_timeout")),
			timeoutMs,
		);
		child.once("exit", onExit);
		child.once("error", onError);
	});
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

	it("releases the real project lock before its cleanup child is SIGKILLed", async () => {
		const repo = makeRepo();
		const runId = `simple-lock-release-killed-${randomUUID()}`;
		const nextRunId = `${runId}-next`;
		const simpleUrl = new URL(
			"../src/switchyard/simple/index.mjs",
			import.meta.url,
		).href;
		const runStoreUrl = new URL(
			"../src/switchyard/run-store/index.mjs",
			import.meta.url,
		).href;
		const childScript = `
			import { runSimpleTask } from ${JSON.stringify(simpleUrl)};
			import { acquireProjectLock, releaseProjectLockIfOwnedBy } from ${JSON.stringify(runStoreUrl)};
			import { rmSync, writeFileSync } from "node:fs";
			import { join } from "node:path";
			const watchdog = setTimeout(() => process.exit(73), 12_000);
			const projectPath = ${JSON.stringify(repo.projectPath)};
			const promptPath = ${JSON.stringify(repo.promptPath)};
			const runId = ${JSON.stringify(runId)};
		try {
			await runSimpleTask(
			{
				promptPath,
				projectPath,
				capability: "standard",
				files: ["src/a.txt"],
				checks: ["test -f src/a.txt"],
				deadlineMs: 100_000,
			},
			{
				now: () => 1_000,
				runId,
				taskId: "simple-lock-release-killed",
				attemptId: "attempt-1",
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
					writeFileSync(join(worktreePath, "src", "a.txt"), "provider");
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				cleanupSimpleWorktree: async (_id, claim) => {
					process.stdout.write(JSON.stringify({ ready: true, path: claim.path }) + "\\n");
					await new Promise((resolve) => setTimeout(resolve, 6_000));
					rmSync(claim.path, { recursive: true, force: true });
					return { removed: true, path: claim.path };
				},
			},
			);
		} finally {
			clearTimeout(watchdog);
		}
		`;
		const child = spawn(
			process.execPath,
			["--input-type=module", "-e", childScript],
			{
				cwd: process.cwd(),
				env: { ...process.env, TMPDIR: SUITE_TMPDIR },
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		let cleanupPath;
		let exited = false;
		try {
			const ready = await waitForCleanupReady(child, 5_000);
			strictEqual(ready.ready, true);
			cleanupPath = resolve(ready.path);
			strictEqual(cleanupPath.startsWith(`${SUITE_TMPDIR}/`), true);
			strictEqual(cleanupPath === repo.projectPath, false);
			strictEqual(child.exitCode, null);
			strictEqual(child.signalCode, null);
			strictEqual(isProjectLockHeld(repo.projectPath), false);
			strictEqual(child.kill("SIGKILL"), true);
			const exit = await waitForChildExit(child, 3_000);
			strictEqual(exit.code, null);
			strictEqual(exit.signal, "SIGKILL");
			exited = true;
			await acquireProjectLock(repo.projectPath, nextRunId);
			strictEqual(
				await releaseProjectLockIfOwnedBy(repo.projectPath, nextRunId),
				true,
			);
		} finally {
			if (!exited && child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await waitForChildExit(child, 3_000).catch(() => {});
			}
			if (
				cleanupPath?.startsWith(`${SUITE_TMPDIR}/`) &&
				cleanupPath !== repo.projectPath
			)
				rmSync(cleanupPath, { recursive: true, force: true });
		}
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
