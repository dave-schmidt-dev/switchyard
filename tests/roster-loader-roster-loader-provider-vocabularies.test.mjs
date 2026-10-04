import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	evaluateRealRosterCoherence,
	formatRealRosterCoherenceFailure,
	getInvocationDescriptor,
	getInvocationDescriptorIdentity,
	mapInvocationArgs,
	PROVIDER_INVOCATION_VOCABULARY,
	QUALIFICATION_STATUS,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
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
		deepStrictEqual(mapInvocationArgs("opencode", { variant: "default" }), []);
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
