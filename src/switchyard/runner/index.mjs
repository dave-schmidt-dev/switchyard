// Runner module - host-side runner supervising headless orchestrator
// Reads persisted task queue, drives serial execution, checkpoints for resume.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { captureDiff as captureAgyDiff, executeAgy } from "../adapter/agy.mjs";
import {
	captureDiff as captureClaudeDiff,
	executeClaude,
} from "../adapter/claude.mjs";
import {
	captureDiff as captureCodexDiff,
	executeCodex,
} from "../adapter/codex.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../adapter/constants.mjs";
import {
	captureDiff as captureCopilotDiff,
	execute as executeCopilot,
} from "../adapter/copilot.mjs";
import {
	captureDiff as captureCursorDiff,
	executeCursor,
} from "../adapter/cursor.mjs";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import {
	captureDiff as captureOpencodeDiff,
	execute as executeOpencode,
} from "../adapter/opencode.mjs";
import {
	AGENT_IMAGE,
	buildAgentImage,
	checkContainerRuntime,
	imageExists,
	startAgentContainer,
} from "../container/index.mjs";
import { integrationGate } from "../integrate/index.mjs";
import { recordDispatch, recordDispatchToStore } from "../ledger/index.mjs";
import {
	commitWorkingTree,
	createWorkingContainer,
	provisionCredentials,
	resetWorkingTree,
	seedProject,
	wipeWorkingContainer,
} from "../lifecycle/index.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import { classifyTask, isValidCapabilityClass } from "../roster/classifier.mjs";
import {
	normalizeProviderName,
	resolveRouteProvenance,
} from "../roster/index.mjs";
import { route } from "../router/index.mjs";

/**
 * Ensure the standing agent container is built and running.
 * Idempotent: only builds the image if it isn't already present (a build
 * costs multiple minutes and should only pay once per host), and
 * startAgentContainer() is itself idempotent (starts an existing stopped
 * container, or is a no-op if already running).
 * @param {object} [deps] Injectable dependencies (tests only)
 * @param {(command: string, args: string[], options: object) => Buffer | string} [deps.execFn]
 *   Defaults to the real `execFileSync`
 * @throws {Error} if Docker/OrbStack is unavailable, or the image build or
 *   container start fails.
 */
export function ensureAgentContainer(deps = {}) {
	const status = checkContainerRuntime(deps);
	if (!status.available) {
		throw new Error(
			`ensureAgentContainer: Docker/OrbStack is not available (${status.classification})`,
		);
	}
	if (!imageExists(AGENT_IMAGE)) {
		if (!buildAgentImage()) {
			throw new Error(`ensureAgentContainer: failed to build ${AGENT_IMAGE}`);
		}
	}
	if (!startAgentContainer()) {
		throw new Error("ensureAgentContainer: failed to start agent container");
	}
}

const CHECKPOINT_VERSION = 2;
const HISTORICAL_CHECKPOINT_VERSION = 1;
const RUN_OPTIONS_VERSION = 1;
const TERMINAL_JOB_STATES = new Set([
	"done",
	"expired",
	"died",
	"error",
	"missing",
]);

// Statuses whose tasks are eligible to run, and the full vocabulary of
// statuses the project documents (see TASKS.md status key:
// `pending | in progress | done | blocked`). A recognized-but-not-runnable
// status (`done`, `blocked`) is an *intentional* skip and excluded silently;
// any status outside this vocabulary is treated as a typo/mistake and excluded
// with a visible warning rather than vanishing indistinguishably from a
// deliberate skip.
const RUNNABLE_TASK_STATUSES = new Set(["pending", "in progress"]);
const KNOWN_TASK_STATUSES = new Set([
	"pending",
	"in progress",
	"done",
	"blocked",
]);
const TASK_ID_PATTERN = "\\d+(?:\\.\\d+)*";
const EXTERNAL_BLOCKER_ID_RE = /^[a-z][a-z0-9]*(?:(?:-|:)[a-z0-9]+)*$/;

function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizeIds(values, label) {
	if (values == null) return [];
	if (
		!Array.isArray(values) ||
		values.some((value) => typeof value !== "string")
	) {
		throw new Error(`${label} must be an array of strings`);
	}
	const ids = values.map((value) => value.trim());
	if (ids.some((value) => !value))
		throw new Error(`${label} contains an empty value`);
	return [...new Set(ids)].sort();
}

function normalizeProviders(values, label) {
	return normalizeIds(values, label).map((value) => value.toLowerCase());
}

/** Normalize the persisted run options used for identity and resume checks. */
export function normalizeRunOptions(options = {}) {
	const maxTasks = options.maxTasks ?? Number.POSITIVE_INFINITY;
	if (
		maxTasks !== Number.POSITIVE_INFINITY &&
		(!Number.isInteger(maxTasks) || maxTasks < 1)
	) {
		throw new Error(
			"runOptions.maxTasks must be a positive integer or infinity",
		);
	}
	return {
		version: RUN_OPTIONS_VERSION,
		maxTasks: Number.isFinite(maxTasks) ? maxTasks : null,
		checkpointPath: options.checkpointPath
			? resolve(options.checkpointPath)
			: null,
		stopOnFailure: options.stopOnFailure !== false,
		onlyProviders: normalizeProviders(
			options.onlyProviders ?? options.only ?? [],
			"runOptions.onlyProviders",
		),
		excludeProviders: normalizeProviders(
			options.excludeProviders ?? options.exclude ?? [],
			"runOptions.excludeProviders",
		),
		taskIds: normalizeIds(
			options.taskIds ?? options.selectedTaskIds ?? [],
			"runOptions.taskIds",
		),
	};
}

/** Build an opaque identity over the queue, graph, project revision, and options. */
export function createQueueIdentity({
	tasksFilePath,
	markdown,
	tasks,
	projectRevision,
	runOptions,
}) {
	const graph = tasks.map((task) => ({
		id: task.id,
		blockedBy: [...(task.blockedBy ?? [])].sort(),
		externalBlockers: [...(task.externalBlockers ?? [])].sort(),
	}));
	const payload = {
		tasksFilePath: resolve(tasksFilePath),
		tasksContentHash: createHash("sha256").update(markdown).digest("hex"),
		graph,
		projectRevision: String(projectRevision ?? "unknown"),
		runOptions: normalizeRunOptions(runOptions),
	};
	return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function computeQueueIdentityFromFile(
	tasksFilePath,
	projectRevision,
	runOptions,
) {
	const markdown = readFileSync(tasksFilePath, "utf8");
	const tasks = parseTaskQueue(markdown);
	return {
		markdown,
		tasks,
		queueIdentity: createQueueIdentity({
			tasksFilePath,
			markdown,
			tasks,
			projectRevision,
			runOptions,
		}),
	};
}

/**
 * Read the committed project revision used by queue identity.
 * A repository without a readable HEAD uses a stable sentinel; callers still
 * retain the task-file content and graph hashes in the resulting identity.
 * @param {string} projectPath
 * @returns {string}
 */
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
		options.queueIdentity !== undefined ||
		options.runOptions !== undefined ||
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
		throw new Error(
			`queue identity mismatch: supplied ${options.queueIdentity}, expected ${expectedIdentity}; ` +
				"the task path, content/graph, project revision, or run options changed — create a new checkpoint or use an audited migration",
		);
	}

	return {
		enabled: true,
		queueIdentity: expectedIdentity,
		runOptions,
		projectRevision,
	};
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

/**
 * Validate explicit task selection before provider routing. Dependencies that
 * are also selected may run first; a dependency outside the selection must
 * already be complete, otherwise the request is rejected rather than silently
 * producing a partial run.
 * @param {Array} tasks
 * @param {object} checkpoint
 * @param {string[]} selectedTaskIds
 */
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
			throw new TaskSelectionError(taskId, "completed-task");
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
 *   (Note: per-task diff isolation is the orchestrator's contract, not the runner's.)
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
 * @returns {Array<{id: string, title: string, status: string, description: string, requiredPaths: string[]|null, allowManifests: boolean, timeoutMs: number|null, requiredCapability: string|null, executor: string, type: string}>}
 */
