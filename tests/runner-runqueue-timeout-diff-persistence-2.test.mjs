import { ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runnerTestDir,
	runQueue,
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
describe("runQueue timeout diff persistence", () => {
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
	it("keeps an explicitly empty timed-out capture distinct from capture failure", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout without edits
`);
		const events = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					reason: "spread",
				}),
				resolveDescriptor: () =>
					descriptorForRoute({
						provider: "claude",
						model: "claude-sonnet-5",
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
				onStatus: (event) => events.push(event),
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							timedOut: true,
							error: "timed out",
						}),
						captureDiffDetailed: () => ({ status: "empty", diff: null }),
					},
				},
			},
		});
		strictEqual(result.results[0].result, "execution_timed_out");
		strictEqual(result.results[0].captureStatus, "empty");
		ok(events.some((event) => event.event === "diff_capture_started"));
		ok(
			!events.some((event) => event.event === "partial_diff_capture_failed"),
			"an explicit empty capture is not a capture failure",
		);
	});
	it("preserves a synchronous capture failure status in the partial-diff failure event", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout while diff capture fails
`);
		const events = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					reason: "spread",
				}),
				resolveDescriptor: () =>
					descriptorForRoute({
						provider: "claude",
						model: "claude-sonnet-5",
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
				onStatus: (event) => events.push(event),
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							timedOut: true,
							error: "timed out",
						}),
						captureDiffDetailed: () => ({
							status: "diff_failed",
							diff: null,
						}),
					},
				},
			},
		});

		strictEqual(result.results[0].captureStatus, "diff_failed");
		const failedEvent = events.find(
			(event) => event.event === "partial_diff_capture_failed",
		);
		ok(failedEvent, "a non-empty capture status must emit a failure event");
		strictEqual(failedEvent.captureStatus, "diff_failed");
	});
});
