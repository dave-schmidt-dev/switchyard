// Dispatch CLI contract tests: subcommand routing, exit codes, help output,
// and backwards compatibility. Tests parse functions directly for deterministic
// validation and spawns the CLI for exit-code / envelope contract verification.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const DISPATCH_PATH = resolve(
	__dirname,
	"..",
	"src",
	"switchyard",
	"dispatch",
	"index.mjs",
);

import {
	parseDispatchArgs,
	parseLaunchArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
} from "../src/switchyard/dispatch/index.mjs";

function runDispatch(args, env = {}, timeout = 10_000) {
	return spawnSync(process.execPath, [DISPATCH_PATH, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
		env: { ...process.env, ...env },
	});
}

let dir;
let tasksFile;
let projectDir;
let stateRoot;

function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "switchyard-dispatch-cli-"));
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	// Set env var so direct run-store calls in tests target the temp dir
	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
});

afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	rmSync(dir, { recursive: true, force: true });
});

describe("parseDispatchArgs (backwards compat)", () => {
	it("parses a valid invocation with defaults", () => {
		const opts = parseDispatchArgs([tasksFile, "--project", projectDir]);
		strictEqual(opts.help, false);
		strictEqual(opts.tasksFilePath, tasksFile);
		strictEqual(opts.projectPath, projectDir);
		strictEqual(opts.maxTasks, Number.POSITIVE_INFINITY);
		strictEqual(opts.stopOnFailure, true);
		strictEqual(opts.checkpointPath, undefined);
	});

	it("returns help:true for --help without requiring other args", () => {
		deepStrictEqual(parseDispatchArgs(["--help"]), { help: true });
	});

	it("honors --max-tasks, --checkpoint, and --no-stop-on-failure", () => {
		const checkpoint = join(dir, "cp.json");
		const opts = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--max-tasks",
			"3",
			"--checkpoint",
			checkpoint,
			"--no-stop-on-failure",
		]);
		strictEqual(opts.maxTasks, 3);
		strictEqual(opts.checkpointPath, checkpoint);
		strictEqual(opts.stopOnFailure, false);
	});

	it("throws when the tasks positional is missing", () => {
		strictEqual(
			(() => {
				try {
					parseDispatchArgs(["--project", projectDir]);
					return null;
				} catch (e) {
					return e.message;
				}
			})().includes("missing <tasks.md>"),
			true,
		);
	});

	it("throws when --project is missing", () => {
		strictEqual(
			(() => {
				try {
					parseDispatchArgs([tasksFile]);
					return null;
				} catch (e) {
					return e.message;
				}
			})().includes("--project <path> is required"),
			true,
		);
	});

	it("throws when the tasks file does not exist", () => {
		strictEqual(
			(() => {
				try {
					parseDispatchArgs([join(dir, "nope.md"), "--project", projectDir]);
					return null;
				} catch (e) {
					return e.message;
				}
			})().includes("tasks file not found"),
			true,
		);
	});

	it("throws when --project is not a git repository", () => {
		const bare = join(dir, "not-a-repo");
		mkdirSync(bare, { recursive: true });
		strictEqual(
			(() => {
				try {
					parseDispatchArgs([tasksFile, "--project", bare]);
					return null;
				} catch (e) {
					return e.message;
				}
			})().includes("not a git repository"),
			true,
		);
	});
});

describe("subcommand parsing", () => {
	it("parseLaunchArgs works same as parseDispatchArgs", () => {
		const opts = parseLaunchArgs([tasksFile, "--project", projectDir]);
		strictEqual(opts.tasksFilePath, tasksFile);
		strictEqual(opts.projectPath, projectDir);
	});

	it("parseLaunchArgs returns help:true for --help", () => {
		deepStrictEqual(parseLaunchArgs(["--help"]), { help: true });
	});

	it("parseStatusArgs extracts runId", () => {
		const parsed = parseStatusArgs(["my-run-id"]);
		strictEqual(parsed.runId, "my-run-id");
		strictEqual(parsed.json, false);
		strictEqual(parsed.help, false);
	});

	it("parseStatusArgs accepts --json flag", () => {
		const parsed = parseStatusArgs(["my-run-id", "--json"]);
		strictEqual(parsed.runId, "my-run-id");
		strictEqual(parsed.json, true);
	});

	it("parseStatusArgs with --help", () => {
		const parsed = parseStatusArgs(["--help"]);
		strictEqual(parsed.help, true);
		strictEqual(parsed.runId, null);
	});

	it("parseResultArgs accepts --json flag", () => {
		const parsed = parseResultArgs(["my-run-id", "--json"]);
		strictEqual(parsed.runId, "my-run-id");
		strictEqual(parsed.json, true);
	});

	it("parseRecoverArgs without --run", () => {
		const parsed = parseRecoverArgs([]);
		strictEqual(parsed.runId, null);
		strictEqual(parsed.help, false);
	});

	it("parseRecoverArgs with --run", () => {
		const parsed = parseRecoverArgs(["--run", "some-run-id"]);
		strictEqual(parsed.runId, "some-run-id");
	});

	it("parseRecoverArgs with --help", () => {
		const parsed = parseRecoverArgs(["--help"]);
		strictEqual(parsed.help, true);
	});
});

