import { createHash, randomUUID } from "node:crypto";

import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";

import { dirname, resolve } from "node:path";

import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_HEALTH_STATE_ROOT = resolve(
	MODULE_DIR,
	"..",
	"..",
	"..",
	".logs",
	"switchyard",
	"route-health",
);

const SCHEMA_VERSION = 1;

export const HEALTH_LOCK_STALE_MS = 60_000;

export const ADAPTER_CONTRACT_VERSION = "switchyard-route-health-v1";

const HASH_RE = /^sha256:[a-f0-9]{64}$/;

export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const REPAIR_KINDS = new Set([
	"image_repaired",
	"auth_repaired",
	"configuration_repaired",
]);

export const HOLD_CODES = new Set([
	"auth_expired",
	"model_unavailable",
	"cli_usage_error",
]);

export const SUCCESS_CODE = "verified_transport_success";

const QUALIFIED_TRANSIENT_ROUTE_HEALTH_CODES = Object.freeze([]);

export const TRANSIENT_CODES = new Set(QUALIFIED_TRANSIENT_ROUTE_HEALTH_CODES);

export const MAX_BYTES = 256 * 1024;

export const MAX_ATTEMPTS = 512;

export const WINDOW_MS = 10 * 60 * 1000;

export const COOLDOWN_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

export const OBSERVATION_AUTHORITY = Symbol(
	"route-health-observation-authority",
);

export class RouteHealthSchemaError extends Error {
	constructor(message) {
		super(message);
		this.name = "RouteHealthSchemaError";
	}
}

export function hash(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function plain(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactKeys(value, keys) {
	return plain(value) && Object.keys(value).every((key) => keys.includes(key));
}

export function safeId(value, label) {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 256 ||
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
	)
		throw new RouteHealthSchemaError(`${label} is invalid`);
	return value;
}

export function safeHash(value, label) {
	if (!HASH_RE.test(value ?? ""))
		throw new RouteHealthSchemaError(`${label} is invalid`);
	return value;
}

export function safeEpoch(value) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RouteHealthSchemaError("repair epoch is invalid");
	return value;
}

export function safeTime(value, label = "timestamp") {
	if (!Number.isFinite(value) || value < 0)
		throw new RouteHealthSchemaError(`${label} is invalid`);
	return value;
}

export function safeAttempt(value) {
	if (
		!(Number.isSafeInteger(value) && value >= 0) &&
		!(typeof value === "string" && value.length > 0 && value.length <= 128)
	)
		throw new RouteHealthSchemaError("attempt is invalid");
	return value;
}

export function normalizedList(value, label) {
	if (!Array.isArray(value) || value.length > 256)
		throw new RouteHealthSchemaError(`${label} is invalid`);
	const result = value.map((item) => safeId(item, label)).sort();
	if (new Set(result).size !== result.length)
		throw new RouteHealthSchemaError(`${label} contains duplicates`);
	return result;
}

export function resolveHealthStateRoot(healthStateRoot) {
	if (healthStateRoot === undefined) return DEFAULT_HEALTH_STATE_ROOT;
	if (typeof healthStateRoot !== "string" || !healthStateRoot)
		throw new RouteHealthSchemaError("health state root is invalid");
	return resolve(healthStateRoot);
}

export function derivePublicConfigurationEpoch({
	adapterContractId = ADAPTER_CONTRACT_VERSION,
	approvedConfiguration,
	goldenImageReference,
}) {
	safeId(adapterContractId, "adapter contract id");
	safeId(goldenImageReference, "golden image reference");
	if (
		!exactKeys(approvedConfiguration, [
			"rosterSchemaVersion",
			"approvedTargets",
			"qualifiedProviders",
		]) ||
		!Number.isSafeInteger(approvedConfiguration.rosterSchemaVersion) ||
		approvedConfiguration.rosterSchemaVersion < 1
	)
		throw new RouteHealthSchemaError(
			"approved public configuration is invalid",
		);
	return hash(
		JSON.stringify({
			version: 1,
			adapterContractId,
			goldenImageReference,
			approvedConfiguration: {
				rosterSchemaVersion: approvedConfiguration.rosterSchemaVersion,
				approvedTargets: normalizedList(
					approvedConfiguration.approvedTargets,
					"approved targets",
				),
				qualifiedProviders: normalizedList(
					approvedConfiguration.qualifiedProviders,
					"qualified providers",
				),
			},
		}),
	);
}

