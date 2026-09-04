// Task 1.5 & Task 4.1: loader test for the roster-backed src/switchyard/roster/index.mjs.
// Verifies roster path resolution (default canonical ~/.agent/roster.json and SWITCHYARD_ROSTER_PATH override)
// fails loud on missing file, malformed JSON, or broken structural contract, and that exports return
// roster-backed values against synthetic fixtures.

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	CAPABILITY_CLASS,
	CAPABILITY_CLASS_ORDER,
	computeQualificationStatus,
	evaluateRealRosterCoherence,
	filterByCapability,
	formatRealRosterCoherenceFailure,
	getCapabilityClass,
	getImplementorPriority,
	getInvocationDescriptor,
	getInvocationDescriptorIdentity,
	getModelForCapability,
	getRightSizedModel,
	mapInvocationArgs,
	normalizeProviderName,
	PROVIDER_CAPABILITIES,
	PROVIDER_INVOCATION_VOCABULARY,
	passesCapabilityFilter,
	QUALIFICATION_STATUS,
	STALE_MAX_AGE_SECONDS,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

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

function setHomeDir(value) {
	if (!("HOME" in previousEnv)) {
		previousEnv.HOME = process.env.HOME;
	}
	if (value === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = value;
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
	if ("HOME" in previousEnv) {
		if (previousEnv.HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousEnv.HOME;
		}
		delete previousEnv.HOME;
	}
	__resetRosterCacheForTests();
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

describe("roster loader — path resolution (default ~/.agent/roster.json & SWITCHYARD_ROSTER_PATH override)", () => {
	it("resolves to canonical ~/.agent/roster.json when SWITCHYARD_ROSTER_PATH is unset", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		copyFileSync(FIXTURE_PATH, join(agentDir, "roster.json"));

		setRosterPath(undefined);
		setHomeDir(tmpDir);

		strictEqual(getRightSizedModel("claude", "low"), "fixture-claude-low");
		strictEqual(passesCapabilityFilter("claude", "low"), true);
	});

	it("resolves to canonical ~/.agent/roster.json when SWITCHYARD_ROSTER_PATH is empty string", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		copyFileSync(FIXTURE_PATH, join(agentDir, "roster.json"));

		setRosterPath("");
		setHomeDir(tmpDir);

		strictEqual(getRightSizedModel("claude", "low"), "fixture-claude-low");
	});

	it("uses SWITCHYARD_ROSTER_PATH as an explicit override over default home roster", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "roster.json"),
			JSON.stringify({
				schema_version: 1,
				models: {
					"home/model": { selector: "home-selector", status: "active" },
				},
				targets: {
					"claude-code": {
						harness: "claude",
						enabled: true,
						qualifications: { "home-selector": { status: "qualified" } },
						slots: { low: [{ model_ref: "home/model", priority: 1 }] },
					},
				},
			}),
			"utf8",
		);

		setHomeDir(tmpDir);
		setRosterPath(FIXTURE_PATH);

		strictEqual(getRightSizedModel("claude", "low"), "fixture-claude-low");
	});

	it("throws fail-loud error when default ~/.agent/roster.json is missing", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		setRosterPath(undefined);
		setHomeDir(tmpDir);

		throws(
			() => passesCapabilityFilter("claude", "low"),
			/failed to read roster/,
		);
	});

	it("throws fail-loud error when default ~/.agent/roster.json is malformed JSON", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "roster.json"), "{ not valid json", "utf8");

		setRosterPath(undefined);
		setHomeDir(tmpDir);

		throws(() => getRightSizedModel("codex", "high"), /is not valid JSON/);
	});

	it("throws fail-loud error when default ~/.agent/roster.json is structurally invalid", () => {
		tmpDir = tempDir("switchyard-roster-home-");
		const agentDir = join(tmpDir, ".agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "roster.json"),
			JSON.stringify({ schema_version: 1, models: {} }),
			"utf8",
		);

		setRosterPath(undefined);
		setHomeDir(tmpDir);

		throws(
			() => passesCapabilityFilter("claude", "low"),
			/failed structural validation/,
		);
	});

	it("throws when SWITCHYARD_ROSTER_PATH override points at a nonexistent file", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		setRosterPath(join(tmpDir, "does-not-exist.json"));
		throws(
			() => passesCapabilityFilter("claude", "low"),
			/failed to read roster/,
		);
	});

	it("throws when SWITCHYARD_ROSTER_PATH override file is not valid JSON", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		const badPath = join(tmpDir, "malformed.json");
		writeFileSync(badPath, "{ not valid json at all", "utf8");
		setRosterPath(badPath);
		throws(() => getRightSizedModel("codex", "high"), /is not valid JSON/);
	});

	it("throws when a slot's model_ref does not resolve in the catalog", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
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
	it("CAPABILITY_CLASS and CAPABILITY_CLASS_ORDER are static capability vocabulary, unaffected by the roster", () => {
		// No SWITCHYARD_ROSTER_PATH needed at all — these never touch the roster.
		strictEqual(CAPABILITY_CLASS.high, "high");
		strictEqual(CAPABILITY_CLASS.standard, "standard");
		strictEqual(CAPABILITY_CLASS.low, "low");
		strictEqual(CAPABILITY_CLASS_ORDER.high, 3);
		strictEqual(CAPABILITY_CLASS_ORDER.standard, 2);
		strictEqual(CAPABILITY_CLASS_ORDER.low, 1);
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
		]);
	});

	it("getRightSizedModel/getModelForCapability return the fixture's per-class selectors", () => {
		setRosterPath(FIXTURE_PATH);
		strictEqual(getRightSizedModel("claude", "low"), "fixture-claude-low");
		strictEqual(
			getRightSizedModel("claude", "standard"),
			"fixture-claude-standard",
		);
		strictEqual(getRightSizedModel("claude", "high"), "fixture-claude-high");
		strictEqual(getModelForCapability("codex", "high"), "fixture-codex-high");
	});

	it("passesCapabilityFilter derives from the computed auto_routing_ceiling, not a static table", () => {
		setRosterPath(FIXTURE_PATH);
		// claude/codex are qualified at every tier -> full high capability.
		strictEqual(passesCapabilityFilter("claude", "high"), true);
		strictEqual(passesCapabilityFilter("codex", "high"), true);
		// The fixture's enabled Antigravity target has a standard ceiling.
		strictEqual(getCapabilityClass("agy"), "standard");
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

	it("getImplementorPriority returns the roster-declared rank for a ranked target, null for an unranked one", () => {
		setRosterPath(FIXTURE_PATH);
		// antigravity/copilot-student/cursor-pro are the fixture's ranked
		// ("cheap implementor") targets (implementor-priority-waterfall-routing
		// plan); claude-code/codex/opencode-go set no implementor_priority and
		// must resolve to null (unranked/spread pool).
		strictEqual(getImplementorPriority("agy"), 1);
		strictEqual(getImplementorPriority("copilot"), 2);
		strictEqual(getImplementorPriority("cursor"), 3);
		strictEqual(getImplementorPriority("claude"), null);
		strictEqual(getImplementorPriority("codex"), null);
		strictEqual(getImplementorPriority("opencode"), null);
	});

	it("getImplementorPriority returns null for a provider name absent from the roster", () => {
		setRosterPath(FIXTURE_PATH);
		strictEqual(getImplementorPriority("totally-unknown-provider"), null);
	});

	it("__resetRosterCacheForTests lets a later test point at a different roster and see fresh values", () => {
		setRosterPath(FIXTURE_PATH);
		strictEqual(getRightSizedModel("claude", "high"), "fixture-claude-high");

		tmpDir = tempDir("switchyard-roster-loader-");
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
		tmpDir = tempDir("switchyard-roster-loader-");
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
									invocation_args: ["--effort", "xhigh"],
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
		tmpDir = tempDir("switchyard-roster-loader-");
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

	it("keeps same-selector OpenCode variants independently qualified", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		const path = join(tmpDir, "opencode-variant-qualification.json");
		const modelRef = "fixture/opencode-variant";
		const selector = "fixture-opencode-variant";
		const makeDescriptor = (variant) => ({
			target_id: "opencode-go",
			model_ref: modelRef,
			selector,
			effort: null,
			variant,
			invocation_args: ["--variant", variant],
		});
		const high = makeDescriptor("high");
		const max = makeDescriptor("max");
		const highIdentity = getInvocationDescriptorIdentity(high, "opencode");
		const maxIdentity = getInvocationDescriptorIdentity(max, "opencode");
		const qualification = (descriptor, identity) => ({
			status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
			descriptor_identity: identity,
			target_id: descriptor.target_id,
			model_ref: descriptor.model_ref,
			selector: descriptor.selector,
			effort: null,
			variant: descriptor.variant,
			invocation_args: descriptor.invocation_args,
			tested_at: new Date().toISOString(),
			credential_profile: "default",
		});
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					[modelRef]: { selector, status: "active" },
				},
				targets: {
					"opencode-go": {
						harness: "opencode",
						credential_profile: "default",
						enabled: true,
						slots: {
							low: [
								{
									model_ref: modelRef,
									priority: 1,
									variant: "high",
									invocation_args: ["--variant", "high"],
								},
							],
							standard: [
								{
									model_ref: modelRef,
									priority: 1,
									variant: "max",
									invocation_args: ["--variant", "max"],
								},
							],
							high: [],
						},
						qualifications: {
							[highIdentity]: qualification(high, highIdentity),
							[maxIdentity]: qualification(max, maxIdentity),
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getInvocationDescriptor("opencode-go", "low")?.variant, "high");
		strictEqual(
			getInvocationDescriptor("opencode-go", "standard")?.variant,
			"max",
		);
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
		tmpDir = tempDir("switchyard-roster-loader-");
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

describe("roster loader — invocation descriptor identity", () => {
	function writeInvocationArgsRoster(path, invocation_args) {
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						slots: {
							high: [{ model_ref: "openai/fixture", invocation_args }],
						},
					},
				},
			}),
			"utf8",
		);
	}

	it("freezes every descriptor field and changes identity when argv changes", () => {
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "codex",
				model_ref: "openai/gpt-5.6-sol",
				selector: "gpt-5.6-sol",
				effort: "xhigh",
				invocation_args: ["-c", "model_reasoning_effort=xhigh"],
			},
			"codex",
		);
		strictEqual(Object.isFrozen(descriptor), true);
		strictEqual(Object.isFrozen(descriptor.invocation_args), true);
		strictEqual(
			descriptor.descriptor_identity,
			getInvocationDescriptorIdentity(descriptor, "codex"),
		);
		strictEqual(
			getInvocationDescriptorIdentity(
				{
					...descriptor,
					effort: "high",
					invocation_args: ["-c", "model_reasoning_effort=high"],
				},
				"codex",
			) === descriptor.descriptor_identity,
			false,
		);
	});

	it("requires an explicit target-bound harness and never lets argv choose it", () => {
		const descriptor = {
			target_id: "claude",
			model_ref: "anthropic/fixture",
			selector: "fixture-claude",
			effort: "xhigh",
			invocation_args: ["-c", "model_reasoning_effort=xhigh"],
		};
		throws(
			() => validateInvocationDescriptor(descriptor, "claude"),
			/must be|claude invocation_args/,
		);
		throws(
			() => getInvocationDescriptorIdentity(descriptor, "claude"),
			/must be|claude invocation_args/,
		);
		throws(
			() => getInvocationDescriptorIdentity(descriptor),
			/harness is required/,
		);
	});

	it("binds descriptor identity to the canonical harness", () => {
		const core = {
			target_id: "antigravity",
			model_ref: "google/fixture",
			selector: "fixture-gemini",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const agyIdentity = getInvocationDescriptorIdentity(core, "Antigravity");
		const claudeIdentity = getInvocationDescriptorIdentity(core, "Claude");
		strictEqual(agyIdentity === claudeIdentity, false);

		const agyReceipt = validateInvocationDescriptor(
			{ ...core, descriptor_identity: agyIdentity },
			"agy",
		);
		throws(
			() => validateInvocationDescriptor(agyReceipt, "claude"),
			/descriptor_identity|invocation descriptor argv/,
		);
	});

	it("selector-only qualification remains readable but cannot authorize a descriptor", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "legacy-qualification.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						qualifications: { "fixture-codex": { status: "qualified" } },
						slots: { high: [{ model_ref: "openai/fixture", priority: 1 }] },
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		strictEqual(getRightSizedModel("codex", "high"), "fixture-codex");
		strictEqual(getInvocationDescriptor("codex", "high"), null);
	});

	it("authorizes only the exact descriptor identity", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "exact-qualification.json");
		const descriptor = {
			target_id: "codex",
			model_ref: "openai/fixture",
			selector: "fixture-codex",
			effort: "xhigh",
			invocation_args: ["-c", "model_reasoning_effort=xhigh"],
		};
		const identity = getInvocationDescriptorIdentity(descriptor, "codex");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						qualifications: {
							[identity]: {
								status: "dispatch_qualified",
								selector: descriptor.selector,
								descriptor_identity: identity,
								tested_at: new Date().toISOString(),
							},
						},
						slots: {
							high: [
								{
									model_ref: descriptor.model_ref,
									priority: 1,
									effort: descriptor.effort,
									invocation_args: descriptor.invocation_args,
								},
							],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		const resolved = getInvocationDescriptor("codex", "high");
		strictEqual(resolved?.descriptor_identity, identity);
		strictEqual(Object.isFrozen(resolved), true);
	});

	it("does not authorize qualifications whose descriptor identity changes", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "mismatch.json");
		const base = {
			target_id: "codex",
			model_ref: "openai/fixture",
			selector: "fixture-codex",
			effort: "xhigh",
			invocation_args: ["-c", "model_reasoning_effort=xhigh"],
		};
		const variants = [
			["target_id", { ...base, target_id: "codex-alt" }],
			["model_ref", { ...base, model_ref: "openai/other" }],
			["selector", { ...base, selector: "fixture-other" }],
			[
				"effort",
				{
					...base,
					effort: "high",
					invocation_args: ["-c", "model_reasoning_effort=high"],
				},
			],
			[
				"variant",
				{
					...base,
					effort: null,
					variant: "high",
					invocation_args: ["--variant", "high"],
				},
			],
			[
				"argv",
				{
					...base,
					effort: "high",
					invocation_args: ["-c", "model_reasoning_effort=high"],
				},
			],
		];
		for (const [field, variant] of variants) {
			const identity = getInvocationDescriptorIdentity(
				variant,
				variant.variant !== undefined ? "opencode" : "codex",
			);
			writeFileSync(
				path,
				JSON.stringify({
					schema_version: 1,
					models: {
						"openai/fixture": { selector: "fixture-codex", status: "active" },
					},
					targets: {
						codex: {
							harness: "codex",
							enabled: true,
							qualifications: { [identity]: { status: "qualified" } },
							slots: {
								high: [
									{
										model_ref: base.model_ref,
										effort: base.effort,
										invocation_args: base.invocation_args,
									},
								],
							},
						},
					},
				}),
				"utf8",
			);
			setRosterPath(path);
			strictEqual(getInvocationDescriptor("codex", "high"), null, field);
		}
	});

	it("rejects unapproved invocation flags, values, and positions at roster load", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "unsafe-invocation.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						slots: {
							high: [
								{
									model_ref: "openai/fixture",
									invocation_args: ["--dangerously-bypass", "yes"],
								},
							],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);
		throws(
			() => getRightSizedModel("codex", "high"),
			/invocation_args invalid/,
		);
		const descriptor = {
			target_id: "codex",
			model_ref: "openai/fixture",
			selector: "fixture-codex",
			effort: "xhigh",
		};
		for (const invocation_args of [
			["--dangerously-bypass", "yes"],
			["-c", "model_reasoning_effort=turbo"],
			["model_reasoning_effort=xhigh", "-c"],
		]) {
			throws(
				() =>
					getInvocationDescriptorIdentity(
						{
							...descriptor,
							invocation_args,
						},
						"codex",
					),
				/invalid|unapproved|must be/,
			);
		}
	});

	it("rejects an approved invocation flag with a bad value at roster load", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "bad-value.json");
		writeInvocationArgsRoster(path, ["-c", "model_reasoning_effort=turbo"]);
		setRosterPath(path);
		throws(
			() => getRightSizedModel("codex", "high"),
			/invocation_args invalid/,
		);
	});

	it("rejects a correctly-shaped invocation pair in reversed positions at roster load", () => {
		tmpDir = tempDir("switchyard-roster-descriptor-");
		const path = join(tmpDir, "reversed-pair.json");
		writeInvocationArgsRoster(path, ["model_reasoning_effort=xhigh", "-c"]);
		setRosterPath(path);
		throws(
			() => getRightSizedModel("codex", "high"),
			/invocation_args invalid/,
		);
	});
});

