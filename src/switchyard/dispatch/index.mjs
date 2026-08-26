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
//   --exclude-provider <name>  Never route to this provider (repeatable).
//   --platform <macos>     Queue workspace platform (default: macos).
//   --help                 Show this help.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import { ParallelsExecutionBackend } from "../lifecycle/parallels-execution-backend.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import {
	acquireProjectLock,
	acquireRunLock,
	advanceState,
	applyRetention,
	createEvent,
	getRunRoot,
	getStateRoot,
	getVmAdmissionRoot,
	initializeRun,
	RevisionError,
	readEvents,
	readRun,
	releaseProjectLockIfOwnedBy,
	releaseRunLock,
	SchemaError,
	updateRun,
	updateRunWithRetry,
} from "../run-store/index.mjs";
import {
	computeQueueIdentityFromFile,
	deriveQueueDiagnostics,
	getCheckpointPath,
	getProjectRevision,
	loadCheckpoint,
	loadTaskQueue,
	normalizeRunOptions,
	runQueueAsync,
} from "../runner/index.mjs";

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
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --platform <macos>     Queue workspace platform (default: macos)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --help                 Show this help`;

const USAGE_RUN = `Usage: switchyard-dispatch run <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --platform <macos>     Queue workspace platform (default: macos)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --help                 Show this help`;

const USAGE_LAUNCH = `Usage: switchyard-dispatch launch <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --help                 Show this help`;

const USAGE_STATUS = `Usage: switchyard-dispatch status <run-id> [--json]

  --json                    Output as JSON (default behavior)
  --state-root <path>       Read the run from this launch's durable state root
  --help     Show this help`;

const USAGE_RESULT = `Usage: switchyard-dispatch result <run-id> [--json]

  --json                    Output as JSON (default behavior)
  --state-root <path>       Read the run from this launch's durable state root
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

// Grace window for a run that has been initialized but whose worker has not yet
// acquired the run lock (workerPid still null). Within this window `recover`
// treats the run — and its working container — as a launching dispatch and
// leaves it alone; past it, a still-worker-less run is a stuck/abandoned launch
// and is reclaimable. Generous relative to real startup (spawn + fingerprint +
// acquireRunLock is seconds; container creation happens AFTER the lock).
const RUN_STARTUP_GRACE_MS = 5 * 60_000;

/**
 * Publish the detached-launch handshake only if the worker has not already
 * claimed the run. The worker can reach `running` during the parent's 500 ms
 * launch grace period; an unconditional `advanceState(..., "launcher_ready")`
 * would then regress the durable state and make status lie about a live run.
 *
 * @param {string} runId
 * @returns {Promise<object>} the current or updated run snapshot
 */
