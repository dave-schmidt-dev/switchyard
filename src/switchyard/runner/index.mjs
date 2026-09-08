// Runner module - host-side runner supervising headless orchestrator
// Reads persisted task queue, drives serial execution, checkpoints for resume.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fchmodSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
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
	CHECKPOINT_REMEDIATION_MESSAGES,
	CLEANUP_STAGES,
	checkpointRemediation,
	INTEGRATION_REFUSAL_KINDS,
	PERSISTED_DIAGNOSTIC_CODES,
	PERSISTED_ERROR_KINDS,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import {
	captureDiff as captureOpencodeDiff,
	captureDiffAsync as captureOpencodeDiffAsync,
	execute as executeOpencode,
	executeAsync as executeOpencodeAsync,
} from "../adapter/opencode.mjs";
import {
	createProgressSnapshot,
	DEFAULT_SILENCE_TIMEOUT_MS,
	verifyCompletionContinuationSync,
} from "../adapter/provider-lifecycle.mjs";
import {
	captureDiff as captureVibeDiff,
	captureDiffAsync as captureVibeDiffAsync,
	captureDiffDetailed as captureVibeDiffDetailed,
	captureDiffDetailedAsync as captureVibeDiffDetailedAsync,
	execute as executeVibe,
	executeAsync as executeVibeAsync,
} from "../adapter/vibe.mjs";
import { createBroker } from "../broker/index.mjs";
import {
	reviewResultFromExecution,
	unavailableReviewResult,
} from "../diagnostics/review-result.mjs";
import { HOST_POWER_STATES, readHostPower } from "../dispatch/host-power.mjs";
import {
	integrationGate,
	validateExactPathSet,
	validateIntegratedCommitAncestry,
	validateIntegratedCommitPaths,
	validateNoTrackedPathOverlap,
} from "../integrate/index.mjs";
import {
	readLedgerFromStore,
	recordDispatch,
	recordDispatchIntentToStore,
	recordDispatchToStore,
	recordExternalCompletionToStore,
} from "../ledger/index.mjs";
import {
	loadWorkspaceLifecycleHooks,
	runWorkspaceLifecycleHook,
} from "../lifecycle/hooks.mjs";
import {
	captureDirtyOverlay,
	captureTaskStartTree,
	captureTaskStartTreeAsync,
	readDirtyOverlayReceipt,
	releaseTaskStartTree,
	releaseTaskStartTreeAsync,
	seedProjectWithBackend,
	validateDirtyOverlayReceipt,
	validateTaskStartTree,
	validateTaskStartTreeAsync,
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
	acquireHalfOpenClaimSync,
	createDefaultRouteHealthDecision,
	createRouteHealthTerminalBinding,
	releaseHalfOpenClaimSync,
	startHalfOpenClaimSync,
} from "../router/health.mjs";
import {
	GOLDEN_IMAGE_VERIFIED_PROVIDERS,
	preflightMacosQueue,
	readSnapshotAtRoute,
	route,
} from "../router/index.mjs";
import {
	acquireVmSlot,
	createFencingIdentity,
	getStateRoot,
	getVmAdmissionRoot,
	isProjectLockOwnedBy,
	releaseVmSlot,
	VmSlotUnavailableError,
} from "../run-store/index.mjs";

const CHECKPOINT_VERSION = 3;
const checkpointOwners = new Map();
const BOUNDED_ERROR_KINDS = new Set(PERSISTED_ERROR_KINDS);
const DIAGNOSTIC_REF_RE = /^diagnostic:[a-f0-9]{32}$/u;
const HISTORICAL_CHECKPOINT_VERSION = 1;
const RUN_OPTIONS_VERSION = 1;
const VM_SLOT_WAIT_TIMEOUT_MS = 5 * 60_000;
const VM_SLOT_WAIT_INTERVAL_MS = 1_000;
export const QUEUE_PLATFORMS = Object.freeze(["macos"]);
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
		// Overlay identity is present only when the opt-in is exercised, and the
		// opt-in alone decides it. Emitting these keys unconditionally, or on a
		// stray receipt path that the dispatch preparation ignores because the
		// opt-in is unset, would change the normalized shape — and so the
		// queue-identity hash — for a queue that never asked for an overlay,
		// invalidating in-flight checkpoints written before the feature existed.
		...(options.dirtyOverlay === true
			? {
					dirtyOverlay: options.dirtyOverlay === true,
					dirtyOverlayReceiptPath: options.dirtyOverlayReceiptPath
						? resolve(options.dirtyOverlayReceiptPath)
						: null,
					dirtyOverlayReceiptHash:
						typeof options.dirtyOverlayReceiptHash === "string" &&
						/^[a-f0-9]{64}$/u.test(options.dirtyOverlayReceiptHash)
							? options.dirtyOverlayReceiptHash
							: null,
				}
			: {}),
	};
}

/** Normalize the queue-level execution platform before any workspace exists. */
export function normalizeQueuePlatform(value = "macos") {
	const platform = String(value ?? "macos")
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

const EXTERNAL_COMPLETION_VERSION = 1;
const RECONCILIATION_INTENT_VERSION = 1;
const RECONCILIATION_INTENT_STATES = Object.freeze([
	"prepared",
	"successor_recorded",
	"ledger_recorded",
	"completed",
]);
const EXTERNAL_COMPLETION_MAX_RECEIPT_BYTES = 1024 * 1024;
const RECONCILIATION_INTENT_MAX_BYTES = 8 * 1024 * 1024;
const CHECKPOINT_ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;

function refusal(code, detail = null) {
	return {
		recorded: false,
		status: "refused",
		result: "external_completion_refused",
		reasonCode: code,
		...(detail ? { detail } : {}),
	};
}

function sortedUnique(values) {
	return [...new Set(Array.isArray(values) ? values : [])].sort();
}

function hashBytes(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function readBoundedReceipt(receiptPath) {
	let fd;
	try {
		fd = openSync(
			receiptPath,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.isSymbolicLink())
			return { error: "receipt_not_regular" };
		if (stats.size > EXTERNAL_COMPLETION_MAX_RECEIPT_BYTES)
			return { error: "receipt_too_large" };
		const ownerUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		if (ownerUid !== null && stats.uid !== ownerUid)
			return { error: "receipt_owner_mismatch" };
		const mode = stats.mode & 0o7777;
		if (mode !== 0o600) return { error: "receipt_mode_mismatch" };
		const bytes = Buffer.alloc(stats.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
		let value;
		try {
			value = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
		} catch {
			return { error: "receipt_malformed" };
		}
		if (value?.ownerUid !== stats.uid || value?.mode !== mode)
			return { error: "receipt_stat_mismatch" };
		return { value };
	} catch (error) {
		return {
			error:
				error?.code === "ELOOP" ? "receipt_not_regular" : "receipt_missing",
		};
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function taskContractBytes(markdown, taskId) {
	const taskBlockRegex =
		/### Task ([0-9.]+):\s*(.+)\n([\s\S]*?)(?=\n### Task [0-9.]+:|\n## |\n---|$)/g;
	for (const match of markdown.matchAll(taskBlockRegex)) {
		if (match[1].trim() === taskId) return match[0];
	}
	return null;
}

function reconciliationIntentPath(sourceCheckpointPath) {
	return `${sourceCheckpointPath}.reconciliation-intent.json`;
}

function readIntent(path) {
	if (!existsSync(path)) return null;
	try {
		const stats = lstatSync(path);
		const ownerUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		if (
			!stats.isFile() ||
			stats.isSymbolicLink() ||
			stats.size > RECONCILIATION_INTENT_MAX_BYTES ||
			(ownerUid !== null && stats.uid !== ownerUid) ||
			(stats.mode & 0o7777) !== 0o600
		)
			return { error: "reconciliation_intent_untrusted" };
		const intent = JSON.parse(readFileSync(path, "utf8"));
		const source = intent?.source;
		const immutable = intent?.immutable;
		const successor = intent?.successor;
		const ledger = intent?.ledger;
		if (
			intent?.version !== RECONCILIATION_INTENT_VERSION ||
			!RECONCILIATION_INTENT_STATES.includes(intent.state) ||
			!/^[a-f0-9]{64}$/i.test(intent.reconciliationId ?? "") ||
			typeof source?.checkpointPath !== "string" ||
			typeof source?.owner !== "object" ||
			!validSourceOwner(source.owner) ||
			!Number.isInteger(source.revision) ||
			source.revision < 0 ||
			typeof source.taskId !== "string" ||
			source.taskId.length === 0 ||
			!Number.isInteger(source.attempt) ||
			source.attempt < 1 ||
			typeof source.tasksFilePath !== "string" ||
			!/^[a-f0-9]{64}$/i.test(source.rawSha256 ?? "") ||
			typeof immutable?.projectPath !== "string" ||
			typeof immutable?.receiptPath !== "string" ||
			!validAbsolutePath(immutable?.runStorePath) ||
			!/^[a-f0-9]{64}$/i.test(immutable.contractHash ?? "") ||
			!/^[a-f0-9]{40,64}$/i.test(immutable.integratedCommit ?? "") ||
			!/^[a-f0-9]{40,64}$/i.test(immutable.currentHead ?? "") ||
			!validReconciliationPathList(immutable.changedPaths) ||
			!validReconciliationPathList(immutable.requiredPaths) ||
			!/^[a-f0-9]{64}$/i.test(immutable.queueIdentity ?? "") ||
			!immutable.runOptions ||
			typeof successor?.checkpointPath !== "string" ||
			!successor?.checkpoint ||
			typeof ledger?.runStorePath !== "string" ||
			!validAbsolutePath(ledger.runStorePath) ||
			ledger.runStorePath !== immutable.runStorePath ||
			!ledger?.fields ||
			typeof ledger.fields === "string" ||
			Array.isArray(ledger.fields) ||
			ledger.fields.reconciliationId !== intent.reconciliationId
		)
			return { error: "reconciliation_intent_malformed" };
		return { value: intent };
	} catch {
		return { error: "reconciliation_intent_malformed" };
	}
}

function writeIntent(path, intent) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, JSON.stringify(intent, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

function updateIntent(path, intent, state) {
	writeIntent(path, {
		...intent,
		state,
		updatedAt: new Date().toISOString(),
	});
}

function sourceTaskAllocation(source, taskId) {
	return (source.providerAttemptAllocations ?? []).filter(
		(entry) => entry?.taskId === taskId,
	);
}

function sourceTaskRetry(source, taskId) {
	if (source.retryState?.taskId === taskId) return true;
	const attempts = (source.retryAttempts ?? []).filter(
		(entry) => entry?.taskId === taskId,
	);
	if (attempts.length === 0) return false;
	// retryAttempts is durable history, not by itself a live allocation.  It
	// is safe to archive that history only when the matching transition stream
	// has an explicit terminal finalization; every other shape is unknown.
	const transitions = (source.retryTransitions ?? []).filter(
		(entry) => entry?.taskId === taskId,
	);
	return transitions.at(-1)?.type !== "finalized";
}

function buildSuccessorCheckpoint(source, input, queueIdentity, options, id) {
	const timestamp = new Date().toISOString();
	// Start from the source snapshot so unrelated task state and forward-
	// compatible fields remain byte-for-field represented in the successor.
	// Replace only the fencing/queue identity and the reconciled task's state.
	const checkpoint = {
		...structuredClone(source),
		version: CHECKPOINT_VERSION,
		revision: 0,
		owner: createFencingIdentity(`reconcile-${id.slice(0, 24)}`),
		ownershipReleased: true,
		tasksFilePath: input.tasksFilePath,
		queueIdentity,
		runOptions: options,
	};
	checkpoint.completedTaskIds = [...(source.completedTaskIds ?? [])];
	if (!checkpoint.completedTaskIds.includes(input.taskId))
		checkpoint.completedTaskIds.push(input.taskId);
	checkpoint.lastTaskId = input.taskId;
	checkpoint.lastUpdatedAt = timestamp;
	checkpoint.taskAttempts = { ...(source.taskAttempts ?? {}) };
	checkpoint.taskBases = { ...(source.taskBases ?? {}) };
	delete checkpoint.taskBases[input.taskId];
	checkpoint.results = [
		...(source.results ?? []),
		{
			taskId: input.taskId,
			result: "external_completion_recorded",
			success: true,
			providerSuccess: false,
			completionAuthority: "verified_external_integration",
			timestamp,
		},
	];
	checkpoint.integrationIntents = { ...(source.integrationIntents ?? {}) };
	delete checkpoint.integrationIntents[input.taskId];
	checkpoint.retryAttempts = (source.retryAttempts ?? []).filter(
		(entry) => entry?.taskId !== input.taskId,
	);
	checkpoint.retryTransitions = (source.retryTransitions ?? []).filter(
		(entry) => entry?.taskId !== input.taskId,
	);
	const reconciledTargetIds = new Set(
		[...(source.retryAttempts ?? []), ...(source.retryTransitions ?? [])]
			.filter((entry) => entry?.taskId === input.taskId)
			.map((entry) => normalizeRetryTargetId(entry.resolvedTargetId))
			.filter((targetId) => targetId !== null),
	);
	checkpoint.quarantinedTargetIds = [
		...(source.quarantinedTargetIds ?? []),
	].filter((targetId) => !reconciledTargetIds.has(targetId));
	checkpoint.providerAttemptAllocations = (
		source.providerAttemptAllocations ?? []
	).filter((entry) => entry?.taskId !== input.taskId);
	checkpoint.retryState =
		source.retryState?.taskId === input.taskId
			? null
			: (source.retryState ?? null);
	if (checkpoint.taskBaseReleaseUncertain?.taskId === input.taskId)
		delete checkpoint.taskBaseReleaseUncertain;
	if (checkpoint.providerCleanupUncertain?.taskId === input.taskId)
		delete checkpoint.providerCleanupUncertain;
	checkpoint.resolvedExternalBlockers = sortedUnique([
		...(source.resolvedExternalBlockers ?? []),
		...(input.resolvedExternalBlockers ?? []),
	]);
	checkpoint.externalCompletion = {
		version: EXTERNAL_COMPLETION_VERSION,
		reconciliationId: id,
		sourceCheckpointPath: resolve(input.sourceCheckpointPath),
		sourceRevision: input.sourceRevision,
		sourceOwner: structuredClone(input.sourceOwner),
		attempt: input.attempt,
		integratedCommit: input.integratedCommit,
		contractHash: input.contractHash,
		changedPaths: sortedUnique(input.changedPaths),
		requiredPaths: sortedUnique(input.requiredPaths),
		resolvedExternalBlockers: sortedUnique(
			input.resolvedExternalBlockers ?? [],
		),
		providerSuccess: false,
	};
	checkpoint.migration = {
		kind: "external_completion",
		fromCheckpoint: resolve(input.sourceCheckpointPath),
		fromRevision: input.sourceRevision,
		toQueueIdentity: queueIdentity,
	};
	return checkpoint;
}

function successorMatches(path, expected) {
	if (!existsSync(path)) return { exists: false };
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink())
			return { exists: true, error: "successor_checkpoint_not_regular" };
		const value = JSON.parse(readFileSync(path, "utf8"));
		const same = stableStringify(value) === stableStringify(expected);
		return { exists: true, same, value };
	} catch {
		return { exists: true, error: "successor_checkpoint_conflict" };
	}
}

function readSuccessorRecord(path) {
	if (!existsSync(path)) return { exists: false };
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink())
			return { exists: true, error: "successor_checkpoint_not_regular" };
		return { exists: true, value: JSON.parse(readFileSync(path, "utf8")) };
	} catch {
		return { exists: true, error: "successor_checkpoint_conflict" };
	}
}

function writeSuccessor(path, checkpoint) {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, JSON.stringify(checkpoint, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(temp, 0o600);
	try {
		// A hard-link publish is atomic and refuses to replace an existing
		// successor.  That closes the concurrent replay window without allowing
		// one reconciler to overwrite another's durable checkpoint.
		linkSync(temp, path);
		unlinkSync(temp);
		return true;
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		if (error?.code === "EEXIST") {
			const existing = successorMatches(path, checkpoint);
			if (existing.exists && existing.same) return false;
		}
		throw error;
	}
}

function intentMatchesInput(intent, input) {
	const immutable = intent.immutable;
	let inputOptions = null;
	let inputRunStorePath = null;
	try {
		if (Object.hasOwn(input, "nextRunOptions"))
			inputOptions = normalizeReconciliationRunOptions(input);
		if (Object.hasOwn(input, "runStorePath"))
			inputRunStorePath = reconciliationRunStorePath(input);
	} catch {
		return false;
	}
	if (
		!immutable ||
		typeof immutable.queueIdentity !== "string" ||
		typeof immutable.runStorePath !== "string" ||
		!immutable.runOptions ||
		!intent.successor?.checkpoint?.externalCompletion ||
		intent.ledger.fields.reconciliationId !== intent.reconciliationId ||
		typeof input.successorCheckpointPath !== "string" ||
		typeof input.tasksFilePath !== "string" ||
		typeof input.projectPath !== "string" ||
		typeof input.receiptPath !== "string"
	)
		return false;
	const expectedId = hashBytes(
		stableStringify({
			version: RECONCILIATION_INTENT_VERSION,
			taskId: intent.source.taskId,
			attempt: intent.source.attempt,
			sourceCheckpointPath: intent.source.checkpointPath,
			sourceRevision: intent.source.revision,
			sourceOwner: intent.source.owner,
			contractHash: immutable.contractHash,
			receiptPath: immutable.receiptPath,
			integratedCommit: immutable.integratedCommit,
			changedPaths: immutable.changedPaths,
			requiredPaths: immutable.requiredPaths,
			resolvedExternalBlockers: immutable.resolvedExternalBlockers,
			queueIdentity: immutable.queueIdentity,
			runOptions: immutable.runOptions,
			runStorePath: immutable.runStorePath,
		}),
	);
	const completion = intent.successor.checkpoint.externalCompletion;
	const identityMatches =
		expectedId === intent.reconciliationId &&
		completion.reconciliationId === intent.reconciliationId &&
		completion.sourceCheckpointPath === intent.source.checkpointPath &&
		completion.sourceRevision === intent.source.revision &&
		completion.attempt === intent.source.attempt &&
		stableStringify(completion.sourceOwner) ===
			stableStringify(intent.source.owner) &&
		completion.contractHash === immutable.contractHash &&
		completion.integratedCommit === immutable.integratedCommit &&
		stableStringify(completion.changedPaths) ===
			stableStringify(immutable.changedPaths) &&
		stableStringify(completion.requiredPaths) ===
			stableStringify(immutable.requiredPaths) &&
		stableStringify(completion.resolvedExternalBlockers ?? []) ===
			stableStringify(immutable.resolvedExternalBlockers) &&
		completion.providerSuccess === false &&
		intent.successor.checkpointPath ===
			resolve(input.successorCheckpointPath) &&
		intent.source.checkpointPath === resolve(input.sourceCheckpointPath) &&
		immutable.projectPath === resolve(input.projectPath) &&
		immutable.receiptPath === resolve(input.receiptPath) &&
		intent.source.tasksFilePath === resolve(input.tasksFilePath);
	if (!identityMatches) return false;
	if (
		Object.hasOwn(input, "runStorePath") &&
		inputRunStorePath !== immutable.runStorePath
	)
		return false;
	if (Object.hasOwn(input, "taskId") && intent.source.taskId !== input.taskId)
		return false;
	if (
		Object.hasOwn(input, "attempt") &&
		intent.source.attempt !== input.attempt
	)
		return false;
	if (
		Object.hasOwn(input, "sourceRevision") &&
		intent.source.revision !== input.sourceRevision
	)
		return false;
	if (
		Object.hasOwn(input, "sourceOwner") &&
		stableStringify(intent.source.owner) !== stableStringify(input.sourceOwner)
	)
		return false;
	if (
		Object.hasOwn(input, "contractHash") &&
		immutable.contractHash !== input.contractHash
	)
		return false;
	if (
		Object.hasOwn(input, "integratedCommit") &&
		immutable.integratedCommit !== input.integratedCommit
	)
		return false;
	if (
		Object.hasOwn(input, "changedPaths") &&
		stableStringify(immutable.changedPaths) !==
			stableStringify(sortedUnique(input.changedPaths))
	)
		return false;
	if (
		Object.hasOwn(input, "requiredPaths") &&
		stableStringify(immutable.requiredPaths) !==
			stableStringify(sortedUnique(input.requiredPaths))
	)
		return false;
	if (
		Object.hasOwn(input, "nextRunOptions") &&
		(inputOptions === null ||
			stableStringify(immutable.runOptions) !== stableStringify(inputOptions))
	)
		return false;
	if (
		Object.hasOwn(input, "resolvedExternalBlockers") &&
		stableStringify(immutable.resolvedExternalBlockers) !==
			stableStringify(sortedUnique(input.resolvedExternalBlockers ?? []))
	)
		return false;
	return (
		input.reconciliationId === undefined ||
		input.reconciliationId === intent.reconciliationId
	);
}

async function replayReconciliationIntent(
	intent,
	intentPath,
	input,
	sourceLease = null,
) {
	const expected = intent.successor.checkpoint;
	const successorPath = intent.successor.checkpointPath;
	assertReconciliationSourceLease(sourceLease);
	const existing = successorMatches(successorPath, expected);
	if (existing.error || (existing.exists && !existing.same))
		return refusal(existing.error ?? "successor_checkpoint_conflict");
	if (!existing.exists) {
		assertReconciliationSourceLease(sourceLease);
		writeSuccessor(successorPath, expected);
		// Persist the successor boundary before touching the ledger.  Recovery
		// can then distinguish a prepared intent from one whose first durable
		// side effect is already present, without trusting mutable worktree data.
		updateIntent(intentPath, intent, "successor_recorded");
	} else if (intent.state === "prepared") {
		// A crash between the successor rename and the state transition is a
		// recoverable window.  Reassert the state only after the exact successor
		// bytes have been verified above.
		updateIntent(intentPath, intent, "successor_recorded");
	}
	if (input.__testFault === "after_successor")
		throw new Error("injected reconciliation crash after successor");
	let ledger;
	try {
		assertReconciliationSourceLease(sourceLease);
		if (input.__testFault === "ledger_failure") {
			const error = new Error("injected reconciliation ledger failure");
			error.code = "EIO";
			throw error;
		}
		ledger = await recordExternalCompletionToStore(
			intent.ledger.fields,
			intent.ledger.runStorePath,
		);
	} catch (error) {
		if (error?.code === "RECONCILIATION_LEDGER_MISMATCH")
			return refusal("ledger_reconciliation_mismatch");
		return recoveryRequired(
			"completion_record_persistence_failed",
			error?.code ?? "unknown",
			intent,
		);
	}
	assertReconciliationSourceLease(sourceLease);
	updateIntent(intentPath, intent, "ledger_recorded");
	if (input.__testFault === "after_ledger")
		throw new Error("injected reconciliation crash after ledger");
	assertReconciliationSourceLease(sourceLease);
	updateIntent(intentPath, intent, "completed");
	if (
		input.__testFault === "before_finalization" ||
		input.__testFault === "during_finalization"
	)
		throw new Error("injected reconciliation crash before finalization");
	try {
		assertReconciliationSourceLease(sourceLease);
		unlinkSync(intentPath);
	} catch (error) {
		if (error?.code !== "ENOENT")
			return recoveryRequired(
				"reconciliation_finalization_failed",
				error?.code ?? "unknown",
				intent,
			);
	}
	return {
		recorded: true,
		status:
			existing.exists && ledger?.alreadyRecorded
				? "already-recorded"
				: "recorded",
		result: "external_completion_recorded",
		reconciliationId: intent.reconciliationId,
		successorCheckpointPath: successorPath,
		providerSuccess: false,
	};
}

function validateExternalCompletionInput(input) {
	if (!input || typeof input !== "object") return refusal("malformed_receipt");
	const required = [
		"sourceCheckpointPath",
		"successorCheckpointPath",
		"tasksFilePath",
		"projectPath",
		"receiptPath",
		"taskId",
		"attempt",
		"contractHash",
		"integratedCommit",
		"changedPaths",
		"requiredPaths",
		"nextRunOptions",
	];
	if (required.some((field) => input[field] === undefined))
		return refusal("malformed_receipt");
	for (const field of [
		"sourceCheckpointPath",
		"successorCheckpointPath",
		"tasksFilePath",
		"projectPath",
		"receiptPath",
		"taskId",
		"contractHash",
		"integratedCommit",
	]) {
		if (
			typeof input[field] !== "string" ||
			input[field].length === 0 ||
			input[field].length > 4096
		)
			return refusal("malformed_receipt");
	}
	if (input.taskId.length > 256) return refusal("malformed_receipt");
	if (input.providerSuccess !== undefined && input.providerSuccess !== false)
		return refusal("malformed_receipt");
	if (
		input.runStorePath !== undefined &&
		!validAbsolutePath(input.runStorePath)
	)
		return refusal("malformed_receipt");
	if (
		input.nextRunOptions !== null &&
		(typeof input.nextRunOptions !== "object" ||
			Array.isArray(input.nextRunOptions))
	)
		return refusal("invalid_next_run_options");
	if (
		input.resolvedExternalBlockers !== undefined &&
		(!Array.isArray(input.resolvedExternalBlockers) ||
			input.resolvedExternalBlockers.some(
				(blocker) => typeof blocker !== "string" || blocker.length === 0,
			))
	)
		return refusal("malformed_receipt");
	if (
		resolve(input.sourceCheckpointPath) ===
		resolve(input.successorCheckpointPath)
	)
		return refusal("successor_checkpoint_must_be_distinct");
	if (
		!validReconciliationPathList(input.changedPaths) ||
		!validReconciliationPathList(input.requiredPaths)
	)
		return refusal("malformed_receipt");
	if (
		!/^[a-f0-9]{40,64}$/i.test(input.integratedCommit) ||
		!/^[a-f0-9]{64}$/i.test(input.contractHash) ||
		!Number.isInteger(input.attempt) ||
		input.attempt < 1
	)
		return refusal("malformed_receipt");
	if (
		input.cleanup?.status !== "complete" ||
		(input.cleanup?.taskBaseReleased !== undefined &&
			input.cleanup.taskBaseReleased !== true) ||
		(input.cleanup?.projectLockReleased !== undefined &&
			input.cleanup.projectLockReleased !== true)
	)
		return refusal("cleanup_uncertain");
	if (
		!validSourceOwner(input.sourceOwner) ||
		!Number.isInteger(input.sourceRevision) ||
		input.sourceRevision < 0
	)
		return refusal("source_identity_missing");
	try {
		const options = normalizeReconciliationRunOptions(input);
		if (options.checkpointPath !== resolve(input.successorCheckpointPath))
			return refusal("next_checkpoint_option_mismatch");
	} catch {
		return refusal("invalid_next_run_options");
	}
	return null;
}

function normalizeReconciliationRunOptions(input) {
	return normalizeRunOptions({
		...(input.nextRunOptions ?? {}),
		checkpointPath:
			input.nextRunOptions?.checkpointPath ?? input.successorCheckpointPath,
	});
}

function validReconciliationPath(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		!value.includes("\0") &&
		!value.includes("\\") &&
		!value.startsWith("/") &&
		![...value].some(
			(character) =>
				character.codePointAt(0) <= 0x1f || character.codePointAt(0) === 0x7f,
		) &&
		!value.split("/").includes("..")
	);
}

function validReconciliationPathList(value) {
	return (
		Array.isArray(value) &&
		value.length <= 256 &&
		value.every(validReconciliationPath)
	);
}

function validSourceOwner(value) {
	const fields = ["runId", "processStartIdentity", "nonce"];
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((field) => fields.includes(field)) &&
		fields.every(
			(field) =>
				typeof value[field] === "string" &&
				value[field].length > 0 &&
				value[field].length <= 256 &&
				![...value[field]].some(
					(character) =>
						character.codePointAt(0) <= 0x1f ||
						character.codePointAt(0) === 0x7f,
				),
		)
	);
}

function validAbsolutePath(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		value.startsWith("/") &&
		![...value].some(
			(character) =>
				character.codePointAt(0) <= 0x1f || character.codePointAt(0) === 0x7f,
		)
	);
}

