import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const LEDGER_VERSION = 1;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;

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

function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

function emptyLedger() {
	return {
		schemaVersion: LEDGER_VERSION,
		revision: 0,
		reservations: [],
		fallbackAttempts: [],
	};
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

async function delay(ms) {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Project-local durable reservation ledger. Every read/modify/write decision is
 * serialized by an atomic directory lock and committed by rename.
 */
export function createReservationLedger(options = {}) {
	const root = resolve(
		options.root ?? resolve(process.cwd(), ".logs", "switchyard", "broker"),
	);
	const ledgerPath = resolve(root, "reservations.json");
	const lockPath = resolve(root, "reservations.lock");
	const now = options.now ?? Date.now;
	const ownerAlive = options.ownerAlive ?? processIsAlive;
	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
	const lockStaleMs = options.lockStaleMs ?? DEFAULT_LEASE_MS;
	const makeId = options.makeId ?? randomUUID;

	async function recoverStaleLock() {
		let owner;
		try {
			owner = JSON.parse(
				await readFile(resolve(lockPath, "owner.json"), "utf8"),
			);
		} catch {
			return false;
		}
		const expired =
			Number.isFinite(owner.acquiredAt) &&
			owner.acquiredAt + lockStaleMs <= now();
		if (!expired && ownerAlive(owner.pid) !== false) return false;
		const stalePath = resolve(root, `.reservations.lock.stale.${randomUUID()}`);
		try {
			await rename(lockPath, stalePath);
		} catch (error) {
			if (error?.code === "ENOENT") return true;
			throw error;
		}
		await rm(stalePath, { recursive: true, force: true });
		return true;
	}

	async function acquireLock() {
		await mkdir(root, { recursive: true, mode: 0o700 });
		const deadline = now() + lockTimeoutMs;
		while (true) {
			const token = randomUUID();
			try {
				await mkdir(lockPath, { mode: 0o700 });
				try {
					await writeFile(
						resolve(lockPath, "owner.json"),
						`${JSON.stringify({ token, pid: process.pid, acquiredAt: now() })}\n`,
						{ mode: 0o600 },
					);
				} catch (error) {
					await rm(lockPath, { recursive: true, force: true });
					throw error;
				}
				return token;
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
				if (await recoverStaleLock()) continue;
				if (now() >= deadline) {
					throw new Error("timed out acquiring broker reservation lock");
				}
				await delay(lockRetryMs);
			}
		}
	}

	async function readLedger() {
		let raw;
		try {
			raw = await readFile(ledgerPath, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return emptyLedger();
			throw error;
		}
		let value;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new Error("broker reservation ledger is malformed");
		}
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

	async function writeLedger(ledger) {
		const next = { ...ledger, revision: ledger.revision + 1 };
		const temporaryPath = resolve(
			root,
			`.reservations.${process.pid}.${randomUUID()}.tmp`,
		);
		await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
			mode: 0o600,
		});
		await rename(temporaryPath, ledgerPath);
		return next;
	}

	async function withLock(operation) {
		const token = await acquireLock();
		try {
			const ledger = await readLedger();
			return await operation(ledger, writeLedger);
		} finally {
			try {
				const owner = JSON.parse(
					await readFile(resolve(lockPath, "owner.json"), "utf8"),
				);
				if (owner.token === token) {
					await rm(lockPath, { recursive: true, force: true });
				}
			} catch {
				// A reclaimed lock is intentionally not removed by its former owner.
			}
		}
	}

	function reclaimable(record, timestamp) {
		if (record.state !== "reserved") return false;
		if (record.expiresAt <= timestamp) return true;
		return ownerAlive(record.ownerPid) === false;
	}

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
			let input;
			try {
				input = await select(active);
			} catch (error) {
				if (recovered || fallbackContext !== null) await persist(ledger);
				throw error;
			}
			if (input === null) {
				if (recovered || fallbackContext !== null) await persist(ledger);
				return null;
			}
			const provider = requireText(input.provider, "reservation.provider");
			const window = requireText(input.window, "reservation.window");
			const runId = requireText(input.runId, "reservation.runId");
			const taskId = requireText(input.taskId, "reservation.taskId");
			const ownerId = requireText(input.ownerId, "reservation.ownerId");
			const estimatedConsumption = requirePositive(
				input.estimatedConsumption,
				"reservation.estimatedConsumption",
			);
			const capacity = requirePositive(input.capacity, "reservation.capacity");

			const duplicate = ledger.reservations.find(
				(record) =>
					record.state === "reserved" &&
					record.provider === provider &&
					record.window === window &&
					record.runId === runId &&
					record.taskId === taskId &&
					record.ownerId === ownerId,
			);
			if (duplicate) {
				if (recovered) await persist(ledger);
				return publicReservation(duplicate);
			}

			const consumed = ledger.reservations
				.filter(
					(record) =>
						record.state === "reserved" &&
						record.provider === provider &&
						record.window === window,
				)
				.reduce((total, record) => total + record.estimatedConsumption, 0);
			if (consumed + estimatedConsumption > capacity) {
				if (recovered) await persist(ledger);
				return null;
			}

			const record = {
				id: makeId(),
				provider,
				window,
				runId,
				taskId,
				ownerId,
				ownerPid: Number.isInteger(input.ownerPid) ? input.ownerPid : null,
				estimatedConsumption,
				actualConsumption: null,
				state: "reserved",
				createdAt: timestamp,
				updatedAt: timestamp,
				expiresAt: timestamp + leaseMs,
				terminalReason: null,
				terminalAt: null,
			};
			ledger.reservations.push(record);
			await persist(ledger);
			return publicReservation(record);
		});
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
			const nextState = outcome === "success" ? "reconciled" : "released";
			if (record.state !== "reserved") {
				if (record.state === nextState && record.terminalReason === outcome) {
					return Object.freeze({
						reservation: publicReservation(record),
						state: record.state,
						changed: false,
					});
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
			await persist(ledger);
			return Object.freeze({
				reservation: publicReservation(record),
				ownerId: record.ownerId,
			});
		});
	}

	async function inspect() {
		return withLock(async (ledger) => structuredClone(ledger));
	}

	return Object.freeze({
		reserve,
		reserveWithSelection,
		terminal,
		takeover,
		inspect,
	});
}
