import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createFencingIdentity } from "../run-store/index.mjs";
import {
	CHECKPOINT_VERSION,
	EXTERNAL_COMPLETION_MAX_RECEIPT_BYTES,
	EXTERNAL_COMPLETION_VERSION,
	RECONCILIATION_INTENT_MAX_BYTES,
	RECONCILIATION_INTENT_STATES,
	RECONCILIATION_INTENT_VERSION,
	stableStringify,
} from "./constants.mjs";
import { normalizeRetryTargetId } from "./quick-checks.mjs";

const CHECKPOINT_ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;
function refusal(code, detail = null) {
	return {
		recorded: false,
		status: "refused",
		result: "external_completion_refused",
		reasonCode: code,
		...(detail ? { detail } : {}),
	};
}
function sortedUnique(values) {
	return [...new Set(Array.isArray(values) ? values : [])].sort();
}
function hashBytes(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
function readBoundedReceipt(receiptPath) {
	let fd;
	try {
		fd = openSync(
			receiptPath,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.isSymbolicLink())
			return { error: "receipt_not_regular" };
		if (stats.size > EXTERNAL_COMPLETION_MAX_RECEIPT_BYTES)
			return { error: "receipt_too_large" };
		const ownerUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		if (ownerUid !== null && stats.uid !== ownerUid)
			return { error: "receipt_owner_mismatch" };
		const mode = stats.mode & 0o7777;
		if (mode !== 0o600) return { error: "receipt_mode_mismatch" };
		const bytes = Buffer.alloc(stats.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
		let value;
		try {
			value = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
		} catch {
			return { error: "receipt_malformed" };
		}
		if (value?.ownerUid !== stats.uid || value?.mode !== mode)
			return { error: "receipt_stat_mismatch" };
		return { value };
	} catch (error) {
		return {
			error:
				error?.code === "ELOOP" ? "receipt_not_regular" : "receipt_missing",
		};
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function taskContractBytes(markdown, taskId) {
	const taskBlockRegex =
		/### Task ([0-9.]+):\s*(.+)\n([\s\S]*?)(?=\n### Task [0-9.]+:|\n## |\n---|$)/g;
	for (const match of markdown.matchAll(taskBlockRegex)) {
		if (match[1].trim() === taskId) return match[0];
	}
	return null;
}
function reconciliationIntentPath(sourceCheckpointPath) {
	return `${sourceCheckpointPath}.reconciliation-intent.json`;
}
function readIntent(path) {
	if (!existsSync(path)) return null;
	try {
		const stats = lstatSync(path);
		const ownerUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		if (
			!stats.isFile() ||
			stats.isSymbolicLink() ||
			stats.size > RECONCILIATION_INTENT_MAX_BYTES ||
			(ownerUid !== null && stats.uid !== ownerUid) ||
			(stats.mode & 0o7777) !== 0o600
		)
			return { error: "reconciliation_intent_untrusted" };
		const intent = JSON.parse(readFileSync(path, "utf8"));
		const source = intent?.source;
		const immutable = intent?.immutable;
		const successor = intent?.successor;
		const ledger = intent?.ledger;
		if (
			intent?.version !== RECONCILIATION_INTENT_VERSION ||
			!RECONCILIATION_INTENT_STATES.includes(intent.state) ||
			!/^[a-f0-9]{64}$/i.test(intent.reconciliationId ?? "") ||
			typeof source?.checkpointPath !== "string" ||
			typeof source?.owner !== "object" ||
			!validSourceOwner(source.owner) ||
			!Number.isInteger(source.revision) ||
			source.revision < 0 ||
			typeof source.taskId !== "string" ||
			source.taskId.length === 0 ||
			!Number.isInteger(source.attempt) ||
			source.attempt < 1 ||
			typeof source.tasksFilePath !== "string" ||
			!/^[a-f0-9]{64}$/i.test(source.rawSha256 ?? "") ||
			typeof immutable?.projectPath !== "string" ||
			typeof immutable?.receiptPath !== "string" ||
			!validAbsolutePath(immutable?.runStorePath) ||
			!/^[a-f0-9]{64}$/i.test(immutable.contractHash ?? "") ||
			!/^[a-f0-9]{40,64}$/i.test(immutable.integratedCommit ?? "") ||
			!/^[a-f0-9]{40,64}$/i.test(immutable.currentHead ?? "") ||
			!validReconciliationPathList(immutable.changedPaths) ||
			!validReconciliationPathList(immutable.requiredPaths) ||
			!/^[a-f0-9]{64}$/i.test(immutable.queueIdentity ?? "") ||
			!immutable.runOptions ||
			typeof successor?.checkpointPath !== "string" ||
			!successor?.checkpoint ||
			typeof ledger?.runStorePath !== "string" ||
			!validAbsolutePath(ledger.runStorePath) ||
			ledger.runStorePath !== immutable.runStorePath ||
			!ledger?.fields ||
			typeof ledger.fields === "string" ||
			Array.isArray(ledger.fields) ||
			ledger.fields.reconciliationId !== intent.reconciliationId
		)
			return { error: "reconciliation_intent_malformed" };
		return { value: intent };
	} catch {
		return { error: "reconciliation_intent_malformed" };
	}
}
function writeIntent(path, intent) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, JSON.stringify(intent, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}
function updateIntent(path, intent, state) {
	writeIntent(path, {
		...intent,
		state,
		updatedAt: new Date().toISOString(),
	});
}
function sourceTaskAllocation(source, taskId) {
	return (source.providerAttemptAllocations ?? []).filter(
		(entry) => entry?.taskId === taskId,
	);
}
function sourceTaskRetry(source, taskId) {
	if (source.retryState?.taskId === taskId) return true;
	const attempts = (source.retryAttempts ?? []).filter(
		(entry) => entry?.taskId === taskId,
	);
	if (attempts.length === 0) return false;
	// retryAttempts is durable history, not by itself a live allocation.  It
	// is safe to archive that history only when the matching transition stream
	// has an explicit terminal finalization; every other shape is unknown.
	const transitions = (source.retryTransitions ?? []).filter(
		(entry) => entry?.taskId === taskId,
	);
	return transitions.at(-1)?.type !== "finalized";
}
function buildSuccessorCheckpoint(source, input, queueIdentity, options, id) {
	const timestamp = new Date().toISOString();
	// Start from the source snapshot so unrelated task state and forward-
	// compatible fields remain byte-for-field represented in the successor.
	// Replace only the fencing/queue identity and the reconciled task's state.
	const checkpoint = {
		...structuredClone(source),
		version: CHECKPOINT_VERSION,
		revision: 0,
		owner: createFencingIdentity(`reconcile-${id.slice(0, 24)}`),
		ownershipReleased: true,
		tasksFilePath: input.tasksFilePath,
		queueIdentity,
		runOptions: options,
	};
	checkpoint.completedTaskIds = [...(source.completedTaskIds ?? [])];
	if (!checkpoint.completedTaskIds.includes(input.taskId))
		checkpoint.completedTaskIds.push(input.taskId);
	checkpoint.lastTaskId = input.taskId;
	checkpoint.lastUpdatedAt = timestamp;
	checkpoint.taskAttempts = { ...(source.taskAttempts ?? {}) };
	checkpoint.taskBases = { ...(source.taskBases ?? {}) };
	delete checkpoint.taskBases[input.taskId];
	checkpoint.results = [
		...(source.results ?? []),
		{
			taskId: input.taskId,
			result: "external_completion_recorded",
			success: true,
			providerSuccess: false,
			completionAuthority: "verified_external_integration",
			timestamp,
		},
	];
	checkpoint.integrationIntents = { ...(source.integrationIntents ?? {}) };
	delete checkpoint.integrationIntents[input.taskId];
	checkpoint.retryAttempts = (source.retryAttempts ?? []).filter(
		(entry) => entry?.taskId !== input.taskId,
	);
	checkpoint.retryTransitions = (source.retryTransitions ?? []).filter(
		(entry) => entry?.taskId !== input.taskId,
	);
	const reconciledTargetIds = new Set(
		[...(source.retryAttempts ?? []), ...(source.retryTransitions ?? [])]
			.filter((entry) => entry?.taskId === input.taskId)
			.map((entry) => normalizeRetryTargetId(entry.resolvedTargetId))
			.filter((targetId) => targetId !== null),
	);
	checkpoint.quarantinedTargetIds = [
		...(source.quarantinedTargetIds ?? []),
	].filter((targetId) => !reconciledTargetIds.has(targetId));
	checkpoint.providerAttemptAllocations = (
		source.providerAttemptAllocations ?? []
	).filter((entry) => entry?.taskId !== input.taskId);
	checkpoint.retryState =
		source.retryState?.taskId === input.taskId
			? null
			: (source.retryState ?? null);
	if (checkpoint.taskBaseReleaseUncertain?.taskId === input.taskId)
		delete checkpoint.taskBaseReleaseUncertain;
	if (checkpoint.providerCleanupUncertain?.taskId === input.taskId)
		delete checkpoint.providerCleanupUncertain;
	checkpoint.resolvedExternalBlockers = sortedUnique([
		...(source.resolvedExternalBlockers ?? []),
		...(input.resolvedExternalBlockers ?? []),
	]);
	checkpoint.externalCompletion = {
		version: EXTERNAL_COMPLETION_VERSION,
		reconciliationId: id,
		sourceCheckpointPath: resolve(input.sourceCheckpointPath),
		sourceRevision: input.sourceRevision,
		sourceOwner: structuredClone(input.sourceOwner),
		attempt: input.attempt,
		integratedCommit: input.integratedCommit,
		contractHash: input.contractHash,
		changedPaths: sortedUnique(input.changedPaths),
		requiredPaths: sortedUnique(input.requiredPaths),
		resolvedExternalBlockers: sortedUnique(
			input.resolvedExternalBlockers ?? [],
		),
		providerSuccess: false,
	};
	checkpoint.migration = {
		kind: "external_completion",
		fromCheckpoint: resolve(input.sourceCheckpointPath),
		fromRevision: input.sourceRevision,
		toQueueIdentity: queueIdentity,
	};
	return checkpoint;
}
function successorMatches(path, expected) {
	if (!existsSync(path)) return { exists: false };
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink())
			return { exists: true, error: "successor_checkpoint_not_regular" };
		const value = JSON.parse(readFileSync(path, "utf8"));
		const same = stableStringify(value) === stableStringify(expected);
		return { exists: true, same, value };
	} catch {
		return { exists: true, error: "successor_checkpoint_conflict" };
	}
}
function readSuccessorRecord(path) {
	if (!existsSync(path)) return { exists: false };
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink())
			return { exists: true, error: "successor_checkpoint_not_regular" };
		return { exists: true, value: JSON.parse(readFileSync(path, "utf8")) };
	} catch {
		return { exists: true, error: "successor_checkpoint_conflict" };
	}
}
function writeSuccessor(path, checkpoint) {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, JSON.stringify(checkpoint, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(temp, 0o600);
	try {
		// A hard-link publish is atomic and refuses to replace an existing
		// successor.  That closes the concurrent replay window without allowing
		// one reconciler to overwrite another's durable checkpoint.
		linkSync(temp, path);
		unlinkSync(temp);
		return true;
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		if (error?.code === "EEXIST") {
			const existing = successorMatches(path, checkpoint);
			if (existing.exists && existing.same) return false;
		}
		throw error;
	}
}
function validReconciliationPath(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		!value.includes("\0") &&
		!value.includes("\\") &&
		!value.startsWith("/") &&
		![...value].some(
			(character) =>
				character.codePointAt(0) <= 0x1f || character.codePointAt(0) === 0x7f,
		) &&
		!value.split("/").includes("..")
	);
}
function validReconciliationPathList(value) {
	return (
		Array.isArray(value) &&
		value.length <= 256 &&
		value.every(validReconciliationPath)
	);
}
function validSourceOwner(value) {
	const fields = ["runId", "processStartIdentity", "nonce"];
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((field) => fields.includes(field)) &&
		fields.every(
			(field) =>
				typeof value[field] === "string" &&
				value[field].length > 0 &&
				value[field].length <= 256 &&
				![...value[field]].some(
					(character) =>
						character.codePointAt(0) <= 0x1f ||
						character.codePointAt(0) === 0x7f,
				),
		)
	);
}
function validAbsolutePath(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		value.startsWith("/") &&
		![...value].some(
			(character) =>
				character.codePointAt(0) <= 0x1f || character.codePointAt(0) === 0x7f,
		)
	);
}

export {
	buildSuccessorCheckpoint,
	CHECKPOINT_ARTIFACT_MAX_FILE_BYTES,
	hashBytes,
	readBoundedReceipt,
	readIntent,
	readSuccessorRecord,
	reconciliationIntentPath,
	refusal,
	sortedUnique,
	sourceTaskAllocation,
	sourceTaskRetry,
	successorMatches,
	taskContractBytes,
	updateIntent,
	validAbsolutePath,
	validReconciliationPathList,
	validSourceOwner,
	writeIntent,
	writeSuccessor,
};
