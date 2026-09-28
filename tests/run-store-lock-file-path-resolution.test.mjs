import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { isPersistentFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";
import {
	acquireLaunchLock,
	advanceState,
	createEvent,
	initializeRun,
	LockError,
	RevisionError,
	readRun,
	updateRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	TEST_ROOT,
	uniquePath,
	uniqueRunId,
	VM_ADMISSION_ROOT,
} from "./helpers/run-store-fixtures.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
process.env.SWITCHYARD_ROSTER_PATH = resolve(
	"tests/fixtures/roster.fixture.json",
);
after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
afterEach(() => {
	try {
		rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
		rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("lock file path resolution", () => {
	it("acquireLaunchLock resolves relative paths to the same lock", async () => {
		const path1 = uniquePath("tasks");
		const runId = uniqueRunId();
		await acquireLaunchLock(path1, runId);

		const relPath = relative(process.cwd(), path1);
		await rejects(acquireLaunchLock(relPath, uniqueRunId()), LockError);
	});
});
describe("concurrent atomic writes", () => {
	it("concurrent updateRun/createEvent never throw ENOENT and leave a valid run.json", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Fire many writers concurrently at the same run.json. With a fixed,
		// shared tmp path (the bug), roughly half of these collide on rename:
		// one writer renames the shared tmp away before another's rename runs,
		// so the loser throws ENOENT. A unique tmp path per write eliminates
		// the collision — each writer's rename only touches its own tmp file.
		const N = 40;
		const ops = [];
		for (let i = 0; i < N; i++) {
			if (i % 2 === 0) {
				ops.push(
					updateRun(runId, { activeTaskId: `task-${i}` }, base.revision),
				);
			} else {
				ops.push(
					createEvent(runId, {
						phase: "execution",
						event: `evt-${i}`,
						status: "ok",
					}),
				);
			}
		}
		const settled = await Promise.allSettled(ops);

		const enoent = settled.filter(
			(r) => r.status === "rejected" && r.reason?.code === "ENOENT",
		);
		strictEqual(
			enoent.length,
			0,
			`no writer should fail with ENOENT, got ${enoent.length}`,
		);

		// run.json must remain valid and parseable; readRun validates the schema.
		const final = await readRun(runId);
		strictEqual(final.runId, runId);
		ok(
			final.revision > base.revision,
			`revision should advance past ${base.revision}, got ${final.revision}`,
		);
	});

	it("serializes racing updateRun calls on the same expectedRevision instead of clobbering", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Simulate worker-bootstrap's fire-and-forget callbacks (onTaskStart,
		// onResult) racing the main thread's terminal write: every caller reads
		// the same starting revision before any of them has written. Without
		// serialization, all of these can pass the optimistic-concurrency check
		// and last-rename-wins silently discards every write but the last —
		// with no error thrown, and no guarantee the terminal write survives.
		const N = 10;
		const settled = await Promise.allSettled(
			Array.from({ length: N }, (_, i) =>
				updateRun(runId, { activeTaskId: `task-${i}` }, base.revision),
			),
		);

		const succeeded = settled.filter((r) => r.status === "fulfilled");
		const revisionErrors = settled.filter(
			(r) => r.status === "rejected" && r.reason instanceof RevisionError,
		);
		strictEqual(
			succeeded.length,
			1,
			`exactly one racing updateRun should win, got ${succeeded.length}`,
		);
		strictEqual(
			revisionErrors.length,
			N - 1,
			`the other ${N - 1} should lose with RevisionError, got ${revisionErrors.length}`,
		);

		const final = await readRun(runId);
		strictEqual(final.revision, base.revision + 1);
		strictEqual(final.activeTaskId, succeeded[0].value.activeTaskId);
	});

	it("updateRunWithRetry's authoritative write survives a losing race against a stale-revision writer", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;
		const base = await readRun(runId);

		// Mirror worker-bootstrap: a fire-and-forget callback (e.g. onResult)
		// captured the starting revision before the terminal write began, so
		// it races updateRunWithRetry using that now-stale expectedRevision.
		// Whichever of these actually reaches the update queue first, the
		// authoritative write must still land with its real payload — it must
		// never be discarded by losing the race.
		const floatingWrite = updateRun(
			runId,
			{ activeTaskId: "floating-task" },
			base.revision,
		);
		const authoritativeWrite = updateRunWithRetry(runId, {
			state: "failed",
			activeTaskId: null,
			cleanupState: "complete",
			terminalSummary: { totalTasks: 2, processedTasks: 1, failedCount: 1 },
		});

		const authoritative = await authoritativeWrite;
		await floatingWrite.catch(() => {});

		strictEqual(authoritative.state, "failed");
		strictEqual(authoritative.cleanupState, "complete");
		strictEqual(authoritative.terminalSummary.failedCount, 1);

		const final = await readRun(runId);
		strictEqual(final.state, "failed");
		strictEqual(final.cleanupState, "complete");
		strictEqual(
			final.terminalSummary.failedCount,
			1,
			"the real terminal summary must win, not be lost to the floating writer",
		);
	});

	it("two concurrent updateRunWithRetry callers touching different fields both survive", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		// Mirrors worker-bootstrap's onTaskStart and onTaskRouted: routing is
		// synchronous and fires microseconds after task-start, so both
		// callbacks can read the same base revision and race for the same
		// per-runId update queue slot. Before onTaskStart/onTaskRouted/onResult
		// were switched to updateRunWithRetry, this shape (two fixed-revision
		// updateRun calls) would silently drop one caller's write via
		// RevisionError — the specific regression this fix addresses.
		const [a, b] = await Promise.all([
			updateRunWithRetry(runId, { activeTaskId: "task-1" }),
			updateRunWithRetry(runId, {
				activeTaskProvider: "claude",
				activeTaskModel: "claude-sonnet-5",
			}),
		]);
		ok(a && b, "both concurrent updateRunWithRetry calls should resolve");

		const final = await readRun(runId);
		strictEqual(final.activeTaskId, "task-1");
		strictEqual(final.activeTaskProvider, "claude");
		strictEqual(final.activeTaskModel, "claude-sonnet-5");
	});
});
describe("lastCompletionAt (worker-bootstrap onResult conditional field)", () => {
	// Mirrors worker-bootstrap's onResult callback, which adds lastCompletionAt
	// via a conditional spread — `...(r.success ? { lastCompletionAt: Date.now() } : {})`
	// — rather than a bare field. A failed task's patch must never carry the
	// key at all, so it can neither introduce nor null out lastCompletionAt.
	function completionPatch(success, now) {
		return {
			activeTaskId: null,
			activeTaskProvider: null,
			activeTaskModel: null,
			activeTaskDeadline: null,
			...(success ? { lastCompletionAt: now } : {}),
		};
	}

	it("stays absent (not null, not set) after a task_failed outcome on a fresh run", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		const final = await updateRunWithRetry(runId, completionPatch(false, 1234));

		ok(
			!Object.hasOwn(final, "lastCompletionAt"),
			"a failed task's patch must never introduce lastCompletionAt",
		);
		strictEqual(final.lastCompletionAt, undefined);
	});

	it("leaves an existing lastCompletionAt untouched (not nulled) when a later task fails", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const { runId } = opts;

		const afterSuccess = await updateRunWithRetry(
			runId,
			completionPatch(true, 111222),
		);
		strictEqual(afterSuccess.lastCompletionAt, 111222);

		const afterFailure = await updateRunWithRetry(
			runId,
			completionPatch(false, 333444),
		);

		strictEqual(
			afterFailure.lastCompletionAt,
			111222,
			"a failed task must not overwrite or null out the prior completion timestamp",
		);
	});
});
describe("shared run finalization", () => {
	it("orders event, pending cleanup, ownership cleanup, terminal patch, and run-lock release", async () => {
		const { finalizeRun } = await import(
			"../src/switchyard/dispatch/run-finalization.mjs"
		);
		const calls = [];
		await finalizeRun(
			{
				runId: "finalizer-order",
				state: "succeeded",
				terminalSummary: { processedTasks: 0, failedCount: 0 },
				cleanup: async () => calls.push("ownership-cleanup"),
			},
			{
				createEvent: async () => calls.push("event"),
				updateRunWithRetry: async (_runId, patch) => {
					calls.push(
						patch.cleanupState === "pending"
							? "pending-cleanup"
							: "terminal-patch",
					);
					return patch;
				},
				releaseRunLock: async () => calls.push("run-lock-release"),
			},
		);
		deepStrictEqual(calls, [
			"event",
			"pending-cleanup",
			"ownership-cleanup",
			"terminal-patch",
			"run-lock-release",
		]);
	});

	it("records cleanup failure as recovery_required without a terminal discriminator", async () => {
		const { finalizeRun } = await import(
			"../src/switchyard/dispatch/run-finalization.mjs"
		);
		const patches = [];
		const result = await finalizeRun(
			{
				runId: "finalizer-cleanup-failure",
				state: "failed",
				terminalSummary: { processedTasks: null, failedCount: null },
				cleanup: async () => {
					throw new Error("raw cleanup detail");
				},
			},
			{
				createEvent: async () => {},
				updateRunWithRetry: async (_runId, patch) => {
					patches.push(patch);
					return patch;
				},
				releaseRunLock: async () => {},
			},
		);
		strictEqual(result.terminal, false);
		strictEqual(patches.at(-1).state, "recovery_required");
		strictEqual(patches.at(-1).cleanupState, "failed");
		strictEqual(patches.at(-1).terminalizedBy, undefined);
		strictEqual(
			patches.at(-1).lastFailure.diagnosticCode,
			"recovery_incomplete",
		);
		ok(!JSON.stringify(patches).includes("raw cleanup detail"));
	});

	it("persists worker terminalization while historical omission remains valid", async () => {
		const { finalizeRun } = await import(
			"../src/switchyard/dispatch/run-finalization.mjs"
		);
		const opts = makeOptions();
		await initializeRun(opts);
		await finalizeRun({
			runId: opts.runId,
			state: "succeeded",
			terminalSummary: { processedTasks: 0, failedCount: 0 },
		});
		const terminal = await readRun(opts.runId);
		strictEqual(terminal.terminalizedBy, "worker");
		strictEqual(terminal.startedAt, null);
		ok(typeof terminal.finishedAt === "string");
		ok(Date.parse(terminal.finishedAt) >= Date.parse(terminal.createdAt));

		const historical = makeOptions();
		await initializeRun(historical);
		strictEqual((await readRun(historical.runId)).terminalizedBy, undefined);
	});
});
describe("terminal failure metadata invariants (Task 1.1)", () => {
	it("substitutes unclassified lastFailure when state is updated to failed without metadata", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const updated = await updateRun(
			opts.runId,
			{ state: "failed" },
			snapshot.revision,
		);

		strictEqual(updated.state, "failed");
		ok(updated.lastFailure !== null, "lastFailure must be non-null");
		strictEqual(updated.lastFailure.errorKind, "unclassified");
		strictEqual(updated.lastFailure.reasonCode, "unclassified");
		ok(isPersistentFailureMetadata(updated.lastFailure));

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "unclassified");
		ok(isPersistentFailureMetadata(onDisk.lastFailure));
	});

	it("substitutes unclassified lastFailure when advanceState sets state to failed", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const updated = await advanceState(opts.runId, "failed");

		strictEqual(updated.state, "failed");
		ok(updated.lastFailure !== null, "lastFailure must be non-null");
		strictEqual(updated.lastFailure.errorKind, "unclassified");
		ok(isPersistentFailureMetadata(updated.lastFailure));

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "unclassified");
	});

	it("substitutes unclassified lastFailure when updateRunWithRetry sets state to failed", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const updated = await updateRunWithRetry(opts.runId, { state: "failed" });

		strictEqual(updated.state, "failed");
		ok(updated.lastFailure !== null, "lastFailure must be non-null");
		strictEqual(updated.lastFailure.errorKind, "unclassified");
		ok(isPersistentFailureMetadata(updated.lastFailure));

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "unclassified");
	});

	it("preserves an existing known failure cause when state is updated to failed without metadata", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "dispatch",
			event: "task_failed",
			status: "Task failed",
			errorKind: "launch_failed",
			reasonCode: "launch_failed",
			reason: "The headless provider job could not be launched.",
		});

		const current = await readRun(opts.runId);
		strictEqual(current.lastFailure?.errorKind, "launch_failed");

		const updated = await updateRun(
			opts.runId,
			{ state: "failed" },
			current.revision,
		);
		strictEqual(updated.state, "failed");
		strictEqual(updated.lastFailure.errorKind, "launch_failed");

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "launch_failed");
	});

	it("preserves explicitly supplied known failure metadata on failed state patch", async () => {
		const opts = makeOptions();
		const snapshot = await initializeRun(opts);
		const safeFailure = {
			errorKind: "auth_expired",
			reasonCode: "auth_expired",
			reason:
				"Provider authentication expired; interactive re-authentication is required.",
		};

		const updated = await updateRun(
			opts.runId,
			{ state: "failed", lastFailure: safeFailure },
			snapshot.revision,
		);
		strictEqual(updated.state, "failed");
		strictEqual(updated.lastFailure.errorKind, "auth_expired");

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "failed");
		strictEqual(onDisk.lastFailure?.errorKind, "auth_expired");
	});

	it("leaves success paths untouched with no lastFailure substituted", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const updated = await advanceState(opts.runId, "succeeded");

		strictEqual(updated.state, "succeeded");
		strictEqual(updated.lastFailure, null);

		const onDisk = await readRun(opts.runId);
		strictEqual(onDisk.state, "succeeded");
		strictEqual(onDisk.lastFailure, null);
	});
});