function reconciliationRunStorePath(_input) {
	return resolve(getStateRoot());
}

function intentUsesCurrentRunStore(intent) {
	const canonical = reconciliationRunStorePath();
	return (
		intent?.immutable?.runStorePath === canonical &&
		intent?.ledger?.runStorePath === canonical
	);
}

function recoveryRequired(code, detail, intent) {
	return {
		recorded: false,
		status: "recovery-required",
		result: "external_completion_recovery_required",
		reasonCode: code,
		...(detail ? { detail } : {}),
		...(intent?.reconciliationId
			? { reconciliationId: intent.reconciliationId }
			: {}),
		...(intent?.successor?.checkpointPath
			? { successorCheckpointPath: intent.successor.checkpointPath }
			: {}),
	};
}

function assertReconciliationSourceLease(sourceLease) {
	if (!sourceLease) return;
	assertCheckpointLease(
		sourceLease,
		sourceLease.checkpointPath,
		sourceLease.owner,
	);
}

/**
 * Reconcile a host-verified external integration into a fresh checkpoint.
 * The source checkpoint is read under its existing lease and never mutated.
 * A versioned adjacent intent makes each crash window replayable.
 * @param {object} input bounded receipt and paths
 * @returns {Promise<object>}
 */
export async function reconcileExternalCompletion(input) {
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.sourceCheckpointPath !== "string" ||
		input.sourceCheckpointPath.length === 0
	)
		return refusal("malformed_receipt");
	const intentPath = reconciliationIntentPath(input.sourceCheckpointPath);
	const existingIntent = readIntent(intentPath);
	if (existingIntent?.error) return refusal(existingIntent.error);
	if (existingIntent?.value) {
		if (!intentUsesCurrentRunStore(existingIntent.value))
			return refusal("reconciliation_intent_mismatch");
		let sourceLease;
		try {
			if (!intentMatchesInput(existingIntent.value, input))
				return refusal("reconciliation_intent_mismatch");
			sourceLease = acquireCheckpointLease(
				existingIntent.value.source.checkpointPath,
				existingIntent.value.source.owner,
			);
			const sourceStats = lstatSync(existingIntent.value.source.checkpointPath);
			if (!sourceStats.isFile() || sourceStats.isSymbolicLink())
				return refusal("source_checkpoint_not_regular");
			const sourceRaw = readFileSync(
				existingIntent.value.source.checkpointPath,
				"utf8",
			);
			assertReconciliationSourceLease(sourceLease);
			if (hashBytes(sourceRaw) !== existingIntent.value.source.rawSha256)
				return refusal("source_checkpoint_changed");
			let source;
			try {
				source = JSON.parse(sourceRaw);
			} catch {
				return refusal("source_checkpoint_malformed");
			}
			const sourceOwnerMatchesIntent =
				stableStringify(source.owner) ===
				stableStringify(existingIntent.value.source.owner);
			if (
				!sourceOwnerMatchesIntent ||
				source.revision !== existingIntent.value.source.revision ||
				source.tasksFilePath !== existingIntent.value.source.tasksFilePath
			)
				return refusal("source_identity_mismatch");
			return await replayReconciliationIntent(
				existingIntent.value,
				intentPath,
				input,
				sourceLease,
			);
		} catch (error) {
			if (error?.message?.startsWith("injected reconciliation crash"))
				throw error;
			if (error?.message?.includes("checkpoint lease unavailable"))
				return refusal("source_checkpoint_lock_unavailable");
			if (error?.message?.includes("checkpoint lease displaced"))
				return refusal("source_checkpoint_lock_displaced");
			return refusal("reconciliation_intent_malformed");
		} finally {
			if (sourceLease) {
				try {
					releaseCheckpointLease(sourceLease);
				} catch {
					console.error(
						"switchyard: source checkpoint lease release failed during intent replay",
					);
				}
			}
		}
	}
	const receipt = readBoundedReceipt(input.receiptPath);
	if (receipt.error) return refusal(receipt.error);
	const inputHasNextRunOptions = Object.hasOwn(input, "nextRunOptions");
	const effectiveInput = {
		...receipt.value,
		...input,
	};
	const invalid = validateExternalCompletionInput(effectiveInput);
	if (invalid) return invalid;
	if (
		receipt.value?.version !== EXTERNAL_COMPLETION_VERSION ||
		receipt.value?.kind !== "external_completion" ||
		receipt.value.taskId !== effectiveInput.taskId ||
		receipt.value.attempt !== effectiveInput.attempt ||
		receipt.value.sourceRevision !== effectiveInput.sourceRevision ||
		stableStringify(receipt.value.sourceOwner) !==
			stableStringify(effectiveInput.sourceOwner) ||
		receipt.value.contractHash !== effectiveInput.contractHash ||
		receipt.value.integratedCommit !== effectiveInput.integratedCommit ||
		stableStringify(sortedUnique(receipt.value.changedPaths)) !==
			stableStringify(sortedUnique(effectiveInput.changedPaths)) ||
		stableStringify(sortedUnique(receipt.value.requiredPaths)) !==
			stableStringify(sortedUnique(effectiveInput.requiredPaths)) ||
		stableStringify(
			sortedUnique(receipt.value.resolvedExternalBlockers ?? []),
		) !==
			stableStringify(
				sortedUnique(effectiveInput.resolvedExternalBlockers ?? []),
			) ||
		(receipt.value.runStorePath !== undefined &&
			(!validAbsolutePath(receipt.value.runStorePath) ||
				resolve(receipt.value.runStorePath) !==
					reconciliationRunStorePath(effectiveInput))) ||
		(effectiveInput.runStorePath !== undefined &&
			(!validAbsolutePath(effectiveInput.runStorePath) ||
				resolve(effectiveInput.runStorePath) !==
					reconciliationRunStorePath(effectiveInput))) ||
		receipt.value.cleanup?.status !== "complete" ||
		(receipt.value.cleanup?.taskBaseReleased !== undefined &&
			receipt.value.cleanup.taskBaseReleased !== true) ||
		(receipt.value.cleanup?.projectLockReleased !== undefined &&
			receipt.value.cleanup.projectLockReleased !== true) ||
		receipt.value.providerSuccess !== false
	)
		return refusal("receipt_contract_mismatch");
	try {
		if (
			stableStringify(
				normalizeReconciliationRunOptions({
					...effectiveInput,
					nextRunOptions: receipt.value.nextRunOptions,
				}),
			) !==
			(inputHasNextRunOptions
				? stableStringify(normalizeReconciliationRunOptions(input))
				: stableStringify(normalizeReconciliationRunOptions(effectiveInput)))
		)
			return refusal("receipt_contract_mismatch");
	} catch {
		return refusal("receipt_contract_mismatch");
	}
	input = effectiveInput;
	let sourceRaw;
	try {
		const sourceStats = lstatSync(input.sourceCheckpointPath);
		if (!sourceStats.isFile() || sourceStats.isSymbolicLink())
			return refusal("source_checkpoint_not_regular");
		sourceRaw = readFileSync(input.sourceCheckpointPath, "utf8");
	} catch {
		return refusal("source_checkpoint_missing");
	}
	let sourceLease;
	try {
		sourceLease = acquireCheckpointLease(
			input.sourceCheckpointPath,
			input.sourceOwner,
		);
	} catch {
		return refusal("source_checkpoint_lock_unavailable");
	}
	let intentPrepared = false;
	try {
		let source;
		try {
			source = JSON.parse(sourceRaw);
		} catch {
			return refusal("source_checkpoint_malformed");
		}
		if (readFileSync(input.sourceCheckpointPath, "utf8") !== sourceRaw)
			return refusal("source_checkpoint_changed");
		if (
			stableStringify(source.owner) !== stableStringify(input.sourceOwner) ||
			source.revision !== input.sourceRevision ||
			typeof source.ownershipReleased !== "boolean"
		)
			return refusal("source_identity_mismatch");
		if (
			typeof source.tasksFilePath !== "string" ||
			resolve(source.tasksFilePath) !== resolve(input.tasksFilePath)
		)
			return refusal("source_tasks_path_mismatch");
		try {
			validateCheckpointTaskBases(source);
			validateRetryDescriptorEvidence(source);
			validateCheckpointV3(
				source,
				source.tasksFilePath,
				{ checkpointOwner: input.sourceOwner },
				input.sourceCheckpointPath,
			);
		} catch {
			return refusal("source_checkpoint_malformed");
		}
		if (source.taskAttempts?.[input.taskId] !== input.attempt)
			return refusal("attempt_identity_mismatch");
		if ((source.completedTaskIds ?? []).includes(input.taskId))
			return refusal("task_already_completed");
		if (
			source.integrationIntents?.[input.taskId]?.status !== undefined &&
			source.integrationIntents[input.taskId]?.status !== "completed"
		)
			return refusal("integration_intent_unresolved");
		if (source.taskBases?.[input.taskId] !== undefined)
			return refusal("task_base_not_released");
		if (
			source.taskBaseReleaseUncertain &&
			(typeof source.taskBaseReleaseUncertain !== "object" ||
				source.taskBaseReleaseUncertain.taskId === input.taskId ||
				typeof source.taskBaseReleaseUncertain.taskId !== "string")
		)
			return refusal("task_base_release_uncertain");
		if (
			source.providerCleanupUncertain &&
			(typeof source.providerCleanupUncertain !== "object" ||
				source.providerCleanupUncertain.taskId === input.taskId ||
				typeof source.providerCleanupUncertain.taskId !== "string")
		)
			return refusal("provider_cleanup_uncertain");
		if (
			source.retryState &&
			(typeof source.retryState !== "object" ||
				source.retryState.taskId === input.taskId ||
				typeof source.retryState.taskId !== "string")
		)
			return refusal("retry_state_unresolved");
		if (sourceTaskRetry(source, input.taskId))
			return refusal("retry_state_unresolved");
		const allocations = sourceTaskAllocation(source, input.taskId);
		if (allocations.some((entry) => entry?.state !== "result_recorded"))
			return refusal("provider_allocation_unresolved");
		try {
			if (
				await isProjectLockOwnedBy(
					resolve(input.projectPath),
					input.sourceOwner.runId,
				)
			)
				return refusal("project_lock_still_owned");
		} catch {
			return refusal("project_lock_state_unknown");
		}
		const markdown = readFileSync(input.tasksFilePath, "utf8");
		const taskBytes = taskContractBytes(markdown, input.taskId);
		if (!taskBytes) return refusal("unknown_task");
		if (hashBytes(taskBytes) !== input.contractHash)
			return refusal("contract_hash_mismatch");
		if (
			source.taskContracts?.[input.taskId] !== undefined &&
			source.taskContracts[input.taskId] !== input.contractHash
		)
			return refusal("contract_hash_mismatch");
		const tasks = parseTaskQueue(markdown);
		const task = tasks.find((candidate) => candidate.id === input.taskId);
		if (!task) return refusal("unknown_task");
		if (
			!Array.isArray(task.requiredPaths) ||
			!validateExactPathSet(task.requiredPaths, input.requiredPaths).ok
		)
			return refusal("path_scope_mismatch");
		if (
			(input.resolvedExternalBlockers ?? []).some(
				(blocker) => !(task.externalBlockers ?? []).includes(blocker),
			)
		)
			return refusal("external_blocker_not_declared");
		const ancestry = validateIntegratedCommitAncestry(
			input.projectPath,
			input.integratedCommit,
		);
		if (!ancestry.ok) return refusal(ancestry.reasonCode);
		const commitPaths = validateIntegratedCommitPaths(
			input.projectPath,
			input.integratedCommit,
			input.changedPaths,
		);
		if (!commitPaths.ok) return refusal(commitPaths.reasonCode);
		if (!validateExactPathSet(input.changedPaths, input.requiredPaths).ok)
			return refusal("path_scope_mismatch");
		const overlap = validateNoTrackedPathOverlap(
			input.projectPath,
			input.changedPaths,
		);
		if (!overlap.ok) return refusal(overlap.reasonCode);
		const options = normalizeReconciliationRunOptions(input);
		const queueIdentity = createQueueIdentity({
			tasksFilePath: input.tasksFilePath,
			markdown,
			tasks,
			projectRevision: ancestry.currentHead,
			runOptions: options,
		});
		const reconciliationId = hashBytes(
			stableStringify({
				version: RECONCILIATION_INTENT_VERSION,
				taskId: input.taskId,
				attempt: input.attempt,
				sourceCheckpointPath: resolve(input.sourceCheckpointPath),
				sourceRevision: input.sourceRevision,
				sourceOwner: input.sourceOwner,
				contractHash: input.contractHash,
				receiptPath: resolve(input.receiptPath),
				integratedCommit: input.integratedCommit,
				changedPaths: sortedUnique(input.changedPaths),
				requiredPaths: sortedUnique(input.requiredPaths),
				resolvedExternalBlockers: sortedUnique(
					input.resolvedExternalBlockers ?? [],
				),
				queueIdentity,
				runOptions: options,
				runStorePath: reconciliationRunStorePath(input),
			}),
		);
		if (input.reconciliationId && input.reconciliationId !== reconciliationId)
			return refusal("reconciliation_id_mismatch");
		const existingSuccessor = readSuccessorRecord(
			input.successorCheckpointPath,
		);
		if (existingSuccessor.error) return refusal(existingSuccessor.error);
		if (existingSuccessor.exists) {
			const completion = existingSuccessor.value?.externalCompletion;
			const identityMatches =
				completion?.version === EXTERNAL_COMPLETION_VERSION &&
				completion.reconciliationId === reconciliationId &&
				completion.sourceCheckpointPath ===
					resolve(input.sourceCheckpointPath) &&
				completion.sourceRevision === input.sourceRevision &&
				completion.attempt === input.attempt &&
				stableStringify(completion.sourceOwner) ===
					stableStringify(input.sourceOwner) &&
				completion.integratedCommit === input.integratedCommit &&
				completion.contractHash === input.contractHash &&
				stableStringify(completion.changedPaths) ===
					stableStringify(sortedUnique(input.changedPaths)) &&
				stableStringify(completion.requiredPaths) ===
					stableStringify(sortedUnique(input.requiredPaths)) &&
				stableStringify(completion.resolvedExternalBlockers ?? []) ===
					stableStringify(sortedUnique(input.resolvedExternalBlockers ?? [])) &&
				completion.providerSuccess === false &&
				existingSuccessor.value.queueIdentity === queueIdentity;
			if (!identityMatches) return refusal("successor_checkpoint_conflict");
			let ledger;
			try {
				ledger = await readLedgerFromStore(reconciliationRunStorePath(input));
			} catch {
				return refusal("ledger_state_unknown");
			}
			const recorded = ledger.find(
				(entry) =>
					entry?.recordType === "external_completion" &&
					entry.reconciliationId === reconciliationId,
			);
			if (!recorded) return refusal("successor_without_ledger");
			if (
				recorded.taskId !== input.taskId ||
				recorded.attempt !== input.attempt ||
				recorded.sourceRevision !== input.sourceRevision ||
				recorded.integratedCommit !== input.integratedCommit ||
				recorded.contractHash !== input.contractHash ||
				recorded.providerSuccess !== false ||
				recorded.result !== "external_completion_recorded"
			)
				return refusal("ledger_reconciliation_mismatch");
			return {
				recorded: true,
				status: "already-recorded",
				result: "external_completion_recorded",
				reconciliationId,
				successorCheckpointPath: resolve(input.successorCheckpointPath),
				providerSuccess: false,
			};
		}
		const successor = buildSuccessorCheckpoint(
			source,
			input,
			queueIdentity,
			options,
			reconciliationId,
		);
		const ledgerFields = {
			reconciliationId,
			taskId: input.taskId,
			attempt: input.attempt,
			sourceRevision: input.sourceRevision,
			integratedCommit: input.integratedCommit,
			contractHash: input.contractHash,
		};
		const intent = {
			version: RECONCILIATION_INTENT_VERSION,
			state: "prepared",
			reconciliationId,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			source: {
				checkpointPath: resolve(input.sourceCheckpointPath),
				owner: structuredClone(input.sourceOwner),
				revision: input.sourceRevision,
				taskId: input.taskId,
				attempt: input.attempt,
				tasksFilePath: resolve(input.tasksFilePath),
				rawSha256: hashBytes(sourceRaw),
			},
			immutable: {
				projectPath: resolve(input.projectPath),
				receiptPath: resolve(input.receiptPath),
				contractHash: input.contractHash,
				integratedCommit: input.integratedCommit,
				currentHead: ancestry.currentHead,
				changedPaths: sortedUnique(input.changedPaths),
				requiredPaths: sortedUnique(input.requiredPaths),
				queueIdentity,
				runOptions: options,
				runStorePath: reconciliationRunStorePath(input),
				resolvedExternalBlockers: sortedUnique(
					input.resolvedExternalBlockers ?? [],
				),
			},
			successor: {
				checkpointPath: resolve(input.successorCheckpointPath),
				checkpoint: successor,
			},
			ledger: {
				runStorePath: reconciliationRunStorePath(input),
				fields: ledgerFields,
			},
		};
		if (
			readFileSync(input.sourceCheckpointPath, "utf8") !== sourceRaw ||
			readFileSync(sourceLease.lockPath, "utf8") !== sourceLease.body
		)
			return refusal("source_checkpoint_lock_displaced");
		if (input.__testFault === "before_intent")
			throw new Error("injected reconciliation crash before intent");
		writeIntent(intentPath, intent);
		intentPrepared = true;
		if (input.__testFault === "after_intent")
			throw new Error("injected reconciliation crash after intent");
		return await replayReconciliationIntent(
			intent,
			intentPath,
			input,
			sourceLease,
		);
	} catch (error) {
		if (error?.code === "RECONCILIATION_LEDGER_MISMATCH")
			return refusal("ledger_reconciliation_mismatch");
		if (error?.code === "EEXIST")
			return refusal("successor_checkpoint_conflict");
		if (error?.message?.startsWith("injected reconciliation crash"))
			throw error;
		return refusal(
			"reconciliation_persistence_failed",
			error?.code ?? "unknown",
		);
	} finally {
		if (sourceLease) {
			try {
				releaseCheckpointLease(sourceLease);
			} catch {
				console.error(
					intentPrepared
						? "switchyard: source checkpoint lease release failed; durable reconciliation intent retained"
						: "switchyard: source checkpoint lease release failed",
				);
			}
		}
	}
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

/**
 * Read the classification of an in-flight queue failure, if it carries one.
 *
 * Only an allowlisted diagnostic code crosses this boundary. The error object
 * itself never does: its message may hold host paths or provider-controlled
 * text, and `PERSISTED_DIAGNOSTIC_CODES` is a closed vocabulary of codes this
 * project mints itself.
 * @param {unknown} error
 * @returns {string|null}
 */
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

/**
 * Closed signal that an owned async queue workspace could not be torn down.
 * The backend error is deliberately not retained: it may contain host paths or
 * provider-controlled text, while detached finalization needs only the fixed
 * recovery disposition and queue summary.
 *
 * When teardown fails while another failure is already in flight, this error
 * replaces it -- cleanup must win so no caller finalizes success over a leaked
 * workspace. Replacing the exception must not erase why the run failed, so the
 * in-flight failure's diagnostic code is carried through when it is one of ours;
 * `code` and the `recovery_incomplete` reason stay fixed, so the disposition
 * still reads `stop` / recovery required and only the reported cause sharpens.
 */
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
		this.terminalSummary = {
			totalTasks: queueResult?.totalTasks ?? null,
			runnableTasks: queueResult?.runnableTasks ?? null,
			processedTasks: queueResult?.processedTasks ?? null,
			completedTaskIds: Array.isArray(queueResult?.completedTaskIds)
				? [...queueResult.completedTaskIds]
				: null,
			deferredTaskIds: Array.isArray(queueResult?.deferredTaskIds)
				? [...queueResult.deferredTaskIds]
				: null,
			failedCount: Array.isArray(queueResult?.results)
				? queueResult.results.filter((result) => !result.success).length
				: null,
		};
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

		const allowManifestsLines = block
			.split("\n")
			.filter((line) => /^- \*\*AllowManifests:\*\*(?:\s|$)/.test(line));
		let allowManifests = false;
		if (allowManifestsLines.length > 0) {
			if (type !== "implementation") {
				throw new Error(
					`Task ${taskId}: AllowManifests is only supported for implementation-type tasks`,
				);
			}
			if (allowManifestsLines.length > 1) {
				throw new Error(
					`Task ${taskId}: duplicate AllowManifests declarations are not allowed`,
				);
			}
			const value = allowManifestsLines[0]
				.replace(/^- \*\*AllowManifests:\*\*\s*/, "")
				.trim();
			if (value === "true") {
				allowManifests = true;
			} else if (value === "false") {
				allowManifests = false;
			} else {
				throw new Error(
					`Task ${taskId}: AllowManifests must be true or false when present`,
				);
			}
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
 * Remove one matching Markdown inline-code wrapper from a Files entry.
 * Wrapped and bare entries share the same path validation below; malformed
 * wrappers fail closed instead of becoming part of the allowlist path.
 * @param {string} token A trimmed, comma-separated Files entry
 * @param {string} taskId Task identifier for error messages
 * @returns {string} The unwrapped path token
 * @throws {Error} If the token contains an unmatched or nested delimiter
 */
function unwrapFilesInlineCode(token, taskId) {
	if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) {
		const inner = token.slice(1, -1);
		if (inner.includes("`")) {
			throw new Error(
				`Task ${taskId}: malformed inline-code wrapper in Files: "${token}"`,
			);
		}
		return inner.trim();
	}
	if (token.includes("`")) {
		throw new Error(
			`Task ${taskId}: unmatched inline-code delimiter in Files: "${token}"`,
		);
	}
	return token;
}

/**
 * Parse and validate a comma-separated Files: field into an array of paths.
 * Each entry may wrap an otherwise valid project-relative path in one matching
 * pair of Markdown inline-code delimiters.
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

	const paths = trimmed
		.split(",")
		.map((entry) => unwrapFilesInlineCode(entry.trim(), taskId));

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
		if (path.split("/").some((component) => component === "")) {
			throw new Error(
				`Task ${taskId}: empty path component in Files: "${path}"`,
			);
		}
		if (path.split("/").some((component) => component === ".")) {
			throw new Error(
				`Task ${taskId}: dot path component not allowed in Files: "${path}"`,
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

export function validateProjectFileEntries(tasks, projectPath) {
	const root = resolve(projectPath);
	for (const task of tasks) {
		for (const relativePath of task.requiredPaths ?? []) {
			const candidate = resolve(root, relativePath);
			const containment = relative(root, candidate);
			if (
				containment === ".." ||
				containment.startsWith(`..${sep}`) ||
				isAbsolute(containment)
			) {
				const error = new Error(
					`Task ${task.id}: Files path escapes project root: "${relativePath}"`,
				);
				error.code = "queue_contract_invalid";
				throw error;
			}
			const components = relative(root, candidate).split(sep);
			let prefix = root;
			for (const component of components.slice(0, -1)) {
				prefix = join(prefix, component);
				try {
					if (lstatSync(prefix).isSymbolicLink()) {
						const error = new Error(
							`Task ${task.id}: Files entry must not traverse a symlink directory: "${relativePath}"`,
						);
						error.code = "queue_contract_invalid";
						throw error;
					}
				} catch (error) {
					if (error?.code === "ENOENT") break;
					throw error;
				}
			}
			try {
				const stat = lstatSync(candidate);
				if (stat.isDirectory() || stat.isSymbolicLink()) {
					const error = new Error(
						`Task ${task.id}: Files entry must name a regular file, not a directory or symlink: "${relativePath}"`,
					);
					error.code = "queue_contract_invalid";
					throw error;
				}
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				throw error;
			}
		}
	}
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
		version: CHECKPOINT_VERSION,
		revision: 0,
		owner:
			identity.checkpointOwner ??
			createFencingIdentity(identity.queueIdentity ?? "direct"),
		ownershipReleased: false,
		tasksFilePath,
		completedTaskIds: [],
		lastTaskId: null,
		lastUpdatedAt: null,
		results: [],
		taskBases: {},
		taskAttempts: {},
		integrationIntents: {},
	};
	if (identity.queueIdentity) {
		checkpoint.queueIdentity = identity.queueIdentity;
		checkpoint.runOptions = identity.runOptions ?? null;
	}
	return checkpoint;
}

function checkpointOwnerFor(checkpointPath, runId, suppliedOwner) {
	if (suppliedOwner) return suppliedOwner;
	const effectiveRunId = runId ?? "direct";
	let cached = checkpointOwners.get(checkpointPath);
	if (!cached || cached.runId !== effectiveRunId) {
		cached = {
			runId: effectiveRunId,
			owner: createFencingIdentity(effectiveRunId),
		};
		checkpointOwners.set(checkpointPath, cached);
	}
	return cached.owner;
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
export function saveCheckpoint(checkpointPath, checkpoint, options = {}) {
	if (checkpoint?.version !== CHECKPOINT_VERSION)
		throw new Error("legacy checkpoint requires explicit v3 migration");
	if (!Number.isInteger(checkpoint.revision) || checkpoint.revision < 0) {
		throw new Error("checkpoint revision is invalid");
	}
	if (!isCheckpointOwner(checkpoint.owner)) {
		throw new Error("checkpoint owner is invalid");
	}
	mkdirSync(dirname(checkpointPath), { recursive: true });
	const lease =
		options.lease ?? acquireCheckpointLease(checkpointPath, checkpoint.owner);
	const ownsLease = options.lease === undefined;
	try {
		assertCheckpointLease(lease, checkpointPath, checkpoint.owner);
		let disk = null;
		let diskRaw = null;
		if (existsSync(checkpointPath)) {
			try {
				diskRaw = readFileSync(checkpointPath, "utf8");
				disk = JSON.parse(diskRaw);
			} catch {
				throw new Error("checkpoint disk record is corrupt");
			}
			if (disk?.version !== CHECKPOINT_VERSION)
				throw new Error("legacy checkpoint requires explicit v3 migration");
			if (!sameCheckpointOwner(disk.owner, checkpoint.owner))
				throw new Error("checkpoint owner displaced");
			if (disk.ownershipReleased)
				throw new Error("checkpoint ownership was released");
		}
		const expectedRevision = options.expectedRevision ?? checkpoint.revision;
		const diskRevision = disk?.revision ?? 0;
		if (
			diskRevision !== expectedRevision ||
			checkpoint.revision !== expectedRevision
		)
			throw new Error(
				`checkpoint revision mismatch: expected ${expectedRevision}, disk ${diskRevision}`,
			);
		const published = structuredClone(checkpoint);
		published.revision = diskRevision + 1;
		const tmpPath = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(published, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		try {
			options.beforePublish?.({ lease, tmpPath });
			assertCheckpointLease(lease, checkpointPath, checkpoint.owner);
			const currentRaw = existsSync(checkpointPath)
				? readFileSync(checkpointPath, "utf8")
				: null;
			if (currentRaw !== diskRaw)
				throw new Error("checkpoint revision changed before publication");
			renameSync(tmpPath, checkpointPath);
		} catch (error) {
			try {
				unlinkSync(tmpPath);
			} catch {}
			throw error;
		}
		checkpoint.revision = published.revision;
	} finally {
		if (ownsLease) releaseCheckpointLease(lease);
	}
}

function checkpointLockPath(checkpointPath) {
	return `${checkpointPath}.lock`;
}

function sameCheckpointOwner(left, right) {
	return (
		left?.runId === right?.runId &&
		left?.processStartIdentity === right?.processStartIdentity &&
		left?.nonce === right?.nonce
	);
}

/** Acquire a cooperative exclusive checkpoint lease. Existing or malformed
 * lease files fail closed; their age and PID are never treated as liveness. */
