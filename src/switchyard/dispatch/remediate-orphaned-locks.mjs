#!/usr/bin/env node

// One-time, human-confirmed remediation for project locks that
// releaseOrphanedProjectLocks() (run-store/index.mjs) intentionally never
// touches on its own. Per David's CR-4/CR-5 decision (see that function's
// doc comment), the automated scan leaves three categories alone because
// each is a strictly weaker signal than "provably stale":
//   - a lock whose body is not valid JSON
//   - a lock with a valid body but no `projectPath` field (the pre-F.1
//     shape — indistinguishable by body alone from a launch lock)
//   - a lock with a `projectPath` whose runId no longer resolves to any
//     run.json at all
// This script is the deferred human-confirmed step for exactly those cases.
//
// Hard invariant: this script NEVER unlinks a lock by its bare filename or
// from a list computed at some earlier time. Every removal goes through
// the run-store's canonical or body-bound historical ownership-checked release
// path,
// which re-reads the lock file at the moment of deletion and only removes it
// if the recorded runId still matches what was resolved — so a lock
// legitimately reassigned to a new, live run between candidate resolution
// and confirmation is never pulled out from under it. The candidate set
// itself is also always resolved fresh from disk on every invocation, never
// cached or hardcoded.
//
// Usage:
//   node src/switchyard/dispatch/remediate-orphaned-locks.mjs [--dry-run] [--confirm] [--help]
//
//   (no flags)   Interactive: prints the candidate set, then prompts y/n
//                before removing anything.
//   --dry-run    Prints the candidate set and what would be removed. Never
//                unlinks anything, never prompts.
//   --confirm    Skips the interactive prompt and removes every resolved
//                candidate immediately. Must be passed deliberately — never
//                implied by any other flag. Mutually exclusive with
//                --dry-run. Cleanup-failed locks still require an
//                interactive confirmation.
//
// Honors SWITCHYARD_RUN_STORE_ROOT the same way run-store/index.mjs does,
// so it can be pointed at a test fixture root instead of the real
// .logs/switchyard state directory.

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
	getStateRoot,
	readRun,
	reconcileProjectLockClaims,
	releaseCwdDerivedProjectLockIfOwnedBy,
	releaseProjectLockIfOwnedBy,
} from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";

const USAGE = `Usage: node remediate-orphaned-locks.mjs [--dry-run] [--confirm] [--help]

One-time human-confirmed remediation for project locks that
releaseOrphanedProjectLocks() cannot resolve on its own: unparseable-body
locks, locks with no projectPath in their body (pre-F.1 shape), and locks
whose run.json is missing entirely. Recovery claims are also listed; only
valid, bound, provably stale claims are removable.

  --dry-run   Print the candidate set and what would be removed. Never
              unlinks anything, never prompts.
  --confirm   Skip the interactive y/n prompt and remove every resolved
              candidate immediately. Must be passed deliberately. Mutually
              exclusive with --dry-run. Cleanup-failed locks still require
              interactive confirmation.
  --help      Show this help.

With neither flag, runs interactively: prints the candidate set, then asks
for explicit y/n confirmation before removing anything.

Every removal is ownership-checked via the run-store's canonical or body-bound
historical release path, or its recovery-claim reconciler, at the moment of
deletion — never a blind unlink by filename.`;

class UsageError extends Error {}

function parseArgs(argv) {
	let dryRun = false;
	let confirm = false;
	let help = false;
	for (const arg of argv) {
		if (arg === "--dry-run") dryRun = true;
		else if (arg === "--confirm") confirm = true;
		else if (arg === "--help" || arg === "-h") help = true;
		else throw new UsageError(`unknown argument: ${arg}`);
	}
	if (dryRun && confirm) {
		throw new UsageError("--dry-run and --confirm are mutually exclusive");
	}
	return { dryRun, confirm, help };
}

function locksDir() {
	return resolve(getStateRoot(), "locks");
}

// Mirrors run-store/index.mjs's canonical project-lock hashing scheme. The
// namespace is hash input, never a path passed through resolve().
// Read-only: this is used to positively identify a lock, never to derive an
// unlink target directly — every removal still goes through
// releaseProjectLockIfOwnedBy.
function projectLockFileName(canonicalProjectPath) {
	const identity = `project:${resolve(canonicalProjectPath)}`;
	return `${createHash("sha256").update(identity).digest("hex")}.lock`;
}

function cwdDerivedProjectLockFileName(canonicalProjectPath) {
	const historicalKeyPath = resolve(
		canonicalProjectPath,
		`project:${canonicalProjectPath}`,
	);
	return `${createHash("sha256").update(historicalKeyPath).digest("hex")}.lock`;
}

