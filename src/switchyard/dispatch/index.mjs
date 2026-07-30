#!/usr/bin/env node

// Thin dispatch CLI over runQueue: farm a task queue across the funded
// providers instead of running every task on one. Host-side routing picks a
// provider by usage headroom (INV-4/5); each task then runs headless inside a
// disposable per-provider working container seeded from the project (INV-1),
// and its result returns to the host only through the reviewed integration
// gate (INV-2). The working container is wiped at the end (INV-3).
//
// This is also the executable SWITCHYARD_ORCHESTRATOR_CMD-style entry the
// :implement loop can point at; standalone it dispatches a queue against a
// project.
//
// Usage:
//   switchyard-dispatch run <tasks.md> --project <path> [options]      # legacy, same as positional
//   switchyard-dispatch launch <tasks.md> --project <path> [options]   # detached
//   switchyard-dispatch status <run-id> [--json]                       # read-only
//   switchyard-dispatch result <run-id> [--json]                       # read-only
//   switchyard-dispatch recover [--run <run-id>]                        # cleanup
//   node src/switchyard/dispatch/index.mjs <tasks.md> --project <path> [options]  # positional (backwards compat)
//
// Options (run/launch):
//   --project <path>       Host git repo to dispatch against (required). Its
//                          committed HEAD seeds each working container, and
//                          reviewed diffs land back on it.
//   --max-tasks <n>        Cap how many tasks are processed this run.
//   --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json).
//   --no-stop-on-failure   Keep going after a task fails (default: stop).
//   --help                 Show this help.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	listManagedContainers,
	recoverManagedObjects,
} from "../lifecycle/index.mjs";
import {
	acquireProjectLock,
	advanceState,
	getRunRoot,
	getStateRoot,
	initializeRun,
	readEvents,
	readRun,
	releaseProjectLockIfOwnedBy,
	SchemaError,
} from "../run-store/index.mjs";
import { loadTaskQueue, runQueue } from "../runner/index.mjs";

const USAGE = `Usage: switchyard-dispatch <subcommand> [args]

Subcommands:
  run    <tasks.md> --project <path> [options]    Run queue synchronously
  launch <tasks.md> --project <path> [options]    Launch detached run
  status <run-id> [--json]                        Show run status
  result <run-id> [--json]                        Show run result
  recover [--run <run-id>]                        Recover managed objects

Run/Launch options:
  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --help                 Show this help`;

const USAGE_RUN = `Usage: switchyard-dispatch run <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --help                 Show this help`;

const USAGE_LAUNCH = `Usage: switchyard-dispatch launch <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --help                 Show this help`;

const USAGE_STATUS = `Usage: switchyard-dispatch status <run-id> [--json]

  --json     Output as JSON (default behavior)
  --help     Show this help`;

const USAGE_RESULT = `Usage: switchyard-dispatch result <run-id> [--json]

  --json     Output as JSON (default behavior)
  --help     Show this help`;

const USAGE_RECOVER = `Usage: switchyard-dispatch recover [--run <run-id>]

  --run <run-id>  Recover only this run's managed objects
  --help          Show this help`;

const KNOWN_SUBCOMMANDS = new Set([
	"run",
	"launch",
	"status",
	"result",
	"recover",
]);

// Distinguishes a bad-invocation error (print usage, exit 2) from a real
// run-time failure (exit 1), mirroring conventional CLI exit-code semantics.
class UsageError extends Error {}

/**
 * Validate CLI arguments into a runQueue options object.
 * @param {string[]} argv process.argv.slice(2) without subcommand
 * @throws {UsageError} on any invalid/missing argument
 */
function parseDispatchArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				project: { type: "string" },
				"max-tasks": { type: "string" },
				checkpoint: { type: "string" },
				"no-stop-on-failure": { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	const { values, positionals } = parsed;
	if (values.help) {
		return { help: true };
	}

	const tasksFilePath = positionals[0];
	if (!tasksFilePath) {
		throw new UsageError("missing <tasks.md> positional argument");
	}
	if (positionals.length > 1) {
		throw new UsageError(
			`unexpected extra arguments: ${positionals.slice(1).join(" ")}`,
		);
	}
	if (!values.project) {
		throw new UsageError("--project <path> is required");
	}

	const resolvedTasks = resolve(tasksFilePath);
	if (!existsSync(resolvedTasks) || !statSync(resolvedTasks).isFile()) {
		throw new UsageError(`tasks file not found: ${resolvedTasks}`);
	}

	const projectPath = resolve(values.project);
	if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
		throw new UsageError(`--project is not a directory: ${projectPath}`);
	}
	// seedProject archives the project's committed HEAD into each working
	// container, so a non-repo project can't be dispatched against.
	if (!existsSync(join(projectPath, ".git"))) {
		throw new UsageError(`--project is not a git repository: ${projectPath}`);
	}

	let maxTasks = Number.POSITIVE_INFINITY;
	if (values["max-tasks"] !== undefined) {
		maxTasks = Number.parseInt(values["max-tasks"], 10);
		if (!Number.isInteger(maxTasks) || maxTasks < 1) {
			throw new UsageError(
				`--max-tasks must be a positive integer, got "${values["max-tasks"]}"`,
			);
		}
	}

	return {
		help: false,
		tasksFilePath: resolvedTasks,
		projectPath,
		maxTasks,
		checkpointPath: values.checkpoint ? resolve(values.checkpoint) : undefined,
		stopOnFailure: !values["no-stop-on-failure"],
	};
}

/**
 * Parse launch arguments (same shape as run args).
 * @param {string[]} argv
 * @throws {UsageError}
 */
function parseLaunchArgs(argv) {
	return parseDispatchArgs(argv);
}

/**
 * Parse status arguments.
 * @param {string[]} argv
 * @throws {UsageError}
 */
function parseStatusArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				help: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	const { values, positionals } = parsed;
	return {
		help: values.help,
		runId: positionals[0] ?? null,
		json: values.json,
	};
}

/**
 * Parse result arguments.
 * @param {string[]} argv
 * @throws {UsageError}
 */
function parseResultArgs(argv) {
	return parseStatusArgs(argv);
}

/**
 * Parse recover arguments.
 * @param {string[]} argv
 * @throws {UsageError}
 */
function parseRecoverArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: false,
			options: {
				run: { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	return { help: parsed.values.help, runId: parsed.values.run ?? null };
}

/**
 * Run the dispatch, printing live per-task progress (INV-1: no silent waits).
 * Sets process.exitCode: 1 if any processed task failed, else 0.
 * @param {object} opts Result of parseDispatchArgs (help:false variant)
 */
function runDispatch(opts) {
	console.error(`dispatch: queue    ${opts.tasksFilePath}`);
	console.error(`dispatch: project  ${opts.projectPath}`);
	console.error(
		"dispatch: routing host-side by usage headroom; each task runs headless in a disposable per-provider container.",
	);
	console.error(
		"dispatch: expect several minutes per task while the provider CLI runs.",
	);

	const result = runQueue({
		tasksFilePath: opts.tasksFilePath,
		projectPath: opts.projectPath,
		maxTasks: opts.maxTasks,
		...(opts.checkpointPath ? { checkpointPath: opts.checkpointPath } : {}),
		stopOnFailure: opts.stopOnFailure,
		dependencies: {
			onTaskStart: (task) =>
				console.error(
					`dispatch: -> task ${task.id} ${task.title ?? ""}`.trimEnd(),
				),
			onTaskRouted: (info) =>
				console.error(
					`dispatch:    routed to ${info.provider}${info.model ? `/${info.model}` : ""} — deadline ${info.deadline}`,
				),
			onResult: (r) => {
				const where = `${r.provider ?? "no-provider"}${r.model ? `/${r.model}` : ""}`;
				console.error(
					`dispatch: ${r.success ? "ok  " : "FAIL"} task ${r.taskId} [${where}] ${r.result}`,
				);
			},
		},
	});

	const failed = result.results.filter((r) => !r.success);
	console.error(
		`dispatch: done — ${result.processedTasks}/${result.runnableTasks} runnable processed, ` +
			`${result.completedTaskIds.length} completed, ${failed.length} failed`,
	);
	console.error(`dispatch: checkpoint ${result.checkpointPath}`);
	process.exitCode = failed.length > 0 ? 1 : 0;
}

function captureHostFingerprint(projectPath) {
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
		// git unavailable — fingerprint degrades to no-git sentinel
	}
	return `git:${head || "no-head"}:${dirty}`;
}

function resolveBootstrapPath() {
	return fileURLToPath(new URL("./worker-bootstrap.mjs", import.meta.url));
}

