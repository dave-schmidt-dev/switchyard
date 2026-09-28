import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	checkpointArtifactIdentity,
	checkpointArtifactPurpose,
	readCheckpointArtifactSnapshot,
	sameCheckpointArtifactIdentity,
	sameFilesystemIdentity,
} from "./checkpoint-artifacts.mjs";
import {
	CHECKPOINT_ARTIFACT_MAX_BYTES,
	CHECKPOINT_ARTIFACT_MAX_ENTRIES,
	CHECKPOINT_ARTIFACT_MAX_FILE_BYTES,
} from "./constants.mjs";
import {
	ownerOnlyDirectoryStat,
	ownerOnlyRegularFileStat,
} from "./receipt-validation.mjs";
import { sanitizeForDisplay } from "./run-records.mjs";
export async function applyCheckpointArtifactRetention(
	checkpointPath,
	options = {},
) {
	const reports = [];
	const terminal = options.terminal === true;
	const dryRun = options.dryRun === true;
	const maxBytes = Number.isSafeInteger(options.maxBytes)
		? Math.max(0, options.maxBytes)
		: CHECKPOINT_ARTIFACT_MAX_BYTES;
	const maxEntries = Number.isSafeInteger(options.maxEntries)
		? Math.max(0, options.maxEntries)
		: CHECKPOINT_ARTIFACT_MAX_ENTRIES;
	if (typeof checkpointPath !== "string" || !isAbsolute(checkpointPath))
		return {
			deletedCount: 0,
			bytesDeleted: 0,
			reports: [
				{ disposition: "unknown", reason: "checkpoint_identity_unavailable" },
			],
		};
	const checkpointRoot = resolve(checkpointPath);
	let checkpointSnapshot;
	try {
		checkpointSnapshot = await readCheckpointArtifactSnapshot(checkpointRoot);
	} catch (error) {
		if (error?.code === "ENOENT")
			return { deletedCount: 0, bytesDeleted: 0, reports };
		checkpointSnapshot = null;
	}
	if (!checkpointSnapshot) {
		reports.push({
			disposition: "malformed",
			reason: "checkpoint_malformed",
		});
		return { deletedCount: 0, bytesDeleted: 0, reports };
	}
	const checkpoint = checkpointSnapshot.checkpoint;
	const checkpointRaw = checkpointSnapshot.raw;
	const checkpointIdentity = checkpointSnapshot.identity;
	const artifactsDir = `${checkpointRoot}.partial-diffs`;
	let artifactDirectoryIdentity;
	try {
		artifactDirectoryIdentity = await lstat(artifactsDir);
		if (!ownerOnlyDirectoryStat(artifactDirectoryIdentity)) {
			reports.push({
				disposition: "unsafe",
				reason: "artifact_directory_unsafe",
			});
			return { deletedCount: 0, bytesDeleted: 0, reports };
		}
	} catch (error) {
		if (error.code !== "ENOENT")
			reports.push({
				disposition: "unsafe",
				reason: "artifact_directory_unreadable",
			});
		return { deletedCount: 0, bytesDeleted: 0, reports };
	}
	let entries;
	try {
		entries = await readdir(artifactsDir, { withFileTypes: true });
	} catch (error) {
		if (error.code !== "ENOENT")
			reports.push({
				disposition: "unsafe",
				reason: "artifact_directory_unreadable",
			});
		return { deletedCount: 0, bytesDeleted: 0, reports };
	}
	const candidates = [];
	for (const entry of entries) {
		const artifactPath = resolve(artifactsDir, entry.name);
		const identity = checkpointArtifactIdentity(entry.name, checkpoint);
		if (identity.disposition !== "classified") {
			reports.push({
				name: sanitizeForDisplay(entry.name),
				...identity,
			});
			continue;
		}
		const purpose = checkpointArtifactPurpose(checkpoint, identity, terminal);
		let stat;
		try {
			stat = await lstat(artifactPath);
		} catch {
			reports.push({
				name: sanitizeForDisplay(entry.name),
				disposition: "unsafe",
				reason: "entry_unreadable",
			});
			continue;
		}
		if (
			!ownerOnlyRegularFileStat(stat, CHECKPOINT_ARTIFACT_MAX_FILE_BYTES) ||
			stat.nlink !== 1
		) {
			reports.push({
				name: sanitizeForDisplay(entry.name),
				disposition: "unsafe",
				reason: stat.isSymbolicLink()
					? "symlink"
					: stat.nlink !== 1
						? "hard_link"
						: "not_owner_regular",
			});
			continue;
		}
		if (purpose.active || !terminal) {
			reports.push({
				name: sanitizeForDisplay(entry.name),
				disposition: "protected",
				reason: purpose.reason,
			});
			continue;
		}
		candidates.push({
			path: artifactPath,
			name: entry.name,
			taskId: identity.taskId,
			attempt: identity.attempt,
			purpose: identity.purpose,
			artifactIdentity: {
				dev: stat.dev,
				ino: stat.ino,
				mode: stat.mode,
				uid: stat.uid,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				ctimeMs: stat.ctimeMs,
				nlink: stat.nlink,
			},
			parentIdentity: {
				dev: artifactDirectoryIdentity.dev,
				ino: artifactDirectoryIdentity.ino,
				mode: artifactDirectoryIdentity.mode,
				uid: artifactDirectoryIdentity.uid,
			},
		});
	}
	const totalBytes = candidates.reduce(
		(sum, candidate) => sum + candidate.artifactIdentity.size,
		0,
	);
	if (totalBytes <= maxBytes && candidates.length <= maxEntries) {
		for (const candidate of candidates)
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "retained",
				reason: "within_bound",
			});
		return { deletedCount: 0, bytesDeleted: 0, reports };
	}
	candidates.sort(
		(left, right) =>
			left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
	);
	let remainingBytes = totalBytes;
	let remainingEntries = candidates.length;
	let deletedCount = 0;
	let bytesDeleted = 0;
	for (const candidate of candidates) {
		if (remainingBytes <= maxBytes && remainingEntries <= maxEntries) {
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "retained",
				reason: "within_bound",
			});
			continue;
		}
		if (dryRun) {
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "would_delete",
				reason: "purpose_complete_bound",
			});
			remainingBytes -= candidate.artifactIdentity.size;
			remainingEntries -= 1;
			deletedCount += 1;
			bytesDeleted += candidate.artifactIdentity.size;
			continue;
		}
		try {
			await options.beforeDelete?.({
				name: candidate.name,
				path: candidate.path,
			});
			const currentCheckpoint =
				await readCheckpointArtifactSnapshot(checkpointRoot);
			if (
				!currentCheckpoint ||
				currentCheckpoint.raw !== checkpointRaw ||
				!sameFilesystemIdentity(currentCheckpoint.identity, checkpointIdentity)
			) {
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: "checkpoint_changed",
				});
				continue;
			}
			const reboundIdentity = checkpointArtifactIdentity(
				candidate.name,
				currentCheckpoint.checkpoint,
			);
			const reboundPurpose =
				reboundIdentity.disposition === "classified"
					? checkpointArtifactPurpose(
							currentCheckpoint.checkpoint,
							reboundIdentity,
							terminal,
						)
					: { active: true, reason: "checkpoint_changed" };
			if (
				reboundIdentity.disposition !== "classified" ||
				reboundIdentity.taskId !== candidate.taskId ||
				reboundIdentity.attempt !== candidate.attempt ||
				reboundIdentity.purpose !== candidate.purpose ||
				reboundPurpose.active
			) {
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: reboundPurpose.reason ?? "checkpoint_changed",
				});
				continue;
			}
			const currentParent = await lstat(dirname(candidate.path));
			if (
				!ownerOnlyDirectoryStat(currentParent) ||
				!sameFilesystemIdentity(currentParent, candidate.parentIdentity)
			) {
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: "parent_directory_changed",
				});
				continue;
			}
			// Recheck immediately before mutation; a replacement symlink or owner
			// change must fail closed without invoking unlink.
			const latest = await lstat(candidate.path);
			if (!sameCheckpointArtifactIdentity(latest, candidate.artifactIdentity)) {
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: "entry_changed",
				});
				continue;
			}
			await options.beforeClaim?.({
				name: candidate.name,
				path: candidate.path,
			});
			const claimPath = resolve(
				dirname(candidate.path),
				`.${candidate.name}.${randomUUID()}.retention-claim`,
			);
			await rename(candidate.path, claimPath);
			const claimed = await lstat(claimPath);
			if (
				!sameCheckpointArtifactIdentity(
					claimed,
					candidate.artifactIdentity,
					false,
				)
			) {
				let originalExists = true;
				try {
					await lstat(candidate.path);
				} catch (error) {
					if (error?.code === "ENOENT") originalExists = false;
					else throw error;
				}
				if (!originalExists) {
					const restoreParent = await lstat(dirname(candidate.path));
					if (
						ownerOnlyDirectoryStat(restoreParent) &&
						sameFilesystemIdentity(restoreParent, candidate.parentIdentity)
					)
						await rename(claimPath, candidate.path);
				}
				reports.push({
					name: sanitizeForDisplay(candidate.name),
					disposition: "unsafe",
					reason: "entry_changed",
				});
				continue;
			}
			await unlink(claimPath);
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "deleted",
				reason: "purpose_complete_bound",
			});
			remainingBytes -= candidate.artifactIdentity.size;
			remainingEntries -= 1;
			deletedCount += 1;
			bytesDeleted += candidate.artifactIdentity.size;
		} catch {
			reports.push({
				name: sanitizeForDisplay(candidate.name),
				disposition: "unsafe",
				reason: "delete_failed",
			});
		}
	}
	return { deletedCount, bytesDeleted, reports };
}
