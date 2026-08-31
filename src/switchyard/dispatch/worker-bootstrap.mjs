// Dispatched by launch(), never run directly.
// Minimal bootstrap: install fatal handlers, verify nonce + host fingerprint,
// claim lease, advance state, then dynamically import and run the queue.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	CLEANUP_STAGES,
	isPersistentFailureMetadata,
	PERSISTED_SIGNALS,
	sanitizeFailureMetadata,
	workerBootStageDiagnosticCode,
} from "../adapter/exec-error.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import { finalizeRun } from "./run-finalization.mjs";

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
	console.error("worker-bootstrap: generation guard refused");
	await writeFatalEvent(error, "worker_boot_exception");
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
let fatalFinalizationPromise = null;
let QueueCleanupErrorType = null;
let fatalPersistenceDiagnosticEmitted = false;

const FATAL_PERSISTENCE_DIAGNOSTIC =
	"worker-bootstrap: fatal event persistence unavailable; durable run state may be incomplete";

function emitFatalPersistenceDiagnostic() {
	if (fatalPersistenceDiagnosticEmitted) return;
	fatalPersistenceDiagnosticEmitted = true;
	console.error(FATAL_PERSISTENCE_DIAGNOSTIC);
}

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

function queueWrite(fn, { propagateFailure = false } = {}) {
	const write = writeChain.then(fn, fn);
	writeChain = write.catch((error) => {
		safeWriteFailure(error);
	});
	// Most callback writes are telemetry: record their failure but allow the
	// queue to continue. Cleanup-state persistence is different: the runner
	// must observe a failure so it can log it, while its finally block still
	// tears down the owned container.
	return propagateFailure ? write : writeChain;
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
	return (
		typeof error?.code === "string" &&
		RECOGNIZED_CHECKPOINT_IDENTITY_CODES.has(error.code)
	);
}

async function writeFatalEvent(
	error,
	diagnosticCode = "worker_boot_exception",
) {
	try {
		const runStore = await import("../run-store/index.mjs");
		const current = await runStore.readRun(runId);
		const closedCode = isRecognizedCheckpointIdentityError(error)
			? error.code
			: (workerBootStageDiagnosticCode(error) ?? diagnosticCode);
		const failure = sanitizeFailureMetadata({
			result: "launch_failed",
			errorKind: "launch_failed",
			diagnosticCode: closedCode,
			failurePhase: "worker_boot",
		});
		await finalizeRun(
			{
				runId,
				state: "failed",
				failure,
				eventName: "worker_boot_failed",
				eventStatus: isRecognizedCheckpointIdentityError(error)
					? error.code
					: "fatal",
				eventReasonCode: isRecognizedCheckpointIdentityError(error)
					? error.code
					: failure.reasonCode,
				terminalSummary: {
					totalTasks: Array.isArray(current.orderedTaskIds)
						? current.orderedTaskIds.length
						: null,
					runnableTasks: null,
					processedTasks: null,
					completedTaskIds: null,
					failedCount: null,
				},
				cleanup: async () => {
					await runStore.reconcileProjectLockClaims();
					await runStore.releaseProjectLockIfOwnedBy(
						current.projectPath,
						runId,
					);
				},
			},
			runStore,
		);
	} catch {
		// A missing or corrupt run must not be mutated. Keep this fallback fixed
		// and categorical because the original error can contain paths, provider
		// output, or other sensitive data.
		emitFatalPersistenceDiagnostic();
	}
}

function isQueueCleanupError(error) {
	return (
		QueueCleanupErrorType !== null &&
		error instanceof QueueCleanupErrorType &&
		error?.code === "recovery_incomplete" &&
		isPersistentFailureMetadata(error?.failure)
	);
}

async function writeQueueCleanupFailure(error) {
	const runStore = await import("../run-store/index.mjs");
	await finalizeRun(
		{
			runId,
			state: "failed",
			failure: error.failure,
			eventName: "run_failed",
			eventStatus: "recovery_required",
			terminalSummary: error.terminalSummary,
			// runQueueAsync already attempted owned-workspace teardown. Keeping
			// the project lock while this fixed cleanup failure drives the shared
			// finalizer to recovery_required prevents another run from claiming
			// the project before explicit recovery proves the workspace absent.
			cleanup: async () => {
				throw new Error("queue cleanup incomplete");
			},
		},
		runStore,
	);
}

