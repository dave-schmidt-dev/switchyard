import { validateInvocationDescriptor } from "../roster/index.mjs";
import { validateBrokerRequest, validateBrokerResult } from "./schema.mjs";

const TERMINAL_OUTCOMES = new Set(["success", "failure", "cancel"]);

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
		const result = await options.launch({
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
		});
		if (signal?.aborted || result?.cancelled === true) {
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
		if (result?.success !== true) {
			throw new Error("launcher failed");
		}
		const actualConsumption =
			Number.isFinite(result.actualConsumption) && result.actualConsumption > 0
				? result.actualConsumption
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
			terminalEvidence,
		});
	} catch (error) {
		const cancelled = signal?.aborted || error?.name === "AbortError";
		const outcome = cancelled ? "cancel" : "failure";
		if (terminalOutcome === null) await reconcileOnce(outcome, null);
		emit(
			options.onStatus,
			cancelled ? "execution_cancelled" : "execution_failed",
			route,
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
					: error?.message?.includes("drift") ||
							error?.message?.includes("identity")
						? "identity_drift"
						: "launcher_failed",
			terminalEvidence,
		});
	}
}
