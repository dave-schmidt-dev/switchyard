import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createEmptyCheckpoint,
	createQueueIdentity,
	getRunnableTasks,
	loadCheckpoint,
	loadTaskQueue,
	normalizeRunOptions,
	planPotentialAttemptTasks,
	QueuePreflightError,
	saveCheckpoint,
	TaskSelectionError,
} from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
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
describe("runner task selection and queue identity", () => {
	it("plans only the bounded potential attempts and dynamically unblocks in queue order", () => {
		const tasks = [
			{
				id: "1.1",
				status: "pending",
				executor: "native",
				requiredCapability: "high",
			},
			{
				id: "1.2",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
				requiredCapability: "high",
			},
			{
				id: "1.3",
				status: "pending",
				executor: "switchyard",
				requiredCapability: "standard",
			},
			{
				id: "1.4",
				status: "pending",
				executor: "human",
				requiredCapability: "high",
			},
		];
		const planned = planPotentialAttemptTasks(
			tasks,
			{ completedTaskIds: [] },
			{ maxTasks: 1 },
		);
		deepStrictEqual(
			planned.map((task) => task.id),
			["1.3"],
		);
		const unblocked = planPotentialAttemptTasks(
			tasks,
			{ completedTaskIds: ["1.1"] },
			{ maxTasks: 2 },
		);
		deepStrictEqual(
			unblocked.map((task) => task.id),
			["1.2", "1.3"],
		);
		const retryFirst = planPotentialAttemptTasks(
			tasks,
			{ completedTaskIds: [], retryState: { taskId: "1.3" } },
			{ selectedTaskIds: ["1.3"], maxTasks: 1 },
		);
		deepStrictEqual(
			retryFirst.map((task) => task.id),
			["1.3"],
		);
		const selectedHigh = planPotentialAttemptTasks(
			tasks,
			{ completedTaskIds: ["1.1"] },
			{ selectedTaskIds: ["1.2"], maxTasks: 2 },
		);
		deepStrictEqual(
			selectedHigh.map((task) => task.id),
			["1.2"],
		);
		const blocked = planPotentialAttemptTasks(
			[
				{ id: "native", status: "pending", executor: "native" },
				{ id: "human", status: "pending", executor: "human" },
				{ id: "external", status: "pending", externalBlockers: ["approval"] },
			],
			{ completedTaskIds: [] },
			{ maxTasks: 3 },
		);
		deepStrictEqual(blocked, []);
		const sanitized = new QueuePreflightError("synthetic", {
			reason: "no_eligible",
			rejections: [
				{
					capability: "standard",
					reason: "safe",
					excludedProviders: ["claude", "\u0000canary"],
					excludedReasons: { claude: "no_descriptor", leak: { raw: true } },
				},
			],
			canary: "must-drop",
		});
		deepStrictEqual(sanitized.preflightDetail, {
			reason: "no_eligible",
			rejections: [
				{
					capability: "standard",
					reason: "safe",
					excludedProviders: ["claude", " canary"],
					excludedReasons: { claude: "no_descriptor" },
				},
			],
		});
		const malformed = new QueuePreflightError("synthetic", {
			reason: "no_eligible",
			rejections: "not-an-array",
		});
		deepStrictEqual(malformed.preflightDetail, {
			reason: "no_eligible",
			rejections: [],
		});
		const nestedMalformed = new QueuePreflightError("synthetic", {
			reason: "no_eligible",
			rejections: [
				null,
				"bad",
				{
					capability: "standard",
					excludedProviders: "bad",
					excludedReasons: [],
				},
			],
		});
		deepStrictEqual(nestedMalformed.preflightDetail, {
			reason: "no_eligible",
			rejections: [{ capability: "standard", reason: "unknown" }],
		});
	});
	it("rejects explicit selection with a stable reason for each unsafe target", () => {
		const checkpoint = { completedTaskIds: [] };
		const tasks = [
			{ id: "1.1", status: "pending", executor: "switchyard" },
			{ id: "1.2", status: "pending", executor: "native" },
			{ id: "1.3", status: "pending", executor: "human" },
			{
				id: "1.4",
				status: "pending",
				executor: "switchyard",
				externalBlockers: ["decision:approval"],
			},
			{
				id: "1.5",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
			},
		];

		for (const [taskId, reason] of [
			["missing", "unknown-task"],
			["1.2", "native-task"],
			["1.3", "human-task"],
			["1.4", "external-blocked:decision:approval"],
			["1.5", "dependency-blocked:1.1"],
		]) {
			throws(
				() =>
					getRunnableTasks(tasks, checkpoint, { selectedTaskIds: [taskId] }),
				(error) =>
					error instanceof TaskSelectionError && error.reason === reason,
			);
		}
	});

	it("creates and validates an identity-bound v3 checkpoint", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Identity task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** Identity
`);
		const tasks = loadTaskQueue(tasksPath);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions = normalizeRunOptions({
			checkpointPath,
			maxTasks: 1,
			stopOnFailure: true,
			taskIds: ["1.1"],
		});
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks,
			projectRevision: "rev-1",
			runOptions,
		});
		const empty = createEmptyCheckpoint(tasksPath, {
			queueIdentity,
			runOptions,
		});
		saveCheckpoint(checkpointPath, empty);
		const loaded = loadCheckpoint(checkpointPath, tasksPath, {
			queueIdentity,
			runOptions,
		});
		strictEqual(loaded.version, 3);
		strictEqual(loaded.queueIdentity, queueIdentity);
		throws(
			() =>
				loadCheckpoint(checkpointPath, tasksPath, {
					queueIdentity: `${"0".repeat(64)}`,
					runOptions,
				}),
			/checkpoint identity mismatch/,
		);
	});
});
