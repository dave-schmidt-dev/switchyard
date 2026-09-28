import { notStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getCapabilityClass,
	getInvocationDescriptorIdentity,
	getModelForCapability,
	getRightSizedModel,
	PROVIDER_CAPABILITIES,
	passesCapabilityFilter,
	resolveTargetIdentity,
} from "../src/switchyard/roster/index.mjs";
import { route, routeBlind } from "../src/switchyard/router/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.dual-agy.fixture.json",
);
const ANTIGRAVITY = "Antigravity";
const ANTIGRAVITY_CLAUDE = "Antigravity (Claude)";
const SNAPSHOT_PATH = join(
	tmpdir(),
	`switchyard-dual-agy-${process.pid}-${randomUUID()}.json`,
);
const QUALIFIED_FIXTURE_PATH = join(
	tmpdir(),
	`switchyard-dual-agy-qualified-${process.pid}-${randomUUID()}.json`,
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
		// ignore
	}
});
function writeSnapshot(providers) {
	writeFileSync(
		SNAPSHOT_PATH,
		JSON.stringify({ schema_version: 2, providers }),
		"utf8",
	);
}
function removeSnapshot() {
	try {
		rmSync(SNAPSHOT_PATH, { force: true });
	} catch {
		// ignore
	}
}
describe("capability gate functions resolve each agy target INDEPENDENTLY (C.5/C.6)", () => {
	it("getModelForCapability returns the CORRECT target's selector for each snapshot name", () => {
		strictEqual(
			getModelForCapability(ANTIGRAVITY_CLAUDE, "standard"),
			"fixture-agy-claude-standard",
		);
		strictEqual(getModelForCapability(ANTIGRAVITY, "standard"), null);
		notStrictEqual(
			getModelForCapability(ANTIGRAVITY_CLAUDE, "standard"),
			getModelForCapability(ANTIGRAVITY, "standard"),
			"the two agy-harness targets must never collapse to the same model",
		);
	});

	it("getRightSizedModel is consistent with getModelForCapability for both targets", () => {
		strictEqual(
			getRightSizedModel(ANTIGRAVITY_CLAUDE, "standard"),
			"fixture-agy-claude-standard",
		);
		strictEqual(getRightSizedModel(ANTIGRAVITY, "standard"), null);
	});

	it("getCapabilityClass / passesCapabilityFilter reflect each target's OWN technical_ceiling", () => {
		strictEqual(getCapabilityClass(ANTIGRAVITY_CLAUDE), "standard");
		strictEqual(getCapabilityClass(ANTIGRAVITY), null);
		strictEqual(passesCapabilityFilter(ANTIGRAVITY_CLAUDE, "standard"), true);
		strictEqual(passesCapabilityFilter(ANTIGRAVITY, "standard"), false);
		// Neither target's fixture qualifies a high slot -> both fail high.
		strictEqual(passesCapabilityFilter(ANTIGRAVITY_CLAUDE, "high"), false);
		strictEqual(passesCapabilityFilter(ANTIGRAVITY, "high"), false);
	});

	it("PROVIDER_CAPABILITIES stays harness-keyed (no snapshot_name pollution of Object.keys)", () => {
		// Task C.5 must NOT fix this by adding snapshot-name keys directly onto
		// the harness-keyed PROVIDER_CAPABILITIES table: router/index.mjs's blind
		// fallback reads Object.keys(PROVIDER_CAPABILITIES) directly (line ~135)
		// to build its candidate order, and that list must contain "agy" exactly
		// once, not once per agy-harness target. Disambiguation must live in a
		// path getCapabilityClass/getModelForCapability consult BEFORE falling back to
		// the harness-keyed table, not in the table's own key set.
		const keys = Object.keys(PROVIDER_CAPABILITIES);
		const agyCount = keys.filter((k) => k === "agy").length;
		strictEqual(agyCount, 1, `expected exactly one "agy" key, got: ${keys}`);
		ok(
			!keys.includes(ANTIGRAVITY) && !keys.includes(ANTIGRAVITY_CLAUDE),
			`PROVIDER_CAPABILITIES keys must not include raw snapshot names, got: ${keys}`,
		);
	});
});
describe("route() gives each agy target independent candidacy (C.5/C.6)", () => {
	it("routes to the Claude bucket's model when it has the most headroom", () => {
		writeSnapshot([
			{
				name: ANTIGRAVITY_CLAUDE,
				ok: true,
				windows: [{ percent_left: 90, pace_delta: 0 }],
			},
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 40, pace_delta: 0 }],
			},
		]);
		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, ANTIGRAVITY_CLAUDE);
		strictEqual(result.model, "fixture-agy-claude-standard");
		strictEqual(result.resolvedTargetId, "antigravity-claude");
	});

	it("does not route to the Gemini bucket even when it has the most headroom", () => {
		writeSnapshot([
			{
				name: ANTIGRAVITY_CLAUDE,
				ok: true,
				windows: [{ percent_left: 30, pace_delta: 0 }],
			},
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 95, pace_delta: 0 }],
			},
		]);
		const result = route({ requiredCapability: "standard" });
		strictEqual(result.provider, ANTIGRAVITY_CLAUDE);
		strictEqual(result.model, "fixture-agy-claude-standard");
		strictEqual(result.resolvedTargetId, "antigravity-claude");
	});

	it("an explicitly named Gemini snapshot is skipped without same-harness fallback", () => {
		// The disabled exact target is diagnosed, but the enabled Claude target
		// remains the sole automatic candidate.
		writeSnapshot([
			{
				name: ANTIGRAVITY_CLAUDE,
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 0 }],
			},
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 50, pace_delta: 0 }],
			},
		]);
		const result = route({ requiredCapability: "standard" });
		const mentionsClaude = result.log.some((line) =>
			line.includes(ANTIGRAVITY_CLAUDE),
		);
		const mentionsGemini = result.log.some(
			(line) =>
				line.includes(ANTIGRAVITY) && !line.includes(ANTIGRAVITY_CLAUDE),
		);
		ok(
			mentionsClaude,
			`expected log to mention ${ANTIGRAVITY_CLAUDE}: ${result.log}`,
		);
		ok(mentionsGemini, `expected log to mention ${ANTIGRAVITY}: ${result.log}`);
		strictEqual(result.provider, ANTIGRAVITY_CLAUDE);
	});

	it("blind fallback keeps the enabled agy target in the candidate order", () => {
		removeSnapshot();
		const result = route({ requiredCapability: "standard" });
		ok(
			result.log.some((line) => line.startsWith("snapshot missing")),
			"expected the blind-routing path to have been taken",
		);
		const blindLine = result.log.find((line) =>
			line.startsWith("blind candidates:"),
		);
		ok(blindLine, `expected a blind candidates log line, got: ${result.log}`);
		strictEqual(result.provider, "claude");
		strictEqual(result.resolvedTargetId, "claude-code");
		ok(
			blindLine.includes("agy"),
			`expected agy in blind candidates, got: ${blindLine}`,
		);
	});

	it("plain agy resolves to the separately enabled Claude target", () => {
		strictEqual(resolveTargetIdentity("agy").ambiguous, false);
		strictEqual(resolveTargetIdentity("agy").targetId, "antigravity-claude");
		const result = route({
			requiredCapability: "standard",
			only: ["agy"],
		});
		strictEqual(result.provider, "agy");
		strictEqual(result.resolvedTargetId, "antigravity-claude");
	});

	it("routeBlind uses the enabled Claude target for a plain agy alias", () => {
		const result = routeBlind(["agy"]);
		strictEqual(result.provider, "agy");
		strictEqual(result.resolvedTargetId, "antigravity-claude");
	});

	it("routeBlind rejects an exact disabled Gemini target without same-harness fallback", () => {
		const result = routeBlind([ANTIGRAVITY]);
		strictEqual(result.provider, null);
		strictEqual(result.reason, "no_eligible_blind");
	});

	it("allows an exact target id to select only its shared-harness target", () => {
		writeSnapshot([
			{
				name: ANTIGRAVITY_CLAUDE,
				ok: true,
				windows: [{ percent_left: 40, pace_delta: 0 }],
			},
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 95, pace_delta: 0 }],
			},
		]);
		const result = route({
			requiredCapability: "standard",
			only: ["antigravity-claude"],
		});
		strictEqual(result.provider, ANTIGRAVITY_CLAUDE);
		strictEqual(result.resolvedTargetId, "antigravity-claude");
	});

	it("--only-provider cannot force the disabled Gemini target", () => {
		writeSnapshot([
			{
				name: ANTIGRAVITY,
				ok: true,
				windows: [{ percent_left: 99, pace_delta: 0 }],
			},
		]);
		const result = route({
			requiredCapability: "standard",
			only: ["antigravity"],
		});
		strictEqual(result.provider, null);
		strictEqual(result.resolvedTargetId, null);
	});
});
