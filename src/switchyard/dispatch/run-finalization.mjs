import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	isPersistentFailureMetadata,
	PERSISTED_DIAGNOSTIC_CODES,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import * as defaultRunStore from "../run-store/index.mjs";

const TERMINAL_STATES = new Set(["succeeded", "failed", "deferred"]);
const TERMINAL_WRITERS = new Set(["worker", "dead_worker_recovery"]);

const CLOSED_EVENT_REASONS = CHECKPOINT_REMEDIATION_MESSAGES;

const CLEARED_ACTIVE_FIELDS = Object.freeze({
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
});

async function emitTypedFinalizationStage(runStore, runId, options) {
	if (
		typeof runStore?.readRun !== "function" ||
		typeof runStore?.createStageOutcome !== "function" ||
		typeof runStore?.appendOutcomeEvent !== "function"
	)
		return null;
	try {
		const run = await runStore.readRun(runId);
		if (
			typeof run?.outcomeWriterEpoch !== "string" ||
			!Number.isSafeInteger(run.workerPid) ||
			typeof run.workerStartToken !== "string" ||
			typeof run.workerNonce !== "string"
		)
			return null;
		const outcome = runStore.createStageOutcome({
			runId,
			writerEpoch: run.outcomeWriterEpoch,
			...options,
		});
		await runStore.appendOutcomeEvent(runId, outcome, {
			writerEpoch: run.outcomeWriterEpoch,
			owner: {
				pid: run.workerPid,
				startToken: run.workerStartToken,
				nonce: run.workerNonce,
			},
		});
		return outcome;
	} catch {
		// Finalization remains fail-closed on the established legacy run state;
		// typed shadow evidence must never erase terminal cleanup or its recovery
		// diagnostic when the compatibility writer is unavailable.
		return null;
	}
}

/**
 * A terminal `failed` state with no failure metadata is a run that says it broke
 * and refuses to say how. It is not a hypothetical: the dispatch finaliser wrote
 * 170 such records. This is the backstop for every other caller — the reason is
 * deliberately unflattering rather than absent, so the gap stays findable.
 */
function unexplainedTerminalFailure() {
	return sanitizeFailureMetadata({
		result: "unknown_failure",
		errorKind: "unknown_failure",
		diagnosticCode: "terminal_without_failure_metadata",
		failurePhase: "terminal_reconciliation",
	});
}

function recoveryIncompleteFailure() {
	return sanitizeFailureMetadata({
		result: "unknown_failure",
		errorKind: "unknown_failure",
		diagnosticCode: "recovery_incomplete",
		failurePhase: "terminal_reconciliation",
	});
}

/**
 * Persist one terminal fact around ownership cleanup.
 *
 * The caller supplies only closed failure metadata and known scalar/count
 * facts. Cleanup runs while the record is non-terminal and cleanup-pending;
 * the terminal state becomes durable only after cleanup succeeds.
 */
