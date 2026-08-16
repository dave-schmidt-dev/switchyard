const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

export class BrokerSnapshotError extends Error {
	constructor(code) {
		super(code);
		this.name = "BrokerSnapshotError";
		this.code = code;
	}
}

function normalizeRead(value, source, nowMs, maxAgeMs) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new BrokerSnapshotError("snapshot_malformed");
	}
	const { snapshot, snapshotMtime = null } = value;
	if (
		!snapshot ||
		typeof snapshot !== "object" ||
		Array.isArray(snapshot) ||
		snapshot.schema_version !== 2 ||
		!Array.isArray(snapshot.providers) ||
		typeof snapshot.updated_at !== "string"
	) {
		throw new BrokerSnapshotError("snapshot_malformed");
	}
	const updatedAtMs = Date.parse(snapshot.updated_at);
	if (!Number.isFinite(updatedAtMs)) {
		throw new BrokerSnapshotError("snapshot_malformed");
	}
	if (
		snapshotMtime !== null &&
		(typeof snapshotMtime !== "number" || !Number.isFinite(snapshotMtime))
	) {
		throw new BrokerSnapshotError("snapshot_malformed");
	}
	const ageMs = nowMs - updatedAtMs;
	const status = ageMs < 0 ? "future" : ageMs >= maxAgeMs ? "stale" : "fresh";
	return Object.freeze({
		snapshot,
		snapshotStatus: status,
		snapshotMtime,
		snapshotAgeMsAtRoute: ageMs,
		source,
	});
}

/** Read one snapshot generation, refreshing a stale source exactly once. */
export function createSnapshotCoordinator(options = {}) {
	if (typeof options.read !== "function") {
		throw new TypeError("snapshot dependency read must be a function");
	}
	if (options.refresh !== undefined && typeof options.refresh !== "function") {
		throw new TypeError("snapshot dependency refresh must be a function");
	}
	const read = options.read;
	const refresh = options.refresh ?? (async () => false);
	const now = options.now ?? Date.now;
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
		throw new TypeError("snapshot maxAgeMs must be positive");
	}

	async function readOnce(source) {
		const nowMs = now();
		const value = await read({ source, nowMs });
		return normalizeRead(value, source, nowMs, maxAgeMs);
	}

	async function prepare(source) {
		let current = await readOnce(source);
		if (current.snapshotStatus === "future") {
			throw new BrokerSnapshotError("snapshot_future");
		}
		if (current.snapshotStatus === "fresh") return current;

		await refresh({ source });
		current = await readOnce(source);
		if (current.snapshotStatus === "future") {
			throw new BrokerSnapshotError("snapshot_future");
		}
		if (current.snapshotStatus !== "fresh") {
			throw new BrokerSnapshotError("snapshot_stale_after_refresh");
		}
		return current;
	}

	return Object.freeze({ prepare });
}
