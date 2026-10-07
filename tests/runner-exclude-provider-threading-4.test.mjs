import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDefaultRouteHealthDecision } from "../src/switchyard/router/health.mjs";
import {
	executeTask,
	runnerTestDir,
	runQueue,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("--exclude-provider threading (context.exclude -> route)", () => {
	it("binds route-health identity to the selected golden image", () => {
		const first = createDefaultRouteHealthDecision({
			qualifiedProviders: [],
			goldenImageReference: "golden-a",
		});
		const second = createDefaultRouteHealthDecision({
			qualifiedProviders: [],
			goldenImageReference: "golden-b",
		});
		notStrictEqual(
			first.publicConfigurationEpoch,
			second.publicConfigurationEpoch,
		);
	});
	it("runQueue forwards options.only onto context.only, reaching route() via executeTask (Task C.9)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			only: ["codex"],
			dependencies: {
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 60,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].only, ["codex"]);
	});
	it("runQueue defaults context.only to [] when options.only is omitted (Task C.9)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 60,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
			},
		});

		deepStrictEqual(routeCalls[0].only, []);
	});
	it("executeTask passes context.only through to route(), alongside exclude and availableProviders (Task C.9)", () => {
		const routeCalls = [];

		executeTask(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 50,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				only: ["codex"],
				platform: "macos",
				goldenImageVerifiedProviders: ["codex"],
			},
		);

		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].only, ["codex"]);
		deepStrictEqual(routeCalls[0].availableProviders, ["codex"]);
		strictEqual(routeCalls[0].platform, "macos");
		deepStrictEqual(routeCalls[0].goldenImageVerifiedProviders, ["codex"]);
	});
});
