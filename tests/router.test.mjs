// INV-4 gate test: a task is dispatched only to a snapshot-available FUNDED
// provider, spreading load across funded providers, and every dispatch
// outcome carries a well-formed {provider, model, reason} triple a caller can
// record (INVARIANTS.md:29-33).
//
// Task 1.6c (roster-unification plan): migrated off hardcoded outcome
// literals this same gate used to assert directly against the frozen
// PROVIDER_CAPABILITIES table -- blind-fallback `provider === 'claude'`,
// `route({requiredCapability:'high'}).model === 'claude-opus-4-8'`,
// `route({requiredCapability:'standard'}).model === 'claude-sonnet-5'`, and a
// fixture-only disabled-Vibe exclusion -- onto the roster-backed router (Task
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

import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
	resolveTargetIdentity,
} from "../src/switchyard/roster/index.mjs";
import {
	preflightMacosQueue,
	route,
	routeBlind,
} from "../src/switchyard/router/index.mjs";
import {
	createQueueBackend,
	executeTaskAsync,
	normalizeRunOptions,
	runQueue,
	runQueueAsync,
	runQueueWithOrchestrator,
} from "../src/switchyard/runner/index.mjs";

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
const ROUTER_ROSTER_PATH = join(
	tmpdir(),
	`switchyard-router-roster-${process.pid}-${randomUUID()}.json`,
);

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;

function withDispatchQualifiedDescriptors(roster) {
	const testedAt = new Date().toISOString();
	for (const [targetId, target] of Object.entries(roster.targets)) {
		if (!target.enabled) continue;
		for (const slots of Object.values(target.slots ?? {})) {
			for (const slot of slots ?? []) {
				if (slot.manual_only) continue;
				const model = roster.models[slot.model_ref];
				if (model?.status !== "active") continue;
				const descriptor = {
					target_id: targetId,
					model_ref: slot.model_ref,
					selector: model.selector,
					effort: slot.effort ?? null,
					variant: slot.variant ?? null,
					invocation_args: slot.invocation_args ?? [],
				};
				const descriptorIdentity = getInvocationDescriptorIdentity(
					descriptor,
					target.harness,
				);
				target.qualifications ??= {};
				target.qualifications[descriptorIdentity] = {
					...descriptor,
					descriptor_identity: descriptorIdentity,
					status: "dispatch_qualified",
					tested_at: testedAt,
					credential_profile: target.credential_profile,
				};
			}
		}
	}
	return roster;
}

// Two ENABLED codex-harness targets, which is what makes `resolveTargetIdentity`
// fall through to its harness tie-break and report `ambiguous: true`. Shared by
// the Task 6.2 disambiguation lock and the case-variant identifier test at the
// bottom of this file; both need the same two-target shape, and duplicating it
// would let one copy drift while the other kept passing.
function buildDualCodexRoster({ incumbentSnapshotName }) {
	const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
	if (incumbentSnapshotName) {
		roster.targets.codex.snapshot_name = incumbentSnapshotName;
	}
	roster.models["fixture/codex-spark-low"] = {
		selector: "fixture-codex-spark-low",
		base_model: "fixture-codex-spark-low",
		model_provider: "fixture",
		status: "active",
	};
	roster.targets["codex-spark"] = {
		harness: "codex",
		snapshot_name: "Codex (Spark)",
		enabled: true,
		technical_ceiling: "low",
		// Selector-keyed `qualified` and descriptor-identity-keyed
		// `dispatch_qualified` are two DIFFERENT records: the first is what
		// autoRoutingCeiling() reads to give the target a capability_class,
		// the second is the routing descriptor gate that
		// withDispatchQualifiedDescriptors() adds below. Omitting this one
		// leaves the target ineligible ("below required capability low"), and
		// each caller's control assertion is what catches that.
		qualifications: {
			"fixture-codex-spark-low": { status: "qualified" },
		},
		slots: {
			low: [{ model_ref: "fixture/codex-spark-low", priority: 1 }],
			standard: [],
			high: [],
		},
	};
	return withDispatchQualifiedDescriptors(roster);
}

before(() => {
	process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = SNAPSHOT_PATH;
	writeFileSync(
		ROUTER_ROSTER_PATH,
		JSON.stringify(
			withDispatchQualifiedDescriptors(
				JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
			),
		),
		"utf8",
	);
	process.env.SWITCHYARD_ROSTER_PATH = ROUTER_ROSTER_PATH;
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
		rmSync(ROUTER_ROSTER_PATH, { force: true });
	} catch {
		// Ignore
	}
});

// Helper to create a test snapshot
function createTestSnapshot(providers, updatedAt = new Date().toISOString()) {
	writeFileSync(
		SNAPSHOT_PATH,
		JSON.stringify({
			schema_version: 2,
			updated_at: updatedAt,
			providers,
		}),
		"utf8",
	);
}

function removeSnapshot() {
	rmSync(SNAPSHOT_PATH, { force: true });
}

