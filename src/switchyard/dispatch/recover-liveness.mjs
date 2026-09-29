import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readRun, releaseProjectLockIfOwnedBy } from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";

async function resolveIsRunDead(runId, dependencies) {
	const readRunFn = dependencies.readRun ?? readRun;
	let run;
	try {
		run = await readRunFn(runId);
	} catch {
		// run record not found => demonstrably dead (its container is an orphan).
		return true;
	}

	const classifier = dependencies.classifyRunLiveness ?? classifyRunLiveness;
	const options = dependencies.isWorkerLive
		? { probePid: () => (dependencies.isWorkerLive(run) ? "live" : "dead") }
		: undefined;
	const liveness = classifier(run, options);
	return liveness === "terminal_clean" || liveness === "dead";
}
async function releaseStaleProjectLocks(candidateIds, dependencies = {}) {
	const readRunFn = dependencies.readRun ?? readRun;
	const releaseFn =
		dependencies.releaseProjectLockIfOwnedBy ?? releaseProjectLockIfOwnedBy;
	const released = [];
	for (const rid of candidateIds) {
		let run;
		try {
			run = await readRunFn(rid);
		} catch {
			// run.json missing/unreadable — no projectPath to key the lock on
			continue;
		}
		if (run.cleanupState === "failed") continue;
		const classifier = dependencies.classifyRunLiveness ?? classifyRunLiveness;
		const options = dependencies.isWorkerLive
			? { probePid: () => (dependencies.isWorkerLive(run) ? "live" : "dead") }
			: undefined;
		const liveness = classifier(run, options);
		if (liveness === "terminal_clean" || liveness === "dead") {
			try {
				const didRelease = await releaseFn(run.projectPath, rid);
				if (didRelease) released.push(rid);
			} catch {
				// unlink failure is non-fatal; the run's VM recovery still ran
			}
		}
	}
	return released;
}
function recoveryLiveness(run, dependencies) {
	const classifier = dependencies.classifyRunLiveness ?? classifyRunLiveness;
	const options = dependencies.isWorkerLive
		? { probePid: () => (dependencies.isWorkerLive(run) ? "live" : "dead") }
		: undefined;
	return classifier(run, options);
}
function inspectSimpleWorktreeRecovery(run, dependencies = {}) {
	const claim = run.worktree;
	const lstatPath = dependencies.lstatSimpleWorktreePath ?? lstatSync;
	const realpathPath = dependencies.realpathSimpleWorktreePath ?? realpathSync;
	const runLiveness =
		run.state !== "running"
			? "not_running"
			: recoveryLiveness(run, dependencies);
	let path = null;
	let disposition = "unavailable";
	let reason = "worktree_unavailable";
	const ambiguous = () => {
		path = null;
		disposition = "ambiguous";
		reason = "worktree_identity_ambiguous";
	};

	if (
		!claim ||
		typeof claim.canonicalParent !== "string" ||
		typeof claim.candidateChild !== "string" ||
		typeof claim.path !== "string" ||
		resolve(claim.canonicalParent, claim.candidateChild) !== claim.path
	) {
		ambiguous();
	} else {
		try {
			const parentInfo = lstatPath(claim.canonicalParent);
			if (
				parentInfo.isSymbolicLink() ||
				!parentInfo.isDirectory() ||
				realpathPath(claim.canonicalParent) !== claim.canonicalParent
			) {
				ambiguous();
			} else {
				path = claim.path;
				let rootInfo;
				try {
					rootInfo = lstatPath(claim.path);
				} catch (error) {
					if (error?.code === "ENOENT") {
						disposition = claim.state === "removed" ? "removed" : "missing";
						reason =
							claim.state === "removed"
								? "worktree_removed"
								: "worktree_missing";
					} else {
						disposition = "unavailable";
						reason = "worktree_unavailable";
					}
				}
				if (rootInfo) {
					const realRootPath = realpathPath(claim.path);
					if (
						rootInfo.isSymbolicLink() ||
						!rootInfo.isDirectory() ||
						realRootPath !== claim.path ||
						dirname(realRootPath) !== claim.canonicalParent
					) {
						ambiguous();
					} else if (claim.state === "removed") {
						ambiguous();
					} else if (run.state === "running") {
						disposition = "preserved";
						reason = "writer_stop_unconfirmed";
					} else if (claim.state === "retained") {
						disposition = "retained";
						reason = "retained_for_recovery";
					} else {
						disposition = "preserved";
						reason = "worktree_state_unconfirmed";
					}
				}
			}
		} catch (error) {
			if (error?.code === "ENOENT") {
				disposition = claim.state === "removed" ? "removed" : "missing";
				reason =
					claim.state === "removed" ? "worktree_removed" : "worktree_missing";
			} else if (error?.code !== "EACCES" && error?.code !== "EPERM") {
				ambiguous();
			}
		}
	}
	if (disposition === "unavailable") path = null;

	return {
		runId: run.runId,
		status: run.state,
		runLiveness,
		disposition,
		reason,
		worktree: { path, state: claim?.state ?? "unavailable" },
	};
}

export {
	inspectSimpleWorktreeRecovery,
	recoveryLiveness,
	releaseStaleProjectLocks,
	resolveIsRunDead,
};
