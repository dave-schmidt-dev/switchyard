const CANARY_RE = /SECRET_CANARY_/;

const ERROR_ALLOWLIST = new Set([
	"name",
	"message",
	"code",
	"phase",
	"taskId",
	"provider",
	"model",
	"exitStatus",
]);

function _sanitizeFieldValue(value) {
	if (typeof value === "string" && CANARY_RE.test(value)) {
		return "[REDACTED]";
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return _sanitizeObject(value);
	}
	return value;
}

function _sanitizeObject(obj) {
	if (!obj || typeof obj !== "object") return obj;
	const out = {};
	for (const [key, value] of Object.entries(obj)) {
		out[key] = _sanitizeFieldValue(value);
	}
	return out;
}

function _serializeError(error) {
	if (error === null || error === undefined) return error;
	if (typeof error === "string") return { message: error };

	const raw = {};
	if (error instanceof Error) {
		raw.name = error.name;
		raw.message = error.message;
		if (error.code !== undefined) raw.code = error.code;
		if (error.phase !== undefined) raw.phase = error.phase;
		if (error.taskId !== undefined) raw.taskId = error.taskId;
		if (error.provider !== undefined) raw.provider = error.provider;
		if (error.model !== undefined) raw.model = error.model;
		if (error.exitStatus !== undefined) raw.exitStatus = error.exitStatus;
	} else {
		Object.assign(raw, error);
	}

	const out = {};
	for (const key of Object.keys(raw)) {
		if (ERROR_ALLOWLIST.has(key) && raw[key] !== undefined) {
			out[key] = raw[key];
		}
	}
	return out;
}

const SENSITIVE_PATH_RE = /\/(home|Users|root|tmp|private|var\/tmp)\/[^/]+/g;

function _redactPaths(/** @type {string} */ str) {
	return str.replace(SENSITIVE_PATH_RE, "/$1/[REDACTED]");
}

export class Diagnostics {
	constructor(_options = {}) {
		this._sinks = [];
	}

	emit(event) {
		// Serialize error first (while still an Error instance with
		// non-enumerable name/message). _sanitizeObject iterates
		// Object.entries which would strip them.
		const prepped = { ...event };
		if (prepped.error) {
			const serialized = _serializeError(prepped.error);
			if (serialized?.message) {
				serialized.message = _redactPaths(serialized.message);
			}
			prepped.error = serialized;
		}
		const sanitized = _sanitizeObject(prepped);
		if (!sanitized.timestamp) {
			sanitized.timestamp = new Date().toISOString();
		}
		for (const sink of this._sinks) {
			try {
				sink(sanitized);
			} catch {
				// Sink errors must not propagate.
			}
		}
	}

	sink(fn) {
		this._sinks.push(fn);
	}

	removeSink(fn) {
		this._sinks = this._sinks.filter((s) => s !== fn);
	}

	/**
	 * Create a JSON-safe rejection record with only allowed fields.
	 *
	 * @param {object} options
	 * @param {string} options.taskId
	 * @param {string} [options.runId]
	 * @param {string} [options.gateCode]
	 * @param {number} [options.byteCount]
	 * @param {number} [options.hunkCount]
	 * @param {number} [options.fileCount]
	 * @param {string} [options.diffSha256]
	 * @param {string[]} [options.normalizedPaths]
	 * @param {string} [options.dumpPath]
	 * @returns {object}
	 */
	static createRejectionRecord({
		taskId,
		runId,
		gateCode,
		byteCount,
		hunkCount,
		fileCount,
		diffSha256,
		normalizedPaths,
		dumpPath: _dumpPath,
	}) {
		const sanitizedPaths = Array.isArray(normalizedPaths)
			? normalizedPaths.map((p) => _redactPaths(p))
			: undefined;

		const record = {
			schemaVersion: 1,
			taskId,
			timestamp: new Date().toISOString(),
		};

		if (runId !== undefined) record.runId = runId;
		if (gateCode !== undefined) record.gateCode = gateCode;
		if (byteCount !== undefined) record.byteCount = byteCount;
		if (hunkCount !== undefined) record.hunkCount = hunkCount;
		if (fileCount !== undefined) record.fileCount = fileCount;
		if (diffSha256 !== undefined) record.diffSha256 = diffSha256;
		if (sanitizedPaths !== undefined) record.normalizedPaths = sanitizedPaths;

		return record;
	}
}
