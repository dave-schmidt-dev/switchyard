/**
 * Task 3.11: continue the next waterfall attempt from the previous attempt's
 * retained partial.
 *
 * The carried diff is never read from the retained clone, whose `.git` is
 * provider-writable once the attempt ends. It is the diff the engine captured
 * under a verified git-control snapshot, handed to the waterfall in memory
 * (`onVerifiedDiff`). It is carried only when it passes the same scope and
 * sensitive-class gates the integrate path uses; anything else starts clean.
 */
import { join } from "node:path";
import { manifestReviewPaths, validateDiff } from "../integrate/index.mjs";
import {
	MAX_CAPTURE_BYTES,
	verifyGitControl,
	worktreeGit,
} from "./git-control.mjs";
import { CONTINUATION_SKIP_REASONS } from "./routing-state.mjs";

export { CONTINUATION_SKIP_REASONS };

// The run claim names the attempt root; the retained clone is the root
// itself or its `worktree` child.
export const claimCovers = (claimPath, partial) =>
	typeof claimPath === "string" &&
	(claimPath === partial || join(claimPath, "worktree") === partial);

const skip = (sourceAttemptId, reason) => {
	if (!CONTINUATION_SKIP_REASONS.includes(reason))
		throw Object.assign(new Error("continuation_reason_unknown"), {
			code: "continuation_reason_unknown",
		});
	return { sourceAttemptId, skipped: reason };
};

/**
 * Decide whether a retained partial may be carried into the next attempt.
 *
 * @param {object} input
 * @param {object} input.source The previous attempt: `attemptId`,
 *   `partialWorktree`, its engine `result`, its run `record`, and the last
 *   verified capture `captured` ({diff, changedFiles, baseRevision}) or null.
 * @param {object} input.options The next attempt's task options (`files`,
 *   `readOnlyInputs`).
 * @param {string} input.projectPath Canonical host project checkout.
 * @returns {{sourceAttemptId: string, diff: string, files: string[],
 *   baseRevision: string} | {sourceAttemptId: string, skipped: string}}
 */
export function planContinuation({ source, options, projectPath }) {
	const id = source.attemptId;
	const claim = source.record?.worktree;
	if (
		typeof source.partialWorktree !== "string" ||
		source.result?.recovery?.cleanup?.writer?.state !== "stopped" ||
		claim?.writerStopped !== true ||
		(claim.path !== undefined &&
			!claimCovers(claim.path, source.partialWorktree))
	)
		return skip(id, "writer_not_stopped");
	const captured = source.captured;
	if (
		!captured ||
		typeof captured.diff !== "string" ||
		captured.diff.trim() === "" ||
		captured.diff.length > MAX_CAPTURE_BYTES ||
		!Array.isArray(captured.changedFiles) ||
		captured.changedFiles.length === 0 ||
		typeof captured.baseRevision !== "string" ||
		!/^[0-9a-f]{40,64}$/u.test(captured.baseRevision)
	)
		return skip(id, "diff_unavailable");
	const files = options.files ?? [];
	const readOnly = options.readOnlyInputs ?? [];
	const validated = validateDiff(captured.diff, projectPath);
	const touched = [
		...new Set([...captured.changedFiles, ...(validated.touchedPaths ?? [])]),
	];
	if (touched.some((path) => readOnly.includes(path)))
		return skip(id, "read_only_input_changed");
	if (manifestReviewPaths(touched).length > 0)
		return skip(id, "manifest_changed");
	if (
		!validated.safe ||
		(validated.sensitivePaths ?? []).length > 0 ||
		touched.some((path) => path.split("/").includes(".git"))
	)
		return skip(id, "unsafe_diff");
	if (touched.some((path) => !files.includes(path)))
		return skip(id, "out_of_scope");
	return {
		sourceAttemptId: id,
		diff: captured.diff,
		files: files.filter((path) => touched.includes(path)),
		baseRevision: captured.baseRevision,
	};
}

/**
 * Seed a fresh attempt clone with a planned continuation diff via
 * `git apply --index` on the same base. Call only before untrusted code runs
 * in the clone after `gitControl` was taken; the caller must re-snapshot git
 * control when this returns `carried`, because the index changed.
 *
 * A failed apply leaves (or restores) the clean base and returns a closed
 * skip reason. A clone that cannot be restored throws.
 */
export function seedContinuation({
	plan,
	worktreePath,
	baseRevision,
	worktreeBaseRevision,
	gitControl,
	timeout,
}) {
	const id = plan.sourceAttemptId;
	if (plan.baseRevision !== baseRevision) return skip(id, "base_changed");
	if (worktreeBaseRevision !== baseRevision)
		return skip(id, "dirty_overlay_base");
	verifyGitControl(worktreePath, gitControl);
	const apply = (args) =>
		worktreeGit(worktreePath, ["apply", "--index", ...args], {
			input: plan.diff,
			timeout,
		});
	if (apply(["--check"]).status !== 0) return skip(id, "apply_failed");
	if (apply([]).status !== 0) {
		const reset = worktreeGit(
			worktreePath,
			["reset", "--hard", "--quiet", baseRevision],
			{ timeout },
		);
		if (reset.status !== 0)
			throw Object.assign(new Error("workspace_checkout_failed"), {
				code: "workspace_checkout_failed",
			});
		return skip(id, "apply_failed");
	}
	return { sourceAttemptId: id, carried: true, files: [...plan.files] };
}

/**
 * Attempt-record fields for one continuation outcome. A planned carry that
 * the engine never reached records `attempt_not_started`.
 */
export function continuationFields(plan, seeded) {
	if (!plan) return {};
	if (plan.skipped) return { continuationSkipped: plan.skipped };
	if (seeded?.carried) return { continuedFromAttemptId: plan.sourceAttemptId };
	return { continuationSkipped: seeded?.skipped ?? "attempt_not_started" };
}

/**
 * The source partial is superseded only when the continuation succeeded or
 * retained its own partial (which holds the carried work); otherwise the
 * source clone is the only copy and stays retained.
 */
export function sourceSuperseded(fields, result) {
	return (
		fields.continuedFromAttemptId !== undefined &&
		(result?.status === "succeeded" ||
			typeof result?.partialWorktree === "string")
	);
}
