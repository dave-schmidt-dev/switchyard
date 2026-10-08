import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runQueueAsync,
} from "./helpers/async-runner-fixtures.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

test("runQueueAsync repairs a failed check once with its initialized task deadline", async () => {
	const root = await tempDirAsync("switchyard-check-repair-async-budget-");
	const sourcePath = join(root, "src", "a.mjs");
	const tasksPath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	const baseSource = "export const answer = 1;\n";
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(sourcePath, baseSource);
	const git = (args) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git(["init", "-q"]);
	git(["add", "src/a.mjs"]);
	git([
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
	const baseTree = git(["rev-parse", "HEAD^{tree}"]).trim();
	writeFileSync(sourcePath, "export const answer =\n");
	const failedPatch = git(["diff", "--", "src/a.mjs"]);
	writeFileSync(sourcePath, "export const answer = 2;\n");
	const repairedPatch = git(["diff", "--", "src/a.mjs"]);
	writeFileSync(sourcePath, baseSource);
	writeFileSync(
		tasksPath,
		[
			"### Task 1.1: Repair failed check",
			"- **Status:** pending",
			"- **Executor:** switchyard",
			"- **Files:** src/a.mjs",
			"- **Quick checks:** node --check src/a.mjs",
			"- **Repair checks:** node --check src/a.mjs",
			"- **Description:** repair the syntax check",
			"",
		].join("\n"),
	);
	const route = {
		provider: "codex",
		model: "fixture-model",
		resolvedTargetId: "codex-target",
		resolved_harness: "codex",
	};
	const descriptor = descriptorForRoute(route);
	let healthStateCalls = 0;
	let healthIdentityCalls = 0;
	const healthDecision = Object.assign(
		() => {
			healthStateCalls += 1;
			return {
				healthDecisionCalls: healthStateCalls,
				available: true,
				initializable: true,
				suppress: false,
				trialAvailable: false,
				repairEpoch: 0,
			};
		},
		{
			mode: "shadow",
			healthStateRoot: root,
			identityFor: () => {
				healthIdentityCalls += 1;
				return {
					targetId: route.resolvedTargetId,
					descriptorIdentity: descriptor.descriptor_identity,
					publicConfigurationEpoch: `sha256:${"c".repeat(64)}`,
				};
			},
		},
	);
	let executionCount = 0;
	let captureCount = 0;
	let terminalRunId = null;
	let terminalEvent = null;
	try {
		const result = await runQueueAsync({
			runId: "direct",
			tasksFilePath: tasksPath,
			projectPath: root,
			checkpointPath,
			dependencies: {
				route: () => route,
				healthDecision,
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				createWorkingContainer: () => "owned-container",
				ensureAgentContainer: () => {},
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				captureTaskBase: () => ({
					ref: "refs/switchyard/task-base/check-repair-test/1.1",
					tree: baseTree,
				}),
				validateTaskBase: (_workspaceId, taskBase) => taskBase,
				releaseTaskBase: () => {},
				createRouteHealthEvent: async (runId, event) => {
					terminalRunId = runId;
					terminalEvent = event;
				},
				getRunRoot: () => root,
				ingestRouteHealthEvents: async () => [
					{
						runId: terminalRunId,
						taskId: terminalEvent.taskId,
						attempt: terminalEvent.attempt,
						targetId: terminalEvent.resolvedTargetId,
						descriptorIdentity: terminalEvent.descriptorIdentity,
						publicConfigurationEpoch: `sha256:${"c".repeat(64)}`,
						repairEpoch: 0,
						accepted: true,
					},
				],
				adapters: {
					codex: {
						executeAsync: async (prompt) => {
							executionCount += 1;
							if (executionCount === 2)
								assert.match(prompt, /check 1 \(acceptance_check_failed\)/u);
							return {
								success: true,
								output: "ok",
								servedModel: true,
								providerLifecycle: {
									terminalStatus: "exited",
									writerLifecycle: "stopped",
									cleanupStatus: "succeeded",
									cleanupStage: "index_lock_removed",
								},
							};
						},
						captureDiffAsync: async () => {
							captureCount += 1;
							return captureCount === 1 ? failedPatch : repairedPatch;
						},
					},
				},
			},
		});
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		assert.equal(
			result.results[0].success,
			true,
			JSON.stringify({
				status: result.results[0].result,
				providerReliability: result.results[0].providerReliability,
				quickCheckReceipt: result.results[0].quickCheckReceipt,
				executionCount,
				captureCount,
				routeHealthAttempt: terminalEvent?.attempt,
				healthIdentityCalls,
				healthStateCalls,
			}),
		);
		assert.equal(result.results[0].providerReliability.repairCount, 1);
		assert.equal(result.results[0].providerReliability.repairStatus, "passed");
		assert.equal(executionCount, 2);
		assert.equal(captureCount, 2);
		assert.ok(healthIdentityCalls > 0);
		assert.ok(healthStateCalls > 0);
		assert.equal(
			checkpoint.providerAttemptAllocations.filter(
				(allocation) => allocation.reason === "check_repair",
			).length,
			1,
		);
		assert.equal(
			checkpoint.providerAttemptAllocations[0].state,
			"result_recorded",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
