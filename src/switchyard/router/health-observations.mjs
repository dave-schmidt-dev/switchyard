import { hasAuthoritativeDiagnosticProvenance } from "../adapter/exec-error.mjs";
import { isProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import { validateInvocationDescriptor } from "../roster/index.mjs";

import { readAuthorizedRunEvidence } from "../run-store/index.mjs";

import { claimIdentity, exactClaim } from "./health-claims.mjs";

import { effective, generationFor } from "./health-inspect.mjs";

import { updateScope } from "./health-lock.mjs";

import {
	ADAPTER_CONTRACT_VERSION,
	COOLDOWN_MS,
	exactKeys,
	HOLD_CODES,
	hash,
	identityFrom,
	initialObservations,
	MAX_ATTEMPTS,
	OBSERVATION_AUTHORITY,
	PROVIDER_COOLDOWN_CODES,
	RouteHealthSchemaError,
	SUCCESS_CODE,
	safeEpoch,
	safeHash,
	safeId,
	safeTime,
	scopeKey,
	TRANSIENT_CODES,
	WINDOW_MS,
} from "./health-schema.mjs";

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
		if (PROVIDER_COOLDOWN_CODES.has(attempt.code)) {
			cooldownStep = Math.min(cooldownStep + 1, COOLDOWN_MS.length);
			cooldownUntil = attempt.at + COOLDOWN_MS[cooldownStep - 1];
			state = "cooldown";
			continue;
		}
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
	if (
		![
			...HOLD_CODES,
			...TRANSIENT_CODES,
			...PROVIDER_COOLDOWN_CODES,
			SUCCESS_CODE,
		].includes(input.code)
	)
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

function confirmedProviderCooldownCode(input) {
	const diagnostic = input?.providerReliability;
	if (
		!isProviderReliabilityDiagnostic(diagnostic) ||
		diagnostic.causeCategory !== "provider" ||
		diagnostic.phase !== "provider" ||
		!PROVIDER_COOLDOWN_CODES.has(diagnostic.causeCode) ||
		input.diagnosticCode !== diagnostic.causeCode ||
		input.diagnosticOrigin !== "adapter" ||
		input.diagnosticEvidenceAvailable !== true ||
		input.failurePhase !== "provider_execution" ||
		!hasAuthoritativeDiagnosticProvenance(input)
	)
		return null;
	return diagnostic.causeCode;
}

function providerLifecycleClosed(input) {
	const lifecycle = input?.providerLifecycle;
	const cleanupClosed =
		(input.healthLane === "simple-direct" &&
			lifecycle?.cleanupStage === null &&
			["not_required", "succeeded"].includes(lifecycle?.cleanupStatus)) ||
		(input.healthLane === "queue-vm" &&
			lifecycle?.cleanupStage === "index_lock_removed" &&
			lifecycle?.cleanupStatus === "succeeded");
	if (
		lifecycle?.schemaVersion !== 1 ||
		lifecycle.terminalStatus !== "exited" ||
		lifecycle.writerLifecycle !== "stopped" ||
		!cleanupClosed
	)
		return false;
	if (
		Number.isSafeInteger(input.exitCode) &&
		lifecycle.exitCode !== input.exitCode
	)
		return false;
	if (input.signal !== undefined && input.signal !== lifecycle.signal)
		return false;
	return true;
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
		!["task_completed", "task_failed", "provider_attempt_terminal"].includes(
			event.event,
		) ||
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
		["task_failed", "provider_attempt_terminal"].includes(event.event) &&
		hasAuthoritativeDiagnosticProvenance(event) &&
		HOLD_CODES.has(event.diagnosticCode)
	)
		code = event.diagnosticCode;
	else if (
		binding.transportVerified === false &&
		["task_failed", "provider_attempt_terminal"].includes(event.event) &&
		binding.lifecycleVerified === true &&
		confirmedProviderCooldownCode(event) !== null
	)
		code = confirmedProviderCooldownCode(event);
	else if (
		binding.transportVerified === false &&
		["task_failed", "provider_attempt_terminal"].includes(event.event) &&
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
	// Lock-reclaim seams. Injectable so a test can prove the abandoned-lock
	// path without guessing a pid that is genuinely dead on the host.
	ownerAlive,
	now,
} = {}) {
	const observations = await collectAuthorized(authorisedRuns, onStatus);
	const results = [];
	for (const observation of observations) {
		const result = await recordAuthorizedObservation(
			{ ...observation, healthStateRoot, onStatus, ownerAlive, now },
			OBSERVATION_AUTHORITY,
		);
		results.push({
			...result,
			runId: observation.runId,
			taskId: observation.taskId,
			attempt: observation.attempt,
			targetId: observation.targetId,
			descriptorIdentity: observation.descriptorIdentity,
			publicConfigurationEpoch: observation.publicConfigurationEpoch,
			repairEpoch: observation.repairEpoch,
			code: observation.code,
		});
	}
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
	const cooldownCode = confirmedProviderCooldownCode(input);
	if (cooldownCode && !providerLifecycleClosed(input)) return null;
	const lifecycleVerified =
		lifecycleReceiptMatches(input.lifecycleReceipt, input) ||
		(["simple-direct", "queue-vm"].includes(input.healthLane) &&
			providerLifecycleClosed(input));
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
			TRANSIENT_CODES.has(input.diagnosticCode) ||
			cooldownCode !== null)
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
