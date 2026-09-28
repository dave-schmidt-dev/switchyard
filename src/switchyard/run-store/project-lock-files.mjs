import { createHash, randomUUID } from "node:crypto";
import {
	link,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	OUTCOME_EVENT_MAX_BYTES,
	OUTCOME_FILE_MAX_BYTES,
	OUTCOME_FILE_MAX_LINES,
} from "../outcome/schema.mjs";
import {
	EVENT_RESERVE_BYTES,
	locksRoot,
	resolveStateRoot,
	resolveVmAdmissionRoot,
} from "./constants.mjs";
import { writeRunAtomically } from "./run-records.mjs";
import { acquireVmSlotWithDependencies, readVmSlotBody } from "./vm-slots.mjs";
export function getStateRoot() {
	return resolveStateRoot();
}
export function getVmAdmissionRoot() {
	return resolveVmAdmissionRoot();
}
function lockFilePath(canonicalPath) {
	const resolvedPath = resolve(canonicalPath);
	const hash = createHash("sha256").update(resolvedPath).digest("hex");
	return resolve(locksRoot(), `${hash}.lock`);
}
function resolveCanonicalProjectPath(projectPath) {
	return resolve(projectPath);
}
function projectLockFileName(projectPath) {
	// Keep the namespace as data for the hash, rather than handing a
	// namespace-prefixed string to path.resolve(). The latter made the lock
	// identity depend on this process's cwd.
	const identity = `project:${resolveCanonicalProjectPath(projectPath)}`;
	return `${createHash("sha256").update(identity).digest("hex")}.lock`;
}
function projectLockPath(canonicalProjectPath) {
	return resolve(locksRoot(), projectLockFileName(canonicalProjectPath));
}
function projectLockClaimPath(canonicalProjectPath) {
	return `${projectLockPath(canonicalProjectPath)}.recovery-claim`;
}
function parseProjectLockBody(raw, canonicalProjectPath = null) {
	try {
		const body = JSON.parse(raw);
		if (
			body === null ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			typeof body.runId !== "string" ||
			body.runId.length === 0 ||
			typeof body.projectPath !== "string" ||
			body.projectPath.length === 0 ||
			(canonicalProjectPath !== null &&
				resolveCanonicalProjectPath(body.projectPath) !==
					resolveCanonicalProjectPath(canonicalProjectPath))
		) {
			return null;
		}
		return body;
	} catch {
		return null;
	}
}
function parseOwnedProjectLockBody(raw, canonicalProjectPath) {
	const body = parseProjectLockBody(raw, canonicalProjectPath);
	if (body) return body;
	// Pre-F.1 project locks did not persist projectPath. The canonical hashed
	// path still identifies the project, so an exact runId remains sufficient
	// for ownership checks and release compatibility.
	return parseLegacyProjectLockBody(raw);
}
function parseLegacyProjectLockBody(raw) {
	try {
		const legacyBody = JSON.parse(raw);
		if (
			legacyBody !== null &&
			typeof legacyBody === "object" &&
			!Array.isArray(legacyBody) &&
			typeof legacyBody.runId === "string" &&
			legacyBody.runId.length > 0 &&
			!Object.hasOwn(legacyBody, "projectPath")
		) {
			return legacyBody;
		}
	} catch {
		// The strict parser already rejected malformed JSON.
	}
	return null;
}
async function readTextIfPresent(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
async function unlinkBodyMatched(path, expectedRaw, options = {}) {
	// Atomically take the directory entry before inspecting it. A read followed
	// by unlink(path) can delete a replacement created in between; renaming to a
	// unique recovery-claim path means only the inode actually taken can be
	// deleted. A mismatched inode is restored without clobbering, or retained as
	// discoverable recovery evidence if the original path is already occupied.
	const existingProof = recoveryProofMetadata(basename(path));
	const originalName = existingProof?.originalName ?? basename(path);
	const proofPath = resolve(
		locksRoot(),
		`${originalName}.${process.pid}.${randomUUID()}.lock.recovery-claim`,
	);
	try {
		await rename(path, proofPath);
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	if (typeof options.afterRename === "function") {
		await options.afterRename(proofPath);
	}
	const proofRaw = await readFile(proofPath, "utf8");
	if (proofRaw === expectedRaw) {
		await unlink(proofPath);
		return true;
	}
	await restoreClaimWithoutClobber(proofPath, path, proofRaw);
	return false;
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
async function restoreClaimWithoutClobber(claimPath, lockPath, raw) {
	try {
		await link(claimPath, lockPath);
	} catch (error) {
		if (error.code === "EEXIST" || error.code === "ENOENT") return false;
		throw error;
	}
	const restoredRaw = await readTextIfPresent(lockPath);
	if (restoredRaw !== raw) return false;
	await unlinkBodyMatched(claimPath, raw);
	return true;
}
export const runStoreTesting = Object.freeze({
	acquireVmSlotWithDependencies,
	eventLimits: Object.freeze({
		fileBytes: OUTCOME_FILE_MAX_BYTES,
		lines: OUTCOME_FILE_MAX_LINES,
		lineBytes: OUTCOME_EVENT_MAX_BYTES,
		reserveBytes: EVENT_RESERVE_BYTES,
	}),
	projectLockArtifacts,
	readVmSlotBody,
	unlinkBodyMatched,
	writeRunAtomically,
});
async function moveProjectLockPathToClaim(
	lockPath,
	claimPath,
	canonicalProjectPath,
	expectedRaw,
) {
	// The reservation is recoverable evidence, not an opaque marker. Keep the
	// exact owner body so a crash before rename can only be reconciled against
	// the same bytes that were read before claiming the lock.
	if (!parseOwnedProjectLockBody(expectedRaw, canonicalProjectPath)) {
		return null;
	}
	const reservation = JSON.stringify({
		claimState: "reservation",
		expectedRaw,
	});
	try {
		await writeFile(claimPath, reservation, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (error.code === "EEXIST") return null;
		throw error;
	}

	try {
		const currentRaw = await readTextIfPresent(lockPath);
		if (currentRaw !== expectedRaw) {
			await unlinkBodyMatched(claimPath, reservation);
			return null;
		}
		try {
			await rename(lockPath, claimPath);
		} catch (error) {
			await unlinkBodyMatched(claimPath, reservation);
			if (error.code === "ENOENT") return null;
			throw error;
		}
		const claimedRaw = await readTextIfPresent(claimPath);
		if (claimedRaw === expectedRaw) return { claimPath, raw: claimedRaw };
		if (claimedRaw !== null) {
			await restoreClaimWithoutClobber(claimPath, lockPath, claimedRaw);
		}
		return null;
	} catch (error) {
		const claimRaw = await readTextIfPresent(claimPath).catch(() => null);
		if (claimRaw === reservation) {
			await unlinkBodyMatched(claimPath, reservation).catch(() => false);
		}
		throw error;
	}
}
function cwdDerivedProjectLockPath(canonicalProjectPath) {
	const historicalKeyPath = resolve(
		canonicalProjectPath,
		`project:${canonicalProjectPath}`,
	);
	return lockFilePath(historicalKeyPath);
}
function parseProjectLockArtifact(raw, projectPath, isOwnedPath) {
	return isOwnedPath
		? parseOwnedProjectLockBody(raw, projectPath)
		: parseProjectLockBody(raw, projectPath);
}
async function projectLockArtifacts(projectPath) {
	const canonicalPath = resolveCanonicalProjectPath(projectPath);
	const canonicalLockPath = projectLockPath(canonicalPath);
	const cwdDerivedLockPath = cwdDerivedProjectLockPath(canonicalPath);
	let entries;
	try {
		entries = await readdir(locksRoot(), { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const artifacts = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const isClaim = entry.name.endsWith(".lock.recovery-claim");
		if (!isClaim && !entry.name.endsWith(".lock")) continue;
		const path = resolve(locksRoot(), entry.name);
		const proof = recoveryProofMetadata(entry.name);
		const raw = await readTextIfPresent(path).catch(() => null);
		if (raw === null) continue;
		const originalPath = proof
			? resolve(locksRoot(), proof.originalName)
			: path;
		const lockPath = originalPath.endsWith(".lock.recovery-claim")
			? originalPath.slice(0, -".recovery-claim".length)
			: originalPath;
		const isOwnedPath =
			lockPath === canonicalLockPath || lockPath === cwdDerivedLockPath;
		if (!isClaim) {
			const body = parseProjectLockArtifact(raw, canonicalPath, isOwnedPath);
			if (body) artifacts.push({ body, kind: "lock", lockPath, path, raw });
			continue;
		}
		const reservation = parseRecoveryReservation(raw);
		if (reservation) {
			const body = parseProjectLockArtifact(
				reservation.expectedRaw,
				canonicalPath,
				isOwnedPath,
			);
			if (body) {
				artifacts.push({
					body,
					claimPath: path,
					kind: "reservation",
					lockPath,
					raw,
					reservation,
				});
			}
			continue;
		}
		const body = parseProjectLockArtifact(raw, canonicalPath, isOwnedPath);
		if (body) {
			artifacts.push({ body, claimPath: path, kind: "claim", lockPath, raw });
		}
	}
	return artifacts;
}
function parseRecoveryReservation(raw) {
	try {
		const body = JSON.parse(raw);
		if (
			body === null ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			body.claimState !== "reservation" ||
			typeof body.expectedRaw !== "string" ||
			Object.keys(body).some(
				(key) => !["claimState", "expectedRaw"].includes(key),
			)
		) {
			return null;
		}
		return body;
	} catch {
		return null;
	}
}

export {
	cwdDerivedProjectLockPath,
	lockFilePath,
	moveProjectLockPathToClaim,
	parseLegacyProjectLockBody,
	parseOwnedProjectLockBody,
	parseProjectLockArtifact,
	parseProjectLockBody,
	parseRecoveryReservation,
	projectLockArtifacts,
	projectLockClaimPath,
	projectLockFileName,
	projectLockPath,
	RECOVERY_PROOF_SUFFIX,
	readTextIfPresent,
	recoveryProofMetadata,
	resolveCanonicalProjectPath,
	restoreClaimWithoutClobber,
	unlinkBodyMatched,
};
