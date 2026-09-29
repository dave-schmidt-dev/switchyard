import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	classifyPreProviderFailure,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import {
	createDefaultRouteHealthDecision,
	ingestRouteHealthEvents,
} from "../router/health.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../router/index.mjs";
import {
	acquireProjectLock,
	acquireRunLock,
	advanceState,
	applyRetention,
	assertProjectLockOwnership,
	createEvent,
	createRouteHealthEvent,
	getRunRoot,
	initializeRun,
	LockError,
	persistDiagnosticArtifact,
	readRun,
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
	releaseProjectLockIfOwnedBy,
	updateRunWithRetry,
} from "../run-store/index.mjs";
import {
	getCheckpointPath,
	loadTaskQueue,
	runQueueAsync,
	validateCallerInputs,
	validateProjectFileEntries,
} from "../runner/index.mjs";
import { materializeValidatedDirtyOverlay } from "./cli-handlers.mjs";
import { UsageError } from "./cli-usage.mjs";
import {
	buildLaunchFailureEnvelope,
	captureHostFingerprint,
	prepareDispatchDirtyOverlay,
	prepareRunIdentity,
	renewDispatchReceipts,
} from "./launch-support.mjs";
import { sweepManagedOrphans } from "./recover-reclaim.mjs";
import { buildResultEnvelope, isTerminalState } from "./result.mjs";
import { finalizeRun } from "./run-finalization.mjs";

