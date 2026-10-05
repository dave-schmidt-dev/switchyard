import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
	isProjectLockOwnedBy,
	readRun,
	reconcileProjectLockClaims,
	releaseCwdDerivedProjectLockIfOwnedBy,
	releaseProjectLockIfOwnedBy,
} from "../run-store/index.mjs";
import { classifyRunLiveness } from "../run-store/run-liveness.mjs";

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
	const isOwnedFn = dependencies.isProjectLockOwnedBy ?? isProjectLockOwnedBy;

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
	const removedNames = new Set();
	const candidateByPath = new Map(
		candidates.map((candidate) => [resolve(candidate.path), candidate]),
	);
	const recordRemovedPath = (path, suffix = "") => {
		const candidate = candidateByPath.get(resolve(path));
		if (!candidate || removedNames.has(candidate.name)) return;
		removedNames.add(candidate.name);
		removed.push(candidate.name);
		log(`remediate-orphaned-locks: removed ${candidate.name}${suffix}`);
	};
	const claimCandidates = candidates.filter(
		(candidate) => candidate.remediationKind === "recovery-claim",
	);
	if (claimCandidates.length > 0) {
		// Reconcile the claim set once. The run-store pass re-checks every
		// candidate's claim, canonical bytes, and liveness; this avoids a first
		// claim's reconciliation changing the result accounting for its peers.
		try {
			await reconcileFn({
				onRemoved: recordRemovedPath,
				allowCleanupFailedDead: true,
				now: dependencies.now ?? Date.now(),
				...(dependencies.probePid ? { probePid: dependencies.probePid } : {}),
			});
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
			if (removedNames.has(c.name)) continue;
			if (c.requiresDeadWorkerRecheck) {
				let currentRun = null;
				try {
					currentRun = await (dependencies.readRun ?? readRun)(c.runId);
				} catch {
					// Missing recovery evidence is ambiguous, so it is not removable.
				}
				if (
					!isCleanupFailedDeadWorker(currentRun, {
						now: dependencies.now ?? Date.now(),
						...(dependencies.probePid
							? { probePid: dependencies.probePid }
							: {}),
					}) ||
					typeof currentRun?.projectPath !== "string" ||
					resolve(currentRun.projectPath) !== resolve(c.projectPath)
				) {
					log(
						`remediate-orphaned-locks: skipped ${c.name} — cleanup-failed worker is no longer proven dead`,
					);
					continue;
				}
				try {
					await releaseFn(c.projectPath, c.runId, {
						onRemoved: (path) => recordRemovedPath(path, ` (runId=${c.runId})`),
					});
				} catch (e) {
					log(
						`remediate-orphaned-locks: error releasing ${c.name}: ${e.message}`,
					);
				}
			}
			if (!removedNames.has(c.name)) {
				log(
					`remediate-orphaned-locks: skipped ${c.name} — claim changed, remains live, or is no longer safely removable`,
				);
			}
			continue;
		}
		if (removedNames.has(c.name)) continue;
		if (!existsSync(c.path)) {
			log(
				`remediate-orphaned-locks: skipped ${c.name} — candidate is no longer present`,
			);
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
		} else if (c.requiresLivenessRecheck) {
			let currentRun = null;
			try {
				currentRun = await (dependencies.readRun ?? readRun)(c.runId);
			} catch {
				// A missing or unreadable run cannot establish fresh deadness.
			}
			if (
				classifyRunLiveness(currentRun, {
					now: dependencies.now ?? Date.now(),
					...(dependencies.probePid ? { probePid: dependencies.probePid } : {}),
				}) !== "dead"
			) {
				log(
					`remediate-orphaned-locks: skipped ${c.name} — owner is no longer proven dead`,
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
		let releaseUncertain = false;
		try {
			didRelease =
				c.remediationKind === "cwd-derived-project-lock"
					? await releaseCwdDerivedFn(c.projectPath, c.runId, {
							onRemoved: (path) =>
								recordRemovedPath(path, ` (runId=${c.runId})`),
							...(dependencies.probePid
								? { probePid: dependencies.probePid }
								: {}),
							...(dependencies.now !== undefined
								? { now: dependencies.now }
								: {}),
							onStatus: (event) => {
								if (
									event?.event === "mutation_postcondition_uncertain" ||
									event?.status === "uncertain" ||
									event?.state === "uncertain"
								) {
									releaseUncertain = true;
								}
							},
						})
					: await releaseFn(c.projectPath, c.runId, {
							onRemoved: (path) =>
								recordRemovedPath(path, ` (runId=${c.runId})`),
							...(dependencies.probePid
								? { probePid: dependencies.probePid }
								: {}),
							...(dependencies.now !== undefined
								? { now: dependencies.now }
								: {}),
							onStatus: (event) => {
								if (
									event?.event === "mutation_postcondition_uncertain" ||
									event?.status === "uncertain" ||
									event?.state === "uncertain"
								) {
									releaseUncertain = true;
								}
							},
						});
		} catch (e) {
			log(`remediate-orphaned-locks: error releasing ${c.name}: ${e.message}`);
		}
		if (didRelease && !removedNames.has(c.name) && !existsSync(c.path)) {
			// Backward-compatible injected release seams may not implement the
			// optional exact-path callback. Production release paths always do.
			recordRemovedPath(c.path, ` (runId=${c.runId})`);
		}
		if (!removedNames.has(c.name)) {
			if (releaseUncertain) {
				log(`remediate-orphaned-locks: skipped ${c.name} — release_uncertain`);
			} else {
				let stillOwned;
				try {
					stillOwned = await isOwnedFn(c.projectPath, c.runId);
				} catch {
					stillOwned = "unknown";
				}
				if (stillOwned === "unknown") {
					log(
						`remediate-orphaned-locks: skipped ${c.name} — release_uncertain (ownership could not be confirmed)`,
					);
				} else if (stillOwned) {
					log(
						`remediate-orphaned-locks: skipped ${c.name} — release_uncertain`,
					);
				} else {
					log(
						`remediate-orphaned-locks: skipped ${c.name} — no longer owned by ${c.runId} (reassigned since resolution, or already released)`,
					);
				}
			}
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

import "./remediate-orphaned-locks-support.mjs";
import "./remediate-orphaned-locks-candidates.mjs";
import { resolveCandidates } from "./remediate-orphaned-locks-candidates.mjs";
import {
	isCleanupFailedDeadWorker,
	parseArgs,
	USAGE,
	UsageError,
} from "./remediate-orphaned-locks-support.mjs";

export { resolveCandidates } from "./remediate-orphaned-locks-candidates.mjs";
