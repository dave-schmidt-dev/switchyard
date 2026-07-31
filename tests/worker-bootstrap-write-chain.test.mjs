// Regression test for worker-bootstrap.mjs's writeChain fix.
//
// worker-bootstrap.mjs's dependency callbacks (onTaskStart, onTaskRouted,
// onResult, onCheckpointSaved, onContainerReady) each fire a run-store write
// without the caller (runQueue's synchronous loop) waiting for it. Two
// callbacks firing close together — e.g. one task's onResult (which does
// createEvent().then(() => updateRunWithRetry(...))) racing the *next*
// task's onTaskStart — can have their internal readRun() calls resolve out
// of order. updateRunWithRetry always reads the *current* revision right
// before it writes, so this isn't a RevisionError case: the later-resolving
// call simply merges its patch on top of whatever is on disk at that
// moment, even if that's now stale relative to a write that landed after it
// fired. The fix is a module-scope `writeChain` that each callback
// synchronously extends the instant it fires, so a later-firing callback's
// updateRunWithRetry call cannot even *start* until an earlier-firing
// callback's call has fully settled — writes end up strictly ordered by
// fire-time, not by whichever readRun() happens to resolve first.
//
// worker-bootstrap.mjs itself can't be imported directly: it's a bare
// top-level script that parses process.argv and calls process.exit on the
// spot, so pulling it into this process would kill the test runner. Instead
// this file reproduces the exact writeChain pattern against a realistically
// faked run-store — same revision-checked write, same updateRunWithRetry
// retry-until-success loop as src/switchyard/run-store/index.mjs — with an
// injectable read latency so the out-of-order-resolution race is forced
// deterministically instead of depending on real filesystem timing (which
// would make this test flaky, and flaky in a way that could pass even
// without the fix). If worker-bootstrap.mjs's writeChain wiring ever
// changes, keep buildCallbacks() below in sync with it.

import { strictEqual } from "node:assert";
import { describe, it } from "node:test";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A realistically-faked run-store: same optimistic-concurrency contract as
 * the real one (readRun returns the *current* on-disk-equivalent state;
 * updateRun merges a patch only if the caller's expectedRevision still
 * matches; updateRunWithRetry loops, re-reading and retrying on conflict).
 * readDelayMs lets a caller model "this particular readRun() call takes
 * longer to resolve" without touching real I/O.
 */
function createFakeRunStore(initialFields) {
	let record = { ...initialFields, revision: 1 };

	async function readRun(readDelayMs = 0) {
		await sleep(readDelayMs);
		return { ...record };
	}

	async function updateRun(partial, expectedRevision) {
		if (record.revision !== expectedRevision) {
			const error = new Error(
				`revision mismatch: expected ${expectedRevision}, got ${record.revision}`,
			);
			error.name = "RevisionError";
			throw error;
		}
		record = { ...record, ...partial, revision: record.revision + 1 };
		return { ...record };
	}

	async function updateRunWithRetry(
		partial,
		{ readDelayMs = 0 } = {},
		maxAttempts = 10,
	) {
		for (let attempt = 0; ; attempt++) {
			const current = await readRun(readDelayMs);
			try {
				return await updateRun(partial, current.revision);
			} catch (error) {
				if (error.name !== "RevisionError" || attempt >= maxAttempts - 1) {
					throw error;
				}
			}
		}
	}

	async function createEvent(_event, { readDelayMs = 0 } = {}) {
		// Mirrors createEvent's shape closely enough for this race: it does a
		// readRun (here, delayed) before returning, so onResult's real
		// createEvent().then(() => updateRunWithRetry(...)) chain has the same
		// "async work happens before the run-record write" latency profile.
		await readRun(readDelayMs);
		return 1;
	}

	return {
		readRun,
		updateRun,
		updateRunWithRetry,
		createEvent,
		snapshot: () => ({ ...record }),
	};
}

/**
 * Reproduces worker-bootstrap.mjs's dependency-callback wiring against a
 * fake store. `ordered: true` is the writeChain fix (synchronously extend a
 * shared chain on every fire); `ordered: false` is the pre-fix fire-and-
 * forget shape (`updateRunWithRetry(...).catch(() => {})`, no chaining).
 */
