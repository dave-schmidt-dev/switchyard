import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	projectRunFailureForDisk,
	upgradeRunFailureFromDisk,
} from "../adapter/exec-error-sanitize.mjs";
import { SUPPORTED_OUTCOME_READER_VERSION } from "../outcome/schema.mjs";
import {
	CURRENT_SCHEMA_VERSION,
	DIAGNOSTIC_ARTIFACT_KINDS,
	DIAGNOSTIC_DIGEST_RE,
	DIAGNOSTIC_REF_RE,
	HISTORICAL_SCHEMA_VERSION,
	MAX_DIAGNOSTIC_ARTIFACT_BYTES,
	MAX_DIAGNOSTIC_STREAM_BYTES,
	runsRoot,
} from "./constants.mjs";
import { SchemaError, validateRunId } from "./errors.mjs";
import {
	ownerOnlyDirectoryStat,
	ownerOnlyRegularFileStat,
} from "./receipt-validation.mjs";
import { validateRun, validateWorktreeRecord } from "./validate-run.mjs";
export function getRunRoot(runId) {
	return resolve(runsRoot(), runId);
}
async function writeRunAtomically(
	runJsonPath,
	data,
	io = { open, rename, unlink },
) {
	// Publish only synced bytes, then sync the directory entry before callers
	// may act on the record (in particular, before allocating a simple root).
	// Every run.json write goes through here, so this is where the in-memory
	// record takes its frozen-reader-compatible on-disk form. Project-lock
	// files share this writer; they carry no lastFailure and pass unchanged.
	const persisted = projectRunFailureForDisk(data);
	if (persisted !== data) validateRun(persisted);
	const tmpPath = `${runJsonPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const file = await io.open(tmpPath, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(persisted));
			await file.sync();
		} finally {
			await file.close();
		}
		await io.rename(tmpPath, runJsonPath);
		const directory = await io.open(dirname(runJsonPath), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (error) {
		await io.unlink(tmpPath).catch(() => {});
		throw error;
	}
}
async function ensureDir(dirPath, mode) {
	const firstCreated = await mkdir(dirPath, {
		recursive: true,
		mode,
		force: true,
	});
	if (firstCreated) {
		let path = resolve(dirPath);
		const boundary = dirname(resolve(firstCreated));
		while (true) {
			const directory = await open(path, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			if (path === boundary) break;
			path = dirname(path);
		}
	}
}
const CONTROL_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
function sanitizeForDisplay(text) {
	if (typeof text !== "string") return "";
	return text.replace(CONTROL_CHAR_RE, "?");
}
export async function initializeRun(options) {
	const {
		runId,
		tasksFilePath,
		projectPath,
		orderedTaskIds,
		initialHostFingerprint,
		workerPid = null,
		workerNonce = "",
		launchArgs = [],
		projectRevision = null,
		runOptions = undefined,
		queueIdentity = undefined,
	} = options;

	validateRunId(runId);
	if (
		workerPid !== undefined &&
		workerPid !== null &&
		(!Number.isSafeInteger(workerPid) || workerPid <= 0)
	) {
		throw new SchemaError("workerPid must be a positive integer or null");
	}

	const runDir = getRunRoot(runId);
	await ensureDir(runDir, 0o700);

	const runJsonPath = resolve(runDir, "run.json");
	try {
		await readFile(runJsonPath, "utf8");
		throw new Error(`Run already exists: ${runId}`);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}

	// No artifacts/ directory is provisioned here. The channel's only writer --
	// the partial-diff copy in dispatch/worker-bootstrap.mjs -- was removed
	// because INV-2 forbids persisting raw provider output nothing reads back,
	// so every run since has created an empty directory and left it there: 81 of
	// them, zero bytes, found during a 2026-09-04 cleanup of the consuming
	// project. Both readers (listArtifactRefs, collectArtifacts) already treat
	// absence as ordinary and return empty. Should a producer ever return, it
	// creates the directory itself.

	const now = new Date().toISOString();
	const versioned =
		queueIdentity !== undefined ||
		runOptions !== undefined ||
		projectRevision !== null;
	const snapshot = {
		schemaVersion: versioned
			? CURRENT_SCHEMA_VERSION
			: HISTORICAL_SCHEMA_VERSION,
		runId,
		state: "created",
		cleanupState: "not_started",
		createdAt: now,
		updatedAt: now,
		startedAt: null,
		finishedAt: null,
		revision: 1,
		tasksFilePath,
		projectPath,
		orderedTaskIds,
		initialHostFingerprint,
		workerPid: workerPid ?? null,
		workerStartToken: null,
		workerNonce,
		activeTaskId: null,
		activeTaskProvider: null,
		activeTaskModel: null,
		activeTaskDeadline: null,
		activeTaskElapsedMs: null,
		activeTaskHeartbeatAt: null,
		activeTaskProcessPhase: null,
		snapshotStatus: null,
		snapshotMtime: null,
		snapshotAgeMsAtRoute: null,
		resolvedTargetId: null,
		lastResolvedTargetId: null,
		activeTaskInvocationDescriptor: null,
		activeTaskDescriptorIdentity: null,
		activeTaskDescriptorHarness: null,
		lastTaskInvocationDescriptor: null,
		lastTaskDescriptorIdentity: null,
		lastTaskDescriptorHarness: null,
		dispatchContractVersion: 1,
		quarantinedTargetIds: [],
		retryState: null,
		retryTransitionId: 0,
		terminalSummary: null,
		cleanupError: null,
		lastLeaseHeartbeat: now,
		lastEventSequence: 0,
		minimumOutcomeReaderVersion: SUPPORTED_OUTCOME_READER_VERSION,
		outcomeWriterEpoch: null,
		outcomeRecovery: null,
		outcomeShadow: null,
		mutationOperations: [],
		lastFailure: null,
		lastReviewResult: null,
		worktree: options.worktree ?? null,
		launchArgs,
	};
	if (options.worktree !== undefined && options.worktree !== null) {
		validateWorktreeRecord(options.worktree);
	}
	if (versioned) {
		snapshot.projectRevision = projectRevision ?? "unknown";
		snapshot.runOptions = runOptions ?? null;
		snapshot.queueIdentity = queueIdentity;
	}

	await writeRunAtomically(runJsonPath, snapshot);
	return snapshot;
}
export async function persistDiagnosticArtifact(runId, evidence) {
	validateRunId(runId);
	if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
		return null;
	}
	const evidenceKeys = new Set([
		"stdoutBytes",
		"stderrBytes",
		"stdoutDigest",
		"stderrDigest",
		"diagnosticKind",
	]);
	if (Object.keys(evidence).some((key) => !evidenceKeys.has(key))) return null;
	const runRoot = getRunRoot(runId);
	const resources = resolve(runRoot, "resources");
	for (const existing of [runRoot, resources]) {
		try {
			const stat = await lstat(existing);
			if (!ownerOnlyDirectoryStat(stat)) return null;
		} catch (error) {
			if (error.code !== "ENOENT") return null;
		}
	}
	await ensureDir(runRoot, 0o700);
	await ensureDir(resources, 0o700);
	const runRootStat = await lstat(runRoot);
	if (!ownerOnlyDirectoryStat(runRootStat)) return null;
	const resourceStat = await lstat(resources);
	if (!ownerOnlyDirectoryStat(resourceStat)) return null;
	const stdoutBytes = evidence.stdoutBytes;
	const stderrBytes = evidence.stderrBytes;
	if (
		!Number.isSafeInteger(stdoutBytes) ||
		!Number.isSafeInteger(stderrBytes) ||
		stdoutBytes < 0 ||
		stderrBytes < 0 ||
		stdoutBytes > MAX_DIAGNOSTIC_STREAM_BYTES ||
		stderrBytes > MAX_DIAGNOSTIC_STREAM_BYTES ||
		!DIAGNOSTIC_DIGEST_RE.test(evidence.stdoutDigest ?? "") ||
		!DIAGNOSTIC_DIGEST_RE.test(evidence.stderrDigest ?? "") ||
		(evidence.diagnosticKind !== undefined &&
			!DIAGNOSTIC_ARTIFACT_KINDS.has(evidence.diagnosticKind))
	) {
		return null;
	}
	const bounded = {
		schemaVersion: 1,
		kind: "provider_diagnostic",
		...(DIAGNOSTIC_ARTIFACT_KINDS.has(evidence.diagnosticKind)
			? { diagnosticKind: evidence.diagnosticKind }
			: {}),
		stdoutBytes,
		stderrBytes,
		stdoutDigest: evidence.stdoutDigest,
		stderrDigest: evidence.stderrDigest,
	};
	const raw = JSON.stringify(bounded);
	if (Buffer.byteLength(raw) > MAX_DIAGNOSTIC_ARTIFACT_BYTES) return null;
	const token = randomUUID().replaceAll("-", "");
	const filename = `provider-diagnostic-${token}.json`;
	const destination = resolve(resources, filename);
	await writeFile(destination, `${raw}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	return `diagnostic:${token}`;
}
export async function resolveDiagnosticArtifact(runId, diagnosticRef) {
	if (!DIAGNOSTIC_REF_RE.test(diagnosticRef ?? "")) return null;
	validateRunId(runId);
	const token = diagnosticRef.slice("diagnostic:".length);
	const path = resolve(
		getRunRoot(runId),
		"resources",
		`provider-diagnostic-${token}.json`,
	);
	try {
		const runRootStat = await lstat(getRunRoot(runId));
		const resourcesStat = await lstat(resolve(getRunRoot(runId), "resources"));
		if (
			!ownerOnlyDirectoryStat(runRootStat) ||
			!ownerOnlyDirectoryStat(resourcesStat)
		)
			return null;
		const stat = await lstat(path);
		if (!ownerOnlyRegularFileStat(stat, MAX_DIAGNOSTIC_ARTIFACT_BYTES))
			return null;
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (parsed?.kind !== "provider_diagnostic" || parsed?.schemaVersion !== 1)
			return null;
		const allowed = new Set([
			"schemaVersion",
			"kind",
			"diagnosticKind",
			"stdoutBytes",
			"stderrBytes",
			"stdoutDigest",
			"stderrDigest",
		]);
		if (Object.keys(parsed).some((key) => !allowed.has(key))) return null;
		if (
			(parsed.diagnosticKind !== undefined &&
				!DIAGNOSTIC_ARTIFACT_KINDS.has(parsed.diagnosticKind)) ||
			!Number.isSafeInteger(parsed.stdoutBytes) ||
			!Number.isSafeInteger(parsed.stderrBytes) ||
			parsed.stdoutBytes < 0 ||
			parsed.stderrBytes < 0 ||
			parsed.stdoutBytes > MAX_DIAGNOSTIC_STREAM_BYTES ||
			parsed.stderrBytes > MAX_DIAGNOSTIC_STREAM_BYTES ||
			!DIAGNOSTIC_DIGEST_RE.test(parsed.stdoutDigest ?? "") ||
			!DIAGNOSTIC_DIGEST_RE.test(parsed.stderrDigest ?? "")
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
}
export async function readRun(runId) {
	validateRunId(runId);
	const runJsonPath = resolve(getRunRoot(runId), "run.json");
	let raw;
	try {
		raw = await readFile(runJsonPath, "utf8");
	} catch (e) {
		if (e.code === "ENOENT") {
			// Tag the not-found signal with ENOENT so callers can tell a
			// transient missing run.json apart from corruption (see
			// applyRetention's conservative skip in its quarantine loop).
			const notFound = new Error(`Run not found: ${runId}`);
			notFound.code = "ENOENT";
			throw notFound;
		}
		throw e;
	}

	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		// Never interpolate JSON.parse's own message or the raw file content —
		// both can echo fragments of whatever malformed bytes were on disk.
		throw new SchemaError("run.json contains invalid JSON");
	}

	if (data === null || typeof data !== "object") {
		throw new SchemaError("run.json is not a valid object");
	}

	// In memory only: legacy detail keys leave lastFailure and a frozen
	// stand-in cause code regains its precise value. The file is never rewritten.
	upgradeRunFailureFromDisk(data);
	validateRun(data);
	return data;
}
export { CONTROL_CHAR_RE, ensureDir, sanitizeForDisplay, writeRunAtomically };
