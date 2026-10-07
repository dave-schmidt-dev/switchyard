import { lstatSync } from "node:fs";
import { join } from "node:path";
import { requireWorktreeGit, verifyGitControl } from "./args.mjs";

function declaredFileStat(worktreePath, path) {
	try {
		const stats = lstatSync(join(worktreePath, path));
		return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
	} catch {
		return null;
	}
}
/** First-change probe: lstat only, so no host git runs while the provider is live. */
function declaredFilesChanged(worktreePath, files, baseline) {
	return files.some((path) => {
		const current = declaredFileStat(worktreePath, path);
		const before = baseline.get(path) ?? null;
		if ((before === null) !== (current === null)) return true;
		return (
			current !== null &&
			(before.size !== current.size ||
				before.mtimeMs !== current.mtimeMs ||
				before.ino !== current.ino)
		);
	});
}
const DEADLINE_CHANGED_FILES_TIMEOUT_MS = 5000;
const DIFF_REJECTION_PATH_LIMIT = 5;
const DIFF_REJECTION_PATH_MAX_CHARS = 200;
const DIFF_REJECTION_REASON_RULES = new Set([
	"empty_diff",
	"path_escapes_project_root",
	"git_internals_touched",
	"credential_path_touched",
	"symlink_creation_refused",
	"executable_file_refused",
	"integration_state_unknown",
	"corrupt_patch",
	"conflict",
]);

function boundedRejectionPaths(paths) {
	const bounded = [];
	for (const path of paths ?? []) {
		if (typeof path !== "string") continue;
		// Provider-chosen names must not inject terminal control sequences.
		bounded.push(
			path.replace(/\p{Cc}/gu, "?").slice(0, DIFF_REJECTION_PATH_MAX_CHARS),
		);
		if (bounded.length === DIFF_REJECTION_PATH_LIMIT) break;
	}
	return bounded;
}

function validateDiffRejectionRule(validated) {
	return DIFF_REJECTION_REASON_RULES.has(validated?.reasonKind)
		? validated.reasonKind
		: "unsafe_diff";
}

export function captureDeadlineChangedFiles({
	worktreePath,
	worktreeBaseRevision,
	worktreeGitControl,
	writerLifecycle,
}) {
	if (
		(writerLifecycle !== "stopped" && writerLifecycle !== "never_started") ||
		!worktreePath ||
		!worktreeBaseRevision ||
		!worktreeGitControl
	) {
		return { files: [], available: false };
	}
	try {
		const guarded = (args, code) => {
			verifyGitControl(worktreePath, worktreeGitControl);
			return requireWorktreeGit(worktreePath, args, code, {
				timeout: DEADLINE_CHANGED_FILES_TIMEOUT_MS,
			});
		};
		guarded(["add", "-A", "--", "."], "diff_stage_failed");
		const changed = guarded(
			["diff", "--cached", "--name-only", "-z", worktreeBaseRevision],
			"diff_names_failed",
		);
		return { files: changed.split("\0").filter(Boolean), available: true };
	} catch (error) {
		if (error?.code === "git_control_tampered") throw error;
		return { files: [], available: false };
	}
}

export {
	boundedRejectionPaths,
	declaredFileStat,
	declaredFilesChanged,
	validateDiffRejectionRule,
};
