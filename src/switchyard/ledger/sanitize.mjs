import { createHash } from "node:crypto";

import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";

import { homedir, hostname } from "node:os";

import { dirname, join, resolve } from "node:path";

import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";

import { assertGenerationAllowed } from "../maintenance/index.mjs";

const DEFAULT_LEDGER_PATH = join(
	homedir(),
	".logs",
	"switchyard",
	"dispatch-ledger.jsonl",
);

function resolveLegacyLedgerPath() {
	const envOverride = process.env.SWITCHYARD_LEDGER_PATH;
	return envOverride ? resolve(envOverride) : DEFAULT_LEDGER_PATH;
}

function ensureLogDir() {
	try {
		mkdirSync(dirname(resolveLegacyLedgerPath()), { recursive: true });
	} catch (error) {
		if (error?.code !== "EEXIST") {
			throw error;
		}
	}
}

export function sanitizeDispatchEntry(dispatch) {
	const safe = { ...dispatch };
	const failure = sanitizeFailureMetadata(dispatch);
	// Provider output, thrown error messages, and host artifact paths are
	// transient adapter data. None may cross the ledger boundary.
	delete safe.error;
	delete safe.output;
	delete safe.partialDiffPath;
	delete safe.gateEvidence;
	delete safe.gateEvidencePath;
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

export function sanitizeIntentEntry(intent) {
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

const DEFAULT_LEDGER_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_LEDGER_SEGMENTS = 5;

let ledgerRotationFailures = 0;

let ledgerRotationWarned = false;

export function getLedgerRotationFailures() {
	return ledgerRotationFailures;
}

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

export function retainedSegmentPaths(path) {
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

export function rotateLedgerIfNeeded(path) {
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
