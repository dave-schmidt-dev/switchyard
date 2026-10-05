import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	MAX_TRANSFER_BYTES,
	PARALLELS_WORKING_PREFIX,
	PROCESS_MARKER_SCHEMA_VERSION,
	PROVIDER_PID_MARKER_PREFIX,
	parseHostProcessIdentity,
	SAFE_GUEST_PATH,
	SAFE_RUN_ID,
	SAFE_USER,
	UUID,
	VM_OWNERSHIP_SCHEMA_VERSION,
	validatePid,
} from "./parallels-primitives.mjs";
import { outputText } from "./parallels-transfer.mjs";

export function providerPidMarkerPath(workspaceId, cleanupContext = {}) {
	const identity = markerIdentity(workspaceId, cleanupContext);
	if (!identity) return null;
	return `${PROVIDER_PID_MARKER_PREFIX}${identity.operation}-${identity.token.slice(0, 32)}.pid`;
}

export function providerTerminalEvidencePath(workspaceId, cleanupContext = {}) {
	const identity = markerIdentity(workspaceId, cleanupContext);
	if (identity?.operation !== "provider") return null;
	return `${PROVIDER_PID_MARKER_PREFIX}${identity.operation}-${identity.token.slice(0, 32)}.terminal.json`;
}

export function validateGuestPath(value, label) {
	if (typeof value !== "string" || !SAFE_GUEST_PATH.test(value)) {
		throw new Error(`${label} must be an absolute safe guest path`);
	}
	if (value.split("/").includes("..")) {
		throw new Error(`${label} must not contain parent traversal`);
	}
	return value;
}

export function validateUser(value) {
	if (typeof value !== "string" || !SAFE_USER.test(value)) {
		throw new Error("provider user must be a safe account name");
	}
	return value;
}

/**
 * The provider account's home directory. `prlctl exec` enters the guest with
 * `HOME=/`, and macOS sudoers preserves it across `sudo -u`, so `-H` does not
 * override it. Everything that has to agree on one home — credential
 * provisioning, the login shell's profile, and the provider's own cache and
 * config directories — resolves it here.
 * @param {string} providerUser
 * @returns {string}
 */
export function providerHomePath(providerUser) {
	return `/Users/${validateUser(providerUser)}`;
}

export function resolveWorkspacePath(value, providerUser) {
	const user = validateUser(providerUser);
	const physicalRoot = `${providerHomePath(user)}/.switchyard/project`;
	if (value === "/project") return physicalRoot;
	if (value.startsWith("/project/")) {
		return `${physicalRoot}${value.slice("/project".length)}`;
	}
	return value;
}

/**
 * A `KEY=value` assignment that survives prlctl's join-and-reparse untouched:
 * printable ASCII only, and no character the guest's single parse would act on.
 * @param {string} value
 * @returns {string}
 */
export function validateEnvAssignment(value) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9._+@%=:,/-]*$/.test(value)
	) {
		throw new Error("env assignment must be a safe KEY=value pair");
	}
	return value;
}

export function validateUid(value) {
	if (!/^\d+$/.test(String(value ?? "")) || Number(value) <= 0) {
		throw new Error("aquaUid must be a positive numeric uid");
	}
	return String(value);
}

export function validateTransferHost(value) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(value) ||
		value.includes("..")
	) {
		throw new Error("transferHost must be a safe host address");
	}
	return value;
}

export function validateTar(value) {
	if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
		throw new TypeError("tar must be an in-memory Buffer or Uint8Array");
	}
	if (value.byteLength > MAX_TRANSFER_BYTES) {
		throw new Error("tar exceeds the configured in-memory transfer limit");
	}
	return Buffer.from(value);
}

