import { normalizeProviderName } from "../roster/index.mjs";
import { runsRoot } from "../run-store/constants.mjs";
import { SIMPLE_TARGET_ADAPTERS } from "./args.mjs";
import { observedP80 } from "./deadline-fit.mjs";
import { simpleProviderCompatibility } from "./provider-invocation.mjs";
import {
	createRouteEvidenceCapture,
	routeDiagnosticPatch,
} from "./route-evidence.mjs";
import { liveRouteExhaustion } from "./route-exhaustion.mjs";
import {
	createRefusalAccumulator,
	withRefusalEvidence,
} from "./routing-refusals.mjs";
import { deadlineFitBudgetMs, evaluateDeadlineFit } from "./task-sizing.mjs";

// Deadline-fit policy (shared with the pre-provider task-sizing refusal): a
// target whose observed p80 cannot finish inside the remaining budget (minus
// the acceptance-check reserve and a fixed margin) is excluded; if that would
// empty the pool the filter is overridden. A caller estimate is decisive and
// so is evaluated before any route call.

// The router's no_eligible* decline reasons (capability ceiling, upstream
// detail) stay in the route evidence; the failure itself carries the one closed
// reason. Any other reason is passed through unchanged.
const closedRouteError = (reason) =>
	reason == null || /^no_eligible(?:_|$)/u.test(reason)
		? "no_eligible_provider"
		: reason;