export function parseTaskQueue(markdown) {
	const tasks = [];
	const taskBlockRegex =
		/### Task ([0-9.]+):\s*(.+)\n([\s\S]*?)(?=\n### Task [0-9.]+:|\n## |\n---|$)/g;

	for (const match of markdown.matchAll(taskBlockRegex)) {
		const [, id, title, block] = match;
		const statusMatch = block.match(/- \*\*Status:\*\*\s*(.+)/i);
		const descriptionMatch = block.match(
			/- \*\*(?:Description|Work|Details|Overview):\*\*\s*([\s\S]*?)(?=\n- \*\*|$)/i,
		);

		const rawDesc =
			descriptionMatch?.[1] ?? block.replace(/- \*\*Status:\*\*\s*.*/gi, "");
		const fullPrompt = `### Task ${id.trim()}: ${title.trim()}\n${block.trim()}`;
		const taskId = id.trim();

		if (hasTaskField(block, "Tier")) {
			throw new Error(
				`Task ${taskId}: Tier is a retired task-contract field; use RequiredCapability instead (Tier is not an alias)`,
			);
		}

		let requiredPaths = null;
		const filesLine = block
			.split("\n")
			.find((line) => /^- \*\*Files:\*\*\s/.test(line));
		if (filesLine) {
			const filesValue = filesLine.replace(/^- \*\*Files:\*\*\s*/, "").trim();
			requiredPaths = parseFilePaths(filesValue, taskId);
		}

		let timeoutMs = null;
		const timeoutLine = block
			.split("\n")
			.find((line) => /^- \*\*Timeout:\*\*\s/.test(line));
		if (timeoutLine) {
			const timeoutValue = timeoutLine
				.replace(/^- \*\*Timeout:\*\*\s*/, "")
				.trim();
			timeoutMs = parseTimeoutField(timeoutValue, taskId);
		}

		const requiredCapability = parseRequiredCapabilityField(block, taskId);
		const executor = parseExecutorField(block, taskId);
		const blockedBy = parseBlockedByField(block, taskId);
		const externalBlockers = parseExternalBlockersField(block, taskId);

		let type = "implementation";
		const typeLine = block
			.split("\n")
			.find((line) => /^- \*\*Type:\*\*\s/.test(line));
		if (typeLine) {
			const typeValue = typeLine.replace(/^- \*\*Type:\*\*\s*/, "").trim();
			type = parseTypeField(typeValue, taskId);
		}

		if (
			executor === "switchyard" &&
			type === "implementation" &&
			requiredPaths === null
		) {
			throw new Error(
				`Task ${taskId}: switchyard implementation task requires a Files: field (declare project-relative paths)`,
			);
		}

		const allowManifestsLine = block
			.split("\n")
			.find((line) => /^- \*\*AllowManifests:\*\*(?:\s|$)/.test(line));
		let allowManifests = false;
		if (allowManifestsLine) {
			if (type !== "implementation") {
				throw new Error(
					`Task ${taskId}: AllowManifests is only supported for implementation-type tasks`,
				);
			}
			const value = allowManifestsLine
				.replace(/^- \*\*AllowManifests:\*\*\s*/, "")
				.trim();
			if (value !== "true") {
				throw new Error(
					`Task ${taskId}: AllowManifests must be exactly true when present`,
				);
			}
			allowManifests = true;
		}

		tasks.push({
			id: taskId,
			title: title.trim(),
			status: (statusMatch?.[1] ?? "pending").trim().toLowerCase(),
			description: rawDesc.trim(),
			prompt: fullPrompt,
			requiredPaths,
			allowManifests,
			timeoutMs,
			requiredCapability,
			executor,
			type,
			blockedBy,
			externalBlockers,
		});
	}

	validateTaskGraph(tasks);
	return tasks;
}

// Typo guards, not policy limits: MIN rejects an accidental zero/near-zero
// value, MAX rejects an accidental order-of-magnitude slip (e.g. "24h" typed
// for "2.4h") without capping how long a task is legitimately allowed to run.
const MIN_TASK_TIMEOUT_MS = 1000; // 1 second
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Parse and validate a per-task `Timeout:` override into milliseconds.
 * Requires an explicit unit (s/m/h) rather than a bare number — same
 * unambiguous-input rule `parseFilePaths` applies to `Files:`.
 * @param {string} raw The raw value of the Timeout field, e.g. "90m"
 * @param {string} taskId Task identifier for error messages
 * @returns {number} Timeout in milliseconds
 * @throws {Error} If the value is malformed or out of bounds
 */
function parseTimeoutField(raw, taskId) {
	const trimmed = raw.trim();
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)$/i);
	if (!match) {
		throw new Error(
			`Task ${taskId}: invalid Timeout field "${trimmed}" (expected a number followed by s/m/h, e.g. "90m")`,
		);
	}

	const [, amount, unit] = match;
	const unitMs = { s: 1000, m: 60_000, h: 3_600_000 }[unit.toLowerCase()];
	const ms = Number.parseFloat(amount) * unitMs;

	if (ms < MIN_TASK_TIMEOUT_MS || ms > MAX_TASK_TIMEOUT_MS) {
		throw new Error(
			`Task ${taskId}: Timeout must be between 1s and 24h (got "${trimmed}")`,
		);
	}

	return ms;
}

function getTaskFieldValues(block, fieldName) {
	const fieldPattern = new RegExp(`^- \\*\\*${fieldName}:\\*\\*(?:\\s(.*))?$`);
	return block.split("\n").flatMap((line) => {
		const match = line.match(fieldPattern);
		return match ? [match[1] ?? ""] : [];
	});
}

function hasTaskField(block, fieldName) {
	const fieldPattern = new RegExp(`^- \\*\\*${fieldName}:\\*\\*(?:\\s|$)`, "i");
	return block.split("\n").some((line) => fieldPattern.test(line));
}

/**
 * Parse the exact task-contract `RequiredCapability:` field. This boundary
 * deliberately keeps the router's internal capability-class vocabulary private
 * runner: the retired `Tier:` task field is rejected above, never aliased.
 * @param {string} block Task markdown block
 * @param {string} taskId Task identifier for error messages
 * @returns {string|null} normalized capability or null when absent
 */
function parseRequiredCapabilityField(block, taskId) {
	const values = getTaskFieldValues(block, "RequiredCapability");
	if (values.length === 0) return null;
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate RequiredCapability declarations are not allowed`,
		);
	}

	const raw = values[0].trim();
	if (!raw) {
		throw new Error(`Task ${taskId}: RequiredCapability field is empty`);
	}
	if (/[,|/]+|\s/.test(raw)) {
		throw new Error(
			`Task ${taskId}: mixed RequiredCapability declaration "${raw}" is not allowed; declare exactly one of high, standard, or low`,
		);
	}

	const normalized = raw.toLowerCase();
	if (!isValidCapabilityClass(normalized)) {
		throw new Error(
			`Task ${taskId}: invalid RequiredCapability field "${raw}" (expected one of: high, standard, low)`,
		);
	}
	return normalized;
}

/**
 * Parse the required task-contract `Executor:` field. Programmatic task
 * objects may still omit it at the runner boundary; markdown task contracts
 * may not.
 * @param {string} block Task markdown block
 * @param {string} taskId Task identifier for error messages
 * @returns {string} normalized executor
 */
function parseExecutorField(block, taskId) {
	const values = getTaskFieldValues(block, "Executor");
	if (values.length === 0) {
		throw new Error(
			`Task ${taskId}: missing Executor field (expected one of: native, switchyard, human)`,
		);
	}
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate Executor declarations are not allowed`,
		);
	}

	const raw = values[0].trim();
	const normalized = raw.toLowerCase();
	if (!raw || !["native", "switchyard", "human"].includes(normalized)) {
		throw new Error(
			`Task ${taskId}: invalid Executor field "${raw}" (expected one of: native, switchyard, human)`,
		);
	}
	return normalized;
}

/**
 * Parse and validate a per-task `Type:` field (`implementation` | `review`).
 * Same fail-closed convention as parseRequiredCapabilityField: an unrecognized value throws
 * immediately with the offending value in the message.
 * @param {string} raw The raw value of the Type field, e.g. "review"
 * @param {string} taskId Task identifier for error messages
 * @returns {string} normalized type ('implementation'|'review')
 * @throws {Error} If the value isn't a recognized task type
 */
function parseTypeField(raw, taskId) {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed !== "implementation" && trimmed !== "review") {
		throw new Error(
			`Task ${taskId}: invalid Type field "${raw.trim()}" (expected one of: implementation, review)`,
		);
	}
	return trimmed;
}

/**
 * Parse the machine-readable `Blocked by:` task dependency field.
 *
 * The field accepts `none`, a single `Task 1.1`, or a comma-separated list
 * such as `Tasks 1.1, 1.2`. Repeating `Task` before each id is accepted for
 * compatibility with existing active queues. Free prose is rejected rather
 * than being silently treated as a dependency or as no dependency.
 * @param {string} block Task markdown block
 * @param {string} taskId Task identifier for error messages
 * @returns {string[]} task ids
 */
function parseBlockedByField(block, taskId) {
	const values = getTaskFieldValues(block, "Blocked by");
	if (values.length === 0) return [];
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate Blocked by declarations are not allowed`,
		);
	}

	const raw = values[0].trim();
	if (!raw) {
		throw new Error(`Task ${taskId}: Blocked by field is empty`);
	}
	if (raw.toLowerCase() === "none") return [];

	const taskIdToken = `(?:${TASK_ID_PATTERN})`;
	const validList = new RegExp(
		`^(?:(?:Tasks?|tasks?)\\s+)?${taskIdToken}(?:\\s*,\\s*(?:(?:Task|task)\\s+)?${taskIdToken})*$`,
	);
	if (!validList.test(raw)) {
		throw new Error(
			`Task ${taskId}: invalid Blocked by field "${raw}" (expected none or exact task IDs)`,
		);
	}

	const dependencies = raw.match(new RegExp(TASK_ID_PATTERN, "g")) ?? [];
	const seen = new Set();
	for (const dependency of dependencies) {
		if (seen.has(dependency)) {
			throw new Error(
				`Task ${taskId}: duplicate Blocked by dependency "${dependency}"`,
			);
		}
		seen.add(dependency);
	}
	return dependencies;
}

/**
 * Parse stable decision/approval/gate identifiers from `External blockers:`.
 * A blocker remains unresolved unless a caller explicitly supplies it as
 * resolved to getRunnableTasks; the default runner therefore fails closed.
 * @param {string} block Task markdown block
 * @param {string} taskId Task identifier for error messages
 * @returns {string[]} external blocker ids
 */
function parseExternalBlockersField(block, taskId) {
	const values = getTaskFieldValues(block, "External blockers");
	if (values.length === 0) return [];
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate External blockers declarations are not allowed`,
		);
	}

	const raw = values[0].trim();
	if (!raw) {
		throw new Error(`Task ${taskId}: External blockers field is empty`);
	}
	if (raw.toLowerCase() === "none") return [];

	const blockers = raw.split(",").map((value) => value.trim());
	const seen = new Set();
	for (const blocker of blockers) {
		if (!EXTERNAL_BLOCKER_ID_RE.test(blocker)) {
			throw new Error(
				`Task ${taskId}: invalid External blockers id "${blocker}" (expected stable slug)`,
			);
		}
		if (seen.has(blocker)) {
			throw new Error(
				`Task ${taskId}: duplicate External blockers id "${blocker}"`,
			);
		}
		seen.add(blocker);
	}
	return blockers;
}

