/**
 * Held integration: `simple --integrate hold` verifies a diff exactly as a
 * normal integration would, then stores the patch and a receipt under the
 * run's own store directory instead of writing to the project tree.
 * `routing-run apply` later integrates that same patch (see held-apply.mjs).
 *
 * The run record is the authority. Its terminal summary names both files and
 * their SHA-256 digests, so an edited receipt or patch is refused rather than
 * applied.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { integrationGate } from "../integrate/index.mjs";
import { getRunRoot } from "../run-store/run-records.mjs";
import { MAX_CAPTURE_BYTES } from "./git-control.mjs";

const HELD_DIRNAME = "held-integration";
const PATCH_NAME = "held.patch";
const RECEIPT_NAME = "receipt.json";
const RECEIPT_KIND = "switchyard.held-integration";
const MAX_RECEIPT_BYTES = 256 * 1024;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function heldPaths(runId) {
	const directory = join(getRunRoot(runId), HELD_DIRNAME);
	return {
		directory,
		patchPath: join(directory, PATCH_NAME),
		receiptPath: join(directory, RECEIPT_NAME),
	};
}

// Create `path` exclusively inside the directory `identity` names. No byte is
// written until the directory is still that one and the new file is the one
// the path now names, so a directory swapped for a symlink receives nothing.
function writeSynced(path, bytes, identity) {
	sameDirectory(dirname(path), identity);
	const fd = openSync(
		path,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		sameDirectory(dirname(path), identity);
		const opened = fstatSync(fd);
		const named = lstatSync(path);
		if (opened.dev !== named.dev || opened.ino !== named.ino)
			throw unsafeDirectory();
		writeSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function syncDirectory(path) {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

const unsafeDirectory = () =>
	Object.assign(new Error("held directory is not owner-only"), {
		code: "held_directory_unsafe",
	});

function ownedDirectory(path) {
	const stats = lstatSync(path);
	if (
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		stats.uid !== process.getuid()
	)
		throw unsafeDirectory();
	return { dev: stats.dev, ino: stats.ino };
}

function sameDirectory(path, identity) {
	const current = ownedDirectory(path);
	if (current.dev !== identity.dev || current.ino !== identity.ino)
		throw unsafeDirectory();
}

// The held directory is created once, by this run, inside its own run root
// (which, like run.json, lives under the configured store root). A
// pre-existing entry, such as a symlink planted into the project, is refused
// rather than followed, and its identity anchors every later write.
function createHeldDirectory(directory) {
	ownedDirectory(dirname(directory));
	mkdirSync(directory, { mode: 0o700 });
	return ownedDirectory(directory);
}

/**
 * Verify `input.diff` through the integration gate without mutating the
 * project, then persist the patch and its receipt. A gate refusal returns
 * `{ ok: false, gate }`; a write failure throws.
 */
export function holdVerifiedIntegration(
	input,
	{ now = Date.now, beforeWrite = () => {} } = {},
) {
	const gate = integrationGate(input.diff, input.projectPath, {
		allowedPaths: input.scopeFiles,
		allowSensitiveManifests: input.allowManifests.length > 0,
		allowExecutables: input.allowExecutables,
		checkOnly: true,
	});
	if (!gate?.success) return { ok: false, gate };
	const { directory, patchPath, receiptPath } = heldPaths(input.runId);
	const patch = Buffer.from(input.diff, "utf8");
	const heldAt = new Date(now()).toISOString();
	const receipt = {
		schemaVersion: 1,
		kind: RECEIPT_KIND,
		runId: input.runId,
		taskId: input.taskId,
		attemptId: input.attemptId,
		projectPath: input.projectPath,
		baseRevision: input.baseRevision,
		verifiedHead: input.verifiedHead,
		files: [...input.files],
		scopeFiles: [...input.scopeFiles],
		readOnlyInputs: [...input.readOnlyInputs],
		allowManifests: [...input.allowManifests],
		allowExecutables: [...input.allowExecutables],
		checks: [...input.checks],
		changedFiles: [...input.changedFiles],
		undeclaredPaths: [...input.undeclaredPaths],
		declaredFingerprint: input.declaredFingerprint,
		expectedOutputs: input.expectedOutputs,
		patchSha256: sha256(patch),
		patchBytes: patch.length,
		heldAt,
	};
	const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
	const identity = createHeldDirectory(directory);
	beforeWrite(directory);
	writeSynced(patchPath, patch, identity);
	writeSynced(receiptPath, receiptBytes, identity);
	sameDirectory(directory, identity);
	syncDirectory(directory);
	return {
		ok: true,
		summary: {
			mode: "hold",
			state: "held",
			receiptPath,
			receiptSha256: sha256(receiptBytes),
			patchPath,
			patchSha256: receipt.patchSha256,
			verifiedHead: input.verifiedHead,
			heldAt,
		},
	};
}