export function snapshotIdsFromOutput(output) {
	const text = outputText(output);
	const ids = new Set();
	try {
		const parsed = JSON.parse(text);
		const visit = (value) => {
			if (!value || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			for (const [key, item] of Object.entries(value)) {
				if (
					/^(?:id|snapshot[_-]?id)$/i.test(key) &&
					typeof item === "string" &&
					item.length > 0
				) {
					ids.add(item);
				}
				visit(item);
			}
		};
		visit(parsed);
	} catch {
		for (const match of text.matchAll(
			/\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?/gi,
		)) {
			ids.add(match[0]);
		}
	}
	return ids;
}

export function normalizedUuid(value) {
	if (!isUuid(value)) return null;
	return String(value)
		.replace(/^\{|\}$/g, "")
		.toLowerCase();
}

/**
 * Read only the closed structured snapshot-list shape used by the
 * reconciliation path. The legacy parser intentionally remains permissive
 * for existing cleanup behavior; it cannot prove absence after a lost result.
 */
export function strictSnapshotIdsFromOutput(output) {
	let parsed;
	try {
		parsed = JSON.parse(outputText(output));
	} catch {
		throw new Error("snapshot inventory is not a complete structured response");
	}
	const idsFromArray = (value) => {
		if (!Array.isArray(value)) {
			throw new Error("snapshot inventory has an unknown structure");
		}
		const ids = new Set();
		for (const entry of value) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error("snapshot inventory has an invalid entry");
			}
			const id = normalizedUuid(
				entry.id ?? entry.snapshotId ?? entry.snapshot_id,
			);
			if (!id) throw new Error("snapshot inventory entry has no exact UUID");
			ids.add(id);
		}
		return ids;
	};
	if (!parsed || typeof parsed !== "object") {
		throw new Error("snapshot inventory has an unknown structure");
	}
	if (Object.keys(parsed).length === 1 && Object.hasOwn(parsed, "snapshots")) {
		return idsFromArray(parsed.snapshots);
	}
	throw new Error("snapshot inventory has an unknown structure");
}

export function snapshotDifference(after, before) {
	return [...after].filter((id) => !before.has(id));
}

function measurePathBytes(path) {
	const entry = lstatSync(path);
	if (!entry.isDirectory()) return entry.size;
	return readdirSync(path, { withFileTypes: true }).reduce((total, child) => {
		const childPath = `${path}/${child.name}`;
		return total + measurePathBytes(childPath);
	}, 0);
}

export function diskBytesFromInfo(info, diskUsageFn = null) {
	const text = outputText(info);
	const image = text.match(/\bimage=['"]([^'"]+)['"]/i)?.[1];
	if (image) {
		const bytes = diskUsageFn ? diskUsageFn(image) : measurePathBytes(image);
		if (Number.isFinite(Number(bytes)) && Number(bytes) > 0) {
			return Number(bytes);
		}
	}
	const size = text.match(
		/\b(?:size|capacity)\s*[=:]\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?\b/i,
	);
	if (size) {
		const units = {
			B: 1,
			KB: 1024,
			MB: 1024 ** 2,
			GB: 1024 ** 3,
			TB: 1024 ** 4,
		};
		const bytes =
			Number(size[1]) * (units[String(size[2] ?? "B").toUpperCase()] ?? 1);
		if (Number.isFinite(bytes) && bytes > 0) return bytes;
	}
	throw new Error(
		"linked clone disk measurement was not present in prlctl output",
	);
}

function validateRunId(runId) {
	if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId)) {
		throw new Error("runId must be a non-empty safe identifier");
	}
	return runId;
}

