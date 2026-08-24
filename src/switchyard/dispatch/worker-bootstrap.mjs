// Dispatched by launch(), never run directly.
// Minimal bootstrap: install fatal handlers, verify nonce + host fingerprint,
// claim lease, advance state, then dynamically import and run the queue.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import { Diagnostics } from "../diagnostics/index.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";

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

// Refuse before importing run-store or running retention. A maintenance
// generation freezes every producer, including detached workers; the later
// handshake check closes the launch-to-start race as well.
try {
	assertGenerationAllowed();
} catch (error) {
	console.error(
		`worker-bootstrap: generation guard refused (${error.message})`,
	);
	process.exit(1);
}

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
let writeFailureCount = 0;
let lastWriteFailure = null;
const shutdown = new AbortController();
let shutdownSignal = null;

function requestGracefulShutdown(signal) {
	if (shutdownSignal) return;
	shutdownSignal = signal;
	shutdown.abort();
	console.error(
		`worker-bootstrap: received ${signal}; finishing durable cleanup`,
	);
}

process.on("SIGINT", () => requestGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => requestGracefulShutdown("SIGTERM"));

function safeWriteFailure(error) {
	writeFailureCount += 1;
	// Keep diagnostics categorical and scalar; Error.message can contain host
	// paths or provider-generated text and must not cross the telemetry boundary.
	const categories = {
		RevisionError: "revision_conflict",
		SchemaError: "schema_invalid",
		LockError: "lock_error",
		TypeError: "type_error",
		Error: "write_failed",
	};
	const name = typeof error?.name === "string" ? error.name : "";
	lastWriteFailure = Object.hasOwn(categories, name)
		? categories[name]
		: "write_failed";
	console.error("worker-bootstrap: run-store write failed");
}

function queueWrite(fn) {
	writeChain = writeChain.then(fn, fn).catch((error) => {
		safeWriteFailure(error);
	});
	return writeChain;
}

const RECOGNIZED_CHECKPOINT_IDENTITY_CODES = new Set([
	"checkpoint_task_file_mismatch",
	"checkpoint_tasks_file_mismatch",
	"checkpoint_missing_queue_identity",
	"checkpoint_queue_identity_missing",
	"checkpoint_queue_identity_mismatch",
	"checkpoint_run_options_mismatch",
	"checkpoint_historical_checkpoint",
	"checkpoint_historical_state",
]);

function isRecognizedCheckpointIdentityError(error) {
	if (!error) return false;
	if (error.name === "CheckpointIdentityError") return true;
	if (
		typeof error.code === "string" &&
		RECOGNIZED_CHECKPOINT_IDENTITY_CODES.has(error.code)
	) {
		return true;
	}
	return false;
}

