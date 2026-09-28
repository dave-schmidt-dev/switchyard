import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	__resetRosterCacheForTests,
	computeRosterSha,
	getInvocationDescriptorIdentity,
	resolveRouteProvenance,
	resolveTargetProvenance,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import {
	executeTask,
	executeTaskWithOrchestrator,
} from "../src/switchyard/runner/index.mjs";
import {
	FIXTURE_PATH,
	PROVENANCE_KEYS,
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
function fixtureTaskBase(taskId = "1.1") {
	return {
		ref: `refs/switchyard/task-base/provenance/${taskId}`,
		tree: "5".repeat(40),
	};
}
function taskBaseContext() {
	return {
		queueBackend: {
			captureTaskBase: (_workspaceId, { taskId }) => fixtureTaskBase(taskId),
			captureTaskBaseAsync: async (_workspaceId, { taskId }) =>
				fixtureTaskBase(taskId),
			validateTaskBase: (_workspaceId, base) => base,
			validateTaskBaseAsync: async (_workspaceId, base) => base,
		},
		taskBases: {},
	};
}
function makeContext({ provider, model, adapters }) {
	const dispatches = [];
	const targetId =
		provider === "OpenCode Go"
			? "opencode-go"
			: provider === "Claude"
				? "claude-code"
				: provider;
	const harness = provider === "OpenCode Go" ? "opencode" : "claude";
	const descriptor = syntheticDescriptor({ targetId, model, harness });
	return {
		context: {
			...taskBaseContext(),
			route: () => ({
				provider,
				model,
				resolvedTargetId: targetId,
				resolved_harness: harness,
				invocationDescriptor: descriptor,
				percentLeft: 50,
				reason: "spread",
				log: [],
			}),
			resolveDescriptor: () => descriptor,
			adapters: adapters ?? {},
			recordDispatch: (d) => dispatches.push(d),
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true }),
			projectPath: "/tmp/does-not-matter",
			workingContainerName: "test-container",
			exclude: [],
		},
		dispatches,
	};
}
function syntheticDescriptor({ targetId, model, harness }) {
	const core = {
		target_id: targetId,
		model_ref: model,
		selector: model,
		effort: null,
		variant: null,
		invocation_args: [],
	};
	return validateInvocationDescriptor(
		{
			...core,
			descriptor_identity: getInvocationDescriptorIdentity(core, harness),
		},
		harness,
	);
}
const REVIEW_OUTPUT = JSON.stringify({ verdict: "clean" });
const TASK = {
	id: "T-1",
	title: "trivial task",
	description: "trivial task",
	prompt: "do the thing",
	requiredCapability: "low",
	requiredCapabilityJustification: "The task is a bounded mechanical change.",
	requiredPaths: null,
};
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
describe("executeTask — every dispatch record carries all six provenance fields", () => {
	it("carries provenance on the SUCCESS path (opencode-go via its adapter)", () => {
		let executed = 0;
		const { context, dispatches } = makeContext({
			provider: "OpenCode Go",
			model: "fixture/opencode-low",
			adapters: {
				opencode: {
					execute: () => {
						executed += 1;
						return { success: true };
					},
					captureDiff: () => "",
				},
			},
		});

		const result = executeTask(TASK, context);
		strictEqual(executed, 1);
		strictEqual(result.result, "success_no_diff");

		strictEqual(dispatches.length, 1);
		const rec = dispatches[0];
		for (const key of PROVENANCE_KEYS) ok(key in rec, `record missing ${key}`);
		strictEqual(rec.requiredCapability, "low");
		strictEqual(result.requiredCapability, "low");
		strictEqual(rec.roster_schema_version, 1);
		ok(/^[0-9a-f]{64}$/.test(rec.roster_sha256));
		strictEqual(rec.resolved_target, "opencode-go");
		strictEqual(rec.resolved_harness, "opencode");
		// credential_profile metadata (M1b) is recorded on the dispatch, not
		// passed to the adapter.
		strictEqual(rec.resolved_credential_profile, "go");
	});

	it("carries provenance on the UNSUPPORTED_PROVIDER path too (no record can omit it)", () => {
		// Claude normalizes to harness "claude" but no adapter is registered ->
		// unsupported_provider. The record must still carry provenance.
		const { context, dispatches } = makeContext({
			provider: "Claude",
			model: "fixture-claude-high",
			adapters: {},
		});

		const result = executeTask(TASK, context);
		strictEqual(result.result, "unsupported_provider");

		const rec = dispatches[0];
		for (const key of PROVENANCE_KEYS) ok(key in rec, `record missing ${key}`);
		strictEqual(rec.resolved_target, "claude-code");
		strictEqual(rec.resolved_harness, "claude");
		// claude-code is qualified at every tier, so the selector is a real claude
		// selector regardless of the classified tier.
		ok(
			typeof rec.resolved_selector === "string" &&
				rec.resolved_selector.startsWith("fixture-claude-"),
			`expected a claude selector, got ${rec.resolved_selector}`,
		);
	});

	it("attaches the six fields onto routeResult itself", () => {
		// Hold a reference to the exact object route() returns; executeTask does
		// Object.assign(routeResult, provenance) on it, so after the call the
		// provenance must be visible on this same object.
		const routeResultObj = {
			provider: "OpenCode Go",
			model: "fixture/opencode-low",
			resolvedTargetId: "opencode-go",
			resolved_harness: "opencode",
			invocationDescriptor: syntheticDescriptor({
				targetId: "opencode-go",
				model: "fixture/opencode-low",
				harness: "opencode",
			}),
			percentLeft: 50,
			reason: "spread",
			log: [],
		};
		const context = {
			...taskBaseContext(),
			route: () => routeResultObj,
			adapters: {
				opencode: {
					execute: () => ({ success: true }),
					captureDiff: () => "",
				},
			},
			recordDispatch: () => {},
			integrationGate: () => ({ success: true }),
			projectPath: "/tmp/x",
			workingContainerName: "c",
			exclude: [],
		};
		context.resolveDescriptor = () => routeResultObj.invocationDescriptor;
		executeTask(TASK, context);
		for (const key of PROVENANCE_KEYS) {
			ok(key in routeResultObj, `routeResult missing ${key}`);
		}
		strictEqual(routeResultObj.resolved_target, "opencode-go");
		strictEqual(routeResultObj.resolved_harness, "opencode");
		strictEqual(routeResultObj.resolved_credential_profile, "go");
		strictEqual(routeResultObj.requiredCapability, "low");
	});
});
function makeOrchestratorContext({
	provider,
	model,
	orchestratorOverrides = {},
}) {
	const dispatches = [];
	const targetId =
		provider === "OpenCode Go"
			? "opencode-go"
			: provider === "Claude"
				? "claude-code"
				: provider;
	const harness = provider === "OpenCode Go" ? "opencode" : "claude";
	const descriptor = syntheticDescriptor({ targetId, model, harness });
	return {
		context: {
			...taskBaseContext(),
			route: () => ({
				provider,
				model,
				resolvedTargetId: targetId,
				resolved_harness: harness,
				invocationDescriptor: descriptor,
				percentLeft: 50,
				reason: "spread",
				log: [],
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: (d) => dispatches.push(d),
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true }),
			projectPath: "/tmp/does-not-matter",
			workingContainerName: "test-container",
			exclude: [],
			adapters: {
				[harness]: { captureDiffAsync: async () => "" },
			},
			orchestrator: {
				launch: async () => "job-1",
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
				...orchestratorOverrides,
			},
		},
		dispatches,
	};
}
describe("executeTaskWithOrchestrator — every dispatch record carries all six provenance fields", () => {
	it("carries provenance on the SUCCESS path (opencode-go via the orchestrator)", async () => {
		const { context, dispatches } = makeOrchestratorContext({
			provider: "OpenCode Go",
			model: "fixture/opencode-low",
		});

		const result = await executeTaskWithOrchestrator(TASK, context);
		strictEqual(result.result, "success_no_diff");
		strictEqual(result.requiredCapability, "low");

		strictEqual(dispatches.length, 1);
		const rec = dispatches[0];
		for (const key of PROVENANCE_KEYS) ok(key in rec, `record missing ${key}`);
		strictEqual(rec.requiredCapability, "low");
		strictEqual(rec.roster_schema_version, 1);
		ok(/^[0-9a-f]{64}$/.test(rec.roster_sha256));
		strictEqual(rec.resolved_target, "opencode-go");
		strictEqual(rec.resolved_harness, "opencode");
		strictEqual(rec.resolved_credential_profile, "go");
	});

	it("carries provenance on the launch_failed path (an early record() call site)", async () => {
		// The orchestrator path has record() call sites the adapter path doesn't
		// (launch/poll/result failures). This is the earliest one — proves
		// provenance is resolved and attached BEFORE the launch is even attempted,
		// not bolted on only at the success tail.
		const { context, dispatches } = makeOrchestratorContext({
			provider: "Claude",
			model: "fixture-claude-high",
			orchestratorOverrides: {
				launch: async () => {
					throw new Error("orchestrator unreachable");
				},
			},
		});

		const result = await executeTaskWithOrchestrator(TASK, context);
		strictEqual(result.result, "launch_failed");
		strictEqual(result.requiredCapability, "low");

		strictEqual(dispatches.length, 1);
		const rec = dispatches[0];
		for (const key of PROVENANCE_KEYS) ok(key in rec, `record missing ${key}`);
		strictEqual(rec.requiredCapability, "low");
		strictEqual(rec.resolved_target, "claude-code");
		strictEqual(rec.resolved_harness, "claude");
		ok(
			typeof rec.resolved_selector === "string" &&
				rec.resolved_selector.startsWith("fixture-claude-"),
			`expected a claude selector, got ${rec.resolved_selector}`,
		);
		ok(
			typeof rec.resolved_credential_profile === "string" &&
				rec.resolved_credential_profile.length > 0,
			`expected a credential profile, got ${rec.resolved_credential_profile}`,
		);
	});
});
