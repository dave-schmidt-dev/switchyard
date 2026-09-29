import {
	CHECKPOINT_REMEDIATION_MESSAGES,
	CLEANUP_STAGES,
	checkpointRemediation,
	INTEGRATION_REFUSAL_KINDS,
	PERSISTED_DIAGNOSTIC_CODES,
	PERSISTED_ERROR_KINDS,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { descriptorReceiptFields } from "./ledger-reporting.mjs";
import {
	captureDiffWithEvidence,
	retainsFailureDiff,
	reviewFailureFields,
} from "./review-results.mjs";

export function handleExecuteTaskUnsafeFailure(
	task,
	context,
	record,
	execution,
	scope,
) {
	const {
		adapter,
		captureExecutionBackend,
		invocationDescriptor,
		requiredCapability,
		resolvedTargetId,
		routeResult,
	} = scope;
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
			...(execution.providerReliability
				? { providerReliability: execution.providerReliability }
				: {}),
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
			...(execution.providerReliability
				? { providerReliability: execution.providerReliability }
				: {}),
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
		...(execution.providerReliability
			? { providerReliability: execution.providerReliability }
			: {}),
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
		...(execution.providerReliability
			? { providerReliability: execution.providerReliability }
			: {}),
		...(captureEvidence ? { captureStatus: captureEvidence.status } : {}),
		...reviewFailureFields(task, execution),
		...(captureEvidence?.diff ? { partialDiff: captureEvidence.diff } : {}),
	};
}
