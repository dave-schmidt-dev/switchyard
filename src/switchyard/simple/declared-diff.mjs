import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
	INTEGRATION_UNKNOWN_CAUSES,
	INTEGRATION_UNKNOWN_STEPS,
} from "../diagnostics/failure-registry.mjs";
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

/**
 * Rejection record for a refused `validateDiff` result: the manifest review
 * paths, or the closed rule with no paths. An `integration_state_unknown`
 * refusal also names the closed `git apply` metadata step that was unknown
 * and how it failed, since it has no path to point at.
 */
function diffRejectionFor(validated) {
	if (validated?.requiresReview) {
		return {
			rule: "manifest_review_required",
			paths: validated.sensitivePaths,
		};
	}
	const rule = DIFF_REJECTION_REASON_RULES.has(validated?.reasonKind)
		? validated.reasonKind
		: "unsafe_diff";
	const rejection = { rule, paths: [] };
	if (rule === "integration_state_unknown") {
		if (INTEGRATION_UNKNOWN_STEPS.includes(validated.metadataStep))
			rejection.unknownStep = validated.metadataStep;
		if (INTEGRATION_UNKNOWN_CAUSES.includes(validated.metadataCause))
			rejection.unknownCause = validated.metadataCause;
	}
	return rejection;
}

const SHELL_SAFE_PATH = /^[\w./@%+=:,-]+$/u;
// A flag argument must be the exact declared path, so a path the hint cannot
// print verbatim and safely is counted instead of named.
const HINT_UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const HINT_PATH_MAX_CHARS = 1024;

/**
 * Human-facing next step for a manifest review refusal: the exact
 * `--allow-manifest=<path>` flag for each of the first five printable paths,
 * shell-quoted when needed, plus a count of the paths it does not name. The
 * `=` form keeps a path that starts with `-` an argument. The machine codes
 * (`manifest_review_required`) are unchanged.
 */
function manifestReviewHint(paths) {
	const listed = [];
	for (const path of paths) {
		if (listed.length === DIFF_REJECTION_PATH_LIMIT) break;
		if (
			typeof path === "string" &&
			path.length > 0 &&
			path.length <= HINT_PATH_MAX_CHARS &&
			!HINT_UNPRINTABLE.test(path)
		)
			listed.push(path);
	}
	if (listed.length === 0)
		return `review the ${paths.length} changed manifest${paths.length === 1 ? "" : "s"}, then rerun with --allow-manifest=<path> for each one to allow it`;
	const flags = listed.map(
		(path) =>
			`--allow-manifest=${SHELL_SAFE_PATH.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`}`,
	);
	const unlisted = paths.length - listed.length;
	const more = unlisted > 0 ? ` and ${unlisted} more` : "";
	return `review the change to ${listed.join(", ")}${more}, then rerun with ${flags.join(" ")} to allow it`;
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
	diffRejectionFor,
	manifestReviewHint,
};
