// INV-5 gate test: capability filter + model right-sizing.
// Property: a high-tier task never yields an under-capable target; the model
// returned is always right-sized to the requested tier; low-capability
// targets are excluded from high-tier routing.
//
// Task 1.6a (roster-unification plan): this file used to assert against the
// frozen PROVIDER_CAPABILITIES table (a hardcoded object literal) and pinned
// a stale `claude-haiku` model literal. Task 1.5 replaced that table with a
// roster-backed load (src/switchyard/roster/index.mjs), so this file now
// asserts the same INV-5 property against the committed synthetic fixture
// (tests/fixtures/roster.fixture.json) instead -- never the real
// ~/.agent/roster.json, and never a hardcoded production model id.
//
// Relationship to sibling test files (no accidental duplicate coverage):
//   - tests/roster-loader.test.mjs (Task 1.5) exercises the LOADER itself:
//     fail-loud path resolution, malformed/missing roster, and that every
//     preserved export is roster-backed rather than static.
//   - tests/router-rightsizing.test.mjs (Task 1.6) exercises route() END TO
//     END through the snapshot/spread machinery.
//   - THIS file exercises the capability GATE FUNCTIONS themselves
//     (getCapabilityClass, passesCapabilityFilter, getRightSizedModel,
//     filterByCapability) as the INV-5 safety net, independent of the router.
//
// Fixture ground truth (tests/fixtures/roster.fixture.json), computed via
// each target's auto_routing_ceiling (brief sec 3.3/9.2):
//   claude   -> high     (claude-code target, qualified low/standard/high)
//   codex    -> high     (codex target, qualified low/standard/high)
//   agy      -> standard (antigravity target, technical_ceiling standard, no high slot)
//   cursor   -> standard (cursor-pro target; its only high slot is manual_only, excluded)
//   copilot  -> standard (copilot-student target, technical_ceiling standard)
//   opencode -> low      (opencode-go target; standard slot is temporarily_unavailable)
//   vibe     -> null     (vibe target is enabled:false -> excluded at EVERY tier)

import { deepStrictEqual, strictEqual } from "node:assert";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	CAPABILITY_CLASS,
	filterByCapability,
	getCapabilityClass,
	getModelForTier,
	getRightSizedModel,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
	TIER_ORDER,
} from "../src/switchyard/roster/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

// Mirrors src/switchyard/roster/index.mjs's internal KNOWN_PROVIDER_HARNESSES
// (not exported) / the fixture's `targets` keys' harnesses. All 7 are backed
// by the committed fixture.
const ALL_KNOWN_PROVIDERS = [
	"claude",
	"codex",
	"agy",
	"cursor",
	"vibe",
	"copilot",
	"opencode",
];

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;

before(() => {
	process.env.SWITCHYARD_ROSTER_PATH = FIXTURE_PATH;
	__resetRosterCacheForTests();
});

after(() => {
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
});