// Mirrors run-store/index.mjs's and dispatch/index.mjs's private
// isWorkerLive: a third independent copy of the same signal-0 kill(2)
// probe. See run-store's comment on releaseOrphanedProjectLocks for why
// these live as separate module-private copies rather than a shared export.
function isWorkerLive(run) {
	if (run.workerPid == null) return false;
	try {
		process.kill(run.workerPid, 0);
		return true;
	} catch (e) {
		// ESRCH => no such process; EPERM => process exists but is not ours.
		return e.code === "EPERM";
	}
}

function isRunStale(run) {
	const terminal = run.state === "succeeded" || run.state === "failed";
	return terminal || !isWorkerLive(run);
}

function isCleanupFailedDeadWorker(run, options = {}) {
	return (
		run?.cleanupState === "failed" &&
		classifyRunLiveness(run, options) === "dead"
	);
}

function baseDescriptor(entry, lockPath, overrides) {
	return {
		name: entry.name,
		path: lockPath,
		ageMs: null,
		createdAt: null,
		runId: null,
		projectPath: null,
		category: "unparseable",
		isCandidate: false,
		reason: "",
		...overrides,
	};
}

function recoveryClaimDescriptor(entry, claimPath, overrides) {
	return baseDescriptor(entry, claimPath, {
		category: "recovery-claim-malformed",
		remediationKind: "recovery-claim",
		claimState: null,
		...overrides,
	});
}

function recoveryClaimLockName(entry) {
	return entry.name.slice(0, -".recovery-claim".length);
}

function isTerminalOrDead(run) {
	const liveness = classifyRunLiveness(run);
	return liveness === "terminal_clean" || liveness === "dead";
}

/**
 * Scan locksRoot() fresh and resolve every lock file into a descriptor the
 * operator can review, positively identifying (and only then flagging as a
 * candidate) locks that releaseOrphanedProjectLocks() leaves untouched.
 *
 * Never mutates anything — this is read-only resolution. Removal happens
 * separately in run(), always re-checked via releaseProjectLockIfOwnedBy at
 * the moment of deletion regardless of what this function returned.
 *
 * @param {object} [dependencies] injected for tests: readRun, locksDir, now
 * @returns {Promise<object[]>} one descriptor per lock file found on disk
 */