/**
 * Parse and validate a comma-separated Files: field into an array of paths.
 * @param {string} raw The raw value of the Files: field
 * @param {string} taskId Task identifier for error messages
 * @returns {string[]} Validated project-relative POSIX paths
 * @throws {Error} If any path is invalid
 */
function parseFilePaths(raw, taskId) {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error(
			`Task ${taskId}: Files field is empty (must include at least one path)`,
		);
	}

	const paths = trimmed.split(",").map((p) => p.trim());

	for (const path of paths) {
		if (!path) {
			throw new Error(`Task ${taskId}: empty path entry in Files field`);
		}
		if (path.startsWith("/")) {
			throw new Error(
				`Task ${taskId}: absolute path not allowed in Files: "${path}"`,
			);
		}
		if (path.split("/").includes("..")) {
			throw new Error(
				`Task ${taskId}: path traversal not allowed in Files: "${path}"`,
			);
		}
		if (path.includes("\\")) {
			throw new Error(
				`Task ${taskId}: backslash separator not allowed in Files: "${path}"`,
			);
		}
		if (/[*?[\]]/.test(path)) {
			throw new Error(
				`Task ${taskId}: wildcards not allowed in Files: "${path}"`,
			);
		}
		if (path.endsWith("/")) {
			throw new Error(
				`Task ${taskId}: directory-only entry not allowed in Files: "${path}"`,
			);
		}
	}

	const seen = new Set();
	for (const path of paths) {
		if (seen.has(path)) {
			throw new Error(`Task ${taskId}: duplicate path in Files: "${path}"`);
		}
		seen.add(path);
	}

	return paths;
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
 * Validate the task dependency graph before any provider can be selected.
 *
 * @param {Array<{id: string, blockedBy?: string[]}>} tasks
 * @returns {Array} the original task array
 * @throws {Error} if ids are duplicated, dependencies are unknown/self-referential, or cyclic
 */
