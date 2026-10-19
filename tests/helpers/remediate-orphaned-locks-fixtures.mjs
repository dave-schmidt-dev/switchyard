import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getStateRoot } from "../../src/switchyard/run-store/index.mjs";
import { tempDir } from "./tempdir.mjs";

export const TEST_ROOT = tempDir("switchyard-remediate-locks-");

export function uniqueRunId() {
	return randomUUID();
}

export function uniquePath(label) {
	return join(TEST_ROOT, `path-${label || uniqueRunId()}`);
}

export function makeOptions(overrides = {}) {
	// uniquePath() with no label falls back to a fresh uuid per call — unlike
	// a fixed literal label, which would hand every unlabeled makeOptions()
	// call in a test the same path and collide on acquireProjectLock.
	return {
		runId: uniqueRunId(),
		tasksFilePath: uniquePath(),
		projectPath: uniquePath(),
		orderedTaskIds: ["task-1"],
		initialHostFingerprint: { git: "abc123", worktree: "clean" },
		launchArgs: [],
		...overrides,
	};
}

export function projectLockFilePath(canonicalProjectPath) {
	const identity = `project:${resolve(canonicalProjectPath)}`;
	const hash = createHash("sha256").update(identity).digest("hex");
	return resolve(getStateRoot(), "locks", `${hash}.lock`);
}

/**
 * Writes the launch lock the retired queue launcher took per tasks file.
 *
 * Its `{runId, createdAt}` body matches a pre-`projectPath` project lock, so
 * lock recovery must tell the two apart by filename hash. Old state roots can
 * still hold one, which is why the fixture outlives the launcher.
 *
 * @param {string} tasksPath Tasks file the launch lock was named after.
 * @param {string} runId Run that held it.
 * @returns {string} The lock file path.
 */
export function writeLegacyLaunchLock(tasksPath, runId) {
	const locks = resolve(getStateRoot(), "locks");
	mkdirSync(locks, { recursive: true, mode: 0o700 });
	const hash = createHash("sha256").update(resolve(tasksPath)).digest("hex");
	const path = resolve(locks, `${hash}.lock`);
	writeFileSync(
		path,
		JSON.stringify({ runId, createdAt: new Date().toISOString() }),
		{ flag: "wx", mode: 0o600 },
	);
	return path;
}