describe("roster loader — dispatch qualification evidence and freshness", () => {
	const recentTimestamp = () => new Date().toISOString();
	const descriptor = {
		target_id: "codex",
		model_ref: "openai/fixture",
		selector: "fixture-codex",
		effort: "xhigh",
		invocation_args: ["-c", "model_reasoning_effort=xhigh"],
	};
	const identity = getInvocationDescriptorIdentity(descriptor, "codex");

	function writeRoster(path, qualification, targetOverrides = {}) {
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						cli_version: "codex-cli 0.146.0",
						wrapper_version: "sha256:wrapper-a",
						credential_profile: "default",
						qualifications: { [identity]: qualification },
						slots: {
							high: [
								{
									model_ref: descriptor.model_ref,
									effort: descriptor.effort,
									invocation_args: descriptor.invocation_args,
									priority: 1,
								},
							],
						},
						...targetOverrides,
					},
				},
			}),
			"utf8",
		);
	}

	it("authorizes a current exact dispatch_qualified receipt", () => {
		tmpDir = tempDir("switchyard-roster-qualification-");
		const path = join(tmpDir, "current.json");
		writeRoster(path, {
			status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
			descriptor_identity: identity,
			target_id: descriptor.target_id,
			model_ref: descriptor.model_ref,
			selector: descriptor.selector,
			invocation_args: descriptor.invocation_args,
			tested_at: recentTimestamp(),
			cli_version: "codex-cli 0.146.0",
			wrapper_version: "sha256:wrapper-a",
			credential_profile: "default",
			promotion_receipt: {
				status: "promoted",
				atomic: true,
				descriptor_identity: identity,
				target_id: descriptor.target_id,
				model_ref: descriptor.model_ref,
				selector: descriptor.selector,
				effort: descriptor.effort,
				variant: null,
				invocation_args: descriptor.invocation_args,
				receipt_id: "receipt-1",
				committed_at: recentTimestamp(),
			},
		});
		setRosterPath(path);
		strictEqual(
			getInvocationDescriptor("codex", "high")?.descriptor_identity,
			identity,
		);
	});

	it("fails closed for probe-only, temporary, non-transmittable, stale, drifted, and wrong-argv evidence", () => {
		const records = [
			{
				status: QUALIFICATION_STATUS.PROBE_QUALIFIED,
				tested_at: recentTimestamp(),
			},
			{ status: QUALIFICATION_STATUS.TEMPORARILY_UNAVAILABLE },
			{ status: QUALIFICATION_STATUS.NOT_TRANSMITTABLE },
			{
				status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
				tested_at: "2026-01-01T00:00:00Z",
			},
			{
				status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
				tested_at: recentTimestamp(),
				cli_version: "codex-cli old",
			},
			{
				status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
				tested_at: recentTimestamp(),
				invocation_args: ["-c", "model_reasoning_effort=high"],
			},
		];
		for (const [index, record] of records.entries()) {
			tmpDir = tempDir(`switchyard-roster-qualification-${index}-`);
			const path = join(tmpDir, "negative.json");
			writeRoster(path, record);
			setRosterPath(path);
			strictEqual(
				getInvocationDescriptor("codex", "high"),
				null,
				`case ${index}`,
			);
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it("rejects malformed atomic promotion receipts", () => {
		tmpDir = tempDir("switchyard-roster-qualification-");
		const path = join(tmpDir, "malformed-promotion.json");
		writeRoster(path, {
			status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
			descriptor_identity: identity,
			tested_at: recentTimestamp(),
			promotion_receipt: { status: "rolled_back", atomic: false },
		});
		setRosterPath(path);
		strictEqual(getInvocationDescriptor("codex", "high"), null);
	});

	it("requires nested promotion receipts to match the complete descriptor atomically", () => {
		const baseReceipt = {
			status: "promoted",
			atomic: true,
			descriptor_identity: identity,
			target_id: descriptor.target_id,
			model_ref: descriptor.model_ref,
			selector: descriptor.selector,
			effort: descriptor.effort,
			variant: null,
			invocation_args: descriptor.invocation_args,
			receipt_id: "receipt-2",
			committed_at: new Date().toISOString(),
		};
		const invalidReceipts = [
			{},
			{ ...baseReceipt, atomic: undefined },
			{ ...baseReceipt, atomic: false },
			{ ...baseReceipt, target_id: "other-target" },
			{ ...baseReceipt, model_ref: "openai/other" },
			{ ...baseReceipt, effort: "high" },
			{ ...baseReceipt, variant: "high" },
			{
				...baseReceipt,
				invocation_args: ["-c", "model_reasoning_effort=high"],
			},
			{
				...baseReceipt,
				argv: ["-c", "model_reasoning_effort=high"],
			},
			{
				...baseReceipt,
				validated_invocation_args: ["-c", "model_reasoning_effort=high"],
			},
		];
		for (const [index, promotion_receipt] of invalidReceipts.entries()) {
			tmpDir = tempDir(`switchyard-roster-promotion-${index}-`);
			const path = join(tmpDir, "invalid-promotion.json");
			writeRoster(path, {
				status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
				selector: descriptor.selector,
				tested_at: recentTimestamp(),
				promotion_receipt,
			});
			setRosterPath(path);
			strictEqual(
				getInvocationDescriptor("codex", "high"),
				null,
				`promotion case ${index}`,
			);
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it("ports staleness evaluation and treats malformed or future timestamps as stale", () => {
		const signature = {
			selector: "fixture-codex",
			cli_version: "codex-cli 0.146.0",
			wrapper_version: "sha256:wrapper-a",
			credential_profile: "default",
		};
		strictEqual(
			computeQualificationStatus(
				{
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					...signature,
					tested_at: "2026-08-05T18:00:00Z",
				},
				signature,
				"2026-08-05T18:00:00Z",
			),
			QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
		);
		strictEqual(
			computeQualificationStatus(
				{
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					...signature,
					tested_at: "2026-08-05T18:00:00Z",
				},
				{ ...signature, wrapper_version: "sha256:wrapper-b" },
				"2026-08-05T18:00:01Z",
			),
			QUALIFICATION_STATUS.STALE,
		);
		strictEqual(
			computeQualificationStatus(
				{
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					...signature,
					tested_at: "not-a-date",
				},
				signature,
				"2026-08-05T18:00:01Z",
			),
			QUALIFICATION_STATUS.STALE,
		);
		strictEqual(
			computeQualificationStatus(
				{
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					...signature,
					tested_at: "2026-08-05T18:00:00Z",
				},
				signature,
				"2026-08-05T18:00:01Z",
				0,
			),
			QUALIFICATION_STATUS.STALE,
		);
		strictEqual(STALE_MAX_AGE_SECONDS, 30 * 24 * 60 * 60);
	});
});

describe("roster loader — provider vocabularies and real-roster coherence", () => {
	const nowIso = "2026-08-05T18:00:00Z";

	function makeRoster({
		status = QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
	} = {}) {
		const models = {
			"anthropic/fixture-low": { selector: "fixture-low", status: "active" },
			"anthropic/fixture-standard": {
				selector: "fixture-standard",
				status: "active",
			},
			"anthropic/fixture-high": { selector: "fixture-high", status: "active" },
		};
		const slots = {};
		const qualifications = {};
		for (const [capabilityClass, modelRef] of Object.entries({
			low: "anthropic/fixture-low",
			standard: "anthropic/fixture-standard",
			high: "anthropic/fixture-high",
		})) {
			const model = models[modelRef];
			const descriptor = {
				target_id: "claude-code",
				model_ref: modelRef,
				selector: model.selector,
				effort: null,
				variant: null,
				invocation_args: [],
			};
			const descriptorIdentity = getInvocationDescriptorIdentity(
				descriptor,
				"claude",
			);
			slots[capabilityClass] = [{ model_ref: modelRef, priority: 1 }];
			qualifications[descriptorIdentity] = {
				status,
				descriptor_identity: descriptorIdentity,
				target_id: "claude-code",
				model_ref: modelRef,
				selector: model.selector,
				invocation_args: [],
				tested_at: nowIso,
			};
		}
		return {
			schema_version: 1,
			models,
			targets: {
				"claude-code": {
					harness: "claude",
					enabled: true,
					slots,
					qualifications,
				},
			},
		};
	}

	it("keeps effort/variant labels and argv mapping isolated per CLI", () => {
		strictEqual(mapInvocationArgs("claude", { effort: "max" })[0], "--effort");
		strictEqual(
			mapInvocationArgs("codex", { effort: "xhigh" })[1],
			"model_reasoning_effort=xhigh",
		);
		strictEqual(mapInvocationArgs("codex", { effort: "max" }), null);
		deepStrictEqual(mapInvocationArgs("opencode", { variant: "thinking" }), [
			"--variant",
			"thinking",
		]);
		deepStrictEqual(mapInvocationArgs("opencode", {}), []);
		strictEqual(mapInvocationArgs("agy", { effort: "high" }), null);
		strictEqual(mapInvocationArgs("cursor", { variant: "high" }), null);
		strictEqual(PROVIDER_INVOCATION_VOCABULARY.copilot.effort.length, 0);
	});

	it("passes when every enabled automatic class has a current exact dispatch receipt", () => {
		const report = evaluateRealRosterCoherence(makeRoster(), { nowIso });
		strictEqual(report.ok, true);
		deepStrictEqual(report.missingClasses, []);
		strictEqual(report.unsupportedSlots.length, 0);
	});

	it("fails closed for legacy qualified evidence and reports an actionable gap", () => {
		const report = evaluateRealRosterCoherence(
			makeRoster({ status: "qualified" }),
			{ nowIso },
		);
		strictEqual(report.ok, false);
		deepStrictEqual(report.missingClasses, ["low", "standard", "high"]);
		ok(formatRealRosterCoherenceFailure(report).includes("dispatch_qualified"));
	});

	it("disables unsupported cross-harness intent instead of coercing it", () => {
		const roster = makeRoster();
		roster.targets["claude-code"].slots.high[0].effort = "max";
		roster.targets["claude-code"].slots.high[0].invocation_args = [
			"-c",
			"model_reasoning_effort=max",
		];
		const report = evaluateRealRosterCoherence(roster, { nowIso });
		strictEqual(report.ok, false);
		strictEqual(report.unsupportedSlots.length, 1);
		strictEqual(report.unsupportedSlots[0].capabilityClass, "high");
	});

	it("fails closed when the automatic capability baseline is empty", () => {
		const report = evaluateRealRosterCoherence({ models: {}, targets: {} });
		strictEqual(report.ok, false);
		deepStrictEqual(report.missingClasses, ["low", "standard", "high"]);
		strictEqual(report.noEnabledClasses, true);
	});

	it("rejects effort/variant descriptors with empty or cross-provider argv", () => {
		throws(
			() =>
				validateInvocationDescriptor(
					{
						target_id: "claude-code",
						model_ref: "anthropic/fixture",
						selector: "fixture-claude",
						effort: "max",
						invocation_args: [],
					},
					"claude",
				),
			/(invocation descriptor argv does not match|codex invocation_args must)/,
		);
		throws(
			() =>
				validateInvocationDescriptor(
					{
						target_id: "codex",
						model_ref: "openai/fixture",
						selector: "fixture-codex",
						effort: "xhigh",
						invocation_args: ["--effort", "xhigh"],
					},
					"codex",
				),
			/(invocation descriptor argv does not match|codex invocation_args must)/,
		);
	});

	it("returns no descriptor for an effort-bearing slot with empty argv", () => {
		const roster = makeRoster();
		roster.targets["claude-code"].slots.high[0].effort = "max";
		tmpDir = tempDir("switchyard-roster-argv-");
		const path = join(tmpDir, "unsupported.json");
		writeFileSync(path, JSON.stringify(roster), "utf8");
		setRosterPath(path);
		strictEqual(getInvocationDescriptor("claude-code", "high"), null);
	});

	it("excludes configured-disabled Gemini and Vibe targets", () => {
		const roster = makeRoster();
		roster.targets.antigravity = {
			harness: "agy",
			enabled: false,
			slots: {
				low: [{ model_ref: "google/gemini-3.6-flash-low" }],
				standard: [],
				high: [],
			},
		};
		roster.targets.vibe = {
			harness: "vibe",
			enabled: false,
			slots: { low: [], standard: [], high: [] },
		};
		const report = evaluateRealRosterCoherence(roster, { nowIso });
		deepStrictEqual(report.excludedTargets, ["antigravity", "vibe"]);
		strictEqual(report.ok, true);
	});

	it("retains enabled Antigravity Claude while Gemini Antigravity is disabled", () => {
		const roster = makeRoster();
		const modelRef = "anthropic/agy-sonnet";
		const selector = "claude-sonnet-4-6";
		roster.models[modelRef] = { selector, status: "active" };
		const descriptor = {
			target_id: "antigravity-claude",
			model_ref: modelRef,
			selector,
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const descriptorIdentity = getInvocationDescriptorIdentity(
			descriptor,
			"agy",
		);
		roster.targets.antigravity = {
			harness: "agy",
			enabled: false,
			slots: { low: [], standard: [], high: [] },
		};
		roster.targets["antigravity-claude"] = {
			harness: "agy",
			enabled: true,
			slots: { low: [], standard: [{ model_ref: modelRef }], high: [] },
			qualifications: {
				[descriptorIdentity]: {
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					descriptor_identity: descriptorIdentity,
					target_id: descriptor.target_id,
					model_ref: modelRef,
					selector,
					invocation_args: [],
					tested_at: nowIso,
				},
			},
		};
		const report = evaluateRealRosterCoherence(roster, { nowIso });
		strictEqual(report.ok, true);
		ok(
			report.eligibleByClass.standard.some(
				(entry) => entry.targetId === "antigravity-claude",
			),
		);
		ok(report.excludedTargets.includes("antigravity"));
	});
});
