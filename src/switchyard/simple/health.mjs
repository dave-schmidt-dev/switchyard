import {
	getInvocationDescriptorIdentity,
	resolveTargetIdentity,
	validateInvocationDescriptor,
} from "../roster/index.mjs";
import {
	acquireHalfOpenClaim,
	createDefaultRouteHealthDecision,
	createRouteHealthTerminalBinding,
	ingestRouteHealthEvents,
	releaseHalfOpenClaim,
	startHalfOpenClaim,
} from "../router/health.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../router/index.mjs";
import { createRouteHealthEvent, getRunRoot } from "../run-store/index.mjs";

const SIMPLE_ROUTE_HEALTH_LANE = "simple-direct";
export const SIMPLE_ROUTE_HEALTH_EPOCH = "switchyard-simple-direct-v1";

function configuredMode(value) {
	return value === "enforce" ? "enforce" : "shadow";
}

function envValue(value, name) {
	return value ?? process.env[name];
}

function validatedRepairEpoch(state) {
	if (Number.isSafeInteger(state?.repairEpoch) && state.repairEpoch >= 0)
		return state.repairEpoch;
	return state?.initializable === true ? 0 : null;
}

function claimFields(binding) {
	return {
		targetId: binding.targetId,
		descriptorIdentity: binding.descriptorIdentity,
		publicConfigurationEpoch: binding.publicConfigurationEpoch,
		repairEpoch: binding.repairEpoch,
		runId: binding.runId,
		taskId: binding.taskId,
		attempt: binding.attempt,
		healthStateRoot: binding.healthStateRoot,
	};
}

function invocationAttempt(sequence) {
	// Health attempts identify provider invocations, not the enclosing task.
	// This permits a correction to settle independently while the durable task
	// receipt retains its existing attempt identity.
	return `provider-${sequence}`;
}

function diagnosticFields(providerResult) {
	return {
		...(typeof providerResult?.diagnosticCode === "string"
			? { diagnosticCode: providerResult.diagnosticCode }
			: {}),
		...(typeof providerResult?.diagnosticOrigin === "string"
			? { diagnosticOrigin: providerResult.diagnosticOrigin }
			: {}),
		...(typeof providerResult?.diagnosticEvidenceAvailable === "boolean"
			? {
					diagnosticEvidenceAvailable:
						providerResult.diagnosticEvidenceAvailable,
				}
			: {}),
		...(Number.isSafeInteger(providerResult?.code)
			? { exitCode: providerResult.code }
			: {}),
		...(typeof providerResult?.signal === "string"
			? { signal: providerResult.signal }
			: {}),
		...(providerResult?.diagnosticOrigin === "adapter" &&
		providerResult?.diagnosticEvidenceAvailable === true
			? { failurePhase: "provider_execution" }
			: {}),
	};
}

