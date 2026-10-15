/**
 * Typed map of every registered detail field. The run.json failure sanitizer
 * and the failure-log record derive their allowlists from this map, so a
 * detail registered here is persisted without editing those boundaries.
 */
export const DETAIL_FIELD_TYPES = Object.freeze({
	failureReason: "string",
	// Decimal milliseconds bypass the historical 4096-count integer limit.
	deadlineFitEncoding: "string",
	deadlineFitSource: "string",
	deadlineFitDeadlineMs: "string",
	deadlineFitEstimateMs: "string",
	deadlineFitRemainingMs: "string",
	deadlineFitCheckReserveMs: "string",
	deadlineFitMarginMs: "string",
	deadlineFitBudgetMs: "string",
	deadlineFitUnverified: "boolean",
	deadlineFitSplitRecommended: "boolean",

	exitCode: "integer",
	signal: "string",
	timedOut: "boolean",
	cancelled: "boolean",
	// Task 3.12: the closed cancellation origin, registered only for a
	// cancelled outcome and validated against CANCEL_SOURCES at the boundary.
	cancelSource: "string",
	checkIndex: "integer",
	checkIdentity: "string",
	checkEnvironmentSignature: "string",
	outputPath: "string",
	dependencyCheck: "string",
	manifestName: "string",
	// Task 2.8: check-setup and dry-run executable provenance.
	checkSetupStep: "string",
	checkSetupErrorCode: "string",
	checkSetupSyscall: "string",
	checkSetupExecutable: "string",
	checkExecutable: "string",
	hostExecutable: "string",
	diffRejectionCategory: "string",
	diffRejectionCount: "integer",
	diffRejectionRule: "string",
	diffRejectionPaths: "stringArray",
	providerSignature: "string",
	stderrBytes: "integer",
	stdoutBytes: "integer",
	// Precise providerReliability cause code when run.json stores a frozen
	// stand-in in `lastFailure` (see projectRunFailureForDisk).
	causeCode: "string",
	changedFilesUnavailable: "boolean",
});
