import { resolveTargetIdentity } from "../../src/switchyard/roster/index.mjs";
import { routeDiagnosticPatch } from "../../src/switchyard/simple/route-evidence.mjs";
import { createSimpleRouteSelection } from "../../src/switchyard/simple/route-selection.mjs";

/**
 * Engine stand-in for routing-waterfall tests: it runs the real
 * route-selection pass over the waterfall's route seam, then hands the
 * selected target to the shared stub engine, which allocates and closes the
 * attempt. The shared fixture's stub engine skips route-selection.mjs, which
 * is where the selector's evidence is merged.
 *
 * @param {object} f A `fixture()` from simple-routing-fixture.mjs.
 * @param {(targetId: string, capability: string) => object|null} descriptorFor
 */
export function realSelectionEngine(f, descriptorFor) {
	const inner = f.deps.runSimpleTask;
	return async (opts, context) => {
		let diagnostics = {};
		const { selectSimpleRoute } = createSimpleRouteSelection({
			options: opts,
			resolveIdentity: resolveTargetIdentity,
			descriptorFor,
			routeProvider: context.route,
			healthController: { prepare: async () => ({ allowed: true }) },
			now: context.now,
			stateRoot: f.deps.stateRoot,
			funded: context.assertFundedRoute ?? (() => {}),
			onDecision: async (routed) => {
				diagnostics = routeDiagnosticPatch(routed);
			},
		});
		const selected = await selectSimpleRoute();
		if (selected.error)
			return {
				status: "failed",
				failurePhase: "route",
				failureReason: selected.error,
				partialWorktree: null,
				...diagnostics,
			};
		const result = await inner(opts, {
			...context,
			route: () => ({
				provider: selected.provider,
				resolvedTargetId: selected.targetId,
			}),
		});
		return Object.assign(result, diagnostics);
	};
}