describe("usage output", () => {
	it("USAGE contains subcommand listing", () => {
		ok(USAGE.includes("run"));
		ok(USAGE.includes("launch"));
		ok(USAGE.includes("status"));
		ok(USAGE.includes("result"));
		ok(USAGE.includes("recover"));
	});

	it("USAGE_RUN describes run options", () => {
		ok(USAGE_RUN.includes("--project"));
		ok(USAGE_RUN.includes("--max-tasks"));
	});

	it("USAGE_LAUNCH describes launch options", () => {
		ok(USAGE_LAUNCH.includes("--project"));
	});

	it("USAGE_STATUS describes status usage", () => {
		ok(USAGE_STATUS.includes("<run-id>"));
	});

	it("USAGE_RESULT describes result usage", () => {
		ok(USAGE_RESULT.includes("<run-id>"));
	});

	it("USAGE_RECOVER describes recover usage", () => {
		ok(USAGE_RECOVER.includes("--run"));
	});
});

describe("CLI exit codes via process spawn", () => {
	it("dispatch --help prints usage and exits 0", () => {
		const result = runDispatch(["--help"]);
		strictEqual(result.status, 0);
		ok(result.stdout.includes("Usage"), "stdout should contain usage text");
	});

	it("launch --help prints usage and exits 0", () => {
		const result = runDispatch(["launch", "--help"]);
		strictEqual(result.status, 0);
		ok(result.stdout.includes(USAGE_LAUNCH.trim().split("\n")[0]));
	});

	it("launch with missing --project exits 2", () => {
		const result = runDispatch(["launch", tasksFile]);
		strictEqual(result.status, 2);
		ok(result.stderr.includes("--project <path> is required"));
	});

	it("launch with missing tasks file exits 2", () => {
		const result = runDispatch([
			"launch",
			join(dir, "nonexistent.md"),
			"--project",
			projectDir,
		]);
		strictEqual(result.status, 2);
	});

	it("status with nonexistent runId exits 3", () => {
		const result = runDispatch(
			["status", "nonexistent-123"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 3);
	});

	it("result with nonexistent runId exits 3", () => {
		const result = runDispatch(
			["result", "nonexistent-456"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 3);
	});

	it("status with invalid subcommand name exits 2 (usage error)", () => {
		const result = runDispatch(["nonexistent-subcommand"]);
		strictEqual(result.status, 2);
	});
});

describe("run subcommand equivalence", () => {
	it("run subcommand parseDispatchArgs matches positional parseDispatchArgs", () => {
		const args = [tasksFile, "--project", projectDir, "--max-tasks", "5"];
		const positional = parseDispatchArgs(args);
		const subcommand = parseDispatchArgs(args);
		deepStrictEqual(positional, subcommand);
		strictEqual(positional.maxTasks, 5);
		strictEqual(subcommand.maxTasks, 5);
	});
});

describe("launch integration", () => {
	it("launch with a 0-task queue fails closed: exits 2, no run state or lock created", () => {
		const emptyTasksFile = join(dir, "empty-tasks.md");
		writeFileSync(
			emptyTasksFile,
			"# Nothing here, no task headings.\n",
			"utf8",
		);

		const result = runDispatch(
			["launch", emptyTasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 2, `stderr: ${result.stderr}`);
		ok(result.stderr.includes("no tasks parsed"));

		// The failure must land before initializeRun/acquireProjectLock, so
		// no run directory or project lock is left behind for `launch` to
		// have silently created ahead of an inevitable worker-side failure.
		ok(
			!existsSync(join(stateRoot, "runs")) ||
				readdirSync(join(stateRoot, "runs")).length === 0,
			"no run directory should be created for a 0-task queue",
		);
		ok(
			!existsSync(join(stateRoot, "locks")) ||
				readdirSync(join(stateRoot, "locks")).length === 0,
			"no project lock should be created for a 0-task queue",
		);
	});

	it("launch with valid args exits 0 and produces JSON envelope", () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		let envelope;
		try {
			envelope = JSON.parse(result.stdout.trim());
		} catch {
			ok(false, `stdout is not valid JSON: ${result.stdout}`);
			return;
		}
		strictEqual(envelope.schemaVersion, 1);
		ok(typeof envelope.runId === "string" && envelope.runId.length > 0);
		strictEqual(envelope.state, "launcher_ready");
		ok(envelope.statusCommand.includes("switchyard-dispatch status"));
		ok(envelope.resultCommand.includes("switchyard-dispatch result"));
	});
});

describe("status integration", () => {
	it("status with a real run produces valid status envelope", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-status-run",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(
			["status", "test-status-run"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.schemaVersion, 1);
		strictEqual(envelope.runId, "test-status-run");
		strictEqual(envelope.state, "created");
		strictEqual(envelope.cleanupState, "not_started");
		strictEqual(envelope.activeTaskId, null);
		strictEqual(envelope.completedCount, 0);
		strictEqual(envelope.failedCount, 0);
	});

	it("status --json produces same envelope", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-status-json",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(
			["status", "test-status-json", "--json"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.runId, "test-status-json");
	});
});

