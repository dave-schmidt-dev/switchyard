import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parsePredecessorReceipt } from "../lifecycle/index.mjs";
import { readRun } from "../run-store/index.mjs";
import { safeChangedFiles } from "./provider-invocation.mjs";

const SIMPLE_RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_WRITER_STATES = new Set([
	"stopped",
	"never_started",
	"unavailable",
]);
const RECOVERY_WORKTREE_STATES = new Set([
	"not_created",
	"retained",
	"removed",
	"unavailable",
]);
const RECOVERY_LOCK_STATES = new Set([
	"not_acquired",
	"released",
	"unavailable",
]);
function aggregateWriterLifecycle(previous, current) {
	if (
		!RECOVERY_WRITER_STATES.has(previous) ||
		!RECOVERY_WRITER_STATES.has(current) ||
		previous === "unavailable" ||
		current === "unavailable"
	)
		return "unavailable";
	if (previous === "never_started") return current;
	if (current === "never_started") return previous;
	return "stopped";
}
function sha256Hex(value) {
	return createHash("sha256").update(value).digest("hex");
}
function sha256(value) {
	return `sha256:${sha256Hex(value)}`;
}
function recoveryScope(files, checks) {
	if (
		!Array.isArray(files) ||
		!Array.isArray(checks) ||
		!files.every((path) => typeof path === "string") ||
		!checks.every((command) => typeof command === "string")
	)
		return null;
	const declaredFiles = files.map((path) => path);
	const declaredChecks = checks.map((command, index) => ({
		index: index + 1,
		digest: sha256(command),
	}));
	return {
		files: declaredFiles,
		checks: declaredChecks,
		digest: sha256(
			JSON.stringify({ files: declaredFiles, checks: declaredChecks }),
		),
	};
}
function recoveryContract(options) {
	return {
		taskId: options.taskId,
		attemptId: options.attemptId,
		baseRevision: options.baseRevision,
		...(options.dirtyBaseline ? { dirtyBaseline: options.dirtyBaseline } : {}),
		scope: recoveryScope(options.files, options.checks),
	};
}
function recoveryUnavailable() {
	return {
		schemaVersion: SIMPLE_RECOVERY_SCHEMA_VERSION,
		identity: {
			taskId: null,
			attemptId: null,
			baseRevision: null,
			scope: null,
		},
		result: {
			status: "failed",
			failureReason: "recovery_evidence_unavailable",
			failurePhase: "preflight",
		},
		partialWorktree: null,
		cleanup: {
			writer: { state: "unavailable" },
			worktree: { state: "unavailable", path: null },
			projectLock: { state: "unavailable" },
		},
		continuation: { available: false, reason: "recovery_evidence_unavailable" },
	};
}
function expectedRecoveryScope(expected) {
	if (expected?.scope) return expected.scope;
	return recoveryScope(expected?.files, expected?.checks);
}
export function assessSimpleRecoveryEvidence(
	recovery,
	expected = {},
	{ allowUnfinalized = false } = {},
) {
	const unavailable = (reason) => ({ available: false, reason });
	if (!recovery || typeof recovery !== "object")
		return unavailable("recovery_evidence_unavailable");
	const identity = recovery.identity;
	const scope = identity?.scope;
	const expectedScope = expectedRecoveryScope(expected);
	if (
		recovery.schemaVersion !== SIMPLE_RECOVERY_SCHEMA_VERSION ||
		!identity ||
		typeof identity.taskId !== "string" ||
		typeof identity.attemptId !== "string" ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity.baseRevision ?? "") ||
		!scope ||
		!Array.isArray(scope.files) ||
		!Array.isArray(scope.checks) ||
		typeof scope.digest !== "string"
	)
		return unavailable("recovery_evidence_unavailable");
	if (
		!scope.files.every(
			(path) =>
				typeof path === "string" &&
				path.length > 0 &&
				!isAbsolute(path) &&
				!path.split("/").includes(".git"),
		) ||
		!scope.checks.every(
			(check, index) =>
				check &&
				check.index === index + 1 &&
				typeof check.digest === "string" &&
				/^sha256:[0-9a-f]{64}$/u.test(check.digest),
		) ||
		scope.digest !==
			sha256(JSON.stringify({ files: scope.files, checks: scope.checks }))
	)
		return unavailable("recovery_evidence_unavailable");
	if (
		identity.taskId !== expected.taskId ||
		identity.attemptId !== expected.attemptId ||
		identity.baseRevision !== expected.baseRevision ||
		JSON.stringify(scope) !== JSON.stringify(expectedScope)
	)
		return unavailable("recovery_identity_mismatch");
	const cleanup = recovery.cleanup;
	if (
		!recovery.result ||
		!new Set(["succeeded", "failed"]).has(recovery.result.status) ||
		(typeof recovery.result.failureReason !== "string" &&
			recovery.result.failureReason !== null) ||
		(typeof recovery.result.failurePhase !== "string" &&
			recovery.result.failurePhase !== null)
	)
		return unavailable("recovery_evidence_unavailable");
	const writerState = cleanup?.writer?.state;
	const worktreeState = cleanup?.worktree?.state;
	const lockState = cleanup?.projectLock?.state;
	if (
		!RECOVERY_WRITER_STATES.has(writerState) ||
		!RECOVERY_WORKTREE_STATES.has(worktreeState) ||
		!RECOVERY_LOCK_STATES.has(lockState)
	)
		return unavailable("recovery_evidence_unavailable");
	if (recovery.continuation?.available !== true && !allowUnfinalized)
		return unavailable(
			recovery.continuation?.reason ?? "recovery_evidence_unavailable",
		);
	if (
		worktreeState !== "retained" ||
		typeof recovery.partialWorktree !== "string" ||
		!isAbsolute(recovery.partialWorktree)
	)
		return unavailable("no_partial_work");
	if (cleanup.worktree.path !== recovery.partialWorktree)
		return unavailable("recovery_evidence_unavailable");
	if (writerState !== "stopped" && writerState !== "never_started")
		return unavailable("writer_stop_unconfirmed");
	if (lockState !== "released" && lockState !== "not_acquired")
		return unavailable("project_lock_release_unconfirmed");
	if (recovery.result?.status === "succeeded")
		return unavailable("no_partial_work");
	return { available: true, reason: null };
}
function createRecoveryEvidence({
	contract,
	result,
	partialWorktree,
	cleanup,
}) {
	const evidence = {
		schemaVersion: SIMPLE_RECOVERY_SCHEMA_VERSION,
		identity: contract,
		result: {
			status: result.status,
			failureReason: result.failureReason,
			failurePhase: result.failurePhase,
		},
		partialWorktree,
		cleanup,
		continuation: { available: false, reason: "pending" },
	};
	const assessment = assessSimpleRecoveryEvidence(evidence, contract, {
		allowUnfinalized: true,
	});
	evidence.continuation = assessment;
	return evidence;
}
function terminalResult(base, overrides = {}) {
	const status = overrides.status ?? "failed";
	return {
		schemaVersion: 1,
		runId: overrides.runId ?? base.runId ?? `simple-${base.taskId}`,
		taskId: base.taskId,
		attemptId: base.attemptId,
		status,
		provider: overrides.provider ?? null,
		targetId: overrides.targetId ?? null,
		elapsedMs: Math.max(0, base.now() - base.startedAt),
		changedFiles: safeChangedFiles(overrides.changedFiles ?? []),
		outputs: overrides.outputs ?? [],
		baseRevision: overrides.baseRevision ?? null,
		checks: overrides.checks ?? [],
		failureReason: overrides.failureReason ?? null,
		failurePhase: overrides.failurePhase ?? null,
		errorKind:
			overrides.errorKind ??
			(status === "succeeded" ? null : "unclassified_failure"),
		providerLifecycle: overrides.providerLifecycle ?? null,
		providerVerdictCode: overrides.providerVerdictCode ?? null,
		...(overrides.preflightDetail
			? { preflightDetail: overrides.preflightDetail }
			: {}),
		dirtyBaseline: overrides.dirtyBaseline ?? null,
		partialWorktree: overrides.partialWorktree ?? null,
		recovery: overrides.recovery ?? recoveryUnavailable(),
	};
}
async function resolvePredecessorReceipt(input, projectPath, dependencies) {
	const supplied = parsePredecessorReceipt(input, { projectPath });
	let predecessor;
	try {
		predecessor = await (dependencies.readRun ?? readRun)(supplied.runId);
	} catch {
		const error = new Error("predecessor run record is unavailable");
		error.code = "predecessor_receipt_unverified";
		throw error;
	}
	if (
		predecessor.state !== "succeeded" ||
		predecessor.cleanupState !== "complete" ||
		realpathSync(predecessor.projectPath) !== realpathSync(projectPath) ||
		predecessor.terminalSummary?.status !== "succeeded"
	) {
		const error = new Error(
			"predecessor run is not an accepted project result",
		);
		error.code = "predecessor_receipt_unverified";
		throw error;
	}
	const durable = parsePredecessorReceipt(
		{ runId: predecessor.runId, ...predecessor.terminalSummary },
		{ projectPath },
	);
	if (
		supplied.baseRevision !== durable.baseRevision ||
		JSON.stringify(supplied.outputs) !== JSON.stringify(durable.outputs)
	) {
		const error = new Error(
			"predecessor receipt does not match durable result",
		);
		error.code = "predecessor_receipt_unverified";
		throw error;
	}
	return durable;
}

export {
	aggregateWriterLifecycle,
	createRecoveryEvidence,
	recoveryContract,
	recoveryUnavailable,
	resolvePredecessorReceipt,
	sha256,
	sha256Hex,
	terminalResult,
};
