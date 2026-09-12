// Lifecycle module - workspace seeding
// INV-3: The workspace is wiped at project end (see ExecutionBackend.destroy)

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const TASK_BASE_REF_PREFIX = "refs/switchyard/task-base";
const ZERO_OBJECT_ID = "0".repeat(40);
const TASK_BASE_PROBE_TIMEOUT_MS = 30_000;
const PRLCTL_LOST_RESULT =
	/PrlJob_(?:GetRetCode|GetResult):\s*Invalid argument\b/u;
const DIRTY_OVERLAY_VERSION = 1;
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

function assertOverlayPathSafe(projectPath, path) {
	if (Buffer.byteLength(path, "utf8") > 100)
		throw new Error(`dirty overlay path exceeds tar name limit: ${path}`);
	if (DIRTY_OVERLAY_SECRET_PATHS.some((pattern) => pattern.test(path))) {
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

/**
 * Report whether a project's ignore rules cover a path.
 *
 * Exported so dispatch can refuse an overlay checkpoint or receipt that would
 * land inside the project unignored, where the capture's own scope check would
 * later see it as an untracked stray.
 *
 * @param {string} projectPath project root
 * @param {string} path path relative to the project root
 * @returns {boolean} true when the path is ignored
 */
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

// The fingerprint identifies the host repository instance the bytes came from,
// not its volatile dirty set: content drift is reported by the per-file byte
// check and an unexpected dirty path by the scope check, so folding either into
// this value would only mask the more specific reason.
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

/**
 * Capture an immutable, content-addressed overlay of exact tracked regular
 * files. The returned receipt contains the bytes needed by a detached worker;
 * callers may persist it with writeDirtyOverlayReceipt().
 */
export function captureDirtyOverlay(
	projectPath,
	paths,
	{ hostFingerprint = null } = {},
) {
	if (!Array.isArray(paths) || paths.length === 0)
		throw new Error("dirty overlay requires at least one declared path");
	const normalized = paths.map((path) =>
		normalizeOverlayPath(projectPath, path),
	);
	if (new Set(normalized).size !== normalized.length)
		throw new Error("dirty overlay rejects duplicate paths");
	const sourceHead = gitRead(projectPath, ["rev-parse", "HEAD"]).trim();
	const status = statusPaths(projectPath);
	const declared = new Set(normalized);
	for (const changed of status) {
		const candidate = changed.replace(/^\?\?\s+/u, "").replace(/^..\s+/u, "");
		if (!declared.has(candidate))
			throw new Error(
				`dirty overlay rejects out-of-scope or untracked path: ${candidate}`,
			);
	}
	const entries = normalized.map((path) => {
		assertOverlayPathSafe(projectPath, path);
		if (!trackedPath(projectPath, path))
			throw new Error(`dirty overlay rejects untracked path: ${path}`);
		if (ignoredPath(projectPath, path))
			throw new Error(`dirty overlay rejects ignored path: ${path}`);
		const target = resolve(projectPath, path);
		const stats = lstatSync(target);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
			throw new Error(`dirty overlay requires one regular file: ${path}`);
		if (stats.size > DIRTY_OVERLAY_MAX_FILE_BYTES)
			throw new Error(`dirty overlay file is too large: ${path}`);
		const bytes = readFileSync(target);
		const afterRead = lstatSync(target);
		if (
			!afterRead.isFile() ||
			afterRead.isSymbolicLink() ||
			afterRead.nlink !== stats.nlink ||
			afterRead.size !== stats.size ||
			(afterRead.mode & 0o777) !== (stats.mode & 0o777)
		)
			throw new Error(`dirty overlay file changed while reading: ${path}`);
		return {
			path,
			mode: stats.mode & 0o777,
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.toString("base64"),
		};
	});
	const body = {
		schemaVersion: DIRTY_OVERLAY_VERSION,
		kind: "tracked_dirty_overlay",
		sourceHead,
		hostFingerprint: hostFingerprint ?? overlayFingerprint(projectPath),
		paths: entries,
	};
	return { ...body, receiptHash: overlayHash(body) };
}

/** Validate receipt identity and current host bytes without recapturing them. */
export function validateDirtyOverlayReceipt(
	projectPath,
	receipt,
	expectedPaths = null,
) {
	if (
		!receipt ||
		receipt.schemaVersion !== DIRTY_OVERLAY_VERSION ||
		receipt.kind !== "tracked_dirty_overlay"
	)
		return { ok: false, reason: "dirty_overlay_receipt_invalid" };
	if (
		!Array.isArray(receipt.paths) ||
		receipt.paths.length === 0 ||
		receipt.paths.some(
			(entry) =>
				!entry ||
				typeof entry.path !== "string" ||
				!Number.isInteger(entry.size) ||
				entry.size < 0 ||
				entry.size > DIRTY_OVERLAY_MAX_FILE_BYTES ||
				!/^[0-7]+$/.test(String(entry.mode)) ||
				!/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "") ||
				typeof entry.bytes !== "string",
		)
	)
		return { ok: false, reason: "dirty_overlay_receipt_invalid" };
	if (!/^[a-f0-9]{64}$/u.test(receipt.receiptHash ?? ""))
		return { ok: false, reason: "dirty_overlay_receipt_hash_invalid" };
	const { receiptHash, ...body } = receipt;
	if (overlayHash(body) !== receiptHash)
		return { ok: false, reason: "dirty_overlay_receipt_changed" };
	const declared = Array.isArray(expectedPaths)
		? expectedPaths.map((path) => normalizeOverlayPath(projectPath, path))
		: null;
	if (
		declared &&
		stableJson(declared) !==
			stableJson(receipt.paths.map((entry) => entry.path))
	)
		return { ok: false, reason: "dirty_overlay_scope_mismatch" };
	try {
		if (
			gitRead(projectPath, ["rev-parse", "HEAD"]).trim() !== receipt.sourceHead
		)
			return { ok: false, reason: "dirty_overlay_source_head_drift" };
		const currentStatus = statusPaths(projectPath);
		if (receipt.hostFingerprint !== overlayFingerprint(projectPath))
			return { ok: false, reason: "dirty_overlay_host_drift" };
		for (const changed of currentStatus) {
			if (!receipt.paths.some((entry) => entry.path === changed))
				return { ok: false, reason: "dirty_overlay_scope_mismatch" };
		}
		for (const entry of receipt.paths) {
			assertOverlayPathSafe(projectPath, entry.path);
			if (!trackedPath(projectPath, entry.path))
				return { ok: false, reason: "dirty_overlay_untracked" };
			if (ignoredPath(projectPath, entry.path))
				return { ok: false, reason: "dirty_overlay_ignored" };
			const stats = lstatSync(resolve(projectPath, entry.path));
			const bytes = readFileSync(resolve(projectPath, entry.path));
			const receiptBytes = Buffer.from(entry.bytes, "base64");
			const afterRead = lstatSync(resolve(projectPath, entry.path));
			if (
				!stats.isFile() ||
				stats.isSymbolicLink() ||
				stats.nlink !== 1 ||
				bytes.length !== entry.size ||
				receiptBytes.length !== entry.size ||
				createHash("sha256").update(receiptBytes).digest("hex") !==
					entry.sha256 ||
				(afterRead.mode & 0o777) !== entry.mode ||
				afterRead.nlink !== stats.nlink ||
				afterRead.size !== stats.size ||
				(afterRead.mode & 0o777) !== (stats.mode & 0o777)
			)
				return { ok: false, reason: "dirty_overlay_file_drift" };
			if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
				return { ok: false, reason: "dirty_overlay_file_drift" };
		}
	} catch {
		return { ok: false, reason: "dirty_overlay_file_unavailable" };
	}
	return { ok: true, receiptHash };
}

/** Persist a receipt for detached workers with restrictive file permissions. */
export function writeDirtyOverlayReceipt(receiptPath, receipt) {
	if (typeof receiptPath !== "string" || !receiptPath)
		throw new TypeError("dirty overlay receipt path is required");
	mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
	assertReceiptParentSafe(receiptPath);
	const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(temporary, 0o600);
	const fd = openSync(temporary, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	// A hard-link publish is atomic and create-only; never replace a receipt that
	// a detached worker may already have consumed.
	try {
		linkSync(temporary, receiptPath);
	} finally {
		try {
			unlinkSync(temporary);
		} catch {}
	}
	return receiptPath;
}

export function readDirtyOverlayReceipt(receiptPath) {
	assertReceiptParentSafe(receiptPath);
	const stats = lstatSync(receiptPath);
	const ownerUid =
		typeof process.getuid === "function" ? process.getuid() : null;
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		stats.nlink !== 1 ||
		(ownerUid !== null && stats.uid !== ownerUid) ||
		(stats.mode & 0o777) !== 0o600
	)
		throw new Error("dirty overlay receipt is not an owner-only regular file");
	if (stats.size > DIRTY_OVERLAY_MAX_FILE_BYTES * 2)
		throw new Error("dirty overlay receipt is too large");
	return JSON.parse(readFileSync(receiptPath, "utf8"));
}

function tarField(value, length) {
	const bytes = Buffer.alloc(length);
	Buffer.from(String(value), "utf8").copy(bytes, 0, 0, length);
	return bytes;
}

function tarOctal(value, length) {
	const bytes = Buffer.alloc(length, 0);
	const text = `${Number(value)
		.toString(8)
		.padStart(length - 2, "0")}\0`;
	Buffer.from(text, "ascii").copy(bytes, 0, 0, length);
	return bytes;
}

function createOverlayTar(receipt) {
	const chunks = [];
	for (const entry of receipt.paths) {
		const data = Buffer.from(entry.bytes, "base64");
		const header = Buffer.alloc(512, 0);
		tarField(entry.path, 100).copy(header, 0);
		tarOctal(entry.mode, 8).copy(header, 100);
		tarOctal(0, 8).copy(header, 108);
		tarOctal(0, 8).copy(header, 116);
		tarOctal(data.length, 12).copy(header, 124);
		tarOctal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
		header.fill(0x20, 148, 156);
		header[156] = 0x30;
		Buffer.from("ustar\0", "ascii").copy(header, 257);
		Buffer.from("00", "ascii").copy(header, 263);
		const checksum = [...header].reduce((sum, value) => sum + value, 0);
		tarOctal(checksum, 8).copy(header, 148);
		chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	chunks.push(Buffer.alloc(1024));
	return Buffer.concat(chunks);
}

function taskBaseComponent(value, label) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
	) {
		throw new TypeError(`${label} must be a safe task-base identifier`);
	}
	return value;
}

