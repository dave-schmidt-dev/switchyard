import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	checkpointRemediation,
	PERSISTED_DIAGNOSTIC_CODES,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { terminalTransition } from "../outcome/transitions.mjs";
import { createQueueIdentity, normalizeRunOptions } from "./constants.mjs";
export function getProjectRevision(projectPath) {
	try {
		const result = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: projectPath,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return result.status === 0 && result.stdout?.trim()
			? result.stdout.trim()
			: "unknown";
	} catch {
		return "unknown";
	}
}
function isIdentityRequested(options) {
	return (
		options.queueIdentity != null ||
		options.runOptions != null ||
		options.dirtyOverlay === true ||
		(options.taskIds ?? []).length > 0
	);
}
function resolveQueueIdentity(options, tasks) {
	if (!isIdentityRequested(options)) {
		return {
			enabled: false,
			queueIdentity: null,
			runOptions: null,
			projectRevision: null,
		};
	}

	const runOptions = normalizeRunOptions(
		options.runOptions ?? {
			...options,
			checkpointPath: options.checkpointPath,
		},
	);
	const projectRevision =
		options.projectRevision ?? getProjectRevision(options.projectPath);
	const markdown = readFileSync(options.tasksFilePath, "utf8");
	const expectedIdentity = createQueueIdentity({
		tasksFilePath: options.tasksFilePath,
		markdown,
		tasks,
		projectRevision,
		runOptions,
	});

	if (
		options.queueIdentity !== undefined &&
		options.queueIdentity !== expectedIdentity
	) {
		throw new CheckpointIdentityError(
			CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH,
			CHECKPOINT_IDENTITY_REMEDIES[
				CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH
			],
		);
	}

	return {
		enabled: true,
		queueIdentity: expectedIdentity,
		runOptions,
		projectRevision,
	};
}
export const CHECKPOINT_IDENTITY_CODES = Object.freeze({
	TASK_FILE_MISMATCH: "checkpoint_task_file_mismatch",
	MISSING_QUEUE_IDENTITY: "checkpoint_missing_queue_identity",
	QUEUE_IDENTITY_MISMATCH: "checkpoint_queue_identity_mismatch",
	RUN_OPTIONS_MISMATCH: "checkpoint_run_options_mismatch",
	HISTORICAL_CHECKPOINT: "checkpoint_historical_checkpoint",
});
export const CHECKPOINT_IDENTITY_REMEDIES = CHECKPOINT_REMEDIATION_MESSAGES;
export class CheckpointIdentityError extends Error {
	constructor(code, remedy = null, details = {}) {
		const staticRemedy =
			remedy ??
			CHECKPOINT_IDENTITY_REMEDIES[code] ??
			"checkpoint identity mismatch; create a new checkpoint or use an audited migration";
		const actionableRemedy =
			details && (details.checkpointPath || details.dimensions)
				? checkpointRemediation(code, details)
				: staticRemedy;
		super(`checkpoint identity mismatch: ${actionableRemedy}`);
		this.name = "CheckpointIdentityError";
		this.code = code;
		this.reasonCode = code;
		this.diagnosticCode = code;
		this.reason = actionableRemedy;
		this.remedy = actionableRemedy;
		this.changedDimensions = Object.freeze([...(details.dimensions ?? [])]);
		this.freshCheckpointPath = "switchyard-fresh.checkpoint.json";
	}
}
export class CheckpointTaskFileMismatchError extends CheckpointIdentityError {
	constructor(remedy = null) {
		super(CHECKPOINT_IDENTITY_CODES.TASK_FILE_MISMATCH, remedy);
	}
}
export class CheckpointMissingQueueIdentityError extends CheckpointIdentityError {
	constructor(remedy = null) {
		super(CHECKPOINT_IDENTITY_CODES.MISSING_QUEUE_IDENTITY, remedy);
	}
}
export class CheckpointQueueIdentityMismatchError extends CheckpointIdentityError {
	constructor(remedy = null) {
		super(CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH, remedy);
	}
}
export class CheckpointRunOptionsMismatchError extends CheckpointIdentityError {
	constructor(remedy = null) {
		super(CHECKPOINT_IDENTITY_CODES.RUN_OPTIONS_MISMATCH, remedy);
	}
}
export class CheckpointHistoricalCheckpointError extends CheckpointIdentityError {
	constructor(remedy = null) {
		super(CHECKPOINT_IDENTITY_CODES.HISTORICAL_CHECKPOINT, remedy);
	}
}
export class IntegrationStateUnknownError extends Error {
	constructor() {
		super("integration state requires explicit reconciliation");
		this.name = "IntegrationStateUnknownError";
		this.code = "INTEGRATION_STATE_UNKNOWN";
	}
}
export class TaskSelectionError extends Error {
	constructor(taskId, reason) {
		super(`task selection failed: ${reason}`);
		this.name = "TaskSelectionError";
		this.taskId = taskId;
		this.reason = reason;
		this.code = reason;
	}
}
export class CallerInputValidationError extends Error {
	constructor(code, remedy, details = {}) {
		super(remedy);
		this.name = "CallerInputValidationError";
		this.code = code;
		this.remedy = remedy;
		this.taskId = details.taskId ?? null;
		this.path = details.path ?? null;
	}
}
class CallerInputValidationUnavailableError extends Error {
	constructor() {
		super("caller-input validation is unavailable");
		this.name = "CallerInputValidationUnavailableError";
		this.code = "validation_unavailable";
		this.remedy = "restore the local git validation runtime and retry";
	}
}
function relativeProjectPath(projectPath, candidatePath) {
	const root = realpathPathOrSelf(resolve(projectPath));
	const candidate = resolve(candidatePath);
	const parent = realpathPathOrSelf(dirname(candidate));
	const relativePath = relative(
		root,
		join(parent, candidate.split(sep).at(-1)),
	);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return null;
	}
	return relativePath || ".";
}
function realpathPathOrSelf(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
function assertCommittedDeclaredFiles(tasks, projectPath) {
	for (const task of tasks) {
		for (const path of task.requiredPaths ?? []) {
			const candidate = resolve(projectPath, path);
			if (!existsSync(candidate)) continue;
			let stats;
			try {
				stats = lstatSync(candidate);
				if (!stats.isFile() || stats.isSymbolicLink()) {
					throw new CallerInputValidationError(
						"declared_path_unreadable",
						"declared Files entries must be readable regular files",
						{ taskId: task.id, path },
					);
				}
				const descriptor = openSync(
					candidate,
					fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
				);
				closeSync(descriptor);
			} catch (error) {
				if (error instanceof CallerInputValidationError) throw error;
				throw new CallerInputValidationError(
					"declared_path_unreadable",
					"declared Files entries must be readable regular files",
					{ taskId: task.id, path },
				);
			}
			// A host-only file cannot be seeded by `git archive HEAD`; reject it
			// before a VM/provider boundary. A launcher failure is host/runtime
			// unavailability, not evidence that the path is absent from HEAD.
			const committed = spawnSync("git", ["cat-file", "-e", `HEAD:${path}`], {
				cwd: projectPath,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (committed.error || committed.status === null) {
				throw new CallerInputValidationUnavailableError();
			}
			if (committed.status !== 0) {
				throw new CallerInputValidationError(
					"declared_path_not_committed",
					"existing declared Files entries must be visible from committed HEAD",
					{ taskId: task.id, path },
				);
			}
		}
	}
}
function persistedDiagnosticCodeOf(error) {
	if (!error || typeof error !== "object") return null;
	for (const candidate of [
		error.diagnosticCode,
		error.failure?.diagnosticCode,
		error.code,
	]) {
		if (PERSISTED_DIAGNOSTIC_CODES.includes(candidate)) return candidate;
	}
	return null;
}
export class QueueCleanupError extends Error {
	constructor(queueResult = null, inFlightError = null) {
		super("Async queue cleanup failed; recovery is required.");
		this.name = "QueueCleanupError";
		this.code = "recovery_incomplete";
		this.failure = sanitizeFailureMetadata({
			result: "unknown_failure",
			errorKind: "unknown_failure",
			diagnosticCode:
				persistedDiagnosticCodeOf(inFlightError) ?? "recovery_incomplete",
			failurePhase: "terminal_reconciliation",
		});
		this.terminalSummary = terminalTransition({
			totalTasks: queueResult?.totalTasks,
			runnableTasks: queueResult?.runnableTasks,
			processedTasks: queueResult?.processedTasks,
			completedTaskIds: queueResult?.completedTaskIds,
			deferredTaskIds: queueResult?.deferredTaskIds,
			failedCount: Array.isArray(queueResult?.results)
				? queueResult.results.filter((result) => !result.success).length
				: null,
		}).terminalSummary;
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
	assertCommittedDeclaredFiles,
	CallerInputValidationUnavailableError,
	relativeProjectPath,
	resolveQueueIdentity,
	sleep,
};
