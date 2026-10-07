import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const WORKTREE_GIT_CONFIG = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"core.commitGraph=false",
	"-c",
	"diff.external=",
	"-c",
	"core.attributesFile=/dev/null",
];
const TAMPER_AREAS = new Set([
	"config",
	"hooks",
	"info",
	"objects",
	"refs",
	"logs",
	"index",
	"packed-refs",
]);
function tamperArea(path) {
	if (path === "") return "root";
	const component = path.split("/")[0].toLowerCase();
	if (component === "head") return "HEAD";
	return TAMPER_AREAS.has(component) ? component : "other";
}
// The kind and area are closed enums and the only tamper evidence a caller
// may surface; the message and the provider-controlled path stay diagnostics.
function gitControlTampered(tamperKind, path, message) {
	const error = new Error(`git_control_tampered: ${message}`);
	error.code = "git_control_tampered";
	error.tamperKind = tamperKind;
	error.tamperArea = tamperArea(path);
	return error;
}
/**
 * Host git against a provider-writable clone. The git-dir and work-tree are
 * pinned, system and global config are dropped, hooks, fsmonitor, the
 * untracked cache, attribute files and external diff drivers are disabled,
 * and replace refs are ignored.
 */
export function worktreeGit(worktreePath, args, options = {}) {
	const hardenedArgs =
		args[0] === "diff"
			? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
			: args;
	return spawnSync(
		"git",
		[
			"--git-dir",
			join(worktreePath, ".git"),
			"--work-tree",
			worktreePath,
			...WORKTREE_GIT_CONFIG,
			...hardenedArgs,
		],
		{
			cwd: worktreePath,
			encoding: options.encoding ?? "utf8",
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: "C",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CEILING_DIRECTORIES: dirname(worktreePath),
				GIT_NO_REPLACE_OBJECTS: "1",
			},
			input: options.input,
			maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
			timeout: options.timeout,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
}
export function requireWorktreeGit(worktreePath, args, code, options = {}) {
	const result = worktreeGit(worktreePath, args, options);
	if (result.status !== 0) {
		const failureCode =
			result.error?.code === "ETIMEDOUT" ? "deadline_expired" : code;
		const error = new Error(failureCode);
		error.code = failureCode;
		throw error;
	}
	return result.stdout;
}
function gitControlEntry(stats) {
	return {
		type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	};
}
// An entry that vanished mid-walk is reported by the comparison; any other
// inspection error (for example a provider chmod 000) is tampering, so it can
// never surface as an ordinary failure that retains the checkout.
function inspectGitControl(path, inspect) {
	try {
		return inspect();
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw gitControlTampered(
			"uninspectable",
			path,
			`cannot inspect .git/${path}`,
		);
	}
}
function collectGitControlEntries(gitDir) {
	const entries = new Map();
	const pending = [["", gitDir]];
	while (pending.length > 0) {
		const [relative, absolute] = pending.pop();
		const dirents =
			inspectGitControl(relative, () =>
				readdirSync(absolute, { withFileTypes: true }),
			) ?? [];
		for (const dirent of dirents) {
			const childRelative = relative
				? `${relative}/${dirent.name}`
				: dirent.name;
			const childAbsolute = join(absolute, dirent.name);
			const stats = inspectGitControl(childRelative, () =>
				lstatSync(childAbsolute),
			);
			if (stats === null) continue;
			const entry = gitControlEntry(stats);
			if (entry.type === "file") {
				const bytes = inspectGitControl(childRelative, () =>
					readFileSync(childAbsolute),
				);
				if (bytes === null) continue;
				entry.sha256 = createHash("sha256").update(bytes).digest("hex");
			}
			entries.set(childRelative, entry);
			if (entry.type === "directory")
				pending.push([childRelative, childAbsolute]);
		}
	}
	return entries;
}
/** Record every path under the clone's `.git` before untrusted code runs. */
export function snapshotGitControl(worktreePath) {
	const gitDir = join(worktreePath, ".git");
	let stats;
	try {
		stats = lstatSync(gitDir);
	} catch (error) {
		if (error?.code === "ENOENT")
			throw gitControlTampered("missing", "", "missing .git");
		throw error;
	}
	if (!stats.isDirectory())
		throw gitControlTampered("replaced", "", ".git is not a directory");
	return {
		dev: stats.dev,
		ino: stats.ino,
		entries: collectGitControlEntries(gitDir),
	};
}
const ALTERNATES_PATH = "objects/info/alternates";
const OBJECTS_INFO_PATH = "objects/info";
// Dumb-transport ref list written by update-server-info (run by repack); local
// git never reads it.
const WRITABLE_GIT_PATHS = new Set([
	"index",
	"head",
	"orig_head",
	"fetch_head",
	"commit_editmsg",
	"packed-refs",
	"info/refs",
]);
function providerWritableGitPath(path) {
	// Git resolves paths case-insensitively on the default macOS filesystem,
	// so every protection decision is case-folded too.
	const folded = path.toLowerCase();
	if (WRITABLE_GIT_PATHS.has(folded)) return true;
	// Under objects/info the only writable entries are that directory itself
	// and exactly packs (written by update-server-info during the trusted
	// shared-clone detach `repack -a -d`). Alternates and http-alternates
	// redirect object lookup outside the clone, and host git trusts a
	// commit-graph cache without verifying it, so a forged one would silently
	// rewrite the captured diff.
	if (folded === "objects" || folded.startsWith("objects/")) {
		return (
			!folded.startsWith(`${OBJECTS_INFO_PATH}/`) ||
			folded === "objects/info/packs"
		);
	}
	if (folded === "refs" || folded.startsWith("refs/"))
		return !(folded === "refs/replace" || folded.startsWith("refs/replace/"));
	return folded === "logs" || folded.startsWith("logs/");
}
function packedRefsNamesReplaceRef(content) {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("^"))
			continue;
		const name = trimmed.split(/\s+/u)[1];
		if (typeof name !== "string") continue;
		if (name.toLowerCase().startsWith("refs/replace/")) return true;
	}
	return false;
}
function packedRefsFileNamesReplaceRef(gitDir) {
	try {
		return packedRefsNamesReplaceRef(
			readFileSync(join(gitDir, "packed-refs"), "utf8"),
		);
	} catch {
		return true;
	}
}
// A directory's own size and mtime move whenever a child is added or removed;
// those children are judged individually, so directories compare by identity.
function gitControlEntryChanged(before, current) {
	if (before.type === "directory" && current.type === "directory")
		return before.dev !== current.dev || before.ino !== current.ino;
	return (
		before.type !== current.type ||
		before.dev !== current.dev ||
		before.ino !== current.ino ||
		before.size !== current.size ||
		before.mtimeMs !== current.mtimeMs ||
		before.sha256 !== current.sha256
	);
}
/**
 * Fail closed before any host git call on a provider-writable clone: only the
 * object database, refs (never replace refs), the index, logs and a few HEAD
 * scratch files may differ from the pre-provider snapshot, and nothing under
 * `.git` may be a symlink, FIFO, socket or device.
 */
