import { deepStrictEqual, strictEqual } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	CAPABILITY_CLASS,
	CAPABILITY_CLASS_ORDER,
	filterByCapability,
	getCapabilityClass,
	getImplementorPriority,
	getModelForCapability,
	getRightSizedModel,
	normalizeProviderName,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
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

	it("getImplementorPriority resolves an exact target id, even when it shares a harness with an earlier target", () => {
		tmpDir = tempDir("switchyard-roster-loader-");
		const rosterPath = join(tmpDir, "shared-harness.json");
		const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
		roster.targets["antigravity-second"] = {
			...roster.targets.antigravity,
			implementor_priority: 2,
		};
		writeFileSync(rosterPath, JSON.stringify(roster));
		setRosterPath(rosterPath);
		strictEqual(getImplementorPriority("antigravity"), 1);
		strictEqual(getImplementorPriority("antigravity-second"), 2);
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