function invalid(detail) {
	return Object.assign(new Error("held_receipt_invalid"), {
		code: "held_receipt_invalid",
		detail,
	});
}

// Owner-only, single-link regular file read through the descriptor that was
// checked, so a swapped path or symlink is never read.
function readOwnedFile(path, maxBytes) {
	let fd;
	try {
		const before = lstatSync(path);
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			(before.mode & 0o077) !== 0 ||
			before.uid !== process.getuid() ||
			before.size > maxBytes
		)
			throw invalid("file_not_owner_only");
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = fstatSync(fd);
		if (opened.dev !== before.dev || opened.ino !== before.ino)
			throw invalid("file_identity_changed");
		return readFileSync(fd);
	} catch (error) {
		if (error?.code === "held_receipt_invalid") throw error;
		throw invalid("file_unreadable");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * The record's held integration summary, or null when it is not a hold.
 * `applying` is the claim an apply writes before it mutates the project; one
 * left behind means that apply ended without recording its outcome.
 */
export function heldIntegrationOf(record) {
	const integration = record?.terminalSummary?.integration;
	if (
		record?.state !== "succeeded" ||
		record.terminalSummary.status !== "held" ||
		integration?.mode !== "hold" ||
		!["held", "applying", "applied"].includes(integration.state)
	)
		return null;
	return integration;
}

/**
 * Load and verify the held patch a run record names. Throws an error coded
 * `held_receipt_invalid` unless both files sit at the run's own fixed paths,
 * match the digests in the record, and describe this run (`runId`, the one
 * the caller asked for) and project.
 */
export function readHeldIntegration(record, projectPath, runId) {
	const integration = heldIntegrationOf(record);
	if (!integration) throw invalid("not_a_held_run");
	if (record.runId !== runId) throw invalid("run_id_mismatch");
	const expected = heldPaths(record.runId);
	if (
		integration.receiptPath !== expected.receiptPath ||
		integration.patchPath !== expected.patchPath
	)
		throw invalid("unexpected_location");
	const receiptBytes = readOwnedFile(expected.receiptPath, MAX_RECEIPT_BYTES);
	if (sha256(receiptBytes) !== integration.receiptSha256)
		throw invalid("receipt_digest_mismatch");
	let receipt;
	try {
		receipt = JSON.parse(receiptBytes.toString("utf8"));
	} catch {
		throw invalid("receipt_unparseable");
	}
	if (
		receipt?.schemaVersion !== 1 ||
		receipt.kind !== RECEIPT_KIND ||
		receipt.runId !== record.runId ||
		receipt.projectPath !== projectPath ||
		receipt.patchSha256 !== integration.patchSha256 ||
		receipt.verifiedHead !== integration.verifiedHead
	)
		throw invalid("receipt_identity_mismatch");
	const patch = readOwnedFile(expected.patchPath, MAX_CAPTURE_BYTES);
	if (
		patch.length !== receipt.patchBytes ||
		sha256(patch) !== receipt.patchSha256
	)
		throw invalid("patch_digest_mismatch");
	return { integration, receipt, patch: patch.toString("utf8") };
}

/** Held integrations named by a routing run's attempts, for inspect. */
export async function inspectHeldIntegrations(state, readRun) {
	const held = [];
	for (const attempt of state?.attempts ?? []) {
		if (attempt.terminal !== "succeeded") continue;
		let record;
		try {
			record = await readRun(attempt.runId);
		} catch {
			continue;
		}
		const integration = heldIntegrationOf(record);
		if (!integration || record.runId !== attempt.runId) continue;
		held.push({
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			runId: attempt.runId,
			state: integration.state,
			heldAt: integration.heldAt,
			verifiedHead: integration.verifiedHead,
			receiptPath: integration.receiptPath,
			patchPath: integration.patchPath,
			...(integration.state === "applied"
				? {
						appliedAt: integration.appliedAt,
						appliedHead: integration.appliedHead,
						applyRunId: integration.applyRunId,
					}
				: {}),
			...(integration.state === "applying"
				? {
						applyingAt: integration.applyingAt,
						applyRunId: integration.applyRunId,
					}
				: {}),
			...(integration.lastApplyRefusal
				? { lastApplyRefusal: integration.lastApplyRefusal }
				: {}),
		});
	}
	return held;
}
