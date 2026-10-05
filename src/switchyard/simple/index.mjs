import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
	PERSISTED_SIGNALS,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { boundProviderLifecycleSnapshot } from "../adapter/provider-lifecycle.mjs";
import { createProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import {
	integrationGate,
	manifestReviewPaths,
	validateDiff,
} from "../integrate/index.mjs";
import {
	captureDirtyOverlay,
	validateDirtyOverlayReceipt,
} from "../lifecycle/index.mjs";
import {
	getConfiguredInvocationDescriptor,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { route } from "../router/index.mjs";
import {
	acquireProjectLock,
	createEvent,
	getRunRoot,
	initializeRun,
	isProjectLockOwnedBy,
	releaseProjectLockIfOwnedBy,
	updateRunWithRetry,
} from "../run-store/index.mjs";
import { isSafeDescriptorReceipt } from "../run-store/receipt-validation.mjs";
import {
	prepareSimpleOverlayBaseline,
	runSimpleBaselineChecks,
} from "./baseline.mjs";
import { createSimpleCheckSessions } from "./check-session.mjs";
import { deriveFailureAccountability } from "./failure-accountability.mjs";
import {
	persistFailureDisposition,
	publishFailedTerminal,
} from "./failure-finalization.mjs";
import { buildGuardedPrompt } from "./guarded-prompt.mjs";
import { createSimpleRouteHealthController } from "./health.mjs";
import { prepareSimpleProviderStart } from "./launcher-preflight.mjs";
import { simpleLockDisposition } from "./lock-disposition.mjs";
import {
	classifySimpleErrorKind,
	createSimpleProviderReliabilityDiagnostic,
} from "./reliability.mjs";
import { buildSimpleRepairPrompt, simpleRepairBudget } from "./repair.mjs";
import { routeDiagnosticPatch } from "./route-evidence.mjs";
import { createSimpleRouteSelection } from "./route-selection.mjs";
import { cleanupSimpleWorktree } from "./worktree-cleanup.mjs";

function declaredFileStat(worktreePath, path) {
	try {
		const stats = lstatSync(join(worktreePath, path));
		return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
	} catch {
		return null;
	}
}
/** First-change probe: lstat only, so no host git runs while the provider is live. */
function declaredFilesChanged(worktreePath, files, baseline) {
	return files.some((path) => {
		const current = declaredFileStat(worktreePath, path);
		const before = baseline.get(path) ?? null;
		if ((before === null) !== (current === null)) return true;
		return (
			current !== null &&
			(before.size !== current.size ||
				before.mtimeMs !== current.mtimeMs ||
				before.ino !== current.ino)
		);
	});
}
export async function runSimpleTask(options, dependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const taskId = dependencies.taskId ?? randomUUID();
	const attemptId = dependencies.attemptId ?? randomUUID();
	// A caller may bind an explicit run id for durable recovery or inspection.
	// Otherwise allocate a unique id: test seams and attended callers can reuse
	// a task id across attempts, while run-store records are create-only.
	const runId = dependencies.runId ?? `simple-${taskId}-${randomUUID()}`;
	const startedAt = now();
	const base = { taskId, attemptId, runId, startedAt, now };
	const onStatus = dependencies.onStatus;
	const signal = dependencies.signal;
	let provider = null;
	let targetId = null;
	let invocationDescriptor = null;
	let descriptorHarness = null;
	let providerExecutionResult = null;
	let providerStarted = false;
	let baselineStatus = (options.baselineChecks ?? []).length
		? "pending"
		: "not_requested";
	let failingCheckIndex = null;
	let failingCheckIdentity = null;
	let failureExitCode = null;
	let failureSignal = null;
	let failureTimedOut = null;
	let repairCount = 0;
	let repairStatus = options.repairChecks ? "not_started" : "not_requested";
	let terminalProviderReliability = null;
	let projectLocked = false;
	let canonicalParent = null;
	let candidateChild = null;
	let candidatePath = null;
	let worktreeRoot = null;
	let worktreePath = null;
	let keepWorktree = false;
	let changedFiles = [];
	let finalResult = null;
	let currentPhase = "preflight";
	let baseRevision = null;
	let worktreeBaseRevision = null;
	let dirtyOverlayReceipt = null;
	let dirtyBaseline = null;
	let preflightDetail = null;
	let providerLifecycle = null;
	let providerVerdictCode = null;
	let writerLifecycle = "never_started";
	let projectLockState = "not_acquired";
	let worktreeCreated = false;
	let worktreeIdentity = null;
	let worktreeGitControl = null;
	let gitControlTampered = false;
	let worktreeCleanupReason = null;
	let executionFailureCaptureComplete = false;
	let lastMilestoneAt = startedAt;
	let firstChangeObserved = false;
	let lastFirstChangeProbeAt = Number.NEGATIVE_INFINITY;
	let runInitialized = false;
	let failureTerminalDurable = true;
	const pendingDurability = new Set();
	const checks = [];
	const acquireLock = dependencies.acquireProjectLock ?? acquireProjectLock;
	const releaseLock =
		dependencies.releaseProjectLock ?? releaseProjectLockIfOwnedBy;
	const executeProvider =
		dependencies.executeProvider ?? defaultExecuteProvider;
	let runCheck = dependencies.runCheck ?? defaultRunCheck;
	let checkSessions = null;
	const routeProvider = dependencies.route ?? route;
	const healthController = (
		dependencies.createSimpleRouteHealthController ??
		createSimpleRouteHealthController
	)({
		healthDecision: dependencies.healthDecision,
		healthMode: dependencies.healthMode,
		healthStateRoot: dependencies.healthStateRoot,
		qualifiedProviders: dependencies.qualifiedProviders,
		runId,
		taskId,
		attemptId,
		now,
		onStatus,
		createRouteHealthEvent: dependencies.createRouteHealthEvent,
		ingestRouteHealthEvents: dependencies.ingestRouteHealthEvents,
	});
	const descriptorFor =
		dependencies.getInvocationDescriptor ?? getConfiguredInvocationDescriptor;
	const resolveIdentity =
		dependencies.resolveTargetIdentity ?? resolveTargetIdentity;

	const classifyErrorKind = classifySimpleErrorKind;
	const cleanupMetadata = (input) => ({
		...sanitizeFailureMetadata(input),
		result: input.result,
	});
	const milestone = (phase, name, details = {}) => {
		const observedAt = now();
		const elapsedSinceLastMilestoneMs = Math.max(
			0,
			observedAt - lastMilestoneAt,
		);
		emitStatus(onStatus, taskId, phase, {
			milestone: name,
			elapsedMs: Math.max(0, observedAt - startedAt),
			elapsedSinceLastMilestoneMs,
			firstChangeObserved,
			...details,
		});
		lastMilestoneAt = observedAt;
		if (runInitialized) {
			try {
				const descriptorReceipt =
					details.invocationDescriptor &&
					isSafeDescriptorReceipt(
						details.invocationDescriptor,
						details.descriptorHarness,
					) &&
					details.invocationDescriptor.descriptor_identity ===
						details.descriptorIdentity &&
					details.invocationDescriptor.target_id === details.resolvedTargetId
						? {
								invocationDescriptor: details.invocationDescriptor,
								descriptorIdentity: details.descriptorIdentity,
								descriptorHarness: details.descriptorHarness,
								resolvedTargetId: details.resolvedTargetId,
							}
						: {};
				const eventWrite = (dependencies.createEvent ?? createEvent)(runId, {
					phase,
					event: "milestone",
					milestone: name,
					status: details.status ?? "in_progress",
					elapsedMs: Math.max(0, observedAt - startedAt),
					elapsedSinceLastMilestoneMs,
					...(details.checkIndex !== undefined
						? { checkIndex: details.checkIndex }
						: {}),
					...(details.checkIdentity !== undefined
						? { checkIdentity: details.checkIdentity }
						: {}),
					...(details.checkStatus !== undefined
						? { checkStatus: details.checkStatus }
						: {}),
					...(details.exitCode !== undefined
						? { exitCode: details.exitCode }
						: {}),
					...(details.signal !== undefined ? { signal: details.signal } : {}),
					...descriptorReceipt,
					firstChangeObserved,
				}).catch(() => {});
				pendingDurability.add(eventWrite);
				void eventWrite.finally(() => pendingDurability.delete(eventWrite));
			} catch {}
		}
	};
	const heartbeat = (phase, details = {}) => {
		const observedAt = now();
		emitStatus(onStatus, taskId, phase, {
			elapsedMs: Math.max(0, observedAt - startedAt),
			elapsedSinceLastMilestoneMs: Math.max(0, observedAt - lastMilestoneAt),
			firstChangeObserved,
			...details,
		});
	};
	let cleanupAttempted = false;
	const removeNonSalvageWorktree = async () => {
		if (cleanupAttempted || !worktreeRoot) return !worktreeRoot;
		cleanupAttempted = true;
		try {
			// Injected provider/check tests normally use the direct cleanup seam;
			// a supplied cleanup function exercises the guarded path instead.
			if (
				!dependencies.cleanupSimpleWorktree &&
				(dependencies.rmSync ||
					dependencies.executeProvider ||
					dependencies.runCheck)
			) {
				const safeParent =
					canonicalParent ??
					realpathSync(dependencies.tmpdir ? dependencies.tmpdir() : tmpdir());
				if (!worktreeRoot.startsWith(`${safeParent}${sep}`))
					throw new Error("unsafe workspace root");
				(dependencies.rmSync ?? rmSync)(worktreeRoot, {
					recursive: true,
					force: true,
				});
			} else {
				const outcome = await (
					dependencies.cleanupSimpleWorktree ?? cleanupSimpleWorktree
				)(
					runId,
					{
						canonicalParent,
						candidateChild,
						path: candidatePath,
						...worktreeIdentity,
					},
					{
						writerStopped:
							writerLifecycle === "stopped" ||
							writerLifecycle === "never_started",
						onStatus: (processPhase) => heartbeat("cleanup", { processPhase }),
					},
				);
				if (outcome.path && outcome.path !== candidatePath) {
					canonicalParent = dirname(outcome.path);
					candidateChild = basename(outcome.path);
					candidatePath = outcome.path;
					worktreeRoot = outcome.path;
					worktreePath = join(outcome.path, "worktree");
				}
				if (!outcome.removed) {
					worktreeCleanupReason = outcome.reason;
					throw new Error(outcome.reason);
				}
			}
			worktreePath = null;
			worktreeRoot = null;
			return true;
		} catch {
			worktreeCleanupReason ??= "worktree_cleanup_failed";
			keepWorktree = true;
			return false;
		}
	};
	const fail = (
		failureReason,
		failurePhase,
		errorKind = null,
		error = null,
	) => {
		const computedErrorKind =
			errorKind ?? classifyErrorKind(failureReason, failurePhase, error);
		if (
			worktreePath &&
			!signal?.aborted &&
			!gitControlTampered &&
			!(currentPhase === "execute" && executionFailureCaptureComplete) &&
			(remainingMs(options.deadlineMs, now) <= 0 ||
				(currentPhase === "execute" && !keepWorktree))
		) {
			keepWorktree = true;
		}
		if (keepWorktree && worktreePath) {
			milestone(failurePhase, "salvage_retained");
		}
		milestone("terminal", "failed", { failurePhase });
		const providerReliability = createSimpleProviderReliabilityDiagnostic({
			errorKind: computedErrorKind,
			failureReason,
			failurePhase,
			providerResult:
				failurePhase === "baseline" || failurePhase === "checks"
					? null
					: providerExecutionResult,
			exitCode: failureExitCode,
			signal: failureSignal,
			timedOut: failureTimedOut,
			checkIndex: failingCheckIndex,
			checkIdentity: failingCheckIdentity,
			baselineStatus,
			diffRejectionCount: changedFiles.length,
			repairCount,
			repairStatus,
		});
		finalResult = terminalResult(base, {
			provider,
			targetId,
			changedFiles,
			checks,
			failureReason,
			failurePhase,
			errorKind: computedErrorKind,
			preflightDetail,
			dirtyBaseline,
			providerLifecycle,
			providerVerdictCode,
			partialWorktree: keepWorktree ? worktreePath : null,
		});
		finalResult.providerReliability = providerReliability;
		finalResult.providerStarted = providerStarted;
		finalResult.accountability = deriveFailureAccountability({
			providerReliability,
			provenance: {
				...providerExecutionResult,
				failurePhase:
					failurePhase === "execute" ? "provider_execution" : failurePhase,
			},
		});
		if (invocationDescriptor) {
			finalResult.invocationDescriptor = structuredClone(invocationDescriptor);
			finalResult.descriptorIdentity = invocationDescriptor.descriptor_identity;
			finalResult.descriptorHarness = descriptorHarness;
		}
		if (runInitialized) {
			failureTerminalDurable = false;
			try {
				const terminalWrite = publishFailedTerminal(
					dependencies.updateRunWithRetry ?? updateRunWithRetry,
					runId,
					{
						state: "failed",
						finishedAt: new Date(now()).toISOString(),
						lastFailure: sanitizeFailureMetadata({
							taskId,
							result: "execution_failed",
							errorKind: computedErrorKind,
							failurePhase:
								failurePhase === "execute"
									? "provider_execution"
									: failurePhase,
							providerReliability,
							...(providerExecutionResult?.diagnosticCode &&
							providerExecutionResult?.diagnosticEvidenceAvailable === true
								? { diagnosticCode: providerExecutionResult.diagnosticCode }
								: {}),
							...(providerExecutionResult?.diagnosticOrigin
								? { diagnosticOrigin: providerExecutionResult.diagnosticOrigin }
								: {}),
							...(providerExecutionResult?.diagnosticEvidenceAvailable === true
								? { diagnosticEvidenceAvailable: true }
								: {}),
							...(Number.isSafeInteger(providerExecutionResult?.code)
								? { exitCode: providerExecutionResult.code }
								: {}),
							...(PERSISTED_SIGNALS.has(providerExecutionResult?.signal)
								? { signal: providerExecutionResult.signal }
								: {}),
						}),
					},
				).then((durable) => {
					failureTerminalDurable = durable;
				});
				pendingDurability.add(terminalWrite);
				void terminalWrite.finally(() =>
					pendingDurability.delete(terminalWrite),
				);
				const taskFailedEvent = (dependencies.createEvent ?? createEvent)(
					runId,
					{
						phase: "execution",
						event: "task_failed",
						status: "failed",
						taskId,
						attempt: attemptId,
						result: "execution_failed",
						errorKind: computedErrorKind,
						failurePhase:
							failurePhase === "execute" ? "provider_execution" : failurePhase,
						providerReliability,
						reasonCode: providerReliability.causeCode,
						...(provider ? { provider } : {}),
						...(descriptorHarness ? { descriptorHarness } : {}),
						...(targetId ? { resolvedTargetId: targetId } : {}),
						...(invocationDescriptor
							? {
									invocationDescriptor: structuredClone(invocationDescriptor),
									descriptorIdentity: invocationDescriptor.descriptor_identity,
								}
							: {}),
						...(providerExecutionResult?.diagnosticCode &&
						providerExecutionResult?.diagnosticEvidenceAvailable === true
							? { diagnosticCode: providerExecutionResult.diagnosticCode }
							: {}),
						...(providerExecutionResult?.diagnosticOrigin
							? { diagnosticOrigin: providerExecutionResult.diagnosticOrigin }
							: {}),
						...(providerExecutionResult?.diagnosticEvidenceAvailable === true
							? { diagnosticEvidenceAvailable: true }
							: {}),
						...(Number.isSafeInteger(providerExecutionResult?.code)
							? { exitCode: providerExecutionResult.code }
							: {}),
						...(PERSISTED_SIGNALS.has(providerExecutionResult?.signal)
							? { signal: providerExecutionResult.signal }
							: {}),
					},
				).catch(() => {});
				pendingDurability.add(taskFailedEvent);
				void taskFailedEvent.finally(() =>
					pendingDurability.delete(taskFailedEvent),
				);
			} catch {}
		}
		return finalResult;
	};
	const failGitControlTampered = (failurePhase) => {
		// A checkout whose git control was tampered with has no salvage value:
		// it is never retained, and no further host git runs against it.
		gitControlTampered = true;
		keepWorktree = false;
		providerExecutionResult = {
			...(providerExecutionResult ?? { success: false, code: null }),
			diagnosticCode: "git_control_tampered",
			diagnosticOrigin: "harness",
			diagnosticEvidenceAvailable: true,
		};
		const result = fail("unsafe_diff", failurePhase, "policy_violation");
		result.diagnosticCode = "git_control_tampered";
		return result;
	};
	const failForSignal = (failurePhase = currentPhase) => {
		if (!signal?.aborted) return null;
		if (worktreePath) {
			if (
				writerLifecycle !== "stopped" &&
				writerLifecycle !== "never_started"
			) {
				keepWorktree = true;
			} else if (changedFiles.length > 0) {
				keepWorktree = true;
			} else {
				try {
					if (worktreeGitControl)
						verifyGitControl(worktreePath, worktreeGitControl);
					const status = worktreeGit(worktreePath, [
						"status",
						"--porcelain=v1",
						"--untracked-files=all",
					]);
					keepWorktree = status.status !== 0 || status.stdout.length > 0;
				} catch (error) {
					if (error?.code === "git_control_tampered")
						return failGitControlTampered(failurePhase);
					keepWorktree = true;
				}
			}
		}
		return fail("provider_cancelled", failurePhase, "execution_failed");
	};

	try {
		try {
			await (dependencies.initializeRun ?? initializeRun)({
				runId,
				tasksFilePath: options.promptPath,
				projectPath: options.projectPath,
				orderedTaskIds: [taskId],
				initialHostFingerprint: "simple",
				workerPid: process.pid,
				workerNonce: randomUUID(),
			});
			runInitialized = true;
		} catch (error) {
			return fail(
				"run_store_write_failed",
				"preflight",
				classifyErrorKind("run_store_write_failed", "preflight", error),
				error,
			);
		}
		if (signal?.aborted) return failForSignal("preflight");

		if (
			manifestReviewPaths(options.files).some(
				(path) => !(options.allowManifests ?? []).includes(path),
			)
		) {
			return fail(
				"manifest_review_required",
				"input_validation",
				"validation_failed",
			);
		}
		if (remainingMs(options.deadlineMs, now) <= 0) {
			return fail("deadline_expired", "preflight");
		}
		emitStatus(onStatus, taskId, "lock");
		try {
			await acquireLock(options.projectPath, runId);
			projectLocked = true;
			projectLockState = "held";
		} catch (error) {
			const result = fail(
				error?.code ?? "project_lock_failed",
				"preflight",
				classifyErrorKind(
					error?.code ?? "project_lock_failed",
					"preflight",
					error,
				),
				error,
			);
			Object.assign(
				result,
				await simpleLockDisposition(error, options.projectPath, dependencies),
			);
			return result;
		}
		if (signal?.aborted) return failForSignal("preflight");
		baseRevision = requireGit(
			options.projectPath,
			["rev-parse", "HEAD"],
			"project_revision_unavailable",
		).trim();
		const baselinePaths = [...options.files, ...(options.readOnlyInputs ?? [])];
		if (options.dirtyOverlay) {
			try {
				const predecessorInput =
					options.predecessorReceiptPath ??
					options.predecessorReceipt ??
					dependencies.predecessorReceipt ??
					null;
				const predecessorReceipt = predecessorInput
					? await resolvePredecessorReceipt(
							predecessorInput,
							options.projectPath,
							dependencies,
						)
					: null;
				dirtyOverlayReceipt = captureDirtyOverlay(
					options.projectPath,
					baselinePaths,
					{
						allowUnrelated: true,
						maxFileBytes: MAX_CAPTURE_BYTES,
						enforceTarPathLimit: false,
						secretPaths: SECRET_PATHS,
						predecessorReceipt,
					},
				);
				dirtyBaseline = makeDirtyBaseline({
					taskId,
					baseRevision,
					projectPath: options.projectPath,
					files: options.files,
					inputs: options.readOnlyInputs ?? [],
					receipt: dirtyOverlayReceipt,
				});
			} catch (error) {
				preflightDetail = dirtyOverlayFailure(error, {
					taskId,
					baseRevision,
					files: options.files,
					inputs: options.readOnlyInputs ?? [],
				});
				return fail(
					preflightDetail.code,
					"preflight",
					classifyErrorKind(preflightDetail.code, "preflight", error),
					error,
				);
			}
		} else if (!declaredPathsAreClean(options.projectPath, options.files)) {
			return fail("declared_path_has_owner_edits", "preflight");
		}
		const initialFingerprint = fileFingerprint(
			options.projectPath,
			options.dirtyOverlay ? baselinePaths : options.files,
		);

		currentPhase = "route";
		emitStatus(onStatus, taskId, "route");
		const { excludedSimpleTargets, selectSimpleRoute } =
			createSimpleRouteSelection({
				options,
				resolveIdentity,
				descriptorFor,
				routeProvider,
				healthController,
				now,
				funded: dependencies.assertFundedRoute ?? assertFundedRoute,
				onDecision: async (routed) => {
					const diagnostics = routeDiagnosticPatch(routed);
					if (!runInitialized || !Object.keys(diagnostics).length) return;
					try {
						await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(
							runId,
							{
								...diagnostics,
								resolvedTargetId: diagnostics.routeEvidence.selectedTargetId,
								activeTaskProvider: routed.provider ?? null,
								activeTaskModel: routed.model ?? null,
							},
						);
					} catch (error) {
						currentPhase = "route";
						throw Object.assign(
							new Error("run_store_write_failed", { cause: error }),
							{
								code: "run_store_write_failed",
							},
						);
					}
				},
			});
		let selectedRoute = await selectSimpleRoute();
		if (selectedRoute.error) return fail(selectedRoute.error, "route");
		provider = selectedRoute.provider;
		targetId = selectedRoute.targetId;
		let descriptor = selectedRoute.descriptor;
		let harness = selectedRoute.harness;
		invocationDescriptor = structuredClone(descriptor);
		descriptorHarness = harness;

		milestone("route", "route_selected", {
			provider,
			targetId,
			resolvedTargetId: targetId,
			descriptorHarness,
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			invocationDescriptor,
		});
		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					resolvedTargetId: targetId,
					...selectedRoute.diagnostics,
					activeTaskProvider: provider,
					activeTaskModel: descriptor?.selector ?? null,
				});
			} catch (error) {
				return fail(
					"run_store_write_failed",
					"route",
					classifyErrorKind("run_store_write_failed", "route", error),
					error,
				);
			}
		}

		currentPhase = "prepare";
		emitStatus(onStatus, taskId, "prepare");
		const tempBase =
			typeof dependencies.tmpdir === "function"
				? dependencies.tmpdir()
				: (dependencies.tmpdir ?? tmpdir());
		canonicalParent = realpathSync(tempBase);
		candidateChild = `switchyard-simple-${randomUUID()}`;
		candidatePath = join(canonicalParent, candidateChild);

		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: "allocating",
						reason: null,
						retainedAt: null,
					},
				});
			} catch (error) {
				return fail(
					"run_store_write_failed",
					"prepare",
					classifyErrorKind("run_store_write_failed", "prepare", error),
					error,
				);
			}
		}

		try {
			(dependencies.mkdirSync ?? mkdirSync)(candidatePath, { mode: 0o700 });
		} catch (error) {
			// An allocation error does not prove the candidate is absent. Keep the
			// durable claim until recovery can inspect the exact path.
			keepWorktree = true;
			return fail(
				"worktree_allocation_failed",
				"prepare",
				"environment_failure",
				error,
			);
		}
		worktreeRoot = candidatePath;
		worktreeCreated = true;
		worktreePath = join(worktreeRoot, "worktree");
		try {
			const rootStat = statSync(candidatePath, { bigint: true });
			if (!rootStat.isDirectory()) throw new Error("root_not_directory");
			const nonce = randomUUID();
			const markerPath = join(candidatePath, ".switchyard-cleanup-owner.json");
			let markerFd = null;
			try {
				markerFd = openSync(markerPath, "wx", 0o600);
				writeSync(markerFd, `${JSON.stringify({ runId, nonce })}\n`);
				fsyncSync(markerFd);
			} finally {
				if (markerFd !== null) closeSync(markerFd);
			}
			let dirFd = null;
			try {
				dirFd = openSync(candidatePath, "r");
				fsyncSync(dirFd);
			} finally {
				if (dirFd !== null) closeSync(dirFd);
			}
			const confirmed = statSync(candidatePath, { bigint: true });
			if (confirmed.dev !== rootStat.dev || confirmed.ino !== rootStat.ino) {
				throw new Error("root_identity_changed");
			}
			worktreeIdentity = {
				device: rootStat.dev.toString(),
				inode: rootStat.ino.toString(),
				nonce,
			};
		} catch (error) {
			keepWorktree = true;
			return fail(
				"worktree_ownership_failed",
				"prepare",
				"cleanup_failed",
				error,
			);
		}
		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: "active",
						reason: null,
						retainedAt: null,
						...worktreeIdentity,
					},
				});
			} catch (error) {
				return fail(
					"run_store_write_failed",
					"prepare",
					classifyErrorKind("run_store_write_failed", "prepare", error),
					error,
				);
			}
		}
		requireGit(
			worktreeRoot,
			[
				"clone",
				"--shared",
				"--no-checkout",
				"--quiet",
				"--",
				options.projectPath,
				worktreePath,
			],
			"workspace_clone_failed",
			{ timeout: deadlineTimeout(options.deadlineMs, now) },
		);
		requireGit(
			worktreePath,
			["checkout", "--detach", "--quiet", baseRevision],
			"workspace_checkout_failed",
			{ timeout: deadlineTimeout(options.deadlineMs, now) },
		);
		worktreeBaseRevision = baseRevision;
		if (dirtyOverlayReceipt) {
			worktreeBaseRevision = prepareSimpleOverlayBaseline({
				worktreePath,
				dirtyOverlayReceipt,
				baselinePaths,
				deadlineMs: options.deadlineMs,
				now,
			});
		}
		// Snapshot git control before any untrusted code (baseline checks or
		// provider) can touch the clone; every later host git call verifies it.
		worktreeGitControl = snapshotGitControl(worktreePath);

		let baselineCheckPath = worktreePath;
		if (
			!dependencies.runCheck &&
			[...options.checks, ...(options.baselineChecks ?? [])].length
		) {
			verifyGitControl(worktreePath, worktreeGitControl);
			checkSessions = createSimpleCheckSessions({
				taskRoot: worktreeRoot,
				projectPath: options.projectPath,
				baseRevision,
				baseTree: requireWorktreeGit(
					worktreePath,
					["rev-parse", "HEAD^{tree}"],
					"check_session_base_unavailable",
					{ timeout: deadlineTimeout(options.deadlineMs, now) },
				).trim(),
				dirtyOverlayReceipt,
				files: options.files,
				allowManifests: options.allowManifests,
				commands: [...options.checks, ...(options.baselineChecks ?? [])],
				taskId,
				deadlineMs: options.deadlineMs,
				cachePath: dependencies.checkCachePath,
				now,
				signal,
				onProgress: () =>
					heartbeat("baseline", { processPhase: "check_preparing" }),
			});
			currentPhase = "baseline";
			baselineCheckPath = await checkSessions.prepare();
			runCheck = checkSessions.run;
		}

		const baselineResult = await runSimpleBaselineChecks({
			checks: options.baselineChecks ?? [],
			taskId,
			worktreePath: baselineCheckPath,
			deadlineMs: options.deadlineMs,
			now,
			signal,
			runCheck,
			gitControlSnapshot: checkSessions
				? checkSessions.gitControlSnapshot
				: worktreeGitControl,
			onStatus: (event) => {
				if (event.checkIndex !== undefined) {
					failingCheckIndex = event.checkIndex;
					failingCheckIdentity = event.checkIdentity ?? null;
				}
				milestone("baseline", event.event, {
					checkIndex: event.checkIndex,
					checkIdentity: event.checkIdentity,
					checkStatus: event.checkStatus,
				});
			},
		});
		baselineStatus = baselineResult.status;
		checkSessions?.remove();
		if (baselineResult.checks.length > 0) {
			const lifecycles = baselineResult.checks.map(
				(check) => check.writerLifecycle,
			);
			writerLifecycle = lifecycles.reduce(
				aggregateWriterLifecycle,
				"never_started",
			);
		}
		const baselineFailure = [...baselineResult.checks]
			.reverse()
			.find((check) => !check.success);
		if (baselineFailure) {
			failureExitCode = baselineFailure.exitCode;
			failureSignal = baselineFailure.signal;
			failureTimedOut = baselineFailure.timedOut;
		}
		if (baselineStatus === "unknown") {
			writerLifecycle = "unavailable";
			keepWorktree = true;
			return fail(
				"baseline_check_unavailable",
				"baseline",
				"environment_failure",
			);
		}
		if (baselineStatus === "cancelled") return failForSignal("baseline");
		if (baselineStatus === "mutation_detected") {
			return fail("baseline_mutation", "baseline", "environment_failure");
		}
		if (baselineStatus === "failed") {
			return fail("baseline_check_failed", "baseline", "environment_failure");
		}
		failingCheckIndex = null;
		failingCheckIdentity = null;

		const guardedPrompt = buildGuardedPrompt({
			promptText: readFileSync(options.promptPath, "utf8"),
			files: options.files,
			readOnlyInputs: options.readOnlyInputs ?? [],
			checks: options.checks ?? [],
		});
		currentPhase = "preflight";
		const admissionFor = (repair = false) =>
			prepareSimpleProviderStart({
				targetId,
				deadlineMs: options.deadlineMs,
				now,
				signal,
				onProgress: () =>
					heartbeat("preflight", { processPhase: "launcher_probe" }),
				probe: dependencies.probeSimpleLauncher,
				runProbe: dependencies.runLauncherProbe,
				healthController,
				recorderPath:
					(executeProvider === defaultExecuteProvider ||
						dependencies.createBridgeRequestRecorder) &&
					(harness === "opencode" ||
						(harness === "vibe" && targetId !== "vibe-code"))
						? join(
								getRunRoot(runId),
								repair
									? "provider-requests-repair.jsonl"
									: "provider-requests.jsonl",
							)
						: null,
				createRecorder: dependencies.createBridgeRequestRecorder,
			});
		const failAdmission = (admission) => {
			const providerWriterLifecycle = providerStarted
				? (providerExecutionResult?.writerLifecycle ?? "unavailable")
				: "never_started";
			if (!providerStarted)
				providerExecutionResult = {
					success: false,
					code: null,
					writerLifecycle: "never_started",
				};
			writerLifecycle =
				admission.probeWriterLifecycle === "unavailable" ||
				admission.cleanupUnavailable
					? "unavailable"
					: providerWriterLifecycle;
			if (writerLifecycle === "unavailable") keepWorktree = true;
			const result = fail(
				admission.failureReason,
				"preflight",
				[
					"launcher_environment_unavailable",
					"request_log_open_failed",
				].includes(admission.failureReason)
					? "environment_failure"
					: null,
			);
			result.providerStarted = providerStarted;
			result.writerLifecycle = providerWriterLifecycle;
			return result;
		};
		let admission = await admissionFor();
		if (!admission.success) return failAdmission(admission);
		let providerHealthStart = admission.healthStart;
		while (!providerHealthStart.allowed && providerHealthStart.reroute) {
			excludedSimpleTargets.add(targetId);
			selectedRoute = await selectSimpleRoute();
			if (selectedRoute.error) return fail("route_health_blocked", "route");
			provider = selectedRoute.provider;
			targetId = selectedRoute.targetId;
			descriptor = selectedRoute.descriptor;
			harness = selectedRoute.harness;
			invocationDescriptor = structuredClone(descriptor);
			descriptorHarness = harness;
			(dependencies.assertFundedRoute ?? assertFundedRoute)(targetId);
			milestone("route", "route_selected", {
				provider,
				targetId,
				resolvedTargetId: targetId,
				descriptorHarness,
				descriptorIdentity: invocationDescriptor.descriptor_identity,
				invocationDescriptor,
			});
			if (runInitialized) {
				try {
					await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
						resolvedTargetId: targetId,
						...selectedRoute.diagnostics,
						activeTaskProvider: provider,
						activeTaskModel: descriptor.selector ?? null,
					});
				} catch (error) {
					return fail(
						"run_store_write_failed",
						"route",
						classifyErrorKind("run_store_write_failed", "route", error),
						error,
					);
				}
			}
			admission = await admissionFor();
			if (!admission.success) return failAdmission(admission);
			providerHealthStart = admission.healthStart;
		}
		if (!providerHealthStart.allowed)
			return fail("route_health_blocked", "route");
		const providerHealthTracked = providerHealthStart.tracked === true;
		const requestRecorder = admission.recorder;
		const cancelAdmission = async (prepared, failureReason) =>
			failAdmission({
				...prepared,
				failureReason,
				cleanupUnavailable: !(await prepared.cancelUnstarted()),
			});
		milestone("execute", "provider_starting");
		// Status callbacks can abort synchronously. The final fence follows them.
		const executionBudget = remainingMs(options.deadlineMs, now);
		if (signal?.aborted)
			return await cancelAdmission(admission, "provider_cancelled");
		if (executionBudget <= 0)
			return await cancelAdmission(admission, "deadline_expired");
		let providerResult;
		let requestLogStatus;
		try {
			if (!admission.startPrepared().allowed)
				return await cancelAdmission(admission, "route_health_blocked");
			currentPhase = "execute";
			providerStarted = true;
			writerLifecycle = "unavailable";
			const declaredFileBaseline = new Map(
				options.files.map((path) => [
					path,
					declaredFileStat(worktreePath, path),
				]),
			);
			const execution = executeProvider({
				targetId,
				harness,
				descriptor,
				capability: options.capability,
				prompt: guardedPrompt,
				worktreePath,
				timeoutMs: executionBudget,
				signal,
				onStderrChunk: requestRecorder?.accept,
				onProgress: () => {
					const progressObservedAt = now();
					if (
						!firstChangeObserved &&
						progressObservedAt - lastFirstChangeProbeAt >=
							FIRST_CHANGE_PROBE_INTERVAL_MS
					) {
						lastFirstChangeProbeAt = progressObservedAt;
						if (
							declaredFilesChanged(
								worktreePath,
								options.files,
								declaredFileBaseline,
							)
						) {
							firstChangeObserved = true;
							milestone("execute", "first_change_observed");
							return;
						}
					}
					heartbeat("execute", { processPhase: "provider_running" });
				},
			});
			milestone("execute", "provider_started");
			providerResult = await execution;
		} finally {
			requestLogStatus = requestRecorder?.close();
		}
		providerExecutionResult = providerResult;
		providerLifecycle = boundProviderLifecycleSnapshot(
			providerResult?.providerLifecycle,
		);
		providerVerdictCode = providerResult?.providerVerdictCode ?? null;
		writerLifecycle = aggregateWriterLifecycle(
			"never_started",
			providerResult?.writerLifecycle,
		);
		const providerAttemptReliability = providerResult?.success
			? null
			: createSimpleProviderReliabilityDiagnostic({
					failureReason: classifyExecutionFailure(providerResult),
					failurePhase: "execute",
					providerResult,
					baselineStatus,
					repairCount,
					repairStatus,
				});
		let providerHealthTerminal = { settled: !providerHealthTracked };
		try {
			providerHealthTerminal = await healthController.terminal({
				providerResult,
				providerReliability:
					providerResult?.providerReliability ?? providerAttemptReliability,
				providerLifecycle,
			});
		} catch {
			providerHealthTerminal = {
				settled: false,
				reason: "provider-health-unavailable",
			};
		}
		const providerAttemptSettled =
			!providerHealthTracked || providerHealthTerminal.settled === true;
		if (requestLogStatus?.error) return fail(requestLogStatus.error, "execute");

		if (signal?.aborted) return failForSignal("execute");
		if (
			(!dependencies.runCheck || executeProvider === defaultExecuteProvider) &&
			writerLifecycle === "unavailable"
		) {
			keepWorktree = true;
			return fail("provider_group_unconfirmed", "execute", "cleanup_failed");
		}
		if (!providerResult?.success) {
			if (remainingMs(options.deadlineMs, now) > 0) {
				const captured = captureWorktreeDiff(
					worktreePath,
					worktreeBaseRevision,
					options.deadlineMs,
					now,
					worktreeGitControl,
				);
				changedFiles = captured.changedFiles;
				executionFailureCaptureComplete = true;
				keepWorktree = changedFiles.length > 0;
			} else {
				keepWorktree = true;
			}
			return fail(classifyExecutionFailure(providerResult), "execute");
		}
		if (remainingMs(options.deadlineMs, now) <= 0) {
			keepWorktree = true;
			return fail("deadline_expired", "checks");
		}
		currentPhase = "diff";
		milestone("diff", "capture_started");
		const captured = captureWorktreeDiff(
			worktreePath,
			worktreeBaseRevision,
			options.deadlineMs,
			now,
			worktreeGitControl,
		);
		changedFiles = captured.changedFiles;
		if (changedFiles.length > 0 && !firstChangeObserved) {
			firstChangeObserved = true;
			milestone("diff", "first_change_observed");
		}
		if (changedFiles.length === 0) return fail("empty_diff", "diff");
		const undeclared = changedFiles.filter(
			(path) => !options.files.includes(path),
		);
		if (undeclared.length > 0) {
			keepWorktree = true;
			return fail(
				(options.readOnlyInputs ?? []).some((path) => undeclared.includes(path))
					? "read_only_input_changed"
					: "undeclared_paths_changed",
				"diff",
			);
		}
		const validated = validateDiff(captured.diff, options.projectPath);
		if (
			!validated.safe ||
			(validated.requiresReview &&
				!(validated.sensitivePaths ?? []).every((path) =>
					(options.allowManifests ?? []).includes(path),
				))
		) {
			keepWorktree = true;
			return fail(
				validated.requiresReview ? "manifest_review_required" : "unsafe_diff",
				"diff",
			);
		}

		let capturedDiff = captured;
		for (let pass = 0; pass < 2; pass += 1) {
			if (checkSessions) {
				if (writerLifecycle !== "stopped")
					return fail("provider_group_unconfirmed", "checks", "cleanup_failed");
				if (options.checks.length > 0) {
					currentPhase = "checks";
					await checkSessions.prepare(capturedDiff.diff);
				}
			}
			let rerunAllChecks = false;
			checks.length = 0;
			for (let index = 0; index < options.checks.length; index += 1) {
				currentPhase = "checks";
				if (signal?.aborted) return failForSignal("checks");
				const remaining = remainingMs(options.deadlineMs, now);
				if (remaining <= 0) {
					keepWorktree = true;
					return fail("deadline_expired", "checks");
				}
				const checkIdentity = createHash("sha256")
					.update(options.checks[index])
					.digest("hex");
				milestone("checks", "check_started", {
					checkIndex: index + 1,
					checkIdentity,
				});
				const settledWriterLifecycle = writerLifecycle;
				writerLifecycle = "unavailable";
				const check = await runCheck({
					command: options.checks[index],
					worktreePath,
					timeoutMs: remaining,
					signal,
					onProgress: () =>
						heartbeat("checks", {
							processPhase: "check_running",
							checkIndex: index + 1,
							checkIdentity,
						}),
				});
				writerLifecycle = aggregateWriterLifecycle(
					settledWriterLifecycle,
					check?.writerLifecycle,
				);
				if (signal?.aborted) return failForSignal("checks");
				if (!dependencies.runCheck && writerLifecycle === "unavailable") {
					keepWorktree = true;
					return fail("check_group_unconfirmed", "checks", "cleanup_failed");
				}
				const checkStatus = check?.success ? "passed" : "failed";
				const checkExitCode =
					Number.isSafeInteger(check?.code) &&
					check.code >= 0 &&
					check.code <= 255
						? check.code
						: null;
				const checkSignal = PERSISTED_SIGNALS.has(check?.signal)
					? check.signal
					: null;
				checks.push({
					index: index + 1,
					status: checkStatus,
					...(checkStatus === "failed"
						? { exitCode: checkExitCode, signal: checkSignal }
						: {}),
				});
				milestone("checks", "check_finished", {
					checkIndex: index + 1,
					checkIdentity,
					checkStatus,
					...(checkStatus === "failed"
						? { exitCode: checkExitCode, signal: checkSignal }
						: {}),
				});
				if (check?.success) {
					failingCheckIndex = null;
					failingCheckIdentity = null;
					continue;
				}

				failingCheckIndex = index + 1;
				failingCheckIdentity = checkIdentity;
				failureExitCode = checkExitCode;
				failureSignal = checkSignal;
				failureTimedOut = check?.timedOut === true;
				if (check?.diagnosticCode === "check_dependencies_unverified") {
					keepWorktree = true;
					repairStatus = options.repairChecks ? "ineligible" : "not_requested";
					return fail(
						"check_dependencies_unverified",
						"checks",
						"environment_failure",
					);
				}
				const checkFailureReason = check?.silenceTimedOut
					? "check_silence_timeout"
					: check?.timedOut
						? "check_deadline_exceeded"
						: "check_failed";
				if (!options.repairChecks || pass > 0) {
					if (pass > 0) {
						keepWorktree = true;
						repairStatus = "failed";
						return fail("check_repair_failed", "checks");
					}
					keepWorktree = true;
					return fail(checkFailureReason, "checks");
				}
				if (
					repairCount !== 0 ||
					writerLifecycle !== "stopped" ||
					!projectLocked ||
					!providerAttemptSettled
				) {
					repairStatus = "ineligible";
					keepWorktree = true;
					return fail(checkFailureReason, "checks");
				}

				checkSessions?.remove();

				// A failing check can itself change the checkout. Re-capture and validate
				// the exact base and declared scope before any correction is allowed.
				capturedDiff = captureWorktreeDiff(
					worktreePath,
					worktreeBaseRevision,
					options.deadlineMs,
					now,
					worktreeGitControl,
				);
				changedFiles = capturedDiff.changedFiles;
				const repairUndeclared = changedFiles.filter(
					(path) => !options.files.includes(path),
				);
				if (repairUndeclared.length > 0) {
					keepWorktree = true;
					repairStatus = "ineligible";
					return fail(
						(options.readOnlyInputs ?? []).some((path) =>
							repairUndeclared.includes(path),
						)
							? "read_only_input_changed"
							: "undeclared_paths_changed",
						"diff",
					);
				}
				const repairDiffValidation = validateDiff(
					capturedDiff.diff,
					options.projectPath,
				);
				if (
					!repairDiffValidation.safe ||
					(repairDiffValidation.requiresReview &&
						!(repairDiffValidation.sensitivePaths ?? []).every((path) =>
							(options.allowManifests ?? []).includes(path),
						))
				) {
					keepWorktree = true;
					repairStatus = "ineligible";
					return fail(
						repairDiffValidation.requiresReview
							? "manifest_review_required"
							: "unsafe_diff",
						"diff",
					);
				}

				const lockOwned = await (
					dependencies.isProjectLockOwnedBy ?? isProjectLockOwnedBy
				)(options.projectPath, runId).catch(() => false);
				let budget = simpleRepairBudget(
					remainingMs(options.deadlineMs, now),
					options.checks.length,
				);
				if (!lockOwned || !budget || signal?.aborted) {
					repairStatus = "ineligible";
					keepWorktree = true;
					if (signal?.aborted) return failForSignal("checks");
					return fail(checkFailureReason, "checks");
				}
				repairCount = 1;
				repairStatus = "attempted";
				const repairPrompt = buildSimpleRepairPrompt({
					originalTask: guardedPrompt,
					checkIndex: index + 1,
					causeCode:
						check?.timedOut === true
							? "acceptance_check_timeout"
							: "acceptance_check_failed",
				});
				const repairPrepared = await healthController.prepare({
					provider,
					targetId,
					capability: options.capability,
					descriptor,
				});
				if (!repairPrepared.allowed || repairPrepared.reroute) {
					repairStatus = "ineligible";
					keepWorktree = true;
					return fail(checkFailureReason, "checks");
				}
				budget = simpleRepairBudget(
					remainingMs(options.deadlineMs, now),
					options.checks.length,
				);
				const stillOwnedBeforeCorrection = await (
					dependencies.isProjectLockOwnedBy ?? isProjectLockOwnedBy
				)(options.projectPath, runId).catch(() => false);
				if (!stillOwnedBeforeCorrection || !budget || signal?.aborted) {
					repairStatus = "ineligible";
					keepWorktree = true;
					if (signal?.aborted) return failForSignal("checks");
					return fail(checkFailureReason, "checks");
				}
				currentPhase = "preflight";
				const repairAdmission = await admissionFor(true);
				if (!repairAdmission.success) {
					repairStatus = "ineligible";
					keepWorktree = true;
					return failAdmission(repairAdmission);
				}
				const repairHealthStart = repairAdmission.healthStart;
				if (!repairHealthStart.allowed) {
					repairStatus = "ineligible";
					keepWorktree = true;
					return fail(checkFailureReason, "checks");
				}
				milestone("repair", "provider_starting");
				const correctionBudget = Math.min(
					budget.providerTimeoutMs,
					remainingMs(options.deadlineMs, now),
				);
				if (signal?.aborted)
					return await cancelAdmission(repairAdmission, "provider_cancelled");
				if (correctionBudget <= 0)
					return await cancelAdmission(repairAdmission, "deadline_expired");
				let correction;
				let correctionLogStatus;
				try {
					if (!repairAdmission.startPrepared().allowed)
						return await cancelAdmission(
							repairAdmission,
							"route_health_blocked",
						);
					currentPhase = "repair";
					providerStarted = true;
					writerLifecycle = "unavailable";
					const execution = executeProvider({
						targetId,
						harness,
						descriptor,
						capability: options.capability,
						prompt: repairPrompt,
						worktreePath,
						timeoutMs: correctionBudget,
						onStderrChunk: repairAdmission.recorder?.accept,
						signal,
						onProgress: () =>
							heartbeat("repair", { processPhase: "provider_running" }),
					});
					milestone("repair", "provider_started");
					correction = await execution;
				} finally {
					correctionLogStatus = repairAdmission.recorder?.close();
				}
				providerExecutionResult = correction;
				providerLifecycle = boundProviderLifecycleSnapshot(
					correction?.providerLifecycle,
				);
				writerLifecycle = aggregateWriterLifecycle(
					"never_started",
					correction?.writerLifecycle,
				);
				const correctionAttemptReliability = correction?.success
					? null
					: createSimpleProviderReliabilityDiagnostic({
							failureReason: classifyExecutionFailure(correction),
							failurePhase: "execute",
							providerResult: correction,
							baselineStatus,
							repairCount,
							repairStatus,
						});
				let correctionHealthTerminal = {
					settled: repairHealthStart.tracked !== true,
				};
				try {
					correctionHealthTerminal = await healthController.terminal({
						providerResult: correction,
						providerReliability:
							correction?.providerReliability ?? correctionAttemptReliability,
						providerLifecycle: providerLifecycle,
					});
				} catch {
					correctionHealthTerminal = {
						settled: false,
						reason: "provider-health-unavailable",
					};
				}
				if (correctionLogStatus?.error)
					return fail(correctionLogStatus.error, "repair");
				if (signal?.aborted) return failForSignal("repair");
				if (
					writerLifecycle !== "stopped" ||
					(repairHealthStart.tracked === true &&
						correctionHealthTerminal.settled !== true)
				) {
					keepWorktree = true;
					repairStatus = "unknown";
					return fail("provider_group_unconfirmed", "repair", "cleanup_failed");
				}
				const stillOwned = await (
					dependencies.isProjectLockOwnedBy ?? isProjectLockOwnedBy
				)(options.projectPath, runId).catch(() => false);
				if (!stillOwned) {
					keepWorktree = true;
					repairStatus = "unknown";
					return fail(
						"project_lock_release_unconfirmed",
						"repair",
						"cleanup_failed",
					);
				}
				if (!correction?.success) {
					keepWorktree = true;
					repairStatus = "failed";
					return fail(classifyExecutionFailure(correction), "execute");
				}

				capturedDiff = captureWorktreeDiff(
					worktreePath,
					worktreeBaseRevision,
					options.deadlineMs,
					now,
					worktreeGitControl,
				);
				changedFiles = capturedDiff.changedFiles;
				const correctedUndeclared = changedFiles.filter(
					(path) => !options.files.includes(path),
				);
				if (correctedUndeclared.length > 0) {
					keepWorktree = true;
					repairStatus = "ineligible";
					return fail(
						(options.readOnlyInputs ?? []).some((path) =>
							correctedUndeclared.includes(path),
						)
							? "read_only_input_changed"
							: "undeclared_paths_changed",
						"diff",
					);
				}
				const correctedValidation = validateDiff(
					capturedDiff.diff,
					options.projectPath,
				);
				if (
					!correctedValidation.safe ||
					(correctedValidation.requiresReview &&
						!(correctedValidation.sensitivePaths ?? []).every((path) =>
							(options.allowManifests ?? []).includes(path),
						))
				) {
					keepWorktree = true;
					repairStatus = "ineligible";
					return fail(
						correctedValidation.requiresReview
							? "manifest_review_required"
							: "unsafe_diff",
						"diff",
					);
				}
				checks.length = 0;
				rerunAllChecks = true;
				break;
			}
			if (rerunAllChecks) continue;
			break;
		}
		checkSessions?.remove();
		if (repairCount > 0) {
			repairStatus = "passed";
			terminalProviderReliability = createProviderReliabilityDiagnostic({
				causeCode: "check_repair_succeeded",
				phase: "check",
				baselineStatus,
				repairCount,
				repairStatus,
			});
		}
		if (signal?.aborted) return failForSignal("integrate");
		if (
			providerVerdictCode === "agy_non_success" ||
			providerVerdictCode === "agy_unparseable"
		) {
			// Keep the checked diff available for salvage without applying a provider-
			// reported failure to the host checkout.
			keepWorktree = true;
			return fail("provider_verdict_rejected", "integrate", "execution_failed");
		}

		if (remainingMs(options.deadlineMs, now) <= 0) {
			keepWorktree = true;
			return fail("deadline_expired", "integrate");
		}
		currentPhase = "integrate";
		if (
			requireGit(
				options.projectPath,
				["rev-parse", "HEAD"],
				"project_revision_unavailable",
				{ timeout: deadlineTimeout(options.deadlineMs, now) },
			).trim() !== baseRevision
		) {
			keepWorktree = true;
			return fail("project_head_changed_concurrently", "integrate");
		}
		if (dirtyOverlayReceipt) {
			const checked = validateDirtyOverlayReceipt(
				options.projectPath,
				dirtyOverlayReceipt,
				baselinePaths,
				{
					allowUnrelated: true,
					maxFileBytes: MAX_CAPTURE_BYTES,
					enforceTarPathLimit: false,
					secretPaths: SECRET_PATHS,
				},
			);
			if (
				!checked.ok ||
				checked.receiptHash !== dirtyOverlayReceipt.receiptHash
			) {
				keepWorktree = true;
				return fail("dirty_overlay_drift", "integrate");
			}
		}
		if (
			fileFingerprint(
				options.projectPath,
				options.dirtyOverlay ? baselinePaths : options.files,
			) !== initialFingerprint
		) {
			keepWorktree = true;
			return fail("declared_path_changed_concurrently", "integrate");
		}
		emitStatus(onStatus, taskId, "integrate");
		milestone("integrate", "integration_started");
		const integration = dependencies.integrate
			? await dependencies.integrate({
					diff: capturedDiff.diff,
					projectPath: options.projectPath,
					changedFiles,
					allowedPaths: options.files,
					allowSensitiveManifests: (options.allowManifests ?? []).length > 0,
				})
			: integrationGate(capturedDiff.diff, options.projectPath, {
					allowedPaths: options.files,
					allowSensitiveManifests: (options.allowManifests ?? []).length > 0,
				});
		if (!integration?.success) {
			keepWorktree = true;
			return fail(
				integration?.message === "ambiguous_combined_rename_spelling"
					? "ambiguous_combined_rename_spelling"
					: integration?.message === "undeclared_paths_touched"
						? "undeclared_paths_changed"
						: "integration_failed",
				"integrate",
			);
		}
		milestone("integrate", "integration_completed");
		const terminalOutputs = changedFiles.map((path) => {
			const absolute = resolve(options.projectPath, path);
			try {
				const stats = lstatSync(absolute);
				const bytes = stats.isFile() ? readFileSync(absolute) : Buffer.alloc(0);
				return {
					path,
					size: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					mode: stats.mode & 0o777,
				};
			} catch {
				return { path, size: 0, sha256: null, mode: 0 };
			}
		});
		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					state: "running",
					cleanupState: "pending",
					terminalSummary: {
						status: "integration_applied",
						baseRevision,
						changedFiles,
						outputs: terminalOutputs,
					},
				});
			} catch (error) {
				keepWorktree = true;
				return fail(
					"run_store_write_failed",
					"integrate",
					classifyErrorKind("run_store_write_failed", "integrate", error),
					error,
				);
			}
			// Publish the accepted output receipt and cleanup intent before any
			// root removal. A crash here leaves a terminal, recoverable claim.
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					state: "succeeded",
					cleanupState: "pending",
					finishedAt: new Date(now()).toISOString(),
					terminalSummary: {
						status: "succeeded",
						baseRevision,
						changedFiles,
						outputs: terminalOutputs,
						...(terminalProviderReliability
							? { providerReliability: terminalProviderReliability }
							: {}),
					},
					...(candidateChild
						? {
								worktree: {
									canonicalParent,
									candidateChild,
									path: candidatePath,
									state: keepWorktree ? "retained" : "active",
									reason: keepWorktree ? "salvage_retained" : null,
									retainedAt: keepWorktree
										? new Date(now()).toISOString()
										: null,
									writerStopped:
										writerLifecycle === "stopped" ||
										writerLifecycle === "never_started",
									...(worktreeIdentity ?? {}),
								},
							}
						: {}),
				});
			} catch (error) {
				keepWorktree = true;
				return fail(
					"run_store_write_failed",
					"cleanup",
					classifyErrorKind("run_store_write_failed", "cleanup", error),
					error,
				);
			}
		}
		emitStatus(onStatus, taskId, "cleanup");
		currentPhase = "cleanup";
		let cleanupFailure = null;
		let cleanupState = "complete";
		const cleanupBudget = remainingMs(options.deadlineMs, now);
		if (cleanupBudget <= 0) {
			keepWorktree = true;
			cleanupFailure = cleanupMetadata({
				taskId,
				result: "deadline_expired",
				errorKind: "cleanup_failed",
				failurePhase: "cleanup",
			});
			cleanupState = "failed";
		}
		if (projectLocked) {
			try {
				const released = await releaseLock(options.projectPath, runId);
				if (released === true) {
					projectLockState = "released";
					projectLocked = false;
				} else {
					projectLockState = "unavailable";
					if (!cleanupFailure) {
						cleanupFailure = cleanupMetadata({
							taskId,
							result: "project_lock_release_unconfirmed",
							errorKind: "cleanup_failed",
							failurePhase: "cleanup",
						});
						cleanupState = "failed";
					}
				}
			} catch {
				projectLockState = "unavailable";
				if (!cleanupFailure) {
					cleanupFailure = cleanupMetadata({
						taskId,
						result: "project_lock_release_unconfirmed",
						errorKind: "cleanup_failed",
						failurePhase: "cleanup",
					});
					cleanupState = "failed";
				}
			}
		}
		if (!cleanupFailure && remainingMs(options.deadlineMs, now) <= 0) {
			keepWorktree = true;
			cleanupFailure = cleanupMetadata({
				taskId,
				result: "deadline_expired",
				errorKind: "cleanup_failed",
				failurePhase: "cleanup",
			});
			cleanupState = "failed";
		}

		let worktreeTerminalState = "removed";
		let worktreeReason = null;
		let worktreeRetainedAt = null;

		if (keepWorktree) {
			worktreeTerminalState = "retained";
			worktreeReason = cleanupFailure?.result ?? "salvage_retained";
			worktreeRetainedAt = new Date(now()).toISOString();
		} else {
			if (!(await removeNonSalvageWorktree())) {
				keepWorktree = true;
				worktreeTerminalState = "retained";
				worktreeReason = worktreeCleanupReason;
				worktreeRetainedAt = new Date(now()).toISOString();
				if (!cleanupFailure) {
					cleanupFailure = cleanupMetadata({
						taskId,
						result: "worktree_cleanup_failed",
						errorKind: "cleanup_failed",
						failurePhase: "cleanup",
					});
					cleanupState = "failed";
				}
			}
		}

		if (runInitialized) {
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					cleanupState,
					...(cleanupFailure ? { cleanupFailure } : {}),
					finishedAt: new Date(now()).toISOString(),
					terminalSummary: {
						status: "succeeded",
						baseRevision,
						changedFiles,
						outputs: terminalOutputs,
						...(terminalProviderReliability
							? { providerReliability: terminalProviderReliability }
							: {}),
					},
					...(candidateChild
						? {
								worktree: {
									canonicalParent,
									candidateChild,
									path: candidatePath,
									state: worktreeTerminalState,
									reason: worktreeReason,
									retainedAt: worktreeRetainedAt,
									writerStopped:
										writerLifecycle === "stopped" ||
										writerLifecycle === "never_started",
									...(worktreeIdentity ?? {}),
								},
							}
						: {}),
				});
			} catch (error) {
				return fail(
					"run_store_write_failed",
					"cleanup",
					classifyErrorKind("run_store_write_failed", "cleanup", error),
					error,
				);
			}
		}
		milestone(
			"cleanup",
			cleanupFailure ? "cleanup_failed" : "cleanup_completed",
		);

		finalResult = terminalResult(base, {
			status: "succeeded",
			provider,
			targetId,
			changedFiles,
			checks,
			dirtyBaseline,
			providerLifecycle,
			providerVerdictCode,
			outputs: terminalOutputs,
			baseRevision,
			partialWorktree: keepWorktree ? (worktreePath ?? candidatePath) : null,
		});
		if (invocationDescriptor) {
			finalResult.invocationDescriptor = structuredClone(invocationDescriptor);
			finalResult.descriptorIdentity = invocationDescriptor.descriptor_identity;
			finalResult.descriptorHarness = descriptorHarness;
		}
		if (terminalProviderReliability)
			finalResult.providerReliability = terminalProviderReliability;
		milestone("terminal", "succeeded");
		return finalResult;
	} catch (error) {
		if (error?.code === "git_control_tampered")
			return failGitControlTampered(currentPhase);
		if (checkSessions && changedFiles.length > 0) keepWorktree = true;
		const failureReason =
			typeof error?.code === "string" ? error.code : "simple_execution_failed";
		const trustedFault =
			(failureReason === "dirty_overlay_stage_failed" &&
				currentPhase === "prepare") ||
			(["check_group_unconfirmed", "check_session_cleanup_failed"].includes(
				failureReason,
			) &&
				["baseline", "checks"].includes(currentPhase));
		if (signal?.aborted && !trustedFault) return failForSignal(currentPhase);
		return fail(
			failureReason,
			currentPhase,
			classifyErrorKind(failureReason, currentPhase, error),
			error,
		);
	} finally {
		if (pendingDurability.size > 0) {
			await Promise.allSettled([...pendingDurability]);
		}
		try {
			if (failureTerminalDurable) checkSessions?.remove();
		} catch {
			keepWorktree = true;
			writerLifecycle = "unavailable";
			worktreeCleanupReason = "check_session_cleanup_failed";
			if (finalResult) finalResult.partialWorktree = worktreePath;
		}
		if (!failureTerminalDurable && worktreePath) {
			keepWorktree = true;
			if (finalResult?.status === "failed")
				finalResult.partialWorktree = worktreePath;
		}
		if (worktreePath && !keepWorktree) {
			await removeNonSalvageWorktree();
			if (worktreePath && finalResult?.status === "failed") {
				keepWorktree = true;
				finalResult.partialWorktree = worktreePath;
			}
		}
		if (projectLocked) {
			try {
				const released = await releaseLock(options.projectPath, runId);
				if (released === true) {
					projectLockState = "released";
					projectLocked = false;
				} else {
					projectLockState = "unavailable";
				}
			} catch {
				projectLockState = "unavailable";
				// The terminal result stays bounded; existing lock recovery owns repair.
			}
		}
		if (finalResult) {
			finalResult.elapsedMs = Math.max(0, now() - startedAt);
			const worktreeState = finalResult.partialWorktree
				? "retained"
				: !worktreeCreated
					? "not_created"
					: worktreeRoot === null && worktreePath === null
						? "removed"
						: "unavailable";
			finalResult.recovery = createRecoveryEvidence({
				contract: recoveryContract({
					taskId,
					attemptId,
					baseRevision,
					files: options.files,
					...(dirtyBaseline ? { dirtyBaseline } : {}),
					checks: options.checks,
				}),
				result: finalResult,
				partialWorktree: finalResult.partialWorktree,
				cleanup: {
					writer: { state: writerLifecycle },
					worktree: {
						state: worktreeState,
						path: finalResult.partialWorktree,
					},
					projectLock: {
						state:
							projectLockState === "held" ? "unavailable" : projectLockState,
					},
				},
			});
		}
		const failureDisposition = await persistFailureDisposition({
			runInitialized,
			status: finalResult?.status,
			terminalDurable: failureTerminalDurable,
			runId,
			taskId,
			keepWorktree,
			worktreePath,
			cleanupAttempted,
			worktreeCleanupReason,
			failureReason: finalResult?.failureReason,
			canonicalParent,
			candidateChild,
			candidatePath,
			worktreeIdentity,
			writerLifecycle,
			projectLockState,
			now,
			updateRun: dependencies.updateRunWithRetry ?? updateRunWithRetry,
		});
		if (failureDisposition && finalResult) {
			finalResult.cleanupState = failureDisposition.persisted
				? failureDisposition.cleanupState
				: "pending";
		}
	}
}
export { handleSimple } from "./cli.mjs";