export function identityFrom(input) {
	return {
		targetId: safeId(input?.targetId, "target id"),
		descriptorIdentity: safeHash(
			input?.descriptorIdentity,
			"descriptor identity",
		),
	};
}

export function scopeKey(identity) {
	return hash(JSON.stringify(identity));
}

export function createRouteHealthKey(input) {
	const identity = identityFrom(input);
	return hash(
		JSON.stringify({
			...identity,
			publicConfigurationEpoch: safeHash(
				input.publicConfigurationEpoch,
				"public configuration epoch",
			),
			repairEpoch: safeEpoch(input.repairEpoch),
		}),
	);
}

export function locations(root, scope) {
	const leaf = scope.slice(7);
	return {
		control: resolve(root, "control", `${leaf}.json`),
		observations: resolve(root, "observations", `${leaf}.json`),
		initialized: resolve(root, "control", `${leaf}.initialized`),
		lock: resolve(root, "locks", `${leaf}.lock`),
	};
}

export function initialControl(identity) {
	return {
		schemaVersion: SCHEMA_VERSION,
		revision: 0,
		...identity,
		repairEpoch: 0,
		observationsRevision: 0,
		observationsDigest: null,
		attestations: [],
		holds: [],
		claim: null,
	};
}

export function initialObservations(identity) {
	return {
		schemaVersion: SCHEMA_VERSION,
		...identity,
		revision: 0,
		generations: {},
		seenAttemptIds: [],
	};
}

function validAttestation(value) {
	return (
		exactKeys(value, [
			"publicConfigurationEpoch",
			"repairEpoch",
			"repairKind",
			"adapterContractId",
			"at",
		]) &&
		HASH_RE.test(value.publicConfigurationEpoch) &&
		Number.isSafeInteger(value.repairEpoch) &&
		value.repairEpoch > 0 &&
		REPAIR_KINDS.has(value.repairKind) &&
		typeof value.adapterContractId === "string" &&
		value.adapterContractId.length <= 128 &&
		Number.isFinite(value.at)
	);
}

function validHold(value) {
	return (
		exactKeys(value, [
			"code",
			"publicConfigurationEpoch",
			"repairEpoch",
			"at",
		]) &&
		HOLD_CODES.has(value.code) &&
		HASH_RE.test(value.publicConfigurationEpoch) &&
		Number.isSafeInteger(value.repairEpoch) &&
		Number.isFinite(value.at)
	);
}

function validClaim(value) {
	return (
		exactKeys(value, [
			"token",
			"healthKey",
			"revision",
			"runId",
			"taskId",
			"attempt",
			"started",
			"acquiredAt",
		]) &&
		UUID_RE.test(value.token) &&
		HASH_RE.test(value.healthKey) &&
		Number.isSafeInteger(value.revision) &&
		typeof value.runId === "string" &&
		typeof value.taskId === "string" &&
		(typeof value.attempt === "string" ||
			Number.isSafeInteger(value.attempt)) &&
		typeof value.started === "boolean" &&
		Number.isFinite(value.acquiredAt)
	);
}

export function validateControl(value, identity) {
	if (
		!exactKeys(value, [
			"schemaVersion",
			"revision",
			"targetId",
			"descriptorIdentity",
			"repairEpoch",
			"observationsRevision",
			"observationsDigest",
			"attestations",
			"holds",
			"claim",
		]) ||
		value.schemaVersion !== SCHEMA_VERSION ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		value.targetId !== identity.targetId ||
		value.descriptorIdentity !== identity.descriptorIdentity ||
		!Number.isSafeInteger(value.repairEpoch) ||
		value.repairEpoch < 0 ||
		!Number.isSafeInteger(value.observationsRevision) ||
		value.observationsRevision < 0 ||
		(value.observationsDigest !== null &&
			!HASH_RE.test(value.observationsDigest)) ||
		!Array.isArray(value.attestations) ||
		value.attestations.length > 256 ||
		!value.attestations.every(validAttestation) ||
		!Array.isArray(value.holds) ||
		value.holds.length > 256 ||
		!value.holds.every(validHold) ||
		(value.claim !== null && !validClaim(value.claim))
	)
		throw new RouteHealthSchemaError("route health control is invalid");
	return value;
}

