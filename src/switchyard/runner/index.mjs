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
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../adapter/constants.mjs";
import {
	captureDiff as captureCopilotDiff,
	execute as executeCopilot,
} from "../adapter/copilot.mjs";
import {
	captureDiff as captureCursorDiff,
	executeCursor,
} from "../adapter/cursor.mjs";
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
import { classifyTask, isValidTier } from "../roster/classifier.mjs";
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

const CHECKPOINT_VERSION = 1;
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
 * @returns {Array<{id: string, title: string, status: string, description: string, requiredPaths: string[]|null, allowManifests: boolean, timeoutMs: number|null, tier: string|null, type: string}>}
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

		// Task 2.1: an upstream task-queue author can declare a tier explicitly
		// rather than leaving it to classifyTask's keyword inference (INV-5
		// right-sizing). Absent is fine (executeTask falls back to
		// classifyTask); present-but-invalid is not — same fail-closed
		// convention as Files:/Timeout: above, not the silent lowest-tier
		// coercion this replaces (see resolveTaskTier / passesCapabilityFilter).
		let tier = null;
		const tierLine = block
			.split("\n")
			.find((line) => /^- \*\*Tier:\*\*\s/.test(line));
		if (tierLine) {
			const tierValue = tierLine.replace(/^- \*\*Tier:\*\*\s*/, "").trim();
			tier = parseTierField(tierValue, taskId);
		}

		let type = "implementation";
		const typeLine = block
			.split("\n")
			.find((line) => /^- \*\*Type:\*\*\s/.test(line));
		if (typeLine) {
			const typeValue = typeLine.replace(/^- \*\*Type:\*\*\s*/, "").trim();
			type = parseTypeField(typeValue, taskId);
		}

		if (type === "implementation" && requiredPaths === null) {
			throw new Error(
				`Task ${taskId}: implementation-type task requires a Files: field (declare Type: review to exempt review tasks)`,
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
			tier,
			type,
		});
	}

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

/**
 * Parse and validate a per-task `Tier:` declaration (Task 2.1). Same
 * fail-closed convention as parseTimeoutField/parseFilePaths: an
 * unrecognized value throws immediately rather than being silently accepted
 * — never coerced to a default tier here.
 * @param {string} raw The raw value of the Tier field, e.g. "standard"
 * @param {string} taskId Task identifier for error messages
 * @returns {string} normalized tier ('high'|'standard'|'low')
 * @throws {Error} If the value isn't a recognized tier
 */
function parseTierField(raw, taskId) {
	const trimmed = raw.trim().toLowerCase();
	if (!isValidTier(trimmed)) {
		throw new Error(
			`Task ${taskId}: invalid Tier field "${raw.trim()}" (expected one of: high, standard, low)`,
		);
	}
	return trimmed;
}

/**
 * Parse and validate a per-task `Type:` field (`implementation` | `review`).
 * Same fail-closed convention as parseTierField: an unrecognized value throws
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
 * @param {Array<{id: string, status: string}>} tasks
 * @param {object} checkpoint
 * @throws {Error} if two tasks share the same id (malformed queue)
 */
export function getRunnableTasks(tasks, checkpoint) {
	const done = new Set(checkpoint.completedTaskIds);
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

		if (done.has(task.id)) {
			continue; // already completed per checkpoint
		}

		runnable.push(task);
	}

	return runnable;
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
 * Resolve the tier to route a task at (Task 2.1 — respect the
 * upstream-declared tier). A declared `task.tier` (parseTaskQueue's `Tier:`
 * field) takes precedence over classifyTask's keyword inference, but only
 * when it is both present AND valid — an invalid/unrecognized declared tier
 * is rejected outright (fail closed, INV-5) rather than silently falling
 * back to classifyTask or reaching the roster's tier-order lookup, which
 * would otherwise coerce an unrecognized string to the least-restrictive
 * tier. classifyTask only runs when the tier is fully ABSENT from the task.
 * @param {{id: string, tier?: string|null, description?: string, title?: string}} task
 * @returns {string} tier ('high'|'standard'|'low')
 * @throws {Error} if task.tier is present but not a recognized tier
 */
function resolveTaskTier(task) {
	if (task.tier != null) {
		if (!isValidTier(task.tier)) {
			throw new Error(
				`Task ${task.id}: invalid declared tier "${task.tier}" (expected one of: high, standard, low) — refusing to silently route at a fallback tier`,
			);
		}
		return task.tier;
	}
	return classifyTask(task.description || task.title);
}

/**
 * Execute one task via routed provider/model and return a structured result.
 * @param {{id: string, title: string, description: string}} task
 * @param {object} context
 */
