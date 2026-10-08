import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	captureDiffDetailed as captureAgyDiffDetailed,
	captureDiffDetailedAsync as captureAgyDiffDetailedAsync,
} from "../src/switchyard/adapter/agy.mjs";
import {
	captureDiffDetailed as captureClaudeDiffDetailed,
	captureDiffDetailedAsync as captureClaudeDiffDetailedAsync,
} from "../src/switchyard/adapter/claude.mjs";
import {
	captureDiffDetailed as captureCodexDiffDetailed,
	captureDiffDetailedAsync as captureCodexDiffDetailedAsync,
} from "../src/switchyard/adapter/codex.mjs";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../src/switchyard/adapter/constants.mjs";
import {
	captureDiffDetailed as captureCopilotDiffDetailed,
	captureDiffDetailedAsync as captureCopilotDiffDetailedAsync,
} from "../src/switchyard/adapter/copilot.mjs";
import {
	captureDiffDetailed as captureCursorDiffDetailed,
	captureDiffDetailedAsync as captureCursorDiffDetailedAsync,
} from "../src/switchyard/adapter/cursor.mjs";
import {
	captureDiffDetailed as captureOpencodeDiffDetailed,
	captureDiffDetailedAsync as captureOpencodeDiffDetailedAsync,
} from "../src/switchyard/adapter/opencode.mjs";
import { prepareAsyncProviderInvocation } from "../src/switchyard/runner/execute-task-async-unsafe-reliability.mjs";
import {
	DEFAULT_ADAPTERS,
	executeTaskAsync,
} from "../src/switchyard/runner/index.mjs";
import { taskRepairScopeIdentity } from "../src/switchyard/runner/reliability.mjs";
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
function claudeDescriptor() {
	return descriptorForRoute({ provider: "claude", model: "claude-sonnet-5" });
}
// executeTaskAsync is a bare execute path: it has no queue bootstrap, so the
// immutable task base must be supplied by a stub async queue backend.
function executeContext(overrides = {}) {
	return {
		queueBackend: {
			captureTaskBaseAsync: async () => TASK_BASE,
			validateTaskBaseAsync: async (_workspaceId, base) => base,
			releaseTaskBaseAsync: async () => {},
		},
		taskBases: {},
		persistTaskBase: () => {},
		resolveDescriptor: () => claudeDescriptor(),
		recordDispatch: () => {},
		recordDispatchIntent: () => {},
		projectPath: TEST_DIR,
		workingContainerName: "fake-container",
		...overrides,
	};
}
function stubBroker(execution) {
	return {
		selectAndReserve: async () => ({
			provider: "claude",
			model: "claude-sonnet-5",
			resolvedTarget: "claude",
			harness: "claude",
			capability: "standard",
			reason: "spread",
			snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
		}),
		launcherIdentity: () => ({}),
		execute: async () => execution,
		release: async () => {},
	};
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("executeTask timeout handling", () => {
	it("reports the canonical timeout kind for an expired async baseline pin", async () => {
		const task = { id: "1.1", title: "repair", description: "repair" };
		const descriptor = claudeDescriptor();
		const routeResult = {
			provider: "claude",
			model: descriptor.selector,
			resolvedTargetId: "claude",
			resolved_harness: "claude",
		};
		const pin = {
			taskId: task.id,
			workspaceId: "fake-container",
			baseTree: TASK_BASE.tree,
			attemptId: "expired-attempt",
			descriptorIdentity: descriptor.descriptor_identity,
			scopeIdentity: taskRepairScopeIdentity(task),
			provider: routeResult.provider,
			resolvedTargetId: routeResult.resolvedTargetId,
			selector: descriptor.selector,
			deadline: "2000-01-01T00:00:00.000Z",
		};
		let releases = 0;
		const result = await prepareAsyncProviderInvocation({
			task,
			context: {
				_completionPin: pin,
				_activeTaskBase: { tree: TASK_BASE.tree },
				workingContainerName: "fake-container",
			},
			routeResult,
			invocationDescriptor: descriptor,
			resolvedTargetId: routeResult.resolvedTargetId,
			requiredCapability: "standard",
			selectedRoute: {},
			releaseSelected: async () => {
				releases += 1;
			},
			record: () => {},
			attemptCleanupContext: { attemptId: pin.attemptId },
			timeoutMs: 30_000,
			runQuickChecksAsync: async () => {
				throw new Error("expired baseline pin must skip checks");
			},
		});

		strictEqual(result.terminal.result, "execution_timed_out");
		strictEqual(result.terminal.errorKind, "execution_timed_out");
		strictEqual(result.terminal.timedOut, true);
		strictEqual(releases, 1);
	});
	it("retains every detailed diff-capture status after a timed-out execution", async () => {
		const statuses = [
			"captured",
			"empty",
			"stage_failed",
			"diff_failed",
			"transport_failed",
			"timed_out",
		];

		for (const status of statuses) {
			const result = await executeTaskAsync(
				{ id: "1.1", title: "task", description: "failed task" },
				executeContext({
					broker: stubBroker({
						success: false,
						error: "provider timed out",
						timedOut: true,
					}),
					integrationGate: () => ({ success: true, message: "ok" }),
					adapters: {
						claude: {
							executeAsync: async () => ({
								success: false,
								error: "provider timed out",
								timedOut: true,
							}),
							captureDiffAsync: async () => null,
							captureDiffDetailedAsync: async () => ({
								status,
								diff: status === "captured" ? "diff --git a/a b/a" : null,
							}),
						},
					},
				}),
			);

			strictEqual(result.captureStatus, status);
			strictEqual(
				result.result,
				["captured", "empty"].includes(status)
					? "execution_timed_out"
					: "execution_timed_out_capture_failed",
			);
			strictEqual(
				result.partialDiff,
				status === "captured" ? "diff --git a/a b/a" : undefined,
			);
		}
	});

	it("uses detailed async capture evidence after a timed-out broker execution", async () => {
		let legacyCaptureCalled = false;
		const result = await executeTaskAsync(
			{ id: "1.1", title: "task", description: "timed out task" },
			executeContext({
				broker: stubBroker({
					success: false,
					timedOut: true,
					reason: "provider timed out",
				}),
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: false }),
						captureDiffAsync: async () => {
							legacyCaptureCalled = true;
							return null;
						},
						captureDiffDetailedAsync: async () => ({
							status: "timed_out",
							diff: null,
						}),
					},
				},
			}),
		);

		strictEqual(result.result, "execution_timed_out_capture_failed");
		strictEqual(result.captureStatus, "timed_out");
		strictEqual(legacyCaptureCalled, false);
	});

	it("wires each legacy adapter's real detailed seams into DEFAULT_ADAPTERS", async () => {
		const adapters = {
			agy: [captureAgyDiffDetailed, captureAgyDiffDetailedAsync],
			claude: [captureClaudeDiffDetailed, captureClaudeDiffDetailedAsync],
			codex: [captureCodexDiffDetailed, captureCodexDiffDetailedAsync],
			copilot: [captureCopilotDiffDetailed, captureCopilotDiffDetailedAsync],
			cursor: [captureCursorDiffDetailed, captureCursorDiffDetailedAsync],
			opencode: [captureOpencodeDiffDetailed, captureOpencodeDiffDetailedAsync],
		};

		for (const [
			name,
			[captureDetailed, captureDetailedAsync],
		] of Object.entries(adapters)) {
			strictEqual(DEFAULT_ADAPTERS[name].captureDiffDetailed, captureDetailed);
			strictEqual(
				DEFAULT_ADAPTERS[name].captureDiffDetailedAsync,
				captureDetailedAsync,
			);
			deepStrictEqual(
				DEFAULT_ADAPTERS[name].captureDiffDetailed("invalid name"),
				{
					status: "stage_failed",
					diff: null,
					reasonCode: "invalid_workspace",
				},
			);
			deepStrictEqual(
				await DEFAULT_ADAPTERS[name].captureDiffDetailedAsync("invalid name"),
				{
					status: "stage_failed",
					diff: null,
					reasonCode: "invalid_workspace",
				},
			);
		}
	});

	it("captures a partial diff and returns execution_timed_out without calling integrationGate when the adapter reports timedOut", async () => {
		const gateCalls = [];
		const captureDiffCalls = [];
		const dispatches = [];

		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "task",
				description: "a task that overran its timeout",
				requiredPaths: null,
			},
			executeContext({
				broker: stubBroker({
					success: false,
					output: "partial output before kill",
					error: "spawnSync docker ETIMEDOUT",
					timedOut: true,
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: false,
							output: "partial output before kill",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						captureDiffAsync: async (containerName) => {
							captureDiffCalls.push(containerName);
							return "diff --git a/wip.mjs b/wip.mjs\n+work in progress";
						},
					},
				},
			}),
		);

		strictEqual(result.success, false);
		strictEqual(result.result, "execution_timed_out");
		strictEqual(result.timedOut, true);
		strictEqual(
			result.partialDiff,
			"diff --git a/wip.mjs b/wip.mjs\n+work in progress",
		);
		strictEqual(captureDiffCalls.length, 1, "captureDiff called once");
		strictEqual(captureDiffCalls[0], "fake-container");
		strictEqual(
			gateCalls.length,
			0,
			"a timed-out diff must never reach integrationGate — it is not a reviewed success (INV-2)",
		);
		strictEqual(dispatches[0].result, "execution_timed_out");
	});

	it("passes task.timeoutMs through to adapter.execute, falling back to the provider default when absent", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: custom
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 90s
- **Description:** x

### Task 1.2: default
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** x
`);
		const executeCalls = [];
		const preparationElapsedMs = 1_234;
		const initialWallTime = Date.UTC(2026, 9, 7);
		let elapsedMs = 0;

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				now: () => initialWallTime + elapsedMs,
				monotonicNow: () => elapsedMs,
				onTaskRouted: () => {
					elapsedMs += preparationElapsedMs;
				},
				adapters: {
					claude: {
						executeAsync: async (_prompt, _containerName, options) => {
							executeCalls.push(options.timeoutMs);
							return { success: true, output: "ok" };
						},
						captureDiffAsync: async () =>
							"diff --git a/src/a.mjs b/src/a.mjs\n+ok",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		const initialTimeouts = [90_000, PROVIDER_EXECUTION_TIMEOUT_MS];
		deepStrictEqual(
			executeCalls,
			initialTimeouts.map((timeoutMs) => timeoutMs - preparationElapsedMs),
		);
		for (const [index, remainingMs] of executeCalls.entries()) {
			strictEqual(remainingMs > 0, true);
			strictEqual(remainingMs < initialTimeouts[index], true);
		}
	});

	it("captures but never integrates a diff from a non-timeout execution failure", async () => {
		const captureDiffCalls = [];
		const gateCalls = [];

		const result = await executeTaskAsync(
			{ id: "1.1", title: "task", description: "a normal failure" },
			executeContext({
				broker: stubBroker({
					success: false,
					output: "",
					error: "provider crashed",
				}),
				integrationGate: (...args) => {
					gateCalls.push(args);
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: false,
							output: "",
							error: "provider crashed",
						}),
						captureDiffAsync: async (containerName) => {
							captureDiffCalls.push(containerName);
							return "diff --git a/wip.mjs b/wip.mjs\n+recoverable work";
						},
					},
				},
			}),
		);

		strictEqual(result.result, "execution_failed");
		strictEqual(result.timedOut, undefined);
		strictEqual(result.captureStatus, "captured");
		strictEqual(
			result.partialDiff,
			"diff --git a/wip.mjs b/wip.mjs\n+recoverable work",
		);
		strictEqual(captureDiffCalls.length, 1);
		strictEqual(gateCalls.length, 0, "failed provider work stays review-only");
	});
});
