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
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import {
	executeTask,
	executeTaskWithOrchestrator,
} from "../src/switchyard/runner/index.mjs";

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
describe("executeTask / executeTaskWithOrchestrator dispatch the CORRECT selector per target (C.7 proof)", () => {
	const taskBase = {
		ref: "refs/switchyard/task-base/dual-target/T-dual-agy",
		tree: "2".repeat(40),
	};
	const taskBaseContext = {
		queueBackend: {
			captureTaskBase: () => taskBase,
			captureTaskBaseAsync: async () => taskBase,
			validateTaskBase: (_workspaceId, base) => base,
			validateTaskBaseAsync: async (_workspaceId, base) => base,
		},
		taskBases: {},
	};
	function makeAdapterContext({ provider, model, targetId }) {
		const executeCalls = [];
		const descriptor = syntheticDescriptor({
			targetId,
			model,
			harness: "agy",
		});
		return {
			context: {
				...taskBaseContext,
				taskBases: {},
				route: () => ({
					provider,
					model,
					resolvedTargetId: targetId,
					resolved_harness: "agy",
					invocationDescriptor: descriptor,
					percentLeft: 50,
					reason: "spread",
					log: [],
				}),
				resolveDescriptor: () => descriptor,
				adapters: {
					agy: {
						execute: (_prompt, _containerName, opts) => {
							executeCalls.push(opts);
							return { success: true };
						},
						captureDiff: () => "",
					},
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true }),
				projectPath: "/tmp/does-not-matter",
				workingContainerName: "test-container",
				exclude: [],
			},
			executeCalls,
		};
	}

	const TASK = {
		id: "T-dual-agy",
		title: "trivial task",
		description: "trivial task",
		prompt: "do the thing",
		requiredPaths: null,
	};

	it("executeTask passes the Claude bucket's model to the SAME 'agy' adapter", () => {
		const { context, executeCalls } = makeAdapterContext({
			provider: ANTIGRAVITY_CLAUDE,
			model: "fixture-agy-claude-standard",
			targetId: "antigravity-claude",
		});
		const result = executeTask(TASK, context);
		strictEqual(result.result, "success_no_diff");
		strictEqual(executeCalls.length, 1);
		strictEqual(executeCalls[0].model, "fixture-agy-claude-standard");
	});

	it("executeTask passes the Gemini bucket's model to the SAME 'agy' adapter", () => {
		const { context, executeCalls } = makeAdapterContext({
			provider: ANTIGRAVITY,
			model: "fixture-agy-gemini-standard",
			targetId: "antigravity",
		});
		const result = executeTask(TASK, context);
		strictEqual(result.result, "success_no_diff");
		strictEqual(executeCalls.length, 1);
		strictEqual(executeCalls[0].model, "fixture-agy-gemini-standard");
	});

	function makeOrchestratorContext({ provider, model, targetId }) {
		const launchCalls = [];
		const descriptor = syntheticDescriptor({
			targetId,
			model,
			harness: "agy",
		});
		return {
			context: {
				...taskBaseContext,
				taskBases: {},
				route: () => ({
					provider,
					model,
					resolvedTargetId: targetId,
					resolved_harness: "agy",
					invocationDescriptor: descriptor,
					percentLeft: 50,
					reason: "spread",
					log: [],
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true }),
				projectPath: "/tmp/does-not-matter",
				workingContainerName: "test-container",
				exclude: [],
				adapters: {
					agy: { captureDiffAsync: async () => "" },
				},
				orchestrator: {
					launch: async (payload) => {
						launchCalls.push(payload);
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
			launchCalls,
		};
	}

	it("executeTaskWithOrchestrator forwards the Claude bucket's model into orchestrator.launch", async () => {
		const { context, launchCalls } = makeOrchestratorContext({
			provider: ANTIGRAVITY_CLAUDE,
			model: "fixture-agy-claude-standard",
			targetId: "antigravity-claude",
		});
		await executeTaskWithOrchestrator(TASK, context);
		strictEqual(launchCalls.length, 1);
		strictEqual(launchCalls[0].provider, ANTIGRAVITY_CLAUDE);
		strictEqual(launchCalls[0].model, "fixture-agy-claude-standard");
	});

	it("executeTaskWithOrchestrator forwards the Gemini bucket's model into orchestrator.launch", async () => {
		const { context, launchCalls } = makeOrchestratorContext({
			provider: ANTIGRAVITY,
			model: "fixture-agy-gemini-standard",
			targetId: "antigravity",
		});
		await executeTaskWithOrchestrator(TASK, context);
		strictEqual(launchCalls.length, 1);
		strictEqual(launchCalls[0].provider, ANTIGRAVITY);
		strictEqual(launchCalls[0].model, "fixture-agy-gemini-standard");
	});

	it("review tasks use the normal high-capability route without a reviewer role flag", () => {
		const routeCalls = [];
		const { context } = makeAdapterContext({
			provider: ANTIGRAVITY_CLAUDE,
			model: "fixture-agy-claude-standard",
			targetId: "antigravity-claude",
		});
		context.route = (options) => {
			routeCalls.push(options);
			return {
				provider: ANTIGRAVITY_CLAUDE,
				model: "fixture-agy-claude-standard",
				percentLeft: 50,
				reason: "spread",
			};
		};
		executeTask(
			{
				...TASK,
				type: "review",
				requiredCapability: "high",
				requiredCapabilityJustification:
					"The review spans provider boundaries.",
			},
			context,
		);
		strictEqual(routeCalls[0].requiredCapability, "high");
		strictEqual(Object.hasOwn(routeCalls[0], "reviewerRole"), false);
	});
});
