// Task 1.6 (roster-unification plan), M1b: selectAdapter must key on the
// resolved HARNESS, not the snapshot provider/display name.
//
// The bug: adapters are keyed by harness ("opencode"), but a route's `provider`
// is a snapshot display name ("OpenCode Go"). The old
// `providerName.toLowerCase()` produced "opencode go", which never matched the
// "opencode" adapter key, so EVERY opencode-target dispatch collapsed to
// `unsupported_provider` before it could run. This test drives executeTask with
// a mocked route returning the display name and asserts the opencode adapter is
// actually invoked and the dispatch is NOT recorded as unsupported_provider.

import { strictEqual } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import { executeTask } from "../src/switchyard/runner/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");
const crossHarnessRoot = tempDir("switchyard-vibe-opencode-roster-");
const CROSS_HARNESS_FIXTURE_PATH = resolve(crossHarnessRoot, "roster.json");

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
const TASK_BASE = {
	ref: "refs/switchyard/task-base/harness-fixture/T-1",
	tree: "1".repeat(40),
};

before(() => {
	process.env.SWITCHYARD_ROSTER_PATH = FIXTURE_PATH;
	__resetRosterCacheForTests();
});

after(() => {
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
	rmSync(crossHarnessRoot, { recursive: true, force: true });
});

// Build a context whose route() returns a fixed result and whose adapters are
// keyed by harness (exactly as runQueue wires them). Records every dispatch.
function makeContext({
	provider,
	model,
	targetId = provider === "OpenCode Go" ? "opencode-go" : "claude-code",
	harness = provider === "OpenCode Go" ? "opencode" : "claude",
}) {
	const dispatches = [];
	const dispatchIntents = [];
	const calls = { execute: 0, lastModel: null };
	const descriptor = syntheticDescriptor({ targetId, model, harness });
	return {
		context: {
			queueBackend: {
				captureTaskBase: () => TASK_BASE,
				validateTaskBase: (_workspaceId, base) => base,
			},
			taskBases: {},
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
			recordDispatchIntent: (intent) => dispatchIntents.push(intent),
			adapters: {
				opencode: {
					execute: (_prompt, _container, opts) => {
						calls.execute += 1;
						calls.lastModel = opts?.model ?? null;
						return { success: true };
					},
					captureDiff: () => "", // empty -> success_no_diff path
				},
			},
			recordDispatch: (d) => dispatches.push(d),
			integrationGate: () => ({ success: true }),
			projectPath: "/tmp/does-not-matter",
			workingContainerName: "test-container",
			exclude: [],
		},
		dispatches,
		dispatchIntents,
		calls,
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

const TASK = {
	id: "T-1",
	title: "trivial task",
	description: "trivial task",
	prompt: "do the thing",
	requiredPaths: null,
};

describe("runner M1b — adapter selected by resolved harness", () => {
	it("dispatches an 'OpenCode Go' route through the opencode adapter (not unsupported_provider)", () => {
		const { context, dispatches, dispatchIntents, calls } = makeContext({
			provider: "OpenCode Go",
			model: "fixture/opencode-low",
		});

		const result = executeTask(TASK, context);

		// The opencode adapter actually ran — the route survived to dispatch.
		strictEqual(calls.execute, 1, "opencode adapter.execute must be invoked");
		strictEqual(calls.lastModel, "fixture/opencode-low");

		// The result is a real execution outcome, never the unsupported_provider
		// collapse the old provider-name keying produced.
		strictEqual(result.result, "success_no_diff");
		strictEqual(result.success, true);
		strictEqual(result.provider, "OpenCode Go");

		strictEqual(dispatches.length, 1);
		strictEqual(dispatches[0].result, "success_no_diff");
		strictEqual(dispatchIntents.length, 1);
		strictEqual(dispatchIntents[0].taskId, TASK.id);
	});

	it("keeps a Vibe accounting target while executing its Mistral GLM selector through OpenCode", () => {
		const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
		roster.targets.vibe.harness = "opencode";
		roster.targets.vibe.snapshot_name = "Vibe";
		writeFileSync(CROSS_HARNESS_FIXTURE_PATH, JSON.stringify(roster), "utf8");
		process.env.SWITCHYARD_ROSTER_PATH = CROSS_HARNESS_FIXTURE_PATH;
		__resetRosterCacheForTests();
		try {
			const { context, dispatches, calls } = makeContext({
				provider: "Vibe",
				targetId: "vibe",
				harness: "opencode",
				model: "mistral/zai-glm-5-2",
			});

			const result = executeTask(TASK, context);

			strictEqual(calls.execute, 1, "the resolved OpenCode adapter must run");
			strictEqual(calls.lastModel, "mistral/zai-glm-5-2");
			strictEqual(result.provider, "Vibe");
			strictEqual(result.resolvedTargetId, "vibe");
			strictEqual(result.success, true);
			strictEqual(dispatches[0].resolvedTargetId, "vibe");
		} finally {
			process.env.SWITCHYARD_ROSTER_PATH = FIXTURE_PATH;
			__resetRosterCacheForTests();
		}
	});

	it("still records unsupported_provider when no adapter exists for the resolved harness", () => {
		// A provider whose harness has no registered adapter must still fail
		// closed — the fix routes by harness, it does not invent adapters.
		const { context, dispatches, calls } = makeContext({
			provider: "Claude", // normalizes to harness "claude", absent from adapters
			model: "fixture-claude-high",
		});

		const result = executeTask(TASK, context);

		strictEqual(calls.execute, 0, "no adapter should run");
		strictEqual(result.result, "unsupported_provider");
		strictEqual(dispatches[0].result, "unsupported_provider");
	});
});