function taskBaseTree(value) {
	if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
		throw new TypeError("task base tree must be a SHA-1 object id");
	}
	return value;
}

function taskBaseProbeOptions(options = {}) {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? TASK_BASE_PROBE_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError("task base probe timeout must be positive");
	}
	return {
		...options,
		now,
		deadlineMs: options.deadlineMs ?? now() + timeoutMs,
	};
}

function probeRemainingMs(options) {
	if (options.signal?.aborted) throw new Error("task base probe aborted");
	const remainingMs = Math.floor(options.deadlineMs - options.now());
	if (remainingMs <= 0) {
		// Carries the same code a killed child would: a caller classifying the
		// failure must read "out of budget", not "this task base is invalid".
		throw Object.assign(new Error("task base probe deadline exhausted"), {
			code: "ETIMEDOUT",
		});
	}
	return remainingMs;
}

function emitProbeStatus(options, event, stage) {
	try {
		options.onStatus?.({
			phase: "checkpoint",
			event,
			stage,
			status: `${stage} ${event === "task_base_probe_started" ? "started" : event === "task_base_probe_completed" ? "completed" : "failed"}`,
		});
	} catch {
		// Telemetry cannot alter the immutable-base operation.
	}
}

function backendExecution(executionBackend, workspaceId, argv, options) {
	const execution = executionBackend.execArgv(workspaceId, {
		cwd: "/project",
		argv: ["git", ...argv],
		recordPid: true,
		cleanupContext: options.cleanupContext,
	});
	return execution;
}

