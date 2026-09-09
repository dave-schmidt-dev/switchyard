#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_FIELD_ALLOWLIST = Object.freeze([
	"stage",
	"classification",
	"counter",
	"identityHash",
	"evidenceStatus",
]);

export const CLASSIFICATION_PRECEDENCE = Object.freeze([
	"preflight_failure",
	"auth_expiry",
	"provider_failure",
	"artifact_failure",
	"integration_rejection",
	"cleanup_uncertainty",
	"detached_fatal",
	"ambiguous_completion",
	"duplicate_event",
	"success",
]);

export const SORT_PRECEDENCE = Object.freeze([
	"identityHash",
	"classification",
	"stage",
	"counter",
	"evidenceStatus",
]);

const STAGES = new Set([
	"run",
	"preflight",
	"provider",
	"artifact",
	"integration",
	"cleanup",
	"detached",
	"completion",
]);
const EVIDENCE_STATUSES = new Set([
	"observed",
	"missing",
	"sanitized",
	"ambiguous",
]);
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|~[\\/])/;

function fail(code) {
	const error = new Error(code);
	error.code = code;
	throw error;
}

function stableJson(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function hasForbiddenKey(key) {
	const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
	return [
		"prompt",
		"rawstream",
		"stream",
		"patchbytes",
		"patch",
		"exception",
		"credentials",
		"credential",
		"secret",
		"environment",
		"env",
		"absolutepath",
		"hostpath",
	].some(
		(forbidden) =>
			normalized === forbidden ||
			normalized.startsWith(forbidden) ||
			normalized.endsWith(forbidden),
	);
}

function compareRecords(left, right) {
	for (const key of SORT_PRECEDENCE) {
		const comparison =
			key === "classification"
				? CLASSIFICATION_PRECEDENCE.indexOf(left[key]) -
					CLASSIFICATION_PRECEDENCE.indexOf(right[key])
				: String(left[key]).localeCompare(String(right[key]));
		if (comparison !== 0) return comparison;
	}
	return 0;
}

/** Return a non-reversible source identity without retaining a run ID or path. */
export function hashSourceIdentity(source) {
	if (typeof source !== "string" || source.length === 0)
		fail("invalid_source_identity");
	return `sha256:${createHash("sha256")
		.update(`switchyard-outcome-replay/v1\u0000${source}`)
		.digest("hex")}`;
}

/** Reject values that could carry operational content before sanitization. */
export function assertSafeSourceValue(value, field = "root") {
	if (typeof value === "string" && ABSOLUTE_PATH.test(value)) {
		fail(`forbidden_absolute_path:${field}`);
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			assertSafeSourceValue(entry, `${field}[${index}]`);
		});
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			if (hasForbiddenKey(key)) fail(`forbidden_sensitive_field:${key}`);
			assertSafeSourceValue(entry, key);
		}
	}
}

function safeCode(value) {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function classifyEvent(event) {
	const phase = safeCode(event.phase);
	const eventName = safeCode(event.event);
	const reason = `${safeCode(event.reasonCode)} ${safeCode(event.diagnosticCode)} ${safeCode(event.errorKind)}`;
	const failed = event.status === "failed" || event.result === "failed";
	if (reason.includes("auth")) return ["preflight", "auth_expiry"];
	if (phase.includes("preflight")) return ["preflight", "preflight_failure"];
	if (
		reason.includes("diff_capture") ||
		eventName.includes("artifact") ||
		eventName.includes("diff_capture")
	) {
		return ["artifact", "artifact_failure"];
	}
	if (phase.includes("integration") || reason.includes("integration")) {
		return ["integration", "integration_rejection"];
	}
	if (phase.includes("cleanup") || reason.includes("cleanup")) {
		return ["cleanup", "cleanup_uncertainty"];
	}
	if (phase.includes("detached") || eventName.includes("fatal")) {
		return ["detached", "detached_fatal"];
	}
	if (eventName.includes("duplicate")) return ["completion", "duplicate_event"];
	if (eventName.includes("ambiguous"))
		return ["completion", "ambiguous_completion"];
	if (phase.includes("provider") || reason.includes("execution_failed")) {
		return ["provider", "provider_failure"];
	}
	if (failed) return ["completion", "ambiguous_completion"];
	return null;
}

function readEventRows(runDir) {
	const eventPath = resolve(runDir, "events.jsonl");
	if (!existsSync(eventPath)) return [];
	const text = readFileSync(eventPath, "utf8");
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			try {
				const row = JSON.parse(line);
				assertSafeSourceValue(row);
				return row;
			} catch (error) {
				if (error?.code) throw error;
				fail("invalid_event_json");
				return null;
			}
		})
		.sort(
			(left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0),
		);
}

