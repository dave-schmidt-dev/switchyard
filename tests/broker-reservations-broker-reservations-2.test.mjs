import { deepStrictEqual, rejects, strictEqual } from "node:assert";
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
async function waitFor(read, timeoutMs = 15_000, intervalMs = 5) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() >= deadline) {
			throw new Error(`condition was not observed within ${timeoutMs}ms`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
	}
}
describe("broker reservations", () => {
	it("reads the ledger while a live writer holds the lock", async () => {
		// Task 40. Reads used to take the write lock, so a reader competed with
		// every writer: under the 5 ms renewal loop below, `inspect()` waited out
		// the whole lock timeout and failed on a ledger that was healthy
		// throughout. Writes publish by rename, so a reader never needed the
		// lock at all. Holding the lock here is deterministic — no sleep decides
		// the outcome.
		const root = await tempDirAsync("switchyard-reservations-");
		const ledger = createReservationLedger({ root, lockTimeoutMs: 250 });
		const lockPath = join(root, "reservations.lock");
		await mkdir(lockPath, { recursive: true, mode: 0o700 });
		await writeFile(
			join(lockPath, "owner.json"),
			`${JSON.stringify({
				token: "held-by-a-live-writer",
				pid: process.pid,
				acquiredAt: Date.now(),
			})}\n`,
			{ mode: 0o600 },
		);
		const document = await ledger.inspect();
		deepStrictEqual(document.reservations, []);
		// The lock is still held: the read neither waited for it nor took it.
		await rejects(
			ledger.reserve({
				provider: "codex",
				window: "gradus@1",
				runId: "run-1",
				taskId: "TASK-001",
				ownerId: "owner-1",
				estimatedConsumption: 1,
				capacity: 4,
			}),
			/timed out acquiring broker reservation lock/,
		);
	});
	it("holds a reservation for the whole of a long execution", async () => {
		const ledger = await fixture({ leaseMs: 1_000 });
		let observed = null;
		let executorError = null;
		let before = null;
		const broker = createBroker({
			...dependencies(ledger, 4),
			getInvocationDescriptor: () => codexDescriptor(),
			reservationRenewIntervalMs: 5,
			executor: async () => {
				// The renewal loop is fast but not synchronous, so wait for the
				// lease to observably advance instead of betting a fixed sleep
				// against a tick. Capture rather than let the broker swallow it:
				// anything thrown here used to surface as "the lease did not
				// advance", which named the wrong defect for two separate real
				// failures.
				try {
					observed = await waitFor(async () => {
						const current =
							(await ledger.inspect()).reservations[0]?.expiresAt ?? null;
						return current !== null && current > before ? current : null;
					});
				} catch (error) {
					executorError = error;
				}
				throw new Error("provider failed");
			},
		});
		const result = await broker.selectAndReserve(request("TASK-001"));
		before = (await ledger.inspect()).reservations[0].expiresAt;
		try {
			await broker.execute(request("TASK-001"), result, {
				launcherIdentity: broker.launcherIdentity(result),
			});
		} catch {
			// The executor's failure is the vehicle, not the assertion.
		}
		strictEqual(
			executorError,
			null,
			`reading the ledger failed: ${executorError}`,
		);
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
		let markRenewEntered = () => {};
		const renewEntered = new Promise((resolve) => {
			markRenewEntered = resolve;
		});
		let markRenewFinished = () => {};
		const renewFinished = new Promise((resolve) => {
			markRenewFinished = resolve;
		});
		// Park the in-flight tick until after the terminal write so the renewal
		// resolves against a record the broker has already reconciled.
		const parked = {
			...ledger,
			renew: async (input) => {
				markRenewEntered();
				await renewGate;
				const outcome = await ledger.renew(input);
				markRenewFinished();
				return outcome;
			},
		};
		const events = [];
		const broker = createBroker({
			...dependencies(parked, 4),
			getInvocationDescriptor: () => codexDescriptor(),
			reservationRenewIntervalMs: 5,
			executor: async () => {
				// A parked renewal is the observable event that replaces the old
				// fixed sleep: the executor only finishes once a tick is genuinely
				// in flight against the lease.
				await renewEntered;
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
		await renewFinished;
		// A macrotask boundary lets every continuation of the released renewal
		// settle before the absence of a loss event is asserted.
		await new Promise((resolveTurn) => setImmediate(resolveTurn));
		deepStrictEqual(
			events.filter((event) => event.event === "reservation_renewal_lost"),
			[],
		);
	});
	it("lets the acquirer that finds ownerless debris reclaim it inside its own deadline", async () => {
		const root = await tempDirAsync(
			"switchyard-reservations-ownerless-deadline-",
		);
		const lockPath = join(root, "reservations.lock");
		await mkdir(lockPath);
		// No ownerlessLockStaleMs: the default must leave this acquirer a real
		// recovery window. The lock's mtime is the epoch and the injected clock
		// advances 300ms per observation, so the first stale check lands at
		// 300ms — past the default ownerless bound (half the 400ms acquisition
		// timeout) but short of the timeout itself. The bound therefore decides
		// the reclaim rather than machine load; a bound equal to the timeout
		// would not look stale at 300ms and would exhaust the deadline on the
		// following check instead.
		await utimes(lockPath, 0, 0);
		let clock = -300;
		const now = () => (clock += 300);
		const ledger = createReservationLedger({
			root,
			lockTimeoutMs: 400,
			lockRetryMs: 20,
			now,
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
		strictEqual(reservation.taskId, "TASK-001");
		strictEqual((await ledger.inspect()).reservations.length, 1);
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
