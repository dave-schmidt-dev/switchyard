import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	checkpointPathForRun,
	hasDiagnosticRecord,
	hasLiveCheckpoint,
	quarantineDirectory,
} from "./checkpoint-artifacts.mjs";
import { applyCheckpointArtifactRetention } from "./checkpoint-retention.mjs";
import { runsRoot } from "./constants.mjs";
import { SchemaError } from "./errors.mjs";
import { getRunRoot, readRun, sanitizeForDisplay } from "./run-records.mjs";

async function collectArtifacts(runId, dryRun) {
	const artifactsDir = resolve(getRunRoot(runId), "artifacts");
	let entries;
	try {
		entries = await readdir(artifactsDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (dryRun) {
			console.error(
				`applyRetention: would collect artifact ${sanitizeForDisplay(entry.name)} from run ${sanitizeForDisplay(runId)}`,
			);
			removed += 1;
			continue;
		}
		try {
			await rm(resolve(artifactsDir, entry.name), {
				recursive: true,
				force: true,
			});
			removed += 1;
		} catch (e) {
			console.warn(
				`applyRetention: failed to collect artifact ${sanitizeForDisplay(entry.name)} from run ${sanitizeForDisplay(runId)}: ${sanitizeForDisplay(e.message)}`,
			);
		}
	}
	return removed;
}
export async function applyRetention(options = {}) {
	const { maxRuns, maxAgeDays, now, dryRun } = options;
	const referenceTime = now ? new Date(now).getTime() : Date.now();

	let entries;
	try {
		entries = await readdir(runsRoot(), { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT")
			return { deletedCount: 0, collectedCount: 0, quarantined: [] };
		throw e;
	}

	const quarantined = [];
	const removable = [];
	let collectedCount = 0;
	const checkpointArtifacts = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let run;
		try {
			run = await readRun(entry.name);
		} catch (e) {
			if (!(e instanceof SchemaError)) {
				// Conservative choice: a run directory that fails to read is
				// NOT quarantined unless the failure is a positive content-
				// validation error. ENOENT (run.json absent — e.g. a
				// concurrent initializeRun mid-flight), EACCES, EIO, EMFILE,
				// and any other filesystem/IO error are indistinguishable
				// from transient or externally-caused failures on this
				// signal, so moving the directory out from under a live
				// writer would be worse than re-scanning it. Leave it in
				// place and skip it. A later sweep may find it readable
				// again, but that is not guaranteed — a persistent I/O error
				// is simply re-skipped each sweep. Only present-but-invalid
				// content (invalid JSON, non-object JSON, SchemaError
				// validation failures) is worth quarantining.
				continue;
			}
			// Reason text is always one of a small set of static strings
			// (SchemaError's own message, which by construction never
			// interpolates file content — see readRun/validateRun); raw
			// error or file content never appears.
			const reason = e.message;
			try {
				const destination = await quarantineDirectory(entry.name);
				quarantined.push({
					runId: sanitizeForDisplay(entry.name),
					// Raw on-disk path for machine use; destinationDisplay is
					// the separately sanitized value safe for logs/terminal.
					destination,
					destinationDisplay: sanitizeForDisplay(destination),
					reason,
				});
			} catch (moveError) {
				// ENOENT here means the source run directory is already gone —
				// a concurrent or repeated sweep moved it first — which is the
				// expected outcome, not a failure worth warning about.
				if (moveError.code === "ENOENT") continue;
				console.warn(
					`applyRetention: failed to quarantine run ${sanitizeForDisplay(entry.name)}: ${sanitizeForDisplay(moveError.message)}`,
				);
			}
			continue;
		}
		const checkpointPath = checkpointPathForRun(run);
		if (checkpointPath) {
			const artifactResult = await applyCheckpointArtifactRetention(
				checkpointPath,
				{
					terminal:
						(run.state === "succeeded" ||
							run.state === "failed" ||
							run.state === "deferred") &&
						run.cleanupState === "complete",
					dryRun,
					maxBytes: options.maxCheckpointArtifactBytes,
					maxEntries: options.maxCheckpointArtifactEntries,
				},
			);
			if (artifactResult.reports.length > 0) {
				checkpointArtifacts.push({
					checkpointPath: sanitizeForDisplay(checkpointPath),
					...artifactResult,
				});
			}
		}
		// A quarantined directory `continue`d above, so it is never reached by
		// the collect/remove paths below in the same sweep — the two never
		// contend for the same directory.
		if (hasLiveCheckpoint(run)) continue;
		collectedCount += await collectArtifacts(entry.name, dryRun);
		// This may be the only ownership evidence after a crash before the
		// first event. Do not discard it until removal was recorded.
		const ownsSimpleRoot = ["allocating", "active", "retained"].includes(
			run.worktree?.state,
		);
		if (!hasDiagnosticRecord(entry.name) && !ownsSimpleRoot) {
			removable.push({
				runId: entry.name,
				createdAt: new Date(run.createdAt).getTime(),
			});
		}
	}

	removable.sort((a, b) => a.createdAt - b.createdAt);

	const deleted = new Set();

	if (maxAgeDays != null && Number.isFinite(maxAgeDays)) {
		const cutoff = referenceTime - maxAgeDays * 86_400_000;
		for (const r of removable) {
			if (r.createdAt < cutoff) {
				if (dryRun) {
					console.error(
						`applyRetention: would delete run ${r.runId} (no events.jsonl, older than maxAgeDays cutoff)`,
					);
					deleted.add(r.runId);
					continue;
				}
				try {
					await rm(getRunRoot(r.runId), { recursive: true, force: true });
					deleted.add(r.runId);
				} catch (e) {
					console.warn(`Failed to delete run ${r.runId}: ${e.message}`);
				}
			}
		}
	}

	const remaining = removable.filter((r) => !deleted.has(r.runId));

	if (
		maxRuns != null &&
		Number.isFinite(maxRuns) &&
		remaining.length > maxRuns
	) {
		const toDelete = remaining.slice(0, remaining.length - maxRuns);
		for (const r of toDelete) {
			if (dryRun) {
				console.error(
					`applyRetention: would delete run ${r.runId} (no events.jsonl, maxRuns trim)`,
				);
				deleted.add(r.runId);
				continue;
			}
			try {
				await rm(getRunRoot(r.runId), { recursive: true, force: true });
				deleted.add(r.runId);
			} catch (e) {
				console.warn(`Failed to delete run ${r.runId}: ${e.message}`);
			}
		}
	}

	return {
		deletedCount: deleted.size,
		collectedCount,
		quarantined,
		checkpointArtifacts,
	};
}
export { collectArtifacts };