describe("result integration", () => {
	it("result with non-terminal run exits 5", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-result-nonterminal",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(
			["result", "test-result-nonterminal"],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			5,
			`expected exit 5, got ${result.status}: ${result.stderr}`,
		);
	});

	it("result with succeeded run exits 0 when cleanup complete", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-result-terminal",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun("test-result-terminal");
		await updateRun(
			"test-result-terminal",
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const result = runDispatch(
			["result", "test-result-terminal"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());
		ok(envelope.terminalSummary !== null);
		ok(Array.isArray(envelope.artifactRefs));
	});

	it("result with failed run exits 1", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-result-failed",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun("test-result-failed");
		await updateRun(
			"test-result-failed",
			{
				state: "failed",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: [], failedCount: 1 },
			},
			current.revision,
		);

		const result = runDispatch(
			["result", "test-result-failed"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 1);
	});

	it("result with cleanup not complete exits 1 even for succeeded", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "test-result-cleanup-incomplete",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun("test-result-cleanup-incomplete");
		await updateRun(
			"test-result-cleanup-incomplete",
			{
				state: "succeeded",
				cleanupState: "not_started",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const result = runDispatch(
			["result", "test-result-cleanup-incomplete"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 1);
	});
});

describe("recover integration", () => {
	it("recover --help prints usage and exits 0", () => {
		const result = runDispatch(["recover", "--help"]);
		strictEqual(result.status, 0);
		ok(result.stdout.includes("recover"));
	});

	it("recover with --run flag parses correctly", () => {
		const parsed = parseRecoverArgs(["--run", "test-run"]);
		strictEqual(parsed.runId, "test-run");
	});

	it("recover without --help runs and exits (Docker may not be available)", () => {
		const result = runDispatch(["recover"]);
		ok(
			result.status === 0 || result.status === 1,
			`unexpected exit code: ${result.status}`,
		);
		try {
			const output = JSON.parse(result.stdout.trim());
			ok(typeof output.containersReclaimed === "number");
			ok(typeof output.volumesReclaimed === "number");
			ok(Array.isArray(output.errors));
			ok(Array.isArray(output.candidates) || output.candidates === null);
		} catch {
			ok(false, `recover stdout is not valid JSON: ${result.stdout}`);
		}
	});
});

