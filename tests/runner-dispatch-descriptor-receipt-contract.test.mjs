import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	writeDispatchIntent,
	writeDispatchIntentAsync,
} from "../src/switchyard/runner/index.mjs";
import {
	executeTask,
	executeTaskWithOrchestrator,
	runnerTestDir,
	runQueue,
	testDescriptor,
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
describe("dispatch descriptor receipt contract", () => {
	it("fails closed when direct intent helpers have no writer", async () => {
		const payload = { taskId: "direct-missing", provider: "claude" };
		const syncFailure = writeDispatchIntent({}, payload);
		strictEqual(syncFailure.ledgerFailureCode, "missing_writer");
		strictEqual(
			(await writeDispatchIntentAsync({}, payload)).ledgerFailureCode,
			"missing_writer",
		);
	});
	it("fails closed on a thenable returned by a synchronous intent writer", () => {
		let executions = 0;
		const descriptor = testDescriptor();
		const base = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTargetId: "claude",
				resolved_harness: "claude",
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: () => {},
			adapters: {
				claude: {
					execute: () => {
						executions += 1;
						return { success: true };
					},
					captureDiff: () => null,
				},
			},
			workingContainerName: "fake-container",
			projectPath: TEST_DIR,
		};
		for (const writer of [
			() => Promise.resolve(),
			() => Promise.reject(new Error("synthetic writer failure")),
		]) {
			const result = executeTask(
				{ id: "direct-thenable", title: "task", description: "work" },
				{ ...base, recordDispatchIntent: writer },
			);
			strictEqual(result.result, "intent_receipt_failed");
			strictEqual(result.ledgerFailureCode, "async_writer");
		}
		strictEqual(executions, 0);
	});
	it("fails closed before adapter execution when the context writer is absent", () => {
		let executions = 0;
		const result = executeTask(
			{ id: "direct-no-writer", title: "task", description: "work" },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude",
					resolved_harness: "claude",
				}),
				resolveDescriptor: () => testDescriptor(),
				recordDispatch: () => {},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
						captureDiff: () => "",
					},
				},
				workingContainerName: "fake-container",
				projectPath: TEST_DIR,
			},
		);
		strictEqual(result.result, "intent_receipt_failed");
		strictEqual(result.ledgerFailureCode, "missing_writer");
		strictEqual(executions, 0);
	});
	it("rejects a missing or changed receipt before adapter execution", () => {
		let executions = 0;
		const descriptor = testDescriptor();
		const base = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTargetId: "claude",
				resolved_harness: "claude",
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: () => {},
			integrationGate: () => ({ success: true }),
			adapters: {
				claude: {
					execute: () => {
						executions += 1;
						return { success: true };
					},
					captureDiff: () => null,
				},
			},
			workingContainerName: "fake-container",
			projectPath: TEST_DIR,
		};
		const missing = executeTask(
			{ id: "1.1", title: "task", description: "work" },
			{
				...base,
				route: () => ({ ...base.route(), invocationDescriptor: null }),
			},
		);
		strictEqual(missing.result, "descriptor_receipt_invalid");
		const changed = executeTask(
			{ id: "1.1", title: "task", description: "work" },
			{
				...base,
				route: () => ({
					...base.route(),
					invocationDescriptor: testDescriptor({ selector: "claude-opus-4" }),
				}),
			},
		);
		strictEqual(changed.result, "descriptor_receipt_invalid");
		strictEqual(executions, 0);
	});
	it("fails closed when the authoritative intent receipt cannot be written", () => {
		let executions = 0;
		const descriptor = testDescriptor();
		const result = executeTask(
			{ id: "1.2", title: "task", description: "work", requiredPaths: null },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude",
					resolved_harness: "claude",
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {},
				integrationGate: () => ({ success: true }),
				recordDispatchIntent: () => {
					const error = new Error("EPERM: /private/host/path");
					error.code = "EPERM";
					throw error;
				},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
						captureDiff: () => null,
					},
				},
				workingContainerName: "fake-container",
				projectPath: TEST_DIR,
			},
		);
		strictEqual(result.result, "intent_receipt_failed");
		strictEqual(result.ledgerFailureCode, "EPERM");
		strictEqual(result.errorKind, "intent_receipt");
		strictEqual(executions, 0);
	});
	it("continues after a legacy projection failure once local intent succeeds", () => {
		let executions = 0;
		let intentWrites = 0;
		const descriptor = testDescriptor();
		const result = executeTask(
			{ id: "1.3", title: "task", description: "work", requiredPaths: null },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude",
					resolved_harness: "claude",
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {
					const error = new Error("EPERM: /private/host/path");
					error.code = "EPERM";
					throw error;
				},
				recordDispatchIntent: () => {
					intentWrites += 1;
				},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
						captureDiff: () => "",
					},
				},
				integrationGate: () => ({ success: true }),
				workingContainerName: "fake-container",
				projectPath: TEST_DIR,
			},
		);
		strictEqual(result.success, true);
		strictEqual(intentWrites, 1);
		strictEqual(executions, 1);
	});
	it("runQueue blocks adapter execution when its local intent writer rejects", () => {
		const tasksFilePath = writeTasksFile(`
### Task 1.6: intent gate
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** work
`);
		let executions = 0;
		const result = runQueue({
			tasksFilePath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: join(TEST_DIR, "intent-gate-checkpoint.json"),
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude",
					resolved_harness: "claude",
				}),
				resolveDescriptor: () => testDescriptor(),
				recordDispatch: () => {},
				recordDispatchIntent: () => {
					const error = new Error("EPERM: /private/host/path");
					error.code = "EPERM";
					throw error;
				},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
						captureDiff: () => null,
					},
				},
				integrationGate: () => ({ success: true }),
			},
		});
		strictEqual(result.results[0].result, "intent_receipt_failed");
		strictEqual(executions, 0);
	});
	it("writes the orchestrator intent before launch and blocks launch on failure", async () => {
		const descriptor = testDescriptor();
		const events = [];
		const base = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTargetId: "claude",
				resolved_harness: "claude",
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: () => {},
			workingContainerName: "fake-container",
			projectPath: TEST_DIR,
			pollIntervalMs: 1,
			maxPolls: 1,
			sleepFn: async () => {},
			integrationGate: () => ({ success: true }),
			adapters: { claude: {} },
		};
		const success = await executeTaskWithOrchestrator(
			{ id: "1.4", title: "task", description: "work" },
			{
				...base,
				recordDispatchIntent: () => events.push("intent"),
				orchestrator: {
					launch: async () => {
						events.push("launch");
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: null }),
				},
			},
		);
		strictEqual(success.success, true);
		deepStrictEqual(events, ["intent", "launch"]);

		let launched = false;
		const blocked = await executeTaskWithOrchestrator(
			{ id: "1.5", title: "task", description: "work" },
			{
				...base,
				recordDispatchIntent: () => {
					const error = new Error("EPERM: /private/host/path");
					error.code = "EPERM";
					throw error;
				},
				orchestrator: {
					launch: async () => {
						launched = true;
						return "job-2";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: null }),
				},
			},
		);
		strictEqual(blocked.result, "intent_receipt_failed");
		strictEqual(launched, false);
	});
	it("fails before orchestrator launch when the task-base probe exhausts its budget", async () => {
		let launches = 0;
		const statuses = [];
		const result = await executeTaskWithOrchestrator(
			{ id: "1.6", title: "task", description: "work" },
			{
				route: () => ({ provider: "claude", model: "test-model" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				workingContainerName: "worker",
				projectPath: TEST_DIR,
				adapters: { claude: {} },
				queueBackend: {
					beforeRun: () => {},
					captureTaskBaseAsync: async () => {
						throw new Error("task base probe deadline exhausted");
					},
				},
				onStatus: (status) => statuses.push(status),
				orchestrator: {
					launch: async () => {
						launches += 1;
						return "job";
					},
				},
			},
		);
		strictEqual(result.result, "task_base_capture_failed");
		strictEqual(launches, 0);
		ok(statuses.some(({ event }) => event === "task_base_failed"));
	});
});