async function markLauncherReadyIfLaunching(runId) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const current = await readRun(runId);
		if (current.state !== "launching") return current;

		try {
			return await updateRun(
				runId,
				{ state: "launcher_ready" },
				current.revision,
			);
		} catch (error) {
			if (!(error instanceof RevisionError)) throw error;
			// A worker or another lifecycle writer won the optimistic-concurrency
			// race. Re-read before deciding whether the handshake is still valid.
		}
	}

	throw new Error(
		`Could not publish launcher_ready for ${runId}: run changed concurrently`,
	);
}

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
				"exclude-provider": { type: "string", multiple: true },
				"only-provider": { type: "string", multiple: true },
				provider: { type: "string", multiple: true },
				"task-id": { type: "string", multiple: true },
				platform: { type: "string" },
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
	// seedProjectWithBackend archives the project's committed HEAD into each
	// workspace, so a non-repo project can't be dispatched against.
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

	const onlyProviders = [
		...(values["only-provider"] ?? []),
		...(values.provider ?? []),
	];
	const platform = String(values.platform ?? "macos")
		.trim()
		.toLowerCase();
	if (platform !== "macos") {
		throw new UsageError(`--platform must be macos, got "${values.platform}"`);
	}
	if (
		onlyProviders.length > 0 &&
		(values["exclude-provider"] ?? []).length > 0
	) {
		throw new UsageError(
			"--only-provider/--provider and --exclude-provider are mutually exclusive",
		);
	}

	return {
		help: false,
		tasksFilePath: resolvedTasks,
		projectPath,
		maxTasks,
		checkpointPath: values.checkpoint ? resolve(values.checkpoint) : undefined,
		stopOnFailure: !values["no-stop-on-failure"],
		excludeProviders: values["exclude-provider"] ?? [],
		onlyProviders,
		taskIds: values["task-id"] ?? [],
		platform,
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
				"state-root": { type: "string" },
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
		stateRoot: values["state-root"] ?? null,
	};
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function withStateRoot(stateRoot, operation) {
	if (!stateRoot) return operation();
	const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	try {
		return await operation();
	} finally {
		if (previous === undefined) {
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		} else {
			process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
		}
	}
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
 *
 * Wraps runQueue in a minimal run-store lifecycle (a runId + a run lock that
 * stamps this process's PID) so the working container it creates is (a)
 * labeled with the runId and (b) liveness-checkable by `recover`: while this
 * process lives the run reads active and is never reaped; on clean exit we
 * advance to a terminal state; on a crash the dead PID makes the run — and its
 * leaked container — reclaimable. The run-store steps are best-effort: a
 * run-store failure must not block a foreground dispatch, so we fall back to
 * an unlabeled (legacy) container rather than aborting. An exclusive project
 * lock (INV-6) is held across queue execution and released on every terminal
 * path; it is only acquired after the run record exists, so a killed dispatch
 * can never strand a lock whose missing run record `recover` refuses to
 * reclaim.
 * @param {object} opts Result of parseDispatchArgs (help:false variant)
 * @param {object} [dependencies] Injectable dependencies (tests only)
 * @param {(options: object) => object} [dependencies.runQueue] Defaults to the
 *   real runQueue; tests stub it so the dispatch lock lifecycle can be proven
 *   in isolation from queue execution (no VM workspaces on that path).
 */
async function runDispatch(opts, dependencies = {}) {
	// A dispatch belongs to its target project, not to this checkout. Keeping
	// durable state beside that project avoids File Provider permissions on a
	// separately checked-out Switchyard source tree. Explicit overrides remain
	// authoritative for isolated tests and shared operational stores.
	if (!process.env.SWITCHYARD_RUN_STORE_ROOT) {
		process.env.SWITCHYARD_RUN_STORE_ROOT = resolve(
			opts.projectPath,
			".logs",
			"switchyard",
		);
	}
	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)();
	console.error(`dispatch: queue    ${opts.tasksFilePath}`);
	console.error(`dispatch: project  ${opts.projectPath}`);
	console.error(
		"dispatch: routing host-side by usage headroom; each task runs headless in a disposable per-provider container.",
	);
	console.error(
		"dispatch: expect several minutes per task while the provider CLI runs.",
	);

	// Pre-dispatch sweep (Piece C): reap any container a prior crashed run
	// leaked so the host self-heals every dispatch. Fire-and-forget — hygiene
	// must NOT sit on the dispatch critical path; the resource limits are the
	// meltdown safety gate, so the sweep only needs to run eventually. It starts
	// before this run's id exists, so it cannot see (or reap) our own run/
	// container. This process lives for the whole dispatch (minutes), giving the
	// sweep ample time to finish. The .catch prevents an unhandledRejection.
	sweepManagedOrphans()
		.then((swept) => {
			// These once read `containersReclaimed`/`volumesReclaimed`, which
			// sweepManagedOrphans stopped returning at the Docker-to-Parallels
			// rename. `undefined > 0` is false, so the branch was unreachable
			// and every pre-run reclamation went unreported.
			if (swept.vmsReclaimed > 0) {
				console.error(
					`dispatch: pre-run sweep reclaimed ${swept.vmsReclaimed} orphaned VM(s)`,
				);
			}
			for (const entry of swept.unreclaimedSnapshots) {
				console.error(
					`dispatch: pre-run sweep left snapshots on the golden for ${entry.name} (${entry.reason}) — human review required`,
				);
			}
		})
		.catch((error) => {
			console.error(`dispatch: pre-run sweep failed (${error.message})`);
		});

	// Retention sweep (Task D.5): dry-run only for this pass — logs what WOULD
	// be reclaimed without deleting anything. David's explicit call: flip
	// dryRun to false in a follow-up once a few dry-run logs have been
	// reviewed. Failed-run directories and their .partial-diffs artifacts are
	// explicitly OUT OF SCOPE here (CR-7/CR-11/PM-7 disposition) — this only
	// ever reaps succeeded && cleanupState:"complete" runs, same as always.
	// Malformed run directories are quarantined (moved, not deleted) on every
	// sweep regardless of dryRun — same as always for that path — since a
	// record that can't be read never becomes "eligible" and would otherwise
	// fail this same scan forever. The one conservative exception: a run
	// directory whose run.json is absent (ENOENT — e.g. a concurrent
	// initializeRun mid-flight) is left for a later sweep, not quarantined.
	// This sweep remains synchronous-dispatch-only:
	// detached launch and worker-bootstrap intentionally do not invoke it.
	applyRetention({ maxAgeDays: 30, dryRun: true })
		.then(({ deletedCount, quarantined }) => {
			if (deletedCount > 0) {
				console.error(
					`dispatch: retention sweep (dry-run) found ${deletedCount} run-store director${deletedCount === 1 ? "y" : "ies"} older than 30 days eligible for reclaim — no deletion performed`,
				);
			}
			for (const entry of quarantined) {
				console.error(
					`dispatch: retention sweep quarantined run ${entry.runId} (${entry.reason})`,
				);
			}
		})
		.catch((error) => {
			console.error(`dispatch: retention sweep failed (${error.message})`);
		});

	const runId = randomUUID();
	const pid = process.pid;
	const startToken = randomUUID();
	const nonce = randomUUID();
	// Production dispatch uses the async runner, which owns broker selection,
	// reservations, fallback, and provider execution. Keep the injectable
	// override for lifecycle tests and compatibility callers.
	const runQueueFn = dependencies.runQueue ?? runQueueAsync;

	// Initialize the run record BEFORE the project lock is ever acquired —
	// the same ordering handleLaunch uses. The project lock is keyed by the
	// project path alone and `recover` deliberately refuses to reclaim a lock
	// whose run.json is missing (CR-4/CR-5), so a lock acquired before its run
	// record exists is a permanent block if this process is killed in between.
	// Initializing first means a hard kill at any point after lock acquisition
	// always leaves a run record the recovery model can reason about (INV-6).
	// The lock itself is acquired immediately before queue execution below; on
	// a contention failure it throws the existing LockError and the finally
	// block advances this run's already-written record to a terminal state.
	let runStoreReady = false;
	let identity = null;
	try {
		const tasks = loadTaskQueue(opts.tasksFilePath);
		identity = prepareRunIdentity(opts);
		await initializeRun({
			runId,
			tasksFilePath: opts.tasksFilePath,
			projectPath: opts.projectPath,
			orderedTaskIds: tasks.map((t) => t.id),
			initialHostFingerprint: captureHostFingerprint(opts.projectPath),
			workerNonce: nonce,
			projectRevision: identity.projectRevision,
			runOptions: identity.runOptions,
			queueIdentity: identity.queueIdentity,
		});
		await acquireRunLock(runId, pid, startToken, nonce);
		await advanceState(runId, "running");
		runStoreReady = true;
	} catch (error) {
		throw new Error(
			`dispatch: run-store initialization failed before routing (${error.message})`,
		);
	}

	let result;
	let eventWriteChain = Promise.resolve();
	try {
		// Acquire the exclusive project lock immediately before queue
		// execution, mirroring handleLaunch. This is deliberately NOT
		// best-effort like the run-store init above — the lock is the
		// mutual-exclusion gate, and a run that cannot acquire it must not run
		// (it fails fast with the existing LockError). It is only attempted
		// when the run record exists (runStoreReady): when the run store is
		// degraded there is no record for `recover` to key on, so holding the
		// lock would recreate the unreclaimable-orphan window this ordering
		// exists to prevent — the run instead degrades to the unlabeled legacy
		// path (no lock, no runId label), exactly as a run-store failure always
		// has. Release on every terminal path is guaranteed by the finally
		// block below.
		if (runStoreReady) {
			await acquireProjectLock(opts.projectPath, runId);
		}
		result = await runQueueFn({
			tasksFilePath: opts.tasksFilePath,
			projectPath: opts.projectPath,
			maxTasks: opts.maxTasks,
			checkpointPath:
				opts.checkpointPath ?? getCheckpointPath(opts.tasksFilePath),
			stopOnFailure: opts.stopOnFailure,
			exclude: opts.excludeProviders,
			only: opts.onlyProviders,
			taskIds: opts.taskIds,
			platform: opts.platform,
			runOptions: identity?.runOptions,
			queueIdentity: identity?.queueIdentity,
			projectRevision: identity?.projectRevision,
			...(runStoreReady ? { runId } : {}),
			dependencies: {
				onTaskStart: (task) =>
					console.error(
						`dispatch: -> task ${task.id} ${task.title ?? ""}`.trimEnd(),
					),
				onTaskRouted: (info) => {
					console.error(
						`dispatch:    routed to ${info.provider}${info.model ? `/${info.model}` : ""} — deadline ${info.deadline ?? "orchestrator"}`,
					);
					if (runStoreReady) {
						eventWriteChain = eventWriteChain
							.then(() =>
								updateRunWithRetry(runId, {
									activeTaskProvider: info.provider,
									activeTaskModel: info.model,
									activeTaskDeadline: info.deadline ?? null,
									resolvedTargetId: info.resolvedTargetId ?? null,
									activeTaskInvocationDescriptor:
										info.invocationDescriptor ?? null,
									activeTaskDescriptorIdentity: info.descriptorIdentity ?? null,
									activeTaskDescriptorHarness: info.descriptorHarness ?? null,
									dispatchContractVersion: info.dispatchContractVersion ?? 1,
									snapshotStatus: info.snapshotStatus ?? null,
									snapshotMtime: info.snapshotMtime ?? null,
									snapshotAgeMsAtRoute: info.snapshotAgeMsAtRoute ?? null,
								}),
							)
							.catch(() => {});
					}
				},
				onResult: (r) => {
					const safeFailure = sanitizeFailureMetadata(r);
					const artifactRef =
						typeof r.artifactRef === "string" &&
						/^artifact:[a-f0-9]{24}$/.test(r.artifactRef)
							? r.artifactRef
							: undefined;
					const where = `${r.provider ?? "no-provider"}${r.model ? `/${r.model}` : ""}`;
					const displayReason =
						safeFailure?.reason ?? (r.success ? "" : "task failed");
					console.error(
						`dispatch: ${r.success ? "ok  " : "FAIL"} task ${r.taskId} [${where}] ${r.result}${displayReason ? ` (${displayReason})` : ""}`,
					);
					if (runStoreReady) {
						const event = {
							phase: "execution",
							event: r.success ? "task_completed" : "task_failed",
							status: `Task ${r.taskId} ${r.success ? "completed" : "failed"}`,
							taskId: r.taskId,
							provider: r.provider ?? null,
							model: r.model ?? null,
							invocationDescriptor: r.invocationDescriptor ?? null,
							descriptorIdentity: r.descriptorIdentity ?? null,
							descriptorHarness: r.descriptorHarness ?? null,
							resolvedTargetId: r.resolvedTargetId ?? null,
							dispatchContractVersion: r.dispatchContractVersion ?? 1,
							result: r.result,
							...(r.alreadyApplied ? { alreadyApplied: true } : {}),
							...(safeFailure ?? {}),
							...(artifactRef ? { artifactRef } : {}),
						};
						eventWriteChain = eventWriteChain
							.then(async () => {
								await createEvent(runId, event);
								await updateRunWithRetry(runId, {
									activeTaskId: null,
									activeTaskProvider: null,
									activeTaskModel: null,
									activeTaskDeadline: null,
									activeTaskInvocationDescriptor: null,
									activeTaskDescriptorIdentity: null,
									activeTaskDescriptorHarness: null,
									resolvedTargetId: null,
									lastResolvedTargetId: r.resolvedTargetId ?? null,
									lastTaskInvocationDescriptor: r.invocationDescriptor ?? null,
									lastTaskDescriptorIdentity: r.descriptorIdentity ?? null,
									lastTaskDescriptorHarness: r.descriptorHarness ?? null,
									...(safeFailure ? { lastFailure: safeFailure } : {}),
								});
							})
							.catch(() => {});
					}
				},
			},
		});
	} finally {
		if (runStoreReady) {
			// Advance to a terminal state (so `recover` treats this run as
			// reclaimable) and release the run lock. Best-effort — never mask
			// the original outcome/throw. If runQueue threw, result is undefined:
			// treat that as a failed run.
			const anyFailed = result ? result.results.some((r) => !r.success) : true;
			try {
				await eventWriteChain;
				// Single combined terminal write (mirrors worker-bootstrap's
				// terminalPatch): setting cleanupState:"complete" here is what
				// makes a sync-path run retention-eligible (applyRetention only
				// reaps succeeded && cleanupState:"complete"). Must be one call —
				// advanceState can only carry {state}, and a second separate
				// write would race the releaseRunLock revision bump.
				await updateRunWithRetry(runId, {
					state: anyFailed ? "failed" : "succeeded",
					cleanupState: "complete",
					activeTaskInvocationDescriptor: null,
					activeTaskDescriptorIdentity: null,
					activeTaskDescriptorHarness: null,
				});
				await releaseRunLock(runId);
			} catch (error) {
				console.error(`dispatch: run-store teardown failed (${error.message})`);
			}
		}
		// Release the project lock on every terminal path — success, a
		// failed-task result, a thrown runQueue error, or a lock-contention
		// failure — so a follow-up run against the same project is never
		// blocked (INV-6). On a contention failure the lock was never ours to
		// hold, and the ownership check below is exactly what stops this
		// teardown from unlinking the winner's lock. Runs AFTER the run-store
		// teardown above (mirroring worker-bootstrap's release ordering), and
		// independently of it: the lock is released even when runStoreReady is
		// false. Ownership-checked so this teardown can never unlink a lock a
		// newer run legitimately re-acquired; best-effort so a release failure
		// can't mask the run's own outcome (`recover` reclaims any lock this
		// leaves behind).
		try {
			await releaseProjectLockIfOwnedBy(opts.projectPath, runId);
		} catch (error) {
			console.error(`dispatch: project lock release failed (${error.message})`);
		}
	}

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
		const statusArgs = ["status", "--porcelain", "--untracked-files=all"];
		const relativeStateRoot = relative(
			resolve(projectPath),
			resolve(getStateRoot()),
		);
		if (
			relativeStateRoot &&
			!isAbsolute(relativeStateRoot) &&
			!relativeStateRoot.startsWith(`..${sep}`)
		) {
			statusArgs.push("--", ".", `:(exclude)${relativeStateRoot}/**`);
		}
		const statusResult = spawnSync("git", statusArgs, {
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

function prepareRunIdentity(opts) {
	const checkpointPath =
		opts.checkpointPath ?? getCheckpointPath(opts.tasksFilePath);
	const runOptions = normalizeRunOptions({
		maxTasks: opts.maxTasks,
		checkpointPath,
		stopOnFailure: opts.stopOnFailure,
		onlyProviders: opts.onlyProviders,
		excludeProviders: opts.excludeProviders,
		taskIds: opts.taskIds,
		platform: opts.platform,
	});
	const projectRevision = getProjectRevision(opts.projectPath);
	const { queueIdentity } = computeQueueIdentityFromFile(
		opts.tasksFilePath,
		projectRevision,
		runOptions,
	);
	return { checkpointPath, projectRevision, runOptions, queueIdentity };
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
	assertGenerationAllowed();
	if (!process.env.SWITCHYARD_RUN_STORE_ROOT) {
		process.env.SWITCHYARD_RUN_STORE_ROOT = resolve(
			opts.projectPath,
			".logs",
			"switchyard",
		);
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
	const identity = prepareRunIdentity(opts);

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
		projectRevision: identity.projectRevision,
		runOptions: identity.runOptions,
		queueIdentity: identity.queueIdentity,
	});

	// NOTE: the pre-dispatch sweep runs in the detached WORKER
	// (worker-bootstrap), NOT here — keeping the host launch handshake fast and
	// off the VM backend (an orphan sweep on this path made `launch` slow and
	// its exit-code tests flaky under contention). The worker sweeps just
	// before it creates this run's workspace; the synchronous `run` path
	// sweeps in-process (see runDispatch).

	// initializeRun writes a fixed snapshot literal (run-store/index.mjs) with
	// no options passthrough, so a launch-time option that needs to become its
	// own named field on the run record — as opposed to just riding along
	// inside the raw launchArgs array above — is persisted via a follow-up
	// updateRunWithRetry rather than threaded into the initializeRun call
	// itself. worker-bootstrap reads them back off run.excludeProviders,
	// run.onlyProviders, and run.stopOnFailure.
	await updateRunWithRetry(runId, {
		excludeProviders: opts.excludeProviders,
		onlyProviders: opts.onlyProviders,
		stopOnFailure: opts.stopOnFailure,
		taskIds: opts.taskIds,
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

	const readyRun = await markLauncherReadyIfLaunching(runId);

	const envelope = {
		schemaVersion: readyRun.schemaVersion ?? 1,
		runId,
		state: "launcher_ready",
		queueIdentity: readyRun.queueIdentity ?? null,
		stateRoot,
		statusCommand: `switchyard-dispatch status ${runId} --state-root ${shellQuote(stateRoot)}`,
		resultCommand: `switchyard-dispatch result ${runId} --state-root ${shellQuote(stateRoot)}`,
	};
	console.log(JSON.stringify(envelope));
}

// Best-effort event read: a missing/unreadable events.jsonl (e.g. a run
// that hasn't started executing yet) degrades to an empty list rather than
// failing the envelope build.
async function readEventsSafe(runId) {
	try {
		return await readEvents(runId);
	} catch {
		// events may be absent or unreadable
		return [];
	}
}

function countCompletedAndFailed(events) {
	let completedCount = 0;
	let failedCount = 0;
	for (const evt of events) {
		if (evt.phase === "execution" && evt.event === "task_completed") {
			completedCount += 1;
		}
		if (evt.phase === "execution" && evt.event === "task_failed") {
			failedCount += 1;
		}
	}
	return { completedCount, failedCount };
}

// Best-effort checkpoint read, mirroring readEventsSafe above: status/result
// are read-only diagnostic commands, so a checkpoint that's absent (fresh
// run, nothing written yet) or corrupt (loadCheckpoint's fail-loud path —
// appropriate for runQueue's own write path, where silently discarding
// completed-task history would cause a full destructive re-run) must not
// crash the *observation* of a run. It degrades to null, which
// deriveTelemetryFields treats as an empty completed set — the same
// pendingCount an operator would see before any checkpoint existed.
//
// Reads the same checkpoint state `runQueue` itself consults
// (getCheckpointPath(tasksFilePath)) so `pendingCount` reflects tasks
// completed by a prior process on a resumed run, not just this run's own
// event log. Mirrors runQueue's own default-path resolution — dispatch never
// threads a custom `--checkpoint` path through run-store, so the default is
// always the one in effect for a launched run.
function readCheckpointStateForRun(run) {
	try {
		const checkpointPath =
			run.runOptions?.checkpointPath ?? getCheckpointPath(run.tasksFilePath);
		return loadCheckpoint(
			checkpointPath,
			run.tasksFilePath,
			run.queueIdentity
				? {
						queueIdentity: run.queueIdentity,
						runOptions: run.runOptions,
					}
				: null,
		);
	} catch {
		// checkpoint exists but is corrupt/unreadable — degrade rather than
		// failing an otherwise-healthy status/result read
		return null;
	}
}

const QUEUE_DIAGNOSTICS_UNAVAILABLE = Object.freeze({
	selected: { count: 0, reason: "queue_unavailable" },
	runnable: { count: 0, reason: "queue_unavailable" },
	humanGated: { count: 0, reason: "queue_unavailable" },
	nativeGated: { count: 0, reason: "queue_unavailable" },
	dependencyBlocked: { count: 0, reason: "queue_unavailable" },
	externalBlocked: { count: 0, reason: "queue_unavailable" },
	completed: { count: 0, reason: "queue_unavailable" },
});

function readQueueDiagnosticsForRun(run, checkpointState) {
	try {
		const tasks = loadTaskQueue(run.tasksFilePath);
		return deriveQueueDiagnostics(tasks, checkpointState, {
			selectedTaskIds: run.runOptions?.taskIds ?? run.taskIds ?? [],
		});
	} catch {
		// Status/result are observation surfaces. A malformed or unavailable
		// queue must never echo its parser error or arbitrary task content.
		return QUEUE_DIAGNOSTICS_UNAVAILABLE;
	}
}

/**
 * Derive the throughput/telemetry fields shared by buildStatusEnvelope and
 * buildResultEnvelope, so the two envelope builders can't drift on the same
 * underlying aggregate-progress signal.
 *
 * @param {object} run parsed run snapshot
 * @param {Array<object>} events this run's event log (readEventsSafe result)
 * @param {object|null} checkpointState checkpoint state read via
 *   readCheckpointStateForRun; `pendingCount` is derived from its
 *   `completedTaskIds` rather than from `events`, so a resumed run against a
 *   pre-existing checkpoint (tasks completed by a prior process, with no
 *   matching event in this run's own events.jsonl) is still counted
 *   correctly instead of over/under-counting via a flat
 *   `orderedTaskIds.length - events.length` subtraction.
 * @returns {object} shared telemetry fields
 */
function deriveTelemetryFields(run, events, checkpointState) {
	void events;

	const now = Date.now();
	const queueStartedAt = new Date(run.createdAt).getTime();
	const completedIds = new Set(checkpointState?.completedTaskIds ?? []);
	const pendingCount = run.orderedTaskIds.filter(
		(id) => !completedIds.has(id),
	).length;

	return {
		queueStartedAt,
		elapsedMs: now - queueStartedAt,
		totalTaskCount: run.orderedTaskIds.length,
		pendingCount,
		// Single worker processes one task at a time, so "running" is a
		// 0/1 signal keyed off whether a task is currently active.
		runningCount: run.activeTaskId != null ? 1 : 0,
		lastCompletionAt: run.lastCompletionAt ?? null,
		// Before the first completion this falls back to queueStartedAt,
		// overstating elapsed time by launch/lock/verification overhead
		// (typically sub-second to low-single-digit seconds) — negligible
		// against this field's hours-scale purpose.
		elapsedSinceLastCompletionMs:
			now - (run.lastCompletionAt ?? queueStartedAt),
		// Gated on activeTaskId, not activeTaskStartedAt: activeTaskStartedAt
		// is set once at task start and never cleared (onResult's patch nulls
		// activeTaskId/Provider/Model/Deadline but omits it), so gating on it
		// directly would report a stale, ever-growing age after the task
		// completes or the run reaches a terminal state. activeTaskId IS
		// reliably nulled on completion/terminal/crash — same reasoning as
		// runningCount two lines above.
		activeTaskAgeMs:
			run.activeTaskId != null ? now - run.activeTaskStartedAt : null,
		// Display-only: derived from the routed deadline, not a scheduling
		// guarantee. Can go negative if a task runs past its deadline.
		activeTaskRemainingMs:
			run.activeTaskDeadline != null
				? new Date(run.activeTaskDeadline).getTime() - now
				: null,
	};
}

function deriveRetryProjection(checkpointState) {
	return {
		quarantinedTargetIds: Array.isArray(checkpointState?.quarantinedTargetIds)
			? [...checkpointState.quarantinedTargetIds]
			: [],
		retryState: checkpointState?.retryState ?? null,
		retryTransitionId: Number.isInteger(checkpointState?.retryTransitionId)
			? checkpointState.retryTransitionId
			: 0,
	};
}

// Maps a run's routed provider (run.activeTaskProvider) to the binary name
// its CLI actually execs as inside the working container. Most providers'
// CLI binary matches the provider key, but cursor's does not — its package
// is "cursor-agent", not "cursor" — so this must stay an explicit map
// rather than an assumed identity transform.
const PROVIDER_BINARY_NAMES = {
	claude: "claude",
	codex: "codex",
	agy: "agy",
	cursor: "cursor-agent",
	copilot: "copilot",
	opencode: "opencode",
};

/**
 * Build the execution backend used to inspect/reclaim a run's workspace,
 * mirroring runner/index.mjs's createQueueBackend construction so a later,
 * separate `status`/`result`/`recover` process reconstructs the same backend
 * shape the worker did.
 * @returns {import("../lifecycle/execution-backend.mjs").ExecutionBackend}
 */
function executionBackendForRun() {
	return new ParallelsExecutionBackend({
		goldenImage: process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE,
		aquaUid: process.env.SWITCHYARD_PARALLELS_AQUA_UID,
		providerUser:
			process.env.SWITCHYARD_PARALLELS_PROVIDER_USER ?? "switchyard",
		// This is the process that reclaims a dead worker's clones, so it is the
		// one that most needs to read the sidecars a live worker wrote.
		snapshotSidecarRoot: getVmAdmissionRoot(),
	});
}

/**
 * Match one `ps -axo pid=,command=` output line against a target binary
 * name. The format is "<pid><whitespace><args...>" where the args column is
 * itself whitespace-separated (argv[0] is its first token); this compares
 * the basename of that first token so a fully-qualified path (e.g.
 * "/usr/local/bin/claude") still matches "claude".
 * @param {string} line one line of guest `ps` output
 * @param {string} binaryName target executable basename
 * @returns {boolean}
 */
function lineMatchesBinary(line, binaryName) {
	const match = line.trim().match(/^\d+\s+(\S+)/);
	if (!match) return false;
	const executable = match[1];
	const base = executable.split("/").pop();
	return base === binaryName;
}

/**
 * Best-effort presence probe for whether the provider CLI routed to this
 * run (run.activeTaskProvider) is actually executing inside the run's
 * workspace: inspect the workspace through the execution backend, catch any
 * failure, and degrade to null rather than throwing — a diagnostic nicety
 * surfaced via the providerProcessDetected envelope field must never crash
 * or indefinitely block a status/result read.
 *
 * Only the derived boolean crosses into the envelope — raw guest `ps`
 * output (which can include other processes' full command lines) is never
 * exposed, since that would be a potential information leak, not just a
 * style choice.
 *
 * Self-gates on run.state === "running" as its first check (in addition to
 * the identical ternary at each call site, mirroring workerLive) so the
 * function is safe to call unconditionally and never shells out at all —
 * not even attempting a probe whose result gets discarded — for a
 * non-running run.
 *
 * @param {object} run parsed run snapshot
 * @param {object} [deps] Injectable dependencies (tests only)
 * @param {import("../lifecycle/execution-backend.mjs").ExecutionBackend} [deps.executionBackend]
 *   Defaults to a fresh ParallelsExecutionBackend
 * @param {(command: string, args: string[], options: object) => Buffer | string} [deps.execFn]
 *   Compatibility injection: routed into a ParallelsExecutionBackend's own
 *   execFn seam instead of executionBackend when supplied.
 * @returns {boolean|null} true/false once the probe runs successfully;
 *   null if the run isn't currently running, isn't routed to a
 *   workspace/provider yet, the provider has no known binary mapping, or
 *   the probe itself failed
 */
function probeProviderProcess(run, { executionBackend, execFn } = {}) {
	if (run.state !== "running") return null;

	const { workingContainerName, activeTaskProvider } = run;
	if (!workingContainerName || !activeTaskProvider) return null;

	const binaryName = PROVIDER_BINARY_NAMES[activeTaskProvider];
	if (!binaryName) return null;

	try {
		const backend = execFn
			? new ParallelsExecutionBackend({ execFn })
			: (executionBackend ?? executionBackendForRun());
		const output = backend.inspectProcess(workingContainerName).toString();
		return output
			.split("\n")
			.some((line) => lineMatchesBinary(line, binaryName));
	} catch {
		// VM unreachable, workspace gone/mid-restart, the guest ps call
		// erroring, or a timeout tripped — degrade to null rather than throw.
		return null;
	}
}

async function buildStatusEnvelope(runId, run) {
	const events = await readEventsSafe(runId);
	const { completedCount, failedCount } = countCompletedAndFailed(events);
	const checkpointState = readCheckpointStateForRun(run);
	const telemetry = deriveTelemetryFields(run, events, checkpointState);
	const retryProjection = deriveRetryProjection(checkpointState);
	const queueDiagnostics = readQueueDiagnosticsForRun(run, checkpointState);
	return {
		schemaVersion: run.schemaVersion ?? 1,
		runId: run.runId,
		queueIdentity: run.queueIdentity ?? null,
		state: run.state,
		cleanupState: run.cleanupState,
		// Liveness derived from a signal-0 probe of the recorded worker pid
		// (see isWorkerLive), so an operator doesn't have to shell out to
		// `ps` to tell active work from a stalled/ghost run.
		workerLive: run.state === "running" ? isWorkerLive(run) : null,
		// Presence of the routed provider's CLI process inside the working
		// VM workspace (see probeProviderProcess) — same conditional-null-when-
		// not-running shape as workerLive, and same "skip the shell-out
		// entirely when not running" rule.
		providerProcessDetected:
			run.state === "running"
				? probeProviderProcess(run, {
						executionBackend: executionBackendForRun(),
					})
				: null,
		activeTaskId: run.state === "running" ? (run.activeTaskId ?? null) : null,
		activeTaskProvider:
			run.state === "running" ? (run.activeTaskProvider ?? null) : null,
		activeTaskModel:
			run.state === "running" ? (run.activeTaskModel ?? null) : null,
		activeTaskDeadline:
			run.state === "running" ? (run.activeTaskDeadline ?? null) : null,
		activeTaskElapsedMs:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskElapsedMs ?? 0)
				: null,
		activeTaskHeartbeatAt:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskHeartbeatAt ?? null)
				: null,
		activeTaskProcessPhase:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskProcessPhase ?? null)
				: null,
		telemetryWriteFailures: run.telemetryWriteFailures ?? 0,
		lastTelemetryWriteFailure: run.lastTelemetryWriteFailure ?? null,
		resolvedTargetId: run.resolvedTargetId ?? null,
		activeTaskInvocationDescriptor:
			run.state === "running"
				? (run.activeTaskInvocationDescriptor ?? null)
				: null,
		activeTaskDescriptorIdentity:
			run.state === "running"
				? (run.activeTaskDescriptorIdentity ?? null)
				: null,
		activeTaskDescriptorHarness:
			run.state === "running"
				? (run.activeTaskDescriptorHarness ?? null)
				: null,
		lastTaskInvocationDescriptor: run.lastTaskInvocationDescriptor ?? null,
		lastTaskDescriptorIdentity: run.lastTaskDescriptorIdentity ?? null,
		lastTaskDescriptorHarness: run.lastTaskDescriptorHarness ?? null,
		lastResolvedTargetId: run.lastResolvedTargetId ?? null,
		dispatchContractVersion: run.dispatchContractVersion ?? null,
		snapshotStatus: run.snapshotStatus ?? null,
		snapshotMtime: run.snapshotMtime ?? null,
		snapshotAgeMsAtRoute: run.snapshotAgeMsAtRoute ?? null,
		completedCount,
		failedCount,
		// Reconciled against the same artifacts channel `result` reports, so the
		// two envelopes cannot disagree about whether a failure has an artifact.
		lastFailure: reconcileFailureArtifactRef(
			run.lastFailure ?? null,
			await listArtifactRefs(runId),
		),
		...retryProjection,
		queueDiagnostics,
		updatedAt: run.updatedAt,
		...telemetry,
	};
}

/**
 * Drop a `lastFailure.artifactRef` the artifacts channel cannot resolve.
 *
 * The ref and the channel are written by two different paths: the ref is
 * derived unconditionally from the task id, while the copy into the run's
 * `artifacts/` directory is best-effort and swallows its own failure. When the
 * copy loses, the operator sees a reference in `lastFailure` that is absent
 * from `artifactRefs` and has no way to tell a lost artifact from a bad
 * pointer. Observed on run eab7d23c (2026-08-25): `artifactRef` was set while
 * `artifactRefs` was `[]`. Report only what the run can actually produce.
 * @param {object|null} lastFailure
 * @param {string[]} artifactRefs refs the artifacts channel actually lists
 * @returns {object|null}
 */
function reconcileFailureArtifactRef(lastFailure, artifactRefs) {
	if (!lastFailure || typeof lastFailure !== "object") {
		return lastFailure ?? null;
	}
	if (typeof lastFailure.artifactRef !== "string") return lastFailure;
	if (artifactRefs.includes(lastFailure.artifactRef)) return lastFailure;
	const { artifactRef: _unresolvable, ...rest } = lastFailure;
	return rest;
}

async function listArtifactRefs(runId) {
	const artifactsDir = resolve(getRunRoot(runId), "artifacts");
	try {
		const entries = await readdir(artifactsDir, { withFileTypes: true });
		return entries
			.filter((e) => e.isFile())
			.map(
				(e) =>
					`artifact:${createHash("sha256")
						.update(e.name)
						.digest("hex")
						.slice(0, 24)}`,
			);
	} catch {
		return [];
	}
}

async function buildResultEnvelope(runId, run) {
	const events = await readEventsSafe(runId);
	const { completedCount, failedCount } = countCompletedAndFailed(events);
	const checkpointState = readCheckpointStateForRun(run);
	const telemetry = deriveTelemetryFields(run, events, checkpointState);
	const retryProjection = deriveRetryProjection(checkpointState);
	const queueDiagnostics = readQueueDiagnosticsForRun(run, checkpointState);
	const artifactRefs = await listArtifactRefs(runId);
	return {
		schemaVersion: run.schemaVersion ?? 1,
		runId: run.runId,
		queueIdentity: run.queueIdentity ?? null,
		state: run.state,
		cleanupState: run.cleanupState,
		workerLive: run.state === "running" ? isWorkerLive(run) : null,
		providerProcessDetected:
			run.state === "running"
				? probeProviderProcess(run, {
						executionBackend: executionBackendForRun(),
					})
				: null,
		activeTaskId: run.state === "running" ? (run.activeTaskId ?? null) : null,
		activeTaskProvider:
			run.state === "running" ? (run.activeTaskProvider ?? null) : null,
		activeTaskModel:
			run.state === "running" ? (run.activeTaskModel ?? null) : null,
		activeTaskDeadline:
			run.state === "running" ? (run.activeTaskDeadline ?? null) : null,
		activeTaskElapsedMs:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskElapsedMs ?? 0)
				: null,
		activeTaskHeartbeatAt:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskHeartbeatAt ?? null)
				: null,
		activeTaskProcessPhase:
			run.state === "running" && run.activeTaskId != null
				? (run.activeTaskProcessPhase ?? null)
				: null,
		telemetryWriteFailures: run.telemetryWriteFailures ?? 0,
		lastTelemetryWriteFailure: run.lastTelemetryWriteFailure ?? null,
		resolvedTargetId: run.resolvedTargetId ?? null,
		activeTaskInvocationDescriptor:
			run.state === "running"
				? (run.activeTaskInvocationDescriptor ?? null)
				: null,
		activeTaskDescriptorIdentity:
			run.state === "running"
				? (run.activeTaskDescriptorIdentity ?? null)
				: null,
		activeTaskDescriptorHarness:
			run.state === "running"
				? (run.activeTaskDescriptorHarness ?? null)
				: null,
		lastTaskInvocationDescriptor: run.lastTaskInvocationDescriptor ?? null,
		lastTaskDescriptorIdentity: run.lastTaskDescriptorIdentity ?? null,
		lastTaskDescriptorHarness: run.lastTaskDescriptorHarness ?? null,
		lastResolvedTargetId: run.lastResolvedTargetId ?? null,
		dispatchContractVersion: run.dispatchContractVersion ?? null,
		snapshotStatus: run.snapshotStatus ?? null,
		snapshotMtime: run.snapshotMtime ?? null,
		snapshotAgeMsAtRoute: run.snapshotAgeMsAtRoute ?? null,
		completedCount,
		failedCount,
		lastFailure: reconcileFailureArtifactRef(
			run.lastFailure ?? null,
			artifactRefs,
		),
		...retryProjection,
		queueDiagnostics,
		updatedAt: run.updatedAt,
		terminalSummary: run.terminalSummary ?? null,
		artifactRefs,
		...telemetry,
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
	const { help, runId, json: _json, stateRoot } = parseStatusArgs(argv);

	if (help) {
		console.log(USAGE_STATUS);
		return;
	}

	if (!runId) {
		throw new UsageError("missing <run-id> positional argument");
	}

	return withStateRoot(stateRoot, async () => {
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
	});
}

/**
 * Handle the result subcommand.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleResult(argv) {
	const { help, runId, json: _json, stateRoot } = parseResultArgs(argv);

	if (help) {
		console.log(USAGE_RESULT);
		return;
	}

	if (!runId) {
		throw new UsageError("missing <run-id> positional argument");
	}

	return withStateRoot(stateRoot, async () => {
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
			console.error(
				`result: run ${runId} is not terminal (state: ${run.state})`,
			);
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
	});
}

async function resolveIsRunDead(runId, dependencies) {
	const readRunFn = dependencies.readRun ?? readRun;
	let run;
	try {
		run = await readRunFn(runId);
	} catch {
		// run record not found => demonstrably dead (its container is an orphan).
		return true;
	}

	// A run record existing is NOT proof of life: a crashed worker or a
	// terminal run leaves run.json behind. Disambiguate carefully so a
	// launching dispatch is never reaped mid-startup:
	//   1. terminal state => done, reclaimable.
	//   2. live worker PID => alive (protects a long-running task and a
	//      just-started sync dispatch, whose PID is stamped immediately).
	//   3. workerPid set but not signalable => the worker HELD the lock and
	//      died => crashed => reclaimable.
	//   4. workerPid null => never acquired the lock => still inside the
	//      pre-lock startup window. `workerPid: null` alone is ambiguous
	//      ("not started yet" vs "never will"), so fall back to run age: young
	//      => a legitimately launching run, protect it; older than the startup
	//      grace => an abandoned/stuck launch, reclaim it.
	if (run.state === "succeeded" || run.state === "failed") return true;

	const isWorkerLiveFn = dependencies.isWorkerLive ?? isWorkerLive;
	if (isWorkerLiveFn(run)) return false;

	if (run.workerPid != null) return true;

	const createdMs = new Date(run.createdAt).getTime();
	if (!Number.isFinite(createdMs)) return true;
	return Date.now() - createdMs > RUN_STARTUP_GRACE_MS;
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
				// unlink failure is non-fatal; the run's VM recovery still ran
			}
		}
	}
	return released;
}

/**
 * Build the execution backend a recovery-path caller (sweep or `recover`)
 * inspects/reclaims managed VMs through. A VM's name embeds its own
 * creator pid (see buildParallelsWorkingName/reclaim), so no run-store
 * read is needed to decide liveness.
 * @param {object} [dependencies]
 * @returns {import("../lifecycle/parallels-execution-backend.mjs").ParallelsExecutionBackend}
 */
function recoveryExecutionBackend(dependencies = {}) {
	return dependencies.executionBackend ?? executionBackendForRun();
}

/**
 * Best-effort reap of leaked managed VMs whose creator process is dead —
 * the reusable core of the no-runId `recover` path. Called as a
 * pre-dispatch sweep (Piece C of the leak-recovery loop) so every dispatch
 * self-heals the previous run's leaks before creating its own workspace.
 * @param {object} [dependencies]
 * @returns {Promise<{vmsReclaimed:number,
 *   unreclaimedSnapshots:Array<{name:string, uuid:string, reason:string}>,
 *   errors:string[], projectLocksReleased:number}>}
 */
async function sweepManagedOrphans(dependencies = {}) {
	const executionBackend = recoveryExecutionBackend(dependencies);
	const listManaged =
		dependencies.listManaged ?? (() => executionBackend.listManaged());
	const reclaim =
		dependencies.reclaim ?? ((opts) => executionBackend.reclaim(opts));

	const candidateIds = listManaged()
		.map((entry) => entry.runId)
		.filter(Boolean);

	const result = reclaim({ dryRun: false });

	const projectLocksReleased = await releaseStaleProjectLocks(
		candidateIds,
		dependencies,
	);

	return {
		vmsReclaimed: result.reclaimed.length,
		// A reclaimed VM whose sidecar was lost leaves parent snapshots on the
		// golden that this code may never delete (see reclaim()). That residue
		// is the one INV-3 leak the sweep cannot fix, so it has to leave the
		// sweep as a fact rather than dying inside it.
		unreclaimedSnapshots: result.skippedSnapshots ?? [],
		errors: result.errors.map((e) => `${e.name}: ${e.reason}`),
		projectLocksReleased,
	};
}

/**
 * Handle the recover subcommand. With no `--run`, sweeps every managed VM
 * whose creator process is dead (same liveness rule as sweepManagedOrphans).
 * With `--run <run-id>`, force-reclaims that one run's VM unconditionally —
 * the operator asked for it by name, so liveness is not consulted.
 * @param {string[]} argv arguments after the subcommand
 */
async function handleRecover(argv, dependencies = {}) {
	const { help, runId } = parseRecoverArgs(argv);

	if (help) {
		console.log(USAGE_RECOVER);
		return;
	}

	const executionBackend = recoveryExecutionBackend(dependencies);
	const listManaged =
		dependencies.listManaged ?? (() => executionBackend.listManaged());
	const managed = listManaged();
	const candidateIds = managed.map((entry) => entry.runId).filter(Boolean);

	let reclaimedCount = 0;
	let errors = [];
	let unreclaimedSnapshots = [];
	if (runId) {
		const target = managed.find((entry) => entry.runId === runId);
		if (target) {
			const destroy =
				dependencies.destroy ?? ((handle) => executionBackend.destroy(handle));
			try {
				destroy(target);
				reclaimedCount = 1;
			} catch (error) {
				errors = [`${target.name}: ${error.message}`];
			}
		}
	} else {
		const reclaim =
			dependencies.reclaim ?? ((opts) => executionBackend.reclaim(opts));
		const result = reclaim({ dryRun: false });
		reclaimedCount = result.reclaimed.length;
		errors = result.errors.map((e) => `${e.name}: ${e.reason}`);
		unreclaimedSnapshots = result.skippedSnapshots ?? [];
	}

	// Filesystem project locks are not VM-managed objects, so reclaim never
	// touches them. Clear stale ones here.
	const projectLocksReleased = await releaseStaleProjectLocks(
		runId ? [runId] : candidateIds,
		dependencies,
	);

	const output = {
		vmsReclaimed: reclaimedCount,
		unreclaimedSnapshots,
		errors,
		projectLocksReleased,
		runId: runId ?? null,
		candidates: !runId
			? managed.map((entry) => ({
					name: entry.name,
					runId: entry.runId,
					status: entry.status,
				}))
			: [{ runId }],
	};

	console.log(JSON.stringify(output));

	process.exitCode = errors.length > 0 ? 1 : 0;
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
				await runDispatch(opts);
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
		await runDispatch(opts);
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
	markLauncherReadyIfLaunching,
	parseDispatchArgs,
	parseLaunchArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
	probeProviderProcess,
	resolveIsRunDead,
	runDispatch,
	sweepManagedOrphans,
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
};
