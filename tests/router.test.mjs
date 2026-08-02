// INV-4 gate test: a task is dispatched only to a snapshot-available FUNDED
// provider, spreading load across funded providers, and every dispatch
// outcome carries a well-formed {provider, model, reason} triple a caller can
// record (INVARIANTS.md:29-33).
//
// Task 1.6c (roster-unification plan): migrated off hardcoded outcome
// literals this same gate used to assert directly against the frozen
// PROVIDER_CAPABILITIES table -- blind-fallback `provider === 'claude'`,
// `route({tier:'high'}).model === 'claude-opus-4-8'`,
// `route({tier:'standard'}).model === 'claude-sonnet-5'`, and a
// vibe-has-no-adapter exclusion -- onto the roster-backed router (Task
// 1.5/1.6). Uses the same committed fixture roster
// (tests/fixtures/roster.fixture.json) + SWITCHYARD_ROSTER_PATH +
// __resetRosterCacheForTests() pattern tests/router-rightsizing.test.mjs
// established for the INV-5 property.
//
// Division of labor with sibling gate/property tests (so this file doesn't
// re-assert what's already covered elsewhere): INV-5 model right-sizing and
// the capability filter itself are tests/capability-match.test.mjs's job (the
// INV-5 gate, INVARIANTS.md:37) and are exercised end-to-end through route()
// by tests/router-rightsizing.test.mjs. This file sticks to INV-4: funded-only
// dispatch, spread, and the recordable result shape.
//
// Claude target-key resolution (this task's other job): the roster's Claude
// target is keyed `claude-code` (see ~/.agent/roster.json and this file's own
// fixture below), with `harness: "claude"` / `usage_provider: "claude"`. The
// router and PROVIDER_CAPABILITIES/passesCapabilityFilter/getRightSizedModel
// all operate at the HARNESS grain ("claude") -- never the target-id grain
// ("claude-code"), which only surfaces in provenance
// (tests/provenance.test.mjs asserts resolved_target === "claude-code" for
// this identical fixture). Grepped both this repo and ~/.agent for
// "claude-pro": zero hits in either -- it never existed anywhere but the
// design brief's own "assumed, confirm during implementation" placeholder.
// Roster and test already agree on "claude" as the harness key; nothing to
// change.

import { notStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
} from "../src/switchyard/roster/index.mjs";
import { route, routeBlind } from "../src/switchyard/router/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

// Isolated per-process temp snapshot (see resolveSnapshotPath() in
// src/switchyard/router/index.mjs). This file and tests/runner.test.mjs both
// exercise the real snapshot loader, and `node --test` runs test files
// concurrently as separate processes -- both used to read/write/rm the SAME
// real on-disk SNAPSHOT_PATH (the host-side gradus snapshot), which raced.
// The suffix is unique per test run (not a fixed test-only name), so this
// file never collides with another isolated run either.
const SNAPSHOT_PATH = join(
	tmpdir(),
	`switchyard-router-test-${process.pid}-${randomUUID()}.json`,
);

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;

before(() => {
	process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = SNAPSHOT_PATH;
	process.env.SWITCHYARD_ROSTER_PATH = FIXTURE_PATH;
	__resetRosterCacheForTests();
});

after(() => {
	delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
	try {
		rmSync(SNAPSHOT_PATH, { force: true });
	} catch {
		// Ignore
	}
});

// Helper to create a test snapshot
function createTestSnapshot(providers) {
	writeFileSync(
		SNAPSHOT_PATH,
		JSON.stringify({
			schema_version: 2,
			providers,
		}),
		"utf8",
	);
}

