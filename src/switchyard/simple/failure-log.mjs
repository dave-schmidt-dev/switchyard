/** Append-only simple-routing failure log for periodic review and tuning. */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { DETAIL_FIELD_TYPES } from "../diagnostics/failure-registry.mjs";
import {
	retainedSegmentPaths,
	rotateLedgerIfNeeded,
} from "../ledger/sanitize.mjs";
import { parseRfc3339 } from "../rfc3339.mjs";
import { getStateRoot } from "../run-store/index.mjs";
import { LIFECYCLE_CHECKS } from "./routing-stop-record.mjs";

const VALID_ORIGINS = Object.freeze(["work", "qualification"]);
const VALID_ORIGIN_SET = new Set(VALID_ORIGINS);
const RECORD_TYPES = new Set(["attempt", "stop", "invocation"]);
const STRING_FIELDS = [
	"project",
	"routingRunId",
	"taskId",
	"attemptId",
	"runId",
	"targetId",
	"capability",
	"severity",
	"reason",
	"stopReason",
	"exhaustionCause",
	"causeCategory",
	"causeCode",
	"phase",
	"failurePhase",
	"errorKind",
];
const BOOLEAN_FIELDS = ["salvageable", "partialRetained"];
// Optional fields are copied only when the caller supplies them, each through
// the sanitizer of its declared type: a registered detail field can never be
// dropped or coerced to another type.
const OPTIONAL_FIELD_TYPES = Object.freeze({
	preflightCode: "string",
	usageError: "string",
	lifecycleCheck: "string",
	...DETAIL_FIELD_TYPES,
});
const STRING_ARRAY_LIMIT = 5;
const STRING_ARRAY_MAX_CHARS = 200;
const hasControls = (value) =>
	[...value].some(
		(char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
	);
const sanitizeString = (value) =>
	typeof value === "string" && value.length <= 256 && !hasControls(value)
		? value
		: null;
const sanitizeStringArray = (value) => {
	if (!Array.isArray(value)) return null;
	const bounded = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		bounded.push(
			item.replace(/\p{Cc}/gu, "?").slice(0, STRING_ARRAY_MAX_CHARS),
		);
		if (bounded.length === STRING_ARRAY_LIMIT) break;
	}
	return bounded;
};
const sanitizeIntegerField = (value) =>
	Number.isSafeInteger(value) && value >= 0 && value <= 4096 ? value : null;
function sanitizeOptionalField(type, value) {
	if (type === "boolean") return typeof value === "boolean" ? value : null;
	if (type === "integer") return sanitizeIntegerField(value);
	if (type === "stringArray") return sanitizeStringArray(value);
	return sanitizeString(value);
}

function logPath({ stateRoot } = {}, create) {
	const dir = join(stateRoot ?? getStateRoot(), "failure-log");
	if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, "failures.jsonl");
	if (create) {
		let fd;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	return path;
}

/**
 * Resolve (and create with restrictive modes) the failure log location.
 *
 * @param {object} [options]
 * @param {string} [options.stateRoot] - State root override; defaults to the
 *   run-store state root.
 * @returns {string} Absolute path to `failure-log/failures.jsonl`. The
 *   directory is created with mode 0o700 and the file with 0o600.
 */
export function failureLogPath(options = {}) {
	return logPath(options, true);
}