export function acquireCheckpointLease(checkpointPath, owner) {
	if (!isCheckpointOwner(owner)) throw new Error("checkpoint owner is invalid");
	mkdirSync(dirname(checkpointPath), { recursive: true });
	const lockPath = checkpointLockPath(checkpointPath);
	const nonce = randomUUID();
	const body = JSON.stringify({ owner, nonce });
	let fd;
	try {
		fd = openSync(lockPath, "wx", 0o600);
		writeFileSync(fd, body, "utf8");
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		throw new Error(
			`checkpoint lease unavailable: ${error.code ?? error.message}`,
		);
	}
	closeSync(fd);
	return {
		checkpointPath,
		lockPath,
		owner: structuredClone(owner),
		nonce,
		body,
	};
}

function assertCheckpointLease(lease, checkpointPath, owner) {
	if (
		lease?.checkpointPath !== checkpointPath ||
		!sameCheckpointOwner(lease.owner, owner) ||
		readFileSync(lease.lockPath, "utf8") !== lease.body
	)
		throw new Error("checkpoint lease displaced");
}

export function releaseCheckpointLease(lease) {
	assertCheckpointLease(lease, lease.checkpointPath, lease.owner);
	unlinkSync(lease.lockPath);
}

function isCheckpointOwner(owner) {
	return (
		owner &&
		typeof owner === "object" &&
		typeof owner.runId === "string" &&
		owner.runId.length > 0 &&
		typeof owner.processStartIdentity === "string" &&
		owner.processStartIdentity.length > 0 &&
		typeof owner.nonce === "string" &&
		owner.nonce.length > 0
	);
}

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
					!["quota_fallback", "completion_correction"].includes(entry.reason) ||
					!["allocated", "running", "result_recorded"].includes(entry.state) ||
					(entry.reason === "completion_correction" &&
						(typeof entry.deadline !== "string" ||
							!Number.isFinite(Date.parse(entry.deadline)) ||
							typeof entry.descriptorIdentity !== "string" ||
							!entry.descriptorIdentity ||
							typeof entry.workspaceId !== "string" ||
							!entry.workspaceId ||
							typeof entry.baseTree !== "string" ||
							!/^[a-f0-9]{40,64}$/.test(entry.baseTree) ||
							typeof entry.attemptId !== "string" ||
							!entry.attemptId)),
			))
	) {
		throw new Error("checkpoint v3 has invalid provider attempt allocations");
	}
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

function validateCheckpointTaskBases(parsed) {
	if (
		!parsed.taskBases ||
		typeof parsed.taskBases !== "object" ||
		Array.isArray(parsed.taskBases)
	)
		throw new Error("checkpoint has invalid taskBases");
	for (const [taskId, base] of Object.entries(parsed.taskBases)) {
		const helper = base?.cleanupContext;
		if (
			typeof base?.ref !== "string" ||
			!base.ref ||
			typeof base?.tree !== "string" ||
			!/^[a-f0-9]{40,64}$/.test(base.tree) ||
			helper?.operation !== "helper" ||
			helper.taskId !== taskId ||
			![
				"runId",
				"taskId",
				"attemptId",
				"descriptorIdentity",
				"workspaceId",
			].every(
				(field) =>
					typeof helper[field] === "string" && helper[field].length > 0,
			) ||
			(helper.processStartIdentity !== null &&
				typeof helper.processStartIdentity !== "string") ||
			(base.dirtyOverlayReceiptHash != null &&
				!/^[a-f0-9]{64}$/u.test(base.dirtyOverlayReceiptHash))
		)
			throw new Error("checkpoint has invalid persisted task base");
	}
}

/** Explicitly migrate a legacy checkpoint that the caller has independently
 * proven never had a pending host application. Potentially-started records are
 * left byte-for-byte unchanged. */
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

function checkpointCanRelease(checkpoint) {
	return (
		checkpoint.retryState == null &&
		Object.keys(checkpoint.taskBases ?? {}).length === 0 &&
		Object.values(checkpoint.integrationIntents ?? {}).every(
			(intent) => intent.status === "completed",
		)
	);
}

