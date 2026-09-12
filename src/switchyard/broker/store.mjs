import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;

/**
 * Liveness probe for a recorded owner pid. Returns null when the value is not a
 * pid at all, so callers can tell "not a pid" from "definitely gone".
 * @param {unknown} pid
 * @returns {boolean|null}
 */
export function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

async function delay(ms) {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * A single-writer JSON document guarded by an atomic directory lock and
 * committed by rename. Extracted from the reservation ledger so the shared
 * account commitment store reuses the same lock discipline rather than growing
 * a second, subtly different copy of it: this is the code whose correctness is
 * what keeps one subscription from being double-booked.
 *
 * @param {object} options
 * @param {string} options.root directory holding the document and its lock
 * @param {string} options.name base filename, without extension
 * @param {() => object} options.empty builds the document a missing file means
 * @param {(value: unknown) => object} options.parse validates a loaded document
 * @param {string} options.lockErrorMessage thrown when acquisition times out
 */
export function createLockedJsonStore(options) {
	const root = resolve(options.root);
	const name = options.name;
	const documentPath = resolve(root, `${name}.json`);
	const lockPath = resolve(root, `${name}.lock`);
	const now = options.now ?? Date.now;
	const ownerAlive = options.ownerAlive ?? processIsAlive;
	const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
	const lockStaleMs = options.lockStaleMs ?? DEFAULT_LEASE_MS;
	// An ownerless lock is bounded by the acquisition timeout, not the lease, and
	// strictly *below* it: at exactly `lockTimeoutMs` the acquirer that finds the
	// debris can never reclaim it inside its own deadline, so the caller that
	// discovers the wedge is still the one that eats a hard timeout. Half the
	// bound is thousands of times the real mkdir -> writeFile publication gap and
	// leaves the discovering acquirer a full retry window. See
	// `recoverOwnerlessLock`.
	const ownerlessLockStaleMs =
		options.ownerlessLockStaleMs ?? Math.max(1, Math.floor(lockTimeoutMs / 2));

	async function reclaimLock() {
		const stalePath = resolve(root, `.${name}.lock.stale.${randomUUID()}`);
		try {
			await rename(lockPath, stalePath);
		} catch (error) {
			if (error?.code === "ENOENT") return true;
			throw error;
		}
		await rm(stalePath, { recursive: true, force: true });
		return true;
	}

	/**
	 * A lock directory whose `owner.json` never became readable names no owner,
	 * so liveness cannot be tested. It is either a live acquirer inside the
	 * `mkdir` -> `writeFile` publication gap or the debris of one that died
	 * there. That gap is microseconds wide, so the directory's own mtime decides
	 * — against the short acquisition bound rather than `lockStaleMs`, since
	 * holding an unrecoverable lock for a full lease would fail every reserve
	 * for that lease's duration, which is the wedge this recovers from.
	 */
	async function recoverOwnerlessLock() {
		let stats;
		try {
			stats = await stat(lockPath);
		} catch (error) {
			if (error?.code === "ENOENT") return true;
			throw error;
		}
		if (stats.mtimeMs + ownerlessLockStaleMs > now()) return false;
		return await reclaimLock();
	}

	async function recoverStaleLock() {
		let owner;
		try {
			owner = JSON.parse(
				await readFile(resolve(lockPath, "owner.json"), "utf8"),
			);
		} catch {
			return await recoverOwnerlessLock();
		}
		const expired =
			Number.isFinite(owner.acquiredAt) &&
			owner.acquiredAt + lockStaleMs <= now();
		if (!expired && ownerAlive(owner.pid) !== false) return false;
		return await reclaimLock();
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
					throw new Error(options.lockErrorMessage);
				}
				await delay(lockRetryMs);
			}
		}
	}

	async function readDocument() {
		let raw;
		try {
			raw = await readFile(documentPath, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return options.empty();
			throw error;
		}
		let value;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new Error(options.malformedMessage);
		}
		return options.parse(value);
	}

	async function writeDocument(document) {
		const next = { ...document, revision: document.revision + 1 };
		const temporaryPath = resolve(
			root,
			`.${name}.${process.pid}.${randomUUID()}.tmp`,
		);
		await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
			mode: 0o600,
		});
		await rename(temporaryPath, documentPath);
		return next;
	}

	async function withLock(operation) {
		const token = await acquireLock();
		try {
			const document = await readDocument();
			return await operation(document, writeDocument);
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

	return Object.freeze({ withLock, readDocument, documentPath, root });
}