function buildCallbacks(store, { ordered }) {
	let writeChain = Promise.resolve();

	function fire(fn) {
		if (ordered) {
			writeChain = writeChain.then(fn, fn).catch(() => {});
			return writeChain;
		}
		return fn().catch(() => {});
	}

	return {
		onTaskStart(task, { readDelayMs = 0 } = {}) {
			const fn = () =>
				store.updateRunWithRetry({ activeTaskId: task.id }, { readDelayMs });
			return fire(fn);
		},
		onResult(_result, { readDelayMs = 0 } = {}) {
			const fn = () =>
				store
					.createEvent({ event: "task_completed" }, { readDelayMs })
					.then(() =>
						store.updateRunWithRetry({ activeTaskId: null }, { readDelayMs }),
					);
			return fire(fn);
		},
		drain: () => writeChain,
	};
}

describe("worker-bootstrap writeChain ordering", () => {
	it("BUG (control, unordered): a fast-resolving later callback can be clobbered by a slow-resolving earlier one", async () => {
		// Fire order matches runQueue's real loop: task A's onResult() fires
		// first (A just finished), then task B's onTaskStart() fires right
		// after (B starts next). onResult(A)'s internal work (createEvent then
		// updateRunWithRetry) is modeled as slower than onTaskStart(B)'s, the
		// same way createEvent's extra round trip makes onResult naturally
		// slower than a bare updateRunWithRetry call in the real code.
		const store = createFakeRunStore({ activeTaskId: "task-A" });
		const callbacks = buildCallbacks(store, { ordered: false });

		const resultPromise = callbacks.onResult(
			{ taskId: "task-A", success: true },
			{ readDelayMs: 30 },
		);
		const startPromise = callbacks.onTaskStart(
			{ id: "task-B" },
			{ readDelayMs: 0 },
		);

		await Promise.all([resultPromise, startPromise]);

		const final = store.snapshot();
		// B's fast write lands first (activeTaskId: "task-B"), then A's slow
		// write resolves, reads that fresher state, and — because
		// updateRunWithRetry re-reads the *current* revision rather than one
		// captured at fire-time — legitimately (no RevisionError) merges its
		// stale `activeTaskId: null` patch on top, silently erasing task B's
		// active state while task B is actually running. This is the bug this
		// suite guards against; without it, the assertion below would fail.
		strictEqual(
			final.activeTaskId,
			null,
			"control case should reproduce the known race: task B's active state gets clobbered by task A's late-resolving completion write",
		);
	});

	it("FIX (writeChain, ordered): a later-firing callback's write always lands after an earlier-firing one's, regardless of I/O timing", async () => {
		const store = createFakeRunStore({ activeTaskId: "task-A" });
		const callbacks = buildCallbacks(store, { ordered: true });

		const resultPromise = callbacks.onResult(
			{ taskId: "task-A", success: true },
			{ readDelayMs: 30 },
		);
		const startPromise = callbacks.onTaskStart(
			{ id: "task-B" },
			{ readDelayMs: 0 },
		);

		await Promise.all([resultPromise, startPromise, callbacks.drain()]);

		const final = store.snapshot();
		strictEqual(
			final.activeTaskId,
			"task-B",
			"activeTaskId must never be observed as null/stale once a later task has started — " +
				"writeChain must hold onTaskStart(B)'s updateRunWithRetry call until onResult(A)'s has fully settled",
		);
	});

	it("FIX holds across a longer interleaved sequence (start -> route -> result -> next start)", async () => {
		const store = createFakeRunStore({ activeTaskId: null });
		const callbacks = buildCallbacks(store, { ordered: true });

		// task-1 starts (slow write), task-1 completes (slow write fired right
		// after, before task-1's start write has necessarily landed), task-2
		// starts (fast write). True fire order must be preserved end to end.
		const p1 = callbacks.onTaskStart({ id: "task-1" }, { readDelayMs: 20 });
		const p2 = callbacks.onResult(
			{ taskId: "task-1", success: true },
			{ readDelayMs: 15 },
		);
		const p3 = callbacks.onTaskStart({ id: "task-2" }, { readDelayMs: 0 });

		await Promise.all([p1, p2, p3, callbacks.drain()]);

		strictEqual(
			store.snapshot().activeTaskId,
			"task-2",
			"the last-fired callback (task-2's start) must win, not be clobbered by earlier, slower-settling writes",
		);
	});
});
