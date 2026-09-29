import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { recordExternalCompletionToStore } from "../ledger/index.mjs";
import { getStateRoot } from "../run-store/index.mjs";
import { assertCheckpointLease } from "./checkpoint-store.mjs";
import {
	normalizeRunOptions,
	RECONCILIATION_INTENT_VERSION,
	stableStringify,
} from "./constants.mjs";
import {
	hashBytes,
	refusal,
	sortedUnique,
	successorMatches,
	updateIntent,
	validAbsolutePath,
	validReconciliationPathList,
	validSourceOwner,
	writeSuccessor,
} from "./reconciliation-intent.mjs";

function intentMatchesInput(intent, input) {
	const immutable = intent.immutable;
	let inputOptions = null;
	let inputRunStorePath = null;
	try {
		if (Object.hasOwn(input, "nextRunOptions"))
			inputOptions = normalizeReconciliationRunOptions(input);
		if (Object.hasOwn(input, "runStorePath"))
			inputRunStorePath = reconciliationRunStorePath(input);
	} catch {
		return false;
	}
	if (
		!immutable ||
		typeof immutable.queueIdentity !== "string" ||
		typeof immutable.runStorePath !== "string" ||
		!immutable.runOptions ||
		!intent.successor?.checkpoint?.externalCompletion ||
		intent.ledger.fields.reconciliationId !== intent.reconciliationId ||
		typeof input.successorCheckpointPath !== "string" ||
		typeof input.tasksFilePath !== "string" ||
		typeof input.projectPath !== "string" ||
		typeof input.receiptPath !== "string"
	)
		return false;
	const expectedId = hashBytes(
		stableStringify({
			version: RECONCILIATION_INTENT_VERSION,
			taskId: intent.source.taskId,
			attempt: intent.source.attempt,
			sourceCheckpointPath: intent.source.checkpointPath,
			sourceRevision: intent.source.revision,
			sourceOwner: intent.source.owner,
			contractHash: immutable.contractHash,
			receiptPath: immutable.receiptPath,
			integratedCommit: immutable.integratedCommit,
			changedPaths: immutable.changedPaths,
			requiredPaths: immutable.requiredPaths,
			resolvedExternalBlockers: immutable.resolvedExternalBlockers,
			queueIdentity: immutable.queueIdentity,
			runOptions: immutable.runOptions,
			runStorePath: immutable.runStorePath,
		}),
	);
	const completion = intent.successor.checkpoint.externalCompletion;
	const identityMatches =
		expectedId === intent.reconciliationId &&
		completion.reconciliationId === intent.reconciliationId &&
		completion.sourceCheckpointPath === intent.source.checkpointPath &&
		completion.sourceRevision === intent.source.revision &&
		completion.attempt === intent.source.attempt &&
		stableStringify(completion.sourceOwner) ===
			stableStringify(intent.source.owner) &&
		completion.contractHash === immutable.contractHash &&
		completion.integratedCommit === immutable.integratedCommit &&
		stableStringify(completion.changedPaths) ===
			stableStringify(immutable.changedPaths) &&
		stableStringify(completion.requiredPaths) ===
			stableStringify(immutable.requiredPaths) &&
		stableStringify(completion.resolvedExternalBlockers ?? []) ===
			stableStringify(immutable.resolvedExternalBlockers) &&
		completion.providerSuccess === false &&
		intent.successor.checkpointPath ===
			resolve(input.successorCheckpointPath) &&
		intent.source.checkpointPath === resolve(input.sourceCheckpointPath) &&
		immutable.projectPath === resolve(input.projectPath) &&
		immutable.receiptPath === resolve(input.receiptPath) &&
		intent.source.tasksFilePath === resolve(input.tasksFilePath);
	if (!identityMatches) return false;
	if (
		Object.hasOwn(input, "runStorePath") &&
		inputRunStorePath !== immutable.runStorePath
	)
		return false;
	if (Object.hasOwn(input, "taskId") && intent.source.taskId !== input.taskId)
		return false;
	if (
		Object.hasOwn(input, "attempt") &&
		intent.source.attempt !== input.attempt
	)
		return false;
	if (
		Object.hasOwn(input, "sourceRevision") &&
		intent.source.revision !== input.sourceRevision
	)
		return false;
	if (
		Object.hasOwn(input, "sourceOwner") &&
		stableStringify(intent.source.owner) !== stableStringify(input.sourceOwner)
	)
		return false;
	if (
		Object.hasOwn(input, "contractHash") &&
		immutable.contractHash !== input.contractHash
	)
		return false;
	if (
		Object.hasOwn(input, "integratedCommit") &&
		immutable.integratedCommit !== input.integratedCommit
	)
		return false;
	if (
		Object.hasOwn(input, "changedPaths") &&
		stableStringify(immutable.changedPaths) !==
			stableStringify(sortedUnique(input.changedPaths))
	)
		return false;
	if (
		Object.hasOwn(input, "requiredPaths") &&
		stableStringify(immutable.requiredPaths) !==
			stableStringify(sortedUnique(input.requiredPaths))
	)
		return false;
	if (
		Object.hasOwn(input, "nextRunOptions") &&
		(inputOptions === null ||
			stableStringify(immutable.runOptions) !== stableStringify(inputOptions))
	)
		return false;
	if (
		Object.hasOwn(input, "resolvedExternalBlockers") &&
		stableStringify(immutable.resolvedExternalBlockers) !==
			stableStringify(sortedUnique(input.resolvedExternalBlockers ?? []))
	)
		return false;
	return (
		input.reconciliationId === undefined ||
		input.reconciliationId === intent.reconciliationId
	);
}
async function replayReconciliationIntent(
	intent,
	intentPath,
	input,
	sourceLease = null,
) {
	const expected = intent.successor.checkpoint;
	const successorPath = intent.successor.checkpointPath;
	assertReconciliationSourceLease(sourceLease);
	const existing = successorMatches(successorPath, expected);
	if (existing.error || (existing.exists && !existing.same))
		return refusal(existing.error ?? "successor_checkpoint_conflict");
	if (!existing.exists) {
		assertReconciliationSourceLease(sourceLease);
		writeSuccessor(successorPath, expected);
		// Persist the successor boundary before touching the ledger.  Recovery
		// can then distinguish a prepared intent from one whose first durable
		// side effect is already present, without trusting mutable worktree data.
		updateIntent(intentPath, intent, "successor_recorded");
	} else if (intent.state === "prepared") {
		// A crash between the successor rename and the state transition is a
		// recoverable window.  Reassert the state only after the exact successor
		// bytes have been verified above.
		updateIntent(intentPath, intent, "successor_recorded");
	}
	if (input.__testFault === "after_successor")
		throw new Error("injected reconciliation crash after successor");
	let ledger;
	try {
		assertReconciliationSourceLease(sourceLease);
		if (input.__testFault === "ledger_failure") {
			const error = new Error("injected reconciliation ledger failure");
			error.code = "EIO";
			throw error;
		}
		ledger = await recordExternalCompletionToStore(
			intent.ledger.fields,
			intent.ledger.runStorePath,
		);
	} catch (error) {
		if (error?.code === "RECONCILIATION_LEDGER_MISMATCH")
			return refusal("ledger_reconciliation_mismatch");
		return recoveryRequired(
			"completion_record_persistence_failed",
			error?.code ?? "unknown",
			intent,
		);
	}
	assertReconciliationSourceLease(sourceLease);
	updateIntent(intentPath, intent, "ledger_recorded");
	if (input.__testFault === "after_ledger")
		throw new Error("injected reconciliation crash after ledger");
	assertReconciliationSourceLease(sourceLease);
	updateIntent(intentPath, intent, "completed");
	if (
		input.__testFault === "before_finalization" ||
		input.__testFault === "during_finalization"
	)
		throw new Error("injected reconciliation crash before finalization");
	try {
		assertReconciliationSourceLease(sourceLease);
		unlinkSync(intentPath);
	} catch (error) {
		if (error?.code !== "ENOENT")
			return recoveryRequired(
				"reconciliation_finalization_failed",
				error?.code ?? "unknown",
				intent,
			);
	}
	return {
		recorded: true,
		status:
			existing.exists && ledger?.alreadyRecorded
				? "already-recorded"
				: "recorded",
		result: "external_completion_recorded",
		reconciliationId: intent.reconciliationId,
		successorCheckpointPath: successorPath,
		providerSuccess: false,
	};
}
function validateExternalCompletionInput(input) {
	if (!input || typeof input !== "object") return refusal("malformed_receipt");
	const required = [
		"sourceCheckpointPath",
		"successorCheckpointPath",
		"tasksFilePath",
		"projectPath",
		"receiptPath",
		"taskId",
		"attempt",
		"contractHash",
		"integratedCommit",
		"changedPaths",
		"requiredPaths",
		"nextRunOptions",
	];
	if (required.some((field) => input[field] === undefined))
		return refusal("malformed_receipt");
	for (const field of [
		"sourceCheckpointPath",
		"successorCheckpointPath",
		"tasksFilePath",
		"projectPath",
		"receiptPath",
		"taskId",
		"contractHash",
		"integratedCommit",
	]) {
		if (
			typeof input[field] !== "string" ||
			input[field].length === 0 ||
			input[field].length > 4096
		)
			return refusal("malformed_receipt");
	}
	if (input.taskId.length > 256) return refusal("malformed_receipt");
	if (input.providerSuccess !== undefined && input.providerSuccess !== false)
		return refusal("malformed_receipt");
	if (
		input.runStorePath !== undefined &&
		!validAbsolutePath(input.runStorePath)
	)
		return refusal("malformed_receipt");
	if (
		input.nextRunOptions !== null &&
		(typeof input.nextRunOptions !== "object" ||
			Array.isArray(input.nextRunOptions))
	)
		return refusal("invalid_next_run_options");
	if (
		input.resolvedExternalBlockers !== undefined &&
		(!Array.isArray(input.resolvedExternalBlockers) ||
			input.resolvedExternalBlockers.some(
				(blocker) => typeof blocker !== "string" || blocker.length === 0,
			))
	)
		return refusal("malformed_receipt");
	if (
		resolve(input.sourceCheckpointPath) ===
		resolve(input.successorCheckpointPath)
	)
		return refusal("successor_checkpoint_must_be_distinct");
	if (
		!validReconciliationPathList(input.changedPaths) ||
		!validReconciliationPathList(input.requiredPaths)
	)
		return refusal("malformed_receipt");
	if (
		!/^[a-f0-9]{40,64}$/i.test(input.integratedCommit) ||
		!/^[a-f0-9]{64}$/i.test(input.contractHash) ||
		!Number.isInteger(input.attempt) ||
		input.attempt < 1
	)
		return refusal("malformed_receipt");
	if (
		input.cleanup?.status !== "complete" ||
		(input.cleanup?.taskBaseReleased !== undefined &&
			input.cleanup.taskBaseReleased !== true) ||
		(input.cleanup?.projectLockReleased !== undefined &&
			input.cleanup.projectLockReleased !== true)
	)
		return refusal("cleanup_uncertain");
	if (
		!validSourceOwner(input.sourceOwner) ||
		!Number.isInteger(input.sourceRevision) ||
		input.sourceRevision < 0
	)
		return refusal("source_identity_missing");
	try {
		const options = normalizeReconciliationRunOptions(input);
		if (options.checkpointPath !== resolve(input.successorCheckpointPath))
			return refusal("next_checkpoint_option_mismatch");
	} catch {
		return refusal("invalid_next_run_options");
	}
	return null;
}
function normalizeReconciliationRunOptions(input) {
	return normalizeRunOptions({
		...(input.nextRunOptions ?? {}),
		checkpointPath:
			input.nextRunOptions?.checkpointPath ?? input.successorCheckpointPath,
	});
}
function reconciliationRunStorePath(_input) {
	return resolve(getStateRoot());
}
function intentUsesCurrentRunStore(intent) {
	const canonical = reconciliationRunStorePath();
	return (
		intent?.immutable?.runStorePath === canonical &&
		intent?.ledger?.runStorePath === canonical
	);
}
function recoveryRequired(code, detail, intent) {
	return {
		recorded: false,
		status: "recovery-required",
		result: "external_completion_recovery_required",
		reasonCode: code,
		...(detail ? { detail } : {}),
		...(intent?.reconciliationId
			? { reconciliationId: intent.reconciliationId }
			: {}),
		...(intent?.successor?.checkpointPath
			? { successorCheckpointPath: intent.successor.checkpointPath }
			: {}),
	};
}
function assertReconciliationSourceLease(sourceLease) {
	if (!sourceLease) return;
	assertCheckpointLease(
		sourceLease,
		sourceLease.checkpointPath,
		sourceLease.owner,
	);
}

export {
	assertReconciliationSourceLease,
	intentMatchesInput,
	intentUsesCurrentRunStore,
	normalizeReconciliationRunOptions,
	reconciliationRunStorePath,
	replayReconciliationIntent,
	validateExternalCompletionInput,
};
