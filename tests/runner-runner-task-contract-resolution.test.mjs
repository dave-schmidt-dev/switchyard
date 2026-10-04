import { rejects, strictEqual, throws } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	executeTask,
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
describe("runner task contract resolution", () => {
	function capabilityCapturingContext(routeCalls) {
		return {
			route: (opts) => {
				routeCalls.push(opts);
				return {
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				};
			},
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => null,
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		};
	}

	it("executeTask routes at RequiredCapability regardless of description text", () => {
		const routeCalls = [];
		// Description text must never override the declared capability.
		executeTask(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: "high",
				requiredCapabilityJustification:
					"The task requires architectural review.",
			},
			capabilityCapturingContext(routeCalls),
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
	});

	it("legacy programmatic task objects with an omitted capability use standard", () => {
		const routeCalls = [];
		executeTask(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: null,
			},
			capabilityCapturingContext(routeCalls),
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "standard");
	});

	it("executeTask never provider-routes native or human tasks", () => {
		for (const executor of ["native", "human"]) {
			const routeCalls = [];
			const result = executeTask(
				{
					id: "1.1",
					title: "task",
					description: "format the readme",
					executor,
					requiredCapability: "high",
					requiredCapabilityJustification:
						"The task requires architectural review.",
				},
				capabilityCapturingContext(routeCalls),
			);
			strictEqual(routeCalls.length, 0);
			strictEqual(result.provider, null);
			strictEqual(result.result, "executor_not_switchyard");
		}
	});

	it("executeTask rejects an invalid RequiredCapability instead of silently routing at capability 0", () => {
		const routeCalls = [];
		throws(
			() =>
				executeTask(
					{
						id: "1.1",
						title: "task",
						description: "format the readme",
						requiredCapability: "urgent",
					},
					capabilityCapturingContext(routeCalls),
				),
			/invalid declared RequiredCapability "urgent"/,
		);
		// The reject must happen before route() is ever reached -- an invalid
		// RequiredCapability must not silently reach the router as a fallback or
		// zero capability.
		strictEqual(routeCalls.length, 0);
	});

	it("executeTask rejects explicit low/high capability without justification before routing", () => {
		for (const capability of ["high", "low"]) {
			const routeCalls = [];
			throws(
				() =>
					executeTask(
						{
							id: "1.1",
							title: "task",
							description: "format the readme",
							requiredCapability: capability,
						},
						capabilityCapturingContext(routeCalls),
					),
				/RequiredCapabilityJustification is required for explicit/,
			);
			strictEqual(routeCalls.length, 0);
		}
	});

	it("executeTaskWithOrchestrator routes at RequiredCapability regardless of description", async () => {
		const routeCalls = [];
		const result = await executeTaskWithOrchestrator(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: "high",
				requiredCapabilityJustification:
					"The task requires architectural review.",
			},
			{
				...capabilityCapturingContext(routeCalls),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
		strictEqual(result.taskId, "1.1");
	});

	it("executeTaskWithOrchestrator uses standard when RequiredCapability is absent", async () => {
		const routeCalls = [];
		await executeTaskWithOrchestrator(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: null,
			},
			{
				...capabilityCapturingContext(routeCalls),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "standard");
	});

	it("executeTaskWithOrchestrator never provider-routes native or human tasks", async () => {
		for (const executor of ["native", "human"]) {
			const routeCalls = [];
			let launches = 0;
			const result = await executeTaskWithOrchestrator(
				{
					id: "1.1",
					title: "task",
					description: "format the readme",
					executor,
					requiredCapability: "high",
					requiredCapabilityJustification:
						"The task requires architectural review.",
				},
				{
					...capabilityCapturingContext(routeCalls),
					orchestrator: {
						launch: async () => {
							launches += 1;
							return "job-1";
						},
					},
				},
			);
			strictEqual(routeCalls.length, 0);
			strictEqual(launches, 0);
			strictEqual(result.provider, null);
			strictEqual(result.result, "executor_not_switchyard");
		}
	});

	it("executeTaskWithOrchestrator rejects an invalid RequiredCapability instead of silently routing at capability 0", async () => {
		const routeCalls = [];
		await rejects(
			() =>
				executeTaskWithOrchestrator(
					{
						id: "1.1",
						title: "task",
						description: "format the readme",
						requiredCapability: "urgent",
					},
					{
						...capabilityCapturingContext(routeCalls),
						orchestrator: {
							launch: async () => "job-1",
							status: async () => ({ state: "done" }),
							result: async () => ({ success: true, diff: "" }),
						},
					},
				),
			/invalid declared RequiredCapability "urgent"/,
		);
		strictEqual(routeCalls.length, 0);
	});

	it("executeTaskWithOrchestrator rejects explicit low/high without justification before routing or launch", async () => {
		for (const capability of ["high", "low"]) {
			const routeCalls = [];
			let launches = 0;
			await rejects(
				() =>
					executeTaskWithOrchestrator(
						{
							id: "1.1",
							title: "task",
							description: "format the readme",
							requiredCapability: capability,
						},
						{
							...capabilityCapturingContext(routeCalls),
							orchestrator: {
								launch: async () => {
									launches += 1;
									return "job-1";
								},
							},
						},
					),
				/RequiredCapabilityJustification is required for explicit/,
			);
			strictEqual(routeCalls.length, 0);
			strictEqual(launches, 0);
		}
	});

	it("end to end: RequiredCapability reaches route() as requiredCapability", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Declared-capability task
- **Status:** pending
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** The task requires architectural review.
- **Description:** format the readme
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: capabilityCapturingContext(routeCalls),
		});

		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
	});
});
