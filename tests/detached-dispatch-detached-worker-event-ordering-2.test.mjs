import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	__dirname,
	BOOTSTRAP_PATH,
	ROSTER_FIXTURE_PATH,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
let detachedCleanupPending;
let detachedCleanupRunId;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-detached-dispatch-");
	detachedCleanupPending = false;
	detachedCleanupRunId = null;
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	if (detachedCleanupPending) {
		console.error(
			`detached cleanup was not confirmed for run ${detachedCleanupRunId ?? "unknown"}; preserving fixture ${dir}`,
		);
		return;
	}
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("detached worker event ordering", () => {
	it("retains a bounded boot diagnostic for failed zero-task workers only", async () => {
		const { getRunRoot, initializeRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const fakeRunnerPath = join(dir, "zero-task-runner.mjs");
		writeFileSync(
			fakeRunnerPath,
			`export async function runQueueAsync() {
  if (process.env.SWITCHYARD_ZERO_TASK_MODE === "fail") {
    throw new Error("SECRET_CANARY_ZERO_TASK /private/tmp/prompt-canary");
  }
  return {
    success: true,
    totalTasks: 0,
    runnableTasks: 0,
    processedTasks: 0,
    completedTaskIds: [],
    deferredTaskIds: [],
    results: [],
  };
}
`,
			"utf8",
		);
		const loaderPath = join(dir, "zero-task-runner-loader.mjs");
		writeFileSync(
			loaderPath,
			`const target = process.env.SWITCHYARD_TEST_RUNNER_URL;
const replacement = process.env.SWITCHYARD_TEST_FAKE_RUNNER_URL;
export async function resolve(specifier, context, nextResolve) {
  const candidate = new URL(specifier, context.parentURL).href;
  if (candidate === target) return { url: replacement, shortCircuit: true };
  return nextResolve(specifier, context, nextResolve);
}
`,
			"utf8",
		);
		const runnerUrl = pathToFileURL(
			resolve(__dirname, "../src/switchyard/runner/index.mjs"),
		).href;
		for (const mode of ["fail", "success"]) {
			const runId = randomUUID();
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: [],
				initialHostFingerprint: "git:no-head:unknown",
				workerNonce: `zero-task-${mode}`,
				launchArgs: [],
			});
			const bootLogPath = resolve(getRunRoot(runId), "boot-stderr.log");
			if (mode === "success") writeFileSync(bootLogPath, "", { mode: 0o600 });
			const worker = spawn(
				process.execPath,
				[
					"--experimental-loader",
					pathToFileURL(loaderPath).href,
					BOOTSTRAP_PATH,
					"--state-root",
					stateRoot,
					"--run-id",
					runId,
					"--nonce",
					`zero-task-${mode}`,
				],
				{
					stdio: ["ignore", "ignore", "ignore"],
					env: {
						...process.env,
						...makeStateRootEnv(),
						SWITCHYARD_ZERO_TASK_MODE: mode,
						SWITCHYARD_TEST_RUNNER_URL: runnerUrl,
						SWITCHYARD_TEST_FAKE_RUNNER_URL: pathToFileURL(fakeRunnerPath).href,
					},
				},
			);
			const exit = await new Promise((resolveExit, rejectExit) => {
				const timer = setTimeout(
					() => rejectExit(new Error(`zero-task ${mode} worker timed out`)),
					5_000,
				);
				worker.once("error", rejectExit);
				worker.once("exit", (code, signal) => {
					clearTimeout(timer);
					resolveExit({ code, signal });
				});
			});
			strictEqual(exit.code, mode === "fail" ? 1 : 0, mode);
			strictEqual(
				(await readRun(runId)).state,
				mode === "fail" ? "failed" : "succeeded",
			);
			if (mode === "fail") {
				ok(existsSync(bootLogPath));
				const bootBytes = readFileSync(bootLogPath);
				strictEqual(bootBytes.toString("utf8"), "worker_boot_exception\n");
				ok(bootBytes.length > 0 && bootBytes.length <= 4096);
				ok(!bootBytes.includes("SECRET_CANARY"));
			} else {
				strictEqual(existsSync(bootLogPath), false);
			}
		}
	});
});
