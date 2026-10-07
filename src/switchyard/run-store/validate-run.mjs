import { isAbsolute, resolve } from "node:path";
import {
	isPersistentFailureDetails,
	isPersistentFailureMetadata,
} from "../adapter/exec-error.mjs";
import { isReviewResult } from "../diagnostics/review-result.mjs";
import { SUPPORTED_OUTCOME_READER_VERSION } from "../outcome/schema.mjs";
import { validateShadowEnvelope } from "../outcome/shadow.mjs";
import { normalizeProviderName } from "../roster/index.mjs";
import {
	CURRENT_SCHEMA_VERSION,
	DIAGNOSTIC_DIGEST_RE,
	HISTORICAL_SCHEMA_VERSION,
	TELEMETRY_WRITE_FAILURE_LABELS,
	VALID_CLEANUP_STATES,
	VALID_STATES,
	VALID_WORKTREE_STATES,
	validateMutationOperations,
	WORKTREE_RECORD_KEYS,
} from "./constants.mjs";
import { SchemaError } from "./errors.mjs";
import {
	DESCRIPTOR_IDENTITY_RE,
	isSafeDescriptorReceipt,
	isSafeTargetId,
} from "./receipt-validation.mjs";

function validateWorktreeRecord(worktree) {
	if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) {
		throw new SchemaError("worktree must be an object");
	}
	for (const key of Object.keys(worktree)) {
		if (!WORKTREE_RECORD_KEYS.has(key)) {
			throw new SchemaError(`worktree contains invalid key: ${key}`);
		}
	}
	const identityKeys = ["device", "inode", "nonce"];
	const presentIdentityKeys = identityKeys.filter(
		(key) => worktree[key] !== undefined,
	);
	if (presentIdentityKeys.length !== 0 && presentIdentityKeys.length !== 3) {
		throw new SchemaError("worktree identity must be complete");
	}
	if (
		presentIdentityKeys.length === 3 &&
		(!/^[0-9]+$/.test(worktree.device) ||
			!/^[0-9]+$/.test(worktree.inode) ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
				worktree.nonce,
			))
	) {
		throw new SchemaError("worktree identity is invalid");
	}
	if (
		worktree.writerStopped !== undefined &&
		typeof worktree.writerStopped !== "boolean"
	) {
		throw new SchemaError("worktree.writerStopped must be a boolean");
	}
	if (
		typeof worktree.canonicalParent !== "string" ||
		!isAbsolute(worktree.canonicalParent)
	) {
		throw new SchemaError(
			"worktree.canonicalParent must be an absolute string path",
		);
	}
	if (
		typeof worktree.candidateChild !== "string" ||
		!worktree.candidateChild ||
		worktree.candidateChild.includes("/") ||
		worktree.candidateChild.includes("\\") ||
		worktree.candidateChild === "." ||
		worktree.candidateChild === ".."
	) {
		throw new SchemaError(
			"worktree.candidateChild must be a single directory segment",
		);
	}
	if (
		typeof worktree.path !== "string" ||
		worktree.path !== resolve(worktree.canonicalParent, worktree.candidateChild)
	) {
		throw new SchemaError(
			"worktree.path must match canonicalParent and candidateChild",
		);
	}
	if (
		typeof worktree.state !== "string" ||
		!VALID_WORKTREE_STATES.has(worktree.state)
	) {
		throw new SchemaError(
			"worktree.state must be allocating, active, removed, or retained",
		);
	}
	if (
		worktree.reason !== undefined &&
		worktree.reason !== null &&
		typeof worktree.reason !== "string"
	) {
		throw new SchemaError("worktree.reason must be a string or null");
	}
	if (worktree.retainedAt !== undefined && worktree.retainedAt !== null) {
		if (
			typeof worktree.retainedAt !== "string" ||
			Number.isNaN(Date.parse(worktree.retainedAt))
		) {
			throw new SchemaError(
				"worktree.retainedAt must be a valid ISO timestamp or null",
			);
		}
	}
}
function isCleanupFailureMetadata(value) {
	if (isPersistentFailureMetadata(value)) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { result, ...metadata } = value;
	return (
		[
			"deadline_expired",
			"project_lock_release_unconfirmed",
			"worktree_cleanup_failed",
		].includes(result) &&
		metadata.errorKind === "cleanup_failed" &&
		isPersistentFailureMetadata(metadata)
	);
}
function validateRun(data) {
	if (
		data.schemaVersion !== HISTORICAL_SCHEMA_VERSION &&
		data.schemaVersion !== CURRENT_SCHEMA_VERSION
	) {
		throw new SchemaError(
			`Unsupported schemaVersion (expected ${HISTORICAL_SCHEMA_VERSION} or ${CURRENT_SCHEMA_VERSION})`,
		);
	}
	if (typeof data.runId !== "string") {
		throw new SchemaError("runId must be a string");
	}
	if (typeof data.state !== "string" || !VALID_STATES.has(data.state)) {
		throw new SchemaError("Invalid state");
	}
	if (
		typeof data.cleanupState !== "string" ||
		!VALID_CLEANUP_STATES.has(data.cleanupState)
	) {
		throw new SchemaError("Invalid cleanupState");
	}
	if (typeof data.revision !== "number" || !Number.isInteger(data.revision)) {
		throw new SchemaError("revision must be an integer");
	}
	if (typeof data.createdAt !== "string") {
		throw new SchemaError("createdAt must be a string");
	}
	if (typeof data.updatedAt !== "string") {
		throw new SchemaError("updatedAt must be a string");
	}
	for (const field of ["startedAt", "finishedAt"]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			typeof data[field] !== "string"
		) {
			throw new SchemaError(`${field} must be a string or null`);
		}
	}
	if (!Array.isArray(data.orderedTaskIds)) {
		throw new SchemaError("orderedTaskIds must be an array");
	}
	if (data.initialHostFingerprint == null) {
		throw new SchemaError("initialHostFingerprint is required");
	}
	if (
		data.workerPid !== undefined &&
		data.workerPid !== null &&
		(!Number.isSafeInteger(data.workerPid) || data.workerPid <= 0)
	) {
		throw new SchemaError("workerPid must be a positive integer or null");
	}
	if (typeof data.workerNonce !== "string") {
		throw new SchemaError("workerNonce must be a string");
	}
	if (typeof data.lastLeaseHeartbeat !== "string") {
		throw new SchemaError("lastLeaseHeartbeat must be a string");
	}
	if (
		typeof data.lastEventSequence !== "number" ||
		!Number.isInteger(data.lastEventSequence)
	) {
		throw new SchemaError("lastEventSequence must be an integer");
	}
	if (
		data.minimumOutcomeReaderVersion !== undefined &&
		(!Number.isSafeInteger(data.minimumOutcomeReaderVersion) ||
			data.minimumOutcomeReaderVersion < 1)
	) {
		throw new SchemaError(
			"minimumOutcomeReaderVersion must be a positive integer",
		);
	}
	if (
		(data.minimumOutcomeReaderVersion ?? 1) > SUPPORTED_OUTCOME_READER_VERSION
	) {
		throw new SchemaError(
			"persisted minimum outcome reader version is unsupported",
		);
	}
	if (
		data.outcomeWriterEpoch !== undefined &&
		data.outcomeWriterEpoch !== null &&
		(typeof data.outcomeWriterEpoch !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(data.outcomeWriterEpoch))
	) {
		throw new SchemaError("outcomeWriterEpoch is invalid");
	}
	if (data.outcomeRecovery !== undefined && data.outcomeRecovery !== null) {
		const recovery = data.outcomeRecovery;
		if (
			!recovery ||
			typeof recovery !== "object" ||
			Array.isArray(recovery) ||
			Object.keys(recovery).some(
				(key) =>
					![
						"reasonCode",
						"contentHash",
						"automaticRetry",
						"operatorCommand",
					].includes(key),
			) ||
			recovery.reasonCode !== "event_reserve_unavailable" ||
			!DIAGNOSTIC_DIGEST_RE.test(recovery.contentHash ?? "") ||
			recovery.automaticRetry !== false ||
			recovery.operatorCommand !== "switchyard-dispatch recover"
		) {
			throw new SchemaError("outcomeRecovery is invalid");
		}
	}
	if (data.outcomeShadow !== undefined && data.outcomeShadow !== null) {
		try {
			validateShadowEnvelope(data.outcomeShadow);
		} catch {
			throw new SchemaError("outcomeShadow is invalid");
		}
	}
	validateMutationOperations(data.mutationOperations);
	if (
		data.activeTaskStartedAt !== undefined &&
		data.activeTaskStartedAt !== null &&
		typeof data.activeTaskStartedAt !== "number"
	) {
		throw new SchemaError("activeTaskStartedAt must be a number or null");
	}
	for (const field of ["activeTaskElapsedMs", "activeTaskHeartbeatAt"]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			(typeof data[field] !== "number" ||
				!Number.isFinite(data[field]) ||
				data[field] < 0)
		) {
			throw new SchemaError(
				`${field} must be a finite non-negative number or null`,
			);
		}
	}
	if (
		data.activeTaskProcessPhase !== undefined &&
		data.activeTaskProcessPhase !== null &&
		(typeof data.activeTaskProcessPhase !== "string" ||
			data.activeTaskProcessPhase.length > 64 ||
			/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(data.activeTaskProcessPhase))
	) {
		throw new SchemaError(
			"activeTaskProcessPhase must be a safe scalar string or null",
		);
	}
	if (
		data.telemetryWriteFailures !== undefined &&
		(typeof data.telemetryWriteFailures !== "number" ||
			!Number.isInteger(data.telemetryWriteFailures) ||
			data.telemetryWriteFailures < 0)
	) {
		throw new SchemaError(
			"telemetryWriteFailures must be a non-negative integer",
		);
	}
	if (
		data.lastTelemetryWriteFailure !== undefined &&
		data.lastTelemetryWriteFailure !== null &&
		(typeof data.lastTelemetryWriteFailure !== "string" ||
			!TELEMETRY_WRITE_FAILURE_LABELS.has(data.lastTelemetryWriteFailure))
	) {
		throw new SchemaError(
			"lastTelemetryWriteFailure must be a known safe label or null",
		);
	}
	if (
		data.lastCompletionAt !== undefined &&
		data.lastCompletionAt !== null &&
		typeof data.lastCompletionAt !== "number"
	) {
		throw new SchemaError("lastCompletionAt must be a number or null");
	}
	if (
		data.workingContainerName !== undefined &&
		data.workingContainerName !== null &&
		typeof data.workingContainerName !== "string"
	) {
		throw new SchemaError("workingContainerName must be a string or null");
	}
	if (
		data.snapshotStatus !== undefined &&
		data.snapshotStatus !== null &&
		typeof data.snapshotStatus !== "string"
	) {
		throw new SchemaError("snapshotStatus must be a string or null");
	}
	if (
		data.resolvedTargetId !== undefined &&
		data.resolvedTargetId !== null &&
		typeof data.resolvedTargetId !== "string"
	) {
		throw new SchemaError("resolvedTargetId must be a string or null");
	}
	for (const field of ["lastResolvedTargetId"]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			!isSafeTargetId(data[field])
		) {
			throw new SchemaError(`${field} must be a safe target id or null`);
		}
	}
	for (const field of [
		"activeTaskDescriptorHarness",
		"lastTaskDescriptorHarness",
	]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			(typeof data[field] !== "string" || !normalizeProviderName(data[field]))
		) {
			throw new SchemaError(`${field} must be a provider harness or null`);
		}
	}
	for (const field of [
		"activeTaskInvocationDescriptor",
		"lastTaskInvocationDescriptor",
	]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			!isSafeDescriptorReceipt(
				data[field],
				field === "activeTaskInvocationDescriptor"
					? data.activeTaskDescriptorHarness
					: data.lastTaskDescriptorHarness,
			)
		) {
			throw new SchemaError(`${field} contains an invalid descriptor receipt`);
		}
	}
	for (const field of [
		"activeTaskDescriptorIdentity",
		"lastTaskDescriptorIdentity",
	]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			(typeof data[field] !== "string" ||
				!DESCRIPTOR_IDENTITY_RE.test(data[field]))
		) {
			throw new SchemaError(`${field} must be a descriptor identity or null`);
		}
	}
	for (const [descriptorField, identityField] of [
		["activeTaskInvocationDescriptor", "activeTaskDescriptorIdentity"],
		["lastTaskInvocationDescriptor", "lastTaskDescriptorIdentity"],
	]) {
		const descriptor = data[descriptorField];
		const identity = data[identityField];
		if (
			descriptor !== undefined &&
			descriptor !== null &&
			identity !== undefined &&
			identity !== null &&
			descriptor.descriptor_identity !== identity
		) {
			throw new SchemaError(
				`${identityField} does not match ${descriptorField}`,
			);
		}
	}
	if (data.activeTaskInvocationDescriptor) {
		if (!data.activeTaskDescriptorHarness || !data.resolvedTargetId) {
			throw new SchemaError(
				"active descriptor requires descriptor harness and resolvedTargetId",
			);
		}
	}
	if (data.lastTaskInvocationDescriptor) {
		if (!data.lastTaskDescriptorHarness || !data.lastResolvedTargetId) {
			throw new SchemaError(
				"last descriptor requires descriptor harness and lastResolvedTargetId",
			);
		}
	}
	if (
		data.activeTaskInvocationDescriptor &&
		data.resolvedTargetId &&
		data.activeTaskInvocationDescriptor.target_id !== data.resolvedTargetId
	) {
		throw new SchemaError(
			"active descriptor target does not match resolvedTargetId",
		);
	}
	if (
		data.lastTaskInvocationDescriptor &&
		data.lastResolvedTargetId &&
		data.lastTaskInvocationDescriptor.target_id !== data.lastResolvedTargetId
	) {
		throw new SchemaError(
			"last descriptor target does not match lastResolvedTargetId",
		);
	}
	if (
		data.dispatchContractVersion !== undefined &&
		(!Number.isInteger(data.dispatchContractVersion) ||
			data.dispatchContractVersion < 1)
	) {
		throw new SchemaError("dispatchContractVersion must be a positive integer");
	}
	if (data.quarantinedTargetIds !== undefined) {
		if (
			!Array.isArray(data.quarantinedTargetIds) ||
			data.quarantinedTargetIds.some((value) => !isSafeTargetId(value))
		) {
			throw new SchemaError(
				"quarantinedTargetIds must be an array of non-empty strings",
			);
		}
	}
	if (
		data.retryTransitionId !== undefined &&
		(!Number.isInteger(data.retryTransitionId) || data.retryTransitionId < 0)
	) {
		throw new SchemaError("retryTransitionId must be a non-negative integer");
	}
	if (data.retryState !== undefined && data.retryState !== null) {
		const retryState = data.retryState;
		if (
			typeof retryState !== "object" ||
			Array.isArray(retryState) ||
			typeof retryState.taskId !== "string" ||
			!Number.isInteger(retryState.attempt) ||
			(retryState.attempt !== 1 && retryState.attempt !== 2) ||
			typeof retryState.phase !== "string" ||
			(retryState.resolvedTargetId !== undefined &&
				retryState.resolvedTargetId !== null &&
				!isSafeTargetId(retryState.resolvedTargetId))
		) {
			throw new SchemaError("retryState contains invalid retry metadata");
		}
		if (
			retryState.invocationDescriptor !== undefined &&
			retryState.invocationDescriptor !== null &&
			!isSafeDescriptorReceipt(
				retryState.invocationDescriptor,
				retryState.descriptorHarness,
			)
		) {
			throw new SchemaError(
				"retryState contains an invalid descriptor receipt",
			);
		}
		if (
			retryState.invocationDescriptor &&
			(!retryState.descriptorHarness || !retryState.resolvedTargetId)
		) {
			throw new SchemaError(
				"retryState descriptor requires descriptor harness and resolvedTargetId",
			);
		}
		if (
			retryState.descriptorIdentity !== undefined &&
			retryState.descriptorIdentity !== null &&
			(!DESCRIPTOR_IDENTITY_RE.test(retryState.descriptorIdentity) ||
				retryState.invocationDescriptor?.descriptor_identity !==
					retryState.descriptorIdentity)
		) {
			throw new SchemaError("retryState descriptor identity is invalid");
		}
		if (
			retryState.invocationDescriptor &&
			retryState.resolvedTargetId &&
			retryState.invocationDescriptor.target_id !== retryState.resolvedTargetId
		) {
			throw new SchemaError(
				"retryState descriptor target does not match target",
			);
		}
	}
	for (const field of ["retryAttempts", "retryTransitions"]) {
		if (data[field] === undefined) continue;
		if (!Array.isArray(data[field])) {
			throw new SchemaError(`${field} must be an array`);
		}
		for (const entry of data[field]) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new SchemaError(`${field} contains invalid retry metadata`);
			}
			if (
				entry.invocationDescriptor !== undefined &&
				entry.invocationDescriptor !== null &&
				!isSafeDescriptorReceipt(
					entry.invocationDescriptor,
					entry.descriptorHarness,
				)
			) {
				throw new SchemaError(
					`${field} contains an invalid descriptor receipt`,
				);
			}
			if (
				entry.invocationDescriptor &&
				(!entry.descriptorHarness || !entry.resolvedTargetId)
			) {
				throw new SchemaError(
					`${field} descriptor requires descriptor harness and resolvedTargetId`,
				);
			}
			if (
				entry.descriptorIdentity !== undefined &&
				entry.descriptorIdentity !== null &&
				(!DESCRIPTOR_IDENTITY_RE.test(entry.descriptorIdentity) ||
					entry.invocationDescriptor?.descriptor_identity !==
						entry.descriptorIdentity)
			) {
				throw new SchemaError(`${field} descriptor identity is invalid`);
			}
			if (
				entry.invocationDescriptor &&
				entry.resolvedTargetId &&
				entry.invocationDescriptor.target_id !== entry.resolvedTargetId
			) {
				throw new SchemaError(
					`${field} descriptor target does not match target`,
				);
			}
		}
	}
	for (const field of ["snapshotMtime", "snapshotAgeMsAtRoute"]) {
		if (
			data[field] !== undefined &&
			data[field] !== null &&
			(typeof data[field] !== "number" || !Number.isFinite(data[field]))
		) {
			throw new SchemaError(`${field} must be a finite number or null`);
		}
	}
	if (
		data.lastFailure !== undefined &&
		data.lastFailure !== null &&
		!isPersistentFailureMetadata(data.lastFailure)
	) {
		throw new SchemaError("lastFailure contains invalid persistent metadata");
	}
	if (
		data.failureDetails !== undefined &&
		data.failureDetails !== null &&
		!isPersistentFailureDetails(data.failureDetails)
	) {
		throw new SchemaError(
			"failureDetails contains invalid persistent metadata",
		);
	}
	if (
		data.cleanupFailure !== undefined &&
		data.cleanupFailure !== null &&
		!isCleanupFailureMetadata(data.cleanupFailure)
	) {
		throw new SchemaError(
			"cleanupFailure contains invalid persistent metadata",
		);
	}
	if (
		data.lastReviewResult !== undefined &&
		data.lastReviewResult !== null &&
		!isReviewResult(data.lastReviewResult)
	) {
		throw new SchemaError("lastReviewResult contains invalid review metadata");
	}
	if (
		data.terminalizedBy !== undefined &&
		data.terminalizedBy !== "worker" &&
		data.terminalizedBy !== "dead_worker_recovery"
	) {
		throw new SchemaError("terminalizedBy must be a known terminal writer");
	}
	if (data.worktree !== undefined && data.worktree !== null) {
		validateWorktreeRecord(data.worktree);
	}
	if (data.schemaVersion === CURRENT_SCHEMA_VERSION) {
		if (
			typeof data.queueIdentity !== "string" ||
			!/^[a-f0-9]{64}$/.test(data.queueIdentity)
		) {
			throw new SchemaError("queueIdentity must be a sha256 hex string");
		}
		if (typeof data.projectRevision !== "string" || !data.projectRevision) {
			throw new SchemaError("projectRevision must be a non-empty string");
		}
		const options = data.runOptions;
		if (
			options === null ||
			typeof options !== "object" ||
			Array.isArray(options)
		) {
			throw new SchemaError("runOptions must be an object");
		}
		if (options.version !== 1) {
			throw new SchemaError("runOptions.version must be 1");
		}
		if (
			(options.maxTasks !== null &&
				(!Number.isInteger(options.maxTasks) || options.maxTasks < 1)) ||
			typeof options.stopOnFailure !== "boolean" ||
			(options.checkpointPath !== null &&
				typeof options.checkpointPath !== "string") ||
			(options.platform !== undefined &&
				!["docker", "macos"].includes(options.platform))
		) {
			throw new SchemaError("runOptions contains invalid scalar fields");
		}
		for (const field of ["onlyProviders", "excludeProviders", "taskIds"]) {
			if (
				!Array.isArray(options[field]) ||
				options[field].some((value) => typeof value !== "string")
			) {
				throw new SchemaError(
					`runOptions.${field} must be an array of strings`,
				);
			}
		}
	}
}

export { isCleanupFailureMetadata, validateRun, validateWorktreeRecord };
