import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getStateRoot } from "../run-store/index.mjs";
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
function isPidProvenDead(pid, probePid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (probePid) {
		try {
			return probePid(pid) === "dead";
		} catch {
			return false;
		}
	}
	try {
		process.kill(pid, 0);
		return false;
	} catch (e) {
		// Only ESRCH proves absence. Permission and unknown probe failures retain
		// the recovery evidence conservatively.
		return e.code === "ESRCH";
	}
}
function isRunStale(run, options = {}) {
	const terminal =
		run.state === "succeeded" ||
		run.state === "failed" ||
		run.state === "deferred";
	const liveness = classifyRunLiveness(run, options);
	return terminal || liveness === "dead";
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
	const originalName =
		recoveryProofMetadata(entry.name)?.originalName ?? entry.name;
	return originalName.endsWith(".lock.recovery-claim")
		? originalName.slice(0, -".recovery-claim".length)
		: originalName;
}
const RECOVERY_PROOF_SUFFIX =
	/^([0-9a-f]{64}\.lock(?:\.recovery-claim)?)\.([1-9]\d*)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock\.recovery-claim$/;
function recoveryProofMetadata(name) {
	const match = RECOVERY_PROOF_SUFFIX.exec(name);
	if (!match) return null;
	const ownerPid = Number(match[2]);
	return Number.isSafeInteger(ownerPid)
		? { originalName: match[1], ownerPid }
		: null;
}
async function bindLegacyRecoveryOwner(body, claimBaseName, readRunFn) {
	if (
		body === null ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		typeof body.runId !== "string" ||
		body.runId.length === 0
	) {
		return null;
	}
	if (typeof body.projectPath === "string" && body.projectPath.length > 0) {
		return body;
	}
	if (Object.hasOwn(body, "projectPath")) return null;
	try {
		const run = await readRunFn(body.runId);
		if (typeof run.projectPath !== "string") return null;
		const projectPath = resolve(run.projectPath);
		if (
			projectLockFileName(projectPath) !== claimBaseName &&
			cwdDerivedProjectLockFileName(projectPath) !== claimBaseName
		) {
			return null;
		}
		return { ...body, projectPath };
	} catch {
		return null;
	}
}
function isTerminalOrDead(run, options = {}) {
	const liveness = classifyRunLiveness(run, options);
	return liveness === "terminal_clean" || liveness === "dead";
}

export {
	baseDescriptor,
	bindLegacyRecoveryOwner,
	cwdDerivedProjectLockFileName,
	isCleanupFailedDeadWorker,
	isPidProvenDead,
	isRunStale,
	isTerminalOrDead,
	locksDir,
	parseArgs,
	projectLockFileName,
	recoveryClaimDescriptor,
	recoveryClaimLockName,
	recoveryProofMetadata,
	USAGE,
	UsageError,
};
