import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { HOST_POWER_STATES } from "../dispatch/host-power.mjs";
import { recordDispatch, recordDispatchToStore } from "../ledger/index.mjs";
import { VmSlotUnavailableError } from "../run-store/index.mjs";
import {
	resolveQueueIdentity,
	sleep,
	TaskSelectionError,
} from "./checkpoint-errors.mjs";
import {
	claimCheckpointOwnership,
	loadCheckpoint,
} from "./checkpoint-load.mjs";
import {
	checkpointOwnerFor,
	sameCheckpointOwner,
} from "./checkpoint-store.mjs";
import {
	CHECKPOINT_VERSION,
	hashBytes,
	VM_SLOT_WAIT_INTERVAL_MS,
	VM_SLOT_WAIT_TIMEOUT_MS,
} from "./constants.mjs";
import { throwOnEmptyParse } from "./halts.mjs";
import {
	reportLegacyProjectionFailure,
	reportOutcomeProjectionFailure,
} from "./ledger-reporting.mjs";
import {
	assertDirtyOverlayReceiptCurrent,
	createQueueBackend,
	prepareDirtyOverlayReceipt,
	queuePlatform,
} from "./queue-backend.mjs";
import { planPotentialAttemptTasks } from "./queue-selection.mjs";
import {
	assertCompletedQuickChecks,
	ensureRetryCheckpoint,
	validateRetryDescriptorEvidence,
} from "./quick-checks.mjs";
import { ensureProviderAttemptAllocations } from "./retry-transitions.mjs";
import { readQueueHostPower } from "./route-health.mjs";
import { assertCheckpointRecoverySafe } from "./task-base.mjs";
import { validateProjectFileEntries } from "./task-fields.mjs";
import { loadTaskQueue } from "./task-queue.mjs";

export function prepareQueueLaunch({
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
	assertCompletedQuickChecks(tasks, checkpoint);
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

export function releaseQueueSlot(queueBackend, slotLease) {
	if (!slotLease) return;
	try {
		queueBackend.releaseSlot(slotLease);
	} catch {
		// The queue outcome is authoritative; release is best effort but always
		// attempted from the enclosing finally block.
	}
}

export function isVmSlotUnavailable(error) {
	return (
		error instanceof VmSlotUnavailableError ||
		error?.code === "VM_SLOT_UNAVAILABLE"
	);
}

export function throwIfQueueAdmissionAborted(signal) {
	if (!signal?.aborted) return;
	if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
	throw signal.reason ?? new Error("VM slot admission wait aborted");
}

export function waitForVmSlotRetry(delayMs, signal, sleepFn) {
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

export async function acquireQueueSlotAsync({
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

export function recordDispatchToBothLedgers(
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
