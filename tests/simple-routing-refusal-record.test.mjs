// @test-phase: serial
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	__resetRosterCacheForTests,
	resolveTargetIdentity,
} from "../src/switchyard/roster/index.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	openRoutingRun,
	readRoutingRunRefusals,
	readRoutingRunState,
} from "../src/switchyard/simple/routing-state.mjs";
import {
	appendRouteRefusals,
	MAX_ROUTE_REFUSAL_RECORDS,
	MAX_ROUTE_REFUSALS_PER_CALL,
	ROUTE_REFUSALS_FILE,
	readRouteRefusals,
} from "../src/switchyard/simple/routing-state-refusals.mjs";
import { realSelectionEngine } from "./helpers/real-route-selection.mjs";
import { withDispatchQualifiedDescriptors } from "./helpers/router-fixtures.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Real route-selection, real production router and a fixture snapshot.
const ENV_KEYS = [
	"SWITCHYARD_ROSTER_PATH",
	"SWITCHYARD_SNAPSHOT_PATH_OVERRIDE",
	"SWITCHYARD_RUN_STORE_ROOT",
];
const previousEnv = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);
let snapshotPath;

const DESCRIPTORS = {
	antigravity: {
		target_id: "antigravity",
		selector: "gemini-3.8-flash-medium",
		invocation_args: [],
	},
	"opencode-go": {
		target_id: "opencode-go",
		selector: "opencode-go/deepseek-v4.1-flash",
		invocation_args: ["--variant", "max"],
	},
};

function writeRoster(dir) {
	const roster = withDispatchQualifiedDescriptors({
		schema_version: 1,
		models: {
			"t/agy-standard": {
				selector: "gemini-3.8-flash-medium",
				base_model: "gemini-3.8-flash-medium",
				model_provider: "fixture",
				status: "active",
			},
			"t/oc-standard": {
				selector: "opencode-go/deepseek-v4.1-flash",
				base_model: "deepseek-v4.1-flash",
				model_provider: "fixture",
				status: "active",
			},
		},
		targets: {
			antigravity: {
				harness: "agy",
				credential_profile: "default",
				enabled: true,
				technical_ceiling: "standard",
				implementor_priority: 1,
				qualifications: {
					"gemini-3.8-flash-medium": { status: "qualified" },
				},
				slots: {
					low: [],
					standard: [{ model_ref: "t/agy-standard", priority: 1 }],
					high: [],
				},
			},
			"opencode-go": {
				harness: "opencode",
				credential_profile: "go",
				enabled: true,
				technical_ceiling: "standard",
				implementor_priority: 2,
				qualifications: {
					"opencode-go/deepseek-v4.1-flash@max": { status: "qualified" },
				},
				slots: {
					low: [],
					standard: [
						{
							model_ref: "t/oc-standard",
							priority: 1,
							variant: "max",
							invocation_args: ["--variant", "max"],
						},
					],
					high: [],
				},
			},
		},
	});
	const path = join(dir, "roster.json");
	writeFileSync(path, JSON.stringify(roster), "utf8");
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
		"utf8",
	);
}

const window = (percentLeft) => ({
	id: "five_hour",
	percent_left: percentLeft,
	pace_delta: 1,
});

before(() => {
	const dir = tempDir("switchyard-refusal-record-");
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

function p6Fixture() {
	writeSnapshot([
		{ name: "antigravity", ok: true, windows: [window(80)] },
		{ name: "opencode-go", ok: true, windows: [window(90)] },
	]);
	const f = fixture({
		antigravity: {
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "quota_exhausted",
					phase: "provider",
				}),
			},
		},
	});
	delete f.deps.route;
	delete f.deps.getImplementorPriority;
	f.deps.resolveTargetIdentity = resolveTargetIdentity;
	f.deps.assertFundedRoute = (targetId) => {
		if (targetId === "opencode-go")
			throw Object.assign(new Error("included usage unverified"), {
				code: "included_usage_unverified",
			});
	};
	f.deps.runSimpleTask = realSelectionEngine(
		f,
		(targetId) => DESCRIPTORS[targetId] ?? null,
	);
	f.deps.onRoutingWarning = () => {};
	return f;
}

const reasonsFor = (excluded, targetId) =>
	excluded
		.filter((entry) => entry.targetId === targetId)
		.map((entry) => entry.reason);