function isParallelsLostResult(error) {
	return PRLCTL_LOST_RESULT.test(
		[String(error?.stderr ?? ""), String(error?.message ?? "")].join("\n"),
	);
}

function emitTaskBaseRecovery(options, stage, mode) {
	try {
		options.onStatus?.({
			phase: "checkpoint",
			event: "task_base_probe_recovered",
			stage,
			mode,
			status: `${stage} recovered from a Parallels lost result`,
		});
	} catch {
		// Status cannot alter immutable-base capture.
	}
}

function backendGit(
	executionBackend,
	workspaceId,
	argv,
	options,
	stage,
	{ retryLostResult = false } = {},
) {
	emitProbeStatus(options, "task_base_probe_started", stage);
	try {
		const run = () => {
			const execution = backendExecution(
				executionBackend,
				workspaceId,
				argv,
				options,
			);
			return execFileSync(execution.command, execution.args, {
				encoding: "utf8",
				stdio: "pipe",
				timeout: probeRemainingMs(options),
				killSignal: "SIGKILL",
				signal: options.signal,
			});
		};
		let output;
		try {
			output = run();
		} catch (error) {
			if (!retryLostResult || !isParallelsLostResult(error)) throw error;
			emitTaskBaseRecovery(options, stage, "replay");
			output = run();
		}
		emitProbeStatus(options, "task_base_probe_completed", stage);
		return output;
	} catch (error) {
		emitProbeStatus(options, "task_base_probe_failed", stage);
		throw error;
	}
}

