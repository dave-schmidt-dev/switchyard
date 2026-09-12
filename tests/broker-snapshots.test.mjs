import { rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { createBroker } from "../src/switchyard/broker/index.mjs";
import { BROKER_CONTRACT_VERSION } from "../src/switchyard/broker/schema.mjs";
import { accountingWindowKey } from "../src/switchyard/broker/snapshots.mjs";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

function request() {
	return {
		schemaVersion: BROKER_CONTRACT_VERSION,
		capability: "standard",
		dataClass: "repository",
		estimatedConsumption: 1,
		runId: "run-1",
		taskId: "TASK-001",
		snapshotSource: "gradus-v2",
		availableAdapters: ["codex"],
	};
}

function snapshot(updatedAt, overrides = {}) {
	return {
		snapshot: {
			schema_version: 2,
			updated_at: updatedAt,
			providers: [],
			...overrides,
		},
		snapshotMtime: 123,
	};
}

function ledger() {
	let reserveCalls = 0;
	return {
		get reserveCalls() {
			return reserveCalls;
		},
		async reserveWithSelection(select) {
			reserveCalls += 1;
			const selected = await select([]);
			return selected
				? {
						id: `reservation-${reserveCalls}`,
						provider: selected.provider,
						runId: selected.runId,
						taskId: selected.taskId,
						amount: selected.estimatedConsumption,
					}
				: null;
		},
		async terminal() {
			return { changed: true };
		},
	};
}

function dependencies(overrides = {}) {
	const reservations = overrides.reservations ?? ledger();
	return {
		adapters: { codex: {} },
		now: () => NOW,
		readSnapshot: async () => snapshot(new Date(NOW - 1_000).toISOString()),
		route: ({ snapshotRead }) => ({
			provider: "Codex",
			model: "codex-standard",
			resolvedTargetId: "codex",
			reason: "ranked",
			snapshotStatus: snapshotRead.snapshotStatus,
			snapshotMtime: snapshotRead.snapshotMtime,
			snapshotAgeMsAtRoute: snapshotRead.snapshotAgeMsAtRoute,
		}),
		resolveTargetIdentity: () => ({
			targetId: "codex",
			harnessKey: "codex",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => ({
			target_id: "codex",
			selector: "codex-standard",
			effort: "high",
		}),
		...overrides,
		reservations,
	};
}

describe("broker snapshot freshness", () => {
	it("uses a fresh snapshot without refreshing", async () => {
		let refreshCalls = 0;
		const result = await createBroker(
			dependencies({ refreshSnapshot: async () => refreshCalls++ }),
		).selectAndReserve(request());
		strictEqual(result.snapshotIdentity.status, "fresh");
		strictEqual(refreshCalls, 0);
	});

	it("refreshes stale input exactly once and routes the re-read generation", async () => {
		let reads = 0;
		let refreshCalls = 0;
		const result = await createBroker(
			dependencies({
				readSnapshot: async () =>
					++reads === 1
						? snapshot(new Date(NOW - 600_000).toISOString())
						: snapshot(new Date(NOW - 1_000).toISOString(), {
								providers: [{ name: "Codex" }],
							}),
				refreshSnapshot: async () => refreshCalls++,
			}),
		).selectAndReserve(request());
		strictEqual(result.provider, "Codex");
		strictEqual(reads, 2);
		strictEqual(refreshCalls, 1);
	});

	it("fails closed after one unsuccessful refresh without reserving", async () => {
		const reservations = ledger();
		let refreshCalls = 0;
		const broker = createBroker(
			dependencies({
				reservations,
				readSnapshot: async () =>
					snapshot(new Date(NOW - 600_000).toISOString()),
				refreshSnapshot: async () => refreshCalls++,
			}),
		);
		await rejects(
			broker.selectAndReserve(request()),
			/snapshot_stale_after_refresh/,
		);
		strictEqual(refreshCalls, 1);
		strictEqual(reservations.reserveCalls, 0);
	});

	it("rejects future and malformed snapshots before scoring", async () => {
		for (const value of [
			snapshot(new Date(NOW + 1).toISOString()),
			{ snapshot: { schema_version: 1, providers: [] } },
		]) {
			let routeCalls = 0;
			const broker = createBroker(
				dependencies({
					readSnapshot: async () => value,
					route: () => {
						routeCalls += 1;
						return {};
					},
				}),
			);
			await rejects(broker.selectAndReserve(request()), /snapshot_/);
			strictEqual(routeCalls, 0);
		}
	});

	it("passes distinct logical source identities without treating them as paths", async () => {
		const seen = [];
		const broker = createBroker(
			dependencies({
				readSnapshot: async ({ source }) => {
					seen.push(source);
					return snapshot(new Date(NOW - 1_000).toISOString());
				},
			}),
		);
		await broker.selectAndReserve(request());
		await broker.selectAndReserve({
			...request(),
			taskId: "TASK-002",
			snapshotSource: "private-logical-source",
		});
		strictEqual(seen.join(","), "gradus-v2,private-logical-source");
	});

	it("rejects an unconfigured default source instead of opening its text as a path", async () => {
		const broker = createBroker({
			reservations: ledger(),
			adapters: { codex: {} },
		});
		await rejects(
			broker.selectAndReserve({
				...request(),
				snapshotSource: "/tmp/arbitrary-caller-path",
			}),
			/snapshot_source_unknown/,
		);
	});
});

function capturingLedger() {
	const windows = [];
	return {
		get windows() {
			return windows;
		},
		async reserveWithSelection(select) {
			const selected = await select([]);
			if (!selected) return null;
			windows.push(selected.window);
			return {
				id: `reservation-${windows.length}`,
				provider: selected.provider,
				runId: selected.runId,
				taskId: selected.taskId,
				amount: selected.estimatedConsumption,
			};
		},
		async terminal() {
			return { changed: true };
		},
	};
}

function windowedDependencies(reservations, accountingWindows, snapshotMtime) {
	return dependencies({
		reservations,
		readSnapshot: async () => ({
			...snapshot(new Date(NOW - 1_000).toISOString()),
			snapshotMtime,
		}),
		route: ({ snapshotRead }) => ({
			provider: "Codex",
			model: "codex-standard",
			resolvedTargetId: "codex",
			reason: "ranked",
			snapshotStatus: snapshotRead.snapshotStatus,
			snapshotMtime: snapshotRead.snapshotMtime,
			snapshotAgeMsAtRoute: snapshotRead.snapshotAgeMsAtRoute,
			accountingWindows,
		}),
	});
}

describe("broker accounting window", () => {
	it("charges two dispatches to one window when the quota bucket has not reset", async () => {
		// Telemetry is rewritten constantly; only a real reset may retire a window.
		const reservations = capturingLedger();
		const windows = [{ id: "weekly", reset_iso: "2026-08-18T02:00:00.000Z" }];
		await createBroker(
			windowedDependencies(reservations, windows, 111),
		).selectAndReserve(request());
		await createBroker(
			windowedDependencies(reservations, windows, 222),
		).selectAndReserve(request());
		strictEqual(reservations.windows.length, 2);
		strictEqual(reservations.windows[0], reservations.windows[1]);
	});

	it("opens a new window once the bucket resets", async () => {
		const reservations = capturingLedger();
		await createBroker(
			windowedDependencies(
				reservations,
				[{ id: "weekly", reset_iso: "2026-08-18T02:00:00.000Z" }],
				111,
			),
		).selectAndReserve(request());
		await createBroker(
			windowedDependencies(
				reservations,
				[{ id: "weekly", reset_iso: "2026-08-25T02:00:00.000Z" }],
				111,
			),
		).selectAndReserve(request());
		strictEqual(reservations.windows.length, 2);
		strictEqual(reservations.windows[0] === reservations.windows[1], false);
	});

	it("falls back to the snapshot generation when the route carries no windows", async () => {
		const reservations = capturingLedger();
		await createBroker(
			windowedDependencies(reservations, null, 111),
		).selectAndReserve(request());
		await createBroker(
			windowedDependencies(reservations, null, 222),
		).selectAndReserve(request());
		strictEqual(reservations.windows[0], "gradus-v2@111");
		strictEqual(reservations.windows[1], "gradus-v2@222");
	});
});

describe("accounting window identity", () => {
	it("does not mint a new window when telemetry is rewritten with unchanged quota", () => {
		const windows = [{ id: "weekly", reset_iso: "2026-09-14T22:35:00-04:00" }];
		strictEqual(
			accountingWindowKey("gradus-v2", windows, 1000),
			accountingWindowKey("gradus-v2", windows, 2000),
		);
	});

	it("mints a new window when the bucket actually resets", () => {
		const before = [{ id: "weekly", reset_iso: "2026-09-14T22:35:00-04:00" }];
		const after = [{ id: "weekly", reset_iso: "2026-09-21T22:35:00-04:00" }];
		strictEqual(
			accountingWindowKey("gradus-v2", before, 1000) ===
				accountingWindowKey("gradus-v2", after, 1000),
			false,
		);
	});

	it("fingerprints every simultaneous bucket, in a stable order", () => {
		// A task on a dual-window provider draws on both, so either rolling over
		// has to invalidate the reservation.
		const fiveHourFirst = [
			{ id: "five_hour", reset_iso: "2026-09-12T00:31:00-04:00" },
			{ id: "weekly", reset_iso: "2026-09-15T18:09:00-04:00" },
		];
		const weeklyFirst = [fiveHourFirst[1], fiveHourFirst[0]];
		strictEqual(
			accountingWindowKey("gradus-v2", fiveHourFirst, 1000),
			accountingWindowKey("gradus-v2", weeklyFirst, 1000),
		);
		const rolled = [
			fiveHourFirst[0],
			{ id: "weekly", reset_iso: "2026-09-22T18:09:00-04:00" },
		];
		strictEqual(
			accountingWindowKey("gradus-v2", fiveHourFirst, 1000) ===
				accountingWindowKey("gradus-v2", rolled, 1000),
			false,
		);
	});

	it("reads one instant written two ways as one window", () => {
		strictEqual(
			accountingWindowKey(
				"gradus-v2",
				[{ id: "weekly", reset_iso: "2026-09-14T22:35:00-04:00" }],
				1000,
			),
			accountingWindowKey(
				"gradus-v2",
				[{ id: "weekly", reset_iso: "2026-09-15T02:35:00.000Z" }],
				1000,
			),
		);
	});

	it("keeps an unparseable reset value verbatim rather than discarding it", () => {
		strictEqual(
			accountingWindowKey(
				"gradus-v2",
				[{ id: "weekly", reset_iso: "soon" }],
				1000,
			),
			"gradus-v2@weekly:soon",
		);
	});

	it("keeps the generation key when no bucket reports an identity", () => {
		strictEqual(accountingWindowKey("gradus-v2", [], 1000), "gradus-v2@1000");
		strictEqual(
			accountingWindowKey("gradus-v2", null, "fresh"),
			"gradus-v2@fresh",
		);
		strictEqual(
			accountingWindowKey("gradus-v2", [{ percent_left: 50 }], 1000),
			"gradus-v2@1000",
		);
	});
});
