import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
	assertOverlayPathSafe,
	DIRTY_OVERLAY_MAX_FILE_BYTES,
	DIRTY_OVERLAY_SECRET_PATHS,
	DIRTY_OVERLAY_VERSION,
	gitRead,
	ignoredPath,
	normalizeOverlayPath,
	overlayFingerprint,
	overlayHash,
	stableJson,
	statusPaths,
	trackedPath,
} from "./overlay-paths.mjs";
import { parsePredecessorReceipt } from "./overlay-receipts.mjs";
export function captureDirtyOverlay(
	projectPath,
	paths,
	{
		hostFingerprint = null,
		allowUnrelated = false,
		maxFileBytes = DIRTY_OVERLAY_MAX_FILE_BYTES,
		enforceTarPathLimit = true,
		secretPaths = DIRTY_OVERLAY_SECRET_PATHS,
		predecessorReceipt = null,
	} = {},
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
		if (!allowUnrelated && !declared.has(candidate))
			throw new Error(
				`dirty overlay rejects out-of-scope or untracked path: ${candidate}`,
			);
	}
	const parsedPredecessor = predecessorReceipt
		? parsePredecessorReceipt(predecessorReceipt, { projectPath })
		: null;
	const entries = normalized.map((path) => {
		assertOverlayPathSafe(projectPath, path, {
			enforceTarPathLimit,
			secretPaths,
		});
		const isTracked = trackedPath(projectPath, path);
		if (ignoredPath(projectPath, path))
			throw new Error(`dirty overlay rejects ignored path: ${path}`);
		let predEntry = null;
		if (!isTracked) {
			if (!parsedPredecessor) {
				throw new Error(`dirty overlay rejects untracked path: ${path}`);
			}
			predEntry = parsedPredecessor.outputs.find((o) => o.path === path);
			if (!predEntry) {
				throw new Error(`dirty overlay rejects untracked path: ${path}`);
			}
			if (parsedPredecessor.baseRevision !== sourceHead) {
				const error = new Error(
					`dirty overlay predecessor base revision mismatch: ${path}`,
				);
				error.code = "predecessor_receipt_mismatch";
				throw error;
			}
		}
		const target = resolve(projectPath, path);
		let stats;
		try {
			stats = lstatSync(target);
		} catch (error) {
			if (error?.code === "ENOENT")
				throw new Error(`dirty overlay rejects deleted path: ${path}`);
			throw error;
		}
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
			throw new Error(`dirty overlay requires one regular file: ${path}`);
		if (stats.size > maxFileBytes)
			throw new Error(`dirty overlay file is too large: ${path}`);
		if (predEntry && stats.size !== predEntry.size) {
			const error = new Error(`dirty overlay predecessor file drift: ${path}`);
			error.code = "predecessor_receipt_mismatch";
			throw error;
		}
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
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (predEntry && sha256 !== predEntry.sha256) {
			const error = new Error(`dirty overlay predecessor file drift: ${path}`);
			error.code = "predecessor_receipt_mismatch";
			throw error;
		}
		const entry = {
			path,
			mode: stats.mode & 0o777,
			size: bytes.length,
			sha256,
			bytes: bytes.toString("base64"),
			tracked: isTracked,
		};
		if (!isTracked && predEntry) {
			entry.predecessor = {
				runId: parsedPredecessor.runId,
				baseRevision: parsedPredecessor.baseRevision,
				sha256: predEntry.sha256,
				size: predEntry.size,
			};
		}
		return entry;
	});
	const body = {
		schemaVersion: DIRTY_OVERLAY_VERSION,
		kind: "tracked_dirty_overlay",
		sourceHead,
		hostFingerprint: hostFingerprint ?? overlayFingerprint(projectPath),
		paths: entries,
		...(parsedPredecessor
			? {
					predecessor: {
						runId: parsedPredecessor.runId,
						baseRevision: parsedPredecessor.baseRevision,
					},
				}
			: {}),
	};
	return { ...body, receiptHash: overlayHash(body) };
}
export function validateDirtyOverlayReceipt(
	projectPath,
	receipt,
	expectedPaths = null,
	{
		allowUnrelated = false,
		maxFileBytes = DIRTY_OVERLAY_MAX_FILE_BYTES,
		enforceTarPathLimit = true,
		secretPaths = DIRTY_OVERLAY_SECRET_PATHS,
	} = {},
) {
	if (
		!receipt ||
		(receipt.schemaVersion !== 1 && receipt.schemaVersion !== 2) ||
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
				entry.size > maxFileBytes ||
				!Number.isInteger(entry.mode) ||
				entry.mode < 0 ||
				entry.mode > 0o777 ||
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
			if (
				!allowUnrelated &&
				!receipt.paths.some((entry) => entry.path === changed)
			)
				return { ok: false, reason: "dirty_overlay_scope_mismatch" };
		}
		for (const entry of receipt.paths) {
			assertOverlayPathSafe(projectPath, entry.path, {
				enforceTarPathLimit,
				secretPaths,
			});
			const isTracked = trackedPath(projectPath, entry.path);
			if (ignoredPath(projectPath, entry.path))
				return { ok: false, reason: "dirty_overlay_ignored" };
			if (!isTracked) {
				if (entry.tracked !== false || !entry.predecessor) {
					return { ok: false, reason: "dirty_overlay_untracked" };
				}
				if (
					typeof entry.predecessor.runId !== "string" ||
					typeof entry.predecessor.baseRevision !== "string" ||
					entry.predecessor.sha256 !== entry.sha256 ||
					entry.predecessor.size !== entry.size
				) {
					return { ok: false, reason: "dirty_overlay_file_drift" };
				}
			}
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
export function materializeDirtyOverlay(
	worktreePath,
	receipt,
	{
		maxFileBytes = DIRTY_OVERLAY_MAX_FILE_BYTES,
		secretPaths = DIRTY_OVERLAY_SECRET_PATHS,
	} = {},
) {
	if (typeof worktreePath !== "string" || !worktreePath)
		throw new TypeError("dirty overlay worktree path is required");
	if (!receipt || !Array.isArray(receipt.paths))
		throw new TypeError("dirty overlay receipt is required");
	const root = realpathSync(worktreePath);
	for (const entry of receipt.paths) {
		const path = normalizeOverlayPath(root, entry.path);
		assertOverlayPathSafe(root, path, {
			enforceTarPathLimit: false,
			secretPaths,
		});
		if (entry.size > maxFileBytes)
			throw new Error(`dirty overlay file is too large: ${path}`);
		const target = resolve(root, path);
		const parent = dirname(target);
		mkdirSync(parent, { recursive: true, mode: 0o755 });
		const parentStats = lstatSync(parent);
		if (!parentStats.isDirectory() || parentStats.isSymbolicLink())
			throw new Error(`dirty overlay rejects symlink parent: ${path}`);
		const bytes = Buffer.from(entry.bytes, "base64");
		if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
			throw new Error(`dirty overlay file corrupted in receipt: ${path}`);
		}
		writeFileSync(target, bytes, { encoding: null, mode: entry.mode });
		chmodSync(target, entry.mode & 0o777);
	}
	return root;
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

export { createOverlayTar };
