import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { locksRoot } from "./constants.mjs";
import { LockError } from "./errors.mjs";
import {
	cwdDerivedProjectLockPath,
	moveProjectLockPathToClaim,
	parseLegacyProjectLockBody,
	parseProjectLockArtifact,
	parseProjectLockBody,
	parseRecoveryReservation,
	projectLockArtifacts,
	projectLockPath,
	readTextIfPresent,
	recoveryProofMetadata,
	resolveCanonicalProjectPath,
	unlinkBodyMatched,
} from "./project-lock-files.mjs";
import {
	markClaimCleanupFailure,
	releaseProjectLockIfOwnedBy,
} from "./project-locks.mjs";
import { classifyRunLiveness } from "./run-liveness.mjs";
import { readRun } from "./run-records.mjs";
import { vmOwnerIsLive } from "./vm-slots.mjs";
export async function assertProjectLockOwnership(
	canonicalProjectPath,
	runId,
	options = {},
) {
	const unlinkMatched = options.unlinkBodyMatched ?? unlinkBodyMatched;
	await reconcileProjectLockClaims();
	const projectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	const artifacts = await projectLockArtifacts(projectPath);
	const claimArtifact = artifacts.find(
		(artifact) => artifact.kind === "claim" || artifact.kind === "reservation",
	);
	if (claimArtifact) {
		if (claimArtifact.kind === "reservation") {
			throw new LockError("Project lock recovery claim blocks execution", {
				code: "PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
			});
		}
		const lockPath = claimArtifact.lockPath;
		const claimPath = claimArtifact.claimPath;
		const claimRaw = claimArtifact.raw;
		const claimBody = claimArtifact.body;
		if (claimBody?.runId === runId) {
			const restoredBody = JSON.stringify({
				...claimBody,
				holderPid: process.pid,
			});
			try {
				await writeFile(lockPath, restoredBody, { flag: "wx", mode: 0o600 });
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				try {
					const removed = await unlinkMatched(claimPath, claimRaw);
					if (!removed) throw new Error("claim changed");
				} catch {
					await markClaimCleanupFailure(runId);
					throw new LockError("Project lock claim cleanup failed", {
						code: "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
					});
				}
				throw new LockError("Project lock ownership was displaced", {
					code: "PROJECT_LOCK_OWNERSHIP_DISPLACED",
				});
			}
			try {
				const removed = await unlinkMatched(claimPath, claimRaw);
				if (!removed) throw new Error("claim changed");
			} catch {
				await unlinkBodyMatched(lockPath, restoredBody).catch(() => false);
				await markClaimCleanupFailure(runId);
				throw new LockError("Project lock claim cleanup failed", {
					code: "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
				});
			}
			return true;
		}
		throw new LockError("Project lock recovery claim blocks execution", {
			code: "PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
		});
	}

	const lockArtifact = artifacts.find((artifact) => artifact.kind === "lock");
	const lockPath = lockArtifact?.lockPath ?? projectLockPath(projectPath);
	const claimPath = `${lockPath}.recovery-claim`;
	const raw = lockArtifact?.raw ?? (await readTextIfPresent(lockPath));
	const body =
		raw === null
			? null
			: parseProjectLockArtifact(
					raw,
					projectPath,
					lockPath === projectLockPath(projectPath) ||
						lockPath === cwdDerivedProjectLockPath(projectPath),
				);
	if (!body || body.runId !== runId) {
		throw new LockError("Project lock ownership assertion failed", {
			code: "PROJECT_LOCK_OWNERSHIP_FAILED",
		});
	}
	if (body.holderPid === process.pid) return true;

	const claimed = await moveProjectLockPathToClaim(
		lockPath,
		claimPath,
		projectPath,
		raw,
	);
	if (!claimed) {
		throw new LockError("Project lock ownership assertion failed", {
			code: "PROJECT_LOCK_OWNERSHIP_FAILED",
		});
	}
	const refreshedRaw = JSON.stringify({ ...body, holderPid: process.pid });
	try {
		await writeFile(lockPath, refreshedRaw, { flag: "wx", mode: 0o600 });
	} catch (error) {
		try {
			const removed = await unlinkMatched(claimed.claimPath, claimed.raw);
			if (!removed) throw new Error("claim changed");
		} catch {
			await markClaimCleanupFailure(runId);
			throw new LockError("Project lock claim cleanup failed", {
				code: "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
			});
		}
		if (error.code === "EEXIST") {
			throw new LockError("Project lock ownership was displaced", {
				code: "PROJECT_LOCK_OWNERSHIP_DISPLACED",
			});
		}
		throw error;
	}
	try {
		const removed = await unlinkMatched(claimed.claimPath, claimed.raw);
		if (!removed) throw new Error("claim changed");
	} catch {
		await unlinkBodyMatched(lockPath, refreshedRaw).catch(() => false);
		await markClaimCleanupFailure(runId);
		throw new LockError("Project lock claim cleanup failed", {
			code: "PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
		});
	}
	return true;
}
export async function reconcileProjectLockClaims(options = {}) {
	let entries;
	try {
		entries = await readdir(locksRoot(), { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const reclaimed = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".lock.recovery-claim")) {
			continue;
		}
		const proof = recoveryProofMetadata(entry.name);
		if (proof !== null && vmOwnerIsLive(proof.ownerPid, options.probePid))
			continue;
		const claimPath = resolve(locksRoot(), entry.name);
		const originalPath = proof
			? resolve(locksRoot(), proof.originalName)
			: claimPath;
		const lockPath = originalPath.endsWith(".lock.recovery-claim")
			? originalPath.slice(0, -".recovery-claim".length)
			: originalPath;
		const raw = await readTextIfPresent(claimPath).catch(() => null);
		if (raw === null) continue;
		const reservation = parseRecoveryReservation(raw);
		if (reservation) {
			let parsedOwnerBody = parseProjectLockBody(reservation.expectedRaw);
			if (!parsedOwnerBody?.projectPath) {
				const legacyBody = parseLegacyProjectLockBody(reservation.expectedRaw);
				if (legacyBody) {
					try {
						const legacyRun = await readRun(legacyBody.runId);
						const projectPath = resolveCanonicalProjectPath(
							legacyRun.projectPath,
						);
						if (
							lockPath === projectLockPath(projectPath) ||
							lockPath === cwdDerivedProjectLockPath(projectPath)
						) {
							parsedOwnerBody = { ...legacyBody, projectPath };
						}
					} catch {
						// Missing or malformed run evidence cannot bind a legacy proof.
					}
				}
			}
			if (!parsedOwnerBody?.projectPath) continue;
			const canonicalRaw = await readTextIfPresent(lockPath).catch(() => null);
			// An ordinary reservation may still coordinate an active recoverer, so
			// its lock bytes must match. A PID-bearing proof is the atomically taken
			// reservation itself; once that PID is dead, a mismatch means the
			// cleanup path was interrupted and the proof can be reconciled safely.
			if (!proof && canonicalRaw !== reservation.expectedRaw) continue;
			let run;
			try {
				run = await readRun(parsedOwnerBody.runId);
			} catch {
				continue;
			}
			if (
				typeof run.projectPath !== "string" ||
				resolveCanonicalProjectPath(run.projectPath) !==
					resolveCanonicalProjectPath(parsedOwnerBody.projectPath)
			) {
				continue;
			}
			if (run.cleanupState === "failed") {
				if (!options.allowCleanupFailedDead) continue;
				const liveness = classifyRunLiveness(run, {
					...(options.now !== undefined ? { now: options.now } : {}),
					...(options.probePid ? { probePid: options.probePid } : {}),
				});
				if (liveness !== "dead") continue;
			} else {
				const liveness = classifyRunLiveness(run, {
					...(options.now !== undefined ? { now: options.now } : {}),
					...(options.probePid ? { probePid: options.probePid } : {}),
				});
				if (liveness !== "terminal_clean" && liveness !== "dead") continue;
			}
			try {
				if (await unlinkBodyMatched(claimPath, raw)) {
					reclaimed.push(parsedOwnerBody.runId);
					options.onRemoved?.(claimPath);
				}
			} catch {
				// One attempt per claim. A later reconciliation may retry it.
			}
			continue;
		}
		let parsedBody = parseProjectLockBody(raw);
		if (!parsedBody?.projectPath) {
			const legacyBody = parseLegacyProjectLockBody(raw);
			if (legacyBody) {
				try {
					const legacyRun = await readRun(legacyBody.runId);
					const projectPath = resolveCanonicalProjectPath(
						legacyRun.projectPath,
					);
					if (
						lockPath === projectLockPath(projectPath) ||
						lockPath === cwdDerivedProjectLockPath(projectPath)
					) {
						parsedBody = { ...legacyBody, projectPath };
					}
				} catch {
					// Missing or malformed run evidence cannot bind a legacy proof.
				}
			}
		}
		if (!parsedBody?.projectPath) continue;
		let run;
		try {
			run = await readRun(parsedBody.runId);
		} catch {
			continue;
		}
		if (
			typeof run.projectPath !== "string" ||
			resolveCanonicalProjectPath(run.projectPath) !==
				resolveCanonicalProjectPath(parsedBody.projectPath)
		) {
			continue;
		}
		if (run.cleanupState === "failed") {
			if (options.allowCleanupFailedDead) {
				const liveness = classifyRunLiveness(run, {
					...(options.now !== undefined ? { now: options.now } : {}),
					...(options.probePid ? { probePid: options.probePid } : {}),
				});
				if (liveness !== "dead") continue;
			} else {
				const replacement = (
					await projectLockArtifacts(parsedBody.projectPath)
				).find(
					(artifact) =>
						artifact.kind === "lock" &&
						artifact.lockPath === projectLockPath(parsedBody.projectPath) &&
						artifact.body.runId !== parsedBody.runId,
				);
				if (!replacement) continue;
			}
		} else {
			const liveness = classifyRunLiveness(run, {
				...(options.now !== undefined ? { now: options.now } : {}),
				...(options.probePid ? { probePid: options.probePid } : {}),
			});
			if (liveness !== "terminal_clean" && liveness !== "dead") continue;
		}
		try {
			if (await unlinkBodyMatched(claimPath, raw)) {
				reclaimed.push(parsedBody.runId);
				options.onRemoved?.(claimPath);
			}
		} catch {
			// One attempt per claim. A later reconciliation may retry it.
		}
	}
	return reclaimed;
}
export async function releaseOrphanedProjectLocks() {
	const reclaimedClaims = await reconcileProjectLockClaims();
	let entries;
	try {
		entries = await readdir(locksRoot(), { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return reclaimedClaims;
		throw e;
	}

	const reclaimed = [...reclaimedClaims];

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;

		const lockPath = resolve(locksRoot(), entry.name);
		let body;
		try {
			const raw = await readFile(lockPath, "utf8");
			body = JSON.parse(raw);
		} catch {
			// Unparseable body: never touched, regardless of age. See the
			// scope note in this function's doc comment.
			continue;
		}

		if (
			body === null ||
			typeof body !== "object" ||
			typeof body.projectPath !== "string"
		) {
			// Parseable but no projectPath: a launch lock. Left untouched
			// permanently — see the scope note in this function's doc comment.
			continue;
		}

		let run;
		try {
			run = await readRun(body.runId);
		} catch {
			// The run no longer exists at all: a strictly weaker signal than
			// a resolvable-but-dead run, so this cannot be proven stale.
			// "Cannot identify, leave alone" per CR-4/CR-5 — see the doc
			// comment above. Deferred to F.3's manual remediation.
			continue;
		}
		if (
			typeof run.projectPath !== "string" ||
			resolveCanonicalProjectPath(run.projectPath) !==
				resolveCanonicalProjectPath(body.projectPath)
		) {
			continue;
		}

		if (run.cleanupState === "failed") continue;
		const liveness = classifyRunLiveness(run);
		if (liveness !== "terminal_clean" && liveness !== "dead") continue;

		try {
			const didRelease = await releaseProjectLockIfOwnedBy(
				body.projectPath,
				body.runId,
			);
			if (didRelease) reclaimed.push(body.runId);
		} catch {
			// Best-effort; leave the lock for a future scan rather than throw
			// and abandon the rest of the sweep.
		}
	}

	return reclaimed;
}
