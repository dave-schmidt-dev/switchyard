import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = resolve(fileURLToPath(import.meta.url), "..");
const defaultCutoverRoot = resolve(
	moduleDir,
	"..",
	"..",
	"..",
	"..",
	".plans",
	".cutovers",
);

const GENERATION_SCHEMA_VERSION = 1;
const GENERATION_IN_PROGRESS = "in_progress";
const GENERATION_COMPLETE = "complete";
const GENERATION_LOCK_MAX_BYTES = 4_096;
const GENERATION_STATES = new Set([
	GENERATION_IN_PROGRESS,
	GENERATION_COMPLETE,
]);

export class GenerationGuardError extends Error {
	constructor(message, options = {}) {
		super(message, options);
		this.name = "GenerationGuardError";
		this.code = "GENERATION_GUARD_UNAVAILABLE";
	}
}

export class MaintenanceGenerationError extends Error {
	constructor(message = "maintenance generation is in progress") {
		super(message);
		this.name = "MaintenanceGenerationError";
		this.code = "MAINTENANCE_GENERATION_IN_PROGRESS";
	}
}

export class ConcurrentGenerationError extends Error {
	constructor(
		message = "another maintenance generation is already in progress",
	) {
		super(message);
		this.name = "ConcurrentGenerationError";
		this.code = "CONCURRENT_GENERATION";
	}
}

function resolveMarkerPath(markerPath) {
	if (markerPath) return resolve(markerPath);
	if (process.env.SWITCHYARD_GENERATION_MARKER) {
		return resolve(process.env.SWITCHYARD_GENERATION_MARKER);
	}
	return join(
		process.env.SWITCHYARD_CUTOVER_ROOT
			? resolve(process.env.SWITCHYARD_CUTOVER_ROOT)
			: defaultCutoverRoot,
		"generation-in-progress.json",
	);
}

function validateMarker(marker, markerPath) {
	if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
		throw new GenerationGuardError(
			`generation marker is not an object: ${markerPath}`,
		);
	}
	if (marker.schemaVersion !== GENERATION_SCHEMA_VERSION) {
		throw new GenerationGuardError(
			`unsupported generation marker schema: ${markerPath}`,
		);
	}
	if (
		typeof marker.state !== "string" ||
		!GENERATION_STATES.has(marker.state)
	) {
		throw new GenerationGuardError(
			`unsupported generation marker state: ${markerPath}`,
		);
	}
	return marker;
}

function readGenerationMarker(options = {}) {
	const markerPath = resolveMarkerPath(options.markerPath);
	let raw;
	try {
		raw = readFileSync(markerPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") {
			return { markerPath, available: true, active: false, marker: null };
		}
		throw new GenerationGuardError(
			`generation marker unavailable: ${markerPath}`,
			{ cause: error },
		);
	}

	let marker;
	try {
		marker = JSON.parse(raw);
	} catch (error) {
		throw new GenerationGuardError(
			`generation marker is unreadable: ${markerPath}`,
			{ cause: error },
		);
	}
	validateMarker(marker, markerPath);
	return {
		markerPath,
		available: true,
		active: marker.state === GENERATION_IN_PROGRESS,
		marker,
	};
}

export function assertGenerationAllowed(options = {}) {
	const state = readGenerationMarker(options);
	if (state.active) {
		throw new MaintenanceGenerationError();
	}
	return state;
}

function safeRunId(runId) {
	if (
		typeof runId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
	) {
		throw new TypeError("runId must be a bounded identifier");
	}
}

function writeJsonAtomically(path, value, { beforeRename } = {}) {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		beforeRename?.();
		renameSync(tempPath, path);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch (cleanupError) {
			if (cleanupError?.code !== "ENOENT") throw cleanupError;
		}
		throw error;
	}
}

function processIsDemonstrablyDead(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error?.code === "ESRCH";
	}
}

