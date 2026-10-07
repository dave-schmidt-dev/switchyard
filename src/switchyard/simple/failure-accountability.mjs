import { hasAuthoritativeDiagnosticProvenance } from "../adapter/exec-error-metadata.mjs";
import { FAILURE_REGISTRY } from "../diagnostics/failure-registry.mjs";
import { isProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";

const RESPONSIBILITY = Object.freeze({
	environment: ["environment", "investigate_environment"],
	policy: ["contract", "review_contract"],
	input: ["caller", "correct_input"],
	check: ["check_system", "investigate_checks"],
	cancellation: ["caller", "acknowledge_cancellation"],
	cleanup: ["cleanup", "repair_cleanup"],
	unknown: ["unknown", "investigate_unknown"],
});

function closedLifecycleReceipt(lifecycle) {
	return (
		lifecycle?.schemaVersion === 1 &&
		lifecycle.writerLifecycle === "stopped" &&
		lifecycle.cleanupStage === null &&
		["not_required", "succeeded"].includes(lifecycle.cleanupStatus)
	);
}

/**
 * True when Switchyard's own process supervisor observed this provider-phase
 * failure and its lifecycle receipt is closed: the direct child and the whole
 * writer group are stopped and cleanup is settled. The receipt's exit status
 * (or deadline termination) must match the diagnostic. The supervisor, not
 * provider output, is the authority here, so no adapter diagnostic is needed.
 */
export function lifecycleBackedProviderFailure(
	providerReliability,
	providerLifecycle,
	providerWriterLifecycle,
) {
	if (
		!isProviderReliabilityDiagnostic(providerReliability) ||
		providerReliability.phase !== "provider" ||
		providerReliability.cancelled === true ||
		providerWriterLifecycle !== "stopped" ||
		!closedLifecycleReceipt(providerLifecycle)
	)
		return false;
	switch (providerReliability.causeCode) {
		case "provider_exit_nonzero":
			return (
				providerLifecycle.terminalStatus === "exited" &&
				Number.isSafeInteger(providerLifecycle.exitCode) &&
				providerLifecycle.exitCode !== 0 &&
				providerReliability.exitCode === providerLifecycle.exitCode
			);
		case "provider_signalled":
			return (
				providerLifecycle.terminalStatus === "exited" &&
				typeof providerLifecycle.signal === "string" &&
				providerReliability.signal === providerLifecycle.signal
			);
		case "provider_deadline_exceeded":
			return (
				providerLifecycle.terminalStatus === "terminated" &&
				providerLifecycle.terminationReason === "deadline" &&
				providerReliability.timedOut === true
			);
		default:
			return false;
	}
}

/**
 * Project existing closed diagnostics without extending any durable schema.
 * `provenance` may also carry `providerLifecycle` and `providerWriterLifecycle`
 * from the supervisor; callers that omit them (routing memory) keep the
 * adapter-diagnostic and deadline trust rules only.
 */
export function deriveFailureAccountability({
	providerReliability,
	provenance = {},
} = {}) {
	const valid = isProviderReliabilityDiagnostic(providerReliability);
	let category = valid ? providerReliability.causeCategory : "unknown";
	// A provider-caused row whose persisted category stays "unknown" for reader
	// compatibility is attributed to the provider only under the same trust rule.
	if (
		valid &&
		category === "unknown" &&
		FAILURE_REGISTRY.get(providerReliability.causeCode)?.providerCaused === true
	)
		category = "provider";
	if (category === "provider") {
		const diagnosticTrusted =
			provenance.diagnosticCode === providerReliability.causeCode &&
			hasAuthoritativeDiagnosticProvenance(provenance);
		const deadlineTrusted =
			providerReliability.causeCode === "provider_deadline_exceeded" &&
			providerReliability.phase === "provider" &&
			providerReliability.timedOut === true;
		const lifecycleTrusted = lifecycleBackedProviderFailure(
			providerReliability,
			provenance.providerLifecycle,
			provenance.providerWriterLifecycle,
		);
		if (!diagnosticTrusted && !deadlineTrusted && !lifecycleTrusted)
			category = "unknown";
	}
	const [owner, action] =
		category === "provider"
			? ["provider", "investigate_provider"]
			: RESPONSIBILITY[category];
	return {
		version: 1,
		owner,
		action,
		causeCategory: valid ? providerReliability.causeCategory : "unknown",
		causeCode: valid ? providerReliability.causeCode : "unknown",
		providerMemoryEligible: owner === "provider",
	};
}

/** Verify the existing run identity before using linked outcome evidence. */
export function linkedRoutingRecordMatches(record, attempt, projectPath) {
	return Boolean(
		record &&
			record.runId === attempt.runId &&
			record.projectPath === projectPath &&
			Array.isArray(record.orderedTaskIds) &&
			record.orderedTaskIds.length === 1 &&
			record.orderedTaskIds[0] === attempt.taskId &&
			record.resolvedTargetId === attempt.targetId &&
			(record.lastFailure?.taskId == null ||
				record.lastFailure.taskId === attempt.taskId) &&
			(record.worktree?.taskId == null ||
				record.worktree.taskId === attempt.taskId) &&
			(record.worktree?.attemptId == null ||
				record.worktree.attemptId === attempt.attemptId) &&
			(record.state === "succeeded"
				? attempt.terminal === "succeeded"
				: record.state === "failed" &&
					["failed", "skipped"].includes(attempt.terminal)),
	);
}

function totals(entries) {
	const successes = entries.filter((entry) => entry.outcome === "succeeded");
	return {
		attempts: entries.length,
		succeededAttempts: successes.length,
		failedAttempts: entries.filter((entry) => entry.outcome === "failed")
			.length,
		unknownAttempts: entries.filter((entry) => entry.outcome === "unknown")
			.length,
		uniqueTasks: new Set(entries.map((entry) => entry.taskId)).size,
		succeededTasks: new Set(successes.map((entry) => entry.taskId)).size,
	};
}

/** Inspect only identity-verified records; cleanup never changes task success. */
export async function inspectRoutingAccountability(state, readRun) {
	const attempts = [];
	for (const attempt of state.attempts) {
		let record;
		try {
			record = await readRun(attempt.runId);
		} catch {
			// Missing, unreadable and malformed linked records have no outcome authority.
		}
		const verified = linkedRoutingRecordMatches(
			record,
			attempt,
			state.canonicalProjectPath,
		);
		attempts.push({
			attemptId: attempt.attemptId,
			taskId: attempt.taskId,
			runId: attempt.runId,
			targetId: attempt.targetId,
			linkedRecord: verified ? "verified" : "unknown",
			outcome: verified ? record.state : "unknown",
			accountability:
				verified && record.state === "succeeded"
					? null
					: deriveFailureAccountability(
							verified && record.state === "failed"
								? {
										providerReliability:
											record.lastFailure?.providerReliability,
										provenance: record.lastFailure,
									}
								: {},
						),
			cleanup: verified
				? {
						state: ["not_started", "pending", "complete", "failed"].includes(
							record.cleanupState,
						)
							? record.cleanupState
							: "unknown",
						worktree: ["removed", "retained", "not_created"].includes(
							record.worktree?.state,
						)
							? record.worktree.state
							: "unknown",
					}
				: { state: "unknown", worktree: "unknown" },
		});
	}
	return {
		version: 1,
		totals: totals(attempts),
		providers: [...new Set(attempts.map((entry) => entry.targetId))].map(
			(targetId) => ({
				targetId,
				...totals(attempts.filter((entry) => entry.targetId === targetId)),
			}),
		),
		attempts,
	};
}
