import { randomUUID } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	CHECKPOINT_IDENTITY_CODES,
	CHECKPOINT_IDENTITY_REMEDIES,
	CheckpointIdentityError,
	IntegrationStateUnknownError,
} from "./checkpoint-errors.mjs";
import {
	acquireCheckpointLease,
	assertCheckpointLease,
	checkpointCanRelease,
	checkpointOwnerFor,
	createEmptyCheckpoint,
	getCheckpointPath,
	isCheckpointOwner,
	releaseCheckpointLease,
	releaseCheckpointOwnership,
	sameCheckpointOwner,
	validateCheckpointTaskBases,
} from "./checkpoint-store.mjs";
import {
	CHECKPOINT_VERSION,
	HISTORICAL_CHECKPOINT_VERSION,
	stableStringify,
} from "./constants.mjs";
import {
	validateBaselineCheckResults,
	validateRetryDescriptorEvidence,
} from "./quick-checks.mjs";
import { parseTaskQueue } from "./task-queue.mjs";

const CHECKPOINT_OPTION_DIMENSIONS = Object.freeze([
	"taskIds",
	"excludeProviders",
	"onlyProviders",
	"maxTasks",
	"stopOnFailure",
]);
function checkpointOptionDimensions(stored, expected) {
	if (
		!stored ||
		!expected ||
		typeof stored !== "object" ||
		typeof expected !== "object"
	)
		return [];
	return CHECKPOINT_OPTION_DIMENSIONS.filter(
		(field) =>
			stableStringify(stored[field]) !== stableStringify(expected[field]),
	);
}
function validateCheckpointV3(
	parsed,
	tasksFilePath,
	expected,
	checkpointPath = null,
) {
	if (
		!Array.isArray(parsed.completedTaskIds) ||
		!Array.isArray(parsed.results) ||
		!Number.isInteger(parsed.revision) ||
		parsed.revision < 0 ||
		!isCheckpointOwner(parsed.owner) ||
		typeof parsed.ownershipReleased !== "boolean" ||
		!parsed.taskAttempts ||
		typeof parsed.taskAttempts !== "object" ||
		Array.isArray(parsed.taskAttempts) ||
		!parsed.integrationIntents ||
		typeof parsed.integrationIntents !== "object" ||
		Array.isArray(parsed.integrationIntents)
	) {
		throw new Error("checkpoint v3 has an invalid fencing record");
	}
	for (const [taskId, attempt] of Object.entries(parsed.taskAttempts)) {
		if (!taskId || !Number.isInteger(attempt) || attempt < 0)
			throw new Error("checkpoint v3 has invalid task attempts");
	}
	for (const [taskId, intent] of Object.entries(parsed.integrationIntents)) {
		const operation = intent?.operation;
		const expectedReceiptHash =
			expected?.runOptions?.dirtyOverlayReceiptHash ?? null;
		if (
			!intent ||
			!operation ||
			operation.taskId !== taskId ||
			typeof operation.runId !== "string" ||
			!operation.runId ||
			!Number.isInteger(operation.attempt) ||
			operation.attempt < 1 ||
			parsed.taskAttempts[taskId] !== operation.attempt ||
			typeof operation.baseTree !== "string" ||
			!/^[a-f0-9]{40,64}$/.test(operation.baseTree) ||
			typeof operation.patchHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(operation.patchHash) ||
			!Array.isArray(operation.paths) ||
			operation.paths.some((path) => typeof path !== "string" || !path) ||
			(operation.dirtyOverlayReceiptHash != null &&
				!/^[a-f0-9]{64}$/u.test(operation.dirtyOverlayReceiptHash)) ||
			(expectedReceiptHash != null &&
				operation.dirtyOverlayReceiptHash !== expectedReceiptHash) ||
			!["pending", "completed"].includes(intent.status) ||
			typeof intent.beforeState !== "string" ||
			!/^[a-f0-9]{64}$/.test(intent.beforeState) ||
			(intent.status === "completed" &&
				(typeof intent.afterState !== "string" ||
					!/^[a-f0-9]{64}$/.test(intent.afterState)))
		) {
			throw new Error("checkpoint v3 has invalid integration intent");
		}
	}
	if (
		parsed.providerAttemptAllocations !== undefined &&
		(!Array.isArray(parsed.providerAttemptAllocations) ||
			parsed.providerAttemptAllocations.some(
				(entry) =>
					!entry ||
					typeof entry.taskId !== "string" ||
					!["quota_fallback", "completion_correction", "check_repair"].includes(
						entry.reason,
					) ||
					!["allocated", "running", "result_recorded"].includes(entry.state) ||
					(["completion_correction", "check_repair"].includes(entry.reason) &&
						(typeof entry.deadline !== "string" ||
							!Number.isFinite(Date.parse(entry.deadline)) ||
							typeof entry.descriptorIdentity !== "string" ||
							!entry.descriptorIdentity ||
							typeof entry.workspaceId !== "string" ||
							!entry.workspaceId ||
							typeof entry.baseTree !== "string" ||
							!/^[a-f0-9]{40,64}$/.test(entry.baseTree) ||
							typeof entry.attemptId !== "string" ||
							!entry.attemptId ||
							(entry.scopeIdentity !== undefined &&
								!/^[a-f0-9]{64}$/u.test(entry.scopeIdentity)) ||
							(entry.reason === "check_repair" &&
								!/^[a-f0-9]{64}$/u.test(entry.scopeIdentity)))),
			))
	) {
		throw new Error("checkpoint v3 has invalid provider attempt allocations");
	}
	if (
		parsed.results.some(
			(entry) =>
				entry?.baselineCheckReceipt !== undefined ||
				entry?.providerReliability !== undefined ||
				entry?.failurePhase === "baseline" ||
				["baseline_check_failed", "baseline_mutation"].includes(entry?.result),
		)
	)
		validateBaselineCheckResults(
			parsed.results,
			parseTaskQueue(readFileSync(tasksFilePath, "utf8")),
		);
	if (parsed.tasksFilePath !== tasksFilePath) {
		throw new CheckpointIdentityError(
			CHECKPOINT_IDENTITY_CODES.TASK_FILE_MISMATCH,
			CHECKPOINT_IDENTITY_REMEDIES[
				CHECKPOINT_IDENTITY_CODES.TASK_FILE_MISMATCH
			],
			{ checkpointPath, dimensions: ["tasksFilePath"] },
		);
	}
	if (
		expected?.queueIdentity &&
		parsed.queueIdentity !== expected.queueIdentity
	) {
		throw new CheckpointIdentityError(
			CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH,
			CHECKPOINT_IDENTITY_REMEDIES[
				CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH
			],
			{
				checkpointPath,
				dimensions: checkpointOptionDimensions(
					parsed.runOptions,
					expected.runOptions,
				).concat(
					checkpointOptionDimensions(parsed.runOptions, expected.runOptions)
						.length === 0
						? ["queueIdentity"]
						: [],
				),
			},
		);
	}
	if (
		expected?.runOptions &&
		stableStringify(parsed.runOptions) !== stableStringify(expected.runOptions)
	) {
		throw new CheckpointIdentityError(
			CHECKPOINT_IDENTITY_CODES.RUN_OPTIONS_MISMATCH,
			CHECKPOINT_IDENTITY_REMEDIES[
				CHECKPOINT_IDENTITY_CODES.RUN_OPTIONS_MISMATCH
			],
			{
				checkpointPath,
				dimensions: checkpointOptionDimensions(
					parsed.runOptions,
					expected.runOptions,
				),
			},
		);
	}
	if (
		expected?.checkpointOwner &&
		!sameCheckpointOwner(parsed.owner, expected.checkpointOwner)
	)
		throw new Error("checkpoint owner displaced");
	return parsed;
}
function assertLegacyCheckpointHasNoPendingOperation(parsed) {
	const completed = new Set(parsed.completedTaskIds ?? []);
	if (
		parsed.retryState != null ||
		Object.keys(parsed.taskBases ?? {}).some(
			(taskId) => !completed.has(taskId),
		) ||
		Object.keys(parsed.taskAttempts ?? {}).some(
			(taskId) => !completed.has(taskId),
		) ||
		Object.keys(parsed.integrationIntents ?? {}).length > 0
	)
		throw new IntegrationStateUnknownError();
}
export function migrateLegacyCheckpoint(
	checkpointPath,
	tasksFilePath,
	expected,
	{ owner, provenNeverStarted = false, beforePublish } = {},
) {
	if (!provenNeverStarted) throw new IntegrationStateUnknownError();
	const lease = acquireCheckpointLease(checkpointPath, owner);
	try {
		const before = readFileSync(checkpointPath, "utf8");
		const legacy = loadCheckpoint(checkpointPath, tasksFilePath, expected);
		if (![1, 2].includes(legacy.version))
			throw new Error("checkpoint is not legacy");
		const completed = new Set(legacy.completedTaskIds);
		if (
			Object.keys(legacy.taskBases ?? {}).some((id) => !completed.has(id)) ||
			Object.keys(legacy.integrationIntents ?? {}).length > 0 ||
			Object.keys(legacy.taskAttempts ?? {}).some((id) => !completed.has(id))
		)
			throw new IntegrationStateUnknownError();
		assertCheckpointLease(lease, checkpointPath, owner);
		if (readFileSync(checkpointPath, "utf8") !== before)
			throw new Error("checkpoint changed during migration");
		const migrated = {
			...legacy,
			version: CHECKPOINT_VERSION,
			revision: 1,
			owner: structuredClone(owner),
			ownershipReleased: false,
			taskBases: structuredClone(legacy.taskBases ?? {}),
			taskAttempts: {},
			integrationIntents: {},
		};
		validateCheckpointTaskBases(migrated);
		validateCheckpointV3(migrated, tasksFilePath, {
			...expected,
			checkpointOwner: owner,
		});
		const tmpPath = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(migrated, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		try {
			beforePublish?.({ lease, tmpPath });
			assertCheckpointLease(lease, checkpointPath, owner);
			if (readFileSync(checkpointPath, "utf8") !== before)
				throw new Error("checkpoint changed during migration");
			renameSync(tmpPath, checkpointPath);
		} catch (error) {
			try {
				unlinkSync(tmpPath);
			} catch {}
			throw error;
		}
		return migrated;
	} finally {
		releaseCheckpointLease(lease);
	}
}
function releaseCheckpointAfterQueueError(options) {
	const { tasksFilePath, runId = null, dependencies = {} } = options;
	const checkpointPath =
		options.checkpointPath ?? getCheckpointPath(tasksFilePath);
	if (!existsSync(checkpointPath)) return;
	const checkpoint = loadCheckpoint(checkpointPath, tasksFilePath);
	if (checkpoint.ownershipReleased || !checkpointCanRelease(checkpoint)) return;
	const owner = checkpointOwnerFor(
		checkpointPath,
		runId ?? checkpoint.queueIdentity,
		dependencies.checkpointOwner,
	);
	if (!sameCheckpointOwner(checkpoint.owner, owner)) return;
	releaseCheckpointOwnership(checkpointPath, checkpoint);
}
function reportCheckpointReleaseFailure(options) {
	try {
		releaseCheckpointAfterQueueError(options);
	} catch {
		options.dependencies?.onStatus?.({
			phase: "cleanup",
			event: "checkpoint_release_failed",
			status: "Checkpoint ownership release failed",
		});
	}
}
export function claimCheckpointOwnership(
	checkpointPath,
	tasksFilePath,
	expected,
	owner,
) {
	const lease = acquireCheckpointLease(checkpointPath, owner);
	try {
		const raw = readFileSync(checkpointPath, "utf8");
		const disk = JSON.parse(raw);
		validateRetryDescriptorEvidence(disk);
		validateCheckpointTaskBases(disk);
		validateCheckpointV3(disk, tasksFilePath, expected);
		if (!disk.ownershipReleased || !checkpointCanRelease(disk))
			throw new Error("checkpoint owner displaced");
		const claimed = {
			...disk,
			owner: structuredClone(owner),
			ownershipReleased: false,
			revision: disk.revision + 1,
		};
		const tmpPath = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(claimed, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		try {
			assertCheckpointLease(lease, checkpointPath, owner);
			if (readFileSync(checkpointPath, "utf8") !== raw)
				throw new Error("checkpoint revision changed during claim");
			renameSync(tmpPath, checkpointPath);
		} catch (error) {
			try {
				unlinkSync(tmpPath);
			} catch {}
			throw error;
		}
		return claimed;
	} finally {
		releaseCheckpointLease(lease);
	}
}
export function loadCheckpoint(checkpointPath, tasksFilePath, expected = null) {
	let raw;
	try {
		raw = readFileSync(checkpointPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") {
			return createEmptyCheckpoint(tasksFilePath, expected ?? {}); // no checkpoint yet
		}
		throw new Error(
			`checkpoint file exists but is unreadable, refusing to silently discard ` +
				`completed-task history: ${checkpointPath}`,
		);
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`checkpoint file exists but is not valid JSON, refusing to silently ` +
				`discard completed-task history: ${checkpointPath} (${error.message})`,
		);
	}

	if (parsed?.version === CHECKPOINT_VERSION) {
		validateRetryDescriptorEvidence(parsed);
		validateCheckpointTaskBases(parsed);
		return validateCheckpointV3(
			parsed,
			tasksFilePath,
			expected,
			checkpointPath,
		);
	}

	if (
		parsed?.version === 2 &&
		Array.isArray(parsed.completedTaskIds) &&
		Array.isArray(parsed.results)
	) {
		if (parsed.tasksFilePath !== tasksFilePath) {
			throw new CheckpointIdentityError(
				CHECKPOINT_IDENTITY_CODES.TASK_FILE_MISMATCH,
				CHECKPOINT_IDENTITY_REMEDIES[
					CHECKPOINT_IDENTITY_CODES.TASK_FILE_MISMATCH
				],
				{ checkpointPath, dimensions: ["tasksFilePath"] },
			);
		}
		if (!parsed.queueIdentity || typeof parsed.queueIdentity !== "string") {
			throw new CheckpointIdentityError(
				CHECKPOINT_IDENTITY_CODES.MISSING_QUEUE_IDENTITY,
				CHECKPOINT_IDENTITY_REMEDIES[
					CHECKPOINT_IDENTITY_CODES.MISSING_QUEUE_IDENTITY
				],
				{ checkpointPath, dimensions: ["queueIdentity"] },
			);
		}
		if (
			expected?.queueIdentity &&
			parsed.queueIdentity !== expected.queueIdentity
		) {
			throw new CheckpointIdentityError(
				CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH,
				CHECKPOINT_IDENTITY_REMEDIES[
					CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH
				],
				{
					checkpointPath,
					dimensions: checkpointOptionDimensions(
						parsed.runOptions,
						expected.runOptions,
					).concat(
						checkpointOptionDimensions(parsed.runOptions, expected.runOptions)
							.length === 0
							? ["queueIdentity"]
							: [],
					),
				},
			);
		}
		if (
			expected?.runOptions &&
			stableStringify(parsed.runOptions) !==
				stableStringify(expected.runOptions)
		) {
			throw new CheckpointIdentityError(
				CHECKPOINT_IDENTITY_CODES.RUN_OPTIONS_MISMATCH,
				CHECKPOINT_IDENTITY_REMEDIES[
					CHECKPOINT_IDENTITY_CODES.RUN_OPTIONS_MISMATCH
				],
				{
					checkpointPath,
					dimensions: checkpointOptionDimensions(
						parsed.runOptions,
						expected.runOptions,
					),
				},
			);
		}
		validateRetryDescriptorEvidence(parsed);
		validateCheckpointTaskBases({
			...parsed,
			taskBases: parsed.taskBases ?? {},
		});
		assertLegacyCheckpointHasNoPendingOperation(parsed);
		return parsed;
	}

	if (
		parsed?.version === HISTORICAL_CHECKPOINT_VERSION &&
		Array.isArray(parsed.completedTaskIds) &&
		Array.isArray(parsed.results)
	) {
		if (expected?.queueIdentity) {
			throw new CheckpointIdentityError(
				CHECKPOINT_IDENTITY_CODES.HISTORICAL_CHECKPOINT,
				CHECKPOINT_IDENTITY_REMEDIES[
					CHECKPOINT_IDENTITY_CODES.HISTORICAL_CHECKPOINT
				],
				{ checkpointPath, dimensions: ["checkpointVersion"] },
			);
		}
		validateRetryDescriptorEvidence(parsed);
		assertLegacyCheckpointHasNoPendingOperation(parsed);
		return parsed;
	}

	throw new Error(
		`checkpoint file exists but has an unexpected shape, refusing to ` +
			`silently discard completed-task history: ${checkpointPath}`,
	);
}
export { reportCheckpointReleaseFailure, validateCheckpointV3 };
