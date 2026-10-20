// @test-phase: serial
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getConfiguredInvocationDescriptor } from "../src/switchyard/roster/descriptors.mjs";
import {
	__resetRosterCacheForTests,
	resolveTargetIdentity,
} from "../src/switchyard/roster/index.mjs";
import { route } from "../src/switchyard/router/index.mjs";
import { SIMPLE_TARGET_ADAPTERS } from "../src/switchyard/simple/args.mjs";
import { routeDiagnosticPatch } from "../src/switchyard/simple/route-evidence.mjs";
import { createSimpleRouteSelection } from "../src/switchyard/simple/route-selection.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import { realSelectionEngine } from "./helpers/real-route-selection.mjs";
import { withDispatchQualifiedDescriptors } from "./helpers/router-fixtures.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Scarecrow 0.4.0 beta (2026-10-09): `--capability high` returned
// no_route_available with no list of the targets considered. A no-route
// result must name every considered target with a closed reason.
const ENV_KEYS = [
	"SWITCHYARD_ROSTER_PATH",
	"SWITCHYARD_SNAPSHOT_PATH_OVERRIDE",
	"SWITCHYARD_RUN_STORE_ROOT",
];
const previousEnv = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);
let snapshotPath;

/** The shared roster fixture plus the two adapter targets it lacks. */
function writeRoster(dir) {
	const roster = JSON.parse(
		readFileSync(new URL("./fixtures/roster.fixture.json", import.meta.url)),
	);
	roster.models["fixture/agy-claude-high"] = {
		selector: "claude-sonnet-4-6",
		base_model: "claude-sonnet-4-6",
		model_provider: "fixture",
		status: "active",
	};
	roster.targets["antigravity-claude"] = {
		harness: "agy",
		snapshot_name: "Antigravity (Claude)",
		credential_profile: "default",
		enabled: true,
		technical_ceiling: "high",
		implementor_priority: 1,
		qualifications: { "claude-sonnet-4-6": { status: "qualified" } },
		slots: {
			low: [],
			standard: [],
			high: [{ model_ref: "fixture/agy-claude-high", priority: 1 }],
		},
	};
	roster.targets["vibe-code"] = {
		...structuredClone(roster.targets.vibe),
		snapshot_name: "Vibe Code",
	};
	const path = join(dir, "roster.json");
	writeFileSync(path, JSON.stringify(withDispatchQualifiedDescriptors(roster)));
	return path;
}

function writeSnapshot(providers) {
	writeFileSync(
		snapshotPath,
		JSON.stringify({
			schema_version: 2,
			updated_at: new Date().toISOString(),
			providers,
		}),
	);
}
const window = (percentLeft) => ({
	id: "five_hour",
	percent_left: percentLeft,
	pace_delta: 1,
});

before(() => {
	const dir = tempDir("switchyard-no-route-evidence-");
	snapshotPath = join(dir, "snapshot.json");
	process.env.SWITCHYARD_ROSTER_PATH = writeRoster(dir);
	process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = snapshotPath;
	process.env.SWITCHYARD_RUN_STORE_ROOT = join(dir, "runs-root");
	__resetRosterCacheForTests();
});

after(() => {
	for (const key of ENV_KEYS) {
		if (previousEnv[key] === undefined) delete process.env[key];
		else process.env[key] = previousEnv[key];
	}
	__resetRosterCacheForTests();
});

function highFixture(options = {}) {
	// Antigravity (Claude) is the only high-capable tier target, and it has no
	// usage snapshot entry.
	writeSnapshot([
		{ name: "antigravity", ok: true, windows: [window(80)] },
		{ name: "copilot-student", ok: true, windows: [window(80)] },
		{ name: "codex", ok: true, windows: [window(80)] },
	]);
	const f = fixture({});
	delete f.deps.route;
	delete f.deps.getImplementorPriority;
	f.deps.resolveTargetIdentity = resolveTargetIdentity;
	f.deps.assertFundedRoute = () => {};
	f.deps.runSimpleTask = realSelectionEngine(
		f,
		getConfiguredInvocationDescriptor,
	);
	f.deps.onRoutingWarning = () => {};
	f.options = { ...f.options, capability: "high", ...options };
	return f;
}

const reasons = (result) =>
	Object.fromEntries(
		Object.entries(
			Object.groupBy(result.routeEvidence.excluded, (entry) => entry.targetId),
		).map(([targetId, entries]) => [
			targetId,
			entries.map((entry) => entry.reason),
		]),
	);

test("a --capability high no-route result names every considered target with its reason", async () => {
	const f = highFixture();
	const result = await runSimpleRoutingTask(f.options, f.deps);
	// Decision fields: identical before and after the report-only change.
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "capacity");
	strictEqual(result.stopReason, undefined);
	deepStrictEqual(f.calls, []);
	strictEqual(result.routeEvidence.selectedTargetId, null);
	deepStrictEqual(reasons(result), {
		// The router still evaluates the Antigravity snapshot entry, which
		// shares its harness with the offered Antigravity (Claude).
		antigravity: [
			"invocation_descriptor_unavailable",
			"below_required_capability",
		],
		"copilot-student": ["invocation_descriptor_unavailable"],
		"opencode-go": ["invocation_descriptor_unavailable"],
		vibe: ["below_required_capability"],
		"vibe-code": ["below_required_capability"],
		"claude-code": ["pin_required"],
		codex: ["tier_excluded"],
		"antigravity-claude": ["not_in_usage_snapshot"],
	});
	// Every adapter target is named; none only as a removal artifact.
	deepStrictEqual(
		Object.keys(reasons(result)).sort(),
		SIMPLE_TARGET_ADAPTERS.map((adapter) => adapter.targetId).sort(),
	);
});

