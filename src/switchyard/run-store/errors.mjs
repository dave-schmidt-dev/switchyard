const RUN_ID_RE = /^[\w-]+$/;
function validateRunId(runId) {
	if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
		throw new SchemaError("Invalid runId");
	}
}
class RevisionError extends Error {
	constructor(message) {
		super(message);
		this.name = "RevisionError";
	}
}
const LOCK_ERROR_CODES = new Set([
	"LOCK_ERROR",
	"OUTCOME_WRITER_COMPATIBILITY_BLOCKED",
	"OUTCOME_WRITER_LEASE_STALE",
	"RUN_LOCK_HELD",
	"RUN_LOCK_IDENTITY_MISMATCH",
	"LAUNCH_LOCK_HELD",
	"PROJECT_LOCK_HELD",
	"PROJECT_LOCK_RECOVERY_IN_PROGRESS",
	"PROJECT_LOCK_OWNERSHIP_FAILED",
	"PROJECT_LOCK_OWNERSHIP_DISPLACED",
	"PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
	"PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
	"VM_SLOT_UNAVAILABLE",
]);
class LockError extends Error {
	constructor(message, { code = "LOCK_ERROR", holderRunId = null } = {}) {
		super(message);
		this.name = "LockError";
		if (!LOCK_ERROR_CODES.has(code)) {
			throw new TypeError("LockError requires a closed code");
		}
		this.code = code;
		try {
			validateRunId(holderRunId);
			this.holderRunId = holderRunId;
		} catch {
			this.holderRunId = null;
		}
	}
}
class VmSlotUnavailableError extends LockError {
	constructor(holderRuns) {
		const holders = holderRuns.length > 0 ? holderRuns.join(", ") : "unknown";
		super(
			`VM_SLOT_UNAVAILABLE: VM admission capacity is unavailable (held by run ${holders})`,
			{ code: "VM_SLOT_UNAVAILABLE" },
		);
		this.name = "VmSlotUnavailableError";
	}
}
class VmAdmissionUnavailableError extends Error {
	constructor(cause) {
		super("VM admission storage is unavailable", { cause });
		this.name = "VmAdmissionUnavailableError";
		this.code = "VM_ADMISSION_UNAVAILABLE";
	}
}
class VmAdmissionPermissionDeniedError extends Error {
	constructor(cause) {
		super("VM admission storage permission is denied", { cause });
		this.name = "VmAdmissionPermissionDeniedError";
		this.code = "VM_ADMISSION_PERMISSION_DENIED";
	}
}
class VmAdmissionStorageError extends Error {
	constructor(cause) {
		super("VM admission storage I/O failed", { cause });
		this.name = "VmAdmissionStorageError";
		this.code = "VM_ADMISSION_STORAGE_FAILED";
	}
}
const VM_ADMISSION_PERMISSION_CODES = new Set(["EACCES", "EPERM"]);
const VM_ADMISSION_STORAGE_CODES = new Set([
	"EIO",
	"ENOSPC",
	"EDQUOT",
	"EMFILE",
	"ENFILE",
	"EROFS",
]);
export function sanitizeVmAdmissionError(cause) {
	if (
		cause instanceof VmAdmissionUnavailableError ||
		cause instanceof VmAdmissionPermissionDeniedError ||
		cause instanceof VmAdmissionStorageError
	) {
		return cause;
	}
	if (VM_ADMISSION_PERMISSION_CODES.has(cause?.code)) {
		return new VmAdmissionPermissionDeniedError(cause);
	}
	if (VM_ADMISSION_STORAGE_CODES.has(cause?.code)) {
		return new VmAdmissionStorageError(cause);
	}
	return new VmAdmissionUnavailableError(cause);
}
class SchemaError extends Error {
	constructor(message) {
		super(message);
		this.name = "SchemaError";
	}
}

export {
	LOCK_ERROR_CODES,
	LockError,
	RevisionError,
	RUN_ID_RE,
	SchemaError,
	VM_ADMISSION_PERMISSION_CODES,
	VM_ADMISSION_STORAGE_CODES,
	VmAdmissionPermissionDeniedError,
	VmAdmissionStorageError,
	VmAdmissionUnavailableError,
	VmSlotUnavailableError,
	validateRunId,
};
