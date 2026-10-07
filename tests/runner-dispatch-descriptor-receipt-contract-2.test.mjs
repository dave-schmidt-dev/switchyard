import { strictEqual } from "node:assert";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import {
	executeTask,
	runnerTestDir,
	TASK_BASE,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("dispatch descriptor receipt contract", () => {
	it("does not recapture a corrupt persisted base for an active attempt", () => {
		let captures = 0;
		let executions = 0;
		const result = executeTask(
			{ id: "1.9", title: "task", description: "work" },
			{
				route: () => ({ provider: "claude", model: "test-model" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				workingContainerName: "worker",
				projectPath: TEST_DIR,
				taskBases: { 1.9: TASK_BASE },
				queueBackend: {
					beforeRun: () => {},
					captureTaskBase: () => {
						captures += 1;
						return TASK_BASE;
					},
					validateTaskBase: () => {
						throw new Error("missing anchor");
					},
				},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
					},
				},
			},
		);
		strictEqual(result.result, "task_base_capture_failed");
		strictEqual(captures, 0);
		strictEqual(executions, 0);
	});
	for (const foreignField of ["runId", "taskId", "workspaceId"]) {
		it(`rejects persisted task-base metadata with a foreign ${foreignField}`, () => {
			let validations = 0;
			let executions = 0;
			const cleanupContext = {
				runId: "run-owned",
				taskId: "1.ownership",
				attemptId: "attempt-original",
				descriptorIdentity: "descriptor-original",
				workspaceId: "worker-owned",
				processStartIdentity: null,
				operation: "helper",
				[foreignField]: "foreign",
			};
			const result = executeTask(
				{ id: "1.ownership", title: "task", description: "work" },
				{
					runId: "run-owned",
					route: () => ({ provider: "claude", model: "test-model" }),
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					workingContainerName: "worker-owned",
					projectPath: TEST_DIR,
					taskBases: {
						"1.ownership": { ...TASK_BASE, cleanupContext },
					},
					queueBackend: {
						beforeRun: () => {},
						validateTaskBase: () => {
							validations += 1;
							return TASK_BASE;
						},
					},
					adapters: {
						claude: {
							execute: () => {
								executions += 1;
								return { success: true };
							},
						},
					},
				},
			);
			strictEqual(result.result, "task_base_capture_failed");
			strictEqual(validations, 0);
			strictEqual(executions, 0);
		});
	}
});
