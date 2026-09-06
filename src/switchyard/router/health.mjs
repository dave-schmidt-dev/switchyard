import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasAuthoritativeDiagnosticProvenance } from "../adapter/exec-error.mjs";
import {
	getInvocationDescriptor,
	getInvocationDescriptorIdentity,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import { readAuthorizedRunEvidence } from "../run-store/index.mjs";

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
const ADAPTER_CONTRACT_VERSION = "switchyard-route-health-v1";
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPAIR_KINDS = new Set([
	"image_repaired",
	"auth_repaired",
	"configuration_repaired",
]);
const HOLD_CODES = new Set([
	"auth_expired",
	"model_unavailable",
	"cli_usage_error",
]);
const SUCCESS_CODE = "verified_transport_success";
// Task 4.2 may qualify closed transport codes after its producer audit. Until
// then generic transient failures cannot create suspect/cooldown authority.
const QUALIFIED_TRANSIENT_ROUTE_HEALTH_CODES = Object.freeze([]);
const TRANSIENT_CODES = new Set(QUALIFIED_TRANSIENT_ROUTE_HEALTH_CODES);
const MAX_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 512;
const WINDOW_MS = 10 * 60 * 1000;
const COOLDOWN_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const OBSERVATION_AUTHORITY = Symbol("route-health-observation-authority");

class RouteHealthSchemaError extends Error {
	constructor(message) {
		super(message);
		this.name = "RouteHealthSchemaError";
	}
}

function hash(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function plain(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys) {
	return plain(value) && Object.keys(value).every((key) => keys.includes(key));
}
function safeId(value, label) {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 256 ||
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
	)
		throw new RouteHealthSchemaError(`${label} is invalid`);
	return value;
}
function safeHash(value, label) {
	if (!HASH_RE.test(value ?? ""))
		throw new RouteHealthSchemaError(`${label} is invalid`);
	return value;
}
function safeEpoch(value) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RouteHealthSchemaError("repair epoch is invalid");
	return value;
}
function safeTime(value, label = "timestamp") {
	if (!Number.isFinite(value) || value < 0)
		throw new RouteHealthSchemaError(`${label} is invalid`);
	return value;
}
function safeAttempt(value) {
	if (
		!(Number.isSafeInteger(value) && value >= 0) &&
		!(typeof value === "string" && value.length > 0 && value.length <= 128)
	)
		throw new RouteHealthSchemaError("attempt is invalid");
	return value;
}
function normalizedList(value, label) {
	if (!Array.isArray(value) || value.length > 256)
		throw new RouteHealthSchemaError(`${label} is invalid`);
	const result = value.map((item) => safeId(item, label)).sort();
	if (new Set(result).size !== result.length)
		throw new RouteHealthSchemaError(`${label} contains duplicates`);
	return result;
}

