import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const TASK_BASE_REF_PREFIX = "refs/switchyard/task-base";
const ZERO_OBJECT_ID = "0".repeat(40);
const TASK_BASE_PROBE_TIMEOUT_MS = 30_000;
const PRLCTL_LOST_RESULT =
	/PrlJob_(?:GetRetCode|GetResult):\s*Invalid argument\b/u;
const DIRTY_OVERLAY_VERSION = 2;
const DIRTY_OVERLAY_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DIRTY_OVERLAY_SECRET_PATHS = [
	/(^|\/)\.env(?:\.|$)/iu,
	/(^|\/)\.npmrc$/iu,
	/(^|\/)\.netrc$/iu,
	/(^|\/)\.ssh\//iu,
	/(^|\/)(?:id_rsa|id_ed25519)/iu,
	/\.(?:pem|key)$/iu,
	/(^|\/)credentials(?:\.|$)/iu,
	/(^|\/)secrets?\.(?:json|ya?ml|toml)$/iu,
	/(^|\/)\.aws\/credentials$/iu,
	/(^|\/)\.docker\/config\.json$/iu,
];
function stableJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
		.join(",")}}`;
}
function overlayHash(value) {
	return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}
function gitRead(projectPath, args) {
	const result = spawnSync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const error = new Error(
			`dirty overlay git probe failed: ${args.join(" ")}`,
		);
		error.code = "dirty_overlay_probe_failed";
		throw error;
	}
	return result.stdout ?? "";
}
function normalizeOverlayPath(projectPath, value) {
	if (typeof value !== "string" || value.trim() === "")
		throw new Error("dirty overlay path must be a non-empty string");
	const raw = value.trim().replaceAll("\\", "/");
	if (isAbsolute(raw) || raw.split("/").includes("..") || raw.includes("\0"))
		throw new Error(`dirty overlay path is outside the project: ${value}`);
	const normalized = raw.replace(/^\.\//u, "");
	const target = resolve(projectPath, normalized);
	const root = resolve(projectPath);
	if (target !== root && !target.startsWith(`${root}${sep}`))
		throw new Error(`dirty overlay path is outside the project: ${value}`);
	return normalized;
}
function assertOverlayPathSafe(
	projectPath,
	path,
	{ enforceTarPathLimit = true, secretPaths = DIRTY_OVERLAY_SECRET_PATHS } = {},
) {
	if (enforceTarPathLimit && Buffer.byteLength(path, "utf8") > 100)
		throw new Error(`dirty overlay path exceeds tar name limit: ${path}`);
	if (secretPaths.some((pattern) => pattern.test(path))) {
		throw new Error(`dirty overlay rejects secret-shaped path: ${path}`);
	}
	let prefix = resolve(projectPath);
	for (const component of path.split("/")) {
		prefix = join(prefix, component);
		try {
			if (lstatSync(prefix).isSymbolicLink())
				throw new Error(`dirty overlay rejects symlink path: ${path}`);
		} catch (error) {
			if (error?.code === "ENOENT") break;
			throw error;
		}
	}
}
export function ignoredPath(projectPath, path) {
	const result = spawnSync(
		"git",
		["check-ignore", "--no-index", "-q", "--", path],
		{
			cwd: projectPath,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	return result.status === 0;
}
function trackedPath(projectPath, path) {
	const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], {
		cwd: projectPath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return result.status === 0 && result.stdout.trim() === path;
}
function statusPaths(projectPath) {
	const output = gitRead(projectPath, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	const paths = [];
	for (const entry of output.split("\0")) {
		if (!entry) continue;
		const value = entry.slice(3);
		paths.push(value.includes(" -> ") ? value.split(" -> ").at(-1) : value);
	}
	return paths.map((path) => path.replace(/^"|"$/gu, "").replaceAll("\\", "/"));
}
function overlayFingerprint(projectPath) {
	const gitDir = gitRead(projectPath, [
		"rev-parse",
		"--absolute-git-dir",
	]).trim();
	return `host:${createHash("sha256")
		.update(stableJson([hostname(), realpathSync(projectPath), gitDir]), "utf8")
		.digest("hex")}`;
}
function assertReceiptParentSafe(receiptPath) {
	const parent = dirname(resolve(receiptPath));
	const stats = lstatSync(parent);
	const ownerUid =
		typeof process.getuid === "function" ? process.getuid() : null;
	if (
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		(ownerUid !== null && stats.uid !== ownerUid) ||
		(stats.mode & 0o022) !== 0
	)
		throw new Error(
			"dirty overlay receipt parent is not a private regular directory",
		);
}

export {
	assertOverlayPathSafe,
	assertReceiptParentSafe,
	DIRTY_OVERLAY_MAX_FILE_BYTES,
	DIRTY_OVERLAY_SECRET_PATHS,
	DIRTY_OVERLAY_VERSION,
	gitRead,
	normalizeOverlayPath,
	overlayFingerprint,
	overlayHash,
	PRLCTL_LOST_RESULT,
	stableJson,
	statusPaths,
	TASK_BASE_PROBE_TIMEOUT_MS,
	TASK_BASE_REF_PREFIX,
	trackedPath,
	ZERO_OBJECT_ID,
};
