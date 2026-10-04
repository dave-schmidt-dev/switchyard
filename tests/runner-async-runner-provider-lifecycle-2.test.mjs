import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	loadCheckpoint,
	TaskSelectionError,
} from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runnerTestDir,
	runQueueAsync,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("async runner provider lifecycle", () => {
	async function runAsyncRedactionCase({ execution, integrationGate }) {
		const root = join(
			TEST_DIR,
			`async-redaction-${Date.now()}-${Math.random()}`,
		);
		mkdirSync(root, { recursive: true });
		const tasksPath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		writeFileSync(
			tasksPath,
			"### Task 4.2: Async redaction\n- **Status:** pending\n- **Type:** review\n- **Description:** exercise redaction\n- **Executor:** switchyard\n",
		);
		const descriptor = descriptorForRoute({
			provider: "opencode",
			resolved_harness: "opencode",
			resolvedTargetId: "async-target",
			model: "fake-model",
		});
		let observed;
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: root,
			workingContainerName: "async-worker",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "opencode",
					resolved_harness: "opencode",
					resolvedTargetId: "async-target",
					model: "fake-model",
					invocationDescriptor: descriptor,
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate,
				onResult: (value) => {
					observed = value;
				},
				adapters: {
					opencode: {
						executeAsync: async () => execution,
						captureDiffAsync: async () => "SECRET_RAW_DIFF",
					},
				},
			},
		});
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		return { result, observed, checkpoint };
	}
	it("async managed-container lifecycle reports processed tasks and cleans up on selection failure", async () => {
		const root = join(TEST_DIR, "async-managed-container");
		mkdirSync(root, { recursive: true });
		const tasksPath = join(root, "TASKS.md");
		writeFileSync(
			tasksPath,
			"### Task 4.2: Managed\n- **Status:** pending\n- **Type:** review\n- **Description:** managed\n- **Executor:** switchyard\n",
		);
		let wiped = 0;
		const ready = [];
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: root,
				taskIds: ["9.9"],
				dependencies: {
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "managed-worker",
					provisionCredentials: () => {},
					seedProject: () => {},
					wipeWorkingContainer: () => {
						wiped += 1;
					},
					onContainerReady: (info) => ready.push(info.workingContainerName),
				},
			}),
			TaskSelectionError,
		);
		deepStrictEqual(ready, ["managed-worker"]);
		strictEqual(
			wiped,
			1,
			"selection/graph errors after container creation must still clean up the owned container",
		);
		wiped = 0;
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: root,
				dependencies: {
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "managed-worker-2",
					provisionCredentials: () => {},
					seedProject: () => {},
					wipeWorkingContainer: () => {
						wiped += 1;
					},
					onContainerReady: () => {
						throw new Error("ready callback failed");
					},
				},
			}),
			/ready callback failed/,
		);
		strictEqual(
			wiped,
			1,
			"ready callback failures must clean up owned containers",
		);
	});
	it("does not persist timeout provider output for review tasks", async () => {
		const { result, observed, checkpoint } = await runAsyncRedactionCase({
			execution: { success: false, timedOut: true, error: "timed out" },
			integrationGate: () => ({ success: true }),
		});
		// A review task that timed out is a provider failure first: it keeps the
		// sanitized failure classification that quarantine, retry and fallback read,
		// and carries an explicit unavailable verdict instead of collapsing into an
		// undiagnosed `review_unavailable`. No provider bytes survive either way.
		strictEqual(result.results[0].result, "execution_timed_out");
		strictEqual(result.results[0].reviewResult.reason, "timeout");
		strictEqual(result.results[0].reviewResult.sourceMutationCount, 0);
		strictEqual(result.results[0].partialDiffPath, undefined);
		strictEqual(observed.result, "execution_timed_out");
		strictEqual(observed.reviewResult.reason, "timeout");
		strictEqual(observed.reviewResult.sourceMutationCount, 0);
		strictEqual(observed.partialDiff, undefined);
		strictEqual(observed.artifactRef, undefined);
		strictEqual(checkpoint.results[0].partialDiffPath, null);
		strictEqual(checkpoint.results[0].artifactRef, undefined);
		ok(!JSON.stringify(checkpoint).includes("SECRET_RAW_DIFF"));
	});
	it("does not invoke integration for successful review execution without a result", async () => {
		const { result, observed, checkpoint } = await runAsyncRedactionCase({
			execution: { success: true, output: "" },
			integrationGate: () => ({ success: false }),
		});
		strictEqual(result.results[0].result, "review_unavailable");
		strictEqual(result.results[0].reviewResult.sourceMutationCount, 0);
		strictEqual(result.results[0].partialDiffPath, undefined);
		strictEqual(observed.result, "review_unavailable");
		strictEqual(observed.reviewResult.sourceMutationCount, 0);
		strictEqual(observed.partialDiff, undefined);
		strictEqual(observed.artifactRef, undefined);
		strictEqual(checkpoint.results[0].partialDiffPath, null);
		strictEqual(checkpoint.results[0].artifactRef, undefined);
		ok(!JSON.stringify(checkpoint).includes("SECRET_RAW_DIFF"));
	});
});