test("a pinned no-route result names only the pinned target", async () => {
	const f = highFixture({ onlyProviders: ["vibe"] });
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "stop");
	deepStrictEqual(f.calls, []);
	deepStrictEqual(reasons(result), {
		vibe: ["invocation_descriptor_unavailable"],
	});
});

test("a router without evidence still leaves no considered target unnamed", async () => {
	const f = highFixture();
	f.deps.route = () => ({ provider: null, reason: "no_eligible" });
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	deepStrictEqual(f.calls, []);
	const named = reasons(result);
	// An injected router keeps every target in the implementor tier.
	deepStrictEqual(named["antigravity-claude"], ["not_evaluated"]);
	deepStrictEqual(named.codex, ["not_evaluated"]);
	deepStrictEqual(named["claude-code"], ["pin_required"]);
	deepStrictEqual(
		Object.keys(named).sort(),
		SIMPLE_TARGET_ADAPTERS.map((adapter) => adapter.targetId).sort(),
	);
});

// Codex review (2026-10-19): with the evidence bound nearly full, the added
// report entries pushed the router's health entry past it, and a health block
// was reported as no_eligible_provider. 57 exclusions is the most the
// previous release still kept ahead of the health entry; 63 fills the
// router's own 64-entry bound, where that release already lost it.
const fillerReasons = [
	"no_quota_headroom",
	"budget_pace_exceeded",
	"provider_unavailable",
	"qualification_missing",
	"qualification_expired",
	"not_configured",
	"no_valid_windows",
	"accounting_bucket_unavailable",
];
function healthBoundRouter(fillerCount) {
	const filler = fillerReasons
		.flatMap((reason) =>
			SIMPLE_TARGET_ADAPTERS.map(({ targetId }) => ({ targetId, reason })),
		)
		.slice(0, fillerCount);
	return () => ({
		provider: null,
		reason: "no_eligible",
		routeEvidence: {
			schemaVersion: 1,
			candidates: [],
			excluded: [
				...filler,
				{ targetId: "codex", reason: "route_health_suppressed" },
			],
		},
	});
}

for (const fillerCount of [57, 63])
	test(`report-only evidence never hides a health block behind ${fillerCount} exclusions`, async () => {
		const { selectSimpleRoute } = createSimpleRouteSelection({
			options: {
				capability: "standard",
				projectPath: tempDir("switchyard-health-bound-project-"),
				checks: [],
				deadlineMs: Date.now() + 3_600_000,
			},
			resolveIdentity: resolveTargetIdentity,
			descriptorFor: getConfiguredInvocationDescriptor,
			routeProvider: healthBoundRouter(fillerCount),
			healthController: { prepare: async () => ({ allowed: true }) },
			now: Date.now,
			stateRoot: tempDir("switchyard-health-bound-state-"),
			funded: () => {},
			onDecision: async () => {},
		});
		deepStrictEqual(await selectSimpleRoute(), {
			error: "route_health_blocked",
		});
	});

test("the evidence bound keeps a raw router's health entry and the order of the rest", () => {
	const routed = healthBoundRouter(64)();
	const excluded = routeDiagnosticPatch(routed).routeEvidence.excluded;
	strictEqual(excluded.length, 64);
	deepStrictEqual(
		excluded.slice(0, 63),
		routed.routeEvidence.excluded.slice(0, 63),
	);
	deepStrictEqual(excluded[63], {
		targetId: "codex",
		reason: "route_health_suppressed",
	});
});

test("a routing run keeps a health block at the evidence bound", async () => {
	const f = highFixture({ capability: "standard" });
	f.deps.route = healthBoundRouter(57);
	const result = await runSimpleRoutingTask(f.options, f.deps);
	deepStrictEqual(f.calls, []);
	strictEqual(result.result.failureReason, "route_health_blocked");
	// The previous release's direction for the same input.
	strictEqual(result.direction, "native_required");
});

test("the router names an offered target missing from the usage snapshot without changing its choice", () => {
	writeSnapshot([{ name: "antigravity", ok: true, windows: [window(80)] }]);
	const input = {
		requiredCapability: "standard",
		platform: "direct",
		hasInvocationDescriptor: () => true,
	};
	const without = route({ ...input, availableProviders: ["antigravity"] });
	const withMissing = route({
		...input,
		availableProviders: ["antigravity", "copilot-student"],
	});
	strictEqual(withMissing.provider, without.provider);
	strictEqual(withMissing.reason, without.reason);
	ok(without.provider, JSON.stringify(without.routeEvidence));
	deepStrictEqual(withMissing.routeEvidence.excluded, [
		...without.routeEvidence.excluded,
		{ targetId: "copilot-student", reason: "not_in_usage_snapshot" },
	]);
});
