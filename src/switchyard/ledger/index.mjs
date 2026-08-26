// Ledger module - dispatch logging
// INV-4: Every dispatch records provider + model + result

import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import { assertGenerationAllowed } from "../maintenance/index.mjs";
import { getStateRoot } from "../run-store/index.mjs";

const DEFAULT_LEDGER_PATH = join(
	homedir(),
	".logs",
	"switchyard",
	"dispatch-ledger.jsonl",
);

/**
 * Resolve the legacy ledger file path, honoring SWITCHYARD_LEDGER_PATH for
 * test isolation (mirrors SWITCHYARD_ROSTER_PATH / SWITCHYARD_RUN_STORE_ROOT).
 * Read lazily (not cached at module load) so tests can redirect it per-run.
 */
function resolveLegacyLedgerPath() {
	const envOverride = process.env.SWITCHYARD_LEDGER_PATH;
	return envOverride ? resolve(envOverride) : DEFAULT_LEDGER_PATH;
}

/**
 * Ensure log directory exists.
 */
function ensureLogDir() {
	try {
		mkdirSync(dirname(resolveLegacyLedgerPath()), { recursive: true });
	} catch (error) {
		if (error?.code !== "EEXIST") {
			throw error;
		}
	}
}

function sanitizeDispatchEntry(dispatch) {
	const safe = { ...dispatch };
	const failure = sanitizeFailureMetadata(dispatch);
	// Provider output, thrown error messages, and host artifact paths are
	// transient adapter data. None may cross the ledger boundary.
	delete safe.error;
	delete safe.output;
	delete safe.partialDiffPath;
	if (failure) {
		delete safe.reason;
		Object.assign(safe, failure);
	}
	return safe;
}

const INTENT_STRING_FIELDS = new Set([
	"taskId",
	"provider",
	"model",
	"requiredCapability",
	"resolvedTargetId",
	"descriptorIdentity",
	"descriptorHarness",
	"roster_sha256",
	"resolved_target",
	"resolved_harness",
	"resolved_selector",
	"resolved_credential_profile",
]);
const INTENT_NUMBER_FIELDS = new Set(["roster_schema_version"]);

const SAFE_DESCRIPTOR_IDENTITY = /^sha256:[a-f0-9]{64}$/i;
const SAFE_CAPABILITIES = new Set(["low", "standard", "high"]);
const SAFE_PROVIDERS = new Set([
	"agy",
	"antigravity-claude",
	"claude",
	"codex",
	"copilot",
	"cursor",
	"opencode",
	"opencode-go",
	"vibe",
]);
const SAFE_HARNESSES = new Set([
	"agy",
	"claude",
	"codex",
	"copilot",
	"cursor",
	"opencode",
	"opencode-go",
	"vibe",
]);
// Flexible task/model/selector/profile values are correlation inputs only.
// Persist a one-way fingerprint instead of trusting a grammar that could still
// admit a hostname, path, or credential-shaped value.
const INTENT_FINGERPRINT_FIELDS = new Set([
	"taskId",
	"model",
	"resolvedTargetId",
	"resolved_target",
	"resolved_selector",
	"resolved_credential_profile",
]);

function fingerprintIntentValue(value) {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return `sha256:${createHash("sha256")
		.update(value.slice(0, 4096), "utf8")
		.digest("hex")}`;
}

function sanitizeIntentString(key, value) {
	if (INTENT_FINGERPRINT_FIELDS.has(key)) return fingerprintIntentValue(value);
	if (key === "descriptorIdentity" || key === "roster_sha256") {
		return typeof value === "string" && SAFE_DESCRIPTOR_IDENTITY.test(value)
			? value
			: undefined;
	}
	if (key === "requiredCapability") {
		return SAFE_CAPABILITIES.has(value) ? value : undefined;
	}
	if (key === "provider") {
		return SAFE_PROVIDERS.has(value) ? value : undefined;
	}
	if (key === "descriptorHarness" || key === "resolved_harness") {
		return SAFE_HARNESSES.has(value) ? value : undefined;
	}
	return undefined;
}

