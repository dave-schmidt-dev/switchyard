import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_ROOT = tempDir("switchyard-durable-telemetry-");
const WORK_ROOT = join(SUITE_ROOT, "work");
mkdirSync(WORK_ROOT, { recursive: true });
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_ROOT, "run-store");

after(() => {
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	rmSync(SUITE_ROOT, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() >= deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function makeRepo() {
	const root = tempDir("switchyard-durable-telemetry-project-");
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
	return { projectPath, promptPath };
}

function options(repo, overrides = {}) {
	return {
		promptPath: repo.promptPath,
		projectPath: repo.projectPath,
		capability: "standard",
		files: ["src/a.txt"],
		checks: ["test -f src/a.txt"],
		deadlineMs: Date.now() + 120_000,
		...overrides,
	};
}

function dependencies(overrides = {}) {
	return {
		tmpdir: () => WORK_ROOT,
		taskId: "durable-telemetry-task",
		attemptId: "durable-telemetry-attempt",
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
		...overrides,
	};
}

function blockedProvider() {
	let enteredResolve;
	const entered = new Promise((resolve) => {
		enteredResolve = resolve;
	});
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	return {
		entered,
		release,
		onEntered: () => enteredResolve(),
		gate,
	};
}

it("persists running state, start timestamps and an observed heartbeat while the provider runs", async () => {
	const repo = makeRepo();
	const runId = `durable-running-${randomUUID()}`;
	const clock = Date.now();
	const provider = blockedProvider();
	let emitProgress = null;
	const pending = runSimpleTask(
		options(repo, { deadlineMs: clock + 120_000 }),
		dependencies({
			runId,
			now: () => clock,
			executeProvider: async ({ worktreePath, onProgress }) => {
				provider.onEntered();
				emitProgress = onProgress;
				onProgress();
				await provider.gate;
				writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n", "utf8");
				return { success: true, code: 0, writerLifecycle: "stopped" };
			},
			runCheck: async () => ({ success: true }),
		}),
	);
	await provider.entered;
	ok(typeof emitProgress === "function");
	const live = await waitFor(async () => {
		const record = await readRun(runId).catch(() => null);
		if (record?.state !== "running" || record.activeTaskHeartbeatAt === null)
			return null;
		return record;
	});
	ok(live, "provider run was never durably marked running");
	strictEqual(live.state, "running");
	strictEqual(live.activeTaskStartedAt, clock);
	strictEqual(live.activeTaskHeartbeatAt, clock);
	strictEqual(live.activeTaskElapsedMs, null);
	strictEqual(typeof live.startedAt, "string");
	ok(Number.isFinite(Date.parse(live.startedAt)));

	provider.release();
	const result = await pending;
	strictEqual(result.status, "succeeded");
	const final = await readRun(runId);
	strictEqual(final.state, "succeeded");
	strictEqual(final.activeTaskStartedAt, clock);
	strictEqual(final.activeTaskHeartbeatAt, clock);
	strictEqual(final.activeTaskElapsedMs, null);
	strictEqual(Object.hasOwn(final, "lastCompletionAt"), false);
});

it("throttles durable heartbeats to at most one per 30 seconds", async () => {
	const repo = makeRepo();
	const runId = `durable-throttle-${randomUUID()}`;
	let clock = Date.now();
	const provider = blockedProvider();
	let emitProgress = null;
	let observedWorktree = null;
	const pending = runSimpleTask(
		options(repo, { deadlineMs: clock + 120_000 }),
		dependencies({
			runId,
			now: () => clock,
			executeProvider: async (context) => {
				provider.onEntered();
				emitProgress = context.onProgress;
				observedWorktree = context.worktreePath;
				await provider.gate;
				writeFileSync(
					join(context.worktreePath, "src", "a.txt"),
					"provider\n",
					"utf8",
				);
				return { success: true, code: 0, writerLifecycle: "stopped" };
			},
			runCheck: async () => ({ success: true }),
		}),
	);
	await provider.entered;
	ok(typeof emitProgress === "function");
	const firstAt = clock;
	emitProgress();
	const firstPersisted = await waitFor(async () => {
		const record = await readRun(runId).catch(() => null);
		return record?.activeTaskHeartbeatAt === firstAt;
	});
	ok(firstPersisted, "first heartbeat was not persisted");

	clock = firstAt + 29_999;
	emitProgress();
	await new Promise((resolve) => setTimeout(resolve, 50));
	strictEqual((await readRun(runId)).activeTaskHeartbeatAt, firstAt);

	clock = firstAt + 30_000;
	emitProgress();
	const secondPersisted = await waitFor(async () => {
		const record = await readRun(runId).catch(() => null);
		return record?.activeTaskHeartbeatAt === firstAt + 30_000;
	});
	ok(secondPersisted, "heartbeat after the interval was not persisted");

	provider.release();
	const result = await pending;
	strictEqual(result.status, "succeeded");
	ok(observedWorktree);
});

it("keeps a terminal failure transition valid without writing lastCompletionAt", async () => {
	const repo = makeRepo();
	const runId = `durable-failure-${randomUUID()}`;
	const result = await runSimpleTask(
		options(repo),
		dependencies({
			runId,
			executeProvider: async () => ({
				success: false,
				code: 1,
				writerLifecycle: "stopped",
			}),
			runCheck: async () => ({ success: true }),
		}),
	);
	strictEqual(result.status, "failed");
	const record = await readRun(runId);
	strictEqual(record.state, "failed");
	strictEqual(typeof record.startedAt, "string");
	strictEqual(typeof record.activeTaskStartedAt, "number");
	ok(record.lastFailure);
	strictEqual(Object.hasOwn(record, "lastCompletionAt"), false);
});
