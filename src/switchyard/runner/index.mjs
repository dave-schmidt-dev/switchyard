// Runner module - host-side runner supervising headless orchestrator
// Reads persisted task queue, drives serial execution, checkpoints for resume.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	captureDiff as captureAgyDiff,
	captureDiffAsync as captureAgyDiffAsync,
	executeAgy,
	executeAgyAsync,
} from "../adapter/agy.mjs";
import {
	captureDiff as captureClaudeDiff,
	captureDiffAsync as captureClaudeDiffAsync,
	executeClaude,
	executeClaudeAsync,
} from "../adapter/claude.mjs";
import {
	captureDiff as captureCodexDiff,
	captureDiffAsync as captureCodexDiffAsync,
	executeCodex,
	executeCodexAsync,
} from "../adapter/codex.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../adapter/constants.mjs";
import {
	captureDiff as captureCopilotDiff,
	captureDiffAsync as captureCopilotDiffAsync,
	execute as executeCopilot,
	executeAsync as executeCopilotAsync,
} from "../adapter/copilot.mjs";
import {
	captureDiff as captureCursorDiff,
	captureDiffAsync as captureCursorDiffAsync,
	executeCursor,
	executeCursorAsync,
} from "../adapter/cursor.mjs";
import {
	PERSISTED_ERROR_KINDS,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import {
	captureDiff as captureOpencodeDiff,
	captureDiffAsync as captureOpencodeDiffAsync,
	execute as executeOpencode,
	executeAsync as executeOpencodeAsync,
} from "../adapter/opencode.mjs";
import { createBroker } from "../broker/index.mjs";
import {
	AGENT_IMAGE,
	buildAgentImage,
	checkContainerRuntime,
	imageExists,
	startAgentContainer,
} from "../container/index.mjs";
import { integrationGate } from "../integrate/index.mjs";
import {
	recordDispatch,
	recordDispatchIntentToStore,
	recordDispatchToStore,
} from "../ledger/index.mjs";
import { DockerExecutionBackend } from "../lifecycle/execution-backend.mjs";
import {
	commitWorkingTree,
	createWorkingContainer,
	provisionAllCredentialsWithBackend,
	provisionCredentials,
	resetWorkingTree,
	seedProject,
	seedProjectWithBackend,
	wipeWorkingContainer,
} from "../lifecycle/index.mjs";
import { ParallelsExecutionBackend } from "../lifecycle/parallels-execution-backend.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import { isValidCapabilityClass } from "../roster/classifier.mjs";
import {
	getInvocationDescriptor,
	normalizeProviderName,
	resolveRouteProvenance,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import {
	preflightMacosQueue,
	readSnapshotAtRoute,
	route,
} from "../router/index.mjs";
import { acquireVmSlot, releaseVmSlot } from "../run-store/index.mjs";

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
const BOUNDED_ERROR_KINDS = new Set(PERSISTED_ERROR_KINDS);
const HISTORICAL_CHECKPOINT_VERSION = 1;
const RUN_OPTIONS_VERSION = 1;
export const QUEUE_PLATFORMS = Object.freeze(["docker", "macos"]);
// Versioned contract shared by the host runner, detached worker, and any
// external headless orchestrator.  Keep this independent from the run-store
// schema so a durable record can remain readable while the wire contract
// evolves.
export const ORCHESTRATOR_PAYLOAD_VERSION = 1;
export const DISPATCH_DESCRIPTOR_CONTRACT_VERSION = 1;
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
		platform: normalizeQueuePlatform(options.platform),
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

/** Normalize the queue-level execution platform before any workspace exists. */
export function normalizeQueuePlatform(value = "docker") {
	const platform = String(value ?? "docker")
		.trim()
		.toLowerCase();
	if (!QUEUE_PLATFORMS.includes(platform)) {
		throw new Error(
			`runOptions.platform must be one of ${QUEUE_PLATFORMS.join(", ")}, got "${value}"`,
		);
	}
	return platform;
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
		options.queueIdentity != null ||
		options.runOptions != null ||
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

function descriptorFromRoute(
	routeResult,
	requiredCapability,
	resolveDescriptor,
) {
	if (!routeResult?.provider) return null;
	const routeTarget = routeResult.resolvedTargetId ?? null;
	const descriptorLookupTarget = routeTarget ?? routeResult.provider;
	const harness = routeResult.resolved_harness ?? routeResult.provider;
	const suppliedKey = [
		"invocationDescriptor",
		"invocation_descriptor",
		"dispatchDescriptor",
		"dispatch_descriptor",
	].find((key) => Object.hasOwn(routeResult, key));
	const supplied = suppliedKey ? routeResult[suppliedKey] : undefined;
	const current = resolveDescriptor(descriptorLookupTarget, requiredCapability);
	if (!current) {
		throw new Error(
			`missing dispatch descriptor receipt for ${descriptorLookupTarget ?? "unknown target"}`,
		);
	}
	const validatedCurrent = validateInvocationDescriptor(current, harness);
	if (routeTarget && validatedCurrent.target_id !== routeTarget) {
		throw new Error("dispatch descriptor target does not match routed target");
	}
	if (routeResult.model && routeResult.model !== validatedCurrent.selector) {
		throw new Error("dispatch descriptor selector does not match routed model");
	}
	if (supplied !== undefined && supplied !== null) {
		const validatedSupplied = validateInvocationDescriptor(supplied, harness);
		if (
			validatedSupplied.descriptor_identity !==
			validatedCurrent.descriptor_identity
		) {
			throw new Error("dispatch descriptor receipt changed or is stale");
		}
		if (routeTarget && validatedSupplied.target_id !== routeTarget) {
			throw new Error(
				"dispatch descriptor target does not match routed target",
			);
		}
		descriptorHarnesses.set(validatedSupplied, normalizeProviderName(harness));
		return validatedSupplied;
	}
	if (supplied === null) {
		throw new Error("missing dispatch descriptor receipt");
	}
	descriptorHarnesses.set(validatedCurrent, normalizeProviderName(harness));
	return validatedCurrent;
}

const descriptorHarnesses = new WeakMap();

function descriptorReceiptFields(descriptor, harness = null) {
	return descriptor
		? {
				dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
				invocationDescriptor: descriptor,
				descriptorIdentity: descriptor.descriptor_identity,
				descriptorHarness:
					harness ?? descriptorHarnesses.get(descriptor) ?? null,
			}
		: {
				dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
				invocationDescriptor: null,
				descriptorIdentity: null,
				descriptorHarness: null,
			};
}

const SAFE_LEDGER_ERROR_CODES = new Set([
	"EACCES",
	"EPERM",
	"EROFS",
	"ENOSPC",
	"EIO",
	"EMFILE",
	"ENFILE",
]);
const SAFE_ROUTE_REASON_CODES = new Set([
	"ambiguous_target",
	"blind_fallback",
	"no_eligible",
	"no_eligible_blind",
	"no_eligible_capability_ceiling",
	"no_eligible_upstream_unavailable",
	"quarantine_unresolvable",
	"spread",
	"priority_fill",
	"last_resort_fallback",
]);

function safeNoProviderReason(reason) {
	// Route diagnostics may contain upstream error text. Only the closed route
	// code crosses the result/status/ledger boundary; unknown text is generic.
	if (typeof reason !== "string") return "no_eligible";
	const code = reason.split(":", 1)[0];
	return SAFE_ROUTE_REASON_CODES.has(code) ? code : "no_eligible";
}

function safeSuccessfulRouteReason(reason) {
	if (typeof reason !== "string") return "spread";
	const code = reason.split(":", 1)[0];
	return SAFE_ROUTE_REASON_CODES.has(code) ? code : "spread";
}

function safeLedgerFailure(error, phase) {
	const code = SAFE_LEDGER_ERROR_CODES.has(error?.code)
		? error.code
		: "unknown";
	return {
		ledgerFailure: true,
		ledgerFailurePhase: phase,
		ledgerFailureCode: code,
	};
}

function classifiedIntentFailure(context, payload, metadata) {
	context.onStatus?.({
		phase: "ledger",
		event: "intent_receipt_failed",
		status: "Authoritative dispatch intent could not be recorded",
		...metadata,
		taskId: payload?.taskId,
		provider: payload?.provider,
	});
	context.onIntentReceiptFailure?.(metadata);
	return metadata;
}

function reportLegacyProjectionFailure(context, error) {
	const metadata = safeLedgerFailure(error, "legacy_projection");
	if (context.onStatus) {
		context.onStatus({
			phase: "ledger",
			event: "legacy_projection_failed",
			status: "Legacy dispatch projection failed",
			...metadata,
		});
	} else {
		console.warn(
			`${context.ledgerSource ?? "runner"}: legacy dispatch projection failed (${metadata.ledgerFailureCode})`,
		);
	}
	context.onLedgerProjectionFailure?.(metadata);
	return metadata;
}

/**
 * The outcome-projection twin of reportLegacyProjectionFailure.
 *
 * Both dispatch ledgers can fail independently, and both failures used to be
 * swallowed into bare console.warn calls that no caller could observe. They
 * now share one bounded classifier (safeLedgerFailure), one status phase, and
 * one callback, so a failed projection is a structured event on any surface
 * that supplies onStatus and only degrades to console.warn when none does.
 *
 * @param {object} context
 * @param {Error} error
 * @returns {{ledgerFailure: boolean, ledgerFailurePhase: string, ledgerFailureCode: string}}
 */
function reportOutcomeProjectionFailure(context, error) {
	const metadata = safeLedgerFailure(error, "outcome_projection");
	if (context.onStatus) {
		context.onStatus({
			phase: "ledger",
			event: "outcome_projection_failed",
			status: "Project-local dispatch outcome projection failed",
			...metadata,
		});
	} else {
		console.warn(
			`${context.ledgerSource ?? "runner"}: project-local dispatch outcome projection failed (${metadata.ledgerFailureCode})`,
		);
	}
	context.onLedgerProjectionFailure?.(metadata);
	return metadata;
}

/**
 * The minimal context the two ledger-failure reporters need. Built separately
 * from the executor `context` so the reporters can be reached from the dispatch
 * writers, which are constructed before that object exists.
 *
 * @param {Function|null} onStatus
 * @param {object} dependencies
 */
function ledgerReportingContext(
	onStatus,
	dependencies = {},
	source = "runner",
) {
	return {
		onStatus: onStatus ?? null,
		onLedgerProjectionFailure: dependencies.onLedgerProjectionFailure,
		// Only reaches the console fallback. The entry point is worth keeping in
		// that one line because it is all an operator gets when no status
		// surface is wired; the structured event carries the phase instead.
		ledgerSource: source,
	};
}

function dispatchIntentPayload(
	taskId,
	routeResult,
	requiredCapability,
	provenance,
	invocationDescriptor,
) {
	return {
		taskId,
		provider: routeResult.provider ?? null,
		model: invocationDescriptor?.selector ?? routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId: routeResult.resolvedTargetId ?? null,
		descriptorIdentity: invocationDescriptor?.descriptor_identity ?? null,
		descriptorHarness: routeResult.resolved_harness ?? null,
		...provenance,
	};
}

const DESCRIPTOR_RECEIPT_INVALID_REASON =
	"The dispatch descriptor receipt was invalid.";

export function writeDispatchIntent(context, payload) {
	if (typeof context?.recordDispatchIntent !== "function") {
		return classifiedIntentFailure(context ?? {}, payload, {
			ledgerFailure: true,
			ledgerFailurePhase: "authoritative_intent",
			ledgerFailureCode: "missing_writer",
		});
	}
	try {
		const receipt = context.recordDispatchIntent(payload);
		if (
			receipt !== null &&
			receipt !== undefined &&
			(typeof receipt === "object" || typeof receipt === "function") &&
			typeof receipt.then === "function"
		) {
			// Prevent a rejecting thenable from becoming an unhandled rejection;
			// the synchronous contract has already failed closed.
			Promise.resolve(receipt).catch(() => {});
			return classifiedIntentFailure(context, payload, {
				ledgerFailure: true,
				ledgerFailurePhase: "authoritative_intent",
				ledgerFailureCode: "async_writer",
			});
		}
		return null;
	} catch (error) {
		const metadata = safeLedgerFailure(error, "authoritative_intent");
		return classifiedIntentFailure(context, payload, metadata);
	}
}

export async function writeDispatchIntentAsync(context, payload) {
	if (typeof context?.recordDispatchIntent !== "function") {
		return classifiedIntentFailure(context ?? {}, payload, {
			ledgerFailure: true,
			ledgerFailurePhase: "authoritative_intent",
			ledgerFailureCode: "missing_writer",
		});
	}
	try {
		await context.recordDispatchIntent(payload);
		return null;
	} catch (error) {
		const metadata = safeLedgerFailure(error, "authoritative_intent");
		return classifiedIntentFailure(context, payload, metadata);
	}
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
 * @returns {Array<{id: string, title: string, status: string, description: string, requiredPaths: string[]|null, allowManifests: boolean, timeoutMs: number|null, requiredCapability: string|null, requiredCapabilityJustification: string|null, executor: string, type: string}>}
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
		const requiredCapabilityJustification =
			parseRequiredCapabilityJustificationField(block, taskId);
		if (
			requiredCapability &&
			requiredCapability !== "standard" &&
			requiredCapabilityJustification === null
		) {
			throw new Error(
				`Task ${taskId}: RequiredCapabilityJustification is required for explicit ${requiredCapability} capability tasks`,
			);
		}
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
			requiredCapabilityJustification,
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
 * Parse the optional justification for an explicitly declared capability.
 * Low/high declarations must carry a non-empty explanation; standard and
 * omitted declarations do not need one. The field remains attached to the
 * parsed task so programmatic and markdown task records share one contract.
 * @param {string} block Task markdown block
 * @param {string} taskId Task identifier for error messages
 * @returns {string|null} trimmed justification or null when absent
 */
function parseRequiredCapabilityJustificationField(block, taskId) {
	const values = getTaskFieldValues(block, "RequiredCapabilityJustification");
	if (values.length === 0) return null;
	if (values.length > 1) {
		throw new Error(
			`Task ${taskId}: duplicate RequiredCapabilityJustification declarations are not allowed`,
		);
	}

	const justification = values[0].trim();
	if (!justification) {
		throw new Error(
			`Task ${taskId}: RequiredCapabilityJustification field is empty`,
		);
	}
	return justification;
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
		validateRetryDescriptorEvidence(parsed);
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
		validateRetryDescriptorEvidence(parsed);
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
 * `task.requiredCapability` takes precedence, and explicit low/high values
 * require a non-empty justification. Missing capability fields use the
 * standard lane; this keeps legacy records readable without re-running the
 * keyword classifier or silently escalating them to high.
 * @param {{id: string, requiredCapability?: string|null, requiredCapabilityJustification?: string|null, tier?: unknown, description?: string, title?: string}} task
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
		if (
			task.requiredCapability !== "standard" &&
			(typeof task.requiredCapabilityJustification !== "string" ||
				task.requiredCapabilityJustification.trim() === "")
		) {
			throw new Error(
				`Task ${task.id}: RequiredCapabilityJustification is required for explicit ${task.requiredCapability} capability tasks`,
			);
		}
		return task.requiredCapability;
	}
	return "standard";
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

const RETRY_TRANSITION_TYPES = new Set([
	"attempt_recorded",
	"target_quarantined",
	"reset_completed",
	"retry_started",
	"finalized",
	"retry_halted",
]);

function normalizeRetryTargetId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) {
		return null;
	}
	if (
		[...value].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint <= 0x1f || codePoint === 0x7f;
		})
	) {
		return null;
	}
	return value;
}

