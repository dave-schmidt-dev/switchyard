import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRun } from "../run-store/index.mjs";
import {
	baseDescriptor,
	bindLegacyRecoveryOwner,
	cwdDerivedProjectLockFileName,
	isCleanupFailedDeadWorker,
	isPidProvenDead,
	isRunStale,
	isTerminalOrDead,
	locksDir,
	projectLockFileName,
	recoveryClaimDescriptor,
	recoveryClaimLockName,
	recoveryProofMetadata,
} from "./remediate-orphaned-locks-support.mjs";
export async function resolveCandidates(dependencies = {}) {
	const readRunFn = dependencies.readRun ?? readRun;
	const dir = dependencies.locksDir ?? locksDir();
	const now = dependencies.now ?? Date.now();
	const livenessOptions = {
		now,
		...(dependencies.probePid ? { probePid: dependencies.probePid } : {}),
	};

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}

	const descriptors = [];

	for (const entry of entries) {
		const isRecoveryClaim = entry.name.endsWith(".lock.recovery-claim");
		if (!entry.isFile() || (!entry.name.endsWith(".lock") && !isRecoveryClaim))
			continue;
		const lockPath = resolve(dir, entry.name);

		let raw;
		try {
			raw = await readFile(lockPath, "utf8");
		} catch {
			// Vanished between readdir and readFile (another actor already
			// cleaned it up, or a live acquire/release raced the scan) —
			// nothing to report.
			continue;
		}
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			if (isRecoveryClaim) {
				descriptors.push(
					recoveryClaimDescriptor(entry, lockPath, {
						reason:
							"recovery claim body is not valid JSON — manual evidence only, never touched",
					}),
				);
				continue;
			}
			descriptors.push(
				baseDescriptor(entry, lockPath, {
					reason: "lock body is not valid JSON — cannot resolve, never touched",
				}),
			);
			continue;
		}

		if (isRecoveryClaim) {
			const proof = recoveryProofMetadata(entry.name);
			if (proof && !isPidProvenDead(proof.ownerPid, dependencies.probePid)) {
				descriptors.push(
					recoveryClaimDescriptor(entry, lockPath, {
						category: "recovery-claim-proof-live",
						reason:
							"recovery proof owner is still live — retain as active recovery evidence",
					}),
				);
				continue;
			}
			const claimBaseName = recoveryClaimLockName(entry);
			const reservation =
				body?.claimState === "reservation" && body?.expectedRaw !== undefined
					? body
					: null;
			if (reservation === null) {
				body = await bindLegacyRecoveryOwner(body, claimBaseName, readRunFn);
			}
			if (
				reservation === null &&
				(body === null ||
					typeof body !== "object" ||
					Array.isArray(body) ||
					typeof body.runId !== "string" ||
					typeof body.projectPath !== "string")
			) {
				descriptors.push(
					recoveryClaimDescriptor(entry, lockPath, {
						reason:
							"recovery claim is malformed or lacks bound owner/project data — manual evidence only, never touched",
					}),
				);
				continue;
			}

			if (reservation !== null) {
				let expectedBody =
					typeof reservation.expectedRaw === "string"
						? (() => {
								try {
									const parsed = JSON.parse(reservation.expectedRaw);
									return parsed &&
										typeof parsed === "object" &&
										!Array.isArray(parsed)
										? parsed
										: null;
								} catch {
									return null;
								}
							})()
						: null;
				expectedBody = await bindLegacyRecoveryOwner(
					expectedBody,
					claimBaseName,
					readRunFn,
				);
				if (
					reservation.claimState !== "reservation" ||
					typeof reservation.expectedRaw !== "string" ||
					Object.keys(reservation).some(
						(key) => !["claimState", "expectedRaw"].includes(key),
					) ||
					!expectedBody ||
					typeof expectedBody.runId !== "string" ||
					typeof expectedBody.projectPath !== "string" ||
					(projectLockFileName(expectedBody.projectPath) !== claimBaseName &&
						cwdDerivedProjectLockFileName(expectedBody.projectPath) !==
							claimBaseName &&
						(await readFile(resolve(dir, claimBaseName), "utf8").catch(
							() => null,
						)) !== reservation.expectedRaw)
				) {
					descriptors.push(
						recoveryClaimDescriptor(entry, lockPath, {
							claimState: "reservation",
							runId: expectedBody?.runId ?? null,
							projectPath: expectedBody?.projectPath ?? null,
							reason:
								"recovery reservation is malformed or not bound to its canonical project lock — manual evidence only, never touched",
						}),
					);
					continue;
				}

				let run = null;
				try {
					run = await readRunFn(expectedBody.runId);
				} catch {
					run = null;
				}
				const correspondingLockPath = resolve(dir, claimBaseName);
				let correspondingLockRaw = null;
				try {
					correspondingLockRaw = await readFile(correspondingLockPath, "utf8");
				} catch {
					// Missing or unreadable corresponding evidence is not removable.
				}
				const bound =
					proof !== null || correspondingLockRaw === reservation.expectedRaw;
				const runProjectMatches =
					typeof run?.projectPath === "string" &&
					resolve(run.projectPath) === resolve(expectedBody.projectPath);
				const cleanupFailed = run?.cleanupState === "failed";
				const stale =
					runProjectMatches &&
					(cleanupFailed
						? isCleanupFailedDeadWorker(run, {
								now,
								...(dependencies.probePid
									? { probePid: dependencies.probePid }
									: {}),
							})
						: isTerminalOrDead(run, livenessOptions));
				descriptors.push(
					recoveryClaimDescriptor(entry, lockPath, {
						claimState: "reservation",
						runId: expectedBody.runId,
						projectPath: expectedBody.projectPath,
						category:
							bound && stale
								? "recovery-claim-reservation-stale"
								: "recovery-claim-reservation-blocked",
						isCandidate: bound && stale,
						requiresInteractiveConfirmation: cleanupFailed && bound && stale,
						requiresDeadWorkerRecheck: cleanupFailed && bound && stale,
						reason:
							bound && stale
								? "reservation is byte-bound to the canonical lock and its run is terminal/dead — ownership-safe remediation may reconcile it"
								: "reservation is changed, live, missing, or indeterminate — retain as manual evidence",
					}),
				);
				continue;
			}

			let run = null;
			try {
				run = await readRunFn(body.runId);
			} catch {
				run = null;
			}
			const runProjectMatches =
				typeof run?.projectPath === "string" &&
				resolve(run.projectPath) === resolve(body.projectPath);
			const cleanupFailed = run?.cleanupState === "failed";
			const stale =
				runProjectMatches &&
				(cleanupFailed
					? isCleanupFailedDeadWorker(run, {
							now,
							...(dependencies.probePid
								? { probePid: dependencies.probePid }
								: {}),
						})
					: isTerminalOrDead(run, livenessOptions));
			descriptors.push(
				recoveryClaimDescriptor(entry, lockPath, {
					runId: body.runId,
					projectPath: body.projectPath,
					category: stale
						? "recovery-claim-stale"
						: "recovery-claim-live-or-indeterminate",
					isCandidate: stale,
					requiresInteractiveConfirmation: cleanupFailed && stale,
					requiresDeadWorkerRecheck: cleanupFailed && stale,
					reason: stale
						? "recovery claim is bound to its project lock and its run is terminal/dead — ownership-safe remediation may reconcile it"
						: "recovery claim run is live, missing, or indeterminate — retain as manual evidence",
				}),
			);
			continue;
		}

		if (
			body === null ||
			typeof body !== "object" ||
			typeof body.runId !== "string"
		) {
			descriptors.push(
				baseDescriptor(entry, lockPath, {
					category: "malformed",
					createdAt:
						typeof body?.createdAt === "string" ? body.createdAt : null,
					reason: "lock body has no runId — cannot resolve, never touched",
				}),
			);
			continue;
		}

		const createdAt =
			typeof body.createdAt === "string" ? body.createdAt : null;
		const ageMs = createdAt ? now - new Date(createdAt).getTime() : null;

		if (typeof body.projectPath === "string") {
			// Post-F.1 shape: the lock body self-describes its projectPath. If
			// releaseOrphanedProjectLocks left this one alone, the only
			// remaining gap it defers is a missing run.json — a stale-and-
			// resolvable run would already have been reclaimed automatically.
			let run = null;
			try {
				run = await readRunFn(body.runId);
			} catch {
				run = null;
			}
			descriptors.push(
				classifyBoundProjectLock({
					name: entry.name,
					path: lockPath,
					body,
					run,
					ageMs,
					createdAt,
					livenessOptions,
				}),
			);
			continue;
		}

		// Pre-F.1 shape: body has no projectPath, indistinguishable by shape
		// alone from a launch lock. Attempt recovery via the run's own
		// projectPath field (run.json has always recorded this, independent
		// of F.1's lock-body addition).
		let run = null;
		try {
			run = await readRunFn(body.runId);
		} catch {
			run = null;
		}

		if (run == null || typeof run.projectPath !== "string") {
			descriptors.push(
				baseDescriptor(entry, lockPath, {
					ageMs,
					createdAt,
					runId: body.runId,
					category: "unrecoverable",
					reason:
						"no projectPath in lock body and run.json is missing or has no projectPath — cannot safely resolve, never touched",
				}),
			);
			continue;
		}

		const expectedName = projectLockFileName(run.projectPath);
		const historicalName = cwdDerivedProjectLockFileName(run.projectPath);
		if (expectedName !== entry.name && historicalName !== entry.name) {
			// This lock's filename does not hash-match the recovered run's
			// project path, so it is not that run's project lock — most
			// likely this run's launch lock instead (same {runId, createdAt}
			// body shape, different path). Never a candidate.
			descriptors.push(
				baseDescriptor(entry, lockPath, {
					ageMs,
					createdAt,
					runId: body.runId,
					category: "not-a-project-lock",
					reason:
						"recovered run does not own this lock filename (hash mismatch) — likely a launch lock, never touched",
				}),
			);
			continue;
		}

		const cleanupFailed = run.cleanupState === "failed";
		const stale = cleanupFailed
			? isCleanupFailedDeadWorker(run, livenessOptions)
			: isRunStale(run, livenessOptions);
		descriptors.push(
			baseDescriptor(entry, lockPath, {
				ageMs,
				createdAt,
				runId: body.runId,
				projectPath: run.projectPath,
				category: cleanupFailed
					? stale
						? "project-lock-cleanup-failed-dead"
						: "project-lock-cleanup-failed-retained"
					: stale
						? "project-lock-stale"
						: "project-lock-live",
				isCandidate: stale,
				remediationKind:
					historicalName === entry.name
						? "cwd-derived-project-lock"
						: "project-lock",
				requiresInteractiveConfirmation: cleanupFailed && stale,
				requiresDeadWorkerRecheck: cleanupFailed && stale,
				requiresLivenessRecheck:
					!cleanupFailed &&
					stale &&
					run.state !== "succeeded" &&
					run.state !== "failed" &&
					run.state !== "deferred",
				reason: stale
					? cleanupFailed
						? "pre-F.1 project lock belongs to a cleanup-failed run with a proven dead worker — interactive ownership-safe remediation may remove it"
						: "positively identified as this run's project lock (pre-F.1 body shape) via hash match, and the run is stale"
					: cleanupFailed
						? "pre-F.1 cleanup-failed project lock has a live, startup-grace, or indeterminate worker — retain it"
						: "positively identified as this run's project lock (pre-F.1 body shape) via hash match, but the run is live — must not be removed",
			}),
		);
	}

	return descriptors;
}