async function runDispatch(opts, dependencies = {}) {
	const jsonRequested = opts.json === true;
	const report = jsonRequested ? () => {} : (...args) => console.error(...args);
	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)();
	// This must precede every sweep, run-store write, lock, receipt publication,
	// or backend/provider operation. It is the single caller-input boundary used
	// again by the detached runner with persisted options.
	const callerInputs = validateCallerInputs(opts);
	materializeValidatedDirtyOverlay(opts, callerInputs);
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
	report(`dispatch: queue    ${opts.tasksFilePath}`);
	report(`dispatch: project  ${opts.projectPath}`);
	report(
		"dispatch: routing host-side by usage headroom; each task runs headlessly in a disposable Parallels working VM.",
	);
	report(
		"dispatch: expect several minutes per task while the provider CLI runs.",
	);

	// Pre-dispatch sweep (Piece C): reap any container a prior crashed run
	// leaked so the host self-heals every dispatch. Fire-and-forget — hygiene
	// must NOT sit on the dispatch critical path; the resource limits are the
	// meltdown safety gate, so the sweep only needs to run eventually. It starts
	// before this run's id exists, so it cannot see (or reap) our own run/
	// container. This process lives for the whole dispatch (minutes), giving the
	// sweep ample time to finish. The .catch prevents an unhandledRejection.
	sweepManagedOrphans({ ...dependencies, projectPath: opts.projectPath })
		.then((swept) => {
			// These once read `containersReclaimed`/`volumesReclaimed`, which
			// sweepManagedOrphans stopped returning at the Docker-to-Parallels
			// rename. `undefined > 0` is false, so the branch was unreachable
			// and every pre-run reclamation went unreported.
			if (swept.vmsReclaimed > 0) {
				report(
					`dispatch: pre-run sweep reclaimed ${swept.vmsReclaimed} orphaned VM(s)`,
				);
			}
			for (const entry of swept.unreclaimedSnapshots) {
				report(
					`dispatch: pre-run sweep left snapshots on the golden for ${entry.name} (${entry.reason}) — human review required`,
				);
			}
		})
		.catch((error) => {
			report(`dispatch: pre-run sweep failed (${error.message})`);
		});

	// Retention sweep (Task D.5, revised by Task 6.5). This pass deletes for
	// real; the dry-run mode it used to run in stays available for inspection
	// via `applyRetention({ dryRun: true })`. What it can reach is bounded by
	// what a file IS, not by run state: run.json and events.jsonl are never
	// removed at any age, artifacts/ contents always are, and only a run
	// directory that never recorded an event can be removed outright.
	// maxAgeDays bounds that last rule alone, which is also what keeps a
	// mid-flight run — run.json written, first event not yet appended — out of
	// reach of this sweep. A run whose checkpoint still exists is skipped
	// entirely, because a resume would read it.
	// Malformed run directories are quarantined (moved, not deleted) on every
	// sweep regardless of dryRun — same as always for that path — since a
	// record that can't be read never becomes eligible and would otherwise
	// fail this same scan forever. The one conservative exception: a run
	// directory whose run.json is absent (ENOENT — e.g. a concurrent
	// initializeRun mid-flight) is left for a later sweep, not quarantined.
	// This sweep remains synchronous-dispatch-only:
	// detached launch and worker-bootstrap intentionally do not invoke it.
	applyRetention({ maxAgeDays: 30 })
		.then(({ deletedCount, collectedCount, quarantined }) => {
			if (deletedCount > 0) {
				report(
					`dispatch: retention sweep removed ${deletedCount} run-store director${deletedCount === 1 ? "y" : "ies"} older than 30 days that recorded no events`,
				);
			}
			if (collectedCount > 0) {
				report(
					`dispatch: retention sweep collected ${collectedCount} run-store artifact${collectedCount === 1 ? "" : "s"}`,
				);
			}
			for (const entry of quarantined) {
				report(
					`dispatch: retention sweep quarantined run ${entry.runId} (${entry.reason})`,
				);
			}
		})
		.catch((error) => {
			report(`dispatch: retention sweep failed (${error.message})`);
		});

	const runId = randomUUID();
	const pid = process.pid;
	const startToken = randomUUID();
	const nonce = randomUUID();
	// Production dispatch uses the async runner, which owns broker selection,
	// reservations, fallback, and provider execution. Keep the injectable
	// override for lifecycle tests and compatibility callers.
	const runQueueFn = dependencies.runQueue ?? runQueueAsync;
	let healthDecision = null;

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
	let initialized = false;
	let initializationCode = null;
	try {
		let tasks;
		try {
			tasks = loadTaskQueue(opts.tasksFilePath);
			validateProjectFileEntries(tasks, opts.projectPath);
		} catch (error) {
			// A queue that fails to parse is a caller contract failure with a
			// precise, user-fixable cause. Left unclassified it fell through to
			// `environment_incomplete`, which points at the host instead of at
			// the line of the task file that needs editing.
			initializationCode = "queue_contract_invalid";
			throw new UsageError(error.message);
		}
		if (tasks.length === 0) {
			initializationCode = "queue_empty";
			throw new UsageError("no tasks parsed from the task queue");
		}
		prepareDispatchDirtyOverlay(opts, tasks);
		// Built inside the classified pre-provider block: an invalid golden
		// image reference or health root is a host configuration failure that
		// must produce the closed envelope, not an uncaught exception.
		healthDecision =
			dependencies.healthDecision ??
			createDefaultRouteHealthDecision({
				healthStateRoot: opts.healthStateRoot,
				mode: opts.healthMode,
				qualifiedProviders: GOLDEN_IMAGE_VERIFIED_PROVIDERS,
				// The runner derives the same epoch from dependencies.goldenImage;
				// dispatch must bind to the identical golden image so both paths
				// observe one health generation.
				...(dependencies.goldenImage !== undefined
					? { goldenImageReference: dependencies.goldenImage }
					: {}),
			});
		try {
			identity = prepareRunIdentity(opts);
		} catch (error) {
			initializationCode = "queue_identity_invalid";
			throw error;
		}
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
		initialized = true;
		await acquireRunLock(runId, pid, startToken, nonce);
		runStoreReady = true;
	} catch (error) {
		const classified = classifyPreProviderFailure(error);
		const diagnosticCode =
			initializationCode ??
			classified?.diagnosticCode ??
			"environment_incomplete";
		if (initialized) {
			try {
				const failure = sanitizeFailureMetadata({
					result: "unknown_failure",
					errorKind: classified?.errorKind ?? diagnosticCode,
					diagnosticCode,
					failurePhase: classified?.failurePhase ?? "queue_preflight",
				});
				await finalizeRun({
					runId,
					state: "failed",
					failure,
					eventName: "dispatch_initialization_failed",
					eventStatus: "fatal",
					eventReasonCode: failure.reasonCode,
					terminalSummary: {
						totalTasks: null,
						runnableTasks: null,
						processedTasks: null,
						completedTaskIds: null,
						failedCount: null,
					},
					cleanup: async () => {},
				});
			} catch {
				// A JSON caller receives a null address unless the terminal record is
				// readable below; raw initialization errors never cross that surface.
			}
		}
		if (jsonRequested) {
			let envelope = null;
			if (initialized) {
				try {
					const terminalRun = await readRun(runId);
					if (isTerminalState(terminalRun.state)) {
						envelope = await buildResultEnvelope(runId, terminalRun);
					}
				} catch {
					// No readable terminal record means no addressable run.
				}
			}
			console.log(
				JSON.stringify(
					envelope ??
						(await buildLaunchFailureEnvelope({
							preInitialization: {
								type: "contract_failure",
								code: diagnosticCode,
							},
						})),
				),
			);
			process.exitCode = error instanceof UsageError ? 2 : 1;
			return { runId: envelope?.runId ?? null, error: true };
		}
		if (initialized) {
			Object.defineProperty(error, "switchyardRunId", {
				value: runId,
				enumerable: false,
			});
		}
		// A caller contract failure already carries the precise message; the
		// fixed-string wrapper discarded the only line that says what to fix.
		// These are host-side errors over the caller's own task file, never
		// provider output.
		if (error instanceof UsageError) throw error;
		const wrapped = new Error(
			`dispatch: run-store initialization failed before routing: ${error.message}`,
			{ cause: error },
		);
		if (initialized) {
			Object.defineProperty(wrapped, "switchyardRunId", {
				value: runId,
				enumerable: false,
			});
		}
		throw wrapped;
	}

	let result;
	let queueError = null;
	let eventWriteChain = Promise.resolve();
	let projectLockOwned = false;
	let firstCallbackFailure = null;
	let callbackFailureCount = 0;

	const createEventFn =
		dependencies.createEvent ??
		dependencies.runStore?.createEvent ??
		createEvent;
	const createRouteHealthEventFn =
		dependencies.createRouteHealthEvent ??
		dependencies.runStore?.createRouteHealthEvent ??
		createRouteHealthEvent;
	const ingestRouteHealthEventsFn =
		dependencies.ingestRouteHealthEvents ?? ingestRouteHealthEvents;
	const updateRunWithRetryFn =
		dependencies.updateRunWithRetry ??
		dependencies.runStore?.updateRunWithRetry ??
		updateRunWithRetry;

	function queueEventWrite(fn) {
		const write = eventWriteChain.then(fn, fn);
		eventWriteChain = write.catch((error) => {
			callbackFailureCount += 1;
			if (!firstCallbackFailure) {
				const categories = {
					RevisionError: "revision_conflict",
					SchemaError: "schema_invalid",
					LockError: "lock_error",
					TypeError: "type_error",
					Error: "write_failed",
				};
				const name = typeof error?.name === "string" ? error.name : "";
				const diagnostic = Object.hasOwn(categories, name)
					? categories[name]
					: "write_failed";
				firstCallbackFailure = {
					name,
					diagnostic,
				};
				report("dispatch: run-store write failed");
			}
		});
		return eventWriteChain;
	}
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
			await (
				dependencies.releaseOrphanedProjectLocks ?? releaseOrphanedProjectLocks
			)();
			await (
				dependencies.reconcileProjectLockClaims ?? reconcileProjectLockClaims
			)();
			await (dependencies.acquireProjectLock ?? acquireProjectLock)(
				opts.projectPath,
				runId,
			);
			const ownsProjectLock = await (
				dependencies.assertProjectLockOwnership ?? assertProjectLockOwnership
			)(opts.projectPath, runId);
			if (ownsProjectLock !== true) {
				throw new LockError("Project lock ownership assertion failed");
			}
			projectLockOwned = true;
		}
		if (runStoreReady) {
			// The run only becomes executing after exclusive project ownership is
			// proven and the provider-capable queue call is ready to begin.
			await advanceState(runId, "running");
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
				...dependencies,
				// The detached worker has always wired this (worker-bootstrap).
				// Without it here the runner's persist block is skipped outright,
				// so a provider failure on the synchronous path deletes its own
				// evidence and records diagnosticEvidenceAvailable: false with no
				// artifact ever offered to the run store.
				persistDiagnosticArtifact:
					dependencies.persistDiagnosticArtifact ??
					(runStoreReady
						? (evidence) => persistDiagnosticArtifact(runId, evidence)
						: undefined),
				healthDecision,
				onHealthDecision: (decision) => {
					dependencies.onHealthDecision?.(decision);
					if (decision.state !== "healthy") {
						report(
							`dispatch: route health ${decision.provider} ${decision.state} (${decision.mode})`,
						);
					}
				},
				onTaskStart: (task) => {
					report(`dispatch: -> task ${task.id} ${task.title ?? ""}`.trimEnd());
					// activeTaskId is not just one datum: buildStatusEnvelope
					// gates activeTaskProvider, activeTaskModel,
					// activeTaskDeadline, activeTaskAgeMs, and runningCount on
					// it being non-null. Without this write the synchronous path
					// reported an idle run for the entire time a provider was
					// executing, and suppressed onTaskRouted's provider/model
					// writes along with it. The detached path has always done
					// this in worker-bootstrap's onTaskStart; only this one was
					// missing. Appended to eventWriteChain so it serializes
					// against onTaskRouted, which fires microseconds later.
					if (runStoreReady) {
						queueEventWrite(() =>
							updateRunWithRetryFn(runId, { activeTaskId: task.id }),
						);
					}
				},
				onTaskRouted: (info) => {
					report(
						`dispatch:    routed to ${info.provider}${info.model ? `/${info.model}` : ""} — deadline ${info.deadline ?? "orchestrator"}`,
					);
					if (runStoreReady) {
						queueEventWrite(() =>
							updateRunWithRetryFn(runId, {
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
						);
					}
				},
				onTaskHeartbeat: (info) => {
					const phase =
						typeof info.processPhase === "string"
							? info.processPhase
							: "provider_running";
					report(
						`dispatch:    progress task ${info.taskId} phase=${phase} elapsed=${Math.max(0, info.elapsedMs ?? 0)}ms${info.milestone ? ` milestone=${info.milestone}` : ""}`,
					);
					dependencies.onTaskHeartbeat?.(info);
					if (runStoreReady) {
						queueEventWrite(() =>
							updateRunWithRetryFn(runId, {
								activeTaskElapsedMs: Math.max(0, info.elapsedMs ?? 0),
								activeTaskHeartbeatAt: Date.now(),
								activeTaskProcessPhase: phase,
							}),
						);
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
					report(
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
							...(typeof r.servedModelVerified === "boolean"
								? { servedModelVerified: r.servedModelVerified }
								: {}),
							result: r.result,
							...(r.reviewResult ? { reviewResult: r.reviewResult } : {}),
							...(r.alreadyApplied ? { alreadyApplied: true } : {}),
							...(safeFailure ?? {}),
							...(artifactRef ? { artifactRef } : {}),
							...(r.routeHealthBinding
								? { attempt: r.routeHealthAttempt }
								: {}),
						};
						queueEventWrite(async () => {
							if (r.routeHealthBinding) {
								await createRouteHealthEventFn(
									runId,
									event,
									r.routeHealthBinding,
								);
								try {
									await ingestRouteHealthEventsFn({
										authorisedRuns: [{ runId, runRoot: getRunRoot(runId) }],
										healthStateRoot: opts.healthStateRoot,
									});
								} catch {
									report("dispatch: route health ingestion unavailable");
								}
							} else {
								await createEventFn(runId, event);
							}
							await updateRunWithRetryFn(runId, {
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
								...(r.reviewResult ? { lastReviewResult: r.reviewResult } : {}),
								...(safeFailure ? { lastFailure: safeFailure } : {}),
							});
						});
					}
				},
			},
		});
	} catch (error) {
		queueError = error;
	} finally {
		if (runStoreReady) {
			try {
				await eventWriteChain;
			} catch {
				// queueEventWrite absorbs rejections and records categorical diagnostics.
			}
			const persistenceFailed = Boolean(firstCallbackFailure);
			const failedResults = result
				? result.results.filter(
						(entry) =>
							!entry.success && entry.result !== "route_health_deferred",
					)
				: [];
			const anyFailed = result
				? failedResults.length > 0 || persistenceFailed
				: true;
			const deferredTaskIds = Array.isArray(result?.deferredTaskIds)
				? result.deferredTaskIds
				: [];
			const failedResult = result?.results.findLast?.(
				(entry) => !entry.success && entry.result !== "route_health_deferred",
			);
			const classifiedQueueError = classifyPreProviderFailure(queueError);
			const checkpointCode =
				typeof queueError?.code === "string" &&
				Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, queueError.code)
					? queueError.code
					: undefined;
			const classifiedFailure = firstCallbackFailure
				? sanitizeFailureMetadata({
						result: "run_store_write_failed",
						errorKind: "run_store_write_failed",
						diagnosticCode: "run_store_write_failed",
						failurePhase: "terminal_reconciliation",
					})
				: queueError
					? sanitizeFailureMetadata({
							result: "unknown_failure",
							errorKind: classifiedQueueError?.errorKind ?? "unknown_failure",
							diagnosticCode: classifiedQueueError?.diagnosticCode,
							failurePhase:
								classifiedQueueError?.failurePhase ?? "terminal_reconciliation",
							checkpointCode,
							checkpointDimensions: checkpointCode
								? queueError.changedDimensions
								: undefined,
						})
					: sanitizeFailureMetadata(failedResult ?? {});
			// `sanitizeFailureMetadata` returns null for anything it cannot classify,
			// including the `{}` that a missing `failedResult` supplies. Combined with
			// `anyFailed` defaulting to true when the queue produced no result, that
			// wrote a run recorded as `failed` with `lastFailure: null` — 170 of 764
			// historical failures, median 8ms, with no target and no event. A failed
			// run must always carry a reason, even when the only honest reason is
			// that the queue returned nothing and did not throw.
			const failure =
				classifiedFailure ??
				(anyFailed
					? sanitizeFailureMetadata({
							result: "unknown_failure",
							errorKind: "unknown_failure",
							diagnosticCode: result
								? "terminal_without_failure_metadata"
								: "queue_returned_no_result",
							failurePhase: "terminal_reconciliation",
						})
					: null);
			try {
				await finalizeRun({
					runId,
					state: anyFailed
						? "failed"
						: deferredTaskIds.length > 0
							? "deferred"
							: "succeeded",
					failure,
					terminalSummary: result
						? {
								totalTasks: result.totalTasks,
								runnableTasks: result.runnableTasks,
								processedTasks: result.processedTasks,
								completedTaskIds: result.completedTaskIds,
								deferredTaskIds,
								failedCount: failedResults.length,
							}
						: {
								totalTasks: null,
								runnableTasks: null,
								processedTasks: null,
								completedTaskIds: null,
								deferredTaskIds: null,
								failedCount: null,
							},
					extraPatch: {
						...(queueError?.preflightDetail
							? { preflightDetail: queueError.preflightDetail }
							: {}),
						...(result?.policyDeferred
							? { policyDeferred: result.policyDeferred }
							: {}),
						...(callbackFailureCount > 0
							? {
									telemetryWriteFailures: callbackFailureCount,
									lastTelemetryWriteFailure: firstCallbackFailure.diagnostic,
								}
							: {}),
					},
					cleanup: async () => {
						if (projectLockOwned) {
							await (
								dependencies.reconcileProjectLockClaims ??
								reconcileProjectLockClaims
							)();
							await (
								dependencies.releaseProjectLockIfOwnedBy ??
								releaseProjectLockIfOwnedBy
							)(opts.projectPath, runId);
						}
					},
				});
			} catch (error) {
				report(`dispatch: run-store teardown failed (${error.message})`);
			}
		}
	}
	if (jsonRequested) {
		let envelope;
		try {
			envelope = await buildResultEnvelope(runId, await readRun(runId));
		} catch {
			envelope = await buildLaunchFailureEnvelope({
				preInitialization: {
					type: "contract_failure",
					code: "environment_incomplete",
				},
			});
		}
		console.log(JSON.stringify(envelope));
		const failed =
			(result
				? result.results.some(
						(entry) =>
							!entry.success && entry.result !== "route_health_deferred",
					)
				: true) || Boolean(firstCallbackFailure);
		const deferred = Array.isArray(result?.deferredTaskIds)
			? result.deferredTaskIds.length > 0
			: false;
		process.exitCode = queueError || failed ? 1 : deferred ? 6 : 0;
		return {
			runId: envelope.runId,
			error: Boolean(queueError || failed || deferred),
		};
	}
	if (queueError) {
		Object.defineProperty(queueError, "switchyardRunId", {
			value: runId,
			enumerable: false,
		});
		throw queueError;
	}

	const failed = result.results.filter(
		(r) => !r.success && r.result !== "route_health_deferred",
	);
	const deferredCount = result.deferredTaskIds?.length ?? 0;
	if (firstCallbackFailure) {
		report(
			`dispatch: run-store persistence failed (${firstCallbackFailure.diagnostic})`,
		);
	} else {
		report(
			`dispatch: done — ${result.processedTasks}/${result.runnableTasks} runnable processed, ` +
				`${result.completedTaskIds.length} completed, ${failed.length} failed, ${deferredCount} deferred`,
		);
		report(`dispatch: checkpoint ${result.checkpointPath}`);
		renewDispatchReceipts(result.checkpointPath, report);
	}
	process.exitCode =
		failed.length > 0 || firstCallbackFailure ? 1 : deferredCount > 0 ? 6 : 0;
}

export { runDispatch };
