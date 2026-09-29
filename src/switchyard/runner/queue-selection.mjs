import { TaskSelectionError } from "./checkpoint-errors.mjs";
import { saveCheckpoint } from "./checkpoint-store.mjs";
import {
	KNOWN_TASK_STATUSES,
	normalizeIds,
	RUNNABLE_TASK_STATUSES,
} from "./constants.mjs";
import { validateTaskGraph } from "./task-queue.mjs";
export function validateTaskSelection(
	tasks,
	checkpoint,
	selectedTaskIds,
	options = {},
) {
	const selected = normalizeIds(selectedTaskIds, "task selection");
	if (selected.length === 0) return selected;
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const done = new Set(checkpoint?.completedTaskIds ?? []);
	const resolvedExternalBlockers = new Set(
		options.resolvedExternalBlockers ??
			checkpoint?.resolvedExternalBlockers ??
			[],
	);
	for (const task of tasks) {
		if (
			String(task.status ?? "")
				.trim()
				.toLowerCase() === "done"
		) {
			done.add(task.id);
		}
	}

	for (const taskId of selected) {
		const task = byId.get(taskId);
		if (!task) throw new TaskSelectionError(taskId, "unknown-task");
		const status = String(task.status ?? "")
			.trim()
			.toLowerCase();
		if (done.has(taskId) || status === "done") {
			// An exact selection of a task that is already complete is a
			// terminal no-op. The queue reconciles an `already_complete`
			// result without routing it to a provider.
			continue;
		}
		if (task.executor === "native") {
			throw new TaskSelectionError(taskId, "native-task");
		}
		if (task.executor === "human") {
			throw new TaskSelectionError(taskId, "human-task");
		}
		const unresolvedExternal = (task.externalBlockers ?? []).find(
			(blocker) => !resolvedExternalBlockers.has(blocker),
		);
		if (unresolvedExternal) {
			throw new TaskSelectionError(
				taskId,
				`external-blocked:${unresolvedExternal}`,
			);
		}
		const unresolvedDependency = (task.blockedBy ?? []).find(
			(dependency) => !done.has(dependency) && !selected.includes(dependency),
		);
		if (unresolvedDependency) {
			throw new TaskSelectionError(
				taskId,
				`dependency-blocked:${unresolvedDependency}`,
			);
		}
	}

	return selected;
}
function alreadyCompleteSelectionResults(tasks, checkpoint, selectedTaskIds) {
	const selected = normalizeIds(selectedTaskIds, "task selection");
	if (selected.length === 0) return [];
	const done = new Set(checkpoint?.completedTaskIds ?? []);
	for (const task of tasks) {
		if (
			String(task.status ?? "")
				.trim()
				.toLowerCase() === "done"
		) {
			done.add(task.id);
		}
	}
	return selected
		.filter((taskId) => done.has(taskId))
		.map((taskId) => ({
			taskId,
			success: true,
			provider: null,
			model: null,
			result: "already_complete",
			reason:
				"Task is already successfully complete; no provider dispatch was needed.",
		}));
}
function reconcileAlreadyCompleteSelection(
	checkpoint,
	checkpointPath,
	results,
	selectedTaskIds,
	tasks,
	onResult,
	emitStatus,
	onCheckpointSaved,
) {
	const terminal = alreadyCompleteSelectionResults(
		tasks,
		checkpoint,
		selectedTaskIds,
	);
	if (terminal.length === 0) return;
	let changed = false;
	for (const result of terminal) {
		results.push(result);
		if (!checkpoint.completedTaskIds.includes(result.taskId)) {
			checkpoint.completedTaskIds.push(result.taskId);
			changed = true;
		}
		if (
			!checkpoint.results.some(
				(entry) =>
					entry.taskId === result.taskId && entry.result === "already_complete",
			)
		) {
			checkpoint.results.push({
				taskId: result.taskId,
				provider: null,
				model: null,
				result: result.result,
				success: true,
				timedOut: false,
				partialDiffPath: null,
				reason: result.reason,
				timestamp: new Date().toISOString(),
			});
			changed = true;
		}
		checkpoint.lastTaskId = result.taskId;
		checkpoint.lastUpdatedAt = new Date().toISOString();
		if (onResult) onResult(result);
		if (emitStatus) {
			emitStatus({
				phase: "execution",
				event: "task_completed",
				status: `Task ${result.taskId} already complete; no provider dispatch needed`,
				taskId: result.taskId,
				provider: null,
				model: null,
				result: result.result,
			});
		}
	}
	if (changed) {
		saveCheckpoint(checkpointPath, checkpoint);
		if (onCheckpointSaved) onCheckpointSaved();
	}
}
export function getRunnableTasks(tasks, checkpoint, options = {}) {
	validateTaskGraph(tasks);
	const selectedTaskIds = normalizeIds(
		options.selectedTaskIds ?? options.taskIds ?? [],
		"task selection",
	);
	if (selectedTaskIds.length > 0) {
		validateTaskSelection(tasks, checkpoint, selectedTaskIds, options);
	}
	const done = new Set(checkpoint?.completedTaskIds ?? []);
	for (const task of tasks) {
		if (
			String(task.status ?? "")
				.trim()
				.toLowerCase() === "done"
		) {
			done.add(task.id);
		}
	}
	const excluded = new Set(options.excludedTaskIds ?? []);
	const resolvedExternalBlockers = new Set(
		options.resolvedExternalBlockers ??
			checkpoint?.resolvedExternalBlockers ??
			[],
	);
	const seenIds = new Set();
	const runnable = [];

	for (const task of tasks) {
		if (seenIds.has(task.id)) {
			throw new Error(
				`tasks queue contains a duplicate task id "${task.id}"; refusing to ` +
					`run the same id twice in one pass — fix the malformed tasks file`,
			);
		}
		seenIds.add(task.id);

		const status = String(task.status ?? "")
			.trim()
			.toLowerCase();

		if (!KNOWN_TASK_STATUSES.has(status)) {
			console.error(
				`getRunnableTasks: task "${task.id}" has unrecognized status ` +
					`"${task.status}" (known: ${[...KNOWN_TASK_STATUSES].join(", ")}); ` +
					`excluding it from the run`,
			);
			continue;
		}

		if (!RUNNABLE_TASK_STATUSES.has(status)) {
			continue; // recognized but intentionally not runnable (done, blocked)
		}

		if (done.has(task.id) || excluded.has(task.id)) {
			continue; // already completed per checkpoint
		}

		if (selectedTaskIds.length > 0 && !selectedTaskIds.includes(task.id)) {
			continue;
		}

		if (task.executor === "native" || task.executor === "human") {
			continue;
		}

		if (
			(task.externalBlockers ?? []).some(
				(blocker) => !resolvedExternalBlockers.has(blocker),
			)
		) {
			continue;
		}

		if ((task.blockedBy ?? []).some((dependency) => !done.has(dependency))) {
			continue;
		}

		runnable.push(task);
	}

	return runnable;
}
export function selectNextQueueTask(
	tasks,
	checkpoint,
	{
		selectedTaskIds = [],
		resolvedExternalBlockers,
		excludedTaskIds = [],
		retryTaskId = null,
	} = {},
) {
	const excluded = new Set(excludedTaskIds);
	const task = retryTaskId
		? (tasks.find((candidate) => candidate.id === retryTaskId) ?? null)
		: (getRunnableTasks(tasks, checkpoint, {
				selectedTaskIds,
				resolvedExternalBlockers,
				excludedTaskIds: excluded,
			})[0] ?? null);
	if (!task) {
		return { task: null, retryTaskId: null, excludedTaskIds: [...excluded] };
	}
	if (retryTaskId)
		return { task, retryTaskId: null, excludedTaskIds: [...excluded] };
	excluded.add(task.id);
	return { task, retryTaskId: null, excludedTaskIds: [...excluded] };
}
export function planPotentialAttemptTasks(tasks, checkpoint, options = {}) {
	const maxTasks = options.maxTasks ?? Number.POSITIVE_INFINITY;
	const selectedTaskIds = normalizeIds(
		options.selectedTaskIds ?? options.taskIds ?? [],
		"task selection",
	);
	const simulated = {
		...(checkpoint ?? {}),
		completedTaskIds: [...(checkpoint?.completedTaskIds ?? [])],
		resolvedExternalBlockers: [
			...(options.resolvedExternalBlockers ??
				checkpoint?.resolvedExternalBlockers ??
				[]),
		],
	};
	const planned = [];
	let retryTaskId = checkpoint?.retryState?.taskId ?? null;
	let excludedTaskIds = [];
	while (planned.length < maxTasks) {
		const selection = selectNextQueueTask(tasks, simulated, {
			selectedTaskIds,
			resolvedExternalBlockers: simulated.resolvedExternalBlockers,
			excludedTaskIds,
			retryTaskId,
		});
		const task = selection.task;
		if (!task) break;
		retryTaskId = selection.retryTaskId;
		excludedTaskIds = selection.excludedTaskIds;
		planned.push(task);
		if (!simulated.completedTaskIds.includes(task.id)) {
			simulated.completedTaskIds.push(task.id);
		}
	}
	return planned;
}
const QUEUE_DIAGNOSTIC_REASONS = Object.freeze({
	selectionExplicit: "explicit_task_ids",
	selectionDefault: "queue_default",
	runnable: "provider_eligible_and_unblocked",
	humanGated: "executor_human",
	nativeGated: "executor_native",
	dependencyBlocked: "task_dependency",
	externalBlocked: "external_blocker",
	completed: "queue_status_or_checkpoint",
});
export function deriveQueueDiagnostics(tasks, checkpoint, options = {}) {
	validateTaskGraph(tasks);
	const selectedTaskIds = normalizeIds(
		options.selectedTaskIds ?? options.taskIds ?? [],
		"task selection",
	);
	const selected = new Set(selectedTaskIds);
	const explicitSelection = selected.size > 0;
	const done = new Set(checkpoint?.completedTaskIds ?? []);
	for (const task of tasks) {
		if (
			String(task.status ?? "")
				.trim()
				.toLowerCase() === "done"
		) {
			done.add(task.id);
		}
	}
	const resolvedExternalBlockers = new Set(
		options.resolvedExternalBlockers ??
			checkpoint?.resolvedExternalBlockers ??
			[],
	);
	const considered = (task) => {
		const status = String(task.status ?? "")
			.trim()
			.toLowerCase();
		return (
			(status === "pending" || status === "in progress") &&
			(!explicitSelection || selected.has(task.id))
		);
	};
	const counts = {
		selected: explicitSelection
			? selectedTaskIds.length
			: tasks.filter((task) => {
					const status = String(task.status ?? "")
						.trim()
						.toLowerCase();
					return status === "pending" || status === "in progress";
				}).length,
		runnable: 0,
		humanGated: 0,
		nativeGated: 0,
		dependencyBlocked: 0,
		externalBlocked: 0,
		completed: done.size,
	};

	for (const task of tasks) {
		if (!considered(task)) continue;
		if (task.executor === "human") {
			counts.humanGated += 1;
			continue;
		}
		if (task.executor === "native") {
			counts.nativeGated += 1;
			continue;
		}
		if (
			(task.externalBlockers ?? []).some(
				(blocker) => !resolvedExternalBlockers.has(blocker),
			)
		) {
			counts.externalBlocked += 1;
		}
		if ((task.blockedBy ?? []).some((dependency) => !done.has(dependency))) {
			counts.dependencyBlocked += 1;
		}
		if (
			task.executor !== "native" &&
			task.executor !== "human" &&
			!(task.externalBlockers ?? []).some(
				(blocker) => !resolvedExternalBlockers.has(blocker),
			) &&
			!(task.blockedBy ?? []).some((dependency) => !done.has(dependency))
		) {
			counts.runnable += 1;
		}
	}

	return {
		selected: {
			count: counts.selected,
			reason: explicitSelection
				? QUEUE_DIAGNOSTIC_REASONS.selectionExplicit
				: QUEUE_DIAGNOSTIC_REASONS.selectionDefault,
		},
		runnable: {
			count: counts.runnable,
			reason: QUEUE_DIAGNOSTIC_REASONS.runnable,
		},
		humanGated: {
			count: counts.humanGated,
			reason: QUEUE_DIAGNOSTIC_REASONS.humanGated,
		},
		nativeGated: {
			count: counts.nativeGated,
			reason: QUEUE_DIAGNOSTIC_REASONS.nativeGated,
		},
		dependencyBlocked: {
			count: counts.dependencyBlocked,
			reason: QUEUE_DIAGNOSTIC_REASONS.dependencyBlocked,
		},
		externalBlocked: {
			count: counts.externalBlocked,
			reason: QUEUE_DIAGNOSTIC_REASONS.externalBlocked,
		},
		completed: {
			count: counts.completed,
			reason: QUEUE_DIAGNOSTIC_REASONS.completed,
		},
	};
}
export { reconcileAlreadyCompleteSelection };