export function releaseCheckpointOwnership(checkpointPath, checkpoint) {
	if (!checkpointCanRelease(checkpoint)) {
		saveCheckpoint(checkpointPath, checkpoint);
		return false;
	}
	checkpoint.ownershipReleased = true;
	try {
		saveCheckpoint(checkpointPath, checkpoint);
		return true;
	} catch (error) {
		checkpoint.ownershipReleased = false;
		throw error;
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
function reserveTaskAttempt(checkpoint, checkpointPath, taskId) {
	checkpoint.taskAttempts ??= {};
	const prior = checkpoint.taskAttempts[taskId];
	const integrationAttempt =
		checkpoint.integrationIntents?.[taskId]?.operation?.attempt;
	// The integration gate durably reserves its attempt before it mutates the
	// host tree. A result recorded after that gate belongs to the same attempt;
	// incrementing here would make the checkpoint fail its own intent/attempt
	// identity validation on resume.
	if (
		Number.isSafeInteger(integrationAttempt) &&
		integrationAttempt > 0 &&
		prior === integrationAttempt
	) {
		return integrationAttempt;
	}
	const attempt = Number.isSafeInteger(prior) && prior > 0 ? prior + 1 : 1;
	checkpoint.taskAttempts[taskId] = attempt;
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
	return attempt;
}

function taskArtifactFilename(taskId, attempt, extension) {
	// Every new artifact carries an explicit attempt. Retention still reads the
	// historical first-attempt form conservatively, but new evidence must never
	// become ambiguous after a retry.
	return `${taskId}.attempt-${attempt}.${extension}`;
}

function prepareArtifactDirectory(dir) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let fd;
	try {
		fd = openSync(
			dir,
			fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
		);
		const ownerUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		let stats = fstatSync(fd);
		if (!stats.isDirectory() || (ownerUid !== null && stats.uid !== ownerUid))
			throw new Error("partial-diffs directory is not owner-owned");
		if ((stats.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
		stats = fstatSync(fd);
		if (
			!stats.isDirectory() ||
			(ownerUid !== null && stats.uid !== ownerUid) ||
			(stats.mode & 0o7777) !== 0o700
		)
			throw new Error("partial-diffs directory is not safely private");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeArtifactFile(artifactPath, text) {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length > CHECKPOINT_ARTIFACT_MAX_FILE_BYTES)
		throw new Error("partial-diffs artifact is too large");
	let fd;
	try {
		fd = openSync(
			artifactPath,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW,
			0o600,
		);
		const ownerUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		let stats = fstatSync(fd);
		if (
			!stats.isFile() ||
			stats.nlink !== 1 ||
			(ownerUid !== null && stats.uid !== ownerUid)
		)
			throw new Error("partial-diffs artifact is not private regular data");
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset);
			if (written <= 0) throw new Error("partial-diffs artifact write stalled");
			offset += written;
		}
		fchmodSync(fd, 0o600);
		fsyncSync(fd);
		stats = fstatSync(fd);
		if (
			!stats.isFile() ||
			stats.nlink !== 1 ||
			(ownerUid !== null && stats.uid !== ownerUid) ||
			stats.size !== bytes.length ||
			(stats.mode & 0o7777) !== 0o600
		)
			throw new Error("partial-diffs artifact verification failed");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function savePartialDiff(checkpointPath, taskId, diffText, attempt = 1) {
	const dir = `${checkpointPath}.partial-diffs`;
	prepareArtifactDirectory(dir);
	const artifactPath = join(dir, taskArtifactFilename(taskId, attempt, "diff"));
	writeArtifactFile(artifactPath, diffText);
	return artifactPath;
}

/**
 * Provider output is never durable gate evidence. Closed diagnostic codes and
 * patch artifacts with an active reconciliation purpose are sufficient.
 *
 * @param {unknown} output raw provider stdout
 * @returns {string|null} bounded transcript, or null when there is none
 */
function boundedGateEvidence(_output) {
	return null;
}

function saveGateEvidence(checkpointPath, taskId, text, attempt = 1) {
	const dir = `${checkpointPath}.partial-diffs`;
	prepareArtifactDirectory(dir);
	const artifactPath = join(
		dir,
		taskArtifactFilename(taskId, attempt, "output"),
	);
	writeArtifactFile(artifactPath, text);
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

/**
 * Select the next queue task using the same retry-first transition as the
 * execution loops. This is pure: callers own the returned state.
 */
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

/**
 * Plan the bounded set of tasks that could consume provider attempts before
 * queue admission. This mirrors the execution transition without invoking
 * hooks, routing, providers, or lifecycle code: retry state wins once, then
 * the first runnable task wins, and a hypothetical success unblocks the next
 * task in queue order.
 * @param {Array} tasks parsed queue tasks
 * @param {object} checkpoint current checkpoint
 * @param {object} [options]
 * @param {Iterable<string>} [options.selectedTaskIds]
 * @param {number} [options.maxTasks]
 * @returns {Array<object>} hypothetical attempt tasks, in execution order
 */
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
 * standard lane only as a compatibility default for legacy records. Newly
 * authored queues declare the field explicitly; runtime never infers it from
 * task prose or silently escalates it to high.
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

/**
 * Identify any declared task path that Git ignores and that therefore cannot
 * be seeded from or captured back into the committed project tree.
 * @param {string[]|string|null|undefined} paths
 * @param {string} [projectPath]
 * @returns {string|null} The first ignored path encountered, or null
 */
export function findIgnoredDeclaredPath(paths, projectPath = process.cwd()) {
	if (!paths) return null;
	const rawList = Array.isArray(paths)
		? paths
		: typeof paths === "string"
			? [paths]
			: null;
	if (!rawList) return null;
	const pathList = rawList
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter(Boolean);
	if (pathList.length === 0) return null;
	try {
		const workingDir =
			projectPath && existsSync(projectPath) ? projectPath : process.cwd();
		const result = spawnSync("git", ["check-ignore", "--", ...pathList], {
			cwd: workingDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status === 0 && result.stdout) {
			const ignored = result.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			return ignored[0] ?? null;
		}
		return null;
	} catch {
		return null;
	}
}

function declaredPathNotSeededResult(task, requiredCapability) {
	const failure = sanitizeFailureMetadata({
		taskId: task.id,
		result: "declared_path_not_seeded",
		errorKind: "declared_path_not_seeded",
	});
	return {
		taskId: task.id,
		success: false,
		provider: null,
		model: null,
		requiredCapability,
		result: "declared_path_not_seeded",
		...(failure ?? {}),
	};
}

function dirtyOverlayResult(task, context, requiredCapability) {
	if (!context.dirtyOverlayReceipt) return null;
	const checked = validateDirtyOverlayReceipt(
		context.projectPath,
		context.dirtyOverlayReceipt,
	);
	const receiptPaths = new Set(
		context.dirtyOverlayReceipt.paths?.map((entry) => entry.path) ?? [],
	);
	// An empty `requiredPaths` passes `.every()` vacuously, which would admit a
	// task that declared nothing into a workspace seeded with overlay bytes.
	// Every task in an overlay queue declares its own scope or is refused.
	const requiredPaths = task.requiredPaths ?? [];
	if (
		checked.ok &&
		requiredPaths.length > 0 &&
		requiredPaths.every((path) => receiptPaths.has(path))
	)
		return null;
	const reason = checked.ok ? "dirty_overlay_scope_mismatch" : checked.reason;
	context.onStatus?.({
		phase: "preflight",
		event: "dirty_overlay_rejected",
		status: "Dirty overlay rejected before provider allocation",
		taskId: task.id,
		reasonCode: reason,
	});
	return {
		taskId: task.id,
		success: false,
		provider: null,
		model: null,
		requiredCapability,
		result: "dirty_overlay_rejected",
		errorKind: "queue_contract",
		reasonCode: reason,
		dirtyOverlayReceiptHash: context.dirtyOverlayReceipt.receiptHash,
	};
}

function decorateDirtyOverlayResult(result, context) {
	if (context?.dirtyOverlayReceipt && result && typeof result === "object") {
		result.dirtyOverlayReceiptHash = context.dirtyOverlayReceipt.receiptHash;
	}
	return result;
}

function dirtyOverlayIntegrationGate(context) {
	if (!context.dirtyOverlayReceipt) return null;
	const checked = validateDirtyOverlayReceipt(
		context.projectPath,
		context.dirtyOverlayReceipt,
	);
	if (checked.ok) return null;
	context.onStatus?.({
		phase: "integration",
		event: "dirty_overlay_rejected",
		status: "Dirty overlay drifted before integration",
		reasonCode: checked.reason,
	});
	return {
		success: false,
		message: "Dirty overlay changed before integration",
		reason: "dirty_overlay_drift",
		reasonKind: "dirty_overlay_drift",
	};
}

function failureMetadataFor(result, partialDiffPath) {
	return sanitizeFailureMetadata({
		taskId: result.taskId,
		result: result.result,
		errorKind: result.errorKind,
		timedOut: result.timedOut,
		partialDiffPath,
		gateEvidencePath: result.gateEvidencePath,
		diagnosticCode: result.diagnosticCode,
		exitCode: result.exitCode,
		signal: result.signal,
		failurePhase: result.failurePhase,
		cleanupStage: result.cleanupStage,
		diagnosticOrigin: result.diagnosticOrigin,
		diagnosticEvidenceAvailable: result.diagnosticEvidenceAvailable,
		resolvedTargetId: result.resolvedTargetId,
		descriptorIdentity: result.descriptorIdentity,
		descriptorHarness: result.descriptorHarness,
		diagnosticRef: result.diagnosticRef,
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

function hasTrustedQuotaRetryEvidence(value) {
	if (
		value?.diagnosticCode !== "quota_exhausted" ||
		value.diagnosticOrigin !== "adapter" ||
		value.diagnosticEvidenceAvailable !== true ||
		!DIAGNOSTIC_REF_RE.test(value.diagnosticRef ?? "") ||
		value.failurePhase !== "provider_execution"
	) {
		return false;
	}
	const targetId = normalizeRetryTargetId(value.resolvedTargetId);
	if (!targetId) return false;
	try {
		const descriptor = validateInvocationDescriptor(
			value.invocationDescriptor,
			value.descriptorHarness,
		);
		return (
			descriptor.target_id === targetId &&
			descriptor.descriptor_identity === value.descriptorIdentity
		);
	} catch {
		return false;
	}
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
		const hasDiagnosticEvidence = [
			"diagnosticCode",
			"diagnosticOrigin",
			"diagnosticEvidenceAvailable",
			"failurePhase",
		].some((field) => entry[field] !== undefined && entry[field] !== null);
		if (hasDiagnosticEvidence && !hasTrustedQuotaRetryEvidence(entry)) {
			throw new Error(`${label} has invalid quota diagnostic provenance`);
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
		diagnosticCode = checkpoint.retryState?.diagnosticCode ?? null,
		diagnosticOrigin = checkpoint.retryState?.diagnosticOrigin ?? null,
		diagnosticEvidenceAvailable = checkpoint.retryState
			?.diagnosticEvidenceAvailable ?? false,
		diagnosticRef = checkpoint.retryState?.diagnosticRef ?? null,
		failurePhase = checkpoint.retryState?.failurePhase ?? null,
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
		diagnosticCode,
		diagnosticOrigin,
		diagnosticEvidenceAvailable,
		diagnosticRef:
			diagnosticEvidenceAvailable === true &&
			DIAGNOSTIC_REF_RE.test(diagnosticRef ?? "")
				? diagnosticRef
				: null,
		failurePhase,
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
				diagnosticCode,
				diagnosticOrigin,
				diagnosticEvidenceAvailable,
				diagnosticRef:
					diagnosticEvidenceAvailable === true &&
					DIAGNOSTIC_REF_RE.test(diagnosticRef ?? "")
						? diagnosticRef
						: null,
				failurePhase,
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
	if (
		!ownsWorkingContainer ||
		!result ||
		result.result !== "execution_failed" ||
		!hasTrustedQuotaRetryEvidence(result)
	) {
		return false;
	}
	return true;
}

const COMPLETION_CONTINUATION_FAILURES = new Set([
	"empty_required_diff",
	"required_paths_missing",
]);

function ensureProviderAttemptAllocations(checkpoint) {
	if (checkpoint.providerAttemptAllocations === undefined) {
		checkpoint.providerAttemptAllocations = [];
	}
	if (!Array.isArray(checkpoint.providerAttemptAllocations)) {
		throw new Error("providerAttemptAllocations is invalid");
	}
	return checkpoint.providerAttemptAllocations;
}

// This is deliberately separate from integration operations: one describes a
// host-side apply, the other spends the single additional provider launch.
function allocateExtraProviderInvocation(
	checkpoint,
	checkpointPath,
	taskId,
	reason,
	intent = null,
) {
	const allocations = ensureProviderAttemptAllocations(checkpoint);
	const legacyUsed = (checkpoint.retryAttempts ?? []).some(
		(entry) => entry?.taskId === taskId,
	);
	if (legacyUsed || allocations.some((entry) => entry?.taskId === taskId)) {
		return null;
	}
	const allocation = {
		taskId,
		reason,
		state: "allocated",
		allocatedAt: new Date().toISOString(),
		...(reason === "completion_correction" ? intent : {}),
	};
	allocations.push(allocation);
	checkpoint.lastUpdatedAt = allocation.allocatedAt;
	saveCheckpoint(checkpointPath, checkpoint);
	return allocation;
}

function recordExtraProviderInvocation(
	checkpoint,
	checkpointPath,
	allocation,
	state,
) {
	if (!allocation || !["running", "result_recorded"].includes(state)) return;
	allocation.state = state;
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
}

function recordExtraProviderInvocationResult(
	checkpoint,
	checkpointPath,
	taskId,
) {
	const allocation = ensureProviderAttemptAllocations(checkpoint).find(
		(entry) => entry?.taskId === taskId,
	);
	if (allocation?.state === "allocated" || allocation?.state === "running") {
		recordExtraProviderInvocation(
			checkpoint,
			checkpointPath,
			allocation,
			"result_recorded",
		);
	}
}

function startExtraProviderInvocation(checkpoint, checkpointPath, taskId) {
	const allocation = ensureProviderAttemptAllocations(checkpoint).find(
		(entry) => entry?.taskId === taskId,
	);
	if (allocation?.state === "allocated") {
		recordExtraProviderInvocation(
			checkpoint,
			checkpointPath,
			allocation,
			"running",
		);
	}
}

function completionContinuationCandidate(result, enabled) {
	return (
		enabled === true &&
		result?.success === false &&
		result.result === "integration_failed" &&
		["captured", "empty"].includes(result.captureStatus) &&
		COMPLETION_CONTINUATION_FAILURES.has(result.diagnosticCode)
	);
}

function machineMissingRequirements(task, result) {
	if (result.diagnosticCode !== "required_paths_missing") return [];
	return (result.missingPaths ?? task.requiredPaths ?? []).filter(
		(path) => typeof path === "string",
	);
}

function taskPromptForAttempt(task, requirements) {
	const prompt = task.prompt || task.description || task.title;
	if (!Array.isArray(requirements) || requirements.length === 0) return prompt;
	return `${prompt}\n\nRequired paths still missing: ${requirements.join(", ")}`;
}

function initializeTaskExecutionBudget(context, task) {
	const timeoutMs = task.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS;
	const wallDeadlineMs = (context.now?.() ?? Date.now()) + timeoutMs;
	const monotonicDeadlineMs =
		(context.monotonicNow?.() ?? performance.now()) + timeoutMs;
	context._activeTaskBudget = {
		taskId: task.id,
		wallDeadlineMs,
		monotonicDeadlineMs,
		deadline: new Date(wallDeadlineMs).toISOString(),
	};
	return { ...context._activeTaskBudget, remainingMs: timeoutMs };
}

function taskExecutionBudget(context, task) {
	if (context._activeTaskBudget?.taskId === task.id) {
		const wallRemaining =
			context._activeTaskBudget.wallDeadlineMs -
			(context.now?.() ?? Date.now());
		const monotonicRemaining =
			context._activeTaskBudget.monotonicDeadlineMs -
			(context.monotonicNow?.() ?? performance.now());
		return {
			...context._activeTaskBudget,
			remainingMs: Math.max(0, Math.min(wallRemaining, monotonicRemaining)),
		};
	}
	return initializeTaskExecutionBudget(context, task);
}

function completionLifecycleContext(context, task) {
	const cleanupContext =
		context._activeTaskHelperContext ??
		executionCleanupContext(
			context,
			task,
			context._activeInvocationDescriptor?.descriptor_identity,
		);
	const budget = taskExecutionBudget(context, task);
	return {
		taskId: task.id,
		attemptId: cleanupContext.attemptId,
		descriptorIdentity: cleanupContext.descriptorIdentity,
		workingContainerName: context.workingContainerName,
		executionBackend: context.executionBackend,
		cleanupContext,
		deadline: budget.deadline,
		timeoutMs: budget.remainingMs,
		onStatus: context.onStatus,
		lifecycleReceipt: context._activeCompletionLifecycleReceipt,
	};
}

function runCompletionCorrection(
	task,
	context,
	result,
	checkpoint,
	checkpointPath,
) {
	if (
		context.ownsWorkingContainer !== true ||
		context.completionContinuationMode !== "sync" ||
		!completionContinuationCandidate(
			result,
			context.completionContinuation?.enabled,
		)
	)
		return result;
	const budget = taskExecutionBudget(context, task);
	const pin = context._activeCompletionPin;
	if (!pin || budget.remainingMs <= 0) return result;
	const requirements = machineMissingRequirements(task, result);
	if (
		!verifyCompletionContinuationSync(
			context._activeCompletionAdapter,
			completionLifecycleContext(context, task),
		)
	) {
		return result;
	}
	if (taskExecutionBudget(context, task).remainingMs <= 0) return result;
	const allocation = allocateExtraProviderInvocation(
		checkpoint,
		checkpointPath,
		task.id,
		"completion_correction",
		{
			deadline: pin.deadline,
			descriptorIdentity: pin.descriptorIdentity,
			workspaceId: pin.workspaceId,
			baseTree: pin.baseTree,
			attemptId: pin.attemptId,
		},
	);
	if (!allocation) return result;
	context.onStatus?.({
		phase: "execution",
		event: "completion_correction_allocated",
		status: `Task ${task.id} completion correction allocated`,
		taskId: task.id,
		missingRequirements: requirements,
	});
	recordExtraProviderInvocation(
		checkpoint,
		checkpointPath,
		allocation,
		"running",
	);
	const originalRequirements = context._completionRequirements;
	context._completionPin = pin;
	context._completionRequirements = requirements;
	try {
		const correction = executeTask(task, context);
		correction.extraProviderInvocationUsed = true;
		recordExtraProviderInvocation(
			checkpoint,
			checkpointPath,
			allocation,
			"result_recorded",
		);
		return correction;
	} finally {
		context._completionPin = null;
		context._completionRequirements = originalRequirements;
	}
}

const ALLOWED_INTEGRATION_MESSAGES = Object.freeze(
	new Set([
		"empty_required_diff",
		"required_paths_missing",
		"undeclared_paths_touched",
		"no_op_diff",
		...INTEGRATION_REFUSAL_KINDS.filter(
			(kind) => kind !== "integration_state_unknown",
		),
	]),
);

export function integrationFailureMetadata(
	taskId,
	diff,
	credentialFlagged,
	gateResult = null,
	hasGateEvidence = false,
) {
	const errorKind =
		gateResult?.errorKind &&
		PERSISTED_ERROR_KINDS.includes(gateResult.errorKind)
			? gateResult.errorKind
			: "integration_failed";
	const rawDiagnosticCode = PERSISTED_DIAGNOSTIC_CODES.includes(
		gateResult?.reasonKind,
	)
		? gateResult.reasonKind
		: ALLOWED_INTEGRATION_MESSAGES.has(gateResult?.message)
			? gateResult.message
			: undefined;
	const diagnosticCode = PERSISTED_DIAGNOSTIC_CODES.includes(rawDiagnosticCode)
		? rawDiagnosticCode
		: undefined;
	return sanitizeFailureMetadata({
		taskId,
		result: "integration_failed",
		errorKind,
		diagnosticCode,
		// The queue saves this diff as `<taskId>.diff`; derive the opaque pointer
		// before recording the dispatch so the ledger can carry the same safe
		// artifact identity without receiving the host path or diff body.
		partialDiffPath:
			typeof diff === "string" && diff.length > 0 && !credentialFlagged
				? `${taskId}.diff`
				: undefined,
		// An empty-diff rejection has no diff to point at. When the provider
		// transcript was kept instead, name it here so the record and the
		// ledger carry evidence rather than a bare reason code.
		gateEvidencePath:
			hasGateEvidence && !credentialFlagged ? `${taskId}.output` : undefined,
	});
}

/**
 * Project an adapter's served-model record into one bounded fact.
 *
 * Only some adapters can read back which model the provider actually served.
 * Vibe can, and is the reason this exists: its CLI silently substitutes a
 * configured model for an unknown one and exits 0, so a whole task can run on
 * a model nobody selected. A served/selector mismatch already fails the task,
 * so on any task that reaches a result the served model is either the selector
 * or unreadable — which reduces to a boolean. The boolean is what crosses the
 * persistence boundary; the guest-supplied string never does.
 *
 * Absent (rather than false) for adapters that cannot report one, so "not
 * supported here" never reads as "checked and failed".
 *
 * @param {object|null|undefined} execution adapter or broker execution record
 * @returns {{servedModelVerified?: boolean}} spreadable, empty when unsupported
 */
function servedModelVerificationFields(execution) {
	const projected = execution?.servedModelVerified;
	if (projected === true || projected === false) {
		return { servedModelVerified: projected };
	}
	if (execution?.servedModel === undefined) return {};
	return { servedModelVerified: Boolean(execution.servedModel) };
}

/**
 * Cleanup evidence for a task whose provider process outlived its kill.
 *
 * Present only when cleanup actually failed, so an ordinary result is
 * unchanged. The failure branches carry `cleanupFailed`/`cleanupStage`
 * already; the success branches did not, so the broker was forwarding both
 * fields on its success shape to a reader that never looked at them and a task
 * could complete, and be persisted as an unqualified success, while leaving a
 * provider process running in the guest.
 */
function survivingProviderFields(execution) {
	const fields = {};
	if (execution?.cleanupFailed === true) {
		Object.assign(fields, {
			cleanupFailed: true,
			cleanupStage: execution.cleanupStage ?? null,
		});
	}
	if (
		execution?.diagnosticEvidenceAvailable === true &&
		typeof execution?.diagnosticRef === "string" &&
		/^diagnostic:[a-f0-9]{32}$/u.test(execution.diagnosticRef)
	) {
		fields.diagnosticRef = execution.diagnosticRef;
	}
	return fields;
}

function reviewTaskResult(
	task,
	execution,
	routeResult,
	invocationDescriptor,
	requiredCapability,
	resolvedTargetId,
) {
	if (task.type !== "review") return null;
	const reviewResult = reviewResultFromExecution(execution);
	const available = reviewResult.status === "available";
	return {
		...descriptorReceiptFields(invocationDescriptor),
		taskId: task.id,
		success: available,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: available ? "review_completed" : "review_unavailable",
		reviewResult,
		...(available
			? {}
			: {
					errorKind: "review_result_unavailable",
					reason: "Provider review result was unavailable or malformed.",
				}),
		...servedModelVerificationFields(execution),
		...survivingProviderFields(execution),
	};
}

// Only a completed provider execution can carry a structured review result.
// Task 3.2 branches review work away from integration so an unreviewed diff can
// never reach the host; it must not also bypass Task 3.1's failure
// classification, or a review task that hit a CLI usage error, a timeout or a
// quota wall would be recorded as an undiagnosed `review_unavailable` and would
// never be quarantined, retried or re-routed. Failed review executions take the
// ordinary failure path instead, with raw diff capture suppressed and an
// explicit unavailable review result attached.
function isStructuredReviewExecution(task, execution) {
	return task.type === "review" && execution?.success === true;
}

// A review task retains no raw provider bytes (Task 3.2), so the failure paths
// skip the diff capture they perform for implementation work rather than
// capturing a diff that must then be discarded unread.
function retainsFailureDiff(task) {
	return task.type !== "review";
}

function reviewFailureFields(task, execution) {
	if (task.type !== "review") return {};
	return {
		reviewResult: unavailableReviewResult(
			execution?.timedOut === true ? "timeout" : "provider_failed",
		),
	};
}

function normalizeSynchronousProviderExecution(execution) {
	if (!execution || typeof execution !== "object") return execution;
	const hasProviderDiagnostic = [
		"diagnosticEvidence",
		"diagnosticEvidenceAvailable",
		"diagnosticRef",
		"diagnosticCode",
		"diagnosticOrigin",
	].some((field) => Object.hasOwn(execution, field));
	return {
		...execution,
		// The synchronous adapter seam has no bounded artifact producer. A
		// provider-supplied availability bit or pre-mapped ref is therefore not
		// durable evidence and must not reach projections or retry decisions.
		...(hasProviderDiagnostic
			? { diagnosticEvidenceAvailable: false, diagnosticRef: null }
			: {}),
	};
}

function opaqueArtifactRef(value) {
	return typeof value === "string" && /^artifact:[a-f0-9]{24}$/.test(value)
		? value
		: undefined;
}

const DIFF_CAPTURE_STATUSES = new Set([
	"captured",
	"empty",
	"stage_failed",
	"diff_failed",
	"transport_failed",
	"timed_out",
]);

function normalizeDiffCaptureEvidence(value) {
	if (typeof value === "string") {
		return value.length > 0
			? { status: "captured", diff: value }
			: { status: "empty", diff: null };
	}
	if (
		value &&
		DIFF_CAPTURE_STATUSES.has(value.status) &&
		(typeof value.diff === "string" || value.diff == null)
	) {
		return {
			status: value.status,
			diff: value.status === "captured" ? value.diff : null,
			...(value.reasonCode ? { reasonCode: value.reasonCode } : {}),
		};
	}
	// Legacy adapters expose only string/null. Preserve their existing failure
	// semantics while allowing Vibe's detailed seam to report `empty` safely.
	return { status: "transport_failed", diff: null };
}

function captureDiffWithEvidence(adapter, workspaceName, options) {
	if (typeof adapter.captureDiffDetailed === "function") {
		return normalizeDiffCaptureEvidence(
			adapter.captureDiffDetailed(workspaceName, options),
		);
	}
	const diff = adapter.captureDiff(workspaceName, options);
	return typeof diff === "string"
		? { status: diff.length > 0 ? "captured" : "empty", diff }
		: { status: "transport_failed", diff: null };
}

async function captureDiffWithEvidenceAsync(adapter, workspaceName, options) {
	if (typeof adapter.captureDiffDetailedAsync === "function") {
		return normalizeDiffCaptureEvidence(
			await adapter.captureDiffDetailedAsync(workspaceName, options),
		);
	}
	const diff = await adapter.captureDiffAsync(workspaceName, options);
	return typeof diff === "string"
		? { status: diff.length > 0 ? "captured" : "empty", diff }
		: { status: "transport_failed", diff: null };
}

// A provider must never choose its own diff base. The runner records this
// receipt before launch, and capture revalidates the anchored ref afterwards.
function taskBaseProbeOptions(context, cleanupContext) {
	return {
		timeoutMs: 30_000,
		signal: context.signal,
		onStatus: context.onStatus,
		cleanupContext,
	};
}

function persistedTaskBaseHelperContext(base, currentOwnership) {
	const stored = base?.cleanupContext;
	if (stored?.operation !== "helper") {
		throw new Error("persisted task base has no exact helper identity");
	}
	for (const field of [
		"runId",
		"taskId",
		"attemptId",
		"descriptorIdentity",
		"workspaceId",
	]) {
		if (typeof stored[field] !== "string" || stored[field].length === 0) {
			throw new Error(`persisted task base has invalid ${field}`);
		}
	}
	if (
		stored.processStartIdentity !== null &&
		typeof stored.processStartIdentity !== "string"
	) {
		throw new Error("persisted task base has invalid processStartIdentity");
	}
	for (const field of ["runId", "taskId", "workspaceId"]) {
		if (stored[field] !== currentOwnership[field]) {
			throw new Error(`persisted task base has foreign ${field}`);
		}
	}
	return true;
}

function integrationOperation(context, task, diff) {
	const checkpoint = context.checkpoint;
	if (!checkpoint || typeof diff !== "string") return null;
	const patch = diff.endsWith("\n") ? diff : `${diff}\n`;
	const patchHash = createHash("sha256").update(patch, "utf8").digest("hex");
	const baseTree = context._activeTaskBase?.tree;
	if (typeof baseTree !== "string" || !baseTree) return null;
	const existing = checkpoint.integrationIntents?.[task.id];
	if (
		existing &&
		existing.operation?.patchHash === patchHash &&
		existing.operation?.baseTree === baseTree &&
		JSON.stringify(existing.operation?.paths) ===
			JSON.stringify(task.requiredPaths ?? []) &&
		(existing.operation?.dirtyOverlayReceiptHash ?? null) ===
			(context.dirtyOverlayReceipt?.receiptHash ?? null)
	) {
		return {
			...existing.operation,
			baseTree,
			patchHash,
			paths: [...(task.requiredPaths ?? [])],
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		};
	}
	return {
		runId: context.runId ?? checkpoint.owner.runId,
		taskId: task.id,
		attempt: (checkpoint.taskAttempts?.[task.id] ?? 0) + 1,
		baseTree,
		patchHash,
		paths: [...(task.requiredPaths ?? [])],
		dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
	};
}

function sameIntegrationOperation(left, right) {
	return (
		left?.runId === right?.runId &&
		left?.taskId === right?.taskId &&
		left?.attempt === right?.attempt &&
		left?.baseTree === right?.baseTree &&
		left?.patchHash === right?.patchHash &&
		JSON.stringify(left?.paths) === JSON.stringify(right?.paths) &&
		(left?.dirtyOverlayReceiptHash ?? null) ===
			(right?.dirtyOverlayReceiptHash ?? null)
	);
}

function checkpointIntegrationIntent(context, task, diff) {
	const operation = integrationOperation(context, task, diff);
	if (!operation) return undefined;
	const read = (candidate, lease) => {
		assertCheckpointLease(
			lease,
			context.checkpointPath,
			context.checkpoint.owner,
		);
		const disk = JSON.parse(readFileSync(context.checkpointPath, "utf8"));
		validateCheckpointV3(disk, context.checkpoint.tasksFilePath, {
			checkpointOwner: context.checkpoint.owner,
		});
		const proof = disk.integrationIntents?.[task.id] ?? null;
		if (proof && !sameIntegrationOperation(proof.operation, candidate))
			return proof;
		return proof ? structuredClone(proof) : null;
	};
	const persist = (proof, lease) => {
		const checkpoint = context.checkpoint;
		const existing = checkpoint.integrationIntents?.[task.id];
		if (
			existing ||
			!sameIntegrationOperation(proof.operation, operation) ||
			proof.status !== "pending"
		)
			return null;
		checkpoint.integrationIntents ??= {};
		checkpoint.taskAttempts ??= {};
		checkpoint.integrationIntents[task.id] = structuredClone(proof);
		checkpoint.taskAttempts[task.id] = operation.attempt;
		checkpoint.lastUpdatedAt = new Date().toISOString();
		try {
			saveCheckpoint(context.checkpointPath, checkpoint, { lease });
			return read(operation, lease);
		} catch {
			return null;
		}
	};
	const complete = (proof, lease) => {
		const entry = context.checkpoint.integrationIntents?.[task.id];
		if (
			!sameIntegrationOperation(entry?.operation, proof.operation) ||
			entry?.status !== "pending" ||
			proof.status !== "completed"
		)
			return null;
		context.checkpoint.integrationIntents[task.id] = structuredClone(proof);
		context.checkpoint.lastUpdatedAt = new Date().toISOString();
		try {
			saveCheckpoint(context.checkpointPath, context.checkpoint, { lease });
			return read(operation, lease);
		} catch {
			return null;
		}
	};
	return {
		operation,
		acquire: () =>
			acquireCheckpointLease(context.checkpointPath, context.checkpoint.owner),
		release: releaseCheckpointLease,
		persist,
		complete,
		read,
	};
}

function prepareTaskBase(context, task, cleanupContext) {
	try {
		const existing = context.taskBases?.[task.id] ?? null;
		if (
			existing &&
			(existing.dirtyOverlayReceiptHash ?? null) !==
				(context.dirtyOverlayReceipt?.receiptHash ?? null)
		)
			throw new Error("dirty overlay receipt changed for persisted task base");
		const helperContext = mergeAttemptCleanupContext(cleanupContext, {
			operation: "helper",
		});
		if (existing) persistedTaskBaseHelperContext(existing, helperContext);
		const base = existing
			? context.queueBackend.validateTaskBase(
					context.workingContainerName,
					existing,
					taskBaseProbeOptions(context, helperContext),
				)
			: context.queueBackend.captureTaskBase(context.workingContainerName, {
					runId: context.runId,
					taskId: task.id,
					...taskBaseProbeOptions(context, helperContext),
				});
		const recordedBase = existing ?? {
			...base,
			cleanupContext: helperContext,
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		};
		context.persistTaskBase?.(task.id, recordedBase);
		context._activeTaskBase = recordedBase;
		context._activeTaskHelperContext = helperContext;
		return recordedBase;
	} catch {
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_failed",
			status: `Task ${task.id} immutable base capture failed`,
			taskId: task.id,
		});
		return null;
	}
}

async function prepareTaskBaseAsync(context, task, cleanupContext) {
	try {
		const existing = context.taskBases?.[task.id] ?? null;
		if (
			existing &&
			(existing.dirtyOverlayReceiptHash ?? null) !==
				(context.dirtyOverlayReceipt?.receiptHash ?? null)
		)
			throw new Error("dirty overlay receipt changed for persisted task base");
		const helperContext = mergeAttemptCleanupContext(cleanupContext, {
			operation: "helper",
		});
		if (existing) persistedTaskBaseHelperContext(existing, helperContext);
		const validateAsync =
			context.queueBackend.validateTaskBaseAsync ??
			((...args) => context.queueBackend.validateTaskBase(...args));
		const captureAsync =
			context.queueBackend.captureTaskBaseAsync ??
			((...args) => context.queueBackend.captureTaskBase(...args));
		const base = existing
			? await validateAsync(
					context.workingContainerName,
					existing,
					taskBaseProbeOptions(context, helperContext),
				)
			: await captureAsync(context.workingContainerName, {
					runId: context.runId,
					taskId: task.id,
					...taskBaseProbeOptions(context, helperContext),
				});
		const recordedBase = existing ?? {
			...base,
			cleanupContext: helperContext,
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		};
		context.persistTaskBase?.(task.id, recordedBase);
		context._activeTaskBase = recordedBase;
		context._activeTaskHelperContext = helperContext;
		return recordedBase;
	} catch {
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_failed",
			status: `Task ${task.id} immutable base capture failed`,
			taskId: task.id,
		});
		return null;
	}
}

function taskBaseReleaseHalt(taskId) {
	return {
		taskId,
		success: false,
		provider: null,
		model: null,
		result: "halted_after_task_base_release_failure",
		errorKind: "diff_capture_failed",
		reason: "immutable task base release is uncertain; recovery required",
	};
}

function providerCleanupHalt(result) {
	return {
		taskId: result.taskId,
		success: false,
		provider: result.provider ?? null,
		model: result.model ?? null,
		result: "halted_after_provider_cleanup_failure",
		errorKind: "provider_cleanup_failed",
		reason: "provider cleanup is uncertain; recovery required",
		cleanupFailed: true,
		cleanupStage: result.cleanupStage ?? null,
	};
}

function markProviderCleanupUncertain(checkpoint, result) {
	if (result.cleanupFailed !== true) return;
	checkpoint.providerCleanupUncertain = {
		taskId: result.taskId,
		cleanupStage: result.cleanupStage ?? null,
	};
}

function persistProviderCleanupUncertain(checkpoint, result, checkpointPath) {
	if (result.cleanupFailed !== true) return;
	markProviderCleanupUncertain(checkpoint, result);
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
}

function assertCheckpointRecoverySafe(checkpoint) {
	const marker = checkpoint.taskBaseReleaseUncertain
		? "immutable task base release"
		: checkpoint.providerCleanupUncertain
			? "provider cleanup"
			: null;
	if (!marker) return;
	const error = new Error(
		`checkpoint records uncertain ${marker}; explicit recovery is required`,
	);
	error.code = "recovery_required";
	throw error;
}

function finalizeTaskBase(context, taskId, checkpoint, checkpointPath) {
	const base = checkpoint.taskBases?.[taskId];
	if (!base) return null;
	try {
		const helperContext = context._activeTaskHelperContext;
		persistedTaskBaseHelperContext(base, helperContext ?? {});
		context.queueBackend.releaseTaskBase(
			context.workingContainerName,
			base,
			taskBaseProbeOptions(context, helperContext),
		);
		delete checkpoint.taskBases[taskId];
		if (checkpoint.taskBaseReleaseUncertain?.taskId === taskId) {
			delete checkpoint.taskBaseReleaseUncertain;
		}
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_released",
			status: `Task ${taskId} immutable base released`,
			taskId,
		});
		return null;
	} catch {
		checkpoint.taskBaseReleaseUncertain = { taskId, ...base };
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_release_failed",
			status: `Task ${taskId} immutable base release uncertain; recovery required`,
			taskId,
		});
		return taskBaseReleaseHalt(taskId);
	}
}

async function finalizeTaskBaseAsync(
	context,
	taskId,
	checkpoint,
	checkpointPath,
) {
	const base = checkpoint.taskBases?.[taskId];
	if (!base) return null;
	try {
		const helperContext = context._activeTaskHelperContext;
		persistedTaskBaseHelperContext(base, helperContext ?? {});
		const releaseAsync =
			context.queueBackend.releaseTaskBaseAsync ??
			((...args) => context.queueBackend.releaseTaskBase(...args));
		await releaseAsync(
			context.workingContainerName,
			base,
			taskBaseProbeOptions(context, helperContext),
		);
		delete checkpoint.taskBases[taskId];
		if (checkpoint.taskBaseReleaseUncertain?.taskId === taskId) {
			delete checkpoint.taskBaseReleaseUncertain;
		}
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_released",
			status: `Task ${taskId} immutable base released`,
			taskId,
		});
		return null;
	} catch {
		checkpoint.taskBaseReleaseUncertain = { taskId, ...base };
		checkpoint.lastUpdatedAt = new Date().toISOString();
		saveCheckpoint(checkpointPath, checkpoint);
		context.onStatus?.({
			phase: "checkpoint",
			event: "task_base_release_failed",
			status: `Task ${taskId} immutable base release uncertain; recovery required`,
			taskId,
		});
		return taskBaseReleaseHalt(taskId);
	}
}

function taskBaseFailure(
	task,
	routeResult,
	invocationDescriptor,
	requiredCapability,
) {
	return {
		...descriptorReceiptFields(invocationDescriptor),
		taskId: task.id,
		success: false,
		provider: routeResult.provider ?? null,
		model: invocationDescriptor?.selector ?? routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId: routeResult.resolvedTargetId ?? null,
		result: "task_base_capture_failed",
		errorKind: "diff_capture_failed",
		reason: "immutable task base capture failed",
	};
}

function taskBaseMatches(actual, expected) {
	return (
		actual !== null &&
		typeof actual === "object" &&
		actual.ref === expected?.ref &&
		actual.tree === expected?.tree
	);
}

/**
 * Execute one task via routed provider/model and return a structured result.
 * @param {{id: string, title: string, description: string}} task
 * @param {object} context
 */
function executionCleanupContext(
	context,
	task,
	descriptorIdentity,
	attemptId = null,
) {
	return Object.freeze({
		runId: context.runId,
		taskId: String(task.id),
		// The lifecycle receipt is matched against the route-health binding by
		// attempt id, so both must derive it from the same checkpoint state.
		attemptId:
			attemptId ??
			context.attemptId ??
			routeHealthAttemptId(context, String(task.id)),
		descriptorIdentity,
		workspaceId: context.workingContainerName,
		processStartIdentity: context.processStartIdentity ?? null,
		operation: "provider",
	});
}

function mergeAttemptCleanupContext(bound, supplied = null) {
	if (!bound) return supplied ? Object.freeze({ ...supplied }) : null;
	const immutable = Object.freeze({ ...bound });
	if (!supplied) return immutable;
	for (const field of [
		"runId",
		"taskId",
		"attemptId",
		"descriptorIdentity",
		"workspaceId",
		"processStartIdentity",
	]) {
		if (field in supplied && supplied[field] !== immutable[field]) {
			throw new Error(`contradictory cleanup context ${field}`);
		}
	}
	const operation = supplied.operation ?? immutable.operation;
	if (!["provider", "helper"].includes(operation)) {
		throw new Error("cleanup context operation must be provider or helper");
	}
	if (immutable.operation === "helper" && operation !== "helper") {
		throw new Error("helper cleanup context cannot become provider context");
	}
	return Object.freeze({ ...immutable, operation });
}

function bindAttemptExecutionBackend(executionBackend, cleanupContext) {
	if (!executionBackend || typeof executionBackend !== "object")
		return executionBackend;
	const bound = Object.freeze({ ...cleanupContext });
	return new Proxy(executionBackend, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property === "execArgv") {
				return (workspaceId, options = {}) => {
					if (workspaceId !== bound.workspaceId) {
						throw new Error("contradictory cleanup context workspaceId");
					}
					return Reflect.apply(value, target, [
						workspaceId,
						{
							...options,
							cleanupContext: mergeAttemptCleanupContext(
								bound,
								options.cleanupContext,
							),
						},
					]);
				};
			}
			if (property === "cleanupProviderProcess") {
				return (command, args, options = {}) => {
					if (
						options.workspaceId !== undefined &&
						options.workspaceId !== bound.workspaceId
					) {
						throw new Error("contradictory cleanup context workspaceId");
					}
					return Reflect.apply(value, target, [
						command,
						args,
						{
							...options,
							workspaceId: bound.workspaceId,
							...mergeAttemptCleanupContext(bound, options),
						},
					]);
				};
			}
			return value.bind(target);
		},
	});
}

function bindAttemptHelperBackend(executionBackend, cleanupContext) {
	return bindAttemptExecutionBackend(
		executionBackend,
		mergeAttemptCleanupContext(cleanupContext, { operation: "helper" }),
	);
}

function routeHealthAttemptId(context, taskId) {
	if (context.healthAttempt !== undefined) return context.healthAttempt;
	const retryState = context.checkpoint?.retryState;
	if (
		retryState?.taskId === taskId &&
		Number.isSafeInteger(retryState.attempt) &&
		retryState.attempt > 0
	)
		return `attempt-${retryState.attempt}`;
	// A completion correction is the same attempt continuing, not a second
	// one: its allocation must not move the binding or the cleanup context
	// to attempt-2, or the continuation's lifecycle receipt can never match.
	const allocation = context.checkpoint?.providerAttemptAllocations?.find(
		(entry) =>
			entry?.taskId === taskId &&
			entry.reason !== "completion_correction" &&
			["allocated", "running"].includes(entry.state),
	);
	return allocation ? "attempt-2" : "attempt-1";
}

function routeHealthAttemptIdentity(context, task, routeResult, descriptor) {
	const decision = context.healthDecision;
	if (typeof decision?.identityFor !== "function") return null;
	// Health evidence and half-open claims are keyed by the run identity. A
	// queue without one (no run store) can neither claim a trial nor publish
	// an ingestible terminal event, so it must never reach the claim path
	// where a missing run id is a schema error instead of a routing outcome.
	if (typeof context.runId !== "string" || context.runId.length === 0)
		return null;
	const identity = decision.identityFor({
		provider: routeResult.provider,
		requiredCapability: routeResult.requiredCapability,
	});
	if (
		!identity ||
		descriptor?.descriptor_identity !== identity.descriptorIdentity
	)
		return null;
	const state = decision({
		provider: routeResult.provider,
		requiredCapability: routeResult.requiredCapability,
	});
	if (!state.available && state.initializable !== true) return null;
	return {
		...identity,
		repairEpoch: state.available ? state.repairEpoch : 0,
		runId: context.runId,
		taskId: String(task.id),
		attempt: routeHealthAttemptId(context, task.id),
		workspaceId: context.workingContainerName,
		descriptorHarness: routeResult.resolved_harness,
		invocationDescriptor: structuredClone(descriptor),
		provider: routeResult.provider,
		model: descriptor.selector,
		mode: decision.mode ?? "shadow",
		suppress: state.suppress === true,
		trialAvailable: state.trialAvailable === true,
		healthStateRoot: decision.healthStateRoot,
		onStatus: context.onStatus,
	};
}

function prepareRouteHealthTrial(context, task, routeResult, descriptor) {
	if (context._completionPin && context._activeRouteHealth) {
		return { allowed: true };
	}
	const binding = routeHealthAttemptIdentity(
		context,
		task,
		routeResult,
		descriptor,
	);
	context._activeRouteHealth = binding;
	if (binding?.suppress === true)
		return {
			allowed: binding.mode !== "enforce",
			reason: "route-health-suppressed",
		};
	if (!binding?.trialAvailable) return { allowed: true };
	// Shadow mode is observational: it never writes a half-open claim, so a
	// shadow queue can neither flip a target to `half-open` for every later
	// reader nor fence this task's fallback launches behind a trial it did
	// not own. Only an enforcing queue claims and starts trials.
	if (binding.mode !== "enforce") {
		context.onStatus?.({
			phase: "route_health",
			event: "half_open_trial_shadowed",
			status: `Task ${task.id} would claim the selected health trial in enforce mode`,
			taskId: task.id,
		});
		return { allowed: true };
	}
	const claimed = acquireHalfOpenClaimSync(binding);
	if (claimed.claimed !== true) {
		context.onStatus?.({
			phase: "route_health",
			event: "half_open_claim_unavailable",
			status: `Task ${task.id} could not claim the selected health trial`,
			taskId: task.id,
		});
		return { allowed: binding.mode !== "enforce", reason: claimed.reason };
	}
	Object.assign(binding, {
		leaseToken: claimed.lease.token,
		leaseRevision: claimed.lease.revision,
		claimRevision: claimed.lease.revision,
	});
	return { allowed: true };
}

