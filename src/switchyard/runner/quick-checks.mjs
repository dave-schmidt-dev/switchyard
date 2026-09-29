import { failureTransition } from "../outcome/transitions.mjs";
import {
	normalizeProviderName,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import {
	invalidCompletedQuickCheckTaskIds,
	isPassingQuickCheckReceipt,
	runQuickChecks,
	runQuickChecksAsync,
} from "./checks.mjs";
import { DIAGNOSTIC_REF_RE } from "./constants.mjs";
import { integrationOperation } from "./review-results.mjs";

function quickCheckSnapshotPaths(context) {
	const trusted = new Set(
		(context.dirtyOverlayReceipt?.paths ?? []).map((entry) => entry.path),
	);
	for (const [id, intent] of Object.entries(
		context.checkpoint?.integrationIntents ?? {},
	)) {
		if (
			intent?.status !== "completed" ||
			!context.checkpoint.completedTaskIds?.includes(id) ||
			!context.checkpoint.results?.some(
				(entry) => entry.taskId === id && entry.success === true,
			)
		)
			continue;
		for (const path of intent.operation?.paths ?? []) trusted.add(path);
	}
	return [...trusted];
}
function quickCheckDecision(task, context, diff) {
	const { checks = [], setup = null } = task.quickChecks ?? {};
	// No candidate exists when capture failed or returned an empty diff. Let the
	// existing capture/integration path report that failure; a check cannot run.
	if (checks.length === 0) return { passed: true, receipt: null };
	if (!diff) return { passed: false, receipt: null };
	const attempt =
		integrationOperation(context, task, diff)?.attempt ??
		(context.checkpoint?.taskAttempts?.[task.id] ?? 0) + 1;
	const baseTree = context._activeTaskBase?.tree ?? null;
	let receipt;
	try {
		receipt = runQuickChecks({
			projectPath: context.projectPath,
			taskId: task.id,
			attempt,
			baseTree,
			diff,
			checks,
			setup,
			onStatus: context.onStatus,
			allowedPaths: task.requiredPaths,
			snapshotPaths: quickCheckSnapshotPaths(context),
			allowSensitiveManifests:
				task.type === "implementation" && task.allowManifests === true,
		});
	} catch {
		return { passed: false, receipt: null };
	}
	return {
		passed: isPassingQuickCheckReceipt(receipt, {
			taskId: task.id,
			attempt,
			baseTree,
			diff,
			checks,
			setup,
		}),
		receipt,
	};
}
async function quickCheckDecisionAsync(task, context, diff) {
	const { checks = [], setup = null } = task.quickChecks ?? {};
	if (checks.length === 0) return { passed: true, receipt: null };
	if (!diff) return { passed: false, receipt: null };
	const attempt =
		integrationOperation(context, task, diff)?.attempt ??
		(context.checkpoint?.taskAttempts?.[task.id] ?? 0) + 1;
	const baseTree = context._activeTaskBase?.tree ?? null;
	let receipt;
	try {
		receipt = await runQuickChecksAsync({
			projectPath: context.projectPath,
			taskId: task.id,
			attempt,
			baseTree,
			diff,
			checks,
			setup,
			onStatus: context.onStatus,
			allowedPaths: task.requiredPaths,
			snapshotPaths: quickCheckSnapshotPaths(context),
			allowSensitiveManifests:
				task.type === "implementation" && task.allowManifests === true,
		});
	} catch {
		return { passed: false, receipt: null };
	}
	return {
		passed: isPassingQuickCheckReceipt(receipt, {
			taskId: task.id,
			attempt,
			baseTree,
			diff,
			checks,
			setup,
		}),
		receipt,
	};
}
function assertCompletedQuickChecks(tasks, checkpoint) {
	const [taskId] = invalidCompletedQuickCheckTaskIds(tasks, checkpoint);
	if (!taskId) return;
	const error = new Error(
		`Task ${taskId}: completed checkpoint lacks an exact passing Quick check receipt`,
	);
	error.code = "check_failed";
	throw error;
}
function failureMetadataFor(result, partialDiffPath) {
	const decision = failureTransition({
		...result,
		result: result.result,
		artifactRef: partialDiffPath,
	});
	return decision.failureMetadata;
}
function normalizeRetryTargetId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) {
		return null;
	}
	if (
		[...value].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint <= 0x1f || codePoint === 0x7f;
		})
	) {
		return null;
	}
	return value;
}
function ensureRetryCheckpoint(checkpoint) {
	if (!Array.isArray(checkpoint.quarantinedTargetIds)) {
		checkpoint.quarantinedTargetIds = [];
	}
	checkpoint.quarantinedTargetIds = [
		...new Set(
			checkpoint.quarantinedTargetIds
				.map(normalizeRetryTargetId)
				.filter((targetId) => targetId !== null),
		),
	];
	for (const field of ["retryAttempts", "retryTransitions"]) {
		if (
			Object.hasOwn(checkpoint, field) &&
			checkpoint[field] !== undefined &&
			checkpoint[field] !== null &&
			!Array.isArray(checkpoint[field])
		) {
			throw new Error(`${field} is invalid`);
		}
		if (!Array.isArray(checkpoint[field])) checkpoint[field] = [];
	}
	if (!Number.isInteger(checkpoint.retryTransitionId)) {
		checkpoint.retryTransitionId = checkpoint.retryTransitions.length;
	}
	if (checkpoint.retryState === undefined) checkpoint.retryState = null;
	return checkpoint;
}
function hasTrustedQuotaRetryEvidence(value) {
	if (
		value?.diagnosticCode !== "quota_exhausted" ||
		value.diagnosticOrigin !== "adapter" ||
		value.diagnosticEvidenceAvailable !== true ||
		!DIAGNOSTIC_REF_RE.test(value.diagnosticRef ?? "") ||
		value.failurePhase !== "provider_execution"
	) {
		return false;
	}
	const targetId = normalizeRetryTargetId(value.resolvedTargetId);
	if (!targetId) return false;
	try {
		const descriptor = validateInvocationDescriptor(
			value.invocationDescriptor,
			value.descriptorHarness,
		);
		return (
			descriptor.target_id === targetId &&
			descriptor.descriptor_identity === value.descriptorIdentity
		);
	} catch {
		return false;
	}
}
function validateRetryDescriptorEvidence(checkpoint) {
	const validateEntry = (entry, label) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${label} is invalid`);
		}
		const hasEvidence = [
			"invocationDescriptor",
			"descriptorIdentity",
			"descriptorHarness",
		].some((field) => entry[field] !== undefined && entry[field] !== null);
		if (!hasEvidence) return;

		if (
			!entry.invocationDescriptor ||
			typeof entry.descriptorIdentity !== "string" ||
			entry.descriptorIdentity.length === 0 ||
			typeof entry.descriptorHarness !== "string" ||
			entry.descriptorHarness.trim() === ""
		) {
			throw new Error(`${label} has incomplete descriptor evidence`);
		}
		const targetId = normalizeRetryTargetId(entry.resolvedTargetId);
		if (!targetId || targetId !== entry.resolvedTargetId) {
			throw new Error(`${label} descriptor target is invalid`);
		}

		let descriptor;
		try {
			descriptor = validateInvocationDescriptor(
				entry.invocationDescriptor,
				entry.descriptorHarness,
			);
		} catch {
			throw new Error(`${label} contains an invalid descriptor receipt`);
		}
		if (descriptor.descriptor_identity !== entry.descriptorIdentity) {
			throw new Error(`${label} descriptor identity does not match receipt`);
		}
		if (descriptor.target_id !== targetId) {
			throw new Error(`${label} descriptor target does not match target`);
		}

		const targetIdentity = resolveTargetIdentity(targetId);
		if (
			targetIdentity.targetId === targetId &&
			targetIdentity.harnessKey &&
			normalizeProviderName(entry.descriptorHarness) !==
				normalizeProviderName(targetIdentity.harnessKey)
		) {
			throw new Error(`${label} descriptor harness does not match target`);
		}
		const hasDiagnosticEvidence = [
			"diagnosticCode",
			"diagnosticOrigin",
			"diagnosticEvidenceAvailable",
			"failurePhase",
		].some((field) => entry[field] !== undefined && entry[field] !== null);
		if (hasDiagnosticEvidence && !hasTrustedQuotaRetryEvidence(entry)) {
			throw new Error(`${label} has invalid quota diagnostic provenance`);
		}
	};

	if (checkpoint.retryState !== undefined && checkpoint.retryState !== null) {
		validateEntry(checkpoint.retryState, "retryState");
	}
	for (const field of ["retryAttempts", "retryTransitions"]) {
		if (checkpoint[field] === undefined || checkpoint[field] === null) continue;
		if (!Array.isArray(checkpoint[field])) {
			throw new Error(`${field} is invalid`);
		}
		checkpoint[field].forEach((entry, index) => {
			validateEntry(entry, `${field}[${index}]`);
		});
	}
}

export {
	assertCompletedQuickChecks,
	ensureRetryCheckpoint,
	failureMetadataFor,
	hasTrustedQuotaRetryEvidence,
	normalizeRetryTargetId,
	quickCheckDecision,
	quickCheckDecisionAsync,
	validateRetryDescriptorEvidence,
};
