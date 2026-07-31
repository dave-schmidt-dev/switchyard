// Dispatched by launch(), never run directly.
// Minimal bootstrap: install fatal handlers, verify nonce + host fingerprint,
// claim lease, advance state, then dynamically import and run the queue.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Diagnostics } from "../diagnostics/index.mjs";

function parseArg(argv, flag) {
	const idx = argv.indexOf(flag);
	if (idx < 0 || idx + 1 >= argv.length) return null;
	return argv[idx + 1];
}

const stateRoot = parseArg(process.argv, "--state-root");
const runId = parseArg(process.argv, "--run-id");
const nonce = parseArg(process.argv, "--nonce");

if (!stateRoot || !runId || !nonce) {
	console.error("worker-bootstrap: missing --state-root, --run-id, or --nonce");
	process.exit(1);
}

process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;

// Module-scope write chain serializing every run-store mutation this worker
// fires outside a direct `await` (the onTaskStart/onTaskRouted/onResult/
// onCheckpointSaved/onContainerReady callbacks below). Each callback must
// synchronously extend this chain the moment it fires — `writeChain =
// writeChain.then(fn, fn).catch(() => {})` — so the *call* to
// updateRunWithRetry for a later-firing callback can never start before an
// earlier-firing callback's call has settled. Without this, two callbacks
// firing close together race independently for I/O (their internal readRun()
// calls), and whichever happens to resolve first reaches the per-runId
// update queue first — which can let an earlier-firing callback's write land
// *after* a later-firing one's, silently corrupting the run record with a
// stale value even though updateRunWithRetry guarantees no write is ever
// lost. Chaining on fire order (not completion order) fixes that. It always
// resolves (never rejects), so awaiting it anywhere is safe and bounded.
let writeChain = Promise.resolve();

async function writeFatalEvent(error) {
	try {
		const runStore = await import("../run-store/index.mjs");
		// Route through Diagnostics with the real Error object (not
		// error?.message) so _serializeError's allowlist and _redactPaths
		// actually apply — a raw message string would bypass that
		// redaction path entirely. emit() is awaited so the payload is
		// guaranteed to have reached the sink before this returns (and
		// before the caller's process.exit(1) runs).
		const diagnostics = new Diagnostics();
		diagnostics.sink((sanitized) => runStore.createEvent(runId, sanitized));
		await diagnostics.emit({
			phase: "worker",
			event: "worker_boot_failed",
			status: "fatal",
			error,
		});
	} catch {
		// best effort
	}
}

