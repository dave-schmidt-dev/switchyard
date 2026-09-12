// Increment 6 (F3.2 shared account authority) gate test: two projects, one
// subscription.
//
// The defect this closes is invisible to a single-project test. Each project
// kept its own reservation ledger, so each one independently believed a
// provider's whole window was free: two projects dispatching at once could
// both reserve the last of one subscription and the account was over-consumed
// with neither ledger ever recording an overdraft. The cases below run two
// ledgers against one account root, which is the only shape that catches it.

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createCommitmentStore } from "../src/switchyard/broker/commitments.mjs";
import { createReservationLedger } from "../src/switchyard/broker/reservations.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let accountRoot = "";
let projects = [];

function reservationLedger(options = {}) {
	const root = tempDir("switchyard-shared-project-");
	projects.push(root);
	return createReservationLedger({
		root,
		// One account for every provider in these cases: the resolver is the seam
		// the roster supplies in production, and the roster-backed derivation of
		// it is covered by tests/broker-accounts.test.mjs.
		accountRootFor: () => accountRoot,
		...options,
	});
}

function reservation(taskId, amount = 1) {
	return {
		provider: "codex",
		window: "gradus@1",
		runId: "RUN-shared",
		taskId,
		ownerId: `owner-${taskId}`,
		ownerPid: process.pid,
		estimatedConsumption: amount,
		capacity: 2,
	};
}

beforeEach(() => {
	accountRoot = tempDir("switchyard-shared-account-");
	projects = [];
});

afterEach(() => {
	rmSync(accountRoot, { recursive: true, force: true });
	for (const root of projects) rmSync(root, { recursive: true, force: true });
});