describe("router (INV-4: dispatch only to a snapshot-available funded provider)", () => {
	it("routes to a funded provider when multiple are present (CR-2 regression)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 200 }],
			},
		]);

		const result = route();
		notStrictEqual(result.provider, null, "Should find a provider");
		strictEqual(result.reason, "spread", "Should use spread selection");
	});

	it("skips a provider below the exhaustion floor, still landing on the funded one", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 3, pace_delta: 100 }], // Below default floor of 5
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 200 }],
			},
		]);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"Should skip exhausted claude and pick funded codex",
		);
	});

	it("tolerates absent providers (CR-3)", () => {
		createTestSnapshot([
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
		]);

		const result = route();
		strictEqual(result.provider, "codex", "Should route to available provider");
	});

	it("returns no_eligible when the only present provider is below the exhaustion floor", () => {
		// Distinct from the "skips exhausted, lands on the other funded one"
		// test above: with only ONE provider present and it below floor, the
		// floor check is the ONLY thing standing between "dispatch nowhere"
		// and "dispatch to an unfunded provider" -- a bare INV-4 violation.
		// When another funded provider is present, spread naturally favors its
		// higher headroom regardless of the floor check, so that scenario
		// alone can't prove the floor is enforced; this one can.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 3, pace_delta: 100 }], // below default floor of 5
			},
		]);

		const result = route();
		strictEqual(
			result.provider,
			null,
			"an exhausted-only snapshot must not dispatch anywhere",
		);
		strictEqual(result.reason, "no_eligible");
	});

	it("returns no_eligible_capability_ceiling when the only candidate is below the tier's capability ceiling", () => {
		// Task D.3: distinguish the deterministic INV-5 ceiling case (every
		// candidate's technical_ceiling is below the task's required tier —
		// expected, not actionable) from the upstream-unavailable case below.
		// antigravity's fixture ceiling is standard, so at tier high the
		// capability filter rejects it and nothing else is present: the reason
		// must name the ceiling, not the generic no_eligible.
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }], // standard ceiling only
			},
		]);

		const result = route({ tier: "high" });
		strictEqual(result.provider, null);
		strictEqual(result.reason, "no_eligible_capability_ceiling");
	});

	it("returns no_eligible_upstream_unavailable with the first unavailable provider's error", () => {
		// Task D.3: a provider that WOULD be eligible (claude clears the high
		// capability filter) but is currently unreachable must surface as an
		// actionable upstream failure carrying the snapshot's (already
		// redacted) error string — not the generic no_eligible.
		createTestSnapshot([
			{
				name: "claude",
				ok: false,
				error: "token expired",
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
		]);

		const result = route({ tier: "high" });
		strictEqual(result.provider, null);
		strictEqual(
			result.reason,
			"no_eligible_upstream_unavailable: claude — token expired",
		);
	});

	it("never routes to vibe (a disabled, no-adapter roster target) even with the most headroom", () => {
		// vibe is `enabled: false` in the roster (no ZDR, no adapter) -- its
		// computed capability_class is null, so it fails the capability filter
		// at every tier, including the lowest. This is the INV-4-relevant half
		// of the old "vibe exclusion" test: a snapshot can report any headroom
		// it likes for a provider switchyard has no business dispatching to,
		// and that must never win the spread.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "vibe",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom, but disabled
			},
		]);

		const result = route({ tier: "low" });
		strictEqual(
			result.provider,
			"claude",
			"vibe is disabled in the roster and must never be selected, even at " +
				"the lowest tier and with the most headroom",
		);
	});

	it("never routes outside availableProviders, even when the excluded one has more headroom", () => {
		// Isolate the availableProviders restriction from capability filtering:
		// both claude and codex are fully capable here, so the ONLY reason
		// codex loses is that this dispatcher can't reach it.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom
			},
		]);

		const result = route({ tier: "low", availableProviders: ["claude"] });
		strictEqual(
			result.provider,
			"claude",
			"codex has more headroom and passes the capability filter, but this " +
				"dispatcher can only reach claude -- availableProviders must win",
		);
	});

	it("--exclude-provider still excludes when the live snapshot uses title-cased provider names (regression)", () => {
		// The real production snapshot (gradus/.state/snapshot-v2.json) stores
		// provider.name title-cased ("Claude", "Antigravity", ...), not the
		// lowercase harness key ("claude", "agy") documented for
		// --exclude-provider and used everywhere else in this file's fixtures.
		// route()'s exclude check used to do a raw `exclude.includes(name)`
		// with no normalization, so excluding "claude" silently failed to
		// match snapshot entry "Claude" and the exclusion was a no-op --
		// caught live 2026-07-31 when --exclude-provider claude/codex/cursor/
		// opencode/copilot left every task routing straight back to Claude.
		createTestSnapshot([
			{
				name: "Claude",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom
			},
			{
				name: "Codex",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
		]);

		const result = route({ tier: "low", exclude: ["claude"] });
		strictEqual(
			result.provider,
			"Codex",
			"excluding the lowercase harness key 'claude' must exclude the " +
				"title-cased snapshot entry 'Claude' -- case must not matter",
		);
	});

	it("--only-provider restricts routing to the allowlisted provider, even when a non-allowlisted one has more headroom (Task C.9)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom
			},
		]);

		const result = route({ tier: "low", only: ["claude"] });
		strictEqual(
			result.provider,
			"claude",
			"codex has more headroom, but --only-provider claude must restrict " +
				"routing to claude regardless",
		);
	});

	it("spreads to the provider with most headroom among funded candidates", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 70, pace_delta: 200 }],
			},
		]);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"Should pick provider with most headroom",
		);
	});

	it("pools Cursor auto and API buckets into one combined average headroom pool", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ percent_left: 4.66, pace_delta: -0.4 },
					{ percent_left: 81.82, pace_delta: 0.2 },
				],
			},
		]);

		const result = route({ tier: "standard" });
		strictEqual(result.provider, "cursor");
		strictEqual(Math.round(result.percentLeft), 43);
	});

	it("breaks percent_left ties with the scorer, not roster order (Task 11)", () => {
		// claude is FIRST in roster harness order, so an array-order tie-break
		// (winner seeded with scored[0]) would always pick claude on a headroom
		// tie. codex has the higher pace_delta, so the documented scorer
		// (0.9*normPace + 0.1*jitter) must pick codex instead -- proving
		// computeScore, not iteration order, decides the tie.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 1 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 999 }],
			},
		]);

		const result = route({ seed: 42 });
		strictEqual(result.percentLeft, 50, "tie is at the top headroom");
		strictEqual(
			result.provider,
			"codex",
			"scorer (higher pace) must break the tie, not roster order (claude first)",
		);
	});

	it("excludes a non-finite percent_left window rather than treating it as eligible (Task 13)", () => {
		// A snapshot CAN carry a non-finite percent_left: JSON.parse("1e999") is
		// Infinity (NaN can't survive a JSON round-trip, so it's unreachable
		// here; Number.isFinite guards both). typeof Infinity === "number" would
		// pass a naive filter, and `Infinity < floor` is false, so the provider
		// would evade the exhausted-skip and win with unbounded headroom -- an
		// INV-4 bypass. It must be excluded, leaving codex the only valid
		// provider. Written as raw JSON because JSON.stringify(Infinity) ===
		// "null".
		writeFileSync(
			SNAPSHOT_PATH,
			'{"schema_version":2,"providers":[' +
				'{"name":"claude","ok":true,"windows":[{"percent_left":1e999,"pace_delta":100}]},' +
				'{"name":"codex","ok":true,"windows":[{"percent_left":50,"pace_delta":200}]}' +
				"]}",
			"utf8",
		);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"claude's non-finite window must be excluded, leaving codex the winner",
		);
	});

	it("does not blow the call stack on an oversized windows array (Task 10)", () => {
		// A malformed/runaway usage-snapshot writer could emit tens of
		// thousands of windows for one provider. The old
		// `Math.min(...windows.map(...))` and `Math.min(...paces)` spreads
		// threw `RangeError: Maximum call stack size exceeded`; the
		// reduce-based min degrades gracefully instead. Each window carries a
		// finite pace_delta so the paces reduce is exercised too, not just the
		// percent_left reduce.
		const bigWindows = Array.from({ length: 200000 }, () => ({
			percent_left: 50,
			pace_delta: 100,
		}));
		createTestSnapshot([{ name: "claude", ok: true, windows: bigWindows }]);

		const result = route();
		strictEqual(
			result.provider,
			"claude",
			"oversized windows must route, not crash the router",
		);
		strictEqual(result.percentLeft, 50, "min headroom computed via reduce");
	});
});

