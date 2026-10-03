import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { PERSISTED_ERROR_KINDS } from "../adapter/exec-error.mjs";

const CHECKPOINT_VERSION = 3;
const checkpointOwners = new Map();
const BOUNDED_ERROR_KINDS = new Set(PERSISTED_ERROR_KINDS);
const DIAGNOSTIC_REF_RE = /^diagnostic:[a-f0-9]{32}$/u;
const HISTORICAL_CHECKPOINT_VERSION = 1;
const RUN_OPTIONS_VERSION = 1;
const VM_SLOT_WAIT_TIMEOUT_MS = 5 * 60_000;
const VM_SLOT_WAIT_INTERVAL_MS = 1_000;
export const QUEUE_PLATFORMS = Object.freeze(["macos"]);
export const ORCHESTRATOR_PAYLOAD_VERSION = 1;
export const DISPATCH_DESCRIPTOR_CONTRACT_VERSION = 1;
const TERMINAL_JOB_STATES = new Set([
	"done",
	"expired",
	"died",
	"error",
	"missing",
]);
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
		...(options.qualificationAttempt === true
			? { qualificationAttempt: true }
			: {}),
	};
}
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
const CHECKPOINT_ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;
function hashBytes(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export {
	BOUNDED_ERROR_KINDS,
	CHECKPOINT_ARTIFACT_MAX_FILE_BYTES,
	CHECKPOINT_VERSION,
	checkpointOwners,
	DIAGNOSTIC_REF_RE,
	EXTERNAL_BLOCKER_ID_RE,
	HISTORICAL_CHECKPOINT_VERSION,
	hashBytes,
	KNOWN_TASK_STATUSES,
	normalizeIds,
	RUNNABLE_TASK_STATUSES,
	stableStringify,
	TASK_ID_PATTERN,
	TERMINAL_JOB_STATES,
	VM_SLOT_WAIT_INTERVAL_MS,
	VM_SLOT_WAIT_TIMEOUT_MS,
};
