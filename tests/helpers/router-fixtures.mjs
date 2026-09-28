import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getInvocationDescriptorIdentity } from "../../src/switchyard/roster/index.mjs";

const __dirname = fileURLToPath(new URL("..", import.meta.url));

const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

const SNAPSHOT_PATH = join(
	tmpdir(),
	`switchyard-router-test-${process.pid}-${randomUUID()}.json`,
);

const ROUTER_ROSTER_PATH = join(
	tmpdir(),
	`switchyard-router-roster-${process.pid}-${randomUUID()}.json`,
);

const HEALTH_ROOT = join(
	tmpdir(),
	`switchyard-health-test-${process.pid}-${randomUUID()}`,
);

const HEALTH_RUN_ROOT = join(
	tmpdir(),
	`switchyard-health-runs-${process.pid}-${randomUUID()}`,
);

const previousRunStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;

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
				const descriptor = {
					target_id: targetId,
					model_ref: slot.model_ref,
					selector: model.selector,
					effort: slot.effort ?? null,
					variant: slot.variant ?? null,
					invocation_args: slot.invocation_args ?? [],
				};
				const descriptorIdentity = getInvocationDescriptorIdentity(
					descriptor,
					target.harness,
				);
				target.qualifications ??= {};
				target.qualifications[descriptorIdentity] = {
					...descriptor,
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

function buildDualCodexRoster({ incumbentSnapshotName }) {
	const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
	if (incumbentSnapshotName) {
		roster.targets.codex.snapshot_name = incumbentSnapshotName;
	}
	roster.models["fixture/codex-spark-low"] = {
		selector: "fixture-codex-spark-low",
		base_model: "fixture-codex-spark-low",
		model_provider: "fixture",
		status: "active",
	};
	roster.targets["codex-spark"] = {
		harness: "codex",
		snapshot_name: "Codex (Spark)",
		enabled: true,
		technical_ceiling: "low",
		// Selector-keyed `qualified` and descriptor-identity-keyed
		// `dispatch_qualified` are two DIFFERENT records: the first is what
		// autoRoutingCeiling() reads to give the target a capability_class,
		// the second is the routing descriptor gate that
		// withDispatchQualifiedDescriptors() adds below. Omitting this one
		// leaves the target ineligible ("below required capability low"), and
		// each caller's control assertion is what catches that.
		qualifications: {
			"fixture-codex-spark-low": { status: "qualified" },
		},
		slots: {
			low: [{ model_ref: "fixture/codex-spark-low", priority: 1 }],
			standard: [],
			high: [],
		},
	};
	return withDispatchQualifiedDescriptors(roster);
}

function createTestSnapshot(providers, updatedAt = new Date().toISOString()) {
	writeFileSync(
		SNAPSHOT_PATH,
		JSON.stringify({
			schema_version: 2,
			updated_at: updatedAt,
			providers,
		}),
		"utf8",
	);
}

export {
	__dirname,
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
};
