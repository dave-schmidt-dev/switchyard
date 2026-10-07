import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { realpathSync } from "node:fs";
import { test } from "node:test";
import { handleRoutingRun } from "../src/switchyard/simple/routing-cli.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	openRoutingRun,
	readRoutingRunState,
} from "../src/switchyard/simple/routing-state.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// A pending attempt left dangling by an unconfirmed lifecycle: the run
// record is the durable evidence close-pending must prove before closing it.
function fixture({ record: overrides } = {}) {
	const project = realpathSync(tempDir("pending-recovery-project-"));
	const stateRoot = realpathSync(tempDir("pending-recovery-state-"));
	const taskId = "task-1";
	const pending = {
		attemptId: "attempt-1",
		taskId,
		runId: "simple-1",
		targetId: "codex",
		capability: "standard",
		startedAt: new Date().toISOString(),
	};
	const handle = openRoutingRun(project, "run-1", { stateRoot });
	handle.commit({ pendingAttempt: pending });
	handle.release();
	const record = {
		runId: pending.runId,
		projectPath: project,
		state: "failed",
		cleanupState: "complete",
		workerPid: null,
		worktree: null,
		...overrides,
	};
	return {
		project,
		stateRoot,
		taskId,
		pending,
		record,
		argv: [
			"close-pending",
			"--project",
			project,
			"--routing-run-id",
			"run-1",
			"--task-id",
			taskId,
		],
		deps: {
			stateRoot,
			readRun: async () => record,
			isProjectLockHeld: () => false,
			writeResult: () => {},
		},
	};
}

const readState = (f) =>
	readRoutingRunState(f.project, "run-1", { stateRoot: f.stateRoot });

test("close-pending records a terminal pending attempt as lifecycle_recovered", async () => {
	const f = fixture();
	let output;
	await handleRoutingRun(f.argv, {
		...f.deps,
		writeResult: (value) => {
			output = JSON.parse(value);
		},
	});
	strictEqual(output.ok, true);
	strictEqual(output.reason, "lifecycle_recovered");
	strictEqual(output.attemptId, f.pending.attemptId);
	const state = readState(f);
	strictEqual(state.pendingAttempt, null);
	strictEqual(state.attempts.length, 1);
	strictEqual(state.attempts[0].terminal, "skipped");
	strictEqual(state.attempts[0].reason, "lifecycle_recovered");
	strictEqual(state.attempts[0].partialWorktree, null);
	deepStrictEqual(state.failedTargetIds, []);
});

test("close-pending recovers a stopped writer and a deferred terminal record", async () => {
	const f = fixture({
		record: {
			state: "deferred",
			worktree: { state: "removed", writerStopped: true },
		},
	});
	let output;
	await handleRoutingRun(f.argv, {
		...f.deps,
		writeResult: (value) => {
			output = JSON.parse(value);
		},
	});
	strictEqual(output.ok, true);
	strictEqual(readState(f).pendingAttempt, null);
});

test("a recovered run lets the next invocation route again", async () => {
	const f = fixture();
	const options = {
		projectPath: f.project,
		routingRunId: "run-1",
		capability: "standard",
		files: ["a.txt"],
		checks: [],
	};
	let engineCalls = 0;
	const deps = {
		...f.deps,
		getImplementorPriority: () => 1,
		assertFundedRoute: () => {},
		route: ({ availableProviders }) => ({
			provider: availableProviders[0] ?? null,
			reason: "no_eligible",
		}),
		runSimpleTask: async (_taskOptions, context) => {
			engineCalls += 1;
			context.route({ availableProviders: ["codex"] });
			return {
				status: "failed",
				failurePhase: "route",
				failureReason: "no_eligible_provider",
			};
		},
	};
	const blocked = await runSimpleRoutingTask(options, deps);
	strictEqual(blocked.stopReason, "pending_attempt_exists");
	strictEqual(engineCalls, 0);
	await handleRoutingRun(f.argv, f.deps);
	const resumed = await runSimpleRoutingTask(options, deps);
	strictEqual(resumed.stopReason !== "pending_attempt_exists", true);
	strictEqual(engineCalls, 1);
});

test("a held project lock is refused without changing routing state", async () => {
	const f = fixture();
	const before = readState(f);
	await rejects(
		handleRoutingRun(f.argv, { ...f.deps, isProjectLockHeld: () => true }),
		{ code: "project_lock_held" },
	);
	deepStrictEqual(readState(f), before);
});

test("a worker that is not proven stopped is refused", async () => {
	const writerLive = fixture({
		record: { worktree: { state: "removed", writerStopped: false } },
	});
	const before = readState(writerLive);
	await rejects(handleRoutingRun(writerLive.argv, writerLive.deps), {
		code: "worker_not_stopped",
	});
	deepStrictEqual(readState(writerLive), before);

	const workerLive = fixture({ record: { workerPid: process.pid } });
	await rejects(handleRoutingRun(workerLive.argv, workerLive.deps), {
		code: "worker_not_stopped",
	});
	deepStrictEqual(readState(workerLive).pendingAttempt, workerLive.pending);

	// An EPERM liveness probe counts as live, so recovery stays refused.
	const eperm = fixture({ record: { workerPid: 999999 } });
	await rejects(
		handleRoutingRun(eperm.argv, {
			...eperm.deps,
			probePid: () => {
				throw Object.assign(new Error("liveness probe refused"), {
					code: "EPERM",
				});
			},
		}),
		{ code: "worker_not_stopped" },
	);
	deepStrictEqual(readState(eperm).pendingAttempt, eperm.pending);
});

test("a non-terminal or unreadable run record is refused", async () => {
	const running = fixture({
		record: { state: "executing", cleanupState: "pending" },
	});
	const before = readState(running);
	await rejects(handleRoutingRun(running.argv, running.deps), {
		code: "run_state_not_terminal",
	});
	deepStrictEqual(readState(running), before);

	const unreadable = fixture();
	await rejects(
		handleRoutingRun(unreadable.argv, {
			...unreadable.deps,
			readRun: async () => {
				throw new Error("run store unavailable");
			},
		}),
		{ code: "lifecycle_unconfirmed" },
	);
	deepStrictEqual(readState(unreadable).pendingAttempt, unreadable.pending);
});

test("a retained-unclaimed worktree is refused", async () => {
	const f = fixture({
		record: {
			cleanupState: "failed",
			worktree: { state: "retained", writerStopped: true },
		},
	});
	const before = readState(f);
	await rejects(handleRoutingRun(f.argv, f.deps), {
		code: "partial_work_retained",
	});
	deepStrictEqual(readState(f), before);
});

test("a task-id mismatch and a missing pending attempt are refused", async () => {
	const f = fixture();
	const before = readState(f);
	await rejects(
		handleRoutingRun([...f.argv.slice(0, -1), "task-other"], f.deps),
		{ code: "routing_pending_identity_mismatch" },
	);
	deepStrictEqual(readState(f), before);

	await handleRoutingRun(f.argv, f.deps);
	await rejects(handleRoutingRun(f.argv, f.deps), {
		code: "pending_attempt_missing",
	});
	strictEqual(readState(f).pendingAttempt, null);
});

test("close-pending requires --task-id and rejects foreign options", async () => {
	const f = fixture();
	await rejects(
		handleRoutingRun([
			"close-pending",
			"--project",
			f.project,
			"--routing-run-id",
			"run-1",
		]),
		{ name: "RoutingCliUsageError" },
	);
	await rejects(handleRoutingRun([...f.argv, "--discard"], f.deps), {
		name: "RoutingCliUsageError",
	});
	deepStrictEqual(readState(f).pendingAttempt, f.pending);
});
