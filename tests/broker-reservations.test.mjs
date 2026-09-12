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

function rankedDependencies(reservations, reservationCapacity, order) {
	// A router stub that actually honours `exclude`, unlike `dependencies()`'s
	// fixed-winner stub. Selection order is the caller's ranking.
	return {
		...dependencies(reservations, reservationCapacity),
		route: ({ exclude = [] } = {}) => {
			const skip = new Set(exclude.map((value) => String(value).toLowerCase()));
			const winner = order.find((name) => !skip.has(name.toLowerCase()));
			if (!winner) {
				return {
					provider: null,
					reason: "no_eligible",
					snapshotStatus: "fresh",
					snapshotMtime: 123,
					snapshotAgeMsAtRoute: 10,
				};
			}
			return {
				provider: winner,
				model: "codex-standard",
				resolvedTargetId: "codex",
				reason: "priority_fill",
				snapshotStatus: "fresh",
				snapshotMtime: 123,
				snapshotAgeMsAtRoute: 10,
			};
		},
		getInvocationDescriptor: () => codexDescriptor(),
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

	it("does not report renewal loss for a task that already succeeded", async () => {
		const ledger = await fixture({ leaseMs: 1_000 });
		let releaseRenew = () => {};
		const renewGate = new Promise((resolve) => {
			releaseRenew = resolve;
		});
		// Park the in-flight tick until after the terminal write so the renewal
		// resolves against a record the broker has already reconciled.
		const parked = {
			...ledger,
			renew: async (input) => {
				await renewGate;
				return await ledger.renew(input);
			},
		};
		const events = [];
		const broker = createBroker({
			...dependencies(parked, 4),
			getInvocationDescriptor: () => codexDescriptor(),
			reservationRenewIntervalMs: 5,
			executor: async () => {
				await new Promise((done) => setTimeout(done, 40));
				return { success: true };
			},
		});
		const result = await broker.selectAndReserve(request("TASK-001"));
		const execution = await broker.execute(request("TASK-001"), result, {
			launcherIdentity: broker.launcherIdentity(result),
			onStatus: (status) => events.push(status),
		});
		strictEqual(execution.success, true);
		releaseRenew();
		await new Promise((done) => setTimeout(done, 20));
		deepStrictEqual(
			events.filter((event) => event.event === "reservation_renewal_lost"),
			[],
		);
	});

	it("lets the acquirer that finds ownerless debris reclaim it inside its own deadline", async () => {
		const root = await tempDirAsync(
			"switchyard-reservations-ownerless-deadline-",
		);
		await mkdir(join(root, "reservations.lock"));
		// No ownerlessLockStaleMs: the default must leave this acquirer a real
		// recovery window. At a threshold equal to lockTimeoutMs the reclaim still
		// happens, but only on the tick that also satisfies the deadline check one
		// line later — correct by evaluation order alone. Asserting the elapsed
		// time is what distinguishes a real window from that knife edge.
		const lockTimeoutMs = 400;
		const ledger = createReservationLedger({
			root,
			lockTimeoutMs,
			lockRetryMs: 20,
		});
		const startedAt = Date.now();
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
		strictEqual(reservation.taskId, "TASK-001");
		const elapsed = Date.now() - startedAt;
		strictEqual(
			elapsed < lockTimeoutMs * 0.75,
			true,
			`expected the reclaim well inside the acquisition window, took ${elapsed}ms of ${lockTimeoutMs}ms`,
		);
	});

	it("skips a provider whose in-flight reservations already fill the window", async () => {
		const ledger = await fixture();
		// Fill Codex's capacity in the window the broker will compute
		// (`<source>@<mtime>` = gradus-v2@123) before the broker ever routes.
		await ledger.reserve({
			provider: "Codex",
			window: "gradus-v2@123",
			runId: "run-0",
			taskId: "TASK-000",
			ownerId: "worker-0",
			// A live owner: recovery reclaims a reservation whose pid is dead, and
			// a reclaimed record is not in-flight, so a fake pid would empty `active`
			// and make this test pass for the wrong reason.
			ownerPid: process.pid,
			estimatedConsumption: 2,
			capacity: 2,
		});
		const broker = createBroker(
			rankedDependencies(ledger, 2, ["Codex", "Vibe"]),
		);
		const result = await broker.selectAndReserve(request("TASK-001"));
		strictEqual(result.provider, "Vibe");
		strictEqual(Boolean(result.reservation), true);
	});

	it("keeps the ranked winner when it still has room", async () => {
		const ledger = await fixture();
		const broker = createBroker(
			rankedDependencies(ledger, 4, ["Codex", "Vibe"]),
		);
		const result = await broker.selectAndReserve(request("TASK-001"));
		strictEqual(result.provider, "Codex");
	});

	it("still answers capacity_unavailable when every candidate is full", async () => {
		const ledger = await fixture();
		for (const [index, provider] of ["Codex", "Vibe"].entries()) {
			await ledger.reserve({
				provider,
				window: "gradus-v2@123",
				runId: "run-0",
				taskId: `TASK-00${index}`,
				ownerId: "worker-0",
				ownerPid: process.pid,
				estimatedConsumption: 2,
				capacity: 2,
			});
		}
		const broker = createBroker(
			rankedDependencies(ledger, 2, ["Codex", "Vibe"]),
		);
		const result = await broker.selectAndReserve(request("TASK-001"));
		strictEqual(result.reservation, null);
		strictEqual(result.reason, "capacity_unavailable");
	});

	it("bounds how many times one lock acquisition may re-run the selector", async () => {
		const ledger = await fixture({ selectionAttemptLimit: 3 });
		let calls = 0;
		const reservation = await ledger.reserveWithSelection(
			(_active, refusals) => {
				calls += 1;
				// A selector that never retires the refused provider: the ledger's own
				// bound is the only thing standing between this and an unbounded hold
				// on the lock every other reserver is waiting for.
				strictEqual(refusals.length, calls - 1);
				return {
					provider: "Codex",
					window: "window-1",
					runId: "run-1",
					taskId: `TASK-00${calls}`,
					ownerId: "owner-1",
					ownerPid: 202,
					estimatedConsumption: 5,
					capacity: 1,
				};
			},
		);
		strictEqual(reservation, null);
		strictEqual(calls, 3);
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
