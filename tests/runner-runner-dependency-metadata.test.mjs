import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import {
	createQueueIdentity,
	deriveQueueDiagnostics,
	getRunnableTasks,
	normalizeRunOptions,
	TaskSelectionError,
	validateTaskGraph,
} from "../src/switchyard/runner/index.mjs";
import { parseFixture, runnerTestDir } from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("runner dependency metadata", () => {
	it("parses task-only dependencies and external blockers", () => {
		const markdown = `## Phase 1

### Task 1.1: Root
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** none
- **Description:** Root

### Task 1.2: Middle
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** Task 1.1
- **Description:** Middle

### Task 1.3: Leaf
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** Tasks 1.1, Task 1.2
- **External blockers:** decision:release-approval, gate:phase-1
- **Description:** Leaf
`;
		const tasks = parseFixture(markdown);
		deepStrictEqual(
			tasks.map((task) => task.blockedBy),
			[[], ["1.1"], ["1.1", "1.2"]],
		);
		deepStrictEqual(tasks[2].externalBlockers, [
			"decision:release-approval",
			"gate:phase-1",
		]);
	});

	it("rejects free prose and malformed external blocker ids", () => {
		const prose = `### Task 1.1: Bad dependency
- **Status:** pending
- **Files:** src/a.mjs
- **Blocked by:** after the review is approved
`;
		throws(() => parseFixture(prose), /invalid Blocked by field/);

		const malformedExternal = `### Task 1.1: Bad external blocker
- **Status:** pending
- **Files:** src/a.mjs
- **External blockers:** David must approve
`;
		throws(
			() => parseFixture(malformedExternal),
			/invalid External blockers id/,
		);
	});

	it("rejects unknown, self, cyclic, and duplicate dependencies", () => {
		const queue = (body) => `### Task 1.1: Task one
- **Status:** pending
- **Files:** src/a.mjs
${body}
`;
		throws(
			() => parseFixture(queue("- **Blocked by:** Task 9.9")),
			/unknown Blocked by task "9\.9"/,
		);
		throws(
			() => parseFixture(queue("- **Blocked by:** Task 1.1")),
			/self-dependency is not allowed/,
		);

		const cycle = `### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Blocked by:** Task 1.2

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Blocked by:** Task 1.1
`;
		throws(() => parseFixture(cycle), /task dependency cycle detected/);
		throws(
			() => parseFixture(queue("- **Blocked by:** Task 1.1, Task 1.1")),
			/duplicate Blocked by dependency/,
		);
	});

	it("gates chains and diamonds on done or checkpoint-success prerequisites", () => {
		const tasks = [
			{ id: "1.1", status: "pending", executor: "switchyard" },
			{
				id: "1.2",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
			},
			{
				id: "1.3",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
			},
			{
				id: "1.4",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.2", "1.3"],
			},
		];

		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: [] }).map((task) => task.id),
			["1.1"],
		);
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: ["1.1"] }).map(
				(task) => task.id,
			),
			["1.2", "1.3"],
		);
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: ["1.1", "1.2", "1.3"] }).map(
				(task) => task.id,
			),
			["1.4"],
		);

		const failedPrerequisite = [
			...tasks.slice(0, 2),
			{
				id: "1.5",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.2"],
			},
		];
		deepStrictEqual(
			getRunnableTasks(failedPrerequisite, {
				completedTaskIds: [],
				results: [{ taskId: "1.2", success: false }],
			}).map((task) => task.id),
			["1.1"],
		);
	});

	it("keeps external, native, human, and unselected work out of provider routing", () => {
		const tasks = [
			{
				id: "1.1",
				status: "pending",
				executor: "switchyard",
				externalBlockers: ["decision:approval"],
			},
			{ id: "1.2", status: "pending", executor: "native" },
			{ id: "1.3", status: "pending", executor: "human" },
			{
				id: "1.4",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.2"],
			},
		];
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: [] }).map((task) => task.id),
			[],
		);
		deepStrictEqual(
			getRunnableTasks(
				tasks,
				{ completedTaskIds: [] },
				{ resolvedExternalBlockers: ["decision:approval"] },
			).map((task) => task.id),
			["1.1"],
		);
		deepStrictEqual(
			getRunnableTasks(
				[
					{ id: "1.1", status: "done", executor: "human" },
					{
						id: "1.2",
						status: "pending",
						executor: "switchyard",
						blockedBy: ["1.1"],
					},
				],
				{ completedTaskIds: [] },
			).map((task) => task.id),
			["1.2"],
		);
	});

	it("validates programmatic dependency graphs before routing", () => {
		throws(
			() => validateTaskGraph([{ id: "1.1", blockedBy: ["9.9"] }]),
			/unknown Blocked by task "9\.9"/,
		);
	});

	it("derives content-free queue diagnostics with stable reason codes", () => {
		const tasks = [
			{
				id: "1.1",
				status: "pending",
				executor: "switchyard",
				description: "provider task description",
				requiredPaths: ["src/provider-secret-name.mjs"],
			},
			{ id: "1.2", status: "pending", executor: "human" },
			{ id: "1.3", status: "pending", executor: "native" },
			{
				id: "1.4",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
			},
			{
				id: "1.5",
				status: "pending",
				executor: "switchyard",
				externalBlockers: ["decision:approval"],
			},
			{ id: "1.6", status: "done", executor: "switchyard" },
		];

		const diagnostics = deriveQueueDiagnostics(tasks, {
			completedTaskIds: ["1.6"],
		});
		deepStrictEqual(diagnostics, {
			selected: { count: 5, reason: "queue_default" },
			runnable: { count: 1, reason: "provider_eligible_and_unblocked" },
			humanGated: { count: 1, reason: "executor_human" },
			nativeGated: { count: 1, reason: "executor_native" },
			dependencyBlocked: { count: 1, reason: "task_dependency" },
			externalBlocked: { count: 1, reason: "external_blocker" },
			completed: { count: 1, reason: "queue_status_or_checkpoint" },
		});

		const serialized = JSON.stringify(diagnostics);
		ok(!serialized.includes("provider task description"));
		ok(!serialized.includes("provider-secret-name.mjs"));
		ok(!serialized.includes("decision:approval"));
	});

	it("capstone: immutable handoff and Sentinel-style queues honor every unconditional contract", () => {
		// Keep this fixture immutable and local: the capstone must not depend on
		// an active plan file, a provider credential, or a live quota response.
		const markdown = `## Phase 1

### Task 1.1: Sentinel root
- **Status:** pending
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** The root task spans multiple provider boundaries.
- **Executor:** switchyard
- **Files:** src/root.mjs
- **Blocked by:** none
- **Description:** provider work stays in the selected execution lane

### Task 1.2: Native handoff
- **Status:** pending
- **RequiredCapability:** standard
- **Executor:** native
- **Description:** native work never enters provider routing

### Task 1.3: Human approval
- **Status:** pending
- **RequiredCapability:** low
- **RequiredCapabilityJustification:** The human approval is a mechanical confirmation.
- **Executor:** human
- **Description:** human work is gated outside the provider queue

### Task 1.4: External gate
- **Status:** pending
- **RequiredCapability:** standard
- **Executor:** switchyard
- **Files:** src/gated.mjs
- **External blockers:** decision:release-approval
- **Description:** the unresolved external gate remains parked

### Task 1.5: Dependent follow-up
- **Status:** pending
- **RequiredCapability:** low
- **RequiredCapabilityJustification:** The follow-up is a bounded mechanical change.
- **Executor:** switchyard
- **Files:** src/follow-up.mjs
- **Blocked by:** Task 1.1
- **Description:** follow-up waits for durable success of the root
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 5);
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: [] }).map((task) => task.id),
			["1.1"],
		);
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: ["1.1"] }).map(
				(task) => task.id,
			),
			["1.5"],
		);
		throws(
			() =>
				getRunnableTasks(
					tasks,
					{ completedTaskIds: [] },
					{ selectedTaskIds: ["1.4"] },
				),
			(error) =>
				error instanceof TaskSelectionError &&
				error.reason === "external-blocked:decision:release-approval",
		);

		const diagnostics = deriveQueueDiagnostics(tasks, {
			completedTaskIds: [],
		});
		strictEqual(diagnostics.runnable.count, 1);
		strictEqual(diagnostics.nativeGated.reason, "executor_native");
		strictEqual(diagnostics.humanGated.reason, "executor_human");
		strictEqual(diagnostics.externalBlocked.reason, "external_blocker");
		strictEqual(diagnostics.dependencyBlocked.reason, "task_dependency");
		const serializedDiagnostics = JSON.stringify(diagnostics);
		ok(!serializedDiagnostics.includes("provider work stays"));
		ok(!serializedDiagnostics.includes("src/root.mjs"));
		ok(!serializedDiagnostics.includes("decision:release-approval"));

		const runOptions = normalizeRunOptions({
			maxTasks: 2,
			only: ["agy"],
			exclude: ["codex"],
			taskIds: ["1.1"],
		});
		const identity = createQueueIdentity({
			tasksFilePath: "/immutable/sentinel/tasks.md",
			markdown,
			tasks,
			projectRevision: "sentinel-revision",
			runOptions,
		});
		notStrictEqual(
			identity,
			createQueueIdentity({
				tasksFilePath: "/immutable/sentinel/tasks.md",
				markdown,
				tasks,
				projectRevision: "sentinel-revision",
				runOptions: normalizeRunOptions({ ...runOptions, maxTasks: 1 }),
			}),
			"run-shaping options must be identity-bound",
		);
		notStrictEqual(
			identity,
			createQueueIdentity({
				tasksFilePath: "/immutable/sentinel/tasks.md",
				markdown: `${markdown}\n<!-- immutable fixture revision -->\n`,
				tasks,
				projectRevision: "sentinel-revision",
				runOptions,
			}),
			"queue content must be identity-bound",
		);
	});
});
