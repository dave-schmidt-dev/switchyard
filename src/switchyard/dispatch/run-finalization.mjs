import {
	isPersistentFailureMetadata,
	PERSISTED_DIAGNOSTIC_CODES,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import * as defaultRunStore from "../run-store/index.mjs";

const TERMINAL_STATES = new Set(["succeeded", "failed"]);
const TERMINAL_WRITERS = new Set(["worker", "dead_worker_recovery"]);

const CLOSED_EVENT_REASONS = Object.freeze({
	checkpoint_task_file_mismatch:
		"checkpoint task file mismatch: tasksFilePath does not match; create a new checkpoint or use an audited migration",
	checkpoint_tasks_file_mismatch:
		"checkpoint task file mismatch: tasksFilePath does not match; create a new checkpoint or use an audited migration",
	checkpoint_missing_queue_identity:
		"checkpoint v2 is missing queueIdentity; create a new checkpoint or use an audited migration",
	checkpoint_queue_identity_missing:
		"checkpoint v2 is missing queueIdentity; create a new checkpoint or use an audited migration",
	checkpoint_queue_identity_mismatch:
		"checkpoint queue identity mismatch; create a new checkpoint or use an audited migration",
	checkpoint_run_options_mismatch:
		"checkpoint run options mismatch: normalized run options changed; create a new checkpoint or use an audited migration",
	checkpoint_historical_checkpoint:
		"checkpoint v1 is historical state without queue identity; create an explicit new checkpoint or use an audited migration",
	checkpoint_historical_state:
		"checkpoint v1 is historical state without queue identity; create an explicit new checkpoint or use an audited migration",
});

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
		eventName = state === "failed" ? "run_failed" : "run_completed",
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
		!["run_completed", "run_failed", "worker_boot_failed"].includes(eventName)
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
		state === "failed" && failure === null
			? unexplainedTerminalFailure()
			: failure;
	const closedEventReasonCode = eventReasonCode ?? closedFailure?.reasonCode;
	const eventReason =
		CLOSED_EVENT_REASONS[closedEventReasonCode] ??
		closedFailure?.reason ??
		null;

	const createEvent = dependencies.createEvent ?? defaultRunStore.createEvent;
	const updateRunWithRetry =
		dependencies.updateRunWithRetry ?? defaultRunStore.updateRunWithRetry;
	const releaseRunLock =
		dependencies.releaseRunLock ?? defaultRunStore.releaseRunLock;
	let primaryError = null;
	let outcome = null;
	try {
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
			await updateRunWithRetry(runId, {
				state: "recovery_required",
				cleanupState: "failed",
				...CLEARED_ACTIVE_FIELDS,
				lastFailure: recoveryFailure,
			});
			outcome = { terminal: false, cleanupComplete: false, error };
		}
		if (!cleanupError) {
			const run = await updateRunWithRetry(runId, {
				state,
				cleanupState: "complete",
				terminalizedBy,
				terminalSummary,
				...CLEARED_ACTIVE_FIELDS,
				...(closedFailure ? { lastFailure: closedFailure } : {}),
				...extraPatch,
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
