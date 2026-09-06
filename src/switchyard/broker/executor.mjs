import {
	CLEANUP_STAGES,
	sanitizeFailureMetadata,
} from "../adapter/exec-error.mjs";
import { validateInvocationDescriptor } from "../roster/index.mjs";
import { validateBrokerRequest, validateBrokerResult } from "./schema.mjs";

const TERMINAL_OUTCOMES = new Set(["success", "failure", "cancel"]);
const FAILURE_KINDS = new Set(["provider", "transient"]);

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
			onAdapterStatus: options.onAdapterStatus,
			onPoll: options.onPoll,
			onTaskHeartbeat: options.onTaskHeartbeat,
		});
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
			terminalEvidence,
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
			outcome,
			reason: cancelled
				? "cancelled"
				: !terminalCompleted
					? "terminal_reconciliation_failed"
					: launcherResult?.timedOut === true
						? launcherResult?.reason || "provider execution timed out"
						: error?.message?.includes("drift") ||
								error?.message?.includes("identity")
							? "identity_drift"
							: "launcher_failed",
			timedOut: launcherResult?.timedOut === true,
			cleanupFailed: launcherResult?.cleanupFailed === true,
			cleanupStage: cleanupStageOf(launcherResult),
			failureKind: FAILURE_KINDS.has(launcherResult?.failureKind)
				? launcherResult.failureKind
				: null,
			errorKind: failure?.errorKind ?? null,
			diagnosticCode: failure?.diagnosticCode ?? null,
			exitCode: failure?.exitCode ?? null,
			signal: failure?.signal ?? null,
			failurePhase: failure?.failurePhase ?? null,
			diagnosticOrigin: failure?.diagnosticOrigin ?? null,
			diagnosticEvidenceAvailable:
				failure?.diagnosticEvidenceAvailable ?? false,
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
		});
	}
}
