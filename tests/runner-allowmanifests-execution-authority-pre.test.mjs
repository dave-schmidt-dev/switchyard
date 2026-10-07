import { rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	executeTaskAsync,
	parseTaskQueue,
} from "../src/switchyard/runner/index.mjs";
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
function parseFixture(markdown) {
	return parseTaskQueue(withExplicitSwitchyardExecutor(markdown));
}
// Async-only task context: the broker seam is stubbed and the descriptor is
// derived from the routed provider/model so executeTaskAsync can run without
// the synchronous router.
function asyncTaskContext({ route, integrationGate, captureDiff }) {
	let latestDescriptor = null;
	return {
		broker: {
			selectAndReserve: async (request) => {
				const routed = route({ requiredCapability: request.capability });
				if (!routed) return null;
				latestDescriptor = descriptorForRoute(routed);
				return {
					provider: routed.provider,
					model: routed.model,
					resolvedTarget: routed.resolvedTargetId ?? routed.provider,
					harness: routed.resolved_harness ?? routed.provider,
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
		integrationGate,
		adapters: {
			claude: {
				executeAsync: async () => ({ success: true, output: "ok" }),
				captureDiffAsync: captureDiff,
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
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("AllowManifests execution authority and pre-routing rejection", () => {
	it("passes allowSensitiveManifests: false to integrationGate when AllowManifests: false", async () => {
		const markdown = `## Phase 1

### Task 1.1: AllowManifests false task
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** false
- **Description:** No manifest authority
`;
		const task = parseFixture(markdown)[0];
		strictEqual(task.allowManifests, false);

		const gateCalls = [];
		const result = await executeTaskAsync(
			task,
			asyncTaskContext({
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				captureDiff: async () => "diff --git a/package.json b/package.json",
			}),
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.allowSensitiveManifests, false);
	});

	it("passes allowSensitiveManifests: true to integrationGate when AllowManifests: true", async () => {
		const markdown = `## Phase 1

### Task 1.1: AllowManifests true task
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** true
- **Description:** Authorized manifest change
`;
		const task = parseFixture(markdown)[0];
		strictEqual(task.allowManifests, true);

		const gateCalls = [];
		const result = await executeTaskAsync(
			task,
			asyncTaskContext({
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				captureDiff: async () => "diff --git a/package.json b/package.json",
			}),
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.allowSensitiveManifests, true);
	});

	it("fails before routing when task contains invalid AllowManifests value", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Invalid AllowManifests task
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** invalid_value
- **Description:** Bad value
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		let routeCalled = false;
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					route: () => {
						routeCalled = true;
						return {
							provider: "claude",
							model: "claude-sonnet-5",
							percentLeft: 50,
							reason: "spread",
						};
					},
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => ({ success: true }),
					adapters: {
						claude: {
							executeAsync: async () => ({ success: true, output: "ok" }),
							captureDiffAsync: async () => "diff",
						},
					},
				},
			}),
			/AllowManifests must be true or false when present/,
		);
		strictEqual(routeCalled, false);
	});
});
