import { normalizeProviderName } from "../roster/index.mjs";
import { SIMPLE_TARGET_ADAPTERS } from "./args.mjs";
import { simpleProviderCompatibility } from "./provider-invocation.mjs";
import {
	createRouteEvidenceCapture,
	routeDiagnosticPatch,
} from "./route-evidence.mjs";

/** The existing local adapter and health selection pass, shared by start reroutes. */
export function createSimpleRouteSelection({
	options,
	resolveIdentity,
	descriptorFor,
	routeProvider,
	healthController,
	now,
	funded,
	onDecision,
}) {
	const requestedSimpleTargets = (options.onlyProviders ?? []).length
		? options.onlyProviders
		: SIMPLE_TARGET_ADAPTERS.filter(
				(adapter) =>
					adapter.defaultEligible !== false &&
					(!adapter.defaultCapabilities ||
						adapter.defaultCapabilities.includes(options.capability)),
			).map((adapter) => adapter.targetId);
	const compatibleSimpleTargets = [];
	const adapterEvidence = createRouteEvidenceCapture();
	let pinnedIncompatibility = null;
	for (const candidate of requestedSimpleTargets) {
		const candidateIdentity = resolveIdentity(candidate);
		const candidateTargetId = candidateIdentity.targetId;
		const candidateHarness = candidateIdentity.harnessKey
			? normalizeProviderName(candidateIdentity.harnessKey)
			: null;
		const candidateDescriptor = candidateTargetId
			? descriptorFor(candidateTargetId, options.capability)
			: null;
		const compatibility = simpleProviderCompatibility({
			targetId: candidateTargetId,
			harness: candidateHarness,
			descriptor: candidateDescriptor,
			capability: options.capability,
		});
		if (compatibility.compatible) {
			compatibleSimpleTargets.push(candidateTargetId);
		} else {
			adapterEvidence.exclude(candidateTargetId, compatibility.reason);
			if ((options.onlyProviders ?? []).length)
				pinnedIncompatibility = compatibility.reason;
		}
	}
	if (compatibleSimpleTargets.length === 0) {
		const error = (options.onlyProviders ?? []).length
			? (pinnedIncompatibility ?? "local_adapter_unavailable")
			: "route_health_blocked";
		return {
			excludedSimpleTargets: new Set(),
			selectSimpleRoute: async () => {
				await onDecision(
					adapterEvidence.finish({
						provider: null,
						reason: pinnedIncompatibility ?? "no_compatible_adapter",
					}),
				);
				return { error };
			},
		};
	}
	const excludedSimpleTargets = new Set();
	const selectSimpleRoute = async () => {
		while (excludedSimpleTargets.size < compatibleSimpleTargets.length) {
			const availableProviders = compatibleSimpleTargets.filter(
				(candidate) => !excludedSimpleTargets.has(candidate),
			);
			const routed = routeProvider({
				requiredCapability: options.capability,
				availableProviders,
				platform: "direct",
				nowMs: now(),
				hasInvocationDescriptor: (name, capability) =>
					Boolean(descriptorFor(name, capability)),
				modelForCapability: (name, capability) =>
					descriptorFor(name, capability)?.selector ?? null,
				healthDecision: healthController.decision,
				only: options.onlyProviders ?? [],
				exclude: [...excludedSimpleTargets],
			});
			await onDecision(routed);
			if (!routed?.provider)
				return {
					error: routed?.reason ?? "no_eligible_provider",
				};
			const candidateProvider = routed.provider;
			const candidateIdentity = resolveIdentity(candidateProvider);
			const candidateTargetId = candidateIdentity.targetId;
			if (!candidateTargetId || !candidateIdentity.harnessKey)
				return { error: "target_identity_unavailable" };
			const candidateDescriptor = descriptorFor(
				candidateProvider,
				options.capability,
			);
			if (
				!candidateDescriptor ||
				candidateDescriptor.target_id !== candidateTargetId
			)
				return { error: "invocation_descriptor_unavailable" };
			const candidateHarness = normalizeProviderName(
				candidateIdentity.harnessKey,
			);
			const compatibility = simpleProviderCompatibility({
				targetId: candidateTargetId,
				harness: candidateHarness,
				descriptor: candidateDescriptor,
				capability: options.capability,
			});
			if (!compatibility.compatible) return { error: compatibility.reason };
			funded(candidateTargetId);
			const prepared = await healthController.prepare({
				provider: candidateProvider,
				targetId: candidateTargetId,
				capability: options.capability,
				descriptor: candidateDescriptor,
			});
			if (!prepared.allowed || prepared.reroute) {
				excludedSimpleTargets.add(candidateTargetId);
				continue;
			}
			return {
				provider: candidateProvider,
				diagnostics: routeDiagnosticPatch(routed),
				targetId: candidateTargetId,
				descriptor: candidateDescriptor,
				harness: candidateHarness,
				compatibility,
				prepared,
			};
		}
		return { error: "route_health_blocked" };
	};
	return { excludedSimpleTargets, selectSimpleRoute };
}