export function createSimpleRouteHealthController(options = {}) {
	const mode = configuredMode(
		envValue(options.healthMode, "SWITCHYARD_ROUTE_HEALTH_MODE"),
	);
	const healthStateRoot = envValue(
		options.healthStateRoot,
		"SWITCHYARD_ROUTE_HEALTH_STATE_ROOT",
	);
	const decision =
		options.healthDecision ??
		createDefaultRouteHealthDecision({
			healthStateRoot,
			mode,
			qualifiedProviders:
				options.qualifiedProviders ?? GOLDEN_IMAGE_VERIFIED_PROVIDERS,
			// Keep local observations in a distinct public configuration epoch.
			goldenImageReference: SIMPLE_ROUTE_HEALTH_EPOCH,
			...(typeof options.now === "function" ? { now: options.now } : {}),
		});
	let sequence = 0;
	let invocation = null;

	function current(candidate) {
		try {
			return decision(candidate);
		} catch {
			return { available: false, mode: decision.mode ?? mode, suppress: false };
		}
	}

	function resolveSelected({ provider, targetId, capability, descriptor }) {
		if (
			typeof decision?.identityFor !== "function" ||
			typeof provider !== "string" ||
			typeof targetId !== "string" ||
			descriptor?.target_id !== targetId ||
			typeof descriptor?.descriptor_identity !== "string" ||
			typeof options.runId !== "string" ||
			typeof options.taskId !== "string"
		)
			return null;
		const identity = decision.identityFor({
			provider: targetId,
			requiredCapability: capability,
		});
		if (
			identity?.targetId !== targetId ||
			identity.descriptorIdentity !== descriptor.descriptor_identity ||
			identity.publicConfigurationEpoch !== decision.publicConfigurationEpoch
		)
			return null;
		let descriptorHarness = null;
		try {
			descriptorHarness = resolveTargetIdentity(targetId)?.harnessKey ?? null;
		} catch {}
		if (!descriptorHarness) return null;
		let verifiedDescriptor;
		try {
			verifiedDescriptor = validateInvocationDescriptor(
				descriptor,
				descriptorHarness,
			);
		} catch {
			return null;
		}
		const descriptorIdentity = getInvocationDescriptorIdentity(
			verifiedDescriptor,
			descriptorHarness,
		);
		if (
			descriptorIdentity !== descriptor.descriptor_identity ||
			descriptorIdentity !== identity.descriptorIdentity
		)
			return null;
		return {
			...identity,
			provider,
			capability,
			descriptor: structuredClone(verifiedDescriptor),
			descriptorHarness,
			runId: options.runId,
			taskId: options.taskId,
			attempt: invocationAttempt(sequence),
			healthStateRoot,
			mode: decision.mode ?? mode,
		};
	}

	async function releaseUnstarted(previous) {
		if (!previous?.lease || previous.started || previous.settled) return;
		await releaseHalfOpenClaim({
			...claimFields(previous.binding),
			...previous.lease,
			leaseToken: previous.lease.token,
			leaseRevision: previous.lease.revision,
			provenNeverStarted: true,
		});
		previous.settled = true;
	}

	async function prepare(input) {
		if (
			invocation?.started &&
			!invocation.settled &&
			invocation.lease &&
			invocation.binding.mode === "enforce"
		)
			return {
				allowed: false,
				reroute: true,
				reason: "provider-invocation-unsettled",
			};
		await releaseUnstarted(invocation);
		sequence += 1;
		const binding = resolveSelected(input);
		invocation = binding
			? { binding, started: false, settled: false, lease: null }
			: null;
		if (!binding) return { allowed: true, tracked: false };
		const state = current({
			provider: binding.targetId,
			requiredCapability: binding.capability,
		});
		binding.repairEpoch = validatedRepairEpoch(state);
		if (binding.repairEpoch === null) {
			invocation = null;
			return {
				allowed: true,
				tracked: false,
				reason: "health-state-unavailable",
			};
		}
		if ((state.mode ?? binding.mode) === "enforce" && state.suppress === true)
			return { allowed: false, reroute: true, reason: "route-health-blocked" };
		return {
			allowed: true,
			tracked: true,
			attempt: binding.attempt,
			state: state.state ?? null,
		};
	}

	async function start() {
		if (!invocation?.binding) return { allowed: true, tracked: false };
		if (invocation.started || invocation.settled)
			return {
				allowed: false,
				reroute: true,
				reason: "provider-invocation-reused",
			};
		const binding = invocation.binding;
		const state = current({
			provider: binding.targetId,
			requiredCapability: binding.capability,
		});
		const repairEpoch = validatedRepairEpoch(state);
		binding.repairEpoch = repairEpoch;
		if ((state.mode ?? binding.mode) === "enforce" && state.suppress === true)
			return { allowed: false, reroute: true, reason: "route-health-changed" };
		if (repairEpoch === null) {
			invocation = null;
			if (binding.mode === "enforce" && state.trialAvailable === true)
				return {
					allowed: false,
					reroute: true,
					tracked: false,
					reason: "health-state-unavailable",
				};
			return {
				allowed: true,
				tracked: false,
				reason: "health-state-unavailable",
			};
		}
		if (binding.mode === "enforce" && state.trialAvailable === true) {
			const claimInput = {
				...claimFields(binding),
				repairEpoch,
				nowMs: typeof options.now === "function" ? options.now() : Date.now(),
			};
			const claimed = await acquireHalfOpenClaim(claimInput);
			if (claimed.claimed !== true)
				return {
					allowed: false,
					reroute: true,
					reason: claimed.reason ?? "half-open-claim-unavailable",
				};
			invocation.lease = claimed.lease;
			const claim = {
				...claimInput,
				...claimed.lease,
				leaseToken: claimed.lease.token,
				leaseRevision: claimed.lease.revision,
			};
			const result = await startHalfOpenClaim(claim);
			if (result.started !== true) {
				await releaseUnstarted(invocation);
				return {
					allowed: false,
					reroute: true,
					reason: result.reason ?? "half-open-start-unavailable",
				};
			}
		}
		// This call is the invocation fence, immediately before provider launch.
		invocation.started = true;
		return {
			allowed: true,
			tracked: Number.isSafeInteger(binding.repairEpoch),
			attempt: binding.attempt,
			trial: Boolean(invocation.lease),
		};
	}

	async function terminal({
		providerResult = null,
		providerReliability = null,
		providerLifecycle = null,
	} = {}) {
		const currentInvocation = invocation;
		if (!currentInvocation?.binding)
			return { settled: false, reason: "untracked-invocation", binding: null };
		if (currentInvocation.terminalResult)
			return currentInvocation.terminalResult;
		const binding = currentInvocation.binding;
		if (!Number.isSafeInteger(binding.repairEpoch)) {
			currentInvocation.terminalResult = {
				settled: !currentInvocation.lease,
				reason: "health-state-unavailable",
				binding: null,
			};
			return currentInvocation.terminalResult;
		}
		if (!currentInvocation.started) {
			await releaseUnstarted(currentInvocation);
			currentInvocation.terminalResult = {
				settled: !currentInvocation.lease,
				reason: "provider-not-started",
				binding: null,
			};
			return currentInvocation.terminalResult;
		}
		const terminalBinding = createRouteHealthTerminalBinding({
			...binding,
			invocationDescriptor: binding.descriptor,
			descriptorHarness: binding.descriptorHarness,
			providerReliability,
			providerLifecycle,
			healthLane: SIMPLE_ROUTE_HEALTH_LANE,
			providerExecutionSucceeded: providerResult?.success === true,
			servedModelVerified: providerResult?.servedModelVerified === true,
			...diagnosticFields(providerResult),
			...(currentInvocation.lease
				? {
						claimRevision: currentInvocation.lease.revision,
						leaseToken: currentInvocation.lease.token,
					}
				: {}),
		});
		if (!terminalBinding) {
			currentInvocation.terminalResult = {
				settled: !currentInvocation.lease,
				reason: "provider-terminal-unverified",
				binding: null,
			};
			return currentInvocation.terminalResult;
		}
		const event = {
			phase: "execution",
			event: "provider_attempt_terminal",
			status: providerResult?.success === true ? "completed" : "failed",
			taskId: binding.taskId,
			attempt: binding.attempt,
			provider: binding.provider,
			model: binding.descriptor.selector,
			resolvedTargetId: binding.targetId,
			descriptorHarness: binding.descriptorHarness,
			descriptorIdentity: binding.descriptorIdentity,
			invocationDescriptor: binding.descriptor,
			servedModelVerified: providerResult?.servedModelVerified === true,
			...(providerReliability ? { providerReliability } : {}),
			...diagnosticFields(providerResult),
		};
		try {
			await (options.createRouteHealthEvent ?? createRouteHealthEvent)(
				binding.runId,
				event,
				terminalBinding,
			);
			const results = await (
				options.ingestRouteHealthEvents ?? ingestRouteHealthEvents
			)({
				authorisedRuns: [
					{ runId: binding.runId, runRoot: getRunRoot(binding.runId) },
				],
				healthStateRoot,
				onStatus: options.onStatus,
			});
			const observed =
				Array.isArray(results) &&
				results.some(
					(result) =>
						result?.runId === binding.runId &&
						result?.taskId === binding.taskId &&
						result?.attempt === binding.attempt &&
						result?.targetId === binding.targetId &&
						result?.descriptorIdentity === binding.descriptorIdentity &&
						result?.publicConfigurationEpoch ===
							binding.publicConfigurationEpoch &&
						result?.repairEpoch === binding.repairEpoch &&
						(result.accepted === true || result.reason === "duplicate-attempt"),
				);
			const settled = observed || !currentInvocation.lease;
			currentInvocation.settled = settled;
			currentInvocation.terminalResult = {
				settled,
				reason: settled ? null : "provider-health-observation-unavailable",
				binding: terminalBinding,
			};
		} catch {
			currentInvocation.terminalResult = {
				settled: !currentInvocation.lease,
				reason: "provider-health-observation-unavailable",
				binding: terminalBinding,
			};
		}
		return currentInvocation.terminalResult;
	}

	return Object.freeze({ decision, prepare, start, terminal });
}
