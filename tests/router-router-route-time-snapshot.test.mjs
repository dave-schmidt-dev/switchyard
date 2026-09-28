import { notStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { route } from "../src/switchyard/router/index.mjs";
import {
	createTestSnapshot,
	FIXTURE_PATH,
	HEALTH_ROOT,
	HEALTH_RUN_ROOT,
	previousRosterPath,
	previousRunStoreRoot,
	ROUTER_ROSTER_PATH,
	SNAPSHOT_PATH,
	withDispatchQualifiedDescriptors,
} from "./helpers/router-fixtures.mjs";

before(() => {
	rmSync(HEALTH_ROOT, { recursive: true, force: true });
	rmSync(HEALTH_RUN_ROOT, { recursive: true, force: true });
	process.env.SWITCHYARD_RUN_STORE_ROOT = HEALTH_RUN_ROOT;
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
		rmSync(HEALTH_ROOT, { recursive: true, force: true });
		rmSync(HEALTH_RUN_ROOT, { recursive: true, force: true });
		if (previousRunStoreRoot === undefined)
			delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		else process.env.SWITCHYARD_RUN_STORE_ROOT = previousRunStoreRoot;
	} catch {
		// Ignore
	}
});

function removeSnapshot() {
	rmSync(SNAPSHOT_PATH, { force: true });
}

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
