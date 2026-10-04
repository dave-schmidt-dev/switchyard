export {
	projectCheckpointOutcome,
	projectOutcomeReader,
} from "../outcome/projection.mjs";
export {
	mergeOutcomeShadow,
	projectOutcomeShadow,
	validateShadowEnvelope,
} from "../outcome/shadow.mjs";

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
import { VALID_WORKTREE_STATES } from "./constants.mjs";
import {
	LockError,
	RevisionError,
	SchemaError,
	VmAdmissionPermissionDeniedError,
	VmAdmissionStorageError,
	VmAdmissionUnavailableError,
	VmSlotUnavailableError,
} from "./errors.mjs";

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