/**
 * Handle the launch subcommand.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleLaunch(argv) {
	const opts = parseLaunchArgs(argv);
	if (opts.help) {
		console.log(USAGE_LAUNCH);
		return;
	}

	const stateRoot = getStateRoot();
	const runId = randomUUID();
	const tasks = loadTaskQueue(opts.tasksFilePath);
	if (tasks.length === 0) {
		// Fail closed before any run state, lock, or worker exists — mirrors
		// runQueue's throwOnEmptyParse, but as a UsageError (exit 2) since an
		// empty/malformed queue is a bad-invocation condition the caller can
		// fix, not a run-time failure.
		throw new UsageError(
			`no tasks parsed from ${opts.tasksFilePath} — 0 headings matching ` +
				`"### Task <id>: <title>" were found. Expected format:\n` +
				`### Task <id>: <title>\n- **Status:** pending\n- **Description:** ...`,
		);
	}
	const orderedTaskIds = tasks.map((t) => t.id);

	const launchArgs = process.argv.slice(2).filter((a) => a !== "launch");
	const nonce = randomUUID();
	const fingerprint = captureHostFingerprint(opts.projectPath);

	await initializeRun({
		runId,
		tasksFilePath: opts.tasksFilePath,
		projectPath: opts.projectPath,
		orderedTaskIds,
		initialHostFingerprint: fingerprint,
		workerNonce: nonce,
		launchArgs,
	});

	await acquireProjectLock(opts.projectPath, runId);

	await advanceState(runId, "launching");

	const bootstrapPath = resolveBootstrapPath();
	const child = spawn(
		process.execPath,
		[
			bootstrapPath,
			"--state-root",
			stateRoot,
			"--run-id",
			runId,
			"--nonce",
			nonce,
		],
		{
			detached: true,
			stdio: "ignore",
		},
	);
	child.unref();

	let spawnError = null;
	child.on("error", (err) => {
		spawnError = err;
	});

	await new Promise((resolve) => {
		setTimeout(() => {
			resolve();
		}, 500);
	});

	if (spawnError) {
		await advanceState(runId, "failed");
		console.error(
			`dispatch: launch failed — child spawn error: ${spawnError.message}`,
		);
		process.exitCode = 1;
		return;
	}

	await advanceState(runId, "launcher_ready");

	const envelope = {
		schemaVersion: 1,
		runId,
		state: "launcher_ready",
		statusCommand: `switchyard-dispatch status ${runId}`,
		resultCommand: `switchyard-dispatch result ${runId}`,
	};
	console.log(JSON.stringify(envelope));
}

async function countCompletedAndFailed(runId) {
	let completedCount = 0;
	let failedCount = 0;
	try {
		const events = await readEvents(runId);
		for (const evt of events) {
			if (evt.phase === "execution" && evt.event === "task_completed") {
				completedCount += 1;
			}
			if (evt.phase === "execution" && evt.event === "task_failed") {
				failedCount += 1;
			}
		}
	} catch {
		// events may be absent or unreadable
	}
	return { completedCount, failedCount };
}

async function buildStatusEnvelope(runId, run) {
	const { completedCount, failedCount } = await countCompletedAndFailed(runId);
	return {
		schemaVersion: 1,
		runId: run.runId,
		state: run.state,
		cleanupState: run.cleanupState,
		// Liveness derived from a signal-0 probe of the recorded worker pid
		// (see isWorkerLive), so an operator doesn't have to shell out to
		// `docker top`/`ps` to tell active work from a stalled/ghost run.
		workerLive: run.state === "running" ? isWorkerLive(run) : null,
		activeTaskId: run.activeTaskId ?? null,
		activeTaskProvider: run.activeTaskProvider ?? null,
		activeTaskModel: run.activeTaskModel ?? null,
		activeTaskDeadline: run.activeTaskDeadline ?? null,
		completedCount,
		failedCount,
		updatedAt: run.updatedAt,
	};
}

async function listArtifactRefs(runId) {
	const artifactsDir = resolve(getRunRoot(runId), "artifacts");
	try {
		const entries = await readdir(artifactsDir, { withFileTypes: true });
		return entries
			.filter((e) => e.isFile())
			.map((e) => resolve(artifactsDir, e.name));
	} catch {
		return [];
	}
}

async function buildResultEnvelope(runId, run) {
	const { completedCount, failedCount } = await countCompletedAndFailed(runId);
	const artifactRefs = await listArtifactRefs(runId);
	return {
		schemaVersion: 1,
		runId: run.runId,
		state: run.state,
		cleanupState: run.cleanupState,
		workerLive: run.state === "running" ? isWorkerLive(run) : null,
		activeTaskId: run.activeTaskId ?? null,
		activeTaskProvider: run.activeTaskProvider ?? null,
		activeTaskModel: run.activeTaskModel ?? null,
		activeTaskDeadline: run.activeTaskDeadline ?? null,
		completedCount,
		failedCount,
		updatedAt: run.updatedAt,
		terminalSummary: run.terminalSummary ?? null,
		artifactRefs,
	};
}

function isTerminalState(state) {
	return state === "succeeded" || state === "failed";
}

function isCleanupComplete(cleanupState) {
	return cleanupState === "complete";
}

/**
 * Handle the status subcommand.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleStatus(argv) {
	const { help, runId, json: _json } = parseStatusArgs(argv);

	if (help) {
		console.log(USAGE_STATUS);
		return;
	}

	if (!runId) {
		throw new UsageError("missing <run-id> positional argument");
	}

	let run;
	try {
		run = await readRun(runId);
	} catch (error) {
		if (error instanceof SchemaError || error?.name === "SchemaError") {
			console.error(
				`status: corrupt or unsupported state for ${runId}: ${error.message}`,
			);
			process.exitCode = 4;
			return;
		}
		if (error.message?.includes("not found")) {
			console.error(`status: run not found: ${runId}`);
			process.exitCode = 3;
			return;
		}
		throw error;
	}

	const envelope = await buildStatusEnvelope(runId, run);
	console.log(JSON.stringify(envelope));
	process.exitCode = 0;
}

/**
 * Handle the result subcommand.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleResult(argv) {
	const { help, runId, json: _json } = parseResultArgs(argv);

	if (help) {
		console.log(USAGE_RESULT);
		return;
	}

	if (!runId) {
		throw new UsageError("missing <run-id> positional argument");
	}

	let run;
	try {
		run = await readRun(runId);
	} catch (error) {
		if (error instanceof SchemaError || error?.name === "SchemaError") {
			console.error(
				`result: corrupt or unsupported state for ${runId}: ${error.message}`,
			);
			process.exitCode = 4;
			return;
		}
		if (error.message?.includes("not found")) {
			console.error(`result: run not found: ${runId}`);
			process.exitCode = 3;
			return;
		}
		throw error;
	}

	if (!isTerminalState(run.state)) {
		console.error(`result: run ${runId} is not terminal (state: ${run.state})`);
		process.exitCode = 5;
		return;
	}

	const envelope = await buildResultEnvelope(runId, run);
	console.log(JSON.stringify(envelope));

	if (run.state === "succeeded" && isCleanupComplete(run.cleanupState)) {
		process.exitCode = 0;
	} else {
		process.exitCode = 1;
	}
}

async function resolveIsRunDead(runId, dependencies) {
	const readRunFn = dependencies.readRun ?? readRun;
	try {
		await readRunFn(runId);
		// run exists — check if locked/expired would require lock check,
		// but for recovery purposes, treat an existing run as active
		return false;
	} catch {
		// run not found => demonstrably dead
		return true;
	}
}

/**
 * Best-effort liveness probe for a run's worker process.
 * @param {object} run parsed run snapshot
 * @returns {boolean} true only if a signalable worker pid still exists
 */
