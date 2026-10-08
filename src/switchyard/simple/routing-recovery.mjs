/** Ownership-safe recovery for retained partial and pending routing attempts. */
import { lstatSync } from "node:fs";
import { isProjectLockHeld, readRun } from "../run-store/index.mjs";
import { claimCovers } from "./partial-continuation.mjs";
import {
	canonicalRoutingProject,
	openRoutingRun,
	recordAttemptOutcome,
	releasePartialAttempt,
} from "./routing-state.mjs";
import {
	cleanupSimpleWorktree,
	simpleQuarantinePath,
} from "./worktree-cleanup.mjs";

const rejectRelease = (code) => {
	throw Object.assign(new Error(code), { code });
};
function statPartial(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		rejectRelease("partial_worktree_unavailable");
	}
}
/**
 * Discard one recorded partial through its exact run claim, then clear it with
 * the release_partial transition. The claim names the attempt root; the
 * recorded partial is that root or its `worktree` child. The root is what is
 * stat-checked and what cleanup removes. Throws a closed code and leaves
 * routing state unchanged when anything does not hold.
 *
 * @returns {Promise<boolean>} Whether anything was discarded from disk.
 */
export async function discardAndReleasePartial(handle, attempt, options) {
	const { projectPath, discard, deps } = options;
	const record = await (deps.readRun ?? readRun)(attempt.runId).catch(
		() => null,
	);
	const claim = record?.worktree;
	if (
		!claim ||
		!claimCovers(claim.path, attempt.partialWorktree) ||
		typeof claim.nonce !== "string" ||
		!/^\d+$/.test(claim.device ?? "") ||
		!/^\d+$/.test(claim.inode ?? "")
	)
		rejectRelease("partial_worktree_claim_mismatch");
	const root = statPartial(claim.path);
	const quarantine = simpleQuarantinePath(claim.nonce);
	const quarantined = statPartial(quarantine);
	if (root?.isSymbolicLink() || quarantined?.isSymbolicLink())
		rejectRelease("partial_worktree_symlink");
	if ((deps.isProjectLockHeld ?? isProjectLockHeld)(projectPath))
		rejectRelease("project_lock_held");
	if (root && quarantined) rejectRelease("cleanup_state_ambiguous");
	let discarded = false;
	if (root || quarantined) {
		if (!discard) rejectRelease("discard_required");
		const cleanupWorktree = deps.cleanupSimpleWorktree ?? cleanupSimpleWorktree;
		const cleanup = await cleanupWorktree(attempt.runId, claim, {
			writerStopped: claim.writerStopped === true,
			onStatus: deps.onStatus,
		});
		if (!cleanup.removed) rejectRelease("cleanup_retained");
		discarded = true;
	}
	releasePartialAttempt(handle.state, handle.commit, attempt.attemptId);
	return discarded;
}
/**
 * Release a recorded retained partial once its root is already absent or its
 * exact claim is discarded. The release clears the routing attempt's
 * partialWorktree so the partial_work_retained guard passes again.
 */
export async function releaseRetainedPartial(options, deps = {}) {
	const projectPath = canonicalRoutingProject(options.projectPath);
	const handle = (deps.openRoutingRun ?? openRoutingRun)(
		projectPath,
		options.routingRunId,
		{ stateRoot: deps.stateRoot, create: false },
	);
	try {
		const taskId = options.taskId;
		const attempt = handle.state.attempts.find(
			(item) => item.taskId === taskId && item.partialWorktree !== null,
		);
		if (!attempt) rejectRelease("partial_worktree_not_recorded");
		const discarded = await discardAndReleasePartial(handle, attempt, {
			projectPath,
			discard: options.discard === true,
			deps,
		});
		return {
			ok: true,
			released: true,
			routingRunId: options.routingRunId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			path: attempt.partialWorktree,
			discarded,
		};
	} finally {
		handle.release();
	}
}

const RUN_TERMINAL_STATES = new Set(["succeeded", "failed", "deferred"]);
// Writer quiescence follows the lifecycle rule: the run's writer is stopped
// or never started. A worktree claim that does not record writerStopped
// proves nothing, and a worker process that answers a liveness probe blocks
// recovery -- a probe that fails with EPERM counts as live.
function writerQuiescent(record, deps) {
	if (record.worktree !== null && record.worktree?.writerStopped !== true)
		return false;
	const pid = record.workerPid;
	if (pid === null || pid === undefined) return true;
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		(deps.probePid ?? process.kill)(pid, 0);
		return false;
	} catch (error) {
		return error?.code === "ESRCH";
	}
}
/**
 * Recover a dangling pending attempt after an unconfirmed lifecycle left it
 * behind; every later invocation would otherwise answer
 * `pending_attempt_exists`. Recovery requires durable proof the attempt is
 * over -- a terminal run record, a quiescent writer, no live project lock and
 * no retained-unclaimed worktree -- and records the attempt as terminal
 * `skipped` with reason `lifecycle_recovered`.
 */
export async function closePendingAttempt(options, deps = {}) {
	const projectPath = canonicalRoutingProject(options.projectPath);
	const handle = (deps.openRoutingRun ?? openRoutingRun)(
		projectPath,
		options.routingRunId,
		{ stateRoot: deps.stateRoot, create: false },
	);
	try {
		const pending = handle.state.pendingAttempt;
		if (!pending) rejectRelease("pending_attempt_missing");
		if (options.taskId !== undefined && pending.taskId !== options.taskId)
			rejectRelease("routing_pending_identity_mismatch");
		const record = await (deps.readRun ?? readRun)(pending.runId).catch(
			() => null,
		);
		if (!record || record.runId !== pending.runId)
			rejectRelease("lifecycle_unconfirmed");
		if (!RUN_TERMINAL_STATES.has(record.state))
			rejectRelease("run_state_not_terminal");
		if (!writerQuiescent(record, deps)) rejectRelease("worker_not_stopped");
		if ((deps.isProjectLockHeld ?? isProjectLockHeld)(projectPath))
			rejectRelease("project_lock_held");
		if (record.worktree?.state === "retained")
			rejectRelease("partial_work_retained");
		recordAttemptOutcome(handle.state, handle.commit, {
			...pending,
			terminal: "skipped",
			reason: "lifecycle_recovered",
			closedAt: new Date((deps.now ?? Date.now)()).toISOString(),
			partialWorktree: null,
		});
		return {
			ok: true,
			recovered: true,
			routingRunId: options.routingRunId,
			taskId: pending.taskId,
			attemptId: pending.attemptId,
			runId: pending.runId,
			reason: "lifecycle_recovered",
		};
	} finally {
		handle.release();
	}
}