function startRouteHealthTrial(context) {
	const binding = context._activeRouteHealth;
	if (binding?.claimStarted) return { allowed: true };
	if (!binding?.leaseToken) return { allowed: true };
	const started = startHalfOpenClaimSync(binding);
	if (started.started === true) {
		binding.claimStarted = true;
		return { allowed: true };
	}
	const released = releaseHalfOpenClaimSync({
		...binding,
		provenNeverStarted: true,
	});
	return {
		allowed: binding.mode !== "enforce",
		reason: released.reason ?? started.reason,
	};
}

function healthDeferredResult(
	task,
	routeResult,
	descriptor,
	requiredCapability,
) {
	return {
		...descriptorReceiptFields(descriptor),
		taskId: task.id,
		success: false,
		provider: routeResult.provider,
		model: descriptor.selector,
		requiredCapability,
		resolvedTargetId: routeResult.resolvedTargetId ?? null,
		result: "route_health_deferred",
		errorKind: null,
		reason: "selected route health trial is already claimed or unavailable",
	};
}

function policyDeferredTaskResult(task, power, taskFileSha256) {
	return {
		taskId: task.id,
		success: false,
		provider: null,
		model: null,
		result: "policy_deferred",
		errorKind: null,
		policyDeferred: {
			version: 1,
			action: "policy_deferred",
			direction: "advance_authorized_fallback",
			reasonCode: "host_on_battery",
			diagnosticCode: power.diagnosticCode ?? "host_on_battery",
			nextTaskId: task.id,
			taskFileSha256,
		},
	};
}

function policyDeferredQueueResult(launch, checkpointPath) {
	const { checkpoint, tasks, policyDeferred } = launch;
	releaseCheckpointOwnership(checkpointPath, checkpoint);
	return {
		results: [],
		totalTasks: tasks.length,
		runnableTasks: policyDeferred.runnableTaskCount,
		processedTasks: 0,
		completedTaskIds: checkpoint.completedTaskIds,
		deferredTaskIds: [policyDeferred.nextTaskId],
		checkpointPath,
		ledgerWritesSettled: Promise.resolve(),
		quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
		retryState: checkpoint.retryState,
		retryTransitionId: checkpoint.retryTransitionId,
		policyDeferred,
	};
}

function reportHostPowerUnknown(onStatus, taskId = null) {
	onStatus?.({
		phase: "policy",
		event: "host_power_unknown",
		status: "Host power state unknown; preserving existing routing",
		diagnosticCode: "host_power_unknown",
		...(typeof taskId === "string" ? { taskId } : {}),
	});
}

function readQueueHostPower(options = {}) {
	if (options.hostPowerPolicyEnabled !== true) {
		return { state: HOST_POWER_STATES.AC, diagnosticCode: null };
	}
	const result = readHostPower(options);
	if (result.state === HOST_POWER_STATES.UNKNOWN) {
		reportHostPowerUnknown(options.onStatus, options.taskId);
	}
	return result;
}

export function isRouteHealthDeferredResult(result) {
	return result?.result === "route_health_deferred";
}

function reportRouteHealthDeferred(result, _onResult, emitStatus) {
	// Deferred work is not a terminal task result. In particular, do not send it
	// through legacy onResult callbacks, whose contract maps success:false to a
	// task_failed event. The status channel is the bounded observation path.
	emitStatus?.({
		phase: "execution",
		event: "route_health_deferred",
		status: `Task ${result.taskId} deferred: route health trial unavailable`,
		taskId: result.taskId,
		provider: result.provider ?? null,
		model: result.model ?? null,
		result: "route_health_deferred",
	});
}

function attachRouteHealthTerminal(result, context) {
	if (isRouteHealthDeferredResult(result)) return result;
	const binding = context._activeRouteHealth;
	if (binding?.claimStarted === true && result) {
		Object.defineProperty(result, "_routeHealthTrialStarted", {
			value: true,
			enumerable: false,
		});
	}
	if (!binding || !result?.invocationDescriptor) return result;
	let hostBinding;
	try {
		hostBinding = createRouteHealthTerminalBinding({
			...binding,
			...result,
			providerExecutionSucceeded:
				context._activeProviderExecutionSucceeded === true,
			lifecycleReceipt: context._activeCompletionLifecycleReceipt ?? null,
		});
	} catch {
		hostBinding = null;
	}
	if (!hostBinding) return result;
	Object.defineProperty(result, "routeHealthBinding", {
		value: hostBinding,
		enumerable: false,
	});
	Object.defineProperty(result, "routeHealthAttempt", {
		value: binding.attempt,
		enumerable: false,
	});
	return result;
}

function executeTaskUnsafe(task, context) {
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return nonSwitchyardExecutorResult(task, executor, requiredCapability);
	}
	const overlayFailure = dirtyOverlayResult(task, context, requiredCapability);
	if (overlayFailure) return overlayFailure;
	// Primary and quota-fallback invocations each own their configured timeout.
	// A completion continuation sets _completionPin and intentionally retains the
	// primary invocation's already-running absolute deadline.
	if (!context._completionPin) initializeTaskExecutionBudget(context, task);
	const checkIgnored = context.checkIgnoredPath ?? findIgnoredDeclaredPath;
	const ignoredPath = checkIgnored(
		task.requiredPaths ?? task.files,
		context.projectPath,
	);
	if (ignoredPath) {
		return declaredPathNotSeededResult(task, requiredCapability);
	}
	const hostPower = readQueueHostPower({
		hostPowerProbe: context.hostPowerProbe,
		execFn: context.hostPowerExecFn,
		timeoutMs: context.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: context.hostPowerPolicyEnabled,
		onStatus: context.onStatus,
		taskId: task.id,
	});
	if (hostPower.state === HOST_POWER_STATES.BATTERY) {
		return policyDeferredTaskResult(task, hostPower, context.taskFileSha256);
	}
	const routeResult = context._completionPin
		? structuredClone(context._completionPin.route)
		: context.route({
				requiredCapability,
				availableProviders: Object.keys(context.adapters ?? {}),
				exclude: context.exclude,
				only: context.only,
				platform: context.platform,
				...(context.goldenImageVerifiedProviders !== undefined
					? {
							goldenImageVerifiedProviders:
								context.goldenImageVerifiedProviders,
						}
					: {}),
				...(context.healthDecision
					? { healthDecision: context.healthDecision }
					: {}),
				...(context.onHealthDecision
					? { onHealthDecision: context.onHealthDecision }
					: {}),
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
		invocationDescriptor = context._completionPin
			? structuredClone(context._completionPin.invocationDescriptor)
			: descriptorFromRoute(
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
	context._activeCompletionAdapter = adapter;
	context._activeCompletionRoute = structuredClone(routeResult);
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
	const executionBudget = taskExecutionBudget(context, task);
	const timeoutMs = Math.floor(executionBudget.remainingMs);
	if (timeoutMs <= 0) {
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "execution_timed_out",
			errorKind: "execution_timeout",
			timedOut: true,
		};
	}

	// Emitted here, before the blocking adapter.execute call below, so the
	// routed provider/model/deadline are visible immediately rather than only
	// discoverable after the (up to timeoutMs-long) call returns.
	const routedDeadline = executionBudget.deadline;
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

	const prompt = taskPromptForAttempt(task, context._completionRequirements);
	const routedModel = invocationDescriptor?.selector ?? routeResult.model;
	context.queueBackend?.beforeRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	const cleanupContext = executionCleanupContext(
		context,
		task,
		invocationDescriptor?.descriptor_identity,
	);
	if (!prepareTaskBase(context, task, cleanupContext)) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "task_base_capture_failed",
			errorKind: "diff_capture_failed",
			reason: "immutable task base capture failed",
		});
		return taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const healthPreparation = prepareRouteHealthTrial(
		context,
		task,
		routeResult,
		invocationDescriptor,
	);
	if (!healthPreparation.allowed)
		return healthDeferredResult(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	if (context._completionPin) {
		if (
			context._completionPin.workspaceId !== context.workingContainerName ||
			context._completionPin.baseTree !== context._activeTaskBase?.tree ||
			context._completionPin.descriptorIdentity !==
				invocationDescriptor.descriptor_identity
		) {
			return taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
		}
	} else {
		context._activeCompletionPin = {
			taskId: task.id,
			route: structuredClone(routeResult),
			invocationDescriptor: structuredClone(invocationDescriptor),
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			workspaceId: context.workingContainerName,
			baseTree: context._activeTaskBase.tree,
			attemptId: cleanupContext.attemptId,
			deadline: executionBudget.deadline,
		};
	}
	const captureExecutionBackend = bindAttemptHelperBackend(
		context.executionBackend,
		cleanupContext,
	);
	const launchBudget = taskExecutionBudget(context, task);
	const launchTimeoutMs = Math.floor(launchBudget.remainingMs);
	if (launchTimeoutMs <= 0) {
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			requiredCapability,
			resolvedTargetId,
			result: "execution_timed_out",
			errorKind: "execution_timeout",
			timedOut: true,
		};
	}
	const healthStart = startRouteHealthTrial(context);
	if (!healthStart.allowed)
		return healthDeferredResult(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	const rawExecution = adapter.execute(prompt, context.workingContainerName, {
		model: routedModel ?? undefined,
		timeoutMs: launchTimeoutMs,
		executionBackend: bindAttemptExecutionBackend(
			context.executionBackend,
			cleanupContext,
		),
		invocationDescriptor,
		descriptorIdentity: invocationDescriptor?.descriptor_identity ?? null,
		descriptorHarness: routeResult.resolved_harness ?? null,
		resolvedTargetId,
		cleanupContext,
	});
	const execution = context.checkpoint
		? normalizeSynchronousProviderExecution(rawExecution)
		: rawExecution;
	context._activeProviderExecutionSucceeded = execution.success === true;
	context._activeCompletionLifecycleReceipt =
		execution.completionContinuationProof ?? null;
	if (execution.cleanupFailed === true && execution.success) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			reason: "provider cleanup is uncertain; recovery required",
			cleanupStage: execution.cleanupStage ?? null,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			...survivingProviderFields(execution),
		};
	}
	if (isStructuredReviewExecution(task, execution)) {
		context.queueBackend?.afterRun?.(
			context.workingContainerName,
			context.projectPath,
			{ onStatus: context.onStatus },
		);
		const review = reviewTaskResult(
			task,
			execution,
			routeResult,
			invocationDescriptor,
			requiredCapability,
			resolvedTargetId,
		);
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: review.result,
			reviewResult: review.reviewResult,
			...(review.success
				? {}
				: { errorKind: review.errorKind, reason: review.reason }),
			...survivingProviderFields(execution),
		});
		return review;
	}

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
			let captureEvidence = null;
			if (retainsFailureDiff(task)) {
				context.onStatus?.({
					phase: "execution",
					event: "diff_capture_started",
					status: `Task ${task.id} partial diff capture started`,
					taskId: task.id,
				});
				try {
					captureEvidence = captureDiffWithEvidence(
						adapter,
						context.workingContainerName,
						{
							executionBackend: captureExecutionBackend,
							taskBase: context._activeTaskBase,
						},
					);
				} catch {
					captureEvidence = { status: "transport_failed", diff: null };
				}
			}
			const partialDiff = captureEvidence?.diff ?? null;
			const captureStatus = captureEvidence?.status;
			const captureFailed =
				captureEvidence !== null &&
				captureStatus !== "captured" &&
				captureStatus !== "empty";
			if (captureEvidence !== null) {
				context.onStatus?.({
					phase: "execution",
					event: "diff_capture_completed",
					status: `Task ${task.id} partial diff capture ${captureStatus}`,
					taskId: task.id,
					captureStatus,
					byteCount: partialDiff?.length ?? 0,
				});
			}
			const cleanupFailed = execution.cleanupFailed === true;
			const resultName = cleanupFailed
				? "execution_timed_out_cleanup_failed"
				: captureFailed
					? "execution_timed_out_capture_failed"
					: "execution_timed_out";
			const errorKind =
				(cleanupFailed && "provider_cleanup_failed") ||
				(captureFailed && "diff_capture_failed") ||
				execution.errorKind ||
				null;
			const safeTimeoutFailure = sanitizeFailureMetadata({
				taskId: task.id,
				result: resultName,
				errorKind,
				timedOut: true,
				diagnosticCode: execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupStage: execution.cleanupStage,
			});
			const error = cleanupFailed
				? (execution.error ??
					safeTimeoutFailure?.reason ??
					"provider cleanup failed after timeout")
				: captureFailed
					? (safeTimeoutFailure?.reason ?? "diff capture failed after timeout")
					: (execution.error ?? null);
			record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: resultName,
				errorKind: safeTimeoutFailure?.errorKind ?? errorKind,
				...(safeTimeoutFailure
					? { reasonCode: safeTimeoutFailure.reasonCode }
					: {}),
				reason: error ?? routeResult.reason,
				...(captureStatus ? { captureStatus } : {}),
				...reviewFailureFields(task, execution),
				percentLeft: routeResult.percentLeft ?? undefined,
				diagnosticCode:
					safeTimeoutFailure?.diagnosticCode ?? execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupStage: execution.cleanupStage,
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
				errorKind: safeTimeoutFailure?.errorKind ?? errorKind,
				...(safeTimeoutFailure
					? {
							reasonCode: safeTimeoutFailure.reasonCode,
							reason: safeTimeoutFailure.reason,
						}
					: {}),
				timedOut: true,
				diagnosticCode:
					safeTimeoutFailure?.diagnosticCode ?? execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupFailed,
				cleanupStage: execution.cleanupStage,
				...(captureStatus ? { captureStatus } : {}),
				...reviewFailureFields(task, execution),
				...(partialDiff ? { partialDiff } : {}),
			};
		}

		let captureEvidence = null;
		if (retainsFailureDiff(task)) {
			context.onStatus?.({
				phase: "execution",
				event: "diff_capture_started",
				status: `Task ${task.id} failure diff capture started`,
				taskId: task.id,
			});
			try {
				captureEvidence = captureDiffWithEvidence(
					adapter,
					context.workingContainerName,
					{
						executionBackend: captureExecutionBackend,
						taskBase: context._activeTaskBase,
					},
				);
			} catch {
				captureEvidence = { status: "transport_failed", diff: null };
			}
			context.onStatus?.({
				phase: "execution",
				event: "diff_capture_completed",
				status: `Task ${task.id} failure diff capture ${captureEvidence.status}`,
				taskId: task.id,
				captureStatus: captureEvidence.status,
				byteCount: captureEvidence.diff?.length ?? 0,
			});
		}

		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			errorKind: execution.errorKind ?? null,
			reason: execution.error ?? routeResult.reason,
			percentLeft: routeResult.percentLeft ?? undefined,
			diagnosticCode: execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupStage: execution.cleanupStage,
			...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
			...reviewFailureFields(task, execution),
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
			diagnosticCode: execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupStage: execution.cleanupStage,
			...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
			...reviewFailureFields(task, execution),
			...(captureEvidence?.diff ? { partialDiff: captureEvidence.diff } : {}),
		};
	}

	context.queueBackend?.afterRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	context.onStatus?.({
		phase: "execution",
		event: "diff_capture_started",
		status: `Task ${task.id} diff capture started`,
		taskId: task.id,
	});
	const captureEvidence = captureDiffWithEvidence(
		adapter,
		context.workingContainerName,
		{
			executionBackend: captureExecutionBackend,
			taskBase: context._activeTaskBase,
		},
	);
	const diff = captureEvidence.diff;
	if (context.onStatus) {
		context.onStatus({
			phase: "execution",
			event: "diff_captured",
			status: "Diff captured",
			taskId: task.id,
			provider: routeResult.provider,
			model: invocationDescriptor.selector,
			byteCount: diff ? diff.length : 0,
			captureStatus: captureEvidence.status,
		});
	}

	if (!diff && task.requiredPaths === null) {
		record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			reason: safeSuccessfulRouteReason(routeResult.reason),
			...survivingProviderFields(execution),
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
			...servedModelVerificationFields(execution),
			...survivingProviderFields(execution),
		};
	}

	const gateResult =
		dirtyOverlayIntegrationGate(context) ??
		context.integrationGate(diff, context.projectPath, {
			requiredPaths: task.requiredPaths,
			allowSensitiveManifests:
				task.type === "implementation" && task.allowManifests === true,
			integrationIntent: checkpointIntegrationIntent(context, task, diff),
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		});
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const success = Boolean(gateResult?.success) || alreadyApplied;
	const terminalResult = success ? "success" : "integration_failed";
	const safeGateFailure = success
		? null
		: integrationFailureMetadata(
				task.id,
				diff,
				gateResult?.credentialFlagged,
				gateResult,
				!diff && Boolean(boundedGateEvidence(execution.output)),
			);
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
			...(safeGateFailure?.diagnosticCode
				? { diagnosticCode: safeGateFailure.diagnosticCode }
				: {}),
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
		...survivingProviderFields(execution),
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
		captureStatus: captureEvidence.status,
		...(Array.isArray(gateResult?.missingPaths)
			? { missingPaths: [...gateResult.missingPaths] }
			: {}),
		...servedModelVerificationFields(execution),
		...survivingProviderFields(execution),
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(gateArtifactRef ? { artifactRef: gateArtifactRef } : {}),
		...(projectionFailure
			? { legacyProjectionFailure: projectionFailure }
			: {}),
	};
	if (!success && !gateResult?.credentialFlagged) {
		result.partialDiff = diff;
		// With no diff there is nothing else to keep, and a rejection that keeps
		// nothing is not diagnosable. The provider's own transcript is then the
		// only account of why it changed no files.
		if (!diff) result.gateEvidence = boundedGateEvidence(execution.output);
	}
	return result;
}

export function executeTask(task, context) {
	if (!context._completionPin) {
		context._activeRouteHealth = null;
		context._activeProviderExecutionSucceeded = false;
		context._activeCompletionLifecycleReceipt = null;
	}
	return decorateDirtyOverlayResult(
		attachRouteHealthTerminal(executeTaskUnsafe(task, context), context),
		context,
	);
}

/**
 * Async provider-backed execution seam. The synchronous executeTask API remains
 * for legacy callers, while queue workers that can await use each adapter's
 * shared spawn/poll lifecycle through this path.
 */
