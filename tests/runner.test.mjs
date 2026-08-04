import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
	throws,
} from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../src/switchyard/adapter/constants.mjs";
import {
	createCliOrchestrator,
	createEmptyCheckpoint,
	createQueueIdentity,
	deriveQueueDiagnostics,
	executeTask,
	executeTaskWithOrchestrator,
	getRunnableTasks,
	loadCheckpoint,
	loadTaskQueue,
	normalizeRunOptions,
	parseTaskQueue,
	resolveOrchestrator,
	runQueue,
	runQueueWithOrchestrator,
	saveCheckpoint,
	TaskSelectionError,
	validateTaskGraph,
	waitForJobCompletion,
} from "../src/switchyard/runner/index.mjs";

const TEST_DIR = join(cwd(), ".switchyard-runner-test");
// Task 1.5 (roster-unification plan): src/switchyard/roster/index.mjs now
// lazily loads the roster, resolving SWITCHYARD_ROSTER_PATH or the canonical
// ~/.agent/roster.json default (Task 4.1) and failing loud only if that
// resolved file can't load. Most of this file's tests inject
// `dependencies.route` and never touch the roster at all, but the two tests
// explicitly noted as exercising the real, unmocked route() do reach it —
// point them at this committed synthetic fixture (not the real
// ~/.agent/roster.json) so they keep passing.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);

// These older runner fixtures predate the mandatory task-contract Executor:
// field. Normalize only the fixture text so the real parser receives an
// explicit field; the missing-Executor rejection is tested directly below.
function withExplicitSwitchyardExecutor(markdown) {
	const lines = markdown.split("\n");
	return lines
		.flatMap((line, index) => {
			if (!/^- \*\*Status:\*\*/.test(line)) return [line];
			const nextHeading = lines.findIndex(
				(candidate, candidateIndex) =>
					candidateIndex > index && /^### Task /.test(candidate),
			);
			const blockEnd = nextHeading === -1 ? lines.length : nextHeading;
			const hasExecutor = lines
				.slice(index + 1, blockEnd)
				.some((candidate) => /^- \*\*Executor:\*\*/.test(candidate));
			return hasExecutor ? [line] : [line, "- **Executor:** switchyard"];
		})
		.join("\n");
}

function parseFixture(markdown) {
	return parseTaskQueue(withExplicitSwitchyardExecutor(markdown));
}

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

describe("runner queue parsing", () => {
	it("parses task blocks with status and description", () => {
		const markdown = `## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do first thing

### Task 1.2: Second task
- **Status:** in progress
- **Files:** src/a.mjs
- **Description:** Do second thing
`;

		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 2);
		strictEqual(tasks[0].id, "1.1");
		strictEqual(tasks[0].status, "pending");
		strictEqual(tasks[1].id, "1.2");
		strictEqual(tasks[1].status, "in progress");
	});

	it("parses tasks with Work or unlabelled body sections", () => {
		const markdown = `
### Task 2.1: Work section task
- **Status:** pending
- **Files:** src/a.mjs
- **Work:** Do the work steps

### Task 2.2: Raw body task
- **Status:** pending
- **Files:** src/a.mjs
1. Step one
2. Step two
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 2);
		strictEqual(tasks[0].description, "Do the work steps");
		strictEqual(tasks[1].description.includes("Step one"), true);
	});

	it("returns runnable tasks excluding completed checkpoint IDs", () => {
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "in progress" },
			{ id: "1.3", status: "done" },
		];
		const checkpoint = {
			completedTaskIds: ["1.1"],
		};
		const runnable = getRunnableTasks(tasks, checkpoint);
		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.2"],
		);
	});

	it("warns and excludes a task with an unrecognized status instead of silently dropping it", () => {
		// Regression (Task 12): the old filter matched exactly
		// `pending`/`in progress`, so a typo'd status was excluded with no
		// signal, indistinguishable from a deliberate skip. The task must now
		// still be excluded, but the exclusion must be *visible*. The
		// discriminating assertion is that console.error fires — the old code
		// also excluded it, so "excluded" alone would pass on the unfixed code.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "pnding" }, // typo
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1"],
		);
		strictEqual(warnings.length, 1);
		ok(warnings[0].includes("1.2"));
		ok(warnings[0].includes("pnding"));
	});

	it("excludes recognized non-runnable statuses (done, blocked) without any warning", () => {
		// `done` and `blocked` are documented project vocabulary — an
		// intentional skip, not a mistake — so they must be excluded silently.
		// Warning on them (e.g. on every completed task) would be pure noise.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "done" },
			{ id: "1.3", status: "blocked" },
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1"],
		);
		strictEqual(warnings.length, 0);
	});

	it("normalizes case and surrounding whitespace before matching status", () => {
		// A differently-cased or padded status is a recognized status, not an
		// unrecognized one — it must run, not warn.
		const tasks = [
			{ id: "1.1", status: "  Pending  " },
			{ id: "1.2", status: "IN PROGRESS" },
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1", "1.2"],
		);
		strictEqual(warnings.length, 0);
	});

	it("throws on duplicate task IDs within one parse instead of yielding both", () => {
		// Regression (Task 12): a malformed queue with two blocks sharing an id
		// previously returned both — `done.has(id)` only checks the checkpoint's
		// completed set, not IDs already yielded in this same pass — so both
		// would execute in one run. Fail loudly, matching loadCheckpoint's
		// posture on malformed input.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.1", status: "pending" },
		];
		throws(
			() => getRunnableTasks(tasks, { completedTaskIds: [] }),
			/duplicate task id "1\.1"/,
		);
	});

	it("extracts requiredPaths from a Files: field", () => {
		const markdown = `## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** src/a.mjs, tests/a.test.mjs
- **Description:** Do things with files
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		deepStrictEqual(tasks[0].requiredPaths, ["src/a.mjs", "tests/a.test.mjs"]);
	});

	it("sets requiredPaths to null when no Files: field is present on a review task", () => {
		const markdown = `## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Type:** review
- **Description:** Do things
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].requiredPaths, null);
	});

	it("rejects a Files: field with an absolute path", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** /etc/passwd
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /absolute path/);
	});

	it("rejects a Files: field with '..' traversal", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** ../outside/evil.mjs
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /path traversal/);
	});

	it("rejects a Files: field with a wildcard", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/*.mjs
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /wildcards/);
	});

	it("rejects an empty Files: field (no paths)", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:**   	
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /empty/);
	});

	it("rejects a Files: field with backslash separators", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src\\evil.mjs
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /backslash/);
	});

	it("rejects a Files: field with directory-only entries", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /directory-only/);
	});

	it("rejects a Files: field with duplicate paths", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs, src/a.mjs
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /duplicate/);
	});

	it("ignores prose-embedded Files: mentions and only matches - **Files:** lines", () => {
		const markdown = `## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This mentions Files: but without the bullet anchor
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		deepStrictEqual(tasks[0].requiredPaths, ["src/a.mjs"]);
	});

	it("extracts timeoutMs from a Timeout: field in minutes", () => {
		const markdown = `## Phase 1

### Task 1.1: Long task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 90m
- **Description:** Needs more than the default 30 minutes
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].timeoutMs, 90 * 60 * 1000);
	});

	it("extracts timeoutMs from a Timeout: field in seconds, hours, and fractional hours", () => {
		strictEqual(
			parseFixture(
				"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Timeout:** 45s\n",
			)[0].timeoutMs,
			45 * 1000,
		);
		strictEqual(
			parseFixture(
				"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Timeout:** 2h\n",
			)[0].timeoutMs,
			2 * 3_600_000,
		);
		strictEqual(
			parseFixture(
				"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Timeout:** 1.5h\n",
			)[0].timeoutMs,
			1.5 * 3_600_000,
		);
	});

	it("sets timeoutMs to null when no Timeout: field is present", () => {
		const markdown = `## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do things
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].timeoutMs, null);
	});

	it("rejects a Timeout: field without a unit suffix (bare number is ambiguous)", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 90
- **Description:** Bad
`;
		throws(
			() => parseFixture(markdown),
			/expected a number followed by s\/m\/h/,
		);
	});

	it("rejects a Timeout: field with an unsupported unit", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 90ms
- **Description:** Bad
`;
		throws(
			() => parseFixture(markdown),
			/expected a number followed by s\/m\/h/,
		);
	});

	it("rejects a Timeout: field below the 1-second floor", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 0s
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /must be between 1s and 24h/);
	});

	it("rejects a Timeout: field above the 24-hour typo-guard ceiling", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 48h
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /must be between 1s and 24h/);
	});

	it("extracts requiredCapability from RequiredCapability:, normalizing case", () => {
		const markdown = `## Phase 1

### Task 1.1: Declared capability task
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **RequiredCapability:** Standard
- **Description:** Whatever classifyTask would guess is irrelevant here
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].requiredCapability, "standard");
		strictEqual(tasks[0].executor, "switchyard");
	});

	it("sets requiredCapability to null when Executor is explicit", () => {
		const markdown = `## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **Description:** Do things
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].requiredCapability, null);
		strictEqual(tasks[0].executor, "switchyard");
	});

	it("rejects a task contract with no Executor field", () => {
		const markdown = `### Task 1.1: Missing executor
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do things
`;
		throws(
			() => parseTaskQueue(markdown),
			/Task 1.1: missing Executor field \(expected one of: native, switchyard, human\)/,
		);
	});

	it("rejects the retired Tier: field instead of accepting it as an alias", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Tier:** urgent
- **Description:** Bad
`;
		throws(
			() => parseFixture(markdown),
			/Tier is a retired task-contract field/,
		);
	});

	it("rejects duplicate, mixed, empty, and invalid RequiredCapability declarations", () => {
		const cases = [
			[
				"- **RequiredCapability:** high\n- **RequiredCapability:** low",
				/duplicate RequiredCapability/,
			],
			["- **RequiredCapability:** high, standard", /mixed RequiredCapability/],
			["- **RequiredCapability:**", /RequiredCapability field is empty/],
			["- **RequiredCapability:** urgent", /invalid RequiredCapability field/],
		];

		for (const [declaration, error] of cases) {
			const markdown = `### Task 1.1: Bad capability\n- **Status:** pending\n- **Files:** src/a.mjs\n${declaration}\n`;
			throws(() => parseFixture(markdown), error);
		}
	});

	it("parses Executor strictly and normalizes accepted values", () => {
		for (const executor of ["Native", "SWITCHYARD", "human"]) {
			const files =
				executor.toLowerCase() === "switchyard"
					? "- **Files:** src/a.mjs\n"
					: "";
			const markdown = `### Task 1.1: Executor task\n- **Status:** pending\n${files}- **Executor:** ${executor}\n- **Description:** Work\n`;
			strictEqual(parseFixture(markdown)[0].executor, executor.toLowerCase());
		}
	});

	it("rejects duplicate, empty, and invalid Executor declarations", () => {
		const cases = [
			["- **Executor:** native\n- **Executor:** human", /duplicate Executor/],
			["- **Executor:**", /invalid Executor field/],
			["- **Executor:** provider", /invalid Executor field/],
		];

		for (const [declaration, error] of cases) {
			const markdown = `### Task 1.1: Bad executor\n- **Status:** pending\n- **Type:** review\n${declaration}\n`;
			throws(() => parseFixture(markdown), error);
		}
	});

	it("defaults type to implementation when no Type: field is present", () => {
		const markdown = `## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do things
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].type, "implementation");
	});

	it("extracts type from a Type: field, accepting explicit review and normalizing case", () => {
		const markdown = `## Phase 1

### Task 1.1: Review task
- **Status:** pending
- **Files:** src/a.mjs
- **Type:** Review
- **Description:** Perform code review
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].type, "review");
	});

	it("rejects a Type: field with an unrecognized value, failing closed at parse time", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad type task
- **Status:** pending
- **Files:** src/a.mjs
- **Type:** audit
- **Description:** Bad type
`;
		throws(
			() => parseFixture(markdown),
			/invalid Type field "audit" \(expected one of: implementation, review\)/,
		);
	});

	it("rejects a switchyard implementation task without Files: field, failing closed at parse time", () => {
		const markdown = `## Phase 1

### Task 1.1: Implementation task without files
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **Description:** Do work
`;
		throws(
			() => parseFixture(markdown),
			/Task 1.1: switchyard implementation task requires a Files: field/,
		);
	});

	it("allows native and human implementation tasks without Files: field", () => {
		const markdown = `## Phase 1

### Task 1.1: Non-switchyard implementation task without files
- **Status:** pending
- **Executor:** native
- **Description:** Do work
`;
		strictEqual(parseFixture(markdown)[0].requiredPaths, null);
	});

	it("allows review-type task without Files: field, leaving requiredPaths as null", () => {
		const markdown = `## Phase 1

### Task 1.1: Review task without files
- **Status:** pending
- **Type:** review
- **Description:** Review PR
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].type, "review");
		strictEqual(tasks[0].requiredPaths, null);
	});
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
});

