import { isSafeDescriptorReceipt } from "../run-store/receipt-validation.mjs";
import { emitStatus } from "./overlay.mjs";

const HEARTBEAT_PERSIST_INTERVAL_MS = 30_000;
const SIMPLE_PROCESS_PHASES = new Set([
	"check_preparing",
	"dry_run_check",
	"launcher_probe",
	"provider_running",
	"format_running",
	"check_running",
	"head_advance_recheck_preparing",
	"head_advance_recheck_running",
	"cleanup_scan_running",
	"cleanup_helper_progress",
	"cleanup_scan_started",
	"cleanup_quarantine_started",
	"cleanup_remove_started",
]);

/**
 * Report observed progress without owning execution or terminal state.
 * The coordinator supplies a snapshot for each call and owns the pending-write
 * set and its final drain; only reporting intervals and process phase live here.
 */
export function createSimpleProgress({
	now,
	startedAt,
	taskId,
	runId,
	onStatus,
	createEvent,
	updateRun,
	pendingDurability,
}) {
	let lastMilestoneAt = startedAt;
	let lastHeartbeatPersistedAt = Number.NEGATIVE_INFINITY;
	let activeTaskProcessPhase = null;
	const milestone = (
		phase,
		name,
		details,
		{ runInitialized, firstChangeObserved },
	) => {
		const observedAt = now();
		const elapsedSinceLastMilestoneMs = Math.max(
			0,
			observedAt - lastMilestoneAt,
		);
		emitStatus(onStatus, taskId, phase, {
			milestone: name,
			elapsedMs: Math.max(0, observedAt - startedAt),
			elapsedSinceLastMilestoneMs,
			firstChangeObserved,
			...details,
		});
		lastMilestoneAt = observedAt;
		if (runInitialized) {
			try {
				const descriptorReceipt =
					details.invocationDescriptor &&
					isSafeDescriptorReceipt(
						details.invocationDescriptor,
						details.descriptorHarness,
					) &&
					details.invocationDescriptor.descriptor_identity ===
						details.descriptorIdentity &&
					details.invocationDescriptor.target_id === details.resolvedTargetId
						? {
								invocationDescriptor: details.invocationDescriptor,
								descriptorIdentity: details.descriptorIdentity,
								descriptorHarness: details.descriptorHarness,
								resolvedTargetId: details.resolvedTargetId,
							}
						: {};
				const eventWrite = createEvent(runId, {
					phase,
					event: "milestone",
					milestone: name,
					status: details.status ?? "in_progress",
					elapsedMs: Math.max(0, observedAt - startedAt),
					elapsedSinceLastMilestoneMs,
					...(details.checkIndex !== undefined
						? { checkIndex: details.checkIndex }
						: {}),
					...(details.checkIdentity !== undefined
						? { checkIdentity: details.checkIdentity }
						: {}),
					...(details.checkStatus !== undefined
						? { checkStatus: details.checkStatus }
						: {}),
					...(details.exitCode !== undefined
						? { exitCode: details.exitCode }
						: {}),
					...(details.signal !== undefined ? { signal: details.signal } : {}),
					...descriptorReceipt,
					firstChangeObserved,
				}).catch(() => {});
				pendingDurability.add(eventWrite);
				void eventWrite.finally(() => pendingDurability.delete(eventWrite));
			} catch {}
		}
	};
	const heartbeat = (
		phase,
		details,
		{
			runInitialized,
			providerStarted,
			runTerminalReached,
			firstChangeObserved,
		},
	) => {
		const observedAt = now();
		if (
			providerStarted &&
			typeof details.processPhase === "string" &&
			SIMPLE_PROCESS_PHASES.has(details.processPhase)
		) {
			activeTaskProcessPhase = details.processPhase;
		}
		emitStatus(onStatus, taskId, phase, {
			elapsedMs: Math.max(0, observedAt - startedAt),
			elapsedSinceLastMilestoneMs: Math.max(0, observedAt - lastMilestoneAt),
			firstChangeObserved,
			...details,
		});
		// Durable liveness only, and only while a provider run is actually live.
		// Nothing derived (elapsed, progress) is persisted: the record carries the
		// timestamp this process observed, no more.
		if (!runInitialized || !providerStarted || runTerminalReached) return;
		if (observedAt - lastHeartbeatPersistedAt < HEARTBEAT_PERSIST_INTERVAL_MS)
			return;
		lastHeartbeatPersistedAt = observedAt;
		const heartbeatPatch = { activeTaskHeartbeatAt: observedAt };
		if (activeTaskProcessPhase !== null) {
			heartbeatPatch.activeTaskProcessPhase = activeTaskProcessPhase;
		}
		const heartbeatWrite = updateRun(runId, heartbeatPatch).catch(() => {});
		pendingDurability.add(heartbeatWrite);
		void heartbeatWrite.finally(() => pendingDurability.delete(heartbeatWrite));
	};
	const persistProviderStarted = async ({
		runInitialized,
		provider,
		targetId,
		invocationDescriptor,
		descriptorHarness,
		deadlineMs,
	}) => {
		if (!runInitialized) return null;
		const observedAt = now();
		const activeDescriptorReceipt =
			invocationDescriptor &&
			isSafeDescriptorReceipt(invocationDescriptor, descriptorHarness) &&
			invocationDescriptor.target_id === targetId
				? invocationDescriptor
				: null;
		try {
			await updateRun(runId, {
				state: "running",
				startedAt: new Date(observedAt).toISOString(),
				activeTaskId: taskId,
				activeTaskProvider: provider,
				activeTaskModel: invocationDescriptor?.selector ?? null,
				activeTaskDeadline:
					typeof deadlineMs === "number" && Number.isFinite(deadlineMs)
						? new Date(deadlineMs).toISOString()
						: null,
				activeTaskStartedAt: observedAt,
				activeTaskProcessPhase,
				activeTaskInvocationDescriptor: activeDescriptorReceipt,
				activeTaskDescriptorIdentity:
					activeDescriptorReceipt?.descriptor_identity ?? null,
				activeTaskDescriptorHarness:
					activeDescriptorReceipt === null ? null : descriptorHarness,
			});
			return null;
		} catch (error) {
			return error;
		}
	};

	return { milestone, heartbeat, persistProviderStarted };
}
