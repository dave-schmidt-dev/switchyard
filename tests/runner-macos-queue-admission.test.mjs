import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	createQueueBackend,
	emitStageOutcome,
	executeTask as executeTaskImpl,
} from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueue,
	runQueueAsync,
	runQueueWithOrchestrator,
	withExplicitSwitchyardExecutor,
	withTestDescriptorContext,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const HOST_BOOT_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function hostBirth(pid) {
	return `switchyard-host-process-v1:${HOST_BOOT_UUID}:${pid}:${pid * 10 + 1}`;
}
function presentHostProbe(pid) {
	return {
		state: "present",
		pid,
		bootSessionUuid: HOST_BOOT_UUID,
		startTicks: String(pid * 10 + 1),
		identity: hostBirth(pid),
	};
}
describe("macOS queue admission", () => {
	it("captures canonical creator identity before the shared default allocation path", () => {
		const stateRoot = join(TEST_DIR, "host-birth-default");
		mkdirSync(stateRoot, { recursive: true });
		const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
		let cloneName;
		const calls = [];
		const executionBackend = new ParallelsExecutionBackend({
			aquaUid: 501,
			requireLinkedCloneMeasurement: false,
			hostProcessIdentityProbe: presentHostProbe,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "clone") cloneName = args[3];
				if (args[0] === "list") {
					return cloneName
						? `{22222222-2222-4222-8222-222222222222}\trunning\t${cloneName}`
						: "";
				}
				return "";
			},
		});
		executionBackend.boot = () => {};
		executionBackend._hardenClone = () => {};
		executionBackend._prepareWorkspace = () => {};
		try {
			const queue = createQueueBackend({
				projectPath: "/private/tmp/fixture-project",
				runId: "fixture-birth-run",
				dependencies: {
					goldenImage: "fixture-golden",
					aquaUid: "501",
					executionBackend,
				},
			});
			const uuid = queue.create("/private/tmp/fixture-project");
			const ownership = executionBackend.readVmOwnership(
				uuid,
				join(stateRoot, "runs", "fixture-birth-run", "resources"),
			);
			strictEqual(ownership.processStartIdentity, hostBirth(process.pid));
			ok(calls.some((args) => args[0] === "clone"));
		} finally {
			if (previous === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
		}
	});

	it("refuses the default allocation before any VM call when birth is unavailable", () => {
		const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_DIR, "host-birth-denied");
		let vmCalls = 0;
		try {
			const queue = createQueueBackend({
				projectPath: "/private/tmp/fixture-project",
				runId: "fixture-birth-denied",
				dependencies: {
					goldenImage: "fixture-golden",
					aquaUid: "501",
					executionBackend: new ParallelsExecutionBackend({
						hostProcessIdentityProbe: () => ({ state: "unknown" }),
						prlctlFn: () => {
							vmCalls += 1;
							return "";
						},
					}),
				},
			});
			throws(
				() => queue.create("/private/tmp/fixture-project"),
				/birth identity unavailable/,
			);
			strictEqual(vmCalls, 0);
		} finally {
			if (previous === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
		}
	});
	it("refuses a real VM allocation without the authoritative run-store root", () => {
		let creates = 0;
		const backend = createQueueBackend({
			projectPath: "/private/tmp/fixture-project",
			runId: "fixture-run",
			dependencies: {
				goldenImage: "fixture-golden",
				aquaUid: "501",
				executionBackend: {
					create: () => {
						creates += 1;
					},
				},
			},
		});
		const original = process.env.SWITCHYARD_RUN_STORE_ROOT;
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		try {
			throws(
				() => backend.create("/private/tmp/fixture-project"),
				/RUN_STORE_ROOT/,
			);
		} finally {
			if (original === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = original;
		}
		strictEqual(creates, 0);
	});

	it("rejects a missing Aqua UID before cloning", () => {
		let creates = 0;
		const backend = createQueueBackend({
			dependencies: {
				goldenImage: "fixture-golden",
				aquaUid: "",
				executionBackend: {
					create() {
						creates += 1;
					},
				},
			},
		});
		throws(() => backend.create("/fixture"), /SWITCHYARD_PARALLELS_AQUA_UID/);
		strictEqual(creates, 0);
	});

	it("surfaces Aqua wait and ready status for every queue create path", async () => {
		const entrypoints = [
			["sync", runQueue],
			["async", runQueueAsync],
			["orchestrator", runQueueWithOrchestrator],
		];

		for (const [name, entrypoint] of entrypoints) {
			const root = join(TEST_DIR, `aqua-status-${name}`);
			mkdirSync(root, { recursive: true });
			const tasksPath = join(root, "TASKS.md");
			const checkpointPath = join(root, "checkpoint.json");
			writeFileSync(
				tasksPath,
				withExplicitSwitchyardExecutor(
					"### Task 1.1: Bootstrap only\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** no task execution\n",
				),
			);
			const events = [];
			const backendFactory = () => ({
				readiness: () => ({ inventoryCount: 0 }),
				create(_path, { onStatus }) {
					onStatus({
						type: "aqua-wait",
						uuid: "vm-uuid",
						domain: "gui/501",
						elapsedMs: 250,
					});
					onStatus({
						type: "aqua-ready",
						uuid: "vm-uuid",
						domain: "gui/501",
					});
					return `${name}-container`;
				},
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			});

			const result = entrypoint({
				tasksFilePath: tasksPath,
				projectPath: root,
				checkpointPath,
				maxTasks: 0,
				dependencies: {
					backendFactory,
					onStatus: (event) => events.push(event),
					orchestrator: {
						launch: async () => "job",
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: null }),
					},
				},
			});
			await result;

			deepStrictEqual(
				events
					.filter(
						({ event }) => event === "aqua_wait" || event === "aqua_ready",
					)
					.map(({ phase, event, status }) => ({ phase, event, status })),
				[
					{
						phase: "bootstrap",
						event: "aqua_wait",
						status: "Waiting for Aqua session to become ready",
					},
					{
						phase: "bootstrap",
						event: "aqua_ready",
						status: "Aqua session ready",
					},
				],
				`${name} queue path must surface Aqua lifecycle status`,
			);
		}
	});
});
describe("typed non-provider stage facts", () => {
	it("emits the closed stage vocabulary without replacing legacy callbacks", async () => {
		const recorded = [];
		const context = {
			runId: "typed-stage-fixture",
			outcomeWriterEpoch: "epoch-typed-stage",
			recordOutcomeEvent: async (event) => recorded.push(event),
		};
		const stages = [
			["run", null, {}],
			["preflight", "1.1", { eligible: true }],
			["worker", "1.1", { launchVerified: true }],
			["artifact", "1.1", { artifactKind: "diff", captured: true }],
			["integration", "1.1", { gateCode: "ok", accepted: true }],
			["cleanup", null, { cleanupCode: "cleanup_completed", observed: true }],
			["recovery", null, { originalStage: "cleanup" }],
			[
				"postcondition",
				null,
				{
					commandResult: "success",
					observedState: "accepted",
				},
			],
		];
		for (const [stage, taskId, detail] of stages) {
			await emitStageOutcome(context, {
				stage,
				taskId,
				status: "succeeded",
				producer: "runner",
				code: `${stage}_fixture`,
				detail,
			});
		}
		strictEqual(recorded.length, stages.length);
		for (const [index, event] of recorded.entries()) {
			strictEqual(event.stage, stages[index][0]);
			strictEqual(event.sequence, 1);
			strictEqual(event.writerEpoch, "epoch-typed-stage");
			ok(event.outcomeId.startsWith("outcome-"));
		}
	});

	it("records production artifact and integration facts after a successful implementation", async () => {
		const recorded = [];
		const context = withTestDescriptorContext({
			runId: "typed-task-success",
			outcomeWriterEpoch: "epoch-typed-task-success",
			emitNonProviderOutcomes: true,
			recordOutcomeEvent: async (event) => recorded.push(event),
			route: () => ({ provider: "claude", model: "fixture-model" }),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true }),
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "typed-task-worker",
		});
		const result = executeTaskImpl(
			{
				id: "1.1",
				title: "typed task",
				type: "implementation",
				description: "exercise production task stages",
				requiredPaths: ["src/a.mjs"],
			},
			context,
		);
		await context._outcomeWriteChain;
		strictEqual(result.success, true);
		deepStrictEqual(
			recorded.map(({ stage, status }) => [stage, status]),
			[
				["artifact", "succeeded"],
				["integration", "succeeded"],
				["postcondition", "succeeded"],
			],
		);
	});

	it("records explicit unavailable evidence when an implementation stops before capture", async () => {
		const recorded = [];
		const context = {
			runId: "typed-task-unavailable",
			outcomeWriterEpoch: "epoch-typed-task-unavailable",
			emitNonProviderOutcomes: true,
			recordOutcomeEvent: async (event) => recorded.push(event),
			route: () => ({
				provider: "claude",
				model: "fixture-model",
				resolved_harness: "claude",
			}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			resolveDescriptor: () => {
				throw new Error("fixture descriptor unavailable");
			},
			integrationGate: () => ({ success: true }),
			adapters: {},
			projectPath: TEST_DIR,
			workingContainerName: "typed-task-worker",
		};
		const result = executeTaskImpl(
			{
				id: "1.1",
				title: "typed unavailable task",
				type: "implementation",
				description: "stop before capture",
				requiredPaths: ["src/a.mjs"],
			},
			context,
		);
		await context._outcomeWriteChain;
		strictEqual(result.success, false);
		deepStrictEqual(
			recorded
				.slice(0, 2)
				.map(({ stage, status, detail }) => [stage, status, detail.code]),
			[
				["artifact", "uncertain", "artifact_evidence_unavailable"],
				["integration", "uncertain", "integration_evidence_unavailable"],
			],
		);
	});
});
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
