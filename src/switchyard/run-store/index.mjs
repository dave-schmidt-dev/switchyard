export { projectOutcomeReader } from "../outcome/projection.mjs";

export { LockError, RevisionError, SchemaError, VALID_WORKTREE_STATES };

import "./errors.mjs";
import "./constants.mjs";
import "./receipt-validation.mjs";
import "./validate-run.mjs";
import "./run-records.mjs";
import "./project-lock-files.mjs";
import "./run-updates.mjs";
import { VALID_WORKTREE_STATES } from "./constants.mjs";
import { LockError, RevisionError, SchemaError } from "./errors.mjs";

export {
	getStateRoot,
	runStoreTesting,
} from "./project-lock-files.mjs";
export {
	createFencingIdentity,
	isSafeTargetId,
} from "./receipt-validation.mjs";
export {
	getRunRoot,
	initializeRun,
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

import "./events.mjs";
import "./project-locks.mjs";
import "./project-lock-claims.mjs";
import "./evidence.mjs";
import "./outcomes.mjs";

export { createEvent, createStageOutcome } from "./events.mjs";
export {
	readAuthorizedRunEvents,
	readAuthorizedRunEvidence,
	readEvents,
} from "./evidence.mjs";
export { appendOutcomeEvent, createRouteHealthEvent } from "./outcomes.mjs";
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
