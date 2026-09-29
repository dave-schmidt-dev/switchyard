import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createFencingIdentity } from "../run-store/index.mjs";
import { CHECKPOINT_VERSION, checkpointOwners } from "./constants.mjs";
export function getCheckpointPath(tasksFilePath) {
	return `${tasksFilePath}.checkpoint.json`;
}
export function createEmptyCheckpoint(tasksFilePath, identity = {}) {
	const checkpoint = {
		version: CHECKPOINT_VERSION,
		revision: 0,
		owner:
			identity.checkpointOwner ??
			createFencingIdentity(identity.queueIdentity ?? "direct"),
		ownershipReleased: false,
		tasksFilePath,
		completedTaskIds: [],
		lastTaskId: null,
		lastUpdatedAt: null,
		results: [],
		taskBases: {},
		taskAttempts: {},
		integrationIntents: {},
		// Additive reducer evidence; legacy checkpoint readers ignore this field.
		outcomeShadow: null,
		// Reader-owned projection captured at checkpoint/resume boundaries.
		outcomeProjection: null,
	};
	if (identity.queueIdentity) {
		checkpoint.queueIdentity = identity.queueIdentity;
		checkpoint.runOptions = identity.runOptions ?? null;
	}
	return checkpoint;
}
function checkpointOwnerFor(checkpointPath, runId, suppliedOwner) {
	if (suppliedOwner) return suppliedOwner;
	const effectiveRunId = runId ?? "direct";
	let cached = checkpointOwners.get(checkpointPath);
	if (!cached || cached.runId !== effectiveRunId) {
		cached = {
			runId: effectiveRunId,
			owner: createFencingIdentity(effectiveRunId),
		};
		checkpointOwners.set(checkpointPath, cached);
	}
	return cached.owner;
}
export function saveCheckpoint(checkpointPath, checkpoint, options = {}) {
	if (checkpoint?.version !== CHECKPOINT_VERSION)
		throw new Error("legacy checkpoint requires explicit v3 migration");
	if (!Number.isInteger(checkpoint.revision) || checkpoint.revision < 0) {
		throw new Error("checkpoint revision is invalid");
	}
	if (!isCheckpointOwner(checkpoint.owner)) {
		throw new Error("checkpoint owner is invalid");
	}
	mkdirSync(dirname(checkpointPath), { recursive: true });
	const lease =
		options.lease ?? acquireCheckpointLease(checkpointPath, checkpoint.owner);
	const ownsLease = options.lease === undefined;
	try {
		assertCheckpointLease(lease, checkpointPath, checkpoint.owner);
		let disk = null;
		let diskRaw = null;
		if (existsSync(checkpointPath)) {
			try {
				diskRaw = readFileSync(checkpointPath, "utf8");
				disk = JSON.parse(diskRaw);
			} catch {
				throw new Error("checkpoint disk record is corrupt");
			}
			if (disk?.version !== CHECKPOINT_VERSION)
				throw new Error("legacy checkpoint requires explicit v3 migration");
			if (!sameCheckpointOwner(disk.owner, checkpoint.owner))
				throw new Error("checkpoint owner displaced");
			if (disk.ownershipReleased)
				throw new Error("checkpoint ownership was released");
		}
		const expectedRevision = options.expectedRevision ?? checkpoint.revision;
		const diskRevision = disk?.revision ?? 0;
		if (
			diskRevision !== expectedRevision ||
			checkpoint.revision !== expectedRevision
		)
			throw new Error(
				`checkpoint revision mismatch: expected ${expectedRevision}, disk ${diskRevision}`,
			);
		const published = structuredClone(checkpoint);
		published.revision = diskRevision + 1;
		const tmpPath = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(published, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		try {
			options.beforePublish?.({ lease, tmpPath });
			assertCheckpointLease(lease, checkpointPath, checkpoint.owner);
			const currentRaw = existsSync(checkpointPath)
				? readFileSync(checkpointPath, "utf8")
				: null;
			if (currentRaw !== diskRaw)
				throw new Error("checkpoint revision changed before publication");
			renameSync(tmpPath, checkpointPath);
		} catch (error) {
			try {
				unlinkSync(tmpPath);
			} catch {}
			throw error;
		}
		checkpoint.revision = published.revision;
	} finally {
		if (ownsLease) releaseCheckpointLease(lease);
	}
}
function checkpointLockPath(checkpointPath) {
	return `${checkpointPath}.lock`;
}
function sameCheckpointOwner(left, right) {
	return (
		left?.runId === right?.runId &&
		left?.processStartIdentity === right?.processStartIdentity &&
		left?.nonce === right?.nonce
	);
}
export function acquireCheckpointLease(checkpointPath, owner) {
	if (!isCheckpointOwner(owner)) throw new Error("checkpoint owner is invalid");
	mkdirSync(dirname(checkpointPath), { recursive: true });
	const lockPath = checkpointLockPath(checkpointPath);
	const nonce = randomUUID();
	const body = JSON.stringify({ owner, nonce });
	let fd;
	try {
		fd = openSync(lockPath, "wx", 0o600);
		writeFileSync(fd, body, "utf8");
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		throw new Error(
			`checkpoint lease unavailable: ${error.code ?? error.message}`,
		);
	}
	closeSync(fd);
	return {
		checkpointPath,
		lockPath,
		owner: structuredClone(owner),
		nonce,
		body,
	};
}
function assertCheckpointLease(lease, checkpointPath, owner) {
	if (
		lease?.checkpointPath !== checkpointPath ||
		!sameCheckpointOwner(lease.owner, owner) ||
		readFileSync(lease.lockPath, "utf8") !== lease.body
	)
		throw new Error("checkpoint lease displaced");
}
export function releaseCheckpointLease(lease) {
	assertCheckpointLease(lease, lease.checkpointPath, lease.owner);
	unlinkSync(lease.lockPath);
}
function isCheckpointOwner(owner) {
	return (
		owner &&
		typeof owner === "object" &&
		typeof owner.runId === "string" &&
		owner.runId.length > 0 &&
		typeof owner.processStartIdentity === "string" &&
		owner.processStartIdentity.length > 0 &&
		typeof owner.nonce === "string" &&
		owner.nonce.length > 0
	);
}
function validateCheckpointTaskBases(parsed) {
	if (
		!parsed.taskBases ||
		typeof parsed.taskBases !== "object" ||
		Array.isArray(parsed.taskBases)
	)
		throw new Error("checkpoint has invalid taskBases");
	for (const [taskId, base] of Object.entries(parsed.taskBases)) {
		const helper = base?.cleanupContext;
		if (
			typeof base?.ref !== "string" ||
			!base.ref ||
			typeof base?.tree !== "string" ||
			!/^[a-f0-9]{40,64}$/.test(base.tree) ||
			helper?.operation !== "helper" ||
			helper.taskId !== taskId ||
			![
				"runId",
				"taskId",
				"attemptId",
				"descriptorIdentity",
				"workspaceId",
			].every(
				(field) =>
					typeof helper[field] === "string" && helper[field].length > 0,
			) ||
			(helper.processStartIdentity !== null &&
				typeof helper.processStartIdentity !== "string") ||
			(base.dirtyOverlayReceiptHash != null &&
				!/^[a-f0-9]{64}$/u.test(base.dirtyOverlayReceiptHash))
		)
			throw new Error("checkpoint has invalid persisted task base");
	}
}
function checkpointCanRelease(checkpoint) {
	return (
		checkpoint.retryState == null &&
		Object.keys(checkpoint.taskBases ?? {}).length === 0 &&
		Object.values(checkpoint.integrationIntents ?? {}).every(
			(intent) => intent.status === "completed",
		)
	);
}
export function releaseCheckpointOwnership(checkpointPath, checkpoint) {
	if (!checkpointCanRelease(checkpoint)) {
		saveCheckpoint(checkpointPath, checkpoint);
		return false;
	}
	checkpoint.ownershipReleased = true;
	try {
		saveCheckpoint(checkpointPath, checkpoint);
		return true;
	} catch (error) {
		checkpoint.ownershipReleased = false;
		throw error;
	}
}
export {
	assertCheckpointLease,
	checkpointCanRelease,
	checkpointOwnerFor,
	isCheckpointOwner,
	sameCheckpointOwner,
	validateCheckpointTaskBases,
};
