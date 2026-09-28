import { notStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	__resetRosterCacheForTests,
	resolveTargetIdentity,
} from "../src/switchyard/roster/index.mjs";
import { preflightMacosQueue, route } from "../src/switchyard/router/index.mjs";
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

describe("providerMatches fallback for roster-unresolvable identifiers", () => {
	it("matches nothing when --only-provider names no roster target, and excludes nothing when --exclude-provider does", () => {
		// Both filtered routes below go through the fallback's `false` outcome:
		// "windsurf" resolves to no target (targetId null), every snapshot name
		// here resolves to one, and "windsurf" !== "claude"/"codex".
		strictEqual(resolveTargetIdentity("windsurf").targetId, null);

		createTestSnapshot([
			{ name: "claude", ok: true, windows: [{ percent_left: 90 }] },
			{ name: "codex", ok: true, windows: [{ percent_left: 80 }] },
		]);

		// Control: without a filter this queue routes fine. Without it, the
		// `only` assertion would pass vacuously on any roster/snapshot state
		// that made every provider ineligible for an unrelated reason.
		const unfiltered = route({ requiredCapability: "standard" });
		notStrictEqual(unfiltered.provider, null);

		// An unknown allowlist entry allows nothing -- it must not silently
		// degrade to "no filter".
		strictEqual(
			route({ requiredCapability: "standard", only: ["windsurf"] }).provider,
			null,
		);

		// The opposite polarity, which the `only` case alone would not catch:
		// an unknown exclusion must remove nothing. An inverted condition in
		// the fallback would show up here as a null route.
		strictEqual(
			route({ requiredCapability: "standard", exclude: ["windsurf"] }).provider,
			unfiltered.provider,
		);
	});

	it("still excludes a disabled target's snapshot provider given a case-variant identifier", () => {
		// The fallback's `true` outcome. The fixture's `vibe` target is
		// disabled, which is precisely what splits the two spellings:
		//   "vibe" -> exact target id (step 1, no `enabled` check) -> "vibe"
		//   "Vibe" -> no id/snapshot_name match, then the harness tie-break
		//             finds zero ENABLED vibe targets                -> null
		// One resolved side and one unresolved side is what drops
		// providerMatches past its `identifierTargetId && nameTargetId` branch
		// onto the fallback, where both spellings normalize to "vibe".
		//
		// Asserting the split directly rather than assuming it: if `vibe` is
		// ever enabled in the fixture, "Vibe" starts resolving through the
		// tie-break, the exclusion below still fires via the earlier branch,
		// and this test would keep passing while covering nothing.
		strictEqual(resolveTargetIdentity("vibe").targetId, "vibe");
		strictEqual(resolveTargetIdentity("Vibe").targetId, null);

		const snapshot = {
			schema_version: 2,
			updated_at: new Date().toISOString(),
			providers: [{ name: "vibe", ok: true, windows: [{ percent_left: 80 }] }],
		};
		const reasonFor = (exclude) =>
			preflightMacosQueue({
				tasks: [{ id: "t", status: "pending", requiredCapability: "standard" }],
				tarProvisionManifest: { verified: true, providers: ["vibe"] },
				readSnapshot: () => ({
					snapshot,
					snapshotStatus: "fresh",
					snapshotMtime: 1,
					snapshotAgeMsAtRoute: 0,
				}),
				exclude,
			}).capabilityResults[0].excludedReasons.vibe;

		// Control: unexcluded, `vibe` drops out later in classifyPreflightProvider
		// for an unrelated reason. That baseline is what makes the flip to
		// "explicitly_excluded" evidence that the exclusion matched, rather
		// than a reason string this provider would have carried anyway.
		strictEqual(reasonFor([]), "below_required_capability");
		strictEqual(reasonFor(["Vibe"]), "explicitly_excluded");
		// ...and the fallback is still discriminating, not matching everything:
		// an unrelated unresolvable identifier leaves the baseline reason.
		strictEqual(reasonFor(["windsurf"]), "below_required_capability");
	});

	it("refuses a case-variant of an ambiguous harness with ambiguous_target rather than routing it", () => {
		// The rider to the above: with TWO enabled codex targets, "CODEX" no
		// longer resolves -- it matches no exact target id (that comparison is
		// case-sensitive) and the harness tie-break now sees two candidates.
		// Lowercase "codex" keeps working because it hits the exact id.
		//
		// route() catches this in its own pre-loop guard and returns
		// `ambiguous_target` with an actionable hint, so the identifier never
		// reaches providerMatches at all. Assert that reason, not just
		// `provider === null`: a bare null assertion would keep passing if the
		// guard were deleted, because the fallback above would then quietly
		// match "CODEX" to the "Codex" snapshot name instead.
		//
		// The mixed case itself is a PRECONDITION, not a bug to fix here: the
		// CLI lowercases every provider filter in normalizeProviders()
		// (src/switchyard/runner/index.mjs:171), so only a programmatic
		// runQueue caller bypassing normalizeRunOptions can hand the router a
		// mixed-case identifier. If case-insensitive target-id resolution is
		// ever added to resolveTargetIdentityFromTargets, revisit this.
		const rosterPath = join(
			tmpdir(),
			`switchyard-router-codex-case-${process.pid}-${randomUUID()}.json`,
		);
		const previousPath = process.env.SWITCHYARD_ROSTER_PATH;
		try {
			writeFileSync(
				rosterPath,
				JSON.stringify(
					buildDualCodexRoster({ incumbentSnapshotName: "Codex" }),
				),
				"utf8",
			);
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			createTestSnapshot([
				{ name: "Codex", ok: true, windows: [{ percent_left: 40 }] },
				{ name: "Codex (Spark)", ok: true, windows: [{ percent_left: 95 }] },
			]);

			// Control: both targets are live and Spark holds the headroom, so a
			// null result below is the filter's doing and not an ineligible roster.
			strictEqual(
				route({ requiredCapability: "low" }).provider,
				"Codex (Spark)",
			);
			strictEqual(
				route({ requiredCapability: "low", only: ["codex"] }).provider,
				"Codex",
			);

			const upper = route({ requiredCapability: "low", only: ["CODEX"] });
			strictEqual(upper.provider, null);
			strictEqual(upper.reason, "ambiguous_target");
			ok(
				upper.log.some((line) => line.includes("use an exact target id")),
				`expected an actionable hint, got: ${JSON.stringify(upper.log)}`,
			);
		} finally {
			if (previousPath === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousPath;
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
	});
});
