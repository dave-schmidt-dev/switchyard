import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	PERSISTED_SIGNALS,
	sanitizeFailureDetails,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { projectRunFailureForDisk } from "../adapter/exec-error-sanitize.mjs";
import { boundProviderLifecycleSnapshot } from "../adapter/provider-lifecycle.mjs";
import { resolveFailure } from "../diagnostics/failure-registry.mjs";
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
import { dryRunAcceptanceChecks } from "./check-dry-run.mjs";
import { classifyFailedCheck } from "./check-environment.mjs";
import { createSimpleCheckSessions } from "./check-session.mjs";
import {
	boundedRejectionPaths,
	captureDeadlineChangedFiles,
	declaredFileStat,
	declaredFilesChanged,
	validateDiffRejectionRule,
} from "./declared-diff.mjs";
import { deriveFailureAccountability } from "./failure-accountability.mjs";
import {
	persistFailureDisposition,
	publishFailedTerminal,
} from "./failure-finalization.mjs";
import { buildGuardedPrompt } from "./guarded-prompt.mjs";
import { headAdvanceSafe } from "./head-advance.mjs";
import { createSimpleRouteHealthController } from "./health.mjs";
import { prepareSimpleProviderStart } from "./launcher-preflight.mjs";
import { simpleLockDisposition } from "./lock-disposition.mjs";
import { seedContinuation } from "./partial-continuation.mjs";
import {
	classifySimpleErrorKind,
	createSimpleProviderReliabilityDiagnostic,
} from "./reliability.mjs";
import { buildSimpleRepairPrompt, simpleRepairBudget } from "./repair.mjs";
import { routeDiagnosticPatch } from "./route-evidence.mjs";
import { createSimpleRouteSelection } from "./route-selection.mjs";
import { allocateSimpleRoot, removeInjectedTestRoot } from "./simple-root.mjs";
import { cleanupSimpleWorktree } from "./worktree-cleanup.mjs";

const HEARTBEAT_PERSIST_INTERVAL_MS = 30_000;
const SIMPLE_PROCESS_PHASES = new Set([
	"check_preparing",
	"dry_run_check",
	"launcher_probe",
	"provider_running",
	"format_running",
	"check_running",
	"head_advance_recheck_preparing",
	"head_advance_recheck_running",
	"cleanup_scan_running",
	"cleanup_helper_progress",
	"cleanup_scan_started",
	"cleanup_quarantine_started",
	"cleanup_remove_started",
]);
// Check-session refusals that already carry their own closed cause code; every
// other failure while preparing the session classifies as check_setup_failed.
const OWN_CODED_CHECK_SETUP_REASONS = new Set([
	"check_dependencies_unverified",
	"check_venv_outside_project",
]);

