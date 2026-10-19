import { existsSync } from "node:fs";
import {
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
} from "../run-store/project-lock-claims.mjs";
import { getStateRoot } from "../run-store/project-lock-files.mjs";
import { releaseProjectLockIfOwnedBy } from "../run-store/project-locks.mjs";
import { isTerminalState } from "../run-store/run-liveness.mjs";
import { readRun } from "../run-store/run-records.mjs";
import {
	scanSimpleWorktreeOpenHandles,
	simpleQuarantinePath,
} from "../simple/worktree-cleanup.mjs";
import { parseRecoverArgs, withStateRoot } from "./cli-args.mjs";
import { USAGE_RECOVER } from "./cli-usage.mjs";
import {
	applyRecordedSimpleCleanup,
	assessGcRootBeforeOpenScan,
} from "./gc-roots.mjs";
import {
	inspectSimpleWorktreeRecovery,
	releaseStaleProjectLocks,
} from "./recover-liveness.mjs";

/**
 * Release stale project locks and recover a terminal simple run's worktree.
 *
 * Without `--run`, every orphaned or unclaimed project lock is reconciled.
 * With `--run`, the named run's own lock is released once its worker is dead
 * or terminal, and a terminal simple run's retained worktree is removed when
 * no process holds it open. A running simple run is left untouched.
 */
async function handleRecover(argv, dependencies = {}) {
	const { help, runId, stateRoot } = parseRecoverArgs(argv);

	if (help) {
		console.log(USAGE_RECOVER);
		return;
	}

	const effectiveStateRoot = stateRoot ?? getStateRoot();
	return withStateRoot(effectiveStateRoot, async () => {
		let recoveryRun = null;
		if (runId) {
			try {
				recoveryRun = await (dependencies.readRun ?? readRun)(runId);
			} catch {
				// A missing run record leaves nothing run-scoped to recover.
			}
		}
		const simpleRun =
			recoveryRun?.runId === runId &&
			recoveryRun.initialHostFingerprint === "simple";
		const errors = [];
		let simpleWorktreeCandidate = null;
		if (simpleRun && recoveryRun.worktree) {
			simpleWorktreeCandidate = inspectSimpleWorktreeRecovery(
				recoveryRun,
				dependencies,
			);
		}
		const runningSimpleRun = simpleRun && recoveryRun.state === "running";

		const targeted =
			runningSimpleRun || !runId
				? []
				: await releaseStaleProjectLocks([runId], dependencies);
		const direct = runningSimpleRun
			? []
			: await (
					dependencies.releaseOrphanedProjectLocks ??
					releaseOrphanedProjectLocks
				)();
		const claims = runningSimpleRun
			? []
			: await (
					dependencies.reconcileProjectLockClaims ?? reconcileProjectLockClaims
				)();
		const releasedIds = [...new Set([...targeted, ...direct, ...claims])];
		let simpleWorktreesReclaimed = 0;
		const recoveryProgress =
			dependencies.onStatus ?? ((event) => console.error(`[recover] ${event}`));
		if (
			simpleRun &&
			recoveryRun.worktree &&
			isTerminalState(recoveryRun.state) &&
			["retained", "preserved"].includes(simpleWorktreeCandidate?.disposition)
		) {
			const claim = recoveryRun.worktree;
			let observedPath = claim.path;
			try {
				if (!existsSync(observedPath) && typeof claim.nonce === "string") {
					const quarantine = simpleQuarantinePath(claim.nonce);
					if (existsSync(quarantine)) observedPath = quarantine;
				}
				if (existsSync(observedPath) && claim.state !== "removed") {
					// A terminal run's own stale lock can be released by exact owner ID;
					// another run's project lock remains untouched and blocks cleanup.
					await (
						dependencies.releaseProjectLockIfOwnedBy ??
						releaseProjectLockIfOwnedBy
					)(recoveryRun.projectPath, runId);
					const root = {
						path: observedPath,
						classification: "recorded",
						pathAmbiguity: false,
						runId,
						deletionEligible: false,
					};
					const assessment = await assessGcRootBeforeOpenScan(
						root,
						recoveryRun,
						{ ...dependencies, onStatus: recoveryProgress },
					);
					root.deletionEligible = assessment.eligible;
					root.eligibilityReason = assessment.reason;
					if (assessment.eligible) {
						const scan = await (
							dependencies.scanOpenHandles ?? scanSimpleWorktreeOpenHandles
						)([observedPath], recoveryProgress);
						if (scan.complete && !scan.openPaths.includes(observedPath)) {
							const result = await applyRecordedSimpleCleanup(root, {
								...dependencies,
								onStatus: recoveryProgress,
							});
							if (result.disposition === "removed")
								simpleWorktreesReclaimed = 1;
							else simpleWorktreeCandidate.reason = result.reason;
						} else {
							simpleWorktreeCandidate.reason = scan.complete
								? "open_handles"
								: "open_handle_scan_unavailable";
						}
					} else {
						simpleWorktreeCandidate.reason = assessment.reason;
					}
					if (simpleWorktreesReclaimed) {
						simpleWorktreeCandidate = inspectSimpleWorktreeRecovery(
							await (dependencies.readRun ?? readRun)(runId),
							dependencies,
						);
					}
				}
			} catch {
				errors.push("simple_worktree_recovery_unavailable");
			}
		}

		const output = {
			disposition:
				errors.length > 0
					? "partial_failure"
					: simpleWorktreesReclaimed > 0
						? "reclaimed"
						: simpleWorktreeCandidate &&
								!["removed", "missing"].includes(
									simpleWorktreeCandidate.disposition,
								)
							? "preserved"
							: "no_candidates",
			worktreesReclaimed: simpleWorktreesReclaimed,
			errors,
			projectLocksReleased: releasedIds.length,
			runId: runId ?? null,
			candidates:
				simpleRun && !recoveryRun?.worktree
					? []
					: simpleWorktreeCandidate
						? [simpleWorktreeCandidate]
						: runId
							? [
									{
										runId,
										disposition: "preserved",
										reason: "resource_missing",
									},
								]
							: [],
		};

		console.log(JSON.stringify(output));
		process.exitCode = errors.length > 0 ? 1 : 0;
	});
}

export { handleRecover };
