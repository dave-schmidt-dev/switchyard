import { createHash } from "node:crypto";
import { boundProviderLifecycleSnapshot } from "../adapter/provider-lifecycle.mjs";
import {
	reviewResultFromExecution,
	unavailableReviewResult,
} from "../diagnostics/review-result.mjs";
import { reviewTransition } from "../outcome/transitions.mjs";
import { descriptorReceiptFields } from "./ledger-reporting.mjs";

function servedModelVerificationFields(execution) {
	const projected = execution?.servedModelVerified;
	if (projected === true || projected === false) {
		return { servedModelVerified: projected };
	}
	if (execution?.servedModel === undefined) return {};
	return { servedModelVerified: Boolean(execution.servedModel) };
}
function survivingProviderFields(execution) {
	const fields = {};
	if (
		execution?.providerLifecycle &&
		typeof execution.providerLifecycle === "object"
	) {
		fields.providerLifecycle = boundProviderLifecycleSnapshot(
			execution.providerLifecycle,
		);
	}
	if (
		execution?.executionOutcome &&
		typeof execution.executionOutcome === "object"
	) {
		fields.executionOutcome = execution.executionOutcome;
	}
	if (execution?.cleanupFailed === true) {
		Object.assign(fields, {
			cleanupFailed: true,
			cleanupStage: execution.cleanupStage ?? null,
		});
	}
	if (
		execution?.diagnosticEvidenceAvailable === true &&
		typeof execution?.diagnosticRef === "string" &&
		/^diagnostic:[a-f0-9]{32}$/u.test(execution.diagnosticRef)
	) {
		fields.diagnosticRef = execution.diagnosticRef;
	}
	return fields;
}
function reviewTaskResult(
	task,
	execution,
	routeResult,
	invocationDescriptor,
	requiredCapability,
	resolvedTargetId,
) {
	if (task.type !== "review") return null;
	const reviewResult = reviewResultFromExecution(execution);
	const reviewDecision = reviewTransition({
		status: reviewResult.status === "available" ? "succeeded" : "uncertain",
		reviewResult,
		available: reviewResult.status === "available",
		code:
			reviewResult.status === "available"
				? "review_completed"
				: "review_unavailable",
	});
	const available = reviewDecision.available;
	return {
		...descriptorReceiptFields(invocationDescriptor),
		taskId: task.id,
		success: available,
		provider: routeResult.provider,
		model: routeResult.model ?? null,
		requiredCapability,
		resolvedTargetId,
		result: available ? "review_completed" : "review_unavailable",
		reviewResult: reviewDecision.reviewResult,
		...(available
			? {}
			: {
					errorKind: "review_result_unavailable",
					reason: "Provider review result was unavailable or malformed.",
				}),
		...servedModelVerificationFields(execution),
		...survivingProviderFields(execution),
	};
}
function isStructuredReviewExecution(task, execution) {
	return task.type === "review" && execution?.success === true;
}
function retainsFailureDiff(task) {
	return task.type !== "review";
}
function reviewFailureFields(task, execution) {
	if (task.type !== "review") return {};
	const reviewDecision = reviewTransition({
		status: "uncertain",
		code: "review_unavailable",
		reviewResult: unavailableReviewResult(
			execution?.timedOut === true ? "timeout" : "provider_failed",
		),
		available: false,
	});
	return {
		reviewResult: reviewDecision.reviewResult,
	};
}
function normalizeSynchronousProviderExecution(execution) {
	if (!execution || typeof execution !== "object") return execution;
	const hasProviderDiagnostic = [
		"diagnosticEvidence",
		"diagnosticEvidenceAvailable",
		"diagnosticRef",
		"diagnosticCode",
		"diagnosticOrigin",
	].some((field) => Object.hasOwn(execution, field));
	return {
		...execution,
		// The synchronous adapter seam has no bounded artifact producer. A
		// provider-supplied availability bit or pre-mapped ref is therefore not
		// durable evidence and must not reach projections or retry decisions.
		...(hasProviderDiagnostic
			? { diagnosticEvidenceAvailable: false, diagnosticRef: null }
			: {}),
	};
}
function opaqueArtifactRef(value) {
	return typeof value === "string" && /^artifact:[a-f0-9]{24}$/.test(value)
		? value
		: undefined;
}
const DIFF_CAPTURE_STATUSES = new Set([
	"captured",
	"empty",
	"stage_failed",
	"diff_failed",
	"transport_failed",
	"timed_out",
]);
function normalizeDiffCaptureEvidence(value) {
	if (typeof value === "string") {
		return value.length > 0
			? { status: "captured", diff: value }
			: { status: "empty", diff: null };
	}
	if (
		value &&
		DIFF_CAPTURE_STATUSES.has(value.status) &&
		(typeof value.diff === "string" || value.diff == null)
	) {
		return {
			status: value.status,
			diff: value.status === "captured" ? value.diff : null,
			...(value.reasonCode ? { reasonCode: value.reasonCode } : {}),
		};
	}
	// Legacy adapters expose only string/null. Preserve their existing failure
	// semantics while allowing Vibe's detailed seam to report `empty` safely.
	return { status: "transport_failed", diff: null };
}
function captureDiffWithEvidence(adapter, workspaceName, options) {
	if (typeof adapter.captureDiffDetailed === "function") {
		return normalizeDiffCaptureEvidence(
			adapter.captureDiffDetailed(workspaceName, options),
		);
	}
	const diff = adapter.captureDiff(workspaceName, options);
	return typeof diff === "string"
		? { status: diff.length > 0 ? "captured" : "empty", diff }
		: { status: "transport_failed", diff: null };
}
async function captureDiffWithEvidenceAsync(adapter, workspaceName, options) {
	if (typeof adapter.captureDiffDetailedAsync === "function") {
		return normalizeDiffCaptureEvidence(
			await adapter.captureDiffDetailedAsync(workspaceName, options),
		);
	}
	const diff = await adapter.captureDiffAsync(workspaceName, options);
	return typeof diff === "string"
		? { status: diff.length > 0 ? "captured" : "empty", diff }
		: { status: "transport_failed", diff: null };
}
function taskBaseProbeOptions(context, cleanupContext) {
	return {
		timeoutMs: 30_000,
		signal: context.signal,
		onStatus: context.onStatus,
		cleanupContext,
	};
}
function persistedTaskBaseHelperContext(base, currentOwnership) {
	const stored = base?.cleanupContext;
	if (stored?.operation !== "helper") {
		throw new Error("persisted task base has no exact helper identity");
	}
	for (const field of [
		"runId",
		"taskId",
		"attemptId",
		"descriptorIdentity",
		"workspaceId",
	]) {
		if (typeof stored[field] !== "string" || stored[field].length === 0) {
			throw new Error(`persisted task base has invalid ${field}`);
		}
	}
	if (
		stored.processStartIdentity !== null &&
		typeof stored.processStartIdentity !== "string"
	) {
		throw new Error("persisted task base has invalid processStartIdentity");
	}
	for (const field of ["runId", "taskId", "workspaceId"]) {
		if (stored[field] !== currentOwnership[field]) {
			throw new Error(`persisted task base has foreign ${field}`);
		}
	}
	return true;
}
function integrationOperation(context, task, diff) {
	const checkpoint = context.checkpoint;
	if (!checkpoint || typeof diff !== "string") return null;
	const patch = diff.endsWith("\n") ? diff : `${diff}\n`;
	const patchHash = createHash("sha256").update(patch, "utf8").digest("hex");
	const baseTree = context._activeTaskBase?.tree;
	if (typeof baseTree !== "string" || !baseTree) return null;
	const existing = checkpoint.integrationIntents?.[task.id];
	if (
		existing &&
		existing.operation?.patchHash === patchHash &&
		existing.operation?.baseTree === baseTree &&
		JSON.stringify(existing.operation?.paths) ===
			JSON.stringify(task.requiredPaths ?? []) &&
		(existing.operation?.dirtyOverlayReceiptHash ?? null) ===
			(context.dirtyOverlayReceipt?.receiptHash ?? null)
	) {
		return {
			...existing.operation,
			baseTree,
			patchHash,
			paths: [...(task.requiredPaths ?? [])],
			dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
		};
	}
	return {
		runId: context.runId ?? checkpoint.owner.runId,
		taskId: task.id,
		attempt: (checkpoint.taskAttempts?.[task.id] ?? 0) + 1,
		baseTree,
		patchHash,
		paths: [...(task.requiredPaths ?? [])],
		dirtyOverlayReceiptHash: context.dirtyOverlayReceipt?.receiptHash ?? null,
	};
}

export {
	captureDiffWithEvidence,
	captureDiffWithEvidenceAsync,
	integrationOperation,
	isStructuredReviewExecution,
	normalizeSynchronousProviderExecution,
	opaqueArtifactRef,
	persistedTaskBaseHelperContext,
	retainsFailureDiff,
	reviewFailureFields,
	reviewTaskResult,
	servedModelVerificationFields,
	survivingProviderFields,
	taskBaseProbeOptions,
};