import "./args.mjs";
import "./funding.mjs";
import "./provider-invocation.mjs";
import "./recovery.mjs";
import "./overlay.mjs";
import {
	MAX_CAPTURE_BYTES,
	requireGit,
	requireWorktreeGit,
	SECRET_PATHS,
	snapshotGitControl,
	verifyGitControl,
	worktreeGit,
} from "./args.mjs";
import { assertFundedRoute } from "./funding.mjs";
import {
	declaredPathsAreClean,
	dirtyOverlayFailure,
	emitStatus,
	FIRST_CHANGE_PROBE_INTERVAL_MS,
	fileFingerprint,
	makeDirtyBaseline,
} from "./overlay.mjs";
import {
	captureWorktreeDiff,
	classifyExecutionFailure,
	deadlineTimeout,
	defaultExecuteProvider,
	defaultRunCheck,
	remainingMs,
} from "./provider-invocation.mjs";
import {
	aggregateWriterLifecycle,
	createRecoveryEvidence,
	recoveryContract,
	resolvePredecessorReceipt,
	terminalResult,
} from "./recovery.mjs";

export { parseSimpleArgs, SIMPLE_USAGE } from "./args.mjs";
export { simpleRouteFundingFailure, simpleRouteIsFunded } from "./funding.mjs";
export {
	buildSimpleProviderInvocation,
	defaultExecuteProvider,
	parseOpenCodeGoBridgeDiagnostic,
	runSimpleWriter,
	simpleProviderCompatibility,
} from "./provider-invocation.mjs";
export { assessSimpleRecoveryEvidence } from "./recovery.mjs";
