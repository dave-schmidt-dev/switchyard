// Runner module - host-side runner supervising headless orchestrator
// Reads persisted task queue, drives serial execution, checkpoints for resume.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureDiff as captureAgyDiff, executeAgy } from "../adapter/agy.mjs";
import {
	captureDiff as captureClaudeDiff,
	executeClaude,
} from "../adapter/claude.mjs";
import {
	captureDiff as captureCodexDiff,
	executeCodex,
} from "../adapter/codex.mjs";
import {
	captureDiff as captureCursorDiff,
	executeCursor,
} from "../adapter/cursor.mjs";
import { integrationGate } from "../integrate/index.mjs";
import { recordDispatch } from "../ledger/index.mjs";
import { classifyTask } from "../roster/classifier.mjs";
import { route } from "../router/index.mjs";

const CHECKPOINT_VERSION = 1;
const TERMINAL_JOB_STATES = new Set([
	"done",
	"expired",
	"died",
	"error",
	"missing",
]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCliCommand(command, args) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`orchestrator command failed: ${command} ${args.join(" ")}\n${result.stderr ?? ""}`,
		);
	}

	return result.stdout?.trim() ?? "";
}

function parseJsonPayload(raw) {
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function parseArgsJson(rawArgsJson) {
	if (!rawArgsJson) return [];
	let parsed;
	try {
		parsed = JSON.parse(rawArgsJson);
	} catch {
		throw new Error("SWITCHYARD_ORCHESTRATOR_ARGS_JSON must be valid JSON");
	}

	if (
		!Array.isArray(parsed) ||
		!parsed.every((arg) => typeof arg === "string")
	) {
		throw new Error(
			"SWITCHYARD_ORCHESTRATOR_ARGS_JSON must be a JSON string array",
		);
	}
	return parsed;
}

/**
 * Build a concrete headless orchestrator backed by a CLI process.
 * Protocol:
 * - launch: `<command> ... launch --json <payload>` => JSON or plain job id
 * - status: `<command> ... status <jobId>` => JSON payload with state/expected_by
 * - result: `<command> ... result <jobId>` => JSON payload with success/diff/error
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} [options.baseArgs]
 * @param {(command: string, args: string[]) => string} [options.execFn]
 */
export function createCliOrchestrator(options) {
	const { command, baseArgs = [], execFn = runCliCommand } = options;
	if (!command || typeof command !== "string") {
		throw new Error("createCliOrchestrator requires a command");
	}

	return {
		async launch(payload) {
			const raw = execFn(command, [
				...baseArgs,
				"launch",
				"--json",
				JSON.stringify(payload),
			]);
			const parsed = parseJsonPayload(raw);
			if (typeof parsed === "string") return parsed;
			if (parsed?.job_id) return parsed.job_id;
			if (parsed?.jobId) return parsed.jobId;
			if (parsed?.id) return parsed.id;
			if (raw) return raw;
			throw new Error("orchestrator launch returned no job id");
		},

		async status(jobId) {
			const raw = execFn(command, [...baseArgs, "status", String(jobId)]);
			const parsed = parseJsonPayload(raw);
			if (!parsed || typeof parsed !== "object") {
				throw new Error("orchestrator status returned non-JSON payload");
			}
			return parsed;
		},

		async result(jobId) {
			const raw = execFn(command, [...baseArgs, "result", String(jobId)]);
			const parsed = parseJsonPayload(raw);
			if (!parsed || typeof parsed !== "object") {
				throw new Error("orchestrator result returned non-JSON payload");
			}
			return parsed;
		},
	};
}

/**
 * Resolve a concrete orchestrator from dependencies or environment.
 * Env contract:
 * - SWITCHYARD_ORCHESTRATOR_CMD: command (required)
 * - SWITCHYARD_ORCHESTRATOR_ARGS_JSON: optional JSON string array
 *
 * @param {object} dependencies
 */
export function resolveOrchestrator(dependencies = {}) {
	if (dependencies.orchestrator) {
		return dependencies.orchestrator;
	}

	const command = process.env.SWITCHYARD_ORCHESTRATOR_CMD;
	if (!command) {
		throw new Error(
			"runQueueWithOrchestrator requires dependencies.orchestrator or SWITCHYARD_ORCHESTRATOR_CMD",
		);
	}

	const baseArgs = parseArgsJson(process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON);
	return createCliOrchestrator({ command, baseArgs });
}

/**
 * Parse the persisted tasks markdown queue into structured task rows.
 * Expected shape:
 *   ### Task 5.1: ...
 *   - **Status:** pending
 *   - **Description:** ...
 *
 * @param {string} markdown
 * @returns {Array<{id: string, title: string, status: string, description: string}>}
 */
export function parseTaskQueue(markdown) {
	const tasks = [];
	const taskBlockRegex =
		/### Task ([0-9.]+):\s*(.+)\n([\s\S]*?)(?=\n### Task [0-9.]+:|\n## |\n---|$)/g;

	for (const match of markdown.matchAll(taskBlockRegex)) {
		const [, id, title, block] = match;
		const statusMatch = block.match(/- \*\*Status:\*\*\s*(.+)/);
		const descriptionMatch = block.match(
			/- \*\*Description:\*\*\s*([\s\S]*?)(?=\n- \*\*|$)/,
		);

		tasks.push({
			id: id.trim(),
			title: title.trim(),
			status: (statusMatch?.[1] ?? "pending").trim().toLowerCase(),
			description: (descriptionMatch?.[1] ?? "").trim(),
		});
	}

	return tasks;
}

/**
 * Load and parse a tasks markdown file.
 * @param {string} tasksFilePath
 */
export function loadTaskQueue(tasksFilePath) {
	const markdown = readFileSync(tasksFilePath, "utf8");
	return parseTaskQueue(markdown);
}

/**
 * Default checkpoint path for a tasks file.
 * @param {string} tasksFilePath
 */
export function getCheckpointPath(tasksFilePath) {
	return `${tasksFilePath}.checkpoint.json`;
}

/**
 * Create an empty checkpoint state.
 * @param {string} tasksFilePath
 */
export function createEmptyCheckpoint(tasksFilePath) {
	return {
		version: CHECKPOINT_VERSION,
		tasksFilePath,
		completedTaskIds: [],
		lastTaskId: null,
		lastUpdatedAt: null,
		results: [],
	};
}

/**
 * Persist checkpoint file. Writes to a sibling temp file and renames over
 * the target — `rename` is atomic on the same filesystem, so a crash
 * mid-write can never leave `checkpointPath` itself holding truncated/
 * invalid JSON; the reader always sees either the prior state or the new
 * one, never a partial write.
 * @param {string} checkpointPath
 * @param {object} checkpoint
 */
export function saveCheckpoint(checkpointPath, checkpoint) {
	mkdirSync(dirname(checkpointPath), { recursive: true });
	const tmpPath = `${checkpointPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), "utf8");
	renameSync(tmpPath, checkpointPath);
}

/**
 * Load checkpoint file. A *missing* file is the normal first-run case and
 * returns an empty checkpoint. A file that *exists but fails to parse or
 * has an unexpected shape* is treated as corruption, not "no checkpoint" —
 * silently discarding it would erase completed-task history and cause a
 * full re-run, which then fails to reapply already-applied diffs and wedges
 * the queue anyway, several steps removed from the actual cause. Fail loudly
 * here instead.
 * @param {string} checkpointPath
 * @param {string} tasksFilePath
 * @throws {Error} if the checkpoint file exists but is unreadable/invalid
 */
export function loadCheckpoint(checkpointPath, tasksFilePath) {
	let raw;
	try {
		raw = readFileSync(checkpointPath, "utf8");
	} catch {
		return createEmptyCheckpoint(tasksFilePath); // no checkpoint yet
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

	if (
		parsed?.version === CHECKPOINT_VERSION &&
		Array.isArray(parsed.completedTaskIds) &&
		Array.isArray(parsed.results)
	) {
		return parsed;
	}

	throw new Error(
		`checkpoint file exists but has an unexpected shape, refusing to ` +
			`silently discard completed-task history: ${checkpointPath}`,
	);
}

/**
 * Filter queue to tasks that still need execution.
 * @param {Array<{id: string, status: string}>} tasks
 * @param {object} checkpoint
 */
export function getRunnableTasks(tasks, checkpoint) {
	const done = new Set(checkpoint.completedTaskIds);
	return tasks.filter((task) => {
		const queueStatusEligible =
			task.status === "pending" || task.status === "in progress";
		return queueStatusEligible && !done.has(task.id);
	});
}

function selectAdapter(providerName, adapters) {
	const provider = providerName?.toLowerCase();
	if (!provider) return null;
	// Look up by key rather than a hardcoded provider allowlist: the prior
	// version only recognized "claude"/"codex" and silently orphaned agy/
	// cursor when they were added to the default adapters map below — route()
	// (via availableProviders) correctly reported them as dispatchable, but
	// this function still rejected them as unsupported on every attempt.
	return adapters?.[provider] ?? null;
}

/**
 * Parse expected_by / expectedBy timestamps to epoch ms.
 * @param {object} status
 * @returns {number|null}
 */
export function parseExpectedBy(status) {
	const raw = status?.expected_by ?? status?.expectedBy ?? null;
	if (!raw || typeof raw !== "string") return null;
	const epochMs = Date.parse(raw);
	return Number.isFinite(epochMs) ? epochMs : null;
}

/**
 * Poll orchestrator status until a terminal state or expected-by timeout.
 * @param {object} options
 * @param {string} options.jobId
 * @param {{status: Function}} options.orchestrator
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.maxPolls]
 * @param {Function} [options.now]
 * @param {Function} [options.sleepFn]
 * @param {Function} [options.onPoll]
 * @returns {Promise<{state: string, status: object, timedOut: boolean, polls: number}>}
 */
export async function waitForJobCompletion(options) {
	const {
		jobId,
		orchestrator,
		pollIntervalMs = 10_000,
		maxPolls = 1_000,
		now = Date.now,
		sleepFn = sleep,
		onPoll = null,
	} = options;

	let polls = 0;
	let lastStatus = { state: "missing" };

	while (polls < maxPolls) {
		let status;
		try {
			// eslint-disable-next-line no-await-in-loop
			status = await orchestrator.status(jobId);
		} catch (error) {
			// A transient status-fetch failure must fail only this task, not
			// abort every remaining task in the queue with no ledger record
			// and no checkpoint save (unlike launch(), this call previously
			// had no error handling at all).
			return {
				state: "status_error",
				status: { error: error?.message ?? "orchestrator status failed" },
				timedOut: false,
				polls: polls + 1,
			};
		}
		const state = String(status?.state ?? "missing");
		lastStatus = status ?? { state: "missing" };
		polls += 1;

		if (typeof onPoll === "function") {
			onPoll({ jobId, status: lastStatus, state, polls });
		}

		if (TERMINAL_JOB_STATES.has(state)) {
			return { state, status: lastStatus, timedOut: false, polls };
		}

		const expectedByMs = parseExpectedBy(status);
		if (expectedByMs !== null && now() > expectedByMs) {
			return { state: "timed_out", status: lastStatus, timedOut: true, polls };
		}

		// eslint-disable-next-line no-await-in-loop
		await sleepFn(pollIntervalMs);
	}

	return { state: "poll_limit", status: lastStatus, timedOut: true, polls };
}

/**
 * Execute one task via routed provider/model and return a structured result.
 * @param {{id: string, title: string, description: string}} task
 * @param {object} context
 */
export function executeTask(task, context) {
	const tier = classifyTask(task.description || task.title);
	// Constrain routing to providers this dispatcher can actually execute.
	// Without this, route() can legitimately pick a roster provider (e.g.
	// vibe/agy/cursor) that has no adapter wired here, which previously
	// produced an unrecoverable "unsupported_provider" failure that
	// re-occurred identically on every resume (the same task, same route,
	// same missing adapter, forever).
	const routeResult = context.route({
		tier,
		availableProviders: Object.keys(context.adapters ?? {}),
	});

	if (!routeResult.provider) {
		context.recordDispatch({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason: routeResult.reason,
		});
		return {
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			result: "no_provider",
		};
	}

	const adapter = selectAdapter(routeResult.provider, context.adapters);
	if (!adapter) {
		context.recordDispatch({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "unsupported_provider",
			reason: routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			result: "unsupported_provider",
		};
	}

	const prompt = task.description || task.title;
	const execution = adapter.execute(prompt, context.workingContainerName, {
		model: routeResult.model ?? undefined,
	});

	if (!execution.success) {
		context.recordDispatch({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			reason: execution.error ?? routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			result: "execution_failed",
			error: execution.error ?? null,
		};
	}

	const diff = adapter.captureDiff(context.workingContainerName);
	if (!diff) {
		context.recordDispatch({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			reason: routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: true,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			result: "success_no_diff",
		};
	}

	const gateResult = context.integrationGate(diff, context.projectPath);
	const success = Boolean(gateResult?.success);
	context.recordDispatch({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: success ? "success" : "integration_failed",
		reason: gateResult?.message ?? routeResult.reason,
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	return {
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		result: success ? "success" : "integration_failed",
	};
}

/**
 * Execute one task by launching and polling a headless orchestrator job.
 * @param {{id: string, title: string, description: string}} task
 * @param {object} context
 * @returns {Promise<object>}
 */
export async function executeTaskWithOrchestrator(task, context) {
	const tier = classifyTask(task.description || task.title);
	const routeResult = context.route({ tier });

	if (!routeResult.provider) {
		context.recordDispatch({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason: routeResult.reason,
		});
		return {
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			result: "no_provider",
		};
	}

	let jobId;
	try {
		jobId = await context.orchestrator.launch({
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			prompt: task.description || task.title,
			workingContainerName: context.workingContainerName,
		});
	} catch (error) {
		context.recordDispatch({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "launch_failed",
			reason: error?.message ?? "orchestrator launch failed",
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			result: "launch_failed",
		};
	}

	const waited = await waitForJobCompletion({
		jobId,
		orchestrator: context.orchestrator,
		pollIntervalMs: context.pollIntervalMs,
		maxPolls: context.maxPolls,
		now: context.now,
		sleepFn: context.sleepFn,
		onPoll: context.onPoll,
	});

	if (waited.state !== "done") {
		context.recordDispatch({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: `orchestrator_${waited.state}`,
			reason: waited.timedOut
				? "orchestrator timed out"
				: "orchestrator ended before done",
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			result: `orchestrator_${waited.state}`,
		};
	}

	let jobResult;
	try {
		jobResult = await context.orchestrator.result(jobId);
	} catch (error) {
		// Same reasoning as the status() guard above: a transient result-fetch
		// failure must fail only this task, not the whole remaining queue.
		context.recordDispatch({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "result_fetch_failed",
			reason: error?.message ?? "orchestrator result failed",
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			result: "result_fetch_failed",
		};
	}
	if (!jobResult?.success) {
		context.recordDispatch({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			reason: jobResult?.error ?? "orchestrator job failed",
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			result: "execution_failed",
		};
	}

	const diff = typeof jobResult.diff === "string" ? jobResult.diff.trim() : "";
	if (!diff) {
		context.recordDispatch({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			reason: routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: true,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			result: "success_no_diff",
		};
	}

	const gateResult = context.integrationGate(diff, context.projectPath);
	const success = Boolean(gateResult?.success);
	context.recordDispatch({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: success ? "success" : "integration_failed",
		reason: gateResult?.message ?? routeResult.reason,
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	return {
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		result: success ? "success" : "integration_failed",
	};
}

/**
 * Run queue serially with host-side checkpointing.
 * @param {object} options
 * @param {string} options.tasksFilePath
 * @param {string} options.projectPath
 * @param {string} options.workingContainerName
 * @param {string} [options.checkpointPath]
 * @param {number} [options.maxTasks]
 * @param {boolean} [options.stopOnFailure]
 * @param {object} [options.dependencies]
 */
export function runQueue(options) {
	const {
		tasksFilePath,
		projectPath,
		workingContainerName,
		checkpointPath = getCheckpointPath(tasksFilePath),
		maxTasks = Number.POSITIVE_INFINITY,
		stopOnFailure = true,
		dependencies = {},
	} = options;

	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? recordDispatch,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		adapters: dependencies.adapters ?? {
			claude: {
				execute: executeClaude,
				captureDiff: captureClaudeDiff,
			},
			codex: {
				execute: executeCodex,
				captureDiff: captureCodexDiff,
			},
			agy: {
				execute: executeAgy,
				captureDiff: captureAgyDiff,
			},
			cursor: {
				execute: executeCursor,
				captureDiff: captureCursorDiff,
			},
		},
		projectPath,
		workingContainerName,
	};

	const tasks = loadTaskQueue(tasksFilePath);
	const checkpoint = loadCheckpoint(checkpointPath, tasksFilePath);
	const runnable = getRunnableTasks(tasks, checkpoint);
	const results = [];
	let processed = 0;

	for (const task of runnable) {
		if (processed >= maxTasks) break;

		const result = executeTask(task, context);
		results.push(result);
		checkpoint.results.push({
			taskId: result.taskId,
			provider: result.provider,
			model: result.model,
			result: result.result,
			success: result.success,
			timestamp: new Date().toISOString(),
		});
		checkpoint.lastTaskId = result.taskId;
		checkpoint.lastUpdatedAt = new Date().toISOString();

		if (result.success) {
			checkpoint.completedTaskIds.push(result.taskId);
		}

		saveCheckpoint(checkpointPath, checkpoint);
		processed += 1;

		if (!result.success && stopOnFailure) {
			break;
		}
	}

	return {
		totalTasks: tasks.length,
		runnableTasks: runnable.length,
		processedTasks: processed,
		completedTaskIds: checkpoint.completedTaskIds,
		lastTaskId: checkpoint.lastTaskId,
		checkpointPath,
		results,
	};
}

/**
 * Run queue serially by supervising headless orchestrator jobs with poll/wait.
 * @param {object} options
 * @param {string} options.tasksFilePath
 * @param {string} options.projectPath
 * @param {string} options.workingContainerName
 * @param {string} [options.checkpointPath]
 * @param {number} [options.maxTasks]
 * @param {boolean} [options.stopOnFailure]
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.maxPolls]
 * @param {object} [options.dependencies]
 */
export async function runQueueWithOrchestrator(options) {
	const {
		tasksFilePath,
		projectPath,
		workingContainerName,
		checkpointPath = getCheckpointPath(tasksFilePath),
		maxTasks = Number.POSITIVE_INFINITY,
		stopOnFailure = true,
		pollIntervalMs = 10_000,
		maxPolls = 1_000,
		dependencies = {},
	} = options;

	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? recordDispatch,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		orchestrator: resolveOrchestrator(dependencies),
		projectPath,
		workingContainerName,
		pollIntervalMs,
		maxPolls,
		now: dependencies.now ?? Date.now,
		sleepFn: dependencies.sleepFn ?? sleep,
		onPoll: dependencies.onPoll ?? null,
	};

	const tasks = loadTaskQueue(tasksFilePath);
	const checkpoint = loadCheckpoint(checkpointPath, tasksFilePath);
	const runnable = getRunnableTasks(tasks, checkpoint);
	const results = [];
	let processed = 0;

	for (const task of runnable) {
		if (processed >= maxTasks) break;

		// eslint-disable-next-line no-await-in-loop
		const result = await executeTaskWithOrchestrator(task, context);
		results.push(result);
		checkpoint.results.push({
			taskId: result.taskId,
			provider: result.provider,
			model: result.model,
			result: result.result,
			success: result.success,
			timestamp: new Date().toISOString(),
		});
		checkpoint.lastTaskId = result.taskId;
		checkpoint.lastUpdatedAt = new Date().toISOString();

		if (result.success) {
			checkpoint.completedTaskIds.push(result.taskId);
		}

		saveCheckpoint(checkpointPath, checkpoint);
		processed += 1;

		if (!result.success && stopOnFailure) {
			break;
		}
	}

	return {
		totalTasks: tasks.length,
		runnableTasks: runnable.length,
		processedTasks: processed,
		completedTaskIds: checkpoint.completedTaskIds,
		lastTaskId: checkpoint.lastTaskId,
		checkpointPath,
		results,
	};
}

/**
 * Convenience runner for project-local task file naming.
 * @param {string} projectRoot
 * @param {string} tasksFileName
 * @param {string} workingContainerName
 */
export function runProjectQueue(
	projectRoot,
	tasksFileName,
	workingContainerName,
) {
	return runQueue({
		tasksFilePath: join(projectRoot, tasksFileName),
		projectPath: projectRoot,
		workingContainerName,
	});
}

export { CHECKPOINT_VERSION };