export async function executeTaskAsync(task, context) {
	clearAsyncTaskContext(context);
	context._activeRouteHealth = null;
	context._activeProviderExecutionSucceeded = false;
	context._activeCompletionLifecycleReceipt = null;
	const requiredCapability = resolveTaskRequiredCapability(task);
	try {
		return decorateDirtyOverlayResult(
			attachRouteHealthTerminal(
				await executeTaskAsyncUnsafe(task, context),
				context,
			),
			context,
		);
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
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
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
	context._activeTaskTranscript = null;
	context._activeTaskIsReview = false;
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
	const overlayFailure = dirtyOverlayResult(task, context, requiredCapability);
	if (overlayFailure) return overlayFailure;
	const checkIgnored = context.checkIgnoredPath ?? findIgnoredDeclaredPath;
	const ignoredPath = checkIgnored(
		task.requiredPaths ?? task.files,
		context.projectPath,
	);
	if (ignoredPath) {
		return declaredPathNotSeededResult(task, requiredCapability);
	}
	const hostPower = readQueueHostPower({
		hostPowerProbe: context.hostPowerProbe,
		execFn: context.hostPowerExecFn,
		timeoutMs: context.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: context.hostPowerPolicyEnabled,
		onStatus: context.onStatus,
		taskId: task.id,
	});
	if (hostPower.state === HOST_POWER_STATES.BATTERY) {
		return policyDeferredTaskResult(task, hostPower, context.taskFileSha256);
	}
	let broker = context.broker;
	if (!broker) {
		broker = createDispatchBroker(context, context.brokerDependencies);
		context.broker = broker;
	}
	context._activeTaskPrompt = taskPromptForAttempt(
		task,
		context._completionRequirements,
	);
	context._activeTaskTimeoutMs =
		task.timeoutMs ?? PROVIDER_EXECUTION_TIMEOUT_MS;
	// Only a review task has a verdict to derive. Deriving unconditionally would
	// parse an implementation task's transcript and relay text sanitized out of it
	// across the broker boundary, which is the one thing that boundary exists to
	// prevent.
	context._activeTaskIsReview = task.type === "review";
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
	context._activeCompletionAdapter = adapter;
	context._activeCompletionRoute = structuredClone(routeResult);
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
	context.queueBackend?.beforeRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	let attemptCleanupContext = executionCleanupContext(
		context,
		task,
		invocationDescriptor.descriptor_identity,
	);
	if (!(await prepareTaskBaseAsync(context, task, attemptCleanupContext))) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "task_base_capture_failed",
			errorKind: "diff_capture_failed",
			reason: "immutable task base capture failed",
		});
		await releaseSelected(selectedRoute);
		return taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const healthPreparation = prepareRouteHealthTrial(
		context,
		task,
		routeResult,
		invocationDescriptor,
	);
	if (!healthPreparation.allowed) {
		await releaseSelected(selectedRoute);
		return healthDeferredResult(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const healthStart = startRouteHealthTrial(context);
	if (!healthStart.allowed) {
		await releaseSelected(selectedRoute);
		return healthDeferredResult(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
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
		if (
			failureKind &&
			fallbackCapability &&
			context._activeRouteHealth?.claimStarted !== true
		) {
			const fallbackPower = readQueueHostPower({
				hostPowerProbe: context.hostPowerProbe,
				execFn: context.hostPowerExecFn,
				timeoutMs: context.hostPowerProbeTimeoutMs,
				hostPowerPolicyEnabled: context.hostPowerPolicyEnabled,
				onStatus: context.onStatus,
				taskId: task.id,
			});
			if (fallbackPower.state === HOST_POWER_STATES.BATTERY) {
				await releaseSelected(selectedRoute);
				return policyDeferredTaskResult(
					task,
					fallbackPower,
					context.taskFileSha256,
				);
			}
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
						diagnosticCode: brokerExecution.diagnosticCode,
						exitCode: brokerExecution.exitCode,
						signal: brokerExecution.signal,
						failurePhase: brokerExecution.failurePhase,
						diagnosticOrigin: brokerExecution.diagnosticOrigin,
						diagnosticEvidenceAvailable:
							brokerExecution.diagnosticEvidenceAvailable,
						diagnosticRef: brokerExecution.diagnosticRef,
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
				attemptCleanupContext = executionCleanupContext(
					context,
					task,
					invocationDescriptor.descriptor_identity,
				);
				context._activeTaskHelperContext = mergeAttemptCleanupContext(
					attemptCleanupContext,
					{ operation: "helper" },
				);
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
				context._activeRouteHealth = null;
				const fallbackHealth = prepareRouteHealthTrial(
					context,
					task,
					routeResult,
					invocationDescriptor,
				);
				if (
					!fallbackHealth.allowed ||
					!startRouteHealthTrial(context).allowed
				) {
					await releaseSelected(fallbackRoute);
					return healthDeferredResult(
						task,
						routeResult,
						invocationDescriptor,
						requiredCapability,
					);
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
		silenceTimedOut: brokerExecution.silenceTimedOut === true,
		outcome: brokerExecution.outcome ?? null,
		cleanupFailed: brokerExecution.cleanupFailed === true,
		error: brokerExecution.reason ?? null,
		errorKind: brokerExecution.errorKind ?? brokerExecution.outcome,
		diagnosticCode: brokerExecution.diagnosticCode ?? null,
		exitCode: brokerExecution.exitCode ?? null,
		signal: brokerExecution.signal ?? null,
		failurePhase: brokerExecution.failurePhase ?? null,
		diagnosticOrigin: brokerExecution.diagnosticOrigin ?? null,
		diagnosticEvidenceAvailable:
			brokerExecution.diagnosticEvidenceAvailable === true,
		diagnosticRef:
			brokerExecution.diagnosticEvidenceAvailable === true &&
			typeof brokerExecution.diagnosticRef === "string" &&
			/^diagnostic:[a-f0-9]{32}$/u.test(brokerExecution.diagnosticRef)
				? brokerExecution.diagnosticRef
				: null,
		cleanupStage: brokerExecution.cleanupStage ?? null,
		servedModelVerified: brokerExecution.servedModelVerified ?? null,
		progress: brokerExecution.progress ?? null,
		// The broker relays a sanitized verdict and never raw provider bytes, so
		// there is no output to read back on this path; a route that produced no
		// verdict relays null and the review result resolves to an explicit
		// `missing` instead of inheriting a placeholder.
		reviewResult: brokerExecution.reviewResult ?? null,
	};
	context._activeProviderExecutionSucceeded = execution.success === true;
	context._activeCompletionLifecycleReceipt =
		brokerExecution.completionContinuationProof ?? null;
	if (execution.cleanupFailed === true && execution.success) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			reason: "provider cleanup is uncertain; recovery required",
			cleanupStage: execution.cleanupStage ?? null,
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			...survivingProviderFields(execution),
		};
	}
	if (isStructuredReviewExecution(task, execution)) {
		context.queueBackend?.afterRun?.(
			context.workingContainerName,
			context.projectPath,
			{ onStatus: context.onStatus },
		);
		const review = reviewTaskResult(
			task,
			execution,
			routeResult,
			invocationDescriptor,
			requiredCapability,
			resolvedTargetId,
		);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: review.result,
			reviewResult: review.reviewResult,
			...(review.success
				? {}
				: { errorKind: review.errorKind, reason: review.reason }),
			...survivingProviderFields(execution),
		});
		return review;
	}
	if (!execution.success) {
		if (execution.silenceTimedOut) {
			await record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: "silence_timeout",
				errorKind: "silence_timeout",
				reason: execution.error ?? "provider made no substantive progress",
				progress: execution.progress,
				...reviewFailureFields(task, execution),
			});
			return {
				...descriptorReceiptFields(invocationDescriptor),
				taskId: task.id,
				success: false,
				provider: routeResult.provider,
				model: routeResult.model ?? null,
				requiredCapability,
				resolvedTargetId,
				result: "silence_timeout",
				error: execution.error ?? "provider made no substantive progress",
				errorKind: "silence_timeout",
				progress: execution.progress,
				silenceTimedOut: true,
				...reviewFailureFields(task, execution),
			};
		}
		if (!execution.timedOut) {
			let captureEvidence = null;
			if (retainsFailureDiff(task)) {
				context.onStatus?.({
					phase: "execution",
					event: "diff_capture_started",
					status: `Task ${task.id} failure diff capture started`,
					taskId: task.id,
				});
				try {
					captureEvidence = await captureDiffWithEvidenceAsync(
						adapter,
						context.workingContainerName,
						{
							executionBackend: bindAttemptHelperBackend(
								context.executionBackend,
								attemptCleanupContext,
							),
							taskBase: context._activeTaskBase,
							signal: context.signal,
						},
					);
				} catch {
					captureEvidence = { status: "transport_failed", diff: null };
				}
				context.onStatus?.({
					phase: "execution",
					event: "diff_capture_completed",
					status: `Task ${task.id} failure diff capture ${captureEvidence.status}`,
					taskId: task.id,
					captureStatus: captureEvidence.status,
					byteCount: captureEvidence.diff?.length ?? 0,
				});
			}
			await record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: "execution_failed",
				errorKind: execution.errorKind ?? null,
				reason: execution.error ?? routeResult.reason,
				diagnosticCode: execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupStage: execution.cleanupStage,
				...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
				...reviewFailureFields(task, execution),
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
				diagnosticCode: execution.diagnosticCode,
				exitCode: execution.exitCode,
				signal: execution.signal,
				failurePhase: execution.failurePhase,
				diagnosticOrigin: execution.diagnosticOrigin,
				diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
				diagnosticRef: execution.diagnosticRef,
				cleanupStage: execution.cleanupStage,
				...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
				...reviewFailureFields(task, execution),
				...(captureEvidence?.diff ? { partialDiff: captureEvidence.diff } : {}),
			};
		}

		let captureEvidence = null;
		if (retainsFailureDiff(task)) {
			context.onStatus?.({
				phase: "execution",
				event: "diff_capture_started",
				status: `Task ${task.id} partial diff capture started`,
				taskId: task.id,
			});
			try {
				captureEvidence = await captureDiffWithEvidenceAsync(
					adapter,
					context.workingContainerName,
					{
						executionBackend: bindAttemptHelperBackend(
							context.executionBackend,
							attemptCleanupContext,
						),
						taskBase: context._activeTaskBase,
						signal: context.signal,
					},
				);
			} catch {
				captureEvidence = { status: "transport_failed", diff: null };
			}
		}
		const partialDiff = captureEvidence?.diff ?? null;
		const captureStatus = captureEvidence?.status;
		const captureFailed =
			captureEvidence !== null &&
			captureStatus !== "captured" &&
			captureStatus !== "empty";
		if (captureEvidence !== null) {
			context.onStatus?.({
				phase: "execution",
				event: "diff_capture_completed",
				status: `Task ${task.id} partial diff capture ${captureStatus}`,
				taskId: task.id,
				captureStatus,
				byteCount: partialDiff?.length ?? 0,
			});
		}
		const cleanupFailed = execution.cleanupFailed === true;
		const resultName = cleanupFailed
			? "execution_timed_out_cleanup_failed"
			: captureFailed
				? "execution_timed_out_capture_failed"
				: "execution_timed_out";
		const errorKind =
			(cleanupFailed && "provider_cleanup_failed") ||
			(captureFailed && "diff_capture_failed") ||
			execution.errorKind ||
			null;
		const safeTimeoutFailure = sanitizeFailureMetadata({
			taskId: task.id,
			result: resultName,
			errorKind,
			timedOut: true,
			diagnosticCode: execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupStage: execution.cleanupStage,
		});
		const error = cleanupFailed
			? (execution.error ??
				safeTimeoutFailure?.reason ??
				"provider cleanup failed after timeout")
			: captureFailed
				? (safeTimeoutFailure?.reason ?? "diff capture failed after timeout")
				: (execution.error ?? null);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: resultName,
			errorKind: safeTimeoutFailure?.errorKind ?? errorKind,
			...(safeTimeoutFailure
				? { reasonCode: safeTimeoutFailure.reasonCode }
				: {}),
			reason: error ?? routeResult.reason,
			...(captureStatus ? { captureStatus } : {}),
			...reviewFailureFields(task, execution),
			diagnosticCode:
				safeTimeoutFailure?.diagnosticCode ?? execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupStage: execution.cleanupStage,
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
			errorKind: safeTimeoutFailure?.errorKind ?? errorKind,
			...(safeTimeoutFailure
				? {
						reasonCode: safeTimeoutFailure.reasonCode,
						reason: safeTimeoutFailure.reason,
					}
				: {}),
			timedOut: true,
			diagnosticCode:
				safeTimeoutFailure?.diagnosticCode ?? execution.diagnosticCode,
			exitCode: execution.exitCode,
			signal: execution.signal,
			failurePhase: execution.failurePhase,
			diagnosticOrigin: execution.diagnosticOrigin,
			diagnosticEvidenceAvailable: execution.diagnosticEvidenceAvailable,
			diagnosticRef: execution.diagnosticRef,
			cleanupFailed,
			cleanupStage: execution.cleanupStage,
			...(captureStatus ? { captureStatus } : {}),
			...reviewFailureFields(task, execution),
			...(partialDiff ? { partialDiff } : {}),
		};
	}
	context.queueBackend?.afterRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	context.onStatus?.({
		phase: "execution",
		event: "diff_capture_started",
		status: `Task ${task.id} diff capture started`,
		taskId: task.id,
	});
	const captureEvidence = await captureDiffWithEvidenceAsync(
		adapter,
		context.workingContainerName,
		{
			executionBackend: bindAttemptHelperBackend(
				context.executionBackend,
				attemptCleanupContext,
			),
			taskBase: context._activeTaskBase,
			signal: context.signal,
		},
	);
	const diff = captureEvidence.diff;
	context.onStatus?.({
		phase: "execution",
		event: "diff_captured",
		status: "Diff captured",
		taskId: task.id,
		provider: routeResult.provider,
		model: invocationDescriptor.selector,
		byteCount: diff ? diff.length : 0,
		captureStatus: captureEvidence.status,
	});
	if (!diff && task.requiredPaths === null) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "success_no_diff",
			reason: safeSuccessfulRouteReason(routeResult.reason),
			...survivingProviderFields(execution),
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
			...servedModelVerificationFields(execution),
			...survivingProviderFields(execution),
		};
	}
	const gateResult =
		dirtyOverlayIntegrationGate(context) ??
		context.integrationGate(diff, context.projectPath, {
			requiredPaths: task.requiredPaths,
			allowSensitiveManifests:
				task.type === "implementation" && task.allowManifests === true,
			integrationIntent: checkpointIntegrationIntent(context, task, diff),
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		});
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const success = Boolean(gateResult?.success) || alreadyApplied;
	const terminalResult = success ? "success" : "integration_failed";
	const safeGateFailure = success
		? null
		: integrationFailureMetadata(
				task.id,
				diff,
				gateResult?.credentialFlagged,
				gateResult,
				!diff && Boolean(context._activeTaskTranscript),
			);
	await record({
		provider: routeResult.provider,
		model: routeResult.model ?? "unknown",
		taskId: task.id,
		result: terminalResult,
		captureStatus: captureEvidence.status,
		...(Array.isArray(gateResult?.missingPaths)
			? { missingPaths: [...gateResult.missingPaths] }
			: {}),
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...survivingProviderFields(execution),
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
		...servedModelVerificationFields(execution),
		...survivingProviderFields(execution),
		...(alreadyApplied ? { alreadyApplied: true } : {}),
		...(safeGateFailure ?? {}),
		...(!success && !gateResult?.credentialFlagged
			? {
					partialDiff: diff,
					...(diff
						? {}
						: { gateEvidence: context._activeTaskTranscript ?? null }),
				}
			: {}),
	};
}

/**
 * Awaiting queue entrypoint for callers that own an async worker. This is a
 * deliberately small sibling of runQueue: it keeps the established sync API
 * untouched while making the per-task provider lifecycle genuinely awaitable.
 * Workspace creation/seeding is delegated to the same injectable lifecycle
 * dependencies; callers with a supplied working container avoid VM setup.
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
		identityTaskIds: [],
		platform,
		runOptions,
		queueIdentity,
		projectRevision,
		runId,
		dependencies,
		onStatus: emitStatus,
		deferSlotAcquisition: true,
	});
	const {
		queueBackend,
		dirtyOverlayReceipt,
		selectedPlatform,
		tasks,
		checkpoint,
		taskFileSha256,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	if (launch.policyDeferred) {
		emitStatus?.({
			phase: "policy",
			event: "queue_deferred",
			status: "Queue deferred while host is on battery power",
			taskId: launch.policyDeferred.nextTaskId,
			diagnosticCode: launch.policyDeferred.diagnosticCode,
		});
		return policyDeferredQueueResult(launch, checkpointPath);
	}
	ensureRetryCheckpoint(checkpoint);
	ensureProviderAttemptAllocations(checkpoint);
	const slotLease = await acquireQueueSlotAsync({
		queueBackend,
		selectedPlatform,
		runId,
		dependencies,
		onStatus: emitStatus,
	});
	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	let queueResult = null;
	try {
		if (!workingContainerName) {
			assertDirtyOverlayReceiptCurrent(
				projectPath,
				dirtyOverlayReceipt,
				"immediately before allocation",
			);
			queueBackend.ensureAgentContainer();
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: dependencies.onStatus,
			});
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
			queueBackend.seed(workingContainerName, projectPath, {
				dirtyOverlayReceipt,
			});
			queueBackend.afterCreate?.(workingContainerName, projectPath, {
				onStatus: dependencies.onStatus,
			});
		}
	} catch (error) {
		if (ownsWorkingContainer && workingContainerName) {
			try {
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueueAsync: before_remove hook failed: ${hookError.message}`,
					);
				}
				queueBackend.destroy(workingContainerName);
			} catch {
				// Preserve the bootstrap error.
			}
		}
		releaseQueueSlot(queueBackend, slotLease);
		throw error;
	}
	checkpoint.taskBases ??= {};
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
		ownsWorkingContainer,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		platform: selectedPlatform,
		goldenImageVerifiedProviders: dependencies.goldenImageVerifiedProviders,
		healthDecision: resolveQueueHealthDecision(dependencies),
		onHealthDecision: dependencies.onHealthDecision,
		checkpoint,
		dirtyOverlayReceipt,
		checkpointPath,
		taskFileSha256,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
		onStatus: dependencies.onStatus ?? null,
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
		onTaskRouted: dependencies.onTaskRouted ?? null,
		onTaskHeartbeat: dependencies.onTaskHeartbeat ?? null,
		checkIgnoredPath: dependencies.checkIgnoredPath,
		hostPowerProbe: dependencies.hostPowerProbe,
		hostPowerExecFn: dependencies.hostPowerExecFn,
		hostPowerProbeTimeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		exclude: mergeRetryExclusions(
			effectiveExclude,
			checkpoint.quarantinedTargetIds,
		),
		only: effectiveOnly,
		signal: dependencies.signal,
		onPoll: dependencies.onPoll,
		resolveDescriptor: dependencies.resolveDescriptor,
		runId: queueBackend.taskBaseRunId ?? runId,
		snapshotSource: dependencies.snapshotSource ?? "gradus-v2",
		completionContinuation: dependencies.completionContinuation ?? {
			enabled: false,
		},
		completionContinuationMode: "unavailable",
		now: dependencies.now ?? Date.now,
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
	};
	const results = [];
	const deferredTaskIds = [];
	let policyDeferred = null;
	// Retained only so a teardown failure can name the failure it displaces.
	let inFlightError = null;
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
			const selection = selectNextQueueTask(tasks, checkpoint, {
				selectedTaskIds: effectiveTaskIds,
				resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
				excludedTaskIds: attemptedTaskIds,
				retryTaskId: resumedRetryTaskId,
			});
			const task = selection.task;
			if (!task) break;
			resumedRetryTaskId = selection.retryTaskId;
			attemptedTaskIds.clear();
			for (const taskId of selection.excludedTaskIds)
				attemptedTaskIds.add(taskId);
			dependencies.onTaskStart?.(task);
			const retryState =
				checkpoint.retryState?.taskId === task.id
					? checkpoint.retryState
					: null;
			const priorExtraAllocation = ensureProviderAttemptAllocations(
				checkpoint,
			).find((entry) => entry?.taskId === task.id);
			let result;
			if (!retryState && priorExtraAllocation) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason: "persisted extra provider invocation already consumed",
				};
			} else if (retryState && !hasTrustedQuotaRetryEvidence(retryState)) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					resolvedTargetId: retryState.resolvedTargetId ?? null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason:
						"historical retry state lacks trusted quota diagnostic provenance",
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
					startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
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
			if (result?.result === "policy_deferred") {
				policyDeferred = result.policyDeferred;
				deferredTaskIds.push(result.taskId);
				break;
			}
			decorateDirtyOverlayResult(result, context);
			if (
				!retryState &&
				result._routeHealthTrialStarted !== true &&
				result.extraProviderInvocationUsed !== true &&
				isQuotaRetryCandidate(result, ownsWorkingContainer) &&
				allocateExtraProviderInvocation(
					checkpoint,
					checkpointPath,
					task.id,
					"quota_fallback",
				)
			) {
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
					diagnosticCode: result.diagnosticCode,
					diagnosticOrigin: result.diagnosticOrigin,
					diagnosticEvidenceAvailable: result.diagnosticEvidenceAvailable,
					diagnosticRef: result.diagnosticRef,
					failurePhase: result.failurePhase,
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
					startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
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
			recordExtraProviderInvocationResult(checkpoint, checkpointPath, task.id);
			if (isRouteHealthDeferredResult(result)) {
				deferredTaskIds.push(result.taskId);
				reportRouteHealthDeferred(
					result,
					dependencies.onResult,
					dependencies.onStatus,
				);
				continue;
			}
			const resultAttempt = reserveTaskAttempt(
				checkpoint,
				checkpointPath,
				result.taskId,
			);
			if (result.partialDiff) {
				try {
					result.partialDiffPath = savePartialDiff(
						checkpointPath,
						result.taskId,
						result.partialDiff,
						resultAttempt,
					);
				} catch {
					result.partialDiffPath = null;
				}
				// Raw diff text is an in-memory transient only; never expose it to
				// onResult or persist it in checkpoint.json.
				result.partialDiff = undefined;
			}
			if (result.gateEvidence) {
				try {
					result.gateEvidencePath = saveGateEvidence(
						checkpointPath,
						result.taskId,
						result.gateEvidence,
						resultAttempt,
					);
				} catch {
					result.gateEvidencePath = null;
				}
				// Same rule as the diff above: host-only bytes, never onResult.
				result.gateEvidence = undefined;
			}
			persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
			results.push(result);
			dependencies.onResult?.(result);
			const safeFailure = failureMetadataFor(result, result.partialDiffPath);
			checkpoint.results.push({
				taskId: result.taskId,
				attempt: resultAttempt,
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
				...(typeof result.servedModelVerified === "boolean"
					? { servedModelVerified: result.servedModelVerified }
					: {}),
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				// Presence is the signal: these are written only when the provider
				// outlived its kill, so a resumed run and `switchyard status` can see
				// that an otherwise successful task left a process in the guest.
				...(result.cleanupFailed === true
					? {
							cleanupFailed: true,
							cleanupStage: result.cleanupStage ?? null,
						}
					: {}),
				success: result.success,
				dirtyOverlayReceiptHash: result.dirtyOverlayReceiptHash ?? null,
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
			let haltResult =
				result.cleanupFailed === true ? providerCleanupHalt(result) : null;
			if (!haltResult)
				haltResult = commitOrResetWorkingContainer(result, {
					ownsWorkingContainer,
					workingContainerName,
					stopOnFailure: effectiveStopOnFailure,
					commitWorkingTreeFn: queueBackend.commit,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus: dependencies.onStatus,
					logPrefix: "runQueueAsync: ",
				});
			if (!haltResult) {
				haltResult = await finalizeTaskBaseAsync(
					context,
					result.taskId,
					checkpoint,
					checkpointPath,
				);
			}
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
			if (
				!result.success &&
				!isRouteHealthDeferredResult(result) &&
				effectiveStopOnFailure
			)
				break;
		}
		if (checkpoint.version === CHECKPOINT_VERSION)
			releaseCheckpointOwnership(checkpointPath, checkpoint);
		queueResult = {
			results,
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			deferredTaskIds,
			policyDeferred,
			checkpointPath,
			ledgerWritesSettled: Promise.resolve(),
			quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
			retryState: checkpoint.retryState,
			retryTransitionId: checkpoint.retryTransitionId,
		};
		return queueResult;
	} catch (error) {
		inFlightError = error;
		throw error;
	} finally {
		if (uninstallSignalCleanup) uninstallSignalCleanup();
		let cleanupError = null;
		try {
			if (ownsWorkingContainer) {
				// The detached worker must durably mark cleanup as pending before
				// destroying the workspace. This gives its run-store telemetry a
				// clear lifecycle boundary and prevents a late heartbeat from
				// describing a provider that no longer has a workspace.
				try {
					await dependencies.onCleanupStarted?.();
				} catch (error) {
					console.error(
						`runQueueAsync: cleanup-started hook failed: ${error?.message ?? "unknown error"}`,
					);
				}
				try {
					try {
						queueBackend.beforeRemove?.(workingContainerName, projectPath);
					} catch (hookError) {
						console.error(
							`runQueueAsync: before_remove hook failed: ${hookError.message}`,
						);
					}
					queueBackend.destroy(workingContainerName);
				} catch {
					// Never retain or forward the backend error: it may contain host paths
					// or provider-controlled text. The fixed event and error below carry
					// the only evidence terminal finalization needs.
					console.error("runQueueAsync: queue backend teardown failed");
					try {
						dependencies.onStatus?.({
							phase: "cleanup",
							event: "cleanup_failed",
							status: "Cleanup failed; recovery required",
						});
					} catch {
						// A progress callback cannot replace the closed cleanup failure.
					}
					cleanupError = new QueueCleanupError(queueResult, inFlightError);
				}
			}
		} finally {
			releaseQueueSlot(queueBackend, slotLease);
		}
		if (cleanupError) {
			// biome-ignore lint/correctness/noUnsafeFinally: teardown failure must override both a nominal queue return and an in-flight failure so callers cannot finalize success over a leaked workspace; the displaced failure's diagnostic code rides along on cleanupError
			throw cleanupError;
		}
	}
}

/**
 * Execute one task by launching and polling a headless orchestrator job.
 * @param {{id: string, title: string, description: string}} task
 * @param {object} context
 * @returns {Promise<object>}
 */
async function executeTaskWithOrchestratorUnsafe(task, context) {
	context._activeRouteHealth = null;
	context._activeProviderExecutionSucceeded = false;
	context._activeCompletionLifecycleReceipt = null;
	const executor = resolveTaskExecutor(task);
	const requiredCapability = resolveTaskRequiredCapability(task);
	if (executor !== "switchyard") {
		return nonSwitchyardExecutorResult(task, executor, requiredCapability);
	}
	const overlayFailure = dirtyOverlayResult(task, context, requiredCapability);
	if (overlayFailure) return overlayFailure;
	const checkIgnored = context.checkIgnoredPath ?? findIgnoredDeclaredPath;
	const ignoredPath = checkIgnored(
		task.requiredPaths ?? task.files,
		context.projectPath,
	);
	if (ignoredPath) {
		return declaredPathNotSeededResult(task, requiredCapability);
	}
	const hostPower = readQueueHostPower({
		hostPowerProbe: context.hostPowerProbe,
		execFn: context.hostPowerExecFn,
		timeoutMs: context.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: context.hostPowerPolicyEnabled,
		onStatus: context.onStatus,
		taskId: task.id,
	});
	if (hostPower.state === HOST_POWER_STATES.BATTERY) {
		return policyDeferredTaskResult(task, hostPower, context.taskFileSha256);
	}
	const routeResult = context.route({
		requiredCapability,
		availableProviders: Object.keys(context.adapters ?? {}),
		exclude: context.exclude,
		only: context.only,
		platform: context.platform,
		...(context.goldenImageVerifiedProviders !== undefined
			? { goldenImageVerifiedProviders: context.goldenImageVerifiedProviders }
			: {}),
		...(context.healthDecision
			? { healthDecision: context.healthDecision }
			: {}),
		...(context.onHealthDecision
			? { onHealthDecision: context.onHealthDecision }
			: {}),
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

	const captureCleanupContext = executionCleanupContext(
		context,
		task,
		invocationDescriptor.descriptor_identity,
	);
	let jobId;
	try {
		context.queueBackend?.beforeRun?.(
			context.workingContainerName,
			context.projectPath,
			{ onStatus: context.onStatus },
		);
		if (!(await prepareTaskBaseAsync(context, task, captureCleanupContext))) {
			await record({
				provider: routeResult.provider,
				model: routeResult.model ?? "unknown",
				taskId: task.id,
				result: "task_base_capture_failed",
				errorKind: "diff_capture_failed",
				reason: "immutable task base capture failed",
			});
			return taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
		}
		const healthPreparation = prepareRouteHealthTrial(
			context,
			task,
			routeResult,
			invocationDescriptor,
		);
		if (!healthPreparation.allowed)
			return healthDeferredResult(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
		const healthStart = startRouteHealthTrial(context);
		if (!healthStart.allowed)
			return healthDeferredResult(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			);
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
			prompt: taskPromptForAttempt(task, context._completionRequirements),
			workingContainerName: context.workingContainerName,
			taskBase: context._activeTaskBase,
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
		onPoll: (poll) => {
			const progress = boundedProgressProjection(poll?.status?.progress);
			if (progress) {
				context.onStatus?.({
					phase: "execution",
					event: "execution_progress",
					status: "orchestrator progress",
					taskId: task.id,
					progress,
				});
			}
			context.onPoll?.(poll);
		},
	});

	if (waited.state !== "done") {
		const progress = boundedProgressProjection(waited.status?.progress);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: `orchestrator_${waited.state}`,
			reason: waited.timedOut
				? "orchestrator timed out"
				: "orchestrator ended before done",
			...(progress ? { progress } : {}),
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
			...(progress ? { progress } : {}),
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
	const progress = boundedProgressProjection(jobResult?.progress);
	if (jobResult?.cleanupFailed === true) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			reason: "provider cleanup is uncertain; recovery required",
			cleanupStage: jobResult.cleanupStage ?? null,
			...(progress ? { progress } : {}),
		});
		return {
			...descriptorReceiptFields(invocationDescriptor),
			taskId: task.id,
			success: false,
			provider: routeResult.provider,
			model: routeResult.model ?? null,
			requiredCapability,
			resolvedTargetId,
			result: "provider_cleanup_failed",
			errorKind: "provider_cleanup_failed",
			cleanupFailed: true,
			cleanupStage: jobResult.cleanupStage ?? null,
			...(progress ? { progress } : {}),
		};
	}
	if (isStructuredReviewExecution(task, jobResult)) {
		context.queueBackend?.afterRun?.(
			context.workingContainerName,
			context.projectPath,
			{ onStatus: context.onStatus },
		);
		const review = reviewTaskResult(
			task,
			jobResult,
			routeResult,
			invocationDescriptor,
			requiredCapability,
			resolvedTargetId,
		);
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: review.result,
			reviewResult: review.reviewResult,
			...(progress ? { progress } : {}),
			...(review.success
				? {}
				: { errorKind: review.errorKind, reason: review.reason }),
		});
		return { ...review, ...(progress ? { progress } : {}) };
	}
	if (!jobResult?.success) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "execution_failed",
			reason: jobResult?.error ?? "orchestrator job failed",
			...(progress ? { progress } : {}),
			...reviewFailureFields(task, jobResult),
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
			...(progress ? { progress } : {}),
			...reviewFailureFields(task, jobResult),
		};
	}
	context._activeProviderExecutionSucceeded = true;
	context._activeCompletionLifecycleReceipt =
		jobResult.completionContinuationProof ?? null;

	context.queueBackend?.afterRun?.(
		context.workingContainerName,
		context.projectPath,
		{ onStatus: context.onStatus },
	);
	if (
		jobResult.taskBase !== undefined &&
		!taskBaseMatches(jobResult.taskBase, context._activeTaskBase)
	) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "task_base_capture_failed",
			errorKind: "diff_capture_failed",
			reason: "immutable task base capture failed",
		});
		return taskBaseFailure(
			task,
			routeResult,
			invocationDescriptor,
			requiredCapability,
		);
	}
	const adapter = selectAdapter(
		routeResult.resolved_harness ?? routeResult.provider,
		context.adapters,
	);
	context._activeCompletionAdapter = adapter;
	context._activeCompletionRoute = structuredClone(routeResult);
	let captureEvidence;
	try {
		captureEvidence = await captureDiffWithEvidenceAsync(
			adapter,
			context.workingContainerName,
			{
				executionBackend: bindAttemptHelperBackend(
					context.executionBackend,
					captureCleanupContext,
				),
				taskBase: context._activeTaskBase,
				signal: context.signal,
				onStatus: context.onStatus,
			},
		);
	} catch {
		captureEvidence = { status: "transport_failed", diff: null };
	}
	if (!["captured", "empty"].includes(captureEvidence.status)) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "diff_capture_failed",
			errorKind: "diff_capture_failed",
			reason: "authoritative host diff capture failed",
		});
		return {
			...taskBaseFailure(
				task,
				routeResult,
				invocationDescriptor,
				requiredCapability,
			),
			result: "diff_capture_failed",
			reason: "authoritative host diff capture failed",
			captureStatus: captureEvidence.status,
		};
	}
	const diff =
		captureEvidence.status === "captured" ? captureEvidence.diff.trim() : "";
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
			...(progress ? { progress } : {}),
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
			...(progress ? { progress } : {}),
		};
	}

	const gateResult =
		dirtyOverlayIntegrationGate(context) ??
		context.integrationGate(diff, context.projectPath, {
			requiredPaths: task.requiredPaths,
			allowSensitiveManifests:
				task.type === "implementation" && task.allowManifests === true,
			integrationIntent: checkpointIntegrationIntent(context, task, diff),
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		});
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const success = Boolean(gateResult?.success) || alreadyApplied;
	const terminalResult = success ? "success" : "integration_failed";
	const safeGateFailure = success
		? null
		: integrationFailureMetadata(
				task.id,
				diff,
				gateResult?.credentialFlagged,
				gateResult,
			);
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
			...(safeGateFailure?.diagnosticCode
				? { diagnosticCode: safeGateFailure.diagnosticCode }
				: {}),
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
		...(progress ? { progress } : {}),
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
		captureStatus: captureEvidence.status,
		...(Array.isArray(gateResult?.missingPaths)
			? { missingPaths: [...gateResult.missingPaths] }
			: {}),
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