export async function runSimpleTask(options, dependencies = {}) {
	const origin = options.origin ?? "work";
	if (origin !== "work" && origin !== "qualification") {
		throw new TypeError("origin must be work or qualification");
	}
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
	const reportMode = options.reportMode === true;
	const reportPath = reportMode ? (options.files?.[0] ?? null) : null;
	let provider = null;
	let targetId = null;
	let invocationDescriptor = null;
	let descriptorHarness = null;
	let providerExecutionResult = null;
	let providerStarted = false;
	let activeTaskProcessPhase = null;
	let baselineStatus = (options.baselineChecks ?? []).length
		? "pending"
		: "not_requested";
	let failingCheckIndex = null;
	let failingCheckIdentity = null;
	let failureExitCode = null;
	let failureSignal = null;
	let failureTimedOut = null;
	let failingCheckEnvironmentSignature = null;
	let failingCheckOutputPath = null;
	let failingCheckExecutable = null;
	let failingCheckHostExecutable = null;
	let repairCount = 0;
	let repairStatus = options.repairChecks ? "not_started" : "not_requested";
	let formatStatus = options.format ? "not_run" : "not_requested";
	let terminalProviderReliability = null;
	let projectLocked = false;
	let canonicalParent = null;
	let candidateChild = null;
	let candidatePath = null;
	let worktreeRoot = null;
	let worktreePath = null;
	let keepWorktree = false;
	let changedFiles = [];
	let changedFilesUnavailable = false;
	let reportOutput = null;
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
	let lastHeartbeatPersistedAt = Number.NEGATIVE_INFINITY;
	let runTerminalReached = false;
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
	let checkSetupInFlight = false;
	let checkSetupReason = null;
	const routeProvider = dependencies.route ?? route;
	const healthController = (
		dependencies.createSimpleRouteHealthController ??
		createSimpleRouteHealthController
	)({
		healthDecision: dependencies.healthDecision,
		healthMode: dependencies.healthMode,
		healthStateRoot: dependencies.healthStateRoot,
		qualifiedProviders: dependencies.qualifiedProviders,
		origin,
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

	// Task 3.11: hand each capture taken under verified git control to the
	// routing waterfall in memory; it is never persisted.
	const captureVerifiedDiff = (path, base, ...rest) => {
		const captured = captureWorktreeDiff(path, base, ...rest);
		dependencies.onVerifiedDiff?.({ ...captured, baseRevision: base });
		return captured;
	};
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
		if (
			providerStarted &&
			typeof details.processPhase === "string" &&
			SIMPLE_PROCESS_PHASES.has(details.processPhase)
		) {
			activeTaskProcessPhase = details.processPhase;
		}
		emitStatus(onStatus, taskId, phase, {
			elapsedMs: Math.max(0, observedAt - startedAt),
			elapsedSinceLastMilestoneMs: Math.max(0, observedAt - lastMilestoneAt),
			firstChangeObserved,
			...details,
		});
		// Durable liveness only, and only while a provider run is actually live.
		// Nothing derived (elapsed, progress) is persisted: the record carries the
		// timestamp this process observed, no more.
		if (!runInitialized || !providerStarted || runTerminalReached) return;
		if (observedAt - lastHeartbeatPersistedAt < HEARTBEAT_PERSIST_INTERVAL_MS)
			return;
		lastHeartbeatPersistedAt = observedAt;
		const heartbeatPatch = { activeTaskHeartbeatAt: observedAt };
		if (activeTaskProcessPhase !== null) {
			heartbeatPatch.activeTaskProcessPhase = activeTaskProcessPhase;
		}
		const heartbeatWrite = (
			dependencies.updateRunWithRetry ?? updateRunWithRetry
		)(runId, heartbeatPatch).catch(() => {});
		pendingDurability.add(heartbeatWrite);
		void heartbeatWrite.finally(() => pendingDurability.delete(heartbeatWrite));
	};
	const persistProviderStarted = async () => {
		if (!runInitialized) return null;
		const observedAt = now();
		const activeDescriptorReceipt =
			invocationDescriptor &&
			isSafeDescriptorReceipt(invocationDescriptor, descriptorHarness) &&
			invocationDescriptor.target_id === targetId
				? invocationDescriptor
				: null;
		try {
			await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
				state: "running",
				startedAt: new Date(observedAt).toISOString(),
				activeTaskId: taskId,
				activeTaskProvider: provider,
				activeTaskModel: invocationDescriptor?.selector ?? null,
				activeTaskDeadline:
					typeof options.deadlineMs === "number" &&
					Number.isFinite(options.deadlineMs)
						? new Date(options.deadlineMs).toISOString()
						: null,
				activeTaskStartedAt: observedAt,
				activeTaskProcessPhase,
				activeTaskInvocationDescriptor: activeDescriptorReceipt,
				activeTaskDescriptorIdentity:
					activeDescriptorReceipt?.descriptor_identity ?? null,
				activeTaskDescriptorHarness:
					activeDescriptorReceipt === null ? null : descriptorHarness,
			});
			return null;
		} catch (error) {
			return error;
		}
	};
	const releaseHeldProjectLock = async () => {
		if (!projectLocked) return;
		try {
			const released = await releaseLock(options.projectPath, runId);
			projectLockState = released === true ? "released" : "unavailable";
			if (released === true) projectLocked = false;
		} catch {
			projectLockState = "unavailable";
			// The terminal result stays bounded; existing lock recovery owns repair.
		}
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
				removeInjectedTestRoot(worktreeRoot, canonicalParent, dependencies);
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
		diffRejection = null,
	) => {
		runTerminalReached = true;
		const dependencyCheck =
			typeof error?.dependencyCheck === "string" ? error.dependencyCheck : null;
		// Task 2.7: a candidate diff that changed the dependency manifest is a
		// check fact, not an environment fault; the record keeps the thrown
		// refusal reason and classifies under the closed manifest cause.
		const manifestChangedByDiff =
			failureReason === "check_dependencies_unverified" &&
			dependencyCheck === "manifest_changed_by_diff";
		// A check-setup failure keeps the thrown reason in the record and
		// classifies under the closed setup cause.
		const classifiedReason =
			checkSetupReason ??
			(manifestChangedByDiff
				? "check_manifest_changed_by_diff"
				: failureReason);
		const computedErrorKind = manifestChangedByDiff
			? "check_failed"
			: (errorKind ?? classifyErrorKind(classifiedReason, failurePhase, error));
		// Task 2.8: a check-setup refusal keeps the closed prepare step the
		// session tagged and, when the step threw a system error, its bounded
		// code, syscall name and executable basename. Message text never travels.
		const setupErrorCode = typeof error?.code === "string" ? error.code : null;
		const setupSyscall =
			typeof error?.syscall === "string"
				? error.syscall.trim().split(/\s+/u)[0] || null
				: null;
		const setupExecutable =
			typeof error?.checkSetupExecutable === "string"
				? basename(error.checkSetupExecutable)
				: typeof error?.path === "string"
					? basename(error.path)
					: null;
		const setupStep =
			typeof error?.checkSetupStep === "string" ? error.checkSetupStep : null;
		// The registry row's detail fields decide what this failure persists in
		// run.json, so a detail registered later reaches the record without
		// editing this call site or the sanitizer boundary.
		const resolution = resolveFailure({
			reason: classifiedReason,
			phase: failurePhase,
			errorKind: computedErrorKind,
			providerResult: providerExecutionResult,
			// resolveFailure ORs this with the provider result's own timedOut.
			timedOut: failureTimedOut === true,
			checkExecutable: failingCheckExecutable,
			hostExecutable: failingCheckHostExecutable,
		});
		const timedOut =
			resolution.timedOut === true
				? true
				: (failureTimedOut ?? providerExecutionResult?.timedOut ?? null);
		const diffRejectionCount = Array.isArray(diffRejection?.paths)
			? diffRejection.paths.length
			: 0;
		if (diffRejection) {
			diffRejection = {
				rule: diffRejection.rule,
				paths: boundedRejectionPaths(diffRejection.paths),
			};
		}
		const detailValues = {
			failureReason,
			timedOut,
			cancelled: providerExecutionResult?.cancelled ?? null,
			cancelSource: resolution.cancelSource,
			providerSignature: providerExecutionResult?.providerSignature,
			stderrBytes: providerExecutionResult?.stderrBytes,
			stdoutBytes: providerExecutionResult?.stdoutBytes,
			checkIndex: failingCheckIndex ?? error?.checkIndex ?? null,
			checkIdentity: failingCheckIdentity,
			checkEnvironmentSignature: failingCheckEnvironmentSignature,
			outputPath: ["baseline", "checks"].includes(failurePhase)
				? failingCheckOutputPath
				: (providerExecutionResult?.outputPath ?? null),
			dependencyCheck,
			manifestName:
				typeof error?.manifestName === "string" ? error.manifestName : null,
			checkSetupStep: setupStep,
			checkSetupErrorCode: setupErrorCode,
			checkSetupSyscall: setupSyscall,
			checkSetupExecutable: setupExecutable,
			checkExecutable: failingCheckExecutable,
			hostExecutable: failingCheckHostExecutable,
			changedFilesUnavailable:
				changedFilesUnavailable === true ? true : undefined,
			diffRejectionCategory: resolution.diffCategory,
			diffRejectionCount,
			diffRejectionRule: diffRejection?.rule,
			diffRejectionPaths: diffRejection?.paths,
		};
		const failureDetails = {};
		for (const field of resolution.detailFields) {
			const value = detailValues[field];
			if (value !== undefined && value !== null) failureDetails[field] = value;
		}
		const sanitizedFailureDetails = sanitizeFailureDetails(failureDetails);
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
			failureReason: classifiedReason,
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
			diffRejectionCount,
			repairCount,
			repairStatus,
		});
		// The run store persists `failureDetails` through
		// projectRunFailureForDisk, so the terminal result carries that same
		// projected record: a caller never needs to read run.json, and the two
		// views always agree.
		const persistentFailureDetails =
			projectRunFailureForDisk({
				lastFailure: { providerReliability },
				failureDetails: sanitizedFailureDetails,
			}).failureDetails ?? null;
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
		if (reportMode) finalResult.resultKind = "report";
		finalResult.origin = origin;
		finalResult.providerReliability = providerReliability;
		finalResult.failureDetails = persistentFailureDetails;
		finalResult.providerStarted = providerStarted;
		finalResult.formatStatus = formatStatus;
		if (diffRejection) finalResult.diffRejection = diffRejection;
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
							// Task 2.8: the dry run's two resolved paths join the
							// failure message only when both are a bounded pair.
							...(failingCheckExecutable && failingCheckHostExecutable
								? {
										checkExecutable: failingCheckExecutable,
										hostExecutable: failingCheckHostExecutable,
									}
								: {}),
						}),
						failureDetails: persistentFailureDetails,
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
	const failGitControlTampered = (failurePhase, error) => {
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
		// Only the closed-enum tamper fields cross into the result; the raw
		// message and provider-controlled path stay diagnostics.
		const tamperKind = error?.tamperKind;
		const tamperArea = error?.tamperArea;
		if (typeof tamperKind === "string" && typeof tamperArea === "string")
			result.gitControlTamper = { kind: tamperKind, area: tamperArea };
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
						return failGitControlTampered(failurePhase, error);
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
			await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(runId, {
				origin,
			});
		} catch (error) {
			return fail(
				"run_store_write_failed",
				"preflight",
				classifyErrorKind("run_store_write_failed", "preflight", error),
				error,
			);
		}
		if (signal?.aborted) return failForSignal("preflight");

		const unreviewedManifests = manifestReviewPaths(options.files).filter(
			(path) => !(options.allowManifests ?? []).includes(path),
		);
		if (unreviewedManifests.length > 0) {
			return fail(
				"manifest_review_required",
				"input_validation",
				"validation_failed",
				null,
				{
					rule: "manifest_review_required",
					paths: unreviewedManifests,
				},
			);
		}
		if (remainingMs(options.deadlineMs, now) <= 0) {
			return fail("deadline_expired", "preflight");
		}
		emitStatus(onStatus, taskId, "lock");
		try {
			await acquireLock(options.projectPath, runId, {
				onEvent: ({ event, reclaimedRunId }) =>
					milestone("preflight", event, { reclaimedRunId }),
			});
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
		// Declared files plus any eligible undeclared edits kept for captain
		// review. Check sessions read this array at prepare time.
		const scopeFiles = [...options.files];
		let undeclaredKept = [];
		let undeclaredPatch = "";
		// `keptOnly` refuses any undeclared path not already kept from the
		// provider's own diff: a failing check must not widen the scope.
		const undeclaredGate = (diff, keptOnly = false) => {
			const scope = evaluateUndeclaredScope({
				changedFiles,
				files: options.files,
				diff,
				projectPath: options.projectPath,
				readOnlyInputs: options.readOnlyInputs ?? [],
				baseRevision,
				enabled: !reportMode,
			});
			if (
				scope.ok &&
				keptOnly &&
				scope.eligible.some((path) => !undeclaredKept.includes(path))
			)
				return { ...scope, ok: false, rule: "undeclared_paths_changed" };
			if (scope.ok) {
				scopeFiles.splice(0, scopeFiles.length, ...options.files);
				scopeFiles.push(...scope.eligible);
				undeclaredKept = scope.eligible;
				undeclaredPatch = scope.patch;
			}
			return scope;
		};

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
		({ canonicalParent, candidateChild, candidatePath } =
			allocateSimpleRoot(dependencies));

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
				files: scopeFiles,
				allowManifests: options.allowManifests,
				commands: [
					...options.checks,
					...(options.baselineChecks ?? []),
					...(options.format ? [options.format] : []),
				],
				taskId,
				deadlineMs: options.deadlineMs,
				cachePath: dependencies.checkCachePath,
				evidenceDir: join(getRunRoot(runId), "check-evidence"),
				now,
				signal,
				onProgress: () =>
					heartbeat("baseline", { processPhase: "check_preparing" }),
			});
			// No baseline check has run yet, so a setup failure stays in "prepare".
			checkSetupInFlight = true;
			baselineCheckPath = await checkSessions.prepare(null, 0);
			checkSetupInFlight = false;
			currentPhase = "baseline";
			runCheck = checkSessions.run;
		}

		const baselineResult = await runSimpleBaselineChecks({
			checks: options.baselineChecks ?? [],
			taskId,
			worktreePath: baselineCheckPath,
			deadlineMs: options.deadlineMs,
			now,
			signal,
			runCheck: async (request) => {
				const result = await runCheck(request);
				if (
					checkSessions &&
					result?.success !== true &&
					typeof result?.outputPath === "string"
				) {
					failingCheckOutputPath = result.outputPath;
				}
				return result;
			},
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
		// Task 2.4: with a clean (or absent) baseline, run the acceptance checks
		// once on the base tree so an environment that cannot run them fails here,
		// before a provider starts. The session is removed on every path after it.
		const dryRun =
			checkSessions &&
			options.checks.length > 0 &&
			["passed", "not_requested"].includes(baselineStatus)
				? await dryRunAcceptanceChecks({
						checks: options.checks,
						runCheck,
						resolveCheckExecutables: checkSessions.resolveCheckExecutables,
						deadlineMs: options.deadlineMs,
						now,
						signal,
						capMs: dependencies.dryRunCheckCapMs,
						onProgress: ({ event, ...details }) =>
							event.endsWith("_progress")
								? heartbeat("baseline", { processPhase: "dry_run_check" })
								: milestone("baseline", event, details),
					})
				: null;
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
		if (dryRun) {
			writerLifecycle = aggregateWriterLifecycle(
				writerLifecycle,
				dryRun.writerLifecycle,
			);
			// Phase "checks": the baseline phase would classify a cancel as
			// baseline_check_failed, though the baseline passed.
			if (dryRun.status === "cancelled") return failForSignal("checks");
			if (dryRun.status === "environment_failed") {
				failingCheckIndex = dryRun.checkIndex;
				failingCheckIdentity = dryRun.checkIdentity;
				failingCheckEnvironmentSignature = dryRun.signature;
				failingCheckOutputPath = dryRun.outputPath;
				failingCheckExecutable =
					typeof dryRun.checkExecutable === "string"
						? dryRun.checkExecutable
						: null;
				failingCheckHostExecutable =
					typeof dryRun.hostExecutable === "string"
						? dryRun.hostExecutable
						: null;
				failureExitCode = dryRun.exitCode;
				failureSignal = dryRun.signal;
				return fail(
					"check_environment_failed",
					"baseline",
					"environment_failure",
				);
			}
		}

		// Task 3.11: seed a planned continuation after the base was judged and
		// before the provider starts; the index changed, so re-snapshot.
		const continuation = dependencies.continuation
			? seedContinuation({
					plan: dependencies.continuation,
					worktreePath,
					baseRevision,
					worktreeBaseRevision,
					gitControl: worktreeGitControl,
					timeout: deadlineTimeout(options.deadlineMs, now),
				})
			: null;
		if (continuation?.carried)
			worktreeGitControl = snapshotGitControl(worktreePath);
		if (continuation) dependencies.onContinuation?.(continuation);
		const guardedPrompt = buildGuardedPrompt({
			promptText: readFileSync(options.promptPath, "utf8"),
			files: options.files,
			readOnlyInputs: options.readOnlyInputs ?? [],
			checks: options.checks ?? [],
			carriedFiles: continuation?.carried ? continuation.files : [],
			reportMode,
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
		let providerStartedWriteFailure = null;
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
				runId,
				targetId,
				harness,
				descriptor,
				capability: options.capability,
				prompt: guardedPrompt,
				worktreePath,
				timeoutMs: executionBudget,
				deadlineMs: options.deadlineMs,
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
			// Await both together so a provider rejection during the run-store
			// write is always handled.
			const startedWrite = persistProviderStarted();
			pendingDurability.add(startedWrite);
			void startedWrite.finally(() => pendingDurability.delete(startedWrite));
			[providerStartedWriteFailure, providerResult] = await Promise.all([
				startedWrite,
				execution,
			]);
		} finally {
			requestLogStatus = requestRecorder?.close();
		}
		if (providerStartedWriteFailure)
			return fail(
				"run_store_write_failed",
				"execute",
				classifyErrorKind(
					"run_store_write_failed",
					"execute",
					providerStartedWriteFailure,
				),
				providerStartedWriteFailure,
			);
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
		// A failed provider is classified by its own result below; the ledger
		// error only fails an attempt the provider reported as successful.
		if (providerResult?.success && requestLogStatus?.error)
			return fail(requestLogStatus.error, "execute");

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
				const captured = captureVerifiedDiff(
					worktreePath,
					worktreeBaseRevision,
					options.deadlineMs,
					now,
					worktreeGitControl,
					reportPath,
				);
				changedFiles = captured.changedFiles;
				executionFailureCaptureComplete = true;
				keepWorktree = changedFiles.length > 0;
			} else {
				keepWorktree = true;
				const deadlineCapture = captureDeadlineChangedFiles({
					worktreePath,
					worktreeBaseRevision,
					worktreeGitControl,
					writerLifecycle,
				});
				changedFiles = deadlineCapture.files;
				changedFilesUnavailable = deadlineCapture.available !== true;
			}
			return fail(classifyExecutionFailure(providerResult), "execute");
		}
		if (remainingMs(options.deadlineMs, now) <= 0) {
			keepWorktree = true;
			const deadlineCapture = captureDeadlineChangedFiles({
				worktreePath,
				worktreeBaseRevision,
				worktreeGitControl,
				writerLifecycle,
			});
			changedFiles = deadlineCapture.files;
			changedFilesUnavailable = deadlineCapture.available !== true;
			return fail("deadline_expired", "checks");
		}
		currentPhase = "diff";
		milestone("diff", "capture_started");
		const captured = captureVerifiedDiff(
			worktreePath,
			worktreeBaseRevision,
			options.deadlineMs,
			now,
			worktreeGitControl,
			reportPath,
		);
		changedFiles = captured.changedFiles;
		if (changedFiles.length > 0 && !firstChangeObserved) {
			firstChangeObserved = true;
			milestone("diff", "first_change_observed");
		}
		if (reportMode) {
			if (!changedFiles.includes(reportPath))
				return fail("report_missing", "diff");
		} else if (changedFiles.length === 0) {
			return fail("empty_diff", "diff");
		}
		const undeclaredScope = undeclaredGate(captured.diff);
		if (!undeclaredScope.ok) {
			keepWorktree = true;
			return fail(undeclaredScope.rule, "diff", null, null, {
				rule: undeclaredScope.rule,
				paths: undeclaredScope.undeclared,
			});
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
				null,
				null,
				validated.requiresReview
					? {
							rule: "manifest_review_required",
							paths: validated.sensitivePaths,
						}
					: { rule: validateDiffRejectionRule(validated), paths: [] },
			);
		}
		if (reportMode) {
			let reportBytes;
			try {
				reportBytes = readFileSync(join(worktreePath, reportPath));
			} catch {
				return fail("report_missing", "diff");
			}
			if (reportBytes.length === 0) return fail("report_missing", "diff");
			reportOutput = {
				path: reportPath,
				bytes: reportBytes.length,
				sha256: createHash("sha256").update(reportBytes).digest("hex"),
			};
		}

		let capturedDiff = captured;
		for (let pass = 0; pass < 2; pass += 1) {
			if (checkSessions) {
				if (writerLifecycle !== "stopped")
					return fail("provider_group_unconfirmed", "checks", "cleanup_failed");
				if (options.checks.length > 0) {
					currentPhase = "checks";
					await checkSessions.prepare(capturedDiff.diff, pass + 1);
					if (options.format) {
						const formatResult = await checkSessions.format({
							command: options.format,
							timeoutMs: remainingMs(options.deadlineMs, now),
							onProgress: () =>
								heartbeat("checks", { processPhase: "format_running" }),
						});
						writerLifecycle = aggregateWriterLifecycle(
							writerLifecycle,
							formatResult?.writerLifecycle,
						);
						// A nonzero format exit is advisory: the acceptance checks,
						// not the formatter's status, decide the candidate.
						formatStatus = formatResult?.success === true ? "passed" : "failed";
						if (signal?.aborted) return failForSignal("checks");
						if (!dependencies.runCheck && writerLifecycle === "unavailable") {
							keepWorktree = true;
							return fail(
								"check_group_unconfirmed",
								"checks",
								"cleanup_failed",
							);
						}
						// Replace the provider worktree's changes with the checker
						// clone's formatted base-relative diff, then re-apply the
						// same scope and safety gates the candidate already faced.
						verifyGitControl(worktreePath, worktreeGitControl);
						requireWorktreeGit(
							worktreePath,
							["checkout", "-f", "HEAD"],
							"integration_failed",
							{ timeout: deadlineTimeout(options.deadlineMs, now) },
						);
						if (formatResult.diff.trim() !== "")
							requireWorktreeGit(
								worktreePath,
								["apply", "--binary", "--whitespace=nowarn", "-"],
								"integration_failed",
								{
									input: formatResult.diff,
									timeout: deadlineTimeout(options.deadlineMs, now),
								},
							);
						capturedDiff = captureWorktreeDiff(
							worktreePath,
							worktreeBaseRevision,
							options.deadlineMs,
							now,
							worktreeGitControl,
						);
						changedFiles = capturedDiff.changedFiles;
						if (changedFiles.length === 0) return fail("empty_diff", "diff");
						const formattedScope = undeclaredGate(capturedDiff.diff, true);
						if (!formattedScope.ok) {
							keepWorktree = true;
							return fail(formattedScope.rule, "diff", null, null, {
								rule: formattedScope.rule,
								paths: formattedScope.undeclared,
							});
						}
						const formattedValidation = validateDiff(
							capturedDiff.diff,
							options.projectPath,
						);
						if (
							!formattedValidation.safe ||
							(formattedValidation.requiresReview &&
								!(formattedValidation.sensitivePaths ?? []).every((path) =>
									(options.allowManifests ?? []).includes(path),
								))
						) {
							keepWorktree = true;
							return fail(
								formattedValidation.requiresReview
									? "manifest_review_required"
									: "unsafe_diff",
								"diff",
								null,
								null,
								formattedValidation.requiresReview
									? {
											rule: "manifest_review_required",
											paths: formattedValidation.sensitivePaths,
										}
									: {
											rule: validateDiffRejectionRule(formattedValidation),
											paths: [],
										},
							);
						}
					}
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
						? {
								exitCode: checkExitCode,
								signal: checkSignal,
								...(check?.outputPath ? { outputPath: check.outputPath } : {}),
							}
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
					failingCheckOutputPath = null;
					continue;
				}

				failingCheckIndex = index + 1;
				failingCheckIdentity = checkIdentity;
				failingCheckOutputPath =
					typeof check?.outputPath === "string" ? check.outputPath : null;
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
				// Task 2.4: a check that cannot run here is the environment's fault, not
				// a regression, so it never reaches repair or the next provider.
				const environmentSignature = classifyFailedCheck(check, {
					preProvider: false,
				});
				if (environmentSignature) {
					keepWorktree = true;
					repairStatus = options.repairChecks ? "ineligible" : "not_requested";
					failingCheckEnvironmentSignature = environmentSignature;
					return fail(
						"check_environment_failed",
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
				capturedDiff = captureVerifiedDiff(
					worktreePath,
					worktreeBaseRevision,
					options.deadlineMs,
					now,
					worktreeGitControl,
					reportPath,
				);
				changedFiles = capturedDiff.changedFiles;
				const repairScope = undeclaredGate(capturedDiff.diff, true);
				if (!repairScope.ok) {
					keepWorktree = true;
					repairStatus = "ineligible";
					return fail(repairScope.rule, "diff", null, null, {
						rule: repairScope.rule,
						paths: repairScope.undeclared,
					});
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
					const repairRejection = repairDiffValidation.requiresReview
						? {
								rule: "manifest_review_required",
								paths: repairDiffValidation.sensitivePaths,
							}
						: {
								rule: validateDiffRejectionRule(repairDiffValidation),
								paths: [],
							};
					return fail(
						repairDiffValidation.requiresReview
							? "manifest_review_required"
							: "unsafe_diff",
						"diff",
						null,
						null,
						repairRejection,
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
					origin,
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
						runId,
						targetId,
						harness,
						descriptor,
						capability: options.capability,
						prompt: repairPrompt,
						worktreePath,
						timeoutMs: correctionBudget,
						deadlineMs: options.deadlineMs,
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
				if (correction?.success && correctionLogStatus?.error)
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

				capturedDiff = captureVerifiedDiff(
					worktreePath,
					worktreeBaseRevision,
					options.deadlineMs,
					now,
					worktreeGitControl,
					reportPath,
				);
				changedFiles = capturedDiff.changedFiles;
				const correctedScope = undeclaredGate(capturedDiff.diff);
				if (!correctedScope.ok) {
					keepWorktree = true;
					repairStatus = "ineligible";
					return fail(correctedScope.rule, "diff", null, null, {
						rule: correctedScope.rule,
						paths: correctedScope.undeclared,
					});
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
						null,
						null,
						correctedValidation.requiresReview
							? {
									rule: "manifest_review_required",
									paths: correctedValidation.sensitivePaths,
								}
							: {
									rule: validateDiffRejectionRule(correctedValidation),
									paths: [],
								},
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
		const currentHead = requireGit(
			options.projectPath,
			["rev-parse", "HEAD"],
			"project_revision_unavailable",
			{ timeout: deadlineTimeout(options.deadlineMs, now) },
		).trim();
		let headAdvanced = false;
		if (currentHead !== baseRevision) {
			const protectedPaths = [...scopeFiles, ...(options.readOnlyInputs ?? [])];
			if (
				!headAdvanceSafe({
					projectPath: options.projectPath,
					base: baseRevision,
					head: currentHead,
					paths: protectedPaths,
				})
			) {
				keepWorktree = true;
				return fail("host_concurrency", "integrate");
			}
			// Peer history may only be unrelated. A manifest, lockfile or other
			// execution input changing under the run can change what the
			// acceptance checks mean, so any peer change there refuses.
			const peerDiff = requireGit(
				options.projectPath,
				["diff", "--binary", "--full-index", baseRevision, currentHead],
				"project_revision_unavailable",
				{
					maxBuffer: MAX_CAPTURE_BYTES,
					timeout: deadlineTimeout(options.deadlineMs, now),
				},
			);
			if (peerDiff.trim()) {
				const peerValidation = validateDiff(peerDiff, options.projectPath);
				if (!peerValidation.safe || peerValidation.requiresReview) {
					keepWorktree = true;
					return fail("host_concurrency", "integrate");
				}
			}
			headAdvanced = true;
		}
		if (dirtyOverlayReceipt) {
			const checked = validateDirtyOverlayReceipt(
				options.projectPath,
				dirtyOverlayReceipt,
				baselinePaths,
				{
					allowUnrelated: true,
					allowHeadAdvance: true,
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
		if (
			undeclaredKept.length > 0 &&
			!declaredPathsAreClean(options.projectPath, undeclaredKept)
		) {
			keepWorktree = true;
			return fail("declared_path_changed_concurrently", "integrate");
		}
		// The provider's checks ran against the original base. When unrelated
		// peer commits moved HEAD, verify the same patch still passes the same
		// acceptance checks at the advanced HEAD before any host mutation.
		if (headAdvanced && options.checks.length > 0) {
			const headAdvanceSession = checkSessions
				? createSimpleCheckSessions({
						taskRoot: worktreeRoot,
						projectPath: options.projectPath,
						baseRevision: currentHead,
						// An overlay rebased onto moved history has no
						// precomputable base tree; the checkout plus the trusted
						// receipt are the baseline.
						baseTree: dirtyOverlayReceipt
							? null
							: requireGit(
									options.projectPath,
									["rev-parse", `${currentHead}^{tree}`],
									"project_revision_unavailable",
									{ timeout: deadlineTimeout(options.deadlineMs, now) },
								).trim(),
						dirtyOverlayReceipt,
						files: scopeFiles,
						allowManifests: options.allowManifests,
						commands: options.checks,
						taskId,
						deadlineMs: options.deadlineMs,
						cachePath: dependencies.checkCachePath,
						evidenceDir: join(getRunRoot(runId), "check-evidence"),
						now,
						signal,
						onProgress: () =>
							heartbeat("integrate", {
								processPhase: "head_advance_recheck_preparing",
							}),
					})
				: null;
			try {
				if (headAdvanceSession)
					await headAdvanceSession.prepare(capturedDiff.diff, 3);
				for (let index = 0; index < options.checks.length; index += 1) {
					if (signal?.aborted) return failForSignal("integrate");
					const remaining = remainingMs(options.deadlineMs, now);
					if (remaining <= 0) {
						keepWorktree = true;
						return fail("deadline_expired", "integrate");
					}
					const onProgress = () =>
						heartbeat("integrate", {
							processPhase: "head_advance_recheck_running",
							checkIndex: index + 1,
						});
					const recheck = headAdvanceSession
						? await headAdvanceSession.run({
								command: options.checks[index],
								onProgress,
							})
						: await runCheck({
								command: options.checks[index],
								worktreePath,
								timeoutMs: remaining,
								signal,
								onProgress,
							});
					if (!recheck?.success) {
						keepWorktree = true;
						return fail("host_concurrency", "integrate");
					}
				}
			} catch (error) {
				if (signal?.aborted) return failForSignal("integrate");
				if (error?.code === "deadline_expired") {
					keepWorktree = true;
					return fail("deadline_expired", "integrate");
				}
				keepWorktree = true;
				return fail("host_concurrency", "integrate");
			} finally {
				try {
					headAdvanceSession?.remove();
				} catch {}
			}
		}
		let undeclaredPatchPath = null;
		if (undeclaredKept.length > 0) {
			undeclaredPatchPath = join(getRunRoot(runId), "undeclared.patch");
			try {
				mkdirSync(getRunRoot(runId), { recursive: true, mode: 0o700 });
				writeFileSync(undeclaredPatchPath, undeclaredPatch, { mode: 0o600 });
			} catch (error) {
				keepWorktree = true;
				return fail(
					"run_store_write_failed",
					"integrate",
					classifyErrorKind("run_store_write_failed", "integrate", error),
					error,
				);
			}
		}
		const undeclaredSummary =
			undeclaredKept.length > 0
				? { undeclaredPaths: [...undeclaredKept], undeclaredPatchPath }
				: {};
		emitStatus(onStatus, taskId, "integrate");
		milestone("integrate", "integration_started");
		const integration = dependencies.integrate
			? await dependencies.integrate({
					diff: capturedDiff.diff,
					projectPath: options.projectPath,
					changedFiles,
					allowedPaths: scopeFiles,
					allowSensitiveManifests: (options.allowManifests ?? []).length > 0,
				})
			: integrationGate(capturedDiff.diff, options.projectPath, {
					allowedPaths: scopeFiles,
					allowSensitiveManifests: (options.allowManifests ?? []).length > 0,
				});
		if (!integration?.success) {
			keepWorktree = true;
			if (headAdvanced && integration?.message === "Diff apply failed")
				return fail("host_concurrency", "integrate");
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
						...undeclaredSummary,
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
		runTerminalReached = true;
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
						...undeclaredSummary,
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
		if (reportMode) finalResult.resultKind = "report";
		if (reportMode && reportOutput) finalResult.report = reportOutput;
		finalResult.origin = origin;
		finalResult.formatStatus = formatStatus;
		if (invocationDescriptor) {
			finalResult.invocationDescriptor = structuredClone(invocationDescriptor);
			finalResult.descriptorIdentity = invocationDescriptor.descriptor_identity;
			finalResult.descriptorHarness = descriptorHarness;
		}
		if (terminalProviderReliability)
			finalResult.providerReliability = terminalProviderReliability;
		if (undeclaredKept.length > 0) {
			Object.assign(finalResult, undeclaredSummary);
			try {
				(dependencies.onRoutingWarning ?? console.error)(
					undeclaredWarning(undeclaredKept, undeclaredPatchPath),
				);
			} catch {}
		}
		milestone("terminal", "succeeded");
		return finalResult;
	} catch (error) {
		if (error?.code === "git_control_tampered")
			return failGitControlTampered(currentPhase, error);
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
		if (checkSetupInFlight) {
			if (!OWN_CODED_CHECK_SETUP_REASONS.has(failureReason))
				checkSetupReason = "check_setup_failed";
			return fail(
				failureReason,
				"prepare",
				classifyErrorKind(checkSetupReason ?? failureReason, "prepare", error),
				error,
			);
		}
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
		// Task 3.9: once the terminal result is durable and the writer is final,
		// integration can no longer run, so release before slow cleanup.
		if (
			failureTerminalDurable &&
			(writerLifecycle === "stopped" || writerLifecycle === "never_started")
		)
			await releaseHeldProjectLock();
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
		await releaseHeldProjectLock();
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
import {
	evaluateUndeclaredScope,
	undeclaredWarning,
} from "./undeclared-scope.mjs";

export { parseSimpleArgs, SIMPLE_USAGE } from "./args.mjs";
export { captureDeadlineChangedFiles } from "./declared-diff.mjs";
export { simpleRouteFundingFailure, simpleRouteIsFunded } from "./funding.mjs";
export {
	buildSimpleProviderInvocation,
	defaultExecuteProvider,
	parseOpenCodeGoBridgeDiagnostic,
	runSimpleWriter,
	simpleProviderCompatibility,
} from "./provider-invocation.mjs";
export { assessSimpleRecoveryEvidence } from "./recovery.mjs";
