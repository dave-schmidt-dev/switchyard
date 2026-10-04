import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	findIgnoredDeclaredPath,
	loadCheckpoint,
} from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	executeTask,
	executeTaskAsync,
	executeTaskWithOrchestrator,
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
describe("reject declared paths that cannot be seeded (Task 1.1)", () => {
	it("findIgnoredDeclaredPath identifies Git-ignored files and ignores tracked/unignored paths", () => {
		strictEqual(findIgnoredDeclaredPath(null), null);
		strictEqual(findIgnoredDeclaredPath([]), null);
		strictEqual(findIgnoredDeclaredPath([""]), null);
		strictEqual(
			findIgnoredDeclaredPath(["src/switchyard/runner/index.mjs"]),
			null,
		);
		strictEqual(
			findIgnoredDeclaredPath(["src/switchyard/new_untracked_file.mjs"]),
			null,
		);
		strictEqual(findIgnoredDeclaredPath(["HISTORY.md"]), "HISTORY.md");
		strictEqual(findIgnoredDeclaredPath(["TASKS.md"]), "TASKS.md");
		strictEqual(findIgnoredDeclaredPath([".logs/run.json"]), ".logs/run.json");
		strictEqual(
			findIgnoredDeclaredPath([
				"src/switchyard/runner/index.mjs",
				"HISTORY.md",
			]),
			"HISTORY.md",
		);
	});

	it("executeTask rejects an ignored declared path before provider routing with declared_path_not_seeded", () => {
		const routeCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "edit history",
				description: "record update",
				requiredPaths: ["HISTORY.md"],
			},
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff",
					},
				},
				projectPath: TEST_DIR,
			},
		);

		strictEqual(routeCalls.length, 0, "must not route to any provider");
		strictEqual(result.success, false);
		strictEqual(result.provider, null);
		strictEqual(result.model, null);
		strictEqual(result.result, "declared_path_not_seeded");
		strictEqual(result.errorKind, "declared_path_not_seeded");
		strictEqual(result.reasonCode, "declared_path_not_seeded");
		strictEqual(
			result.reason,
			"The task declared a Git-ignored path that cannot be seeded or captured.",
		);
		ok(!result.reason.includes("HISTORY.md"));
	});

	it("executeTask preserves current behavior for tracked paths and unignored new files", () => {
		const routeCalls = [];
		const gateCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "valid work",
				description: "implementation",
				requiredPaths: [
					"src/switchyard/runner/index.mjs",
					"src/switchyard/new_untracked_test_file.mjs",
				],
			},
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(routeCalls.length, 1);
		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
	});

	it("executeTask preserves current behavior when requiredPaths is null", () => {
		const routeCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "review task",
				description: "no required paths",
				requiredPaths: null,
			},
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(routeCalls.length, 1);
		strictEqual(result.success, true);
	});

	it("review tasks never integrate provider diffs and report zero source mutations", () => {
		let gateCalls = 0;
		const result = executeTask(
			{
				id: "1.1",
				title: "review task",
				type: "review",
				description: "inspect changes",
				requiredPaths: null,
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 80,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => {
					gateCalls += 1;
					return { success: true, message: "must not run" };
				},
				adapters: {
					claude: {
						execute: () => ({
							success: true,
							output: JSON.stringify({
								verdict: "clean",
								findings: [],
							}),
						}),
						captureDiff: () => "diff --git a/secret b/secret",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, true);
		strictEqual(result.result, "review_completed");
		strictEqual(result.reviewResult.sourceMutationCount, 0);
		strictEqual(gateCalls, 0);
	});

	it("malformed review output stays unavailable across sync, broker, and orchestrator paths", async () => {
		const task = {
			id: "1.2",
			title: "malformed review",
			type: "review",
			description: "inspect changes",
			requiredPaths: null,
		};
		let syncGateCalls = 0;
		let syncCaptureCalls = 0;
		const syncResult = executeTask(task, {
			route: () => ({ provider: "claude", model: "claude-sonnet-5" }),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: () => {
				syncGateCalls += 1;
				throw new Error("review must not integrate");
			},
			adapters: {
				claude: {
					execute: () => ({
						success: true,
						output: "PROVIDER_SECRET_CANARY plain output",
					}),
					captureDiff: () => {
						syncCaptureCalls += 1;
						throw new Error("review must not capture");
					},
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});
		strictEqual(syncResult.result, "review_unavailable");
		strictEqual(syncResult.reviewResult.sourceMutationCount, 0);
		strictEqual(syncGateCalls, 0);
		strictEqual(syncCaptureCalls, 0);
		ok(!JSON.stringify(syncResult).includes("PROVIDER_SECRET_CANARY"));

		const descriptor = descriptorForRoute({
			provider: "claude",
			resolved_harness: "claude",
			resolvedTargetId: "claude-target",
			model: "claude-sonnet-5",
		});
		const route = {
			provider: "claude",
			model: "claude-sonnet-5",
			resolvedTarget: "claude-target",
			resolvedTargetId: "claude-target",
			harness: "claude",
			capability: "standard",
			reason: "fixture",
			snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
			reservation: { id: "review-reservation" },
		};
		let asyncGateCalls = 0;
		let asyncCaptureCalls = 0;
		const asyncResult = await executeTaskAsync(task, {
			broker: {
				selectAndReserve: async () => route,
				launcherIdentity: () => ({}),
				execute: async () => ({
					success: true,
					output: "PROVIDER_SECRET_CANARY plain broker output",
				}),
				release: async () => {},
			},
			resolveDescriptor: () => descriptor,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: () => {
				asyncGateCalls += 1;
				throw new Error("review must not integrate");
			},
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffAsync: async () => {
						asyncCaptureCalls += 1;
						throw new Error("review must not capture");
					},
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});
		strictEqual(asyncResult.result, "review_unavailable");
		strictEqual(asyncResult.reviewResult.sourceMutationCount, 0);
		strictEqual(asyncGateCalls, 0);
		strictEqual(asyncCaptureCalls, 0);
		ok(!JSON.stringify(asyncResult).includes("PROVIDER_SECRET_CANARY"));

		let orchestratorGateCalls = 0;
		let orchestratorCaptureCalls = 0;
		const orchestratorResult = await executeTaskWithOrchestrator(task, {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				resolved_harness: "claude",
				resolvedTargetId: "claude-target",
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: () => {
				orchestratorGateCalls += 1;
				throw new Error("review must not integrate");
			},
			orchestrator: {
				launch: async () => "review-job",
				status: async () => ({ state: "done" }),
				result: async () => ({
					success: true,
					output: "PROVIDER_SECRET_CANARY plain orchestrator output",
					diff: "diff --git a/secret b/secret",
				}),
			},
			adapters: {
				claude: {
					captureDiff: () => {
						orchestratorCaptureCalls += 1;
						throw new Error("review must not capture");
					},
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});
		strictEqual(orchestratorResult.result, "review_unavailable");
		strictEqual(orchestratorResult.reviewResult.sourceMutationCount, 0);
		strictEqual(orchestratorGateCalls, 0);
		strictEqual(orchestratorCaptureCalls, 0);
		ok(!JSON.stringify(orchestratorResult).includes("PROVIDER_SECRET_CANARY"));
	});

	it("executeTaskWithOrchestrator rejects an ignored declared path before provider routing or launch", async () => {
		const routeCalls = [];
		let launches = 0;
		const result = await executeTaskWithOrchestrator(
			{
				id: "1.1",
				title: "edit tasks record",
				description: "update tasks",
				requiredPaths: ["TASKS.md"],
			},
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => {
						launches += 1;
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "",
					},
				},
				projectPath: TEST_DIR,
			},
		);

		strictEqual(routeCalls.length, 0);
		strictEqual(launches, 0);
		strictEqual(result.success, false);
		strictEqual(result.provider, null);
		strictEqual(result.result, "declared_path_not_seeded");
		strictEqual(result.errorKind, "declared_path_not_seeded");
		strictEqual(result.reasonCode, "declared_path_not_seeded");
		strictEqual(
			result.reason,
			"The task declared a Git-ignored path that cannot be seeded or captured.",
		);
		ok(!result.reason.includes("TASKS.md"));
	});

	it("executeTaskAsync rejects an ignored declared path before broker reservation or routing", async () => {
		let brokerCalled = false;
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "edit tasks record",
				description: "update tasks",
				requiredPaths: ["TASKS.md"],
			},
			{
				broker: {
					selectAndReserve: async () => {
						brokerCalled = true;
						return null;
					},
				},
				projectPath: TEST_DIR,
			},
		);

		strictEqual(brokerCalled, false);
		strictEqual(result.success, false);
		strictEqual(result.provider, null);
		strictEqual(result.result, "declared_path_not_seeded");
	});

	it("the ignored-record regression rejects before dispatch with declared_path_not_seeded in runQueue", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Edit ignored local record
- **Status:** pending
- **Executor:** switchyard
- **Files:** HISTORY.md
- **Description:** append update to history
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				resolveTargetIdentity: () => ({
					targetId: "claude-sonnet-5",
					harnessKey: "claude",
					ambiguous: false,
				}),
				route: () => {
					throw new Error(
						"route must not be called for an ignored declared path",
					);
				},
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff",
					},
				},
			},
		});

		strictEqual(dispatches.length, 0, "must not record dispatch to a provider");
		strictEqual(result.processedTasks, 1);
		deepStrictEqual(result.completedTaskIds, []);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].result, "declared_path_not_seeded");
		strictEqual(checkpoint.results[0].success, false);
		strictEqual(checkpoint.results[0].errorKind, "declared_path_not_seeded");
		strictEqual(checkpoint.results[0].reasonCode, "declared_path_not_seeded");
		strictEqual(
			checkpoint.results[0].reason,
			"The task declared a Git-ignored path that cannot be seeded or captured.",
		);
		ok(!checkpoint.results[0].reason.includes("HISTORY.md"));
	});
});
