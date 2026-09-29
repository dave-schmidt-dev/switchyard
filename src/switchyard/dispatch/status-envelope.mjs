import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	checkpointRemediation,
	isPersistentFailureMetadata,
} from "../adapter/exec-error.mjs";
import {
	createExecutionBackend,
	hostBackendDefaults,
} from "../lifecycle/backend-selection.mjs";
import {
	applyOutcomeProjection,
	projectOutcomeReader,
} from "../outcome/projection.mjs";
import {
	getRunRoot,
	getStateRoot,
	getVmAdmissionRoot,
	readEvents,
} from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";
import {
	deriveQueueDiagnostics,
	getCheckpointPath,
	invalidCompletedQuickCheckTaskIds,
	loadCheckpoint,
	loadTaskQueue,
	sanitizeQueuePreflightDetail,
} from "../runner/index.mjs";
import { shellQuote } from "./cli-args.mjs";
import { projectDisposition } from "./disposition.mjs";

async function readEventsSafe(runId) {
	try {
		const events = await readEvents(runId);
		Object.defineProperty(events, "evidenceValid", { value: true });
		return events;
	} catch {
		// events may be absent or unreadable
		const events = [];
		Object.defineProperty(events, "evidenceValid", { value: false });
		return events;
	}
}
function recoveryCommandFor(runId) {
	return `switchyard-dispatch recover --run ${runId} --state-root ${shellQuote(getStateRoot())}`;
}
function remediationCommandFor() {
	return `switchyard-dispatch remediate-orphaned-locks --state-root ${shellQuote(getStateRoot())}`;
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
function shadowEnvelope(run) {
	const shadow = run?.outcomeShadow;
	if (!shadow || typeof shadow !== "object") return null;
	return {
		version: shadow.version ?? 1,
		projection: shadow.projection ?? null,
		parity: shadow.parity ?? null,
		recoveryQueue: Array.isArray(shadow.recoveryQueue)
			? shadow.recoveryQueue
			: [],
	};
}
function sanitizedExecutionFailureEvents(events) {
	const failureFields = [
		"errorKind",
		"reasonCode",
		"reason",
		"artifactRef",
		"diagnosticCode",
		"exitCode",
		"signal",
		"failurePhase",
	];
	return events.filter((event) => {
		if (event?.phase !== "execution" || event?.event !== "task_failed") {
			return false;
		}
		const failure = {};
		for (const field of failureFields) {
			if (event[field] !== undefined) failure[field] = event[field];
		}
		return isPersistentFailureMetadata(failure);
	});
}
function readCheckpointStateForRun(run) {
	try {
		const checkpointPath =
			run.runOptions?.checkpointPath ?? getCheckpointPath(run.tasksFilePath);
		const checkpoint = loadCheckpoint(
			checkpointPath,
			run.tasksFilePath,
			run.queueIdentity
				? {
						queueIdentity: run.queueIdentity,
						runOptions: run.runOptions,
					}
				: null,
		);
		try {
			const invalidIds = invalidCompletedQuickCheckTaskIds(
				loadTaskQueue(run.tasksFilePath),
				checkpoint,
			);
			if (invalidIds.length)
				return {
					...checkpoint,
					quickCheckInvalidTaskIds: invalidIds,
					completedTaskIds: checkpoint.completedTaskIds.filter(
						(id) => !invalidIds.includes(id),
					),
				};
		} catch {
			// The ordinary observation path still reports a malformed queue as
			// unavailable; it must not echo task text or parser diagnostics.
		}
		return checkpoint;
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
const PROVIDER_BINARY_NAMES = {
	claude: "claude",
	codex: "codex",
	agy: "agy",
	cursor: "cursor-agent",
	copilot: "copilot",
	opencode: "opencode",
};
function executionBackendForRun() {
	return createExecutionBackend({
		...hostBackendDefaults(),
		// This is the process that reclaims a dead worker's clones, so it is the
		// one that most needs to read the sidecars a live worker wrote.
		snapshotSidecarRoot: getVmAdmissionRoot(),
	});
}
function lineMatchesBinary(line, binaryName) {
	const match = line.trim().match(/^\d+\s+(\S+)/);
	if (!match) return false;
	const executable = match[1];
	const base = executable.split("/").pop();
	return base === binaryName;
}
function probeProviderProcess(run, { executionBackend, execFn } = {}) {
	if (run.state !== "running") return null;

	const { workingContainerName, activeTaskProvider } = run;
	if (!workingContainerName || !activeTaskProvider) return null;

	const binaryName = PROVIDER_BINARY_NAMES[activeTaskProvider];
	if (!binaryName) return null;

	try {
		const backend = execFn
			? createExecutionBackend({ execFn })
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
	const outcomeProjection = projectOutcomeReader({ run, events });
	let projectedRun = applyOutcomeProjection(run, outcomeProjection);
	const { completedCount, failedCount } = countCompletedAndFailed(events);
	const checkpointState = readCheckpointStateForRun(run);
	const quickCheckInvalid =
		(checkpointState?.quickCheckInvalidTaskIds?.length ?? 0) > 0;
	if (quickCheckInvalid) projectedRun = { ...projectedRun, state: "failed" };
	const telemetry = deriveTelemetryFields(run, events, checkpointState);
	const retryProjection = deriveRetryProjection(checkpointState);
	const queueDiagnostics = readQueueDiagnosticsForRun(run, checkpointState);
	const liveness = classifyRunLiveness(run);
	const disposition = projectDisposition({
		run: projectedRun,
		outcomeProjection,
		checkpoint: checkpointState,
		events: sanitizedExecutionFailureEvents(events),
		liveness,
		recoveryCommand: recoveryCommandFor(runId),
		remediationCommand: remediationCommandFor(),
		optionalEvidenceValid:
			events.evidenceValid !== false && checkpointState !== null,
	});
	const outcomeShadow = shadowEnvelope(run);
	if (outcomeShadow) disposition.outcomeShadow = outcomeShadow;
	return {
		schemaVersion: run.schemaVersion ?? 1,
		runId: run.runId,
		queueIdentity: run.queueIdentity ?? null,
		...(sanitizeQueuePreflightDetail(run.preflightDetail)
			? { preflightDetail: sanitizeQueuePreflightDetail(run.preflightDetail) }
			: {}),
		state: projectedRun.state,
		cleanupState: run.cleanupState,
		// Liveness derived from a signal-0 probe of the recorded worker pid
		// (see isWorkerLive), so an operator doesn't have to shell out to
		// `ps` to tell active work from a stalled/ghost run.
		workerLive: run.state === "running" ? liveness === "live" : null,
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
		completedCount: quickCheckInvalid
			? checkpointState.completedTaskIds.length
			: outcomeProjection.reader === "reducer"
				? (outcomeProjection.taskCounters?.completed ?? completedCount)
				: completedCount,
		failedCount: quickCheckInvalid
			? Math.max(1, failedCount)
			: outcomeProjection.reader === "reducer"
				? (outcomeProjection.taskCounters?.failed ?? failedCount)
				: failedCount,
		// Reconciled against the same artifacts channel `result` reports, so the
		// two envelopes cannot disagree about whether a failure has an artifact.
		lastFailure: reconcileFailureArtifactRef(
			quickCheckInvalid
				? { errorKind: "check_failed", reasonCode: "check_failed" }
				: (run.lastFailure ?? null),
			await listArtifactRefs(runId),
		),
		lastReviewResult: run.lastReviewResult ?? null,
		...retryProjection,
		queueDiagnostics,
		startedAt: run.startedAt ?? null,
		finishedAt: run.finishedAt ?? null,
		updatedAt: run.updatedAt,
		disposition,
		outcomeShadow,
		outcomeProjection,
		...telemetry,
	};
}
function reconcileFailureArtifactRef(lastFailure, artifactRefs) {
	if (!lastFailure || typeof lastFailure !== "object") {
		return lastFailure ?? null;
	}
	if (typeof lastFailure.artifactRef !== "string") return lastFailure;
	if (artifactRefs.includes(lastFailure.artifactRef)) return lastFailure;
	const { artifactRef: _unresolvable, ...rest } = lastFailure;
	return rest;
}
function projectFailureRemedy(lastFailure) {
	if (
		!lastFailure ||
		typeof lastFailure !== "object" ||
		typeof lastFailure.checkpointCode !== "string" ||
		!Object.hasOwn(CHECKPOINT_REMEDIATION_MESSAGES, lastFailure.checkpointCode)
	)
		return lastFailure;
	return {
		...lastFailure,
		reason: checkpointRemediation(lastFailure.checkpointCode, {
			dimensions: lastFailure.checkpointDimensions,
		}),
	};
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

export {
	buildStatusEnvelope,
	countCompletedAndFailed,
	deriveRetryProjection,
	deriveTelemetryFields,
	executionBackendForRun,
	listArtifactRefs,
	probeProviderProcess,
	projectFailureRemedy,
	readCheckpointStateForRun,
	readEventsSafe,
	readQueueDiagnosticsForRun,
	reconcileFailureArtifactRef,
	recoveryCommandFor,
	remediationCommandFor,
	sanitizedExecutionFailureEvents,
	shadowEnvelope,
};
