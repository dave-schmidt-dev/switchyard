// Task 1.5 (roster-unification plan): loader test for the roster-backed
// src/switchyard/roster/index.mjs. Verifies SWITCHYARD_ROSTER_PATH resolution
// fails loud (missing env var, missing file, malformed JSON, broken
// structural contract) and that the exports router/index.mjs depends on
// (PROVIDER_CAPABILITIES, passesCapabilityFilter, getRightSizedModel, and
// the rest of the pre-roster interface) return roster-backed values against
// a committed, synthetic fixture — never the real ~/.agent/roster.json.

import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	CAPABILITY_CLASS,
	filterByCapability,
	getCapabilityClass,
	getModelForTier,
	getRightSizedModel,
	normalizeProviderName,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
	TIER_ORDER,
} from "../src/switchyard/roster/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

let tmpDir;
const previousEnv = {};

function setRosterPath(value) {
	if (!("SWITCHYARD_ROSTER_PATH" in previousEnv)) {
		previousEnv.SWITCHYARD_ROSTER_PATH = process.env.SWITCHYARD_ROSTER_PATH;
	}
	if (value === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = value;
	}
	__resetRosterCacheForTests();
}

afterEach(() => {
	if ("SWITCHYARD_ROSTER_PATH" in previousEnv) {
		if (previousEnv.SWITCHYARD_ROSTER_PATH === undefined) {
			delete process.env.SWITCHYARD_ROSTER_PATH;
		} else {
			process.env.SWITCHYARD_ROSTER_PATH = previousEnv.SWITCHYARD_ROSTER_PATH;
		}
		delete previousEnv.SWITCHYARD_ROSTER_PATH;
	}
	__resetRosterCacheForTests();
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

describe("roster loader — fail-loud path resolution", () => {
	it("throws when SWITCHYARD_ROSTER_PATH is unset", () => {
		setRosterPath(undefined);
		throws(
			() => passesCapabilityFilter("claude", "low"),
			/SWITCHYARD_ROSTER_PATH is not set/,
		);
	});

	it("throws when SWITCHYARD_ROSTER_PATH is empty string (treated as unset)", () => {
		setRosterPath("");
		throws(
			() => getRightSizedModel("claude", "low"),
			/SWITCHYARD_ROSTER_PATH is not set/,
		);
	});

	it("throws when SWITCHYARD_ROSTER_PATH points at a nonexistent file", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-roster-loader-"));
		setRosterPath(join(tmpDir, "does-not-exist.json"));
		throws(
			() => passesCapabilityFilter("claude", "low"),
			/failed to read roster/,
		);
	});

	it("throws when the roster file is not valid JSON", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-roster-loader-"));
		const badPath = join(tmpDir, "malformed.json");
		writeFileSync(badPath, "{ not valid json at all", "utf8");
		setRosterPath(badPath);
		throws(() => getRightSizedModel("codex", "high"), /is not valid JSON/);
	});

	it("throws when the roster is missing top-level 'targets'", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-roster-loader-"));
		const badPath = join(tmpDir, "no-targets.json");
		writeFileSync(
			badPath,
			JSON.stringify({ schema_version: 1, models: {} }),
			"utf8",
		);
		setRosterPath(badPath);
		throws(
			() => passesCapabilityFilter("claude", "low"),
			/failed structural validation/,
		);
	});

	it("throws when a slot's model_ref does not resolve in the catalog", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-roster-loader-"));
		const badPath = join(tmpDir, "dangling-ref.json");
		writeFileSync(
			badPath,
			JSON.stringify({
				schema_version: 1,
				models: {},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						technical_ceiling: "high",
						qualifications: {},
						slots: {
							low: [{ model_ref: "nonexistent/model", priority: 1 }],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(badPath);
		throws(
			() => passesCapabilityFilter("claude", "low"),
			/does not resolve to any catalog model/,
		);
	});
});

describe("roster loader — preserved exports, roster-backed (committed fixture)", () => {
	it("CAPABILITY_CLASS and TIER_ORDER are static tier vocabulary, unaffected by the roster", () => {
		// No SWITCHYARD_ROSTER_PATH needed at all — these never touch the roster.
		strictEqual(CAPABILITY_CLASS.high, "high");
		strictEqual(CAPABILITY_CLASS.standard, "standard");
		strictEqual(CAPABILITY_CLASS.low, "low");
		strictEqual(TIER_ORDER.high, 3);
		strictEqual(TIER_ORDER.standard, 2);
		strictEqual(TIER_ORDER.low, 1);
	});

	it("normalizeProviderName is unchanged pure vocabulary, unaffected by the roster", () => {
		strictEqual(normalizeProviderName("OpenCode Go"), "opencode");
		strictEqual(normalizeProviderName("Antigravity"), "agy");
		strictEqual(normalizeProviderName("Claude"), "claude");
	});

	it("PROVIDER_CAPABILITIES exposes one entry per known provider/harness, roster-backed", () => {
		setRosterPath(FIXTURE_PATH);
		const keys = Object.keys(PROVIDER_CAPABILITIES).sort();
		deepStrictEqual(keys, [
			"agy",
			"claude",
			"codex",
			"copilot",
			"cursor",
			"opencode",
			"vibe",
		]);
	});

	it("getRightSizedModel/getModelForTier return the fixture's per-tier selectors", () => {
		setRosterPath(FIXTURE_PATH);
		strictEqual(getRightSizedModel("claude", "low"), "fixture-claude-low");
		strictEqual(
			getRightSizedModel("claude", "standard"),
			"fixture-claude-standard",
		);
		strictEqual(getRightSizedModel("claude", "high"), "fixture-claude-high");
		strictEqual(getModelForTier("codex", "high"), "fixture-codex-high");
	});

	it("passesCapabilityFilter derives from the computed auto_routing_ceiling, not a static table", () => {
		setRosterPath(FIXTURE_PATH);
		// claude/codex are qualified at every tier -> full high capability.
		strictEqual(passesCapabilityFilter("claude", "high"), true);
		strictEqual(passesCapabilityFilter("codex", "high"), true);
		// antigravity has no high slot at all -> excluded above standard.
		strictEqual(passesCapabilityFilter("agy", "standard"), true);
		strictEqual(passesCapabilityFilter("agy", "high"), false);
	});

	it("a manual_only slot never counts toward the auto ceiling (cursor: standard yes, high no)", () => {
		setRosterPath(FIXTURE_PATH);
		strictEqual(getCapabilityClass("cursor"), "standard");
		strictEqual(passesCapabilityFilter("cursor", "standard"), true);
		strictEqual(passesCapabilityFilter("cursor", "high"), false);
		strictEqual(getRightSizedModel("cursor", "high"), null);
	});

	it("a disabled target (vibe) is excluded from auto-routing at every tier, even where a slot exists", () => {
		setRosterPath(FIXTURE_PATH);
		strictEqual(getCapabilityClass("vibe"), null);
		strictEqual(passesCapabilityFilter("vibe", "low"), false);
		strictEqual(getRightSizedModel("vibe", "standard"), null);
	});

	it("a temporarily_unavailable qualification excludes that tier without disabling the whole target", () => {
		setRosterPath(FIXTURE_PATH);
		// opencode-go: low is qualified, standard is only temporarily_unavailable.
		strictEqual(getCapabilityClass("opencode"), "low");
		strictEqual(passesCapabilityFilter("opencode", "low"), true);
		strictEqual(passesCapabilityFilter("opencode", "standard"), false);
		strictEqual(getRightSizedModel("opencode", "standard"), null);
	});

	it("filterByCapability filters a provider list using the roster-backed predicate", () => {
		setRosterPath(FIXTURE_PATH);
		const highTier = filterByCapability(
			["claude", "codex", "vibe", "agy"],
			"high",
		);
		deepStrictEqual(highTier.sort(), ["claude", "codex"]);
	});

	it("getCapabilityClass returns null for a provider name absent from the roster", () => {
		setRosterPath(FIXTURE_PATH);
		strictEqual(getCapabilityClass("totally-unknown-provider"), null);
	});

	it("__resetRosterCacheForTests lets a later test point at a different roster and see fresh values", () => {
		setRosterPath(FIXTURE_PATH);
		strictEqual(getRightSizedModel("claude", "high"), "fixture-claude-high");

		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-roster-loader-"));
		const otherPath = join(tmpDir, "other.json");
		writeFileSync(
			otherPath,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/other-high": {
						selector: "other-claude-high",
						status: "active",
					},
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						technical_ceiling: "high",
						qualifications: { "other-claude-high": { status: "qualified" } },
						slots: {
							high: [{ model_ref: "fixture/other-high", priority: 1 }],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(otherPath);
		strictEqual(getRightSizedModel("claude", "high"), "other-claude-high");
	});
});

describe("roster loader — effort-keyed qualification variants (brief §4: 'qualification is keyed by invocation variant')", () => {
	// Live production pattern (~/.agent/roster.json, verified 2026-07-31):
	// claude-code's and codex's HIGH slots both carry a non-manual_only
	// `effort` field (e.g. "max"/"xhigh"), so their qualification is keyed
	// `${selector}@${effort}`, not the bare selector. The committed synthetic
	// fixture (tests/fixtures/roster.fixture.json) never happens to exercise
	// this: its only `effort`-carrying slot (cursor-pro's high slot) is also
	// `manual_only`, which short-circuits BEFORE qualificationVariantKey is
	// ever computed (see autoRoutingCeiling/resolveSlotModel in
	// src/switchyard/roster/index.mjs). So nothing anywhere proves the
	// composite key is actually used for a real, auto-routable slot — a
	// regression that dropped the `@effort` suffix (falling back to the bare
	// selector) would pass every existing test. These two cases close that
	// gap directly against a temp roster shaped like the live one.
	it("a qualification keyed 'selector@effort' gates a non-manual_only effort-carrying slot's ceiling", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-roster-loader-"));
		const path = join(tmpDir, "effort-variant-qualified.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/claude-high-effort": {
						selector: "fixture-claude-high-effort",
						status: "active",
					},
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						qualifications: {
							"fixture-claude-high-effort@xhigh": { status: "qualified" },
						},
						slots: {
							high: [
								{
									model_ref: "fixture/claude-high-effort",
									priority: 1,
									effort: "xhigh",
								},
							],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getCapabilityClass("claude"), "high");
		strictEqual(passesCapabilityFilter("claude", "high"), true);
		strictEqual(
			getRightSizedModel("claude", "high"),
			"fixture-claude-high-effort",
		);
	});

	it("control: a qualification keyed by the BARE selector does NOT satisfy an effort-carrying slot", () => {
		// Identical roster shape to the case above, except the qualification is
		// recorded under the bare selector instead of 'selector@effort'. If the
		// implementation ever fell back to matching on the bare selector, this
		// would incorrectly qualify — proving the composite key is load-bearing,
		// not merely present-but-unused.
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-roster-loader-"));
		const path = join(tmpDir, "effort-variant-bare-key.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/claude-high-effort": {
						selector: "fixture-claude-high-effort",
						status: "active",
					},
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						qualifications: {
							"fixture-claude-high-effort": { status: "qualified" }, // bare key, no @xhigh
						},
						slots: {
							high: [
								{
									model_ref: "fixture/claude-high-effort",
									priority: 1,
									effort: "xhigh",
								},
							],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getCapabilityClass("claude"), null);
		strictEqual(passesCapabilityFilter("claude", "high"), false);
		strictEqual(getRightSizedModel("claude", "high"), null);
	});
});

describe("roster loader — a retired catalog model never counts toward the ceiling", () => {
	it("a 'qualified' slot referencing a retired model is excluded, even though nothing else disqualifies it", () => {
		// autoRoutingCeiling/resolveSlotModel both gate on
		// `modelEntry?.status !== "active"` before ever consulting
		// qualifications. The committed fixture's one retired model
		// ("fixture/retired-model") is never referenced by any target slot, so
		// that filter is exercised only incidentally (never on a slot that would
		// otherwise qualify) by the rest of the suite. This proves it directly:
		// an enabled target, a fully-qualified slot, whose only problem is that
		// its catalog model has status "retired" — must still resolve to no
		// capability.
		tmpDir = mkdtempSync(join(tmpdir(), "switchyard-roster-loader-"));
		const path = join(tmpDir, "retired-slot.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/claude-retired": {
						selector: "fixture-claude-retired",
						status: "retired",
					},
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						qualifications: {
							"fixture-claude-retired": { status: "qualified" },
						},
						slots: {
							high: [{ model_ref: "fixture/claude-retired", priority: 1 }],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getCapabilityClass("claude"), null);
		strictEqual(passesCapabilityFilter("claude", "high"), false);
		strictEqual(getRightSizedModel("claude", "high"), null);
	});
});