describe("router (INV-4: blind fallback still respects funding/eligibility)", () => {
	it("handles a missing snapshot gracefully, picking the first capability-eligible roster harness", () => {
		// A missing/broken snapshot must not silently halt every task behind
		// it -- route() wires the blind fallback into the real path. The
		// expected winner is derived here from the SAME roster-backed exports
		// route() itself uses (PROVIDER_CAPABILITIES + passesCapabilityFilter),
		// not a hardcoded provider name -- so this test tracks the roster's
		// actual declared order/eligibility instead of asserting a literal
		// that only happens to match today's fixture.
		try {
			rmSync(SNAPSHOT_PATH);
		} catch {
			// Ignore
		}

		const result = route();
		strictEqual(result.reason, "blind_fallback");

		const expectedOrder = Object.keys(PROVIDER_CAPABILITIES).filter((name) =>
			passesCapabilityFilter(name, "high"),
		);
		ok(
			expectedOrder.length > 0,
			"fixture must have at least one high-capable harness for this test to mean anything",
		);
		strictEqual(
			result.provider,
			expectedOrder[0],
			"blind fallback must pick the first capability-eligible roster harness, " +
				"in the roster's own declared order",
		);
	});

	it("restricts blind-mode candidates to the caller's availableProviders", () => {
		try {
			rmSync(SNAPSHOT_PATH);
		} catch {
			// Ignore
		}

		const result = route({ availableProviders: ["codex"] });
		strictEqual(result.reason, "blind_fallback");
		strictEqual(result.provider, "codex");
	});

	it("blind fallback (unit-level) falls back to the first non-excluded candidate", () => {
		const result = routeBlind(["claude", "codex"], ["claude"]);
		strictEqual(
			result.provider,
			"codex",
			"Should fall back to first non-excluded",
		);
	});

	it("routeBlind excludes case-insensitively too (regression, mirrors the route() fix above)", () => {
		const result = routeBlind(["Claude", "Codex"], ["claude"]);
		strictEqual(
			result.provider,
			"Codex",
			"excluding lowercase 'claude' must exclude candidate 'Claude'",
		);
	});
});

