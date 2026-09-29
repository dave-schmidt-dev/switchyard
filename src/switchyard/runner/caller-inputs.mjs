import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	captureDirtyOverlay,
	ignoredPath,
	readDirtyOverlayReceipt,
	validateDirtyOverlayReceipt,
} from "../lifecycle/index.mjs";
import {
	assertCommittedDeclaredFiles,
	CallerInputValidationError,
	CallerInputValidationUnavailableError,
	CHECKPOINT_IDENTITY_CODES,
	CHECKPOINT_IDENTITY_REMEDIES,
	CheckpointIdentityError,
	getProjectRevision,
	relativeProjectPath,
	TaskSelectionError,
} from "./checkpoint-errors.mjs";
import { loadCheckpoint } from "./checkpoint-load.mjs";
import { getCheckpointPath } from "./checkpoint-store.mjs";
import { normalizeIds, normalizeRunOptions } from "./constants.mjs";
import { planPotentialAttemptTasks } from "./queue-selection.mjs";
import { assertCompletedQuickChecks } from "./quick-checks.mjs";
import { validateProjectFileEntries } from "./task-fields.mjs";
import { computeQueueIdentityFromFile, loadTaskQueue } from "./task-queue.mjs";
export function validateCallerInputs(options = {}) {
	const tasksFilePath = resolve(options.tasksFilePath);
	const projectPath = resolve(options.projectPath);
	const checkpointPath = resolve(
		options.checkpointPath ?? getCheckpointPath(tasksFilePath),
	);
	let tasks;
	const requestedSelection =
		options.runOptions?.taskIds ?? options.taskIds ?? [];
	let selectedTaskIds = [];
	let evaluatedTaskIds = [];
	try {
		tasks = loadTaskQueue(tasksFilePath);
		if (tasks.length === 0) {
			throw new CallerInputValidationError(
				"queue_empty",
				"no tasks parsed from task file — 0 headings matching the required task format",
			);
		}
		selectedTaskIds = normalizeIds(requestedSelection, "task selection");
		const byId = new Map(tasks.map((task) => [task.id, task]));
		const selectedTasks =
			selectedTaskIds.length > 0
				? selectedTaskIds.map((taskId) => {
						const task = byId.get(taskId);
						if (!task) throw new TaskSelectionError(taskId, "unknown-task");
						return task;
					})
				: tasks;
		evaluatedTaskIds = selectedTasks.map((task) => task.id);
		validateProjectFileEntries(selectedTasks, projectPath);
		assertCommittedDeclaredFiles(selectedTasks, projectPath);
	} catch (error) {
		if (error instanceof TaskSelectionError) {
			const rejection = new CallerInputValidationError(
				"task_selection_failed",
				"selected task is not runnable with the current checkpoint",
				{ taskId: error.taskId },
			);
			rejection.selectedTaskIds = selectedTaskIds;
			rejection.evaluatedTaskIds = evaluatedTaskIds;
			throw rejection;
		}
		if (
			error instanceof CallerInputValidationError ||
			error instanceof CallerInputValidationUnavailableError
		) {
			error.selectedTaskIds = selectedTaskIds;
			error.evaluatedTaskIds = evaluatedTaskIds;
			throw error;
		}
		const rejection = new CallerInputValidationError(
			"queue_contract_invalid",
			"task queue, graph, and declared Files entries must be valid",
		);
		// The CLI's legacy text surface may retain the parser's caller-owned
		// diagnostic; JSON validation output deliberately uses `remedy` instead.
		rejection.message = error?.message ?? rejection.message;
		rejection.selectedTaskIds = selectedTaskIds;
		rejection.evaluatedTaskIds = evaluatedTaskIds;
		throw rejection;
	}

	const dirtyOverlay =
		options.dirtyOverlay === true || options.runOptions?.dirtyOverlay === true;
	const receiptPath = dirtyOverlay
		? resolve(
				options.dirtyOverlayReceiptPath ??
					options.runOptions?.dirtyOverlayReceiptPath ??
					`${checkpointPath}.dirty-overlay.json`,
			)
		: null;
	const selection = selectedTaskIds;
	const evaluatedTasks =
		selection.length > 0
			? tasks.filter((task) => selection.includes(task.id))
			: tasks;
	let dirtyOverlayReceipt = null;
	if (dirtyOverlay) {
		const undeclared = evaluatedTasks.find(
			(task) => (task.requiredPaths ?? []).length === 0,
		);
		const paths = [
			...new Set(evaluatedTasks.flatMap((task) => task.requiredPaths ?? [])),
		];
		if (undeclared || paths.length === 0) {
			throw new CallerInputValidationError(
				"dirty_overlay_invalid",
				undeclared
					? `dirty overlay requires exact declared task paths: task ${undeclared.id} declares none`
					: "dirty overlay requires exact declared task paths",
				undeclared ? { taskId: undeclared.id } : {},
			);
		}
		for (const path of [checkpointPath, receiptPath]) {
			const relativePath = relativeProjectPath(projectPath, path);
			if (relativePath !== null && !ignoredPath(projectPath, relativePath)) {
				throw new CallerInputValidationError(
					"dirty_overlay_invalid",
					"dirty overlay state must live outside the project or be ignored",
					{ path: relativePath },
				);
			}
		}
		try {
			if (existsSync(receiptPath)) {
				dirtyOverlayReceipt = readDirtyOverlayReceipt(receiptPath);
				const result = validateDirtyOverlayReceipt(
					projectPath,
					dirtyOverlayReceipt,
					paths,
				);
				if (!result.ok) {
					throw new CallerInputValidationError(
						"dirty_overlay_invalid",
						`${result.reason}; remove the existing receipt to recapture`,
					);
				}
			} else {
				dirtyOverlayReceipt = captureDirtyOverlay(projectPath, paths);
			}
		} catch (error) {
			if (error instanceof CallerInputValidationError) throw error;
			throw new CallerInputValidationError(
				"dirty_overlay_invalid",
				String(error?.message ?? "dirty overlay input is not eligible").slice(
					0,
					512,
				),
			);
		}
	}

	const runOptions = normalizeRunOptions({
		maxTasks: options.runOptions?.maxTasks ?? options.maxTasks,
		checkpointPath,
		stopOnFailure: options.runOptions?.stopOnFailure ?? options.stopOnFailure,
		onlyProviders:
			options.runOptions?.onlyProviders ??
			options.only ??
			options.onlyProviders,
		excludeProviders:
			options.runOptions?.excludeProviders ??
			options.exclude ??
			options.excludeProviders,
		taskIds: selection,
		platform: options.runOptions?.platform ?? options.platform,
		qualificationAttempt:
			options.runOptions?.qualificationAttempt === true ||
			options.qualificationAttempt === true,
		...(dirtyOverlay
			? {
					dirtyOverlay: true,
					dirtyOverlayReceiptPath: receiptPath,
					dirtyOverlayReceiptHash: dirtyOverlayReceipt.receiptHash,
				}
			: {}),
	});
	const projectRevision =
		options.projectRevision ?? getProjectRevision(projectPath);
	let queueIdentity;
	try {
		queueIdentity = computeQueueIdentityFromFile(
			tasksFilePath,
			projectRevision,
			runOptions,
		).queueIdentity;
	} catch {
		throw new CallerInputValidationError(
			"queue_contract_invalid",
			"task queue changed or became unreadable during validation",
		);
	}
	if (
		options.queueIdentity !== null &&
		options.queueIdentity !== undefined &&
		options.queueIdentity !== queueIdentity
	) {
		throw new CheckpointIdentityError(
			CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH,
			CHECKPOINT_IDENTITY_REMEDIES[
				CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH
			],
		);
	}
	let checkpoint;
	try {
		checkpoint = loadCheckpoint(checkpointPath, tasksFilePath, {
			queueIdentity,
			runOptions,
			...(options.checkpointOwner
				? { checkpointOwner: options.checkpointOwner }
				: {}),
		});
	} catch (error) {
		if (error instanceof CheckpointIdentityError) throw error;
		throw new CallerInputValidationError(
			"checkpoint_invalid",
			"checkpoint must be absent or readable, valid, and safe to resume",
		);
	}
	assertCompletedQuickChecks(tasks, checkpoint);
	let potentialAttemptTasks;
	try {
		potentialAttemptTasks = planPotentialAttemptTasks(tasks, checkpoint, {
			selectedTaskIds: runOptions.taskIds,
			maxTasks: runOptions.maxTasks ?? Number.POSITIVE_INFINITY,
			resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
		});
		return {
			tasks,
			selectedTaskIds:
				runOptions.taskIds.length > 0
					? [...runOptions.taskIds]
					: tasks.map((task) => task.id),
			evaluatedTaskIds: [...evaluatedTaskIds],
			checkpoint,
			checkpointPath,
			projectRevision,
			runOptions,
			queueIdentity,
			potentialAttemptTasks,
			dirtyOverlayReceipt,
			dirtyOverlayReceiptPath: receiptPath,
		};
	} catch (error) {
		if (error instanceof TaskSelectionError) {
			throw new CallerInputValidationError(
				"task_selection_failed",
				"selected task is not runnable with the current checkpoint",
				{ taskId: error.taskId },
			);
		}
		throw new CallerInputValidationError(
			"queue_contract_invalid",
			"task queue, graph, and declared Files entries must remain valid",
		);
	}
}
