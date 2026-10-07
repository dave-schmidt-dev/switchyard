import { rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { executeTaskAsync } from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runnerTestDir,
	runQueueAsync,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
function capturingRoute(routeCalls) {
	return (opts) => {
		routeCalls.push(opts);
		return {
			provider: "claude",
			model: "claude-sonnet-5",
			percentLeft: 50,
			reason: "spread",
		};
	};
}
// Async-only task context: the broker seam forwards the declared capability
// through the same route() seam the queue broker uses, and the descriptor is
// derived from the routed provider/model.
function capabilityCapturingContext(routeCalls) {
	let latestDescriptor = null;
	return {
		broker: {
			selectAndReserve: async (request) => {
				const routed = capturingRoute(routeCalls)({
					requiredCapability: request.capability,
				});
				latestDescriptor = descriptorForRoute(routed);
				return {
					provider: routed.provider,
					model: routed.model,
					resolvedTarget: routed.provider,
					harness: routed.provider,
					capability: request.capability,
					reason: routed.reason,
					reservation: { id: "test-reservation" },
					snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
				};
			},
			launcherIdentity: () => ({}),
			execute: async () => ({ success: true, output: "ok" }),
			release: async () => {},
		},
		resolveDescriptor: () => latestDescriptor,
		recordDispatch: () => {},
		recordDispatchIntent: () => {},
		integrationGate: () => ({ success: true, message: "ok" }),
		adapters: {
			claude: {
				executeAsync: async () => ({ success: true, output: "ok" }),
				captureDiffAsync: async () => null,
			},
		},
		queueBackend: {
			captureTaskBase: () => TASK_BASE,
			validateTaskBase: (_workspaceId, base) => base,
			releaseTaskBase: () => {},
		},
		projectPath: TEST_DIR,
		workingContainerName: "fake-container",
	};
}
function routingDependencies(routeCalls) {
	return {
		route: capturingRoute(routeCalls),
		recordDispatch: () => {},
		integrationGate: () => ({ success: true, message: "ok" }),
		adapters: {
			claude: {
				executeAsync: async () => ({ success: true, output: "ok" }),
				captureDiffAsync: async () => "diff --git a/a b/a",
			},
		},
	};
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("runner task contract resolution", () => {
	it("executeTask routes at RequiredCapability regardless of description text", async () => {
		const routeCalls = [];
		// Description text must never override the declared capability.
		await executeTaskAsync(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: "high",
				requiredCapabilityJustification:
					"The task requires architectural review.",
			},
			capabilityCapturingContext(routeCalls),
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
	});

	it("legacy programmatic task objects with an omitted capability use standard", async () => {
		const routeCalls = [];
		await executeTaskAsync(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: null,
			},
			capabilityCapturingContext(routeCalls),
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "standard");
	});

	it("executeTask never provider-routes native or human tasks", async () => {
		for (const executor of ["native", "human"]) {
			const routeCalls = [];
			const result = await executeTaskAsync(
				{
					id: "1.1",
					title: "task",
					description: "format the readme",
					executor,
					requiredCapability: "high",
					requiredCapabilityJustification:
						"The task requires architectural review.",
				},
				capabilityCapturingContext(routeCalls),
			);
			strictEqual(routeCalls.length, 0);
			strictEqual(result.provider, null);
			strictEqual(result.result, "executor_not_switchyard");
		}
	});

	it("executeTask rejects an invalid RequiredCapability instead of silently routing at capability 0", async () => {
		const routeCalls = [];
		await rejects(
			executeTaskAsync(
				{
					id: "1.1",
					title: "task",
					description: "format the readme",
					requiredCapability: "urgent",
				},
				capabilityCapturingContext(routeCalls),
			),
			/invalid declared RequiredCapability "urgent"/,
		);
		// The reject must happen before route() is ever reached -- an invalid
		// RequiredCapability must not silently reach the router as a fallback or
		// zero capability.
		strictEqual(routeCalls.length, 0);
	});

	it("executeTask rejects explicit low/high capability without justification before routing", async () => {
		for (const capability of ["high", "low"]) {
			const routeCalls = [];
			await rejects(
				executeTaskAsync(
					{
						id: "1.1",
						title: "task",
						description: "format the readme",
						requiredCapability: capability,
					},
					capabilityCapturingContext(routeCalls),
				),
				/RequiredCapabilityJustification is required for explicit/,
			);
			strictEqual(routeCalls.length, 0);
		}
	});

	it("end to end: RequiredCapability reaches route() as requiredCapability", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Declared-capability task
- **Status:** pending
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** The task requires architectural review.
- **Description:** format the readme
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: routingDependencies(routeCalls),
		});

		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
	});
});
