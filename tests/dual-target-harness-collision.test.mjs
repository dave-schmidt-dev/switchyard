// Task C.4 (antigravity-buckets-consolidation plan): regression fixture for the
// "collision cluster" — two SIMULTANEOUSLY-`enabled: true` roster targets
// sharing one harness ("agy"), the shape introduced by Task C.2 (the
// "Antigravity (Claude)" bucket living alongside the pre-existing "Antigravity"
// Gemini bucket).
//
// This is a NEW failure mode, distinct from the pre-existing
// tests/provenance.test.mjs "shared harness" test (opencode-go/opencode-zen):
// that fixture models the EXCLUSIVE-ALTERNATIVE case (only one of the two
// targets is ever enabled at a time — a billing-account swap), where
// findTargetEntryForHarness's "first enabled wins" tie-break is the correct,
// intended behavior. Here BOTH targets are enabled at once and must resolve
// INDEPENDENTLY — the tie-break is the bug, not the fix.
//
// Per SR-2 (plan): this file must be confirmed FAILING against pre-fix code
// before any of Tasks C.5/C.6/C.7/C.8 land, then passing after.
//
// Fixture (tests/fixtures/roster.dual-agy.fixture.json) deliberately declares
// "antigravity-claude" BEFORE "antigravity" in the targets object -- the
// OPPOSITE of the real roster.json's declaration order -- so a fix that
// resolves correctly only by accidental object-iteration-order the real
// roster happens to have would fail here. Both targets carry a distinct
// `snapshot_name` field (the disambiguation mechanism this task's fixes
// introduce) and a distinct `credential_profile`, so every assertion below can
// tell the two targets apart unambiguously.

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getCapabilityClass,
	getModelForCapability,
	getRightSizedModel,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
	resolveRouteProvenance,
	resolveTargetIdentity,
	resolveTargetProvenance,
} from "../src/switchyard/roster/index.mjs";
import { route, routeBlind } from "../src/switchyard/router/index.mjs";
import {
	executeTask,
	executeTaskWithOrchestrator,
} from "../src/switchyard/runner/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.dual-agy.fixture.json",
);

const ANTIGRAVITY = "Antigravity";
const ANTIGRAVITY_CLAUDE = "Antigravity (Claude)";

const SNAPSHOT_PATH = join(
	tmpdir(),
	`switchyard-dual-agy-${process.pid}-${randomUUID()}.json`,
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
		// ignore
	}
});

function writeSnapshot(providers) {
	writeFileSync(
		SNAPSHOT_PATH,
		JSON.stringify({ schema_version: 2, providers }),
		"utf8",
	);
}

function removeSnapshot() {
	try {
		rmSync(SNAPSHOT_PATH, { force: true });
	} catch {
		// ignore
	}
}

describe("capability gate functions resolve each agy target INDEPENDENTLY (C.5/C.6)", () => {
	it("getModelForCapability returns the CORRECT target's selector for each snapshot name", () => {
		strictEqual(
			getModelForCapability(ANTIGRAVITY_CLAUDE, "standard"),
			"fixture-agy-claude-standard",
		);
		strictEqual(
			getModelForCapability(ANTIGRAVITY, "standard"),
			"fixture-agy-gemini-standard",
		);
		notStrictEqual(
			getModelForCapability(ANTIGRAVITY_CLAUDE, "standard"),
			getModelForCapability(ANTIGRAVITY, "standard"),
			"the two agy-harness targets must never collapse to the same model",
		);
	});

	it("getRightSizedModel is consistent with getModelForCapability for both targets", () => {
		strictEqual(
			getRightSizedModel(ANTIGRAVITY_CLAUDE, "standard"),
			"fixture-agy-claude-standard",
		);
		strictEqual(
			getRightSizedModel(ANTIGRAVITY, "standard"),
			"fixture-agy-gemini-standard",
		);
	});

	it("getCapabilityClass / passesCapabilityFilter reflect each target's OWN technical_ceiling", () => {
		strictEqual(getCapabilityClass(ANTIGRAVITY_CLAUDE), "standard");
		strictEqual(getCapabilityClass(ANTIGRAVITY), "standard");
		strictEqual(passesCapabilityFilter(ANTIGRAVITY_CLAUDE, "standard"), true);
		strictEqual(passesCapabilityFilter(ANTIGRAVITY, "standard"), true);
		// Neither target's fixture qualifies a high slot -> both fail high.
		strictEqual(passesCapabilityFilter(ANTIGRAVITY_CLAUDE, "high"), false);
		strictEqual(passesCapabilityFilter(ANTIGRAVITY, "high"), false);
	});

	it("PROVIDER_CAPABILITIES stays harness-keyed (no snapshot_name pollution of Object.keys)", () => {
		// Task C.5 must NOT fix this by adding snapshot-name keys directly onto
		// the harness-keyed PROVIDER_CAPABILITIES table: router/index.mjs's blind
		// fallback reads Object.keys(PROVIDER_CAPABILITIES) directly (line ~135)
		// to build its candidate order, and that list must contain "agy" exactly
		// once, not once per agy-harness target. Disambiguation must live in a
		// path getCapabilityClass/getModelForCapability consult BEFORE falling back to
		// the harness-keyed table, not in the table's own key set.
		const keys = Object.keys(PROVIDER_CAPABILITIES);
		const agyCount = keys.filter((k) => k === "agy").length;
		strictEqual(agyCount, 1, `expected exactly one "agy" key, got: ${keys}`);
		ok(
			!keys.includes(ANTIGRAVITY) && !keys.includes(ANTIGRAVITY_CLAUDE),
			`PROVIDER_CAPABILITIES keys must not include raw snapshot names, got: ${keys}`,
		);
	});
});

