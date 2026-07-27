// Dispatched by launch(), never run directly.
// Minimal bootstrap: install fatal handlers, verify nonce + host fingerprint,
// claim lease, advance state, then dynamically import and run the queue.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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
			onTaskStart: (task) => {
				runStore
					.readRun(runId)
					.then((current) =>
						runStore.updateRun(
							runId,
							{ activeTaskId: task.id },
							current.revision,
						),
					)
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
						runStore
							.readRun(runId)
							.then((current) =>
								runStore.updateRun(
									runId,
									{ activeTaskId: null },
									current.revision,
								),
							),
					)
					.catch(() => {});
			},
			onCheckpointSaved: () => {
				runStore
					.readRun(runId)
					.then((current) => runStore.updateRun(runId, {}, current.revision))
					.catch(() => {});
			},
		},
	});

	const failed = result.results.filter((r) => !r.success);

	try {
		const current = await runStore.readRun(runId);
		await runStore.updateRun(
			runId,
			{
				state: failed.length > 0 ? "failed" : "succeeded",
				activeTaskId: null,
				cleanupState: "complete",
				terminalSummary: {
					totalTasks: result.totalTasks,
					runnableTasks: result.runnableTasks,
					processedTasks: result.processedTasks,
					completedTaskIds: result.completedTaskIds,
					failedCount: failed.length,
				},
			},
			current.revision,
		);
	} finally {
		await runStore.releaseRunLock(runId);
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
	} catch {
		// best effort — at least the fatal event was recorded
		try {
			const runStore = await import("../run-store/index.mjs");
			await runStore.releaseRunLock(runId);
		} catch {
			// lock may not exist
		}
	}
	process.exit(1);
}