async function writeFatalEvent(error) {
	try {
		const runStore = await import("../run-store/index.mjs");
		const diagnostics = new Diagnostics();
		diagnostics.sink((sanitized) => runStore.createEvent(runId, sanitized));
		if (isRecognizedCheckpointIdentityError(error)) {
			await diagnostics.emit({
				phase: "worker",
				event: "worker_boot_failed",
				status: error.code ?? "checkpoint_identity_mismatch",
				reasonCode: error.code ?? "checkpoint_identity_mismatch",
				diagnosticCode: error.code ?? "checkpoint_identity_mismatch",
				reason: error.reason ?? error.remedy ?? "checkpoint identity mismatch",
			});
		} else {
			await diagnostics.emit({
				phase: "worker",
				event: "worker_boot_failed",
				status: "fatal",
			});
		}
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
		const statusArgs = ["status", "--porcelain", "--untracked-files=all"];
		const relativeStateRoot = relative(
			resolve(projectPath),
			resolve(stateRoot),
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
		// git unavailable
	}
	return `git:${head || "no-head"}:${dirty}`;
}

try {
	const runStore = await import("../run-store/index.mjs");
	// Match the synchronous dispatch path's retention policy, but wait for its
	// schema-only quarantine pass before this worker starts its own run.
	// Deletion remains dry-run-only.
	try {
		await runStore.applyRetention({ maxAgeDays: 30, dryRun: true });
	} catch (error) {
		console.error(
			`worker-bootstrap: retention sweep failed (${error.message})`,
		);
	}

	const run = await runStore.readRun(runId);

	if (run.workerNonce !== nonce) {
		await writeFatalEvent(
			new Error(
				`nonce mismatch: bootstrap received "${nonce}", run.json has "${run.workerNonce}"`,
			),
		);
		process.exit(3);
	}
	if (
		run.dispatchContractVersion !== undefined &&
		run.dispatchContractVersion !== 1
	) {
		await writeFatalEvent(
			new Error(
				`unsupported dispatch descriptor contract version: ${run.dispatchContractVersion}`,
			),
		);
		process.exit(5);
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

	// Re-check after the detached handshake. A generation may begin between
	// launch() and worker startup; fail closed before claiming the run lease or
	// creating a working container. The launch record remains recoverable.
	assertGenerationAllowed();

	const pid = process.pid;
	const startToken = randomUUID();

	await runStore.acquireRunLock(runId, pid, startToken, nonce);
	await runStore.advanceState(runId, "running");

	// NOTE (leak-recovery Piece C): the detached worker deliberately does NOT
	// run a pre-dispatch orphan sweep. An ephemeral worker whose only job is to
	// execute one task must not perform system-wide VM GC — a concurrent
	// sweep here reclaims workspaces belonging to *other* live runs
	// (proven: enabling it deterministically reaps a sibling run's fixture
	// volume). The startup applyRetention call above is safe to include: its
	// schema-only quarantine can only move that malformed run's own record; it
	// never touches another run's live resources and therefore has none of the
	// orphan sweep's cross-run interference risk. The leak-recovery guarantee is
	// delivered by the primary `runDispatch` path's pre-run sweep, the explicit
	// `recover` command, and the SIGTERM/SIGINT owned-container cleanup handler
	// in the runner — none of which run concurrently with a foreign live run.

	const { runQueueAsync: runQueueFn } = await import("../runner/index.mjs");
	const persistedRunOptions = run.runOptions ?? null;

	const result = await runQueueFn({
		tasksFilePath: run.tasksFilePath,
		projectPath: run.projectPath,
		maxTasks: persistedRunOptions?.maxTasks ?? Number.POSITIVE_INFINITY,
		checkpointPath:
			persistedRunOptions?.checkpointPath ??
			`${run.tasksFilePath}.checkpoint.json`,
		// Defensive fallback: a run record written before this field existed
		// (or a hand-built fixture in a test) won't have stopOnFailure at all —
		// default to true (stop on first failure), today's existing behavior.
		stopOnFailure:
			persistedRunOptions?.stopOnFailure ?? run.stopOnFailure ?? true,
		// Stamp the working container with this run's id so a leaked container
		// is discoverable + liveness-checkable by `recover` (labeled branch).
		runId,
		// Defensive fallback: a run.json written before this field existed (or
		// a hand-built fixture in a test) won't have excludeProviders at all.
		exclude:
			persistedRunOptions?.excludeProviders ?? run.excludeProviders ?? [],
		// Defensive fallback: a run.json written before this field existed (or
		// a hand-built fixture in a test) won't have onlyProviders at all.
		only: persistedRunOptions?.onlyProviders ?? run.onlyProviders ?? [],
		taskIds: persistedRunOptions?.taskIds ?? run.taskIds ?? [],
		...(run.queueIdentity
			? {
					runOptions: persistedRunOptions,
					queueIdentity: run.queueIdentity,
					projectRevision: run.projectRevision,
				}
			: {}),
		dependencies: {
			signal: shutdown.signal,
			onStatus: (event) => {
				const phase =
					typeof event?.phase === "string"
						? event.phase.slice(0, 64)
						: "execution";
				const name =
					typeof event?.event === "string"
						? event.event.slice(0, 64)
						: "status";
				const status =
					typeof event?.status === "string"
						? event.status.slice(0, 256)
						: name.replaceAll("_", " ");
				queueWrite(() =>
					runStore.createEvent(runId, { phase, event: name, status }),
				);
			},
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
						activeTaskElapsedMs: 0,
						activeTaskHeartbeatAt: Date.now(),
						activeTaskProcessPhase: "starting",
					});
				queueWrite(fn);
			},
			onTaskRouted: (info) => {
				const fn = () =>
					runStore.updateRunWithRetry(runId, {
						activeTaskProvider: info.provider,
						activeTaskModel: info.model,
						activeTaskDeadline: info.deadline,
						snapshotStatus: info.snapshotStatus ?? null,
						snapshotMtime: info.snapshotMtime ?? null,
						snapshotAgeMsAtRoute: info.snapshotAgeMsAtRoute ?? null,
						resolvedTargetId: info.resolvedTargetId ?? null,
						activeTaskInvocationDescriptor: info.invocationDescriptor ?? null,
						activeTaskDescriptorIdentity: info.descriptorIdentity ?? null,
						activeTaskDescriptorHarness: info.descriptorHarness ?? null,
						dispatchContractVersion: info.dispatchContractVersion ?? 1,
						activeTaskElapsedMs: 0,
						activeTaskHeartbeatAt: Date.now(),
						activeTaskProcessPhase: "routed",
					});
				queueWrite(fn);
			},
			onTaskHeartbeat: (info) => {
				const fn = () =>
					runStore.updateRunWithRetry(runId, {
						activeTaskElapsedMs: Number.isFinite(info.elapsedMs)
							? Math.max(0, info.elapsedMs)
							: 0,
						activeTaskHeartbeatAt: Date.now(),
						activeTaskProcessPhase: "provider_running",
					});
				queueWrite(fn);
			},
			onResult: (r) => {
				const safeFailure = sanitizeFailureMetadata(r);
				const event = r.success
					? {
							phase: "execution",
							event: "task_completed",
							status: `Task ${r.taskId} completed`,
							taskId: r.taskId,
							provider: r.provider ?? null,
							model: r.model ?? null,
							invocationDescriptor: r.invocationDescriptor ?? null,
							descriptorIdentity: r.descriptorIdentity ?? null,
							descriptorHarness: r.descriptorHarness ?? null,
							resolvedTargetId: r.resolvedTargetId ?? null,
							dispatchContractVersion: r.dispatchContractVersion ?? 1,
						}
					: {
							phase: "execution",
							event: "task_failed",
							status: `Task ${r.taskId} failed: ${r.result}`,
							taskId: r.taskId,
							provider: r.provider ?? null,
							model: r.model ?? null,
							result: r.result,
							invocationDescriptor: r.invocationDescriptor ?? null,
							descriptorIdentity: r.descriptorIdentity ?? null,
							descriptorHarness: r.descriptorHarness ?? null,
							resolvedTargetId: r.resolvedTargetId ?? null,
							dispatchContractVersion: r.dispatchContractVersion ?? 1,
							...(safeFailure ?? {}),
						};
				const fn = () =>
					runStore.createEvent(runId, event).then(() =>
						runStore.updateRunWithRetry(runId, {
							activeTaskId: null,
							activeTaskProvider: null,
							activeTaskModel: null,
							activeTaskDeadline: null,
							activeTaskElapsedMs: null,
							activeTaskHeartbeatAt: null,
							activeTaskProcessPhase: null,
							snapshotStatus: null,
							snapshotMtime: null,
							snapshotAgeMsAtRoute: null,
							resolvedTargetId: null,
							lastResolvedTargetId: r.resolvedTargetId ?? null,
							lastTaskInvocationDescriptor: r.invocationDescriptor ?? null,
							lastTaskDescriptorIdentity: r.descriptorIdentity ?? null,
							lastTaskDescriptorHarness: r.descriptorHarness ?? null,
							activeTaskInvocationDescriptor: null,
							activeTaskDescriptorIdentity: null,
							activeTaskDescriptorHarness: null,
							...(safeFailure ? { lastFailure: safeFailure } : {}),
							// Only a successful task advances lastCompletionAt — a
							// failure must leave the run record's existing value
							// untouched (not null it out), so this stays a
							// conditional spread rather than a bare field.
							...(r.success ? { lastCompletionAt: Date.now() } : {}),
						}),
					);
				queueWrite(fn);

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
				queueWrite(fn);
			},
			onRetryStateChanged: (projection) => {
				// The checkpoint is authoritative. This is only a sanitized
				// run-store projection; status/result re-read the checkpoint so a
				// crash cannot hide a transition if this asynchronous write loses
				// the race with worker termination.
				const fn = () => runStore.updateRunWithRetry(runId, projection);
				queueWrite(fn);
			},
			onContainerReady: (info) => {
				const fn = () =>
					runStore.updateRunWithRetry(runId, {
						workingContainerName: info.workingContainerName,
					});
				queueWrite(fn);
			},
		},
	});

	const failed = result.results.filter((r) => !r.success);
	const terminalPatchBase = {
		state: failed.length > 0 ? "failed" : "succeeded",
		activeTaskId: null,
		activeTaskProvider: null,
		activeTaskModel: null,
		activeTaskDeadline: null,
		activeTaskStartedAt: null,
		activeTaskElapsedMs: null,
		activeTaskHeartbeatAt: null,
		activeTaskProcessPhase: null,
		snapshotStatus: null,
		snapshotMtime: null,
		snapshotAgeMsAtRoute: null,
		resolvedTargetId: null,
		activeTaskInvocationDescriptor: null,
		activeTaskDescriptorIdentity: null,
		activeTaskDescriptorHarness: null,
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
	const terminalPatch = {
		...terminalPatchBase,
		...(writeFailureCount > 0
			? {
					telemetryWriteFailures: writeFailureCount,
					lastTelemetryWriteFailure: lastWriteFailure,
				}
			: {}),
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
				activeTaskStartedAt: null,
				activeTaskElapsedMs: null,
				activeTaskHeartbeatAt: null,
				activeTaskProcessPhase: null,
				snapshotStatus: null,
				snapshotMtime: null,
				snapshotAgeMsAtRoute: null,
				resolvedTargetId: null,
				activeTaskInvocationDescriptor: null,
				activeTaskDescriptorIdentity: null,
				activeTaskDescriptorHarness: null,
				...(writeFailureCount > 0
					? {
							telemetryWriteFailures: writeFailureCount,
							lastTelemetryWriteFailure: lastWriteFailure,
						}
					: {}),
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
