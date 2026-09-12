import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createCommitmentStore } from "./commitments.mjs";
import {
	createLockedJsonStore,
	DEFAULT_LEASE_MS,
	processIsAlive,
} from "./store.mjs";

const LEDGER_VERSION = 1;

function requireText(value, label) {
	if (typeof value !== "string" || value.trim() === "" || value.length > 1024) {
		throw new TypeError(`${label} must be non-empty bounded text`);
	}
	return value;
}

function requirePositive(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`${label} must be a positive finite number`);
	}
	return value;
}

function emptyLedger() {
	return {
		schemaVersion: LEDGER_VERSION,
		revision: 0,
		reservations: [],
		fallbackAttempts: [],
	};
}

function localConsumed(ledger, provider, window) {
	return ledger.reservations
		.filter(
			(record) =>
				record.state === "reserved" &&
				record.provider === provider &&
				record.window === window,
		)
		.reduce((total, record) => total + record.estimatedConsumption, 0);
}

function parseLedger(value) {
	if (
		value?.schemaVersion !== LEDGER_VERSION ||
		!Number.isInteger(value.revision) ||
		value.revision < 0 ||
		!Array.isArray(value.reservations)
	) {
		throw new Error("broker reservation ledger has an unsupported schema");
	}
	if (value.fallbackAttempts === undefined) value.fallbackAttempts = [];
	if (!Array.isArray(value.fallbackAttempts)) {
		throw new Error("broker reservation ledger has an unsupported schema");
	}
	return value;
}

function publicReservation(record) {
	return Object.freeze({
		id: record.id,
		provider: record.provider,
		runId: record.runId,
		taskId: record.taskId,
		amount: record.estimatedConsumption,
	});
}

/**
 * Project-local durable reservation ledger. Every read/modify/write decision is
 * serialized by an atomic directory lock and committed by rename.
 */