function resolveQueueHealthDecision(dependencies) {
	if (dependencies.healthDecision) return dependencies.healthDecision;
	const environmentMode = process.env.SWITCHYARD_ROUTE_HEALTH_MODE;
	return createDefaultRouteHealthDecision({
		healthStateRoot:
			dependencies.healthStateRoot ??
			process.env.SWITCHYARD_ROUTE_HEALTH_STATE_ROOT,
		mode: dependencies.healthMode ?? environmentMode ?? "shadow",
		qualifiedProviders:
			dependencies.goldenImageVerifiedProviders ??
			GOLDEN_IMAGE_VERIFIED_PROVIDERS,
		goldenImageReference:
			dependencies.goldenImage ??
			process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE ??
			"golden-image-unconfigured",
	});
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

function boundedProgressProjection(value) {
	if (!value || typeof value !== "object") return null;
	return createProgressSnapshot({
		stage: value.stage,
		elapsedMs: value.elapsedMs,
		lastSubstantiveProgressAt: value.lastSubstantiveProgressAt,
		lastSubstantiveProgressAgeMs: value.lastSubstantiveProgressAgeMs,
		stdoutBytes: value.counters?.stdoutBytes,
		stderrBytes: value.counters?.stderrBytes,
		pollCount: value.counters?.polls,
		progressCount: value.counters?.progressEvents,
		outcome: value.outcome,
	});
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
	vibe: {
		execute: executeVibe,
		executeAsync: executeVibeAsync,
		captureDiff: captureVibeDiff,
		captureDiffAsync: captureVibeDiffAsync,
		captureDiffDetailed: captureVibeDiffDetailed,
		captureDiffDetailedAsync: captureVibeDiffDetailedAsync,
	},
};

/**
 * Bind an existing async provider adapter to the complete broker identity.
 * The returned identity is checked by the broker before adapter execution.
 */
/**
 * Derive a review task's closed verdict here, where the provider's own output
 * is still in hand and before the bounded launcher shape drops it. A `missing`
 * result means there was nothing to derive, and stays null so the reader on the
 * far side of the broker records it as missing rather than re-deriving it into
 * a provider failure that never happened.
 */
function launchReviewResult(execution) {
	const derived = reviewResultFromExecution(execution);
	return derived.reason === "missing" ? null : derived;
}

export function createBrokerAdapterLauncher({
	adapter,
	executionBackend,
	workingContainerName,
	prompt,
	timeoutMs = PROVIDER_EXECUTION_TIMEOUT_MS,
	silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS,
	onTranscript = null,
	cleanupContext = null,
	deriveReviewResult = false,
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
		onProgress,
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
		const requestCleanupContext = mergeAttemptCleanupContext(cleanupContext, {
			taskId: String(request.taskId),
			attemptId: cleanupContext?.attemptId ?? request.attemptId ?? "attempt-1",
			descriptorIdentity: invocationDescriptor.descriptor_identity,
			operation: "provider",
		});
		const execution = await adapter.executeAsync(
			typeof prompt === "string" && prompt.length > 0 ? prompt : request.taskId,
			workingContainerName,
			{
				model: route.model,
				timeoutMs,
				silenceTimeoutMs,
				executionBackend: bindAttemptExecutionBackend(
					executionBackend,
					requestCleanupContext,
				),
				cleanupContext: requestCleanupContext,
				signal,
				onStatus: onAdapterStatus,
				onPoll,
				onProgress,
				invocationDescriptor,
				descriptorIdentity: invocationDescriptor.descriptor_identity,
				descriptorHarness: route.harness,
				resolvedTargetId: route.resolvedTarget,
			},
		);
		// The bounded return shape below stays closed. The raw transcript is
		// handed back in-process instead of crossing it, so an evidence-free
		// gate rejection still has the provider's own account behind it.
		onTranscript?.(execution?.output);
		return {
			success: execution?.success === true,
			cancelled: signal?.aborted === true,
			reason: execution?.error ?? null,
			actualConsumption: execution?.actualConsumption,
			timedOut: execution?.timedOut === true,
			silenceTimedOut: execution?.silenceTimedOut === true,
			outcome: execution?.outcome ?? null,
			// The verdict, not the transcript it was parsed out of. Omitting it here
			// left every review dispatched through the broker with no result to act
			// on, so each one terminated as an undiagnosed `review_unavailable`.
			reviewResult: deriveReviewResult ? launchReviewResult(execution) : null,
			cleanupFailed: execution?.cleanupFailed === true,
			// Which kill step failed, bounded to the backend-owned vocabulary.
			// Omitting it here left `execution.cleanupStage` permanently null on
			// the async path, so a cleanup failure was recorded without naming
			// the stage that failed - the fact that makes it actionable.
			cleanupStage: CLEANUP_STAGES.has(execution?.cleanupStage)
				? execution.cleanupStage
				: null,
			failureKind:
				execution?.failureKind === "transient" ||
				execution?.failureKind === "provider"
					? execution.failureKind
					: null,
			errorKind: BOUNDED_ERROR_KINDS.has(execution?.errorKind)
				? execution.errorKind
				: execution?.errorKind === "silence_timeout"
					? "silence_timeout"
					: null,
			diagnosticCode: execution?.diagnosticCode ?? null,
			exitCode: execution?.exitCode ?? null,
			signal: execution?.signal ?? null,
			failurePhase: execution?.failurePhase ?? null,
			diagnosticOrigin: execution?.diagnosticOrigin ?? null,
			diagnosticEvidenceAvailable:
				execution?.diagnosticEvidenceAvailable === true,
			diagnosticRef:
				typeof execution?.diagnosticRef === "string" &&
				/^diagnostic:[a-f0-9]{32}$/u.test(execution.diagnosticRef)
					? execution.diagnosticRef
					: null,
			diagnosticEvidence: execution?.diagnosticEvidence ?? null,
			// A bounded fact, not the guest-supplied model name: whether the
			// adapter could affirmatively read back what the provider served.
			servedModelVerified:
				execution?.servedModel === undefined
					? null
					: Boolean(execution.servedModel),
			progress: execution?.progress ?? null,
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
			platform,
			goldenImageVerifiedProviders,
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
				platform,
				...(goldenImageVerifiedProviders !== undefined
					? { goldenImageVerifiedProviders }
					: {}),
				...(context.healthDecision
					? { healthDecision: context.healthDecision }
					: {}),
				...(context.onHealthDecision
					? { onHealthDecision: context.onHealthDecision }
					: {}),
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
		platform: context.platform,
		...(context.goldenImageVerifiedProviders !== undefined
			? {
					goldenImageVerifiedProviders: context.goldenImageVerifiedProviders,
				}
			: {}),
		executor: async ({
			request,
			route: selectedRoute,
			invocationDescriptor,
			launcherIdentity,
			signal,
			onStatus,
			onAdapterStatus,
			onPoll,
			onProgress,
			onTaskHeartbeat,
		}) => {
			const adapter = selectAdapter(selectedRoute.harness, adapters);
			if (!adapter) {
				throw new Error(
					`broker route harness '${selectedRoute.harness}' has no runner adapter`,
				);
			}
			const launchResult = await createBrokerAdapterLauncher({
				adapter,
				executionBackend: context.executionBackend,
				workingContainerName: context.workingContainerName,
				prompt: context._activeTaskPrompt,
				timeoutMs: context._activeTaskTimeoutMs,
				deriveReviewResult: context._activeTaskIsReview === true,
				onTranscript: (output) => {
					context._activeTaskTranscript = boundedGateEvidence(output);
				},
				cleanupContext: executionCleanupContext(
					context,
					{ id: request.taskId },
					invocationDescriptor.descriptor_identity,
					request.attemptId ?? null,
				),
			})({
				request,
				route: selectedRoute,
				invocationDescriptor,
				launcherIdentity,
				signal,
				onAdapterStatus,
				onProgress,
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
						processPhase: "provider_transport_running",
						resolvedTargetId: selectedRoute.resolvedTarget,
						descriptorIdentity: invocationDescriptor.descriptor_identity,
						descriptorHarness: selectedRoute.harness,
					};
					onTaskHeartbeat?.(heartbeat);
				},
			});
			const inProcessEvidence = launchResult?.diagnosticEvidence;
			const hasInProcessEvidence =
				inProcessEvidence && typeof inProcessEvidence === "object";
			let diagnosticRef = null;
			if (
				launchResult?.success !== true &&
				hasInProcessEvidence &&
				typeof context.persistDiagnosticArtifact === "function"
			) {
				try {
					const persisted =
						await context.persistDiagnosticArtifact(inProcessEvidence);
					if (
						typeof persisted === "string" &&
						/^diagnostic:[a-f0-9]{32}$/u.test(persisted)
					) {
						diagnosticRef = persisted;
					}
				} catch {
					diagnosticRef = null;
				}
			}
			// Raw streams are producer-local and must not reach the broker result,
			// checkpoint, event, or status projections.
			delete launchResult.diagnosticEvidence;
			if (hasInProcessEvidence) {
				launchResult.diagnosticRef = diagnosticRef;
				launchResult.diagnosticEvidenceAvailable = diagnosticRef !== null;
			} else {
				launchResult.diagnosticRef = null;
				launchResult.diagnosticEvidenceAvailable = false;
			}
			return launchResult;
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

// Generic broker failures are terminal. Peer retries require a future,
// explicitly reviewed closed-enum entry here; prose and provider-supplied
// `failureKind` values never authorize a second provider reservation.
const BROKER_PEER_RETRY_ERROR_KINDS = new Set();

function brokerFailureKind(result) {
	if (result?.outcome !== "failure" || result?.timedOut === true) {
		return null;
	}
	return BROKER_PEER_RETRY_ERROR_KINDS.has(result.errorKind)
		? "transient"
		: null;
}

// `script` must be repeat-safe: execGuest retries a prlctl job misfire, so a
// script can run twice. Both callers are written that way -- the commit guards
// on `git diff --cached --quiet ||` and reset is `--hard` -- and a new one must
// hold that line or pass `prlctlOptions: { retry: false }`.
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
		const providerReasons = Object.entries(rejection.excludedReasons ?? {})
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([provider, reason]) => `${provider}: ${reason}`);
		const reasonDetails = providerReasons.length
			? `; reasons: ${providerReasons.join(", ")}`
			: "";
		return `${capability}: ${rejection.reason} (excluded: ${excluded}${reasonDetails})`;
	});
	return `macOS queue provider preflight failed: ${details.join("; ") || result.reason}`;
}

export function sanitizeQueuePreflightDetail(result) {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
	const isPlainObject = (value) =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	const boundedText = (value, limit = 160) =>
		typeof value === "string"
			? value.replace(/[\p{Cc}]/gu, " ").slice(0, limit)
			: null;
	return {
		reason: boundedText(result?.reason) ?? "unknown",
		rejections: (Array.isArray(result.rejections) ? result.rejections : [])
			.filter(isPlainObject)
			.slice(0, 8)
			.map((rejection) => ({
				capability: boundedText(rejection.capability, 80),
				reason: boundedText(rejection.reason, 160) ?? "unknown",
				...(rejection.selector
					? { selector: boundedText(rejection.selector, 160) }
					: {}),
				...(Array.isArray(rejection.excludedProviders) &&
				rejection.excludedProviders.length
					? {
							excludedProviders: rejection.excludedProviders
								.slice(0, 16)
								.map((provider) => boundedText(provider, 80))
								.filter(Boolean),
						}
					: {}),
				...(isPlainObject(rejection.excludedReasons)
					? {
							excludedReasons: Object.entries(rejection.excludedReasons)
								.slice(0, 16)
								.reduce((reasons, [provider, reason]) => {
									const safeProvider = boundedText(provider, 80);
									const safeReason = boundedText(reason, 160);
									if (safeProvider && safeReason)
										reasons[safeProvider] = safeReason;
									return reasons;
								}, {}),
						}
					: {}),
			})),
	};
}

function queuePreflightDetail(result) {
	return sanitizeQueuePreflightDetail(result);
}

export class QueuePreflightError extends Error {
	constructor(message, detail = null) {
		super(message);
		this.name = "QueuePreflightError";
		this.preflightDetail = sanitizeQueuePreflightDetail(detail);
	}
}

function createDefaultQueuePreflight({ selectedPlatform, dependencies }) {
	if (selectedPlatform !== "macos") return () => ({ ok: true, eligible: true });

	const adapters = dependencies.adapters ?? DEFAULT_ADAPTERS;
	return (input = {}) => {
		const result = preflightMacosQueue({
			...input,
			platform: selectedPlatform,
			availableProviders: Object.keys(adapters),
			...(Object.hasOwn(dependencies, "goldenImageVerifiedProviders")
				? {
						goldenImageVerifiedProviders:
							dependencies.goldenImageVerifiedProviders,
					}
				: {}),
			...(dependencies.preflightReadSnapshot
				? { readSnapshot: dependencies.preflightReadSnapshot }
				: {}),
			...(dependencies.healthDecision
				? { healthDecision: dependencies.healthDecision }
				: {}),
			...(dependencies.onHealthDecision
				? { onHealthDecision: dependencies.onHealthDecision }
				: {}),
		});
		if (!result.ok)
			throw new QueuePreflightError(
				formatQueuePreflightFailure(result),
				queuePreflightDetail(result),
			);
		return result;
	};
}

/**
 * Adapt the Parallels lifecycle's low-level Aqua callbacks to the runner's
 * status contract. The backend deliberately reports its own `type` field so
 * it can be used outside the runner; queue callers receive the established
 * `{phase, event, status}` shape instead.
 *
 * @param {Function|null|undefined} onStatus runner status callback
 * @returns {Function|undefined} backend lifecycle callback
 */
function createQueueBootstrapStatusEmitter(onStatus) {
	if (typeof onStatus !== "function") return undefined;
	return (event) => {
		if (event?.type === "aqua-wait") {
			onStatus({
				phase: "bootstrap",
				event: "aqua_wait",
				status: "Waiting for Aqua session to become ready",
				...(event.uuid !== undefined ? { uuid: event.uuid } : {}),
				...(event.domain !== undefined ? { domain: event.domain } : {}),
				...(event.elapsedMs !== undefined
					? { elapsedMs: event.elapsedMs }
					: {}),
			});
			return;
		}
		if (event?.type === "aqua-ready") {
			onStatus({
				phase: "bootstrap",
				event: "aqua_ready",
				status: "Aqua session ready",
				...(event.uuid !== undefined ? { uuid: event.uuid } : {}),
				...(event.domain !== undefined ? { domain: event.domain } : {}),
			});
			return;
		}
		if (event?.type === "host-readiness") {
			onStatus({
				phase: "bootstrap",
				event: event.event,
				status: event.status,
				...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
				...(event.elapsedMs !== undefined
					? { elapsedMs: event.elapsedMs }
					: {}),
				...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
				...(event.inventoryCount !== undefined
					? { inventoryCount: event.inventoryCount }
					: {}),
			});
			return;
		}
		// Preserve any future backend lifecycle events rather than dropping
		// visibility when the backend grows its status vocabulary.
		onStatus(event);
	};
}

/**
 * Bind queue lifetime operations to one selected execution substrate.
 *
 * `backendFactory` is intentionally synchronous and returns either a backend
 * or a partial queue helper. It is the seam for VM admission and provider
 * preflight.
 */
function queueOwnershipContext({
	projectPath,
	runId,
	taskId = "queue-bootstrap",
	attemptId = "bootstrap",
	purpose = "dispatch",
	processStartIdentity = null,
}) {
	const runStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
	if (!runStoreRoot) {
		throw new Error(
			"macos queue requires SWITCHYARD_RUN_STORE_ROOT for VM ownership metadata",
		);
	}
	if (typeof runId !== "string" || !runId) {
		throw new Error("macos queue requires a runId for VM ownership metadata");
	}
	return {
		resourceRoot: join(resolve(runStoreRoot), "runs", runId, "resources"),
		runId,
		taskId,
		attemptId,
		projectRoot: resolve(projectPath),
		creatorPid: process.pid,
		processStartIdentity,
		purpose,
	};
}

export function createQueueBackend({
	platform = "macos",
	dependencies = {},
	projectPath,
	runId = null,
	runOptions = null,
} = {}) {
	const taskBaseRunId =
		typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)
			? runId
			: `queue-${createHash("sha256")
					.update(String(projectPath ?? "project"))
					.digest("hex")
					.slice(0, 24)}`;
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
			const suppliedReadiness =
				supplied.readiness ?? supplied.executionBackend?.probeHostReadiness;
			return {
				platform: selectedPlatform,
				...supplied,
				taskBaseRunId,
				create: (path, options = {}) =>
					supplied.create(path, {
						...options,
						onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
					}),
				ensureAgentContainer: supplied.ensureAgentContainer ?? (() => {}),
				readiness: (options = {}) => {
					if (typeof suppliedReadiness !== "function") {
						throw new Error(
							"backendFactory must provide readiness() for macOS queue admission",
						);
					}
					return suppliedReadiness.call(
						supplied.readiness ? supplied : supplied.executionBackend,
						{
							...options,
							onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
						},
					);
				},
				provision: supplied.provision ?? (() => null),
				preflight: supplied.preflight ?? configuredQueuePreflight,
				acquireSlot: supplied.acquireSlot ?? (() => null),
				releaseSlot: supplied.releaseSlot ?? (() => {}),
				captureTaskBase:
					supplied.captureTaskBase ??
					((workspaceId, { taskId, ...options } = {}) =>
						captureTaskStartTree(supplied.executionBackend, workspaceId, {
							runId: taskBaseRunId,
							taskId,
							...options,
						})),
				captureTaskBaseAsync:
					supplied.captureTaskBaseAsync ??
					(async (workspaceId, options = {}) =>
						(
							supplied.captureTaskBase ??
							((id, input) =>
								captureTaskStartTreeAsync(supplied.executionBackend, id, {
									runId: taskBaseRunId,
									...input,
								}))
						)(workspaceId, options)),
				validateTaskBase:
					supplied.validateTaskBase ??
					((workspaceId, base, options = {}) =>
						validateTaskStartTree(
							supplied.executionBackend,
							workspaceId,
							base,
							options,
						)),
				validateTaskBaseAsync:
					supplied.validateTaskBaseAsync ??
					(async (workspaceId, base, options = {}) =>
						(
							supplied.validateTaskBase ??
							((id, value, input) =>
								validateTaskStartTreeAsync(
									supplied.executionBackend,
									id,
									value,
									input,
								))
						)(workspaceId, base, options)),
				releaseTaskBase:
					supplied.releaseTaskBase ??
					((workspaceId, base, options = {}) =>
						releaseTaskStartTree(
							supplied.executionBackend,
							workspaceId,
							base,
							options,
						)),
				releaseTaskBaseAsync:
					supplied.releaseTaskBaseAsync ??
					(async (workspaceId, base, options = {}) =>
						(
							supplied.releaseTaskBase ??
							((id, value, input) =>
								releaseTaskStartTreeAsync(
									supplied.executionBackend,
									id,
									value,
									input,
								))
						)(workspaceId, base, options)),
			};
		}
	}

	const executionBackend =
		supplied?.executionBackend ??
		supplied?.backend ??
		dependencies.executionBackend ??
		new ParallelsExecutionBackend({
			goldenImage:
				dependencies.goldenImage ??
				process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE,
			aquaUid:
				dependencies.aquaUid ?? process.env.SWITCHYARD_PARALLELS_AQUA_UID,
			providerUser:
				dependencies.providerUser ??
				process.env.SWITCHYARD_PARALLELS_PROVIDER_USER ??
				"switchyard",
			// Durable record of which golden-image snapshots each clone creates,
			// so a later process can reclaim them after this one dies.
			snapshotSidecarRoot: getVmAdmissionRoot(),
			runId: dependencies.runId ?? process.env.SWITCHYARD_RUN_ID ?? null,
			...(dependencies.hostProcessIdentityProbe
				? {
						hostProcessIdentityProbe: dependencies.hostProcessIdentityProbe,
					}
				: {}),
		});

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
		taskBaseRunId,
		executionBackend,
		ensureAgentContainer: () => {},
		readiness: (options = {}) => {
			if (typeof executionBackend.probeHostReadiness !== "function") {
				throw new Error(
					"Parallels execution backend does not provide host readiness",
				);
			}
			return executionBackend.probeHostReadiness({
				...options,
				onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
			});
		},
		create: (_path, options = {}) => {
			if (!goldenImage) {
				throw new Error(
					"macos queue requires SWITCHYARD_PARALLELS_GOLDEN_IMAGE",
				);
			}
			if (!/^\d+$/u.test(String(aquaUid ?? "")) || Number(aquaUid) <= 0) {
				throw new Error(
					"macos queue requires SWITCHYARD_PARALLELS_AQUA_UID to be a positive numeric uid",
				);
			}
			return executionBackend.create(goldenImage, {
				runId: options.runId ?? runId,
				aquaUid,
				providerUser,
				onStatus: createQueueBootstrapStatusEmitter(options.onStatus),
				// Linked-clone measurement/admission is owned by its later task.
				linked: !!dependencies.linkedCloneMeasurement,
				...(dependencies.linkedCloneMeasurement
					? { linkedCloneMeasurement: dependencies.linkedCloneMeasurement }
					: {}),
				ownershipContext: queueOwnershipContext({
					projectPath: _path,
					runId: options.runId ?? runId,
					taskId: options.taskId ?? "queue-bootstrap",
					attemptId: options.attemptId ?? "bootstrap",
					processStartIdentity: dependencies.processStartIdentity ?? null,
				}),
			});
		},
		// Provider auth is baked into the golden image and survives cloning
		// (verified for codex — see TASKS.md's clone-survival test), so there is
		// no runtime credential-provisioning step; each adapter's own auth
		// check decides at exec time.
		provision: dependencies.provisionCredentials ?? (() => null),
		seed: (workspaceId, path, options = {}) =>
			seedProjectWithBackend(executionBackend, workspaceId, path, options),
		afterCreate: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"after_create",
				options,
			),
		beforeRun: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"before_run",
				options,
			),
		afterRun: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"after_run",
				options,
			),
		beforeRemove: (workspaceId, path, options = {}) =>
			runWorkspaceLifecycleHook(
				executionBackend,
				workspaceId,
				loadWorkspaceLifecycleHooks(path),
				"before_remove",
				options,
			),
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
		captureTaskBase: (workspaceId, { taskId, ...options } = {}) =>
			captureTaskStartTree(executionBackend, workspaceId, {
				runId: taskBaseRunId,
				taskId,
				...options,
			}),
		captureTaskBaseAsync: (workspaceId, { taskId, ...options } = {}) =>
			captureTaskStartTreeAsync(executionBackend, workspaceId, {
				runId: taskBaseRunId,
				taskId,
				...options,
			}),
		validateTaskBase: (workspaceId, base, options = {}) =>
			validateTaskStartTree(executionBackend, workspaceId, base, options),
		validateTaskBaseAsync: (workspaceId, base, options = {}) =>
			validateTaskStartTreeAsync(executionBackend, workspaceId, base, options),
		releaseTaskBase: (workspaceId, base, options = {}) =>
			releaseTaskStartTree(executionBackend, workspaceId, base, options),
		releaseTaskBaseAsync: (workspaceId, base, options = {}) =>
			releaseTaskStartTreeAsync(executionBackend, workspaceId, base, options),
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

function prepareDirtyOverlayReceipt({
	projectPath,
	tasks,
	potentialAttemptTasks,
	runOptions,
	dependencies,
}) {
	if (
		runOptions?.dirtyOverlay !== true &&
		dependencies.dirtyOverlay !== true &&
		!dependencies.dirtyOverlayReceipt
	)
		return null;
	const supplied = dependencies.dirtyOverlayReceipt;
	const receipt =
		supplied ??
		(runOptions?.dirtyOverlayReceiptPath
			? readDirtyOverlayReceipt(runOptions.dirtyOverlayReceiptPath)
			: null);
	const paths = [
		...new Set(
			(potentialAttemptTasks.length > 0
				? potentialAttemptTasks
				: tasks
			).flatMap((task) => task.requiredPaths ?? []),
		),
	];
	if (paths.length === 0)
		throw new Error("dirty overlay requires exact declared task paths");
	if (!receipt) return captureDirtyOverlay(projectPath, paths);
	const validation = validateDirtyOverlayReceipt(projectPath, receipt, paths);
	if (!validation.ok)
		throw new Error(`dirty overlay receipt rejected: ${validation.reason}`);
	return receipt;
}