// Intent receipts are deliberately narrower than outcome records. In
// particular, do not spread the caller's object here: task prompts, env,
// host paths, adapter output, and descriptor invocation args must never cross
// this durable boundary.
function sanitizeIntentEntry(intent) {
	const safe = {
		intent: true,
		recordType: "intent",
	};
	for (const key of INTENT_STRING_FIELDS) {
		if (typeof intent?.[key] === "string") {
			const value = sanitizeIntentString(key, intent[key]);
			if (value !== undefined) safe[key] = value;
		} else if (intent?.[key] === null) {
			safe[key] = null;
		}
	}
	for (const key of INTENT_NUMBER_FIELDS) {
		if (Number.isSafeInteger(intent?.[key])) safe[key] = intent[key];
		else if (intent?.[key] === null) safe[key] = null;
	}
	return safe;
}

/**
 * Record a dispatch to the ledger.
 * INV-4: records provider + model + result for each dispatch
 *
 * @param {object} dispatch
 * @param {string} dispatch.provider Provider name
 * @param {string} dispatch.model Model name
 * @param {string} dispatch.taskId Task identifier
 * @param {string} dispatch.result Dispatch result status
 * @param {string} [dispatch.requiredCapability] Resolved capability class
 * @param {string} [dispatch.reason] Routing reason
 * @param {number} [dispatch.percentLeft] Provider percent left at dispatch time
 */
export function recordDispatch(dispatch) {
	assertGenerationAllowed();
	ensureLogDir();

	const entry = {
		timestamp: new Date().toISOString(),
		host: hostname(),
		...sanitizeDispatchEntry(dispatch),
	};

	appendFileSync(
		resolveLegacyLedgerPath(),
		`${JSON.stringify(entry)}\n`,
		"utf8",
	);
}

/**
 * Read all ledger entries.
 * @returns {Array} Array of dispatch entries
 */
export function readLedger() {
	try {
		const content = readFileSync(resolveLegacyLedgerPath(), "utf8");
		const entries = [];
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			try {
				entries.push(JSON.parse(line));
			} catch (parseError) {
				console.error(
					`readLedger: skipping malformed line: ${parseError.message}`,
				);
			}
		}
		return entries;
	} catch {
		return [];
	}
}

// The store-backed ledger is a single append-only file with no rotation. On
// 2026-08-26 it had reached 25.3 MB and 32,448 lines since 2026-08-04, about
// 1.1 MB a day, which is 89 percent of all Switchyard log volume. Rotate on
// size rather than age: the write rate differs by orders of magnitude between
// an idle day and a live-run day, so an age window either keeps far too much or
// discards a whole run's provenance in one sweep.
const DEFAULT_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_LEDGER_SEGMENTS = 5;

let ledgerRotationFailures = 0;
let ledgerRotationWarned = false;

/**
 * Number of ledger rotations this process failed to complete.
 * @returns {number}
 */
export function getLedgerRotationFailures() {
	return ledgerRotationFailures;
}

/**
 * Reset the rotation failure counter. Test seam only.
 * @returns {void}
 */
export function resetLedgerRotationFailures() {
	ledgerRotationFailures = 0;
	ledgerRotationWarned = false;
}

function ledgerMaxBytes() {
	const raw = Number(process.env.SWITCHYARD_LEDGER_MAX_BYTES);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEDGER_MAX_BYTES;
}

function ledgerSegments() {
	const raw = Number(process.env.SWITCHYARD_LEDGER_SEGMENTS);
	return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LEDGER_SEGMENTS;
}

function segmentPath(path, index) {
	return `${path}.${index}`;
}

/**
 * Segment paths oldest-first, for readers that want the full retained history.
 * @param {string} path active ledger path
 * @returns {string[]}
 */
function retainedSegmentPaths(path) {
	const paths = [];
	for (let index = ledgerSegments(); index >= 1; index -= 1) {
		paths.push(segmentPath(path, index));
	}
	return paths;
}

function noteRotationFailure(error) {
	ledgerRotationFailures += 1;
	if (ledgerRotationWarned) return;
	ledgerRotationWarned = true;
	console.warn(
		`switchyard: dispatch ledger rotation failed (${error?.code ?? "unknown"}); the ledger will keep growing but this run is unaffected`,
	);
}

