import { strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import {
	preflightMacosQueue,
	route,
	routeBlind,
} from "../src/switchyard/router/index.mjs";
import {
	buildDualCodexRoster,
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

describe("router (INV-4: dispatch only to a snapshot-available funded provider)", () => {
	it("keeps --only-provider codex on the incumbent target when a second codex-harness target is enabled (Task 6.2)", () => {
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-codex-spark-${process.pid}-${randomUUID()}.json`,
		);
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		const routeOnlyCodex = (roster) => {
			writeFileSync(rosterPath, JSON.stringify(roster), "utf8");
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			// Spark deliberately holds the most headroom: if the identifier matched
			// both targets, INV-4's most-headroom spread would hand the route to
			// Spark, so "Codex" below is a positive result and not a tie default.
			const providers = [
				{
					name: "Codex",
					ok: true,
					windows: [{ percent_left: 40, pace_delta: 0 }],
				},
				{
					name: "Codex (Spark)",
					ok: true,
					windows: [{ percent_left: 95, pace_delta: 0 }],
				},
			];
			createTestSnapshot(providers);
			const snapshotRead = {
				snapshot: {
					schema_version: 2,
					updated_at: new Date().toISOString(),
					providers,
				},
				snapshotStatus: "fresh",
				snapshotMtime: 1,
				snapshotAgeMsAtRoute: 0,
			};
			const sparkQualificationPolicy = {
				requiredCapability: "low",
				only: ["codex"],
				platform: "macos",
				goldenImageVerifiedProviders: ["codex-spark"],
			};
			return {
				onlyCodex: route({ requiredCapability: "low", only: ["codex"] }),
				unfiltered: route({ requiredCapability: "low" }),
				codexWithOwnQualification: route({
					requiredCapability: "low",
					only: ["codex"],
					platform: "macos",
					goldenImageVerifiedProviders: ["codex"],
				}),
				codexWithSparkQualification: route({
					...sparkQualificationPolicy,
					snapshotRead,
				}),
				blindCodexWithSparkQualification: routeBlind(
					["Codex"],
					[],
					"low",
					sparkQualificationPolicy,
				),
				preflightCodexWithSparkQualification: preflightMacosQueue({
					...sparkQualificationPolicy,
					tasks: [{ status: "pending", requiredCapability: "low" }],
					readSnapshot: () => snapshotRead,
				}),
			};
		};
		try {
			const withSnapshotName = routeOnlyCodex(
				buildDualCodexRoster({ incumbentSnapshotName: "Codex" }),
			);
			// Control: Spark IS eligible and IS the most-headroom lane here, so the
			// filtered assertion below is doing real work. Without this the test
			// would still pass if Spark were quietly ineligible (no descriptor,
			// capability filtered out), proving nothing about disambiguation.
			strictEqual(withSnapshotName.unfiltered.provider, "Codex (Spark)");
			strictEqual(withSnapshotName.onlyCodex.provider, "Codex");
			strictEqual(withSnapshotName.codexWithOwnQualification.provider, "Codex");
			strictEqual(withSnapshotName.codexWithSparkQualification.provider, null);
			strictEqual(
				withSnapshotName.blindCodexWithSparkQualification.provider,
				null,
			);
			strictEqual(
				withSnapshotName.preflightCodexWithSparkQualification
					.capabilityResults[0].excludedReasons.Codex,
				"not_golden_image_verified",
			);
			strictEqual(
				routeOnlyCodex(buildDualCodexRoster({ incumbentSnapshotName: null }))
					.onlyCodex.provider,
				null,
			);
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});

	it("never routes outside availableProviders, even when the excluded one has more headroom", () => {
		// Isolate the availableProviders restriction from capability filtering:
		// both claude and codex are fully capable here, so the ONLY reason
		// codex loses is that this dispatcher can't reach it.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom
			},
		]);

		const result = route({
			requiredCapability: "low",
			availableProviders: ["claude"],
		});
		strictEqual(
			result.provider,
			"claude",
			"codex has more headroom and passes the capability filter, but this " +
				"dispatcher can only reach claude -- availableProviders must win",
		);
	});

	it("--exclude-provider still excludes when the live snapshot uses title-cased provider names (regression)", () => {
		// The real production snapshot (Gradus/Installed/snapshot-v2.json) stores
		// provider.name title-cased ("Claude", "Antigravity", ...), not the
		// lowercase harness key ("claude", "agy") documented for
		// --exclude-provider and used everywhere else in this file's fixtures.
		// route()'s exclude check used to do a raw `exclude.includes(name)`
		// with no normalization, so excluding "claude" silently failed to
		// match snapshot entry "Claude" and the exclusion was a no-op --
		// caught live 2026-07-31 when --exclude-provider claude/codex/cursor/
		// opencode/copilot left every task routing straight back to Claude.
		createTestSnapshot([
			{
				name: "Claude",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom
			},
			{
				name: "Codex",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
		]);

		const result = route({ requiredCapability: "low", exclude: ["claude"] });
		strictEqual(
			result.provider,
			"Codex",
			"excluding the lowercase harness key 'claude' must exclude the " +
				"title-cased snapshot entry 'Claude' -- case must not matter",
		);
	});

	it("--only-provider restricts routing to the allowlisted provider, even when a non-allowlisted one has more headroom (Task C.9)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom
			},
		]);

		const result = route({ requiredCapability: "low", only: ["claude"] });
		strictEqual(
			result.provider,
			"claude",
			"codex has more headroom, but --only-provider claude must restrict " +
				"routing to claude regardless",
		);
	});

	it("spreads to the provider with most headroom among funded candidates", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 70, pace_delta: 200 }],
			},
		]);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"Should pick provider with most headroom",
		);
	});

	it("no longer pools Cursor's ac/ap windows — ac alone drives the (ranked) result even though ap has more headroom", () => {
		// implementor-priority-waterfall-routing plan: Cursor's ac (1st-party,
		// rank 3, 0% floor) and ap (API, last-resort) windows are matched by
		// `w.id`, never pooled/averaged. ac is well above its 0% floor here, so
		// cursor-pro's ranked candidate wins on ac's own headroom (4.66%) —
		// nothing close to the old pooled ~43% average.
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 4.66, pace_delta: -0.4 },
					{ id: "ap", percent_left: 81.82, pace_delta: 0.2 },
				],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "cursor");
		strictEqual(result.percentLeft, 4.66);
		strictEqual(result.reason, "priority_fill");
	});

	it("breaks percent_left ties with the scorer, not roster order (Task 11)", () => {
		// claude is FIRST in roster harness order, so an array-order tie-break
		// (winner seeded with scored[0]) would always pick claude on a headroom
		// tie. codex has the higher pace_delta, so the documented scorer
		// (0.9*normPace + 0.1*jitter) must pick codex instead -- proving
		// computeScore, not iteration order, decides the tie.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 1 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 999 }],
			},
		]);

		const result = route({ seed: 42 });
		strictEqual(result.percentLeft, 50, "tie is at the top headroom");
		strictEqual(
			result.provider,
			"codex",
			"scorer (higher pace) must break the tie, not roster order (claude first)",
		);
	});

	it("excludes a non-finite percent_left window rather than treating it as eligible (Task 13)", () => {
		// A snapshot CAN carry a non-finite percent_left: JSON.parse("1e999") is
		// Infinity (NaN can't survive a JSON round-trip, so it's unreachable
		// here; Number.isFinite guards both). typeof Infinity === "number" would
		// pass a naive filter, and `Infinity < floor` is false, so the provider
		// would evade the exhausted-skip and win with unbounded headroom -- an
		// INV-4 bypass. It must be excluded, leaving codex the only valid
		// provider. Written as raw JSON because JSON.stringify(Infinity) ===
		// "null".
		writeFileSync(
			SNAPSHOT_PATH,
			'{"schema_version":2,"providers":[' +
				'{"name":"claude","ok":true,"windows":[{"percent_left":1e999,"pace_delta":100}]},' +
				'{"name":"codex","ok":true,"windows":[{"percent_left":50,"pace_delta":200}]}' +
				"]}",
			"utf8",
		);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"claude's non-finite window must be excluded, leaving codex the winner",
		);
	});

	it("does not blow the call stack on an oversized windows array (Task 10)", () => {
		// A malformed/runaway usage-snapshot writer could emit tens of
		// thousands of windows for one provider. The old
		// `Math.min(...windows.map(...))` and `Math.min(...paces)` spreads
		// threw `RangeError: Maximum call stack size exceeded`; the
		// reduce-based min degrades gracefully instead. Each window carries a
		// finite pace_delta so the paces reduce is exercised too, not just the
		// percent_left reduce.
		const bigWindows = Array.from({ length: 200000 }, () => ({
			percent_left: 50,
			pace_delta: 100,
		}));
		createTestSnapshot([{ name: "claude", ok: true, windows: bigWindows }]);

		const result = route();
		strictEqual(
			result.provider,
			"claude",
			"oversized windows must route, not crash the router",
		);
		strictEqual(result.percentLeft, 50, "min headroom computed via reduce");
	});
});
