import { strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { route } from "../src/switchyard/router/index.mjs";
import {
	__dirname,
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

describe("router (implementor-priority waterfall routing)", () => {
	// Fixture ranks: antigravity (agy) = 1, copilot-student (copilot) = 2,
	// cursor-pro (cursor, ac window only) = 3. claude/codex/opencode carry no
	// implementor_priority and stay in the unranked spread pool.

	it("a ranked provider is chosen over a higher-headroom unranked one", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 0 }],
			},
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 20, pace_delta: 0 }],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			"antigravity",
			"ranked pool wins over unranked pool regardless of relative headroom",
		);
		strictEqual(result.reason, "priority_fill");
	});

	it("waterfall order is strictly honored across multiple ranked providers regardless of relative headroom", () => {
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 1, pace_delta: 0 }],
			},
			{
				name: "copilot",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			"antigravity",
			"priority 1 wins over priority 2 even with far less headroom left — a true waterfall, not a headroom comparison",
		);
		strictEqual(result.reason, "priority_fill");
	});

	it("a ranked provider drains to exactly 0% (not the 5% DEFAULT_FLOOR) before falling through", () => {
		// Below the unranked DEFAULT_FLOOR (5%) but still above the ranked 0%
		// floor: must still be picked — proves the hardcoded 0% floor
		// override, not just a lower default.
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 1, pace_delta: 0 }],
			},
		]);
		let result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "antigravity");
		strictEqual(result.reason, "priority_fill");

		// At exactly 0%, the ranked provider must fall through instead.
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 0, pace_delta: 0 }],
			},
		]);
		result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			null,
			"a ranked provider at exactly 0% must be excluded, not treated as still-eligible",
		);
	});

	it("Cursor's ac window alone drives ranked eligibility (matched by window id, not array position)", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ap", percent_left: 99, pace_delta: 0 },
					{ id: "ac", percent_left: 10, pace_delta: 0 },
				],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "cursor");
		strictEqual(
			result.percentLeft,
			10,
			"eligibility and headroom must come from the ac window (matched by id), not array position or the ap window",
		);
		strictEqual(result.reason, "priority_fill");
	});

	it("Cursor's ap window is NOT picked as long as any unranked provider still has headroom, even with ac exhausted", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 0, pace_delta: 0 },
					{ id: "ap", percent_left: 50, pace_delta: 0 },
				],
			},
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 10, pace_delta: 0 }],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			"claude",
			"an unranked provider with headroom must win over Cursor's ap last-resort bucket",
		);
		strictEqual(result.reason, "spread");
	});

	it("Cursor's ap window IS picked once ac is exhausted AND every unranked provider is also exhausted", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 0, pace_delta: 0 },
					{ id: "ap", percent_left: 50, pace_delta: 0 },
				],
			},
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 2, pace_delta: 0 }], // below the 5% DEFAULT_FLOOR
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "cursor");
		strictEqual(result.percentLeft, 50);
		strictEqual(result.reason, "last_resort_fallback");
	});

	it("Cursor's ap window still respects its own DEFAULT_FLOOR (5%) exhaustion check", () => {
		createTestSnapshot([
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 0, pace_delta: 0 },
					{ id: "ap", percent_left: 3, pace_delta: 0 }, // below 5%
				],
			},
		]);

		const result = route({ requiredCapability: "standard" });
		strictEqual(
			result.provider,
			null,
			"ap below its own 5% floor must not be picked even as a last resort",
		);
	});

	it("tier 1 drains in roster order and stays sticky as quota falls", () => {
		// The fixture declares antigravity-claude before antigravity. Snapshot
		// order, headroom, pace, and seed must not change that tier-1 choice.
		const tiebreakFixturePath = resolve(
			__dirname,
			"fixtures",
			"roster.priority-tiebreak.fixture.json",
		);
		const qualifiedTiebreakFixturePath = join(
			tmpdir(),
			`switchyard-router-priority-tiebreak-${process.pid}-${randomUUID()}.json`,
		);
		const savedRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		writeFileSync(
			qualifiedTiebreakFixturePath,
			JSON.stringify(
				withDispatchQualifiedDescriptors(
					JSON.parse(readFileSync(tiebreakFixturePath, "utf8")),
				),
			),
			"utf8",
		);
		process.env.SWITCHYARD_ROSTER_PATH = qualifiedTiebreakFixturePath;
		__resetRosterCacheForTests();
		try {
			createTestSnapshot([
				{
					name: "Antigravity",
					ok: true,
					windows: [{ percent_left: 90, pace_delta: 1 }],
				},
				{
					name: "Antigravity (Claude)",
					ok: true,
					windows: [{ percent_left: 40, pace_delta: 999 }],
				},
			]);

			let result = route({ requiredCapability: "standard", seed: 1 });
			strictEqual(
				result.provider,
				"Antigravity (Claude)",
				"tier 1 follows roster order despite the other candidate having more headroom and a different pace",
			);
			strictEqual(result.reason, "priority_fill");

			// The incumbent remains first while it has any usable quota, even
			// when its headroom drops below the later roster candidate.
			createTestSnapshot([
				{
					name: "Antigravity",
					ok: true,
					windows: [{ percent_left: 99, pace_delta: 1 }],
				},
				{
					name: "Antigravity (Claude)",
					ok: true,
					windows: [{ percent_left: 1, pace_delta: 999 }],
				},
			]);
			result = route({ requiredCapability: "standard", seed: 999 });
			strictEqual(result.provider, "Antigravity (Claude)");
		} finally {
			if (savedRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = savedRosterPath;
			}
			__resetRosterCacheForTests();
			rmSync(qualifiedTiebreakFixturePath, { force: true });
		}
	});

	it("balances within tier 2 and does not enter tier 3 before tier 2 is unusable", () => {
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-tier-balance-${process.pid}-${randomUUID()}.json`,
		);
		const roster = withDispatchQualifiedDescriptors(
			JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
		);
		// The fixture normally places Cursor in tier 3. Move it to tier 2 for
		// this synthetic roster so two independently eligible tier-2 targets
		// prove that balancing is scoped to the tier.
		roster.targets["cursor-pro"].implementor_priority = 2;
		writeFileSync(rosterPath, JSON.stringify(roster), "utf8");
		const savedRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
		__resetRosterCacheForTests();
		try {
			createTestSnapshot([
				{
					name: "antigravity",
					ok: true,
					windows: [{ percent_left: 0, pace_delta: 0 }],
				},
				{
					name: "copilot",
					ok: true,
					windows: [{ percent_left: 20, pace_delta: 0 }],
				},
				{
					name: "cursor",
					ok: true,
					windows: [
						{ id: "ac", percent_left: 80, pace_delta: 0 },
						{ id: "ap", percent_left: 80, pace_delta: 0 },
					],
				},
				{
					name: "claude",
					ok: true,
					windows: [{ percent_left: 99, pace_delta: 0 }],
				},
			]);
			let result = route({ requiredCapability: "standard" });
			strictEqual(result.provider, "cursor");
			strictEqual(result.reason, "priority_fill");

			// Once Cursor's tier-2 quota is exhausted, the remaining tier-2
			// provider wins before the tier-3/unranked fallbacks.
			createTestSnapshot([
				{
					name: "antigravity",
					ok: true,
					windows: [{ percent_left: 0, pace_delta: 0 }],
				},
				{
					name: "copilot",
					ok: true,
					windows: [{ percent_left: 20, pace_delta: 0 }],
				},
				{
					name: "cursor",
					ok: true,
					windows: [
						{ id: "ac", percent_left: 0, pace_delta: 0 },
						{ id: "ap", percent_left: 80, pace_delta: 0 },
					],
				},
				{
					name: "claude",
					ok: true,
					windows: [{ percent_left: 99, pace_delta: 0 }],
				},
			]);
			result = route({ requiredCapability: "standard" });
			strictEqual(result.provider, "copilot");
		} finally {
			if (savedRosterPath === undefined)
				delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = savedRosterPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});

	it("enters tier 3 only after tier 1 and tier 2 are unusable", () => {
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 0, pace_delta: 0 }],
			},
			{
				name: "copilot",
				ok: true,
				windows: [{ percent_left: 0, pace_delta: 0 }],
			},
			{
				name: "cursor",
				ok: true,
				windows: [
					{ id: "ac", percent_left: 80, pace_delta: 0 },
					{ id: "ap", percent_left: 80, pace_delta: 0 },
				],
			},
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
		]);
		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, "cursor");
		strictEqual(result.reason, "priority_fill");
	});
});