export function validateTaskGraph(tasks) {
	if (!Array.isArray(tasks)) {
		throw new Error("tasks queue must be an array");
	}

	const byId = new Map();
	for (const task of tasks) {
		if (!task || typeof task.id !== "string" || !task.id.trim()) {
			throw new Error("tasks queue contains a task without a valid id");
		}
		if (byId.has(task.id)) {
			throw new Error(
				`tasks queue contains a duplicate task id "${task.id}"; refusing to ` +
					`run the same id twice in one pass — fix the malformed tasks file`,
			);
		}
		byId.set(task.id, task);
	}

	for (const task of tasks) {
		const dependencies = task.blockedBy ?? [];
		if (!Array.isArray(dependencies)) {
			throw new Error(
				`Task ${task.id}: blockedBy must be an array of exact task IDs`,
			);
		}
		for (const dependency of dependencies) {
			if (typeof dependency !== "string" || !byId.has(dependency)) {
				throw new Error(
					`Task ${task.id}: unknown Blocked by task "${dependency}"`,
				);
			}
			if (dependency === task.id) {
				throw new Error(
					`Task ${task.id}: self-dependency is not allowed in Blocked by`,
				);
			}
		}
	}

	const visiting = new Set();
	const visited = new Set();
	const visit = (taskId, path) => {
		if (visiting.has(taskId)) {
			const cycleStart = path.indexOf(taskId);
			const cycle = [...path.slice(cycleStart), taskId].join(" -> ");
			throw new Error(`task dependency cycle detected: ${cycle}`);
		}
		if (visited.has(taskId)) return;

		visiting.add(taskId);
		const task = byId.get(taskId);
		for (const dependency of task.blockedBy ?? []) {
			visit(dependency, [...path, taskId]);
		}
		visiting.delete(taskId);
		visited.add(taskId);
	};

	for (const task of tasks) visit(task.id, []);
	return tasks;
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
export function createEmptyCheckpoint(tasksFilePath, identity = {}) {
	const checkpoint = {
		// Keep the historical shape for direct callers that predate queue
		// identity. Dispatch/resume paths pass an identity and receive v2.
		version: identity.queueIdentity
			? CHECKPOINT_VERSION
			: HISTORICAL_CHECKPOINT_VERSION,
		tasksFilePath,
		completedTaskIds: [],
		lastTaskId: null,
		lastUpdatedAt: null,
		results: [],
	};
	if (identity.queueIdentity) {
		checkpoint.queueIdentity = identity.queueIdentity;
		checkpoint.runOptions = identity.runOptions ?? null;
	}
	return checkpoint;
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
 * Persist a timeout-interrupted diff as a review artifact next to the
 * checkpoint file, rather than embedding raw diff content in
 * checkpoint.json. This is the same class of content checkpoint.json's
 * `success` path already sends through captureDiff -> the integration gate
 * (a project source diff, `git add -A`-scoped so .gitignore'd files are
 * already excluded) — the only difference is it arrives via a timed-out task
 * instead of a completed one, so it is kept out of the gate and returned
 * here as a plain file for a human to review.
 * @param {string} checkpointPath
 * @param {string} taskId
 * @param {string} diffText
 * @returns {string} Path to the written artifact
 */
function savePartialDiff(checkpointPath, taskId, diffText) {
	const dir = `${checkpointPath}.partial-diffs`;
	mkdirSync(dir, { recursive: true });
	const artifactPath = join(dir, `${taskId}.diff`);
	writeFileSync(artifactPath, diffText, "utf8");
	return artifactPath;
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
export function loadCheckpoint(checkpointPath, tasksFilePath, expected = null) {
	let raw;
	try {
		raw = readFileSync(checkpointPath, "utf8");
	} catch {
		return createEmptyCheckpoint(tasksFilePath, expected ?? {}); // no checkpoint yet
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
		if (parsed.tasksFilePath !== tasksFilePath) {
			throw new Error(
				`checkpoint identity mismatch: tasksFilePath is ${parsed.tasksFilePath}, expected ${tasksFilePath}`,
			);
		}
		if (!parsed.queueIdentity || typeof parsed.queueIdentity !== "string") {
			throw new Error(
				"checkpoint v2 is missing queueIdentity; create a new checkpoint or use an audited migration",
			);
		}
		if (
			expected?.queueIdentity &&
			parsed.queueIdentity !== expected.queueIdentity
		) {
			throw new Error(
				`checkpoint identity mismatch: supplied ${parsed.queueIdentity}, expected ${expected.queueIdentity}; create a new checkpoint or use an audited migration`,
			);
		}
		if (
			expected?.runOptions &&
			stableStringify(parsed.runOptions) !==
				stableStringify(expected.runOptions)
		) {
			throw new Error(
				"checkpoint identity mismatch: normalized run options changed; create a new checkpoint or use an audited migration",
			);
		}
		return parsed;
	}

	if (
		parsed?.version === HISTORICAL_CHECKPOINT_VERSION &&
		Array.isArray(parsed.completedTaskIds) &&
		Array.isArray(parsed.results)
	) {
		if (expected?.queueIdentity) {
			throw new Error(
				"checkpoint v1 is historical state without queue identity; create an explicit new checkpoint or use an audited migration",
			);
		}
		return parsed;
	}

	throw new Error(
		`checkpoint file exists but has an unexpected shape, refusing to ` +
			`silently discard completed-task history: ${checkpointPath}`,
	);
}

/**
 * Filter queue to tasks that still need execution.
 *
 * Robustness beyond a plain status match (see Task 12):
 * - Status is normalized (trimmed + lowercased) before comparison, so a
 *   differently-cased or whitespace-padded value isn't silently dropped.
 * - A status outside the documented vocabulary produces a visible warning and
 *   is excluded, instead of vanishing indistinguishably from a deliberate skip.
 * - Duplicate task IDs within a single parse are malformed input and throw
 *   loudly (matching `loadCheckpoint`'s fail-loud posture) rather than being
 *   yielded twice and executed twice in the same pass — `done` only tracks the
 *   checkpoint's completed set, not IDs already yielded earlier in this pass.
 *
 * @param {Array<{id: string, status: string, blockedBy?: string[], externalBlockers?: string[], executor?: string}>} tasks
 * @param {object} checkpoint
 * @param {object} [options]
 * @param {Iterable<string>} [options.excludedTaskIds] Task ids already attempted in this run
 * @param {Iterable<string>} [options.resolvedExternalBlockers] External blocker ids cleared by an operator
 * @throws {Error} if two tasks share the same id (malformed queue)
 */
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

/**
 * Derive bounded, content-free queue diagnostics for status/result surfaces.
 * Only counts and a closed vocabulary of reason codes leave this function.
 * @param {Array} tasks parsed queue tasks
 * @param {object|null} checkpoint checkpoint state
 * @param {object} [options]
 * @param {Iterable<string>} [options.selectedTaskIds] explicit selection
 * @param {Iterable<string>} [options.resolvedExternalBlockers] cleared blockers
 * @returns {object}
 */
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

/**
 * Select the execution adapter for a route by its HARNESS, not its snapshot
 * provider/display name (Task 1.6, M1b). Adapters are keyed by harness
 * (`claude`, `codex`, `agy`, `cursor`, `copilot`, `opencode`), but a route's
 * `provider` is a snapshot display name (e.g. "OpenCode Go"). The old
 * `providerName.toLowerCase()` produced "opencode go", which never matched the
 * "opencode" adapter key, collapsing every opencode-target dispatch to
 * `unsupported_provider`. Normalizing to the harness ("OpenCode Go" →
 * "opencode") lets the route survive to dispatch.
 *
 * Callers pass `routeResult.resolved_harness` (the roster target's authoritative
 * `harness`) when available, falling back to the raw provider name;
 * normalizeProviderName is idempotent on an already-resolved harness, so both
 * inputs resolve to the same adapter key.
 * @param {string} harnessOrProvider
 * @param {object} adapters
 * @returns {object|null}
 */
function selectAdapter(harnessOrProvider, adapters) {
	const harness = normalizeProviderName(harnessOrProvider);
	if (!harness) return null;
	return adapters?.[harness] ?? null;
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
 * Resolve the task executor. Missing Executor retains the existing
 * Switchyard-routed behavior; present values are fail-closed.
 * @param {{id: string, executor?: string, description?: string, title?: string}} task
 * @returns {string} executor ('native'|'switchyard'|'human')
 * @throws {Error} if task.executor is present but invalid
 */
function resolveTaskExecutor(task) {
	if (!Object.hasOwn(task, "executor")) return "switchyard";
	if (["native", "switchyard", "human"].includes(task.executor)) {
		return task.executor;
	}
	throw new Error(
		`Task ${task.id}: invalid Executor field "${task.executor}" (expected one of: native, switchyard, human)`,
	);
}

/**
 * Resolve the required capability from the task contract. A declared
 * `task.requiredCapability` takes precedence over classifyTask's keyword
 * inference. The retired `task.tier` input is rejected rather than accepted
 * as a compatibility alias. classifyTask only runs when the capability is
 * fully absent from the task.
 * @param {{id: string, requiredCapability?: string|null, tier?: unknown, description?: string, title?: string}} task
 * @returns {string} required capability ('high'|'standard'|'low')
 * @throws {Error} if a retired task.tier or invalid capability is present
 */
function resolveTaskRequiredCapability(task) {
	if (Object.hasOwn(task, "tier")) {
		throw new Error(
			`Task ${task.id}: Tier is a retired task-contract field; use requiredCapability instead (Tier is not an alias)`,
		);
	}
	if (task.requiredCapability != null) {
		if (!isValidCapabilityClass(task.requiredCapability)) {
			throw new Error(
				`Task ${task.id}: invalid declared RequiredCapability "${task.requiredCapability}" (expected one of: high, standard, low) — refusing to silently route at a fallback capability`,
			);
		}
		return task.requiredCapability;
	}
	return classifyTask(task.description || task.title);
}

function nonSwitchyardExecutorResult(task, executor, requiredCapability) {
	return {
		taskId: task.id,
		success: false,
		provider: null,
		model: null,
		requiredCapability,
		result: "executor_not_switchyard",
		...sanitizeFailureMetadata({
			taskId: task.id,
			result: "executor_not_switchyard",
		}),
		reason: `Task ${task.id} declares Executor: ${executor}; Switchyard does not route ${executor} tasks to a provider`,
	};
}

function failureMetadataFor(result, partialDiffPath) {
	return sanitizeFailureMetadata({
		taskId: result.taskId,
		result: result.result,
		errorKind: result.errorKind,
		timedOut: result.timedOut,
		partialDiffPath,
	});
}

function integrationFailureMetadata(taskId, diff, credentialFlagged) {
	return sanitizeFailureMetadata({
		taskId,
		result: "integration_failed",
		// The queue saves this diff as `<taskId>.diff`; derive the opaque pointer
		// before recording the dispatch so the ledger can carry the same safe
		// artifact identity without receiving the host path or diff body.
		partialDiffPath:
			typeof diff === "string" && diff.length > 0 && !credentialFlagged
				? `${taskId}.diff`
				: undefined,
	});
}

/**
 * Execute one task via routed provider/model and return a structured result.
 * @param {{id: string, title: string, description: string}} task
 * @param {object} context
 */
export function executeTask(task, context) {
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return nonSwitchyardExecutorResult(task, executor, requiredCapability);
	}
	const routeResult = context.route({
		requiredCapability,
		availableProviders: Object.keys(context.adapters ?? {}),
		exclude: context.exclude,
		only: context.only,
	});

	// Provenance (Task 1.6, M7/M8): resolve the six roster-provenance fields
	// once, attach them to routeResult, and route every dispatch record through
	// a local `record()` that spreads them in. Doing it here — not at each of
	// the recordDispatch call sites below — means no dispatch record can omit
	// provenance, and adds it in exactly one place per execute path.
	const provenance = resolveRouteProvenance(
		routeResult.provider,
		requiredCapability,
	);
	Object.assign(routeResult, { requiredCapability }, provenance);
	const record = (dispatch) =>
		context.recordDispatch({ ...provenance, ...dispatch, requiredCapability });

	if (!routeResult.provider) {
		record({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason: routeResult.reason,
			errorKind: null,
		});
		return {
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			requiredCapability,
			result: "no_provider",
			reason: routeResult.reason,
			errorKind: null,
		};
	}

	const adapter = selectAdapter(
		routeResult.resolved_harness ?? routeResult.provider,
		context.adapters,
	);
	if (!adapter) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "unsupported_provider",
			errorKind: null,
			reason: routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			result: "unsupported_provider",
		};
	}

	// A task's own `Timeout:` field (runner/index.mjs parseTimeoutField)
	// overrides the global default for tasks known to legitimately need more
	// (or less) than PROVIDER_EXECUTION_TIMEOUT_MS.
	const timeoutMs = task.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS;

	// Emitted here, before the blocking adapter.execute call below, so the
	// routed provider/model/deadline are visible immediately rather than only
	// discoverable after the (up to timeoutMs-long) call returns.
	const routedDeadline = new Date(Date.now() + timeoutMs).toISOString();
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "task_routed",
			status: `Task ${task.id} routed to ${routeResult.provider}${routeResult.model ? `/${routeResult.model}` : ""}`,
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}
	if (context.onTaskRouted) {
		context.onTaskRouted({
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}

	const prompt = task.prompt || task.description || task.title;
	const execution = adapter.execute(prompt, context.workingContainerName, {
		model: routeResult.model ?? undefined,
		timeoutMs,
	});

	if (!execution.success) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: execution.timedOut ? "execution_timed_out" : "execution_failed",
			reason: execution.error ?? routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
		});

		if (execution.timedOut) {
			// The adapter already killed the orphaned in-container process
			// before returning (see adapter/orphan-kill.mjs), so this reads a
			// stable snapshot rather than one still being mutated. Surfaced as
			// a review artifact only — deliberately NOT run through
			// context.integrationGate, so an interrupted (possibly broken,
			// possibly mid-edit) diff can never auto-apply as if the task had
			// succeeded. INV-2: the gate is the only reviewed door back to the
			// host, and this diff has not been reviewed.
			const partialDiff = adapter.captureDiff(context.workingContainerName);
			return {
				taskId: task.id,
				success: false,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
				requiredCapability,
				result: "execution_timed_out",
				error: execution.error ?? null,
				errorKind: execution.errorKind ?? null,
				timedOut: true,
				partialDiff,
			};
		}

		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			result: "execution_failed",
			error: execution.error ?? null,
			errorKind: execution.errorKind ?? null,
		};
	}

	const diff = adapter.captureDiff(context.workingContainerName);
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "diff_captured",
			status: "Diff captured",
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			byteCount: diff ? diff.length : 0,
		});
	}

	if (!diff && task.requiredPaths === null) {
		record({
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
			requiredCapability,
			result: "success_no_diff",
		};
	}

	const gateResult = context.integrationGate(diff, context.projectPath, {
		requiredPaths: task.requiredPaths,
		allowSensitiveManifests:
			task.type === "implementation" && task.allowManifests === true,
	});
	const success = Boolean(gateResult?.success);
	const safeGateFailure = success
		? null
		: integrationFailureMetadata(task.id, diff, gateResult?.credentialFlagged);

	if (context.onStatus) {
		context.onStatus({
			phase: "integration",
			event: "gate_validated",
			status: success ? "ok" : safeGateFailure.reason,
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			outcome: success ? "passed" : "rejected",
			errorKind: safeGateFailure?.errorKind,
			reasonCode: safeGateFailure?.reasonCode,
			artifactRef: safeGateFailure?.artifactRef,
		});
		if (success) {
			context.onStatus({
				phase: "integration",
				event: "gate_applied",
				status: "Diff applied via integration gate",
				taskId: task.id,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
			});
		}
	}

	record({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: success ? "success" : "integration_failed",
		...(safeGateFailure ?? {}),
		...(success ? { reason: routeResult.reason } : {}),
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	const result = {
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		result: success ? "success" : "integration_failed",
		...(safeGateFailure ?? {}),
	};
	if (!success && !gateResult?.credentialFlagged) {
		result.partialDiff = diff;
	}
	return result;
}

/**
 * Execute one task by launching and polling a headless orchestrator job.
 * @param {{id: string, title: string, description: string}} task
 * @param {object} context
 * @returns {Promise<object>}
 */
export async function executeTaskWithOrchestrator(task, context) {
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return nonSwitchyardExecutorResult(task, executor, requiredCapability);
	}
	const routeResult = context.route({
		requiredCapability,
		availableProviders: Object.keys(context.adapters ?? {}),
		exclude: context.exclude,
		only: context.only,
	});

	// Provenance (Task 1.6, M7/M8) — same treatment as executeTask: resolve the
	// six fields once, attach to routeResult, and route every dispatch record
	// through the provenance-injecting `record()`.
	const provenance = resolveRouteProvenance(
		routeResult.provider,
		requiredCapability,
	);
	Object.assign(routeResult, { requiredCapability }, provenance);
	const record = async (dispatch) =>
		await context.recordDispatch({
			...provenance,
			...dispatch,
			requiredCapability,
		});

	if (!routeResult.provider) {
		await record({
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
			requiredCapability,
			result: "no_provider",
			reason: routeResult.reason,
			errorKind: null,
		};
	}

	const routedDeadline = null;
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "task_routed",
			status: `Task ${task.id} routed to ${routeResult.provider}${routeResult.model ? `/${routeResult.model}` : ""}`,
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}
	if (context.onTaskRouted) {
		context.onTaskRouted({
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}

	let jobId;
	try {
		jobId = await context.orchestrator.launch({
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			prompt: task.prompt || task.description || task.title,
			workingContainerName: context.workingContainerName,
		});
	} catch (error) {
		await record({
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
			requiredCapability,
			result: "launch_failed",
			errorKind: null,
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
		await record({
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
			requiredCapability,
			result: `orchestrator_${waited.state}`,
			errorKind: null,
			// Propagate the wait result's timeout verdict so the durable
			// checkpoint record (timedOut: Boolean(result.timedOut)) is
			// truthful for an orchestrator_timed_out outcome.
			timedOut: waited.timedOut,
		};
	}

	let jobResult;
	try {
		jobResult = await context.orchestrator.result(jobId);
	} catch (error) {
		await record({
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
			requiredCapability,
			result: "result_fetch_failed",
			errorKind: null,
		};
	}
	if (!jobResult?.success) {
		await record({
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
			requiredCapability,
			result: "execution_failed",
			errorKind: jobResult?.errorKind ?? null,
		};
	}

	const diff = typeof jobResult.diff === "string" ? jobResult.diff.trim() : "";
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "diff_captured",
			status: "Diff captured",
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			byteCount: diff.length,
		});
	}

	if (!diff && task.requiredPaths === null) {
		await record({
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
			requiredCapability,
			result: "success_no_diff",
		};
	}

	const gateResult = context.integrationGate(diff, context.projectPath, {
		requiredPaths: task.requiredPaths,
		allowSensitiveManifests:
			task.type === "implementation" && task.allowManifests === true,
	});
	const success = Boolean(gateResult?.success);
	const safeGateFailure = success
		? null
		: integrationFailureMetadata(task.id, diff, gateResult?.credentialFlagged);

	if (context.onStatus) {
		context.onStatus({
			phase: "integration",
			event: "gate_validated",
			status: success ? "ok" : safeGateFailure.reason,
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			outcome: success ? "passed" : "rejected",
			errorKind: safeGateFailure?.errorKind,
			reasonCode: safeGateFailure?.reasonCode,
			artifactRef: safeGateFailure?.artifactRef,
		});
		if (success) {
			context.onStatus({
				phase: "integration",
				event: "gate_applied",
				status: "Diff applied via integration gate",
				taskId: task.id,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
			});
		}
	}

	await record({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: success ? "success" : "integration_failed",
		...(safeGateFailure ?? {}),
		...(success ? { reason: routeResult.reason } : {}),
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	const result = {
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		result: success ? "success" : "integration_failed",
		...(safeGateFailure ?? {}),
	};
	if (!success && !gateResult?.credentialFlagged) {
		result.partialDiff = diff;
	}
	return result;
}

function _resolveOnStatus(deps) {
	const diagnostics = deps.diagnostics ?? null;
	const onStatus = deps.onStatus ?? null;

	if (!onStatus && !diagnostics) return null;

	return (event) => {
		if (diagnostics && typeof diagnostics.emit === "function") {
			diagnostics.emit(event);
		}
		if (onStatus && typeof onStatus === "function") {
			onStatus(event);
		}
	};
}

function _safeError(error) {
	if (error == null) return { message: "unknown error" };
	if (typeof error === "string") return { message: error };
	if (error instanceof Error) {
		const out = { name: error.name, message: error.message };
		if (error.code !== undefined) out.code = error.code;
		return out;
	}
	const out = {};
	if (error.name !== undefined) out.name = error.name;
	if (error.message !== undefined) out.message = error.message;
	if (error.code !== undefined) out.code = error.code;
	return out;
}

// Injected commit/reset seams (tests) can throw any JavaScript value — null,
// undefined, a string, a plain object — not just an Error. Format the failure
// for display without ever dereferencing `error.message` on such a value: an
// Error keeps its message (existing behavior); every other throw maps to one
// static, bounded label so arbitrary values can never leak into halt text or
// checkpoint-adjacent status events.
function _formatCheckpointActionError(error) {
	if (
		error instanceof Error &&
		typeof error.message === "string" &&
		error.message.length > 0
	) {
		return error.message;
	}
	return "unknown error";
}

/**
 * Build the halt outcome recorded when an owned working container's baseline
 * cannot be advanced (commit) or restored (reset) after a task. The task
 * itself is untouched — its durable checkpoint entry stays intact — this is a
 * run-level outcome explaining why the queue stopped.
 * The outcome's `result`/`action` are static, action-specific values
 * (`halted_after_commit_failure`/`commit` vs `halted_after_reset_failure`/
 * `reset`) so the durable checkpoint entry stays diagnosable without
 * persisting the underlying error, whose message may embed arbitrary command
 * stderr. The raw error text is kept only on the in-memory `error`/`reason`
 * fields for the immediate caller, never written to the checkpoint.
 * @param {{taskId: string, provider: string|null, model: string|null}} result
 * @param {string} actionLabel "commit" or "reset"
 * @param {Error} error The underlying commit/reset error
 * @returns {object}
 */
function _haltResult(result, actionLabel, error) {
	return {
		taskId: result.taskId,
		success: false,
		provider: result.provider ?? null,
		model: result.model ?? null,
		result: `halted_after_${actionLabel}_failure`,
		action: actionLabel,
		// Bounded: only a real Error's message is kept; a non-Error throw
		// value (including a plain object's `message`) never rides along.
		error: error instanceof Error ? error.message : null,
		reason: `${actionLabel} failed after task ${result.taskId}: ${_formatCheckpointActionError(error)}`,
	};
}

/**
 * Commit (after success) or reset (after a failed task when continuing) the
 * owned working container's baseline, per task so multi-task diffs stay
 * isolated (INV-2). A commit/reset failure leaves the container in a state
 * INV-3 forbids reusing — a success whose baseline was not advanced would
 * make the next task diff against (and re-emit) prior uncommitted work, and
 * a failed task whose changes were not reset would bleed into the next task —
 * so the run must halt instead of dispatching another task against it. The
 * existing console/status failure reporting is preserved verbatim.
 * @param {{success: boolean, taskId: string}} result
 * @param {object} deps
 * @param {boolean} deps.ownsWorkingContainer
 * @param {string} deps.workingContainerName
 * @param {boolean} deps.stopOnFailure
 * @param {(name: string) => void} deps.commitWorkingTreeFn
 * @param {(name: string) => void} deps.resetWorkingTreeFn
 * @param {Function|null} deps.emitStatus
 * @param {string} deps.logPrefix Console.error prefix ("runQueue: " or similar)
 * @returns {object|null} A halt outcome (result: "halted_after_<action>_failure",
 *   e.g. "halted_after_commit_failure" or "halted_after_reset_failure")
 *   when the baseline could not be advanced/reset, else null.
 */
function commitOrResetWorkingContainer(result, deps) {
	const {
		ownsWorkingContainer,
		workingContainerName,
		stopOnFailure,
		commitWorkingTreeFn,
		resetWorkingTreeFn,
		emitStatus,
		logPrefix,
	} = deps;

	if (!ownsWorkingContainer) return null;

	if (result.success) {
		try {
			commitWorkingTreeFn(workingContainerName);
		} catch (error) {
			const message = _formatCheckpointActionError(error);
			console.error(
				`${logPrefix} could not checkpoint working container after task ${result.taskId}: ${message}`,
			);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_failed",
					status: `Checkpoint commit failed: ${message}`,
					taskId: result.taskId,
					error: _safeError(error),
				});
			}
			return _haltResult(result, "commit", error);
		}
	} else if (!stopOnFailure) {
		try {
			resetWorkingTreeFn(workingContainerName);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "state_reset",
					status: `Reset working tree after failed task ${result.taskId}`,
					taskId: result.taskId,
				});
			}
		} catch (error) {
			const message = _formatCheckpointActionError(error);
			console.error(
				`${logPrefix} could not reset working container after task ${result.taskId}: ${message}`,
			);
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_failed",
					status: `Checkpoint reset failed: ${message}`,
					taskId: result.taskId,
					error: _safeError(error),
				});
			}
			return _haltResult(result, "reset", error);
		}
	}

	return null;
}