describe("route() gives each agy target independent candidacy (C.5/C.6)", () => {
	it("routes to the Claude bucket's model when it has the most headroom", () => {
		writeSnapshot([
			{
				name: ANTIGRAVITY_CLAUDE,
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 0 }],
			},
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 40, pace_delta: 0 }],
			},
		]);
		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, ANTIGRAVITY_CLAUDE);
		strictEqual(result.model, "fixture-agy-claude-standard");
		strictEqual(result.resolvedTargetId, "antigravity-claude");
	});

	it("routes to the Gemini bucket's model when IT has the most headroom (winner flips, model follows)", () => {
		writeSnapshot([
			{
				name: ANTIGRAVITY_CLAUDE,
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 0 }],
			},
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 95, pace_delta: 0 }],
			},
		]);
		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, ANTIGRAVITY);
		strictEqual(result.model, "fixture-agy-gemini-standard");
		strictEqual(result.resolvedTargetId, "antigravity");
	});

	it("both agy-harness snapshot entries are scored as independent candidates, not collapsed to one", () => {
		// Both present and eligible -> both must appear in the routing log as
		// distinct, independently-evaluated candidates (proves the scoring loop
		// itself sees two entries, not that one shadows the other before scoring
		// even starts).
		writeSnapshot([
			{
				name: ANTIGRAVITY_CLAUDE,
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 0 }],
			},
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 0 }],
			},
		]);
		const result = route({ requiredCapability: "standard" });
		const mentionsClaude = result.log.some((line) =>
			line.includes(ANTIGRAVITY_CLAUDE),
		);
		const mentionsGemini = result.log.some(
			(line) =>
				line.includes(ANTIGRAVITY) && !line.includes(ANTIGRAVITY_CLAUDE),
		);
		ok(
			mentionsClaude,
			`expected log to mention ${ANTIGRAVITY_CLAUDE}: ${result.log}`,
		);
		ok(mentionsGemini, `expected log to mention ${ANTIGRAVITY}: ${result.log}`);
	});

	it("blind fallback quarantines an ambiguous shared harness instead of choosing a target", () => {
		removeSnapshot();
		const result = route({ requiredCapability: "standard" });
		ok(
			result.log.some((line) => line.startsWith("snapshot missing")),
			"expected the blind-routing path to have been taken",
		);
		const blindLine = result.log.find((line) =>
			line.startsWith("blind candidates:"),
		);
		ok(blindLine, `expected a blind candidates log line, got: ${result.log}`);
		strictEqual(result.provider, "claude");
		strictEqual(result.resolvedTargetId, "claude-code");
		ok(
			result.log.some((line) =>
				line.includes("ambiguous blind targets skipped: agy"),
			),
			`expected agy to be quarantined, got: ${result.log}`,
		);
		const agyOccurrences = (blindLine.match(/\bagy\b/g) ?? []).length;
		strictEqual(
			agyOccurrences,
			0,
			`ambiguous agy must not appear in blind candidates, got: ${blindLine}`,
		);
	});

	it("rejects a harness alias that maps to two enabled targets", () => {
		strictEqual(resolveTargetIdentity("agy").ambiguous, true);
		const result = route({
			requiredCapability: "standard",
			only: ["agy"],
		});
		strictEqual(result.provider, null);
		strictEqual(result.resolvedTargetId, null);
		strictEqual(result.reason, "ambiguous_target");
	});

	it("routeBlind also fails closed for an ambiguous shared harness", () => {
		const result = routeBlind(["agy"]);
		strictEqual(result.provider, null);
		strictEqual(result.reason, "quarantine_unresolvable");
	});

	it("allows an exact target id to select only its shared-harness target", () => {
		writeSnapshot([
			{
				name: ANTIGRAVITY_CLAUDE,
				ok: true,
				windows: [{ percent_left: 40, pace_delta: 0 }],
			},
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 95, pace_delta: 0 }],
			},
		]);
		const result = route({
			requiredCapability: "standard",
			only: ["antigravity-claude"],
		});
		strictEqual(result.provider, ANTIGRAVITY_CLAUDE);
		strictEqual(result.resolvedTargetId, "antigravity-claude");
	});
});