describe("capability match", () => {
	it("should define capability classes (static tier vocabulary, unaffected by the roster)", () => {
		strictEqual(CAPABILITY_CLASS.high, "high");
		strictEqual(CAPABILITY_CLASS.standard, "standard");
		strictEqual(CAPABILITY_CLASS.low, "low");
	});

	it("should define tier ordering (static tier vocabulary, unaffected by the roster)", () => {
		strictEqual(TIER_ORDER.high, 3);
		strictEqual(TIER_ORDER.standard, 2);
		strictEqual(TIER_ORDER.low, 1);
	});

	it("should derive provider capability classes from the roster's computed auto_routing_ceiling", () => {
		strictEqual(
			PROVIDER_CAPABILITIES.claude.capability_class,
			CAPABILITY_CLASS.high,
		);
		strictEqual(
			PROVIDER_CAPABILITIES.codex.capability_class,
			CAPABILITY_CLASS.high,
		);
		strictEqual(
			PROVIDER_CAPABILITIES.agy.capability_class,
			CAPABILITY_CLASS.standard,
		);
		// opencode-go is qualified only at low (its standard slot is
		// temporarily_unavailable) -> this is the enabled-but-low-capability
		// provider the old test used vibe for; vibe itself is disabled
		// (excluded entirely, see below), a stronger exclusion than "low".
		strictEqual(
			PROVIDER_CAPABILITIES.opencode.capability_class,
			CAPABILITY_CLASS.low,
		);
		// vibe is enabled:false in the fixture -> excluded from auto-routing
		// at every tier, not merely capped low.
		strictEqual(PROVIDER_CAPABILITIES.vibe.capability_class, null);
	});

	it("should get capability class for provider", () => {
		strictEqual(getCapabilityClass("claude"), CAPABILITY_CLASS.high);
		strictEqual(getCapabilityClass("codex"), CAPABILITY_CLASS.high);
		strictEqual(getCapabilityClass("opencode"), CAPABILITY_CLASS.low);
		strictEqual(getCapabilityClass("vibe"), null);
		strictEqual(getCapabilityClass("unknown"), null);
	});

	it("should get model for provider and tier (fixture selectors, not a hardcoded production model id)", () => {
		strictEqual(getModelForTier("claude", "high"), "fixture-claude-high");
		strictEqual(
			getModelForTier("claude", "standard"),
			"fixture-claude-standard",
		);
		strictEqual(getModelForTier("claude", "low"), "fixture-claude-low");
	});

	it("should get right-sized model", () => {
		strictEqual(getRightSizedModel("claude", "high"), "fixture-claude-high");
		strictEqual(
			getRightSizedModel("codex", "standard"),
			"fixture-codex-standard",
		);
	});

	it("should pass capability filter for sufficient providers", () => {
		// High-tier task should pass for claude and codex (full high capability)
		strictEqual(passesCapabilityFilter("claude", "high"), true);
		strictEqual(passesCapabilityFilter("codex", "high"), true);

		// Standard-tier task should pass for claude and agy
		strictEqual(passesCapabilityFilter("claude", "standard"), true);
		strictEqual(passesCapabilityFilter("agy", "standard"), true);

		// Low-tier task should pass for every enabled, qualified-at-low provider
		strictEqual(passesCapabilityFilter("claude", "low"), true);
		strictEqual(passesCapabilityFilter("opencode", "low"), true);
	});

	it("should fail capability filter for insufficient providers", () => {
		// High-tier task should NOT pass for opencode (low capability)
		strictEqual(passesCapabilityFilter("opencode", "high"), false);
		strictEqual(passesCapabilityFilter("opencode", "standard"), false);

		// Standard-tier task should NOT pass for opencode
		strictEqual(passesCapabilityFilter("opencode", "standard"), false);

		// vibe is disabled -> fails at every tier, including low
		strictEqual(passesCapabilityFilter("vibe", "low"), false);
		strictEqual(passesCapabilityFilter("vibe", "high"), false);
	});

	it("should filter providers by capability", () => {
		// High-tier: only claude and codex have high capability
		const highTierProviders = filterByCapability(ALL_KNOWN_PROVIDERS, "high");
		strictEqual(highTierProviders.sort().join(","), "claude,codex");

		// Standard-tier: claude, codex, agy, cursor, copilot
		const standardTierProviders = filterByCapability(
			ALL_KNOWN_PROVIDERS,
			"standard",
		);
		strictEqual(
			standardTierProviders.sort().join(","),
			"agy,claude,codex,copilot,cursor",
		);

		// Low-tier: every provider EXCEPT vibe (disabled -> excluded even at
		// its own floor tier; this is the roster-derived behavior that
		// differs from the old frozen table, where vibe was merely "low").
		const lowTierProviders = filterByCapability(ALL_KNOWN_PROVIDERS, "low");
		strictEqual(
			lowTierProviders.sort().join(","),
			"agy,claude,codex,copilot,cursor,opencode",
		);
	});
});

describe("capability match — INV-5 safety property", () => {
	it("high-tier routing never yields an under-capable target", () => {
		// Every provider below full-high capability must be excluded from a
		// high-tier route, regardless of how the roster's data shapes it
		// (disabled, technical_ceiling cap, or manual_only-only high slot).
		const underCapableAtHigh = ["agy", "cursor", "copilot", "opencode", "vibe"];
		for (const provider of underCapableAtHigh) {
			strictEqual(
				passesCapabilityFilter(provider, "high"),
				false,
				`${provider} must not pass the high-tier capability filter`,
			);
		}
		deepStrictEqual(
			filterByCapability(ALL_KNOWN_PROVIDERS, "high").sort(),
			["claude", "codex"],
			"only full-high providers may be candidates for a high-tier route",
		);
	});

	it("the model returned for a passing provider is always right-sized to the requested tier", () => {
		// Right-sizing must track the REQUESTED tier, not leak a different
		// tier's model. Verify each tier resolves to its own distinct
		// selector for both full-high providers.
		for (const provider of ["claude", "codex"]) {
			const low = getRightSizedModel(provider, "low");
			const standard = getRightSizedModel(provider, "standard");
			const high = getRightSizedModel(provider, "high");
			strictEqual(low, `fixture-${provider}-low`);
			strictEqual(standard, `fixture-${provider}-standard`);
			strictEqual(high, `fixture-${provider}-high`);
			// The three must be pairwise distinct -- assert this explicitly
			// (not just via the equality checks above) so a right-sizing
			// regression that collapsed all three tiers to one model can't
			// slip through by coincidence of fixture naming.
			strictEqual(new Set([low, standard, high]).size, 3);
		}
	});

	it("low-capability targets are excluded from high-tier routing even though they are enabled and qualified at their own tier", () => {
		// opencode-go is enabled and genuinely qualified at low -- it is a
		// legitimate low-tier target, not a broken one -- yet it must still
		// be excluded the moment the task tier exceeds its ceiling.
		strictEqual(passesCapabilityFilter("opencode", "low"), true);
		strictEqual(getRightSizedModel("opencode", "low"), "fixture/opencode-low");
		strictEqual(passesCapabilityFilter("opencode", "standard"), false);
		strictEqual(passesCapabilityFilter("opencode", "high"), false);
		strictEqual(getRightSizedModel("opencode", "high"), null);
	});

	it("a disabled target is excluded from auto-routing at every tier, not merely capped low", () => {
		strictEqual(getCapabilityClass("vibe"), null);
		for (const tier of ["low", "standard", "high"]) {
			strictEqual(passesCapabilityFilter("vibe", tier), false);
			strictEqual(getRightSizedModel("vibe", tier), null);
		}
	});
});