function ensureRetryCheckpoint(checkpoint) {
	if (!Array.isArray(checkpoint.quarantinedTargetIds)) {
		checkpoint.quarantinedTargetIds = [];
	}
	checkpoint.quarantinedTargetIds = [
		...new Set(
			checkpoint.quarantinedTargetIds
				.map(normalizeRetryTargetId)
				.filter((targetId) => targetId !== null),
		),
	];
	for (const field of ["retryAttempts", "retryTransitions"]) {
		if (
			Object.hasOwn(checkpoint, field) &&
			checkpoint[field] !== undefined &&
			checkpoint[field] !== null &&
			!Array.isArray(checkpoint[field])
		) {
			throw new Error(`${field} is invalid`);
		}
		if (!Array.isArray(checkpoint[field])) checkpoint[field] = [];
	}
	if (!Number.isInteger(checkpoint.retryTransitionId)) {
		checkpoint.retryTransitionId = checkpoint.retryTransitions.length;
	}
	if (checkpoint.retryState === undefined) checkpoint.retryState = null;
	return checkpoint;
}

function hasExactRetryDescriptorEvidence(retryState) {
	return Boolean(
		retryState?.invocationDescriptor &&
			retryState.descriptorIdentity &&
			retryState.descriptorHarness,
	);
}

/**
 * Validate persisted retry descriptor evidence before it can authorize a
 * reset, reroute, or adapter execution. Retry records written before the
 * descriptor contract have no descriptor fields and remain readable; they
 * are handled by the fail-closed historical path in runQueue. Any partial or
 * malformed descriptor evidence is corruption, not legacy state.
 * @param {object} checkpoint
 * @throws {Error} when retry descriptor evidence is incoherent
 */
