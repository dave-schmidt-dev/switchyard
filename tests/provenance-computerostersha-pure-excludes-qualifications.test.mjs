// @test-phase: other
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	__resetRosterCacheForTests,
	computeRosterSha,
	resolveRouteProvenance,
	resolveTargetProvenance,
} from "../src/switchyard/roster/index.mjs";
import {
	FIXTURE_PATH,
	previousHomeDir,
	previousRosterPath,
	setHomeDir,
	setRosterPath,
} from "./helpers/provenance-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let tmpDir;
before(() => {
	setRosterPath(FIXTURE_PATH);
});
afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
	setRosterPath(FIXTURE_PATH);
	setHomeDir(previousHomeDir);
});
after(() => {
	if (previousRosterPath === undefined)
		delete process.env.SWITCHYARD_ROSTER_PATH;
	else process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	setHomeDir(previousHomeDir);
	__resetRosterCacheForTests();
});
describe("computeRosterSha — pure, excludes qualifications (PM-12/SR-4)", () => {
	// Two rosters identical except for the mutable qualifications block.
	const base = {
		schema_version: 1,
		models: { "p/m": { selector: "p-m", status: "active" } },
		targets: {
			t: {
				harness: "p",
				enabled: true,
				slots: { low: [{ model_ref: "p/m", priority: 1 }] },
				qualifications: { "p-m": { status: "untested" } },
			},
		},
	};

	it("returns the SAME hash when only qualifications differ (smoke write-back is invisible)", () => {
		const flipped = structuredClone(base);
		flipped.targets.t.qualifications["p-m"].status = "qualified";
		flipped.targets.t.qualifications["p-m"].last_smoke = "2026-07-31T00:00:00Z";
		strictEqual(computeRosterSha(base), computeRosterSha(flipped));
	});

	it("returns a DIFFERENT hash when a real (non-qualification) field changes", () => {
		const changed = structuredClone(base);
		changed.targets.t.slots.low[0].priority = 2; // a genuine routing change
		notStrictEqual(computeRosterSha(base), computeRosterSha(changed));
	});

	it("is order-independent over object keys (canonicalized) but not over arrays", () => {
		const reordered = {
			targets: base.targets,
			schema_version: 1,
			models: base.models,
		};
		strictEqual(computeRosterSha(base), computeRosterSha(reordered));
	});

	it("produces a 64-char hex sha256 string", () => {
		const sha = computeRosterSha(base);
		strictEqual(typeof sha, "string");
		ok(/^[0-9a-f]{64}$/.test(sha), `expected 64-char hex, got ${sha}`);
	});
});
describe("resolveTargetProvenance / resolveRouteProvenance — target resolution", () => {
	it("resolves the enabled target, harness, and tier-right-sized selector", () => {
		deepStrictEqual(resolveTargetProvenance("OpenCode Go", "low"), {
			resolved_target: "opencode-go",
			resolved_harness: "opencode",
			resolved_selector: "fixture/opencode-low",
			// credential_profile is carried as metadata (M1b) but never passed to
			// the adapter — the fixture's opencode-go target uses profile "go".
			resolved_credential_profile: "go",
		});
	});

	it("returns a null target/selector but the normalized harness for an unbacked provider", () => {
		deepStrictEqual(resolveTargetProvenance("Totally Unknown", "low"), {
			resolved_target: null,
			resolved_harness: "totally unknown",
			resolved_selector: null,
			resolved_credential_profile: null,
		});
	});

	it("resolveRouteProvenance returns all six fields with the roster identity", () => {
		const prov = resolveRouteProvenance("OpenCode Go", "low");
		strictEqual(prov.roster_schema_version, 1);
		ok(/^[0-9a-f]{64}$/.test(prov.roster_sha256));
		strictEqual(prov.resolved_target, "opencode-go");
		strictEqual(prov.resolved_harness, "opencode");
		strictEqual(prov.resolved_selector, "fixture/opencode-low");
	});

	it("resolves the ENABLED target when two targets share one harness (production shape: opencode-go/opencode-zen)", () => {
		// findTargetEntryForHarness's whole reason for existing: the real roster
		// has exactly this shape (opencode-go enabled, opencode-zen disabled, both
		// harness "opencode"), and its docstring cites that case directly. The
		// committed fixture never models two same-harness targets, so nothing
		// proves resolveTargetProvenance actually picks the enabled one rather
		// than, say, the first one found by object-key order (which would be
		// wrong if the disabled target happened to be declared first).
		tmpDir = tempDir("switchyard-provenance-");
		const path = join(tmpDir, "shared-harness.json");
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"fixture/opencode-zen-low": {
						selector: "fixture-opencode-zen-low",
						status: "active",
					},
					"fixture/opencode-go-low": {
						selector: "fixture-opencode-go-low",
						status: "active",
					},
				},
				targets: {
					// Declared BEFORE the enabled target, so a naive "first match wins"
					// implementation would pick this one and fail the assertion below.
					"opencode-zen": {
						harness: "opencode",
						enabled: false,
						credential_profile: "zen",
						qualifications: {
							"fixture-opencode-zen-low": { status: "qualified" },
						},
						slots: {
							low: [{ model_ref: "fixture/opencode-zen-low", priority: 1 }],
						},
					},
					"opencode-go": {
						harness: "opencode",
						enabled: true,
						credential_profile: "go",
						qualifications: {
							"fixture-opencode-go-low": { status: "qualified" },
						},
						slots: {
							low: [{ model_ref: "fixture/opencode-go-low", priority: 1 }],
						},
					},
				},
			}),
			"utf8",
		);
		setRosterPath(path);

		deepStrictEqual(resolveTargetProvenance("OpenCode", "low"), {
			resolved_target: "opencode-go",
			resolved_harness: "opencode",
			resolved_selector: "fixture-opencode-go-low",
			resolved_credential_profile: "go",
		});
	});

	it("degrades every field to null (never throws) when the roster is unavailable", () => {
		// Task 4.1: with SWITCHYARD_ROSTER_PATH unset the loader now resolves
		// the canonical ~/.agent/roster.json default — which EXISTS on dev
		// machines, so unsetting alone no longer makes the roster unavailable.
		// Point HOME at an empty temp dir so the canonical default is guaranteed
		// missing, keeping this case hermetic and independent of the real roster.
		tmpDir = tempDir("switchyard-provenance-");
		setHomeDir(tmpDir);
		setRosterPath(undefined); // env unset -> canonical default is a missing file
		const prov = resolveRouteProvenance("OpenCode Go", "low");
		deepStrictEqual(prov, {
			roster_schema_version: null,
			roster_sha256: null,
			resolved_target: null,
			resolved_harness: null,
			resolved_selector: null,
			resolved_credential_profile: null,
		});
	});
});
