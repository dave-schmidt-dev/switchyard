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
	materializeDirtyOverlay,
	validateDirtyOverlayReceipt,
} from "../lifecycle/index.mjs";
import {
	getConfiguredInvocationDescriptor,
	normalizeProviderName,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { route } from "../router/index.mjs";
import {
	acquireProjectLock,
	createEvent,
	initializeRun,
	isProjectLockOwnedBy,
	releaseProjectLockIfOwnedBy,
	updateRunWithRetry,
} from "../run-store/index.mjs";
import { isSafeDescriptorReceipt } from "../run-store/receipt-validation.mjs";
import { runSimpleBaselineChecks } from "./baseline.mjs";
import { createSimpleRouteHealthController } from "./health.mjs";
import {
	classifySimpleErrorKind,
	createSimpleProviderReliabilityDiagnostic,
} from "./reliability.mjs";
import { buildSimpleRepairPrompt, simpleRepairBudget } from "./repair.mjs";
import { cleanupSimpleWorktree } from "./worktree-cleanup.mjs";
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
	const runCheck = dependencies.runCheck ?? defaultRunCheck;
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
		if (invocationDescriptor) {
			finalResult.invocationDescriptor = structuredClone(invocationDescriptor);
			finalResult.descriptorIdentity = invocationDescriptor.descriptor_identity;
			finalResult.descriptorHarness = descriptorHarness;
		}
		if (runInitialized) {
			failureTerminalDurable = false;
			try {
				const terminalWrite = (
					dependencies.updateRunWithRetry ?? updateRunWithRetry
				)(runId, {
					state: "failed",
					finishedAt: new Date(now()).toISOString(),
					lastFailure: sanitizeFailureMetadata({
						taskId,
						result: "execution_failed",
						errorKind: computedErrorKind,
						failurePhase:
							failurePhase === "execute" ? "provider_execution" : failurePhase,
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
				}).then(
					() => {
						failureTerminalDurable = true;
					},
					() => {},
				);
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
				const status = git(worktreePath, [
					"status",
					"--porcelain=v1",
					"--untracked-files=all",
				]);
				keepWorktree = status.status !== 0 || status.stdout.length > 0;
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
			return fail(
				error?.code ?? "project_lock_failed",
				"preflight",
				classifyErrorKind(
					error?.code ?? "project_lock_failed",
					"preflight",
					error,
				),
				error,
			);
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
		const requestedSimpleTargets = (options.onlyProviders ?? []).length
			? options.onlyProviders
			: SIMPLE_TARGET_ADAPTERS.filter(
					(adapter) =>
						adapter.defaultEligible !== false &&
						(!adapter.defaultCapabilities ||
							adapter.defaultCapabilities.includes(options.capability)),
				).map((adapter) => adapter.targetId);
		const compatibleSimpleTargets = [];
		let pinnedIncompatibility = null;
		for (const candidate of requestedSimpleTargets) {
			const candidateIdentity = resolveIdentity(candidate);
			const candidateTargetId = candidateIdentity.targetId;
			const candidateHarness = candidateIdentity.harnessKey
				? normalizeProviderName(candidateIdentity.harnessKey)
				: null;
			const candidateDescriptor = candidateTargetId
				? descriptorFor(candidateTargetId, options.capability)
				: null;
			const compatibility = simpleProviderCompatibility({
				targetId: candidateTargetId,
				harness: candidateHarness,
				descriptor: candidateDescriptor,
				capability: options.capability,
			});
			if (compatibility.compatible) {
				compatibleSimpleTargets.push(candidateTargetId);
			} else if ((options.onlyProviders ?? []).length) {
				pinnedIncompatibility = compatibility.reason;
			}
		}
		if (
			(options.onlyProviders ?? []).length &&
			compatibleSimpleTargets.length === 0
		) {
			return fail(
				pinnedIncompatibility ?? "local_adapter_unavailable",
				"route",
			);
		}
		const excludedSimpleTargets = new Set();
		const selectSimpleRoute = async () => {
			while (excludedSimpleTargets.size < compatibleSimpleTargets.length) {
				const availableProviders = compatibleSimpleTargets.filter(
					(candidate) => !excludedSimpleTargets.has(candidate),
				);
				const routed = routeProvider({
					requiredCapability: options.capability,
					availableProviders,
					platform: "direct",
					nowMs: now(),
					hasInvocationDescriptor: (name, capability) =>
						Boolean(descriptorFor(name, capability)),
					modelForCapability: (name, capability) =>
						descriptorFor(name, capability)?.selector ?? null,
					healthDecision: healthController.decision,
					only: options.onlyProviders ?? [],
				});
				if (!routed?.provider)
					return {
						error: routed?.reason ?? "no_eligible_provider",
					};
				const candidateProvider = routed.provider;
				const candidateIdentity = resolveIdentity(candidateProvider);
				const candidateTargetId = candidateIdentity.targetId;
				if (!candidateTargetId || !candidateIdentity.harnessKey)
					return { error: "target_identity_unavailable" };
				const candidateDescriptor = descriptorFor(
					candidateProvider,
					options.capability,
				);
				if (
					!candidateDescriptor ||
					candidateDescriptor.target_id !== candidateTargetId
				)
					return { error: "invocation_descriptor_unavailable" };
				const candidateHarness = normalizeProviderName(
					candidateIdentity.harnessKey,
				);
				const compatibility = simpleProviderCompatibility({
					targetId: candidateTargetId,
					harness: candidateHarness,
					descriptor: candidateDescriptor,
					capability: options.capability,
				});
				if (!compatibility.compatible) return { error: compatibility.reason };
				(dependencies.assertFundedRoute ?? assertFundedRoute)(
					candidateTargetId,
				);
				const prepared = await healthController.prepare({
					provider: candidateProvider,
					targetId: candidateTargetId,
					capability: options.capability,
					descriptor: candidateDescriptor,
				});
				if (!prepared.allowed || prepared.reroute) {
					excludedSimpleTargets.add(candidateTargetId);
					continue;
				}
				return {
					provider: candidateProvider,
					targetId: candidateTargetId,
					descriptor: candidateDescriptor,
					harness: candidateHarness,
					compatibility,
					prepared,
				};
			}
			return { error: "route_health_blocked" };
		};
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
			materializeDirtyOverlay(worktreePath, dirtyOverlayReceipt, {
				maxFileBytes: MAX_CAPTURE_BYTES,
				secretPaths: SECRET_PATHS,
			});
			requireGit(
				worktreePath,
				["add", "-A", "--", ...baselinePaths],
				"dirty_overlay_stage_failed",
				{ timeout: deadlineTimeout(options.deadlineMs, now) },
			);
			const overlayDiff = git(worktreePath, ["diff", "--cached", "--quiet"], {
				timeout: deadlineTimeout(options.deadlineMs, now),
			});
			if (overlayDiff.status === 1) {
				requireGit(
					worktreePath,
					[
						"-c",
						"user.name=switchyard",
						"-c",
						"user.email=switchyard@localhost",
						"commit",
						"-qm",
						"switchyard-dirty-overlay",
					],
					"dirty_overlay_baseline_failed",
					{ timeout: deadlineTimeout(options.deadlineMs, now) },
				);
			} else if (overlayDiff.status !== 0) {
				throw Object.assign(new Error("dirty_overlay_baseline_failed"), {
					code: "dirty_overlay_baseline_failed",
				});
			}
			worktreeBaseRevision = requireGit(
				worktreePath,
				["rev-parse", "HEAD"],
				"dirty_overlay_baseline_revision_unavailable",
				{ timeout: deadlineTimeout(options.deadlineMs, now) },
			).trim();
		}

		const baselineResult = await runSimpleBaselineChecks({
			checks: options.baselineChecks ?? [],
			taskId,
			worktreePath,
			deadlineMs: options.deadlineMs,
			now,
			signal,
			runCheck,
			git,
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

		const readOnlyNotice = (options.readOnlyInputs ?? []).length
			? ` Read-only input paths (do not modify): ${(options.readOnlyInputs ?? []).join(", ")}.`
			: "";
		const guardedPrompt = `${readFileSync(options.promptPath, "utf8")}\n\nWork only in the current disposable checkout. Change only these writable files: ${options.files.join(", ")}.${readOnlyNotice} Do not delegate, plan recursively, commit, push, access credentials, or change any other path.`;
		currentPhase = "execute";
		milestone("execute", "provider_started");
		const executionBudget = remainingMs(options.deadlineMs, now);
		if (executionBudget <= 0) {
			return fail("deadline_expired", "execute");
		}
		if (signal?.aborted) return failForSignal("execute");
		let providerHealthStart = await healthController.start();
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
			providerHealthStart = await healthController.start();
		}
		if (!providerHealthStart.allowed)
			return fail("route_health_blocked", "route");
		const providerHealthTracked = providerHealthStart.tracked === true;
		writerLifecycle = "unavailable";
		const providerResult = await executeProvider({
			targetId,
			harness,
			descriptor,
			capability: options.capability,
			prompt: guardedPrompt,
			worktreePath,
			timeoutMs: executionBudget,
			signal,
			onProgress: () => {
				const progressObservedAt = now();
				if (
					!firstChangeObserved &&
					progressObservedAt - lastFirstChangeProbeAt >=
						FIRST_CHANGE_PROBE_INTERVAL_MS
				) {
					lastFirstChangeProbeAt = progressObservedAt;
					const observed = git(worktreePath, [
						"status",
						"--porcelain=v1",
						"--untracked-files=all",
						"--",
						...options.files,
					]);
					if (observed.status === 0 && observed.stdout.length > 0) {
						firstChangeObserved = true;
						milestone("execute", "first_change_observed");
						return;
					}
				}
				heartbeat("execute", { processPhase: "provider_running" });
			},
		});
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

		if (signal?.aborted) return failForSignal("execute");
		if (
			executeProvider === defaultExecuteProvider &&
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
				if (runCheck === defaultRunCheck && writerLifecycle === "unavailable") {
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
				const checkFailureReason = check?.silenceTimedOut
					? "check_silence_timeout"
					: check?.timedOut
						? "check_deadline_exceeded"
						: "check_failed";
				if (!options.repairChecks || pass > 0) {
					if (pass > 0) {
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

				// A failing check can itself change the checkout. Re-capture and validate
				// the exact base and declared scope before any correction is allowed.
				capturedDiff = captureWorktreeDiff(
					worktreePath,
					worktreeBaseRevision,
					options.deadlineMs,
					now,
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
				const repairHealthStart = await healthController.start();
				if (!repairHealthStart.allowed) {
					repairStatus = "ineligible";
					keepWorktree = true;
					return fail(checkFailureReason, "checks");
				}
				writerLifecycle = "unavailable";
				const correction = await executeProvider({
					targetId,
					harness,
					descriptor,
					capability: options.capability,
					prompt: repairPrompt,
					worktreePath,
					timeoutMs: budget.providerTimeoutMs,
					signal,
					onProgress: () =>
						heartbeat("repair", { processPhase: "provider_running" }),
				});
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
		const cleanupMetadata = (input) => ({
			...sanitizeFailureMetadata(input),
			result: input.result,
		});
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
		const failureReason =
			typeof error?.code === "string" ? error.code : "simple_execution_failed";
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
		if (
			runInitialized &&
			candidateChild &&
			finalResult?.status !== "succeeded"
		) {
			const isRetained = Boolean(keepWorktree || worktreePath);
			const cleanupFailed = cleanupAttempted && isRetained;
			const terminalState = isRetained ? "retained" : "removed";
			const reason = isRetained
				? (worktreeCleanupReason ??
					finalResult?.failureReason ??
					"salvage_retained")
				: null;
			const retainedAt = isRetained ? new Date(now()).toISOString() : null;
			try {
				await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
					cleanupState: cleanupFailed
						? "failed"
						: isRetained
							? "pending"
							: "complete",
					...(cleanupFailed
						? {
								cleanupFailure: cleanupMetadata({
									taskId,
									result: "worktree_cleanup_failed",
									errorKind: "cleanup_failed",
									failurePhase: "cleanup",
								}),
							}
						: {}),
					worktree: {
						canonicalParent,
						candidateChild,
						path: candidatePath,
						state: terminalState,
						reason,
						retainedAt,
						writerStopped:
							writerLifecycle === "stopped" ||
							writerLifecycle === "never_started",
						...(worktreeIdentity ?? {}),
					},
				});
			} catch {}
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
	git,
	MAX_CAPTURE_BYTES,
	requireGit,
	SECRET_PATHS,
	SIMPLE_TARGET_ADAPTERS,
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
	simpleProviderCompatibility,
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
