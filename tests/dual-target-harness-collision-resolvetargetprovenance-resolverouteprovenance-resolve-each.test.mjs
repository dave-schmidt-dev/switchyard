// @test-phase: other
import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
	resolveRouteProvenance,
	resolveTargetProvenance,
} from "../src/switchyard/roster/index.mjs";

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
describe("resolveTargetProvenance / resolveRouteProvenance resolve each target's OWN identity (C.8)", () => {
	it("resolves the Claude bucket's target id, selector, and credential_profile", () => {
		deepStrictEqual(resolveTargetProvenance(ANTIGRAVITY_CLAUDE, "standard"), {
			resolved_target: "antigravity-claude",
			resolved_harness: "agy",
			resolved_selector: "fixture-agy-claude-standard",
			resolved_credential_profile: "claude-profile",
		});
	});

	it("resolves the Gemini bucket's target id, selector, and credential_profile", () => {
		deepStrictEqual(resolveTargetProvenance(ANTIGRAVITY, "standard"), {
			resolved_target: "antigravity",
			resolved_harness: "agy",
			resolved_selector: null,
			resolved_credential_profile: "gemini-profile",
		});
	});

	it("the two directions never cross — provenance never attributes one bucket's dispatch to the other", () => {
		const claudeProv = resolveRouteProvenance(ANTIGRAVITY_CLAUDE, "standard");
		const geminiProv = resolveRouteProvenance(ANTIGRAVITY, "standard");
		notStrictEqual(claudeProv.resolved_target, geminiProv.resolved_target);
		notStrictEqual(claudeProv.resolved_selector, geminiProv.resolved_selector);
		notStrictEqual(
			claudeProv.resolved_credential_profile,
			geminiProv.resolved_credential_profile,
		);
		strictEqual(claudeProv.resolved_target, "antigravity-claude");
		strictEqual(geminiProv.resolved_target, "antigravity");
	});
});
