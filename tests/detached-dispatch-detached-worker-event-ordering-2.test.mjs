import { ok, strictEqual } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
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
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	__dirname,
	BOOTSTRAP_PATH,
	commandAvailable,
	PARALLELS_AQUA_UID,
	PARALLELS_GOLDEN_IMAGE,
	ROSTER_FIXTURE_PATH,
	SWITCHYARD_SKIP_LIVE_VM_TESTS,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let parallelsConfigurationFault = null;
function parallelsGoldenImagePrerequisiteReason() {
	if (!commandAvailable("prlctl")) return "Parallels prlctl is unavailable";
	// Parallels is installed but the operator has not said which VM to clone.
	// That is a configuration fault, not an absent dependency, so it FAILS the gate
	// instead of skipping it. The previous `|| "macOS"` fallback pointed at the
	// unhardened Task 1.1 base VM, which is present and stopped on this host: with
	// the variable unset the gate would have cloned and asserted against a VM that
	// was never hardened. Production already refuses to guess (README.md: "no
	// default -- guessing at which VM to clone is not a safe default").
	if (!PARALLELS_GOLDEN_IMAGE) {
		parallelsConfigurationFault =
			"SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set to run the VM gate";
		return null;
	}
	let output;
	try {
		output = execFileSync("prlctl", ["list", "-a", "-o", "uuid,status,name"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	const golden = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split(/\s+/))
		.find(
			(fields) =>
				fields.length >= 3 &&
				fields.slice(2).join(" ") === PARALLELS_GOLDEN_IMAGE,
		);
	if (!golden) return `golden image ${PARALLELS_GOLDEN_IMAGE} is unavailable`;
	if (!/^stopped$/i.test(golden[1])) {
		return `golden image ${PARALLELS_GOLDEN_IMAGE} is not stopped`;
	}
	// An unset or malformed Aqua uid is a configuration fault, not an absent
	// dependency, so it FAILS the gate instead of skipping it. Returning a skip
	// reason here made the gate report green having proven nothing: it passes
	// locally only because ~/.zshrc exports the variable, so any non-interactive
	// shell, CI runner, or launchd context silently lost the INV-1 assertions.
	if (!PARALLELS_AQUA_UID) {
		parallelsConfigurationFault =
			"SWITCHYARD_PARALLELS_AQUA_UID must be set to run the VM gate";
		return null;
	}
	if (!/^\d+$/.test(PARALLELS_AQUA_UID) || Number(PARALLELS_AQUA_UID) <= 0) {
		parallelsConfigurationFault = `SWITCHYARD_PARALLELS_AQUA_UID must be a positive integer uid, got ${JSON.stringify(PARALLELS_AQUA_UID.slice(0, 32))}`;
		return null;
	}
	try {
		if (new ParallelsExecutionBackend().listManaged().length > 0) {
			return "a Switchyard working VM is active";
		}
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	return null;
}
const PARALLELS_PREREQUISITE_REASON = SWITCHYARD_SKIP_LIVE_VM_TESTS
	? "fixture-only: SWITCHYARD_SKIP_LIVE_VM_TESTS=1"
	: parallelsGoldenImagePrerequisiteReason();
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
