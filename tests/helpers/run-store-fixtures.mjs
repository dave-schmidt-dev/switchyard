import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "./tempdir.mjs";

export const TEST_ROOT = tempDir("switchyard-run-store-");

export const VM_ADMISSION_ROOT = join(TEST_ROOT, "vm-admission");

export function uniqueRunId() {
	return randomUUID();
}

export const RUN_STORE_MODULE_URL = pathToFileURL(
	resolve("src/switchyard/run-store/index.mjs"),
).href;

export function uniquePath(label) {
	return join(TEST_ROOT, `path-${label || uniqueRunId()}`);
}

export function makeOptions(overrides = {}) {
	return {
		runId: uniqueRunId(),
		tasksFilePath: uniquePath("tasks"),
		projectPath: uniquePath("project"),
		orderedTaskIds: ["task-1", "task-2", "task-3"],
		initialHostFingerprint: { git: "abc123", worktree: "clean" },
		launchArgs: ["--provider", "claude"],
		...overrides,
	};
}
