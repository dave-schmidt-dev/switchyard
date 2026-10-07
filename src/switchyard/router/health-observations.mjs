import { hasAuthoritativeDiagnosticProvenance } from "../adapter/exec-error.mjs";
import { FAILURE_REGISTRY } from "../diagnostics/failure-registry.mjs";
import { isProviderReliabilityDiagnostic } from "../diagnostics/provider-reliability.mjs";
import { validateInvocationDescriptor } from "../roster/index.mjs";

import { readAuthorizedRunEvidence } from "../run-store/index.mjs";
import {
	deriveFailureAccountability,
	lifecycleBackedProviderFailure,
} from "../simple/failure-accountability.mjs";

import { claimIdentity, exactClaim } from "./health-claims.mjs";

import {
	claimReclaimable,
	effective,
	generationFor,
} from "./health-inspect.mjs";

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
	TRIAL_INCONCLUSIVE_CODE,
	WINDOW_MS,
} from "./health-schema.mjs";

// Distinct failed attempts inside the window that put a target into cooldown.
const TRANSIENT_INCIDENT_THRESHOLD = 2;

// Compact at half capacity: the ledger file is byte-bounded as well as
// count-bounded, and compaction only drops history a success already settled.
const COMPACT_AT = MAX_ATTEMPTS / 2;

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
	// A success clears the target: failures before it neither count toward the
	// window nor keep the cooldown ladder climbing.
	let barrier = 0;
	const escalate = (at) => {
		cooldownStep = Math.min(cooldownStep + 1, COOLDOWN_MS.length);
		cooldownUntil = at + COOLDOWN_MS[cooldownStep - 1];
		state = "cooldown";
	};
	for (let index = 0; index < generation.attempts.length; index += 1) {
		const attempt = generation.attempts[index];
		if (attempt.code === SUCCESS_CODE) {
			state = "healthy";
			cooldownStep = 0;
			cooldownUntil = null;
			barrier = index + 1;
			continue;
		}
		if (
			HOLD_CODES.has(attempt.code) ||
			attempt.code === TRIAL_INCONCLUSIVE_CODE
		)
			continue;
		if (PROVIDER_COOLDOWN_CODES.has(attempt.code)) {
			escalate(attempt.at);
			continue;
		}
		const incidents = new Set(
			generation.attempts
				.slice(barrier, index + 1)
				.filter(
					(item) =>
						TRANSIENT_CODES.has(item.code) && attempt.at - item.at <= WINDOW_MS,
				)
				.map((item) => item.incidentId),
		);
		// Failures inside an active cooldown are in-flight attempts that started
		// before it: they never step the ladder, however many land together.
		if (state === "cooldown" && attempt.at < cooldownUntil) continue;
		// A failure at or after the cooldown's end is the re-probe failing: it
		// always advances the ladder, however old the earlier failures are.
		const probeFailed = state === "cooldown";
		if (probeFailed || incidents.size >= TRANSIENT_INCIDENT_THRESHOLD)
			escalate(attempt.at);
		// A lone failure never lifts an active cooldown.
		else if (state !== "cooldown") state = "suspect";
	}
	generation.state = state;
	generation.cooldownStep = cooldownStep;
	generation.cooldownUntil = cooldownUntil;
	return now;
}

// Successes are recorded for every simple dispatch, so the per-scope attempt
// ledger would reach MAX_ATTEMPTS and refuse every later observation, trial
// resolutions included. Everything before a generation's last success is
// already folded into its healthy state, so it can be dropped without changing
// it. The success itself stays as the barrier that neutralises any older
// attempt replayed from run evidence.
function compactObservations(observations) {
	const kept = new Set();
	for (const generation of Object.values(observations.generations)) {
		generation.attempts.sort(compareAttempts);
		let lastSuccess = -1;
		for (let index = 0; index < generation.attempts.length; index += 1)
			if (generation.attempts[index].code === SUCCESS_CODE) lastSuccess = index;
		generation.attempts = generation.attempts.slice(Math.max(lastSuccess, 0));
		for (const attempt of generation.attempts) kept.add(attempt.id);
	}
	observations.seenAttemptIds = observations.seenAttemptIds.filter((id) =>
		kept.has(id),
	);
}

