// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";

// Refusals resolve target IDs through the roster; pin the committed fixture
// so the outcome never depends on the owner's live roster.
process.env.SWITCHYARD_ROSTER_PATH = fileURLToPath(
	new URL("./fixtures/roster.fixture.json", import.meta.url),
);
__resetRosterCacheForTests();

const TARGETS = ["antigravity", "codex"];

// Like the real selector (router/eligibility.mjs), report every target that
// is missing from availableProviders as adapter_unavailable.
function selectorWithEvidence({ availableProviders }) {
	const provider = availableProviders[0] ?? null;
	const reason = provider ? "priority_fill" : "no_eligible";
	return {
		provider,
		reason,
		routeEvidence: {
			schemaVersion: 1,
			selectionReason: reason,
			selectedTargetId: provider,
			candidates: [],
			excluded: TARGETS.filter((id) => !availableProviders.includes(id)).map(
				(targetId) => ({ targetId, reason: "adapter_unavailable" }),
			),
		},
	};
}

function fundingRefused() {
	throw Object.assign(new Error("paid overage not allowed"), {
		code: "paid_overage_not_allowed",
	});
}

function reasonsFor(result, targetId) {
	return result.routeEvidence.excluded
		.filter((entry) => entry.targetId === targetId)
		.map((entry) => entry.reason);
}

// Regression (stability audit O10, 2026-10-18): the selector reported the
// targets routing-run had removed for funding as adapter_unavailable, so the
// persisted evidence named a cause that never happened. Funding-only
// exhaustion still falls back to native as capacity.
test("a funding-only exhaustion records only the funding refusals and falls back to native", async () => {
	const f = fixture({ __targets: TARGETS });
	f.deps.route = selectorWithEvidence;
	f.deps.assertFundedRoute = fundingRefused;
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "capacity");
	strictEqual(result.stopReason, undefined);
	deepStrictEqual(f.calls, []);
	for (const targetId of TARGETS)
		deepStrictEqual(reasonsFor(result, targetId), ["paid_overage_not_allowed"]);
});

test("a target the caller never offered keeps its adapter_unavailable entry", async () => {
	const f = fixture({ __targets: ["antigravity"] });
	f.deps.route = selectorWithEvidence;
	f.deps.assertFundedRoute = fundingRefused;
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "capacity");
	deepStrictEqual(reasonsFor(result, "antigravity"), [
		"paid_overage_not_allowed",
	]);
	deepStrictEqual(reasonsFor(result, "codex"), ["adapter_unavailable"]);
});