/**
 * Rotate the active ledger once it outgrows its bound.
 *
 * The active file keeps its name so existing readers are unaffected; retained
 * history moves to `.1` (newest) through `.N` (oldest). Best-effort by design:
 * the ledger is an observability channel and a rotation failure must never be
 * able to abort a run, for the same reason the legacy append is best-effort.
 *
 * @param {string} path active ledger path
 * @returns {void}
 */
function rotateLedgerIfNeeded(path) {
	try {
		if (statSync(path).size < ledgerMaxBytes()) return;
	} catch (error) {
		// Nothing written yet is the normal first-call case, not a failure.
		if (error?.code !== "ENOENT") noteRotationFailure(error);
		return;
	}
	try {
		const keep = ledgerSegments();
		// Drop the oldest segment, then shift every survivor down one slot.
		rmSync(segmentPath(path, keep), { force: true });
		for (let index = keep - 1; index >= 1; index -= 1) {
			try {
				renameSync(segmentPath(path, index), segmentPath(path, index + 1));
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		// Rename rather than copy-and-truncate: an in-flight reader keeps a
		// consistent view and no entry can be observed twice or lost.
		renameSync(path, segmentPath(path, 1));
	} catch (error) {
		noteRotationFailure(error);
	}
}

function resolveLedgerDir(runStorePath) {
	const root = runStorePath ?? getStateRoot();
	return resolve(root, "ledger");
}

function resolveLedgerPath(runStorePath) {
	return join(resolveLedgerDir(runStorePath), "dispatch-ledger.jsonl");
}

/**
 * Record a dispatch entry to the project-local run-store ledger.
 *
 * @param {object} data
 * @param {string} data.provider
 * @param {string} data.model
 * @param {string} data.taskId
 * @param {string} data.result
 * @param {string} [data.requiredCapability]
 * @param {string} [data.reason]
 * @param {number} [data.percentLeft]
 * @param {string} [runStorePath] - defaults to getStateRoot()
 * @returns {Promise<void>}
 */
export async function recordDispatchToStore(data, runStorePath) {
	assertGenerationAllowed();
	const dir = resolveLedgerDir(runStorePath);
	await mkdir(dir, { recursive: true });

	const entry = {
		timestamp: new Date().toISOString(),
		host: hostname(),
		storeBacked: true,
		...sanitizeDispatchEntry(data),
	};

	const path = resolveLedgerPath(runStorePath);
	rotateLedgerIfNeeded(path);
	await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Write the authoritative, sanitized project-local dispatch intent receipt.
 * This is synchronous by design: callers must finish the durable append
 * before invoking a provider or launching an orchestrator job.
 *
 * @param {object} data safe dispatch provenance
 * @param {string} [runStorePath] defaults to getStateRoot()
 * @returns {void}
 */
export function recordDispatchIntentToStore(data, runStorePath) {
	assertGenerationAllowed();
	const dir = resolveLedgerDir(runStorePath);
	mkdirSync(dir, { recursive: true });
	const entry = {
		timestamp: new Date().toISOString(),
		storeBacked: true,
		...sanitizeIntentEntry(data),
	};
	const path = resolveLedgerPath(runStorePath);
	// Rotation is best-effort; the append below is NOT. This receipt is
	// synchronous by design and callers depend on it being durable before a
	// provider is invoked, so its failure must still propagate.
	rotateLedgerIfNeeded(path);
	appendFileSync(path, `${JSON.stringify(entry)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

/**
 * Read all entries from the project-local run-store ledger.
 *
 * @param {string} [runStorePath] - defaults to getStateRoot()
 * @returns {Promise<Array>} Array of dispatch entries
 */
export async function readLedgerFromStore(runStorePath) {
	const path = resolveLedgerPath(runStorePath);
	const entries = [];
	// Oldest retained segment first, active file last, so a rotation boundary is
	// invisible to callers and chronological order is preserved across it.
	for (const candidate of [...retainedSegmentPaths(path), path]) {
		let content;
		try {
			content = await readFile(candidate, "utf8");
		} catch (e) {
			if (e.code === "ENOENT") continue;
			// A missing segment is normal; anything else on the ACTIVE file is
			// not, and must still surface.
			if (candidate === path) throw e;
			continue;
		}
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			try {
				entries.push(JSON.parse(line));
			} catch (parseError) {
				console.error(
					`readLedgerFromStore: skipping malformed line: ${parseError.message}`,
				);
			}
		}
	}
	return entries;
}
