import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const GIT_ARGS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.attributesFile=/dev/null",
	"-c",
	"diff.external=",
	"-c",
	"diff.trustExitCode=false",
	"-c",
	"filter.lfs.smudge=",
	"-c",
	"filter.lfs.required=false",
];
function sha(value) {
	return createHash("sha256").update(value).digest("hex");
}
function safeEnv(home) {
	home = realpathSync(home);
	return {
		PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
		HOME: home,
		TMPDIR: home,
		XDG_CONFIG_HOME: home,
		CI: "true",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_LFS_SKIP_SMUDGE: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/usr/bin/false",
	};
}
export function quickCheckSandboxProfile(clone, runtime) {
	clone = realpathSync(clone);
	runtime = realpathSync(runtime);
	const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
	const npmRoot = dirname(dirname(realpathSync("/opt/homebrew/bin/npm")));
	const reads = [
		"/System",
		"/usr",
		"/bin",
		"/sbin",
		"/dev",
		"/opt/homebrew/Cellar",
		"/opt/homebrew/opt",
		"/opt/homebrew/etc/openssl@3/openssl.cnf",
		nodeRoot,
		npmRoot,
		"/opt/homebrew/bin/node",
		"/opt/homebrew/bin/npm",
		clone,
		runtime,
	];
	const ancestors = new Set(["/"]);
	for (const path of reads) {
		let current = dirname(path);
		while (current !== "/") {
			ancestors.add(current);
			current = dirname(current);
		}
	}
	const literals = [...ancestors]
		.filter((path) => path !== "/")
		.map((path) => `(literal ${JSON.stringify(path)})`)
		.join(" ");
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow sysctl-read)",
		'(allow file-read* (literal "/"))',
		`(allow file-read-metadata ${literals})`,
		`(allow file-read* ${reads.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})`,
		`(allow file-write* (subpath ${JSON.stringify(clone)}) (subpath ${JSON.stringify(runtime)}) (literal "/dev/null"))`,
	].join("\n");
}
function git(cwd, env, args, input) {
	const result = spawnSync("git", [...GIT_ARGS, ...args], {
		cwd,
		env,
		input,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.status !== 0 || result.error)
		throw new Error("git_operation_failed");
	return result.stdout.trim();
}
function validSnapshotPath(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.includes("\0") &&
		!path.includes("\\") &&
		path
			.split("/")
			.every((part) => part && part !== "." && part !== ".." && part !== ".git")
	);
}
function prepareExactBase(clone, projectPath, env, baseTree, snapshotPaths) {
	if (
		!Array.isArray(snapshotPaths) ||
		snapshotPaths.length > 4096 ||
		!snapshotPaths.every(validSnapshotPath)
	)
		throw new Error("base_mismatch");
	const trusted = new Set(snapshotPaths);
	const observed = spawnSync(
		"git",
		[
			...GIT_ARGS,
			"status",
			"--porcelain=v1",
			"--no-renames",
			"-z",
			"--untracked-files=all",
		],
		{
			cwd: projectPath,
			env,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (
		observed.status !== 0 ||
		observed.error ||
		typeof observed.stdout !== "string"
	)
		throw new Error("base_mismatch");
	for (const row of observed.stdout.split("\0").filter(Boolean)) {
		const changedPath = row.slice(3);
		if (row.length < 4) throw new Error("base_mismatch");
		if (row.startsWith("?? ")) continue;
		if (!trusted.has(changedPath)) throw new Error("base_mismatch");
	}
	git(clone, env, ["read-tree", "HEAD"]);
	if (trusted.size) {
		git(
			clone,
			{ ...env, GIT_WORK_TREE: projectPath, GIT_LITERAL_PATHSPECS: "1" },
			["add", "-A", "--", ...trusted],
		);
	}
	if (git(clone, env, ["write-tree"]) !== baseTree)
		throw new Error("base_mismatch");
	git(clone, env, ["checkout-index", "-a", "-f"]);
	git(clone, env, ["diff", "--quiet"]);
}

export { git, prepareExactBase, safeEnv, sha };
