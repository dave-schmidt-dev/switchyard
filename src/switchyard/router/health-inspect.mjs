import { randomUUID } from "node:crypto";

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

import { dirname } from "node:path";

import {
	getInvocationDescriptor,
	getInvocationDescriptorIdentity,
	resolveTargetIdentity,
} from "../roster/index.mjs";

import {
	lockRecord,
	observationsDigest,
	pairMatches,
	readSyncRecord,
	reclaimAbandonedLock,
	verifyControlCas,
	verifyLock,
} from "./health-lock.mjs";

import {
	assertOwned,
	boundedRead,
	createRouteHealthKey,
	derivePublicConfigurationEpoch,
	emit,
	identityFrom,
	initialControl,
	initialObservations,
	locations,
	MAX_BYTES,
	normalizedList,
	RouteHealthSchemaError,
	resolveHealthStateRoot,
	scopeKey,
	unavailable,
	validateControl,
	validateObservations,
} from "./health-schema.mjs";

export function updateScopeSync(
	input,
	mutate,
	{ allowInitialize = false } = {},
) {
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
			if (error?.code !== "EEXIST") throw error;
			if (!reclaimAbandonedLock(location, input))
				return unavailable("health-lease-held");
			try {
				lockFd = openSync(location.lock, "wx", 0o600);
			} catch (retryError) {
				if (retryError?.code === "EEXIST")
					return unavailable("health-lease-held");
				throw retryError;
			}
		}
		lease = { token: randomUUID(), ino: lstatSync(location.lock).ino };
		writeFileSync(lockFd, lockRecord(lease.token));
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

export function generationFor(observations, input) {
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

export function effective(control, observations, input, now) {
	const { key, value } = generationFor(observations, input);
	if (control.claim)
		return { key, value, state: "half-open", claim: control.claim };
	if (control.holds.length) return { key, value, state: "repair-hold" };
	if (value.state === "cooldown")
		return {
			key,
			value,
			state: "cooldown",
			trialAvailable: value.cooldownUntil <= now,
		};
	return { key, value, state: value.state };
}

export function repairTrialAvailable(control, input) {
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