function isWorkerLive(run) {
	if (run.workerPid == null) return false;
	try {
		// Signal 0 performs error checking without delivering a signal.
		process.kill(run.workerPid, 0);
		return true;
	} catch (e) {
		// ESRCH => no such process; EPERM => process exists but is not ours.
		return e.code === "EPERM";
	}
}

/**
 * Release stale project locks for runs that are dead or terminal.
 *
 * The worker releases its own project lock on every terminal path, but a worker
 * that crashes hard (e.g. process.exit from a fatal handler) can bypass that
 * cleanup. `recover` is the safety net: for each candidate run whose worker is
 * gone (terminal state, or a running state with no live worker), release the
 * project lock so the project is not blocked forever. Runs whose run.json is
 * unreadable are skipped — without a projectPath there is no lock to key on.
 *
 * Release is ownership-checked (`releaseProjectLockIfOwnedBy`), not a blind
 * unlink by path: a lock is keyed by project path only, so a stale candidate
 * whose lock was already superseded by a newer, currently-active run against
 * the same project must never have that active run's lock pulled out from
 * under it.
 *
 * @param {string[]} candidateIds run ids to consider
 * @param {object} dependencies optional injected readRun/releaseProjectLockIfOwnedBy
 * @returns {Promise<string[]>} run ids whose project lock was released
 */