export function createReservationLedger(options = {}) {
	const root = resolve(
		options.root ?? resolve(process.cwd(), ".logs", "switchyard", "broker"),
	);
	const now = options.now ?? Date.now;
	const ownerAlive = options.ownerAlive ?? processIsAlive;
	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	// How many times one acquisition may re-run the caller's selector after a
	// capacity refusal. The selector runs *inside* the lock, so this is a direct
	// bound on how long one reserver can hold it away from every other reserver;
	// it is not a routing knob. The caller ends the loop earlier by returning null.
	const selectionAttemptLimit = options.selectionAttemptLimit ?? 8;
	const makeId = options.makeId ?? randomUUID;
	const store = createLockedJsonStore({
		root,
		name: "reservations",
		now,
		ownerAlive,
		lockTimeoutMs: options.lockTimeoutMs,
		lockRetryMs: options.lockRetryMs,
		lockStaleMs: options.lockStaleMs,
		ownerlessLockStaleMs: options.ownerlessLockStaleMs,
		lockErrorMessage: "timed out acquiring broker reservation lock",
		malformedMessage: "broker reservation ledger is malformed",
		empty: emptyLedger,
		parse: parseLedger,
	});
	const withLock = store.withLock;

	// Shared account accounting (increment 6 / F3.2). `accountRootFor` maps a
	// provider to the root of the account it meters against, or null when this
	// host cannot say with certainty. Unset, every path below is skipped and the
	// ledger behaves exactly as it did before shared accounting existed.
	//
	// Lock order is project lock outer, account lock inner, in every operation.
	// There is no path that takes them the other way round. The cost is that a
	// contended account lock is waited for while this project's lock is held.
	const accountRootFor = options.accountRootFor ?? null;
	const accountStores = new Map();
	function accountStoreFor(provider) {
		if (!accountRootFor) return null;
		let accountRoot = null;
		try {
			accountRoot = accountRootFor(provider);
		} catch {
			return null;
		}
		if (!accountRoot) return null;
		let commitmentStore = accountStores.get(accountRoot);
		if (!commitmentStore) {
			commitmentStore = createCommitmentStore({
				root: accountRoot,
				now,
				ownerAlive,
				lockTimeoutMs: options.lockTimeoutMs,
				lockRetryMs: options.lockRetryMs,
				lockStaleMs: options.lockStaleMs,
				ownerlessLockStaleMs: options.ownerlessLockStaleMs,
			});
			accountStores.set(accountRoot, commitmentStore);
		}
		return commitmentStore;
	}

	// Records written before ownership generations existed carry no fence; they
	// are the first generation by definition.
	function fenceOf(record) {
		return Number.isInteger(record.fence) ? record.fence : 1;
	}

	function reclaimable(record, timestamp) {
		if (record.state !== "reserved") return false;
		if (record.expiresAt <= timestamp) return true;
		return ownerAlive(record.ownerPid) === false;
	}

	// Recovered records leave their shared commitment behind. That is deliberate
	// and not a leak: the commitment carries the same `expiresAt` and the same
	// pid as the record, so the shared store drops it on exactly the condition
	// that reclaimed the record here, without this project having to reach into
	// another lock while holding its own.
	function recover(ledger, timestamp) {
		let changed = false;
		for (const record of ledger.reservations) {
			if (!reclaimable(record, timestamp)) continue;
			record.state = "released";
			record.terminalReason = "owner_recovered";
			record.terminalAt = timestamp;
			record.updatedAt = timestamp;
			changed = true;
		}
		return changed;
	}

	async function reserveWithSelection(select, fallbackContext = null) {
		if (typeof select !== "function") {
			throw new TypeError("reservation selector must be a function");
		}
		if (fallbackContext !== null) {
			if (!fallbackContext || typeof fallbackContext !== "object") {
				throw new TypeError("fallback reservation context must be an object");
			}
			requireText(fallbackContext.runId, "fallback.runId");
			requireText(fallbackContext.taskId, "fallback.taskId");
			requireText(
				fallbackContext.fromReservationId,
				"fallback.fromReservationId",
			);
		}
		return withLock(async (ledger, persist) => {
			const timestamp = now();
			const recovered = recover(ledger, timestamp);
			if (fallbackContext !== null) {
				const previous = ledger.reservations.find(
					(record) => record.id === fallbackContext.fromReservationId,
				);
				if (
					!previous ||
					previous.runId !== fallbackContext.runId ||
					previous.taskId !== fallbackContext.taskId ||
					previous.state !== "released" ||
					previous.terminalReason !== "failure"
				) {
					throw new Error("fallback source reservation is not a failed route");
				}
				if (
					ledger.fallbackAttempts.some(
						(attempt) =>
							attempt.runId === fallbackContext.runId &&
							attempt.taskId === fallbackContext.taskId,
					)
				) {
					throw new Error("fallback already attempted for this task");
				}
				ledger.fallbackAttempts.push({
					runId: fallbackContext.runId,
					taskId: fallbackContext.taskId,
					fromReservationId: fallbackContext.fromReservationId,
					attemptedAt: timestamp,
				});
			}
			const active = Object.freeze(
				ledger.reservations
					.filter((record) => record.state === "reserved")
					.map((record) =>
						Object.freeze({
							provider: record.provider,
							window: record.window,
							amount: record.estimatedConsumption,
						}),
					),
			);
			// A refused candidate is offered back to the selector instead of ending
			// the attempt: the selector owns which provider comes next, the ledger
			// owns whether that provider still fits. `active` does not change while
			// this loop runs, because nothing is written until one candidate fits.
			const refusals = [];
			let input = null;
			let provider = "";
			let window = "";
			let runId = "";
			let taskId = "";
			let ownerId = "";
			let estimatedConsumption = 0;
			let attempts = 0;
			// The id is minted before the capacity decision because the shared
			// account store is written first and has to name the reservation it is
			// holding room for. Only one candidate can ever commit: the loop breaks
			// on the first success, so the id is never reused across accounts.
			const pendingId = makeId();
			let committedId = null;
			while (true) {
				attempts += 1;
				try {
					input = await select(active, Object.freeze(refusals.slice()));
				} catch (error) {
					if (recovered || fallbackContext !== null) await persist(ledger);
					throw error;
				}
				if (input === null) {
					if (recovered || fallbackContext !== null) await persist(ledger);
					return null;
				}
				provider = requireText(input.provider, "reservation.provider");
				window = requireText(input.window, "reservation.window");
				runId = requireText(input.runId, "reservation.runId");
				taskId = requireText(input.taskId, "reservation.taskId");
				ownerId = requireText(input.ownerId, "reservation.ownerId");
				estimatedConsumption = requirePositive(
					input.estimatedConsumption,
					"reservation.estimatedConsumption",
				);
				const capacity = requirePositive(
					input.capacity,
					"reservation.capacity",
				);

				// Capacity is decided by the shared account store when this provider
				// resolves to one, and by this project's own rows when it does not.
				// Never by both: every row this project holds for that provider is
				// already in the shared store, so adding the local sum would count
				// this project's own reservations twice and refuse a window that
				// actually has room.
				const commitments = accountStoreFor(provider);

				const duplicate = ledger.reservations.find(
					(record) =>
						record.state === "reserved" &&
						record.provider === provider &&
						record.window === window &&
						record.runId === runId &&
						record.taskId === taskId &&
						record.ownerId === ownerId,
				);
				let consumed = 0;
				let refusalReason = "capacity";
				if (duplicate) {
					// A retry of a reservation this project already holds still has to
					// be backed by a live account row. The first attempt's row can be
					// gone — expired, pruned after a stalled renewal, or lost with the
					// store — and handing the caller a reservation the account no
					// longer knows about is how two projects end up running against
					// one subscription with neither ledger showing it.
					if (!commitments) {
						if (recovered) await persist(ledger);
						return publicReservation(duplicate);
					}
					const reattached = await commitDecision(commitments, {
						reservationId: duplicate.id,
						provider,
						window,
						amount: duplicate.estimatedConsumption,
						capacity,
						expiresAt: duplicate.expiresAt,
						ownerPid: duplicate.ownerPid,
					});
					if (reattached.committed) {
						if (recovered) await persist(ledger);
						return publicReservation(duplicate);
					}
					consumed = reattached.consumed;
					refusalReason = reattached.reason;
				} else if (commitments) {
					const decision = await commitDecision(commitments, {
						reservationId: pendingId,
						provider,
						window,
						amount: estimatedConsumption,
						capacity,
						// The commitment carries the same lease as the record below,
						// so both sides of the accounting expire on one schedule.
						expiresAt: timestamp + leaseMs,
						ownerPid: Number.isInteger(input.ownerPid) ? input.ownerPid : null,
					});
					if (decision.committed) {
						committedId = pendingId;
						break;
					}
					consumed = decision.consumed;
					refusalReason = decision.reason;
				} else {
					consumed = localConsumed(ledger, provider, window);
					if (consumed + estimatedConsumption <= capacity) break;
				}
				refusals.push(
					Object.freeze({
						provider,
						window,
						capacity,
						consumed,
						requested: estimatedConsumption,
						reason: refusalReason,
					}),
				);
				if (attempts >= selectionAttemptLimit) {
					if (recovered) await persist(ledger);
					return null;
				}
			}

			const record = {
				id: committedId ?? pendingId,
				provider,
				window,
				runId,
				taskId,
				ownerId,
				ownerPid: Number.isInteger(input.ownerPid) ? input.ownerPid : null,
				estimatedConsumption,
				// Kept so a later renewal can re-admit this reservation into its
				// account window without a fresh snapshot read.
				capacity: requirePositive(input.capacity, "reservation.capacity"),
				actualConsumption: null,
				state: "reserved",
				createdAt: timestamp,
				updatedAt: timestamp,
				expiresAt: timestamp + leaseMs,
				terminalReason: null,
				terminalAt: null,
				// Monotonic ownership generation. Bumped by every takeover so a
				// superseded writer that still holds the old value is refused.
				fence: 1,
			};
			ledger.reservations.push(record);
			await persist(ledger);
			return publicReservation(record);
		});
	}

	/**
	 * Ask the shared account store whether this reservation fits, treating an
	 * unreachable store as a refusal.
	 *
	 * Falling back to this project's own rows here would be fail-open, not
	 * fail-closed: a wedged lock or a flapping filesystem would put every
	 * project back on its private view of a window it is sharing, and two of
	 * them with empty local ledgers would both reserve the last unit. Only an
	 * account that never resolved at all may use project-local accounting,
	 * because there is then no shared view to contradict.
	 */
	async function commitDecision(commitments, input) {
		try {
			const decision = await commitments.commit(input);
			return {
				committed: decision.committed,
				consumed: decision.consumed,
				reason: "capacity",
			};
		} catch {
			return { committed: false, consumed: 0, reason: "account_unavailable" };
		}
	}

	// Commitment upkeep after the project record has already changed. A failure
	// here cannot be reported to the caller without lying about the reservation
	// it just completed, so the row is left to expire on its own lease instead:
	// the shared store and the ledger carry the same `expiresAt` and the same
	// pid, so both sides heal on one schedule.
	async function releaseCommitment(record) {
		const commitments = accountStoreFor(record.provider);
		if (!commitments) return;
		try {
			await commitments.release({ reservationId: record.id });
		} catch {
			// Left to lease expiry.
		}
	}

	/**
	 * Hold the shared account row for a reservation whose lease is being
	 * extended, and report whether the account still grants it.
	 *
	 * A renewal that silently tolerated a missing row would be the quiet
	 * double-booking path: the local reservation would keep advancing while the
	 * account had already handed that capacity to another project, and nothing
	 * would record the overlap. So the answer is returned rather than swallowed,
	 * and an unreachable store counts as a refusal for the same reason a
	 * refusing one does.
	 *
	 * @returns {Promise<boolean>} true when this project still owns the capacity
	 */
	async function holdCommitment(record, expiresAt) {
		const commitments = accountStoreFor(record.provider);
		if (!commitments) return true;
		try {
			const result = await commitments.renew({
				reservationId: record.id,
				provider: record.provider,
				window: record.window,
				amount: record.estimatedConsumption,
				// Records written before shared accounting carry no capacity. Sizing
				// the window at this one reservation is the conservative reading: it
				// re-admits into an empty window and refuses a shared one, rather
				// than inventing headroom the account never quoted.
				capacity:
					typeof record.capacity === "number" &&
					Number.isFinite(record.capacity) &&
					record.capacity > 0
						? record.capacity
						: record.estimatedConsumption,
				expiresAt,
				ownerPid: record.ownerPid,
			});
			return result.renewed === true;
		} catch {
			return false;
		}
	}

	async function reserve(input) {
		return reserveWithSelection(() => input);
	}

	async function terminal(input) {
		return withLock(async (ledger, persist) => {
			const reservationId = requireText(
				input.reservationId,
				"terminal.reservationId",
			);
			const ownerId = requireText(input.ownerId, "terminal.ownerId");
			const outcome = input.outcome;
			if (!new Set(["success", "failure", "cancel"]).has(outcome)) {
				throw new TypeError(
					"terminal.outcome must be success, failure, or cancel",
				);
			}
			const record = ledger.reservations.find(
				(candidate) => candidate.id === reservationId,
			);
			if (!record) throw new Error("reservation not found");
			if (record.ownerId !== ownerId) {
				throw new Error("reservation owner identity mismatch");
			}
			if (input.fence !== undefined && fenceOf(record) !== input.fence) {
				throw new Error("reservation fence is stale; ownership was superseded");
			}
			const nextState = outcome === "success" ? "reconciled" : "released";
			if (record.state !== "reserved") {
				if (record.state === nextState && record.terminalReason === outcome) {
					return Object.freeze({
						reservation: publicReservation(record),
						state: record.state,
						changed: false,
					});
				}
				// Distinguish the result-loss path from an ordinary double
				// terminal: recovery released this reservation while its owner was
				// still working, so the outcome now being reported has nowhere to
				// land. The generic message hid that.
				if (record.terminalReason === "owner_recovered") {
					throw new Error(
						"reservation was reclaimed before its owner finalized",
					);
				}
				throw new Error(
					"reservation already terminated with a different outcome",
				);
			}
			let actualConsumption = null;
			if (outcome === "success") {
				actualConsumption = requirePositive(
					input.actualConsumption,
					"terminal.actualConsumption",
				);
			}
			const timestamp = now();
			record.state = nextState;
			record.actualConsumption = actualConsumption;
			record.terminalReason = outcome;
			record.terminalAt = timestamp;
			record.updatedAt = timestamp;
			await persist(ledger);
			await releaseCommitment(record);
			return Object.freeze({
				reservation: publicReservation(record),
				state: record.state,
				changed: true,
			});
		});
	}

	async function takeover(input) {
		return withLock(async (ledger, persist) => {
			const timestamp = now();
			const record = ledger.reservations.find(
				(candidate) => candidate.id === input.reservationId,
			);
			if (!record) throw new Error("reservation not found");
			if (record.state !== "reserved") {
				throw new Error("only an active reservation can be taken over");
			}
			if (!reclaimable(record, timestamp)) {
				throw new Error("live reservation owner cannot be replaced");
			}
			record.ownerId = requireText(input.ownerId, "takeover.ownerId");
			record.ownerPid = Number.isInteger(input.ownerPid)
				? input.ownerPid
				: null;
			record.expiresAt = timestamp + leaseMs;
			record.updatedAt = timestamp;
			record.fence = fenceOf(record) + 1;
			// A dead owner's commitment has usually already been pruned, so this is
			// a re-admission under current capacity rather than a lease bump. It
			// must not succeed locally if the account has meanwhile been filled.
			if (!(await holdCommitment(record, record.expiresAt))) {
				throw new Error("account capacity for this reservation is gone");
			}
			await persist(ledger);
			return Object.freeze({
				reservation: publicReservation(record),
				ownerId: record.ownerId,
				fence: record.fence,
			});
		});
	}

	/**
	 * Extend a live owner's lease. This is what keeps expiry authoritative
	 * without expiring an owner that is still working: a task whose execution
	 * outlives the lease keeps proving liveness, while a stuck owner stops
	 * renewing and is reclaimed on schedule.
	 *
	 * Ownership problems are reported, not thrown, so a caller polling on a
	 * timer never has to match on error text. Only caller mistakes throw.
	 */
	async function renew(input) {
		return withLock(async (ledger, persist) => {
			const reservationId = requireText(
				input.reservationId,
				"renew.reservationId",
			);
			const ownerId = requireText(input.ownerId, "renew.ownerId");
			const record = ledger.reservations.find(
				(candidate) => candidate.id === reservationId,
			);
			if (!record) throw new Error("reservation not found");
			if (record.ownerId !== ownerId) {
				return Object.freeze({ renewed: false, reason: "superseded" });
			}
			if (input.fence !== undefined && fenceOf(record) !== input.fence) {
				return Object.freeze({ renewed: false, reason: "superseded" });
			}
			if (record.state !== "reserved") {
				return Object.freeze({
					renewed: false,
					reason:
						record.terminalReason === "owner_recovered"
							? "reclaimed"
							: "not_reserved",
				});
			}
			const timestamp = now();
			const expiresAt = timestamp + leaseMs;
			if (!(await holdCommitment(record, expiresAt))) {
				// The account no longer grants this capacity, so the reservation is
				// over whatever the local ledger says. Releasing it here is what
				// stops the owner from carrying on against a subscription another
				// project now holds.
				record.state = "released";
				record.terminalReason = "account_lost";
				record.terminalAt = timestamp;
				record.updatedAt = timestamp;
				await persist(ledger);
				return Object.freeze({ renewed: false, reason: "reclaimed" });
			}
			record.expiresAt = expiresAt;
			record.updatedAt = timestamp;
			await persist(ledger);
			return Object.freeze({
				renewed: true,
				expiresAt: record.expiresAt,
				fence: fenceOf(record),
			});
		});
	}

	async function inspect() {
		return withLock(async (ledger) => structuredClone(ledger));
	}

	return Object.freeze({
		reserve,
		reserveWithSelection,
		renew,
		terminal,
		takeover,
		inspect,
	});
}
