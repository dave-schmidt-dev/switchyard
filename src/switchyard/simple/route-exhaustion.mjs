/** Durable per-target quota-exhaustion markers; independent of route-health mode. */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getStateRoot } from "../run-store/index.mjs";

export const ROUTE_EXHAUSTION_TTL_MS = 60 * 60 * 1000;

const TARGET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
// Internal write-guard codes; routing-run catches them and only warns, so
// they are never failure reasons.
const rejectRecord = (code) => {
	throw Object.assign(new Error(code), { code });
};
const exhaustionDir = ({ stateRoot } = {}) =>
	join(stateRoot ?? getStateRoot(), "route-exhaustion");
const recordPath = (dir, targetId) =>
	join(dir, `${createHash("sha256").update(targetId).digest("hex")}.json`);

/**
 * Mark one target quota-exhausted for an hour (default). The record is a
 * single JSON file per target, replaced atomically, so concurrent routing
 * runs never read-modify-write a shared file.
 *
 * @param {string} targetId - The exhausted target.
 * @param {object} [options]
 * @param {string} [options.stateRoot] - State root override; defaults to the
 *   run-store state root.
 * @param {() => number} [options.now] - Clock, default Date.now.
 * @param {number} [options.ttlMs] - Marker lifetime; default one hour.
 * @returns {{targetId: string, until: number}} The record as written.
 */
export function recordRouteExhaustion(
	targetId,
	{ stateRoot, now = Date.now, ttlMs = ROUTE_EXHAUSTION_TTL_MS } = {},
) {
	if (typeof targetId !== "string" || !TARGET_ID_RE.test(targetId))
		rejectRecord("route_exhaustion_target_invalid");
	const until = now() + ttlMs;
	if (!Number.isFinite(until)) rejectRecord("route_exhaustion_until_invalid");
	const dir = exhaustionDir({ stateRoot });
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = recordPath(dir, targetId);
	const tmp = join(dir, `.exhaustion-${randomUUID()}`);
	let fd;
	try {
		fd = openSync(tmp, "wx", 0o600);
		writeFileSync(fd, JSON.stringify({ targetId, until }));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tmp, target);
	} catch {
		rejectRecord("route_exhaustion_write_failed");
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(tmp)) unlinkSync(tmp);
	}
	return { targetId, until };
}

/**
 * Live exhaustion records. Expired records are ignored and removed best
 * effort; malformed or swept records are not evidence.
 *
 * @param {object} [options]
 * @param {string} [options.stateRoot] - State root override.
 * @param {() => number} [options.now] - Clock, default Date.now.
 * @returns {{targetId: string, until: number}[]} Live records.
 */
export function liveRouteExhaustion({ stateRoot, now = Date.now } = {}) {
	const dir = exhaustionDir({ stateRoot });
	let names;
	try {
		names = readdirSync(dir);
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const at = now();
	const live = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		let record;
		try {
			record = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			// A record replaced or swept mid-scan is not evidence.
			continue;
		}
		if (
			typeof record?.targetId !== "string" ||
			!TARGET_ID_RE.test(record.targetId) ||
			!Number.isFinite(record.until)
		)
			continue;
		if (record.until <= at) {
			try {
				unlinkSync(path);
			} catch {
				// Removal is best effort; an expired record is already ignored.
			}
			continue;
		}
		live.push({ targetId: record.targetId, until: record.until });
	}
	return live;
}