export function validateDurationMs(value, name, minimum) {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer of at least ${minimum}ms`);
	}
	return value;
}

/**
 * Build the only VM name this backend may create or reclaim.
 * @param {string} runId
 * @param {number} creatorPid
 * @returns {string}
 */
export function buildParallelsWorkingName(runId, creatorPid) {
	return `${PARALLELS_WORKING_PREFIX}${validateRunId(runId)}-${validatePid(creatorPid)}`;
}

/**
 * Parse ownership from a VM name. The PID is the final hyphen-delimited
 * component, so run IDs may contain hyphens without weakening the proof.
 * @param {unknown} name
 * @returns {{name: string, runId: string, creatorPid: number}|null}
 */
export function parseParallelsWorkingName(name) {
	if (typeof name !== "string" || !name.startsWith(PARALLELS_WORKING_PREFIX)) {
		return null;
	}
	const remainder = name.slice(PARALLELS_WORKING_PREFIX.length);
	const separator = remainder.lastIndexOf("-");
	if (separator <= 0) return null;
	const runId = remainder.slice(0, separator);
	const pidText = remainder.slice(separator + 1);
	if (!SAFE_RUN_ID.test(runId) || !/^[1-9]\d*$/.test(pidText)) return null;
	return { name, runId, creatorPid: Number(pidText) };
}

/**
 * Validate the evidence required before selecting a linked clone.
 *
 * Parallels creates a snapshot on the golden image for a linked clone and
 * does not protect that image from destructive operations. A positive disk
 * measurement and finite clone-to-boot duration are therefore a prerequisite
 * for using `--linked`; missing or malformed evidence fails closed.
 * @param {unknown} measurement
 * @returns {{diskBytes: number, cloneToBootMs: number}}
 */
export function validateLinkedCloneMeasurement(measurement) {
	if (!measurement || typeof measurement !== "object") {
		throw new Error(
			"refusing linked clone: positive disk and finite clone-to-boot measurements are required",
		);
	}
	const diskBytes = Number(measurement.diskBytes ?? measurement.onDiskBytes);
	const cloneToBootMs = Number(measurement.cloneToBootMs ?? measurement.bootMs);
	if (
		!Number.isFinite(diskBytes) ||
		diskBytes <= 0 ||
		!Number.isFinite(cloneToBootMs) ||
		cloneToBootMs < 0
	) {
		throw new Error(
			"refusing linked clone: positive disk and finite clone-to-boot measurements are required",
		);
	}
	return { diskBytes, cloneToBootMs };
}

const HOST_READINESS_CODES = new Set([
	"vm_host_inventory_permission_denied",
	"vm_host_inventory_unavailable",
	"vm_host_service_degraded",
]);

/** Closed, content-free host readiness failure for queue admission. */
export class ParallelsHostReadinessError extends Error {
	constructor(code, cause) {
		if (!HOST_READINESS_CODES.has(code)) {
			throw new TypeError("unrecognized Parallels host readiness code");
		}
		super(
			code === "vm_host_inventory_permission_denied"
				? "Parallels VM inventory permission is denied"
				: code === "vm_host_inventory_unavailable"
					? "Parallels VM inventory is unavailable"
					: "Parallels host service is degraded",
			{ cause },
		);
		this.name = "ParallelsHostReadinessError";
		Object.defineProperty(this, "code", { value: code, enumerable: true });
		if (code === "vm_host_inventory_permission_denied") {
			Object.defineProperty(this, "boundary", {
				value: "parallels_vm_inventory",
				enumerable: true,
			});
		}
	}
}

export function parseVmList(output) {
	return outputText(output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const fields = line.includes("\t")
				? line.split("\t").map((field) => field.trim())
				: line.split(/\s+/);
			if (fields.length < 3) return null;
			const [uuid, status, ...nameParts] = fields;
			const name = nameParts.join(" ").trim();
			if (!uuid || !status || !name || name.toLowerCase() === "name")
				return null;
			return {
				uuid,
				status,
				name,
				ownership: parseParallelsWorkingName(name),
			};
		})
		.filter(Boolean);
}

export function parseReadinessInventory(output) {
	const lines = outputText(output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) {
		throw new Error("Parallels VM inventory is blank");
	}
	const rows = lines.map((line) =>
		line.includes("\t")
			? line.split("\t").map((field) => field.trim())
			: line.split(/\s+/),
	);
	if (
		rows[0].length === 3 &&
		rows[0][0].toLowerCase() === "uuid" &&
		rows[0][1].toLowerCase() === "status" &&
		rows[0][2].toLowerCase() === "name"
	) {
		rows.shift();
	}
	for (const fields of rows) {
		const [uuid, status, ...nameParts] = fields;
		if (
			fields.length < 3 ||
			!UUID.test(uuid ?? "") ||
			!/^[A-Za-z][A-Za-z0-9_-]*$/.test(status ?? "") ||
			!nameParts.join(" ").trim()
		) {
			throw new Error("Parallels VM inventory contains an invalid row");
		}
	}
	return rows;
}

export function isUuid(value) {
	return typeof value === "string" && UUID.test(value);
}

export function isBoundedRecordText(value, maxLength = 1024) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		![...value].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint <= 31 || codePoint === 127;
		})
	);
}

export function markerIdentity(workspaceId, cleanupContext = {}) {
	const required = [
		"runId",
		"taskId",
		"attemptId",
		"descriptorIdentity",
		"workspaceId",
	];
	if (
		!cleanupContext ||
		!["provider", "helper"].includes(cleanupContext.operation) ||
		cleanupContext.workspaceId !== String(workspaceId) ||
		required.some(
			(field) =>
				typeof cleanupContext[field] !== "string" ||
				cleanupContext[field].length === 0,
		)
	) {
		return null;
	}
	const operation = cleanupContext.operation;
	const payload = JSON.stringify({
		v: PROCESS_MARKER_SCHEMA_VERSION,
		operation,
		workspaceId: String(workspaceId),
		runId: cleanupContext.runId,
		taskId: cleanupContext.taskId,
		attemptId: cleanupContext.attemptId,
		descriptorIdentity: cleanupContext.descriptorIdentity,
		processStartIdentity:
			typeof cleanupContext.processStartIdentity === "string" &&
			cleanupContext.processStartIdentity
				? cleanupContext.processStartIdentity
				: null,
	});
	return {
		operation,
		payload,
		// No qualified guest birth-identity probe exists in this source scope.
		// The host supervisor identity still fences marker names, but it never
		// upgrades a guest PID into signaling authority.
		strongStart: false,
		token: createHash("sha256").update(payload).digest("hex"),
	};
}

export function ownershipContextFor(options, backend) {
	const source = options?.ownershipContext;
	const required = [
		"resourceRoot",
		"runId",
		"taskId",
		"attemptId",
		"projectRoot",
	];
	if (
		!source ||
		required.some(
			(field) =>
				typeof source[field] !== "string" || source[field].length === 0,
		)
	) {
		throw new Error(
			"VM allocation requires explicit durable ownership context",
		);
	}
	if (!isAbsolute(source.resourceRoot) || !isAbsolute(source.projectRoot)) {
		throw new Error(
			"VM ownership context requires absolute resourceRoot and projectRoot",
		);
	}
	const suppliedProcessIdentity =
		source.processStartIdentity === null ||
		source.processStartIdentity === undefined
			? null
			: parseHostProcessIdentity(source.processStartIdentity)?.identity;
	if (
		source.processStartIdentity !== null &&
		source.processStartIdentity !== undefined &&
		!suppliedProcessIdentity
	) {
		throw new Error(
			"VM ownership context has malformed creator birth identity",
		);
	}
	return Object.freeze({
		schemaVersion: VM_OWNERSHIP_SCHEMA_VERSION,
		resourceRoot: resolve(source.resourceRoot),
		runId: validateRunId(source.runId),
		taskId: String(source.taskId),
		attemptId: String(source.attemptId),
		projectRoot: resolve(source.projectRoot),
		purpose:
			typeof source.purpose === "string" && source.purpose
				? source.purpose
				: "dispatch",
		creatorPid: validatePid(
			source.creatorPid ?? options.creatorPid ?? backend.creatorPid,
		),
		processStartIdentity: suppliedProcessIdentity,
	});
}