describe("resolveTargetProvenance / resolveRouteProvenance resolve each target's OWN identity (C.8)", () => {
	it("resolves the Claude bucket's target id, selector, and credential_profile", () => {
		deepStrictEqual(resolveTargetProvenance(ANTIGRAVITY_CLAUDE, "standard"), {
			resolved_target: "antigravity-claude",
			resolved_harness: "agy",
			resolved_selector: "fixture-agy-claude-standard",
			resolved_credential_profile: "claude-profile",
		});
	});

	it("resolves the Gemini bucket's target id, selector, and credential_profile", () => {
		deepStrictEqual(resolveTargetProvenance(ANTIGRAVITY, "standard"), {
			resolved_target: "antigravity",
			resolved_harness: "agy",
			resolved_selector: "fixture-agy-gemini-standard",
			resolved_credential_profile: "gemini-profile",
		});
	});

	it("the two directions never cross — provenance never attributes one bucket's dispatch to the other", () => {
		const claudeProv = resolveRouteProvenance(ANTIGRAVITY_CLAUDE, "standard");
		const geminiProv = resolveRouteProvenance(ANTIGRAVITY, "standard");
		notStrictEqual(claudeProv.resolved_target, geminiProv.resolved_target);
		notStrictEqual(claudeProv.resolved_selector, geminiProv.resolved_selector);
		notStrictEqual(
			claudeProv.resolved_credential_profile,
			geminiProv.resolved_credential_profile,
		);
		strictEqual(claudeProv.resolved_target, "antigravity-claude");
		strictEqual(geminiProv.resolved_target, "antigravity");
	});
});

describe("executeTask / executeTaskWithOrchestrator dispatch the CORRECT selector per target (C.7 proof)", () => {
	function makeAdapterContext({ provider, model }) {
		const executeCalls = [];
		return {
			context: {
				route: () => ({
					provider,
					model,
					percentLeft: 50,
					reason: "spread",
					log: [],
				}),
				adapters: {
					agy: {
						execute: (_prompt, _containerName, opts) => {
							executeCalls.push(opts);
							return { success: true };
						},
						captureDiff: () => "",
					},
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true }),
				projectPath: "/tmp/does-not-matter",
				workingContainerName: "test-container",
				exclude: [],
			},
			executeCalls,
		};
	}

	const TASK = {
		id: "T-dual-agy",
		title: "trivial task",
		description: "trivial task",
		prompt: "do the thing",
		requiredPaths: null,
	};

	it("executeTask passes the Claude bucket's model to the SAME 'agy' adapter", () => {
		const { context, executeCalls } = makeAdapterContext({
			provider: ANTIGRAVITY_CLAUDE,
			model: "fixture-agy-claude-standard",
		});
		const result = executeTask(TASK, context);
		strictEqual(result.result, "success_no_diff");
		strictEqual(executeCalls.length, 1);
		strictEqual(executeCalls[0].model, "fixture-agy-claude-standard");
	});

	it("executeTask passes the Gemini bucket's model to the SAME 'agy' adapter", () => {
		const { context, executeCalls } = makeAdapterContext({
			provider: ANTIGRAVITY,
			model: "fixture-agy-gemini-standard",
		});
		const result = executeTask(TASK, context);
		strictEqual(result.result, "success_no_diff");
		strictEqual(executeCalls.length, 1);
		strictEqual(executeCalls[0].model, "fixture-agy-gemini-standard");
	});

	function makeOrchestratorContext({ provider, model }) {
		const launchCalls = [];
		return {
			context: {
				route: () => ({
					provider,
					model,
					percentLeft: 50,
					reason: "spread",
					log: [],
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true }),
				projectPath: "/tmp/does-not-matter",
				workingContainerName: "test-container",
				exclude: [],
				orchestrator: {
					launch: async (payload) => {
						launchCalls.push(payload);
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
			launchCalls,
		};
	}

	it("executeTaskWithOrchestrator forwards the Claude bucket's model into orchestrator.launch", async () => {
		const { context, launchCalls } = makeOrchestratorContext({
			provider: ANTIGRAVITY_CLAUDE,
			model: "fixture-agy-claude-standard",
		});
		await executeTaskWithOrchestrator(TASK, context);
		strictEqual(launchCalls.length, 1);
		strictEqual(launchCalls[0].provider, ANTIGRAVITY_CLAUDE);
		strictEqual(launchCalls[0].model, "fixture-agy-claude-standard");
	});

	it("executeTaskWithOrchestrator forwards the Gemini bucket's model into orchestrator.launch", async () => {
		const { context, launchCalls } = makeOrchestratorContext({
			provider: ANTIGRAVITY,
			model: "fixture-agy-gemini-standard",
		});
		await executeTaskWithOrchestrator(TASK, context);
		strictEqual(launchCalls.length, 1);
		strictEqual(launchCalls[0].provider, ANTIGRAVITY);
		strictEqual(launchCalls[0].model, "fixture-agy-gemini-standard");
	});
});