/**
 * Classify one post-F.1 project lock (its body names `projectPath`) against
 * its run record. Pure: no I/O; the caller reads the run (or passes `null`
 * when run.json is missing). Shared by the remediation scan and the
 * acquire-time dead-holder reclaim so both apply one rule set.
 *
 * @param {object} input
 * @param {string} input.name lock file name
 * @param {string} input.path lock file path
 * @param {{runId: string, projectPath: string}} input.body parsed lock body
 * @param {object|null} input.run run record, or null when run.json is missing
 * @param {number|null} [input.ageMs]
 * @param {string|null} [input.createdAt]
 * @param {object} [input.livenessOptions] `{ now, probePid }` for liveness
 * @returns {object} remediation descriptor
 */
export function classifyBoundProjectLock({
	name,
	path,
	body,
	run,
	ageMs = null,
	createdAt = null,
	livenessOptions = {},
}) {
	const entry = { name };
	if (
		run !== null &&
		(typeof run.projectPath !== "string" ||
			resolve(run.projectPath) !== resolve(body.projectPath))
	) {
		return baseDescriptor(entry, path, {
			ageMs,
			createdAt,
			runId: body.runId,
			projectPath: body.projectPath,
			category: "project-owner-mismatch",
			reason:
				"lock projectPath does not match its run record — manual evidence only, never touched",
		});
	}
	const canonicalName = projectLockFileName(body.projectPath);
	const cwdDerivedName = cwdDerivedProjectLockFileName(body.projectPath);
	if (run == null) {
		return baseDescriptor(entry, path, {
			ageMs,
			createdAt,
			runId: body.runId,
			projectPath: body.projectPath,
			category: "run-missing",
			isCandidate: true,
			remediationKind:
				cwdDerivedName === entry.name
					? "cwd-derived-project-lock"
					: canonicalName === entry.name
						? "project-lock"
						: "historical-project-lock",
			requiresInteractiveConfirmation: true,
			reason:
				"projectPath known from lock body; run.json no longer exists — cannot verify liveness independently, human judgment required",
		});
	}

	const cleanupFailed = run.cleanupState === "failed";
	const cwdDerived = cwdDerivedName === entry.name;
	const historical = canonicalName !== entry.name && !cwdDerived;
	const stale = cleanupFailed
		? isCleanupFailedDeadWorker(run, livenessOptions)
		: isRunStale(run, livenessOptions);
	return baseDescriptor(entry, path, {
		ageMs,
		createdAt,
		runId: body.runId,
		projectPath: body.projectPath,
		category: cleanupFailed
			? stale
				? "project-lock-cleanup-failed-dead"
				: "project-lock-cleanup-failed-retained"
			: stale
				? "project-lock-stale"
				: "project-lock-live",
		isCandidate: stale,
		remediationKind: cwdDerived
			? "cwd-derived-project-lock"
			: historical
				? "historical-project-lock"
				: "project-lock",
		requiresInteractiveConfirmation: cleanupFailed && stale,
		requiresDeadWorkerRecheck: cleanupFailed && stale,
		requiresLivenessRecheck:
			!cleanupFailed &&
			stale &&
			run.state !== "succeeded" &&
			run.state !== "failed" &&
			run.state !== "deferred",
		reason: stale
			? cleanupFailed
				? `cleanup failed, but the ${cwdDerived ? "cwd-derived" : "canonical"} project lock has a proven dead worker — interactive ownership-safe remediation may remove it`
				: "run is stale (terminal or worker gone) — re-verified fresh at resolution time"
			: cleanupFailed
				? "cleanup failed but worker liveness is live, startup-grace, or indeterminate — retain the canonical lock"
				: "run is live — must not be removed",
	});
}
