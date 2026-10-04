import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	CHECKPOINT_IDENTITY_CODES,
	CheckpointIdentityError,
	createQueueIdentity,
	loadCheckpoint,
	loadTaskQueue,
	normalizeRunOptions,
	runQueueAsync as runQueueAsyncImpl,
} from "../src/switchyard/runner/index.mjs";
import {
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
describe("typed checkpoint identity failures (Task 1.3)", () => {
	it("task-file mismatch throws CheckpointIdentityError with checkpoint_task_file_mismatch", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions = normalizeRunOptions({ checkpointPath });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: "/other/nonexistent/tasks.md",
				queueIdentity,
				runOptions,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, { queueIdentity, runOptions });
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_task_file_mismatch");
		strictEqual(thrown.reasonCode, "checkpoint_task_file_mismatch");
		strictEqual(thrown.diagnosticCode, "checkpoint_task_file_mismatch");
		ok(thrown.reason.includes("checkpoint task file mismatch"));
		ok(
			!thrown.message.includes("/other/nonexistent/tasks.md"),
			"must not leak host paths",
		);
		ok(
			!thrown.reason.includes("/other/nonexistent/tasks.md"),
			"must not leak host paths in reason",
		);
	});

	it("missing queue identity throws CheckpointIdentityError with checkpoint_missing_queue_identity", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions = normalizeRunOptions({ checkpointPath });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, { queueIdentity, runOptions });
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_missing_queue_identity");
		strictEqual(thrown.reasonCode, "checkpoint_missing_queue_identity");
		strictEqual(thrown.diagnosticCode, "checkpoint_missing_queue_identity");
		ok(thrown.reason.includes("missing queueIdentity"));
	});

	it("queue-identity mismatch throws CheckpointIdentityError with checkpoint_queue_identity_mismatch", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions = normalizeRunOptions({ checkpointPath });

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksPath,
				queueIdentity: "a".repeat(64),
				runOptions,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, {
				queueIdentity: "b".repeat(64),
				runOptions,
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_queue_identity_mismatch");
		strictEqual(thrown.reasonCode, "checkpoint_queue_identity_mismatch");
		strictEqual(thrown.diagnosticCode, "checkpoint_queue_identity_mismatch");
		ok(thrown.reason.includes("queue identity mismatch"));
		deepStrictEqual(thrown.changedDimensions, ["queueIdentity"]);
		strictEqual(thrown.freshCheckpointPath, "switchyard-fresh.checkpoint.json");
		ok(thrown.message.includes("switchyard-fresh.checkpoint.json"));
	});

	it("run-options mismatch throws CheckpointIdentityError with checkpoint_run_options_mismatch", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions1 = normalizeRunOptions({ checkpointPath, maxTasks: 1 });
		const runOptions2 = normalizeRunOptions({ checkpointPath, maxTasks: 2 });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksPath,
				queueIdentity,
				runOptions: runOptions2,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, {
				queueIdentity,
				runOptions: runOptions1,
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_run_options_mismatch");
		strictEqual(thrown.reasonCode, "checkpoint_run_options_mismatch");
		strictEqual(thrown.diagnosticCode, "checkpoint_run_options_mismatch");
		ok(thrown.reason.includes("normalized run options changed"));
	});

	for (const [field, value] of [
		["taskIds", ["9.9"]],
		["excludeProviders", ["claude"]],
	]) {
		it(`reports ${field} for normalized checkpoint option mismatch`, () => {
			const tasksPath = writeTasksFile(
				"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
			);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const expectedOptions = normalizeRunOptions({ checkpointPath });
			const storedOptions = normalizeRunOptions({
				checkpointPath,
				[field]: value,
			});
			const queueIdentity = createQueueIdentity({
				tasksFilePath: tasksPath,
				markdown: readFileSync(tasksPath, "utf8"),
				tasks: loadTaskQueue(tasksPath),
				projectRevision: "rev-1",
				runOptions: expectedOptions,
			});
			writeFileSync(
				checkpointPath,
				JSON.stringify({
					version: 2,
					tasksFilePath: tasksPath,
					queueIdentity,
					runOptions: storedOptions,
					completedTaskIds: [],
					results: [],
				}),
				"utf8",
			);
			throws(
				() =>
					loadCheckpoint(checkpointPath, tasksPath, {
						queueIdentity,
						runOptions: expectedOptions,
					}),
				(error) => {
					strictEqual(error.code, "checkpoint_run_options_mismatch");
					deepStrictEqual(error.changedDimensions, [field]);
					return true;
				},
			);
		});
	}

	it("historical checkpoint throws CheckpointIdentityError with checkpoint_historical_checkpoint", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 1,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, {
				queueIdentity: "a".repeat(64),
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_historical_checkpoint");
		strictEqual(thrown.reasonCode, "checkpoint_historical_checkpoint");
		strictEqual(thrown.diagnosticCode, "checkpoint_historical_checkpoint");
		ok(thrown.reason.includes("historical state without queue identity"));
	});

	it("five checkpoint identity regressions emit distinct static codes", () => {
		const codes = [
			CHECKPOINT_IDENTITY_CODES.TASK_FILE_MISMATCH,
			CHECKPOINT_IDENTITY_CODES.MISSING_QUEUE_IDENTITY,
			CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH,
			CHECKPOINT_IDENTITY_CODES.RUN_OPTIONS_MISMATCH,
			CHECKPOINT_IDENTITY_CODES.HISTORICAL_CHECKPOINT,
		];
		const uniqueCodes = new Set(codes);
		strictEqual(uniqueCodes.size, 5, "five distinct codes defined");
		deepStrictEqual(codes, [
			"checkpoint_task_file_mismatch",
			"checkpoint_missing_queue_identity",
			"checkpoint_queue_identity_mismatch",
			"checkpoint_run_options_mismatch",
			"checkpoint_historical_checkpoint",
		]);
	});

	it("the run-options mismatch regression emits checkpoint_run_options_mismatch in runQueue", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions1 = normalizeRunOptions({ checkpointPath, maxTasks: 1 });
		const runOptions2 = normalizeRunOptions({ checkpointPath, maxTasks: 2 });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksPath,
				queueIdentity,
				runOptions: runOptions2,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				runOptions: runOptions1,
				queueIdentity,
				projectRevision: "rev-1",
				dependencies: {
					route: () => ({ provider: "claude", model: "claude-sonnet-5" }),
					integrationGate: () => ({ success: true }),
					adapters: {},
				},
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"runQueue must throw CheckpointIdentityError",
		);
		strictEqual(thrown.code, "checkpoint_run_options_mismatch");
	});

	it("the run-options mismatch regression emits checkpoint_run_options_mismatch in runQueueAsync", async () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions1 = normalizeRunOptions({ checkpointPath, maxTasks: 1 });
		const runOptions2 = normalizeRunOptions({ checkpointPath, maxTasks: 2 });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksFileOrTasksPath(tasksPath),
				queueIdentity,
				runOptions: runOptions2,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		function tasksFileOrTasksPath(p) {
			return p;
		}

		let thrown = null;
		try {
			await runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				runOptions: runOptions1,
				queueIdentity,
				projectRevision: "rev-1",
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"runQueueAsync must throw CheckpointIdentityError",
		);
		strictEqual(thrown.code, "checkpoint_run_options_mismatch");
	});
});
