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
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { executeTask } from "../src/switchyard/runner/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;

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
});

// Build a context whose route() returns a fixed result and whose adapters are
// keyed by harness (exactly as runQueue wires them). Records every dispatch.
function makeContext({ provider, model }) {
	const dispatches = [];
	const calls = { execute: 0, lastModel: null };
	return {
		context: {
			route: () => ({
				provider,
				model,
				percentLeft: 50,
				reason: "spread",
				log: [],
			}),
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
		calls,
	};
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
		const { context, dispatches, calls } = makeContext({
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
