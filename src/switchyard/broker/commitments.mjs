import { createLockedJsonStore, processIsAlive } from "./store.mjs";

const COMMITMENT_VERSION = 1;

function emptyCommitments() {
	return { schemaVersion: COMMITMENT_VERSION, revision: 0, commitments: [] };
}

function isText(value) {
	return typeof value === "string" && value !== "" && value.length <= 1024;
}

function isPositive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Every field is checked, not just the envelope. A row carrying `amount: "2"`
// or `amount: null` would make the consumed sum NaN, and `NaN > capacity` is
// false — so a corrupt or hand-edited store would admit every reservation
// instead of refusing them. A store that cannot be trusted has to be an error,
// because the alternative reads exactly like an empty account.
function isRow(value) {
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		isText(value.id) &&
		isText(value.provider) &&
		isText(value.window) &&
		isPositive(value.amount) &&
		isPositive(value.capacity) &&
		typeof value.expiresAt === "number" &&
		Number.isFinite(value.expiresAt) &&
		(value.ownerPid === null || Number.isInteger(value.ownerPid))
	);
}

function parseCommitments(value) {
	if (
		value?.schemaVersion !== COMMITMENT_VERSION ||
		!Number.isInteger(value.revision) ||
		value.revision < 0 ||
		!Array.isArray(value.commitments) ||
		!value.commitments.every(isRow)
	) {
		throw new Error("account commitment store has an unsupported schema");
	}
	return value;
}

function requireCommitInput(input) {
	if (
		!isText(input?.reservationId) ||
		!isText(input.provider) ||
		!isText(input.window) ||
		!isPositive(input.amount) ||
		!isPositive(input.capacity)
	) {
		throw new TypeError("account commitment input is invalid");
	}
}

/**
 * Shared per-account record of how much of one subscription is committed right
 * now, across every project on this host.
 *
 * Only the amounts live here. Every audit record — the reservation itself, its
 * run and task, the dispatch ledger, the run store — stays project-local; a
 * commitment row carries the least that a capacity decision needs, so reading
 * this directory tells an observer how busy an account is and nothing about
 * what any project is doing with it.
 *
 * Liveness mirrors the reservation ledger exactly: a row is dropped once its
 * lease expires or its owning process is gone. The two use the same `expiresAt`
 * and the same pid, so a project that crashes mid-run heals both sides on the
 * same schedule without either needing to know the other recovered.
 *
 * @param {object} options
 * @param {string} options.root account root, from `resolveAccountRoot`
 */
export function createCommitmentStore(options) {
	const now = options.now ?? Date.now;
	const ownerAlive = options.ownerAlive ?? processIsAlive;
	const store = createLockedJsonStore({
		root: options.root,
		name: "commitments",
		now,
		ownerAlive,
		lockTimeoutMs: options.lockTimeoutMs,
		lockRetryMs: options.lockRetryMs,
		lockStaleMs: options.lockStaleMs,
		ownerlessLockStaleMs: options.ownerlessLockStaleMs,
		lockErrorMessage: "timed out acquiring account commitment lock",
		malformedMessage: "account commitment store is malformed",
		empty: emptyCommitments,
		parse: parseCommitments,
	});

	function live(row, timestamp) {
		if (row.expiresAt <= timestamp) return false;
		return ownerAlive(row.ownerPid) !== false;
	}

	function prune(document, timestamp) {
		const kept = document.commitments.filter((row) => live(row, timestamp));
		const changed = kept.length !== document.commitments.length;
		document.commitments = kept;
		return changed;
	}

	function windowRows(document, input) {
		return document.commitments.filter(
			(row) => row.provider === input.provider && row.window === input.window,
		);
	}

	// Capacity is quoted by each project from its own snapshot read. They should
	// agree, and when they disagree the account cannot be allowed to take the
	// larger number on faith: a project quoting 2 against a window another
	// project has already sized at 1 would otherwise reserve the second unit.
	// The smallest figure any live holder of the window quoted wins.
	function effectiveCapacity(rows, quoted) {
		return rows.reduce(
			(smallest, row) => Math.min(smallest, row.capacity),
			quoted,
		);
	}

	function admit(document, input) {
		const rows = windowRows(document, input);
		const consumed = rows.reduce((total, row) => total + row.amount, 0);
		const capacity = effectiveCapacity(rows, input.capacity);
		if (consumed + input.amount > capacity) {
			return { admitted: false, consumed };
		}
		document.commitments.push({
			id: input.reservationId,
			provider: input.provider,
			window: input.window,
			amount: input.amount,
			capacity: input.capacity,
			expiresAt: input.expiresAt,
			ownerPid: Number.isInteger(input.ownerPid) ? input.ownerPid : null,
		});
		return { admitted: true, consumed };
	}

	/**
	 * Authoritative capacity decision for one account window. The sum and the
	 * write happen under a single lock, so two projects racing for the last of a
	 * window cannot both read "it fits".
	 *
	 * @returns {Promise<{committed: boolean, consumed: number}>}
	 */
	async function commit(input) {
		requireCommitInput(input);
		return store.withLock(async (document, persist) => {
			const timestamp = now();
			const pruned = prune(document, timestamp);
			const existing = document.commitments.find(
				(row) => row.id === input.reservationId,
			);
			if (existing) {
				if (pruned) await persist(document);
				return Object.freeze({ committed: true, consumed: 0 });
			}
			const result = admit(document, input);
			if (!result.admitted) {
				if (pruned) await persist(document);
				return Object.freeze({ committed: false, consumed: result.consumed });
			}
			await persist(document);
			return Object.freeze({ committed: true, consumed: result.consumed });
		});
	}

	/**
	 * Extend a commitment's lease alongside its reservation, re-admitting it
	 * under current capacity when the row is already gone.
	 *
	 * Without the re-admission a delayed renewal would extend the local
	 * reservation while the account had already handed that capacity to another
	 * project, and the two would overlap with nothing recording it. A renewal
	 * that cannot be re-admitted has to be reported as a failure so the caller
	 * gives the reservation up.
	 *
	 * @returns {Promise<{renewed: boolean, reason?: string}>}
	 */
	async function renew(input) {
		requireCommitInput(input);
		return store.withLock(async (document, persist) => {
			const timestamp = now();
			prune(document, timestamp);
			const row = document.commitments.find(
				(candidate) => candidate.id === input.reservationId,
			);
			if (row) {
				row.expiresAt = input.expiresAt;
				row.capacity = input.capacity;
				if (Number.isInteger(input.ownerPid)) row.ownerPid = input.ownerPid;
				await persist(document);
				return Object.freeze({ renewed: true });
			}
			const result = admit(document, input);
			await persist(document);
			return result.admitted
				? Object.freeze({ renewed: true, reason: "readmitted" })
				: Object.freeze({ renewed: false, reason: "capacity" });
		});
	}

	async function release(input) {
		return store.withLock(async (document, persist) => {
			const timestamp = now();
			const pruned = prune(document, timestamp);
			const remaining = document.commitments.filter(
				(row) => row.id !== input.reservationId,
			);
			const released = remaining.length !== document.commitments.length;
			document.commitments = remaining;
			if (pruned || released) await persist(document);
			return Object.freeze({ released });
		});
	}

	async function inspect() {
		const document = await store.readDocument();
		return Object.freeze({
			commitments: Object.freeze(
				document.commitments.map((row) => Object.freeze({ ...row })),
			),
		});
	}

	return Object.freeze({ commit, renew, release, inspect, root: store.root });
}