// P6 rr-p6-timeouts-v4 (2026-10-09): antigravity failed quota_exhausted, then
// the second route returned no_eligible_provider while OpenCode Go was
// eligible on quota. The funding refusal must be recorded in the result
// envelope and in the routing state.
test("the P6 two-route sequence records the funding refusal in the envelope", async () => {
	const f = p6Fixture();
	const result = await runSimpleRoutingTask(f.options, f.deps);
	// Decision fields: identical before and after the report-only change.
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "capacity");
	strictEqual(result.stopReason, undefined);
	deepStrictEqual(f.calls, ["antigravity"]);
	ok(
		reasonsFor(result.routeEvidence.excluded, "opencode-go").includes(
			"included_usage_unverified",
		),
		JSON.stringify(result.routeEvidence.excluded),
	);
});

const refusalsOf = (f, runId = "run-1") =>
	readRoutingRunRefusals(f.options.projectPath, runId, {
		stateRoot: f.deps.stateRoot,
	});

test("the P6 two-route sequence persists each route call's refusals beside the routing state", async () => {
	const f = p6Fixture();
	await runSimpleRoutingTask(f.options, f.deps);
	const unrouted = refusalsOf(f).at(-1);
	ok(unrouted, "no refusal record");
	strictEqual(unrouted.selectedTargetId, null);
	ok(
		reasonsFor(unrouted.excluded, "opencode-go").includes(
			"included_usage_unverified",
		),
		JSON.stringify(unrouted.excluded),
	);
	ok(
		reasonsFor(unrouted.excluded, "antigravity").length > 0,
		JSON.stringify(unrouted.excluded),
	);
	// state.json keeps the exact key set earlier releases validate.
	ok(
		!Object.hasOwn(
			readRoutingRunState(f.options.projectPath, "run-1", {
				stateRoot: f.deps.stateRoot,
			}),
			"routeRefusals",
		),
	);
});

test("each route call's record names the allocated target and that call's refusals", async () => {
	const f = p6Fixture();
	await runSimpleRoutingTask(f.options, f.deps);
	const records = refusalsOf(f);
	deepStrictEqual(
		records.map((record) => record.selectedTargetId),
		["antigravity", null],
	);
	// The funding refusal belongs to the second call only.
	deepStrictEqual(reasonsFor(records[0].excluded, "opencode-go"), []);
});

function stubFixture(overrides = {}) {
	const f = fixture({
		__targets: ["antigravity", "opencode-go"],
		...overrides,
	});
	f.deps.onRoutingWarning = () => {};
	return f;
}

test("a target this task already failed is refused as failed_this_task", async () => {
	const f = stubFixture({ antigravity: { status: "failed" } });
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity", "opencode-go"]);
	deepStrictEqual(reasonsFor(result.routeEvidence.excluded, "antigravity"), [
		"failed_this_task",
	]);
	const second = refusalsOf(f)[1];
	strictEqual(second.selectedTargetId, "opencode-go");
	deepStrictEqual(second.excluded, [
		{ targetId: "antigravity", reason: "failed_this_task" },
	]);
});

test("a target another task failed in this routing run is refused as failed_in_routing_run", async () => {
	const f = stubFixture({ antigravity: { status: "failed" } });
	await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(
		readRoutingRunState(f.options.projectPath, "run-1", {
			stateRoot: f.deps.stateRoot,
		}).failedTargetIds.includes("antigravity"),
		true,
	);
	const result = await runSimpleRoutingTask(
		{ ...f.options, files: ["b.txt"] },
		f.deps,
	);
	strictEqual(result.direction, "complete");
	deepStrictEqual(reasonsFor(result.routeEvidence.excluded, "antigravity"), [
		"failed_in_routing_run",
	]);
});

test("a funding refusal keeps its own reason on later route calls", async () => {
	const f = stubFixture({ antigravity: { status: "failed" } });
	f.deps.assertFundedRoute = (targetId) => {
		if (targetId === "opencode-go")
			throw Object.assign(new Error("paid overage not allowed"), {
				code: "paid_overage_not_allowed",
			});
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "native_required");
	strictEqual(result.exhaustionCause, "task_failures");
	deepStrictEqual(f.calls, ["antigravity"]);
	deepStrictEqual(
		refusalsOf(f).map((record) => [
			record.selectedTargetId,
			reasonsFor(record.excluded, "opencode-go"),
		]),
		[
			["antigravity", []],
			[null, ["paid_overage_not_allowed"]],
		],
	);
});

// The routing answer fields a refusal record must never change.
const decision = (f, result) => ({
	direction: result.direction,
	stopReason: result.stopReason,
	exhaustionCause: result.exhaustionCause,
	calls: f.calls,
	attempts: result.attempts.map((a) => [a.targetId, a.terminal, a.reason]),
});