export function verifyGitControl(worktreePath, snapshot) {
	if (!snapshot)
		throw gitControlTampered("missing_snapshot", "", "missing snapshot");
	const gitDir = join(worktreePath, ".git");
	let rootStats;
	try {
		rootStats = lstatSync(gitDir);
	} catch (error) {
		if (error?.code === "ENOENT")
			throw gitControlTampered("missing", "", "missing .git");
		throw error;
	}
	if (
		!rootStats.isDirectory() ||
		rootStats.dev !== snapshot.dev ||
		rootStats.ino !== snapshot.ino
	)
		throw gitControlTampered("replaced", "", ".git replaced");
	const current = collectGitControlEntries(gitDir);
	for (const [path, entry] of current) {
		if (entry.type === "other")
			throw gitControlTampered(
				"non_regular",
				path,
				`non-regular .git entry: ${path}`,
			);
		const before = snapshot.entries.get(path);
		if (before === undefined) {
			if (!providerWritableGitPath(path))
				throw gitControlTampered("added", path, `added .git/${path}`);
		} else if (before.type !== entry.type) {
			throw gitControlTampered("retyped", path, `retyped .git/${path}`);
		} else if (
			!providerWritableGitPath(path) &&
			gitControlEntryChanged(before, entry)
		) {
			throw gitControlTampered("changed", path, `changed .git/${path}`);
		}
		if (
			path.toLowerCase() === "packed-refs" &&
			(before === undefined || gitControlEntryChanged(before, entry)) &&
			packedRefsFileNamesReplaceRef(gitDir)
		)
			throw gitControlTampered(
				"replace_ref",
				"packed-refs",
				"packed-refs names refs/replace/",
			);
	}
	// Removing alternates only narrows object lookup to the clone itself; the
	// native launcher does exactly this when it detaches a shared clone.
	for (const path of snapshot.entries.keys()) {
		if (
			!current.has(path) &&
			path.toLowerCase() !== ALTERNATES_PATH &&
			!providerWritableGitPath(path)
		)
			throw gitControlTampered("removed", path, `removed .git/${path}`);
	}
}