/**
 * Record a commit/reset-halt outcome in the returned results and the durable
 * checkpoint, and surface it on the status channel. The halted task's own
 * checkpoint entry is not modified — completedTaskIds and its result stay on
 * disk exactly as the pre-commit save wrote them (INV-6). The durable entry
 * carries only static, secret-safe fields (result/action), never the raw
 * error message that may contain command output.
 *
 * The halt entry is saved through the normal atomic saveCheckpoint at the
 * point it is recorded — before the queue_halted observer event (and the
 * later terminal event) can fire — so an observer reading the checkpoint at
 * that moment already sees the halt outcome (INV-6: durable before
 * observable). The final save callers make after the run remains and covers
 * the non-halt fields/zero-runnable path.
 * @param {object} checkpoint
 * @param {string} checkpointPath
 * @param {object[]} results
 * @param {object} haltResult
 * @param {Function|null} emitStatus
 */
function recordHalt(
	checkpoint,
	checkpointPath,
	results,
	haltResult,
	emitStatus,
) {
	const safeFailure = failureMetadataFor(haltResult);
	results.push(haltResult);
	checkpoint.results.push({
		taskId: haltResult.taskId,
		provider: haltResult.provider,
		model: haltResult.model,
		result: haltResult.result,
		action: haltResult.action,
		success: haltResult.success,
		timedOut: false,
		partialDiffPath: null,
		...(safeFailure ?? {}),
		timestamp: new Date().toISOString(),
	});
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
	if (emitStatus) {
		emitStatus({
			phase: "lifecycle",
			event: "queue_halted",
			status: `Queue halted after task ${haltResult.taskId}: ${safeFailure?.reason ?? "The queue halted after a checkpoint action failure."}`,
			taskId: haltResult.taskId,
			error: safeFailure ? { message: safeFailure.reason } : undefined,
			errorKind: safeFailure?.errorKind,
			reasonCode: safeFailure?.reasonCode,
		});
	}
}

