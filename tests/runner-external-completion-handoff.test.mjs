import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createCliOrchestrator,
	reconcileExternalCompletion,
	resolveOrchestrator,
	waitForJobCompletion,
} from "../src/switchyard/runner/index.mjs";
import {
	executeTask,
	executeTaskWithOrchestrator,
	runnerTestDir,
	runQueueWithOrchestrator,
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
describe("external completion handoff", () => {
	it("fails closed before reading or mutating any checkpoint for malformed input", async () => {
		const result = await reconcileExternalCompletion({});
		strictEqual(result.status, "refused");
		strictEqual(result.reasonCode, "malformed_receipt");
	});
});
describe("runner no-provider outcome uses a safe route reason code (Task D.3)", () => {
	it("maps an untrusted route reason to a closed code in result and ledger", () => {
		// The result and ledger retain only the closed route reason code; raw
		// upstream diagnostics never cross either boundary.
		const dispatches = [];
		const result = executeTask(
			{ id: "1.1", title: "task", description: "simple cleanup" },
			{
				route: () => ({
					provider: null,
					reason:
						"no_eligible_upstream_unavailable: claude — sk-proj-opaquevalue at service.prod.company.com",
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
		strictEqual(result.reason, "no_eligible_upstream_unavailable");
		// Ledger record uses the same safe code.
		strictEqual(dispatches[0].result, "no_provider");
		strictEqual(dispatches[0].reason, "no_eligible_upstream_unavailable");
	});

	it("maps an untrusted route reason before orchestrator outcome projection", async () => {
		const dispatches = [];
		let launches = 0;
		const result = await executeTaskWithOrchestrator(
			{ id: "1.1", title: "task", description: "simple cleanup" },
			{
				route: () => ({
					provider: null,
					reason:
						"../../private/sk-proj-opaquevalue at service.prod.company.com",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true }),
				adapters: {},
				orchestrator: {
					launch: async () => {
						launches += 1;
						return "should-not-launch";
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.reason, "no_eligible");
		strictEqual(dispatches[0].reason, "no_eligible");
		strictEqual(launches, 0);
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
