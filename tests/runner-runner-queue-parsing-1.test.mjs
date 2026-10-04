import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import {
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import {
	getRunnableTasks,
	runQueue as runQueueImpl,
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
	it("unwraps one matching inline-code pair per Files entry", () => {
		const markdown = `## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** \`src/a.mjs\`, tests/a.test.mjs, \`HISTORY.md\`
- **Description:** Do things with files
`;
		const tasks = parseFixture(markdown);
		deepStrictEqual(tasks[0].requiredPaths, [
			"src/a.mjs",
			"tests/a.test.mjs",
			"HISTORY.md",
		]);
	});
	it("rejects malformed inline-code wrappers in Files entries", () => {
		for (const filesValue of [
			"`src/a.mjs",
			"src/a.mjs`",
			"``src/a.mjs``",
			"`src/`a.mjs`",
		]) {
			const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** ${filesValue}
- **Description:** Bad
`;
			throws(
				() => parseFixture(markdown),
				/(?:unmatched|malformed) inline-code/,
			);
		}
	});
	it("applies existing path validation after inline-code unwrapping", () => {
		for (const [filesValue, message] of [
			["`/etc/passwd`", /absolute path/],
			["`../outside/evil.mjs`", /path traversal/],
			["`src/*.mjs`", /wildcards/],
			["`src/`", /directory-only/],
			["src//empty.mjs", /empty path component/],
		]) {
			const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** ${filesValue}
- **Description:** Bad
`;
			throws(() => parseFixture(markdown), message);
		}
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
	it("matches the shared task-file path corpus", () => {
		const corpus = JSON.parse(
			readFileSync(
				join(cwd(), "tests/fixtures/task-file-path-corpus.json"),
				"utf8",
			),
		);
		for (const fixture of corpus) {
			const markdown = `### Task 1.1: Corpus\n- **Status:** pending\n- **Files:** ${fixture.path}\n`;
			if (fixture.valid) {
				strictEqual(parseFixture(markdown)[0].requiredPaths[0], fixture.path);
			} else {
				throws(() => parseFixture(markdown), new RegExp(fixture.reason));
			}
		}
	});
	it("validates Files entries against the project before backend preflight", () => {
		const root = join(TEST_DIR, "files-contract");
		mkdirSync(join(root, "existing-dir"), { recursive: true });
		mkdirSync(join(root, "outside"), { recursive: true });
		writeFileSync(join(root, "existing.mjs"), "export {}\n");
		symlinkSync("existing.mjs", join(root, "link.mjs"));
		symlinkSync("outside", join(root, "linked-dir"));
		const cases = [
			["existing-dir", /regular file, not a directory or symlink/],
			["link.mjs", /regular file, not a directory or symlink/],
			["linked-dir/future.mjs", /symlink directory/],
			["future.mjs", null],
			["..cache/new-file.mjs", null],
		];
		for (const [path, expected] of cases) {
			const tasksPath = join(root, `${path.replaceAll("/", "-")}.md`);
			writeFileSync(
				tasksPath,
				`### Task 1.1: File task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** ${path}\n- **Description:** fixture\n`,
			);
			let preflightCalls = 0;
			const invoke = () =>
				runQueueImpl({
					tasksFilePath: tasksPath,
					projectPath: root,
					platform: "macos",
					checkpointPath: `${tasksPath}.checkpoint.json`,
					dependencies: {
						queuePreflight: () => {
							preflightCalls += 1;
						},
						backendFactory: () => ({
							platform: "macos",
							preflight: () => {
								preflightCalls += 1;
							},
						}),
					},
				});
			if (expected) throws(invoke, expected);
			else throws(invoke);
			strictEqual(preflightCalls, expected ? 0 : 1);
		}
	});
});