function validateRetryDescriptorEvidence(checkpoint) {
	const validateEntry = (entry, label) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${label} is invalid`);
		}
		const hasEvidence = [
			"invocationDescriptor",
			"descriptorIdentity",
			"descriptorHarness",
		].some((field) => entry[field] !== undefined && entry[field] !== null);
		if (!hasEvidence) return;

		if (
			!entry.invocationDescriptor ||
			typeof entry.descriptorIdentity !== "string" ||
			entry.descriptorIdentity.length === 0 ||
			typeof entry.descriptorHarness !== "string" ||
			entry.descriptorHarness.trim() === ""
		) {
			throw new Error(`${label} has incomplete descriptor evidence`);
		}
		const targetId = normalizeRetryTargetId(entry.resolvedTargetId);
		if (!targetId || targetId !== entry.resolvedTargetId) {
			throw new Error(`${label} descriptor target is invalid`);
		}

		let descriptor;
		try {
			descriptor = validateInvocationDescriptor(
				entry.invocationDescriptor,
				entry.descriptorHarness,
			);
		} catch {
			throw new Error(`${label} contains an invalid descriptor receipt`);
		}
		if (descriptor.descriptor_identity !== entry.descriptorIdentity) {
			throw new Error(`${label} descriptor identity does not match receipt`);
		}
		if (descriptor.target_id !== targetId) {
			throw new Error(`${label} descriptor target does not match target`);
		}

		const targetIdentity = resolveTargetIdentity(targetId);
		if (
			targetIdentity.targetId === targetId &&
			targetIdentity.harnessKey &&
			normalizeProviderName(entry.descriptorHarness) !==
				normalizeProviderName(targetIdentity.harnessKey)
		) {
			throw new Error(`${label} descriptor harness does not match target`);
		}
	};

	if (checkpoint.retryState !== undefined && checkpoint.retryState !== null) {
		validateEntry(checkpoint.retryState, "retryState");
	}
	for (const field of ["retryAttempts", "retryTransitions"]) {
		if (checkpoint[field] === undefined || checkpoint[field] === null) continue;
		if (!Array.isArray(checkpoint[field])) {
			throw new Error(`${field} is invalid`);
		}
		checkpoint[field].forEach((entry, index) => {
			validateEntry(entry, `${field}[${index}]`);
		});
	}
}

function mergeRetryExclusions(base, quarantinedTargetIds) {
	return [
		...new Set([
			...(Array.isArray(base) ? base : []),
			...(Array.isArray(quarantinedTargetIds)
				? quarantinedTargetIds.filter(
						(targetId) => normalizeRetryTargetId(targetId) !== null,
					)
				: []),
		]),
	];
}

function persistRetryTransition(
	checkpoint,
	checkpointPath,
	{
		type,
		taskId,
		attempt,
		provider = null,
		model = null,
		resolvedTargetId = null,
		invocationDescriptor = null,
		descriptorIdentity = null,
		descriptorHarness = null,
		phase = type,
		clearState = false,
		save = true,
	},
) {
	if (!RETRY_TRANSITION_TYPES.has(type)) {
		throw new Error(`unknown retry transition: ${type}`);
	}
	const targetId = normalizeRetryTargetId(resolvedTargetId);
	const transitionId = checkpoint.retryTransitionId + 1;
	const transition = {
		transitionId,
		type,
		taskId,
		attempt,
		provider: typeof provider === "string" ? provider : null,
		model: typeof model === "string" ? model : null,
		resolvedTargetId: targetId,
		invocationDescriptor,
		descriptorIdentity,
		descriptorHarness,
		timestamp: new Date().toISOString(),
	};
	checkpoint.retryTransitionId = transitionId;
	checkpoint.retryTransitions.push(transition);
	checkpoint.retryState = clearState
		? null
		: {
				taskId,
				attempt,
				phase,
				resolvedTargetId: targetId,
				invocationDescriptor,
				descriptorIdentity,
				descriptorHarness,
			};
	checkpoint.lastUpdatedAt = transition.timestamp;
	if (save) saveCheckpoint(checkpointPath, checkpoint);
	return transition;
}

function appendRetryAttempt(checkpoint, result, attempt) {
	const safeFailure = failureMetadataFor(result);
	checkpoint.retryAttempts.push({
		taskId: result.taskId,
		attempt,
		provider: result.provider ?? null,
		model: result.model ?? null,
		resolvedTargetId: normalizeRetryTargetId(result.resolvedTargetId),
		invocationDescriptor: result.invocationDescriptor ?? null,
		descriptorIdentity: result.descriptorIdentity ?? null,
		descriptorHarness: result.descriptorHarness ?? null,
		result: result.result,
		success: Boolean(result.success),
		timedOut: Boolean(result.timedOut),
		...(safeFailure ?? {}),
	});
}

function isQuotaRetryCandidate(result, ownsWorkingContainer) {
	return Boolean(
		ownsWorkingContainer &&
			result &&
			result.result === "execution_failed" &&
			result.errorKind === "quota_exhausted" &&
			normalizeRetryTargetId(result.resolvedTargetId),
	);
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

function opaqueArtifactRef(value) {
	return typeof value === "string" && /^artifact:[a-f0-9]{24}$/.test(value)
		? value
		: undefined;
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
	let invocationDescriptor;
	try {
		invocationDescriptor = descriptorFromRoute(
			routeResult,
			requiredCapability,
			context.resolveDescriptor ?? getInvocationDescriptor,
		);
	} catch {
		try {
			context.recordDispatch({
				...provenance,
				...descriptorReceiptFields(null),
				resolvedTargetId: routeResult.resolvedTargetId ?? null,
				provider: routeResult.provider ?? "none",
				model: routeResult.model ?? null,
				taskId: task.id,
				result: "descriptor_receipt_invalid",
				reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
				requiredCapability,
			});
		} catch (projectionError) {
			reportLegacyProjectionFailure(context, projectionError);
		}
		return {
			...descriptorReceiptFields(null),
			taskId: task.id,
			success: false,
			provider: routeResult.provider ?? null,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			result: "descriptor_receipt_invalid",
			errorKind: "descriptor_receipt",
			reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
		};
	}
	Object.assign(routeResult, descriptorReceiptFields(invocationDescriptor));
	context._activeInvocationDescriptor = invocationDescriptor;
	let projectionFailure = null;
	const record = (dispatch) => {
		try {
			context.recordDispatch({
				...provenance,
				...descriptorReceiptFields(invocationDescriptor),
				resolvedTargetId: routeResult.resolvedTargetId ?? null,
				...dispatch,
				requiredCapability,
			});
		} catch (error) {
			projectionFailure = reportLegacyProjectionFailure(context, error);
		}
	};
	const resolvedTargetId = routeResult.resolvedTargetId ?? null;

	if (!routeResult.provider) {
		const noProviderReason = safeNoProviderReason(routeResult.reason);
		record({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason: noProviderReason,
			errorKind: null,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			requiredCapability,
			resolvedTargetId,
			result: "no_provider",
			reason: noProviderReason,
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
			reason: safeSuccessfulRouteReason(routeResult.reason),
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
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
			model: invocationDescriptor.selector,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			...descriptorReceiptFields(invocationDescriptor),
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}
	if (context.onTaskRouted) {
		context.onTaskRouted({
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			...descriptorReceiptFields(invocationDescriptor),
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}

	const intentFailure = writeDispatchIntent(
		context,
		dispatchIntentPayload(
			task.id,
			routeResult,
			requiredCapability,
			provenance,
			invocationDescriptor,
		),
	);
	if (intentFailure) {
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "intent_receipt_failed",
			errorKind: "intent_receipt",
			...intentFailure,
		};
	}

	const prompt = task.prompt || task.description || task.title;
	const routedModel = invocationDescriptor?.selector ?? routeResult.model;
	const execution = adapter.execute(prompt, context.workingContainerName, {
		model: routedModel ?? undefined,
		timeoutMs,
		executionBackend: context.executionBackend,
		invocationDescriptor,
		descriptorIdentity: invocationDescriptor?.descriptor_identity ?? null,
		descriptorHarness: routeResult.resolved_harness ?? null,
		resolvedTargetId,
	});

	if (!execution.success) {
		if (execution.timedOut) {
			// The adapter already killed the orphaned in-container process
			// before returning (see adapter/orphan-kill.mjs), so this reads a
			// stable snapshot rather than one still being mutated. Surfaced as
			// a review artifact only — deliberately NOT run through
			// context.integrationGate, so an interrupted (possibly broken,
			// possibly mid-edit) diff can never auto-apply as if the task had
			// succeeded. INV-2: the gate is the only reviewed door back to the
			// host, and this diff has not been reviewed.
			let partialDiff = null;
			try {
				partialDiff = adapter.captureDiff(context.workingContainerName, {
					executionBackend: context.executionBackend,
				});
			} catch {
				partialDiff = null;
			}
			const captureFailed = !partialDiff;
			const cleanupFailed = execution.cleanupFailed === true;
			const resultName = cleanupFailed
				? "execution_timed_out_cleanup_failed"
				: captureFailed
					? "execution_timed_out_capture_failed"
					: "execution_timed_out";
			const error = cleanupFailed
				? (execution.error ?? "provider cleanup failed after timeout")
				: captureFailed
					? "diff capture failed after timeout"
					: (execution.error ?? null);
			record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: resultName,
				errorKind:
					(cleanupFailed && "provider_cleanup_failed") ||
					(captureFailed && "diff_capture_failed") ||
					execution.errorKind ||
					null,
				reason: error ?? routeResult.reason,
				percentLeft: routeResult.percentLeft ?? undefined,
			});
			return {
				...descriptorReceiptFields(invocationDescriptor),
				taskId: task.id,
				success: false,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
				requiredCapability,
				resolvedTargetId,
				result: resultName,
				error,
				errorKind:
					(cleanupFailed && "provider_cleanup_failed") ||
					(captureFailed && "diff_capture_failed") ||
					execution.errorKind ||
					null,
				timedOut: true,
				...(partialDiff ? { partialDiff } : {}),
			};
		}

		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			errorKind: execution.errorKind ?? null,
			reason: execution.error ?? routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
		});

		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor?.selector ?? routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "execution_failed",
			error: execution.error ?? null,
			errorKind: execution.errorKind ?? null,
		};
	}

	const diff = adapter.captureDiff(context.workingContainerName, {
		executionBackend: context.executionBackend,
	});
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "diff_captured",
			status: "Diff captured",
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			byteCount: diff ? diff.length : 0,
		});
	}

	if (!diff && task.requiredPaths === null) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			reason: safeSuccessfulRouteReason(routeResult.reason),
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: true,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "success_no_diff",
		};
	}

	const gateResult = context.integrationGate(diff, context.projectPath, {
		requiredPaths: task.requiredPaths,
		allowSensitiveManifests:
			task.type === "implementation" && task.allowManifests === true,
	});
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const success = Boolean(gateResult?.success) || alreadyApplied;
	const terminalResult = success ? "success" : "integration_failed";
	const safeGateFailure = success
		? null
		: integrationFailureMetadata(task.id, diff, gateResult?.credentialFlagged);
	const gateArtifactRef = opaqueArtifactRef(gateResult?.artifactRef);

	if (context.onStatus) {
		context.onStatus({
			phase: "integration",
			event: "gate_validated",
			status: success
				? alreadyApplied
					? "already applied"
					: "ok"
				: safeGateFailure.reason,
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			outcome: success
				? alreadyApplied
					? "already_applied"
					: "passed"
				: "rejected",
			errorKind: safeGateFailure?.errorKind,
			reasonCode: safeGateFailure?.reasonCode,
			artifactRef: safeGateFailure?.artifactRef ?? gateArtifactRef,
		});
		if (success) {
			context.onStatus({
				phase: "integration",
				event: "gate_applied",
				status: alreadyApplied
					? "Diff already applied; integration gate confirmed terminal state"
					: "Diff applied via integration gate",
				taskId: task.id,
				provider: routeResult.provider,
				model: invocationDescriptor.selector,
			});
		}
	}

	record({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: terminalResult,
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...(success
			? { reason: safeSuccessfulRouteReason(routeResult.reason) }
			: {}),
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	const result = {
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: terminalResult,
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...(projectionFailure
			? { legacyProjectionFailure: projectionFailure }
			: {}),
	};
	if (!success && !gateResult?.credentialFlagged) {
		result.partialDiff = diff;
	}
	return result;
}

/**
 * Async provider-backed execution seam. The synchronous executeTask API remains
 * for legacy callers, while queue workers that can await use each adapter's
 * shared spawn/poll lifecycle through this path.
 */
export async function executeTaskAsync(task, context) {
	clearAsyncTaskContext(context);
	const requiredCapability = resolveTaskRequiredCapability(task);
	try {
		return await executeTaskAsyncUnsafe(task, context);
	} catch (error) {
		const route = context._activeBrokerRoute;
		const routed = context._activeTaskRoute;
		const failure = asyncExecutionFailureMetadata(error, task.id);
		context._activeBrokerRoute = null;
		if (route?.reservation && context.broker?.release) {
			try {
				await context.broker.release(route, "failure");
			} catch {
				// The task failure remains bounded; recovery handles an unavailable ledger.
			}
		}
		if (!context._activeDispatchOutcomeRecorded) {
			try {
				await Promise.resolve(
					context.recordDispatch({
						provider: routed?.provider ?? "none",
						model: routed?.model ?? "none",
						taskId: task.id,
						result: "execution_failed",
						...failure,
						requiredCapability,
						resolvedTargetId: routed?.resolvedTargetId ?? null,
					}),
				);
			} catch {
				// Preserve the bounded task result if outcome projection is unavailable.
			}
		}
		return {
			taskId: task.id,
			success: false,
			provider: routed?.provider ?? null,
			model: routed?.model ?? null,
			requiredCapability,
			result: "execution_failed",
			...failure,
		};
	} finally {
		clearAsyncTaskContext(context);
	}
}

function clearAsyncTaskContext(context) {
	context._activeBrokerRoute = null;
	context._activeTaskRoute = null;
	context._activeInvocationDescriptor = null;
	context._activeDispatchOutcomeRecorded = false;
	context._activeTaskPrompt = null;
	context._activeTaskTimeoutMs = null;
	context._activeTaskDeadline = null;
}

function asyncExecutionFailureMetadata(error, taskId) {
	const errorKind = BOUNDED_ERROR_KINDS.has(error?.errorKind)
		? error.errorKind
		: "unknown_failure";
	const failure = sanitizeFailureMetadata({
		taskId,
		result: "execution_failed",
		errorKind,
	});
	const message = typeof error?.message === "string" ? error.message : "";
	const brokerErrorCode =
		error?.code && /^snapshot_[a-z_]+$/.test(error.code)
			? error.code
			: message.includes("fallback already attempted")
				? "fallback_already_attempted"
				: message.includes("timed out acquiring broker reservation lock")
					? "reservation_lock_timeout"
					: null;
	return {
		...failure,
		...(brokerErrorCode
			? {
					ledgerFailure: true,
					ledgerFailurePhase: "broker_precondition",
					ledgerFailureCode: brokerErrorCode,
				}
			: {}),
	};
}

async function executeTaskAsyncUnsafe(task, context) {
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return nonSwitchyardExecutorResult(task, executor, requiredCapability);
	}
	let broker = context.broker;
	if (!broker) {
		broker = createDispatchBroker(context, context.brokerDependencies);
		context.broker = broker;
	}
	context._activeTaskPrompt = task.prompt || task.description || task.title;
	context._activeTaskTimeoutMs =
		task.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS;
	const brokerRequest = brokerRequestForTask(task, context, requiredCapability);
	let selectedRoute = await broker.selectAndReserve(brokerRequest);
	context._activeBrokerRoute = selectedRoute;
	context._activeDispatchOutcomeRecorded = false;
	const releaseSelected = async (route) => {
		context._activeBrokerRoute = null;
		if (route?.reservation) {
			try {
				await broker.release(route, "failure");
			} catch {
				// Preserve the task failure; recovery handles an unavailable ledger.
			}
		}
	};
	let routeResult = normalizeBrokerRoute(selectedRoute);
	context._activeTaskRoute = routeResult;
	let routeCapability = selectedRoute.capability;
	let provenance = resolveRouteProvenance(
		routeResult.provider,
		routeCapability,
	);
	mergeBrokerRouteProvenance(routeResult, routeCapability, provenance);
	let invocationDescriptor;
	try {
		invocationDescriptor = descriptorFromRoute(
			routeResult,
			routeCapability,
			context.resolveDescriptor ?? getInvocationDescriptor,
		);
	} catch {
		await releaseSelected(selectedRoute);
		return {
			taskId: task.id,
			success: false,
			provider: routeResult.provider ?? null,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			result: "descriptor_receipt_invalid",
			errorKind: "descriptor_receipt",
			reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
		};
	}
	Object.assign(routeResult, descriptorReceiptFields(invocationDescriptor));
	context._activeInvocationDescriptor = invocationDescriptor;
	let resolvedTargetId = routeResult.resolvedTargetId ?? null;
	const record = async (
		dispatch,
		{
			recordProvenance = provenance,
			recordDescriptor = invocationDescriptor,
			recordResolvedTargetId = resolvedTargetId,
		} = {},
	) => {
		await Promise.resolve(
			context.recordDispatch({
				...recordProvenance,
				...descriptorReceiptFields(recordDescriptor),
				resolvedTargetId: recordResolvedTargetId,
				...dispatch,
				requiredCapability,
			}),
		);
		context._activeDispatchOutcomeRecorded = true;
	};
	if (!routeResult.provider) {
		await releaseSelected(selectedRoute);
		const reason = safeNoProviderReason(routeResult.reason);
		await record({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			requiredCapability,
			resolvedTargetId,
			result: "no_provider",
			reason,
			errorKind: null,
		};
	}
	let adapter = selectAdapter(
		routeResult.resolved_harness ?? routeResult.provider,
		context.adapters,
	);
	if (!adapter) {
		await releaseSelected(selectedRoute);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "unsupported_provider",
			reason: safeSuccessfulRouteReason(routeResult.reason),
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "unsupported_provider",
		};
	}
	const timeoutMs = task.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS;
	const routedDeadline = new Date(Date.now() + timeoutMs).toISOString();
	context._activeTaskDeadline = routedDeadline;
	context.onStatus?.({
		phase: "execution",
		event: "task_routed",
		status: `Task ${task.id} routed to ${routeResult.provider}`,
		taskId: task.id,
		provider: routeResult.provider,
		model: invocationDescriptor.selector,
		deadline: routedDeadline,
		resolvedTargetId,
		...descriptorReceiptFields(invocationDescriptor),
	});
	context.onTaskRouted?.({
		taskId: task.id,
		provider: routeResult.provider,
		model: invocationDescriptor.selector,
		deadline: routedDeadline,
		resolvedTargetId,
		...descriptorReceiptFields(invocationDescriptor),
	});
	const intentFailure = await writeDispatchIntentAsync(
		context,
		dispatchIntentPayload(
			task.id,
			routeResult,
			requiredCapability,
			provenance,
			invocationDescriptor,
		),
	);
	if (intentFailure) {
		await releaseSelected(selectedRoute);
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "intent_receipt_failed",
			errorKind: "intent_receipt",
			...intentFailure,
		};
	}
	if (
		typeof adapter.executeAsync !== "function" ||
		typeof adapter.captureDiffAsync !== "function"
	) {
		await releaseSelected(selectedRoute);
		const reason = "adapter async lifecycle unavailable";
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			errorKind: "execution_failed",
			reason,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "execution_failed",
			errorKind: "execution_failed",
			error: reason,
		};
	}
	let brokerExecution = await broker.execute(brokerRequest, selectedRoute, {
		launcherIdentity: broker.launcherIdentity(selectedRoute),
		signal: context.signal,
		onStatus: context.onStatus,
		onAdapterStatus: context.onStatus,
		onPoll: context.onPoll,
		onTaskHeartbeat: context.onTaskHeartbeat,
	});
	context._activeBrokerRoute = null;
	if (!brokerExecution.success) {
		const primaryRoute = routeResult;
		const primaryProvenance = provenance;
		const primaryDescriptor = invocationDescriptor;
		const primaryResolvedTargetId = resolvedTargetId;
		const failureKind = brokerFailureKind(brokerExecution);
		const fallbackCapability = {
			low: "low",
			standard: "standard",
			high: "high",
		}[requiredCapability];
		if (failureKind && fallbackCapability) {
			context._activeBrokerRoute = selectedRoute;
			const fallbackRoute = await broker.fallbackAndReserve(
				brokerRequest,
				selectedRoute,
				{
					failureKind,
					capabilityCeiling: fallbackCapability,
				},
			);
			if (fallbackRoute.provider) {
				await record(
					{
						provider: primaryRoute.provider,
						model: primaryRoute.model ?? "unknown",
						taskId: task.id,
						result: "execution_failed",
						errorKind: brokerExecution.errorKind ?? "execution_failed",
						reason: brokerExecution.reason ?? primaryRoute.reason,
					},
					{
						recordProvenance: primaryProvenance,
						recordDescriptor: primaryDescriptor,
						recordResolvedTargetId: primaryResolvedTargetId,
					},
				);
				context._activeDispatchOutcomeRecorded = false;
				context._activeBrokerRoute = fallbackRoute;
				selectedRoute = fallbackRoute;
				routeCapability = fallbackRoute.capability;
				routeResult = normalizeBrokerRoute(fallbackRoute);
				context._activeTaskRoute = routeResult;
				provenance = resolveRouteProvenance(
					routeResult.provider,
					routeCapability,
				);
				invocationDescriptor = descriptorFromRoute(
					routeResult,
					routeCapability,
					context.resolveDescriptor ?? getInvocationDescriptor,
				);
				mergeBrokerRouteProvenance(routeResult, routeCapability, provenance);
				Object.assign(
					routeResult,
					descriptorReceiptFields(invocationDescriptor),
				);
				context._activeInvocationDescriptor = invocationDescriptor;
				resolvedTargetId = routeResult.resolvedTargetId ?? null;
				adapter = selectAdapter(
					routeResult.resolved_harness ?? routeResult.provider,
					context.adapters,
				);
				context.onStatus?.({
					phase: "broker",
					event: "fallback_reserved",
					status: `Task ${task.id} reserved an authorized fallback route`,
					taskId: task.id,
					provider: routeResult.provider,
					model: routeResult.model,
				});
				context._activeTaskDeadline = new Date(
					Date.now() + timeoutMs,
				).toISOString();
				context.onTaskRouted?.({
					taskId: task.id,
					provider: routeResult.provider,
					model: invocationDescriptor.selector,
					deadline: context._activeTaskDeadline,
					resolvedTargetId,
					...descriptorReceiptFields(invocationDescriptor),
				});
				context.onStatus?.({
					phase: "execution",
					event: "task_routed",
					status: `Task ${task.id} fallback routed to ${routeResult.provider}`,
					taskId: task.id,
					provider: routeResult.provider,
					model: invocationDescriptor.selector,
					deadline: context._activeTaskDeadline,
					resolvedTargetId,
					...descriptorReceiptFields(invocationDescriptor),
				});
				const fallbackIntentFailure = await writeDispatchIntentAsync(
					context,
					dispatchIntentPayload(
						task.id,
						routeResult,
						requiredCapability,
						provenance,
						invocationDescriptor,
					),
				);
				if (fallbackIntentFailure) {
					await releaseSelected(fallbackRoute);
					return {
						...descriptorReceiptFields(invocationDescriptor),
						taskId: task.id,
						success: false,
						provider: routeResult.provider,
						model: invocationDescriptor.selector,
						requiredCapability,
						resolvedTargetId,
						result: "intent_receipt_failed",
						errorKind: "intent_receipt",
						...fallbackIntentFailure,
					};
				}
				brokerExecution = await broker.execute(brokerRequest, fallbackRoute, {
					launcherIdentity: broker.launcherIdentity(fallbackRoute),
					signal: context.signal,
					onStatus: context.onStatus,
					onAdapterStatus: context.onStatus,
					onPoll: context.onPoll,
					onTaskHeartbeat: context.onTaskHeartbeat,
				});
				context._activeBrokerRoute = null;
			}
		}
	}
	const execution = {
		success: brokerExecution.success,
		timedOut: brokerExecution.timedOut === true,
		cleanupFailed: brokerExecution.cleanupFailed === true,
		error: brokerExecution.reason ?? null,
		errorKind: brokerExecution.errorKind ?? brokerExecution.outcome,
	};
	if (!execution.success) {
		if (!execution.timedOut) {
			await record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: "execution_failed",
				errorKind: execution.errorKind ?? null,
				reason: execution.error ?? routeResult.reason,
			});
			return {
				...descriptorReceiptFields(invocationDescriptor),
				taskId: task.id,
				success: false,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
				requiredCapability,
				resolvedTargetId,
				result: "execution_failed",
				error: execution.error ?? null,
				errorKind: execution.errorKind ?? null,
			};
		}

		let partialDiff = null;
		try {
			partialDiff = await adapter.captureDiffAsync(
				context.workingContainerName,
				{
					executionBackend: context.executionBackend,
					signal: context.signal,
				},
			);
		} catch {
			partialDiff = null;
		}
		const captureFailed = !partialDiff;
		const cleanupFailed = execution.cleanupFailed === true;
		const resultName = cleanupFailed
			? "execution_timed_out_cleanup_failed"
			: captureFailed
				? "execution_timed_out_capture_failed"
				: "execution_timed_out";
		const error = cleanupFailed
			? (execution.error ?? "provider cleanup failed after timeout")
			: captureFailed
				? "diff capture failed after timeout"
				: (execution.error ?? null);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: resultName,
			errorKind:
				(cleanupFailed && "provider_cleanup_failed") ||
				(captureFailed && "diff_capture_failed") ||
				execution.errorKind ||
				null,
			reason: error ?? routeResult.reason,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: resultName,
			error,
			errorKind:
				(cleanupFailed && "provider_cleanup_failed") ||
				(captureFailed && "diff_capture_failed") ||
				execution.errorKind ||
				null,
			timedOut: true,
			...(partialDiff ? { partialDiff } : {}),
		};
	}
	const diff = await adapter.captureDiffAsync(context.workingContainerName, {
		executionBackend: context.executionBackend,
		signal: context.signal,
	});
	context.onStatus?.({
		phase: "execution",
		event: "diff_captured",
		status: "Diff captured",
		taskId: task.id,
		provider: routeResult.provider,
		model: invocationDescriptor.selector,
		byteCount: diff ? diff.length : 0,
	});
	if (!diff && task.requiredPaths === null) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			reason: safeSuccessfulRouteReason(routeResult.reason),
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: true,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "success_no_diff",
		};
	}
	const gateResult = context.integrationGate(diff, context.projectPath, {
		requiredPaths: task.requiredPaths,
		allowSensitiveManifests:
			task.type === "implementation" && task.allowManifests === true,
	});
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const success = Boolean(gateResult?.success) || alreadyApplied;
	const terminalResult = success ? "success" : "integration_failed";
	const safeGateFailure = success
		? null
		: integrationFailureMetadata(task.id, diff, gateResult?.credentialFlagged);
	await record({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: terminalResult,
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(success
			? { reason: safeSuccessfulRouteReason(routeResult.reason) }
			: {}),
	});
	return {
		...descriptorReceiptFields(invocationDescriptor),
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: terminalResult,
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(!success && !gateResult?.credentialFlagged
			? { partialDiff: diff }
			: {}),
	};
}

/**
 * Awaiting queue entrypoint for callers that own an async worker. This is a
 * deliberately small sibling of runQueue: it keeps the established sync API
 * untouched while making the per-task provider lifecycle genuinely awaitable.
 * Container creation/seeding is delegated to the same injectable lifecycle
 * dependencies; callers with a supplied working container avoid Docker setup.
 */
export async function runQueueAsync(options) {
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
		platform,
		runOptions = null,
		queueIdentity = null,
		projectRevision = null,
		runStorePath = null,
		runId = null,
		dependencies = {},
	} = options;
	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});
	const launch = prepareQueueLaunch({
		tasksFilePath,
		projectPath,
		checkpointPath,
		maxTasks,
		stopOnFailure,
		exclude,
		only,
		taskIds,
		identityTaskIds: [],
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId,
		dependencies,
		onStatus: dependencies.onStatus,
	});
	const {
		queueBackend,
		slotLease,
		tasks,
		checkpoint,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	ensureRetryCheckpoint(checkpoint);
	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	try {
		if (!workingContainerName) {
			queueBackend.ensureAgentContainer();
			workingContainerName = queueBackend.create(projectPath, { runId });
			if (!workingContainerName) {
				throw new Error("runQueueAsync: failed to create working container");
			}
			ownsWorkingContainer = true;
			uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
				workingContainerName,
				queueBackend.destroy,
			);
			dependencies.onStatus?.({
				phase: "bootstrap",
				event: "container_created",
				status: "Working container created",
			});
			// Credential provisioning and project seeding can be slow. Publish the
			// resolved container before either operation so status is useful during
			// bootstrap rather than looking like a dead launch.
			dependencies.onContainerReady?.({ workingContainerName });
			try {
				queueBackend.provision(workingContainerName);
			} catch (error) {
				console.error(
					`runQueueAsync: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
			queueBackend.seed(workingContainerName, projectPath);
		}
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				queueBackend.destroy(workingContainerName);
			} catch {
				// Preserve the bootstrap error.
			}
		}
		releaseQueueSlot(queueBackend, slotLease);
		throw error;
	}
	const context = {
		route: dependencies.route ?? route,
		recordDispatch:
			dependencies.recordDispatch ??
			((dispatch) =>
				recordDispatchToBothLedgers(
					dispatch,
					(data) => recordDispatchToStore(data, runStorePath),
					ledgerReportingContext(dependencies.onStatus ?? null, dependencies),
				)),
		recordDispatchIntent:
			dependencies.recordDispatchIntent ??
			((intent) => recordDispatchIntentToStore(intent, runStorePath)),
		integrationGate: dependencies.integrationGate ?? integrationGate,
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		onStatus: dependencies.onStatus ?? null,
		onTaskRouted: dependencies.onTaskRouted ?? null,
		onTaskHeartbeat: dependencies.onTaskHeartbeat ?? null,
		exclude: mergeRetryExclusions(
			effectiveExclude,
			checkpoint.quarantinedTargetIds,
		),
		only: effectiveOnly,
		signal: dependencies.signal,
		onPoll: dependencies.onPoll,
		resolveDescriptor: dependencies.resolveDescriptor,
		runId,
		snapshotSource: dependencies.snapshotSource ?? "gradus-v2",
	};
	const results = [];
	try {
		context.broker = createDispatchBroker(context, dependencies);
		const initialRunnable = getRunnableTasks(tasks, checkpoint, {
			selectedTaskIds: effectiveTaskIds,
			resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
		});
		const attemptedTaskIds = new Set();
		let resumedRetryTaskId = checkpoint.retryState?.taskId ?? null;
		let processed = 0;
		const projectRetryState = () => {
			dependencies.onRetryStateChanged?.({
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
			});
		};
		reconcileAlreadyCompleteSelection(
			checkpoint,
			checkpointPath,
			results,
			effectiveTaskIds,
			tasks,
			dependencies.onResult,
			dependencies.onStatus,
			dependencies.onCheckpointSaved,
		);
		while (processed < effectiveMaxTasks) {
			context.exclude = mergeRetryExclusions(
				effectiveExclude,
				checkpoint.quarantinedTargetIds,
			);
			const runnable = resumedRetryTaskId
				? []
				: getRunnableTasks(tasks, checkpoint, {
						selectedTaskIds: effectiveTaskIds,
						resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
						excludedTaskIds: attemptedTaskIds,
					});
			const task = resumedRetryTaskId
				? tasks.find((candidate) => candidate.id === resumedRetryTaskId)
				: runnable[0];
			if (!task) break;
			if (resumedRetryTaskId) resumedRetryTaskId = null;
			else attemptedTaskIds.add(task.id);
			dependencies.onTaskStart?.(task);
			const retryState =
				checkpoint.retryState?.taskId === task.id
					? checkpoint.retryState
					: null;
			let result;
			if (retryState && !hasExactRetryDescriptorEvidence(retryState)) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					resolvedTargetId: retryState.resolvedTargetId ?? null,
					result: "unknown_failure",
					errorKind: "descriptor_receipt",
					reason:
						"historical retry state lacks exact invocation descriptor evidence",
				};
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "finalized",
					taskId: task.id,
					attempt: retryState.attempt,
					resolvedTargetId: retryState.resolvedTargetId,
					clearState: true,
					save: false,
				});
				projectRetryState();
			} else if (
				retryState &&
				["retry_started", "retry_halted"].includes(retryState.phase)
			) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					resolvedTargetId: retryState.resolvedTargetId ?? null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason:
						"persisted retry state already consumed the bounded retry attempt",
				};
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "finalized",
					taskId: task.id,
					attempt: retryState.attempt,
					provider: retryState.provider,
					model: retryState.model,
					resolvedTargetId: retryState.resolvedTargetId,
					invocationDescriptor: retryState.invocationDescriptor,
					descriptorIdentity: retryState.descriptorIdentity,
					descriptorHarness: retryState.descriptorHarness,
					clearState: true,
					save: false,
				});
				projectRetryState();
			} else if (retryState) {
				const retryTargetId = normalizeRetryTargetId(
					retryState.resolvedTargetId,
				);
				if (
					retryTargetId &&
					!checkpoint.quarantinedTargetIds.includes(retryTargetId)
				) {
					checkpoint.quarantinedTargetIds.push(retryTargetId);
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "target_quarantined",
						taskId: task.id,
						attempt: 1,
						resolvedTargetId: retryTargetId,
						invocationDescriptor: retryState.invocationDescriptor,
						descriptorIdentity: retryState.descriptorIdentity,
						descriptorHarness: retryState.descriptorHarness,
					});
					projectRetryState();
				}
				let retryHalt = null;
				if (retryState.phase !== "reset_completed") {
					retryHalt = resetBeforeQuotaRetry({
						result: {
							taskId: task.id,
							provider: null,
							model: null,
							resolvedTargetId: retryState.resolvedTargetId,
							invocationDescriptor: retryState.invocationDescriptor,
							descriptorIdentity: retryState.descriptorIdentity,
							descriptorHarness: retryState.descriptorHarness,
						},
						checkpoint,
						checkpointPath,
						workingContainerName,
						resetWorkingTreeFn: queueBackend.reset,
						emitStatus: dependencies.onStatus,
					});
					projectRetryState();
				}
				if (retryHalt) {
					result = retryHalt;
				} else {
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "retry_started",
						taskId: task.id,
						attempt: 2,
						resolvedTargetId: retryState.resolvedTargetId,
						invocationDescriptor: retryState.invocationDescriptor,
						descriptorIdentity: retryState.descriptorIdentity,
						descriptorHarness: retryState.descriptorHarness,
					});
					projectRetryState();
					context.exclude = mergeRetryExclusions(
						effectiveExclude,
						checkpoint.quarantinedTargetIds,
					);
					result = await executeTaskAsync(task, context);
					appendRetryAttempt(checkpoint, result, 2);
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "finalized",
						taskId: task.id,
						attempt: 2,
						provider: result.provider,
						model: result.model,
						resolvedTargetId:
							result.invocationDescriptor?.target_id ??
							normalizeRetryTargetId(result.resolvedTargetId) ??
							retryTargetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
						clearState: true,
						save: false,
					});
					projectRetryState();
				}
			} else {
				result = await executeTaskAsync(task, context);
			}
			if (!retryState && isQuotaRetryCandidate(result, ownsWorkingContainer)) {
				const targetId = normalizeRetryTargetId(result.resolvedTargetId);
				appendRetryAttempt(checkpoint, result, 1);
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "attempt_recorded",
					taskId: task.id,
					attempt: 1,
					provider: result.provider,
					model: result.model,
					resolvedTargetId: targetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
				});
				projectRetryState();
				checkpoint.quarantinedTargetIds = [
					...new Set([...checkpoint.quarantinedTargetIds, targetId]),
				];
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "target_quarantined",
					taskId: task.id,
					attempt: 1,
					provider: result.provider,
					model: result.model,
					resolvedTargetId: targetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
				});
				projectRetryState();
				const retryHalt = resetBeforeQuotaRetry({
					result,
					checkpoint,
					checkpointPath,
					workingContainerName,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus: dependencies.onStatus,
				});
				if (retryHalt) {
					result = retryHalt;
				} else {
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "retry_started",
						taskId: task.id,
						attempt: 2,
						provider: result.provider,
						model: result.model,
						resolvedTargetId: targetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
					});
					projectRetryState();
					context.exclude = mergeRetryExclusions(
						effectiveExclude,
						checkpoint.quarantinedTargetIds,
					);
					result = await executeTaskAsync(task, context);
					appendRetryAttempt(checkpoint, result, 2);
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "finalized",
						taskId: task.id,
						attempt: 2,
						provider: result.provider,
						model: result.model,
						resolvedTargetId:
							result.invocationDescriptor?.target_id ??
							normalizeRetryTargetId(result.resolvedTargetId) ??
							targetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
						clearState: true,
						save: false,
					});
					projectRetryState();
				}
			}
			if (result.partialDiff) {
				try {
					result.partialDiffPath = savePartialDiff(
						checkpointPath,
						result.taskId,
						result.partialDiff,
					);
				} catch {
					result.partialDiffPath = null;
				}
				// Raw diff text is an in-memory transient only; never expose it to
				// onResult or persist it in checkpoint.json.
				result.partialDiff = undefined;
			}
			results.push(result);
			dependencies.onResult?.(result);
			const safeFailure = failureMetadataFor(result, result.partialDiffPath);
			checkpoint.results.push({
				taskId: result.taskId,
				provider: result.provider,
				model: result.model,
				...(result.invocationDescriptor
					? {
							dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity:
								result.invocationDescriptor.descriptor_identity,
							descriptorHarness: result.descriptorHarness ?? null,
							resolvedTargetId: result.resolvedTargetId ?? null,
						}
					: {}),
				result: result.result,
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				success: result.success,
				timedOut: Boolean(result.timedOut),
				// The host path is transient; safeFailure carries only its opaque
				// artifactRef into the durable checkpoint.
				partialDiffPath: null,
				...(safeFailure ?? {}),
				...(opaqueArtifactRef(result.artifactRef)
					? { artifactRef: opaqueArtifactRef(result.artifactRef) }
					: {}),
				timestamp: new Date().toISOString(),
			});
			checkpoint.lastTaskId = result.taskId;
			if (result.success) checkpoint.completedTaskIds.push(result.taskId);
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
			dependencies.onCheckpointSaved?.(checkpoint);
			const haltResult = commitOrResetWorkingContainer(result, {
				ownsWorkingContainer,
				workingContainerName,
				stopOnFailure: effectiveStopOnFailure,
				commitWorkingTreeFn: queueBackend.commit,
				resetWorkingTreeFn: queueBackend.reset,
				emitStatus: dependencies.onStatus,
				logPrefix: "runQueueAsync: ",
			});
			processed += 1;
			if (haltResult) {
				recordHalt(
					checkpoint,
					checkpointPath,
					results,
					haltResult,
					dependencies.onStatus,
				);
				break;
			}
			if (!result.success && effectiveStopOnFailure) break;
		}
		saveCheckpoint(checkpointPath, checkpoint);
		return {
			results,
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			checkpointPath,
			ledgerWritesSettled: Promise.resolve(),
			quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
			retryState: checkpoint.retryState,
			retryTransitionId: checkpoint.retryTransitionId,
		};
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		try {
			if (ownsWorkingContainer) {
				try {
					queueBackend.destroy(workingContainerName);
				} catch {
					// Container cleanup is best effort; the run result remains authoritative.
				}
			}
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
		}
	}
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
	let invocationDescriptor;
	try {
		invocationDescriptor = descriptorFromRoute(
			routeResult,
			requiredCapability,
			context.resolveDescriptor ?? getInvocationDescriptor,
		);
	} catch {
		try {
			await context.recordDispatch({
				...provenance,
				...descriptorReceiptFields(null),
				resolvedTargetId: routeResult.resolvedTargetId ?? null,
				provider: routeResult.provider ?? "none",
				model: routeResult.model ?? null,
				taskId: task.id,
				result: "descriptor_receipt_invalid",
				reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
				requiredCapability,
			});
		} catch (projectionError) {
			reportLegacyProjectionFailure(context, projectionError);
		}
		return {
			...descriptorReceiptFields(null),
			taskId: task.id,
			success: false,
			provider: routeResult.provider ?? null,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			result: "descriptor_receipt_invalid",
			errorKind: "descriptor_receipt",
			reason: DESCRIPTOR_RECEIPT_INVALID_REASON,
		};
	}
	Object.assign(routeResult, descriptorReceiptFields(invocationDescriptor));
	context._activeInvocationDescriptor = invocationDescriptor;
	const resolvedTargetId = routeResult.resolvedTargetId ?? null;
	let projectionFailure = null;
	const record = async (dispatch) => {
		try {
			await context.recordDispatch({
				...provenance,
				...descriptorReceiptFields(invocationDescriptor),
				resolvedTargetId,
				...dispatch,
				requiredCapability,
			});
		} catch (error) {
			projectionFailure = reportLegacyProjectionFailure(context, error);
		}
	};

	if (!routeResult.provider) {
		const noProviderReason = safeNoProviderReason(routeResult.reason);
		await record({
			provider: "none",
			model: "none",
			taskId: task.id,
			result: "no_provider",
			reason: noProviderReason,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: null,
			model: null,
			requiredCapability,
			resolvedTargetId,
			result: "no_provider",
			reason: noProviderReason,
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
			model: invocationDescriptor.selector,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			...descriptorReceiptFields(invocationDescriptor),
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}
	if (context.onTaskRouted) {
		context.onTaskRouted({
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			deadline: routedDeadline,
			resolvedTargetId: routeResult.resolvedTargetId ?? null,
			...descriptorReceiptFields(invocationDescriptor),
			snapshotStatus: routeResult.snapshotStatus ?? null,
			snapshotMtime: routeResult.snapshotMtime ?? null,
			snapshotAgeMsAtRoute: routeResult.snapshotAgeMsAtRoute ?? null,
		});
	}

	const intentFailure = await writeDispatchIntentAsync(
		context,
		dispatchIntentPayload(
			task.id,
			routeResult,
			requiredCapability,
			provenance,
			invocationDescriptor,
		),
	);
	if (intentFailure) {
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "intent_receipt_failed",
			errorKind: "intent_receipt",
			...intentFailure,
		};
	}

	let jobId;
	try {
		jobId = await context.orchestrator.launch({
			payloadVersion: ORCHESTRATOR_PAYLOAD_VERSION,
			contractVersion: ORCHESTRATOR_PAYLOAD_VERSION,
			dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			invocationDescriptor,
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			descriptorHarness: routeResult.resolved_harness ?? null,
			resolvedTargetId,
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
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
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
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
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
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
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
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
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
			reason: safeSuccessfulRouteReason(routeResult.reason),
			percentLeft: routeResult.percentLeft ?? undefined,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: true,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "success_no_diff",
		};
	}

	const gateResult = context.integrationGate(diff, context.projectPath, {
		requiredPaths: task.requiredPaths,
		allowSensitiveManifests:
			task.type === "implementation" && task.allowManifests === true,
	});
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const success = Boolean(gateResult?.success) || alreadyApplied;
	const terminalResult = success ? "success" : "integration_failed";
	const safeGateFailure = success
		? null
		: integrationFailureMetadata(task.id, diff, gateResult?.credentialFlagged);
	const gateArtifactRef = opaqueArtifactRef(gateResult?.artifactRef);

	if (context.onStatus) {
		context.onStatus({
			phase: "integration",
			event: "gate_validated",
			status: success
				? alreadyApplied
					? "already applied"
					: "ok"
				: safeGateFailure.reason,
			taskId: task.id,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			outcome: success
				? alreadyApplied
					? "already_applied"
					: "passed"
				: "rejected",
			errorKind: safeGateFailure?.errorKind,
			reasonCode: safeGateFailure?.reasonCode,
			artifactRef: safeGateFailure?.artifactRef ?? gateArtifactRef,
		});
		if (success) {
			context.onStatus({
				phase: "integration",
				event: "gate_applied",
				status: alreadyApplied
					? "Diff already applied; integration gate confirmed terminal state"
					: "Diff applied via integration gate",
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
		result: terminalResult,
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...(success
			? { reason: safeSuccessfulRouteReason(routeResult.reason) }
			: {}),
		percentLeft: routeResult.percentLeft ?? undefined,
	});

	const result = {
		taskId: task.id,
		success,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: terminalResult,
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...(projectionFailure
			? { legacyProjectionFailure: projectionFailure }
			: {}),
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
 * Restore the owned working-container baseline before a quota retry. Unlike
 * the normal failed-task continuation, this reset is mandatory even when the
 * caller requested stop-on-failure: the second attempt must never see edits
 * from the failed first attempt.
 * @param {object} deps
 * @returns {object|null} a safe halt result when reset fails
 */
function resetBeforeQuotaRetry({
	result,
	checkpoint,
	checkpointPath,
	workingContainerName,
	resetWorkingTreeFn,
	emitStatus,
}) {
	if (emitStatus) {
		emitStatus({
			phase: "checkpoint",
			event: "retry_reset_started",
			status: `Resetting the working tree before retrying task ${result.taskId}`,
			taskId: result.taskId,
			provider: result.provider ?? null,
			model: result.model ?? null,
			resolvedTargetId: result.resolvedTargetId ?? null,
		});
	}
	try {
		resetWorkingTreeFn(workingContainerName);
	} catch (error) {
		const haltResult = _haltResult(result, "reset", error);
		persistRetryTransition(checkpoint, checkpointPath, {
			type: "retry_halted",
			taskId: result.taskId,
			attempt: 1,
			provider: result.provider,
			model: result.model,
			resolvedTargetId: result.resolvedTargetId,
			invocationDescriptor: result.invocationDescriptor,
			descriptorIdentity: result.descriptorIdentity,
			descriptorHarness: result.descriptorHarness,
			clearState: true,
		});
		if (emitStatus) {
			emitStatus({
				phase: "checkpoint",
				event: "checkpoint_failed",
				status: `Checkpoint reset failed: ${_formatCheckpointActionError(error)}`,
				taskId: result.taskId,
				error: _safeError(error),
			});
		}
		return haltResult;
	}

	persistRetryTransition(checkpoint, checkpointPath, {
		type: "reset_completed",
		taskId: result.taskId,
		attempt: 1,
		provider: result.provider,
		model: result.model,
		resolvedTargetId: result.resolvedTargetId,
		invocationDescriptor: result.invocationDescriptor,
		descriptorIdentity: result.descriptorIdentity,
		descriptorHarness: result.descriptorHarness,
	});
	if (emitStatus) {
		emitStatus({
			phase: "checkpoint",
			event: "state_reset",
			status: `Reset working tree before retrying task ${result.taskId}`,
			taskId: result.taskId,
		});
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
		executeAsync: executeClaudeAsync,
		captureDiff: captureClaudeDiff,
		captureDiffAsync: captureClaudeDiffAsync,
	},
	codex: {
		execute: executeCodex,
		executeAsync: executeCodexAsync,
		captureDiff: captureCodexDiff,
		captureDiffAsync: captureCodexDiffAsync,
	},
	agy: {
		execute: executeAgy,
		executeAsync: executeAgyAsync,
		captureDiff: captureAgyDiff,
		captureDiffAsync: captureAgyDiffAsync,
	},
	cursor: {
		execute: executeCursor,
		executeAsync: executeCursorAsync,
		captureDiff: captureCursorDiff,
		captureDiffAsync: captureCursorDiffAsync,
	},
	copilot: {
		execute: executeCopilot,
		executeAsync: executeCopilotAsync,
		captureDiff: captureCopilotDiff,
		captureDiffAsync: captureCopilotDiffAsync,
	},
	opencode: {
		execute: executeOpencode,
		executeAsync: executeOpencodeAsync,
		captureDiff: captureOpencodeDiff,
		captureDiffAsync: captureOpencodeDiffAsync,
	},
};

/**
 * Bind an existing async provider adapter to the complete broker identity.
 * The returned identity is checked by the broker before adapter execution.
 */
export function createBrokerAdapterLauncher({
	adapter,
	executionBackend,
	workingContainerName,
	prompt,
	timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
}) {
	if (!adapter || typeof adapter.executeAsync !== "function") {
		throw new TypeError("broker adapter requires executeAsync");
	}
	return async function launch({
		request,
		route,
		invocationDescriptor,
		launcherIdentity,
		signal,
		onAdapterStatus,
		onPoll,
	}) {
		if (
			!launcherIdentity ||
			launcherIdentity.provider !== route.provider ||
			launcherIdentity.resolvedTarget !== route.resolvedTarget ||
			launcherIdentity.harness !== route.harness ||
			launcherIdentity.model !== route.model ||
			launcherIdentity.effort !== route.effort ||
			launcherIdentity.descriptorIdentity !==
				invocationDescriptor.descriptor_identity ||
			launcherIdentity.reservationId !== route.reservation?.id
		) {
			throw new Error("broker launcher identity drift at spawn");
		}
		const execution = await adapter.executeAsync(
			typeof prompt === "string" && prompt.length > 0 ? prompt : request.taskId,
			workingContainerName,
			{
				model: route.model,
				timeoutMs,
				executionBackend,
				signal,
				onStatus: onAdapterStatus,
				onPoll,
				invocationDescriptor,
				descriptorIdentity: invocationDescriptor.descriptor_identity,
				descriptorHarness: route.harness,
				resolvedTargetId: route.resolvedTarget,
			},
		);
		return {
			success: execution?.success === true,
			cancelled: signal?.aborted === true,
			reason: execution?.error ?? null,
			actualConsumption: execution?.actualConsumption,
			timedOut: execution?.timedOut === true,
			cleanupFailed: execution?.cleanupFailed === true,
			failureKind:
				execution?.failureKind === "transient" ||
				execution?.failureKind === "provider"
					? execution.failureKind
					: null,
			errorKind: BOUNDED_ERROR_KINDS.has(execution?.errorKind)
				? execution.errorKind
				: null,
		};
	};
}

function createDispatchBroker(context, dependencies = {}) {
	if (dependencies.broker) return dependencies.broker;
	const adapters = context.adapters ?? DEFAULT_ADAPTERS;
	const contextOnly = Array.isArray(context.only) ? context.only : [];
	const snapshotSources = dependencies.snapshotSources ?? { "gradus-v2": null };
	if (
		typeof context.projectPath !== "string" ||
		context.projectPath.trim() === ""
	) {
		throw new Error(
			"broker runner requires projectPath for its reservation ledger",
		);
	}
	const projectLedgerRoot = join(
		context.projectPath,
		".logs",
		"switchyard",
		"broker",
	);
	const usesProductionRouter = context.route === route;
	return createBroker({
		adapters,
		route: ({
			runId,
			requiredCapability,
			availableProviders,
			snapshotSource,
			snapshotRead,
			exclude = [],
		}) =>
			context.route({
				runId,
				requiredCapability,
				availableProviders,
				snapshotSource,
				snapshotRead,
				exclude: [
					...(Array.isArray(context.exclude) ? context.exclude : []),
					...exclude,
				],
				only: contextOnly,
			}),
		resolveTargetIdentity:
			dependencies.resolveTargetIdentity ?? resolveTargetIdentity,
		getInvocationDescriptor:
			context.resolveDescriptor ?? getInvocationDescriptor,
		reservations: dependencies.brokerReservations,
		reservationOptions: dependencies.brokerReservationOptions ?? {
			root: projectLedgerRoot,
		},
		snapshotSources,
		readSnapshot: usesProductionRouter
			? (dependencies.readSnapshot ??
				(({ source, nowMs }) => {
					if (!Object.hasOwn(snapshotSources, source)) {
						const error = new Error("snapshot_source_unknown");
						error.code = "snapshot_source_unknown";
						throw error;
					}
					const sourcePath = snapshotSources[source];
					if (sourcePath !== null && typeof sourcePath !== "string") {
						throw new TypeError(
							"configured snapshot source must be a path or null",
						);
					}
					return readSnapshotAtRoute(nowMs, sourcePath ?? undefined);
				}))
			: dependencies.readSnapshot,
		refreshSnapshot: dependencies.refreshSnapshot,
		ownerId: context.runId ? `runner:${context.runId}` : undefined,
		executor: async ({
			request,
			route: selectedRoute,
			invocationDescriptor,
			launcherIdentity,
			signal,
			onStatus,
			onAdapterStatus,
			onPoll,
			onTaskHeartbeat,
		}) => {
			const adapter = selectAdapter(selectedRoute.harness, adapters);
			if (!adapter) {
				throw new Error(
					`broker route harness '${selectedRoute.harness}' has no runner adapter`,
				);
			}
			return createBrokerAdapterLauncher({
				adapter,
				executionBackend: context.executionBackend,
				workingContainerName: context.workingContainerName,
				prompt: context._activeTaskPrompt,
				timeoutMs: context._activeTaskTimeoutMs,
			})({
				request,
				route: selectedRoute,
				invocationDescriptor,
				launcherIdentity,
				signal,
				onAdapterStatus,
				onPoll: (poll) => {
					onStatus?.(poll);
					onPoll?.(poll);
					const heartbeat = {
						taskId: request.taskId,
						provider: selectedRoute.provider,
						model: invocationDescriptor.selector ?? selectedRoute.model,
						deadline: context._activeTaskDeadline ?? null,
						elapsedMs: Number.isFinite(poll?.elapsedMs)
							? Math.max(0, poll.elapsedMs)
							: 0,
						processPhase: "provider_running",
						resolvedTargetId: selectedRoute.resolvedTarget,
						descriptorIdentity: invocationDescriptor.descriptor_identity,
						descriptorHarness: selectedRoute.harness,
					};
					onTaskHeartbeat?.(heartbeat);
				},
			});
		},
	});
}

function brokerRequestForTask(task, context, requiredCapability) {
	return {
		schemaVersion: 1,
		capability: requiredCapability,
		dataClass: "repository",
		estimatedConsumption:
			typeof task.estimatedConsumption === "number" &&
			Number.isFinite(task.estimatedConsumption) &&
			task.estimatedConsumption > 0
				? task.estimatedConsumption
				: 1,
		runId: context.runId ?? `runner-${process.pid}`,
		taskId: task.id,
		snapshotSource: context.snapshotSource ?? "gradus-v2",
		availableAdapters: Object.keys(context.adapters ?? DEFAULT_ADAPTERS),
	};
}

function normalizeBrokerRoute(result) {
	return {
		provider: result.provider,
		model: result.model,
		resolvedTargetId: result.resolvedTarget,
		resolved_harness: result.harness,
		requiredCapability: result.capability,
		reason: result.reason,
		snapshotStatus: result.snapshotIdentity.status,
		snapshotMtime: result.snapshotIdentity.mtime,
		snapshotAgeMsAtRoute: result.snapshotIdentity.ageMs,
	};
}

function mergeBrokerRouteProvenance(routeResult, capability, provenance) {
	Object.assign(routeResult, { requiredCapability: capability });
	for (const [key, value] of Object.entries(provenance)) {
		if (key === "resolved_target" && routeResult.resolvedTargetId != null) {
			routeResult[key] = routeResult.resolvedTargetId;
			continue;
		}
		if (key === "resolved_harness" && routeResult.resolved_harness != null) {
			continue;
		}
		if (key === "resolved_selector" && routeResult.model != null) {
			routeResult[key] = routeResult.model;
			continue;
		}
		if (value != null || routeResult[key] == null) routeResult[key] = value;
	}
}

function brokerFailureKind(result) {
	if (result?.outcome !== "failure" || result?.timedOut === true) {
		return null;
	}
	if (
		result.errorKind === "auth_expired" ||
		result.errorKind === "model_unavailable" ||
		result.errorKind === "quota_exhausted"
	) {
		return null;
	}
	if (result.failureKind === "provider" || result.failureKind === "transient") {
		return result.failureKind;
	}
	if (typeof result.reason !== "string") {
		return null;
	}
	const reason = result.reason.toLowerCase();
	if (reason.includes("transient") || reason.includes("timeout")) {
		return "transient";
	}
	if (reason === "launcher_failed" || reason.includes("provider")) {
		return "provider";
	}
	return null;
}

function runBackendGitCommand(executionBackend, workspaceId, script) {
	if (typeof executionBackend.execGuest === "function") {
		executionBackend.execGuest(workspaceId, "/bin/bash", ["-lc", script], {
			cwd: "/project",
		});
		return { status: 0 };
	}
	const execution = executionBackend.execArgv(workspaceId, {
		cwd: "/project",
		argv: ["/bin/bash", "-lc", `cd /project && ${script}`],
	});
	const result = spawnSync(execution.command, execution.args, {
		stdio: "pipe",
	});
	if (result.status !== 0) {
		throw new Error(
			`backend workspace command failed (${result.status ?? result.signal ?? "unknown"})`,
		);
	}
	return result;
}

const DEFAULT_TAR_PROVISION_MANIFEST_PATH = fileURLToPath(
	new URL("../../../ops/macos-vm/tar-provision-manifest.json", import.meta.url),
);

function loadTarProvisionRegistry(dependencies) {
	if (Object.hasOwn(dependencies, "tarProvisionRegistry")) {
		return dependencies.tarProvisionRegistry;
	}
	if (Object.hasOwn(dependencies, "tarProvisionManifest")) {
		return dependencies.tarProvisionManifest;
	}
	// The shipped manifest is the recorded Task 1.3 measurement, one file per
	// provider verdict with the evidence that produced it. Before 2026-08-14
	// there was nothing to point at and the preflight rejected every provider
	// with `tar_provisionability_unverified`; an operator who re-measures
	// against a different image still overrides it by env or dependency.
	const manifestPath =
		dependencies.tarProvisionManifestPath ??
		process.env.SWITCHYARD_MACOS_TAR_PROVISION_MANIFEST ??
		DEFAULT_TAR_PROVISION_MANIFEST_PATH;
	try {
		return JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
	} catch {
		return null;
	}
}

function formatQueuePreflightFailure(result) {
	const details = (result.rejections ?? []).map((rejection) => {
		const capability = rejection.capability ?? "unknown";
		// A selector-level rejection is not about any one capability tier, so the
		// excluded-provider list would be empty and misleading. Name the selector
		// instead: it is the only thing the operator can act on.
		if (rejection.selector) {
			return `${capability}: ${rejection.reason} (selector: ${rejection.selector}; use an exact target id)`;
		}
		const excluded = rejection.excludedProviders?.length
			? rejection.excludedProviders.join(", ")
			: "none";
		return `${capability}: ${rejection.reason} (excluded: ${excluded})`;
	});
	return `macOS queue provider preflight failed: ${details.join("; ") || result.reason}`;
}

function createDefaultQueuePreflight({ selectedPlatform, dependencies }) {
	if (selectedPlatform !== "macos") return () => ({ ok: true, eligible: true });

	const adapters = dependencies.adapters ?? DEFAULT_ADAPTERS;
	const tarProvisionRegistry = loadTarProvisionRegistry(dependencies);
	return (input = {}) => {
		const result = preflightMacosQueue({
			...input,
			platform: selectedPlatform,
			availableProviders: Object.keys(adapters),
			tarProvisionRegistry,
			...(dependencies.preflightReadSnapshot
				? { readSnapshot: dependencies.preflightReadSnapshot }
				: {}),
		});
		if (!result.ok) throw new Error(formatQueuePreflightFailure(result));
		return result;
	};
}

/**
 * Bind queue lifetime operations to one selected execution substrate.
 *
 * `backendFactory` is intentionally synchronous and returns either a backend
 * or a partial queue helper. It is the seam for VM admission and provider
 * preflight.
 */
export function createQueueBackend({
	platform = "docker",
	dependencies = {},
	projectPath,
	runId = null,
	runOptions = null,
} = {}) {
	const selectedPlatform = normalizeQueuePlatform(platform);
	const defaultQueuePreflight = createDefaultQueuePreflight({
		selectedPlatform,
		dependencies,
	});
	const configuredQueuePreflight =
		dependencies.queuePreflight ?? defaultQueuePreflight;
	const factory = dependencies.backendFactory;
	const supplied = factory?.({
		platform: selectedPlatform,
		projectPath,
		runId,
		runOptions,
	});
	if (supplied && typeof supplied === "object") {
		if (
			supplied.platform &&
			normalizeQueuePlatform(supplied.platform) !== selectedPlatform
		) {
			throw new Error("backendFactory returned a different queue platform");
		}
		if (
			supplied.create &&
			supplied.destroy &&
			supplied.seed &&
			supplied.commit &&
			supplied.reset
		) {
			return {
				platform: selectedPlatform,
				...supplied,
				ensureAgentContainer: supplied.ensureAgentContainer ?? (() => {}),
				provision: supplied.provision ?? (() => null),
				preflight: supplied.preflight ?? configuredQueuePreflight,
				acquireSlot: supplied.acquireSlot ?? (() => null),
				releaseSlot: supplied.releaseSlot ?? (() => {}),
			};
		}
	}

	const executionBackend =
		supplied?.executionBackend ??
		supplied?.backend ??
		dependencies.executionBackend ??
		(selectedPlatform === "macos"
			? new ParallelsExecutionBackend({
					goldenImage:
						dependencies.goldenImage ??
						process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE,
					aquaUid:
						dependencies.aquaUid ?? process.env.SWITCHYARD_PARALLELS_AQUA_UID,
					providerUser:
						dependencies.providerUser ??
						process.env.SWITCHYARD_PARALLELS_PROVIDER_USER ??
						"switchyard",
				})
			: new DockerExecutionBackend());

	if (selectedPlatform === "docker") {
		const createFn =
			dependencies.createWorkingContainer ?? createWorkingContainer;
		const destroyFn = dependencies.wipeWorkingContainer ?? wipeWorkingContainer;
		return {
			platform: selectedPlatform,
			executionBackend,
			ensureAgentContainer:
				dependencies.ensureAgentContainer ?? ensureAgentContainer,
			create: (path, options = {}) =>
				createFn(path, undefined, { runId: options.runId }),
			provision: dependencies.provisionCredentials ?? provisionCredentials,
			seed: dependencies.seedProject ?? seedProject,
			commit: dependencies.commitWorkingTree ?? commitWorkingTree,
			reset: dependencies.resetWorkingTree ?? resetWorkingTree,
			destroy: destroyFn,
			preflight: configuredQueuePreflight,
			acquireSlot: () => null,
			releaseSlot: () => {},
		};
	}

	const goldenImage =
		dependencies.goldenImage ?? process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE;
	const aquaUid =
		dependencies.aquaUid ?? process.env.SWITCHYARD_PARALLELS_AQUA_UID;
	const providerUser =
		dependencies.providerUser ??
		process.env.SWITCHYARD_PARALLELS_PROVIDER_USER ??
		"switchyard";
	return {
		platform: selectedPlatform,
		executionBackend,
		// The VM lane does not start the Docker agent container; the standing
		// vault is only read from, over `docker cp`, when credentials are moved
		// into the guest.
		ensureAgentContainer: () => {},
		create: (_path, options = {}) => {
			if (!goldenImage) {
				throw new Error(
					"macos queue requires SWITCHYARD_PARALLELS_GOLDEN_IMAGE",
				);
			}
			return executionBackend.create(goldenImage, {
				runId: options.runId ?? runId,
				aquaUid,
				providerUser,
				// Linked-clone measurement/admission is owned by its later task.
				linked: !!dependencies.linkedCloneMeasurement,
				...(dependencies.linkedCloneMeasurement
					? { linkedCloneMeasurement: dependencies.linkedCloneMeasurement }
					: {}),
			});
		},
		// Routing has not picked a provider at workspace-creation time, so every
		// tar-provisionable provider is seeded and each adapter's own auth check
		// decides at exec — the same contract the Docker lane has always had.
		// This was `() => null` until 2026-08-14, which meant the guest booted
		// with no credentials at all and every provider failed authentication.
		provision:
			dependencies.provisionCredentials ??
			((workspaceId) =>
				provisionAllCredentialsWithBackend(executionBackend, workspaceId, {
					aquaUid,
					providerUser,
					...(dependencies.agentContainerName
						? { agentContainerName: dependencies.agentContainerName }
						: {}),
					// The vault read is a seam so the wiring can be tested without a
					// standing Docker container, and so nothing pulls real credential
					// bytes into a unit-test process.
					...(dependencies.readCredentialTar
						? { readCredentialTar: dependencies.readCredentialTar }
						: {}),
					onSkip: ({ provider, reason }) =>
						console.error(
							`macos queue: ${provider} credentials not provisioned, tasks routed to it will fail authentication: ${reason}`,
						),
				})),
		seed: (workspaceId, path) =>
			seedProjectWithBackend(executionBackend, workspaceId, path),
		commit: (workspaceId) =>
			runBackendGitCommand(
				executionBackend,
				workspaceId,
				"git add -A && (git diff --cached --quiet || git commit -q -m switchyard-task)",
			),
		reset: (workspaceId) =>
			runBackendGitCommand(
				executionBackend,
				workspaceId,
				"git reset --hard && git clean -fd",
			),
		destroy: (workspaceId) => executionBackend.destroy(workspaceId),
		preflight: configuredQueuePreflight,
		acquireSlot: dependencies.acquireVmSlot ?? acquireVmSlot,
		releaseSlot: dependencies.releaseVmSlot ?? releaseVmSlot,
	};
}

function queuePlatform(options) {
	return normalizeQueuePlatform(
		options.runOptions?.platform ?? options.platform,
	);
}

function prepareQueueLaunch({
	tasksFilePath,
	projectPath,
	checkpointPath,
	maxTasks,
	stopOnFailure,
	exclude,
	only,
	taskIds,
	identityTaskIds = taskIds,
	platform,
	runOptions,
	queueIdentity,
	projectRevision,
	runId,
	dependencies,
	onStatus,
}) {
	const selectedPlatform = queuePlatform({ platform, runOptions });
	const tasks = loadTaskQueue(tasksFilePath);
	if (tasks.length === 0) {
		throwOnEmptyParse(tasksFilePath, checkpointPath, onStatus);
	}
	// Read the checkpoint before backend selection so malformed or stale queue
	// state fails without creating a workspace or reserving a VM slot.
	loadCheckpoint(checkpointPath, tasksFilePath);
	const identity = resolveQueueIdentity(
		{
			tasksFilePath,
			projectPath,
			checkpointPath,
			maxTasks,
			stopOnFailure,
			exclude,
			only,
			taskIds: identityTaskIds,
			platform: selectedPlatform,
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
	ensureRetryCheckpoint(checkpoint);
	validateRetryDescriptorEvidence(checkpoint);
	const queueBackend = createQueueBackend({
		platform: selectedPlatform,
		dependencies,
		projectPath,
		runId,
		runOptions: identity.runOptions ?? runOptions,
	});
	queueBackend.preflight({
		platform: selectedPlatform,
		tasks,
		checkpoint,
		maxTasks: effectiveMaxTasks,
		selectedTaskIds: effectiveTaskIds,
		exclude: effectiveExclude,
		only: effectiveOnly,
		runId,
		projectPath,
		runOptions: identity.runOptions,
	});
	const slotLease =
		selectedPlatform === "macos" ? queueBackend.acquireSlot({ runId }) : null;
	return {
		selectedPlatform,
		tasks,
		checkpoint,
		identity,
		queueBackend,
		slotLease,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	};
}

function releaseQueueSlot(queueBackend, slotLease) {
	if (!slotLease) return;
	try {
		queueBackend.releaseSlot(slotLease);
	} catch {
		// The queue outcome is authoritative; release is best effort but always
		// attempted from the enclosing finally block.
	}
}

/**
 * Dual-write one dispatch outcome: project-local store first, legacy file
 * ledger second. Neither failure aborts the other, and neither aborts the
 * dispatch — but both are now reported through the bounded classifier rather
 * than swallowed, so a caller supplying `reporting` sees them.
 *
 * `reporting` is appended rather than inserted: both call sites already pass a
 * store-writer closure as the second argument.
 *
 * @param {object} dispatch
 * @param {Function} [recordDispatchToStoreFn]
 * @param {object} [reporting] from ledgerReportingContext()
 */
function recordDispatchToBothLedgers(
	dispatch,
	recordDispatchToStoreFn = recordDispatchToStore,
	reporting = {},
) {
	return Promise.resolve()
		.then(() => recordDispatchToStoreFn(dispatch))
		.catch((error) => {
			reportOutcomeProjectionFailure(reporting, error);
		})
		.then(() => {
			try {
				recordDispatch(dispatch);
			} catch (error) {
				reportLegacyProjectionFailure(reporting, error);
			}
		});
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
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId = null,
		dependencies = {},
	} = options;

	(dependencies.assertGenerationAllowed ?? assertGenerationAllowed)({
		markerPath: dependencies.generationMarkerPath,
	});
	const onTaskStart = dependencies.onTaskStart ?? null;
	const onTaskRouted = dependencies.onTaskRouted ?? null;
	const onResult = dependencies.onResult ?? null;
	const onCheckpointSaved = dependencies.onCheckpointSaved ?? null;
	const onRetryStateChanged = dependencies.onRetryStateChanged ?? null;
	const onContainerReady = dependencies.onContainerReady ?? null;
	const runStore = dependencies.runStore ?? null;
	const runStorePath = dependencies.runStorePath ?? null;
	const emitStatus = _resolveOnStatus(dependencies);
	const launch = prepareQueueLaunch({
		tasksFilePath,
		projectPath,
		checkpointPath,
		maxTasks,
		stopOnFailure,
		exclude,
		only,
		taskIds,
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId,
		dependencies,
		onStatus: emitStatus,
	});
	const {
		queueBackend,
		slotLease,
		tasks,
		checkpoint,
		identity,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	try {
		if (!workingContainerName) {
			queueBackend.ensureAgentContainer();
			// Pass runId so the working container carries the managed + run_id
			// labels (createWorkingContainer's labeled branch). Without this the
			// container is unlabeled and invisible to `recover` — the core leak.
			workingContainerName = queueBackend.create(projectPath, { runId });
			if (!workingContainerName) {
				throw new Error("runQueue: failed to create working container");
			}
			ownsWorkingContainer = true;
			uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
				workingContainerName,
				queueBackend.destroy,
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
				queueBackend.provision(workingContainerName);
			} catch (error) {
				console.error(
					`runQueue: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
		}

		// Fires once the workspace handle holds its final value, whether it was
		// supplied by the caller or created by this queue.
		if (onContainerReady) onContainerReady({ workingContainerName });
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				queueBackend.destroy(workingContainerName);
			} catch {
				// Preserve the bootstrap error.
			}
		}
		releaseQueueSlot(queueBackend, slotLease);
		throw error;
	}

	const recordDispatchToStoreFn =
		dependencies.recordDispatchToStore ?? recordDispatchToStore;
	const recordDispatchIntentFn =
		dependencies.recordDispatchIntent ?? recordDispatchIntentToStore;
	const ledgerReporting = ledgerReportingContext(
		emitStatus,
		dependencies,
		"runQueue",
	);
	// The project-local outcome write is async; executeTask() and runQueue are
	// both synchronous. Writes are therefore queued onto one chain that keeps
	// them in dispatch order, and nothing in this function can await it --
	// making runQueue async would duplicate runQueueAsync, which exists for
	// exactly that reason.
	//
	// What the chain cannot do on its own is guarantee durability before the
	// caller acts on the return value: a caller that exits the process as soon
	// as runQueue returns drops any write still in flight. The chain is
	// returned as `ledgerWritesSettled` so such a caller can drain it. The
	// authoritative pre-dispatch intent receipt is unaffected -- it is written
	// synchronously by recordDispatchIntentToStore, before the provider runs,
	// and never goes through this chain.
	let storeWriteChain = Promise.resolve();
	const defaultRecordDispatch = (dispatch) => {
		storeWriteChain = storeWriteChain
			.then(() => recordDispatchToStoreFn(dispatch, runStorePath))
			.catch((error) => {
				reportOutcomeProjectionFailure(ledgerReporting, error);
			})
			.then(() => {
				try {
					recordDispatch(dispatch);
				} catch (error) {
					reportLegacyProjectionFailure(ledgerReporting, error);
				}
			})
			// Both handlers above call caller-supplied code (`onStatus`,
			// `diagnostics.emit`, `onLedgerProjectionFailure`), none of which is
			// guarded against throwing. Everywhere else in this runner such a
			// throw propagates synchronously and is the caller's own visible
			// bug; here it would instead reject a chain that the documented
			// normal case ignores, turning a best-effort ledger warning into an
			// unhandled rejection -- fatal on current Node, and raised after
			// runQueue has already returned success. So the chain is kept
			// non-rejecting: `ledgerWritesSettled` always settles, which is also
			// what a caller draining it before exit needs. console.warn is the
			// only channel left once the status surface is the thing that broke.
			.catch((error) => {
				console.warn(
					`runQueue: dispatch-ledger failure reporting threw (${error?.name ?? "Error"}); the ledger write itself is unaffected`,
				);
			});
	};
	const defaultRecordDispatchIntent = (intent) => {
		recordDispatchIntentFn(intent, runStorePath);
	};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ?? defaultRecordDispatchIntent,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		onStatus: emitStatus,
		onTaskRouted,
		onLedgerProjectionFailure: dependencies.onLedgerProjectionFailure,
		onIntentReceiptFailure: dependencies.onIntentReceiptFailure,
		resolveDescriptor: dependencies.resolveDescriptor,
		exclude,
		only,
	};

	try {
		if (ownsWorkingContainer) {
			try {
				queueBackend.seed(workingContainerName, projectPath);
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

		context.exclude = effectiveExclude;
		context.only = effectiveOnly;
		const projectRetryState = () => {
			if (
				(!runStore && !onRetryStateChanged) ||
				(checkpoint.retryTransitionId === 0 &&
					checkpoint.retryState === null &&
					checkpoint.quarantinedTargetIds.length === 0)
			) {
				return;
			}
			const projection = {
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
			};
			if (runStore) runStore.updateRun(projection).catch(() => {});
			if (onRetryStateChanged) onRetryStateChanged(projection);
		};
		const selectionOptions = identity.enabled
			? { selectedTaskIds: effectiveTaskIds }
			: {};
		context.exclude = mergeRetryExclusions(
			effectiveExclude,
			checkpoint.quarantinedTargetIds,
		);
		const initialRunnable = getRunnableTasks(
			tasks,
			checkpoint,
			selectionOptions,
		);
		const attemptedTaskIds = new Set();
		const results = [];
		reconcileAlreadyCompleteSelection(
			checkpoint,
			checkpointPath,
			results,
			effectiveTaskIds,
			tasks,
			onResult,
			emitStatus,
			onCheckpointSaved,
		);
		let processed = 0;
		let halted = false;
		let resumedRetryTaskId = checkpoint.retryState?.taskId ?? null;

		while (processed < effectiveMaxTasks) {
			const runnable = resumedRetryTaskId
				? []
				: getRunnableTasks(tasks, checkpoint, {
						excludedTaskIds: attemptedTaskIds,
						...selectionOptions,
					});
			const task = resumedRetryTaskId
				? tasks.find((candidate) => candidate.id === resumedRetryTaskId)
				: runnable[0];
			if (!task) break;
			const retryState =
				checkpoint.retryState?.taskId === task.id
					? checkpoint.retryState
					: null;
			if (resumedRetryTaskId) {
				resumedRetryTaskId = null;
			} else {
				attemptedTaskIds.add(task.id);
			}
			context._activeInvocationDescriptor = null;

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
			context.exclude = mergeRetryExclusions(
				effectiveExclude,
				checkpoint.quarantinedTargetIds,
			);
			let result;
			let retryHaltResult = null;
			let retryUsed = Boolean(retryState);
			let retryTargetId = retryState?.resolvedTargetId ?? null;
			const retryEvidenceMissing =
				Boolean(retryState) && !hasExactRetryDescriptorEvidence(retryState);
			if (retryEvidenceMissing) {
				// Historical model-only retry state is readable, but it cannot
				// authorize a retry against an exact descriptor/target. Halt before
				// reset, reroute, or adapter invocation; the normal finally path
				// still releases the run/project locks.
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					resolvedTargetId: retryState.resolvedTargetId ?? null,
					result: "unknown_failure",
					errorKind: "descriptor_receipt",
					reason:
						"historical retry state lacks exact invocation descriptor evidence",
				};
			} else if (retryState) {
				const resumedTargetId = normalizeRetryTargetId(
					retryState.resolvedTargetId,
				);
				if (
					resumedTargetId &&
					!checkpoint.quarantinedTargetIds.includes(resumedTargetId)
				) {
					// A crash can land after attempt_recorded but before the
					// separate quarantine transition. Reconstruct the safety
					// invariant before any reset/reroute so resume cannot select
					// the exhausted target again.
					checkpoint.quarantinedTargetIds = [
						...checkpoint.quarantinedTargetIds,
						resumedTargetId,
					];
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "target_quarantined",
						taskId: task.id,
						attempt: 1,
						resolvedTargetId: resumedTargetId,
						invocationDescriptor: retryState.invocationDescriptor,
						descriptorIdentity: retryState.descriptorIdentity,
						descriptorHarness: retryState.descriptorHarness,
					});
					projectRetryState();
				}
				if (retryState.phase === "retry_halted") {
					result = {
						taskId: task.id,
						success: false,
						provider: null,
						model: null,
						result: "unknown_failure",
						errorKind: "unknown_failure",
					};
				} else if (retryState.phase === "retry_started") {
					// A provider may already have run when the process died after
					// this transition. Never spend a third attempt; fail closed.
					result = {
						taskId: task.id,
						success: false,
						provider: null,
						model: null,
						result: "unknown_failure",
						errorKind: "unknown_failure",
					};
				} else {
					if (retryState.phase !== "reset_completed") {
						retryHaltResult = resetBeforeQuotaRetry({
							result: {
								taskId: task.id,
								provider: null,
								model: null,
								resolvedTargetId: retryState.resolvedTargetId,
								invocationDescriptor: retryState.invocationDescriptor,
								descriptorIdentity: retryState.descriptorIdentity,
								descriptorHarness: retryState.descriptorHarness,
							},
							checkpoint,
							checkpointPath,
							workingContainerName,
							resetWorkingTreeFn: queueBackend.reset,
							emitStatus,
						});
						projectRetryState();
					}
					if (!retryHaltResult) {
						persistRetryTransition(checkpoint, checkpointPath, {
							type: "retry_started",
							taskId: task.id,
							attempt: 2,
							resolvedTargetId: retryState.resolvedTargetId,
							invocationDescriptor: retryState.invocationDescriptor,
							descriptorIdentity: retryState.descriptorIdentity,
							descriptorHarness: retryState.descriptorHarness,
						});
						projectRetryState();
						context.exclude = mergeRetryExclusions(
							effectiveExclude,
							checkpoint.quarantinedTargetIds,
						);
						result = executeTask(task, context);
					}
				}
			} else {
				result = executeTask(task, context);
				if (context._activeInvocationDescriptor) {
					Object.assign(
						result,
						descriptorReceiptFields(context._activeInvocationDescriptor),
					);
				}
				if (isQuotaRetryCandidate(result, ownsWorkingContainer)) {
					const targetId = normalizeRetryTargetId(result.resolvedTargetId);
					retryUsed = true;
					retryTargetId = targetId;
					appendRetryAttempt(checkpoint, result, 1);
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "attempt_recorded",
						taskId: task.id,
						attempt: 1,
						provider: result.provider,
						model: result.model,
						resolvedTargetId: targetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
					});
					projectRetryState();
					checkpoint.quarantinedTargetIds = [
						...new Set([...checkpoint.quarantinedTargetIds, targetId]),
					];
					persistRetryTransition(checkpoint, checkpointPath, {
						type: "target_quarantined",
						taskId: task.id,
						attempt: 1,
						provider: result.provider,
						model: result.model,
						resolvedTargetId: targetId,
						invocationDescriptor: result.invocationDescriptor,
						descriptorIdentity: result.descriptorIdentity,
						descriptorHarness: result.descriptorHarness,
					});
					projectRetryState();
					if (emitStatus) {
						emitStatus({
							phase: "execution",
							event: "target_quarantined",
							status: `Quarantined ${targetId} after quota exhaustion`,
							taskId: task.id,
							provider: result.provider,
							model: result.model,
							resolvedTargetId: targetId,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity: result.descriptorIdentity,
							descriptorHarness: result.descriptorHarness,
						});
					}
					retryHaltResult = resetBeforeQuotaRetry({
						result,
						checkpoint,
						checkpointPath,
						workingContainerName,
						resetWorkingTreeFn: queueBackend.reset,
						emitStatus,
					});
					projectRetryState();
					if (!retryHaltResult) {
						persistRetryTransition(checkpoint, checkpointPath, {
							type: "retry_started",
							taskId: task.id,
							attempt: 2,
							provider: result.provider,
							model: result.model,
							resolvedTargetId: targetId,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity: result.descriptorIdentity,
							descriptorHarness: result.descriptorHarness,
						});
						projectRetryState();
						context.exclude = mergeRetryExclusions(
							effectiveExclude,
							checkpoint.quarantinedTargetIds,
						);
						result = executeTask(task, context);
					}
				}
			}

			if (retryHaltResult) {
				recordHalt(
					checkpoint,
					checkpointPath,
					results,
					retryHaltResult,
					emitStatus,
				);
				processed += 1;
				halted = true;
				break;
			}
			if (retryUsed) {
				appendRetryAttempt(checkpoint, result, 2);
			}
			if (context._activeInvocationDescriptor) {
				Object.assign(
					result,
					descriptorReceiptFields(context._activeInvocationDescriptor),
				);
			}
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
				...(result.invocationDescriptor
					? {
							dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity:
								result.invocationDescriptor.descriptor_identity,
							descriptorHarness: result.descriptorHarness ?? null,
							resolvedTargetId: result.resolvedTargetId ?? null,
						}
					: {}),
				result: result.result,
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				success: result.success,
				timedOut: Boolean(result.timedOut),
				partialDiffPath: null,
				...(safeFailure ?? {}),
				...(opaqueArtifactRef(result.artifactRef)
					? { artifactRef: opaqueArtifactRef(result.artifactRef) }
					: {}),
				timestamp: new Date().toISOString(),
			});
			checkpoint.lastTaskId = result.taskId;
			checkpoint.lastUpdatedAt = new Date().toISOString();

			if (result.success) {
				checkpoint.completedTaskIds.push(result.taskId);
			}
			if (retryUsed) {
				persistRetryTransition(checkpoint, checkpointPath, {
					type: "finalized",
					taskId: result.taskId,
					attempt: 2,
					provider: result.provider,
					model: result.model,
					resolvedTargetId:
						result.invocationDescriptor?.target_id ??
						normalizeRetryTargetId(result.resolvedTargetId) ??
						retryTargetId,
					invocationDescriptor: result.invocationDescriptor,
					descriptorIdentity: result.descriptorIdentity,
					descriptorHarness: result.descriptorHarness,
					clearState: true,
					save: false,
				});
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
			projectRetryState();
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
				commitWorkingTreeFn: queueBackend.commit,
				resetWorkingTreeFn: queueBackend.reset,
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
					quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
					retryState: checkpoint.retryState,
					retryTransitionId: checkpoint.retryTransitionId,
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
			// The drain boundary for the async outcome writes queued above. A
			// caller that terminates on return (or that reads the ledger right
			// after it) must await this; every other caller can ignore it, which
			// is why runQueue's own signature stays synchronous.
			ledgerWritesSettled: storeWriteChain,
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
		try {
			if (ownsWorkingContainer) {
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_started",
						status: "Wiping working container",
					});
				}
				try {
					queueBackend.destroy(workingContainerName);
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
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
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
		platform,
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
	const onTaskStart = dependencies.onTaskStart ?? null;
	const onTaskRouted = dependencies.onTaskRouted ?? null;
	const onResult = dependencies.onResult ?? null;
	const onCheckpointSaved = dependencies.onCheckpointSaved ?? null;
	const runStore = dependencies.runStore ?? null;
	const runStorePath = dependencies.runStorePath ?? null;
	const emitStatus = _resolveOnStatus(dependencies);
	const launch = prepareQueueLaunch({
		tasksFilePath,
		projectPath,
		checkpointPath,
		maxTasks,
		stopOnFailure,
		exclude,
		only,
		taskIds,
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId,
		dependencies,
		onStatus: emitStatus,
	});
	const {
		queueBackend,
		slotLease,
		tasks,
		checkpoint,
		identity,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	try {
		if (!workingContainerName) {
			queueBackend.ensureAgentContainer();
			// Pass runId so the container is labeled managed + run_id (see runQueue).
			workingContainerName = queueBackend.create(projectPath, { runId });
			if (!workingContainerName) {
				throw new Error(
					"runQueueWithOrchestrator: failed to create working container",
				);
			}
			ownsWorkingContainer = true;
			uninstallSignalCleanup = _installOwnedContainerSignalCleanup(
				workingContainerName,
				queueBackend.destroy,
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
				queueBackend.provision(workingContainerName);
			} catch (error) {
				console.error(
					`runQueueWithOrchestrator: credential provisioning failed, continuing unauthenticated: ${error.message}`,
				);
			}
		}
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				queueBackend.destroy(workingContainerName);
			} catch {
				// Preserve the bootstrap error.
			}
		}
		releaseQueueSlot(queueBackend, slotLease);
		throw error;
	}

	const recordDispatchToStoreFn =
		dependencies.recordDispatchToStore ?? recordDispatchToStore;
	const recordDispatchIntentFn =
		dependencies.recordDispatchIntent ?? recordDispatchIntentToStore;
	const defaultRecordDispatch = async (dispatch) => {
		await recordDispatchToBothLedgers(
			dispatch,
			(data) => recordDispatchToStoreFn(data, runStorePath),
			ledgerReportingContext(emitStatus, dependencies),
		);
	};
	const defaultRecordDispatchIntent = (intent) =>
		recordDispatchIntentFn(intent, runStorePath);
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ?? defaultRecordDispatchIntent,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		orchestrator: resolveOrchestrator(dependencies),
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		pollIntervalMs,
		maxPolls,
		now: dependencies.now ?? Date.now,
		sleepFn: dependencies.sleepFn ?? sleep,
		onPoll: dependencies.onPoll ?? null,
		onStatus: emitStatus,
		onTaskRouted,
		onLedgerProjectionFailure: dependencies.onLedgerProjectionFailure,
		onIntentReceiptFailure: dependencies.onIntentReceiptFailure,
		resolveDescriptor: dependencies.resolveDescriptor,
	};

	try {
		if (ownsWorkingContainer) {
			try {
				queueBackend.seed(workingContainerName, projectPath);
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

		context.exclude = effectiveExclude;
		context.only = effectiveOnly;
		if (checkpoint.retryState !== null) {
			const reason = hasExactRetryDescriptorEvidence(checkpoint.retryState)
				? "orchestrator mode cannot resume persisted retry state until an audited retry-resume state machine is implemented"
				: "historical retry state lacks exact invocation descriptor evidence";
			throw new Error(`runQueueWithOrchestrator: ${reason}`);
		}
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
		reconcileAlreadyCompleteSelection(
			checkpoint,
			checkpointPath,
			results,
			effectiveTaskIds,
			tasks,
			onResult,
			emitStatus,
			onCheckpointSaved,
		);
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
			context._activeInvocationDescriptor = null;

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
			if (context._activeInvocationDescriptor) {
				Object.assign(
					result,
					descriptorReceiptFields(context._activeInvocationDescriptor),
				);
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
				...(result.invocationDescriptor
					? {
							dispatchContractVersion: DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
							invocationDescriptor: result.invocationDescriptor,
							descriptorIdentity:
								result.invocationDescriptor.descriptor_identity,
							descriptorHarness: result.descriptorHarness ?? null,
							resolvedTargetId: result.resolvedTargetId ?? null,
						}
					: {}),
				result: result.result,
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				success: result.success,
				timedOut: Boolean(result.timedOut),
				partialDiffPath: null,
				...(safeFailure ?? {}),
				...(opaqueArtifactRef(result.artifactRef)
					? { artifactRef: opaqueArtifactRef(result.artifactRef) }
					: {}),
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
				commitWorkingTreeFn: queueBackend.commit,
				resetWorkingTreeFn: queueBackend.reset,
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
		try {
			if (ownsWorkingContainer) {
				if (emitStatus) {
					emitStatus({
						phase: "cleanup",
						event: "cleanup_started",
						status: "Wiping working container",
					});
				}
				try {
					queueBackend.destroy(workingContainerName);
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
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
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