function assertDirtyOverlayReceiptCurrent(projectPath, receipt, phase) {
	if (!receipt) return;
	const validation = validateDirtyOverlayReceipt(projectPath, receipt);
	if (!validation.ok)
		throw new Error(`dirty overlay drift ${phase}: ${validation.reason}`);
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
	deferSlotAcquisition = false,
}) {
	const selectedPlatform = queuePlatform({ platform, runOptions });
	const taskFileSha256 = hashBytes(readFileSync(tasksFilePath, "utf8"));
	const tasks = loadTaskQueue(tasksFilePath);
	validateProjectFileEntries(tasks, projectPath);
	if (tasks.length === 0) {
		throwOnEmptyParse(tasksFilePath, checkpointPath, onStatus);
	}
	let dirtyOverlayReceipt = null;
	// Read the checkpoint before backend selection so malformed or stale queue
	// state fails without creating a workspace or reserving a VM slot.
	const checkpointExisted = existsSync(checkpointPath);
	const observedCheckpoint = loadCheckpoint(checkpointPath, tasksFilePath);
	let identity = resolveQueueIdentity(
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
	const checkpointOwner = checkpointOwnerFor(
		checkpointPath,
		runId ?? identity.queueIdentity,
		dependencies.checkpointOwner,
	);
	const expectedCheckpointIdentity = identity.enabled
		? {
				queueIdentity: identity.queueIdentity,
				runOptions: identity.runOptions,
			}
		: null;
	if (
		checkpointExisted &&
		observedCheckpoint.version === CHECKPOINT_VERSION &&
		(observedCheckpoint.ownershipReleased ||
			!sameCheckpointOwner(observedCheckpoint.owner, checkpointOwner))
	) {
		claimCheckpointOwnership(
			checkpointPath,
			tasksFilePath,
			expectedCheckpointIdentity,
			checkpointOwner,
		);
	}
	const checkpoint = loadCheckpoint(
		checkpointPath,
		tasksFilePath,
		identity.enabled
			? {
					queueIdentity: identity.queueIdentity,
					runOptions: identity.runOptions,
					checkpointOwner,
				}
			: {
					checkpointOwner,
				},
	);
	ensureRetryCheckpoint(checkpoint);
	ensureProviderAttemptAllocations(checkpoint);
	validateRetryDescriptorEvidence(checkpoint);
	assertCheckpointRecoverySafe(checkpoint);
	let potentialAttemptTasks;
	try {
		potentialAttemptTasks = planPotentialAttemptTasks(tasks, checkpoint, {
			selectedTaskIds: effectiveTaskIds,
			maxTasks: effectiveMaxTasks,
			resolvedExternalBlockers: checkpoint.resolvedExternalBlockers,
		});
	} catch (error) {
		// Selection/dependency errors remain owned by the execution transition;
		// admission must not move their established failure point or teardown
		// semantics. No task can be safely claimed for provider eligibility.
		if (!(error instanceof TaskSelectionError)) throw error;
		potentialAttemptTasks = [];
	}
	dirtyOverlayReceipt = prepareDirtyOverlayReceipt({
		projectPath,
		tasks,
		potentialAttemptTasks,
		runOptions: identity.runOptions ?? runOptions,
		dependencies,
	});
	if (
		dirtyOverlayReceipt &&
		(identity.runOptions?.dirtyOverlayReceiptHash ?? null) !==
			dirtyOverlayReceipt.receiptHash
	) {
		runOptions = {
			...(runOptions ?? {}),
			dirtyOverlayReceiptHash: dirtyOverlayReceipt.receiptHash,
		};
		identity = resolveQueueIdentity(
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
	}
	const hostPower = readQueueHostPower({
		hostPowerProbe: dependencies.hostPowerProbe,
		execFn: dependencies.hostPowerExecFn,
		timeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		onStatus,
	});
	if (
		hostPower.state === HOST_POWER_STATES.BATTERY &&
		potentialAttemptTasks.length > 0
	) {
		return {
			selectedPlatform,
			tasks,
			checkpoint,
			identity,
			queueBackend: null,
			slotLease: null,
			effectiveMaxTasks,
			effectiveStopOnFailure,
			effectiveExclude,
			effectiveOnly,
			effectiveTaskIds,
			policyDeferred: {
				version: 1,
				action: "policy_deferred",
				direction: "advance_authorized_fallback",
				reasonCode: "host_on_battery",
				diagnosticCode: "host_on_battery",
				nextTaskId: potentialAttemptTasks[0].id,
				taskFileSha256,
				runnableTaskCount: potentialAttemptTasks.length,
			},
		};
	}
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
		potentialAttemptTasks,
		checkpoint,
		maxTasks: effectiveMaxTasks,
		selectedTaskIds: effectiveTaskIds,
		exclude: effectiveExclude,
		only: effectiveOnly,
		runId,
		projectPath,
		runOptions: identity.runOptions,
	});
	if (selectedPlatform === "macos") {
		queueBackend.readiness({
			platform: selectedPlatform,
			tasks,
			checkpoint,
			runId,
			projectPath,
			onStatus,
		});
	}
	assertDirtyOverlayReceiptCurrent(
		projectPath,
		dirtyOverlayReceipt,
		"before allocation",
	);
	const slotLease =
		selectedPlatform === "macos" && !deferSlotAcquisition
			? queueBackend.acquireSlot({ runId })
			: null;
	return {
		selectedPlatform,
		tasks,
		checkpoint,
		taskFileSha256,
		identity,
		queueBackend,
		dirtyOverlayReceipt,
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

function isVmSlotUnavailable(error) {
	return (
		error instanceof VmSlotUnavailableError ||
		error?.code === "VM_SLOT_UNAVAILABLE"
	);
}

function throwIfQueueAdmissionAborted(signal) {
	if (!signal?.aborted) return;
	if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
	throw signal.reason ?? new Error("VM slot admission wait aborted");
}

function waitForVmSlotRetry(delayMs, signal, sleepFn) {
	throwIfQueueAdmissionAborted(signal);
	const delay = Promise.resolve().then(() => sleepFn(delayMs));
	if (typeof signal?.addEventListener !== "function") return delay;
	return new Promise((resolveDelay, rejectDelay) => {
		const abort = () => {
			signal.removeEventListener?.("abort", abort);
			try {
				throwIfQueueAdmissionAborted(signal);
			} catch (error) {
				rejectDelay(error);
			}
		};
		signal.addEventListener("abort", abort, { once: true });
		delay.then(
			(value) => {
				signal.removeEventListener?.("abort", abort);
				resolveDelay(value);
			},
			(error) => {
				signal.removeEventListener?.("abort", abort);
				rejectDelay(error);
			},
		);
	});
}

/** Await bounded VM-slot admission for the production async queue path. */
async function acquireQueueSlotAsync({
	queueBackend,
	selectedPlatform,
	runId,
	dependencies,
	onStatus,
}) {
	if (selectedPlatform !== "macos") return null;
	const timeoutMs = dependencies.vmSlotWaitTimeoutMs ?? VM_SLOT_WAIT_TIMEOUT_MS;
	const intervalMs =
		dependencies.vmSlotWaitIntervalMs ?? VM_SLOT_WAIT_INTERVAL_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new RangeError("vmSlotWaitTimeoutMs must be a non-negative number");
	}
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new RangeError("vmSlotWaitIntervalMs must be a positive number");
	}
	// VM admission must not be extended or shortened by wall-clock adjustments.
	// `nowFn` remains injectable for deterministic tests, but production uses the
	// monotonic process clock.
	const now = dependencies.nowFn ?? performance.now.bind(performance);
	const sleepFn = dependencies.sleepFn ?? sleep;
	const signal = dependencies.signal;
	const deadline = now() + timeoutMs;

	for (;;) {
		throwIfQueueAdmissionAborted(signal);
		try {
			return queueBackend.acquireSlot({ runId });
		} catch (error) {
			if (!isVmSlotUnavailable(error)) throw error;
			const remainingMs = Math.max(0, deadline - now());
			const elapsedMs = timeoutMs - remainingMs;
			onStatus?.({
				phase: "bootstrap",
				event: "vm_slot_wait",
				status: "Waiting for VM admission capacity",
				elapsedMs,
			});
			if (remainingMs === 0) throw error;
			await waitForVmSlotRetry(
				Math.min(intervalMs, remainingMs),
				signal,
				sleepFn,
			);
		}
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
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
	});
	const {
		queueBackend,
		dirtyOverlayReceipt,
		selectedPlatform,
		slotLease,
		tasks,
		checkpoint,
		taskFileSha256,
		identity,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	if (launch.policyDeferred) {
		emitStatus?.({
			phase: "policy",
			event: "queue_deferred",
			status: "Queue deferred while host is on battery power",
			taskId: launch.policyDeferred.nextTaskId,
			diagnosticCode: launch.policyDeferred.diagnosticCode,
		});
		return policyDeferredQueueResult(launch, checkpointPath);
	}
	ensureProviderAttemptAllocations(checkpoint);

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	try {
		if (!workingContainerName) {
			assertDirtyOverlayReceiptCurrent(
				projectPath,
				dirtyOverlayReceipt,
				"immediately before allocation",
			);
			queueBackend.ensureAgentContainer();
			// Pass runId so the cloned VM's name embeds it (see
			// buildParallelsWorkingName) — that embedding is the only ownership
			// record `recover`/reclaim has, so a missing runId here is invisible
			// to leak reclamation.
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: emitStatus,
			});
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
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueue: before_remove hook failed: ${hookError.message}`,
					);
				}
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
	checkpoint.taskBases ??= {};
	const context = {
		route: dependencies.route ?? route,
		recordDispatch: dependencies.recordDispatch ?? defaultRecordDispatch,
		recordDispatchIntent:
			dependencies.recordDispatchIntent ?? defaultRecordDispatchIntent,
		integrationGate: dependencies.integrationGate ?? integrationGate,
		adapters: dependencies.adapters ?? DEFAULT_ADAPTERS,
		projectPath,
		workingContainerName,
		ownsWorkingContainer,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		platform: selectedPlatform,
		goldenImageVerifiedProviders: dependencies.goldenImageVerifiedProviders,
		healthDecision: resolveQueueHealthDecision(dependencies),
		onHealthDecision: dependencies.onHealthDecision,
		checkpoint,
		checkpointPath,
		taskFileSha256,
		runId: queueBackend.taskBaseRunId ?? runId,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
		onStatus: emitStatus,
		persistDiagnosticArtifact: dependencies.persistDiagnosticArtifact,
		onTaskRouted,
		onLedgerProjectionFailure: dependencies.onLedgerProjectionFailure,
		onIntentReceiptFailure: dependencies.onIntentReceiptFailure,
		resolveDescriptor: dependencies.resolveDescriptor,
		checkIgnoredPath: dependencies.checkIgnoredPath,
		hostPowerProbe: dependencies.hostPowerProbe,
		hostPowerExecFn: dependencies.hostPowerExecFn,
		hostPowerProbeTimeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		completionContinuation: dependencies.completionContinuation ?? {
			enabled: false,
		},
		completionContinuationMode: "sync",
		now: dependencies.now ?? Date.now,
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
		exclude,
		only,
	};

	try {
		if (ownsWorkingContainer) {
			try {
				queueBackend.seed(workingContainerName, projectPath, {
					dirtyOverlayReceipt,
				});
				queueBackend.afterCreate?.(workingContainerName, projectPath, {
					onStatus: emitStatus,
				});
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
		const deferredTaskIds = [];
		let policyDeferred = null;
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
			const selection = selectNextQueueTask(tasks, checkpoint, {
				...selectionOptions,
				excludedTaskIds: attemptedTaskIds,
				retryTaskId: resumedRetryTaskId,
			});
			const task = selection.task;
			if (!task) break;
			resumedRetryTaskId = selection.retryTaskId;
			attemptedTaskIds.clear();
			for (const taskId of selection.excludedTaskIds)
				attemptedTaskIds.add(taskId);
			const retryState =
				checkpoint.retryState?.taskId === task.id
					? checkpoint.retryState
					: null;
			const priorExtraAllocation = ensureProviderAttemptAllocations(
				checkpoint,
			).find((entry) => entry?.taskId === task.id);
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
				Boolean(retryState) && !hasTrustedQuotaRetryEvidence(retryState);
			if (!retryState && priorExtraAllocation) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason: "persisted extra provider invocation already consumed",
				};
			} else if (retryEvidenceMissing) {
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
					errorKind: "unknown_failure",
					reason:
						"historical retry state lacks trusted quota diagnostic provenance",
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
						startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
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
				result = runCompletionCorrection(
					task,
					context,
					result,
					checkpoint,
					checkpointPath,
				);
				if (
					result._routeHealthTrialStarted !== true &&
					result.extraProviderInvocationUsed !== true &&
					isQuotaRetryCandidate(result, ownsWorkingContainer) &&
					allocateExtraProviderInvocation(
						checkpoint,
						checkpointPath,
						task.id,
						"quota_fallback",
					)
				) {
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
						diagnosticCode: result.diagnosticCode,
						diagnosticOrigin: result.diagnosticOrigin,
						diagnosticEvidenceAvailable: result.diagnosticEvidenceAvailable,
						diagnosticRef: result.diagnosticRef,
						failurePhase: result.failurePhase,
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
						startExtraProviderInvocation(checkpoint, checkpointPath, task.id);
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
			recordExtraProviderInvocationResult(checkpoint, checkpointPath, task.id);
			if (context._activeInvocationDescriptor) {
				Object.assign(
					result,
					descriptorReceiptFields(context._activeInvocationDescriptor),
				);
			}
			if (result?.result === "policy_deferred") {
				deferredTaskIds.push(result.taskId);
				policyDeferred = result.policyDeferred;
				break;
			}
			decorateDirtyOverlayResult(result, context);
			if (isRouteHealthDeferredResult(result)) {
				deferredTaskIds.push(result.taskId);
				reportRouteHealthDeferred(result, onResult, emitStatus);
				continue;
			}
			const resultAttempt = reserveTaskAttempt(
				checkpoint,
				checkpointPath,
				result.taskId,
			);
			if (result.partialDiff) {
				try {
					result.partialDiffPath = savePartialDiff(
						checkpointPath,
						result.taskId,
						result.partialDiff,
						resultAttempt,
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
			} else if (result.timedOut && result.captureStatus !== "empty") {
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
						status: `Task ${result.taskId} timed out; no diff was recovered (${result.captureStatus ?? "unknown"})`,
						taskId: result.taskId,
						captureStatus: result.captureStatus ?? "unknown",
					});
				}
			}
			if (result.gateEvidence) {
				try {
					result.gateEvidencePath = saveGateEvidence(
						checkpointPath,
						result.taskId,
						result.gateEvidence,
						resultAttempt,
					);
				} catch (error) {
					console.error(
						`runQueue: could not save gate evidence for task ${result.taskId}: ${error.message}`,
					);
					result.gateEvidencePath = null;
				}
				// Same rule as the diff above: host-only bytes, never onResult.
				result.gateEvidence = undefined;
			}
			persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
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
						...(safeFailure?.diagnosticCode
							? { diagnosticCode: safeFailure.diagnosticCode }
							: {}),
						...(safeFailure?.diagnosticOrigin
							? {
									diagnosticOrigin: safeFailure.diagnosticOrigin,
									diagnosticEvidenceAvailable:
										safeFailure.diagnosticEvidenceAvailable,
								}
							: {}),
						...(safeFailure?.diagnosticRef
							? { diagnosticRef: safeFailure.diagnosticRef }
							: {}),
					});
				}
			}
			results.push(result);
			checkpoint.results.push({
				taskId: result.taskId,
				attempt: resultAttempt,
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
				...(typeof result.servedModelVerified === "boolean"
					? { servedModelVerified: result.servedModelVerified }
					: {}),
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				// Presence is the signal: these are written only when the provider
				// outlived its kill, so a resumed run and `switchyard status` can see
				// that an otherwise successful task left a process in the guest.
				...(result.cleanupFailed === true
					? {
							cleanupFailed: true,
							cleanupStage: result.cleanupStage ?? null,
						}
					: {}),
				success: result.success,
				dirtyOverlayReceiptHash: result.dirtyOverlayReceiptHash ?? null,
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
			let haltResult =
				result.cleanupFailed === true ? providerCleanupHalt(result) : null;
			if (!haltResult)
				haltResult = commitOrResetWorkingContainer(result, {
					ownsWorkingContainer,
					workingContainerName,
					stopOnFailure: effectiveStopOnFailure,
					commitWorkingTreeFn: queueBackend.commit,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus,
					logPrefix: "runQueue: ",
				});
			if (!haltResult) {
				haltResult = finalizeTaskBase(
					context,
					result.taskId,
					checkpoint,
					checkpointPath,
				);
			}
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
			const lastFailed = results.findLast((r) => !r.success);
			const lastFailure = lastFailed
				? failureMetadataFor(lastFailed, lastFailed.partialDiffPath)
				: null;
			const terminalProjection = {
				state: anyFailed
					? "failed"
					: deferredTaskIds.length > 0
						? "deferred"
						: "succeeded",
				activeTaskId: null,
				quarantinedTargetIds: [...checkpoint.quarantinedTargetIds],
				retryState: checkpoint.retryState,
				retryTransitionId: checkpoint.retryTransitionId,
				cleanupState: "complete",
				terminalSummary: {
					totalTasks: tasks.length,
					runnableTasks: initialRunnable.length,
					processedTasks: processed,
					completedTaskIds: checkpoint.completedTaskIds,
					deferredTaskIds,
					failedCount: results.filter((result) => !result.success).length,
				},
				terminalizedBy: "worker",
				...(lastFailure ? { lastFailure } : {}),
				...(policyDeferred ? { policyDeferred } : {}),
			};
			let writePromise;
			try {
				writePromise = Promise.resolve(
					runStore.updateRun(terminalProjection),
				).catch((error) => {
					reportOutcomeProjectionFailure(ledgerReporting, error);
				});
			} catch (error) {
				reportOutcomeProjectionFailure(ledgerReporting, error);
				writePromise = Promise.resolve();
			}
			storeWriteChain = storeWriteChain.then(() => writePromise);
		}

		// Guarantee a checkpoint file exists at the path this return value
		// reports, even when the per-task loop above never ran (e.g. every
		// task was already completed by a prior checkpoint) — the caller must
		// never be handed a checkpointPath with nothing on disk behind it.
		// A halt entry was already persisted by recordHalt before the
		// queue_halted event fired; this final save is a no-op for that entry
		// and remains for the other fields/zero-runnable path.
		if (checkpoint.version === CHECKPOINT_VERSION)
			releaseCheckpointOwnership(checkpointPath, checkpoint);

		return {
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			deferredTaskIds,
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
			...(policyDeferred ? { policyDeferred } : {}),
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
					try {
						queueBackend.beforeRemove?.(workingContainerName, projectPath);
					} catch (hookError) {
						console.error(
							`runQueue: before_remove hook failed: ${hookError.message}`,
						);
					}
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

/** Preserve the same receipt identity on direct orchestrator callers. */
export async function executeTaskWithOrchestrator(task, context) {
	return decorateDirtyOverlayResult(
		await executeTaskWithOrchestratorUnsafe(task, context),
		context,
	);
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
		dirtyOverlayReceipt,
		selectedPlatform,
		slotLease,
		tasks,
		checkpoint,
		taskFileSha256,
		identity,
		effectiveMaxTasks,
		effectiveStopOnFailure,
		effectiveExclude,
		effectiveOnly,
		effectiveTaskIds,
	} = launch;
	if (launch.policyDeferred) {
		emitStatus?.({
			phase: "policy",
			event: "queue_deferred",
			status: "Queue deferred while host is on battery power",
			taskId: launch.policyDeferred.nextTaskId,
			diagnosticCode: launch.policyDeferred.diagnosticCode,
		});
		return policyDeferredQueueResult(launch, checkpointPath);
	}
	ensureProviderAttemptAllocations(checkpoint);

	let workingContainerName = suppliedWorkingContainerName;
	let ownsWorkingContainer = false;
	let uninstallSignalCleanup = null;
	try {
		if (!workingContainerName) {
			assertDirtyOverlayReceiptCurrent(
				projectPath,
				dirtyOverlayReceipt,
				"immediately before allocation",
			);
			queueBackend.ensureAgentContainer();
			// Pass runId so the container is labeled managed + run_id (see runQueue).
			workingContainerName = queueBackend.create(projectPath, {
				runId,
				onStatus: emitStatus,
			});
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
				try {
					queueBackend.beforeRemove?.(workingContainerName, projectPath);
				} catch (hookError) {
					console.error(
						`runQueueWithOrchestrator: before_remove hook failed: ${hookError.message}`,
					);
				}
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
	checkpoint.taskBases ??= {};
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
		ownsWorkingContainer,
		executionBackend: queueBackend.executionBackend,
		queueBackend,
		platform: selectedPlatform,
		goldenImageVerifiedProviders: dependencies.goldenImageVerifiedProviders,
		healthDecision: resolveQueueHealthDecision(dependencies),
		onHealthDecision: dependencies.onHealthDecision,
		checkpoint,
		dirtyOverlayReceipt,
		checkpointPath,
		taskFileSha256,
		runId: queueBackend.taskBaseRunId ?? runId,
		taskBases: checkpoint.taskBases,
		persistTaskBase: (taskId, base) => {
			checkpoint.taskBases[taskId] = base;
			checkpoint.lastUpdatedAt = new Date().toISOString();
			saveCheckpoint(checkpointPath, checkpoint);
		},
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
		checkIgnoredPath: dependencies.checkIgnoredPath,
		hostPowerProbe: dependencies.hostPowerProbe,
		hostPowerExecFn: dependencies.hostPowerExecFn,
		hostPowerProbeTimeoutMs: dependencies.hostPowerProbeTimeoutMs,
		hostPowerPolicyEnabled: dependencies.hostPowerPolicyEnabled !== false,
		completionContinuation: dependencies.completionContinuation ?? {
			enabled: false,
		},
		completionContinuationMode: "unavailable",
		monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
	};

	try {
		if (ownsWorkingContainer) {
			try {
				queueBackend.seed(workingContainerName, projectPath, {
					dirtyOverlayReceipt,
				});
				queueBackend.afterCreate?.(workingContainerName, projectPath, {
					onStatus: emitStatus,
				});
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
			const reason = hasTrustedQuotaRetryEvidence(checkpoint.retryState)
				? "orchestrator mode cannot resume persisted retry state until an audited retry-resume state machine is implemented"
				: "historical retry state lacks trusted quota diagnostic provenance";
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
		const deferredTaskIds = [];
		let policyDeferred = null;
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

			const priorExtraAllocation = ensureProviderAttemptAllocations(
				checkpoint,
			).find((entry) => entry?.taskId === task.id);
			let result;
			if (priorExtraAllocation) {
				result = {
					taskId: task.id,
					success: false,
					provider: null,
					model: null,
					result: "unknown_failure",
					errorKind: "unknown_failure",
					reason: "persisted extra provider invocation already consumed",
				};
			} else {
				// eslint-disable-next-line no-await-in-loop
				result = await executeTaskWithOrchestrator(task, context);
			}
			if (context._activeInvocationDescriptor) {
				Object.assign(
					result,
					descriptorReceiptFields(context._activeInvocationDescriptor),
				);
			}
			if (result?.result === "policy_deferred") {
				deferredTaskIds.push(result.taskId);
				policyDeferred = result.policyDeferred;
				break;
			}
			decorateDirtyOverlayResult(result, context);

			if (isRouteHealthDeferredResult(result)) {
				deferredTaskIds.push(result.taskId);
				reportRouteHealthDeferred(result, onResult, emitStatus);
				continue;
			}

			const resultAttempt = reserveTaskAttempt(
				checkpoint,
				checkpointPath,
				result.taskId,
			);
			persistProviderCleanupUncertain(checkpoint, result, checkpointPath);
			attachRouteHealthTerminal(result, context);
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
						...(safeFailure?.diagnosticCode
							? { diagnosticCode: safeFailure.diagnosticCode }
							: {}),
						...(safeFailure?.diagnosticOrigin
							? {
									diagnosticOrigin: safeFailure.diagnosticOrigin,
									diagnosticEvidenceAvailable:
										safeFailure.diagnosticEvidenceAvailable,
								}
							: {}),
						...(safeFailure?.diagnosticRef
							? { diagnosticRef: safeFailure.diagnosticRef }
							: {}),
					});
				}
			}

			results.push(result);
			checkpoint.results.push({
				taskId: result.taskId,
				attempt: resultAttempt,
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
				...(typeof result.servedModelVerified === "boolean"
					? { servedModelVerified: result.servedModelVerified }
					: {}),
				...(result.alreadyApplied ? { alreadyApplied: true } : {}),
				...(result.cleanupFailed === true
					? {
							cleanupFailed: true,
							cleanupStage: result.cleanupStage ?? null,
						}
					: {}),
				success: result.success,
				dirtyOverlayReceiptHash: result.dirtyOverlayReceiptHash ?? null,
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
			let haltResult =
				result.cleanupFailed === true ? providerCleanupHalt(result) : null;
			if (!haltResult)
				haltResult = commitOrResetWorkingContainer(result, {
					ownsWorkingContainer,
					workingContainerName,
					stopOnFailure: effectiveStopOnFailure,
					commitWorkingTreeFn: queueBackend.commit,
					resetWorkingTreeFn: queueBackend.reset,
					emitStatus,
					logPrefix: "runQueueWithOrchestrator: ",
				});
			if (!haltResult) {
				haltResult = await finalizeTaskBaseAsync(
					context,
					result.taskId,
					checkpoint,
					checkpointPath,
				);
			}
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
			const lastFailed = results.findLast((r) => !r.success);
			const lastFailure = lastFailed
				? failureMetadataFor(lastFailed, lastFailed.partialDiffPath)
				: null;
			const terminalProjection = {
				state: anyFailed
					? "failed"
					: deferredTaskIds.length > 0
						? "deferred"
						: "succeeded",
				activeTaskId: null,
				cleanupState: "complete",
				terminalSummary: {
					totalTasks: tasks.length,
					runnableTasks: initialRunnable.length,
					processedTasks: processed,
					completedTaskIds: checkpoint.completedTaskIds,
					deferredTaskIds,
					failedCount: results.filter((result) => !result.success).length,
				},
				terminalizedBy: "worker",
				...(lastFailure ? { lastFailure } : {}),
				...(policyDeferred ? { policyDeferred } : {}),
			};
			try {
				await runStore.updateRun(terminalProjection);
			} catch (error) {
				reportOutcomeProjectionFailure(
					ledgerReportingContext(
						emitStatus,
						dependencies,
						"runQueueWithOrchestrator",
					),
					error,
				);
			}
		}

		// Guarantee a checkpoint file exists at the path this return value
		// reports, even when the per-task loop above never ran (e.g. every
		// task was already completed by a prior checkpoint) — the caller must
		// never be handed a checkpointPath with nothing on disk behind it.
		// A halt entry was already persisted by recordHalt before the
		// queue_halted event fired; this final save is a no-op for that entry
		// and remains for the other fields/zero-runnable path.
		if (checkpoint.version === CHECKPOINT_VERSION)
			releaseCheckpointOwnership(checkpointPath, checkpoint);

		return {
			totalTasks: tasks.length,
			runnableTasks: initialRunnable.length,
			processedTasks: processed,
			completedTaskIds: checkpoint.completedTaskIds,
			deferredTaskIds,
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
			...(policyDeferred ? { policyDeferred } : {}),
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
					try {
						queueBackend.beforeRemove?.(workingContainerName, projectPath);
					} catch (hookError) {
						console.error(
							`runQueueWithOrchestrator: before_remove hook failed: ${hookError.message}`,
						);
					}
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