async function withRefusalFile(
	prepare,
	{ throwOnRefusalWarning = false } = {},
) {
	const baseline = stubFixture({ antigravity: { status: "failed" } });
	const expected = decision(
		baseline,
		await runSimpleRoutingTask(baseline.options, baseline.deps),
	);
	const f = stubFixture({ antigravity: { status: "failed" } });
	const warnings = [];
	f.deps.onRoutingWarning = (line) => {
		warnings.push(line);
		if (throwOnRefusalWarning && line.includes("route refusal record"))
			throw new Error("warning sink unavailable");
	};
	const handle = openRoutingRun(f.options.projectPath, "run-1", {
		stateRoot: f.deps.stateRoot,
	});
	handle.release();
	prepare(join(handle.runDir, ROUTE_REFUSALS_FILE));
	const result = await runSimpleRoutingTask(f.options, f.deps);
	deepStrictEqual(decision(f, result), expected);
	return { f, warnings };
}

test("a refusal record that cannot be written warns and leaves the routing answer unchanged", async () => {
	const { f, warnings } = await withRefusalFile((path) => mkdirSync(path));
	deepStrictEqual(refusalsOf(f), []);
	deepStrictEqual(
		[...new Set(warnings)],
		["dispatch: route refusal record unavailable (routing_unsafe_file)"],
	);
});

// Codex review (2026-10-19): a throwing warning sink must not carry the
// write failure into the route, which may already have committed its
// pending attempt.
test("a refusal record failure with a failing warning sink leaves the routing answer unchanged", async () => {
	const { f, warnings } = await withRefusalFile((path) => mkdirSync(path), {
		throwOnRefusalWarning: true,
	});
	deepStrictEqual(refusalsOf(f), []);
	ok(warnings.some((line) => line.includes("route refusal record")));
});

test("an unreadable refusal record file leaves the routing answer unchanged and is replaced", async () => {
	const { f, warnings } = await withRefusalFile((path) => {
		writeFileSync(path, "{not json", { mode: 0o600 });
		chmodSync(path, 0o600);
	});
	deepStrictEqual(warnings, []);
	deepStrictEqual(
		refusalsOf(f).map((record) => record.selectedTargetId),
		["antigravity", "opencode-go"],
	);
});

test("refusal records keep the newest calls, close unknown reasons and drop malformed entries", () => {
	const dir = tempDir("refusal-bounds");
	for (let index = 0; index < MAX_ROUTE_REFUSAL_RECORDS + 3; index += 1)
		appendRouteRefusals(dir, {
			taskId: `task-${index}`,
			attemptId: `attempt-${index}`,
			at: new Date(Date.UTC(2026, 9, 19, 0, 0, index)).toISOString(),
			selectedTargetId: "Not A Target",
			excluded: [
				{ targetId: "codex", reason: "tier_excluded", bucket: "ac" },
				{ targetId: "codex", reason: "free-form text" },
				{ targetId: "../escape", reason: "tier_excluded" },
				...Array.from({ length: MAX_ROUTE_REFUSALS_PER_CALL }, () => ({
					targetId: "vibe",
					reason: "tier_excluded",
				})),
			],
		});
	// A record without a usable identity is not written at all.
	appendRouteRefusals(dir, { taskId: "", attemptId: "a", at: "x" });
	const records = readRouteRefusals(dir);
	strictEqual(records.length, MAX_ROUTE_REFUSAL_RECORDS);
	strictEqual(records[0].taskId, "task-3");
	const newest = records.at(-1);
	strictEqual(newest.taskId, `task-${MAX_ROUTE_REFUSAL_RECORDS + 2}`);
	strictEqual(newest.selectedTargetId, null);
	strictEqual(newest.excluded.length, MAX_ROUTE_REFUSALS_PER_CALL);
	deepStrictEqual(newest.excluded.slice(0, 2), [
		{ targetId: "codex", reason: "tier_excluded", bucket: "ac" },
		{ targetId: "codex", reason: "unknown" },
	]);
	const path = join(dir, ROUTE_REFUSALS_FILE);
	const stored = JSON.parse(readFileSync(path, "utf8"));
	strictEqual(stored.schemaVersion, 1);
	// A record with unexpected keys is skipped on read, never thrown on.
	stored.records[0].note = "extra";
	writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
	strictEqual(readRouteRefusals(dir).length, MAX_ROUTE_REFUSAL_RECORDS - 1);
	deepStrictEqual(readRouteRefusals(join(dir, "missing")), []);
});