function backendGitAsync(
	executionBackend,
	workspaceId,
	argv,
	options,
	stage,
	{ retryLostResult = false } = {},
) {
	emitProbeStatus(options, "task_base_probe_started", stage);
	const run = () => {
		const execution = backendExecution(
			executionBackend,
			workspaceId,
			argv,
			options,
		);
		return new Promise((resolve, reject) => {
			execFile(
				execution.command,
				execution.args,
				{
					encoding: "utf8",
					timeout: probeRemainingMs(options),
					killSignal: "SIGKILL",
					signal: options.signal,
				},
				(error, stdout) => {
					if (error) {
						reject(error);
						return;
					}
					resolve(stdout);
				},
			);
		});
	};
	return Promise.resolve()
		.then(run)
		.catch(async (error) => {
			if (!retryLostResult || !isParallelsLostResult(error)) throw error;
			emitTaskBaseRecovery(options, stage, "replay");
			return run();
		})
		.then((output) => {
			emitProbeStatus(options, "task_base_probe_completed", stage);
			return output;
		})
		.catch((error) => {
			emitProbeStatus(options, "task_base_probe_failed", stage);
			throw error;
		});
}

/**
 * Create a task-scoped immutable tree anchor after hooks have prepared the
 * workspace. The compare-and-swap creation is intentional: a mutable ref is
 * never accepted as evidence of the host-recorded tree.
 */
export function captureTaskStartTree(
	executionBackend,
	workspaceId,
	{ runId, taskId, ...inputOptions } = {},
) {
	if (!executionBackend || typeof executionBackend.execArgv !== "function") {
		throw new TypeError("execution backend does not support task-base capture");
	}
	const safeRunId = taskBaseComponent(runId, "runId");
	const safeTaskId = taskBaseComponent(taskId, "taskId");
	const options = taskBaseProbeOptions(inputOptions);
	backendGit(
		executionBackend,
		workspaceId,
		["add", "-A"],
		options,
		"task_base_stage",
		{ retryLostResult: true },
	);
	const tree = taskBaseTree(
		backendGit(
			executionBackend,
			workspaceId,
			["write-tree"],
			options,
			"task_base_write",
			{ retryLostResult: true },
		).trim(),
	);
	const ref = `${TASK_BASE_REF_PREFIX}/${safeRunId}/${safeTaskId}`;
	try {
		backendGit(
			executionBackend,
			workspaceId,
			["update-ref", ref, tree, ZERO_OBJECT_ID],
			options,
			"task_base_anchor",
		);
	} catch (error) {
		if (!isParallelsLostResult(error)) throw error;
		let observed;
		try {
			observed = taskBaseTree(
				backendGit(
					executionBackend,
					workspaceId,
					["rev-parse", "--verify", `${ref}^{tree}`],
					options,
					"task_base_anchor_reconcile",
					{ retryLostResult: true },
				).trim(),
			);
		} catch {
			throw error;
		}
		if (observed !== tree) throw error;
		emitTaskBaseRecovery(options, "task_base_anchor", "reconcile");
	}
	return { ref, tree };
}

