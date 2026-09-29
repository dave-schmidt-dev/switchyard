import {
	activateOutcomeWriter,
	appendOutcomeEvent,
	createStageOutcome,
	readRun,
	recoverExecutionOutcome,
} from "../run-store/index.mjs";

export function normalizeBrokerRoute(result) {
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

export async function prepareOutcomeWriter(runId, dependencies) {
	if (
		typeof runId !== "string" ||
		runId.length === 0 ||
		dependencies.enableTypedOutcomes === false
	)
		return null;
	let current;
	try {
		current = await readRun(runId);
	} catch {
		return null;
	}
	if (!Number.isSafeInteger(current.workerPid) || current.workerPid < 1)
		return null;
	if (current.workerPid !== process.pid) {
		const error = new Error(
			"typed outcome writer lease belongs to another process",
		);
		error.code = "OUTCOME_WRITER_LEASE_STALE";
		throw error;
	}
	const activated = await activateOutcomeWriter(runId, {
		pid: current.workerPid,
		startToken: current.workerStartToken,
		nonce: current.workerNonce,
		writerEpoch:
			dependencies.outcomeWriterEpoch ??
			current.outcomeWriterEpoch ??
			`epoch-${runId}-${current.revision + 1}`,
		minimumReaderVersion: dependencies.minimumOutcomeReaderVersion ?? 1,
	});
	const owner = {
		pid: activated.workerPid,
		startToken: activated.workerStartToken,
		nonce: activated.workerNonce,
	};
	while (
		(await recoverExecutionOutcome(runId, {
			writerEpoch: activated.outcomeWriterEpoch,
			owner,
			minimumReaderVersion: activated.minimumOutcomeReaderVersion ?? 1,
		})) !== null
	) {
		// Recover every durable process fact whose execution fact was interrupted.
	}
	return {
		writerEpoch: activated.outcomeWriterEpoch,
		owner,
		record: (outcome) =>
			appendOutcomeEvent(runId, outcome, {
				writerEpoch: activated.outcomeWriterEpoch,
				owner,
				minimumReaderVersion: activated.minimumOutcomeReaderVersion ?? 1,
			}),
	};
}

export async function emitStageOutcome(context, options = {}) {
	if (
		!context ||
		typeof context.recordOutcomeEvent !== "function" ||
		typeof context.outcomeWriterEpoch !== "string"
	)
		return null;
	try {
		const outcome = createStageOutcome({
			runId: context.runId,
			writerEpoch: context.outcomeWriterEpoch,
			causedBy: context._activeProcessOutcomeId ?? null,
			resumesOutcomeId: context._activeProcessOutcomeId ?? null,
			...options,
		});
		await context.recordOutcomeEvent(outcome);
		return outcome;
	} catch {
		// Typed outcomes are shadow writes in this phase. A failed typed write
		// cannot erase the already-authoritative legacy event or result.
		context.onStatus?.({
			phase: options.stage ?? "run",
			event: "outcome_write_unavailable",
			status: "Typed stage evidence unavailable",
		});
		return null;
	}
}

export function mergeBrokerRouteProvenance(
	routeResult,
	capability,
	provenance,
) {
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

export const BROKER_PEER_RETRY_ERROR_KINDS = new Set();

export function brokerFailureKind(result) {
	if (result?.outcome !== "failure" || result?.timedOut === true) {
		return null;
	}
	return BROKER_PEER_RETRY_ERROR_KINDS.has(result.errorKind)
		? "transient"
		: null;
}
