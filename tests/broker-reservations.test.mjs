import { notStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createBroker } from "../src/switchyard/broker/index.mjs";
import { createReservationLedger } from "../src/switchyard/broker/reservations.mjs";
import { BROKER_CONTRACT_VERSION } from "../src/switchyard/broker/schema.mjs";

function request(taskId, amount = 2) {
	return {
		schemaVersion: BROKER_CONTRACT_VERSION,
		capability: "standard",
		dataClass: "repository",
		estimatedConsumption: amount,
		runId: "run-1",
		taskId,
		snapshotSource: "gradus-v2",
		availableAdapters: ["codex"],
	};
}

function dependencies(reservations, reservationCapacity) {
	return {
		reservations,
		reservationCapacity,
		ownerId: "worker-1",
		adapters: { codex: { execute() {} } },
		route: () => ({
			provider: "Codex",
			model: "codex-standard",
			resolvedTargetId: "codex",
			reason: "priority_fill",
			snapshotStatus: "fresh",
			snapshotMtime: 123,
			snapshotAgeMsAtRoute: 10,
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
	};
}

async function fixture(options = {}) {
	const root = await mkdtemp(join(tmpdir(), "switchyard-reservations-"));
	let sequence = 0;
	return createReservationLedger({
		root,
		makeId: () => `reservation-${++sequence}`,
		...options,
	});
}

describe("broker reservations", () => {
	it("atomically prevents concurrent requests from double-booking one slot", async () => {
		const ledger = await fixture();
		const broker = createBroker(dependencies(ledger, 2));
		const results = await Promise.all([
			broker.selectAndReserve(request("TASK-001")),
			broker.selectAndReserve(request("TASK-002")),
		]);
		strictEqual(results.filter((result) => result.reservation).length, 1);
		strictEqual(
			results.filter((result) => result.reason === "capacity_unavailable")
				.length,
			1,
		);
	});

	it("returns distinct reservations when the window has distinct capacity", async () => {
		const ledger = await fixture();
		const broker = createBroker(dependencies(ledger, 4));
		const [first, second] = await Promise.all([
			broker.selectAndReserve(request("TASK-001")),
			broker.selectAndReserve(request("TASK-002")),
		]);
		notStrictEqual(first.reservation.id, second.reservation.id);
	});

	it("reconciles success exactly once", async () => {
		const ledger = await fixture();
		const broker = createBroker(dependencies(ledger, 2));
		const result = await broker.selectAndReserve(request("TASK-001"));
		strictEqual((await broker.reconcile(result, 1.5)).changed, true);
		strictEqual((await broker.reconcile(result, 1.5)).changed, false);
		const record = (await ledger.inspect()).reservations[0];
		strictEqual(record.state, "reconciled");
		strictEqual(record.actualConsumption, 1.5);
	});

	it("releases failure and cancellation exactly once", async () => {
		const ledger = await fixture();
		const broker = createBroker(dependencies(ledger, 4));
		const failed = await broker.selectAndReserve(request("TASK-001"));
		const cancelled = await broker.selectAndReserve(request("TASK-002"));
		strictEqual((await broker.release(failed)).changed, true);
		strictEqual((await broker.release(failed)).changed, false);
		strictEqual((await broker.release(cancelled, "cancel")).changed, true);
		strictEqual((await broker.release(cancelled, "cancel")).changed, false);
	});

	it("rejects live-owner takeover and permits one expired-owner takeover", async () => {
		let timestamp = 1_000;
		const ledger = await fixture({
			now: () => timestamp,
			leaseMs: 100,
			ownerAlive: () => true,
		});
		const reservation = await ledger.reserve({
			provider: "Codex",
			window: "window-1",
			runId: "run-1",
			taskId: "TASK-001",
			ownerId: "owner-1",
			ownerPid: 101,
			estimatedConsumption: 1,
			capacity: 1,
		});
		await rejects(
			ledger.takeover({ reservationId: reservation.id, ownerId: "owner-2" }),
			/live reservation owner/,
		);
		timestamp = 1_101;
		strictEqual(
			(
				await ledger.takeover({
					reservationId: reservation.id,
					ownerId: "owner-2",
				})
			).ownerId,
			"owner-2",
		);
		await rejects(
			ledger.takeover({ reservationId: reservation.id, ownerId: "owner-3" }),
			/live reservation owner/,
		);
	});

	it("recovers a proven-dead owner without reclaiming an unknown owner", async () => {
		const ledger = await fixture({
			ownerAlive: (pid) => (pid === 101 ? false : null),
		});
		const dead = await ledger.reserve({
			provider: "Codex",
			window: "window-1",
			runId: "run-1",
			taskId: "TASK-001",
			ownerId: "dead-owner",
			ownerPid: 101,
			estimatedConsumption: 1,
			capacity: 1,
		});
		const replacement = await ledger.reserve({
			provider: "Codex",
			window: "window-1",
			runId: "run-1",
			taskId: "TASK-002",
			ownerId: "new-owner",
			ownerPid: 202,
			estimatedConsumption: 1,
			capacity: 1,
		});
		strictEqual(Boolean(replacement), true);
		strictEqual(
			(await ledger.inspect()).reservations.find((item) => item.id === dead.id)
				.state,
			"released",
		);
		const unknown = await ledger.reserve({
			provider: "Claude",
			window: "window-1",
			runId: "run-1",
			taskId: "TASK-003",
			ownerId: "unknown-owner",
			ownerPid: null,
			estimatedConsumption: 1,
			capacity: 1,
		});
		strictEqual(Boolean(unknown), true);
		strictEqual(
			await ledger.reserve({
				provider: "Claude",
				window: "window-1",
				runId: "run-1",
				taskId: "TASK-004",
				ownerId: "other-owner",
				ownerPid: 303,
				estimatedConsumption: 1,
				capacity: 1,
			}),
			null,
		);
	});

	it("recovers an abandoned atomic lock owned by a dead process", async () => {
		const root = await mkdtemp(join(tmpdir(), "switchyard-reservations-lock-"));
		const lockPath = join(root, "reservations.lock");
		await mkdir(lockPath);
		await writeFile(
			join(lockPath, "owner.json"),
			JSON.stringify({ token: "old", pid: 101, acquiredAt: 1 }),
		);
		const ledger = createReservationLedger({
			root,
			ownerAlive: () => false,
			makeId: () => "reservation-1",
		});
		const reservation = await ledger.reserve({
			provider: "Codex",
			window: "window-1",
			runId: "run-1",
			taskId: "TASK-001",
			ownerId: "owner-1",
			ownerPid: 202,
			estimatedConsumption: 1,
			capacity: 1,
		});
		strictEqual(reservation.id, "reservation-1");
	});
});