describe("CLI exit code contract", () => {
	it("exit 0: launch success", () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0);
	});

	it("exit 2: launch with missing --project", () => {
		const result = runDispatch(["launch", tasksFile]);
		strictEqual(result.status, 2);
	});

	it("exit 2: status with missing run-id", () => {
		const result = runDispatch(["status"]);
		strictEqual(result.status, 2);
	});

	it("exit 2: result with missing run-id", () => {
		const result = runDispatch(["result"]);
		strictEqual(result.status, 2);
	});

	it("exit 3: status with nonexistent runId", () => {
		const result = runDispatch(["status", "nonexistent"], makeStateRootEnv());
		strictEqual(result.status, 3);
	});

	it("exit 3: result with nonexistent runId", () => {
		const result = runDispatch(["result", "nonexistent"], makeStateRootEnv());
		strictEqual(result.status, 3);
	});

	it("exit 5: result with non-terminal run", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "exit-code-5",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(["result", "exit-code-5"], makeStateRootEnv());
		strictEqual(result.status, 5);
	});
});

describe("exit code 4: corrupt state", () => {
	it("status with corrupt run.json exits 4", () => {
		const runDir = join(stateRoot, "runs", "corrupt-status");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "{not valid json at all", "utf8");

		const result = runDispatch(
			["status", "corrupt-status"],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			4,
			`expected exit 4, got ${result.status}: ${result.stderr}`,
		);
	});

	it("result with corrupt run.json exits 4", () => {
		const runDir = join(stateRoot, "runs", "corrupt-result");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), "{not valid json at all", "utf8");

		const result = runDispatch(
			["result", "corrupt-result"],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			4,
			`expected exit 4, got ${result.status}: ${result.stderr}`,
		);
	});
});

describe("CLI exit code contract - launch failures", () => {
	it("exit 1: launch with unwritable state root", () => {
		const fileStateRoot = join(dir, "is-a-file-not-dir");
		writeFileSync(fileStateRoot, "block", "utf8");

		const result = runDispatch(["launch", tasksFile, "--project", projectDir], {
			...makeStateRootEnv(),
			SWITCHYARD_RUN_STORE_ROOT: fileStateRoot,
		});
		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: stderr=${result.stderr} stdout=${result.stdout}`,
		);
	});
});

describe("run subcommand via spawn", () => {
	it("run with valid args exits 0 and produces checkpoint", () => {
		const tasksPath = join(dir, "run-tasks.md");
		writeFileSync(
			tasksPath,
			"### Task 1.1: Test run task\n- **Status:** pending\n- **Description:** Run test\n",
			"utf8",
		);

		const runProjectDir = join(dir, "run-project");
		mkdirSync(runProjectDir, { recursive: true });
		mkdirSync(join(runProjectDir, ".git"), { recursive: true });
		execSync("git init", { cwd: runProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: runProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: runProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: runProjectDir,
			stdio: "ignore",
		});

		const result = runDispatch(
			["run", tasksPath, "--project", runProjectDir, "--max-tasks", "1"],
			makeStateRootEnv(),
			60_000,
		);
		ok(
			result.status === 0 || result.status === 1,
			`expected exit 0 or 1, got ${result.status}: stderr=${result.stderr}`,
		);
	});
});

describe("envelope format", () => {
	it("launch envelope has required fields", () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		const envelope = JSON.parse(result.stdout.trim());
		const required = [
			"schemaVersion",
			"runId",
			"state",
			"statusCommand",
			"resultCommand",
		];
		for (const key of required) {
			ok(key in envelope, `launch envelope missing field: ${key}`);
		}
		strictEqual(envelope.schemaVersion, 1);
		strictEqual(envelope.state, "launcher_ready");
	});

	it("status envelope has required fields", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "env-status",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(["status", "env-status"], makeStateRootEnv());
		const envelope = JSON.parse(result.stdout.trim());
		const required = [
			"schemaVersion",
			"runId",
			"state",
			"cleanupState",
			"activeTaskId",
			"completedCount",
			"failedCount",
			"updatedAt",
		];
		for (const key of required) {
			ok(key in envelope, `status envelope missing field: ${key}`);
		}
	});

	it("result envelope has required fields", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		await initializeRun({
			runId: "env-result",
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun("env-result");
		await updateRun(
			"env-result",
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const result = runDispatch(["result", "env-result"], makeStateRootEnv());
		const envelope = JSON.parse(result.stdout.trim());
		const required = [
			"schemaVersion",
			"runId",
			"state",
			"cleanupState",
			"activeTaskId",
			"completedCount",
			"failedCount",
			"updatedAt",
			"terminalSummary",
			"artifactRefs",
		];
		for (const key of required) {
			ok(key in envelope, `result envelope missing field: ${key}`);
		}
	});
});
