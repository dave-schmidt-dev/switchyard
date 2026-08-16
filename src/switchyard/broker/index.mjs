import {
	getInvocationDescriptor,
	resolveTargetIdentity,
} from "../roster/index.mjs";
import { readSnapshotAtRoute, route } from "../router/index.mjs";
import { createReservationLedger } from "./reservations.mjs";
import {
	BROKER_CONTRACT_VERSION,
	validateBrokerRequest,
	validateBrokerResult,
} from "./schema.mjs";
import { createSnapshotCoordinator } from "./snapshots.mjs";

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
	const snapshotSources = dependencies.snapshotSources ?? { "gradus-v2": null };
	if (
		!snapshotSources ||
		typeof snapshotSources !== "object" ||
		Array.isArray(snapshotSources)
	) {
		throw new TypeError("broker dependency snapshotSources must be an object");
	}
	const snapshots =
		dependencies.readSnapshot !== undefined || routeTask === route
			? createSnapshotCoordinator({
					read:
						dependencies.readSnapshot ??
						(({ source, nowMs }) => {
							if (!Object.hasOwn(snapshotSources, source)) {
								throw new Error("snapshot_source_unknown");
							}
							const sourcePath = snapshotSources[source];
							if (sourcePath !== null && typeof sourcePath !== "string") {
								throw new TypeError(
									"configured snapshot source must be a path or null",
								);
							}
							return readSnapshotAtRoute(nowMs, sourcePath ?? undefined);
						}),
					refresh: dependencies.refreshSnapshot,
					now: dependencies.now,
					maxAgeMs: dependencies.snapshotMaxAgeMs,
				})
			: null;
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

	function selectPrepared(requestValue, selectionOptions = {}) {
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
			snapshotRead: selectionOptions.snapshotRead,
			exclude: selectionOptions.exclude ?? [],
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

	function select(requestValue) {
		return selectPrepared(requestValue);
	}

	async function selectAndReserve(requestValue) {
		const request = validateBrokerRequest(requestValue);
		const snapshotRead = snapshots
			? await snapshots.prepare(request.snapshotSource)
			: undefined;
		let selected = null;
		const reservation = await reservations.reserveWithSelection(() => {
			selected = selectPrepared(request, { snapshotRead });
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

	const NEXT_CAPABILITY = Object.freeze({ low: "standard", standard: "high" });

	async function fallbackAndReserve(
		requestValue,
		previousResultValue,
		options = {},
	) {
		const request = validateBrokerRequest(requestValue);
		const previous = validateBrokerResult(previousResultValue);
		if (
			previous.runId !== request.runId ||
			previous.taskId !== request.taskId ||
			previous.capability !== request.capability ||
			!previous.provider ||
			!previous.reservation
		) {
			throw new Error("fallback request does not match the reserved route");
		}
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			throw new TypeError("fallback options must be an object");
		}
		for (const field of Object.keys(options)) {
			if (!new Set(["failureKind", "capabilityCeiling"]).has(field)) {
				throw new TypeError(`fallback options has unknown field '${field}'`);
			}
		}
		if (!new Set(["provider", "transient"]).has(options.failureKind)) {
			throw new Error("fallback is limited to provider or transient failures");
		}
		const ceiling = options.capabilityCeiling ?? request.capability;
		if (
			ceiling !== request.capability &&
			ceiling !== NEXT_CAPABILITY[request.capability]
		) {
			throw new Error(
				"fallback capability ceiling must be the current or next tier",
			);
		}
		const snapshotRead = snapshots
			? await snapshots.prepare(request.snapshotSource)
			: undefined;
		await release(previous, "failure");
		const capabilities =
			ceiling === request.capability
				? [request.capability]
				: [request.capability, ceiling];
		let selected = null;
		const reservation = await reservations.reserveWithSelection(
			() => {
				for (const capability of capabilities) {
					const candidateRequest = { ...request, capability };
					selected = selectPrepared(candidateRequest, {
						snapshotRead,
						exclude: [previous.provider],
					});
					if (selected.provider) {
						const generation =
							selected.snapshotIdentity.mtime ??
							selected.snapshotIdentity.status;
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
					}
				}
				return null;
			},
			{
				runId: request.runId,
				taskId: request.taskId,
				fromReservationId: previous.reservation.id,
			},
		);
		if (selected?.provider && reservation) {
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
			reason: selected?.provider
				? "capacity_unavailable"
				: "fallback_unavailable",
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
		fallbackAndReserve,
		reconcile,
		release,
	});
}

/** One-shot convenience wrapper for callers that do not retain a broker. */
export function selectBrokerRoute(request, dependencies) {
	return createBroker(dependencies).select(request);
}