/**
 * Import only explicitly supplied source directories. Source sorting is by the
 * hash of each directory basename; classifications use the pinned precedence;
 * event ordering falls back to its recorded counter.
 */
export function importRunDirectories(runDirectories) {
	if (!Array.isArray(runDirectories) || runDirectories.length === 0) {
		fail("explicit_run_directories_required");
	}
	const identities = new Set();
	const records = [];
	for (const suppliedDirectory of runDirectories) {
		if (
			typeof suppliedDirectory !== "string" ||
			suppliedDirectory.length === 0
		) {
			fail("invalid_run_directory");
		}
		const runDirectory = resolve(suppliedDirectory);
		if (!statSync(runDirectory).isDirectory())
			fail("run_directory_not_directory");
		const identityHash = hashSourceIdentity(basename(runDirectory));
		if (identities.has(identityHash)) fail("duplicate_source_identity");
		identities.add(identityHash);
		const counters = new Map();
		for (const event of readEventRows(runDirectory)) {
			const classified = classifyEvent(event);
			if (!classified) continue;
			const [stage, classification] = classified;
			const counterKey = `${stage}:${classification}`;
			const counter = (counters.get(counterKey) ?? 0) + 1;
			counters.set(counterKey, counter);
			records.push({
				stage,
				classification,
				counter,
				identityHash,
				evidenceStatus: "observed",
			});
		}
	}
	return records.sort(compareRecords);
}

function syntheticRecord(stage, classification, counter = 1) {
	return {
		stage,
		classification,
		counter,
		identityHash: hashSourceIdentity(`synthetic:${classification}`),
		evidenceStatus: "sanitized",
	};
}

export const SYNTHETIC_RECORDS = Object.freeze([
	syntheticRecord("run", "success"),
	syntheticRecord("preflight", "preflight_failure"),
	syntheticRecord("preflight", "auth_expiry"),
	syntheticRecord("provider", "provider_failure"),
	syntheticRecord("artifact", "artifact_failure"),
	syntheticRecord("integration", "integration_rejection"),
	syntheticRecord("cleanup", "cleanup_uncertainty"),
	syntheticRecord("detached", "detached_fatal"),
	syntheticRecord("completion", "duplicate_event"),
	syntheticRecord("completion", "ambiguous_completion"),
]);

export function validateSanitizedRecord(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) {
		fail("invalid_sanitized_record");
	}
	const keys = Object.keys(record).sort();
	const allowed = [...SOURCE_FIELD_ALLOWLIST].sort();
	if (
		keys.length !== allowed.length ||
		keys.some((key, index) => key !== allowed[index])
	) {
		fail("sanitized_record_allowlist_violation");
	}
	if (!STAGES.has(record.stage)) fail("invalid_stage");
	if (!CLASSIFICATION_PRECEDENCE.includes(record.classification)) {
		fail("invalid_classification");
	}
	if (!Number.isSafeInteger(record.counter) || record.counter < 1)
		fail("invalid_counter");
	if (!/^sha256:[0-9a-f]{64}$/.test(record.identityHash))
		fail("invalid_identity_hash");
	if (!EVIDENCE_STATUSES.has(record.evidenceStatus))
		fail("invalid_evidence_status");
}

export function createOutcomeReplayCorpus(runDirectories = []) {
	const records = [
		...SYNTHETIC_RECORDS,
		...importRunDirectories(runDirectories),
	].sort(compareRecords);
	records.forEach(validateSanitizedRecord);
	return {
		schemaVersion: 1,
		sourceFieldAllowlist: SOURCE_FIELD_ALLOWLIST,
		sortPrecedence: SORT_PRECEDENCE,
		classificationPrecedence: CLASSIFICATION_PRECEDENCE,
		records,
		baselines: {
			maskingPrimary: "provider_failure",
			maskingSecondary: "artifact_failure",
			logicalFailedTasks: 1,
			failureFacts: 2,
		},
	};
}

export function serializeOutcomeReplayCorpus(runDirectories = []) {
	return stableJson(createOutcomeReplayCorpus(runDirectories));
}

function parseArgs(args) {
	const runDirectories = [];
	let outputPath = null;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--run") runDirectories.push(args[++index]);
		else if (args[index] === "--output") outputPath = args[++index];
		else fail("invalid_argument");
	}
	if (!outputPath || runDirectories.some((entry) => !entry))
		fail("usage_requires_output_and_run");
	return { runDirectories, outputPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { runDirectories, outputPath } = parseArgs(process.argv.slice(2));
	writeFileSync(
		outputPath,
		serializeOutcomeReplayCorpus(runDirectories),
		"utf8",
	);
}
