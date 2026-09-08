import {
	CLEANUP_STAGES,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { createProgressSnapshot } from "../adapter/provider-lifecycle.mjs";
import { isReviewResult } from "../diagnostics/review-result.mjs";
import { validateInvocationDescriptor } from "../roster/index.mjs";
import { validateBrokerRequest, validateBrokerResult } from "./schema.mjs";

const TERMINAL_OUTCOMES = new Set(["success", "failure", "cancel"]);
const FAILURE_KINDS = new Set(["provider", "transient"]);
const DIAGNOSTIC_REF_RE = /^diagnostic:[a-f0-9]{32}$/u;

/**
 * Bound a launcher's cleanup stage to the backend-owned vocabulary.
 *
 * `sanitizeFailureMetadata` reads this value to derive a diagnostic code but
 * does not return it, so it has to be forwarded explicitly to survive the
 * frozen result shapes below.
 * @param {unknown} launcherResult
 * @returns {string|null}
 */
function cleanupStageOf(launcherResult) {
	return CLEANUP_STAGES.has(launcherResult?.cleanupStage)
		? launcherResult.cleanupStage
		: null;
}

function diagnosticRefOf(launcherResult) {
	return DIAGNOSTIC_REF_RE.test(launcherResult?.diagnosticRef ?? "")
		? launcherResult.diagnosticRef
		: null;
}
/**
 * Relay the launcher's review verdict in its closed, already-sanitized shape.
 * A review task's structured result is the whole of what the runner may act on,
 * so without it here the frozen allowlist dropped every verdict a broker route
 * produced and each review terminated as an undiagnosed `review_unavailable`.
 * Raw provider bytes still never cross: the launcher derives the result while
 * the transcript is in hand, and this boundary only re-validates the closed
 * schema. Anything else is dropped to null.
 */
function reviewResultOf(launcherResult) {
	const relayed = launcherResult?.reviewResult;
	return isReviewResult(relayed) ? relayed : null;
}

function sameSnapshot(left, right) {
	return (
		left?.source === right?.source &&
		left?.status === right?.status &&
		left?.mtime === right?.mtime &&
		left?.ageMs === right?.ageMs
	);
}

function validateLaunchIdentity(value, route, descriptor) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("launcher identity must be an object");
	}
	const expected = {
		provider: route.provider,
		resolvedTarget: route.resolvedTarget,
		harness: route.harness,
		model: route.model,
		effort: route.effort,
		descriptorIdentity: descriptor.descriptor_identity,
		reservationId: route.reservation?.id ?? null,
	};
	for (const [field, expectedValue] of Object.entries(expected)) {
		if (value[field] !== expectedValue) {
			throw new Error(`launcher identity drift: ${field}`);
		}
	}
	if (!sameSnapshot(value.snapshotIdentity, route.snapshotIdentity)) {
		throw new Error("launcher identity drift: snapshotIdentity");
	}
	return Object.freeze({
		...expected,
		snapshotIdentity: route.snapshotIdentity,
	});
}

function emit(onStatus, event, route, extra = {}) {
	try {
		onStatus?.({
			phase: "broker_execution",
			event,
			status: event.replaceAll("_", " "),
			runId: route.runId,
			taskId: route.taskId,
			provider: route.provider,
			model: route.model,
			...extra,
		});
	} catch {
		// Status is a best-effort side channel and never owns task state.
	}
}

function boundedTerminalEvidence(value) {
	const state = new Set(["reconciled", "released"]).has(value?.state)
		? value.state
		: null;
	return Object.freeze({
		changed: value?.changed === true,
		state,
	});
}

function boundedProgress(value) {
	if (!value || typeof value !== "object") return null;
	return createProgressSnapshot({
		stage: value.stage,
		elapsedMs: value.elapsedMs,
		lastSubstantiveProgressAt: value.lastSubstantiveProgressAt,
		lastSubstantiveProgressAgeMs: value.lastSubstantiveProgressAgeMs,
		stdoutBytes: value.counters?.stdoutBytes,
		stderrBytes: value.counters?.stderrBytes,
		pollCount: value.counters?.polls,
		progressCount: value.counters?.progressEvents,
		outcome: value.outcome,
	});
}

/**
 * Launch one reserved broker route and reconcile it exactly once.
 * Provider output remains inside the launcher; only bounded status and terminal
 * evidence cross this boundary.
 */
const PROOF_ID_RE = /^[A-Za-z0-9._:/-]{1,256}$/;

/**
 * Relay the launcher's completion-continuation lifecycle receipt only in its
 * exact closed shape. The runner reads it off every broker result to decide
 * whether a same-task continuation or a route-health terminal binding may
 * trust the invocation's cleanup; a partial or free-form object is dropped
 * to null so it can never pass as proof or carry launcher output.
 */