describe("router (INV-4: every dispatch outcome records provider + model + result)", () => {
	it("a spread-selected route carries a non-null model alongside the provider", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
		]);

		const result = route({ tier: "high" });
		strictEqual(result.provider, "claude");
		strictEqual(result.reason, "spread");
		notStrictEqual(
			result.model,
			null,
			"a successful dispatch must carry a model for the ledger to record",
		);
	});

	it("a blind-fallback route also carries a non-null model", () => {
		try {
			rmSync(SNAPSHOT_PATH);
		} catch {
			// Ignore
		}

		const result = route({ tier: "high" });
		strictEqual(result.reason, "blind_fallback");
		notStrictEqual(result.provider, null);
		notStrictEqual(
			result.model,
			null,
			"blind fallback must still right-size a model for recording",
		);
	});

	it("a no-eligible-provider outcome still returns a well-formed {provider:null, model:null, reason} triple", () => {
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }], // standard ceiling only
			},
		]);

		const result = route({ tier: "high" });
		strictEqual(result.provider, null);
		strictEqual(result.model, null);
		// The single candidate fails only the INV-5 capability filter, so the
		// triple's reason is the distinguishable ceiling classification (Task
		// D.3), not the generic no_eligible.
		strictEqual(result.reason, "no_eligible_capability_ceiling");
	});
});

describe("router (Task 2.2: low-tier lane economics & eligibility under INV-4 spread)", () => {
	it("low-tier tasks are eligible for qualified low-cost lanes (opencode) and INV-4 spread selects opencode when it has most headroom", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 40, pace_delta: 100 }],
			},
			{
				name: "opencode",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }],
			},
		]);

		const result = route({ tier: "low" });
		strictEqual(
			result.provider,
			"opencode",
			"opencode is eligible for low-tier tasks and has most headroom",
		);
		strictEqual(
			result.model,
			"fixture/opencode-low",
			"model is right-sized to opencode's low selector",
		);
		strictEqual(result.percentLeft, 90);
		strictEqual(result.reason, "spread");
	});

	it("INV-4 spread governs selection among eligible lanes — higher-headroom provider wins over low-cost lane (cost never overrides spread)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 100 }],
			},
			{
				name: "opencode",
				ok: true,
				windows: [{ percent_left: 40, pace_delta: 50 }],
			},
		]);

		const result = route({ tier: "low" });
		strictEqual(
			result.provider,
			"claude",
			"claude has more headroom (90% > 40%) so INV-4 spread selects it; cost does not override spread",
		);
		strictEqual(result.model, "fixture-claude-low");
		strictEqual(result.percentLeft, 90);
	});

	it("high-tier eligibility stays Claude + Codex only regardless of low-tier provider headroom", () => {
		createTestSnapshot([
			{
				name: "opencode",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 10 }],
			},
			{
				name: "agy",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 10 }],
			},
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 60, pace_delta: 100 }],
			},
		]);

		const result = route({ tier: "high" });
		strictEqual(
			result.provider,
			"codex",
			"high-tier task excludes opencode and agy; selects codex with highest headroom among Claude+Codex",
		);
		strictEqual(result.model, "fixture-codex-high");
		strictEqual(result.percentLeft, 60);
	});

	it("INV-4 spread algorithm itself is unchanged (regression check: most headroom selection given same availability)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 75, pace_delta: 50 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 85, pace_delta: 50 }],
			},
			{
				name: "opencode",
				ok: true,
				windows: [{ percent_left: 65, pace_delta: 50 }],
			},
		]);

		const result = route({ tier: "low" });
		strictEqual(
			result.provider,
			"codex",
			"spread picks highest percent_left among all low-eligible providers",
		);
		strictEqual(result.percentLeft, 85);
		strictEqual(result.reason, "spread");
	});
});
