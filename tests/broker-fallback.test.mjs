import { rejects, strictEqual } from "node:assert";

import { describe, it } from "node:test";
import { createBroker } from "../src/switchyard/broker/index.mjs";
import { createReservationLedger } from "../src/switchyard/broker/reservations.mjs";
import { BROKER_CONTRACT_VERSION } from "../src/switchyard/broker/schema.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

function request(overrides = {}) {
	return {
		schemaVersion: BROKER_CONTRACT_VERSION,
		capability: "standard",
		dataClass: "repository",
		estimatedConsumption: 1,
		runId: "run-1",
		taskId: "TASK-001",
		snapshotSource: "gradus-v2",
		availableAdapters: ["cheap", "peer", "high"],
		...overrides,
	};
}

function reservationLedger() {
	let sequence = 0;
	let terminalCalls = 0;
	const fallbackAttempts = new Set();
	return {
		get terminalCalls() {
			return terminalCalls;
		},
		async reserveWithSelection(select, fallbackContext = null) {
			if (fallbackContext) {
				const key = `${fallbackContext.runId}:${fallbackContext.taskId}`;
				if (fallbackAttempts.has(key)) {
					throw new Error("fallback already attempted for this task");
				}
				fallbackAttempts.add(key);
			}
			const selected = await select([]);
			return selected
				? {
						id: `reservation-${++sequence}`,
						provider: selected.provider,
						runId: selected.runId,
						taskId: selected.taskId,
						amount: selected.estimatedConsumption,
					}
				: null;
		},
		async terminal() {
			terminalCalls += 1;
			return { changed: true };
		},
	};
}

function dependencies(overrides = {}) {
	const reservations = overrides.reservations ?? reservationLedger();
	return {
		adapters: { cheap: {}, peer: {}, high: {} },
		now: () => NOW,
		readSnapshot: async () => ({
			snapshot: {
				schema_version: 2,
				updated_at: new Date(NOW - 1_000).toISOString(),
				providers: [],
			},
			snapshotMtime: 123,
		}),
		route: ({ requiredCapability, exclude, snapshotRead }) => {
			const provider = !exclude.includes("Cheap")
				? "Cheap"
				: requiredCapability === "high"
					? "High"
					: "Peer";
			return {
				provider,
				model: `${provider.toLowerCase()}-${requiredCapability}`,
				resolvedTargetId: provider.toLowerCase(),
				reason: "ranked",
				snapshotStatus: snapshotRead.snapshotStatus,
				snapshotMtime: snapshotRead.snapshotMtime,
				snapshotAgeMsAtRoute: snapshotRead.snapshotAgeMsAtRoute,
			};
		},
		resolveTargetIdentity: (provider) => ({
			targetId: provider.toLowerCase(),
			harnessKey: provider.toLowerCase(),
			ambiguous: false,
		}),
		getInvocationDescriptor: (provider, capability) => ({
			target_id: provider.toLowerCase(),
			selector: `${provider.toLowerCase()}-${capability}`,
			effort: "high",
		}),
		...overrides,
		reservations,
	};
}

describe("broker fallback", () => {
	it("uses one different provider without changing capability", async () => {
		const broker = createBroker(dependencies());
		const first = await broker.selectAndReserve(request());
		const fallback = await broker.fallbackAndReserve(request(), first, {
			failureKind: "transient",
		});
		strictEqual(fallback.provider, "Peer");
		strictEqual(fallback.capability, "standard");
		await rejects(
			broker.fallbackAndReserve(request(), fallback, {
				failureKind: "transient",
			}),
			/fallback request|already attempted/,
		);
	});

	it("uses an explicit one-tier ceiling only after same-tier exhaustion", async () => {
		const broker = createBroker(
			dependencies({
				route: ({ requiredCapability, exclude, snapshotRead }) => {
					const provider = !exclude.includes("Cheap")
						? "Cheap"
						: requiredCapability === "high"
							? "High"
							: null;
					return {
						provider,
						model: provider
							? `${provider.toLowerCase()}-${requiredCapability}`
							: null,
						resolvedTargetId: provider?.toLowerCase() ?? null,
						reason: provider ? "ranked" : "no_route",
						snapshotStatus: snapshotRead.snapshotStatus,
						snapshotMtime: snapshotRead.snapshotMtime,
						snapshotAgeMsAtRoute: snapshotRead.snapshotAgeMsAtRoute,
					};
				},
			}),
		);
		const first = await broker.selectAndReserve(request());
		const fallback = await broker.fallbackAndReserve(request(), first, {
			failureKind: "provider",
			capabilityCeiling: "high",
		});
		strictEqual(fallback.provider, "High");
		strictEqual(fallback.capability, "high");
	});

	it("rejects absent or wider ceilings before releasing capacity", async () => {
		const reservations = reservationLedger();
		const broker = createBroker(dependencies({ reservations }));
		const first = await broker.selectAndReserve(request({ capability: "low" }));
		await rejects(
			broker.fallbackAndReserve(request({ capability: "low" }), first, {
				failureKind: "provider",
				capabilityCeiling: "high",
			}),
			/next tier/,
		);
		strictEqual(reservations.terminalCalls, 0);
	});

	it("rejects fallback routes outside caller-available adapters", async () => {
		const broker = createBroker(
			dependencies({
				route: ({ exclude, snapshotRead }) => ({
					provider: exclude.length ? "Outside" : "Cheap",
					model: exclude.length ? "outside-standard" : "cheap-standard",
					resolvedTargetId: exclude.length ? "outside" : "cheap",
					reason: "ranked",
					snapshotStatus: snapshotRead.snapshotStatus,
					snapshotMtime: snapshotRead.snapshotMtime,
					snapshotAgeMsAtRoute: snapshotRead.snapshotAgeMsAtRoute,
				}),
				resolveTargetIdentity: (provider) => ({
					targetId: provider.toLowerCase(),
					harnessKey: provider.toLowerCase(),
					ambiguous: false,
				}),
			}),
		);
		const first = await broker.selectAndReserve(request());
		await rejects(
			broker.fallbackAndReserve(request(), first, {
				failureKind: "provider",
			}),
			/unavailable to the caller/,
		);
	});

	it("preserves the one-fallback ceiling across broker restart", async () => {
		const root = await tempDirAsync("switchyard-fallback-");
		const firstBroker = createBroker(
			dependencies({ reservations: createReservationLedger({ root }) }),
		);
		const first = await firstBroker.selectAndReserve(request());
		const fallback = await firstBroker.fallbackAndReserve(request(), first, {
			failureKind: "provider",
		});
		const restartedBroker = createBroker(
			dependencies({ reservations: createReservationLedger({ root }) }),
		);
		await rejects(
			restartedBroker.fallbackAndReserve(request(), fallback, {
				failureKind: "provider",
			}),
			/fallback already attempted/,
		);
	});
});
