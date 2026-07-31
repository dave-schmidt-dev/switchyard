// Task 1.6 (roster-unification plan): router INV-5 right-sizing property test.
//
// The router's source needed no change in Task 1.6 — Task 1.5 replaced the
// frozen PROVIDER_CAPABILITIES table with a roster-backed load while preserving
// every export's shape, so router/index.mjs's capability call sites
// (Object.keys(PROVIDER_CAPABILITIES) for the blind order, passesCapabilityFilter
// for the INV-5 gate, getRightSizedModel for the model) already resolve against
// the roster. This test PROVES that (rather than asserting it): against the
// committed synthetic fixture it verifies the two INV-5 properties end-to-end
// through route() —
//   1. the routed model is right-sized to the requested tier, and
//   2. a provider below the tier is never routed, even when it holds the most
//      headroom (so the capability filter, not the spread, decides eligibility).
//
// It reads the committed fixture (never the real ~/.agent/roster.json) and an
// isolated per-process temp snapshot, mirroring tests/router.test.mjs.

import { strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { route } from "../src/switchyard/router/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

// Isolated per-process temp snapshot (see resolveSnapshotPath() in
// src/switchyard/router/index.mjs). Unique suffix so concurrent test-file
// processes never collide on one on-disk snapshot.
const SNAPSHOT_PATH = join(
	tmpdir(),
	`switchyard-router-rightsizing-${process.pid}-${randomUUID()}.json`,
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
		// Ignore
	}
});

function writeSnapshot(providers) {
	writeFileSync(
		SNAPSHOT_PATH,
		JSON.stringify({ schema_version: 2, providers }),
		"utf8",
	);
}

describe("router INV-5 — model right-sizing per tier", () => {
	it("routes the tier-appropriate selector for low/standard/high (single eligible provider)", () => {
		// claude is qualified at every tier in the fixture; make it the only
		// present provider so the winner is deterministic and we isolate the
		// right-sizing behavior from the spread.
		writeSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 80, pace_delta: 0 }],
			},
		]);

		strictEqual(route({ tier: "low" }).model, "fixture-claude-low");
		strictEqual(route({ tier: "standard" }).model, "fixture-claude-standard");
		strictEqual(route({ tier: "high" }).model, "fixture-claude-high");
	});

	it("the winner's model always matches the requested tier, whichever high-capable provider wins", () => {
		// claude and codex are both full-high in the fixture; codex has more
		// headroom so the spread picks it. The routed model must be codex's
		// HIGH selector — right-sizing follows the winner.
		writeSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 40, pace_delta: 0 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 0 }],
			},
		]);

		const result = route({ tier: "high" });
		strictEqual(result.provider, "codex");
		strictEqual(result.model, "fixture-codex-high");
	});
});

describe("router INV-5 — capability filter gates the spread", () => {
	it("never routes an under-capable provider at high tier, even with the most headroom", () => {
		// antigravity (agy) has NO high slot in the fixture -> standard ceiling.
		// Give it the most headroom so a pure spread would pick it; the INV-5
		// capability filter must exclude it and hand the route to codex.
		writeSnapshot([
			{ name: "agy", ok: true, windows: [{ percent_left: 99, pace_delta: 0 }] },
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 20, pace_delta: 0 }],
			},
		]);

		const result = route({ tier: "high" });
		strictEqual(
			result.provider,
			"codex",
			"agy is below high tier and must be filtered out",
		);
		strictEqual(result.model, "fixture-codex-high");
	});

	it("returns no eligible provider when every present provider is below the tier", () => {
		// Only agy (standard ceiling) is present; at high tier nothing qualifies.
		writeSnapshot([
			{ name: "agy", ok: true, windows: [{ percent_left: 99, pace_delta: 0 }] },
		]);

		const result = route({ tier: "high" });
		strictEqual(result.provider, null);
		strictEqual(result.model, null);
		strictEqual(result.reason, "no_eligible");
	});

	it("at standard tier the same under-capable provider IS eligible and right-sized", () => {
		// agy qualifies at standard; with no higher-capable provider present it
		// wins and is right-sized to its standard selector.
		writeSnapshot([
			{ name: "agy", ok: true, windows: [{ percent_left: 99, pace_delta: 0 }] },
		]);

		const result = route({ tier: "standard" });
		strictEqual(result.provider, "agy");
		strictEqual(result.model, "fixture-agy-standard");
	});
});

describe("router INV-5 — blind fallback still filters + right-sizes", () => {
	it("with no snapshot, blind candidates respect the capability filter and are right-sized", () => {
		// No snapshot on disk -> route() takes the blind path, which builds its
		// candidate order from Object.keys(PROVIDER_CAPABILITIES), applies
		// passesCapabilityFilter, and right-sizes via getRightSizedModel — the
		// three roster-backed call sites Task 1.6 migrated.
		rmSync(SNAPSHOT_PATH, { force: true });

		const result = route({ tier: "high" });
		strictEqual(result.reason, "blind_fallback");
		// Whatever blind winner emerges must be high-capable and high-right-sized.
		strictEqual(result.model, `fixture-${result.provider}-high`);
	});
});