/** The existing local adapter and health selection pass, shared by start reroutes. */
export function createSimpleRouteSelection({
	options,
	resolveIdentity,
	descriptorFor,
	routeProvider,
	healthController,
	now,
	stateRoot,
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
	const checks = options.checks ?? [];
	// Decision 4: a caller estimate is target-independent, so an estimate that
	// cannot fit refuses before any route call — no target is selected, no
	// provider work starts and no routing attempt is counted.
	const explicitFitRefusal = () => {
		const evidence = evaluateDeadlineFit({
			estimateMinutes: options.estimateMinutes ?? null,
			p80Ms: null,
			deadlineMs: options.deadlineMs,
			nowMs: now(),
			checkCount: checks.length,
		});
		return evidence.fits === false ? evidence : null;
	};
	const compatibleSimpleTargets = [];
	const adapterEvidence = createRouteEvidenceCapture();
	const refusals = createRefusalAccumulator();
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
			refusals.add(candidateTargetId, compatibility.reason);
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
				const refused = explicitFitRefusal();
				if (refused)
					return {
						error: "task_estimate_exceeds_budget",
						deadlineFit: refused,
					};
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
	const deadlineFitEvidence = [];
	let deadlineFitApplied = false;
	const applyDeadlineFit = async () => {
		deadlineFitApplied = true;
		// A pinned --only-provider request is an explicit operator override.
		if ((options.onlyProviders ?? []).length) return;
		const budgetMs = deadlineFitBudgetMs({
			deadlineMs: options.deadlineMs,
			nowMs: now(),
			checkCount: checks.length,
		});
		if (budgetMs === null) return;
		const slowTargets = [];
		try {
			for (const candidate of compatibleSimpleTargets) {
				const p80Ms = await observedP80(candidate, options.projectPath, {
					runsRoot: runsRoot(),
				});
				if (p80Ms !== null && p80Ms > budgetMs) slowTargets.push(candidate);
			}
		} catch {
			// Observed history is advisory; never gate routing on a run-store
			// read failure.
			return;
		}
		if (slowTargets.length === 0) return;
		if (slowTargets.length === compatibleSimpleTargets.length) {
			// Excluding every target would empty the pool; keep them all.
			for (const targetId of slowTargets)
				deadlineFitEvidence.push({
					targetId,
					reason: "deadline_fit_overridden",
				});
			return;
		}
		for (const targetId of slowTargets) {
			excludedSimpleTargets.add(targetId);
			deadlineFitEvidence.push({
				targetId,
				reason: "deadline_fit_excluded",
			});
		}
	};
	const quotaExhaustionEvidence = [];
	let quotaExhaustionApplied = false;
	// A live quota-exhaustion marker outlives the Gradus snapshot this run
	// routes from; the marked target stays ineligible for its TTL hour.
	const applyQuotaExhaustion = () => {
		quotaExhaustionApplied = true;
		let live;
		try {
			live = liveRouteExhaustion({ stateRoot, now });
		} catch {
			// Exhaustion markers are advisory; never gate routing on a state
			// read failure.
			return;
		}
		const exhausted = new Set(live.map((entry) => entry.targetId));
		for (const candidate of compatibleSimpleTargets) {
			if (!exhausted.has(candidate)) continue;
			excludedSimpleTargets.add(candidate);
			quotaExhaustionEvidence.push({
				targetId: candidate,
				reason: "quota_exhausted",
			});
		}
	};
	const selectionEvidence = () => [
		...quotaExhaustionEvidence,
		...deadlineFitEvidence,
	];
	const withSelectionEvidence = (routed) => {
		for (const entry of selectionEvidence())
			refusals.add(entry.targetId, entry.reason, entry.bucket);
		for (const entry of routeDiagnosticPatch(routed).routeEvidence?.excluded ??
			[])
			refusals.add(entry.targetId, entry.reason, entry.bucket);
		return withRefusalEvidence(routed, refusals.entries());
	};
	const selectSimpleRoute = async () => {
		const refused = explicitFitRefusal();
		if (refused)
			return { error: "task_estimate_exceeds_budget", deadlineFit: refused };
		if (!quotaExhaustionApplied) applyQuotaExhaustion();
		if (!deadlineFitApplied) await applyDeadlineFit();
		while (excludedSimpleTargets.size < compatibleSimpleTargets.length) {
			const availableProviders = compatibleSimpleTargets.filter(
				(candidate) => !excludedSimpleTargets.has(candidate),
			);
			let routed = routeProvider({
				requiredCapability: options.capability,
				availableProviders,
				platform: "direct",
				nowMs: now(),
				hasInvocationDescriptor: (name, capability) =>
					Boolean(descriptorFor(name, capability)),
				modelForCapability: (name, capability) =>
					descriptorFor(name, capability)?.selector ?? null,
				...(options.origin === "qualification"
					? {}
					: { healthDecision: healthController.decision }),
				only: options.onlyProviders ?? [],
				exclude: [...excludedSimpleTargets],
				// Diagnostic only: refusals already known for this call, so the
				// routing run can persist the complete per-call record.
				refusals: [...refusals.entries(), ...selectionEvidence()],
			});
			routed = withSelectionEvidence(routed);
			await onDecision(routed);
			if (!routed?.provider) {
				const error = closedRouteError(routed?.reason);
				// Enforced route health can empty an otherwise eligible pool; name it
				// as the health block it is, not as a missing provider.
				const healthBlocked =
					error === "no_eligible_provider" &&
					routed?.routeEvidence?.excluded?.some(
						(entry) => entry?.reason === "route_health_suppressed",
					);
				return { error: healthBlocked ? "route_health_blocked" : error };
			}
			const candidateProvider = routed.provider;
			const reject = async (error) => {
				refusals.add(candidateProvider, error);
				await onDecision(
					withSelectionEvidence({ ...routed, provider: null, reason: error }),
				);
				return { error };
			};
			const candidateIdentity = resolveIdentity(candidateProvider);
			const candidateTargetId = candidateIdentity.targetId;
			if (!candidateTargetId || !candidateIdentity.harnessKey)
				return reject("target_identity_unavailable");
			const candidateDescriptor = descriptorFor(
				candidateProvider,
				options.capability,
			);
			if (
				!candidateDescriptor ||
				candidateDescriptor.target_id !== candidateTargetId
			)
				return reject("invocation_descriptor_unavailable");
			const candidateHarness = normalizeProviderName(
				candidateIdentity.harnessKey,
			);
			const compatibility = simpleProviderCompatibility({
				targetId: candidateTargetId,
				harness: candidateHarness,
				descriptor: candidateDescriptor,
				capability: options.capability,
			});
			if (!compatibility.compatible) return reject(compatibility.reason);
			try {
				funded(candidateTargetId);
			} catch (error) {
				if (
					["paid_overage_not_allowed", "included_usage_unverified"].includes(
						error?.code,
					)
				) {
					refusals.add(candidateTargetId, error.code);
					await onDecision(
						withSelectionEvidence({
							...routed,
							provider: null,
							reason: error.code,
						}),
					);
				}
				throw error;
			}
			const prepared = await healthController.prepare({
				provider: candidateProvider,
				targetId: candidateTargetId,
				capability: options.capability,
				descriptor: candidateDescriptor,
			});
			if (!prepared.allowed || prepared.reroute) {
				refusals.add(candidateTargetId, "route_health_suppressed");
				excludedSimpleTargets.add(candidateTargetId);
				await onDecision(
					withSelectionEvidence({
						...routed,
						provider: null,
						reason: "route_health_suppressed",
					}),
				);
				continue;
			}
			// Diagnostic provenance belongs to the selected cell only. History
			// remains advisory and preserves the existing routing policy.
			let p80Ms = null;
			if (options.estimateMinutes == null) {
				try {
					p80Ms = await observedP80(candidateTargetId, options.projectPath, {
						runsRoot: runsRoot(),
					});
				} catch {
					/* An unavailable history is unknown. */
				}
			}
			const deadlineFit = evaluateDeadlineFit({
				estimateMinutes: options.estimateMinutes,
				p80Ms,
				deadlineMs: options.deadlineMs,
				nowMs: now(),
				checkCount: checks.length,
			});
			return {
				deadlineFit,
				provider: candidateProvider,
				diagnostics: routeDiagnosticPatch(routed),
				targetId: candidateTargetId,
				descriptor: candidateDescriptor,
				harness: candidateHarness,
				compatibility,
				prepared,
			};
		}
		await onDecision(
			withSelectionEvidence({ provider: null, reason: "no_eligible" }),
		);
		return { error: "route_health_blocked" };
	};
	return { excludedSimpleTargets, selectSimpleRoute };
}
