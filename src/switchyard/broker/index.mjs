import {
	getInvocationDescriptor,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { route } from "../router/index.mjs";
import { createReservationLedger } from "./reservations.mjs";
import {
	BROKER_CONTRACT_VERSION,
	validateBrokerRequest,
	validateBrokerResult,
} from "./schema.mjs";

function requireDependency(value, label) {
	if (typeof value !== "function") {
		throw new TypeError(`broker dependency ${label} must be a function`);
	}
	return value;
}

function validateAdapterRegistry(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("broker dependency adapters must be an object");
	}
	return value;
}

/**
 * Construct the selection boundary without copying router, roster, adapter,
 * or executor policy. Tests and callers can replace each seam independently.
 */
export function createBroker(dependencies = {}) {
	const routeTask = requireDependency(dependencies.route ?? route, "route");
	const resolveIdentity = requireDependency(
		dependencies.resolveTargetIdentity ?? resolveTargetIdentity,
		"resolveTargetIdentity",
	);
	const resolveDescriptor = requireDependency(
		dependencies.getInvocationDescriptor ?? getInvocationDescriptor,
		"getInvocationDescriptor",
	);
	const adapters = validateAdapterRegistry(dependencies.adapters ?? {});
	const reservations =
		dependencies.reservations ??
		createReservationLedger(dependencies.reservationOptions);
	if (
		!reservations ||
		typeof reservations.reserveWithSelection !== "function" ||
		typeof reservations.terminal !== "function"
	) {
		throw new TypeError("broker dependency reservations is invalid");
	}
	const ownerId = dependencies.ownerId ?? `pid:${process.pid}`;
	const reservationCapacity = dependencies.reservationCapacity ?? 100;
	if (
		typeof reservationCapacity !== "number" ||
		!Number.isFinite(reservationCapacity) ||
		reservationCapacity <= 0
	) {
		throw new TypeError(
			"broker dependency reservationCapacity must be positive",
		);
	}
	if (
		dependencies.executor !== undefined &&
		typeof dependencies.executor !== "function"
	) {
		throw new TypeError("broker dependency executor must be a function");
	}

	function select(requestValue) {
		const request = validateBrokerRequest(requestValue);
		for (const adapter of request.availableAdapters) {
			if (!Object.hasOwn(adapters, adapter) || !adapters[adapter]) {
				throw new Error(
					`caller-declared adapter '${adapter}' is unavailable in the broker registry`,
				);
			}
		}

		const availableProviders = request.availableAdapters.filter((adapter) =>
			Object.hasOwn(adapters, adapter),
		);
		const routed = routeTask({
			runId: request.runId,
			requiredCapability: request.capability,
			availableProviders,
			snapshotSource: request.snapshotSource,
		});
		if (!routed || typeof routed !== "object" || Array.isArray(routed)) {
			throw new Error("router returned a malformed result");
		}

		const snapshotIdentity = {
			source: request.snapshotSource,
			status: routed.snapshotStatus ?? "not_reported",
			mtime: routed.snapshotMtime ?? null,
			ageMs: routed.snapshotAgeMsAtRoute ?? null,
		};
		if (!routed.provider) {
			return validateBrokerResult({
				schemaVersion: BROKER_CONTRACT_VERSION,
				runId: request.runId,
				taskId: request.taskId,
				capability: request.capability,
				provider: null,
				resolvedTarget: null,
				harness: null,
				model: null,
				effort: null,
				snapshotIdentity,
				reservation: null,
				reason: routed.reason ?? "no_route",
			});
		}

		const identity = resolveIdentity(routed.provider);
		if (!identity?.targetId || !identity.harnessKey || identity.ambiguous) {
			throw new Error("router provider has no unambiguous roster identity");
		}
		if (
			(routed.resolvedTargetId != null &&
				routed.resolvedTargetId !== identity.targetId) ||
			(routed.resolvedTarget != null &&
				routed.resolvedTarget !== identity.targetId) ||
			(routed.harness != null && routed.harness !== identity.harnessKey)
		) {
			throw new Error("router and roster identity disagree");
		}
		if (
			!request.availableAdapters.includes(identity.harnessKey) ||
			!Object.hasOwn(adapters, identity.harnessKey)
		) {
			throw new Error(
				`routed harness '${identity.harnessKey}' is unavailable to the caller`,
			);
		}

		const descriptor = resolveDescriptor(routed.provider, request.capability);
		if (!descriptor) {
			throw new Error("routed provider has no dispatchable descriptor");
		}
		if (
			descriptor.target_id !== identity.targetId ||
			descriptor.selector !== routed.model
		) {
			throw new Error("router, roster, and invocation descriptor disagree");
		}

		return validateBrokerResult({
			schemaVersion: BROKER_CONTRACT_VERSION,
			runId: request.runId,
			taskId: request.taskId,
			capability: request.capability,
			provider: routed.provider,
			resolvedTarget: identity.targetId,
			harness: identity.harnessKey,
			model: descriptor.selector,
			effort: descriptor.effort ?? descriptor.variant ?? null,
			snapshotIdentity,
			reservation: null,
			reason: routed.reason ?? "selected",
		});
	}

	async function selectAndReserve(requestValue) {
		const request = validateBrokerRequest(requestValue);
		let selected = null;
		const reservation = await reservations.reserveWithSelection(() => {
			selected = select(request);
			if (!selected.provider) return null;
			const generation =
				selected.snapshotIdentity.mtime ?? selected.snapshotIdentity.status;
			return {
				provider: selected.provider,
				window: `${selected.snapshotIdentity.source}@${generation}`,
				runId: request.runId,
				taskId: request.taskId,
				ownerId,
				ownerPid: process.pid,
				estimatedConsumption: request.estimatedConsumption,
				capacity: reservationCapacity,
			};
		});
		if (!selected) {
			throw new Error("reservation selector did not produce a broker result");
		}
		if (!selected.provider || reservation) {
			return validateBrokerResult({ ...selected, reservation });
		}
		return validateBrokerResult({
			...selected,
			provider: null,
			resolvedTarget: null,
			harness: null,
			model: null,
			effort: null,
			reservation: null,
			reason: "capacity_unavailable",
		});
	}

	async function reconcile(resultValue, actualConsumption) {
		const result = validateBrokerResult(resultValue);
		if (!result.reservation)
			throw new Error("broker result has no reservation");
		return reservations.terminal({
			reservationId: result.reservation.id,
			ownerId,
			outcome: "success",
			actualConsumption,
		});
	}

	async function release(resultValue, outcome = "failure") {
		const result = validateBrokerResult(resultValue);
		if (!result.reservation)
			throw new Error("broker result has no reservation");
		return reservations.terminal({
			reservationId: result.reservation.id,
			ownerId,
			outcome,
		});
	}

	return Object.freeze({
		select,
		selectAndReserve,
		reconcile,
		release,
	});
}

/** One-shot convenience wrapper for callers that do not retain a broker. */
export function selectBrokerRoute(request, dependencies) {
	return createBroker(dependencies).select(request);
}