// Compaction cannot shrink a generation that never succeeded. When the ledger
// is still full, drop the oldest attempts across generations down to `keep` and
// re-derive each generation from what remains, so a half-open trial can always
// record its result instead of stranding its claim.
function evictOldest(observations, keep) {
	const attempts = Object.values(observations.generations)
		.flatMap((generation) => generation.attempts)
		.sort(compareAttempts);
	const dropped = new Set(
		attempts
			.slice(0, Math.max(0, attempts.length - keep))
			.map((attempt) => attempt.id),
	);
	for (const generation of Object.values(observations.generations)) {
		generation.attempts = generation.attempts.filter(
			(attempt) => !dropped.has(attempt.id),
		);
		recomputeGeneration(generation, null);
	}
	observations.seenAttemptIds = observations.seenAttemptIds.filter(
		(id) => !dropped.has(id),
	);
}

// A transient failure stamped at or before a recorded success is history the
// success already settled; once compaction forgets its id, a replay of its run
// must not land it again.
function settledBySuccess(observations, input, at) {
	return generationFor(observations, input).value.attempts.some(
		(attempt) => attempt.code === SUCCESS_CODE && attempt.at >= at,
	);
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
			TRIAL_INCONCLUSIVE_CODE,
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
			const trial = input.leaseRevision !== undefined;
			if (
				!trial &&
				TRANSIENT_CODES.has(input.code) &&
				settledBySuccess(observations, input, at)
			)
				return {
					write: false,
					accepted: false,
					reason: "superseded-by-success",
				};
			if (
				trial &&
				(!exactClaim(control.claim, input) || !control.claim.started)
			)
				return {
					write: false,
					accepted: false,
					reason: "stale-or-unstarted-claim",
				};
			if (control.claim && !trial) {
				if (!claimReclaimable(control.claim, Date.now()))
					return { write: false, accepted: false, reason: "claim-active" };
				control.claim = null;
			}
			if (observations.seenAttemptIds.length >= COMPACT_AT)
				compactObservations(observations);
			// Only a trial may evict: it must resolve its claim. Other observations
			// keep the pre-existing refusal at capacity.
			if (observations.seenAttemptIds.length >= MAX_ATTEMPTS && trial)
				evictOldest(observations, COMPACT_AT - 1);
			if (observations.seenAttemptIds.length >= MAX_ATTEMPTS)
				return {
					write: false,
					accepted: false,
					reason: "observation-capacity",
				};
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

// The persisted event carries the sanitized diagnostic and exit evidence; the
// closed lifecycle itself was verified by the producer and is attested by the
// binding's `lifecycleVerified`. Re-check that the two agree.
function lifecycleBackedEventCode(event) {
	const diagnostic = event.providerReliability;
	if (
		!isProviderReliabilityDiagnostic(diagnostic) ||
		diagnostic.phase !== "provider" ||
		diagnostic.cancelled === true ||
		!TRANSIENT_CODES.has(diagnostic.causeCode) ||
		FAILURE_REGISTRY.get(diagnostic.causeCode)?.providerCaused !== true
	)
		return null;
	switch (diagnostic.causeCode) {
		case "provider_exit_nonzero":
			return diagnostic.exitCode !== 0 && event.exitCode === diagnostic.exitCode
				? diagnostic.causeCode
				: null;
		case "provider_signalled":
			return diagnostic.signal !== null && event.signal === diagnostic.signal
				? diagnostic.causeCode
				: null;
		case "provider_deadline_exceeded":
			return diagnostic.timedOut === true ? diagnostic.causeCode : null;
		default:
			return null;
	}
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
	const terminalEvent = ["task_failed", "provider_attempt_terminal"].includes(
		event.event,
	);
	let code;
	// Simple-direct dispatch cannot prove which model served a run, so success
	// is transport plus lifecycle; the queue's producer still demands the
	// served-model read-back before it will mint transportVerified.
	if (binding.transportVerified === true && binding.lifecycleVerified === true)
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
		terminalEvent &&
		binding.lifecycleVerified === true &&
		lifecycleBackedEventCode(event) !== null
	)
		code = lifecycleBackedEventCode(event);
	// A half-open trial must always resolve its claim; a failure that is not
	// provider-attributable (cancelled, group unconfirmed, not a transient
	// code) frees the target for another trial without counting against it.
	else if (
		binding.transportVerified === false &&
		terminalEvent &&
		binding.lifecycleVerified === true &&
		binding.claimRevision !== undefined
	)
		code = TRIAL_INCONCLUSIVE_CODE;
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

// A transient failure counts only when Switchyard's own supervisor observed it:
// the diagnostic is provider-caused and eligible for provider memory, and the
// closed lifecycle receipt agrees with it. No adapter diagnostic is needed.
function lifecycleBackedFailureCode(input) {
	const diagnostic = input?.providerReliability;
	const code = diagnostic?.causeCode;
	if (
		input.healthLane !== "simple-direct" ||
		!isProviderReliabilityDiagnostic(diagnostic) ||
		!TRANSIENT_CODES.has(code) ||
		FAILURE_REGISTRY.get(code)?.providerCaused !== true
	)
		return null;
	const provenance = {
		providerLifecycle: input.providerLifecycle,
		providerWriterLifecycle: input.providerWriterLifecycle,
	};
	if (
		!lifecycleBackedProviderFailure(
			diagnostic,
			provenance.providerLifecycle,
			provenance.providerWriterLifecycle,
		) ||
		!deriveFailureAccountability({
			providerReliability: diagnostic,
			provenance,
		}).providerMemoryEligible
	)
		return null;
	if (
		code === "provider_exit_nonzero" &&
		input.exitCode !== diagnostic.exitCode
	)
		return null;
	if (code === "provider_signalled" && input.signal !== diagnostic.signal)
		return null;
	return code;
}

// The group-settled writer lifecycle and the direct child's receipt both show
// nothing of the provider's tree is still running, whatever the outcome was.
function providerStopped(input) {
	const lifecycle = input?.providerLifecycle;
	return (
		input.healthLane === "simple-direct" &&
		lifecycle?.schemaVersion === 1 &&
		["stopped", "never_started"].includes(lifecycle.writerLifecycle) &&
		["stopped", "never_started"].includes(input.providerWriterLifecycle) &&
		lifecycle.cleanupStage === null &&
		["not_required", "succeeded"].includes(lifecycle.cleanupStatus) &&
		["exited", "terminated", "spawn_failed"].includes(lifecycle.terminalStatus)
	);
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
	const failureCode = lifecycleBackedFailureCode(input);
	const adapterFailure =
		input.providerExecutionSucceeded !== true &&
		hasAuthoritativeDiagnosticProvenance(input) &&
		(HOLD_CODES.has(input.diagnosticCode) || cooldownCode !== null);
	// A failed simple-direct trial that is not a countable failure still has to
	// resolve its claim, provided nothing of the provider is left running.
	const inconclusiveTrial =
		trial &&
		input.providerExecutionSucceeded !== true &&
		!adapterFailure &&
		failureCode === null &&
		providerStopped(input);
	const lifecycleVerified =
		lifecycleReceiptMatches(input.lifecycleReceipt, input) ||
		(["simple-direct", "queue-vm"].includes(input.healthLane) &&
			providerLifecycleClosed(input)) ||
		failureCode !== null ||
		inconclusiveTrial;
	if (trial && !lifecycleVerified) return null;
	let transportVerified = false;
	if (
		input.providerExecutionSucceeded === true &&
		// Simple-direct dispatch has no served-model read-back: a clean exit
		// whose whole writer group is stopped is its success evidence.
		(input.servedModelVerified === true ||
			(input.healthLane === "simple-direct" &&
				input.providerWriterLifecycle === "stopped"))
	) {
		transportVerified = true;
	} else if (
		input.providerExecutionSucceeded !== true &&
		(adapterFailure || failureCode !== null || inconclusiveTrial)
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
						if (replacement.seenAttemptIds.length >= COMPACT_AT)
							compactObservations(replacement);
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