export function executeTask(task, context) {
	const tier = resolveTaskTier(task);
	const routeResult = context.route({
		tier,
		availableProviders: Object.keys(context.adapters ?? {}),
		exclude: context.exclude,
		only: context.only,
	});

	// Provenance (Task 1.6, M7/M8): resolve the six roster-provenance fields
	// once, attach them to routeResult, and route every dispatch record through
	// a local `record()` that spreads them in. Doing it here — not at each of
	// the recordDispatch call sites below — means no dispatch record can omit
	// provenance, and adds it in exactly one place per execute path.
	const provenance = resolveRouteProvenance(routeResult.provider, tier);
	Object.assign(routeResult, provenance);
	const record = (dispatch) =>
		context.recordDispatch({ ...provenance, ...dispatch });

	if (!routeResult.provider) {
		record({
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
			reason: routeResult.reason,
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
		});
	}
	if (context.onTaskRouted) {
		context.onTaskRouted({
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			deadline: routedDeadline,
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
				result: "execution_timed_out",
				error: execution.error ?? null,
				timedOut: true,
				partialDiff,
			};
		}

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
			result: "success_no_diff",
		};
	}

	const gateResult = context.integrationGate(diff, context.projectPath, {
		requiredPaths: task.requiredPaths,
		allowSensitiveManifests:
			task.type === "implementation" && task.allowManifests === true,
	});
	const success = Boolean(gateResult?.success);

	if (context.onStatus) {
		context.onStatus({
			phase: "integration",
			event: "gate_validated",
			status: gateResult?.message ?? (success ? "ok" : "rejected"),
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			outcome: success ? "passed" : "rejected",
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
		reason: gateResult?.message ?? routeResult.reason,
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	const result = {
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		result: success ? "success" : "integration_failed",
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
	const tier = resolveTaskTier(task);
	const routeResult = context.route({
		tier,
		availableProviders: Object.keys(context.adapters ?? {}),
		exclude: context.exclude,
	});

	// Provenance (Task 1.6, M7/M8) — same treatment as executeTask: resolve the
	// six fields once, attach to routeResult, and route every dispatch record
	// through the provenance-injecting `record()`.
	const provenance = resolveRouteProvenance(routeResult.provider, tier);
	Object.assign(routeResult, provenance);
	const record = async (dispatch) =>
		await context.recordDispatch({ ...provenance, ...dispatch });

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
			result: "no_provider",
			reason: routeResult.reason,
		};
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
			result: `orchestrator_${waited.state}`,
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
			result: "result_fetch_failed",
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
			result: "execution_failed",
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
			result: "success_no_diff",
		};
	}

	const gateResult = context.integrationGate(diff, context.projectPath, {
		requiredPaths: task.requiredPaths,
		allowSensitiveManifests:
			task.type === "implementation" && task.allowManifests === true,
	});
	const success = Boolean(gateResult?.success);

	if (context.onStatus) {
		context.onStatus({
			phase: "integration",
			event: "gate_validated",
			status: gateResult?.message ?? (success ? "ok" : "rejected"),
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			outcome: success ? "passed" : "rejected",
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
		reason: gateResult?.message ?? routeResult.reason,
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	const result = {
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		result: success ? "success" : "integration_failed",
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
		timestamp: new Date().toISOString(),
	});
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
	if (emitStatus) {
		emitStatus({
			phase: "lifecycle",
			event: "queue_halted",
			status: `Queue halted after task ${haltResult.taskId}: ${haltResult.reason}`,
			taskId: haltResult.taskId,
			error: _safeError(haltResult.error),
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
		runId = null,
		dependencies = {},
	} = options;

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
		const checkpoint = loadCheckpoint(checkpointPath, tasksFilePath);
		const runnable = getRunnableTasks(tasks, checkpoint);
		const results = [];
		let processed = 0;
		let halted = false;

		for (const task of runnable) {
			if (processed >= maxTasks) break;

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
						error: _safeError(result.error),
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
				partialDiffPath: result.partialDiffPath ?? null,
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
				stopOnFailure,
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

			if (!result.success && stopOnFailure) {
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
			runnableTasks: runnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			lastTaskId: checkpoint.lastTaskId,
			checkpointPath,
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
		pollIntervalMs = 10_000,
		maxPolls = 1_000,
		runId = null,
		dependencies = {},
	} = options;

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
		const checkpoint = loadCheckpoint(checkpointPath, tasksFilePath);
		const runnable = getRunnableTasks(tasks, checkpoint);
		const results = [];
		let processed = 0;
		let halted = false;

		for (const task of runnable) {
			if (processed >= maxTasks) break;

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
						error: _safeError(result.error),
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
				stopOnFailure,
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

			if (!result.success && stopOnFailure) {
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
			runnableTasks: runnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			lastTaskId: checkpoint.lastTaskId,
			checkpointPath,
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
