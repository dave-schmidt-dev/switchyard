import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseTaskQueue } from "../src/switchyard/runner/index.mjs";
import {
	parseFixture,
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
describe("runner queue parsing", () => {
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
- **Description:** Task prose does not select the capability lane
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
	it("requires a non-empty justification for explicit low/high capabilities", () => {
		for (const capability of ["high", "low"]) {
			const markdown = `### Task 1.1: Missing justification
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **RequiredCapability:** ${capability}
- **Description:** Work
`;
			throws(
				() => parseFixture(markdown),
				/RequiredCapabilityJustification is required for explicit/,
			);
		}
	});
	it("rejects an empty RequiredCapabilityJustification field", () => {
		const markdown = `### Task 1.1: Empty justification
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **RequiredCapability:** low
- **RequiredCapabilityJustification:**
- **Description:** Work
`;
		throws(
			() => parseFixture(markdown),
			/RequiredCapabilityJustification field is empty/,
		);
	});
	it("rejects duplicate RequiredCapabilityJustification declarations", () => {
		const markdown = `### Task 1.1: Duplicate justification
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** First reason
- **RequiredCapabilityJustification:** Second reason
- **Description:** Work
`;
		throws(
			() => parseFixture(markdown),
			/duplicate RequiredCapabilityJustification declarations/,
		);
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
	it("parses AllowManifests: true and returns allowManifests: true", () => {
		const markdown = `## Phase 1

### Task 1.1: Opt in to manifests
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** true
- **Description:** Update dependencies
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].allowManifests, true);
	});
	it("parses AllowManifests: false and returns allowManifests: false without manifest authority", () => {
		const markdown = `## Phase 1

### Task 1.1: Explicitly disable manifests
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** false
- **Description:** Update dependencies
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].allowManifests, false);
	});
	it("defaults allowManifests to false when AllowManifests is omitted", () => {
		const markdown = `## Phase 1

### Task 1.1: Omitted AllowManifests
- **Status:** pending
- **Files:** src/index.mjs
- **Description:** Update code
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].allowManifests, false);
	});
	it("rejects non-boolean AllowManifests values, failing closed before routing", () => {
		const invalidValues = [
			"True",
			"False",
			"TRUE",
			"FALSE",
			"yes",
			"no",
			"1",
			"0",
			"maybe",
			"",
		];
		for (const val of invalidValues) {
			const markdown = `## Phase 1

### Task 1.1: Bad AllowManifests
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** ${val}
- **Description:** Update dependencies
`;
			throws(
				() => parseFixture(markdown),
				/AllowManifests must be true or false when present/,
			);
		}
	});
	it("rejects duplicate AllowManifests declarations", () => {
		const markdown = `## Phase 1

### Task 1.1: Duplicate AllowManifests
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** true
- **AllowManifests:** false
- **Description:** Update dependencies
`;
		throws(
			() => parseFixture(markdown),
			/duplicate AllowManifests declarations are not allowed/,
		);
	});
	it("rejects AllowManifests on review tasks", () => {
		for (const boolVal of ["true", "false"]) {
			const markdown = `## Phase 1

### Task 1.1: Review task with AllowManifests
- **Status:** pending
- **Type:** review
- **AllowManifests:** ${boolVal}
- **Description:** Review dependencies
`;
			throws(
				() => parseFixture(markdown),
				/AllowManifests is only supported for implementation-type tasks/,
			);
		}
	});
});
