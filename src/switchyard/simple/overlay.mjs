import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { git } from "./args.mjs";
import { sha256, sha256Hex } from "./recovery.mjs";

function fileFingerprint(projectPath, files) {
	const hash = createHash("sha256");
	for (const path of [...files].sort()) {
		const absolute = resolve(projectPath, path);
		hash.update(path).update("\0");
		try {
			const stats = lstatSync(absolute);
			if (stats.isSymbolicLink()) hash.update(`symlink:${stats.mode}`);
			else if (stats.isFile())
				hash.update(`file:${stats.mode}:`).update(readFileSync(absolute));
			else hash.update(`other:${stats.mode}:${stats.size}`);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			hash.update("missing");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}
function dirtyBaselineScopeIdentity({ baseRevision, files, inputs }) {
	return sha256(
		JSON.stringify({
			baseRevision,
			writablePaths: files,
			readOnlyInputs: inputs,
		}),
	);
}
function canonicalJson(value) {
	if (typeof value === "string") {
		return JSON.stringify(value).replaceAll(
			/[\u007f-\uffff]/g,
			(unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	}
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`)
		.join(",")}}`;
}
function makeDirtyBaseline({
	taskId,
	baseRevision,
	projectPath,
	files,
	inputs,
	receipt,
}) {
	const allPaths = [...files, ...inputs];
	const commonDir = git(projectPath, ["rev-parse", "--git-common-dir"]);
	if (commonDir.status !== 0)
		throw new Error("dirty baseline repository identity unavailable");
	const commonPath = commonDir.stdout.trim();
	const repositoryPath = realpathSync(
		isAbsolute(commonPath) ? commonPath : resolve(projectPath, commonPath),
	);
	const baseline = {
		task_id: taskId,
		base_commit: baseRevision,
		repository_identity: sha256Hex(repositoryPath),
		host_identity: hostname().trim() || "unknown-host",
		writable_paths: [...files],
		read_only_inputs: [...inputs],
		files: Object.fromEntries(
			allPaths.map((path) => {
				const entry = receipt.paths.find(
					(candidate) => candidate.path === path,
				);
				return [
					path,
					{
						sha256: entry.sha256,
						size: entry.size,
						mode: entry.mode & 0o111 ? 0o100755 : 0o100644,
						...(entry.tracked === false
							? { tracked: false, predecessor: entry.predecessor }
							: { tracked: true }),
					},
				];
			}),
		),
	};
	return {
		...baseline,
		receipt_sha256: sha256Hex(canonicalJson(baseline)),
	};
}
function extractErrno(error) {
	if (!error) return null;
	const candidates = [
		error.code,
		error.errno,
		error.cause?.code,
		error.cause?.errno,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && /^[A-Z0-9]+$/u.test(candidate)) {
			return candidate;
		}
	}
	if (typeof error.message === "string") {
		const match =
			/\b(EPERM|EACCES|EROFS|ENOSPC|EMFILE|ENFILE|EIO|EDQUOT|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|ENETDOWN)\b/u.exec(
				error.message,
			);
		if (match) return match[1];
	}
	return null;
}
function dirtyOverlayFailure(error, { taskId, baseRevision, files, inputs }) {
	const message = String(error?.message ?? "dirty overlay preflight failed");
	const errno = extractErrno(error);
	let code = errno ?? "dirty_overlay_preflight_failed";
	let condition = "declared dirty input could not be captured";
	let remedy =
		"keep the declared inputs tracked, regular, non-secret files and retry";
	if (errno === "EPERM" || errno === "EACCES") {
		code = errno;
		condition = "filesystem permission denied during overlay capture";
		remedy = "ensure read access to declared input files";
	} else if (errno) {
		code = errno;
		condition = "filesystem error during overlay capture";
		remedy = "resolve filesystem issue";
	} else if (
		/predecessor.*mismatch/iu.test(message) ||
		error?.code === "predecessor_receipt_mismatch"
	) {
		code = "predecessor_receipt_mismatch";
		condition = "predecessor receipt base revision or digest mismatched";
		remedy = "provide a valid matching predecessor receipt or track the file";
	} else if (
		/predecessor.*missing/iu.test(message) ||
		error?.code === "predecessor_receipt_missing"
	) {
		code = "predecessor_receipt_missing";
		condition = "predecessor receipt file is missing";
		remedy = "provide an existing predecessor receipt file";
	} else if (error?.code === "predecessor_receipt_unverified") {
		code = "predecessor_receipt_unverified";
		condition = "predecessor run is not a completed accepted result";
		remedy =
			"wait for predecessor cleanup to complete and use its durable receipt";
	} else if (
		/predecessor/iu.test(message) ||
		error?.code === "predecessor_receipt_invalid"
	) {
		code = "predecessor_receipt_invalid";
		condition = "predecessor receipt is invalid";
		remedy = "provide a valid predecessor receipt";
	} else if (/untracked/u.test(message)) {
		code = "dirty_overlay_untracked";
		condition = "a scoped input is untracked";
		remedy = "track the input or remove it from --file/--input";
	} else if (/deleted|ENOENT/u.test(message)) {
		code = "dirty_overlay_deleted";
		condition = "a scoped input is deleted or unavailable";
		remedy = "restore the input or remove it from --file/--input";
	} else if (/ignored/u.test(message)) {
		code = "dirty_overlay_ignored";
		condition = "a scoped input is ignored by Git";
		remedy = "remove the ignore rule or remove the input from --file/--input";
	} else if (/symlink/u.test(message)) {
		code = "dirty_overlay_symlink";
		condition = "a scoped input crosses or names a symlink";
		remedy = "declare a regular tracked file without symlink parents";
	} else if (/too large/u.test(message)) {
		code = "dirty_overlay_oversized";
		condition = "a scoped input exceeds the 8 MiB simple transport limit";
		remedy = "reduce the file below 8 MiB or remove it from the scope";
	} else if (/regular file/u.test(message)) {
		code = "dirty_overlay_not_regular";
		condition = "a scoped input is not one regular file";
		remedy = "replace the scoped path with a tracked regular file";
	} else if (/secret-shaped|credential/u.test(message)) {
		code = "dirty_overlay_secret_path";
		condition = "a scoped input matches a credential or secret path convention";
		remedy = "remove the secret-shaped path from the scope";
	}
	return {
		code,
		condition,
		remedy,
		identity: dirtyBaselineScopeIdentity({
			baseRevision,
			files,
			inputs,
		}),
		taskId,
	};
}
function declaredPathsAreClean(projectPath, files) {
	const result = git(projectPath, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--",
		...files,
	]);
	return result.status === 0 && result.stdout.length === 0;
}
const FIRST_CHANGE_PROBE_INTERVAL_MS = 5_000;
function emitStatus(onStatus, taskId, phase, details = {}) {
	try {
		onStatus?.({ schemaVersion: 1, taskId, phase, ...details });
	} catch {
		// Status reporting cannot change execution.
	}
}

export {
	declaredPathsAreClean,
	dirtyOverlayFailure,
	emitStatus,
	extractErrno,
	FIRST_CHANGE_PROBE_INTERVAL_MS,
	fileFingerprint,
	makeDirtyBaseline,
};
