import { rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { createBroker } from "../src/switchyard/broker/index.mjs";
import { BROKER_CONTRACT_VERSION } from "../src/switchyard/broker/schema.mjs";

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