function fingerprintOf(record) {
	const reason =
		record.recordType === "stop" ? record.stopReason : record.reason;
	return createHash("sha256")
		.update(
			[record.targetId, reason, record.causeCode, record.phase]
				.map((value) => value ?? "")
				.join("|"),
		)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Append one sanitized failure record as a JSON line.
 *
 * The record is built from a closed allowlist only: unknown input keys are
 * dropped, missing values become null, and strings longer than 256 characters
 * or containing control characters become null. Prompts, provider output,
 * argv, environment, check commands and file contents are never recorded.
 * Registered detail fields (and the invocation fields `preflightCode` and
 * `usageError`) are copied only when supplied, each sanitized by its declared
 * type. `lifecycleCheck` is copied only when it names a closed lifecycle check.
 *
 * @param {object} input - Raw record fields; `recordType` must be "attempt",
 *   "stop" or "invocation".
 * @param {object} [options]
 * @param {string} [options.stateRoot] - State root override.
 * @returns {object} The record exactly as it was appended.
 */
export function appendFailureRecord(input, { stateRoot } = {}) {
	const recordType = input?.recordType;
	if (!RECORD_TYPES.has(recordType)) {
		throw Object.assign(new Error("failure_log_record_type_invalid"), {
			code: "failure_log_record_type_invalid",
		});
	}
	const record = {
		schemaVersion: 1,
		recordedAt: new Date().toISOString(),
		recordType,
	};
	for (const key of STRING_FIELDS) record[key] = sanitizeString(input?.[key]);
	for (const key of BOOLEAN_FIELDS)
		record[key] = typeof input?.[key] === "boolean" ? input[key] : null;
	for (const [key, type] of Object.entries(OPTIONAL_FIELD_TYPES)) {
		if (input?.[key] === undefined) continue;
		record[key] = sanitizeOptionalField(type, input[key]);
	}
	// lifecycleCheck is a closed enum: anything else is not a check name.
	if (
		record.lifecycleCheck !== undefined &&
		!LIFECYCLE_CHECKS.includes(record.lifecycleCheck)
	)
		record.lifecycleCheck = null;
	record.fingerprint = fingerprintOf(record);
	let origin = input?.origin;
	if (origin === undefined || origin === null) {
		origin = "work";
	} else if (typeof origin !== "string" || !VALID_ORIGIN_SET.has(origin)) {
		throw Object.assign(new Error("failure_log_origin_invalid"), {
			code: "failure_log_origin_invalid",
		});
	}
	record.origin = origin;
	const path = failureLogPath({ stateRoot });
	rotateLedgerIfNeeded(path);
	appendFileSync(path, `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return record;
}

/**
 * Read every retained failure record, oldest first.
 *
 * @param {object} [options]
 * @param {string} [options.stateRoot] - State root override.
 * @param {string} [options.since] - RFC3339 lower bound on `recordedAt`.
 * @returns {object[]} Parsed records; malformed lines are skipped.
 */
export function readFailureRecords({ stateRoot, since } = {}) {
	let sinceMs = null;
	let sinceHasSubMillisecondRemainder = false;
	if (since !== undefined) {
		const parsedSince = parseRfc3339(since);
		if (!parsedSince) {
			throw Object.assign(new Error("failure_log_since_invalid"), {
				code: "failure_log_since_invalid",
			});
		}
		sinceMs = parsedSince.epochMs;
		sinceHasSubMillisecondRemainder = parsedSince.hasSubMillisecondRemainder;
	}
	const path = logPath({ stateRoot }, false);
	const records = [];
	for (const candidate of [...retainedSegmentPaths(path), path]) {
		let content;
		try {
			content = readFileSync(candidate, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const record = JSON.parse(line);
				const recordedAtMs = Date.parse(record?.recordedAt);
				if (sinceMs !== null) {
					const recordedAtIsAfterSince =
						recordedAtMs > sinceMs ||
						(recordedAtMs === sinceMs && !sinceHasSubMillisecondRemainder);
					if (!recordedAtIsAfterSince) continue;
				}
				if (record && typeof record === "object" && !Array.isArray(record)) {
					if (record.origin != null && !VALID_ORIGIN_SET.has(record.origin))
						continue;
					record.origin ??= "work";
				}
				records.push(record);
			} catch {
				// A malformed line must never block a periodic review.
			}
		}
	}
	return records;
}

const asString = (value) => (typeof value === "string" ? value : null);

/**
 * Aggregate failure records for review.
 *
 * @param {object[]} records - Records as produced by appendFailureRecord.
 * @param {object} [options]
 * @param {string} [options.origin="work"] - Origin filter ("work", "qualification", or "all").
 * @returns {{ groups: object[], totals: { byTargetId: object, byReason: object } }}
 *   Groups keyed by fingerprint, sorted by count descending then lastSeen
 *   descending. Totals count records per targetId and per reason (stop
 *   records contribute their stopReason).
 */
export function summarizeFailures(records, options = {}) {
	const originFilter = options?.origin ?? "work";
	if (
		originFilter !== "work" &&
		originFilter !== "qualification" &&
		originFilter !== "all"
	) {
		throw Object.assign(new Error("failure_log_origin_invalid"), {
			code: "failure_log_origin_invalid",
		});
	}
	const groups = new Map();
	const totals = { byTargetId: {}, byReason: {} };
	for (const record of Array.isArray(records) ? records : []) {
		if (record?.origin != null && !VALID_ORIGIN_SET.has(record.origin))
			continue;
		const recordOrigin = record?.origin ?? "work";
		if (originFilter !== "all" && recordOrigin !== originFilter) continue;
		const reason = record?.reason ?? record?.stopReason ?? null;
		const targetId = asString(record?.targetId);
		const targetKey = targetId ?? "null";
		totals.byTargetId[targetKey] = (totals.byTargetId[targetKey] ?? 0) + 1;
		const reasonKey = reason ?? "null";
		totals.byReason[reasonKey] = (totals.byReason[reasonKey] ?? 0) + 1;
		const recordedAt = asString(record?.recordedAt) ?? "";
		const key =
			typeof record?.fingerprint === "string" && record.fingerprint !== ""
				? record.fingerprint
				: fingerprintOf(record ?? {});
		let group = groups.get(key);
		if (!group) {
			group = {
				fingerprint: key,
				recordType: record?.recordType ?? null,
				targetId,
				reason,
				causeCode: record?.causeCode ?? null,
				phase: record?.phase ?? null,
				count: 0,
				firstSeen: recordedAt,
				lastSeen: recordedAt,
				projects: new Set(),
				capabilities: new Set(),
				sampleRunIds: [],
			};
			groups.set(key, group);
		}
		group.count += 1;
		if (recordedAt < group.firstSeen) group.firstSeen = recordedAt;
		if (recordedAt > group.lastSeen) group.lastSeen = recordedAt;
		const project = asString(record?.project);
		if (project !== null) group.projects.add(project);
		const capability = asString(record?.capability);
		if (capability !== null) group.capabilities.add(capability);
		const runId = asString(record?.runId);
		if (
			runId !== null &&
			!group.sampleRunIds.includes(runId) &&
			group.sampleRunIds.length < 3
		)
			group.sampleRunIds.push(runId);
	}
	return {
		groups: [...groups.values()]
			.map((group) => ({
				...group,
				projects: group.projects.size,
				capabilities: [...group.capabilities].sort(),
			}))
			.sort(
				(a, b) =>
					b.count - a.count ||
					(a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0),
			),
		totals,
	};
}
