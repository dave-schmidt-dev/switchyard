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
//   1. the routed model is right-sized to the required capability, and
//   2. a provider below the required capability is never routed, even when it holds the most
//      headroom (so the capability filter, not the spread, decides eligibility).
//
// It reads the committed fixture (never the real ~/.agent/roster.json) and an
// isolated per-process temp snapshot, mirroring tests/router.test.mjs.

import { strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
} from "../src/switchyard/roster/index.mjs";
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
const QUALIFIED_FIXTURE_PATH = join(
	tmpdir(),
	`switchyard-router-rightsizing-roster-${process.pid}-${randomUUID()}.json`,
);

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;

function withDispatchQualifiedDescriptors(roster) {
	const testedAt = new Date().toISOString();
	for (const [targetId, target] of Object.entries(roster.targets)) {
		if (!target.enabled) continue;
		for (const slots of Object.values(target.slots ?? {})) {
			for (const slot of slots ?? []) {
				if (slot.manual_only) continue;
				const model = roster.models[slot.model_ref];
				if (model?.status !== "active") continue;
				const core = {
					target_id: targetId,
					model_ref: slot.model_ref,
					selector: model.selector,
					effort: slot.effort ?? null,
					variant: slot.variant ?? null,
					invocation_args: slot.invocation_args ?? [],
				};
				const descriptorIdentity = getInvocationDescriptorIdentity(
					core,
					target.harness,
				);
				target.qualifications ??= {};
				target.qualifications[descriptorIdentity] = {
					...core,
					descriptor_identity: descriptorIdentity,
					status: "dispatch_qualified",
					tested_at: testedAt,
					credential_profile: target.credential_profile,
				};
			}
		}
	}
	return roster;
}

before(() => {
	process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = SNAPSHOT_PATH;
	writeFileSync(
		QUALIFIED_FIXTURE_PATH,
		JSON.stringify(
			withDispatchQualifiedDescriptors(
				JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
			),
		),
		"utf8",
	);
	process.env.SWITCHYARD_ROSTER_PATH = QUALIFIED_FIXTURE_PATH;
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
		rmSync(QUALIFIED_FIXTURE_PATH, { force: true });
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

describe("router INV-5 — model right-sizing per capability class", () => {
	it("routes the capability-appropriate selector for low/standard/high (single eligible provider)", () => {
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

		strictEqual(
			route({ requiredCapability: "low" }).model,
			"fixture-claude-low",
		);
		strictEqual(
			route({ requiredCapability: "standard" }).model,
			"fixture-claude-standard",
		);
		strictEqual(
			route({ requiredCapability: "high" }).model,
			"fixture-claude-high",
		);
	});

	it("the winner's model always matches the required capability, whichever high-capable provider wins", () => {
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

		const result = route({ requiredCapability: "high" });
		strictEqual(result.provider, "codex");
		strictEqual(result.model, "fixture-codex-high");
	});
});

describe("router INV-5 — capability filter gates the spread", () => {
	it("never routes an under-capable provider at high required capability, even with the most headroom", () => {
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

		const result = route({ requiredCapability: "high" });
		strictEqual(
			result.provider,
			"codex",
			"agy is below high required capability and must be filtered out",
		);
		strictEqual(result.model, "fixture-codex-high");
	});

	it("returns no eligible provider when every present provider is below the required capability", () => {
		// Only agy (standard ceiling) is present; at high required capability nothing qualifies.
		writeSnapshot([
			{ name: "agy", ok: true, windows: [{ percent_left: 99, pace_delta: 0 }] },
		]);

		const result = route({ requiredCapability: "high" });
		strictEqual(result.provider, null);
		strictEqual(result.model, null);
		// Every candidate fails only the INV-5 capability filter, so the reason
		// names the deterministic ceiling classification (Task D.3), not the
		// generic no_eligible.
		strictEqual(result.reason, "no_eligible_capability_ceiling");
	});

	it("at standard required capability the same under-capable provider IS eligible and right-sized", () => {
		// agy qualifies at standard; with no higher-capable provider present it
		// wins and is right-sized to its standard selector.
		writeSnapshot([
			{ name: "agy", ok: true, windows: [{ percent_left: 99, pace_delta: 0 }] },
		]);

		const result = route({ requiredCapability: "standard" });
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

		const result = route({ requiredCapability: "high" });
		strictEqual(result.reason, "blind_fallback");
		// Whatever blind winner emerges must be high-capable and high-right-sized.
		strictEqual(result.model, `fixture-${result.provider}-high`);
	});
});
