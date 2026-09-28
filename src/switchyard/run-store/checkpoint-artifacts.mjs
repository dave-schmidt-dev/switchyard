import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
	CHECKPOINT_ARTIFACT_MAX_FILE_BYTES,
	MAX_DIAGNOSTIC_ARTIFACT_BYTES,
	quarantineRoot,
} from "./constants.mjs";
import { ownerOnlyRegularFileStat } from "./receipt-validation.mjs";
import { ensureDir, getRunRoot } from "./run-records.mjs";

async function quarantineDirectory(name) {
	await ensureDir(quarantineRoot(), 0o700);
	const baseDestination = resolve(quarantineRoot(), name);
	let destination = baseDestination;
	try {
		await mkdir(baseDestination);
	} catch (e) {
		if (e.code !== "EEXIST") throw e;
		destination = resolve(
			quarantineRoot(),
			`${name}-collision-${randomUUID()}`,
		);
		await mkdir(destination);
	}
	try {
		await rename(getRunRoot(name), destination);
		return destination;
	} catch (e) {
		// Only remove the empty placeholder reserved above. rmdir removes a
		// directory only when it is empty, so a pre-existing or non-empty
		// quarantine artifact can never be deleted — unlike
		// rm({recursive:false}), which throws EISDIR on a directory and would
		// leave the placeholder behind.
		await rmdir(destination).catch(() => {});
		throw e;
	}
}
function hasDiagnosticRecord(runId) {
	if (existsSync(resolve(getRunRoot(runId), "events.jsonl"))) {
		return true;
	}
	try {
		const stat = lstatSync(resolve(getRunRoot(runId), "boot-stderr.log"));
		return (
			ownerOnlyRegularFileStat(stat, MAX_DIAGNOSTIC_ARTIFACT_BYTES) &&
			stat.size > 0
		);
	} catch {
		return false;
	}
}
function checkpointPathForRun(run) {
	const explicit = run?.runOptions?.checkpointPath;
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	if (typeof run?.tasksFilePath === "string" && run.tasksFilePath.length > 0) {
		return `${run.tasksFilePath}.checkpoint.json`;
	}
	return null;
}
function hasLiveCheckpoint(run) {
	const path = checkpointPathForRun(run);
	if (path === null) return false;
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}
function checkpointArtifactTaskIds(checkpoint) {
	const ids = new Set();
	for (const taskId of checkpoint?.completedTaskIds ?? []) {
		if (typeof taskId === "string" && taskId.length > 0) ids.add(taskId);
	}
	for (const taskId of Object.keys(checkpoint?.taskAttempts ?? {}))
		ids.add(taskId);
	for (const taskId of Object.keys(checkpoint?.integrationIntents ?? {}))
		ids.add(taskId);
	for (const result of checkpoint?.results ?? []) {
		if (typeof result?.taskId === "string" && result.taskId.length > 0)
			ids.add(result.taskId);
	}
	return [...ids].sort((left, right) => right.length - left.length);
}
function checkpointArtifactResultAttempts(checkpoint, taskId) {
	const counts = new Map();
	let invalidCount = 0;
	for (const result of checkpoint?.results ?? []) {
		if (result?.taskId !== taskId) continue;
		if (!Number.isSafeInteger(result.attempt) || result.attempt < 1) {
			invalidCount += 1;
			continue;
		}
		counts.set(result.attempt, (counts.get(result.attempt) ?? 0) + 1);
	}
	return { counts, invalidCount };
}
function checkpointArtifactIdentity(name, checkpoint) {
	if (
		typeof name !== "string" ||
		(!name.endsWith(".diff") && !name.endsWith(".output"))
	) {
		return { disposition: "unknown", reason: "unknown_entry" };
	}
	const purpose = name.endsWith(".diff") ? "partial_diff" : "gate_evidence";
	const suffix = name.slice(0, -(purpose === "partial_diff" ? 5 : 7));
	const taskId = checkpointArtifactTaskIds(checkpoint).find(
		(candidate) =>
			suffix === candidate || suffix.startsWith(`${candidate}.attempt-`),
	);
	if (!taskId) return { disposition: "malformed", reason: "unknown_task" };
	const remainder = suffix.slice(taskId.length);
	let attempt = null;
	const resultEvidence = checkpointArtifactResultAttempts(checkpoint, taskId);
	const resultAttempts = resultEvidence.counts;
	const declared = checkpoint.taskAttempts?.[taskId];
	const declaredIsValid = Number.isSafeInteger(declared) && declared > 0;
	if (remainder === "") {
		// The original `<taskId>.<ext>` form has no attempt in its name.  It is
		// safe only when the checkpoint proves one unambiguous attempt.
		const uniqueResultAttempts = [...resultAttempts].filter(
			(attempt) => resultAttempts.get(attempt) === 1,
		);
		const resultEvidenceIsExact =
			resultEvidence.invalidCount === 0 &&
			resultAttempts.size === 1 &&
			uniqueResultAttempts.length === 1 &&
			declaredIsValid &&
			uniqueResultAttempts[0] === declared;
		if (!resultEvidenceIsExact && resultAttempts.size !== 0)
			return {
				disposition: "ambiguous",
				reason: "attempt_identity_ambiguous",
			};
		if (!resultEvidenceIsExact && !declaredIsValid)
			return {
				disposition: "ambiguous",
				reason: "attempt_identity_ambiguous",
			};
		attempt = resultEvidenceIsExact ? uniqueResultAttempts[0] : declared;
	} else {
		const match = /^\.attempt-(\d+)$/u.exec(remainder);
		if (!match || Number(match[1]) < 1)
			return { disposition: "malformed", reason: "malformed_name" };
		attempt = Number(match[1]);
	}
	if (!Number.isSafeInteger(attempt) || attempt < 1)
		return { disposition: "malformed", reason: "malformed_attempt" };
	if (
		resultEvidence.invalidCount !== 0 ||
		!declaredIsValid ||
		resultAttempts.get(attempt) !== 1 ||
		attempt > declared
	)
		return { disposition: "unknown", reason: "attempt_not_in_checkpoint" };
	return { disposition: "classified", taskId, attempt, purpose };
}
function checkpointArtifactPurpose(checkpoint, identity, terminal) {
	const taskId = identity.taskId;
	const completed = new Set(checkpoint.completedTaskIds ?? []);
	const pending = checkpoint.integrationIntents?.[taskId];
	const latest = [...(checkpoint.results ?? [])]
		.reverse()
		.find((result) => result?.taskId === taskId);
	if (
		!terminal ||
		!completed.has(taskId) ||
		pending?.status === "pending" ||
		(latest && latest.success !== true)
	)
		return {
			active: true,
			reason:
				pending?.status === "pending"
					? "active_reconciliation"
					: "current_review",
		};
	return { active: false, reason: "purpose_complete" };
}
function sameFilesystemIdentity(left, right) {
	return (
		left?.dev === right?.dev &&
		left?.ino === right?.ino &&
		left?.mode === right?.mode &&
		left?.uid === right?.uid
	);
}
function sameCheckpointArtifactIdentity(stat, identity, includeCtime = true) {
	return (
		ownerOnlyRegularFileStat(stat, CHECKPOINT_ARTIFACT_MAX_FILE_BYTES) &&
		stat.nlink === 1 &&
		stat.dev === identity.dev &&
		stat.ino === identity.ino &&
		stat.mode === identity.mode &&
		stat.uid === identity.uid &&
		stat.size === identity.size &&
		stat.mtimeMs === identity.mtimeMs &&
		(!includeCtime || stat.ctimeMs === identity.ctimeMs)
	);
}
function checkpointShapeIsUsable(checkpoint) {
	return (
		checkpoint &&
		typeof checkpoint === "object" &&
		!Array.isArray(checkpoint) &&
		Array.isArray(checkpoint.completedTaskIds) &&
		Array.isArray(checkpoint.results) &&
		checkpoint.taskAttempts &&
		typeof checkpoint.taskAttempts === "object" &&
		!Array.isArray(checkpoint.taskAttempts) &&
		checkpoint.integrationIntents &&
		typeof checkpoint.integrationIntents === "object" &&
		!Array.isArray(checkpoint.integrationIntents)
	);
}
async function readCheckpointArtifactSnapshot(checkpointPath) {
	const stat = await lstat(checkpointPath);
	if (!ownerOnlyRegularFileStat(stat, 64 * 1024 * 1024)) return null;
	const raw = await readFile(checkpointPath, "utf8");
	let checkpoint;
	try {
		checkpoint = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!checkpointShapeIsUsable(checkpoint)) return null;
	return {
		raw,
		checkpoint,
		identity: {
			dev: stat.dev,
			ino: stat.ino,
			mode: stat.mode,
			uid: stat.uid,
		},
	};
}

export {
	checkpointArtifactIdentity,
	checkpointArtifactPurpose,
	checkpointArtifactResultAttempts,
	checkpointArtifactTaskIds,
	checkpointPathForRun,
	checkpointShapeIsUsable,
	hasDiagnosticRecord,
	hasLiveCheckpoint,
	quarantineDirectory,
	readCheckpointArtifactSnapshot,
	sameCheckpointArtifactIdentity,
	sameFilesystemIdentity,
};