export async function resolveCandidates(dependencies = {}) {
	const readRunFn = dependencies.readRun ?? readRun;
	const dir = dependencies.locksDir ?? locksDir();
	const now = dependencies.now ?? Date.now();

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
			const claimBaseName = recoveryClaimLockName(entry);
			const reservation =
				body?.claimState === "reservation" && body?.expectedRaw !== undefined
					? body
					: null;
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
				const expectedBody =
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
				const bound = correspondingLockRaw === reservation.expectedRaw;
				const runProjectMatches =
					typeof run?.projectPath === "string" &&
					resolve(run.projectPath) === resolve(expectedBody.projectPath);
				const stale = runProjectMatches && isTerminalOrDead(run);
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
			let replacementCanonical = null;
			try {
				replacementCanonical = JSON.parse(
					await readFile(
						resolve(dir, projectLockFileName(body.projectPath)),
						"utf8",
					),
				);
			} catch {
				// A missing or malformed canonical lock cannot prove displacement.
			}
			const runProjectMatches =
				typeof run?.projectPath === "string" &&
				resolve(run.projectPath) === resolve(body.projectPath);
			const stale =
				runProjectMatches &&
				(run.cleanupState === "failed"
					? replacementCanonical?.runId !== undefined &&
						replacementCanonical.runId !== body.runId &&
						replacementCanonical.projectPath === body.projectPath
					: isTerminalOrDead(run));
			descriptors.push(
				recoveryClaimDescriptor(entry, lockPath, {
					runId: body.runId,
					projectPath: body.projectPath,
					category: stale
						? "recovery-claim-stale"
						: "recovery-claim-live-or-indeterminate",
					isCandidate: stale,
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
			if (
				run !== null &&
				(typeof run.projectPath !== "string" ||
					resolve(run.projectPath) !== resolve(body.projectPath))
			) {
				descriptors.push(
					baseDescriptor(entry, lockPath, {
						ageMs,
						createdAt,
						runId: body.runId,
						projectPath: body.projectPath,
						category: "project-owner-mismatch",
						reason:
							"lock projectPath does not match its run record — manual evidence only, never touched",
					}),
				);
				continue;
			}
			const canonicalName = projectLockFileName(body.projectPath);
			const cwdDerivedName = cwdDerivedProjectLockFileName(body.projectPath);
			if (run == null) {
				descriptors.push(
					baseDescriptor(entry, lockPath, {
						ageMs,
						createdAt,
						runId: body.runId,
						projectPath: body.projectPath,
						category: "run-missing",
						isCandidate: true,
						reason:
							"projectPath known from lock body; run.json no longer exists — cannot verify liveness independently, human judgment required",
					}),
				);
				continue;
			}

			const cleanupFailed = run.cleanupState === "failed";
			const cwdDerived = cwdDerivedName === entry.name;
			const historical = canonicalName !== entry.name && !cwdDerived;
			const stale = cleanupFailed
				? isCleanupFailedDeadWorker(run, {
						now,
						...(dependencies.probePid
							? { probePid: dependencies.probePid }
							: {}),
					})
				: isRunStale(run);
			descriptors.push(
				baseDescriptor(entry, lockPath, {
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
					reason: stale
						? cleanupFailed
							? `cleanup failed, but the ${cwdDerived ? "cwd-derived" : "canonical"} project lock has a proven dead worker — interactive ownership-safe remediation may remove it`
							: "run is stale (terminal or worker gone) — re-verified fresh at resolution time"
						: cleanupFailed
							? "cleanup failed but worker liveness is live, startup-grace, or indeterminate — retain the canonical lock"
							: "run is live — must not be removed",
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

		const stale = isRunStale(run);
		descriptors.push(
			baseDescriptor(entry, lockPath, {
				ageMs,
				createdAt,
				runId: body.runId,
				projectPath: run.projectPath,
				category: stale ? "project-lock-stale" : "project-lock-live",
				isCandidate: stale,
				remediationKind:
					historicalName === entry.name
						? "cwd-derived-project-lock"
						: "project-lock",
				reason: stale
					? "positively identified as this run's project lock (pre-F.1 body shape) via hash match, and the run is stale"
					: "positively identified as this run's project lock (pre-F.1 body shape) via hash match, but the run is live — must not be removed",
			}),
		);
	}

	return descriptors;
}

function formatAge(ageMs) {
	if (ageMs == null) return "unknown";
	if (ageMs < 0) return "0m (clock skew?)";
	const minutes = ageMs / 60_000;
	if (minutes < 60) return `${Math.round(minutes)}m`;
	const hours = minutes / 60;
	if (hours < 48) return `${hours.toFixed(1)}h`;
	return `${(hours / 24).toFixed(1)}d`;
}

function printTable(log, descriptors) {
	log(`remediate-orphaned-locks: scanned ${descriptors.length} lock file(s)`);
	log("");
	for (const d of descriptors) {
		log(`${d.isCandidate ? "[CANDIDATE]" : "[skip]     "} ${d.name}`);
		log(`    age:         ${formatAge(d.ageMs)}`);
		log(`    runId:       ${d.runId ?? "unknown"}`);
		log(`    projectPath: ${d.projectPath ?? "unrecoverable"}`);
		log(`    category:    ${d.category}`);
		log(`    reason:      ${d.reason}`);
		log("");
	}
}

async function defaultConfirm(promptText) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(promptText);
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}

/**
 * Orchestrate one remediation run: resolve candidates fresh, print them,
 * then — gated on --dry-run / --confirm / interactive y-n — remove exactly
 * the resolved candidates, each ownership-checked at the moment of removal.
 *
 * Exported for tests; the CLI entry point below wires this to real stdio
 * and process.exitCode.
 *
 * @param {string[]} argv
 * @param {object} [dependencies] injected for tests: resolveCandidates,
 *   releaseProjectLockIfOwnedBy, confirmFn, log
 * @returns {Promise<{exitCode: number, removed: string[], candidates: object[]}>}
 */
export async function run(argv, dependencies = {}) {
	const log = dependencies.log ?? console.log;
	const resolveFn = dependencies.resolveCandidates ?? resolveCandidates;
	const releaseFn =
		dependencies.releaseProjectLockIfOwnedBy ?? releaseProjectLockIfOwnedBy;
	const releaseCwdDerivedFn =
		dependencies.releaseCwdDerivedProjectLockIfOwnedBy ??
		releaseCwdDerivedProjectLockIfOwnedBy;
	const reconcileFn =
		dependencies.reconcileProjectLockClaims ?? reconcileProjectLockClaims;
	const confirmFn = dependencies.confirmFn ?? defaultConfirm;

	let opts;
	try {
		opts = parseArgs(argv);
	} catch (e) {
		if (e instanceof UsageError) {
			log(`remediate-orphaned-locks: ${e.message}`);
			log(USAGE);
			return { exitCode: 2, removed: [], candidates: [] };
		}
		throw e;
	}

	if (opts.help) {
		log(USAGE);
		return { exitCode: 0, removed: [], candidates: [] };
	}

	// Always resolved fresh, right here, on every invocation — never a list
	// computed earlier and passed in.
	const descriptors = await resolveFn(dependencies);
	printTable(log, descriptors);

	const candidates = descriptors.filter((d) => d.isCandidate);

	if (candidates.length === 0) {
		log("remediate-orphaned-locks: no candidates to remove.");
		return { exitCode: 0, removed: [], candidates: descriptors };
	}

	if (opts.dryRun) {
		log(
			`remediate-orphaned-locks: DRY RUN — would attempt to remove ${candidates.length} candidate lock(s):`,
		);
		for (const c of candidates) {
			log(`  - ${c.name} (runId=${c.runId}, projectPath=${c.projectPath})`);
		}
		log("remediate-orphaned-locks: dry run — nothing removed.");
		return { exitCode: 0, removed: [], candidates: descriptors };
	}

	if (
		!opts.confirm ||
		candidates.some((c) => c.requiresInteractiveConfirmation)
	) {
		const proceed = await confirmFn(
			`remediate-orphaned-locks: remove ${candidates.length} candidate lock(s) listed above? [y/N] `,
		);
		if (!proceed) {
			log("remediate-orphaned-locks: confirmation declined — nothing removed.");
			return { exitCode: 0, removed: [], candidates: descriptors };
		}
	}

	const removed = [];
	const claimCandidates = candidates.filter(
		(candidate) => candidate.remediationKind === "recovery-claim",
	);
	const claimExisted = new Map(
		claimCandidates.map((candidate) => [
			candidate.name,
			existsSync(candidate.path),
		]),
	);
	if (claimCandidates.length > 0) {
		// Reconcile the claim set once. The run-store pass re-checks every
		// candidate's claim, canonical bytes, and liveness; this avoids a first
		// claim's reconciliation changing the result accounting for its peers.
		try {
			await reconcileFn();
		} catch (e) {
			log(
				`remediate-orphaned-locks: error reconciling recovery claims: ${e.message}`,
			);
		}
	}
	for (const c of candidates) {
		if (c.remediationKind === "recovery-claim") {
			// Reconcile re-read and validated the complete claim set above. It
			// never accepts the earlier descriptor as authority or unlinks by
			// filename.
			if (claimExisted.get(c.name) && !existsSync(c.path)) {
				removed.push(c.name);
				log(`remediate-orphaned-locks: removed ${c.name}`);
			} else {
				log(
					`remediate-orphaned-locks: skipped ${c.name} — claim changed, remains live, or is no longer safely removable`,
				);
			}
			continue;
		}
		if (c.requiresDeadWorkerRecheck) {
			let currentRun = null;
			try {
				currentRun = await (dependencies.readRun ?? readRun)(c.runId);
			} catch {
				// Missing cleanup state is ambiguous, so it is not removable.
			}
			if (
				!isCleanupFailedDeadWorker(currentRun, {
					now: dependencies.now ?? Date.now(),
					...(dependencies.probePid ? { probePid: dependencies.probePid } : {}),
				})
			) {
				log(
					`remediate-orphaned-locks: skipped ${c.name} — cleanup-failed worker is no longer proven dead`,
				);
				continue;
			}
		}
		// Ownership-checked at the moment of removal, never a blind unlink by
		// filename: both release helpers re-read the lock file fresh and only
		// delete if the recorded runId still matches what we resolved above.
		// If this project's lock was reassigned to a new, live run between
		// resolution and this call, that read returns a different runId and
		// the delete is a safe no-op.
		let didRelease = false;
		try {
			didRelease =
				c.remediationKind === "cwd-derived-project-lock"
					? await releaseCwdDerivedFn(c.projectPath, c.runId)
					: await releaseFn(c.projectPath, c.runId);
		} catch (e) {
			log(`remediate-orphaned-locks: error releasing ${c.name}: ${e.message}`);
		}
		if (didRelease) {
			removed.push(c.name);
			log(`remediate-orphaned-locks: removed ${c.name} (runId=${c.runId})`);
		} else {
			log(
				`remediate-orphaned-locks: skipped ${c.name} — no longer owned by ${c.runId} (reassigned since resolution, or already released)`,
			);
		}
	}

	log(
		`remediate-orphaned-locks: done — removed ${removed.length}/${candidates.length} candidate(s).`,
	);
	return { exitCode: 0, removed, candidates: descriptors };
}

const entrypointPath = process.argv[1];
if (
	typeof entrypointPath === "string" &&
	import.meta.url === pathToFileURL(realpathSync(entrypointPath)).href
) {
	try {
		const result = await run(process.argv.slice(2));
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error(`remediate-orphaned-locks: aborted: ${error.message}`);
		process.exitCode = 1;
	}
}
