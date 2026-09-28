import { strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	descriptorForRoute,
	executeTask,
	executeTaskWithOrchestrator,
	runnerTestDir,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);
const VALID_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
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
	it("uses host-captured orchestrator bytes and rejects a contradictory base receipt", async () => {
		let gatedDiff = null;
		let captureCleanupContext = null;
		let captureError = null;
		const context = {
			runId: "orchestrator-capture-run",
			attemptId: "orchestrator-capture-attempt",
			route: () => ({ provider: "claude", model: "test-model" }),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			workingContainerName: "worker",
			projectPath: TEST_DIR,
			pollIntervalMs: 1,
			maxPolls: 1,
			sleepFn: async () => {},
			adapters: {
				claude: {
					captureDiffAsync: async (_workspace, options) => {
						try {
							options.executionBackend.execArgv("worker", {});
						} catch (error) {
							captureError = error;
							throw error;
						}
						return "authoritative-host-diff";
					},
				},
			},
			executionBackend: {
				execArgv(_workspace, options) {
					captureCleanupContext = options.cleanupContext;
					return { command: "true", args: [] };
				},
			},
			integrationGate: (diff) => {
				gatedDiff = diff;
				return { success: true };
			},
			orchestrator: {
				launch: async () => "job",
				status: async () => ({ state: "done" }),
				result: async () => ({
					success: true,
					diff: "untrusted-returned-diff",
				}),
			},
		};
		const accepted = await executeTaskWithOrchestrator(
			{ id: "1.7", title: "task", description: "work" },
			context,
		);
		strictEqual(
			accepted.success,
			true,
			`${JSON.stringify(accepted)} capture=${captureError?.message}`,
		);
		strictEqual(gatedDiff, "authoritative-host-diff");
		strictEqual(captureCleanupContext.operation, "helper");
		strictEqual(captureCleanupContext.workspaceId, "worker");

		const rejected = await executeTaskWithOrchestrator(
			{ id: "1.8", title: "task", description: "work" },
			{
				...context,
				orchestrator: {
					...context.orchestrator,
					result: async () => ({
						success: true,
						taskBase: { ...TASK_BASE, tree: "9".repeat(40) },
					}),
				},
			},
		);
		strictEqual(rejected.result, "task_base_capture_failed");

		const opencodeDescriptor = descriptorForRoute({
			provider: "OpenCode Go",
			resolved_harness: "opencode",
			resolvedTargetId: "opencode-go",
			model: "fixture/opencode-low",
		});
		for (const hostDiff of ["authoritative-opencode-diff", ""]) {
			let captures = 0;
			const result = await executeTaskWithOrchestrator(
				{
					id: `1.openc-${hostDiff.length}`,
					title: "task",
					description: "work",
				},
				{
					...context,
					route: () => ({
						provider: "OpenCode Go",
						model: "fixture/opencode-low",
						resolvedTargetId: "opencode-go",
						resolved_harness: "opencode",
						invocationDescriptor: opencodeDescriptor,
					}),
					resolveDescriptor: () => opencodeDescriptor,
					adapters: {
						opencode: {
							captureDiffAsync: async () => {
								captures += 1;
								return hostDiff;
							},
						},
					},
				},
			);
			strictEqual(result.success, true);
			strictEqual(captures, 1);
		}
	});
});
