import {
	deepStrictEqual,
	notStrictEqual,
	rejects,
	strictEqual,
} from "node:assert";
import { mkdir, utimes, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { describe, it } from "node:test";
import { createBroker } from "../src/switchyard/broker/index.mjs";
import { createReservationLedger } from "../src/switchyard/broker/reservations.mjs";
import { BROKER_CONTRACT_VERSION } from "../src/switchyard/broker/schema.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

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

function codexDescriptor() {
	const core = {
		target_id: "codex",
		model_ref: "codex-standard",
		selector: "codex-standard",
		effort: "high",
		variant: null,
		invocation_args: ["-c", "model_reasoning_effort=high"],
	};
	return {
		...core,
		descriptor_identity: getInvocationDescriptorIdentity(core, "codex"),
	};
}

async function fixture(options = {}) {
	const root = await tempDirAsync("switchyard-reservations-");
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
		const root = await tempDirAsync("switchyard-reservations-lock-");
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

	it("recovers a lock abandoned before its owner record was published", async () => {
		const root = await tempDirAsync("switchyard-reservations-ownerless-");
		const lockPath = join(root, "reservations.lock");
		await mkdir(lockPath);
		const aged = (Date.now() - 60_000) / 1000;
		await utimes(lockPath, aged, aged);
		const ledger = createReservationLedger({
			root,
			ownerlessLockStaleMs: 5_000,
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

	it("renews a live owner's lease instead of letting it expire", async () => {
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
		timestamp = 1_080;
		const renewed = await ledger.renew({
			reservationId: reservation.id,
			ownerId: "owner-1",
		});
		strictEqual(renewed.renewed, true);
		strictEqual(renewed.expiresAt, 1_180);
		// Past the original lease, but inside the renewed one: a second owner
		// must still be refused where it previously would have taken the slot.
		timestamp = 1_150;
		await rejects(
			ledger.takeover({ reservationId: reservation.id, ownerId: "owner-2" }),
			/live reservation owner/,
		);
	});

	it("reports lost ownership from renew rather than throwing", async () => {
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
		timestamp = 1_101;
		await ledger.takeover({
			reservationId: reservation.id,
			ownerId: "owner-2",
			ownerPid: 202,
		});
		deepStrictEqual(
			await ledger.renew({
				reservationId: reservation.id,
				ownerId: "owner-1",
			}),
			{ renewed: false, reason: "superseded" },
		);
	});

	it("refuses a superseded writer's terminal and names the reason", async () => {
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
		timestamp = 1_101;
		const takeover = await ledger.takeover({
			reservationId: reservation.id,
			ownerId: "owner-2",
			ownerPid: 202,
		});
		strictEqual(takeover.fence, 2);
		await rejects(
			ledger.terminal({
				reservationId: reservation.id,
				ownerId: "owner-1",
				outcome: "success",
				actualConsumption: 1,
			}),
			/reservation owner identity mismatch/,
		);
		await rejects(
			ledger.terminal({
				reservationId: reservation.id,
				ownerId: "owner-2",
				fence: 1,
				outcome: "success",
				actualConsumption: 1,
			}),
			/reservation fence is stale/,
		);
	});

	it("names reclamation when a recovered owner reports its outcome", async () => {
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
		// Every reserve runs recovery first, which releases the expired-but-still
		// working owner out from under it. That is the result-loss path.
		timestamp = 1_101;
		await ledger.reserve({
			provider: "Claude",
			window: "window-1",
			runId: "run-1",
			taskId: "TASK-002",
			ownerId: "owner-2",
			ownerPid: 202,
			estimatedConsumption: 1,
			capacity: 1,
		});
		await rejects(
			ledger.terminal({
				reservationId: reservation.id,
				ownerId: "owner-1",
				outcome: "success",
				actualConsumption: 1,
			}),
			/reservation was reclaimed before its owner finalized/,
		);
		deepStrictEqual(
			await ledger.renew({
				reservationId: reservation.id,
				ownerId: "owner-1",
			}),
			{ renewed: false, reason: "reclaimed" },
		);
	});

	it("holds a reservation for the whole of a long execution", async () => {
		const ledger = await fixture({ leaseMs: 1_000 });
		let observed = null;
		const broker = createBroker({
			...dependencies(ledger, 4),
			getInvocationDescriptor: () => codexDescriptor(),
			reservationRenewIntervalMs: 5,
			executor: async () => {
				await new Promise((done) => setTimeout(done, 60));
				observed = (await ledger.inspect()).reservations[0].expiresAt;
				throw new Error("provider failed");
			},
		});
		const result = await broker.selectAndReserve(request("TASK-001"));
		const before = (await ledger.inspect()).reservations[0].expiresAt;
		try {
			await broker.execute(request("TASK-001"), result, {
				launcherIdentity: broker.launcherIdentity(result),
			});
		} catch {
			// The executor's failure is the vehicle, not the assertion.
		}
		strictEqual(
			observed > before,
			true,
			`expected the lease to advance during execution (${before} -> ${observed})`,
		);
	});

	it("refuses a freshly created ownerless lock rather than stealing it", async () => {
		const root = await tempDirAsync("switchyard-reservations-ownerless-fresh-");
		await mkdir(join(root, "reservations.lock"));
		const ledger = createReservationLedger({
			root,
			ownerlessLockStaleMs: 60_000,
			lockTimeoutMs: 50,
			lockRetryMs: 5,
		});
		await rejects(
			ledger.reserve({
				provider: "Codex",
				window: "window-1",
				runId: "run-1",
				taskId: "TASK-001",
				ownerId: "owner-1",
				ownerPid: 202,
				estimatedConsumption: 1,
				capacity: 1,
			}),
			/timed out acquiring broker reservation lock/,
		);
	});
});
