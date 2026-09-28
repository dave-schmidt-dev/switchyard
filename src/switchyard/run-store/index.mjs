import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	appendFile,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	isPersistentFailureMetadata,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { createProgressSnapshot } from "../adapter/provider-lifecycle.mjs";
import {
	validateIdentifier,
	validateInvocationArgs,
	validateModelArg,
} from "../adapter/shell-safety.mjs";
import {
	isReviewResult,
	sanitizeReviewResult,
} from "../diagnostics/review-result.mjs";
import {
	createMutationIntent,
	executeMutation,
} from "../lifecycle/mutation-protocol.mjs";
import { projectOutcomeReader } from "../outcome/projection.mjs";
import {
	mergeOutcomeShadow,
	projectOutcomeShadow,
	validateShadowEnvelope,
} from "../outcome/shadow.mjs";

export {
	projectCheckpointOutcome,
	projectOutcomeReader,
} from "../outcome/projection.mjs";
export {
	mergeOutcomeShadow,
	projectOutcomeShadow,
	validateShadowEnvelope,
} from "../outcome/shadow.mjs";

import {
	createOversizeRejectionFact,
	isOutcomeEvent,
	OUTCOME_EVENT_MAX_BYTES,
	OUTCOME_FILE_MAX_BYTES,
	OUTCOME_FILE_MAX_LINES,
	OUTCOME_STAGES,
	SUPPORTED_OUTCOME_READER_VERSION,
	validateOutcomeEvent,
} from "../outcome/schema.mjs";
import {
	getInvocationDescriptorIdentity,
	normalizeProviderName,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import { classifyRunLiveness } from "./run-liveness.mjs";

export {
	LockError,
	RevisionError,
	SchemaError,
	VALID_WORKTREE_STATES,
	VmAdmissionPermissionDeniedError,
	VmAdmissionStorageError,
	VmAdmissionUnavailableError,
	VmSlotUnavailableError,
};

import "./errors.mjs";
import "./constants.mjs";
import "./receipt-validation.mjs";
import "./validate-run.mjs";
import "./run-records.mjs";
import "./vm-slots.mjs";
import "./project-lock-files.mjs";
import "./run-updates.mjs";
import {
	APPROVED_EVENT_KEYS,
	CHECKPOINT_ARTIFACT_MAX_BYTES,
	CHECKPOINT_ARTIFACT_MAX_ENTRIES,
	CHECKPOINT_ARTIFACT_MAX_FILE_BYTES,
	DEFAULT_LEASE_AGE_MS,
	EVENT_RESERVE_BYTES,
	locksRoot,
	MAX_DIAGNOSTIC_ARTIFACT_BYTES,
	quarantineRoot,
	ROUTE_HEALTH_DEFERRED_RESULT,
	runsRoot,
	SUCCESS_RESULTS,
	VALID_WORKTREE_STATES,
} from "./constants.mjs";
import {
	LockError,
	RevisionError,
	RUN_ID_RE,
	SchemaError,
	VmAdmissionPermissionDeniedError,
	VmAdmissionStorageError,
	VmAdmissionUnavailableError,
	VmSlotUnavailableError,
	validateRunId,
} from "./errors.mjs";
import {
	cwdDerivedProjectLockPath,
	lockFilePath,
	moveProjectLockPathToClaim,
	parseLegacyProjectLockBody,
	parseOwnedProjectLockBody,
	parseProjectLockArtifact,
	parseProjectLockBody,
	parseRecoveryReservation,
	projectLockArtifacts,
	projectLockClaimPath,
	projectLockPath,
	readTextIfPresent,
	recoveryProofMetadata,
	resolveCanonicalProjectPath,
	unlinkBodyMatched,
} from "./project-lock-files.mjs";
import {
	DESCRIPTOR_IDENTITY_RE,
	isSafeDescriptorReceipt,
	ownerOnlyDirectoryStat,
	ownerOnlyRegularFileStat,
	validateRouteHealthBinding,
} from "./receipt-validation.mjs";
import {
	ensureDir,
	getRunRoot,
	readRun,
	resolveDiagnosticArtifact,
	sanitizeForDisplay,
} from "./run-records.mjs";
import {
	enqueueRunMutation,
	inspectEventLog,
	performUpdate,
	readMutationOperation,
	reconcileEventCeilingLocked,
	recordMutationOperation,
	updateRun,
	updateRunWithRetry,
	withEventAppendLock,
} from "./run-updates.mjs";
import { validateRun } from "./validate-run.mjs";
import { vmOwnerIsLive } from "./vm-slots.mjs";

export { sanitizeVmAdmissionError } from "./errors.mjs";
export {
	getStateRoot,
	getVmAdmissionRoot,
	runStoreTesting,
} from "./project-lock-files.mjs";
export {
	createFencingIdentity,
	isSafeTargetId,
} from "./receipt-validation.mjs";
export {
	getRunRoot,
	initializeRun,
	persistDiagnosticArtifact,
	readRun,
	resolveDiagnosticArtifact,
} from "./run-records.mjs";
export {
	advanceState,
	readMutationOperation,
	reconcileEventSequence,
	recordMutationOperation,
	updateRun,
	updateRunWithRetry,
} from "./run-updates.mjs";
export {
	acquireMacosVmSlot,
	acquireVmSlot,
	acquireVmSlotForTest,
	projectVmGateOutcome,
	publishVmGateOutcome,
	releaseMacosVmSlot,
	releaseVmSlot,
	TEST_VM_SLOT_WAIT_INTERVAL_MS,
	TEST_VM_SLOT_WAIT_TIMEOUT_MS,
} from "./vm-slots.mjs";

import "./events.mjs";
import "./project-locks.mjs";
import "./project-lock-claims.mjs";
import "./run-locks.mjs";
import "./evidence.mjs";
import "./outcomes.mjs";
import "./checkpoint-artifacts.mjs";
import "./checkpoint-retention.mjs";
import "./retention.mjs";

export { applyCheckpointArtifactRetention } from "./checkpoint-retention.mjs";
export { createEvent, createStageOutcome } from "./events.mjs";
export {
	readAuthorizedRunEvents,
	readAuthorizedRunEvidence,
	readEvents,
} from "./evidence.mjs";
export {
	activateOutcomeWriter,
	appendOutcomeEvent,
	assertOutcomeWriter,
	createRouteHealthEvent,
	recoverExecutionOutcome,
	recoverMissingExecutionOutcome,
} from "./outcomes.mjs";
export {
	assertProjectLockOwnership,
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
} from "./project-lock-claims.mjs";
export {
	acquireProjectLock,
	isProjectLockHeld,
	isProjectLockOwnedBy,
	releaseCwdDerivedProjectLockIfOwnedBy,
	releaseProjectLock,
	releaseProjectLockIfOwnedBy,
} from "./project-locks.mjs";
export { applyRetention } from "./retention.mjs";
export {
	acquireLaunchLock,
	acquireRunLock,
	isRunLockExpired,
	releaseLaunchLock,
	releaseRunLock,
	renewRunLock,
} from "./run-locks.mjs";
