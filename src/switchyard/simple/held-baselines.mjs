/**
 * The differential baselines a held receipt carries, so a held apply's
 * HEAD-advance recheck judges a red-at-baseline test-runner check against the
 * original base tree's failing set, exactly as the run's own recheck does.
 *
 * Writer and reader share one rule, so a receipt this module writes always
 * reads back. A baseline is kept only when it qualifies (a clean per-test
 * report naming at least one failing test and none that ended abnormally)
 * and every test id and file is already in recorded form: no control
 * characters, nothing credential-shaped, at most MAX_BASELINE_ID_CHARS long.
 * A redacted or truncated id could never match the candidate's run, so such a
 * check is left out and rechecks strictly. The set as a whole stays within
 * MAX_BASELINE_TESTS and MAX_BASELINE_BYTES. The receipt's digest, which the
 * run record names, binds the result.
 */
import { isAbsolute } from "node:path";
import { persistableId } from "./check-differential.mjs";
import { testRunnerOf } from "./test-runner-argv.mjs";

/** Most base-tree tests one receipt carries across all its checks. */
export const MAX_BASELINE_TESTS = 20_000;
/** Longest test id or file a receipt carries, in characters. */
export const MAX_BASELINE_ID_CHARS = 1024;
/** Largest serialized baseline set one receipt carries. */
export const MAX_BASELINE_BYTES = 1024 * 1024;

const STATUSES = new Set(["passed", "failed", "skipped", "todo"]);
const ENTRY_KEYS = "command,runner,tests";

/** Thrown for a receipt whose baselines fail validation. */
export const BASELINES_INVALID = "differential_baselines_invalid";

const recordable = (text) =>
	typeof text === "string" &&
	text !== "" &&
	text.length <= MAX_BASELINE_ID_CHARS &&
	persistableId(text, MAX_BASELINE_ID_CHARS) === text;

// A test file as the report parsers keep it: relative to the checkout and
// never leaving it.
const recordableFile = (file) =>
	file === null ||
	(recordable(file) &&
		!isAbsolute(file) &&
		!file.split(/[\\/]/u).includes(".."));

/**
 * One persisted entry, `{command, runner, tests: [[id, status, file], ...]}`,
 * as the session's baseline shape, or null when it does not qualify.
 */
function decodeEntry(entry, checks) {
	if (
		entry === null ||
		typeof entry !== "object" ||
		Array.isArray(entry) ||
		Object.keys(entry).sort().join() !== ENTRY_KEYS ||
		!checks.includes(entry.command)
	)
		return null;
	const runner = testRunnerOf(entry.command);
	if (
		runner?.eligible !== true ||
		runner.runner !== entry.runner ||
		!Array.isArray(entry.tests) ||
		entry.tests.length === 0
	)
		return null;
	const tests = new Map();
	for (const test of entry.tests) {
		if (!Array.isArray(test) || test.length !== 3) return null;
		const [id, status, file] = test;
		if (
			!recordable(id) ||
			tests.has(id) ||
			!STATUSES.has(status) ||
			!recordableFile(file)
		)
			return null;
		tests.set(id, { status, file, abnormal: false });
	}
	if (![...tests.values()].some(({ status }) => status === "failed"))
		return null;
	return { runner: entry.runner, tests };
}

// A session baseline in persisted form, or null when it cannot be persisted
// faithfully.
function encodeEntry(command, baseline, checks) {
	if (!(baseline?.tests instanceof Map)) return null;
	const tests = [];
	for (const [id, entry] of baseline.tests) {
		if (entry?.abnormal !== false) return null;
		tests.push([id, entry.status, entry.file]);
	}
	const encoded = { command, runner: baseline.runner, tests };
	return decodeEntry(encoded, checks) ? encoded : null;
}

/**
 * The baselines `checkSessions.differentialBaselines()` captured, in the
 * receipt's persisted form: one entry per qualifying check, in check order,
 * within the total count and serialized-byte bounds. If either bound is
 * exceeded, no baselines are stored and every check rechecks strictly.
 * Other ineligible baselines are left out individually.
 *
 * @param {Map<string, object>|null|undefined} baselines By check command.
 * @param {string[]} checks The task's acceptance checks.
 * @returns {object[]}
 */
export function persistedBaselines(baselines, checks) {
	if (!(baselines instanceof Map)) return [];
	const kept = [];
	let tests = 0;
	let bytes = 2; // The serialized array brackets.
	for (const command of new Set(checks)) {
		const entry = encodeEntry(command, baselines.get(command), checks);
		if (!entry) continue;
		const size =
			Buffer.byteLength(JSON.stringify(entry), "utf8") +
			(kept.length > 0 ? 1 : 0);
		if (
			tests + entry.tests.length > MAX_BASELINE_TESTS ||
			bytes + size > MAX_BASELINE_BYTES
		)
			return [];
		tests += entry.tests.length;
		bytes += size;
		kept.push(entry);
	}
	return kept;
}

/**
 * The baselines a receipt carries, as the Map `createSimpleCheckSessions`
 * takes for `differentialBaselines`. A schema-1 receipt predates them and
 * returns null, so its recheck stays strict. Throws an error whose `detail`
 * is BASELINES_INVALID when the receipt's entries fail validation.
 *
 * @param {object} receipt A parsed held receipt.
 * @returns {Map<string, object>|null}
 */
export function receiptBaselines(receipt) {
	const invalid = () =>
		Object.assign(new Error("held_receipt_invalid"), {
			code: "held_receipt_invalid",
			detail: BASELINES_INVALID,
		});
	const hasField = Object.hasOwn(receipt, "differentialBaselines");
	if (receipt.schemaVersion === 1) {
		if (hasField) throw invalid();
		return null;
	}
	const { checks, differentialBaselines: entries } = receipt;
	if (
		!Array.isArray(checks) ||
		!checks.every((check) => typeof check === "string") ||
		!Array.isArray(entries) ||
		entries.length > checks.length ||
		Buffer.byteLength(JSON.stringify(entries), "utf8") > MAX_BASELINE_BYTES
	)
		throw invalid();
	const baselines = new Map();
	let tests = 0;
	for (const entry of entries) {
		const decoded = decodeEntry(entry, checks);
		if (!decoded || baselines.has(entry.command)) throw invalid();
		tests += decoded.tests.size;
		if (tests > MAX_BASELINE_TESTS) throw invalid();
		baselines.set(entry.command, decoded);
	}
	return baselines;
}
