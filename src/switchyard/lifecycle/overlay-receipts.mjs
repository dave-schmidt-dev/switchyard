import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
	assertReceiptParentSafe,
	DIRTY_OVERLAY_MAX_FILE_BYTES,
	DIRTY_OVERLAY_SECRET_PATHS,
} from "./overlay-paths.mjs";
export function parsePredecessorReceipt(input, { projectPath = null } = {}) {
	let data = input;
	if (typeof input === "string") {
		const raw = input.trim();
		if (raw.startsWith("{")) {
			try {
				data = JSON.parse(raw);
			} catch {
				const error = new Error("predecessor receipt contains invalid JSON");
				error.code = "predecessor_receipt_invalid";
				throw error;
			}
		} else {
			const resolvedPath = resolve(input);
			try {
				const stats = lstatSync(resolvedPath);
				if (!stats.isFile() || stats.isSymbolicLink()) {
					const error = new Error(
						"predecessor receipt must be a regular non-symlink file",
					);
					error.code = "predecessor_receipt_invalid";
					throw error;
				}
				data = JSON.parse(readFileSync(resolvedPath, "utf8"));
			} catch (err) {
				const error = new Error(
					`predecessor receipt unavailable: ${err.message}`,
				);
				error.code =
					err.code === "ENOENT"
						? "predecessor_receipt_missing"
						: "predecessor_receipt_invalid";
				throw error;
			}
		}
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		const error = new Error("predecessor receipt must be an object");
		error.code = "predecessor_receipt_invalid";
		throw error;
	}
	const runId = data.runId ?? (data.taskId ? `simple-${data.taskId}` : null);
	if (typeof runId !== "string" || !runId.trim()) {
		const error = new Error("predecessor receipt requires runId or taskId");
		error.code = "predecessor_receipt_invalid";
		throw error;
	}
	const baseRevision =
		data.baseRevision ??
		data.base_commit ??
		data.dirtyBaseline?.base_commit ??
		data.projectRevision ??
		null;
	if (
		typeof baseRevision !== "string" ||
		!/^[0-9a-f]{40,64}$/i.test(baseRevision)
	) {
		const error = new Error(
			"predecessor receipt requires a valid baseRevision",
		);
		error.code = "predecessor_receipt_invalid";
		throw error;
	}
	const rawOutputs = data.outputs ?? data.files ?? data.changedFiles ?? [];
	const outputs = [];
	if (Array.isArray(rawOutputs)) {
		for (const item of rawOutputs) {
			if (typeof item === "string") {
				const fileMeta =
					data.outputHashes?.[item] ?? data.dirtyBaseline?.files?.[item];
				if (!fileMeta) {
					const error = new Error(
						`predecessor receipt output missing metadata: ${item}`,
					);
					error.code = "predecessor_receipt_invalid";
					throw error;
				}
				outputs.push({
					path: item,
					size: fileMeta.size,
					sha256: fileMeta.sha256,
					mode: fileMeta.mode ?? 0o644,
				});
			} else if (item && typeof item === "object") {
				outputs.push(item);
			}
		}
	} else if (rawOutputs && typeof rawOutputs === "object") {
		for (const [path, meta] of Object.entries(rawOutputs)) {
			if (meta && typeof meta === "object") {
				outputs.push({ path, ...meta });
			}
		}
	}
	if (outputs.length === 0) {
		const error = new Error("predecessor receipt has no outputs");
		error.code = "predecessor_receipt_invalid";
		throw error;
	}
	const normalizedOutputs = [];
	for (const entry of outputs) {
		if (
			!entry ||
			typeof entry.path !== "string" ||
			!Number.isInteger(entry.size) ||
			entry.size < 0 ||
			!/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")
		) {
			const error = new Error(
				`predecessor receipt invalid output entry: ${JSON.stringify(entry)}`,
			);
			error.code = "predecessor_receipt_invalid";
			throw error;
		}
		const path = entry.path.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
		if (
			isAbsolute(path) ||
			path.split("/").includes("..") ||
			path.split("/").includes(".git") ||
			DIRTY_OVERLAY_SECRET_PATHS.some((p) => p.test(path))
		) {
			const error = new Error(
				`predecessor receipt unsafe output path: ${entry.path}`,
			);
			error.code = "predecessor_receipt_invalid";
			throw error;
		}
		if (projectPath) {
			const resolved = resolve(projectPath, path);
			const root = resolve(projectPath);
			if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
				const error = new Error(
					`predecessor receipt path escapes project: ${entry.path}`,
				);
				error.code = "predecessor_receipt_invalid";
				throw error;
			}
		}
		normalizedOutputs.push({
			path,
			size: entry.size,
			sha256: entry.sha256.toLowerCase(),
			mode: Number(entry.mode) || 0o644,
		});
	}
	return {
		runId,
		baseRevision,
		outputs: normalizedOutputs,
	};
}
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
