import { createHash, randomUUID } from "node:crypto";
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
