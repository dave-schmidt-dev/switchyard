import { deepStrictEqual, strictEqual } from "node:assert";
import { rmSync } from "node:fs";
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
import { DEFAULT_ADAPTERS } from "../src/switchyard/runner/index.mjs";
import {
	executeTask,
	executeTaskAsync,
	runnerTestDir,
	testDescriptor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("executeTask timeout handling", () => {
	it("retains every detailed diff-capture status after a timed-out execution", () => {
		const statuses = [
			"captured",
			"empty",
			"stage_failed",
			"diff_failed",
			"transport_failed",
			"timed_out",
		];

		for (const status of statuses) {
			const result = executeTask(
				{ id: "1.1", title: "task", description: "failed task" },
				{
					route: () => ({
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 50,
						reason: "spread",
					}),
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => ({ success: true, message: "ok" }),
					adapters: {
						claude: {
							execute: () => ({
								success: false,
								error: "provider timed out",
								timedOut: true,
							}),
							captureDiffDetailed: () => ({
								status,
								diff: status === "captured" ? "diff --git a/a b/a" : null,
							}),
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
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
			{
				broker: {
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
					execute: async () => ({
						success: false,
						timedOut: true,
						reason: "provider timed out",
					}),
				},
				resolveDescriptor: () => testDescriptor(),
				recordDispatch: async () => {},
				recordDispatchIntent: async () => {},
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
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
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

	it("captures a partial diff and returns execution_timed_out without calling integrationGate when the adapter reports timedOut", () => {
		const gateCalls = [];
		const captureDiffCalls = [];
		const dispatches = [];

		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "a task that overran its timeout",
				requiredPaths: null,
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				recordDispatchIntent: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "partial output before kill",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						captureDiff: (containerName) => {
							captureDiffCalls.push(containerName);
							return "diff --git a/wip.mjs b/wip.mjs\n+work in progress";
						},
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
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

	it("passes task.timeoutMs through to adapter.execute, falling back to the provider default when absent", () => {
		const executeCalls = [];
		const context = () => ({
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 50,
				reason: "spread",
			}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: (_prompt, _containerName, options) => {
						executeCalls.push(options.timeoutMs);
						return { success: true, output: "ok" };
					},
					captureDiff: () => null,
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			now: () => 1_000,
			monotonicNow: () => 0,
		});

		executeTask(
			{ id: "1.1", title: "custom", description: "x", timeoutMs: 90_000 },
			context(),
		);
		executeTask({ id: "1.2", title: "default", description: "x" }, context());

		strictEqual(executeCalls[0], 90_000);
		strictEqual(executeCalls[1], PROVIDER_EXECUTION_TIMEOUT_MS);
	});

	it("captures but never integrates a diff from a non-timeout execution failure", () => {
		const captureDiffCalls = [];
		const gateCalls = [];

		const result = executeTask(
			{ id: "1.1", title: "task", description: "a normal failure" },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: (...args) => {
					gateCalls.push(args);
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "provider crashed",
						}),
						captureDiff: (containerName) => {
							captureDiffCalls.push(containerName);
							return "diff --git a/wip.mjs b/wip.mjs\n+recoverable work";
						},
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
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