/**
 * Install SIGINT/SIGTERM handlers that wipe an owned working container on
 * graceful termination, so a Ctrl-C or `kill` between tasks does not leak it
 * (part of the container leak-recovery loop). Returns an uninstall function to
 * call in the owner's finally so the handlers never outlive the run.
 *
 * Limitation: while a provider CLI runs via a blocking execFileSync, Node
 * defers signal handlers until that call returns — a signal delivered
 * mid-execution is serviced only once the task finishes (when normal cleanup
 * runs anyway) — and a SIGKILL cannot be caught at all. The host-side
 * pre-dispatch sweep + `recover` is the backstop for both cases.
 * @param {string} containerName owned working container to wipe on signal
 * @param {(name: string) => void} wipeFn
 * @returns {() => void} uninstall
 */
function _installOwnedContainerSignalCleanup(containerName, wipeFn) {
	const handler = (signal) => {
		try {
			wipeFn(containerName);
		} catch {
			/* best effort — recover is the backstop */
		}
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
		// Re-raise with default disposition so the exit status reflects the signal.
		process.kill(process.pid, signal);
	};
	process.on("SIGINT", handler);
	process.on("SIGTERM", handler);
	return () => {
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
	};
}

/**
 * Fail closed when a tasks file parses to zero tasks — this always indicates
 * a schema mismatch (wrong heading level, empty file, corrupted markdown),
 * never a legitimate "nothing to do" state. Writes an auditable checkpoint
 * carrying the failure detail before throwing, so a run that never reaches
 * the per-task loop still leaves the checkpoint file its caller reports.
 * @param {string} tasksFilePath
 * @param {string} checkpointPath
 * @param {Function|null} emitStatus
 * @throws {Error} always
 */
function throwOnEmptyParse(tasksFilePath, checkpointPath, emitStatus) {
	const message =
		`runQueue: no tasks parsed from ${tasksFilePath} — 0 headings matching ` +
		`"### Task <id>: <title>" were found. Expected format:\n` +
		`### Task <id>: <title>\n- **Status:** pending\n- **Description:** ...`;
	const failureCheckpoint = createEmptyCheckpoint(tasksFilePath);
	failureCheckpoint.parseError = {
		message: "no tasks parsed",
		tasksFilePath,
		detectedHeadings: 0,
		expectedFormat: "### Task <id>: <title>",
	};
	failureCheckpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, failureCheckpoint);
	if (emitStatus) {
		emitStatus({
			phase: "bootstrap",
			event: "parse_failed",
			status: message,
			error: { tasksFilePath, detectedHeadings: 0 },
		});
	}
	throw new Error(message);
}

// Shared by runQueue and runQueueWithOrchestrator so both execution paths
// report the same known-provider set as availableProviders to route() —
// the orchestrator path never calls execute()/captureDiff() on these (its
// dispatch goes through context.orchestrator.launch()), but still needs the
// same key set so its availableProviders filter isn't always empty (Task E.1).
const DEFAULT_ADAPTERS = {
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
	copilot: {
		execute: executeCopilot,
		captureDiff: captureCopilotDiff,
	},
	opencode: {
		execute: executeOpencode,
		captureDiff: captureOpencodeDiff,
	},
};