function canReclaimGenerationLock(lockPath) {
	let stats;
	try {
		stats = statSync(lockPath);
	} catch (error) {
		return error?.code === "ENOENT";
	}

	if (stats.size > GENERATION_LOCK_MAX_BYTES) return false;

	try {
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		if (!lock || typeof lock !== "object" || Array.isArray(lock)) return false;
		return processIsDemonstrablyDead(lock.pid);
	} catch {
		return false;
	}
}

function acquireGenerationLock(markerPath) {
	const lockPath = `${markerPath}.lock`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const token = randomUUID();
			const lockContents = `${JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
				token,
			})}\n`;
			const fd = openSync(lockPath, "wx", 0o600);
			try {
				writeFileSync(fd, lockContents, "utf8");
				fsyncSync(fd);
			} catch (error) {
				closeSync(fd);
				try {
					unlinkSync(lockPath);
				} catch {}
				throw error;
			}
			closeSync(fd);
			return {
				release() {
					try {
						if (readFileSync(lockPath, "utf8") !== lockContents) return;
						unlinkSync(lockPath);
					} catch (error) {
						if (error?.code !== "ENOENT") throw error;
					}
				},
			};
		} catch (error) {
			if (error?.code !== "EEXIST") {
				throw new GenerationGuardError(
					`cannot create generation lock: ${lockPath}`,
					{ cause: error },
				);
			}
			if (!canReclaimGenerationLock(lockPath)) {
				throw new ConcurrentGenerationError();
			}
			try {
				unlinkSync(lockPath);
			} catch (cleanupError) {
				if (cleanupError?.code !== "ENOENT") throw cleanupError;
			}
		}
	}
	throw new ConcurrentGenerationError();
}

function withGenerationLock(markerPath, operation) {
	const lock = acquireGenerationLock(markerPath);
	try {
		return operation();
	} finally {
		lock.release();
	}
}

export function beginGeneration({
	markerPath,
	runId,
	owner = "native",
	metadata = {},
	beforeRename,
} = {}) {
	safeRunId(runId);
	if (beforeRename !== undefined && typeof beforeRename !== "function") {
		throw new TypeError("beforeRename must be a function");
	}
	const resolvedPath = resolveMarkerPath(markerPath);
	const marker = {
		schemaVersion: GENERATION_SCHEMA_VERSION,
		state: GENERATION_IN_PROGRESS,
		runId,
		owner,
		startedAt: new Date().toISOString(),
		metadata,
	};

	return withGenerationLock(resolvedPath, () => {
		try {
			const fd = openSync(resolvedPath, "wx", 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if (error?.code === "EEXIST") {
				const existing = readGenerationMarker({ markerPath: resolvedPath });
				if (existing.marker?.state === GENERATION_COMPLETE) {
					// Replace the completed marker in one same-directory rename so
					// readers never observe a missing marker during the transition.
					writeJsonAtomically(resolvedPath, marker, { beforeRename });
					return marker;
				}
				throw new ConcurrentGenerationError();
			}
			throw new GenerationGuardError(
				`cannot create generation marker: ${resolvedPath}`,
				{ cause: error },
			);
		}
		return marker;
	});
}

export function finishGeneration({
	markerPath,
	runId,
	metadata = {},
	beforeCommit,
} = {}) {
	if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
		throw new TypeError("beforeCommit must be a function");
	}
	const resolvedPath = resolveMarkerPath(markerPath);
	return withGenerationLock(resolvedPath, () => {
		const state = readGenerationMarker({ markerPath: resolvedPath });
		if (!state.marker || state.marker.state !== GENERATION_IN_PROGRESS) {
			throw new GenerationGuardError("no in-progress generation to finish");
		}
		if (state.marker.runId !== runId) {
			throw new GenerationGuardError("generation owner does not match marker");
		}
		beforeCommit?.(state.marker);
		const marker = {
			...state.marker,
			state: GENERATION_COMPLETE,
			completedAt: new Date().toISOString(),
			metadata: { ...state.marker.metadata, ...metadata },
		};
		writeJsonAtomically(state.markerPath, marker);
		return marker;
	});
}