async function releaseStaleProjectLocks(candidateIds, dependencies = {}) {
	const readRunFn = dependencies.readRun ?? readRun;
	const releaseFn =
		dependencies.releaseProjectLockIfOwnedBy ?? releaseProjectLockIfOwnedBy;
	const released = [];
	for (const rid of candidateIds) {
		let run;
		try {
			run = await readRunFn(rid);
		} catch {
			// run.json missing/unreadable — no projectPath to key the lock on
			continue;
		}
		const terminal = run.state === "succeeded" || run.state === "failed";
		if (terminal || !isWorkerLive(run)) {
			try {
				const didRelease = await releaseFn(run.projectPath, rid);
				if (didRelease) released.push(rid);
			} catch {
				// unlink failure is non-fatal; the run's Docker recovery still ran
			}
		}
	}
	return released;
}

/**
 * Handle the recover subcommand.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleRecover(argv, dependencies = {}) {
	const { help, runId } = parseRecoverArgs(argv);

	if (help) {
		console.log(USAGE_RECOVER);
		return;
	}

	const managedContainers =
		dependencies.listManagedContainers ?? listManagedContainers;
	let candidateIds;
	if (!runId) {
		candidateIds = managedContainers()
			.map((c) => c.runId)
			.filter(Boolean);
	} else {
		candidateIds = [runId];
	}

	const deadMap = new Map();
	await Promise.all(
		candidateIds.map(async (rid) => {
			deadMap.set(rid, await resolveIsRunDead(rid, dependencies));
		}),
	);

	const result = await recoverManagedObjects({
		isRunActive: (rid) => {
			if (runId) return rid !== runId;
			return !(deadMap.get(rid) ?? false);
		},
		dryRun: false,
	});

	// Filesystem project locks are not Docker-managed objects, so
	// recoverManagedObjects never touches them. Clear stale ones here.
	const projectLocksReleased = await releaseStaleProjectLocks(
		candidateIds,
		dependencies,
	);

	const output = {
		containersReclaimed: result.containersReclaimed,
		volumesReclaimed: result.volumesReclaimed,
		errors: result.errors,
		projectLocksReleased,
		runId: runId ?? null,
		candidates: !runId
			? managedContainers().map((c) => ({
					name: c.name,
					runId: c.runId,
					status: c.status,
				}))
			: [{ runId }],
	};

	console.log(JSON.stringify(output));

	process.exitCode = result.errors.length > 0 ? 1 : 0;
}

/**
 * Main entry point: route to subcommand or backwards-compat positional dispatch.
 * @param {string[]} argv process.argv.slice(2)
 */
async function main(argv) {
	// Find the first positional argument (non-flag) that is a known subcommand
	const subIdx = argv.findIndex(
		(a) => !a.startsWith("-") && KNOWN_SUBCOMMANDS.has(a),
	);

	if (subIdx >= 0) {
		const subcommand = argv[subIdx];
		const subArgs = [...argv.slice(0, subIdx), ...argv.slice(subIdx + 1)];

		switch (subcommand) {
			case "run":
			case undefined: {
				// run subcommand is equivalent to positional dispatch
				const opts = parseDispatchArgs(subArgs);
				if (opts.help) {
					console.log(subcommand === "run" ? USAGE_RUN : USAGE);
					return;
				}
				runDispatch(opts);
				break;
			}
			case "launch": {
				await handleLaunch(subArgs);
				break;
			}
			case "status": {
				await handleStatus(subArgs);
				break;
			}
			case "result": {
				await handleResult(subArgs);
				break;
			}
			case "recover": {
				await handleRecover(subArgs);
				break;
			}
			default:
				throw new UsageError(`unknown subcommand: ${subcommand}`);
		}
	} else {
		// Backwards compat: positional dispatch (no explicit subcommand)
		const opts = parseDispatchArgs(argv);
		if (opts.help) {
			console.log(USAGE);
			return;
		}
		runDispatch(opts);
	}
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`dispatch: ${error.message}\n`);
			console.error(USAGE);
			process.exitCode = 2;
		} else {
			console.error(`dispatch: run aborted: ${error.message}`);
			process.exitCode = 1;
		}
	}
}

export {
	captureHostFingerprint,
	handleLaunch,
	handleRecover,
	handleResult,
	handleStatus,
	parseDispatchArgs,
	parseLaunchArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
};