function resolveHealthStateRoot(healthStateRoot) {
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

function identityFrom(input) {
	return {
		targetId: safeId(input?.targetId, "target id"),
		descriptorIdentity: safeHash(
			input?.descriptorIdentity,
			"descriptor identity",
		),
	};
}
function scopeKey(identity) {
	return hash(JSON.stringify(identity));
}
function createRouteHealthKey(input) {
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
function locations(root, scope) {
	const leaf = scope.slice(7);
	return {
		control: resolve(root, "control", `${leaf}.json`),
		observations: resolve(root, "observations", `${leaf}.json`),
		initialized: resolve(root, "control", `${leaf}.initialized`),
		lock: resolve(root, "locks", `${leaf}.lock`),
	};
}
function initialControl(identity) {
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
function initialObservations(identity) {
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
function validateControl(value, identity) {
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
function validateObservations(value, identity) {
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

async function assertOwned(path, directory = false) {
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
async function boundedRead(path, validate, identity, optional = false) {
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
async function readDerivedForUpdate(path, identity, allowRepair) {
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
function unavailable(reason = "health-storage-unavailable") {
	return { available: false, state: "health-unavailable", reason };
}
function emit(input, event) {
	input.onStatus?.({ phase: "route_health", event });
}
function verifyLock(location, lease) {
	const stat = lstatSync(location.lock);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.ino !== lease.ino ||
		readFileSync(location.lock, "utf8") !== `${lease.token}\n`
	)
		throw new RouteHealthSchemaError("route health lease displaced");
}
function verifyControlCas(location, identity, before) {
	if (before === null) {
		try {
			lstatSync(location.control);
			throw new RouteHealthSchemaError("route health revision displaced");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		return;
	}
	const raw = readFileSync(location.control, "utf8");
	const current = validateControl(JSON.parse(raw), identity);
	if (raw !== before.raw || current.revision !== before.value.revision)
		throw new RouteHealthSchemaError("route health revision displaced");
}
function observationsDigest(observations) {
	return hash(JSON.stringify(observations));
}
function pairMatches(control, observations) {
	return (
		control.observationsRevision === observations.revision &&
		control.observationsDigest === observationsDigest(observations)
	);
}
async function updateScope(
	input,
	mutate,
	{ allowInitialize = false, allowObservationRepair = false } = {},
) {
	const identity = identityFrom(input);
	const root = resolveHealthStateRoot(input.healthStateRoot);
	const location = locations(root, scopeKey(identity));
	let descriptor;
	let lease;
	try {
		emit(input, "health_update_start");
		await mkdir(root, { recursive: true, mode: 0o700 });
		await assertOwned(root, true);
		for (const directory of [
			dirname(location.control),
			dirname(location.observations),
			dirname(location.lock),
		]) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await assertOwned(directory, true);
		}
		try {
			descriptor = await open(location.lock, "wx", 0o600);
		} catch (error) {
			if (error?.code === "EEXIST") return unavailable("health-lease-held");
			throw error;
		}
		lease = { token: randomUUID(), ino: (await descriptor.stat()).ino };
		await descriptor.writeFile(`${lease.token}\n`);
		await descriptor.sync();
		const beforeControl = await boundedRead(
			location.control,
			validateControl,
			identity,
			true,
		);
		const beforeObservations = await readDerivedForUpdate(
			location.observations,
			identity,
			allowObservationRepair,
		);
		let initialized = false;
		try {
			const initializedStat = await assertOwned(location.initialized);
			initialized = initializedStat.size === 0;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		if (
			!beforeControl &&
			(initialized || !allowInitialize || beforeObservations)
		)
			return unavailable("health-control-unavailable");
		if (beforeControl && !initialized)
			return unavailable("health-initialization-registry-unavailable");
		if (beforeControl && !beforeObservations && !allowObservationRepair)
			return unavailable("health-observations-unavailable");
		if (
			beforeControl &&
			beforeObservations &&
			(!beforeObservations.value ||
				!pairMatches(beforeControl.value, beforeObservations.value)) &&
			!allowObservationRepair
		)
			return unavailable("health-observation-commit-mismatch");
		const control = structuredClone(
			beforeControl?.value ?? initialControl(identity),
		);
		const observations = structuredClone(
			beforeObservations?.value ?? initialObservations(identity),
		);
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== control.revision
		)
			return unavailable("health-revision-conflict");
		const result = await mutate({ control, observations, identity });
		if (result?.write === false)
			return { available: true, revision: control.revision, ...result };
		control.revision += 1;
		observations.revision = control.revision;
		control.observationsRevision = observations.revision;
		control.observationsDigest = observationsDigest(observations);
		validateControl(control, identity);
		validateObservations(observations, identity);
		const suffix = `${process.pid}.${randomUUID()}.tmp`;
		const controlTemp = `${location.control}.${suffix}`;
		const observationsTemp = `${location.observations}.${suffix}`;
		if (!initialized)
			await writeFile(location.initialized, "", { mode: 0o600, flag: "wx" });
		await writeFile(controlTemp, JSON.stringify(control), {
			mode: 0o600,
			flag: "wx",
		});
		await writeFile(observationsTemp, JSON.stringify(observations), {
			mode: 0o600,
			flag: "wx",
		});
		emit(input, "health_publish_staged");
		verifyLock(location, lease);
		verifyControlCas(location, identity, beforeControl);
		// Publication is synchronous after the final lease/CAS check so another JS
		// writer cannot interleave between validation and rename.
		renameSync(controlTemp, location.control);
		emit(input, "health_control_published");
		renameSync(observationsTemp, location.observations);
		emit(input, "health_publish_complete");
		return { available: true, revision: control.revision, ...result };
	} catch {
		emit(input, "health_update_unavailable");
		return unavailable();
	} finally {
		if (descriptor) {
			try {
				if (lease) verifyLock(location, lease);
				unlinkSync(location.lock);
			} catch {}
			await descriptor.close().catch(() => {});
		}
	}
}

function readSyncRecord(path, validate, identity, optional = false) {
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid() ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > MAX_BYTES
		)
			throw new RouteHealthSchemaError("route health storage is unavailable");
		const raw = readFileSync(path, "utf8");
		return { raw, value: validate(JSON.parse(raw), identity) };
	} catch (error) {
		if (optional && error?.code === "ENOENT") return null;
		throw error;
	}
}

/** Synchronous lock/CAS publication used at the synchronous routing boundary. */
function updateScopeSync(input, mutate, { allowInitialize = false } = {}) {
	const identity = identityFrom(input);
	const root = resolveHealthStateRoot(input.healthStateRoot);
	const location = locations(root, scopeKey(identity));
	let lockFd = null;
	let lease = null;
	try {
		emit(input, "health_update_start");
		for (const directory of [
			root,
			dirname(location.control),
			dirname(location.observations),
			dirname(location.lock),
		]) {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const stat = lstatSync(directory);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				stat.uid !== process.getuid() ||
				(stat.mode & 0o077) !== 0
			)
				throw new RouteHealthSchemaError("route health storage is unavailable");
		}
		try {
			lockFd = openSync(location.lock, "wx", 0o600);
		} catch (error) {
			if (error?.code === "EEXIST") return unavailable("health-lease-held");
			throw error;
		}
		lease = { token: randomUUID(), ino: lstatSync(location.lock).ino };
		writeFileSync(lockFd, `${lease.token}\n`);
		fsyncSync(lockFd);
		const beforeControl = readSyncRecord(
			location.control,
			validateControl,
			identity,
			true,
		);
		const beforeObservations = readSyncRecord(
			location.observations,
			validateObservations,
			identity,
			true,
		);
		let initialized = false;
		try {
			const stat = lstatSync(location.initialized);
			initialized =
				stat.isFile() &&
				!stat.isSymbolicLink() &&
				stat.uid === process.getuid() &&
				(stat.mode & 0o077) === 0 &&
				stat.size === 0;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		if (
			!beforeControl &&
			(initialized || !allowInitialize || beforeObservations)
		)
			return unavailable("health-control-unavailable");
		if (beforeControl && !initialized)
			return unavailable("health-initialization-registry-unavailable");
		if (beforeControl && !beforeObservations)
			return unavailable("health-observations-unavailable");
		if (
			beforeControl &&
			beforeObservations &&
			!pairMatches(beforeControl.value, beforeObservations.value)
		)
			return unavailable("health-observation-commit-mismatch");
		const control = structuredClone(
			beforeControl?.value ?? initialControl(identity),
		);
		const observations = structuredClone(
			beforeObservations?.value ?? initialObservations(identity),
		);
		const result = mutate({ control, observations, identity });
		if (result?.write === false)
			return { available: true, revision: control.revision, ...result };
		control.revision += 1;
		observations.revision = control.revision;
		control.observationsRevision = observations.revision;
		control.observationsDigest = observationsDigest(observations);
		validateControl(control, identity);
		validateObservations(observations, identity);
		const suffix = `${process.pid}.${randomUUID()}.tmp`;
		const controlTemp = `${location.control}.${suffix}`;
		const observationsTemp = `${location.observations}.${suffix}`;
		if (!initialized)
			writeFileSync(location.initialized, "", { mode: 0o600, flag: "wx" });
		writeFileSync(controlTemp, JSON.stringify(control), {
			mode: 0o600,
			flag: "wx",
		});
		writeFileSync(observationsTemp, JSON.stringify(observations), {
			mode: 0o600,
			flag: "wx",
		});
		verifyLock(location, lease);
		verifyControlCas(location, identity, beforeControl);
		renameSync(controlTemp, location.control);
		renameSync(observationsTemp, location.observations);
		emit(input, "health_publish_complete");
		return { available: true, revision: control.revision, ...result };
	} catch {
		emit(input, "health_update_unavailable");
		return unavailable();
	} finally {
		if (lockFd !== null) {
			try {
				if (lease) verifyLock(location, lease);
				unlinkSync(location.lock);
			} catch {}
			try {
				closeSync(lockFd);
			} catch {}
		}
	}
}

function generationFor(observations, input) {
	const key = createRouteHealthKey(input);
	return {
		key,
		value: observations.generations[key] ?? {
			publicConfigurationEpoch: input.publicConfigurationEpoch,
			repairEpoch: input.repairEpoch,
			state: "healthy",
			attempts: [],
			cooldownStep: 0,
			cooldownUntil: null,
		},
	};
}
function effective(control, observations, input, now) {
	const { key, value } = generationFor(observations, input);
	if (control.claim)
		return { key, value, state: "half-open", claim: control.claim };
	if (control.holds.length) return { key, value, state: "repair-hold" };
	if (value.state === "cooldown")
		return {
			key,
			value,
			state: value.cooldownUntil <= now ? "cooldown" : "cooldown",
			trialAvailable: value.cooldownUntil <= now,
		};
	return { key, value, state: value.state };
}

function repairTrialAvailable(control, input) {
	if (control.holds.length === 0) return false;
	const newestHold = Math.max(...control.holds.map((hold) => hold.at));
	return control.attestations.some(
		(attestation) =>
			attestation.publicConfigurationEpoch === input.publicConfigurationEpoch &&
			attestation.repairEpoch === control.repairEpoch &&
			attestation.at > newestHold,
	);
}

export async function inspectRouteHealth(input) {
	const identity = identityFrom(input);
	const root = resolveHealthStateRoot(input.healthStateRoot);
	try {
		emit(input, "health_inspect_start");
		const location = locations(root, scopeKey(identity));
		for (const directory of [
			root,
			dirname(location.control),
			dirname(location.observations),
		])
			await assertOwned(directory, true);
		const initialized = await assertOwned(location.initialized);
		if (initialized.size !== 0)
			throw new RouteHealthSchemaError(
				"health initialization registry is invalid",
			);
		const control = await boundedRead(
			location.control,
			validateControl,
			identity,
		);
		const observations = await boundedRead(
			location.observations,
			validateObservations,
			identity,
			true,
		);
		if (!observations) return unavailable("health-observations-unavailable");
		if (!pairMatches(control.value, observations.value))
			return unavailable("health-observation-commit-mismatch");
		const currentInput = { ...input, repairEpoch: control.value.repairEpoch };
		const result = effective(
			control.value,
			observations.value,
			currentInput,
			input.nowMs ?? Date.now(),
		);
		return {
			available: true,
			state: result.state,
			revision: control.value.revision,
			repairEpoch: control.value.repairEpoch,
			healthKey: result.key,
			trialAvailable:
				result.trialAvailable === true ||
				(result.state === "repair-hold" &&
					repairTrialAvailable(control.value, currentInput)),
			claimStatus: result.claim
				? result.claim.started
					? "started"
					: "allocated"
				: null,
		};
	} catch {
		emit(input, "health_inspect_unavailable");
		return unavailable();
	}
}

/**
 * Read the committed health projection without yielding.  Router entry points
 * are deliberately synchronous, so this is the read-only counterpart to the
 * locked async lifecycle APIs above.  It never initializes, repairs, or
 * claims state: an unreadable or incomplete pair is simply unavailable.
 */
function inspectRouteHealthSync(input) {
	try {
		const identity = identityFrom(input);
		const root = resolveHealthStateRoot(input.healthStateRoot);
		const location = locations(root, scopeKey(identity));
		for (const directory of [
			root,
			dirname(location.control),
			dirname(location.observations),
		]) {
			const stat = lstatSync(directory);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				stat.uid !== process.getuid() ||
				(stat.mode & 0o077) !== 0
			)
				throw new RouteHealthSchemaError("route health storage is unavailable");
		}
		const initialized = lstatSync(location.initialized);
		if (
			!initialized.isFile() ||
			initialized.isSymbolicLink() ||
			initialized.size !== 0 ||
			initialized.uid !== process.getuid() ||
			(initialized.mode & 0o077) !== 0
		)
			throw new RouteHealthSchemaError("route health storage is unavailable");
		const readSync = (path, validate, optional = false) => {
			try {
				const stat = lstatSync(path);
				if (
					!stat.isFile() ||
					stat.isSymbolicLink() ||
					stat.uid !== process.getuid() ||
					(stat.mode & 0o077) !== 0 ||
					stat.size > MAX_BYTES
				)
					throw new RouteHealthSchemaError(
						"route health storage is unavailable",
					);
				return validate(JSON.parse(readFileSync(path, "utf8")), identity);
			} catch (error) {
				if (optional && error?.code === "ENOENT") return null;
				throw error;
			}
		};
		const control = readSync(location.control, validateControl);
		const observations = readSync(
			location.observations,
			validateObservations,
			true,
		);
		if (!observations || !pairMatches(control, observations))
			return unavailable("health-observations-unavailable");
		const currentInput = { ...input, repairEpoch: control.repairEpoch };
		const result = effective(
			control,
			observations,
			currentInput,
			input.nowMs ?? Date.now(),
		);
		return {
			available: true,
			state: result.state,
			revision: control.revision,
			repairEpoch: control.repairEpoch,
			healthKey: result.key,
			trialAvailable:
				result.trialAvailable === true ||
				(result.state === "repair-hold" &&
					repairTrialAvailable(control, currentInput)),
			claimStatus: result.claim
				? result.claim.started
					? "started"
					: "allocated"
				: null,
		};
	} catch {
		return unavailable();
	}
}

function scopeIsUninitializedSync(input) {
	try {
		const identity = identityFrom(input);
		const location = locations(
			resolveHealthStateRoot(input.healthStateRoot),
			scopeKey(identity),
		);
		for (const path of [
			location.initialized,
			location.control,
			location.observations,
		]) {
			try {
				lstatSync(path);
				return false;
			} catch (error) {
				if (error?.code !== "ENOENT") return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the small synchronous selection facade shared by preflight, ranked,
 * and blind routing.  Enforcement is opt-in; unavailable durable state keeps
 * ordinary static routing intact and never manufactures a half-open trial.
 */
function createRouteHealthDecision({
	healthStateRoot,
	mode = "shadow",
	publicConfigurationEpoch,
	resolveIdentity,
	now = Date.now,
} = {}) {
	const enforcing = mode === "enforce";
	return (candidate) => {
		try {
			const identity = resolveIdentity?.(candidate);
			if (!identity) return { available: false, state: "health-unavailable" };
			const health = inspectRouteHealthSync({
				healthStateRoot,
				publicConfigurationEpoch,
				nowMs: now(),
				...identity,
			});
			const initializable =
				health.available !== true &&
				scopeIsUninitializedSync({
					healthStateRoot,
					publicConfigurationEpoch,
					...identity,
				});
			const blocked =
				(health.state === "repair-hold" && health.trialAvailable !== true) ||
				health.state === "half-open" ||
				(health.state === "cooldown" && health.trialAvailable !== true);
			return {
				...health,
				initializable,
				mode: enforcing ? "enforce" : "shadow",
				suppress: enforcing && health.available === true && blocked,
			};
		} catch {
			return {
				available: false,
				state: "health-unavailable",
				mode: enforcing ? "enforce" : "shadow",
				suppress: false,
			};
		}
	};
}

/** Build the production read-only router projection from public roster facts. */
export function createDefaultRouteHealthDecision({
	healthStateRoot,
	mode = "shadow",
	qualifiedProviders = [],
	goldenImageReference = process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE ??
		"golden-image-unconfigured",
	now,
} = {}) {
	const providers = normalizedList(qualifiedProviders, "qualified providers");
	const targets = providers
		.map((provider) => resolveTargetIdentity(provider).targetId)
		.filter(Boolean);
	const publicConfigurationEpoch = derivePublicConfigurationEpoch({
		approvedConfiguration: {
			rosterSchemaVersion: 1,
			approvedTargets: [...new Set(targets)],
			qualifiedProviders: providers,
		},
		goldenImageReference,
	});
	const decision = createRouteHealthDecision({
		healthStateRoot,
		mode,
		publicConfigurationEpoch,
		now,
		resolveIdentity: ({ provider, requiredCapability }) => {
			const targetId = resolveTargetIdentity(provider).targetId;
			const descriptor = getInvocationDescriptor(provider, requiredCapability);
			if (!targetId || !descriptor) return null;
			return {
				targetId,
				descriptorIdentity:
					descriptor.descriptor_identity ??
					getInvocationDescriptorIdentity(
						descriptor,
						resolveTargetIdentity(provider).harnessKey,
					),
			};
		},
	});
	Object.defineProperties(decision, {
		publicConfigurationEpoch: { value: publicConfigurationEpoch },
		healthStateRoot: { value: healthStateRoot },
		mode: { value: mode },
		identityFor: {
			value: ({ provider, requiredCapability }) => {
				const targetId = resolveTargetIdentity(provider).targetId;
				const descriptor = getInvocationDescriptor(
					provider,
					requiredCapability,
				);
				const qualified = providers.some(
					(candidate) => resolveTargetIdentity(candidate).targetId === targetId,
				);
				if (!targetId || !descriptor || !qualified) return null;
				return {
					targetId,
					descriptorIdentity:
						descriptor.descriptor_identity ??
						getInvocationDescriptorIdentity(
							descriptor,
							resolveTargetIdentity(provider).harnessKey,
						),
					publicConfigurationEpoch,
				};
			},
		},
	});
	return decision;
}

export async function attestRouteRepair(input) {
	identityFrom(input);
	safeHash(input.publicConfigurationEpoch, "public configuration epoch");
	if (!REPAIR_KINDS.has(input.repairKind))
		throw new RouteHealthSchemaError("repair kind is invalid");
	const adapterContractId = input.adapterContractId ?? ADAPTER_CONTRACT_VERSION;
	safeId(adapterContractId, "adapter contract id");
	return updateScope(
		input,
		async ({ control }) => {
			if (control.claim)
				return {
					write: false,
					repairEpoch: control.repairEpoch,
					reason: "claim-active",
				};
			control.repairEpoch += 1;
			control.attestations.push({
				publicConfigurationEpoch: input.publicConfigurationEpoch,
				repairEpoch: control.repairEpoch,
				repairKind: input.repairKind,
				adapterContractId,
				at: safeTime(input.nowMs ?? Date.now()),
			});
			return { repairEpoch: control.repairEpoch, state: "repair-hold" };
		},
		{ allowInitialize: true },
	);
}

function claimIdentity(input) {
	return {
		runId: safeId(input.runId, "run id"),
		taskId: safeId(input.taskId, "task id"),
		attempt: safeAttempt(input.attempt),
	};
}
export async function acquireHalfOpenClaim(input) {
	const claimant = claimIdentity(input);
	safeHash(input.publicConfigurationEpoch, "public configuration epoch");
	safeEpoch(input.repairEpoch);
	const now = safeTime(input.nowMs ?? Date.now());
	return updateScope(input, async ({ control, observations }) => {
		if (control.repairEpoch !== input.repairEpoch)
			return { write: false, claimed: false, reason: "stale-repair-epoch" };
		if (control.claim)
			return { write: false, claimed: false, reason: "claim-active" };
		const state = effective(control, observations, input, now);
		const attested = control.attestations.some(
			(item) =>
				item.publicConfigurationEpoch === input.publicConfigurationEpoch &&
				item.repairEpoch === input.repairEpoch &&
				item.at > Math.max(-1, ...control.holds.map((hold) => hold.at)),
		);
		const eligibleRepair = state.state === "repair-hold" && attested;
		const eligibleCooldown =
			state.state === "cooldown" && state.trialAvailable === true;
		if (!eligibleRepair && !eligibleCooldown)
			return { write: false, claimed: false, state: state.state };
		const revision = control.revision + 1;
		control.claim = {
			token: randomUUID(),
			healthKey: state.key,
			revision,
			...claimant,
			started: false,
			acquiredAt: now,
		};
		return {
			claimed: true,
			state: "half-open",
			lease: { ...control.claim },
		};
	});
}

export function acquireHalfOpenClaimSync(input) {
	const claimant = claimIdentity(input);
	safeHash(input.publicConfigurationEpoch, "public configuration epoch");
	safeEpoch(input.repairEpoch);
	const now = safeTime(input.nowMs ?? Date.now());
	return updateScopeSync(input, ({ control, observations }) => {
		if (control.repairEpoch !== input.repairEpoch)
			return { write: false, claimed: false, reason: "stale-repair-epoch" };
		if (control.claim)
			return { write: false, claimed: false, reason: "claim-active" };
		const state = effective(control, observations, input, now);
		const eligibleRepair =
			state.state === "repair-hold" && repairTrialAvailable(control, input);
		const eligibleCooldown =
			state.state === "cooldown" && state.trialAvailable === true;
		if (!eligibleRepair && !eligibleCooldown)
			return { write: false, claimed: false, state: state.state };
		control.claim = {
			token: randomUUID(),
			healthKey: state.key,
			revision: control.revision + 1,
			...claimant,
			started: false,
			acquiredAt: now,
		};
		return { claimed: true, state: "half-open", lease: { ...control.claim } };
	});
}
function exactClaim(claim, input) {
	return (
		claim &&
		(input.leaseToken === undefined || claim.token === input.leaseToken) &&
		claim.revision === input.leaseRevision &&
		claim.healthKey === createRouteHealthKey(input) &&
		claim.runId === input.runId &&
		claim.taskId === input.taskId &&
		claim.attempt === input.attempt
	);
}
export async function startHalfOpenClaim(input) {
	claimIdentity(input);
	if (!UUID_RE.test(input.leaseToken ?? ""))
		throw new RouteHealthSchemaError("half-open lease token is invalid");
	return updateScope(input, async ({ control }) => {
		if (!exactClaim(control.claim, input) || control.claim.started)
			return { write: false, started: false, reason: "stale-or-started-claim" };
		control.claim.started = true;
		return { started: true, lease: { ...control.claim } };
	});
}

export function startHalfOpenClaimSync(input) {
	claimIdentity(input);
	if (!UUID_RE.test(input.leaseToken ?? ""))
		throw new RouteHealthSchemaError("half-open lease token is invalid");
	return updateScopeSync(input, ({ control }) => {
		if (!exactClaim(control.claim, input) || control.claim.started)
			return { write: false, started: false, reason: "stale-or-started-claim" };
		control.claim.started = true;
		return { started: true, lease: { ...control.claim } };
	});
}
export async function releaseHalfOpenClaim(input) {
	claimIdentity(input);
	if (!UUID_RE.test(input.leaseToken ?? ""))
		throw new RouteHealthSchemaError("half-open lease token is invalid");
	return updateScope(input, async ({ control }) => {
		if (!exactClaim(control.claim, input))
			return { write: false, released: false, reason: "stale-claim" };
		if (control.claim.started || input.provenNeverStarted !== true)
			return {
				write: false,
				released: false,
				reason: "claim-liveness-unknown",
			};
		control.claim = null;
		return { released: true };
	});
}

export function releaseHalfOpenClaimSync(input) {
	claimIdentity(input);
	if (!UUID_RE.test(input.leaseToken ?? ""))
		throw new RouteHealthSchemaError("half-open lease token is invalid");
	return updateScopeSync(input, ({ control }) => {
		if (!exactClaim(control.claim, input))
			return { write: false, released: false, reason: "stale-claim" };
		if (control.claim.started || input.provenNeverStarted !== true)
			return {
				write: false,
				released: false,
				reason: "claim-liveness-unknown",
			};
		control.claim = null;
		return { released: true };
	});
}

function observationId(input) {
	return hash(JSON.stringify([input.runId, input.taskId, input.attempt]));
}
function compareAttempts(a, b) {
	return (
		a.at - b.at || a.runId.localeCompare(b.runId) || a.sequence - b.sequence
	);
}
function recomputeGeneration(generation, now) {
	generation.attempts.sort(compareAttempts);
	let state = "healthy";
	let cooldownStep = 0;
	let cooldownUntil = null;
	for (let index = 0; index < generation.attempts.length; index += 1) {
		const attempt = generation.attempts[index];
		if (attempt.code === SUCCESS_CODE) {
			state = "healthy";
			cooldownUntil = null;
			continue;
		}
		if (HOLD_CODES.has(attempt.code)) continue;
		const incidents = new Set(
			generation.attempts
				.slice(0, index + 1)
				.filter(
					(item) =>
						TRANSIENT_CODES.has(item.code) && attempt.at - item.at <= WINDOW_MS,
				)
				.map((item) => item.incidentId),
		);
		if (incidents.size < 2) state = "suspect";
		else {
			cooldownStep = Math.min(cooldownStep + 1, COOLDOWN_MS.length);
			cooldownUntil = attempt.at + COOLDOWN_MS[cooldownStep - 1];
			state = "cooldown";
		}
	}
	generation.state = state;
	generation.cooldownStep = cooldownStep;
	generation.cooldownUntil = cooldownUntil;
	return now;
}
async function recordAuthorizedObservation(input, authority) {
	if (authority !== OBSERVATION_AUTHORITY)
		return {
			available: true,
			accepted: false,
			reason: "untrusted-observation",
		};
	const claimant = claimIdentity(input);
	const at = safeTime(input.at);
	if (![...HOLD_CODES, ...TRANSIENT_CODES, SUCCESS_CODE].includes(input.code))
		throw new RouteHealthSchemaError("route health code is invalid");
	return updateScope(
		input,
		async ({ control, observations }) => {
			if (control.repairEpoch !== input.repairEpoch)
				return { write: false, accepted: false, reason: "stale-repair-epoch" };
			const id = observationId(input);
			if (observations.seenAttemptIds.includes(id))
				return { write: false, accepted: false, reason: "duplicate-attempt" };
			if (observations.seenAttemptIds.length >= MAX_ATTEMPTS)
				return {
					write: false,
					accepted: false,
					reason: "observation-capacity",
				};
			const trial = input.leaseRevision !== undefined;
			if (
				trial &&
				(!exactClaim(control.claim, input) || !control.claim.started)
			)
				return {
					write: false,
					accepted: false,
					reason: "stale-or-unstarted-claim",
				};
			if (control.claim && !trial)
				return { write: false, accepted: false, reason: "claim-active" };
			const { key, value } = generationFor(observations, input);
			value.attempts.push({
				id,
				...claimant,
				incidentId: safeId(input.incidentId ?? id, "incident id"),
				code: input.code,
				at,
				sequence: input.sequence,
			});
			observations.seenAttemptIds.push(id);
			recomputeGeneration(value, at);
			observations.generations[key] = value;
			if (HOLD_CODES.has(input.code)) {
				control.holds.push({
					code: input.code,
					publicConfigurationEpoch: input.publicConfigurationEpoch,
					repairEpoch: input.repairEpoch,
					at,
				});
			}
			if (trial) {
				control.claim = null;
				if (input.code === SUCCESS_CODE) control.holds = [];
			}
			return {
				accepted: true,
				state: effective(control, observations, input, at).state,
				healthKey: key,
			};
		},
		{ allowInitialize: true },
	);
}
export async function recordRouteHealthObservation(input) {
	return recordAuthorizedObservation(input, null);
}

function eventObservation(event, run) {
	const binding = event.routeHealthBinding;
	if (
		binding?.version !== 1 ||
		binding.producer !== "run-store" ||
		binding.adapterContractId !== ADAPTER_CONTRACT_VERSION ||
		binding.runId !== run.runId ||
		binding.runRevision > run.revision ||
		event.phase !== "execution" ||
		!["task_completed", "task_failed"].includes(event.event) ||
		!event.invocationDescriptor ||
		event.invocationDescriptor.descriptor_identity !==
			event.descriptorIdentity ||
		event.invocationDescriptor.target_id !== event.resolvedTargetId ||
		!event.descriptorHarness ||
		!event.taskId ||
		event.attempt === undefined
	)
		return null;
	let code;
	if (
		binding.transportVerified === true &&
		binding.lifecycleVerified === true &&
		event.servedModelVerified === true
	)
		code = SUCCESS_CODE;
	else if (
		binding.transportVerified === false &&
		event.event === "task_failed" &&
		hasAuthoritativeDiagnosticProvenance(event) &&
		HOLD_CODES.has(event.diagnosticCode)
	)
		code = event.diagnosticCode;
	else if (
		binding.transportVerified === false &&
		event.event === "task_failed" &&
		hasAuthoritativeDiagnosticProvenance(event) &&
		TRANSIENT_CODES.has(event.diagnosticCode)
	)
		code = event.diagnosticCode;
	else return null;
	const at = Date.parse(event.timestamp);
	if (!Number.isFinite(at)) return null;
	return {
		targetId: event.resolvedTargetId,
		descriptorIdentity: event.descriptorIdentity,
		publicConfigurationEpoch: binding.publicConfigurationEpoch,
		repairEpoch: binding.repairEpoch,
		runId: run.runId,
		taskId: event.taskId,
		attempt: event.attempt,
		incidentId: event.hostIncidentId,
		code,
		at,
		sequence: event.sequence,
		...(binding.claimRevision !== undefined
			? { leaseRevision: binding.claimRevision }
			: {}),
	};
}
async function collectAuthorized(authorisedRuns, onStatus) {
	if (!Array.isArray(authorisedRuns) || authorisedRuns.length > 256)
		throw new RouteHealthSchemaError("authorised runs are invalid");
	const observations = [];
	for (const source of authorisedRuns) {
		if (!exactKeys(source, ["runId", "runRoot"]))
			throw new RouteHealthSchemaError("authorised run is invalid");
		safeId(source.runId, "run id");
		onStatus?.({ phase: "route_health", event: "health_ingest_run_start" });
		const evidence = await readAuthorizedRunEvidence(source.runRoot);
		if (evidence.run.runId !== source.runId)
			throw new RouteHealthSchemaError("authorised run id mismatch");
		for (const event of evidence.events) {
			const observation = eventObservation(event, evidence.run);
			if (observation) observations.push(observation);
		}
		onStatus?.({ phase: "route_health", event: "health_ingest_run_complete" });
	}
	return observations.sort(compareAttempts);
}
export async function ingestRouteHealthEvents({
	authorisedRuns,
	healthStateRoot,
	onStatus,
} = {}) {
	const observations = await collectAuthorized(authorisedRuns, onStatus);
	const results = [];
	for (const observation of observations)
		results.push(
			await recordAuthorizedObservation(
				{ ...observation, healthStateRoot, onStatus },
				OBSERVATION_AUTHORITY,
			),
		);
	return results;
}

function lifecycleReceiptMatches(receipt, input) {
	return (
		receipt?.version === 1 &&
		receipt.kind === "completion_continuation_lifecycle" &&
		receipt.providerExited === true &&
		receipt.childrenExited === true &&
		receipt.cleanupSucceeded === true &&
		receipt.taskId === input.taskId &&
		receipt.attemptId === input.attempt &&
		receipt.descriptorIdentity === input.descriptorIdentity &&
		receipt.workspaceId === input.workspaceId
	);
}

/**
 * Mint the closed host binding consumed by the existing serialized outcome
 * event writer. A started trial remains claimed unless exact lifecycle cleanup
 * proof accompanies the terminal result.
 */
export function createRouteHealthTerminalBinding(input) {
	const identity = identityFrom(input);
	const descriptor = validateInvocationDescriptor(
		input.invocationDescriptor,
		input.descriptorHarness,
	);
	if (
		descriptor.descriptor_identity !== identity.descriptorIdentity ||
		descriptor.target_id !== identity.targetId ||
		input.runId === undefined ||
		input.taskId === undefined
	)
		return null;
	const trial = input.claimRevision !== undefined;
	const lifecycleVerified = lifecycleReceiptMatches(
		input.lifecycleReceipt,
		input,
	);
	if (trial && !lifecycleVerified) return null;
	let transportVerified = false;
	if (
		input.providerExecutionSucceeded === true &&
		input.servedModelVerified === true
	) {
		transportVerified = true;
	} else if (
		input.providerExecutionSucceeded !== true &&
		hasAuthoritativeDiagnosticProvenance(input) &&
		(HOLD_CODES.has(input.diagnosticCode) ||
			TRANSIENT_CODES.has(input.diagnosticCode))
	) {
		transportVerified = false;
	} else {
		return null;
	}
	if (transportVerified && !lifecycleVerified) return null;
	return {
		adapterContractId: ADAPTER_CONTRACT_VERSION,
		publicConfigurationEpoch: safeHash(
			input.publicConfigurationEpoch,
			"public configuration epoch",
		),
		repairEpoch: safeEpoch(input.repairEpoch),
		transportVerified,
		lifecycleVerified,
		...(trial ? { claimRevision: input.claimRevision } : {}),
	};
}
export async function rebuildRouteHealth({
	authorisedRuns,
	healthStateRoot,
	onStatus,
} = {}) {
	const observations = await collectAuthorized(authorisedRuns, onStatus);
	const groups = new Map();
	for (const observation of observations) {
		const identity = identityFrom(observation);
		const key = scopeKey(identity);
		if (!groups.has(key)) groups.set(key, { identity, observations: [] });
		groups.get(key).observations.push(observation);
	}
	const results = [];
	for (const group of groups.values()) {
		results.push(
			await updateScope(
				{ ...group.identity, healthStateRoot, onStatus },
				async ({ control, observations: derived }) => {
					const replacement = initialObservations(group.identity);
					for (const observation of group.observations) {
						if (observation.repairEpoch !== control.repairEpoch) continue;
						const id = observationId(observation);
						if (replacement.seenAttemptIds.includes(id)) continue;
						const { key, value } = generationFor(replacement, observation);
						value.attempts.push({
							id,
							runId: observation.runId,
							taskId: observation.taskId,
							attempt: observation.attempt,
							incidentId: observation.incidentId ?? id,
							code: observation.code,
							at: observation.at,
							sequence: observation.sequence,
						});
						replacement.seenAttemptIds.push(id);
						recomputeGeneration(value, observation.at);
						replacement.generations[key] = value;
					}
					Object.assign(derived, replacement);
					return {
						rebuilt: true,
						observationCount: replacement.seenAttemptIds.length,
					};
				},
				{ allowObservationRepair: true },
			),
		);
	}
	return results;
}
