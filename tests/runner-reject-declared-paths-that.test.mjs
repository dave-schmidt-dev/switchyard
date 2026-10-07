import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	executeTaskAsync,
	findIgnoredDeclaredPath,
	loadCheckpoint,
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
const DEFAULT_ROUTE = () => ({
	provider: "claude",
	model: "claude-sonnet-5",
	percentLeft: 80,
	reason: "spread",
});
// Async-only task context: the broker seam is stubbed and the descriptor is
// derived from the routed provider/model so executeTaskAsync can run without
// the synchronous router.
function asyncTaskContext({
	route = DEFAULT_ROUTE,
	execute = async () => ({ success: true, output: "ok" }),
	captureDiff = async () => "diff --git a/a b/a",
	integrationGate = () => ({ success: true, message: "ok" }),
	recordDispatch = () => {},
}) {
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
			execute,
			release: async () => {},
		},
		resolveDescriptor: () => latestDescriptor,
		recordDispatch,
		recordDispatchIntent: () => {},
		integrationGate,
		adapters: {
			claude: {
				executeAsync: execute,
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

	it("executeTask rejects an ignored declared path before provider routing with declared_path_not_seeded", async () => {
		const routeCalls = [];
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "edit history",
				description: "record update",
				requiredPaths: ["HISTORY.md"],
			},
			asyncTaskContext({
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
			}),
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

	it("executeTask preserves current behavior for tracked paths and unignored new files", async () => {
		const routeCalls = [];
		const gateCalls = [];
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "valid work",
				description: "implementation",
				requiredPaths: [
					"src/switchyard/runner/index.mjs",
					"src/switchyard/new_untracked_test_file.mjs",
				],
			},
			asyncTaskContext({
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
			}),
		);

		strictEqual(routeCalls.length, 1);
		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
	});

	it("executeTask preserves current behavior when requiredPaths is null", async () => {
		const routeCalls = [];
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "review task",
				description: "no required paths",
				requiredPaths: null,
			},
			asyncTaskContext({
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				captureDiff: async () => "",
			}),
		);

		strictEqual(routeCalls.length, 1);
		strictEqual(result.success, true);
	});

	it("review tasks never integrate provider diffs and report zero source mutations", async () => {
		let gateCalls = 0;
		let captureCalls = 0;
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "review task",
				type: "review",
				description: "inspect changes",
				requiredPaths: null,
			},
			asyncTaskContext({
				execute: async () => ({
					success: true,
					output: JSON.stringify({
						verdict: "clean",
						findings: [],
					}),
					reviewResult: {
						schemaVersion: 1,
						status: "available",
						verdict: "clean",
						summary: "clean",
						findings: [],
						comments: [],
						findingCount: 0,
						commentCount: 0,
						sourceMutationCount: 0,
					},
				}),
				integrationGate: () => {
					gateCalls += 1;
					return { success: true, message: "must not run" };
				},
				captureDiff: async () => {
					captureCalls += 1;
					throw new Error("x");
				},
			}),
		);

		strictEqual(result.success, true);
		strictEqual(result.result, "review_completed");
		strictEqual(result.reviewResult.sourceMutationCount, 0);
		strictEqual(gateCalls, 0);
		strictEqual(captureCalls, 0);
	});

	it("malformed review output stays unavailable across sync, broker, and orchestrator paths", async () => {
		const task = {
			id: "1.2",
			title: "malformed review",
			type: "review",
			description: "inspect changes",
			requiredPaths: null,
		};
		// BLOCKED (Task 5.5): the synchronous executeTask path is deleted by
		// Task 5.13, so the syncResult half of this test cannot be ported to
		// the async runner. The broker path below asserts the same closed
		// malformed-review behavior without integration or diff capture.
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
			queueBackend: {
				captureTaskBase: () => TASK_BASE,
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: () => {},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});
		strictEqual(asyncResult.result, "review_unavailable");
		strictEqual(asyncResult.reviewResult.sourceMutationCount, 0);
		strictEqual(asyncGateCalls, 0);
		strictEqual(asyncCaptureCalls, 0);
		ok(!JSON.stringify(asyncResult).includes("PROVIDER_SECRET_CANARY"));
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

	it("the ignored-record regression rejects before dispatch with declared_path_not_seeded in runQueue", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Edit ignored local record
- **Status:** pending
- **Executor:** switchyard
- **Files:** HISTORY.md
- **Description:** append update to history
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		const result = await runQueueAsync({
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
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff",
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
