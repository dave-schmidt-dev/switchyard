import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	acquireProjectLock,
	isProjectLockHeld,
	readRun,
	releaseProjectLockIfOwnedBy,
	updateRunWithRetry,
} from "../run-store/index.mjs";
import {
	cleanupSimpleWorktree,
	scanSimpleWorktreeOpenHandles,
	simpleQuarantinePath,
	verifySimpleWorktreeClaim,
} from "../simple/worktree-cleanup.mjs";
import { isTerminalState } from "./result.mjs";

function isFixture(name, worktreeRecord, dirPath, exists = existsSync) {
	if (typeof name === "string" && /fixture/i.test(name)) return true;
	if (worktreeRecord) {
		if (worktreeRecord.worktree?.reason === "fixture") return true;
		if (
			typeof worktreeRecord.runId === "string" &&
			/fixture/i.test(worktreeRecord.runId)
		) {
			return true;
		}
	}
	if (dirPath && exists(dirPath)) {
		try {
			if (
				exists(join(dirPath, ".fixture")) ||
				exists(join(dirPath, "fixture"))
			) {
				return true;
			}
		} catch {}
	}
	return false;
}
async function hasRecentWorktreeEntry(rootPath, cutoffMs, dependencies = {}) {
	const readDirectory = dependencies.readdir ?? readdir;
	const stat = dependencies.lstat ?? lstat;
	const stack = [rootPath];
	let visited = 0;
	try {
		while (stack.length > 0) {
			if (++visited > 100_000) return null;
			if (visited === 1 || visited % 1000 === 0)
				dependencies.onStatus?.("cleanup_age_scan_running");
			const path = stack.pop();
			const info = await stat(path);
			if (info.mtimeMs > cutoffMs) return true;
			if (!info.isDirectory() || info.isSymbolicLink()) continue;
			const entries = await readDirectory(path, { withFileTypes: true });
			for (const entry of entries) stack.push(join(path, entry.name));
		}
		return false;
	} catch {
		return null;
	}
}
function claimMatchesObservedPath(claim, path) {
	if (claim?.path === path) return true;
	try {
		return path === simpleQuarantinePath(claim?.nonce);
	} catch {
		return false;
	}
}
const NON_SALVAGE_RETENTION_REASONS = new Set([
	"worktree_cleanup_failed",
	"worktree_identity_or_quarantine_unavailable",
	"open_handles_or_scan_unavailable",
	"guarded_removal_failed",
	"guarded_removal_unconfirmed",
	"recently_modified_or_unavailable",
]);
async function assessGcRootBeforeOpenScan(root, run, dependencies = {}) {
	const reject = (reason) => ({ eligible: false, reason });
	if (!run || root.classification !== "recorded" || root.pathAmbiguity)
		return reject("unrecorded_or_ambiguous");
	const claim = run.worktree;
	if (
		!claimMatchesObservedPath(claim, root.path) ||
		claim.state === "removed" ||
		!/^\d+$/.test(claim?.device ?? "") ||
		!/^\d+$/.test(claim?.inode ?? "") ||
		typeof claim?.nonce !== "string"
	)
		return reject("identity_unavailable");
	if (!isTerminalState(run.state)) return reject("run_not_terminal");
	if (claim.writerStopped !== true) return reject("writer_stop_unconfirmed");
	if (claim.state === "active" && run.state !== "succeeded")
		return reject("active_claim_unresolved");
	if (
		!(dependencies.verifySimpleWorktreeClaim ?? verifySimpleWorktreeClaim)(
			root.path,
			claim,
			run.runId,
		)
	)
		return reject("identity_unavailable");
	const nowMs = dependencies.now?.() ?? Date.now();
	if (
		claim.state === "retained" &&
		run.state !== "succeeded" &&
		!NON_SALVAGE_RETENTION_REASONS.has(claim.reason)
	) {
		const retainedMs = Date.parse(claim.retainedAt ?? "");
		if (
			!Number.isFinite(retainedMs) ||
			nowMs - retainedMs < 24 * 60 * 60 * 1000
		)
			return reject("salvage_not_expired");
	}
	try {
		if ((dependencies.isProjectLockHeld ?? isProjectLockHeld)(run.projectPath))
			return reject("project_locked");
	} catch {
		return reject("project_lock_unavailable");
	}
	const recent = await hasRecentWorktreeEntry(
		root.path,
		nowMs - 30 * 60 * 1000,
		dependencies,
	);
	if (recent === null) return reject("modification_time_unavailable");
	if (recent) return reject("recently_modified");
	return { eligible: true, reason: null };
}
async function applyRecordedSimpleCleanup(root, dependencies = {}) {
	const reject = (reason) => ({
		runId: root.runId,
		path: root.path,
		disposition: "preserved",
		reason,
	});
	if (
		root.classification !== "recorded" ||
		!root.runId ||
		!root.deletionEligible
	)
		return reject(root.eligibilityReason ?? "not_eligible");
	let run;
	try {
		run = await (dependencies.readRun ?? readRun)(root.runId);
	} catch {
		return reject("run_record_unavailable");
	}
	if (!claimMatchesObservedPath(run.worktree, root.path))
		return reject("run_record_changed");
	const gcRunId = `gc-${randomUUID()}`;
	let locked = false;
	try {
		await (dependencies.acquireProjectLock ?? acquireProjectLock)(
			run.projectPath,
			gcRunId,
		);
		locked = true;
		const current = await (dependencies.readRun ?? readRun)(root.runId);
		if (
			current.revision !== run.revision ||
			!claimMatchesObservedPath(current.worktree, root.path)
		)
			return reject("run_record_changed");
		const assessment = await assessGcRootBeforeOpenScan(root, current, {
			...dependencies,
			isProjectLockHeld: () => false,
		});
		if (!assessment.eligible) return reject(assessment.reason);
		const open = await (
			dependencies.scanOpenHandles ?? scanSimpleWorktreeOpenHandles
		)([root.path], dependencies.onStatus);
		if (!open.complete) return reject("open_handle_scan_unavailable");
		if (open.openPaths.includes(root.path)) return reject("open_handles");
		const cleanup = await (
			dependencies.cleanupSimpleWorktree ?? cleanupSimpleWorktree
		)(current.runId, current.worktree, {
			writerStopped: current.worktree.writerStopped === true,
			onStatus: dependencies.onStatus,
			postQuarantineCheck: async (path) =>
				(await hasRecentWorktreeEntry(
					path,
					(dependencies.now?.() ?? Date.now()) - 30 * 60 * 1000,
					dependencies,
				)) === false,
		});
		const nextPath = cleanup.path ?? root.path;
		const changedWorktree = {
			...current.worktree,
			canonicalParent: dirname(nextPath),
			candidateChild: basename(nextPath),
			path: nextPath,
			state: cleanup.removed ? "removed" : "retained",
			reason: cleanup.removed ? null : cleanup.reason,
			retainedAt: cleanup.removed
				? null
				: (current.worktree.retainedAt ??
					new Date(dependencies.now?.() ?? Date.now()).toISOString()),
		};
		await (dependencies.updateRunWithRetry ?? updateRunWithRetry)(
			current.runId,
			{
				worktree: changedWorktree,
				cleanupState: cleanup.removed ? "complete" : "failed",
			},
		);
		return {
			runId: root.runId,
			path: nextPath,
			disposition: cleanup.removed ? "removed" : "preserved",
			reason: cleanup.reason,
		};
	} catch {
		return reject(
			locked
				? "cleanup_or_record_write_failed"
				: "project_locked_or_unavailable",
		);
	} finally {
		if (locked) {
			try {
				await (
					dependencies.releaseProjectLockIfOwnedBy ??
					releaseProjectLockIfOwnedBy
				)(run.projectPath, gcRunId);
			} catch {
				dependencies.onStatus?.("cleanup_lock_release_unavailable");
			}
		}
	}
}

export { applyRecordedSimpleCleanup, assessGcRootBeforeOpenScan, isFixture };