describe("runner task selection and queue identity", () => {
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

	it("creates and validates an identity-bound v2 checkpoint", () => {
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
		strictEqual(loaded.version, 2);
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

describe("runner orchestration", () => {
	it("re-evaluates dependencies after each successful task", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Root task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** none
- **Description:** Root operation

### Task 1.2: Dependent task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** Task 1.1
- **Description:** Dependent operation
`);
		const dispatches = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.runnableTasks, 1);
		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			dispatches.map((dispatch) => dispatch.taskId),
			["1.1", "1.2"],
		);
	});

	it("executes tasks serially and checkpoints completion", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		const prompts = [];

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: (entry) => dispatches.push(entry),
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: (prompt) => {
						prompts.push(prompt);
						return { success: true, output: "ok" };
					},
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(result.completedTaskIds.length, 2);
		strictEqual(dispatches.length, 2);
		deepStrictEqual(prompts, [
			"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** First operation",
			"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** Second operation",
		]);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1", "1.2"]);
	});

	it("resumes from checkpoint and only runs remaining work", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const prompts = [];

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: (prompt) => {
						prompts.push(prompt);
						return { success: true, output: "ok" };
					},
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
			maxTasks: 1,
		});

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		deepStrictEqual(prompts, [
			"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** First operation",
			"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** Second operation",
		]);
	});
});

describe("runner stopOnFailure + integration gate failure", () => {
	function dependenciesWithGateResult(gateResult) {
		return {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => gateResult,
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};
	}

	it("halts the queue when integrationGate fails and stopOnFailure is true", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: true,
			dependencies: dependenciesWithGateResult({
				success: false,
				message: "rejected",
			}),
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].result, "integration_failed");
		strictEqual(result.results[0].success, false);
		deepStrictEqual(result.completedTaskIds, []);
	});

	it("continues past an integrationGate failure when stopOnFailure is false", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: false,
			dependencies: dependenciesWithGateResult({
				success: false,
				message: "rejected",
			}),
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["integration_failed", "integration_failed"],
		);
		deepStrictEqual(result.completedTaskIds, []);
	});
});

describe("runner poll/wait loop", () => {
	it("waits through running states until done", async () => {
		const statuses = [
			{ state: "running", expected_by: "2999-01-01T00:00:00Z" },
			{ state: "2/3", expected_by: "2999-01-01T00:00:00Z" },
			{ state: "done", expected_by: "2999-01-01T00:00:00Z" },
		];
		let i = 0;
		const pollStates = [];
		let sleeps = 0;

		const result = await waitForJobCompletion({
			jobId: "job-1",
			orchestrator: {
				status: async () => {
					const current = statuses[Math.min(i, statuses.length - 1)];
					i += 1;
					return current;
				},
			},
			pollIntervalMs: 1,
			sleepFn: async () => {
				sleeps += 1;
			},
			onPoll: ({ state }) => {
				pollStates.push(state);
			},
		});

		strictEqual(result.state, "done");
		strictEqual(result.timedOut, false);
		deepStrictEqual(pollStates, ["running", "2/3", "done"]);
		strictEqual(sleeps, 2);
	});

	it("returns timed_out when expected_by is exceeded", async () => {
		const result = await waitForJobCompletion({
			jobId: "job-2",
			orchestrator: {
				status: async () => ({
					state: "running",
					expected_by: "2020-01-01T00:00:00Z",
				}),
			},
			now: () => Date.parse("2021-01-01T00:00:00Z"),
			pollIntervalMs: 1,
			sleepFn: async () => {},
		});

		strictEqual(result.state, "timed_out");
		strictEqual(result.timedOut, true);
	});
});

describe("runner headless orchestrator mode", () => {
	it("runs through launch/status/result and checkpoints", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		const dispatches = [];
		const polls = [];
		const statusesByJob = new Map([
			["job-1", [{ state: "running" }, { state: "done" }]],
			["job-2", [{ state: "done" }]],
		]);
		const diffsByJob = new Map([
			["job-1", "diff --git a/a b/a"],
			["job-2", ""],
		]);
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			pollIntervalMs: 1,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				onPoll: ({ state }) => polls.push(state),
				orchestrator: {
					launch: async (payload) => {
						launches.push(payload);
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async (jobId) => {
						const queue = statusesByJob.get(jobId) ?? [{ state: "missing" }];
						if (queue.length > 1) {
							return queue.shift();
						}
						return queue[0];
					},
					result: async (jobId) => ({
						success: true,
						diff: diffsByJob.get(jobId) ?? "",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(dispatches.length, 2);
		deepStrictEqual(
			dispatches.map((entry) => entry.result),
			["success", "success"],
		);
		deepStrictEqual(
			launches.map((payload) => payload.prompt),
			[
				"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** First operation",
				"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** Second operation",
			],
		);
		deepStrictEqual(polls, ["running", "done", "done"]);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1", "1.2"]);
	});

	it("resumes in orchestrator mode from checkpoint", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		let launchIndex = 0;

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 65,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			sleepFn: async () => {},
			orchestrator: {
				launch: async (payload) => {
					launches.push(payload);
					launchIndex += 1;
					return `job-${launchIndex}`;
				},
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
			},
		};

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			maxTasks: 1,
			dependencies,
		});

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		deepStrictEqual(
			launches.map((payload) => payload.taskId),
			["1.1", "1.2"],
		);
	});

	it("re-selects and re-fails the same unsupported provider on every resume (orchestrator launch failure, not a route gap — Task E.1)", async () => {
		// Since Task E.1, executeTaskWithOrchestrator passes availableProviders
		// (derived from context.adapters), same as executeTask — so this
		// dependencies object declares an adapters.cursor entry to keep cursor
		// selectable, isolating the scenario under test: the external
		// orchestrator is an opaque black box with no capability-discovery
		// protocol, so route() can still pick a provider the orchestrator
		// itself can't run. Here the fake orchestrator rejects "cursor" at
		// launch(), standing in for one that doesn't support that provider.
		// Because a failed launch never adds the task to completedTaskIds, a
		// resume re-selects the same task and the same provider and fails
		// identically — accepted behavior today, not a bug.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launchAttempts = [];
		const dispatches = [];

		const dependencies = {
			route: ({ availableProviders }) =>
				availableProviders && !availableProviders.includes("cursor")
					? { provider: null, reason: "no candidates" }
					: {
							provider: "cursor",
							model: "cursor-fast",
							percentLeft: 95,
							reason: "spread",
						},
			recordDispatch: (entry) => dispatches.push(entry),
			integrationGate: () => ({ success: true, message: "ok" }),
			sleepFn: async () => {},
			adapters: {
				cursor: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => null,
				},
			},
			orchestrator: {
				launch: async (payload) => {
					launchAttempts.push(payload);
					throw new Error(
						`orchestrator cannot run provider ${payload.provider}`,
					);
				},
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
			},
		};

		const first = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		// Failed task is recorded but NOT marked complete...
		strictEqual(first.results[0].result, "launch_failed");
		deepStrictEqual(first.completedTaskIds, []);
		deepStrictEqual(
			loadCheckpoint(checkpointPath, tasksPath).completedTaskIds,
			[],
		);

		// ...so a resume re-runs the SAME task against the SAME provider.
		const second = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		strictEqual(second.results[0].result, "launch_failed");
		deepStrictEqual(second.completedTaskIds, []);

		strictEqual(launchAttempts.length, 2);
		deepStrictEqual(
			launchAttempts.map((payload) => payload.taskId),
			["1.1", "1.1"],
		);
		deepStrictEqual(
			launchAttempts.map((payload) => payload.provider),
			["cursor", "cursor"],
		);
	});
});

describe("runner provider spread recording", () => {
	it("records split dispatches across claude and codex", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Type:** review
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Type:** review
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		let routeIndex = 0;
		const routes = [
			{
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 70,
				reason: "spread",
			},
			{
				provider: "codex",
				model: "gpt-5.6-terra",
				percentLeft: 68,
				reason: "spread",
			},
		];
		let launchIndex = 0;

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => {
					const selected = routes[Math.min(routeIndex, routes.length - 1)];
					routeIndex += 1;
					return selected;
				},
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
		});

		deepStrictEqual(
			dispatches.map((entry) => entry.provider),
			["claude", "codex"],
		);
		deepStrictEqual(
			dispatches.map((entry) => entry.model),
			["claude-sonnet-5", "gpt-5.6-terra"],
		);
		deepStrictEqual(
			dispatches.map((entry) => entry.result),
			["success_no_diff", "success_no_diff"],
		);
	});

	it("uses headroom routing to split providers across tasks", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Type:** review
- **Description:** integration task one

### Task 1.2: Second task
- **Status:** pending
- **Type:** review
- **Description:** integration task two
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		// Isolated per-test temp snapshot, not the real shared SNAPSHOT_PATH: this
		// test intentionally exercises the real, unmocked route() (no
		// dependencies.route override below), and tests/router.test.mjs also
		// exercises the real loader concurrently in its own process. Both used to
		// read/write/rm the SAME on-disk SNAPSHOT_PATH (the host-side gradus
		// snapshot), which raced under `node --test`'s concurrent-file execution.
		// The env var is read dynamically by resolveSnapshotPath() in
		// src/switchyard/router/index.mjs, so pointing it at a unique file here
		// redirects the real readSnapshot() without touching production callers.
		const snapshotPath = join(
			tmpdir(),
			`switchyard-runner-test-headroom-${process.pid}-${randomUUID()}.json`,
		);
		let launchIndex = 0;

		const writeSnapshot = (claudePercentLeft, codexPercentLeft) => {
			writeFileSync(
				snapshotPath,
				JSON.stringify({
					schema_version: 2,
					providers: [
						{
							name: "claude",
							ok: true,
							windows: [{ percent_left: claudePercentLeft, pace_delta: 100 }],
						},
						{
							name: "codex",
							ok: true,
							windows: [{ percent_left: codexPercentLeft, pace_delta: 100 }],
						},
					],
				}),
				"utf8",
			);
		};

		const previousOverride = process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
		process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = snapshotPath;
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;

		try {
			writeSnapshot(72, 60);

			await runQueueWithOrchestrator({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					recordDispatch: (entry) => {
						dispatches.push(entry);
						if (dispatches.length === 1) {
							writeSnapshot(4, 68);
						}
					},
					integrationGate: () => ({ success: true, message: "ok" }),
					sleepFn: async () => {},
					orchestrator: {
						launch: async () => {
							launchIndex += 1;
							return `job-${launchIndex}`;
						},
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: "" }),
					},
				},
			});

			deepStrictEqual(
				dispatches.map((entry) => entry.provider),
				["claude", "codex"],
			);
			// Assert the mechanism, not just the outcome sequence: the first
			// dispatch picks claude specifically because it has more headroom
			// (72 > 60) via spread selection, and the second picks codex
			// specifically because claude's headroom then dropped to 4% —
			// below DEFAULT_FLOOR (5.0) — excluding it, not because provider
			// selection happened to differ for some unrelated reason.
			strictEqual(dispatches[0].reason, "spread");
			strictEqual(dispatches[0].percentLeft, 72);
			strictEqual(dispatches[1].reason, "spread");
			strictEqual(dispatches[1].percentLeft, 68);
		} finally {
			if (previousOverride === undefined) {
				delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
			} else {
				process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = previousOverride;
			}
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			try {
				rmSync(snapshotPath, { force: true });
			} catch {
				// ignore cleanup errors
			}
		}
	});

	it("never dispatches to a roster provider with no adapter, even with the most headroom", async () => {
		// Regression: vibe/agy/cursor/copilot are in the roster but only
		// claude/codex have adapters wired here. Before the availableProviders
		// fix, route() (unconstrained) could legitimately pick vibe for a
		// low-capability task, selectAdapter() would return null, and the task
		// would fail with "unsupported_provider" forever — every resume
		// re-picks the same unsupported provider and fails identically.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** simple trivial cleanup
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		// Isolated per-test temp snapshot — see the "uses headroom routing" test
		// above for why: this test also exercises the real, unmocked route().
		const snapshotPath = join(
			tmpdir(),
			`switchyard-runner-test-noadapter-${process.pid}-${randomUUID()}.json`,
		);

		const previousOverride = process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
		process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = snapshotPath;
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;

		try {
			writeFileSync(
				snapshotPath,
				JSON.stringify({
					schema_version: 2,
					providers: [
						{
							name: "claude",
							ok: true,
							windows: [{ percent_left: 30, pace_delta: 100 }],
						},
						{
							name: "vibe",
							ok: true,
							windows: [{ percent_left: 95, pace_delta: 10 }],
						},
					],
				}),
				"utf8",
			);

			const dispatches = [];
			const result = runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					// Real router (not mocked) — only override recordDispatch/adapters.
					recordDispatch: (entry) => dispatches.push(entry),
					integrationGate: () => ({ success: true, message: "ok" }),
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/b b/b",
						},
					},
				},
			});

			strictEqual(dispatches[0].provider, "claude");
			notStrictEqual(dispatches[0].result, "unsupported_provider");
			strictEqual(result.results[0].success, true);
		} finally {
			if (previousOverride === undefined) {
				delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
			} else {
				process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = previousOverride;
			}
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			try {
				rmSync(snapshotPath, { force: true });
			} catch {
				// ignore cleanup errors
			}
		}
	});

	for (const provider of ["agy", "cursor"]) {
		it(`dispatches to the ${provider} adapter when route selects it (regression: selectAdapter only recognized claude/codex)`, () => {
			// Regression: runQueue's default adapters map was extended to include
			// agy/cursor (so route()'s availableProviders correctly reports them
			// as dispatchable), but selectAdapter() itself was never updated
			// beyond its original claude/codex checks. That combination is worse
			// than not wiring them at all: route() is now told agy/cursor are
			// available and may legitimately pick one, but selectAdapter() then
			// returns null for it and the task fails with "unsupported_provider"
			// on every attempt (and every resume), exactly the failure mode the
			// availableProviders fix was meant to eliminate.
			const dispatches = [];
			const result = executeTask(
				{ id: "1.1", title: "task", description: "simple cleanup" },
				{
					route: () => ({
						provider,
						model: `${provider}-model`,
						percentLeft: 50,
						reason: "spread",
					}),
					recordDispatch: (entry) => dispatches.push(entry),
					integrationGate: () => ({ success: true, message: "ok" }),
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/b b/b",
						},
						agy: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/c b/c",
						},
						cursor: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/d b/d",
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
			);

			notStrictEqual(
				result.result,
				"unsupported_provider",
				`${provider} has an adapter wired but was rejected as unsupported`,
			);
			strictEqual(result.success, true);
			strictEqual(dispatches[0].provider, provider);
			strictEqual(dispatches[0].result, "success");
		});
	}
});

describe("runner no-provider outcome carries the route reason (Task D.3)", () => {
	it("returns the route's reason in the result object when no provider is found, not just the ledger record", () => {
		// The ledger record always carried `reason`; the RETURNED result must
		// too, so callers (dispatch's onResult) can tell the operator a
		// deterministic INV-5 capability-ceiling exhaustion from an actionable
		// upstream-unavailable provider. Route's reason passes through
		// verbatim, including the redacted upstream error detail.
		const dispatches = [];
		const result = executeTask(
			{ id: "1.1", title: "task", description: "simple cleanup" },
			{
				route: () => ({
					provider: null,
					reason: "no_eligible_upstream_unavailable: claude — token expired",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true }),
				adapters: {},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.result, "no_provider");
		strictEqual(result.success, false);
		strictEqual(
			result.reason,
			"no_eligible_upstream_unavailable: claude — token expired",
		);
		// Ledger record unchanged behavior: still records the same reason.
		strictEqual(dispatches[0].result, "no_provider");
		strictEqual(
			dispatches[0].reason,
			"no_eligible_upstream_unavailable: claude — token expired",
		);
	});
});

describe("runner cli orchestrator wiring", () => {
	it("builds launch/status/result calls for CLI orchestrator", async () => {
		const calls = [];
		const outputs = [
			JSON.stringify({ job_id: "job-123" }),
			JSON.stringify({ state: "done", expected_by: "2999-01-01T00:00:00Z" }),
			JSON.stringify({ success: true, diff: "diff --git a/a b/a" }),
		];

		const orch = createCliOrchestrator({
			command: "switchyard-orch",
			baseArgs: ["--headless"],
			execFn: (command, args) => {
				calls.push([command, args]);
				return outputs.shift();
			},
		});

		const jobId = await orch.launch({ taskId: "1.1" });
		const status = await orch.status(jobId);
		const result = await orch.result(jobId);

		strictEqual(jobId, "job-123");
		strictEqual(status.state, "done");
		strictEqual(result.success, true);
		deepStrictEqual(calls[0], [
			"switchyard-orch",
			["--headless", "launch", "--json", JSON.stringify({ taskId: "1.1" })],
		]);
		deepStrictEqual(calls[1], [
			"switchyard-orch",
			["--headless", "status", "job-123"],
		]);
		deepStrictEqual(calls[2], [
			"switchyard-orch",
			["--headless", "result", "job-123"],
		]);
	});

	it("resolves orchestrator from dependencies first", () => {
		const marker = { status: async () => ({ state: "done" }) };
		const resolved = resolveOrchestrator({ orchestrator: marker });
		strictEqual(resolved, marker);
	});

	it("throws when no dependency or environment orchestrator is set", () => {
		const previousCmd = process.env.SWITCHYARD_ORCHESTRATOR_CMD;
		const previousArgs = process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;
		delete process.env.SWITCHYARD_ORCHESTRATOR_CMD;
		delete process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;

		let error = null;
		try {
			resolveOrchestrator({});
		} catch (err) {
			error = err;
		} finally {
			if (previousCmd === undefined) {
				delete process.env.SWITCHYARD_ORCHESTRATOR_CMD;
			} else {
				process.env.SWITCHYARD_ORCHESTRATOR_CMD = previousCmd;
			}
			if (previousArgs === undefined) {
				delete process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;
			} else {
				process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON = previousArgs;
			}
		}

		ok(error instanceof Error);
		ok(error.message.includes("SWITCHYARD_ORCHESTRATOR_CMD"));
	});
});

describe("checkpoint durability", () => {
	it("round-trips through an atomic write with no leftover temp file", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		saveCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: ["1.1"],
			lastTaskId: "1.1",
			lastUpdatedAt: "2026-01-01T00:00:00Z",
			results: [],
		});

		strictEqual(existsSync(`${checkpointPath}.tmp`), false);
		deepStrictEqual(
			loadCheckpoint(checkpointPath, tasksPath).completedTaskIds,
			["1.1"],
		);
	});

	it("throws instead of silently discarding a checkpoint that exists but fails to parse", () => {
		// Regression: a prior version caught any parse error and returned a
		// fresh empty checkpoint, indistinguishable from "no checkpoint yet" —
		// a crash mid-write (before checkpoints were written atomically) would
		// silently erase all completed-task history and trigger a full re-run.
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeFileSync(checkpointPath, "{not valid json", "utf8");

		throws(() => loadCheckpoint(checkpointPath, tasksPath), /not valid JSON/);
	});

	it("throws on a checkpoint file with an unexpected shape", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeFileSync(checkpointPath, JSON.stringify({ foo: "bar" }), "utf8");

		throws(() => loadCheckpoint(checkpointPath, tasksPath), /unexpected shape/);
	});

	it("still returns an empty checkpoint when the file is simply missing", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpoint = loadCheckpoint(
			`${tasksPath}.checkpoint.json`,
			tasksPath,
		);
		deepStrictEqual(checkpoint.completedTaskIds, []);
	});

	it("runQueue fails closed instead of silently succeeding when the tasks file parses to zero tasks", () => {
		// Regression: a tasks file with 0 "### Task <id>: <title>" headings
		// (wrong heading level, empty file, corrupted markdown) parsed to an
		// empty array and runQueue returned totalTasks:0/runnableTasks:0 as a
		// normal success — a silent no-op instead of a loud, diagnosable
		// failure.
		const tasksPath = writeTasksFile("## Phase 1\nNo task headings here.\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		throws(
			() =>
				runQueue({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {},
				}),
			/no tasks parsed from .*0 headings/,
		);

		// The auditable checkpoint must exist even though the run never
		// reached the per-task loop.
		strictEqual(existsSync(checkpointPath), true);
		const raw = JSON.parse(readFileSync(checkpointPath, "utf8"));
		strictEqual(raw.parseError.detectedHeadings, 0);
		strictEqual(raw.parseError.tasksFilePath, tasksPath);
	});

	it("runQueueWithOrchestrator also fails closed on a zero-task parse", async () => {
		const tasksPath = writeTasksFile("## Phase 1\nNo task headings here.\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		await rejects(
			() =>
				runQueueWithOrchestrator({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {},
				}),
			/no tasks parsed from .*0 headings/,
		);
		strictEqual(existsSync(checkpointPath), true);
	});

	it("runQueue always leaves a checkpoint file behind on a normal completion, even with zero runnable tasks", () => {
		// Regression: saveCheckpoint was only called inside the per-task loop,
		// so a run whose queue was already fully completed by a prior
		// checkpoint (runnable.length === 0, totalTasks > 0) returned a
		// checkpointPath with nothing on disk backing it up on this
		// invocation.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		saveCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: ["1.1"],
			lastTaskId: "1.1",
			lastUpdatedAt: "2026-01-01T00:00:00Z",
			results: [{ taskId: "1.1", success: true }],
		});

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {},
		});

		strictEqual(result.totalTasks, 1);
		strictEqual(result.runnableTasks, 0);
		strictEqual(existsSync(checkpointPath), true);
		const onDisk = JSON.parse(readFileSync(checkpointPath, "utf8"));
		deepStrictEqual(onDisk.completedTaskIds, ["1.1"]);
	});
});

describe("orchestrator status/result error guards", () => {
	it("waitForJobCompletion returns status_error instead of throwing when status() fails", async () => {
		const result = await waitForJobCompletion({
			jobId: "job-1",
			orchestrator: {
				status: async () => {
					throw new Error("orchestrator CLI crashed");
				},
			},
			sleepFn: async () => {},
		});

		strictEqual(result.state, "status_error");
		strictEqual(result.timedOut, false);
	});

	it("runQueueWithOrchestrator fails only the affected task when result() throws, not the whole queue", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => {
						throw new Error("orchestrator result endpoint unreachable");
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["result_fetch_failed", "result_fetch_failed"],
		);
		strictEqual(
			dispatches[0].reason,
			"orchestrator result endpoint unreachable",
		);
	});
});

describe("container lifecycle wiring (Tasks 8+9)", () => {
	function baseDependencies() {
		return {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			// No-op by default so an auto-create test doesn't invoke the real
			// docker+git seedProject against TEST_DIR (not a git repo). The
			// callOrder test below overrides this with a recording spy.
			seedProject: () => {},
			// No-op by default for the same reason — the real commitWorkingTree
			// runs docker+git. The callOrder test overrides it with a spy.
			commitWorkingTree: () => {},
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
			},
		};
	}

	it("runQueue skips ensureAgentContainer/createWorkingContainer entirely when workingContainerName is supplied", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let ensureCalled = false;
		let createCalled = false;
		let wipeCalled = false;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {
					ensureCalled = true;
				},
				createWorkingContainer: () => {
					createCalled = true;
					return "should-not-be-used";
				},
				wipeWorkingContainer: () => {
					wipeCalled = true;
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(
			ensureCalled,
			false,
			"a caller-supplied workingContainerName must skip ensureAgentContainer",
		);
		strictEqual(createCalled, false);
		strictEqual(
			wipeCalled,
			false,
			"a caller-supplied workingContainerName is the caller's to wipe, not runQueue's",
		);
	});

	it("fires onContainerReady with the resolved workingContainerName on both the pre-supplied and freshly-created branches", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);

		// Branch 1: caller supplies workingContainerName — onContainerReady must
		// still fire, surfacing that same name.
		const suppliedCheckpointPath = `${tasksPath}.supplied.checkpoint.json`;
		const suppliedReady = [];
		const suppliedResult = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: suppliedCheckpointPath,
			dependencies: {
				...baseDependencies(),
				onContainerReady: (info) => suppliedReady.push(info),
			},
		});

		strictEqual(suppliedResult.processedTasks, 1);
		deepStrictEqual(suppliedReady, [
			{ workingContainerName: "fake-container" },
		]);

		// Branch 2: no workingContainerName supplied — runQueue creates its own,
		// and onContainerReady must fire with the name it generated.
		const createdCheckpointPath = `${tasksPath}.created.checkpoint.json`;
		const createdReady = [];
		const createdResult = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: createdCheckpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				onContainerReady: (info) => createdReady.push(info),
			},
		});

		strictEqual(createdResult.processedTasks, 1);
		deepStrictEqual(createdReady, [
			{ workingContainerName: "generated-working-container" },
		]);
	});

	it("runQueue creates and wipes its own working container when none is supplied, ensuring the agent container first", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const callOrder = [];
		let capturedProjectPath;
		let capturedContextContainerName;
		let seededContainerName;
		let seededProjectPath;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {
					callOrder.push("ensure");
				},
				createWorkingContainer: (projectPath) => {
					callOrder.push("create");
					capturedProjectPath = projectPath;
					return "generated-working-container";
				},
				provisionCredentials: (name) => {
					callOrder.push("provision");
					capturedContextContainerName = name;
					return 1;
				},
				seedProject: (name, projectPath) => {
					callOrder.push("seed");
					seededContainerName = name;
					seededProjectPath = projectPath;
				},
				commitWorkingTree: (name) => {
					callOrder.push("commit");
					capturedContextContainerName = name;
				},
				wipeWorkingContainer: (name) => {
					callOrder.push("wipe");
					capturedContextContainerName = name;
				},
				// Marks the checkpoint save position in the sequence (fired right
				// after saveCheckpoint), proving the durable write lands between
				// execute and commit — not after it (INV-6).
				onCheckpointSaved: () => callOrder.push("checkpoint"),
				adapters: {
					claude: {
						execute: (_prompt, workingContainerName) => {
							callOrder.push(`execute:${workingContainerName}`);
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(capturedProjectPath, TEST_DIR);
		strictEqual(capturedContextContainerName, "generated-working-container");
		// The container it created is the one it seeds, with the project path
		// (INV-2: the seed is what gives captureDiff a baseline to diff against).
		strictEqual(seededContainerName, "generated-working-container");
		strictEqual(seededProjectPath, TEST_DIR);
		// commit lands after the task's execute (advancing the container baseline
		// so a following task diffs only against its own work) and before wipe.
		// The checkpoint save lands between execute and commit so a commit
		// failure can never strand a completed task outside the durable record.
		deepStrictEqual(callOrder, [
			"ensure",
			"create",
			"provision",
			"seed",
			"execute:generated-working-container",
			"checkpoint",
			"commit",
			"wipe",
		]);
	});

	it("commits the working container after EACH task so multi-task diffs stay isolated (INV-2)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const order = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => order.push("commit"),
				wipeWorkingContainer: () => {},
				onCheckpointSaved: () => order.push("checkpoint"),
				adapters: {
					claude: {
						execute: () => {
							order.push("execute");
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		// Exactly one commit per task, each immediately after that task's execute
		// — never batched at the end, which would leave every task diffing the
		// original seed and re-emitting earlier tasks' hunks. Each task's
		// checkpoint save (fired right after saveCheckpoint) also lands between
		// that task's execute and commit: the durable record is on disk before
		// the container baseline is advanced (INV-6).
		deepStrictEqual(order, [
			"execute",
			"checkpoint",
			"commit",
			"execute",
			"checkpoint",
			"commit",
		]);
	});

	it("runQueue still wipes the working container it created when a task throws mid-queue (INV-3)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		throws(() => {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					...baseDependencies(),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-working-container",
					provisionCredentials: () => {},
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
					route: () => {
						throw new Error("route exploded mid-queue");
					},
				},
			});
		}, /route exploded mid-queue/);

		strictEqual(
			wipeCalled,
			true,
			"the working container must still be wiped even when the task loop throws",
		);
	});

	it("runQueue wipes the working container it created when seedProject throws (INV-3)", () => {
		// seedProject runs inside the try/finally specifically so a seed failure
		// (e.g. the project has no committed HEAD to archive) still triggers the
		// INV-3 wipe rather than leaking the container. If seeding were placed in
		// the pre-try setup block next to provisionCredentials, this would leak.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		throws(() => {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					...baseDependencies(),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-working-container",
					provisionCredentials: () => {},
					seedProject: () => {
						throw new Error("seed exploded: project has no commits");
					},
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
				},
			});
		}, /seed exploded/);

		strictEqual(
			wipeCalled,
			true,
			"a container created by runQueue must still be wiped when seeding throws",
		);
	});

	it("runQueueWithOrchestrator also skips container wiring when workingContainerName is supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let ensureCalled = false;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				ensureAgentContainer: () => {
					ensureCalled = true;
				},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "diff --git a/a b/a" }),
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(ensureCalled, false);
	});

	it("runQueueWithOrchestrator creates and wipes its own working container when none is supplied, ensuring the agent container first", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const callOrder = [];
		let capturedProjectPath;
		let capturedContextContainerName;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				ensureAgentContainer: () => {
					callOrder.push("ensure");
				},
				createWorkingContainer: (projectPath) => {
					callOrder.push("create");
					capturedProjectPath = projectPath;
					return "generated-orchestrator-container";
				},
				provisionCredentials: (name) => {
					callOrder.push("provision");
					capturedContextContainerName = name;
					return 1;
				},
				seedProject: () => {
					callOrder.push("seed");
				},
				commitWorkingTree: () => {
					callOrder.push("commit");
				},
				wipeWorkingContainer: (name) => {
					callOrder.push("wipe");
					capturedContextContainerName = name;
				},
				// Marks the checkpoint save position in the sequence (fired right
				// after saveCheckpoint) — it must land between launch and commit.
				onCheckpointSaved: () => callOrder.push("checkpoint"),
				orchestrator: {
					launch: async (payload) => {
						callOrder.push(`launch:${payload.workingContainerName}`);
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "diff --git a/a b/a" }),
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(capturedProjectPath, TEST_DIR);
		strictEqual(
			capturedContextContainerName,
			"generated-orchestrator-container",
		);
		deepStrictEqual(callOrder, [
			"ensure",
			"create",
			"provision",
			"seed",
			"launch:generated-orchestrator-container",
			"checkpoint",
			"commit",
			"wipe",
		]);
	});

	it("runQueueWithOrchestrator still wipes the working container it created when a task throws mid-queue (INV-3)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		await rejects(async () => {
			await runQueueWithOrchestrator({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					recordDispatch: () => {},
					integrationGate: () => ({ success: true, message: "ok" }),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-orchestrator-container",
					provisionCredentials: () => {},
					seedProject: () => {},
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
					route: () => {
						throw new Error("route exploded mid-orchestrator-queue");
					},
					orchestrator: {
						launch: async () => "job-1",
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: "" }),
					},
				},
			});
		}, /route exploded mid-orchestrator-queue/);

		strictEqual(
			wipeCalled,
			true,
			"the working container must still be wiped even when the orchestrator task loop throws",
		);
	});
});

describe("runner commit/reset behavior (Task 3.2)", () => {
	it("commits only after successful tasks, not after failed ones", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task

### Task 1.3: Third
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** third task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];
		let gateCalls = 0;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => {
					gateCalls += 1;
					if (gateCalls === 2) {
						return { success: false, message: "rejected" };
					}
					return { success: true, message: "ok" };
				},
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 3);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["success", "integration_failed", "success"],
		);
		strictEqual(commits.length, 2, "commit called after tasks 1 and 3 only");
		strictEqual(resets.length, 1, "reset called after failed task 2");
	});

	it("resets rejected state before continuing when stopOnFailure is false", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(commits.length, 0, "commit never called for failed tasks");
		strictEqual(resets.length, 2, "reset called after each failed task");
	});

	it("does not reset when stopOnFailure is true", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: true,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1, "stopped after first failure");
		strictEqual(commits.length, 0);
		strictEqual(
			resets.length,
			0,
			"reset not called when stopOnFailure is true",
		);
	});

	it("does not reset when working container is caller-supplied", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(commits.length, 0);
		strictEqual(
			resets.length,
			0,
			"reset not called when container is caller-supplied",
		);
	});

	it("orchestrator path: commits only after success, resets on failure with continuation", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task

### Task 1.3: Third
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** third task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];
		let launchIndex = 0;
		let gateCalls = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => {
					gateCalls += 1;
					if (gateCalls === 2) {
						return { success: false, message: "rejected" };
					}
					return { success: true, message: "ok" };
				},
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 3);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["success", "integration_failed", "success"],
		);
		strictEqual(
			commits.length,
			2,
			"orchestrator: commit called after tasks 1 and 3 only",
		);
		strictEqual(
			resets.length,
			1,
			"orchestrator: reset called after failed task 2",
		);
	});

	it("orchestrator path: does not reset when stopOnFailure is true", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resets = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: true,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 1, "stopped after first failure");
		strictEqual(
			resets.length,
			0,
			"orchestrator: reset not called when stopOnFailure is true",
		);
	});

	it("orchestrator path: does not reset when working container is caller-supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resets = [];

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				commitWorkingTree: () => {},
				resetWorkingTree: () => resets.push(true),
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(
			resets.length,
			0,
			"orchestrator: reset not called when container is caller-supplied",
		);
	});
	it("orchestrator path: resets when result returns success=false (execution_failed) with continuation", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resets = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: false,
						error: "execution_failed",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["execution_failed", "execution_failed"],
		);
		strictEqual(
			resets.length,
			2,
			"orchestrator: reset called after each execution_failed",
		);
	});

	it("sync path: a completed task is already in the durable checkpoint when commitWorkingTree throws (INV-6)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let checkpointAtCommit = null;

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					// Snapshot the checkpoint the instant commit is attempted.
					checkpointAtCommit = JSON.parse(readFileSync(checkpointPath, "utf8"));
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(checkpointAtCommit, "commitWorkingTree was attempted");
		// The checkpoint save runs ahead of the commit block, so a commit failure
		// can never strand a completed task outside the durable record.
		deepStrictEqual(checkpointAtCommit.completedTaskIds, ["1.1"]);
		strictEqual(checkpointAtCommit.results[0].taskId, "1.1");
		strictEqual(checkpointAtCommit.results[0].result, "success");
		strictEqual(checkpointAtCommit.results[0].success, true);
	});

	it("orchestrator path: a completed task is already in the durable checkpoint when commitWorkingTree throws (INV-6)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let checkpointAtCommit = null;

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					checkpointAtCommit = JSON.parse(readFileSync(checkpointPath, "utf8"));
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		ok(checkpointAtCommit, "commitWorkingTree was attempted");
		deepStrictEqual(checkpointAtCommit.completedTaskIds, ["1.1"]);
		strictEqual(checkpointAtCommit.results[0].taskId, "1.1");
		strictEqual(checkpointAtCommit.results[0].result, "success");
		strictEqual(checkpointAtCommit.results[0].success, true);
	});

	it("sync path: a commitWorkingTree failure halts the queue before the next task, keeping the completed task's durable checkpoint (Task 1.2)", () => {
		// INV-3: a success whose container baseline was not advanced is not
		// reusable — the next task would diff against (and re-emit) task 1's
		// uncommitted work. The run must stop before task 2's execute, even
		// with stopOnFailure:false (only the commit failure can stop it here).
		// Task 1's checkpoint stays on disk (INV-6); the halt is recorded as a
		// distinct outcome, not by failing task 1.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		const executes = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							executes.push(true);
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(
			executes.length,
			1,
			"task 2's execute must never run against an unadvanced container",
		);
		strictEqual(result.processedTasks, 1);
		// The completed task's durable checkpoint stays on disk (INV-6)...
		deepStrictEqual(result.completedTaskIds, ["1.1"]);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1"]);
		strictEqual(checkpoint.results[0].taskId, "1.1");
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].success, true);
		// ...and the halt is a distinct, recorded outcome — not a failure
		// assigned to the successfully completed task.
		strictEqual(result.results.length, 2);
		strictEqual(result.results[0].result, "success");
		strictEqual(result.results[1].result, "halted_after_commit_failure");
		strictEqual(result.results[1].success, false);
		strictEqual(result.results[1].action, "commit");
		ok(
			result.results[1].reason.includes("commit exploded"),
			"halt outcome carries the underlying commit failure detail",
		);
		strictEqual(checkpoint.results[1].result, "halted_after_commit_failure");
		// The durable halt entry carries the action-specific static fields
		// and never embeds the raw commit error message.
		strictEqual(checkpoint.results[1].action, "commit");
		strictEqual(checkpoint.results[1].success, false);
		strictEqual(checkpoint.results[1].timedOut, false);
		strictEqual(checkpoint.results[1].partialDiffPath, null);
		ok(
			!readFileSync(checkpointPath, "utf8").includes("commit exploded"),
			"checkpoint.json must not embed the commit failure's raw message",
		);
		// The failure stays observable on the status channel.
		const commitFailure = events.find(
			(e) =>
				e.event === "checkpoint_failed" &&
				e.status.startsWith("Checkpoint commit failed"),
		);
		ok(commitFailure, "checkpoint_failed event emitted for the commit failure");
		strictEqual(commitFailure.taskId, "1.1");
		ok(
			events.find((e) => e.event === "queue_halted"),
			"queue_halted event emitted when the run stops",
		);
		// The terminal status must not claim "Queue complete" for a halted run.
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(
			terminal.status,
			"Queue halted: 1 tasks processed",
			"a halted run reports a halted terminal status, not Queue complete",
		);
	});

	it("orchestrator path: a commitWorkingTree failure halts the queue before the next launch (Task 1.2)", async () => {
		// Same INV-3 halt through the headless orchestrator path: task 2 must
		// never be launched once task 1's container baseline commit failed.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw new Error("orchestrator commit exploded");
				},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async (payload) => {
						launches.push(payload);
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(
			launches.length,
			1,
			"task 2 must never be launched against an unadvanced container",
		);
		deepStrictEqual(launches[0].taskId, "1.1");
		strictEqual(result.processedTasks, 1);
		deepStrictEqual(result.completedTaskIds, ["1.1"]);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1"]);
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].success, true);
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_commit_failure");
		strictEqual(result.results[1].success, false);
		strictEqual(result.results[1].action, "commit");
		strictEqual(checkpoint.results[1].result, "halted_after_commit_failure");
		// The durable orchestrator halt entry carries the action-specific
		// static fields and never embeds the raw commit error message.
		strictEqual(checkpoint.results[1].action, "commit");
		strictEqual(checkpoint.results[1].success, false);
		strictEqual(checkpoint.results[1].timedOut, false);
		strictEqual(checkpoint.results[1].partialDiffPath, null);
		ok(
			!readFileSync(checkpointPath, "utf8").includes(
				"orchestrator commit exploded",
			),
			"checkpoint.json must not embed the commit failure's raw message",
		);
	});

	it("sync path: a resetWorkingTree failure after a failed task halts the queue before the next task, keeping the failed task's durable checkpoint (Task 1.2)", () => {
		// INV-3 continuation reset: with stopOnFailure:false a failed task's
		// un-reset changes would bleed into the next task, so a reset failure
		// must stop the run before task 2's execute. The failed task's
		// checkpoint entry stays durable (INV-6, success:false and NOT in
		// completedTaskIds); the halt is a distinct halted_after_reset_failure
		// outcome — not a failure retroactively assigned to the failed task.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const executes = [];
		const events = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {
					throw new Error("reset exploded");
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							executes.push(true);
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(
			executes.length,
			1,
			"task 2's execute must never run after a reset failure",
		);
		strictEqual(result.processedTasks, 1);
		// The failed task's bookkeeping stays durable and un-completed.
		deepStrictEqual(result.completedTaskIds, []);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		strictEqual(checkpoint.results[0].taskId, "1.1");
		strictEqual(checkpoint.results[0].result, "integration_failed");
		strictEqual(checkpoint.results[0].success, false);
		// The outcome identifies a reset halt, action-specifically and durably.
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_reset_failure");
		strictEqual(result.results[1].action, "reset");
		strictEqual(result.results[1].success, false);
		ok(
			result.results[1].reason.includes("reset exploded"),
			"halt outcome carries the underlying reset failure detail",
		);
		strictEqual(checkpoint.results[1].result, "halted_after_reset_failure");
		strictEqual(checkpoint.results[1].action, "reset");
		// Raw command stderr must never reach the durable checkpoint.
		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("reset exploded"),
			"checkpoint.json must not embed the reset failure's raw message",
		);
		// The failure stays observable on the status channel and the terminal
		// status is truthful about the halt.
		const resetFailure = events.find(
			(e) =>
				e.event === "checkpoint_failed" &&
				e.status.startsWith("Checkpoint reset failed"),
		);
		ok(resetFailure, "checkpoint_failed event emitted for the reset failure");
		strictEqual(resetFailure.taskId, "1.1");
		ok(
			events.find((e) => e.event === "queue_halted"),
			"queue_halted event emitted when the run stops",
		);
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(terminal.status, "Queue halted: 1 tasks processed");
	});

	it("orchestrator path: a resetWorkingTree failure after a failed task halts the queue before the next launch (Task 1.2)", async () => {
		// Same INV-3 halt through the headless orchestrator path: task 2 must
		// never be launched once task 1's continuation reset failed.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		const events = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {
					throw new Error("orchestrator reset exploded");
				},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async (payload) => {
						launches.push(payload);
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(
			launches.length,
			1,
			"task 2 must never be launched after a reset failure",
		);
		deepStrictEqual(launches[0].taskId, "1.1");
		strictEqual(result.processedTasks, 1);
		deepStrictEqual(result.completedTaskIds, []);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		strictEqual(checkpoint.results[0].result, "integration_failed");
		strictEqual(checkpoint.results[0].success, false);
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_reset_failure");
		strictEqual(result.results[1].action, "reset");
		strictEqual(result.results[1].success, false);
		strictEqual(checkpoint.results[1].result, "halted_after_reset_failure");
		strictEqual(checkpoint.results[1].action, "reset");
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(terminal.status, "Queue halted: 1 tasks processed");
	});

	it("failed and timed-out tasks still land in the checkpoint with success:false under the reordered flow", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Fails
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Times out
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText = "diff --git a/wip.mjs b/wip.mjs\n+work in progress";
		let callCount = 0;

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							callCount += 1;
							if (callCount === 1) {
								return { success: false, error: "provider crashed" };
							}
							return {
								success: false,
								error: "spawnSync docker ETIMEDOUT",
								timedOut: true,
							};
						},
						captureDiff: () => diffText,
					},
				},
			},
		});

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results.length, 2);
		deepStrictEqual(
			checkpoint.results.map((r) => r.success),
			[false, false],
		);
		deepStrictEqual(
			checkpoint.results.map((r) => r.result),
			["execution_failed", "execution_timed_out"],
		);
		strictEqual(checkpoint.results[1].timedOut, true);
		deepStrictEqual(checkpoint.completedTaskIds, []);
	});

	it("orchestrator path: failed and timed-out tasks land in the checkpoint with success:false under the reordered flow", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Fails
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Times out
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				// Deterministic orchestrator timeout: the first status poll
				// reports a running job whose expected_by is already in the
				// past relative to the injected clock, so waitForJobCompletion
				// returns timed_out without sleeping.
				now: () => 2_000_000_000_000,
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async (jobId) =>
						jobId === "job-1"
							? { state: "done" }
							: {
									state: "running",
									expected_by: "2020-01-01T00:00:00Z",
								},
					result: async () => ({
						success: false,
						error: "provider crashed",
					}),
				},
			},
		});

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results.length, 2);
		deepStrictEqual(
			checkpoint.results.map((r) => r.success),
			[false, false],
		);
		deepStrictEqual(
			checkpoint.results.map((r) => r.result),
			["execution_failed", "orchestrator_timed_out"],
		);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		// The orchestrator timeout verdict must reach the durable record, not
		// just the result string: the checkpoint's timedOut flag is truthful
		// for the orchestrator_timed_out outcome (and the in-memory result it
		// was derived from).
		strictEqual(result.results[1].timedOut, true);
		strictEqual(result.results[1].result, "orchestrator_timed_out");
		strictEqual(checkpoint.results[1].timedOut, true);
	});

	it("persists the halt outcome to the checkpoint before queue_halted and terminal events (INV-6)", () => {
		// The halt entry must be on disk the moment the queue_halted observer
		// event fires — not merely after the run's final save — so any
		// observer reading the checkpoint at that point (e.g. an operator
		// reacting to the status channel) already sees the durable halt
		// outcome. Asserted behaviorally: read the checkpoint inside the
		// queue_halted handler.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		let haltOnDiskWhenEventFired = null;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => {
					events.push(e.event);
					if (e.event === "queue_halted") {
						haltOnDiskWhenEventFired = loadCheckpoint(
							checkpointPath,
							tasksPath,
						);
					}
				},
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw new Error("commit exploded");
				},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(haltOnDiskWhenEventFired, "queue_halted event fired");
		strictEqual(
			haltOnDiskWhenEventFired.results.length,
			2,
			"the halt entry must already be on disk when queue_halted fires",
		);
		strictEqual(
			haltOnDiskWhenEventFired.results[1].result,
			"halted_after_commit_failure",
		);
		strictEqual(haltOnDiskWhenEventFired.results[1].action, "commit");
		// The task's own durable entry precedes the halt, and the halt
		// precedes the terminal event.
		const saved = events.indexOf("checkpoint_saved");
		const halted = events.indexOf("queue_halted");
		const terminal = events.indexOf("terminal");
		ok(saved !== -1 && saved < halted, "task entry saved before queue_halted");
		ok(
			halted !== -1 && halted < terminal,
			"queue_halted fires before the terminal event",
		);
		strictEqual(result.results[1].result, "halted_after_commit_failure");
	});

	it("formats a non-Error commit seam failure safely and halts without crashing (regression)", () => {
		// Injected dependency seams may throw any value, not just an Error. A
		// thrown plain object must not crash the halt formatting (no unguarded
		// `error.message` dereference) and must not leak its arbitrary
		// contents into the halt text or the durable checkpoint.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw { marker: "RAW_CANARY_commit_object" };
				},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[1].result, "halted_after_commit_failure");
		strictEqual(result.results[1].action, "commit");
		// A non-Error throw maps to the bounded static label, never to the
		// thrown object's own contents.
		ok(
			result.results[1].reason.includes("unknown error"),
			"halt reason uses the bounded static label for a non-Error throw",
		);
		ok(
			!result.results[1].reason.includes("RAW_CANARY_commit_object"),
			"a non-Error throw's arbitrary value must never reach the halt reason",
		);
		strictEqual(
			result.results[1].error,
			null,
			"a non-Error throw's arbitrary value must never reach the halt error field",
		);
		ok(
			!readFileSync(checkpointPath, "utf8").includes(
				"RAW_CANARY_commit_object",
			),
			"checkpoint.json must never embed a non-Error throw's value",
		);
		ok(
			events.find((e) => e.event === "queue_halted"),
			"queue_halted still emitted after a non-Error commit failure",
		);
		ok(
			events.find((e) => e.event === "terminal"),
			"terminal event still emitted after a non-Error commit failure",
		);
	});

	it("formats a null reset seam failure safely (no unguarded message dereference)", () => {
		// A seam that throws literally `null` is the sharpest non-Error case:
		// any unguarded `error.message` in the reset halt path would throw a
		// TypeError instead of producing the halt outcome.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {
					throw null;
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[1].result, "halted_after_reset_failure");
		strictEqual(result.results[1].action, "reset");
		ok(
			result.results[1].reason.includes("unknown error"),
			"a null throw maps to the bounded static label",
		);
		strictEqual(result.results[1].error, null);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[1].result, "halted_after_reset_failure");
		strictEqual(checkpoint.results[1].action, "reset");
	});
});

describe("runner progress hooks (INV-1: no silent waits)", () => {
	it("fires onTaskStart before and onResult after each task, in order", () => {
		// A serial dispatch blocks with no feedback during each multi-minute
		// provider exec. These hooks are the CLI's feedback path — assert they
		// fire interleaved (start then result, per task) so the surface can
		// print a line as each task begins and finishes.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				onTaskStart: (task) => events.push(`start:${task.id}`),
				onResult: (result) =>
					events.push(`result:${result.taskId}:${result.success}`),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		deepStrictEqual(events, [
			"start:1.1",
			"result:1.1:true",
			"start:1.2",
			"result:1.2:true",
		]);
	});

	it("fires onTaskRouted with provider/model/deadline before the blocking adapter.execute call", () => {
		// Regression: task_started fires before routing decides a provider, so
		// an operator watching progress couldn't learn which provider/model was
		// picked until the (up to 30-minute) adapter call finished. onTaskRouted
		// must fire between routing and the execute call.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
- **Timeout:** 60s
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		const routedBefore = Date.now();

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				onTaskRouted: (info) => events.push({ type: "routed", ...info }),
				adapters: {
					claude: {
						execute: () => {
							events.push({ type: "execute" });
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const routedAfter = Date.now();
		strictEqual(events.length, 2);
		strictEqual(events[0].type, "routed");
		strictEqual(events[0].taskId, "1.1");
		strictEqual(events[0].provider, "claude");
		strictEqual(events[0].model, "claude-sonnet-5");
		// The deadline must encode the task's declared Timeout (60s), not
		// merely "some future time" — a deadline hardcoded to now, or to the
		// wrong unit, fails this range check. runQueue is synchronous, so the
		// routing happens between the two timestamps captured around it and
		// deadline = routing time + 60s must land in [before, after] + 60s.
		const deadlineMs = new Date(events[0].deadline).getTime();
		ok(
			deadlineMs >= routedBefore + 60_000 && deadlineMs <= routedAfter + 60_000,
			`deadline must encode the 60s task Timeout, got ${events[0].deadline}`,
		);
		strictEqual(events[1].type, "execute", "routed must fire before execute");
	});

	it("emits a task_routed onStatus event with provider/model/deadline", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const routed = events.find((e) => e.event === "task_routed");
		ok(routed, "task_routed event fired");
		strictEqual(routed.phase, "execution");
		strictEqual(routed.provider, "claude");
		strictEqual(routed.model, "claude-sonnet-5");
		ok(routed.deadline, "deadline present");

		const routedIndex = events.findIndex((e) => e.event === "task_routed");
		const completedIndex = events.findIndex(
			(e) => e.event === "task_completed",
		);
		ok(
			routedIndex < completedIndex,
			"task_routed must fire before task_completed",
		);
	});

	it("runner emits task_started, diff_captured, gate_validated, gate_applied, task_completed, checkpoint_saved, and cleanup events via onStatus", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) =>
					events.push({
						phase: e.phase,
						event: e.event,
						outcome: e.outcome,
						byteCount: e.byteCount,
						taskId: e.taskId,
					}),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const byEvent = {};
		for (const e of events) {
			byEvent[e.event] = e;
		}

		ok(byEvent.container_created, "container_created fired");
		strictEqual(byEvent.container_created.phase, "bootstrap");
		ok(byEvent.task_started, "task_started fired");
		strictEqual(byEvent.task_started.taskId, "1.1");
		ok(byEvent.diff_captured, "diff_captured fired");
		strictEqual(byEvent.diff_captured.byteCount, 18);
		ok(byEvent.gate_validated, "gate_validated fired");
		strictEqual(byEvent.gate_validated.outcome, "passed");
		ok(byEvent.gate_applied, "gate_applied fired");
		ok(byEvent.task_completed, "task_completed fired");
		strictEqual(byEvent.task_completed.taskId, "1.1");
		ok(byEvent.checkpoint_saved, "checkpoint_saved fired");
		ok(byEvent.terminal, "terminal fired");
		strictEqual(byEvent.terminal.phase, "lifecycle");
		ok(byEvent.cleanup_started, "cleanup_started fired");
		ok(byEvent.cleanup_complete, "cleanup_complete fired");
	});

	it("runner emits task_failed event with error serialization", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							error: "simulated adapter failure",
						}),
						captureDiff: () => "",
					},
				},
			},
		});

		const failed = events.find((e) => e.event === "task_failed");
		ok(failed, "task_failed event emitted");
		strictEqual(failed.taskId, "1.1");
		ok(failed.error, "error field present");
	});

	it("runner emits gate_validated event with rejected outcome on gate failure", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Gate-failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will be rejected
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "gate rejected diff",
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const validated = events.find((e) => e.event === "gate_validated");
		ok(validated, "gate_validated event emitted");
		strictEqual(validated.outcome, "rejected");
		ok(
			!events.find((e) => e.event === "gate_applied"),
			"gate_applied not emitted on rejection",
		);
	});

	it("runner emits checkpoint events (checkpoint_saved) for each task", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const checkpoints = events.filter((e) => e.event === "checkpoint_saved");
		strictEqual(checkpoints.length, 2);
		strictEqual(checkpoints[0].taskId, "1.1");
		strictEqual(checkpoints[1].taskId, "1.2");
	});

	it("runner emits container_created when it creates a working container", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const created = events.find((e) => e.event === "container_created");
		ok(created, "container_created event emitted");
		strictEqual(created.phase, "bootstrap");
	});

	it("does NOT emit container_created when working container is supplied by caller", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied-container",
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "should-not-be-used",
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(
			events.find((e) => e.event === "container_created"),
			undefined,
			"container_created not emitted for caller-supplied container",
		);
	});

	it("onStatus absence: existing behavior unchanged (no new output when hook not provided)", () => {
		// Regression guard: ensure that when neither onStatus nor diagnostics
		// is provided, runQueue behaves exactly as before — no errors, no
		// new side effects.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].success, true);
	});

	it("supports Diagnostics instance via dependencies.diagnostics", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		// Build a minimal diagnostics-like interface inline.
		const diag = {
			emit: (e) => events.push(e),
		};

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				diagnostics: diag,
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(events.length > 0, "diagnostics.emit was called");
		ok(
			events.find((e) => e.event === "task_completed"),
			"task_completed event via diagnostics",
		);
	});

	it("cleanup_failed event is emitted when wipe fails", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		throws(() => {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					onStatus: (e) => events.push(e),
					route: () => ({
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 72,
						reason: "spread",
					}),
					recordDispatch: () => {},
					integrationGate: () => ({ success: true, message: "ok" }),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-diag-container",
					provisionCredentials: () => 1,
					seedProject: () => {},
					commitWorkingTree: () => {},
					wipeWorkingContainer: () => {
						throw new Error("wipe exploded");
					},
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
					},
				},
			});
		}, /wipe exploded/);

		const failed = events.find((e) => e.event === "cleanup_failed");
		ok(failed, "cleanup_failed event emitted");
		strictEqual(failed.phase, "cleanup");
		ok(
			events.find((e) => e.event === "cleanup_started"),
			"cleanup_started was emitted first",
		);
	});

	it("Diagnostics instance supports multiple sinks via dependencies.diagnostics", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const sinkA = [];
		const sinkB = [];
		const d = {
			_sinks: [],
			emit(event) {
				for (const s of this._sinks) s(event);
			},
			sink(fn) {
				this._sinks.push(fn);
			},
			removeSink(fn) {
				this._sinks = this._sinks.filter((s) => s !== fn);
			},
		};
		d.sink((e) => sinkA.push(e));
		d.sink((e) => sinkB.push(e));

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				diagnostics: d,
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(
			sinkA.length === sinkB.length,
			"both sinks received same number of events",
		);
		ok(sinkA.length > 0, "sink A received events");
		deepStrictEqual(
			sinkA.map((e) => e.event),
			sinkB.map((e) => e.event),
		);
	});

	it("fires onResult with success:false when a task fails", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				onTaskStart: (task) => events.push(`start:${task.id}`),
				onResult: (result) =>
					events.push(`result:${result.taskId}:${result.success}`),
				adapters: {
					claude: {
						execute: () => ({ success: false, error: "simulated failure" }),
						captureDiff: () => "",
					},
				},
			},
		});

		deepStrictEqual(events, ["start:1.1", "result:1.1:false"]);
	});
});

describe("Files requiredPaths propagation", () => {
	it("executeTask passes requiredPaths to integrationGate", () => {
		const gateCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: ["src/a.mjs", "tests/a.test.mjs"],
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		deepStrictEqual(gateCalls[0].options.requiredPaths, [
			"src/a.mjs",
			"tests/a.test.mjs",
		]);
	});

	it("executeTask passes null requiredPaths to integrationGate when task has none", () => {
		const gateCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: null,
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.requiredPaths, null);
	});

	it("executeTask calls integrationGate with empty diff when requiredPaths is set (not success_no_diff)", () => {
		const gateCalls = [];
		const dispatches = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: ["src/f.mjs"],
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: false, message: "empty_required_diff" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, false);
		strictEqual(result.result, "integration_failed");
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].diff, "");
		deepStrictEqual(gateCalls[0].options.requiredPaths, ["src/f.mjs"]);
		strictEqual(dispatches[0].result, "integration_failed");
	});

	it("executeTaskWithOrchestrator passes requiredPaths to integrationGate", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Simple operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const gateCalls = [];

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: (_diff, _projectPath, options) => {
					gateCalls.push({ options });
					return { success: true, message: "ok" };
				},
				sleepFn: async () => {},
				orchestrator: {
					launch: async (_payload) => {
						// Inject requiredPaths into the task so the orchestrator
						// path receives them.
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				onTaskStart: (task) => {
					// Simulate parseTaskQueue injecting requiredPaths
					task.requiredPaths = ["src/a.mjs"];
				},
			},
		});

		strictEqual(gateCalls.length, 1);
		deepStrictEqual(gateCalls[0].options.requiredPaths, ["src/a.mjs"]);
	});

	it("executeTaskWithOrchestrator calls gate with empty diff when requiredPaths is set", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Simple operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const gateCalls = [];
		const dispatches = [];

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: (diff, _projectPath, options) => {
					gateCalls.push({ diff, options });
					return { success: false, message: "empty_required_diff" };
				},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
				onTaskStart: (task) => {
					task.requiredPaths = ["src/a.mjs"];
				},
			},
		});

		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].diff, "");
		strictEqual(dispatches[0].result, "integration_failed");
	});
});

describe("runner runStore dependency", () => {
	it("calls runStore.updateRun during task execution with activeTaskId", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				runStore,
			},
		});

		strictEqual(result.processedTasks, 2);

		const taskStartCalls = runStoreCalls.filter(
			(c) => typeof c.activeTaskId === "string",
		);
		strictEqual(taskStartCalls.length, 2);
		strictEqual(taskStartCalls[0].activeTaskId, "1.1");
		strictEqual(taskStartCalls[1].activeTaskId, "1.2");

		const emptyCalls = runStoreCalls.filter(
			(c) => c.activeTaskId === undefined && c.state === undefined,
		);
		strictEqual(emptyCalls.length, 2);

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "succeeded");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
	});

	it("runStore terminal call sets state to failed when tasks fail", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: false, error: "simulated failure" }),
						captureDiff: () => "",
					},
				},
				runStore,
			},
		});

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "failed");
	});

	it("calls onCheckpointSaved after each checkpoint save", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const checkpoints = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				onCheckpointSaved: () => checkpoints.push(true),
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(checkpoints.length, 2);
	});
});

describe("executeTask timeout handling", () => {
	it("captures a partial diff and returns execution_timed_out without calling integrationGate when the adapter reports timedOut", () => {
		const gateCalls = [];
		const captureDiffCalls = [];
		const dispatches = [];

		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "a task that overran its timeout",
				requiredPaths: null,
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "partial output before kill",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						captureDiff: (containerName) => {
							captureDiffCalls.push(containerName);
							return "diff --git a/wip.mjs b/wip.mjs\n+work in progress";
						},
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, false);
		strictEqual(result.result, "execution_timed_out");
		strictEqual(result.timedOut, true);
		strictEqual(
			result.partialDiff,
			"diff --git a/wip.mjs b/wip.mjs\n+work in progress",
		);
		strictEqual(captureDiffCalls.length, 1, "captureDiff called once");
		strictEqual(captureDiffCalls[0], "fake-container");
		strictEqual(
			gateCalls.length,
			0,
			"a timed-out diff must never reach integrationGate — it is not a reviewed success (INV-2)",
		);
		strictEqual(dispatches[0].result, "execution_timed_out");
	});

	it("passes task.timeoutMs through to adapter.execute, falling back to the provider default when absent", () => {
		const executeCalls = [];
		const context = () => ({
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 50,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: (_prompt, _containerName, options) => {
						executeCalls.push(options.timeoutMs);
						return { success: true, output: "ok" };
					},
					captureDiff: () => null,
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});

		executeTask(
			{ id: "1.1", title: "custom", description: "x", timeoutMs: 90_000 },
			context(),
		);
		executeTask({ id: "1.2", title: "default", description: "x" }, context());

		strictEqual(executeCalls[0], 90_000);
		strictEqual(executeCalls[1], PROVIDER_EXECUTION_TIMEOUT_MS);
	});

	it("does not capture a diff for a non-timeout execution failure (existing behavior unchanged)", () => {
		const captureDiffCalls = [];

		const result = executeTask(
			{ id: "1.1", title: "task", description: "a normal failure" },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "provider crashed",
						}),
						captureDiff: (containerName) => {
							captureDiffCalls.push(containerName);
							return "should not be captured";
						},
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.result, "execution_failed");
		strictEqual(result.timedOut, undefined);
		strictEqual(result.partialDiff, undefined);
		strictEqual(captureDiffCalls.length, 0);
	});
});

// Task 1.1: RequiredCapability is the task-contract name at the parser and
// runner boundary. Task 1.2 carries that name through route selection.
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

	it("executeTask routes at RequiredCapability, not classifyTask's guess from the description", () => {
		const routeCalls = [];
		// "format the readme" is an unambiguous low-capability keyword match in
		// classifier.mjs (format/readme) -- classifyTask would call this
		// "low". The declared capability must win instead.
		executeTask(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: "high",
			},
			capabilityCapturingContext(routeCalls),
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
	});

	it("programmatic task objects may omit Executor and still fall back to classifyTask", () => {
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
		strictEqual(routeCalls[0].requiredCapability, "low");
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

	it("executeTaskWithOrchestrator routes at RequiredCapability, not classifyTask's guess", async () => {
		const routeCalls = [];
		const result = await executeTaskWithOrchestrator(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: "high",
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

	it("executeTaskWithOrchestrator falls back to classifyTask when RequiredCapability is absent", async () => {
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
		strictEqual(routeCalls[0].requiredCapability, "low");
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

	it("end to end: RequiredCapability reaches route() as requiredCapability", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Declared-capability task
- **Status:** pending
- **Files:** src/a.mjs
- **RequiredCapability:** high
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

describe("--exclude-provider threading (context.exclude -> route)", () => {
	it("runQueue forwards options.exclude onto context.exclude, reaching route() via executeTask", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			exclude: ["claude"],
			dependencies: {
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 60,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].exclude, ["claude"]);
	});

	it("runQueue defaults context.exclude to [] when options.exclude is omitted", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 60,
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
			},
		});

		deepStrictEqual(routeCalls[0].exclude, []);
	});

	it("executeTask passes context.exclude through to route(), alongside availableProviders", () => {
		const routeCalls = [];

		executeTask(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: (opts) => {
					routeCalls.push(opts);
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
						captureDiff: () => null,
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				exclude: ["claude"],
			},
		);

		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].exclude, ["claude"]);
		deepStrictEqual(routeCalls[0].availableProviders, ["codex"]);
	});

	it("runQueue forwards options.only onto context.only, reaching route() via executeTask (Task C.9)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			only: ["codex"],
			dependencies: {
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 60,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].only, ["codex"]);
	});

	it("runQueue defaults context.only to [] when options.only is omitted (Task C.9)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 60,
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
			},
		});

		deepStrictEqual(routeCalls[0].only, []);
	});

	it("executeTask passes context.only through to route(), alongside exclude and availableProviders (Task C.9)", () => {
		const routeCalls = [];

		executeTask(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: (opts) => {
					routeCalls.push(opts);
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
						captureDiff: () => null,
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				only: ["codex"],
			},
		);

		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].only, ["codex"]);
		deepStrictEqual(routeCalls[0].availableProviders, ["codex"]);
	});

	it("executeTaskWithOrchestrator passes both context.exclude and availableProviders through to route() (Task E.1)", async () => {
		// Task E.1 closed the "intentionally-unfiltered orchestrator route" gap
		// (Task 16): executeTaskWithOrchestrator now mirrors executeTask and
		// passes availableProviders derived from context.adapters, alongside
		// the pre-existing exclude forwarding.
		const routeCalls = [];

		const result = await executeTaskWithOrchestrator(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 50,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
				sleepFn: async () => {},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
				exclude: ["claude"],
			},
		);

		strictEqual(result.success, true);
		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].exclude, ["claude"]);
		deepStrictEqual(routeCalls[0].availableProviders, ["codex"]);
	});
});

describe("runQueue timeout diff persistence", () => {
	it("persists a timed-out task's partial diff to disk and records partialDiffPath + timedOut in checkpoint.json without embedding the raw diff text", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText =
			"diff --git a/wip.mjs b/wip.mjs\n+SECRET_CANARY_wip_marker";

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						captureDiff: () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.timedOut, true);
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"raw diff text must not ride along in the in-memory result once persisted",
		);
		ok(taskResult.partialDiffPath, "result carries the artifact path");
		ok(existsSync(taskResult.partialDiffPath));
		strictEqual(readFileSync(taskResult.partialDiffPath, "utf8"), diffText);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].success, false);
		strictEqual(checkpoint.results[0].timedOut, true);
		strictEqual(
			checkpoint.results[0].partialDiffPath,
			taskResult.partialDiffPath,
		);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_wip_marker"),
			"checkpoint.json must reference the artifact by path only, never embed the diff text",
		);
	});

	it("emits a distinct partial_diff_capture_failed signal when a timed-out task's rescue attempt recovers no diff", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				onStatus: (e) => events.push(e),
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						// The kill+capture rescue ran but found nothing to recover —
						// e.g. no edits were made yet, or capture itself failed.
						captureDiff: () => null,
					},
				},
			},
		});

		const [taskResult] = result.results;
		strictEqual(taskResult.timedOut, true);
		strictEqual(taskResult.partialDiffPath, undefined);

		const failedEvent = events.find(
			(e) => e.event === "partial_diff_capture_failed",
		);
		ok(
			failedEvent,
			"expected a partial_diff_capture_failed status event when captureDiff returns null on timeout",
		);
		strictEqual(failedEvent.taskId, "1.1");
		ok(
			!events.some((e) => e.event === "partial_diff_captured"),
			"a failed rescue must not also fire the success event",
		);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].timedOut, true);
		strictEqual(checkpoint.results[0].partialDiffPath, null);
	});
});

describe("runQueue non-timeout rejection diff persistence (Task D.4)", () => {
	it("persists a non-timeout, non-credential integrationGate rejection's diff to disk, same as the timeout path", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Rejected task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** produces a diff the gate rejects for a non-credential reason
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText =
			"diff --git a/wip.mjs b/wip.mjs\n+SECRET_CANARY_rejected_marker";

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "Diff apply failed",
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "", error: null }),
						captureDiff: () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(taskResult.result, "integration_failed");
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"raw diff text must not ride along in the in-memory result once persisted",
		);
		ok(taskResult.partialDiffPath, "result carries the artifact path");
		ok(existsSync(taskResult.partialDiffPath));
		strictEqual(readFileSync(taskResult.partialDiffPath, "utf8"), diffText);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(
			checkpoint.results[0].partialDiffPath,
			taskResult.partialDiffPath,
		);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_rejected_marker"),
			"checkpoint.json must reference the artifact by path only, never embed the diff text",
		);
	});

	it("NEVER persists a credential-flagged rejection's diff to disk (security property)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Credential-flagged task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** produces a diff the gate rejects for touching a credential-convention path
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText =
			"diff --git a/.env b/.env\n+SECRET_CANARY_must_never_touch_disk";

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "diff touches a credential-convention path: .env",
					credentialFlagged: true,
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "", error: null }),
						captureDiff: () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"credential-flagged diff must never even ride along in the in-memory result",
		);
		strictEqual(
			taskResult.partialDiffPath,
			undefined,
			"credential-flagged rejection must never produce an artifact path",
		);

		const artifactsDir = `${checkpointPath}.partial-diffs`;
		ok(
			!existsSync(artifactsDir) || readdirSync(artifactsDir).length === 0,
			"no artifact file may exist under .partial-diffs for a credential-flagged rejection",
		);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].partialDiffPath, null);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_must_never_touch_disk"),
			"checkpoint.json must never embed a credential-flagged diff's text",
		);
	});
});
