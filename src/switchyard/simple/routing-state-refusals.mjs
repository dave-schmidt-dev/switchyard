/**
 * Per-route-call refusal records, kept beside a routing run's state.json in
 * `route-refusals.json`. They are diagnostic only: they say why each target
 * was refused on each route call, and no routing decision reads them back.
 *
 * The records live in their own file so state.json keeps the exact key set
 * earlier releases validate, and so an unreadable or newer record file can
 * never fail a routing run closed: reads are tolerant and writes best effort.
 */
import { join } from "node:path";
import { closedReason } from "./route-evidence.mjs";
import {
	ensureSafeRoutingDirectories,
	readRoutingJsonFile,
	writeRoutingJsonAtomic,
} from "./routing-state-storage.mjs";

export const ROUTE_REFUSALS_FILE = "route-refusals.json";
/** Newest route calls kept; older records drop off the front. */
export const MAX_ROUTE_REFUSAL_RECORDS = 32;
/** Refusals kept per route call, the same bound as routeEvidence.excluded. */
export const MAX_ROUTE_REFUSALS_PER_CALL = 64;

const RECORD_KEYS = [
	"taskId",
	"attemptId",
	"at",
	"selectedTargetId",
	"excluded",
].sort();
const targetValid = (id) =>
	typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id);
// The same identifier and timestamp shapes routing state accepts.
const idValid = (id) =>
	typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id);
const atValid = (value) =>
	typeof value === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
	!Number.isNaN(Date.parse(value));
const isObject = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** One refusal with a closed reason, or null when it cannot be kept. */
function refusalEntry(entry) {
	if (!isObject(entry) || !targetValid(entry.targetId)) return null;
	const reason = closedReason(entry.reason);
	return entry.bucket === "ac" || entry.bucket === "ap"
		? { targetId: entry.targetId, reason, bucket: entry.bucket }
		: { targetId: entry.targetId, reason };
}

/**
 * The record kept for one route call, or null when its identity is unusable.
 * Unknown reasons become `unknown` and malformed refusals are dropped.
 */
function routeRefusalRecord(record) {
	if (
		!isObject(record) ||
		!idValid(record.taskId) ||
		!idValid(record.attemptId) ||
		!atValid(record.at)
	)
		return null;
	return {
		taskId: record.taskId,
		attemptId: record.attemptId,
		at: record.at,
		selectedTargetId: targetValid(record.selectedTargetId)
			? record.selectedTargetId
			: null,
		excluded: (Array.isArray(record.excluded) ? record.excluded : [])
			.map(refusalEntry)
			.filter(Boolean)
			.slice(0, MAX_ROUTE_REFUSALS_PER_CALL),
	};
}

/**
 * The routing run's stored refusal records, oldest first. A missing, unsafe
 * or malformed file reads as no records, and a record with unexpected keys is
 * skipped; this never throws.
 */
export function readRouteRefusals(runDir) {
	let stored;
	try {
		stored = readRoutingJsonFile(join(runDir, ROUTE_REFUSALS_FILE));
	} catch {
		return [];
	}
	if (!isObject(stored) || !Array.isArray(stored.records)) return [];
	return stored.records
		.filter(
			(record) =>
				isObject(record) &&
				Object.keys(record).sort().join() === RECORD_KEYS.join(),
		)
		.map(routeRefusalRecord)
		.filter(Boolean)
		.slice(-MAX_ROUTE_REFUSAL_RECORDS);
}

/**
 * Append one route call's record, keeping the newest
 * MAX_ROUTE_REFUSAL_RECORDS. The caller holds the routing run lock. Throws
 * `routing_refusals_write_failed` or `routing_unsafe_file` on a failed write;
 * the routing run treats either as a warning.
 */
export function appendRouteRefusals(runDir, record) {
	const kept = routeRefusalRecord(record);
	if (!kept || !ensureSafeRoutingDirectories(runDir, false)) return;
	writeRoutingJsonAtomic(
		runDir,
		ROUTE_REFUSALS_FILE,
		{
			schemaVersion: 1,
			records: [...readRouteRefusals(runDir), kept].slice(
				-MAX_ROUTE_REFUSAL_RECORDS,
			),
		},
		"routing_refusals_write_failed",
	);
}
