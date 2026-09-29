import {
	closeSync,
	fchmodSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { saveCheckpoint } from "./checkpoint-store.mjs";
import { CHECKPOINT_ARTIFACT_MAX_FILE_BYTES } from "./reconciliation-intent.mjs";

function reserveTaskAttempt(checkpoint, checkpointPath, taskId) {
	checkpoint.taskAttempts ??= {};
	const prior = checkpoint.taskAttempts[taskId];
	const integrationAttempt =
		checkpoint.integrationIntents?.[taskId]?.operation?.attempt;
	// The integration gate durably reserves its attempt before it mutates the
	// host tree. A result recorded after that gate belongs to the same attempt;
	// incrementing here would make the checkpoint fail its own intent/attempt
	// identity validation on resume.
	if (
		Number.isSafeInteger(integrationAttempt) &&
		integrationAttempt > 0 &&
		prior === integrationAttempt
	) {
		return integrationAttempt;
	}
	const attempt = Number.isSafeInteger(prior) && prior > 0 ? prior + 1 : 1;
	checkpoint.taskAttempts[taskId] = attempt;
	checkpoint.lastUpdatedAt = new Date().toISOString();
	saveCheckpoint(checkpointPath, checkpoint);
	return attempt;
}
function taskArtifactFilename(taskId, attempt, extension) {
	// Every new artifact carries an explicit attempt. Retention still reads the
	// historical first-attempt form conservatively, but new evidence must never
	// become ambiguous after a retry.
	return `${taskId}.attempt-${attempt}.${extension}`;
}
function prepareArtifactDirectory(dir) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let fd;
	try {
		fd = openSync(
			dir,
			fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
		);
		const ownerUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		let stats = fstatSync(fd);
		if (!stats.isDirectory() || (ownerUid !== null && stats.uid !== ownerUid))
			throw new Error("partial-diffs directory is not owner-owned");
		if ((stats.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
		stats = fstatSync(fd);
		if (
			!stats.isDirectory() ||
			(ownerUid !== null && stats.uid !== ownerUid) ||
			(stats.mode & 0o7777) !== 0o700
		)
			throw new Error("partial-diffs directory is not safely private");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function writeArtifactFile(artifactPath, text) {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length > CHECKPOINT_ARTIFACT_MAX_FILE_BYTES)
		throw new Error("partial-diffs artifact is too large");
	let fd;
	try {
		fd = openSync(
			artifactPath,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW,
			0o600,
		);
		const ownerUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		let stats = fstatSync(fd);
		if (
			!stats.isFile() ||
			stats.nlink !== 1 ||
			(ownerUid !== null && stats.uid !== ownerUid)
		)
			throw new Error("partial-diffs artifact is not private regular data");
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset);
			if (written <= 0) throw new Error("partial-diffs artifact write stalled");
			offset += written;
		}
		fchmodSync(fd, 0o600);
		fsyncSync(fd);
		stats = fstatSync(fd);
		if (
			!stats.isFile() ||
			stats.nlink !== 1 ||
			(ownerUid !== null && stats.uid !== ownerUid) ||
			stats.size !== bytes.length ||
			(stats.mode & 0o7777) !== 0o600
		)
			throw new Error("partial-diffs artifact verification failed");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function savePartialDiff(checkpointPath, taskId, diffText, attempt = 1) {
	const dir = `${checkpointPath}.partial-diffs`;
	prepareArtifactDirectory(dir);
	const artifactPath = join(dir, taskArtifactFilename(taskId, attempt, "diff"));
	writeArtifactFile(artifactPath, diffText);
	return artifactPath;
}
function boundedGateEvidence(_output) {
	return null;
}
function saveGateEvidence(checkpointPath, taskId, text, attempt = 1) {
	const dir = `${checkpointPath}.partial-diffs`;
	prepareArtifactDirectory(dir);
	const artifactPath = join(
		dir,
		taskArtifactFilename(taskId, attempt, "output"),
	);
	writeArtifactFile(artifactPath, text);
	return artifactPath;
}
export function persistAsyncResultArtifacts({
	result,
	checkpointPath,
	resultAttempt,
	onStatus,
	savePartialDiffFn = savePartialDiff,
	saveGateEvidenceFn = saveGateEvidence,
}) {
	const markPersistenceFailure = (event, status) => {
		result.success = false;
		result.result = "diff_capture_failed";
		result.errorKind = "diff_capture_failed";
		result.diagnosticCode = "diff_capture_failed";
		onStatus?.({
			phase: "artifact",
			event,
			status,
			taskId: result.taskId,
		});
	};

	if (result.partialDiff) {
		const byteCount = Buffer.byteLength(result.partialDiff);
		try {
			result.partialDiffPath = savePartialDiffFn(
				checkpointPath,
				result.taskId,
				result.partialDiff,
				resultAttempt,
			);
			onStatus?.({
				phase: "artifact",
				event: "partial_diff_captured",
				status: `Task ${result.taskId} partial diff saved for review`,
				taskId: result.taskId,
				byteCount,
			});
		} catch {
			result.partialDiffPath = null;
			markPersistenceFailure(
				"partial_diff_persistence_failed",
				`Task ${result.taskId} partial diff could not be saved`,
			);
		}
		result.partialDiff = undefined;
	}

	if (result.gateEvidence) {
		try {
			result.gateEvidencePath = saveGateEvidenceFn(
				checkpointPath,
				result.taskId,
				result.gateEvidence,
				resultAttempt,
			);
		} catch {
			result.gateEvidencePath = null;
			markPersistenceFailure(
				"gate_evidence_persistence_failed",
				`Task ${result.taskId} gate evidence could not be saved`,
			);
		}
		result.gateEvidence = undefined;
	}
	return result;
}
export {
	boundedGateEvidence,
	reserveTaskAttempt,
	saveGateEvidence,
	savePartialDiff,
};