describe("router (INV-4: dispatch only to a snapshot-available funded provider)", () => {
	it("excludes an enabled Vibe implementation target until its exact descriptor is dispatch-qualified", () => {
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-vibe-opencode-${process.pid}-${randomUUID()}.json`,
		);
		const roster = withDispatchQualifiedDescriptors(
			JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
		);
		roster.targets.vibe = {
			harness: "opencode",
			snapshot_name: "Vibe",
			credential_profile: "default",
			enabled: true,
			technical_ceiling: "low",
			qualifications: {
				"fixture/opencode-low": { status: "qualified" },
			},
			slots: {
				low: [{ model_ref: "fixture/opencode-low", priority: 1 }],
				standard: [],
				high: [],
			},
		};
		writeFileSync(rosterPath, JSON.stringify(roster), "utf8");
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
		__resetRosterCacheForTests();
		try {
			createTestSnapshot([
				{
					name: "Vibe",
					ok: true,
					windows: [{ percent_left: 90, pace_delta: 50 }],
				},
			]);
			const result = route({
				requiredCapability: "low",
				availableProviders: ["opencode"],
			});
			strictEqual(result.provider, null);
			strictEqual(result.reason, "no_eligible");
			ok(
				result.log.some((entry) =>
					entry.includes("Vibe: no current exact invocation descriptor"),
				),
				"selector-only Vibe must not become an automatic OpenCode route",
			);

			const explicit = route({
				requiredCapability: "low",
				availableProviders: ["opencode"],
				only: ["vibe"],
			});
			strictEqual(explicit.provider, null);
			strictEqual(explicit.reason, "no_eligible");
		} finally {
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});

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

	it("uses standard capability when RequiredCapability is omitted", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
		]);

		const result = route();
		strictEqual(result.requiredCapability, "standard");
		strictEqual(result.provider, "claude");
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

	it("returns no_eligible_capability_ceiling when the only candidate is below the required capability ceiling", () => {
		// Task D.3: distinguish the deterministic INV-5 ceiling case (every
		// candidate's technical_ceiling is below the task's required capability —
		// expected, not actionable) from the upstream-unavailable case below.
		// antigravity fixture's ceiling is standard, so at required capability high the
		// capability filter rejects it and nothing else is present: the reason
		// must name the ceiling, not the generic no_eligible.
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }], // standard ceiling only
			},
		]);

		const result = route({ requiredCapability: "high" });
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

		const result = route({ requiredCapability: "high" });
		strictEqual(result.provider, null);
		strictEqual(
			result.reason,
			"no_eligible_upstream_unavailable: claude — token expired",
		);
	});

	it("skips a fixture-disabled Vibe target even with the most headroom", () => {
		// This fixture isolates disabled-target handling. Production Vibe is an
		// enabled OpenCode-backed implementation target; its separate exact-
		// descriptor gate is covered above.
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

		const result = route({ requiredCapability: "low" });
		strictEqual(
			result.provider,
			"claude",
			"fixture-disabled Vibe must never be selected, even at " +
				"the lowest required capability and with the most headroom",
		);
	});

	it("--only-provider cannot force a fixture-disabled Vibe target into the candidate set", () => {
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
			{
				name: "vibe",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
		]);

		for (const only of ["vibe"]) {
			const result = route({ requiredCapability: "standard", only: [only] });
			strictEqual(result.provider, null);
			strictEqual(result.reason, "no_eligible");
		}
	});

	it("rejects disabled Gemini target id while accepting enabled Agy Claude", () => {
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-agy-target-${process.pid}-${randomUUID()}.json`,
		);
		const roster = withDispatchQualifiedDescriptors(
			JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
		);
		roster.targets.antigravity.enabled = false;
		roster.targets["antigravity-claude"] = {
			harness: "agy",
			enabled: true,
			slots: {
				low: [],
				standard: [{ model_ref: "fixture/agy-standard", priority: 1 }],
				high: [],
			},
			qualifications: {
				"fixture-agy-standard": { status: "qualified" },
			},
		};
		withDispatchQualifiedDescriptors(roster);
		writeFileSync(rosterPath, JSON.stringify(roster), "utf8");
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
		__resetRosterCacheForTests();
		try {
			createTestSnapshot([
				{
					name: "agy",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 10 }],
				},
			]);
			strictEqual(route({ only: ["antigravity"] }).provider, null);
			strictEqual(route({ only: ["agy"] }).provider, "agy");
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});

	// Task 6.2 (gradus codex-spark-bucket plan): the incumbent `codex` target and
	// the new `codex-spark` target share the `codex` harness and are BOTH enabled,
	// so `resolveTargetIdentity` can no longer fall through to its harness
	// tie-break -- that path returns `ambiguous: true` for two enabled targets, and
	// providerMatches() turns any ambiguity into `false`. The incumbent's
	// `snapshot_name: "Codex"` is what keeps `--only-provider codex` matching it.
	//
	// This drives the REAL providerMatches through route({only}) rather than
	// asserting on resolveTargetIdentity directly, and it builds both targets
	// enabled from the fixture, so it cannot pass vacuously if a target is later
	// disabled in the live roster. The second half re-runs the identical route
	// against a roster with `snapshot_name` deleted and asserts it stops matching
	// -- without that leg the first assertion alone would still pass on a roster
	// where the regression had returned.
	it("keeps --only-provider codex on the incumbent target when a second codex-harness target is enabled (Task 6.2)", () => {
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-codex-spark-${process.pid}-${randomUUID()}.json`,
		);
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		const routeOnlyCodex = (roster) => {
			writeFileSync(rosterPath, JSON.stringify(roster), "utf8");
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			// Spark deliberately holds the most headroom: if the identifier matched
			// both targets, INV-4's most-headroom spread would hand the route to
			// Spark, so "Codex" below is a positive result and not a tie default.
			createTestSnapshot([
				{
					name: "Codex",
					ok: true,
					windows: [{ percent_left: 40, pace_delta: 0 }],
				},
				{
					name: "Codex (Spark)",
					ok: true,
					windows: [{ percent_left: 95, pace_delta: 0 }],
				},
			]);
			return {
				onlyCodex: route({ requiredCapability: "low", only: ["codex"] }),
				unfiltered: route({ requiredCapability: "low" }),
			};
		};
		try {
			const withSnapshotName = routeOnlyCodex(
				buildDualCodexRoster({ incumbentSnapshotName: "Codex" }),
			);
			// Control: Spark IS eligible and IS the most-headroom lane here, so the
			// filtered assertion below is doing real work. Without this the test
			// would still pass if Spark were quietly ineligible (no descriptor,
			// capability filtered out), proving nothing about disambiguation.
			strictEqual(withSnapshotName.unfiltered.provider, "Codex (Spark)");
			strictEqual(withSnapshotName.onlyCodex.provider, "Codex");
			strictEqual(
				routeOnlyCodex(buildDualCodexRoster({ incumbentSnapshotName: null }))
					.onlyCodex.provider,
				null,
			);
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
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

		const result = route({
			requiredCapability: "low",
			availableProviders: ["claude"],
		});
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

		const result = route({ requiredCapability: "low", exclude: ["claude"] });
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

		const result = route({ requiredCapability: "low", only: ["claude"] });
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

	it("no longer pools Cursor's ac/ap windows — ac alone drives the (ranked) result even though ap has more headroom", () => {
		// implementor-priority-waterfall-routing plan: Cursor's ac (1st-party,
		// rank 3, 0% floor) and ap (API, last-resort) windows are matched by
		// `w.id`, never pooled/averaged. ac is well above its 0% floor here, so
		// cursor-pro's ranked candidate wins on ac's own headroom (4.66%) —
		// nothing close to the old pooled ~43% average.
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 4.66, pace_delta: -0.4 },
					{ id: "ap", percent_left: 81.82, pace_delta: 0.2 },
				],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "cursor");
		strictEqual(result.percentLeft, 4.66);
		strictEqual(result.reason, "priority_fill");
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

describe("Task 4.3 timeout boundaries", () => {
	it("records Docker timeout capture failure only after capture resolves", async () => {
		const order = [];
		const dispatches = [];
		const descriptor = {
			target_id: "claude-code",
			model_ref: "fixture/claude-standard",
			selector: "fixture/claude-standard",
			invocation_args: [],
		};
		const result = await executeTaskAsync(
			{
				id: "4.3-docker",
				title: "timeout",
				description: "timeout",
				requiredPaths: null,
			},
			{
				route: () => ({
					provider: "claude",
					resolved_harness: "claude",
					resolvedTargetId: "claude-code",
					model: descriptor.selector,
					invocationDescriptor: descriptor,
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: (entry) => {
					order.push(`record:${entry.result}`);
					dispatches.push(entry);
				},
				recordDispatchIntent: () => {},
				integrationGate: () => {
					throw new Error("timeout capture failure must not reach the gate");
				},
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: false,
							timedOut: true,
							error: "provider execution timed out (ETIMEDOUT)",
						}),
						captureDiffAsync: async () => {
							order.push("capture");
							return null;
						},
					},
				},
				workingContainerName: "docker-worker",
				projectPath: process.cwd(),
			},
		);

		strictEqual(result.result, "execution_timed_out_capture_failed");
		strictEqual(result.success, false);
		strictEqual(result.timedOut, true);
		strictEqual(result.errorKind, "diff_capture_failed");
		strictEqual(result.partialDiff, undefined);
		strictEqual(dispatches[0].result, "execution_timed_out_capture_failed");
		strictEqual(
			order.join("|"),
			"capture|record:execution_timed_out_capture_failed",
		);
	});

	it("kills the recorded guest tree before clearing index.lock and retains the VM", () => {
		const calls = [];
		const statuses = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				if (args.includes("/bin/cat")) return "4321\n";
				return "ok";
			},
		});

		const cleanup = backend.cleanupProviderProcess(
			"prlctl",
			["exec", "vm-timeout"],
			{ onStatus: (event) => statuses.push(event.event) },
		);
		strictEqual(cleanup.pid, 4321);
		strictEqual(
			calls.findIndex((args) => args.includes("/project/.git/index.lock")) >
				calls.findIndex((args) => args.includes("switchyard-kill-tree")),
			true,
		);
		ok(
			calls
				.find((args) => args.includes("switchyard-kill-tree"))
				.join(" ")
				.includes("signal_tree TERM") &&
				!calls
					.find((args) => args.includes("switchyard-kill-tree"))
					.join(" ")
					.includes("kill -1"),
		);
		ok(!calls.some((args) => args.includes("destroy")));
		strictEqual(statuses.at(-1), "provider_cleanup_complete");
	});

	it("does not clear index.lock when guest tree cleanup is unconfirmed", () => {
		const calls = [];
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			prlctlFn: (args) => {
				calls.push(args);
				if (args.includes("/bin/cat")) return "4321\n";
				if (args.includes("switchyard-kill-tree")) {
					throw new Error("guest provider survived cleanup");
				}
				return "ok";
			},
		});

		throws(
			() => backend.cleanupProviderProcess("prlctl", ["exec", "vm-timeout"]),
			/guest provider survived cleanup/,
		);
		ok(!calls.some((args) => args.includes("/project/.git/index.lock")));
	});
});

describe("Task 6.1 queue-level platform selection", () => {
	it("normalizes docker by default and rejects an invalid platform", () => {
		strictEqual(normalizeRunOptions({}).platform, "docker");
		throws(() => normalizeRunOptions({ platform: "windows" }), /platform/);
	});

	it("selects one macOS backend before workspace creation for every queue entrypoint", async () => {
		const root = join(
			tmpdir(),
			`switchyard-platform-${process.pid}-${randomUUID()}`,
		);
		const tasksFilePath = join(root, "tasks.md");
		const calls = [];
		const backendFactory = ({ platform }) => {
			strictEqual(platform, "macos");
			return {
				platform,
				create: () => {
					calls.push("create-vm");
					return "vm-handle";
				},
				provision: () => calls.push("provision-vm"),
				seed: () => calls.push("seed-vm"),
				commit: () => calls.push("commit-vm"),
				reset: () => calls.push("reset-vm"),
				destroy: () => calls.push("destroy-vm"),
			};
		};
		mkdirSync(root, { recursive: true });
		writeFileSync(
			tasksFilePath,
			"### Task 1.1: Already complete\n- **Status:** done\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** fixture\n",
			"utf8",
		);
		const base = {
			tasksFilePath,
			projectPath: process.cwd(),
			checkpointPath: join(root, "checkpoint.json"),
			platform: "macos",
			dependencies: {
				backendFactory,
				orchestrator: { launch: async () => ({ jobId: "unused" }) },
			},
		};
		try {
			await runQueueAsync(base);
			runQueue(base);
			await runQueueWithOrchestrator(base);
			strictEqual(calls.filter((call) => call === "create-vm").length, 3);
			strictEqual(calls.filter((call) => call === "destroy-vm").length, 3);
			ok(!calls.some((call) => call.includes("docker")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the injected queue helper synchronous and exposes later queue gates", () => {
		const events = [];
		const helper = createQueueBackend({
			platform: "macos",
			dependencies: {
				backendFactory: () => ({
					create: () => "vm",
					seed: () => {},
					commit: () => {},
					reset: () => {},
					destroy: () => {},
					preflight: () => events.push("preflight"),
					acquireSlot: () => events.push("acquire"),
					releaseSlot: () => events.push("release"),
				}),
			},
		});
		strictEqual(helper.platform, "macos");
		strictEqual(typeof helper.preflight, "function");
		strictEqual(typeof helper.acquireSlot, "function");
		strictEqual(typeof helper.releaseSlot, "function");
		deepStrictEqual(events, []);
	});

	it("wires the default macOS preflight into the queue backend", () => {
		const helper = createQueueBackend({
			platform: "macos",
			dependencies: {
				tarProvisionRegistry: { verified: true, providers: ["opencode"] },
				preflightReadSnapshot: () => ({
					snapshot: {
						schema_version: 2,
						updated_at: new Date().toISOString(),
						providers: [
							{
								name: "codex",
								ok: true,
								windows: [{ percent_left: 80, pace_delta: 1 }],
							},
						],
					},
					snapshotStatus: "fresh",
					snapshotMtime: 1,
					snapshotAgeMsAtRoute: 0,
				}),
			},
		});

		throws(
			() =>
				helper.preflight({
					tasks: [{ status: "pending", requiredCapability: "high" }],
				}),
			/high: no_tar_provisionable_provider_with_quota_headroom.*codex/,
		);
	});
});

describe("Task 6.3 macOS provider-eligibility preflight", () => {
	function snapshotFor(...providers) {
		return {
			schema_version: 2,
			updated_at: new Date().toISOString(),
			providers,
		};
	}

	function freshSnapshotReader(snapshot, calls) {
		return () => {
			calls.push("snapshot");
			return {
				snapshot,
				snapshotStatus: "fresh",
				snapshotMtime: 1,
				snapshotAgeMsAtRoute: 0,
			};
		};
	}

	it("reads one snapshot for all tiers and counts blocked tasks as non-terminal", () => {
		const reads = [];
		const result = preflightMacosQueue({
			tasks: [
				{
					id: "pending-standard",
					status: "pending",
					requiredCapability: "standard",
				},
				{ id: "blocked-high", status: "blocked", requiredCapability: "high" },
				{ id: "done-high", status: "done", requiredCapability: "high" },
			],
			tarProvisionManifest: { verified: true, providers: ["codex"] },
			readSnapshot: freshSnapshotReader(
				snapshotFor({
					name: "codex",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 1 }],
				}),
				reads,
			),
		});

		strictEqual(reads.length, 1);
		deepStrictEqual(result.checkedCapabilities, ["standard", "high"]);
		strictEqual(result.eligible, true);
		deepStrictEqual(result.rejections, []);
	});

	it("rejects an unsatisfiable blocked tier with its capability and excluded provider", () => {
		const result = preflightMacosQueue({
			tasks: [
				{ id: "blocked-high", status: "blocked", requiredCapability: "high" },
			],
			tarProvisionRegistry: { verified: true, providers: ["opencode"] },
			readSnapshot: freshSnapshotReader(
				snapshotFor({
					name: "OpenCode Go",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 1 }],
				}),
				[],
			),
		});

		strictEqual(result.eligible, false);
		deepStrictEqual(result.rejection, {
			capability: "high",
			excludedProviders: ["OpenCode Go"],
			reason: "no_tar_provisionable_provider_with_quota_headroom",
		});
		strictEqual(
			result.capabilityResults[0].excludedReasons["OpenCode Go"],
			"below_required_capability",
		);
	});

	it("rejects one unsatisfiable tier even when another tier is eligible", () => {
		const reads = [];
		const result = preflightMacosQueue({
			tasks: [
				{
					id: "pending-standard",
					status: "pending",
					requiredCapability: "standard",
				},
				{ id: "pending-high", status: "pending", requiredCapability: "high" },
			],
			tarProvisionRegistry: { verified: true, providers: ["agy"] },
			readSnapshot: freshSnapshotReader(
				snapshotFor({
					name: "agy",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 1 }],
				}),
				reads,
			),
		});

		strictEqual(reads.length, 1);
		deepStrictEqual(result.checkedCapabilities, ["standard", "high"]);
		strictEqual(result.eligible, false);
		strictEqual(result.capabilityResults[0].eligible, true);
		strictEqual(result.capabilityResults[1].eligible, false);
		deepStrictEqual(result.rejections, [
			{
				capability: "high",
				excludedProviders: ["agy"],
				reason: "no_tar_provisionable_provider_with_quota_headroom",
			},
		]);
	});

	it("fails closed for an absent or unverified tar manifest and respects only/exclude and adapters", () => {
		const calls = [];
		const result = preflightMacosQueue({
			tasks: [
				{ id: "standard", status: "pending", requiredCapability: "standard" },
			],
			only: ["codex"],
			exclude: ["claude"],
			availableProviders: ["claude"],
			readSnapshot: freshSnapshotReader(
				snapshotFor(
					{
						name: "codex",
						ok: true,
						windows: [{ percent_left: 80, pace_delta: 1 }],
					},
					{
						name: "claude",
						ok: true,
						windows: [{ percent_left: 80, pace_delta: 1 }],
					},
				),
				calls,
			),
		});

		strictEqual(calls.length, 1);
		strictEqual(result.eligible, false);
		strictEqual(result.rejection.capability, "standard");
		deepStrictEqual(result.rejection.excludedProviders, ["codex", "claude"]);
		strictEqual(result.rejection.reason, "tar_provisionability_unverified");
	});

	it("leaves Docker as an explicit no-op without reading the snapshot", () => {
		let reads = 0;
		const result = preflightMacosQueue({
			platform: "docker",
			tasks: [{ status: "pending", requiredCapability: "high" }],
			readSnapshot: () => {
				reads += 1;
				throw new Error("Docker preflight must not read the macOS snapshot");
			},
		});

		strictEqual(reads, 0);
		strictEqual(result.eligible, true);
		strictEqual(result.reason, "docker_unchanged");
	});

	it("allows a terminal-only macOS queue without snapshot or manifest evidence", () => {
		const result = preflightMacosQueue({
			tasks: [{ status: "done", requiredCapability: "high" }],
			readSnapshot: () => {
				throw new Error("terminal-only queues must not read routing state");
			},
		});

		strictEqual(result.eligible, true);
		strictEqual(result.reason, "no_non_terminal_tasks");
	});

	it("refuses an ambiguous provider selector on the same terms route() does", () => {
		// The queue-level go/no-go has to agree with the dispatches it admits.
		// route() refuses an ambiguous selector with `ambiguous_target`; before
		// the preflight guard existed, the same selector fell through to the
		// per-capability loop here and came back as a per-provider
		// `not_in_only_allowlist` -- preflight reporting "no eligible provider
		// for this tier" for a queue route() would refuse to route at all.
		//
		// "CODEX" is ambiguous for the same reason as in the route() test at the
		// bottom of this file: it matches no exact target id (case-sensitive) and
		// the harness tie-break sees two enabled codex targets.
		const rosterPath = join(
			tmpdir(),
			`switchyard-preflight-ambiguous-${process.pid}-${randomUUID()}.json`,
		);
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		const tasks = [
			{ id: "pending-low", status: "pending", requiredCapability: "low" },
		];
		const tarProvisionRegistry = {
			verified: true,
			providers: ["codex", "codex-spark"],
		};
		try {
			writeFileSync(
				rosterPath,
				JSON.stringify(
					buildDualCodexRoster({ incumbentSnapshotName: "Codex" }),
				),
				"utf8",
			);
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			const snapshot = snapshotFor(
				{ name: "Codex", ok: true, windows: [{ percent_left: 40 }] },
				{ name: "Codex (Spark)", ok: true, windows: [{ percent_left: 95 }] },
			);

			// Control: the exact target id resolves, so an unambiguous selector
			// over this same roster and snapshot passes preflight. Without this, a
			// false `eligible` below could be an ineligible fixture rather than
			// the guard.
			const exact = preflightMacosQueue({
				tasks,
				only: ["codex"],
				tarProvisionRegistry,
				readSnapshot: freshSnapshotReader(snapshot, []),
			});
			strictEqual(exact.eligible, true);

			// The guard sits above the snapshot read and above the task scan, so
			// an ambiguous selector is refused without touching routing state.
			const throwingReader = () => {
				throw new Error("an ambiguous selector must not read routing state");
			};
			const ambiguous = preflightMacosQueue({
				tasks,
				only: ["CODEX"],
				tarProvisionRegistry,
				readSnapshot: throwingReader,
			});
			strictEqual(ambiguous.ok, false);
			strictEqual(ambiguous.eligible, false);
			strictEqual(ambiguous.reason, "ambiguous_target");
			strictEqual(ambiguous.rejection.selector, "CODEX");
			strictEqual(ambiguous.rejection.capability, null);
			ok(
				ambiguous.log.some((line) => line.includes("use an exact target id")),
				`expected an actionable hint, got: ${JSON.stringify(ambiguous.log)}`,
			);

			// ...and route() agrees, which is the property the guard exists for.
			strictEqual(
				route({ requiredCapability: "low", only: ["CODEX"] }).reason,
				"ambiguous_target",
			);

			// An exclude-side selector is refused identically: route() pools both
			// lists into one ambiguity check and so must this.
			strictEqual(
				preflightMacosQueue({
					tasks,
					exclude: ["CODEX"],
					tarProvisionRegistry,
					readSnapshot: throwingReader,
				}).reason,
				"ambiguous_target",
			);

			// Placement assertion: a queue with nothing left to run still fails
			// closed. Below the task scan the guard would never run here, and
			// preflight would return `no_non_terminal_tasks` for a selector that
			// cannot be routed -- the last case where the two could disagree.
			const terminalOnly = preflightMacosQueue({
				tasks: [{ id: "done-low", status: "done", requiredCapability: "low" }],
				only: ["CODEX"],
				tarProvisionRegistry,
				readSnapshot: throwingReader,
			});
			strictEqual(terminalOnly.ok, false);
			strictEqual(terminalOnly.reason, "ambiguous_target");
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});

	it("does not gate native or human tasks on provider eligibility", () => {
		const result = preflightMacosQueue({
			tasks: [
				{ status: "pending", executor: "native", requiredCapability: "high" },
				{
					status: "blocked",
					executor: "human",
					requiredCapability: "standard",
				},
			],
			readSnapshot: () => {
				throw new Error("non-switchyard tasks must not read routing state");
			},
		});

		strictEqual(result.eligible, true);
		strictEqual(result.reason, "no_non_terminal_tasks");
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

	it("routeBlind skips fixture-disabled Vibe even when explicitly ordered", () => {
		const result = routeBlind(["vibe", "claude"]);
		strictEqual(result.provider, "claude");
		strictEqual(result.reason, "blind_fallback");
	});
});

describe("router route-time snapshot diagnostics", () => {
	it("reports a missing snapshot from the same route read", () => {
		removeSnapshot();
		const result = route({ requiredCapability: "standard" });
		strictEqual(result.snapshotStatus, "missing");
		strictEqual(result.snapshotMtime, null);
		strictEqual(result.snapshotAgeMsAtRoute, null);
	});

	it("reports malformed JSON and malformed timestamps without throwing", () => {
		writeFileSync(SNAPSHOT_PATH, "{not-json", "utf8");
		strictEqual(route().snapshotStatus, "malformed");

		writeFileSync(
			SNAPSHOT_PATH,
			JSON.stringify({ schema_version: 2, providers: [] }),
			"utf8",
		);
		strictEqual(route().snapshotStatus, "malformed");
	});

	it("reports stale and future producer timestamps with age at route", () => {
		const nowMs = Date.parse("2026-08-04T16:00:00.000Z");
		const providers = [
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 80, pace_delta: 0 }],
			},
		];

		createTestSnapshot(
			providers,
			new Date(nowMs - 5 * 60 * 1000).toISOString(),
		);
		const stale = route({ nowMs });
		strictEqual(stale.snapshotStatus, "stale");
		strictEqual(stale.snapshotAgeMsAtRoute, 5 * 60 * 1000);
		ok(Number.isFinite(stale.snapshotMtime));

		createTestSnapshot(providers, new Date(nowMs + 1_000).toISOString());
		const future = route({ nowMs });
		strictEqual(future.snapshotStatus, "future");
		strictEqual(future.snapshotAgeMsAtRoute, -1_000);
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

		const result = route({ requiredCapability: "high" });
		strictEqual(result.provider, "claude");
		strictEqual(result.reason, "spread");
		strictEqual(result.requiredCapability, "high");
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

		const result = route({ requiredCapability: "high" });
		strictEqual(result.reason, "blind_fallback");
		strictEqual(result.requiredCapability, "high");
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

		const result = route({ requiredCapability: "high" });
		strictEqual(result.provider, null);
		strictEqual(result.model, null);
		strictEqual(result.requiredCapability, "high");
		// The single candidate fails only the INV-5 capability filter, so the
		// triple's reason is the distinguishable ceiling classification (Task
		// D.3), not the generic no_eligible.
		strictEqual(result.reason, "no_eligible_capability_ceiling");
	});
});

describe("router (Task 2.2: low-capability lane economics & eligibility under INV-4 spread)", () => {
	it("low-capability tasks are eligible for qualified low-cost lanes (opencode) and INV-4 spread selects opencode when it has most headroom", () => {
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

		const result = route({ requiredCapability: "low" });
		strictEqual(
			result.provider,
			"opencode",
			"opencode is eligible for low-capability tasks and has most headroom",
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

		const result = route({ requiredCapability: "low" });
		strictEqual(
			result.provider,
			"claude",
			"claude has more headroom (90% > 40%) so INV-4 spread selects it; cost does not override spread",
		);
		strictEqual(result.model, "fixture-claude-low");
		strictEqual(result.percentLeft, 90);
	});

	it("high-capability eligibility stays Claude + Codex only regardless of low-capability provider headroom", () => {
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

		const result = route({ requiredCapability: "high" });
		strictEqual(
			result.provider,
			"codex",
			"high-capability task excludes opencode and agy; selects codex with highest headroom among Claude+Codex",
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

		const result = route({ requiredCapability: "low" });
		strictEqual(
			result.provider,
			"codex",
			"spread picks highest percent_left among all low-eligible providers",
		);
		strictEqual(result.percentLeft, 85);
		strictEqual(result.reason, "spread");
	});
});

describe("router (implementor-priority waterfall routing)", () => {
	// Fixture ranks: antigravity (agy) = 1, copilot-student (copilot) = 2,
	// cursor-pro (cursor, ac window only) = 3. claude/codex/opencode carry no
	// implementor_priority and stay in the unranked spread pool.

	it("a ranked provider is chosen over a higher-headroom unranked one", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 0 }],
			},
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 20, pace_delta: 0 }],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			"antigravity",
			"ranked pool wins over unranked pool regardless of relative headroom",
		);
		strictEqual(result.reason, "priority_fill");
	});

	it("waterfall order is strictly honored across multiple ranked providers regardless of relative headroom", () => {
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 1, pace_delta: 0 }],
			},
			{
				name: "copilot",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			"antigravity",
			"priority 1 wins over priority 2 even with far less headroom left — a true waterfall, not a headroom comparison",
		);
		strictEqual(result.reason, "priority_fill");
	});

	it("a ranked provider drains to exactly 0% (not the 5% DEFAULT_FLOOR) before falling through", () => {
		// Below the unranked DEFAULT_FLOOR (5%) but still above the ranked 0%
		// floor: must still be picked — proves the hardcoded 0% floor
		// override, not just a lower default.
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 1, pace_delta: 0 }],
			},
		]);
		let result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "antigravity");
		strictEqual(result.reason, "priority_fill");

		// At exactly 0%, the ranked provider must fall through instead.
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 0, pace_delta: 0 }],
			},
		]);
		result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			null,
			"a ranked provider at exactly 0% must be excluded, not treated as still-eligible",
		);
	});

	it("Cursor's ac window alone drives ranked eligibility (matched by window id, not array position)", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ap", percent_left: 99, pace_delta: 0 },
					{ id: "ac", percent_left: 10, pace_delta: 0 },
				],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "cursor");
		strictEqual(
			result.percentLeft,
			10,
			"eligibility and headroom must come from the ac window (matched by id), not array position or the ap window",
		);
		strictEqual(result.reason, "priority_fill");
	});

	it("Cursor's ap window is NOT picked as long as any unranked provider still has headroom, even with ac exhausted", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 0, pace_delta: 0 },
					{ id: "ap", percent_left: 50, pace_delta: 0 },
				],
			},
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 10, pace_delta: 0 }],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			"claude",
			"an unranked provider with headroom must win over Cursor's ap last-resort bucket",
		);
		strictEqual(result.reason, "spread");
	});

	it("Cursor's ap window IS picked once ac is exhausted AND every unranked provider is also exhausted", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 0, pace_delta: 0 },
					{ id: "ap", percent_left: 50, pace_delta: 0 },
				],
			},
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 2, pace_delta: 0 }], // below the 5% DEFAULT_FLOOR
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "cursor");
		strictEqual(result.percentLeft, 50);
		strictEqual(result.reason, "last_resort_fallback");
	});

	it("Cursor's ap window still respects its own DEFAULT_FLOOR (5%) exhaustion check", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 0, pace_delta: 0 },
					{ id: "ap", percent_left: 3, pace_delta: 0 }, // below 5%
				],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			null,
			"ap below its own 5% floor must not be picked even as a last resort",
		);
	});

	it("two same-priority ranked providers (the two Antigravity buckets) tie-break via the scorer", () => {
		// Dedicated fixture (not the shared dual-agy one, which asserts
		// headroom-based winner flips that a priority tie-break would break):
		// both agy-harness targets carry implementor_priority: 1, so the tie
		// is decided by priority equality, then the SAME scorer mechanism
		// (0.9*normPace + 0.1*jitter) equal-percentLeft ties use elsewhere.
		// The two buckets are given DELIBERATELY UNEQUAL headroom (90% vs
		// 40%) to prove headroom plays no role in a same-rank tie: the
		// ranked-pool tie set is built from priority equality alone, so both
		// still enter the tie-break despite the headroom gap, and the
		// LOWER-headroom/higher-pace bucket wins — showing this is not
		// secretly the ordinary headroom-spread path in disguise. With two
		// candidates and distinct finite paces, the one at normPace===1 (max
		// pace) always outscores the one at normPace===0 regardless of
		// jitter, so the higher-pace bucket deterministically wins even
		// though it holds less headroom.
		const tiebreakFixturePath = resolve(
			__dirname,
			"fixtures",
			"roster.priority-tiebreak.fixture.json",
		);
		const qualifiedTiebreakFixturePath = join(
			tmpdir(),
			`switchyard-router-priority-tiebreak-${process.pid}-${randomUUID()}.json`,
		);
		const savedRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		writeFileSync(
			qualifiedTiebreakFixturePath,
			JSON.stringify(
				withDispatchQualifiedDescriptors(
					JSON.parse(readFileSync(tiebreakFixturePath, "utf8")),
				),
			),
			"utf8",
		);
		process.env.SWITCHYARD_ROSTER_PATH = qualifiedTiebreakFixturePath;
		__resetRosterCacheForTests();
		try {
			createTestSnapshot([
				{
					name: "Antigravity",
					ok: true,
					windows: [{ percent_left: 90, pace_delta: 1 }],
				},
				{
					name: "Antigravity (Claude)",
					ok: true,
					windows: [{ percent_left: 40, pace_delta: 999 }],
				},
			]);

			const result = route({ requiredCapability: "standard" });
			strictEqual(
				result.provider,
				"Antigravity (Claude)",
				"both buckets tie at priority 1 — the scorer's higher-pace candidate must win even though it holds LESS headroom (90% vs 40%), proving headroom is not compared within a same-rank tie",
			);
			strictEqual(result.reason, "priority_fill");
		} finally {
			if (savedRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = savedRosterPath;
			}
			__resetRosterCacheForTests();
			rmSync(qualifiedTiebreakFixturePath, { force: true });
		}
	});
});

// providerMatches()'s last line -- the `normalizeProviderName(identifier) ===
// normalizeProviderName(name)` fallback -- had no coverage. It is reached only
// when at least one side fails to resolve to a roster target, and since every
// one of its seven call sites already guards `name` with a non-null-targetId
// check first, in practice that means: the caller-supplied IDENTIFIER
// (--only-provider / --exclude-provider) names nothing in the roster.
//
// Both outcomes of that fallback are reachable and observable, so both are
// locked below. The asymmetry that makes the `true` side reachable at all is
// that resolveTargetIdentity()'s first two steps (exact target id, exact
// snapshot_name) do NOT check `enabled`, while its harness tie-break does --
// so a snapshot provider named exactly like a DISABLED target still resolves,
// while a case-variant of that same string does not.
describe("providerMatches fallback for roster-unresolvable identifiers", () => {
	it("matches nothing when --only-provider names no roster target, and excludes nothing when --exclude-provider does", () => {
		// Both filtered routes below go through the fallback's `false` outcome:
		// "windsurf" resolves to no target (targetId null), every snapshot name
		// here resolves to one, and "windsurf" !== "claude"/"codex".
		strictEqual(resolveTargetIdentity("windsurf").targetId, null);

		createTestSnapshot([
			{ name: "claude", ok: true, windows: [{ percent_left: 90 }] },
			{ name: "codex", ok: true, windows: [{ percent_left: 80 }] },
		]);

		// Control: without a filter this queue routes fine. Without it, the
		// `only` assertion would pass vacuously on any roster/snapshot state
		// that made every provider ineligible for an unrelated reason.
		const unfiltered = route({ requiredCapability: "standard" });
		notStrictEqual(unfiltered.provider, null);

		// An unknown allowlist entry allows nothing -- it must not silently
		// degrade to "no filter".
		strictEqual(
			route({ requiredCapability: "standard", only: ["windsurf"] }).provider,
			null,
		);

		// The opposite polarity, which the `only` case alone would not catch:
		// an unknown exclusion must remove nothing. An inverted condition in
		// the fallback would show up here as a null route.
		strictEqual(
			route({ requiredCapability: "standard", exclude: ["windsurf"] }).provider,
			unfiltered.provider,
		);
	});

	it("still excludes a disabled target's snapshot provider given a case-variant identifier", () => {
		// The fallback's `true` outcome. The fixture's `vibe` target is
		// disabled, which is precisely what splits the two spellings:
		//   "vibe" -> exact target id (step 1, no `enabled` check) -> "vibe"
		//   "Vibe" -> no id/snapshot_name match, then the harness tie-break
		//             finds zero ENABLED vibe targets                -> null
		// One resolved side and one unresolved side is what drops
		// providerMatches past its `identifierTargetId && nameTargetId` branch
		// onto the fallback, where both spellings normalize to "vibe".
		//
		// Asserting the split directly rather than assuming it: if `vibe` is
		// ever enabled in the fixture, "Vibe" starts resolving through the
		// tie-break, the exclusion below still fires via the earlier branch,
		// and this test would keep passing while covering nothing.
		strictEqual(resolveTargetIdentity("vibe").targetId, "vibe");
		strictEqual(resolveTargetIdentity("Vibe").targetId, null);

		const snapshot = {
			schema_version: 2,
			updated_at: new Date().toISOString(),
			providers: [{ name: "vibe", ok: true, windows: [{ percent_left: 80 }] }],
		};
		const reasonFor = (exclude) =>
			preflightMacosQueue({
				tasks: [{ id: "t", status: "pending", requiredCapability: "standard" }],
				tarProvisionManifest: { verified: true, providers: ["vibe"] },
				readSnapshot: () => ({
					snapshot,
					snapshotStatus: "fresh",
					snapshotMtime: 1,
					snapshotAgeMsAtRoute: 0,
				}),
				exclude,
			}).capabilityResults[0].excludedReasons.vibe;

		// Control: unexcluded, `vibe` drops out later in classifyPreflightProvider
		// for an unrelated reason. That baseline is what makes the flip to
		// "explicitly_excluded" evidence that the exclusion matched, rather
		// than a reason string this provider would have carried anyway.
		strictEqual(reasonFor([]), "below_required_capability");
		strictEqual(reasonFor(["Vibe"]), "explicitly_excluded");
		// ...and the fallback is still discriminating, not matching everything:
		// an unrelated unresolvable identifier leaves the baseline reason.
		strictEqual(reasonFor(["windsurf"]), "below_required_capability");
	});

	it("refuses a case-variant of an ambiguous harness with ambiguous_target rather than routing it", () => {
		// The rider to the above: with TWO enabled codex targets, "CODEX" no
		// longer resolves -- it matches no exact target id (that comparison is
		// case-sensitive) and the harness tie-break now sees two candidates.
		// Lowercase "codex" keeps working because it hits the exact id.
		//
		// route() catches this in its own pre-loop guard and returns
		// `ambiguous_target` with an actionable hint, so the identifier never
		// reaches providerMatches at all. Assert that reason, not just
		// `provider === null`: a bare null assertion would keep passing if the
		// guard were deleted, because the fallback above would then quietly
		// match "CODEX" to the "Codex" snapshot name instead.
		//
		// The mixed case itself is a PRECONDITION, not a bug to fix here: the
		// CLI lowercases every provider filter in normalizeProviders()
		// (src/switchyard/runner/index.mjs:171), so only a programmatic
		// runQueue caller bypassing normalizeRunOptions can hand the router a
		// mixed-case identifier. If case-insensitive target-id resolution is
		// ever added to resolveTargetIdentityFromTargets, revisit this.
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-codex-case-${process.pid}-${randomUUID()}.json`,
		);
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		try {
			writeFileSync(
				rosterPath,
				JSON.stringify(
					buildDualCodexRoster({ incumbentSnapshotName: "Codex" }),
				),
				"utf8",
			);
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			createTestSnapshot([
				{ name: "Codex", ok: true, windows: [{ percent_left: 40 }] },
				{ name: "Codex (Spark)", ok: true, windows: [{ percent_left: 95 }] },
			]);

			// Control: both targets are live and Spark holds the headroom, so a
			// null result below is the filter's doing and not an ineligible roster.
			strictEqual(
				route({ requiredCapability: "low" }).provider,
				"Codex (Spark)",
			);
			strictEqual(
				route({ requiredCapability: "low", only: ["codex"] }).provider,
				"Codex",
			);

			const upper = route({ requiredCapability: "low", only: ["CODEX"] });
			strictEqual(upper.provider, null);
			strictEqual(upper.reason, "ambiguous_target");
			ok(
				upper.log.some((line) => line.includes("use an exact target id")),
				`expected an actionable hint, got: ${JSON.stringify(upper.log)}`,
			);
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});
});
