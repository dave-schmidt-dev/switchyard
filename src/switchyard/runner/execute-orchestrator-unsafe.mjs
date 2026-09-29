import { boundCompletionContinuationProof } from "../adapter/provider-lifecycle.mjs";
import { HOST_POWER_STATES } from "../dispatch/host-power.mjs";
import {
	getConfiguredInvocationDescriptor,
	getInvocationDescriptor,
	resolveRouteProvenance,
} from "../roster/index.mjs";
import {
	DISPATCH_DESCRIPTOR_CONTRACT_VERSION,
	ORCHESTRATOR_PAYLOAD_VERSION,
} from "./constants.mjs";
import { boundedProgressProjection } from "./halts.mjs";
import {
	DESCRIPTOR_RECEIPT_INVALID_REASON,
	descriptorFromRoute,
	descriptorReceiptFields,
	dispatchIntentPayload,
	reportLegacyProjectionFailure,
	safeNoProviderReason,
	safeSuccessfulRouteReason,
	writeDispatchIntentAsync,
} from "./ledger-reporting.mjs";
import { quickCheckDecisionAsync } from "./quick-checks.mjs";
import {
	integrationFailureMetadata,
	taskPromptForAttempt,
} from "./retry-transitions.mjs";
import {
	captureDiffWithEvidenceAsync,
	isStructuredReviewExecution,
	opaqueArtifactRef,
	reviewFailureFields,
	reviewTaskResult,
} from "./review-results.mjs";
import {
	bindAttemptHelperBackend,
	executionCleanupContext,
	healthDeferredResult,
	policyDeferredTaskResult,
	prepareRouteHealthTrial,
	readQueueHostPower,
	startRouteHealthTrial,
} from "./route-health.mjs";
import {
	checkpointIntegrationIntent,
	prepareTaskBaseAsync,
	taskBaseFailure,
	taskBaseMatches,
} from "./task-base.mjs";
import {
	declaredPathNotSeededResult,
	dirtyOverlayIntegrationGate,
	dirtyOverlayResult,
	findIgnoredDeclaredPath,
	nonSwitchyardExecutorResult,
	resolveTaskExecutor,
	resolveTaskRequiredCapability,
	selectAdapter,
	waitForJobCompletion,
} from "./task-routing.mjs";

export async function executeTaskWithOrchestratorUnsafe(task, context) {
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
		...(context.qualificationAttempt
			? { hasInvocationDescriptor: context.hasInvocationDescriptor }
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
			context.resolveDescriptor ??
				(context.qualificationAttempt
					? getConfiguredInvocationDescriptor
					: getInvocationDescriptor),
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
	context._activeCompletionLifecycleReceipt = boundCompletionContinuationProof(
		jobResult.completionContinuationProof,
	);

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
