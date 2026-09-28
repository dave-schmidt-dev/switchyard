import { ok, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
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
describe("runner commit/reset behavior (Task 3.2)", () => {
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