function validAttempt(value) {
	return (
		exactKeys(value, [
			"id",
			"runId",
			"taskId",
			"attempt",
			"incidentId",
			"code",
			"at",
			"sequence",
		]) &&
		HASH_RE.test(value.id) &&
		typeof value.runId === "string" &&
		typeof value.taskId === "string" &&
		(typeof value.attempt === "string" ||
			Number.isSafeInteger(value.attempt)) &&
		typeof value.incidentId === "string" &&
		[...HOLD_CODES, ...TRANSIENT_CODES, SUCCESS_CODE].includes(value.code) &&
		Number.isFinite(value.at) &&
		Number.isSafeInteger(value.sequence)
	);
}

function validGeneration(value) {
	return (
		exactKeys(value, [
			"publicConfigurationEpoch",
			"repairEpoch",
			"state",
			"attempts",
			"cooldownStep",
			"cooldownUntil",
		]) &&
		HASH_RE.test(value.publicConfigurationEpoch) &&
		Number.isSafeInteger(value.repairEpoch) &&
		["healthy", "suspect", "cooldown"].includes(value.state) &&
		Array.isArray(value.attempts) &&
		value.attempts.length <= MAX_ATTEMPTS &&
		value.attempts.every(validAttempt) &&
		Number.isSafeInteger(value.cooldownStep) &&
		value.cooldownStep >= 0 &&
		(value.cooldownUntil === null || Number.isFinite(value.cooldownUntil))
	);
}

export function validateObservations(value, identity) {
	if (
		!exactKeys(value, [
			"schemaVersion",
			"targetId",
			"descriptorIdentity",
			"revision",
			"generations",
			"seenAttemptIds",
		]) ||
		value.schemaVersion !== SCHEMA_VERSION ||
		value.targetId !== identity.targetId ||
		value.descriptorIdentity !== identity.descriptorIdentity ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		!plain(value.generations) ||
		Object.keys(value.generations).length > 256 ||
		!Object.entries(value.generations).every(
			([key, generation]) => HASH_RE.test(key) && validGeneration(generation),
		) ||
		!Array.isArray(value.seenAttemptIds) ||
		value.seenAttemptIds.length > MAX_ATTEMPTS ||
		!value.seenAttemptIds.every((id) => HASH_RE.test(id)) ||
		new Set(value.seenAttemptIds).size !== value.seenAttemptIds.length
	)
		throw new RouteHealthSchemaError("route health observations are invalid");
	return value;
}

export async function assertOwned(path, directory = false) {
	const stat = await lstat(path);
	if (
		(directory ? !stat.isDirectory() : !stat.isFile()) ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid() ||
		(stat.mode & 0o077) !== 0
	)
		throw new RouteHealthSchemaError("route health storage is not owner-only");
	return stat;
}

export async function boundedRead(path, validate, identity, optional = false) {
	try {
		const stat = await assertOwned(path);
		if (stat.size > MAX_BYTES)
			throw new RouteHealthSchemaError("route health record exceeds limit");
		const raw = await readFile(path, "utf8");
		return { raw, value: validate(JSON.parse(raw), identity) };
	} catch (error) {
		if (optional && error?.code === "ENOENT") return null;
		if (error instanceof RouteHealthSchemaError) throw error;
		throw new RouteHealthSchemaError("route health storage is unavailable");
	}
}

export async function readDerivedForUpdate(path, identity, allowRepair) {
	let stat;
	try {
		stat = await assertOwned(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	if (stat.size > MAX_BYTES)
		throw new RouteHealthSchemaError("route health record exceeds limit");
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new RouteHealthSchemaError("route health storage is unavailable");
	}
	try {
		return { raw, value: validateObservations(JSON.parse(raw), identity) };
	} catch (error) {
		if (allowRepair && error instanceof RouteHealthSchemaError)
			return { raw, value: null, corrupt: true };
		throw error;
	}
}

export function unavailable(reason = "health-storage-unavailable") {
	return { available: false, state: "health-unavailable", reason };
}

export function emit(input, event) {
	input.onStatus?.({ phase: "route_health", event });
}
