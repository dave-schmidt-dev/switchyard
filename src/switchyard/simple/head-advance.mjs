import { spawnSync } from "node:child_process";

const HEAD_ADVANCE_GIT_TIMEOUT_MS = 10_000;

function gitExitStatus(projectPath, args) {
	const result = spawnSync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: HEAD_ADVANCE_GIT_TIMEOUT_MS,
	});
	return result.status;
}

/**
 * True when `head` descends from `base` and the commits between them changed
 * none of `paths`. A failed probe, a non-ancestor head or an invalid argument
 * is false: every one of those is a genuine conflict for the caller.
 */
export function headAdvanceSafe({ projectPath, base, head, paths = [] } = {}) {
	if (
		typeof projectPath !== "string" ||
		projectPath.length === 0 ||
		typeof base !== "string" ||
		base.length === 0 ||
		typeof head !== "string" ||
		head.length === 0
	)
		return false;
	if (base === head) return true;
	const declared = Array.isArray(paths)
		? paths.filter((path) => typeof path === "string" && path.length > 0)
		: [];
	if (
		gitExitStatus(projectPath, ["merge-base", "--is-ancestor", base, head]) !==
		0
	)
		return false;
	if (declared.length === 0) return true;
	return (
		gitExitStatus(projectPath, [
			"diff",
			"--quiet",
			base,
			head,
			"--",
			...declared,
		]) === 0
	);
}
