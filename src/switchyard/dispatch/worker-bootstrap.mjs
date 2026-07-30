// Dispatched by launch(), never run directly.
// Minimal bootstrap: install fatal handlers, verify nonce + host fingerprint,
// claim lease, advance state, then dynamically import and run the queue.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

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

async function writeFatalEvent(error) {
	try {
		const runStore = await import("../run-store/index.mjs");
		await runStore.createEvent(runId, {
			phase: "worker",
			event: "worker_boot_failed",
			status: "fatal",
			detail: error?.message ?? "unknown error",
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
			// These fire-and-forget callbacks all use updateRunWithRetry rather
			// than a read-then-updateRun(fixed revision) pair: onTaskStart and
			// onTaskRouted fire microseconds apart (routing is synchronous, ahead
			// of the blocking adapter.execute call), so both can read the same
			// base revision and race for the same per-runId update queue slot.
			// With a fixed expectedRevision, the loser's update throws
			// RevisionError and is silently dropped by the .catch(() => {})
			// below, so activeTaskId or activeTaskProvider/Model/Deadline goes
			// missing nondeterministically. updateRunWithRetry re-reads the
			// current revision and retries on conflict, so the loser's write
			// still lands instead of vanishing.
			onTaskStart: (task) => {
				runStore
					.updateRunWithRetry(runId, { activeTaskId: task.id })
					.catch(() => {});
			},
			onTaskRouted: (info) => {
				runStore
					.updateRunWithRetry(runId, {
						activeTaskProvider: info.provider,
						activeTaskModel: info.model,
						activeTaskDeadline: info.deadline,
					})
					.catch(() => {});
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
				runStore
					.createEvent(runId, event)
					.then(() =>
						runStore.updateRunWithRetry(runId, {
							activeTaskId: null,
							activeTaskProvider: null,
							activeTaskModel: null,
							activeTaskDeadline: null,
						}),
					)
					.catch(() => {});

				// Surface a timeout's partial diff through the run's existing
				// (already-provisioned, previously-unused) artifacts channel so
				// it shows up in `switchyard result <runId>`'s artifactRefs —
				// same best-effort, fire-and-forget style as the rest of this
				// callback.
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
				runStore.updateRunWithRetry(runId, {}).catch(() => {});
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