export async function finalizeRun(options, dependencies = {}) {
	const {
		runId,
		state,
		terminalSummary,
		failure = null,
		terminalizedBy = "worker",
		cleanup = async () => {},
		extraPatch = {},
		eventName = state === "failed"
			? "run_failed"
			: state === "deferred"
				? "run_deferred"
				: "run_completed",
		eventStatus = state,
		eventReasonCode = failure?.reasonCode,
	} = options ?? {};
	if (!TERMINAL_STATES.has(state)) {
		throw new TypeError("finalizeRun requires a terminal state");
	}
	if (!TERMINAL_WRITERS.has(terminalizedBy)) {
		throw new TypeError("finalizeRun requires a known terminal writer");
	}
	if (failure !== null && !isPersistentFailureMetadata(failure)) {
		throw new TypeError("finalizeRun accepts only sanitized failure metadata");
	}
	if (
		![
			"run_completed",
			"run_failed",
			"run_deferred",
			"worker_boot_failed",
		].includes(eventName)
	) {
		throw new TypeError("finalizeRun requires a closed terminal event name");
	}
	if (
		eventReasonCode &&
		eventReasonCode !== failure?.reasonCode &&
		!Object.hasOwn(CLOSED_EVENT_REASONS, eventReasonCode) &&
		!PERSISTED_DIAGNOSTIC_CODES.includes(eventReasonCode)
	) {
		throw new TypeError("finalizeRun requires a closed event reason code");
	}
	const closedFailure =
		state === "failed"
			? failure === null
				? unexplainedTerminalFailure()
				: failure
			: null;
	const closedEventReasonCode = eventReasonCode ?? closedFailure?.reasonCode;
	const eventReason =
		closedFailure?.reason ??
		CLOSED_EVENT_REASONS[closedEventReasonCode] ??
		null;

	const createEvent = dependencies.createEvent ?? defaultRunStore.createEvent;
	const stageStore =
		typeof dependencies.createStageOutcome === "function" &&
		typeof dependencies.appendOutcomeEvent === "function"
			? dependencies
			: defaultRunStore;
	const recordFinalizationStage = (options) =>
		emitTypedFinalizationStage(stageStore, runId, options);
	const updateRunWithRetry =
		dependencies.updateRunWithRetry ?? defaultRunStore.updateRunWithRetry;
	const releaseRunLock =
		dependencies.releaseRunLock ?? defaultRunStore.releaseRunLock;
	let primaryError = null;
	let outcome = null;
	try {
		await recordFinalizationStage({
			stage: "cleanup",
			status: "started",
			producer: "runner",
			code: "cleanup_started",
			detail: { cleanupCode: "cleanup_started", observed: false },
		});
		await createEvent(runId, {
			phase: "worker",
			event: eventName,
			status: eventStatus,
			...(closedFailure ?? {}),
			...(closedEventReasonCode ? { reasonCode: closedEventReasonCode } : {}),
			...(eventReason !== null ? { reason: eventReason } : {}),
		});
		await updateRunWithRetry(runId, {
			cleanupState: "pending",
			...CLEARED_ACTIVE_FIELDS,
			...(closedFailure ? { lastFailure: closedFailure } : {}),
		});
		let cleanupError = null;
		try {
			await cleanup();
		} catch (error) {
			cleanupError = error;
			const recoveryFailure = recoveryIncompleteFailure();
			await recordFinalizationStage({
				stage: "cleanup",
				status: "failed",
				producer: "recovery",
				code: "cleanup_failed",
				detail: { cleanupCode: "cleanup_failed", observed: false },
			});
			await recordFinalizationStage({
				stage: "recovery",
				status: "failed",
				producer: "recovery",
				code: "recovery_required",
				detail: { originalStage: "cleanup" },
			});
			await updateRunWithRetry(runId, {
				state: "recovery_required",
				cleanupState: "failed",
				...CLEARED_ACTIVE_FIELDS,
				lastFailure: recoveryFailure,
			});
			outcome = { terminal: false, cleanupComplete: false, error };
		}
		if (!cleanupError) {
			await recordFinalizationStage({
				stage: "cleanup",
				status: "succeeded",
				producer: "runner",
				code: "cleanup_completed",
				detail: { cleanupCode: "cleanup_completed", observed: true },
			});
			const run = await updateRunWithRetry(runId, {
				state,
				cleanupState: "complete",
				terminalizedBy,
				terminalSummary,
				...CLEARED_ACTIVE_FIELDS,
				...(closedFailure ? { lastFailure: closedFailure } : {}),
				...extraPatch,
				finishedAt: new Date().toISOString(),
			});
			await recordFinalizationStage({
				stage: "run",
				status:
					state === "succeeded"
						? "succeeded"
						: state === "deferred"
							? "skipped"
							: "failed",
				producer: "runner",
				code: state === "succeeded" ? "run_completed" : `run_${state}`,
			});
			await recordFinalizationStage({
				stage: "postcondition",
				status: "succeeded",
				producer: "runner",
				code: "run_terminalized",
				detail: { commandResult: state, observedState: "cleanup_complete" },
			});
			outcome = { terminal: true, cleanupComplete: true, run };
		}
	} catch (error) {
		primaryError = error;
	}
	let releaseError = null;
	try {
		await releaseRunLock(runId);
	} catch (error) {
		releaseError = error;
	}
	if (primaryError) throw primaryError;
	// The terminal patch is now durable, so a competing lease release must not
	// turn a completed run into a second, synthetic failure finalization. The
	// stale lease remains recoverable through normal run-lock reclamation.
	if (releaseError && !outcome?.terminal) throw releaseError;
	return outcome;
}
