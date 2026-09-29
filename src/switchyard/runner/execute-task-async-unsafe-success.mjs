import {
	descriptorReceiptFields,
	safeSuccessfulRouteReason,
} from "./ledger-reporting.mjs";
import { quickCheckDecisionAsync } from "./quick-checks.mjs";
import { integrationFailureMetadata } from "./retry-transitions.mjs";
import {
	captureDiffWithEvidenceAsync,
	servedModelVerificationFields,
	survivingProviderFields,
} from "./review-results.mjs";
import { bindAttemptHelperBackend } from "./route-health.mjs";
import { checkpointIntegrationIntent, taskBaseFailure } from "./task-base.mjs";
import { dirtyOverlayIntegrationGate } from "./task-routing.mjs";

export async function completeExecuteTaskAsyncUnsafe(
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
	if (!["captured", "empty"].includes(captureEvidence.status)) {
		await record({
			provider: routeResult.provider,
			model: routeResult.model ?? "unknown",
			taskId: task.id,
			result: "diff_capture_failed",
			errorKind: "diff_capture_failed",
			captureStatus: captureEvidence.status,
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
	if (
		!diff &&
		task.requiredPaths === null &&
		(task.quickChecks?.checks?.length ?? 0) === 0
	) {
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
			captureStatus: captureEvidence.status,
			...servedModelVerificationFields(execution),
			...survivingProviderFields(execution),
		};
	}
	const quickCheck = await quickCheckDecisionAsync(task, context, diff);
	const gateResult = !quickCheck.passed
		? { success: false, message: "check_failed" }
		: (dirtyOverlayIntegrationGate(context) ??
			context.integrationGate(diff, context.projectPath, {
				allowedPaths: task.requiredPaths,
				allowSensitiveManifests:
					task.type === "implementation" && task.allowManifests === true,
				integrationIntent: checkpointIntegrationIntent(context, task, diff),
				dirtyOverlayReceiptHash:
					context.dirtyOverlayReceipt?.receiptHash ?? null,
			}));
	const alreadyApplied = gateResult?.alreadyApplied === true;
	const gateSuccess = Boolean(gateResult?.success) || alreadyApplied;
	const success = gateSuccess && quickCheck.passed;
	const terminalResult = !quickCheck.passed
		? "check_failed"
		: gateSuccess
			? "success"
			: "integration_failed";
	const safeGateFailure = !quickCheck.passed
		? {
				errorKind: "check_failed",
				reasonCode: "check_failed",
				reason: "Task check command failed.",
			}
		: !gateSuccess
			? integrationFailureMetadata(
					task.id,
					diff,
					gateResult?.credentialFlagged,
					gateResult,
					!diff && Boolean(context._activeTaskTranscript),
				)
			: null;
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
		...(quickCheck.receipt ? { quickCheckReceipt: quickCheck.receipt } : {}),
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: terminalResult,
		captureStatus: captureEvidence.status,
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
