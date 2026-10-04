import { strictEqual, throws } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	executeTask,
	parseFixture,
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
describe("AllowManifests execution authority and pre-routing rejection", () => {
	it("passes allowSensitiveManifests: false to integrationGate when AllowManifests: false", () => {
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
		const result = executeTask(task, {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 50,
				reason: "spread",
			}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: (diff, projectPath, options) => {
				gateCalls.push({ diff, projectPath, options });
				return { success: true, message: "ok" };
			},
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/package.json b/package.json",
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.allowSensitiveManifests, false);
	});

	it("passes allowSensitiveManifests: true to integrationGate when AllowManifests: true", () => {
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
		const result = executeTask(task, {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 50,
				reason: "spread",
			}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: (diff, projectPath, options) => {
				gateCalls.push({ diff, projectPath, options });
				return { success: true, message: "ok" };
			},
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/package.json b/package.json",
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.allowSensitiveManifests, true);
	});

	it("fails before routing when task contains invalid AllowManifests value", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Invalid AllowManifests task
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** invalid_value
- **Description:** Bad value
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		let routeCalled = false;
		throws(
			() =>
				runQueue({
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
								execute: () => ({ success: true, output: "ok" }),
								captureDiff: () => "diff",
							},
						},
					},
				}),
			/AllowManifests must be true or false when present/,
		);
		strictEqual(routeCalled, false);
	});
});