function recordDispatchToBothLedgers(
	dispatch,
	recordDispatchToStoreFn = recordDispatchToStore,
) {
	recordDispatch(dispatch);
	return recordDispatchToStoreFn(dispatch);
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
 * @param {string[]} [options.exclude] Provider names to never route to.
 * @param {string[]} [options.only] Provider names/target ids to restrict routing to.
 * @param {object} [options.dependencies]
 */
export function runQueue(options) {
	const {
		tasksFilePath,
		projectPath,
		workingContainerName: suppliedWorkingContainerName,
		checkpointPath = getCheckpointPath(tasksFilePath),
		maxTasks = Number.POSITIVE_INFINITY,
		stopOnFailure = true,
		exclude = [],
		only = [],
		taskIds = [],
		runOptions,
		queueIdentity,
		projectRevision,
		runId = null,
		dependencies = {},
	} = options;

	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});

	const ensureAgentContainerFn =
		dependencies.ensureAgentContainer ?? ensureAgentContainer;
	const createWorkingContainerFn =
		dependencies.createWorkingContainer ?? createWorkingContainer;
	const provisionCredentialsFn =
		dependencies.provisionCredentials ?? provisionCredentials;
	const seedProjectFn = dependencies.seedProject ?? seedProject;
	const commitWorkingTreeFn =
		dependencies.commitWorkingTree ?? commitWorkingTree;
	const resetWorkingTreeFn = dependencies.resetWorkingTree ?? resetWorkingTree;
	const wipeWorkingContainerFn =
		dependencies.wipeWorkingContainer ?? wipeWorkingContainer;
	const onTaskStart = dependencies.onTaskStart ?? null;
	const onTaskRouted = dependencies.onTaskRouted ?? null;
	const onResult = dependencies.onResult ?? null;
	const onCheckpointSaved = dependencies.onCheckpointSaved ?? null;
	const onContainerReady = dependencies.onContainerReady ?? null;
	const runStore = dependencies.runStore ?? null;
	const emitStatus = _resolveOnStatus(dependencies);

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	if (!workingContainerName) {
		ensureAgentContainerFn();
		// Pass runId so the working container carries the managed + run_id
		// labels (createWorkingContainer's labeled branch). Without this the
		// container is unlabeled and invisible to `recover` — the core leak.
		workingContainerName = createWorkingContainerFn(projectPath, undefined, {
			runId,
		});
		if (!workingContainerName) {
			throw new Error("runQueue: failed to create working container");
		}
		ownsWorkingContainer = true;
		uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
			workingContainerName,
			wipeWorkingContainerFn,
		);
		if (emitStatus) {
			emitStatus({
				phase: "bootstrap",
				event: "container_created",
				status: "Working container created",
				provider: null,
				model: null,
			});
		}
		try {
			provisionCredentialsFn(workingContainerName);
		} catch (error) {
			console.error(
				`runQueue: credential provisioning failed, continuing unauthenticated: ${error.message}`,
			);
		}
	}

	// Fires unconditionally once workingContainerName holds its final value —
	// whether just created above or supplied by the caller — so a caller
	// wiring the run record (e.g. worker-bootstrap) always learns the
	// container name, not just on the auto-created path.
	if (onContainerReady) {
		onContainerReady({ workingContainerName });
	}

	const recordDispatchToStoreFn =
		dependencies.recordDispatchToStore ?? recordDispatchToStore;
	let storeWriteChain = Promise.resolve();
	const defaultRecordDispatch = (dispatch) => {
		recordDispatch(dispatch);
		storeWriteChain = storeWriteChain.then(() =>
			recordDispatchToStoreFn(dispatch),
		);
		storeWriteChain = storeWriteChain.catch((error) => {
			console.warn(
				`runQueue: project-local dispatch ledger write failed: ${error.message}`,
			);
		});
	};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		onStatus: emitStatus,
		onTaskRouted,
		exclude,
		only,
	};

	try {
		if (ownsWorkingContainer) {
			try {
				seedProjectFn(workingContainerName, projectPath);
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "bootstrap",
						event: "seed_failed",
						status: `Seed failed: ${error.message}`,
						error: _safeError(error),
					});
				}
				throw error;
			}
		}

		const tasks = loadTaskQueue(tasksFilePath);
		if (tasks.length === 0) {
			throwOnEmptyParse(tasksFilePath, checkpointPath, emitStatus);
		}
		const identity = resolveQueueIdentity(
			{
				tasksFilePath,
				projectPath,
				checkpointPath,
				maxTasks,
				stopOnFailure,
				exclude,
				only,
				taskIds,
				runOptions,
				queueIdentity,
				projectRevision,
			},
			tasks,
		);
		const effectiveMaxTasks = identity.runOptions
			? (identity.runOptions.maxTasks ?? Number.POSITIVE_INFINITY)
			: maxTasks;
		const effectiveStopOnFailure = identity.runOptions
			? identity.runOptions.stopOnFailure
			: stopOnFailure;
		const effectiveExclude = identity.runOptions
			? identity.runOptions.excludeProviders
			: exclude;
		const effectiveOnly = identity.runOptions
			? identity.runOptions.onlyProviders
			: only;
		const effectiveTaskIds = identity.runOptions
			? identity.runOptions.taskIds
			: taskIds;
		context.exclude = effectiveExclude;
		context.only = effectiveOnly;
		const checkpoint = loadCheckpoint(
			checkpointPath,
			tasksFilePath,
			identity.enabled
				? {
						queueIdentity: identity.queueIdentity,
						runOptions: identity.runOptions,
					}
				: null,
		);
		const selectionOptions = identity.enabled
			? { selectedTaskIds: effectiveTaskIds }
			: {};
		const initialRunnable = getRunnableTasks(
			tasks,
			checkpoint,
			selectionOptions,
		);
		const attemptedTaskIds = new Set();
		const results = [];
		let processed = 0;
		let halted = false;

		while (processed < effectiveMaxTasks) {
			const runnable = getRunnableTasks(tasks, checkpoint, {
				excludedTaskIds: attemptedTaskIds,
				...selectionOptions,
			});
			const task = runnable[0];
			if (!task) break;
			attemptedTaskIds.add(task.id);

			if (onTaskStart) onTaskStart(task);
			if (runStore) {
				runStore
					.updateRun({ activeTaskId: task.id })
					.then((upd) => {
						runStore._rev = upd.revision;
					})
					.catch(() => {});
			}
			if (emitStatus) {
				emitStatus({
					phase: "execution",
					event: "task_started",
					status: `Starting task ${task.id}`,
					taskId: task.id,
				});
			}
			const result = executeTask(task, context);
			if (result.partialDiff) {
				try {
					result.partialDiffPath = savePartialDiff(
						checkpointPath,
						result.taskId,
						result.partialDiff,
					);
					if (emitStatus) {
						emitStatus({
							phase: "execution",
							event: "partial_diff_captured",
							status: result.timedOut
								? `Task ${result.taskId} timed out; partial diff saved for review (not applied)`
								: `Task ${result.taskId} was rejected (${result.result}); diff saved for review (not applied)`,
							taskId: result.taskId,
							partialDiffPath: result.partialDiffPath,
							byteCount: result.partialDiff.length,
						});
					}
				} catch (error) {
					console.error(
						`runQueue: could not save diff artifact for task ${result.taskId}: ${error.message}`,
					);
				}
				// Raw diff text stays out of checkpoint.json / onResult payloads —
				// the artifact on disk (partialDiffPath) is the single copy.
				result.partialDiff = undefined;
			} else if (result.timedOut) {
				// The rescue attempt itself came up empty (no edits were made
				// before the kill, or diff capture failed — e.g. a container in a
				// state git couldn't diff). Distinct from the diff-captured case so
				// this doesn't collapse into a generic task_failed: an operator
				// needs to know whether their in-progress work was actually saved,
				// not just that the task didn't finish.
				if (emitStatus) {
					emitStatus({
						phase: "execution",
						event: "partial_diff_capture_failed",
						status: `Task ${result.taskId} timed out; no diff was recovered (no edits made, or diff capture failed)`,
						taskId: result.taskId,
					});
				}
			}
			if (onResult) onResult(result);
			const safeFailure = failureMetadataFor(result, result.partialDiffPath);
			if (emitStatus) {
				if (result.success) {
					emitStatus({
						phase: "execution",
						event: "task_completed",
						status: `Task ${result.taskId} completed`,
						taskId: result.taskId,
						provider: result.provider ?? null,
						model: result.model ?? null,
					});
				} else {
					emitStatus({
						phase: "execution",
						event: "task_failed",
						status: `Task ${result.taskId} failed: ${result.result}`,
						taskId: result.taskId,
						provider: result.provider ?? null,
						model: result.model ?? null,
						error: safeFailure ? { message: safeFailure.reason } : undefined,
						errorKind: safeFailure?.errorKind,
						reasonCode: safeFailure?.reasonCode,
						reason: safeFailure?.reason,
						artifactRef: safeFailure?.artifactRef,
					});
				}
			}
			results.push(result);
			checkpoint.results.push({
				taskId: result.taskId,
				provider: result.provider,
				model: result.model,
				result: result.result,
				success: result.success,
				timedOut: Boolean(result.timedOut),
				partialDiffPath: null,
				...(safeFailure ?? {}),
				timestamp: new Date().toISOString(),
			});
			checkpoint.lastTaskId = result.taskId;
			checkpoint.lastUpdatedAt = new Date().toISOString();

			if (result.success) {
				checkpoint.completedTaskIds.push(result.taskId);
			}

			try {
				saveCheckpoint(checkpointPath, checkpoint);
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "checkpoint",
						event: "checkpoint_failed",
						status: `Checkpoint save failed: ${error.message}`,
						taskId: result.taskId,
						error: _safeError(error),
					});
				}
				throw error;
			}
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_saved",
					status: `Checkpoint saved after task ${result.taskId}`,
					taskId: result.taskId,
				});
			}
			if (onCheckpointSaved) onCheckpointSaved();

			// The checkpoint/result bookkeeping block above runs ahead of the
			// working-container commit/reset below: a commit or reset failure (or
			// a crash mid-commit) must never leave a task whose execute succeeded
			// missing from the durable checkpoint (INV-6). The result and
			// completedTaskIds are on disk before commit is even attempted.
			const haltResult = commitOrResetWorkingContainer(result, {
				ownsWorkingContainer,
				workingContainerName,
				stopOnFailure: effectiveStopOnFailure,
				commitWorkingTreeFn,
				resetWorkingTreeFn,
				emitStatus,
				logPrefix: "runQueue: ",
			});
			if (runStore) {
				runStore.updateRun({}).catch(() => {});
			}
			processed += 1;

			// A commit/reset failure leaves the owned working container in a
			// state INV-3 forbids reusing (an unadvanced baseline or a failed
			// task's un-reset changes), so the run must halt here — after this
			// task's checkpoint/bookkeeping and failure handling — before the
			// next task's execute/gate/capture can begin. The completed task's
			// checkpoint stays durable for a later invocation on a fresh
			// container; the halt itself is recorded as a distinct outcome.
			if (haltResult) {
				recordHalt(checkpoint, checkpointPath, results, haltResult, emitStatus);
				halted = true;
				break;
			}

			if (!result.success && effectiveStopOnFailure) {
				break;
			}
		}

		if (emitStatus) {
			emitStatus({
				phase: "lifecycle",
				event: "terminal",
				status: `Queue ${halted ? "halted" : "complete"}: ${processed} tasks processed`,
			});
		}
		if (runStore) {
			const anyFailed = results.some((r) => !r.success);
			runStore
				.updateRun({
					state: anyFailed ? "failed" : "succeeded",
					activeTaskId: null,
					cleanupState: "complete",
				})
				.catch(() => {});
		}

		// Guarantee a checkpoint file exists at the path this return value
		// reports, even when the per-task loop above never ran (e.g. every
		// task was already completed by a prior checkpoint) — the caller must
		// never be handed a checkpointPath with nothing on disk behind it.
		// A halt entry was already persisted by recordHalt before the
		// queue_halted event fired; this final save is a no-op for that entry
		// and remains for the other fields/zero-runnable path.
		saveCheckpoint(checkpointPath, checkpoint);

		return {
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			lastTaskId: checkpoint.lastTaskId,
			checkpointPath,
			...(identity.enabled
				? {
						queueIdentity: identity.queueIdentity,
						runOptions: identity.runOptions,
						projectRevision: identity.projectRevision,
					}
				: {}),
			results,
		};
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		if (ownsWorkingContainer) {
			if (emitStatus) {
				emitStatus({
					phase: "cleanup",
					event: "cleanup_started",
					status: "Wiping working container",
				});
			}
			try {
				wipeWorkingContainerFn(workingContainerName);
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_complete",
						status: "Cleanup complete",
					});
				}
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_failed",
						status: `Cleanup failed: ${error.message}`,
						error: _safeError(error),
					});
				}
				// biome-ignore lint/correctness/noUnsafeFinally: re-throwing the same error the bare wipe call would throw
				throw error;
			}
		}
	}
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
		workingContainerName: suppliedWorkingContainerName,
		checkpointPath = getCheckpointPath(tasksFilePath),
		maxTasks = Number.POSITIVE_INFINITY,
		stopOnFailure = true,
		exclude = [],
		only = [],
		taskIds = [],
		runOptions,
		queueIdentity,
		projectRevision,
		pollIntervalMs = 10_000,
		maxPolls = 1_000,
		runId = null,
		dependencies = {},
	} = options;

	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});

	const ensureAgentContainerFn =
		dependencies.ensureAgentContainer ?? ensureAgentContainer;
	const createWorkingContainerFn =
		dependencies.createWorkingContainer ?? createWorkingContainer;
	const provisionCredentialsFn =
		dependencies.provisionCredentials ?? provisionCredentials;
	const seedProjectFn = dependencies.seedProject ?? seedProject;
	const commitWorkingTreeFn =
		dependencies.commitWorkingTree ?? commitWorkingTree;
	const resetWorkingTreeFn = dependencies.resetWorkingTree ?? resetWorkingTree;
	const onTaskStart = dependencies.onTaskStart ?? null;
	const onTaskRouted = dependencies.onTaskRouted ?? null;
	const onResult = dependencies.onResult ?? null;
	const onCheckpointSaved = dependencies.onCheckpointSaved ?? null;
	const runStore = dependencies.runStore ?? null;
	const wipeWorkingContainerFn =
		dependencies.wipeWorkingContainer ?? wipeWorkingContainer;
	const emitStatus = _resolveOnStatus(dependencies);

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	if (!workingContainerName) {
		ensureAgentContainerFn();
		// Pass runId so the container is labeled managed + run_id (see runQueue).
		workingContainerName = createWorkingContainerFn(projectPath, undefined, {
			runId,
		});
		if (!workingContainerName) {
			throw new Error(
				"runQueueWithOrchestrator: failed to create working container",
			);
		}
		ownsWorkingContainer = true;
		uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
			workingContainerName,
			wipeWorkingContainerFn,
		);
		if (emitStatus) {
			emitStatus({
				phase: "bootstrap",
				event: "container_created",
				status: "Working container created",
				provider: null,
				model: null,
			});
		}
		try {
			provisionCredentialsFn(workingContainerName);
		} catch (error) {
			console.error(
				`runQueueWithOrchestrator: credential provisioning failed, continuing unauthenticated: ${error.message}`,
			);
		}
	}

	const recordDispatchToStoreFn =
		dependencies.recordDispatchToStore ?? recordDispatchToStore;
	const defaultRecordDispatch = async (dispatch) => {
		await recordDispatchToBothLedgers(dispatch, recordDispatchToStoreFn);
	};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		orchestrator: resolveOrchestrator(dependencies),
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		pollIntervalMs,
		maxPolls,
		now: dependencies.now ?? Date.now,
		sleepFn: dependencies.sleepFn ?? sleep,
		onPoll: dependencies.onPoll ?? null,
		onStatus: emitStatus,
		onTaskRouted,
	};

	try {
		if (ownsWorkingContainer) {
			try {
				seedProjectFn(workingContainerName, projectPath);
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "bootstrap",
						event: "seed_failed",
						status: `Seed failed: ${error.message}`,
						error: _safeError(error),
					});
				}
				throw error;
			}
		}

		const tasks = loadTaskQueue(tasksFilePath);
		if (tasks.length === 0) {
			throwOnEmptyParse(tasksFilePath, checkpointPath, emitStatus);
		}
		const identity = resolveQueueIdentity(
			{
				tasksFilePath,
				projectPath,
				checkpointPath,
				maxTasks,
				stopOnFailure,
				exclude,
				only,
				taskIds,
				runOptions,
				queueIdentity,
				projectRevision,
			},
			tasks,
		);
		const effectiveMaxTasks = identity.runOptions
			? (identity.runOptions.maxTasks ?? Number.POSITIVE_INFINITY)
			: maxTasks;
		const effectiveStopOnFailure = identity.runOptions
			? identity.runOptions.stopOnFailure
			: stopOnFailure;
		const effectiveExclude = identity.runOptions
			? identity.runOptions.excludeProviders
			: exclude;
		const effectiveOnly = identity.runOptions
			? identity.runOptions.onlyProviders
			: only;
		const effectiveTaskIds = identity.runOptions
			? identity.runOptions.taskIds
			: taskIds;
		context.exclude = effectiveExclude;
		context.only = effectiveOnly;
		const checkpoint = loadCheckpoint(
			checkpointPath,
			tasksFilePath,
			identity.enabled
				? {
						queueIdentity: identity.queueIdentity,
						runOptions: identity.runOptions,
					}
				: null,
		);
		const selectionOptions = identity.enabled
			? { selectedTaskIds: effectiveTaskIds }
			: {};
		const initialRunnable = getRunnableTasks(
			tasks,
			checkpoint,
			selectionOptions,
		);
		const attemptedTaskIds = new Set();
		const results = [];
		let processed = 0;
		let halted = false;

		while (processed < effectiveMaxTasks) {
			const runnable = getRunnableTasks(tasks, checkpoint, {
				excludedTaskIds: attemptedTaskIds,
				...selectionOptions,
			});
			const task = runnable[0];
			if (!task) break;
			attemptedTaskIds.add(task.id);

			if (onTaskStart) onTaskStart(task);
			if (runStore) {
				runStore
					.updateRun({ activeTaskId: task.id })
					.then((upd) => {
						runStore._rev = upd.revision;
					})
					.catch(() => {});
			}
			if (emitStatus) {
				emitStatus({
					phase: "execution",
					event: "task_started",
					status: `Starting task ${task.id}`,
					taskId: task.id,
				});
			}

			// eslint-disable-next-line no-await-in-loop
			const result = await executeTaskWithOrchestrator(task, context);

			if (onResult) onResult(result);
			const safeFailure = failureMetadataFor(result, result.partialDiffPath);
			if (emitStatus) {
				if (result.success) {
					emitStatus({
						phase: "execution",
						event: "task_completed",
						status: `Task ${result.taskId} completed`,
						taskId: result.taskId,
						provider: result.provider ?? null,
						model: result.model ?? null,
					});
				} else {
					emitStatus({
						phase: "execution",
						event: "task_failed",
						status: `Task ${result.taskId} failed: ${result.result}`,
						taskId: result.taskId,
						provider: result.provider ?? null,
						model: result.model ?? null,
						error: safeFailure ? { message: safeFailure.reason } : undefined,
						errorKind: safeFailure?.errorKind,
						reasonCode: safeFailure?.reasonCode,
						reason: safeFailure?.reason,
						artifactRef: safeFailure?.artifactRef,
					});
				}
			}

			results.push(result);
			checkpoint.results.push({
				taskId: result.taskId,
				provider: result.provider,
				model: result.model,
				result: result.result,
				success: result.success,
				timedOut: Boolean(result.timedOut),
				partialDiffPath: null,
				...(safeFailure ?? {}),
				timestamp: new Date().toISOString(),
			});
			checkpoint.lastTaskId = result.taskId;
			checkpoint.lastUpdatedAt = new Date().toISOString();

			if (result.success) {
				checkpoint.completedTaskIds.push(result.taskId);
			}

			try {
				saveCheckpoint(checkpointPath, checkpoint);
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "checkpoint",
						event: "checkpoint_failed",
						status: `Checkpoint save failed: ${error.message}`,
						taskId: result.taskId,
						error: _safeError(error),
					});
				}
				throw error;
			}
			if (emitStatus) {
				emitStatus({
					phase: "checkpoint",
					event: "checkpoint_saved",
					status: `Checkpoint saved after task ${result.taskId}`,
					taskId: result.taskId,
				});
			}
			if (onCheckpointSaved) onCheckpointSaved();

			// Same INV-6 ordering as runQueue: the checkpoint is on disk before
			// the working-container commit/reset is attempted.
			const haltResult = commitOrResetWorkingContainer(result, {
				ownsWorkingContainer,
				workingContainerName,
				stopOnFailure: effectiveStopOnFailure,
				commitWorkingTreeFn,
				resetWorkingTreeFn,
				emitStatus,
				logPrefix: "runQueueWithOrchestrator: ",
			});
			if (runStore) {
				runStore.updateRun({}).catch(() => {});
			}
			processed += 1;

			// Same INV-3 halt as runQueue: a commit/reset failure makes the
			// container non-reusable, so the run stops before the next task's
			// launch/status/result cycle instead of reusing an unadvanced or
			// un-reset baseline. The completed task's checkpoint stays durable.
			if (haltResult) {
				recordHalt(checkpoint, checkpointPath, results, haltResult, emitStatus);
				halted = true;
				break;
			}

			if (!result.success && effectiveStopOnFailure) {
				break;
			}
		}

		if (emitStatus) {
			emitStatus({
				phase: "lifecycle",
				event: "terminal",
				status: `Queue ${halted ? "halted" : "complete"}: ${processed} tasks processed`,
			});
		}
		if (runStore) {
			const anyFailed = results.some((r) => !r.success);
			runStore
				.updateRun({
					state: anyFailed ? "failed" : "succeeded",
					activeTaskId: null,
					cleanupState: "complete",
				})
				.catch(() => {});
		}

		// Guarantee a checkpoint file exists at the path this return value
		// reports, even when the per-task loop above never ran (e.g. every
		// task was already completed by a prior checkpoint) — the caller must
		// never be handed a checkpointPath with nothing on disk behind it.
		// A halt entry was already persisted by recordHalt before the
		// queue_halted event fired; this final save is a no-op for that entry
		// and remains for the other fields/zero-runnable path.
		saveCheckpoint(checkpointPath, checkpoint);

		return {
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			lastTaskId: checkpoint.lastTaskId,
			checkpointPath,
			...(identity.enabled
				? {
						queueIdentity: identity.queueIdentity,
						runOptions: identity.runOptions,
						projectRevision: identity.projectRevision,
					}
				: {}),
			results,
		};
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		if (ownsWorkingContainer) {
			if (emitStatus) {
				emitStatus({
					phase: "cleanup",
					event: "cleanup_started",
					status: "Wiping working container",
				});
			}
			try {
				wipeWorkingContainerFn(workingContainerName);
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_complete",
						status: "Cleanup complete",
					});
				}
			} catch (error) {
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_failed",
						status: `Cleanup failed: ${error.message}`,
						error: _safeError(error),
					});
				}
				// biome-ignore lint/correctness/noUnsafeFinally: re-throwing the same error the bare wipe call would throw
				throw error;
			}
		}
	}
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
