import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createMutationIntent,
	executeMutation,
} from "../lifecycle/mutation-protocol.mjs";
import { locksRoot } from "./constants.mjs";
import { LockError } from "./errors.mjs";
import {
	cwdDerivedProjectLockPath,
	moveProjectLockPathToClaim,
	parseOwnedProjectLockBody,
	parseProjectLockArtifact,
	parseRecoveryReservation,
	projectLockArtifacts,
	projectLockClaimPath,
	projectLockPath,
	readTextIfPresent,
	recoveryProofMetadata,
	resolveCanonicalProjectPath,
	unlinkBodyMatched,
} from "./project-lock-files.mjs";
import { classifyRunLiveness } from "./run-liveness.mjs";
import { ensureDir, readRun } from "./run-records.mjs";
import {
	readMutationOperation,
	recordMutationOperation,
	updateRunWithRetry,
} from "./run-updates.mjs";
export async function acquireProjectLock(canonicalProjectPath, runId) {
	canonicalProjectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	await ensureDir(locksRoot(), 0o700);
	const lockPath = projectLockPath(canonicalProjectPath);
	const claimPath = projectLockClaimPath(canonicalProjectPath);
	const historicalLockPath = cwdDerivedProjectLockPath(canonicalProjectPath);
	const historicalClaimPath = `${historicalLockPath}.recovery-claim`;
	const content = JSON.stringify({
		runId,
		createdAt: new Date().toISOString(),
		projectPath: canonicalProjectPath,
		holderPid: process.pid,
	});
	if (
		existsSync(claimPath) ||
		existsSync(historicalLockPath) ||
		existsSync(historicalClaimPath) ||
		(await projectLockArtifacts(canonicalProjectPath)).some(
			(artifact) => artifact.kind !== "lock" || artifact.lockPath !== lockPath,
		)
	) {
		throw new LockError(
			`Project lock recovery is in progress for ${canonicalProjectPath}`,
			{ code: "PROJECT_LOCK_RECOVERY_IN_PROGRESS" },
		);
	}
	try {
		await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
	} catch (e) {
		if (e.code === "EEXIST") {
			let holder = "unknown";
			try {
				const raw = await readFile(lockPath, "utf8");
				holder = JSON.parse(raw).runId;
			} catch {
				// ignore
			}
			throw new LockError(
				`Project lock already held for ${canonicalProjectPath} by ${holder}`,
				{ code: "PROJECT_LOCK_HELD", holderRunId: holder },
			);
		}
		throw e;
	}
	if (
		existsSync(claimPath) ||
		existsSync(historicalLockPath) ||
		existsSync(historicalClaimPath) ||
		(await projectLockArtifacts(canonicalProjectPath)).some(
			(artifact) => artifact.path !== lockPath,
		)
	) {
		await unlinkBodyMatched(lockPath, content);
		throw new LockError(
			`Project lock recovery is in progress for ${canonicalProjectPath}`,
			{ code: "PROJECT_LOCK_RECOVERY_IN_PROGRESS" },
		);
	}
}
export async function releaseProjectLock(canonicalProjectPath, expectedRunId) {
	if (typeof expectedRunId !== "string" || expectedRunId.length === 0) {
		return false;
	}
	return releaseProjectLockIfOwnedBy(canonicalProjectPath, expectedRunId);
}
export async function releaseProjectLockIfOwnedBy(
	canonicalProjectPath,
	expectedRunId,
	options = {},
) {
	if (typeof expectedRunId !== "string" || expectedRunId.length === 0)
		return false;
	if (!options._mutationRaw) {
		const protocol = options.mutationProtocol ?? options.mutation ?? {};
		const operation = protocol.operation ?? "project_lock_release";
		const resource =
			protocol.resource ??
			`lock-${createHash("sha256")
				.update(
					`${resolveCanonicalProjectPath(canonicalProjectPath)}:${expectedRunId}`,
					"utf8",
				)
				.digest("hex")
				.slice(0, 32)}`;
		const policy = protocol.policy ?? {
			maxAttempts: 2,
			idempotency: "idempotent",
			reconcile: true,
		};
		const operationId =
			protocol.operationId ??
			createMutationIntent({ operation, resource, policy }).operationId;
		let resume = protocol.resume ?? null;
		if (!resume) {
			try {
				resume = await readMutationOperation(expectedRunId, operationId);
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		const isIdempotent =
			(protocol.policy?.idempotency ??
				policy?.idempotency ??
				resume?.idempotency) === "idempotent";
		if (resume && resume.state === "uncertain" && isIdempotent) {
			const projectPath = resolveCanonicalProjectPath(canonicalProjectPath);
			const observeIsOwned = async () => {
				if (typeof protocol.observe === "function") {
					const result = await protocol.observe();
					return result?.status !== "confirmed";
				}
				return isProjectLockOwnedBy(projectPath, expectedRunId);
			};

			const owned = await observeIsOwned();
			const persistFn =
				protocol.persist ??
				(async (record) => {
					try {
						await recordMutationOperation(expectedRunId, record);
					} catch (error) {
						if (error?.code !== "ENOENT") throw error;
					}
				});
			const onStatus = protocol.onStatus ?? options.onStatus;

			if (!owned) {
				const completedRecord = Object.freeze({
					...resume,
					state: "completed",
					outcome: "confirmed",
					attempt: (resume.attempt ?? 1) + 1,
					reconciled: true,
					recordedAt: new Date().toISOString(),
				});
				await persistFn(completedRecord);
				onStatus?.({
					phase: "mutation",
					event: "mutation_completed",
					operationId: completedRecord.operationId,
					attempt: completedRecord.attempt,
				});
				return true;
			}

			const artifacts = await projectLockArtifacts(projectPath);
			const ownedArtifacts = artifacts.filter(
				(artifact) => artifact.body?.runId === expectedRunId,
			);

			let holderPid = null;
			for (const artifact of ownedArtifacts) {
				if (artifact.body?.holderPid != null) {
					holderPid = artifact.body.holderPid;
					break;
				}
				const fileName = artifact.claimPath
					? artifact.claimPath.split("/").pop()
					: artifact.path
						? artifact.path.split("/").pop()
						: "";
				const proof = recoveryProofMetadata(fileName);
				if (proof?.ownerPid != null) {
					holderPid = proof.ownerPid;
					break;
				}
			}
			if (holderPid == null) {
				try {
					const run = await readRun(expectedRunId);
					holderPid = run?.workerPid ?? null;
				} catch {
					// ignore
				}
			}

			const isCurrentProcess = holderPid === process.pid;
			const isDead =
				Number.isInteger(holderPid) &&
				holderPid > 0 &&
				classifyRunLiveness({ workerPid: holderPid }, options) === "dead";

			if (isCurrentProcess || isDead) {
				await releaseProjectLockIfOwnedBy(canonicalProjectPath, expectedRunId, {
					...options,
					_mutationRaw: true,
				});
				const stillOwned = await observeIsOwned();
				if (!stillOwned) {
					const completedRecord = Object.freeze({
						...resume,
						state: "completed",
						outcome: "confirmed",
						attempt: (resume.attempt ?? 1) + 1,
						reconciled: true,
						recordedAt: new Date().toISOString(),
					});
					await persistFn(completedRecord);
					onStatus?.({
						phase: "mutation",
						event: "mutation_completed",
						operationId: completedRecord.operationId,
						attempt: completedRecord.attempt,
					});
					return true;
				}
				const uncertainRecord = Object.freeze({
					...resume,
					state: "uncertain",
					outcome: "ambiguous",
					attempt: (resume.attempt ?? 1) + 1,
					recordedAt: new Date().toISOString(),
				});
				await persistFn(uncertainRecord);
				onStatus?.({
					phase: "mutation",
					event: "mutation_postcondition_uncertain",
					operationId: uncertainRecord.operationId,
					attempt: uncertainRecord.attempt,
					status: "uncertain",
				});
				return false;
			}

			// Never release a lock whose holder pid is alive and is not the caller.
			onStatus?.({
				phase: "mutation",
				event: "mutation_postcondition_uncertain",
				operationId: resume.operationId,
				attempt: resume.attempt,
				status: "uncertain",
			});
			return false;
		}
		let releasedValue = false;
		const mutation = await executeMutation({
			...protocol,
			operation,
			resource,
			operationId,
			policy,
			resume,
			command:
				protocol.command ??
				(async () => {
					releasedValue = await releaseProjectLockIfOwnedBy(
						canonicalProjectPath,
						expectedRunId,
						{ ...options, _mutationRaw: true },
					);
					return releasedValue;
				}),
			observe:
				protocol.observe ??
				(async () => {
					const owned = await isProjectLockOwnedBy(
						canonicalProjectPath,
						expectedRunId,
					);
					return owned
						? { status: "ambiguous", ownership: "unknown" }
						: { status: "confirmed", ownership: "confirmed" };
				}),
			persist:
				protocol.persist ??
				(async (record) => {
					try {
						await recordMutationOperation(expectedRunId, record);
					} catch (error) {
						if (error?.code !== "ENOENT") throw error;
					}
				}),
			onStatus: protocol.onStatus ?? options.onStatus,
		});
		return mutation.state === "completed" ? releasedValue : false;
	}
	const projectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	let released = false;
	const recordRemoved = (path) => {
		released = true;
		options.onRemoved?.(path);
	};
	for (const artifact of await projectLockArtifacts(projectPath)) {
		if (artifact.body.runId !== expectedRunId) continue;
		if (artifact.kind === "claim") {
			if (await unlinkBodyMatched(artifact.claimPath, artifact.raw)) {
				recordRemoved(artifact.claimPath);
			}
			continue;
		}
		if (artifact.kind === "reservation") {
			const lockRaw = await readTextIfPresent(artifact.lockPath);
			if (lockRaw !== artifact.reservation.expectedRaw) continue;
			if (!(await unlinkBodyMatched(artifact.claimPath, artifact.raw)))
				continue;
			recordRemoved(artifact.claimPath);
		}
		const raw = await readTextIfPresent(artifact.lockPath);
		if (raw === null) continue;
		const body = parseProjectLockArtifact(
			raw,
			projectPath,
			artifact.lockPath === projectLockPath(projectPath) ||
				artifact.lockPath === cwdDerivedProjectLockPath(projectPath),
		);
		if (!body || body.runId !== expectedRunId) continue;
		const claimed = await moveProjectLockPathToClaim(
			artifact.lockPath,
			`${artifact.lockPath}.recovery-claim`,
			projectPath,
			raw,
		);
		if (claimed) {
			if (await unlinkBodyMatched(claimed.claimPath, claimed.raw)) {
				recordRemoved(artifact.lockPath);
			}
		}
	}
	return released;
}
export async function releaseCwdDerivedProjectLockIfOwnedBy(
	canonicalProjectPath,
	expectedRunId,
	options = {},
) {
	canonicalProjectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	const lockPath = cwdDerivedProjectLockPath(canonicalProjectPath);
	const raw = await readTextIfPresent(lockPath);
	if (raw === null) return false;
	const body = parseOwnedProjectLockBody(raw, canonicalProjectPath);
	if (!body || body.runId !== expectedRunId) return false;
	const claimPath = `${lockPath}.recovery-claim`;
	const claimed = await moveProjectLockPathToClaim(
		lockPath,
		claimPath,
		canonicalProjectPath,
		raw,
	);
	if (!claimed) return false;
	const released = await unlinkBodyMatched(claimed.claimPath, claimed.raw);
	if (released) options.onRemoved?.(lockPath);
	return released;
}
export async function isProjectLockOwnedBy(
	canonicalProjectPath,
	expectedRunId,
) {
	return (await projectLockArtifacts(canonicalProjectPath)).some(
		(artifact) => artifact.body.runId === expectedRunId,
	);
}
async function markClaimCleanupFailure(runId) {
	try {
		await updateRunWithRetry(runId, {
			state: "recovery_required",
			cleanupState: "failed",
		});
	} catch {
		// The caller still rejects execution; persistence failure stays bounded.
	}
}
export function isProjectLockHeld(canonicalProjectPath) {
	const projectPath = resolveCanonicalProjectPath(canonicalProjectPath);
	const canonicalLockPath = projectLockPath(projectPath);
	const historicalLockPath = cwdDerivedProjectLockPath(projectPath);
	if (
		existsSync(canonicalLockPath) ||
		existsSync(projectLockClaimPath(projectPath)) ||
		existsSync(historicalLockPath) ||
		existsSync(`${historicalLockPath}.recovery-claim`)
	) {
		return true;
	}
	try {
		return readdirSync(locksRoot(), { withFileTypes: true }).some((entry) => {
			if (!entry.isFile()) return false;
			const isClaim = entry.name.endsWith(".lock.recovery-claim");
			if (!isClaim && !entry.name.endsWith(".lock")) return false;
			const path = resolve(locksRoot(), entry.name);
			const proof = recoveryProofMetadata(entry.name);
			const originalPath = proof
				? resolve(locksRoot(), proof.originalName)
				: path;
			const lockPath = originalPath.endsWith(".lock.recovery-claim")
				? originalPath.slice(0, -".recovery-claim".length)
				: originalPath;
			const isOwnedPath =
				lockPath === canonicalLockPath || lockPath === historicalLockPath;
			if (isOwnedPath) return true;
			try {
				const raw = readFileSync(path, "utf8");
				if (!isClaim)
					return (
						parseProjectLockArtifact(raw, projectPath, isOwnedPath) !== null
					);
				const reservation = parseRecoveryReservation(raw);
				return reservation
					? parseProjectLockArtifact(
							reservation.expectedRaw,
							projectPath,
							isOwnedPath,
						) !== null
					: parseProjectLockArtifact(raw, projectPath, isOwnedPath) !== null;
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}
export { markClaimCleanupFailure };
