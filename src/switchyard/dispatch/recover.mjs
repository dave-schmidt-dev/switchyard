import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { sanitizeFailureMetadata } from "../adapter/exec-error.mjs";
import {
	acquireRunLock,
	activateOutcomeWriter,
	getStateRoot,
	isProjectLockOwnedBy,
	readRun,
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
	releaseProjectLockIfOwnedBy,
} from "../run-store/index.mjs";
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
	recoveryLiveness,
	releaseStaleProjectLocks,
} from "./recover-liveness.mjs";
import {
	auditKnownAllocationIntents,
	canonicalRecoveryProject,
	emptyReclaimResult,
	reclaimManagedEntries,
	recoveryExecutionBackend,
} from "./recover-reclaim.mjs";
import { isTerminalState } from "./result.mjs";
import { finalizeRun } from "./run-finalization.mjs";

async function handleRecover(argv, dependencies = {}) {
	const { help, runId, stateRoot } = parseRecoverArgs(argv);

	if (help) {
		console.log(USAGE_RECOVER);
		return;
	}

	const effectiveStateRoot = stateRoot ?? getStateRoot();
	return withStateRoot(effectiveStateRoot, async () => {
		let executionBackend = dependencies.executionBackend ?? null;
		const getExecutionBackend = () =>
			(executionBackend ??= recoveryExecutionBackend(dependencies));
		const listManaged =
			dependencies.listManaged ?? (() => getExecutionBackend().listManaged());
		let managed = [];
		let inventoryErrors = [];
		let recoveryRun = null;
		if (runId) {
			try {
				recoveryRun = await (dependencies.readRun ?? readRun)(runId);
			} catch {
				// Missing run evidence never authorizes VM destruction.
			}
		}
		const simpleRun =
			recoveryRun?.runId === runId &&
			recoveryRun.initialHostFingerprint === "simple";
		// Simple runs own local worktree claims, not managed VMs. Avoid asking
		// the VM backend to inventory resources for any targeted simple run.
		if (!simpleRun) {
			try {
				managed = listManaged();
			} catch {
				inventoryErrors = ["managed_inventory_unavailable"];
			}
		}
		const candidateIds = managed.map((entry) => entry.runId).filter(Boolean);

		let reclaimedCount = 0;
		const errors = [...inventoryErrors];
		let unreclaimedSnapshots = [];
		let candidateResults = [];
		let simpleWorktreeCandidate = null;
		let runningSimpleRun = false;
		let recoveredByFinalizer = false;
		let projectLockReleasedByFinalizer = false;
		if (runId && simpleRun) {
			if (recoveryRun.worktree) {
				simpleWorktreeCandidate = inspectSimpleWorktreeRecovery(
					recoveryRun,
					dependencies,
				);
			}
			runningSimpleRun = recoveryRun.state === "running";
		} else if (runId) {
			const target = managed.find((entry) => entry.runId === runId);
			const recoveryRunMatchesTarget =
				recoveryRun?.runId === runId &&
				typeof recoveryRun.projectPath === "string";
			const liveness = recoveryRunMatchesTarget
				? recoveryLiveness(recoveryRun, dependencies)
				: "unknown";
			const reclaimTarget = async () => {
				if (!target || !recoveryRunMatchesTarget) return false;
				const targetDependencies =
					typeof dependencies.destroy === "function" &&
					typeof dependencies.reclaim !== "function"
						? {
								...dependencies,
								reclaim: ({ eligibility }) => {
									if (!eligibility(target)) return emptyReclaimResult();
									dependencies.destroy(target);
									return {
										...emptyReclaimResult(),
										reclaimed: [target],
									};
								},
							}
						: dependencies;
				const { result, candidates } = await reclaimManagedEntries({
					managed: [target],
					dependencies: targetDependencies,
					projectPath: recoveryRun.projectPath,
				});
				candidateResults = candidates;
				const reclaimed = result.reclaimed.some(
					(entry) => entry.uuid === target.uuid && entry.name === target.name,
				);
				if (reclaimed) reclaimedCount = 1;
				unreclaimedSnapshots.push(...(result.skippedSnapshots ?? []));
				errors.push(
					...(result.errors ?? []).map(
						(error) => `${error.name}: ${error.reason}`,
					),
				);
				return reclaimed;
			};
			if (
				recoveryRunMatchesTarget &&
				liveness === "dead" &&
				!isTerminalState(recoveryRun.state)
			) {
				// Preserve the dead-worker proof through the destructive boundary.
				// Claiming the recovery writer lease first would make the run appear
				// live and correctly disqualify its managed VM from reclamation.
				let destroyFailed = false;
				if (target) {
					try {
						if (!(await reclaimTarget())) destroyFailed = true;
					} catch {
						destroyFailed = true;
						errors.push("managed_reclaim_failed");
					}
				}
				const recoveryStartToken = randomUUID();
				const recoveryNonce = randomUUID();
				await acquireRunLock(
					runId,
					process.pid,
					recoveryStartToken,
					recoveryNonce,
					{
						allowRecovery: true,
						maxAgeMs: 0,
						now: new Date(Date.now() + 1).toISOString(),
					},
				);
				await activateOutcomeWriter(runId, {
					pid: process.pid,
					startToken: recoveryStartToken,
					nonce: recoveryNonce,
					writerEpoch: `epoch-recovery-${randomUUID()}`,
					allowRecovery: true,
				});
				const failure = sanitizeFailureMetadata({
					result: "unknown_failure",
					errorKind: "unknown_failure",
					failurePhase: "terminal_reconciliation",
				});
				const finalized = await finalizeRun({
					runId,
					state: "failed",
					terminalizedBy: "dead_worker_recovery",
					failure,
					terminalSummary: {
						totalTasks: Array.isArray(recoveryRun.orderedTaskIds)
							? recoveryRun.orderedTaskIds.length
							: null,
						runnableTasks: null,
						processedTasks: null,
						completedTaskIds: null,
						failedCount: null,
					},
					cleanup: async () => {
						await (
							dependencies.reconcileProjectLockClaims ??
							reconcileProjectLockClaims
						)();
						projectLockReleasedByFinalizer = await (
							dependencies.releaseProjectLockIfOwnedBy ??
							releaseProjectLockIfOwnedBy
						)(recoveryRun.projectPath, runId);
						if (
							await (dependencies.isProjectLockOwnedBy ?? isProjectLockOwnedBy)(
								recoveryRun.projectPath,
								runId,
							)
						) {
							throw new Error("recovery ownership cleanup incomplete");
						}
						if (destroyFailed) throw new Error("managed reclaim failed");
					},
				});
				recoveredByFinalizer = finalized.terminal;
				if (!finalized.cleanupComplete) errors.push("recovery_incomplete");
			} else if (
				target &&
				(liveness === "terminal_clean" || liveness === "dead")
			) {
				try {
					await reclaimTarget();
				} catch {
					errors.push("managed_reclaim_failed");
				}
			}
			if (candidateResults.length === 0) {
				candidateResults = target
					? [
							{
								entry: target,
								disposition: "preserved",
								reason: recoveryRunMatchesTarget
									? liveness === "live"
										? "live_run"
										: liveness === "startup_grace"
											? "startup_grace"
											: "liveness_unknown"
									: recoveryRun
										? "run_identity_mismatch"
										: "run_missing",
							},
						]
					: [];
			}
		} else {
			const projectPath = await canonicalRecoveryProject(managed, dependencies);
			try {
				const { result, candidates } = await reclaimManagedEntries({
					managed,
					dependencies,
					projectPath,
				});
				candidateResults = candidates;
				reclaimedCount = result.reclaimed.length;
				errors.push(...result.errors.map((e) => `${e.name}: ${e.reason}`));
				unreclaimedSnapshots = result.skippedSnapshots ?? [];
			} catch {
				errors.push("managed_reclaim_unavailable");
			}
		}

		const targeted = runningSimpleRun
			? []
			: recoveredByFinalizer
				? projectLockReleasedByFinalizer
					? [runId]
					: []
				: await releaseStaleProjectLocks(
						runId ? [runId] : candidateIds,
						dependencies,
					);
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
		const allocationIntents = simpleRun
			? []
			: await auditKnownAllocationIntents({
					stateRoot: effectiveStateRoot,
					runId,
					managed,
					dependencies,
					executionBackend: getExecutionBackend(),
				});

		const output = {
			disposition:
				errors.length > 0
					? "partial_failure"
					: reclaimedCount > 0 || simpleWorktreesReclaimed > 0
						? "reclaimed"
						: simpleWorktreeCandidate
							? ["removed", "missing"].includes(
									simpleWorktreeCandidate.disposition,
								)
								? "no_candidates"
								: "preserved"
							: managed.length === 0
								? "no_candidates"
								: "preserved",
			vmsReclaimed: reclaimedCount,
			worktreesReclaimed: simpleWorktreesReclaimed,
			unreclaimedSnapshots,
			allocationIntents,
			errors,
			projectLocksReleased: releasedIds.length,
			runId: runId ?? null,
			candidates:
				simpleRun && !recoveryRun?.worktree
					? []
					: simpleWorktreeCandidate
						? [simpleWorktreeCandidate]
						: candidateResults.length > 0
							? candidateResults.map(({ entry, disposition, reason }) => ({
									name: entry.name,
									runId: entry.runId,
									status: entry.status,
									disposition,
									reason,
								}))
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