describe("shared account reservations", () => {
	it("refuses a second project once the account window is full", async () => {
		const one = reservationLedger();
		const other = reservationLedger();
		ok(await one.reserve(reservation("TASK-A", 2)));
		strictEqual(await other.reserve(reservation("TASK-B", 1)), null);
	});

	it("lets only one of two concurrent projects take the last of a window", async () => {
		// The sequential cases prove the sum is read; this one proves the sum and
		// the write are one critical section. Two projects reaching the account
		// at the same instant is the shape the defect actually took in the field.
		const one = reservationLedger();
		const other = reservationLedger();
		const results = await Promise.all([
			one.reserve(reservation("TASK-A", 2)),
			other.reserve(reservation("TASK-B", 2)),
		]);
		strictEqual(results.filter(Boolean).length, 1);
		const store = createCommitmentStore({ root: accountRoot });
		deepStrictEqual(
			(await store.inspect()).commitments.map((row) => row.amount),
			[2],
		);
	});

	it("frees the account for the other project on terminal", async () => {
		const one = reservationLedger();
		const other = reservationLedger();
		const held = await one.reserve(reservation("TASK-A", 2));
		strictEqual(await other.reserve(reservation("TASK-B", 1)), null);
		await one.terminal({
			reservationId: held.id,
			ownerId: "owner-TASK-A",
			outcome: "success",
			actualConsumption: 2,
		});
		ok(await other.reserve(reservation("TASK-B", 1)));
	});

	it("does not count one project's own rows twice", async () => {
		// The shared store already holds this project's reservation. Adding the
		// project-local sum on top would read the window as 2 of 2 consumed and
		// refuse a request that fits.
		const one = reservationLedger();
		ok(await one.reserve(reservation("TASK-A", 1)));
		ok(await one.reserve(reservation("TASK-B", 1)));
	});

	it("holds the account for the whole of a renewed lease", async () => {
		// Driven by an injected clock rather than a short lease and a sleep: a
		// wall-clock version of this passes alone and expires the commitment out
		// from under the assertion when the suite runs loaded.
		let clock = 1_700_000_000_000;
		const now = () => clock;
		const one = reservationLedger({ leaseMs: 1_000, now });
		const other = reservationLedger({ leaseMs: 1_000, now });
		const held = await one.reserve(reservation("TASK-A", 2));
		const store = createCommitmentStore({ root: accountRoot, now });
		const before = (await store.inspect()).commitments[0].expiresAt;
		clock += 500;
		const renewed = await one.renew({
			reservationId: held.id,
			ownerId: "owner-TASK-A",
		});
		strictEqual(renewed.renewed, true);
		const after = (await store.inspect()).commitments[0].expiresAt;
		strictEqual(after, renewed.expiresAt);
		ok(
			after > before,
			`expected the account commitment to advance (${before} -> ${after})`,
		);
		// The other project must still be refused: a commitment that stopped
		// advancing while its reservation kept renewing is exactly how a long
		// execution becomes invisible and the account is double-booked.
		strictEqual(await other.reserve(reservation("TASK-B", 1)), null);
	});

	it("recovers an account held by a process that is gone", async () => {
		// Only the second project treats owners as dead, so the row it drops can
		// only have been dropped by the shared store's own recovery: a project
		// that crashes must not hold another project out of the account until the
		// lease runs out.
		const one = reservationLedger();
		const other = reservationLedger({ ownerAlive: () => false });
		await one.reserve(reservation("TASK-A", 2));
		const store = createCommitmentStore({ root: accountRoot });
		strictEqual((await store.inspect()).commitments.length, 1);
		ok(await other.reserve(reservation("TASK-B", 2)));
		deepStrictEqual(
			(await store.inspect()).commitments.map((row) => row.amount),
			[2],
		);
	});

	it("falls back to the project ledger when no account resolves", async () => {
		const one = reservationLedger({ accountRootFor: () => null });
		const other = reservationLedger({ accountRootFor: () => null });
		ok(await one.reserve(reservation("TASK-A", 2)));
		// Project-local accounting is what this was before shared accounts: the
		// second project sees an empty ledger and reserves, which is the
		// behaviour increment 6 replaces rather than the behaviour it promises.
		ok(await other.reserve(reservation("TASK-B", 2)));
		const store = createCommitmentStore({ root: accountRoot });
		deepStrictEqual((await store.inspect()).commitments, []);
	});

	it("refuses rather than falling back when a resolved account store is unusable", async () => {
		// Resolution succeeded, so this provider is known to be shared. Dropping
		// back to project-local accounting here would be fail-open: every project
		// would return to its private view of a window it is sharing, and two
		// with empty ledgers would both take the last unit.
		const one = reservationLedger({
			accountRootFor: () => "/dev/null/not-a-directory",
		});
		strictEqual(await one.reserve(reservation("TASK-A", 1)), null);
	});

	it("refuses a retry whose account row can no longer be re-admitted", async () => {
		// The first attempt's commitment is gone and another project has taken
		// the window. Handing back the local record because it still says
		// "reserved" is how two projects end up running against one account.
		let clock = 1_700_000_000_000;
		const now = () => clock;
		const one = reservationLedger({ leaseMs: 1_000, now });
		const other = reservationLedger({ leaseMs: 10_000, now });
		const held = await one.reserve(reservation("TASK-A", 2));
		ok(held);
		clock += 1_001;
		ok(await other.reserve(reservation("TASK-B", 2)));
		clock -= 1_001;
		strictEqual(await one.reserve(reservation("TASK-A", 2)), null);
	});

	it("gives up a reservation whose account row cannot be renewed", async () => {
		let clock = 1_700_000_000_000;
		const now = () => clock;
		const one = reservationLedger({ leaseMs: 1_000, now });
		const other = reservationLedger({ leaseMs: 10_000, now });
		const held = await one.reserve(reservation("TASK-A", 2));
		clock += 1_001;
		ok(await other.reserve(reservation("TASK-B", 2)));
		clock -= 1_001;
		const renewed = await one.renew({
			reservationId: held.id,
			ownerId: "owner-TASK-A",
		});
		strictEqual(renewed.renewed, false);
		strictEqual(renewed.reason, "reclaimed");
		// Released locally too: a live local record with no account row behind it
		// is exactly the state the owner would keep working against.
		const record = (await one.inspect()).reservations[0];
		strictEqual(record.state, "released");
		strictEqual(record.terminalReason, "account_lost");
	});

	it("reports a finalized result that lost its account row as result loss", async () => {
		// The owner keeps executing after the account row is gone, so its terminal
		// write still arrives. It must read as a lost result, not as the caller
		// double-terminating a reservation it never finalized once.
		let clock = 1_700_000_000_000;
		const now = () => clock;
		const one = reservationLedger({ leaseMs: 1_000, now });
		const other = reservationLedger({ leaseMs: 10_000, now });
		const held = await one.reserve(reservation("TASK-A", 2));
		clock += 1_001;
		ok(await other.reserve(reservation("TASK-B", 2)));
		clock -= 1_001;
		await one.renew({ reservationId: held.id, ownerId: "owner-TASK-A" });
		await rejects(
			one.terminal({
				reservationId: held.id,
				ownerId: "owner-TASK-A",
				outcome: "success",
				actualConsumption: 2,
			}),
			/reservation was reclaimed before its owner finalized/,
		);
	});

	it("re-admits a renewal when the account window still has room", async () => {
		let clock = 1_700_000_000_000;
		const now = () => clock;
		const one = reservationLedger({ leaseMs: 1_000, now });
		const held = await one.reserve(reservation("TASK-A", 1));
		clock += 1_001;
		const renewed = await one.renew({
			reservationId: held.id,
			ownerId: "owner-TASK-A",
		});
		strictEqual(renewed.renewed, true);
		const store = createCommitmentStore({ root: accountRoot, now });
		strictEqual((await store.inspect()).commitments.length, 1);
	});

	it("takes the smallest capacity any live holder quoted for a window", async () => {
		// One project reading a stale snapshot must not be able to enlarge a
		// window another project has already sized.
		const one = reservationLedger();
		const other = reservationLedger();
		ok(await one.reserve({ ...reservation("TASK-A", 1), capacity: 1 }));
		strictEqual(
			await other.reserve({ ...reservation("TASK-B", 1), capacity: 2 }),
			null,
		);
	});

	it("refuses a commitment store whose rows are not valid", async () => {
		const one = reservationLedger();
		ok(await one.reserve(reservation("TASK-A", 1)));
		const path = join(accountRoot, "commitments.json");
		const document = JSON.parse(readFileSync(path, "utf8"));
		document.commitments[0].amount = "plenty";
		writeFileSync(path, JSON.stringify(document), "utf8");
		// A NaN sum compares false against every capacity, so a store that
		// cannot be parsed must refuse rather than read as an empty account.
		const other = reservationLedger();
		strictEqual(await other.reserve(reservation("TASK-B", 1)), null);
	});
});
