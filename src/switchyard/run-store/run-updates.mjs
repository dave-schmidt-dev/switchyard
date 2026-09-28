import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import { isReviewResult } from "../diagnostics/review-result.mjs";
import { projectOutcomeReader } from "../outcome/projection.mjs";
import {
	OUTCOME_EVENT_MAX_BYTES,
	OUTCOME_FILE_MAX_BYTES,
	OUTCOME_FILE_MAX_LINES,
	validateOutcomeEvent,
} from "../outcome/schema.mjs";
import {
	mergeOutcomeShadow,
	projectOutcomeShadow,
} from "../outcome/shadow.mjs";
import {
	EVENT_LOCK_WAIT_MS,
	MUTATION_ID_RE,
	MUTATION_OPERATION_LIMIT,
	PROCESS_INSTANCE_ID,
	validateMutationOperations,
} from "./constants.mjs";
import {
	LockError,
	RevisionError,
	SchemaError,
	validateRunId,
} from "./errors.mjs";
import {
	getRunRoot,
	readRun,
	resolveDiagnosticArtifact,
	writeRunAtomically,
} from "./run-records.mjs";
import { validateRun } from "./validate-run.mjs";
import { vmOwnerIsLive } from "./vm-slots.mjs";

const updateQueues = new Map();
function enqueueRunMutation(runId, operation) {
	const previous = updateQueues.get(runId) ?? Promise.resolve();
	const result = previous.catch(() => {}).then(operation);
	updateQueues.set(runId, result);
	void result
		.finally(() => {
			if (updateQueues.get(runId) === result) updateQueues.delete(runId);
		})
		.catch(() => {});
	return result;
}
export async function updateRun(runId, partial, expectedRevision) {
	validateRunId(runId);
	return enqueueRunMutation(runId, () =>
		performUpdate(runId, partial, expectedRevision),
	);
}
async function performUpdate(runId, partial, expectedRevision) {
	const current = await readRun(runId);

	if (current.revision !== expectedRevision) {
		throw new RevisionError(
			`Revision mismatch for ${runId}: expected ${expectedRevision}, got ${current.revision}`,
		);
	}

	if (
		partial?.lastReviewResult !== undefined &&
		partial.lastReviewResult !== null &&
		!isReviewResult(partial.lastReviewResult)
	) {
		throw new SchemaError("lastReviewResult contains invalid review metadata");
	}
	const merged = {
		...current,
		...partial,
		runId: current.runId,
		schemaVersion: current.schemaVersion,
		createdAt: current.createdAt,
		updatedAt: new Date().toISOString(),
		revision: current.revision + 1,
	};
	if (merged.lastFailure?.diagnosticRef) {
		const diagnosticArtifact = await resolveDiagnosticArtifact(
			runId,
			merged.lastFailure.diagnosticRef,
		);
		if (!diagnosticArtifact) {
			const withoutDiagnosticRef = { ...merged.lastFailure };
			delete withoutDiagnosticRef.diagnosticRef;
			merged.lastFailure = {
				...withoutDiagnosticRef,
				diagnosticEvidenceAvailable: false,
			};
		}
	}

	if (merged.state === "failed" && !merged.lastFailure) {
		merged.lastFailure = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "unclassified",
		});
	}
	// Recompute against the post-update run state so a terminal transition does
	// not leave the shadow parity record describing the prior live state. This
	// remains additive; callers continue reading the legacy fields above.
	const eventLog = await inspectEventLog(runId).catch(() => null);
	if (eventLog) {
		const refreshedShadow = projectOutcomeShadow(eventLog.events, {
			run: merged,
		});
		merged.outcomeShadow = mergeOutcomeShadow(
			current.outcomeShadow,
			refreshedShadow,
		);
		merged.outcomeProjection = projectOutcomeReader({
			run: merged,
			events: eventLog.events,
		});
	}

	validateRun(merged);

	const runJsonPath = resolve(getRunRoot(runId), "run.json");
	await writeRunAtomically(runJsonPath, merged);
	return merged;
}
export async function updateRunWithRetry(runId, partial, maxAttempts = 10) {
	for (let attempt = 0; ; attempt++) {
		const current = await readRun(runId);
		try {
			return await updateRun(runId, partial, current.revision);
		} catch (error) {
			if (!(error instanceof RevisionError) || attempt >= maxAttempts - 1) {
				throw error;
			}
		}
	}
}
export async function recordMutationOperation(runId, operation) {
	validateRunId(runId);
	validateMutationOperations([operation]);
	for (;;) {
		const current = await readRun(runId);
		const operations = Array.isArray(current.mutationOperations)
			? [...current.mutationOperations]
			: [];
		const index = operations.findIndex(
			(candidate) => candidate.operationId === operation.operationId,
		);
		if (index >= 0) operations[index] = { ...operation };
		else operations.push({ ...operation });
		if (operations.length > MUTATION_OPERATION_LIMIT)
			operations.splice(0, operations.length - MUTATION_OPERATION_LIMIT);
		try {
			return await updateRun(
				runId,
				{ mutationOperations: operations },
				current.revision,
			);
		} catch (error) {
			if (!(error instanceof RevisionError)) throw error;
		}
	}
}
export async function readMutationOperation(runId, operationId) {
	validateRunId(runId);
	if (!MUTATION_ID_RE.test(operationId ?? "")) return null;
	const run = await readRun(runId);
	return (
		(Array.isArray(run.mutationOperations) ? run.mutationOperations : []).find(
			(operation) => operation.operationId === operationId,
		) ?? null
	);
}
export async function advanceState(runId, newState) {
	const current = await readRun(runId);
	const patch = { state: newState };
	if (newState === "running" && current.startedAt == null) {
		patch.startedAt = new Date().toISOString();
	}
	return updateRun(runId, patch, current.revision);
}
function eventAppendLockPath(runId) {
	return resolve(getRunRoot(runId), ".event-append.lock");
}
async function withEventAppendLock(runId, operation) {
	const path = eventAppendLockPath(runId);
	const token = JSON.stringify({
		runId,
		pid: process.pid,
		processInstanceId: PROCESS_INSTANCE_ID,
		nonce: randomUUID(),
	});
	const deadline = Date.now() + EVENT_LOCK_WAIT_MS;
	for (;;) {
		try {
			await writeFile(path, token, { flag: "wx", mode: 0o600 });
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const staleRaw = await readFile(path, "utf8").catch(() => null);
			if (staleRaw !== null) {
				let staleOwner = null;
				try {
					staleOwner = JSON.parse(staleRaw);
				} catch {
					/* fail closed */
				}
				if (
					staleOwner?.runId === runId &&
					Number.isSafeInteger(staleOwner.pid) &&
					!vmOwnerIsLive(staleOwner.pid)
				) {
					const currentRaw = await readFile(path, "utf8").catch(() => null);
					if (currentRaw === staleRaw) await unlink(path).catch(() => {});
					continue;
				}
			}
			if (Date.now() >= deadline)
				throw new LockError(`Event append lock unavailable for ${runId}`, {
					code: "EVENT_APPEND_LOCK_HELD",
					holderRunId: runId,
				});
			await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		}
	}
	try {
		return await operation();
	} finally {
		const currentToken = await readFile(path, "utf8").catch(() => null);
		if (currentToken === token) await unlink(path).catch(() => {});
	}
}
async function inspectEventLog(runId) {
	const path = resolve(getRunRoot(runId), "events.jsonl");
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT")
			return { path, raw: "", events: [], bytes: 0, lines: 0, ceiling: 0 };
		throw error;
	}
	const bytes = Buffer.byteLength(raw, "utf8");
	if (bytes > OUTCOME_FILE_MAX_BYTES)
		throw new SchemaError("events exceed file limit");
	if (raw.length > 0 && !raw.endsWith("\n"))
		throw new SchemaError("events contain a corrupt tail");
	const lines = raw.split("\n").filter(Boolean);
	if (lines.length > OUTCOME_FILE_MAX_LINES)
		throw new SchemaError("events exceed line limit");
	const events = [];
	let expected = 1;
	for (const line of lines) {
		if (Buffer.byteLength(line, "utf8") + 1 > OUTCOME_EVENT_MAX_BYTES)
			throw new SchemaError("event exceeds line limit");
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new SchemaError("events contain invalid JSON");
		}
		if (
			!event ||
			typeof event !== "object" ||
			Array.isArray(event) ||
			event.sequence !== expected
		)
			throw new SchemaError("event sequence gap is unresolved");
		if (event.stage !== undefined || event.outcomeId !== undefined) {
			try {
				validateOutcomeEvent(event);
			} catch {
				throw new SchemaError("typed outcome event is invalid");
			}
		}
		events.push(event);
		expected += 1;
	}
	return {
		path,
		raw,
		events,
		bytes,
		lines: lines.length,
		ceiling: expected - 1,
	};
}
async function reconcileEventCeilingLocked(runId) {
	const log = await inspectEventLog(runId);
	const run = await readRun(runId);
	if (run.lastEventSequence > log.ceiling)
		throw new SchemaError("run projection exceeds durable event sequence");
	if (run.lastEventSequence < log.ceiling) {
		await performUpdate(
			runId,
			{ lastEventSequence: log.ceiling },
			run.revision,
		);
	}
	return { ...log, repaired: run.lastEventSequence < log.ceiling };
}
export async function reconcileEventSequence(runId) {
	validateRunId(runId);
	return enqueueRunMutation(runId, () =>
		withEventAppendLock(runId, () => reconcileEventCeilingLocked(runId)),
	);
}
export {
	enqueueRunMutation,
	eventAppendLockPath,
	inspectEventLog,
	performUpdate,
	reconcileEventCeilingLocked,
	updateQueues,
	withEventAppendLock,
};
