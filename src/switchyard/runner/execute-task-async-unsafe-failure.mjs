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
	captureDiffWithEvidenceAsync,
	retainsFailureDiff,
	reviewFailureFields,
	survivingProviderFields,
} from "./review-results.mjs";
import { bindAttemptHelperBackend } from "./route-health.mjs";

export async function handleExecuteTaskAsyncUnsafeFailure(
	task,
	context,
	record,
	execution,
	scope,
) {
	const {
		adapter,
		attemptCleanupContext,
		invocationDescriptor,
		requiredCapability,
		resolvedTargetId,
		routeResult,
	} = scope;
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
			...survivingProviderFields(execution),
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
			...survivingProviderFields(execution),
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
		...survivingProviderFields(execution),
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
		...survivingProviderFields(execution),
		...(partialDiff ? { partialDiff } : {}),
	};
}