process.on("uncaughtException", (error) => {
	fatalFinalizationPromise = writeFatalEvent(
		error,
		"worker_boot_exception",
	).then(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
	const error = reason instanceof Error ? reason : new Error(String(reason));
	fatalFinalizationPromise = writeFatalEvent(
		error,
		"worker_boot_exception",
	).then(() => process.exit(1));
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

async function yieldFatalHandlerTurn() {
	await new Promise((resolveTurn) => setImmediate(resolveTurn));
}

async function exitAfterDirectFailure(error, diagnosticCode, exitCode) {
	// A next-tick uncaught exception may already be queued by the embedding
	// process. Give the installed fatal handler first claim so its exit 1 and
	// worker_boot_exception evidence cannot race a direct bootstrap exit.
	await yieldFatalHandlerTurn();
	if (fatalFinalizationPromise) {
		await fatalFinalizationPromise;
		process.exit(1);
	}
	await writeFatalEvent(error, diagnosticCode);
	process.exit(exitCode);
}

try {
	const runStore = await import("../run-store/index.mjs");
	// Match the synchronous dispatch path's retention policy, but wait for its
	// schema-only quarantine pass before this worker starts its own run. This
	// worker's own directory is not at risk from the sweep it runs: the sweep
	// can only remove a directory that recorded no events AND is older than
	// the cutoff, and this run was created moments ago.
	try {
		await runStore.applyRetention({ maxAgeDays: 30 });
	} catch (_error) {
		console.error("worker-bootstrap: retention sweep failed");
	}

	const run = await runStore.readRun(runId);

	if (run.workerNonce !== nonce) {
		await exitAfterDirectFailure(
			new Error(
				`nonce mismatch: bootstrap received "${nonce}", run.json has "${run.workerNonce}"`,
			),
			"worker_nonce_mismatch",
			3,
		);
	}
	if (
		run.dispatchContractVersion !== undefined &&
		run.dispatchContractVersion !== 1
	) {
		await exitAfterDirectFailure(
			new Error(
				`unsupported dispatch descriptor contract version: ${run.dispatchContractVersion}`,
			),
			"worker_contract_unsupported",
			5,
		);
	}

	const currentFingerprint = captureCurrentFingerprint(run.projectPath);
	if (
		run.initialHostFingerprint !== currentFingerprint &&
		!currentFingerprint.includes(":no-head:") &&
		!run.initialHostFingerprint.includes(":no-head:")
	) {
		await exitAfterDirectFailure(
			new Error(
				`host fingerprint mismatch: initial="${run.initialHostFingerprint}", current="${currentFingerprint}"`,
			),
			"worker_fingerprint_mismatch",
			4,
		);
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

	const runner = await import("../runner/index.mjs");
	const runQueueFn = runner.runQueueAsync;
	QueueCleanupErrorType = runner.QueueCleanupError;
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
				// This handler is an INV-2 chokepoint: it forwards fields by
				// explicit name with a type check, never by spread, so provider
				// output has no path into events.jsonl. taskId and byteCount are
				// forwarded because `partial_diff_captured` is the only record
				// that a partial diff existed — the diff itself is deliberately
				// not copied into the run store (see onResult below), so dropping
				// these two left the event saying a diff happened somewhere, to
				// some task, of some size. Both are content-free by construction:
				// an identifier and a count.
				const taskId =
					typeof event?.taskId === "string" ? event.taskId.slice(0, 64) : null;
				const byteCount =
					Number.isSafeInteger(event?.byteCount) && event.byteCount >= 0
						? event.byteCount
						: null;
				// The same reasoning extends `provider_cleanup_failed`. Without
				// these three the event says only that cleanup "could not
				// confirm process exit", which cannot distinguish a kill script
				// that ran and found survivors from a guest exec that never ran
				// — the two have different fixes. Each is validated against a
				// closed set rather than length-truncated, so an unexpected
				// value is dropped instead of persisted.
				const cleanupStage = CLEANUP_STAGES.has(event?.cleanupStage)
					? event.cleanupStage
					: null;
				const exitCode =
					Number.isSafeInteger(event?.exitCode) &&
					event.exitCode >= 0 &&
					event.exitCode <= 255
						? event.exitCode
						: null;
				const signal = PERSISTED_SIGNALS.has(event?.signal)
					? event.signal
					: null;
				queueWrite(() =>
					runStore.createEvent(runId, {
						phase,
						event: name,
						status,
						...(taskId !== null ? { taskId } : {}),
						...(byteCount !== null ? { byteCount } : {}),
						...(cleanupStage !== null ? { cleanupStage } : {}),
						...(exitCode !== null ? { exitCode } : {}),
						...(signal !== null ? { signal } : {}),
					}),
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
				// Retain boot diagnostics through every pre-provider failure, then
				// remove the named log synchronously at the adapter boundary.
				try {
					unlinkSync(resolve(runStore.getRunRoot(runId), "boot-stderr.log"));
				} catch {
					// Missing/already-removed logs are benign.
				}
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
						activeTaskProcessPhase: "provider_transport_running",
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

				// A partial diff is raw provider output and is NOT copied into the
				// run store. The copy that used to live here existed only so a
				// count appeared in `switchyard result <runId>`'s artifactRefs:
				// listArtifactRefs hashes the file NAME into an opaque
				// `artifact:<hash>` ref and never opens the file, and
				// opaqueArtifactRef rejects any reference that is not exactly that
				// form. So the bytes had no reader, which is the situation INV-2
				// exists to prevent. The fact is kept instead of the content — the
				// runner's `partial_diff_captured` status event carries the task id
				// and the byte count (see onStatus above) — and the diff itself
				// stays beside the checkpoint, outside the run store.
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
			onCleanupStarted: () => {
				const fn = () =>
					runStore.updateRunWithRetry(runId, {
						cleanupState: "pending",
						activeTaskId: null,
						activeTaskProvider: null,
						activeTaskModel: null,
						activeTaskDeadline: null,
						activeTaskStartedAt: null,
						activeTaskElapsedMs: null,
						activeTaskHeartbeatAt: null,
						activeTaskProcessPhase: null,
						activeTaskInvocationDescriptor: null,
						activeTaskDescriptorIdentity: null,
						activeTaskDescriptorHarness: null,
					});
				return queueWrite(fn, { propagateFailure: true });
			},
		},
	});

	const failed = result.results.filter((r) => !r.success);
	if (result.processedTasks === 0) {
		try {
			unlinkSync(resolve(runStore.getRunRoot(runId), "boot-stderr.log"));
		} catch {
			// Missing/already-removed logs are benign.
		}
	}
	const terminalSummary = {
		totalTasks: result.totalTasks,
		runnableTasks: result.runnableTasks,
		processedTasks: result.processedTasks,
		completedTaskIds: result.completedTaskIds,
		failedCount: failed.length,
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
	await finalizeRun(
		{
			runId,
			state: failed.length > 0 ? "failed" : "succeeded",
			failure: sanitizeFailureMetadata(failed.at(-1) ?? {}),
			terminalSummary,
			extraPatch:
				writeFailureCount > 0
					? {
							telemetryWriteFailures: writeFailureCount,
							lastTelemetryWriteFailure: lastWriteFailure,
						}
					: {},
			cleanup: async () => {
				await runStore.reconcileProjectLockClaims();
				await runStore.releaseProjectLockIfOwnedBy(run.projectPath, runId);
			},
		},
		runStore,
	);
} catch (error) {
	// Same reasoning as the terminal-write drain above: a crash can land here
	// while a straggler writeChain write is still in flight (e.g. runQueueFn
	// itself threw mid-loop). Draining first keeps this fixed-revision
	// updateRun below from losing a revision race to that straggler.
	// writeChain always resolves, so this is safe even before it's ever used.
	await writeChain;
	if (isQueueCleanupError(error)) {
		try {
			await writeQueueCleanupFailure(error);
		} catch {
			// Do not fall through to fatal finalization: that path performs only
			// lock cleanup and could falsely mark the still-owned workspace clean.
			console.error(
				"worker-bootstrap: failed to persist queue cleanup recovery evidence",
			);
		}
		process.exit(1);
	}
	await writeFatalEvent(error, "worker_boot_exception");
	process.exit(1);
}
