import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	validateExactPathSet,
	validateIntegratedCommitAncestry,
	validateIntegratedCommitPaths,
	validateNoTrackedPathOverlap,
} from "../integrate/index.mjs";
import { readLedgerFromStore } from "../ledger/index.mjs";
import { isProjectLockOwnedBy } from "../run-store/index.mjs";
import { validateCheckpointV3 } from "./checkpoint-load.mjs";
import {
	acquireCheckpointLease,
	releaseCheckpointLease,
	validateCheckpointTaskBases,
} from "./checkpoint-store.mjs";
import {
	createQueueIdentity,
	EXTERNAL_COMPLETION_VERSION,
	RECONCILIATION_INTENT_VERSION,
	stableStringify,
} from "./constants.mjs";
import { validateRetryDescriptorEvidence } from "./quick-checks.mjs";
import {
	buildSuccessorCheckpoint,
	hashBytes,
	readBoundedReceipt,
	readIntent,
	readSuccessorRecord,
	reconciliationIntentPath,
	refusal,
	sortedUnique,
	sourceTaskAllocation,
	sourceTaskRetry,
	taskContractBytes,
	validAbsolutePath,
	writeIntent,
} from "./reconciliation-intent.mjs";
import {
	assertReconciliationSourceLease,
	intentMatchesInput,
	intentUsesCurrentRunStore,
	normalizeReconciliationRunOptions,
	reconciliationRunStorePath,
	replayReconciliationIntent,
	validateExternalCompletionInput,
} from "./reconciliation-validate.mjs";
import { parseTaskQueue } from "./task-queue.mjs";
export async function reconcileExternalCompletion(input) {
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.sourceCheckpointPath !== "string" ||
		input.sourceCheckpointPath.length === 0
	)
		return refusal("malformed_receipt");
	const intentPath = reconciliationIntentPath(input.sourceCheckpointPath);
	const existingIntent = readIntent(intentPath);
	if (existingIntent?.error) return refusal(existingIntent.error);
	if (existingIntent?.value) {
		if (!intentUsesCurrentRunStore(existingIntent.value))
			return refusal("reconciliation_intent_mismatch");
		let sourceLease;
		try {
			if (!intentMatchesInput(existingIntent.value, input))
				return refusal("reconciliation_intent_mismatch");
			sourceLease = acquireCheckpointLease(
				existingIntent.value.source.checkpointPath,
				existingIntent.value.source.owner,
			);
			const sourceStats = lstatSync(existingIntent.value.source.checkpointPath);
			if (!sourceStats.isFile() || sourceStats.isSymbolicLink())
				return refusal("source_checkpoint_not_regular");
			const sourceRaw = readFileSync(
				existingIntent.value.source.checkpointPath,
				"utf8",
			);
			assertReconciliationSourceLease(sourceLease);
			if (hashBytes(sourceRaw) !== existingIntent.value.source.rawSha256)
				return refusal("source_checkpoint_changed");
			let source;
			try {
				source = JSON.parse(sourceRaw);
			} catch {
				return refusal("source_checkpoint_malformed");
			}
			const sourceOwnerMatchesIntent =
				stableStringify(source.owner) ===
				stableStringify(existingIntent.value.source.owner);
			if (
				!sourceOwnerMatchesIntent ||
				source.revision !== existingIntent.value.source.revision ||
				source.tasksFilePath !== existingIntent.value.source.tasksFilePath
			)
				return refusal("source_identity_mismatch");
			return await replayReconciliationIntent(
				existingIntent.value,
				intentPath,
				input,
				sourceLease,
			);
		} catch (error) {
			if (error?.message?.startsWith("injected reconciliation crash"))
				throw error;
			if (error?.message?.includes("checkpoint lease unavailable"))
				return refusal("source_checkpoint_lock_unavailable");
			if (error?.message?.includes("checkpoint lease displaced"))
				return refusal("source_checkpoint_lock_displaced");
			return refusal("reconciliation_intent_malformed");
		} finally {
			if (sourceLease) {
				try {
					releaseCheckpointLease(sourceLease);
				} catch {
					console.error(
						"switchyard: source checkpoint lease release failed during intent replay",
					);
				}
			}
		}
	}
	const receipt = readBoundedReceipt(input.receiptPath);
	if (receipt.error) return refusal(receipt.error);
	const inputHasNextRunOptions = Object.hasOwn(input, "nextRunOptions");
	const effectiveInput = {
		...receipt.value,
		...input,
	};
	const invalid = validateExternalCompletionInput(effectiveInput);
	if (invalid) return invalid;
	if (
		receipt.value?.version !== EXTERNAL_COMPLETION_VERSION ||
		receipt.value?.kind !== "external_completion" ||
		receipt.value.taskId !== effectiveInput.taskId ||
		receipt.value.attempt !== effectiveInput.attempt ||
		receipt.value.sourceRevision !== effectiveInput.sourceRevision ||
		stableStringify(receipt.value.sourceOwner) !==
			stableStringify(effectiveInput.sourceOwner) ||
		receipt.value.contractHash !== effectiveInput.contractHash ||
		receipt.value.integratedCommit !== effectiveInput.integratedCommit ||
		stableStringify(sortedUnique(receipt.value.changedPaths)) !==
			stableStringify(sortedUnique(effectiveInput.changedPaths)) ||
		stableStringify(sortedUnique(receipt.value.requiredPaths)) !==
			stableStringify(sortedUnique(effectiveInput.requiredPaths)) ||
		stableStringify(
			sortedUnique(receipt.value.resolvedExternalBlockers ?? []),
		) !==
			stableStringify(
				sortedUnique(effectiveInput.resolvedExternalBlockers ?? []),
			) ||
		(receipt.value.runStorePath !== undefined &&
			(!validAbsolutePath(receipt.value.runStorePath) ||
				resolve(receipt.value.runStorePath) !==
					reconciliationRunStorePath(effectiveInput))) ||
		(effectiveInput.runStorePath !== undefined &&
			(!validAbsolutePath(effectiveInput.runStorePath) ||
				resolve(effectiveInput.runStorePath) !==
					reconciliationRunStorePath(effectiveInput))) ||
		receipt.value.cleanup?.status !== "complete" ||
		(receipt.value.cleanup?.taskBaseReleased !== undefined &&
			receipt.value.cleanup.taskBaseReleased !== true) ||
		(receipt.value.cleanup?.projectLockReleased !== undefined &&
			receipt.value.cleanup.projectLockReleased !== true) ||
		receipt.value.providerSuccess !== false
	)
		return refusal("receipt_contract_mismatch");
	try {
		if (
			stableStringify(
				normalizeReconciliationRunOptions({
					...effectiveInput,
					nextRunOptions: receipt.value.nextRunOptions,
				}),
			) !==
			(inputHasNextRunOptions
				? stableStringify(normalizeReconciliationRunOptions(input))
				: stableStringify(normalizeReconciliationRunOptions(effectiveInput)))
		)
			return refusal("receipt_contract_mismatch");
	} catch {
		return refusal("receipt_contract_mismatch");
	}
	input = effectiveInput;
	let sourceRaw;
	try {
		const sourceStats = lstatSync(input.sourceCheckpointPath);
		if (!sourceStats.isFile() || sourceStats.isSymbolicLink())
			return refusal("source_checkpoint_not_regular");
		sourceRaw = readFileSync(input.sourceCheckpointPath, "utf8");
	} catch {
		return refusal("source_checkpoint_missing");
	}
	let sourceLease;
	try {
		sourceLease = acquireCheckpointLease(
			input.sourceCheckpointPath,
			input.sourceOwner,
		);
	} catch {
		return refusal("source_checkpoint_lock_unavailable");
	}
	let intentPrepared = false;
	try {
		let source;
		try {
			source = JSON.parse(sourceRaw);
		} catch {
			return refusal("source_checkpoint_malformed");
		}
		if (readFileSync(input.sourceCheckpointPath, "utf8") !== sourceRaw)
			return refusal("source_checkpoint_changed");
		if (
			stableStringify(source.owner) !== stableStringify(input.sourceOwner) ||
			source.revision !== input.sourceRevision ||
			typeof source.ownershipReleased !== "boolean"
		)
			return refusal("source_identity_mismatch");
		if (
			typeof source.tasksFilePath !== "string" ||
			resolve(source.tasksFilePath) !== resolve(input.tasksFilePath)
		)
			return refusal("source_tasks_path_mismatch");
		try {
			validateCheckpointTaskBases(source);
			validateRetryDescriptorEvidence(source);
			validateCheckpointV3(
				source,
				source.tasksFilePath,
				{ checkpointOwner: input.sourceOwner },
				input.sourceCheckpointPath,
			);
		} catch {
			return refusal("source_checkpoint_malformed");
		}
		if (source.taskAttempts?.[input.taskId] !== input.attempt)
			return refusal("attempt_identity_mismatch");
		if ((source.completedTaskIds ?? []).includes(input.taskId))
			return refusal("task_already_completed");
		if (
			source.integrationIntents?.[input.taskId]?.status !== undefined &&
			source.integrationIntents[input.taskId]?.status !== "completed"
		)
			return refusal("integration_intent_unresolved");
		if (source.taskBases?.[input.taskId] !== undefined)
			return refusal("task_base_not_released");
		if (
			source.taskBaseReleaseUncertain &&
			(typeof source.taskBaseReleaseUncertain !== "object" ||
				source.taskBaseReleaseUncertain.taskId === input.taskId ||
				typeof source.taskBaseReleaseUncertain.taskId !== "string")
		)
			return refusal("task_base_release_uncertain");
		if (
			source.providerCleanupUncertain &&
			(typeof source.providerCleanupUncertain !== "object" ||
				source.providerCleanupUncertain.taskId === input.taskId ||
				typeof source.providerCleanupUncertain.taskId !== "string")
		)
			return refusal("provider_cleanup_uncertain");
		if (
			source.retryState &&
			(typeof source.retryState !== "object" ||
				source.retryState.taskId === input.taskId ||
				typeof source.retryState.taskId !== "string")
		)
			return refusal("retry_state_unresolved");
		if (sourceTaskRetry(source, input.taskId))
			return refusal("retry_state_unresolved");
		const allocations = sourceTaskAllocation(source, input.taskId);
		if (allocations.some((entry) => entry?.state !== "result_recorded"))
			return refusal("provider_allocation_unresolved");
		try {
			if (
				await isProjectLockOwnedBy(
					resolve(input.projectPath),
					input.sourceOwner.runId,
				)
			)
				return refusal("project_lock_still_owned");
		} catch {
			return refusal("project_lock_state_unknown");
		}
		const markdown = readFileSync(input.tasksFilePath, "utf8");
		const taskBytes = taskContractBytes(markdown, input.taskId);
		if (!taskBytes) return refusal("unknown_task");
		if (hashBytes(taskBytes) !== input.contractHash)
			return refusal("contract_hash_mismatch");
		if (
			source.taskContracts?.[input.taskId] !== undefined &&
			source.taskContracts[input.taskId] !== input.contractHash
		)
			return refusal("contract_hash_mismatch");
		const tasks = parseTaskQueue(markdown);
		const task = tasks.find((candidate) => candidate.id === input.taskId);
		if (!task) return refusal("unknown_task");
		if (task.quickChecks?.checks?.length)
			return refusal("quick_check_receipt_missing");
		if (
			!Array.isArray(task.requiredPaths) ||
			!validateExactPathSet(task.requiredPaths, input.requiredPaths).ok
		)
			return refusal("path_scope_mismatch");
		if (
			(input.resolvedExternalBlockers ?? []).some(
				(blocker) => !(task.externalBlockers ?? []).includes(blocker),
			)
		)
			return refusal("external_blocker_not_declared");
		const ancestry = validateIntegratedCommitAncestry(
			input.projectPath,
			input.integratedCommit,
		);
		if (!ancestry.ok) return refusal(ancestry.reasonCode);
		const commitPaths = validateIntegratedCommitPaths(
			input.projectPath,
			input.integratedCommit,
			input.changedPaths,
		);
		if (!commitPaths.ok) return refusal(commitPaths.reasonCode);
		if (!validateExactPathSet(input.changedPaths, input.requiredPaths).ok)
			return refusal("path_scope_mismatch");
		const overlap = validateNoTrackedPathOverlap(
			input.projectPath,
			input.changedPaths,
		);
		if (!overlap.ok) return refusal(overlap.reasonCode);
		const options = normalizeReconciliationRunOptions(input);
		const queueIdentity = createQueueIdentity({
			tasksFilePath: input.tasksFilePath,
			markdown,
			tasks,
			projectRevision: ancestry.currentHead,
			runOptions: options,
		});
		const reconciliationId = hashBytes(
			stableStringify({
				version: RECONCILIATION_INTENT_VERSION,
				taskId: input.taskId,
				attempt: input.attempt,
				sourceCheckpointPath: resolve(input.sourceCheckpointPath),
				sourceRevision: input.sourceRevision,
				sourceOwner: input.sourceOwner,
				contractHash: input.contractHash,
				receiptPath: resolve(input.receiptPath),
				integratedCommit: input.integratedCommit,
				changedPaths: sortedUnique(input.changedPaths),
				requiredPaths: sortedUnique(input.requiredPaths),
				resolvedExternalBlockers: sortedUnique(
					input.resolvedExternalBlockers ?? [],
				),
				queueIdentity,
				runOptions: options,
				runStorePath: reconciliationRunStorePath(input),
			}),
		);
		if (input.reconciliationId && input.reconciliationId !== reconciliationId)
			return refusal("reconciliation_id_mismatch");
		const existingSuccessor = readSuccessorRecord(
			input.successorCheckpointPath,
		);
		if (existingSuccessor.error) return refusal(existingSuccessor.error);
		if (existingSuccessor.exists) {
			const completion = existingSuccessor.value?.externalCompletion;
			const identityMatches =
				completion?.version === EXTERNAL_COMPLETION_VERSION &&
				completion.reconciliationId === reconciliationId &&
				completion.sourceCheckpointPath ===
					resolve(input.sourceCheckpointPath) &&
				completion.sourceRevision === input.sourceRevision &&
				completion.attempt === input.attempt &&
				stableStringify(completion.sourceOwner) ===
					stableStringify(input.sourceOwner) &&
				completion.integratedCommit === input.integratedCommit &&
				completion.contractHash === input.contractHash &&
				stableStringify(completion.changedPaths) ===
					stableStringify(sortedUnique(input.changedPaths)) &&
				stableStringify(completion.requiredPaths) ===
					stableStringify(sortedUnique(input.requiredPaths)) &&
				stableStringify(completion.resolvedExternalBlockers ?? []) ===
					stableStringify(sortedUnique(input.resolvedExternalBlockers ?? [])) &&
				completion.providerSuccess === false &&
				existingSuccessor.value.queueIdentity === queueIdentity;
			if (!identityMatches) return refusal("successor_checkpoint_conflict");
			let ledger;
			try {
				ledger = await readLedgerFromStore(reconciliationRunStorePath(input));
			} catch {
				return refusal("ledger_state_unknown");
			}
			const recorded = ledger.find(
				(entry) =>
					entry?.recordType === "external_completion" &&
					entry.reconciliationId === reconciliationId,
			);
			if (!recorded) return refusal("successor_without_ledger");
			if (
				recorded.taskId !== input.taskId ||
				recorded.attempt !== input.attempt ||
				recorded.sourceRevision !== input.sourceRevision ||
				recorded.integratedCommit !== input.integratedCommit ||
				recorded.contractHash !== input.contractHash ||
				recorded.providerSuccess !== false ||
				recorded.result !== "external_completion_recorded"
			)
				return refusal("ledger_reconciliation_mismatch");
			return {
				recorded: true,
				status: "already-recorded",
				result: "external_completion_recorded",
				reconciliationId,
				successorCheckpointPath: resolve(input.successorCheckpointPath),
				providerSuccess: false,
			};
		}
		const successor = buildSuccessorCheckpoint(
			source,
			input,
			queueIdentity,
			options,
			reconciliationId,
		);
		const ledgerFields = {
			reconciliationId,
			taskId: input.taskId,
			attempt: input.attempt,
			sourceRevision: input.sourceRevision,
			integratedCommit: input.integratedCommit,
			contractHash: input.contractHash,
		};
		const intent = {
			version: RECONCILIATION_INTENT_VERSION,
			state: "prepared",
			reconciliationId,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			source: {
				checkpointPath: resolve(input.sourceCheckpointPath),
				owner: structuredClone(input.sourceOwner),
				revision: input.sourceRevision,
				taskId: input.taskId,
				attempt: input.attempt,
				tasksFilePath: resolve(input.tasksFilePath),
				rawSha256: hashBytes(sourceRaw),
			},
			immutable: {
				projectPath: resolve(input.projectPath),
				receiptPath: resolve(input.receiptPath),
				contractHash: input.contractHash,
				integratedCommit: input.integratedCommit,
				currentHead: ancestry.currentHead,
				changedPaths: sortedUnique(input.changedPaths),
				requiredPaths: sortedUnique(input.requiredPaths),
				queueIdentity,
				runOptions: options,
				runStorePath: reconciliationRunStorePath(input),
				resolvedExternalBlockers: sortedUnique(
					input.resolvedExternalBlockers ?? [],
				),
			},
			successor: {
				checkpointPath: resolve(input.successorCheckpointPath),
				checkpoint: successor,
			},
			ledger: {
				runStorePath: reconciliationRunStorePath(input),
				fields: ledgerFields,
			},
		};
		if (
			readFileSync(input.sourceCheckpointPath, "utf8") !== sourceRaw ||
			readFileSync(sourceLease.lockPath, "utf8") !== sourceLease.body
		)
			return refusal("source_checkpoint_lock_displaced");
		if (input.__testFault === "before_intent")
			throw new Error("injected reconciliation crash before intent");
		writeIntent(intentPath, intent);
		intentPrepared = true;
		if (input.__testFault === "after_intent")
			throw new Error("injected reconciliation crash after intent");
		return await replayReconciliationIntent(
			intent,
			intentPath,
			input,
			sourceLease,
		);
	} catch (error) {
		if (error?.code === "RECONCILIATION_LEDGER_MISMATCH")
			return refusal("ledger_reconciliation_mismatch");
		if (error?.code === "EEXIST")
			return refusal("successor_checkpoint_conflict");
		if (error?.message?.startsWith("injected reconciliation crash"))
			throw error;
		return refusal(
			"reconciliation_persistence_failed",
			error?.code ?? "unknown",
		);
	} finally {
		if (sourceLease) {
			try {
				releaseCheckpointLease(sourceLease);
			} catch {
				console.error(
					intentPrepared
						? "switchyard: source checkpoint lease release failed; durable reconciliation intent retained"
						: "switchyard: source checkpoint lease release failed",
				);
			}
		}
	}
}