export async function captureTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ runId, taskId, ...inputOptions } = {},
) {
	if (!executionBackend || typeof executionBackend.execArgv !== "function") {
		throw new TypeError("execution backend does not support task-base capture");
	}
	const safeRunId = taskBaseComponent(runId, "runId");
	const safeTaskId = taskBaseComponent(taskId, "taskId");
	const options = taskBaseProbeOptions(inputOptions);
	await backendGitAsync(
		executionBackend,
		workspaceId,
		["add", "-A"],
		options,
		"task_base_stage",
		{ retryLostResult: true },
	);
	const tree = taskBaseTree(
		(
			await backendGitAsync(
				executionBackend,
				workspaceId,
				["write-tree"],
				options,
				"task_base_write",
				{ retryLostResult: true },
			)
		).trim(),
	);
	const ref = `${TASK_BASE_REF_PREFIX}/${safeRunId}/${safeTaskId}`;
	try {
		await backendGitAsync(
			executionBackend,
			workspaceId,
			["update-ref", ref, tree, ZERO_OBJECT_ID],
			options,
			"task_base_anchor",
		);
	} catch (error) {
		if (!isParallelsLostResult(error)) throw error;
		let observed;
		try {
			observed = taskBaseTree(
				(
					await backendGitAsync(
						executionBackend,
						workspaceId,
						["rev-parse", "--verify", `${ref}^{tree}`],
						options,
						"task_base_anchor_reconcile",
						{ retryLostResult: true },
					)
				).trim(),
			);
		} catch {
			throw error;
		}
		if (observed !== tree) throw error;
		emitTaskBaseRecovery(options, "task_base_anchor", "reconcile");
	}
	return { ref, tree };
}

/** Validate a task base against both the durable expected hash and its ref. */
export function validateTaskStartTree(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const expectedTree = taskBaseTree(tree);
	if (
		typeof ref !== "string" ||
		!new RegExp(
			`^${TASK_BASE_REF_PREFIX}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
			"u",
		).test(ref)
	) {
		throw new TypeError("task base ref must be in refs/switchyard/task-base");
	}
	const actualTree = backendGit(
		executionBackend,
		workspaceId,
		["rev-parse", "--verify", `${ref}^{tree}`],
		options,
		"task_base_validate",
	).trim();
	if (actualTree !== expectedTree) {
		throw new Error("task base ref does not match the recorded tree");
	}
	return { ref, tree: expectedTree };
}

export async function validateTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const expectedTree = taskBaseTree(tree);
	if (
		typeof ref !== "string" ||
		!new RegExp(
			`^${TASK_BASE_REF_PREFIX}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
			"u",
		).test(ref)
	)
		throw new TypeError("task base ref must be in refs/switchyard/task-base");
	const options = taskBaseProbeOptions(inputOptions);
	const actualTree = (
		await backendGitAsync(
			executionBackend,
			workspaceId,
			["rev-parse", "--verify", `${ref}^{tree}`],
			options,
			"task_base_validate",
		)
	).trim();
	if (actualTree !== expectedTree)
		throw new Error("task base ref does not match the recorded tree");
	return { ref, tree: expectedTree };
}

/** Remove a task-base anchor only after that task reaches final disposition. */
export function releaseTaskStartTree(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const base = validateTaskStartTree(
		executionBackend,
		workspaceId,
		{
			ref,
			tree,
		},
		options,
	);
	backendGit(
		executionBackend,
		workspaceId,
		["update-ref", "-d", base.ref, base.tree],
		options,
		"task_base_release",
	);
}

