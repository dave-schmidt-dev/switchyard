import { notStrictEqual, ok, strictEqual } from "node:assert";
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
	it("excludes an enabled Vibe implementation target until its exact descriptor is dispatch-qualified", () => {
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-vibe-opencode-${process.pid}-${randomUUID()}.json`,
		);
		const roster = withDispatchQualifiedDescriptors(
			JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
		);
		roster.targets.vibe = {
			harness: "opencode",
			snapshot_name: "Vibe",
			credential_profile: "default",
			enabled: true,
			technical_ceiling: "low",
			qualifications: {
				"fixture/opencode-low": { status: "qualified" },
			},
			slots: {
				low: [{ model_ref: "fixture/opencode-low", priority: 1 }],
				standard: [],
				high: [],
			},
		};
		writeFileSync(rosterPath, JSON.stringify(roster), "utf8");
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
		__resetRosterCacheForTests();
		try {
			const provider = {
				name: "Vibe",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }],
			};
			createTestSnapshot([provider]);
			const result = route({
				requiredCapability: "low",
				availableProviders: ["opencode"],
			});
			strictEqual(result.provider, null);
			strictEqual(result.reason, "no_eligible");
			ok(
				result.log.some((entry) =>
					// `qualified` is probe evidence, not a dispatch receipt, so
					// this target has never been dispatch-qualified — the log
					// names that gap specifically rather than the old collapsed
					// "no usable invocation descriptor".
					entry.includes("Vibe: never dispatch-qualified"),
				),
				"selector-only Vibe must not become an automatic OpenCode route",
			);

			const explicit = route({
				requiredCapability: "low",
				availableProviders: ["opencode"],
				only: ["vibe"],
			});
			strictEqual(explicit.provider, null);
			strictEqual(explicit.reason, "no_eligible");

			const policy = {
				requiredCapability: "low",
				availableProviders: ["opencode"],
				platform: "macos",
				goldenImageVerifiedProviders: ["vibe"],
			};
			strictEqual(route({ ...policy }).provider, null);
			strictEqual(routeBlind(["Vibe"], [], "low", policy).provider, null);
			const preflight = preflightMacosQueue({
				...policy,
				tasks: [{ status: "pending", requiredCapability: "low" }],
				readSnapshot: () => ({
					snapshot: {
						schema_version: 2,
						updated_at: new Date().toISOString(),
						providers: [provider],
					},
					snapshotStatus: "fresh",
				}),
			});
			// This fixture's target carries no dispatch receipt at all, which is
			// the "never canaried" gap rather than a receipt that aged out.
			strictEqual(
				preflight.capabilityResults[0].excludedReasons.Vibe,
				"qualification_missing",
			);
		} finally {
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});

	it("routes to a funded provider when multiple are present (CR-2 regression)", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 200 }],
			},
		]);

		const result = route();
		notStrictEqual(result.provider, null, "Should find a provider");
		strictEqual(result.reason, "spread", "Should use spread selection");
	});

	it("uses standard capability when RequiredCapability is omitted", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
		]);

		const result = route();
		strictEqual(result.requiredCapability, "standard");
		strictEqual(result.provider, "claude");
	});

	it("skips a provider below the exhaustion floor, still landing on the funded one", () => {
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 3, pace_delta: 100 }], // Below default floor of 5
			},
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 200 }],
			},
		]);

		const result = route();
		strictEqual(
			result.provider,
			"codex",
			"Should skip exhausted claude and pick funded codex",
		);
	});

	it("tolerates absent providers (CR-3)", () => {
		createTestSnapshot([
			{
				name: "codex",
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
		]);

		const result = route();
		strictEqual(result.provider, "codex", "Should route to available provider");
	});

	it("returns no_eligible when the only present provider is below the exhaustion floor", () => {
		// Distinct from the "skips exhausted, lands on the other funded one"
		// test above: with only ONE provider present and it below floor, the
		// floor check is the ONLY thing standing between "dispatch nowhere"
		// and "dispatch to an unfunded provider" -- a bare INV-4 violation.
		// When another funded provider is present, spread naturally favors its
		// higher headroom regardless of the floor check, so that scenario
		// alone can't prove the floor is enforced; this one can.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 3, pace_delta: 100 }], // below default floor of 5
			},
		]);

		const result = route();
		strictEqual(
			result.provider,
			null,
			"an exhausted-only snapshot must not dispatch anywhere",
		);
		strictEqual(result.reason, "no_eligible");
	});

	it("returns no_eligible_capability_ceiling when the only candidate is below the required capability ceiling", () => {
		// Task D.3: distinguish the deterministic INV-5 ceiling case (every
		// candidate's technical_ceiling is below the task's required capability —
		// expected, not actionable) from the upstream-unavailable case below.
		// antigravity fixture's ceiling is standard, so at required capability high the
		// capability filter rejects it and nothing else is present: the reason
		// must name the ceiling, not the generic no_eligible.
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }], // standard ceiling only
			},
		]);

		const result = route({ requiredCapability: "high" });
		strictEqual(result.provider, null);
		strictEqual(result.reason, "no_eligible_capability_ceiling");
	});

	it("returns no_eligible_upstream_unavailable with the first unavailable provider's error", () => {
		// Task D.3: a provider that WOULD be eligible (claude clears the high
		// capability filter) but is currently unreachable must surface as an
		// actionable upstream failure carrying the snapshot's (already
		// redacted) error string — not the generic no_eligible.
		createTestSnapshot([
			{
				name: "claude",
				ok: false,
				error: "token expired",
				windows: [{ percent_left: 50, pace_delta: 100 }],
			},
		]);

		const result = route({ requiredCapability: "high" });
		strictEqual(result.provider, null);
		strictEqual(
			result.reason,
			"no_eligible_upstream_unavailable: claude — token expired",
		);
	});

	it("skips a fixture-disabled Vibe target even with the most headroom", () => {
		// This fixture isolates disabled-target handling. Production Vibe is also
		// disabled until its native-harness descriptor is qualified.
		createTestSnapshot([
			{
				name: "claude",
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 100 }],
			},
			{
				name: "vibe",
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 50 }], // most headroom, but disabled
			},
		]);

		const result = route({ requiredCapability: "low" });
		strictEqual(
			result.provider,
			"claude",
			"fixture-disabled Vibe must never be selected, even at " +
				"the lowest required capability and with the most headroom",
		);
		strictEqual(
			routeBlind(["vibe"], [], "low", {
				platform: "macos",
				goldenImageVerifiedProviders: ["vibe"],
			}).provider,
			null,
		);
		const disabledPreflight = preflightMacosQueue({
			tasks: [{ status: "pending", requiredCapability: "low" }],
			goldenImageVerifiedProviders: ["vibe"],
			readSnapshot: () => ({
				snapshot: {
					schema_version: 2,
					updated_at: new Date().toISOString(),
					providers: [
						{
							name: "vibe",
							ok: true,
							windows: [{ percent_left: 90, pace_delta: 50 }],
						},
					],
				},
				snapshotStatus: "fresh",
			}),
		});
		strictEqual(
			disabledPreflight.capabilityResults[0].excludedReasons.vibe,
			"below_required_capability",
		);
	});

	it("--only-provider cannot force a fixture-disabled Vibe target into the candidate set", () => {
		createTestSnapshot([
			{
				name: "antigravity",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
			{
				name: "vibe",
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
		]);

		for (const only of ["vibe"]) {
			const result = route({ requiredCapability: "standard", only: [only] });
			strictEqual(result.provider, null);
			strictEqual(result.reason, "no_eligible");
		}
	});

	it("rejects disabled Gemini target id while accepting enabled Agy Claude", () => {
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-agy-target-${process.pid}-${randomUUID()}.json`,
		);
		const roster = withDispatchQualifiedDescriptors(
			JSON.parse(readFileSync(FIXTURE_PATH, "utf8")),
		);
		roster.targets.antigravity.enabled = false;
		roster.targets["antigravity-claude"] = {
			harness: "agy",
			enabled: true,
			slots: {
				low: [],
				standard: [{ model_ref: "fixture/agy-standard", priority: 1 }],
				high: [],
			},
			qualifications: {
				"fixture-agy-standard": { status: "qualified" },
			},
		};
		withDispatchQualifiedDescriptors(roster);
		writeFileSync(rosterPath, JSON.stringify(roster), "utf8");
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
		__resetRosterCacheForTests();
		try {
			createTestSnapshot([
				{
					name: "agy",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 10 }],
				},
			]);
			strictEqual(route({ only: ["antigravity"] }).provider, null);
			strictEqual(route({ only: ["agy"] }).provider, "agy");
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});
});
