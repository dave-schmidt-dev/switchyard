import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	HOST_POWER_STATES,
	normalizeHostPower,
	probeHostPower,
} from "../src/switchyard/dispatch/host-power.mjs";
import { writeDirtyOverlayReceipt } from "../src/switchyard/lifecycle/index.mjs";
import {
	getRunnableTasks,
	loadCheckpoint,
	loadTaskQueue,
	runQueueAsync as runQueueAsyncImpl,
	saveCheckpoint,
	validateCallerInputs,
} from "../src/switchyard/runner/index.mjs";
import {
	executeTask,
	runnerTestDir,
	runQueue,
	runQueueAsync,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("caller-input validation (Task 1.1)", () => {
	function createValidationRepo() {
		const projectPath = join(TEST_DIR, "project");
		mkdirSync(join(projectPath, "src"), { recursive: true });
		writeFileSync(
			join(projectPath, "src", "tracked.mjs"),
			"export default 1;\n",
		);
		runFixtureGit(projectPath, ["init", "-q"]);
		runFixtureGit(projectPath, ["add", "src/tracked.mjs"]);
		runFixtureGit(projectPath, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"seed",
		]);
		return projectPath;
	}

	function validationOptions(projectPath, files = "src/tracked.mjs") {
		const tasksFilePath = writeTasksFile(`### Task 1.1: Validate inputs
- **Status:** pending
- **Executor:** switchyard
- **Files:** ${files}
- **Description:** bounded validation fixture
`);
		return {
			tasksFilePath,
			projectPath,
			checkpointPath: join(TEST_DIR, "checkpoint.json"),
		};
	}

	it("accepts committed inputs and nonexistent outputs without writing state", () => {
		const projectPath = createValidationRepo();
		const tracked = validationOptions(projectPath);
		const trackedResult = validateCallerInputs(tracked);
		strictEqual(trackedResult.potentialAttemptTasks[0].id, "1.1");
		ok(!existsSync(tracked.checkpointPath));

		const output = validationOptions(projectPath, "generated/new.mjs");
		strictEqual(
			validateCallerInputs(output).potentialAttemptTasks[0].id,
			"1.1",
		);
		ok(!existsSync(output.checkpointPath));
	});

	it("rejects an existing declared file absent from committed HEAD", () => {
		const projectPath = createValidationRepo();
		mkdirSync(join(projectPath, "generated"), { recursive: true });
		writeFileSync(join(projectPath, "generated", "new.mjs"), "untracked\n");
		const options = validationOptions(projectPath, "generated/new.mjs");
		throws(
			() => validateCallerInputs(options),
			(error) =>
				error.code === "declared_path_not_committed" &&
				error.taskId === "1.1" &&
				error.path === "generated/new.mjs",
		);
		ok(!existsSync(options.checkpointPath));
	});

	it("does not misclassify a missing git runtime as an uncommitted path", () => {
		const projectPath = createValidationRepo();
		const options = validationOptions(projectPath);
		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			throws(
				() => validateCallerInputs(options),
				(error) => error.code === "validation_unavailable",
			);
		} finally {
			process.env.PATH = previousPath;
		}
		ok(!existsSync(options.checkpointPath));
	});

	it("normalizes graph and explicit-selection failures as input rejections", () => {
		const projectPath = createValidationRepo();
		const options = validationOptions(projectPath);
		writeFileSync(
			options.tasksFilePath,
			withExplicitSwitchyardExecutor(`### Task 1.1: First
- **Status:** pending
- **Files:** src/tracked.mjs
- **Blocked by:** 9.9
- **Description:** invalid graph
`),
		);
		throws(
			() => validateCallerInputs(options),
			(error) => error.code === "queue_contract_invalid",
		);

		const selected = validationOptions(projectPath);
		selected.taskIds = ["9.9"];
		throws(
			() => validateCallerInputs(selected),
			(error) =>
				error.code === "task_selection_failed" && error.taskId === "9.9",
		);
	});

	it("accepts a matching checkpoint and rejects stale or malformed state", () => {
		const projectPath = createValidationRepo();
		const options = validationOptions(projectPath);
		const initial = validateCallerInputs(options);
		saveCheckpoint(options.checkpointPath, initial.checkpoint);
		strictEqual(
			validateCallerInputs(options).queueIdentity,
			initial.queueIdentity,
		);

		writeFileSync(options.checkpointPath, "{malformed", "utf8");
		throws(
			() => validateCallerInputs(options),
			(error) => error.code === "checkpoint_invalid",
		);

		rmSync(options.checkpointPath, { force: true });
		mkdirSync(options.checkpointPath);
		throws(
			() => validateCallerInputs(options),
			(error) => error.code === "checkpoint_invalid",
		);
	});

	it("validates dirty-overlay scope and stale receipts without publishing", () => {
		const projectPath = createValidationRepo();
		writeFileSync(
			join(projectPath, "src", "tracked.mjs"),
			"export default 2;\n",
		);
		const options = {
			...validationOptions(projectPath),
			dirtyOverlay: true,
			dirtyOverlayReceiptPath: join(TEST_DIR, "overlay.json"),
		};
		const current = validateCallerInputs(options);
		ok(current.dirtyOverlayReceipt);
		ok(!existsSync(options.dirtyOverlayReceiptPath));

		writeDirtyOverlayReceipt(
			options.dirtyOverlayReceiptPath,
			current.dirtyOverlayReceipt,
		);
		validateCallerInputs(options);
		writeFileSync(
			join(projectPath, "src", "tracked.mjs"),
			"export default 3;\n",
		);
		throws(
			() => validateCallerInputs(options),
			(error) => error.code === "dirty_overlay_invalid",
		);

		const inProject = {
			...options,
			checkpointPath: join(projectPath, "checkpoint.json"),
			dirtyOverlayReceiptPath: join(projectPath, "overlay.json"),
		};
		throws(
			() => validateCallerInputs(inProject),
			(error) =>
				error.code === "dirty_overlay_invalid" &&
				error.path === "checkpoint.json",
		);
	});

	it("resolves a symlinked state parent before applying the project boundary", () => {
		const projectPath = createValidationRepo();
		const stateLink = join(TEST_DIR, "state-link");
		symlinkSync(projectPath, stateLink, "dir");
		const options = {
			...validationOptions(projectPath),
			dirtyOverlay: true,
			checkpointPath: join(stateLink, "checkpoint.json"),
			dirtyOverlayReceiptPath: join(stateLink, "overlay.json"),
		};
		throws(
			() => validateCallerInputs(options),
			(error) =>
				error.code === "dirty_overlay_invalid" &&
				error.path === "checkpoint.json",
		);
	});
});
describe("host power queue policy", () => {
	it("defers before backend creation when the next task starts on battery", async () => {
		const tasksPath = writeTasksFile(`### Task 2.1: Battery deferred
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** bounded task
`);
		const checkpointPath = `${tasksPath}.battery.checkpoint.json`;
		let backendCreated = 0;
		let preflightCalled = 0;
		let providerSelected = 0;
		const result = await runQueueAsyncImpl({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			platform: "macos",
			checkpointPath,
			dependencies: {
				hostPowerProbe: () => ({ state: HOST_POWER_STATES.BATTERY }),
				backendFactory: () => {
					backendCreated += 1;
					throw new Error("backend must not be created on battery");
				},
				queuePreflight: () => {
					preflightCalled += 1;
				},
				route: () => {
					providerSelected += 1;
					throw new Error("provider must not be selected on battery");
				},
			},
		});
		strictEqual(backendCreated, 0);
		strictEqual(preflightCalled, 0);
		strictEqual(providerSelected, 0);
		strictEqual(result.processedTasks, 0);
		deepStrictEqual(result.deferredTaskIds, ["2.1"]);
		strictEqual(result.policyDeferred.nextTaskId, "2.1");
		strictEqual(result.policyDeferred.diagnosticCode, "host_on_battery");
		strictEqual(
			result.policyDeferred.taskFileSha256,
			createHash("sha256")
				.update(readFileSync(tasksPath, "utf8"))
				.digest("hex"),
		);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		strictEqual(checkpoint.ownershipReleased, true);
		deepStrictEqual(
			getRunnableTasks(loadTaskQueue(tasksPath), checkpoint).map(
				(task) => task.id,
			),
			["2.1"],
		);
	});

	it("emits fixed unknown-power status while preserving provider routing", () => {
		const statuses = [];
		const routeCalls = [];
		const result = executeTask(
			{ id: "1.1", title: "task", description: "op" },
			{
				hostPowerPolicyEnabled: true,
				hostPowerProbe: () => ({
					state: HOST_POWER_STATES.UNKNOWN,
					diagnosticCode: "untrusted-host-text-must-not-leak",
				}),
				onStatus: (event) => statuses.push(event),
				route: (options) => {
					routeCalls.push(options);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 50,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);
		strictEqual(result.taskId, "1.1");
		strictEqual(routeCalls.length, 1);
		deepStrictEqual(statuses[0], {
			phase: "policy",
			event: "host_power_unknown",
			status: "Host power state unknown; preserving existing routing",
			diagnosticCode: "host_power_unknown",
			taskId: "1.1",
		});
		strictEqual(
			statuses.some((event) => event.event === "task_routed"),
			true,
		);
		strictEqual(
			JSON.stringify(statuses).includes("untrusted-host-text-must-not-leak"),
			false,
		);
	});

	it("keeps unknown power fail-open", () => {
		strictEqual(
			normalizeHostPower("Now drawing from 'AC Power'"),
			HOST_POWER_STATES.AC,
		);
		strictEqual(
			normalizeHostPower("Now drawing from 'Battery Power'"),
			HOST_POWER_STATES.BATTERY,
		);
		strictEqual(normalizeHostPower("unrecognized"), HOST_POWER_STATES.UNKNOWN);
		const result = probeHostPower({
			execFn: () => ({ status: 1, stdout: "" }),
		});
		strictEqual(result.state, HOST_POWER_STATES.UNKNOWN);
		strictEqual(result.diagnosticCode, "host_power_unknown");
	});

	it("binds the task-file digest when sync, async, or orchestrated queues transition to battery", async () => {
		const entrypoints = [
			["sync", runQueue],
			["async", runQueueAsync],
		];
		for (const [name, entrypoint] of entrypoints) {
			const tasksPath = writeTasksFile(`### Task 2.1: Battery transition ${name}
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** bounded task
`);
			const checkpointPath = `${tasksPath}.${name}.battery.checkpoint.json`;
			let probeCount = 0;
			let routeCalls = 0;
			const result = await entrypoint({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "existing-container",
				checkpointPath,
				dependencies: {
					acquireVmSlot: () => null,
					hostPowerProbe: () => ({
						state:
							probeCount++ === 0
								? HOST_POWER_STATES.AC
								: HOST_POWER_STATES.BATTERY,
					}),
					route: () => {
						routeCalls += 1;
						throw new Error(
							"provider must not be selected after battery transition",
						);
					},
				},
			});
			strictEqual(routeCalls, 0, name);
			ok(result.policyDeferred, `${name} must preserve policy deferral`);
			strictEqual(result.policyDeferred.nextTaskId, "2.1", name);
			strictEqual(
				result.policyDeferred.taskFileSha256,
				createHash("sha256")
					.update(readFileSync(tasksPath, "utf8"))
					.digest("hex"),
				name,
			);
		}
	});
});