export async function releaseTaskStartTreeAsync(
	executionBackend,
	workspaceId,
	{ ref, tree } = {},
	inputOptions = {},
) {
	const options = taskBaseProbeOptions(inputOptions);
	const base = await validateTaskStartTreeAsync(
		executionBackend,
		workspaceId,
		{ ref, tree },
		options,
	);
	await backendGitAsync(
		executionBackend,
		workspaceId,
		["update-ref", "-d", base.ref, base.tree],
		options,
		"task_base_release",
	);
}

/**
 * Seed a backend workspace from the host repository's committed tree.
 * `pushTar` is the only payload transfer; the baseline git setup runs through
 * the same backend execution prefix, so this works for any ExecutionBackend
 * implementation without a host mount.
 * @param {import("./execution-backend.mjs").ExecutionBackend} executionBackend
 * @param {string} workspaceId
 * @param {string} projectPath
 * @returns {object} backend transfer receipt
 */
export function seedProjectWithBackend(
	executionBackend,
	workspaceId,
	projectPath,
	{ dirtyOverlayReceipt = null } = {},
) {
	if (!executionBackend || typeof executionBackend.pushTar !== "function") {
		throw new TypeError("execution backend does not support tar transfer");
	}
	if (typeof workspaceId !== "string" || workspaceId.length === 0) {
		throw new TypeError("workspaceId must be a non-empty backend handle");
	}
	const tar = execFileSync("git", ["-C", projectPath, "archive", "HEAD"], {
		maxBuffer: 256 * 1024 * 1024,
	});
	const receipt = executionBackend.pushTar(workspaceId, tar, "/project");
	// Repeat-safe on purpose: execGuest retries a prlctl job misfire, so this
	// script can run a second time against a guest that already ran it to
	// completion. `git init` and `git add` are no-ops on the second pass, but an
	// unguarded `commit --allow-empty` would stack a redundant baseline commit,
	// so the commit is gated on HEAD not already existing. `--allow-empty` stays
	// because an empty project still needs a baseline for HEAD to resolve.
	const script =
		"git init -q && git add -A -f && { git rev-parse --verify -q HEAD >/dev/null || git -c user.name=switchyard -c user.email=switchyard@localhost commit --allow-empty -qm baseline; }";
	if (typeof executionBackend.execGuest === "function") {
		executionBackend.execGuest(workspaceId, "/bin/bash", ["-lc", script], {
			cwd: "/project",
		});
	} else {
		const execution = executionBackend.execArgv(workspaceId, {
			cwd: "/project",
			argv: ["/bin/bash", "-lc", script],
		});
		execFileSync(execution.command, execution.args, { stdio: "pipe" });
	}
	if (dirtyOverlayReceipt) {
		const checked = validateDirtyOverlayReceipt(
			projectPath,
			dirtyOverlayReceipt,
			dirtyOverlayReceipt.paths.map((entry) => entry.path),
		);
		if (
			!checked.ok ||
			checked.receiptHash !== dirtyOverlayReceipt.receiptHash
		) {
			throw new Error(
				`dirty overlay receipt rejected before seed: ${checked.reason}`,
			);
		}
		// pushTar extracts the immutable payload into the guest without a host
		// mount, overwriting exactly the declared paths in the already-seeded
		// tree. It runs after the baseline commit, so the overlay is the guest
		// repository's only uncommitted change when the apply command below
		// folds it into a single commit.
		executionBackend.pushTar(
			workspaceId,
			createOverlayTar(dirtyOverlayReceipt),
			"/project",
		);
		const overlayScript =
			"git add -A -- . && git diff --cached --quiet || git commit -q -m switchyard-dirty-overlay";
		if (typeof executionBackend.execGuest === "function") {
			executionBackend.execGuest(
				workspaceId,
				"/bin/bash",
				["-lc", overlayScript],
				{
					cwd: "/project",
				},
			);
		} else {
			const overlayExecution = executionBackend.execArgv(workspaceId, {
				cwd: "/project",
				argv: ["/bin/bash", "-lc", overlayScript],
			});
			execFileSync(overlayExecution.command, overlayExecution.args, {
				stdio: "pipe",
			});
		}
	}
	return receipt;
}

export * from "./execution-backend.mjs";
export * from "./parallels-execution-backend.mjs";
