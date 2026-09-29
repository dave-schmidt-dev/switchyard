import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	getRunRoot,
	readRun,
	reconcileProjectLockClaims,
	releaseOrphanedProjectLocks,
} from "../run-store/index.mjs";
import {
	recoveryLiveness,
	releaseStaleProjectLocks,
} from "./recover-liveness.mjs";
import { executionBackendForRun } from "./status-envelope.mjs";

function managedIdentity(entry) {
	if (
		typeof entry?.uuid !== "string" ||
		typeof entry?.name !== "string" ||
		typeof entry?.runId !== "string" ||
		!Number.isInteger(entry?.creatorPid)
	)
		return null;
	return JSON.stringify([
		entry.uuid,
		entry.name,
		entry.runId,
		entry.creatorPid,
	]);
}
const RECOVERY_SKIP_REASONS = new Set([
	"recovery_evidence_missing",
	"creator-birth-unverified",
	"ineligible",
	"identity-or-eligibility-changed",
	"creator-birth-changed-before-delete",
]);
function closedRecoverySkipReason(value) {
	return RECOVERY_SKIP_REASONS.has(value) ? value : "recovery_evidence_changed";
}
async function assessRecoveryEntry(entry, dependencies, projectPath) {
	const identity = managedIdentity(entry);
	if (identity === null)
		return {
			eligible: false,
			liveness: "unknown",
			reason: "identity_malformed",
		};
	if (typeof projectPath !== "string")
		return {
			eligible: false,
			liveness: "unknown",
			reason: "project_identity_unknown",
		};
	const readRunFn = dependencies.readRun ?? readRun;
	let run;
	try {
		run = await readRunFn(entry.runId);
	} catch {
		return { eligible: false, liveness: "unknown", reason: "run_missing" };
	}
	if (run?.runId !== entry.runId)
		return {
			eligible: false,
			liveness: "unknown",
			reason: "run_identity_mismatch",
		};
	if (
		typeof run.projectPath !== "string" ||
		resolve(run.projectPath) !== resolve(projectPath)
	)
		return {
			eligible: false,
			liveness: "unknown",
			reason: "project_identity_mismatch",
		};
	if (run.cleanupState === "failed")
		return { eligible: false, liveness: "unknown", reason: "cleanup_failed" };
	const liveness = recoveryLiveness(run, dependencies);
	if (liveness === "terminal_clean" || liveness === "dead") {
		const canonicalRunDigest = createHash("sha256")
			.update(JSON.stringify(run))
			.digest("hex");
		const ownershipContext = {
			resourceRoot: join(getRunRoot(run.runId), "resources"),
			runId: run.runId,
			projectRoot: resolve(run.projectPath),
			creatorPid: entry.creatorPid,
		};
		return {
			eligible: true,
			liveness,
			reason: "stale_owned_resource",
			ownershipContext,
			canonicalRunDigest,
			proof: JSON.stringify([
				identity,
				run.runId,
				resolve(run.projectPath),
				ownershipContext.resourceRoot,
				entry.creatorPid,
				liveness,
				canonicalRunDigest,
			]),
		};
	}
	return {
		eligible: false,
		liveness,
		reason:
			liveness === "live"
				? "live_run"
				: liveness === "startup_grace"
					? "startup_grace"
					: "liveness_unknown",
	};
}
function recoveryEntryIsEligibleAtMutation(
	entry,
	dependencies,
	ownershipContext,
	canonicalRunDigest,
) {
	if (
		managedIdentity(entry) === null ||
		entry.runId !== ownershipContext.runId ||
		entry.creatorPid !== ownershipContext.creatorPid ||
		entry.ownership?.resourceRoot !== ownershipContext.resourceRoot ||
		entry.ownership?.projectRoot !== ownershipContext.projectRoot ||
		entry.ownership?.runId !== ownershipContext.runId ||
		entry.ownership?.creatorPid !== ownershipContext.creatorPid
	)
		return false;
	let run;
	try {
		run = JSON.parse(
			readFileSync(join(getRunRoot(entry.runId), "run.json"), "utf8"),
		);
	} catch {
		return false;
	}
	// `canonicalRunDigest` came from readRun's complete schema validation at the
	// last async boundary. Exact binding rejects every replacement, including a
	// parseable object that this local subset of identity checks would accept.
	if (
		createHash("sha256").update(JSON.stringify(run)).digest("hex") !==
		canonicalRunDigest
	)
		return false;
	if (
		!run ||
		typeof run !== "object" ||
		Array.isArray(run) ||
		run.runId !== entry.runId ||
		typeof run.projectPath !== "string" ||
		resolve(run.projectPath) !== ownershipContext.projectRoot ||
		run.cleanupState === "failed"
	)
		return false;
	const liveness = recoveryLiveness(run, dependencies);
	return liveness === "terminal_clean" || liveness === "dead";
}
function emptyReclaimResult() {
	return { reclaimed: [], skippedSnapshots: [], errors: [] };
}
async function reclaimManagedEntries({ managed, dependencies, projectPath }) {
	const executionBackend = recoveryExecutionBackend(dependencies);
	const reclaim =
		dependencies.reclaim ?? ((opts) => executionBackend.reclaim(opts));
	const combined = emptyReclaimResult();
	const eligibleRunIds = new Set();
	const candidates = [];
	let invoked = false;
	for (const entry of managed) {
		const first = await assessRecoveryEntry(entry, dependencies, projectPath);
		if (!first.eligible) {
			candidates.push({
				entry,
				disposition: "preserved",
				reason: first.reason,
			});
			continue;
		}
		// Re-read authoritative run/liveness evidence at the last asynchronous
		// boundary before the synchronous backend performs its own VM, creator,
		// ownership-record, and eligibility checks immediately before mutation.
		const final = await assessRecoveryEntry(entry, dependencies, projectPath);
		if (!final.eligible || final.proof !== first.proof) {
			candidates.push({
				entry,
				disposition: "preserved",
				reason: final.eligible ? "recovery_evidence_changed" : final.reason,
			});
			continue;
		}
		const identity = managedIdentity(entry);
		invoked = true;
		eligibleRunIds.add(entry.runId);
		try {
			const ownershipContext = final.ownershipContext;
			const result = reclaim({
				dryRun: false,
				ownershipContext,
				eligibility: (candidate) => {
					if (managedIdentity(candidate) !== identity) return false;
					if (candidate.recoveryPhase !== "pre_mutation") return true;
					return recoveryEntryIsEligibleAtMutation(
						candidate,
						dependencies,
						ownershipContext,
						final.canonicalRunDigest,
					);
				},
			});
			combined.reclaimed.push(...(result.reclaimed ?? []));
			combined.skippedSnapshots.push(...(result.skippedSnapshots ?? []));
			combined.errors.push(...(result.errors ?? []));
			const reclaimed = (result.reclaimed ?? []).some(
				(candidate) =>
					candidate?.uuid === entry.uuid && candidate?.name === entry.name,
			);
			const skipped = (result.skipped ?? []).find(
				(candidate) => managedIdentity(candidate) === identity,
			);
			candidates.push({
				entry,
				disposition: reclaimed ? "reclaimed" : "preserved",
				reason: reclaimed
					? "stale_owned_resource"
					: closedRecoverySkipReason(skipped?.reason),
			});
		} catch {
			combined.errors.push({
				name: entry.name,
				reason: "managed_reclaim_failed",
			});
			candidates.push({
				entry,
				disposition: "preserved",
				reason: "managed_reclaim_failed",
			});
		}
	}
	if (!invoked) {
		const result = reclaim({ dryRun: false, eligibility: () => false });
		combined.errors.push(...(result.errors ?? []));
	}
	return { result: combined, eligibleRunIds, candidates };
}
async function auditKnownAllocationIntents({
	stateRoot,
	runId = null,
	managed,
	dependencies,
	executionBackend,
}) {
	let runIds;
	if (runId) {
		runIds = [runId];
	} else {
		try {
			runIds = (await readdir(join(stateRoot, "runs"), { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch {
			runIds = [];
		}
	}
	const readRunFn = dependencies.readRun ?? readRun;
	const knownResourceRoots = [];
	for (const candidateRunId of runIds) {
		const descriptor = {
			resourceRoot: join(stateRoot, "runs", candidateRunId, "resources"),
			runId: candidateRunId,
			runRecordStatus: "missing",
			projectPath: null,
			cleanupState: null,
			liveness: "unknown",
		};
		try {
			const run = await readRunFn(candidateRunId);
			if (
				run?.runId === candidateRunId &&
				typeof run.projectPath === "string"
			) {
				descriptor.runRecordStatus = "valid";
				descriptor.projectPath = run.projectPath;
				descriptor.cleanupState = run.cleanupState ?? null;
				descriptor.liveness = recoveryLiveness(run, dependencies);
			} else {
				descriptor.runRecordStatus = "unknown";
			}
		} catch (error) {
			descriptor.runRecordStatus =
				error?.code === "ENOENT" ? "missing" : "unknown";
		}
		knownResourceRoots.push(descriptor);
	}
	const audit =
		dependencies.auditAllocationIntents ??
		((options) => executionBackend.auditAllocationIntents(options));
	try {
		return audit({ knownResourceRoots, managed });
	} catch {
		return [
			{
				file: null,
				runId,
				vmName: null,
				classification: "unknown",
				reason: "allocation_audit_unavailable",
			},
		];
	}
}
async function canonicalRecoveryProject(managed, dependencies) {
	const readRunFn = dependencies.readRun ?? readRun;
	const projects = new Set();
	for (const entry of managed) {
		if (managedIdentity(entry) === null) continue;
		try {
			const run = await readRunFn(entry.runId);
			if (run?.runId === entry.runId && typeof run.projectPath === "string") {
				projects.add(run.projectPath);
			}
		} catch {
			// Missing or malformed records contribute no destruction authority.
		}
	}
	return projects.size === 1 ? [...projects][0] : null;
}
function recoveryExecutionBackend(dependencies = {}) {
	return dependencies.executionBackend ?? executionBackendForRun();
}
async function sweepManagedOrphans(dependencies = {}) {
	const executionBackend = recoveryExecutionBackend(dependencies);
	const listManaged =
		dependencies.listManaged ?? (() => executionBackend.listManaged());
	const currentProjectPath = dependencies.projectPath ?? null;
	let managed = [];
	const errors = [];
	try {
		managed = listManaged();
	} catch {
		errors.push("managed_inventory_unavailable");
	}
	let result = emptyReclaimResult();
	let eligibleRunIds = new Set();
	try {
		({ result, eligibleRunIds } = await reclaimManagedEntries({
			managed,
			dependencies,
			projectPath: currentProjectPath,
		}));
	} catch {
		errors.push("managed_reclaim_unavailable");
	}

	const candidateIds = [...eligibleRunIds];

	const targeted = await releaseStaleProjectLocks(candidateIds, dependencies);
	const direct = await (
		dependencies.releaseOrphanedProjectLocks ?? releaseOrphanedProjectLocks
	)();
	const claims = await (
		dependencies.reconcileProjectLockClaims ?? reconcileProjectLockClaims
	)();
	const projectLocksReleased = new Set([...targeted, ...direct, ...claims])
		.size;

	return {
		vmsReclaimed: result.reclaimed.length,
		// A reclaimed VM whose sidecar was lost leaves parent snapshots on the
		// golden that this code may never delete (see reclaim()). That residue
		// is the one INV-3 leak the sweep cannot fix, so it has to leave the
		// sweep as a fact rather than dying inside it.
		unreclaimedSnapshots: result.skippedSnapshots ?? [],
		errors: [...errors, ...result.errors.map((e) => `${e.name}: ${e.reason}`)],
		projectLocksReleased,
	};
}

export {
	assessRecoveryEntry,
	auditKnownAllocationIntents,
	canonicalRecoveryProject,
	emptyReclaimResult,
	reclaimManagedEntries,
	recoveryExecutionBackend,
	sweepManagedOrphans,
};
