import {
	applyOutcomeProjection,
	projectOutcomeReader,
} from "../outcome/projection.mjs";
import { readRun, SchemaError } from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";
import { sanitizeQueuePreflightDetail } from "../runner/index.mjs";
import {
	parseResultArgs,
	parseStatusArgs,
	withStateRoot,
} from "./cli-args.mjs";
import { USAGE_RESULT, USAGE_STATUS, UsageError } from "./cli-usage.mjs";
import { projectDisposition, projectTerminalOutcome } from "./disposition.mjs";
import {
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
} from "./status-envelope.mjs";

async function buildResultEnvelope(runId, run) {
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
	const artifactRefs = await listArtifactRefs(runId);
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
		workerLive: run.state === "running" ? liveness === "live" : null,
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
		lastFailure: projectFailureRemedy(
			reconcileFailureArtifactRef(
				quickCheckInvalid
					? { errorKind: "check_failed", reasonCode: "check_failed" }
					: (run.lastFailure ?? null),
				artifactRefs,
			),
		),
		lastReviewResult: run.lastReviewResult ?? null,
		...retryProjection,
		queueDiagnostics,
		startedAt: run.startedAt ?? null,
		finishedAt: run.finishedAt ?? null,
		updatedAt: run.updatedAt,
		terminalSummary: {
			...(run.terminalSummary ?? {}),
			...(quickCheckInvalid
				? {
						completedTaskIds: checkpointState.completedTaskIds,
						failedCount: Math.max(1, failedCount),
					}
				: {}),
			outcome: quickCheckInvalid
				? "failed_work"
				: projectTerminalOutcome(projectedRun, outcomeProjection),
		},
		artifactRefs,
		disposition,
		outcomeShadow,
		outcomeProjection,
		...telemetry,
	};
}
function isTerminalState(state) {
	return state === "succeeded" || state === "failed" || state === "deferred";
}
function isCleanupComplete(cleanupState) {
	return cleanupState === "complete";
}
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

		if (
			envelope.state === "succeeded" &&
			isCleanupComplete(envelope.cleanupState)
		) {
			process.exitCode = 0;
		} else if (
			envelope.state === "deferred" &&
			isCleanupComplete(envelope.cleanupState)
		) {
			process.exitCode = 6;
		} else {
			process.exitCode = 1;
		}
	});
}

export { buildResultEnvelope, handleResult, handleStatus, isTerminalState };
