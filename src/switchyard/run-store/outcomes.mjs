import { appendFile } from "node:fs/promises";
import {
	createOversizeRejectionFact,
	OUTCOME_EVENT_MAX_BYTES,
	OUTCOME_FILE_MAX_BYTES,
	OUTCOME_FILE_MAX_LINES,
	SUPPORTED_OUTCOME_READER_VERSION,
	validateOutcomeEvent,
} from "../outcome/schema.mjs";
import { EVENT_RESERVE_BYTES } from "./constants.mjs";
import { LockError, SchemaError, validateRunId } from "./errors.mjs";
import { createEventInternal } from "./events.mjs";
import { validateRouteHealthBinding } from "./receipt-validation.mjs";
import { readRun, resolveDiagnosticArtifact } from "./run-records.mjs";
import {
	enqueueRunMutation,
	performUpdate,
	reconcileEventCeilingLocked,
	withEventAppendLock,
} from "./run-updates.mjs";
export async function appendOutcomeEvent(
	runId,
	outcome,
	{
		writerEpoch,
		owner = null,
		minimumReaderVersion = SUPPORTED_OUTCOME_READER_VERSION,
	} = {},
) {
	validateRunId(runId);
	return enqueueRunMutation(runId, () =>
		withEventAppendLock(runId, async () => {
			const log = await reconcileEventCeilingLocked(runId);
			const run = await readRun(runId);
			if (owner !== null) {
				await assertOutcomeWriter(runId, {
					...owner,
					writerEpoch,
					minimumReaderVersion,
				});
			}
			if (
				typeof writerEpoch !== "string" ||
				run.outcomeWriterEpoch !== writerEpoch
			)
				throw new SchemaError("typed outcome writer epoch is stale");
			if (
				outcome?.writerEpoch !== undefined &&
				outcome.writerEpoch !== writerEpoch
			)
				throw new SchemaError(
					"typed outcome writer epoch does not match append",
				);
			if (
				Number.isSafeInteger(outcome?.minimumReaderVersion) &&
				outcome.minimumReaderVersion < (run.minimumOutcomeReaderVersion ?? 1)
			)
				throw new SchemaError(
					"typed outcome minimum reader capability is stale",
				);

			const existing = log.events.find(
				(event) => event.outcomeId === outcome?.outcomeId,
			);
			if (existing) return existing.sequence;

			const sequence = log.ceiling + 1;
			const candidate = { ...outcome, runId, sequence };
			let candidateRaw;
			try {
				candidateRaw = `${JSON.stringify(candidate)}\n`;
			} catch {
				throw new SchemaError("typed outcome is not serializable");
			}
			if (Buffer.byteLength(candidateRaw, "utf8") <= OUTCOME_EVENT_MAX_BYTES) {
				try {
					validateOutcomeEvent(candidate);
				} catch {
					throw new SchemaError("typed outcome event is invalid");
				}
				if (
					log.lines + 1 >= OUTCOME_FILE_MAX_LINES ||
					log.bytes +
						Buffer.byteLength(candidateRaw, "utf8") +
						EVENT_RESERVE_BYTES >
						OUTCOME_FILE_MAX_BYTES
				)
					throw new SchemaError("event reserve cannot be proven intact");
				await appendFile(log.path, candidateRaw, { mode: 0o600 });
				await performUpdate(
					runId,
					{ lastEventSequence: sequence },
					run.revision,
				);
				return sequence;
			}

			let rejection;
			const approvedDiagnostic = outcome?.detail?.diagnosticRef
				? await resolveDiagnosticArtifact(runId, outcome.detail.diagnosticRef)
				: null;
			try {
				rejection = createOversizeRejectionFact(outcome, {
					diagnosticRef: approvedDiagnostic
						? outcome.detail.diagnosticRef
						: null,
				});
			} catch {
				rejection = createOversizeRejectionFact(outcome);
			}
			const duplicate = log.events.find(
				(event) =>
					event.stage === "recovery" &&
					event.detail?.reasonCode === "outcome_too_large" &&
					event.detail?.contentHash === rejection.contentHash,
			);
			if (duplicate) return duplicate.sequence;

			const rejectionEvent = {
				schemaVersion: 1,
				minimumReaderVersion: SUPPORTED_OUTCOME_READER_VERSION,
				writerEpoch,
				outcomeId: `outcome-rejected-${rejection.contentHash.slice(7)}`,
				sequence,
				runId,
				scope: "run",
				taskId: null,
				attemptId: null,
				resumesOutcomeId: null,
				stage: "recovery",
				legacyPhase: null,
				legacyEvent: null,
				dispatchCausality: null,
				attempt: 0,
				recordedAt: new Date().toISOString(),
				producer: "run-store",
				causedBy: null,
				operationId: null,
				status: "failed",
				detail: rejection,
			};
			validateOutcomeEvent(rejectionEvent);
			const rejectionRaw = `${JSON.stringify(rejectionEvent)}\n`;
			const rejectionBytes = Buffer.byteLength(rejectionRaw, "utf8");
			if (
				rejectionBytes > EVENT_RESERVE_BYTES ||
				log.lines + 1 > OUTCOME_FILE_MAX_LINES ||
				log.bytes + rejectionBytes > OUTCOME_FILE_MAX_BYTES
			) {
				await performUpdate(
					runId,
					{
						state: "recovery_required",
						outcomeRecovery: {
							reasonCode: "event_reserve_unavailable",
							contentHash: rejection.contentHash,
							automaticRetry: false,
							operatorCommand: "switchyard-dispatch recover",
						},
					},
					run.revision,
				);
				throw new SchemaError("event reserve unavailable; recovery required");
			}
			await appendFile(log.path, rejectionRaw, { mode: 0o600 });
			await performUpdate(runId, { lastEventSequence: sequence }, run.revision);
			return sequence;
		}),
	);
}
async function assertOutcomeWriter(
	runId,
	{
		pid = process.pid,
		startToken,
		nonce,
		writerEpoch,
		minimumReaderVersion = SUPPORTED_OUTCOME_READER_VERSION,
	} = {},
) {
	validateRunId(runId);
	const run = await readRun(runId);
	if (
		!Number.isSafeInteger(pid) ||
		pid < 1 ||
		pid !== process.pid ||
		run.workerPid !== pid ||
		run.workerStartToken !== startToken ||
		(typeof nonce === "string" && run.workerNonce !== nonce) ||
		run.outcomeWriterEpoch !== writerEpoch
	)
		throw new LockError("typed outcome writer lease is stale", {
			code: "OUTCOME_WRITER_LEASE_STALE",
			holderRunId: runId,
		});
	if (
		!Number.isSafeInteger(minimumReaderVersion) ||
		minimumReaderVersion < (run.minimumOutcomeReaderVersion ?? 1) ||
		(run.minimumOutcomeReaderVersion ?? 1) > SUPPORTED_OUTCOME_READER_VERSION
	)
		throw new SchemaError("typed outcome reader capability is stale");
	return run;
}
export async function createRouteHealthEvent(runId, event, binding) {
	validateRunId(runId);
	if (
		event?.phase !== "execution" ||
		!["task_completed", "task_failed", "provider_attempt_terminal"].includes(
			event?.event,
		) ||
		typeof event?.taskId !== "string" ||
		(!Number.isSafeInteger(event?.attempt) &&
			typeof event?.attempt !== "string") ||
		!event?.invocationDescriptor ||
		!event?.descriptorIdentity ||
		!event?.descriptorHarness ||
		!event?.resolvedTargetId
	) {
		throw new SchemaError(
			"route health event requires exact execution evidence",
		);
	}
	const current = await readRun(runId);
	if (!current.orderedTaskIds.includes(event.taskId))
		throw new SchemaError(
			"route health event task is outside the run contract",
		);
	const hostBinding = {
		...binding,
		version: 1,
		producer: "run-store",
		runId,
		runRevision: current.revision,
	};
	validateRouteHealthBinding(hostBinding);
	return enqueueRunMutation(runId, () =>
		withEventAppendLock(runId, () =>
			createEventInternal(
				runId,
				{ ...event, routeHealthBinding: hostBinding },
				{ routeHealthAuthorised: true },
			),
		),
	);
}
