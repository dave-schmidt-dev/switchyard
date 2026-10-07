import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { sanitizeFailureMetadata } from "../src/switchyard/adapter/exec-error.mjs";
import { CODE_CATEGORIES } from "../src/switchyard/diagnostics/failure-registry.mjs";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	getRunRoot,
	initializeRun,
	readRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	TEST_ROOT,
	VM_ADMISSION_ROOT,
} from "./helpers/run-store-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
process.env.SWITCHYARD_ROSTER_PATH = resolve(
	"tests/fixtures/roster.fixture.json",
);

// Releases whose run.json reader must keep accepting new records.
const FROZEN_REVISIONS = ["d48047a"];
const frozenReaders = new Map();
const frozenRoot = tempDir("switchyard-frozen-reader-");
// Codes some frozen release cannot store exactly; they persist as the stand-in.
const projectedCodes = new Set();
for (const revision of FROZEN_REVISIONS) {
	const dir = join(frozenRoot, revision.replace(/[^A-Za-z0-9]/gu, "_"));
	mkdirSync(dir, { recursive: true });
	// A missing revision must fail the suite, never skip it.
	const archive = execFileSync("git", ["archive", revision, "src"], {
		maxBuffer: 256 * 1024 * 1024,
	});
	execFileSync("tar", ["-x", "-C", dir], { input: archive });
	const module = await import(
		pathToFileURL(join(dir, "src/switchyard/run-store/validate-run.mjs")).href
	);
	ok(typeof module.validateRun === "function", revision);
	frozenReaders.set(revision, module.validateRun);
	const reliability = await import(
		pathToFileURL(
			join(dir, "src/switchyard/diagnostics/provider-reliability.mjs"),
		).href
	);
	for (const [causeCode, category] of CODE_CATEGORIES) {
		const frozen = reliability.createProviderReliabilityDiagnostic({
			causeCode,
			phase: "route",
			baselineStatus: "not_requested",
			repairStatus: "not_started",
		});
		if (frozen.causeCode !== causeCode || frozen.causeCategory !== category)
			projectedCodes.add(causeCode);
	}
}
// The previous release's vocabulary is closed; new codes must project.
for (const causeCode of [
	"no_route_available",
	"check_setup_failed",
	"check_environment_failed",
	"request_evidence_invalid",
	"provider_silence_timeout",
])
	ok(projectedCodes.has(causeCode), causeCode);

after(() => {
	rmSync(frozenRoot, { recursive: true, force: true });
	rmSync(TEST_ROOT, { recursive: true, force: true });
});
afterEach(() => {
	rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
	rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
});

function runJsonPath(runId) {
	return join(getRunRoot(runId), "run.json");
}

function onDisk(runId) {
	return JSON.parse(readFileSync(runJsonPath(runId), "utf8"));
}

function assertFrozenReadersAccept(record, label) {
	for (const [revision, validateRun] of frozenReaders) {
		try {
			validateRun(structuredClone(record));
		} catch (error) {
			throw new Error(`${revision} rejected ${label}: ${error.message}`);
		}
	}
}

async function writeFailedRun(causeCode, failureReason = "probe") {
	const opts = makeOptions({ orderedTaskIds: ["task-1"] });
	await initializeRun(opts);
	const providerReliability = createProviderReliabilityDiagnostic({
		causeCode,
		phase: "route",
		baselineStatus: "not_requested",
		repairStatus: "not_started",
	});
	strictEqual(providerReliability.causeCode, causeCode);
	await updateRunWithRetry(opts.runId, {
		state: "failed",
		lastFailure: sanitizeFailureMetadata({
			result: "execution_failed",
			errorKind: "unclassified_failure",
			failurePhase: "route",
			providerReliability,
		}),
		failureDetails: { failureReason },
	});
	return { runId: opts.runId, providerReliability };
}

describe("run records stay readable by frozen releases", () => {
	for (const causeCode of projectedCodes) {
		it(`persists ${causeCode} in a frozen-readable form`, async () => {
			const { runId, providerReliability } = await writeFailedRun(causeCode);
			const disk = onDisk(runId);
			strictEqual(disk.lastFailure.providerReliability.causeCode, "unknown");
			strictEqual(
				disk.lastFailure.providerReliability.causeCategory,
				"unknown",
			);
			deepStrictEqual(disk.failureDetails, {
				failureReason: "probe",
				causeCode,
			});
			assertFrozenReadersAccept(disk, causeCode);

			// The current reader restores the precise code in memory only.
			const read = await readRun(runId);
			deepStrictEqual(
				read.lastFailure.providerReliability,
				providerReliability,
			);
			strictEqual(
				read.lastFailure.providerReliability.causeCategory,
				CODE_CATEGORIES.get(causeCode),
			);
			deepStrictEqual(onDisk(runId), disk);

			// An unrelated update re-persists through the same projection.
			await updateRunWithRetry(runId, { cleanupState: "complete" });
			const rewritten = onDisk(runId);
			strictEqual(
				rewritten.lastFailure.providerReliability.causeCode,
				"unknown",
			);
			strictEqual(rewritten.failureDetails.causeCode, causeCode);
			assertFrozenReadersAccept(rewritten, `${causeCode} after update`);
		});
	}

	it("leaves every frozen cause code and its category unchanged", async () => {
		for (const [causeCode, category] of CODE_CATEGORIES) {
			if (projectedCodes.has(causeCode)) continue;
			const { runId } = await writeFailedRun(causeCode);
			const disk = onDisk(runId);
			strictEqual(disk.lastFailure.providerReliability.causeCode, causeCode);
			strictEqual(disk.lastFailure.providerReliability.causeCategory, category);
			strictEqual(disk.failureDetails.causeCode, undefined);
			assertFrozenReadersAccept(disk, causeCode);
		}
	});

	it("reads a legacy record with detail keys inside lastFailure", async () => {
		const opts = makeOptions({ orderedTaskIds: ["task-1"] });
		await initializeRun(opts);
		await updateRunWithRetry(opts.runId, {
			state: "failed",
			lastFailure: sanitizeFailureMetadata({
				result: "execution_failed",
				errorKind: "unclassified_failure",
				failurePhase: "diff",
			}),
		});
		// Shape written by pre-release builds of this change on this host.
		const legacy = onDisk(opts.runId);
		Object.assign(legacy.lastFailure, {
			failureReason: "diff_rejected",
			diffRejectionCategory: "undeclared",
			diffRejectionCount: 2,
			diffRejectionRule: "undeclared_path",
			diffRejectionPaths: ["a.txt", "b.txt"],
		});
		delete legacy.failureDetails;
		const raw = JSON.stringify(legacy);
		writeFileSync(runJsonPath(opts.runId), raw);

		const read = await readRun(opts.runId);
		deepStrictEqual(read.failureDetails, {
			failureReason: "diff_rejected",
			diffRejectionCategory: "undeclared",
			diffRejectionCount: 2,
			diffRejectionRule: "undeclared_path",
			diffRejectionPaths: ["a.txt", "b.txt"],
		});
		strictEqual(read.lastFailure.failureReason, undefined);
		strictEqual(read.lastFailure.diffRejectionPaths, undefined);
		// Reading never rewrites the file.
		strictEqual(readFileSync(runJsonPath(opts.runId), "utf8"), raw);
	});
});
