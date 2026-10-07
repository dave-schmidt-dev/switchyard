import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MIN_SAMPLES = 5;

/**
 * Observed p80 duration (ms) for one project/target cell over the newest run
 * directories, or null when fewer than MIN_SAMPLES succeeded runs are on
 * record. History is advisory: an absent run store yields null.
 */
export async function observedP80(
	targetId,
	project,
	{ runsRoot, limit = 500 },
) {
	if (
		typeof targetId !== "string" ||
		targetId === "" ||
		typeof project !== "string" ||
		project === "" ||
		typeof runsRoot !== "string" ||
		runsRoot === "" ||
		!Number.isSafeInteger(limit) ||
		limit <= 0
	) {
		return null;
	}
	let entries;
	try {
		entries = await readdir(runsRoot, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	const runDirs = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const info = await stat(resolve(runsRoot, entry.name));
			runDirs.push({ name: entry.name, mtimeMs: info.mtimeMs });
		} catch {
			// A run directory can be swept by retention mid-scan; skip it.
		}
	}
	runDirs.sort((left, right) => right.mtimeMs - left.mtimeMs);
	const durations = [];
	for (const runDir of runDirs.slice(0, limit)) {
		let run;
		try {
			run = JSON.parse(
				await readFile(resolve(runsRoot, runDir.name, "run.json"), "utf8"),
			);
		} catch {
			continue;
		}
		if (
			run?.state !== "succeeded" ||
			run.projectPath !== project ||
			run.resolvedTargetId !== targetId
		) {
			continue;
		}
		const createdAtMs = Date.parse(run.createdAt);
		const finishedAtMs = Date.parse(run.finishedAt);
		if (!Number.isFinite(createdAtMs) || !Number.isFinite(finishedAtMs))
			continue;
		const durationMs = finishedAtMs - createdAtMs;
		if (!Number.isFinite(durationMs) || durationMs < 0) continue;
		durations.push(durationMs);
	}
	if (durations.length < MIN_SAMPLES) return null;
	durations.sort((left, right) => left - right);
	const rank = Math.min(
		durations.length,
		Math.max(1, Math.ceil(0.8 * durations.length)),
	);
	return durations[rank - 1];
}