function completionContinuationProofOf(launcherResult) {
	const proof = launcherResult?.completionContinuationProof;
	if (
		!proof ||
		typeof proof !== "object" ||
		proof.version !== 1 ||
		proof.kind !== "completion_continuation_lifecycle" ||
		typeof proof.providerExited !== "boolean" ||
		typeof proof.childrenExited !== "boolean" ||
		typeof proof.cleanupSucceeded !== "boolean" ||
		![
			proof.taskId,
			proof.attemptId,
			proof.descriptorIdentity,
			proof.workspaceId,
		].every((value) => typeof value === "string" && PROOF_ID_RE.test(value))
	)
		return null;
	return Object.freeze({
		version: 1,
		kind: "completion_continuation_lifecycle",
		providerExited: proof.providerExited,
		childrenExited: proof.childrenExited,
		cleanupSucceeded: proof.cleanupSucceeded,
		taskId: proof.taskId,
		attemptId: proof.attemptId,
		descriptorIdentity: proof.descriptorIdentity,
		workspaceId: proof.workspaceId,
	});
}

export async function executeBrokerRoute(options) {
	const request = validateBrokerRequest(options?.request);
	const route = validateBrokerResult(options?.route);
	if (!route.provider || !route.reservation) {
		throw new Error("broker execution requires a reserved route");
	}
	if (
		route.runId !== request.runId ||
		route.taskId !== request.taskId ||
		route.capability !== request.capability ||
		route.snapshotIdentity.source !== request.snapshotSource ||
		!request.availableAdapters.includes(route.harness)
	) {
		throw new Error("reserved route does not match broker request");
	}
	if (typeof options.launch !== "function") {
		throw new TypeError("broker launcher must be a function");
	}
	if (typeof options.terminal !== "function") {
		throw new TypeError("broker terminal reconciler must be a function");
	}
	const signal = options.signal ?? null;
	let terminalOutcome = null;
	let terminalCompleted = false;
	let terminalEvidence;
	let launcherResult = null;
	const descriptorIdentity =
		typeof options.invocationDescriptor?.descriptor_identity === "string" &&
		/^sha256:[a-f0-9]{64}$/.test(
			options.invocationDescriptor.descriptor_identity,
		)
			? options.invocationDescriptor.descriptor_identity
			: null;
	const reconcileOnce = async (outcome, actualConsumption) => {
		if (terminalOutcome !== null) {
			throw new Error("broker route already reconciled");
		}
		if (!TERMINAL_OUTCOMES.has(outcome)) {
			throw new TypeError("invalid broker terminal outcome");
		}
		terminalOutcome = outcome;
		emit(options.onStatus, "terminal_reconciling", route, { outcome });
		terminalEvidence = boundedTerminalEvidence(
			await options.terminal({ outcome, actualConsumption }),
		);
		terminalCompleted = true;
	};

	emit(options.onStatus, "execution_waiting", route);
	if (signal?.aborted) {
		await reconcileOnce("cancel", null);
		emit(options.onStatus, "execution_cancelled", route);
		return Object.freeze({
			runId: route.runId,
			taskId: route.taskId,
			provider: route.provider,
			model: route.model,
			success: false,
			outcome: "cancel",
			reason: "cancelled before launch",
			terminalEvidence,
		});
	}

	try {
		const descriptor = validateInvocationDescriptor(
			options.invocationDescriptor,
			route.harness,
		);
		if (
			descriptor.target_id !== route.resolvedTarget ||
			descriptor.selector !== route.model ||
			(descriptor.effort ?? descriptor.variant ?? null) !== route.effort
		) {
			throw new Error("invocation descriptor drift");
		}
		const launcherIdentity = validateLaunchIdentity(
			options.launcherIdentity,
			route,
			descriptor,
		);
		emit(options.onStatus, "execution_started", route);
		launcherResult = await options.launch({
			request,
			route,
			invocationDescriptor: descriptor,
			launcherIdentity,
			signal,
			onStatus: (progress = {}) =>
				emit(options.onStatus, "execution_progress", route, {
					elapsedMs: Number.isFinite(progress.elapsedMs)
						? Math.max(0, progress.elapsedMs)
						: null,
				}),
			onProgress: (progress) =>
				emit(options.onStatus, "execution_progress", route, {
					progress: boundedProgress(progress),
				}),
			onAdapterStatus: options.onAdapterStatus,
			onPoll: options.onPoll,
			onTaskHeartbeat: options.onTaskHeartbeat,
		});
		// Persistence is owned by the adapter/run-store boundary.  The broker
		// only carries a strict reference returned by that producer and drops
		// the in-process streams before constructing any durable result.
		const diagnosticRef = diagnosticRefOf(launcherResult);
		launcherResult = {
			...launcherResult,
			diagnosticRef,
			diagnosticEvidenceAvailable: diagnosticRef !== null,
		};
		delete launcherResult.diagnosticEvidence;
		if (signal?.aborted || launcherResult?.cancelled === true) {
			await reconcileOnce("cancel", null);
			emit(options.onStatus, "execution_cancelled", route);
			return Object.freeze({
				runId: route.runId,
				taskId: route.taskId,
				provider: route.provider,
				model: route.model,
				success: false,
				outcome: "cancel",
				reason: "cancelled",
				terminalEvidence,
			});
		}
		if (launcherResult?.success !== true) {
			throw new Error("launcher failed");
		}
		const actualConsumption =
			Number.isFinite(launcherResult.actualConsumption) &&
			launcherResult.actualConsumption > 0
				? launcherResult.actualConsumption
				: request.estimatedConsumption;
		await reconcileOnce("success", actualConsumption);
		emit(options.onStatus, "execution_succeeded", route);
		return Object.freeze({
			runId: route.runId,
			taskId: route.taskId,
			provider: route.provider,
			model: route.model,
			success: true,
			outcome: "success",
			actualConsumption,
			// A task can succeed while the kill of its provider process fails.
			// These carried on the failure shape only, so that case reached a
			// result with no record that anything was left running.
			cleanupFailed: launcherResult?.cleanupFailed === true,
			cleanupStage: cleanupStageOf(launcherResult),
			// A bounded boolean from the launcher, not the guest-supplied model
			// name. Without it here the frozen allowlist silently dropped the
			// adapter's served-model read-back before it could reach a result.
			servedModelVerified:
				typeof launcherResult?.servedModelVerified === "boolean"
					? launcherResult.servedModelVerified
					: null,
			completionContinuationProof:
				completionContinuationProofOf(launcherResult),
			reviewResult: reviewResultOf(launcherResult),
			terminalEvidence,
			progress: boundedProgress(launcherResult?.progress),
		});
	} catch (error) {
		const cancelled = signal?.aborted || error?.name === "AbortError";
		const outcome = cancelled ? "cancel" : "failure";
		if (terminalOutcome === null) await reconcileOnce(outcome, null);
		const failure = sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: launcherResult?.errorKind,
			timedOut: launcherResult?.timedOut === true,
			diagnosticCode: launcherResult?.diagnosticCode,
			exitCode: launcherResult?.exitCode,
			signal: launcherResult?.signal,
			failurePhase:
				launcherResult?.failurePhase ??
				(!terminalCompleted ? "terminal_reconciliation" : "provider_execution"),
			diagnosticOrigin: launcherResult?.diagnosticOrigin,
			diagnosticEvidenceAvailable: launcherResult?.diagnosticEvidenceAvailable,
			diagnosticRef: launcherResult?.diagnosticRef,
			resolvedTargetId: route.resolvedTarget,
			descriptorIdentity,
			descriptorHarness: route.harness,
		});
		emit(
			options.onStatus,
			cancelled ? "execution_cancelled" : "execution_failed",
			route,
			failure ?? {},
		);
		return Object.freeze({
			runId: route.runId,
			taskId: route.taskId,
			provider: route.provider,
			model: route.model,
			success: false,
			reason: cancelled
				? "cancelled"
				: !terminalCompleted
					? "terminal_reconciliation_failed"
					: launcherResult?.silenceTimedOut === true
						? "provider made no substantive progress before the silence deadline"
						: launcherResult?.timedOut === true
							? launcherResult?.reason || "provider execution timed out"
							: error?.message?.includes("drift") ||
									error?.message?.includes("identity")
								? "identity_drift"
								: "launcher_failed",
			timedOut: launcherResult?.timedOut === true,
			silenceTimedOut: launcherResult?.silenceTimedOut === true,
			// A failed execution carries no verdict the runner may act on; the runner
			// attaches the explicit unavailable reason for the failure it classified.
			reviewResult: null,
			// Broker reconciliation owns this terminal vocabulary. Provider-specific
			// classifications remain in errorKind/silenceTimedOut/progress.
			outcome,
			cleanupFailed: launcherResult?.cleanupFailed === true,
			cleanupStage: cleanupStageOf(launcherResult),
			failureKind: FAILURE_KINDS.has(launcherResult?.failureKind)
				? launcherResult.failureKind
				: null,
			errorKind:
				launcherResult?.errorKind === "silence_timeout"
					? "silence_timeout"
					: (failure?.errorKind ?? null),
			diagnosticCode: failure?.diagnosticCode ?? null,
			exitCode: failure?.exitCode ?? null,
			signal: failure?.signal ?? null,
			failurePhase: failure?.failurePhase ?? null,
			diagnosticOrigin: failure?.diagnosticOrigin ?? null,
			diagnosticEvidenceAvailable:
				failure?.diagnosticEvidenceAvailable ?? false,
			diagnosticRef: failure?.diagnosticRef ?? null,
			resolvedTargetId: failure?.resolvedTargetId ?? null,
			descriptorIdentity: failure?.descriptorIdentity ?? null,
			descriptorHarness: failure?.descriptorHarness ?? null,
			servedModelVerified:
				typeof launcherResult?.servedModelVerified === "boolean"
					? launcherResult.servedModelVerified
					: null,
			completionContinuationProof:
				completionContinuationProofOf(launcherResult),
			terminalEvidence,
			progress: boundedProgress(launcherResult?.progress),
		});
	}
}
