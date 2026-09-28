import { spawnSync } from "node:child_process";

function gitReadOnly(projectPath, args) {
	const result = spawnSync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

function normalizedPathSet(paths) {
	if (
		!Array.isArray(paths) ||
		paths.some((path) => typeof path !== "string" || path.length === 0)
	)
		return null;
	return [...new Set(Array.isArray(paths) ? paths : [])].sort();
}

export function validateExactPathSet(actual, expected) {
	const actualPaths = normalizedPathSet(actual);
	const expectedPaths = normalizedPathSet(expected);
	return {
		ok:
			actualPaths !== null &&
			expectedPaths !== null &&
			JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
		actualPaths,
		expectedPaths,
	};
}

export function validateIntegratedCommitAncestry(
	projectPath,
	integratedCommit,
	currentHead = null,
) {
	if (
		typeof integratedCommit !== "string" ||
		!/^[a-f0-9]{40,64}$/i.test(integratedCommit)
	)
		return { ok: false, reasonCode: "integrated_commit_invalid" };
	const head =
		typeof currentHead === "string" && currentHead.length > 0
			? currentHead
			: gitReadOnly(projectPath, ["rev-parse", "HEAD"]).stdout.trim();
	if (!/^[a-f0-9]{40,64}$/i.test(head))
		return { ok: false, reasonCode: "project_revision_unreadable" };
	const result = gitReadOnly(projectPath, [
		"merge-base",
		"--is-ancestor",
		integratedCommit,
		head,
	]);
	return result.status === 0
		? { ok: true, currentHead: head }
		: {
				ok: false,
				reasonCode: "integrated_commit_not_ancestor",
				currentHead: head,
			};
}

export function validateIntegratedCommitPaths(
	projectPath,
	integratedCommit,
	declaredPaths,
) {
	const parents = gitReadOnly(projectPath, [
		"rev-list",
		"--parents",
		"-n",
		"1",
		integratedCommit,
	]);
	const parentTokens = parents.stdout.trim().split(/\s+/).filter(Boolean);
	if (
		parents.status !== 0 ||
		parentTokens.length === 0 ||
		parentTokens.length > 2
	) {
		return {
			ok: false,
			reasonCode:
				parentTokens.length > 2
					? "integrated_commit_merge_unsupported"
					: "integrated_commit_paths_unreadable",
			actualPaths: [],
			expectedPaths: normalizedPathSet(declaredPaths),
		};
	}
	const result = gitReadOnly(projectPath, [
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		"--root",
		"--find-renames",
		integratedCommit,
	]);
	if (result.status !== 0) {
		return {
			ok: false,
			reasonCode: "integrated_commit_paths_unreadable",
			actualPaths: [],
			expectedPaths: normalizedPathSet(declaredPaths),
		};
	}
	const actualPaths = result.stdout.split("\n").filter(Boolean);
	if (actualPaths.length === 0) {
		return {
			ok: false,
			reasonCode: "integrated_commit_paths_empty",
			actualPaths,
			expectedPaths: normalizedPathSet(declaredPaths),
		};
	}
	const comparison = validateExactPathSet(actualPaths, declaredPaths);
	return {
		...comparison,
		ok: comparison.ok,
		reasonCode: comparison.ok ? undefined : "path_scope_mismatch",
	};
}

export function validateNoTrackedPathOverlap(projectPath, paths) {
	const declared = normalizedPathSet(paths);
	if (declared === null)
		return {
			ok: false,
			reasonCode: "path_scope_malformed",
			overlappingPaths: [],
		};
	if (declared.length === 0) return { ok: true, overlappingPaths: [] };
	const result = gitReadOnly(projectPath, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"--",
		...declared,
	]);
	if (result.status !== 0)
		return {
			ok: false,
			reasonCode: "worktree_status_unreadable",
			overlappingPaths: [],
		};
	const overlappingPaths = result.stdout
		.split("\n")
		.filter(Boolean)
		.filter((line) => line.slice(0, 2) !== "??" && line.slice(0, 2) !== "!!")
		.map((line) => line.slice(3).trim());
	return overlappingPaths.length === 0
		? { ok: true, overlappingPaths: [] }
		: {
				ok: false,
				reasonCode: "tracked_modification_overlaps_task_paths",
				overlappingPaths,
			};
}