process.on("uncaughtException", (error) => {
	writeFatalEvent(error).then(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
	const error = reason instanceof Error ? reason : new Error(String(reason));
	writeFatalEvent(error).then(() => process.exit(1));
});

function captureCurrentFingerprint(projectPath) {
	let head = "";
	let dirty = "unknown";
	try {
		const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: projectPath,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (headResult.status === 0) {
			head = headResult.stdout.trim();
		}
		const statusResult = spawnSync("git", ["status", "--porcelain"], {
			cwd: projectPath,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (statusResult.status === 0) {
			dirty = statusResult.stdout.trim().length > 0 ? "dirty" : "clean";
		}
	} catch {
		// git unavailable
	}
	return `git:${head || "no-head"}:${dirty}`;
}

try {
	const runStore = await import("../run-store/index.mjs");

	const run = await runStore.readRun(runId);

	if (run.workerNonce !== nonce) {
		await writeFatalEvent(
			new Error(
				`nonce mismatch: bootstrap received "${nonce}", run.json has "${run.workerNonce}"`,
			),
		);
		process.exit(3);
	}

	const currentFingerprint = captureCurrentFingerprint(run.projectPath);
	if (
		run.initialHostFingerprint !== currentFingerprint &&
		!currentFingerprint.includes(":no-head:") &&
		!run.initialHostFingerprint.includes(":no-head:")
	) {
		await writeFatalEvent(
			new Error(
				`host fingerprint mismatch: initial="${run.initialHostFingerprint}", current="${currentFingerprint}"`,
			),
		);
		process.exit(4);
	}

	const pid = process.pid;
	const startToken = randomUUID();

	await runStore.acquireRunLock(runId, pid, startToken, nonce);
	await runStore.advanceState(runId, "running");

	const { runQueue: runQueueFn } = await import("../runner/index.mjs");

	const result = runQueueFn({
		tasksFilePath: run.tasksFilePath,
		projectPath: run.projectPath,
		maxTasks: Number.POSITIVE_INFINITY,
		stopOnFailure: true,
		dependencies: {
			// These callbacks all use updateRunWithRetry rather than a
			// read-then-updateRun(fixed revision) pair, and each one synchronously
			// extends the module-scope `writeChain` (declared above) instead of
			// firing its updateRunWithRetry call directly: onTaskStart and
			// onTaskRouted fire microseconds apart (routing is synchronous, ahead
			// of the blocking adapter.execute call), and onResult for one task can
			// fire close to onTaskStart for the next, so consecutive callbacks'
			// underlying readRun() calls can resolve in either order.
			// updateRunWithRetry alone guarantees no write is ever *lost* (it
			// re-reads and retries on conflict rather than throwing RevisionError),
			// but it does not guarantee *order* — a callback that fired first could
			// still have its write applied after a callback that fired later, if
			// the later one's readRun() happens to resolve first and reaches the
			// per-runId update queue first. Chaining onto writeChain fixes that: a
			// later-firing callback's actual updateRunWithRetry call cannot start
			// until the earlier-firing callback's call has fully settled, so writes
			// are strictly ordered by fire-time regardless of I/O timing.
			onTaskStart: (task) => {
				const fn = () =>
					runStore.updateRunWithRetry(runId, {
						activeTaskId: task.id,
						activeTaskStartedAt: Date.now(),
					});
				writeChain = writeChain.then(fn, fn).catch(() => {});
			},
			onTaskRouted: (info) => {
				const fn = () =>
					runStore.updateRunWithRetry(runId, {
						activeTaskProvider: info.provider,
						activeTaskModel: info.model,
						activeTaskDeadline: info.deadline,
					});
				writeChain = writeChain.then(fn, fn).catch(() => {});
			},
			onResult: (r) => {
				const event = r.success
					? {
							phase: "execution",
							event: "task_completed",
							status: `Task ${r.taskId} completed`,
							taskId: r.taskId,
							provider: r.provider ?? null,
							model: r.model ?? null,
						}
					: {
							phase: "execution",
							event: "task_failed",
							status: `Task ${r.taskId} failed: ${r.result}`,
							taskId: r.taskId,
							provider: r.provider ?? null,
							model: r.model ?? null,
						};
				const fn = () =>
					runStore.createEvent(runId, event).then(() =>
						runStore.updateRunWithRetry(runId, {
							activeTaskId: null,
							activeTaskProvider: null,
							activeTaskModel: null,
							activeTaskDeadline: null,
							// Only a successful task advances lastCompletionAt — a
							// failure must leave the run record's existing value
							// untouched (not null it out), so this stays a
							// conditional spread rather than a bare field.
							...(r.success ? { lastCompletionAt: Date.now() } : {}),
						}),
					);
				writeChain = writeChain.then(fn, fn).catch(() => {});

				// Surface a timeout's partial diff through the run's existing
				// (already-provisioned, previously-unused) artifacts channel so
				// it shows up in `switchyard result <runId>`'s artifactRefs —
				// same best-effort, fire-and-forget style as the rest of this
				// callback. This copies a file rather than mutating run.json, so
				// it doesn't race the other callbacks' writes and stays outside
				// writeChain.
				if (r.partialDiffPath) {
					const artifactsDir = join(runStore.getRunRoot(runId), "artifacts");
					mkdir(artifactsDir, { recursive: true })
						.then(() =>
							copyFile(
								r.partialDiffPath,
								join(artifactsDir, `${r.taskId}.diff`),
							),
						)
						.catch(() => {});
				}
			},
			onCheckpointSaved: () => {
				const fn = () => runStore.updateRunWithRetry(runId, {});
				writeChain = writeChain.then(fn, fn).catch(() => {});
			},
			onContainerReady: (info) => {
				const fn = () =>
					runStore.updateRunWithRetry(runId, {
						workingContainerName: info.workingContainerName,
					});
				writeChain = writeChain.then(fn, fn).catch(() => {});
			},
		},
	});

	const failed = result.results.filter((r) => !r.success);
	const terminalPatch = {
		state: failed.length > 0 ? "failed" : "succeeded",
		activeTaskId: null,
		activeTaskProvider: null,
		activeTaskModel: null,
		activeTaskDeadline: null,
		cleanupState: "complete",
		terminalSummary: {
			totalTasks: result.totalTasks,
			runnableTasks: result.runnableTasks,
			processedTasks: result.processedTasks,
			completedTaskIds: result.completedTaskIds,
			failedCount: failed.length,
		},
	};

	// Drain writeChain before the terminal write. runQueueFn has already
	// returned, so no further callback will extend the chain past this point —
	// but the last task's callbacks may still have an updateRunWithRetry call
	// in flight. Without waiting for it here, releaseRunLock's fixed-revision
	// updateRun (in the finally below) can lose a race against that straggler:
	// its readRun() can be followed by the straggler bumping the revision
	// before releaseRunLock's own update reaches the queue, throwing
	// RevisionError, which would fall into the catch block below and
	// overwrite this run's real terminal outcome with a zeroed failure
	// placeholder. writeChain always resolves, so this await is bounded.
	await writeChain;

	try {
		// The terminal write carries the authoritative outcome, but it can lose
		// the revision race to a still-in-flight fire-and-forget event callback
		// (onTaskStart/onResult). updateRunWithRetry retries against the
		// current revision on conflict rather than letting this real
		// terminalSummary be lost and falling through to the catch block
		// below, which would replace it with a zeroed placeholder.
		await runStore.updateRunWithRetry(runId, terminalPatch);
	} finally {
		await runStore.releaseRunLock(runId);
	}
	// Release the project lock on the success/failure terminal path so a
	// subsequent launch against the same project is not blocked forever.
	// Mirror the acquire-side canonicalization: acquireProjectLock was called
	// with the resolved project path, which is exactly what run.projectPath
	// persists. The run's terminal state was already committed above, so a
	// failure here must stay contained — it must not fall into the catch
	// block below and overwrite that already-successful state with
	// "failed". `recover` reclaims any lock left behind by this failure.
	try {
		await runStore.releaseProjectLock(run.projectPath);
	} catch (lockError) {
		await writeFatalEvent(lockError);
	}
} catch (error) {
	// Same reasoning as the terminal-write drain above: a crash can land here
	// while a straggler writeChain write is still in flight (e.g. runQueueFn
	// itself threw mid-loop). Draining first keeps this fixed-revision
	// updateRun below from losing a revision race to that straggler.
	// writeChain always resolves, so this is safe even before it's ever used.
	await writeChain;
	await writeFatalEvent(error);
	try {
		const runStore = await import("../run-store/index.mjs");
		const current = await runStore.readRun(runId);
		await runStore.updateRun(
			runId,
			{
				state: "failed",
				activeTaskId: null,
				activeTaskProvider: null,
				activeTaskModel: null,
				activeTaskDeadline: null,
				cleanupState: "complete",
				terminalSummary: {
					totalTasks: 0,
					runnableTasks: 0,
					processedTasks: 0,
					completedTaskIds: [],
					failedCount: 1,
				},
			},
			current.revision,
		);
		await runStore.releaseRunLock(runId);
		// Same project-lock release on the crash/catch terminal path.
		await runStore.releaseProjectLock(current.projectPath);
	} catch {
		// best effort — the fatal event is already recorded, and `recover`
		// can clear any lock that survives this fallback.
		try {
			const runStore = await import("../run-store/index.mjs");
			const current = await runStore.readRun(runId);
			await runStore.releaseRunLock(runId);
			await runStore.releaseProjectLock(current.projectPath);
		} catch {
			// run.json unreadable — leave locks for `recover` to reclaim
		}
	}
	process.exit(1);
}
