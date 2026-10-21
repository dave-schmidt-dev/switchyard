// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { routeDiagnosticPatch } from "../src/switchyard/simple/route-evidence.mjs";
import {
	liveRouteExhaustion,
	ROUTE_EXHAUSTION_TTL_MS,
	recordRouteExhaustion,
} from "../src/switchyard/simple/route-exhaustion.mjs";
import { createSimpleRouteSelection } from "../src/switchyard/simple/route-selection.mjs";
import { runSimpleRoutingTask } from "../src/switchyard/simple/routing-run.mjs";
import {
	openRoutingRun,
	readRoutingRunState,
	recordAttemptOutcome,
} from "../src/switchyard/simple/routing-state.mjs";
import { fixture } from "./helpers/simple-routing-fixture.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const NOW = 1_800_000_000_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const recordFile = (stateRoot, targetId) =>
	join(stateRoot, "route-exhaustion", `${sha256(targetId)}.json`);
const quotaDiagnostic = () =>
	createProviderReliabilityDiagnostic({
		causeCode: "quota_exhausted",
		phase: "provider",
	});
const trustedQuotaFailure = () => {
	const providerReliability = quotaDiagnostic();
	return {
		status: "failed",
		result: { providerReliability },
		record: {
			lastFailure: {
				errorKind: "execution_failed",
				providerReliability,
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		},
	};
};

// Route evidence target ids resolve through the roster; pin a minimal fixture
// so the selection assertions do not depend on the host's real roster.
function withPinnedRoster() {
	const rosterDir = tempDir("switchyard-route-exhaustion-roster-");
	writeFileSync(
		join(rosterDir, "roster.json"),
		JSON.stringify({
			models: {},
			targets: {
				codex: { harness: "codex" },
				antigravity: { harness: "agy" },
			},
		}),
		"utf8",
	);
	const previous = process.env.SWITCHYARD_ROSTER_PATH;
	process.env.SWITCHYARD_ROSTER_PATH = join(rosterDir, "roster.json");
	__resetRosterCacheForTests();
	return () => {
		if (previous === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
		else process.env.SWITCHYARD_ROSTER_PATH = previous;
		__resetRosterCacheForTests();
	};
}

const DESCRIPTORS = {
	codex: { target_id: "codex", selector: "any-model", invocation_args: [] },
	antigravity: {
		target_id: "antigravity",
		selector: "gemini-3.8-flash-medium",
		invocation_args: [],
	},
};

function selectionFixture(stateRoot) {
	const decisions = [];
	const routed = [];
	const result = createSimpleRouteSelection({
		options: {
			capability: "standard",
			onlyProviders: [],
			projectPath: "/route-exhaustion/project",
			checks: ["true"],
		},
		resolveIdentity: (targetId) => ({
			targetId,
			harnessKey: targetId === "codex" ? "codex" : "agy",
		}),
		descriptorFor: (targetId) => DESCRIPTORS[targetId] ?? null,
		routeProvider: ({ availableProviders, exclude }) => {
			const provider = availableProviders[0];
			routed.push({
				availableProviders: [...availableProviders],
				exclude: [...exclude],
			});
			return {
				provider,
				routeEvidence: {
					schemaVersion: 1,
					snapshotStatus: "not_checked",
					snapshotMtime: null,
					snapshotAgeMsAtRoute: null,
					selectionReason: "spread",
					selectedTargetId: provider,
					candidates: [],
					excluded: [],
				},
			};
		},
		healthController: {
			decision: () => ({}),
			prepare: async () => ({ allowed: true }),
		},
		funded: () => {},
		onDecision: async (decision) => {
			decisions.push(decision);
		},
		now: () => NOW,
		stateRoot,
	});
	return { result, decisions, routed };
}

test("recordRouteExhaustion replaces the single per-target record atomically", () => {
	const stateRoot = tempDir("switchyard-route-exhaustion-");
	const first = recordRouteExhaustion("codex", { stateRoot, now: () => NOW });
	deepStrictEqual(first, {
		targetId: "codex",
		until: NOW + ROUTE_EXHAUSTION_TTL_MS,
	});
	const second = recordRouteExhaustion("codex", {
		stateRoot,
		now: () => NOW + 1000,
	});
	strictEqual(second.until, NOW + 1000 + ROUTE_EXHAUSTION_TTL_MS);
	const dir = join(stateRoot, "route-exhaustion");
	deepStrictEqual(readdirSync(dir), [`${sha256("codex")}.json`]);
	deepStrictEqual(
		JSON.parse(readFileSync(recordFile(stateRoot, "codex"), "utf8")),
		{ targetId: "codex", until: second.until },
	);
	deepStrictEqual(liveRouteExhaustion({ stateRoot, now: () => NOW }), [
		{ targetId: "codex", until: second.until },
	]);
});

test("liveRouteExhaustion ignores malformed records and removes expired ones", () => {
	const stateRoot = tempDir("switchyard-route-exhaustion-");
	const dir = join(stateRoot, "route-exhaustion");
	recordRouteExhaustion("codex", { stateRoot, now: () => NOW });
	recordRouteExhaustion("antigravity", {
		stateRoot,
		now: () => NOW - ROUTE_EXHAUSTION_TTL_MS,
	});
	writeFileSync(join(dir, "malformed.json"), "not json", "utf8");
	deepStrictEqual(liveRouteExhaustion({ stateRoot, now: () => NOW }), [
		{ targetId: "codex", until: NOW + ROUTE_EXHAUSTION_TTL_MS },
	]);
	// The expired record is gone; the malformed one is ignored, not removed.
	deepStrictEqual(readdirSync(dir).sort(), [
		`${sha256("codex")}.json`,
		"malformed.json",
	]);
	deepStrictEqual(
		liveRouteExhaustion({
			stateRoot: join(stateRoot, "missing"),
			now: () => NOW,
		}),
		[],
	);
});

test("a quota_exhausted attempt marks the target exhausted for an hour", async () => {
	const f = fixture({
		"antigravity-claude": trustedQuotaFailure(),
	});
	f.deps.now = () => NOW;
	f.options.deadlineMs = NOW + 60_000;
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	deepStrictEqual(f.calls, ["antigravity-claude", "codex"]);
	deepStrictEqual(
		JSON.parse(
			readFileSync(recordFile(f.deps.stateRoot, "antigravity-claude"), "utf8"),
		),
		{ targetId: "antigravity-claude", until: NOW + ROUTE_EXHAUSTION_TTL_MS },
	);
	deepStrictEqual(
		liveRouteExhaustion({ stateRoot: f.deps.stateRoot, now: () => NOW }),
		[{ targetId: "antigravity-claude", until: NOW + ROUTE_EXHAUSTION_TTL_MS }],
	);
});

test("non-quota failures write no exhaustion record", async () => {
	for (const behavior of [
		{ status: "failed" },
		{
			status: "failed",
			result: {
				providerReliability: createProviderReliabilityDiagnostic({
					causeCode: "auth_expired",
					phase: "provider",
				}),
			},
		},
	]) {
		const f = fixture({ "antigravity-claude": behavior });
		const result = await runSimpleRoutingTask(f.options, f.deps);
		strictEqual(result.direction, "complete");
		strictEqual(existsSync(join(f.deps.stateRoot, "route-exhaustion")), false);
	}
});

test("an exhaustion record write failure never changes the routing outcome", async () => {
	const f = fixture({
		"antigravity-claude": trustedQuotaFailure(),
	});
	const warnings = [];
	f.deps.onRoutingWarning = (message) => warnings.push(message);
	writeFileSync(
		join(f.deps.stateRoot, "route-exhaustion"),
		"not a directory",
		"utf8",
	);
	const result = await runSimpleRoutingTask(f.options, f.deps);
	strictEqual(result.direction, "complete");
	strictEqual(warnings.length, 1);
	strictEqual(warnings[0].includes("route exhaustion"), true);
});

// A warning sink is diagnostic: one that throws must not change the route.
test("an exhaustion record write failure with a throwing warning sink leaves the outcome unchanged", async () => {
	const quotaFixture = () => {
		const f = fixture({
			"antigravity-claude": trustedQuotaFailure(),
		});
		writeFileSync(
			join(f.deps.stateRoot, "route-exhaustion"),
			"not a directory",
			"utf8",
		);
		return f;
	};
	const decision = (result) => ({
		direction: result.direction,
		stopReason: result.stopReason,
		attempts: result.attempts.map((a) => [a.targetId, a.terminal, a.reason]),
		failedTargetIds: result.failedTargetIds,
	});
	const baseline = quotaFixture();
	baseline.deps.onRoutingWarning = () => {};
	const expected = decision(
		await runSimpleRoutingTask(baseline.options, baseline.deps),
	);
	const f = quotaFixture();
	const warnings = [];
	f.deps.onRoutingWarning = (message) => {
		warnings.push(message);
		throw new Error("warning sink unavailable");
	};
	const result = await runSimpleRoutingTask(f.options, f.deps);
	deepStrictEqual(decision(result), expected);
	strictEqual(expected.direction, "complete");
	strictEqual(warnings.length, 1);
	strictEqual(warnings[0].includes("route exhaustion"), true);
});

test("selection rejects a live-exhausted target with quota_exhausted evidence", async () => {
	const restore = withPinnedRoster();
	try {
		const stateRoot = tempDir("switchyard-route-exhaustion-");
		recordRouteExhaustion("codex", { stateRoot, now: () => NOW });
		const { result, decisions, routed } = selectionFixture(stateRoot);
		const selected = await result.selectSimpleRoute();
		strictEqual(selected.provider, "antigravity");
		deepStrictEqual(routed[0].availableProviders, ["antigravity"]);
		deepStrictEqual(routed[0].exclude, ["codex"]);
		deepStrictEqual(decisions[0].routeEvidence.excluded, [
			{ targetId: "codex", reason: "quota_exhausted" },
		]);
		// The allowlisted reason survives the diagnostic re-bound.
		const diagnostics = routeDiagnosticPatch(decisions[0]);
		deepStrictEqual(diagnostics.routeEvidence.excluded, [
			{ targetId: "codex", reason: "quota_exhausted" },
		]);
	} finally {
		restore();
	}
});

test("selection accepts the target again once the entry expires", async () => {
	const restore = withPinnedRoster();
	try {
		const stateRoot = tempDir("switchyard-route-exhaustion-");
		recordRouteExhaustion("codex", {
			stateRoot,
			now: () => NOW - ROUTE_EXHAUSTION_TTL_MS - 1,
		});
		const { result, decisions, routed } = selectionFixture(stateRoot);
		const selected = await result.selectSimpleRoute();
		strictEqual(selected.provider, "codex");
		deepStrictEqual(routed[0].availableProviders, ["codex", "antigravity"]);
		deepStrictEqual(routed[0].exclude, []);
		deepStrictEqual(
			decisions[0].routeEvidence.excluded.filter(
				(entry) => entry.reason === "quota_exhausted",
			),
			[],
		);
		// The expired record was removed best effort.
		deepStrictEqual(readdirSync(join(stateRoot, "route-exhaustion")), []);
	} finally {
		restore();
	}
});

// Close one failed codex attempt in a fresh routing run; return the state.
function recordFailedAttempt(extra, patch) {
	const project = tempDir("switchyard-route-exhaustion-project-");
	const stateRoot = tempDir("switchyard-route-exhaustion-state-");
	const handle = openRoutingRun(project, "run-quota", { stateRoot });
	const pending = {
		taskId: "task-1",
		attemptId: "attempt-1",
		runId: "run-1",
		targetId: "codex",
		capability: "standard",
		startedAt: new Date(NOW).toISOString(),
	};
	const record = {
		...pending,
		terminal: "failed",
		reason: "unsafe_failure",
		closedAt: new Date(NOW).toISOString(),
		partialWorktree: null,
		...extra,
	};
	try {
		handle.commit({ pendingAttempt: pending });
		if (patch) handle.commit({ ...patch(record), pendingAttempt: null });
		else recordAttemptOutcome(handle.state, handle.commit, record);
	} finally {
		handle.release();
	}
	return readRoutingRunState(project, "run-quota", { stateRoot });
}

test("a quota_exhausted failure does not latch its target for the routing run", () => {
	const state = recordFailedAttempt({ nonBlamingCause: "quota_exhausted" });
	deepStrictEqual(state.failedTargetIds, []);
	strictEqual(state.attempts[0].nonBlamingCause, "quota_exhausted");
});

test("a blaming failure still latches its target for the routing run", () => {
	const state = recordFailedAttempt({});
	deepStrictEqual(state.failedTargetIds, ["codex"]);
});

test("a run that latched a quota failure before the fix stays readable", () => {
	const state = recordFailedAttempt(
		{ nonBlamingCause: "quota_exhausted" },
		(record) => ({ attempts: [record], failedTargetIds: ["codex"] }),
	);
	deepStrictEqual(state.failedTargetIds, ["codex"]);
});
