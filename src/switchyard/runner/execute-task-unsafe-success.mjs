import { boundedGateEvidence } from "./artifacts.mjs";
import {
	descriptorReceiptFields,
	safeSuccessfulRouteReason,
} from "./ledger-reporting.mjs";
import { quickCheckDecision } from "./quick-checks.mjs";
import { acceptanceCheckDiagnostic } from "./reliability.mjs";
import { integrationFailureMetadata } from "./retry-transitions.mjs";
import {
	captureDiffWithEvidence,
	opaqueArtifactRef,
	servedModelVerificationFields,
	survivingProviderFields,
} from "./review-results.mjs";
import { checkpointIntegrationIntent, taskBaseFailure } from "./task-base.mjs";
import { dirtyOverlayIntegrationGate } from "./task-routing.mjs";

export function completeExecuteTaskUnsafe(
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
		projectionFailure,
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
	const captureEvidence = captureDiffWithEvidence(
		adapter,
		context.workingContainerName,
		{
			executionBackend: captureExecutionBackend,
			taskBase: context._activeTaskBase,
		},
	);
	if (!["captured", "empty"].includes(captureEvidence.status)) {
		record({
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

	if (
		!diff &&
		task.requiredPaths === null &&
		(task.quickChecks?.checks?.length ?? 0) === 0
	) {
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
			captureStatus: captureEvidence.status,
			...servedModelVerificationFields(execution),
			...survivingProviderFields(execution),
		};
	}

	const quickCheck = quickCheckDecision(task, context, diff);
	const providerReliability = quickCheck.passed
		? execution.providerReliability
		: acceptanceCheckDiagnostic(task, quickCheck.receipt).diagnostic;
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
					!diff && Boolean(boundedGateEvidence(execution.output)),
				)
			: null;
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
		...(providerReliability ? { providerReliability } : {}),
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
		...(quickCheck.receipt ? { quickCheckReceipt: quickCheck.receipt } : {}),
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
		...(providerReliability ? { providerReliability } : {}),
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
