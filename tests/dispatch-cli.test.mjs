// Dispatch CLI contract tests: subcommand routing, exit codes, help output,
// and backwards compatibility. Tests parse functions directly for deterministic
// validation and spawns the CLI for exit-code / envelope contract verification.

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	AGENT_IMAGE,
	imageExists,
	isContainerRuntimeAvailable,
} from "../src/switchyard/container/index.mjs";
import {
	createLabeledContainer,
	removeContainer,
} from "./helpers/lifecycle-fixture.mjs";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const DISPATCH_PATH = resolve(
	__dirname,
	"..",
	"src",
	"switchyard",
	"dispatch",
	"index.mjs",
);
// Task 1.5 (roster-unification plan): src/switchyard/roster/index.mjs now
// lazily loads the roster, resolving SWITCHYARD_ROSTER_PATH or the canonical
// ~/.agent/roster.json default (Task 4.1) and failing loud only if that
// resolved file can't load. This file's `launch` subcommand spawns a
// detached worker that eventually reaches the real, unmocked router/roster
// on the way to routing a task — point at this committed synthetic fixture
// (not the real ~/.agent/roster.json) so a background routing failure can't
// leak into this suite as stray errors or a stuck run.
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);

import {
	runDispatch as dispatchRun,
	markLauncherReadyIfLaunching,
	parseDispatchArgs,
	parseLaunchArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
	probeProviderProcess,
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
} from "../src/switchyard/dispatch/index.mjs";

const HAS_DOCKER = isContainerRuntimeAvailable();

if (!HAS_DOCKER) {
	console.log(
		"Docker not available — skipping providerProcessDetected live-Docker tests",
	);
}

function describeIf(condition, ...args) {
	if (condition) return describe(...args);
	return describe.skip(...args);
}

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
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});

afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
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

	it("defaults excludeProviders to an empty array when --exclude-provider is absent", () => {
		const opts = parseDispatchArgs([tasksFile, "--project", projectDir]);
		deepStrictEqual(opts.excludeProviders, []);
	});

	it("collects repeated --exclude-provider flags into excludeProviders", () => {
		const opts = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--exclude-provider",
			"claude",
			"--exclude-provider",
			"cursor",
		]);
		deepStrictEqual(opts.excludeProviders, ["claude", "cursor"]);
	});

	it("defaults onlyProviders to an empty array when --only-provider is absent", () => {
		const opts = parseDispatchArgs([tasksFile, "--project", projectDir]);
		deepStrictEqual(opts.onlyProviders, []);
	});

	it("collects repeated --only-provider flags into onlyProviders", () => {
		const opts = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--only-provider",
			"claude",
			"--only-provider",
			"agy",
		]);
		deepStrictEqual(opts.onlyProviders, ["claude", "agy"]);
	});

	it("collects --provider as an alias for --only-provider into the same onlyProviders list", () => {
		// onlyProviders concatenates --only-provider values then --provider
		// values, regardless of the order the flags appear on the command
		// line (parseArgs groups by option name, not positional order).
		const opts = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--provider",
			"claude",
			"--only-provider",
			"agy",
		]);
		deepStrictEqual(opts.onlyProviders, ["agy", "claude"]);
	});

	it("throws a UsageError when --only-provider and --exclude-provider are combined", () => {
		strictEqual(
			(() => {
				try {
					parseDispatchArgs([
						tasksFile,
						"--project",
						projectDir,
						"--only-provider",
						"claude",
						"--exclude-provider",
						"cursor",
					]);
					return null;
				} catch (e) {
					return e.message;
				}
			})().includes("mutually exclusive"),
			true,
		);
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

	it("USAGE_RUN and USAGE_LAUNCH describe --exclude-provider", () => {
		ok(USAGE_RUN.includes("--exclude-provider"));
		ok(USAGE_LAUNCH.includes("--exclude-provider"));
	});

	it("USAGE_RUN and USAGE_LAUNCH describe --only-provider", () => {
		ok(USAGE_RUN.includes("--only-provider"));
		ok(USAGE_LAUNCH.includes("--only-provider"));
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
	it("does not regress a worker-owned running state to launcher_ready", async () => {
		const runId = `launch-state-${randomUUID()}`;
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
		});

		const created = await readRun(runId);
		await updateRun(runId, { state: "running" }, created.revision);

		const result = await markLauncherReadyIfLaunching(runId);
		strictEqual(result.state, "running");
		strictEqual((await readRun(runId)).state, "running");
	});

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

	it("launch with no --exclude-provider persists excludeProviders: [] on the run record", async () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());

		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		deepStrictEqual(run.excludeProviders, []);
	});

	it("launch persists repeated --exclude-provider flags onto the run record as excludeProviders", async () => {
		const result = runDispatch(
			[
				"launch",
				tasksFile,
				"--project",
				projectDir,
				"--exclude-provider",
				"claude",
				"--exclude-provider",
				"cursor",
			],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());

		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		deepStrictEqual(run.excludeProviders, ["claude", "cursor"]);
	});

	it("launch with no --only-provider persists onlyProviders: [] on the run record", async () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());

		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		deepStrictEqual(run.onlyProviders, []);
	});

	it("launch persists repeated --only-provider flags onto the run record as onlyProviders", async () => {
		const result = runDispatch(
			[
				"launch",
				tasksFile,
				"--project",
				projectDir,
				"--only-provider",
				"claude",
				"--only-provider",
				"agy",
			],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());

		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		deepStrictEqual(run.onlyProviders, ["claude", "agy"]);
	});

	it("launch with no --no-stop-on-failure persists stopOnFailure: true on the run record", async () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());

		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		strictEqual(run.stopOnFailure, true);
	});

	it("launch --no-stop-on-failure persists stopOnFailure: false on the run record", async () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir, "--no-stop-on-failure"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());

		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		strictEqual(run.stopOnFailure, false);
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
	it("run with valid args exits 0 and produces checkpoint", async () => {
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

		// The sync path's terminal write must persist cleanupState:"complete"
		// (Task D.5) so applyRetention can later reclaim the run. Unlike
		// `launch`, the `run` subcommand prints no envelope, so locate the
		// single persisted run record in the fresh state root instead.
		const runDirs = readdirSync(join(stateRoot, "runs"));
		strictEqual(
			runDirs.length,
			1,
			`expected exactly one run record, got ${runDirs.length}`,
		);
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runDirs[0]);
		strictEqual(run.cleanupState, "complete");
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
			"queueStartedAt",
			"elapsedMs",
			"totalTaskCount",
			"pendingCount",
			"runningCount",
			"lastCompletionAt",
			"elapsedSinceLastCompletionMs",
			"activeTaskAgeMs",
			"activeTaskRemainingMs",
			"platformInfo",
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
			"queueStartedAt",
			"elapsedMs",
			"totalTaskCount",
			"pendingCount",
			"runningCount",
			"lastCompletionAt",
			"elapsedSinceLastCompletionMs",
			"activeTaskAgeMs",
			"activeTaskRemainingMs",
			"platformInfo",
		];
		for (const key of required) {
			ok(key in envelope, `result envelope missing field: ${key}`);
		}
	});

	it("status and result envelopes' platformInfo has the getPlatformInfo shape", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "env-platform-info";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());

		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0, `stderr: ${resultResult.stderr}`);
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());

		// platformInfo is a static host/image diagnostic (see
		// container/index.mjs's getPlatformInfo), unconditional on run.state —
		// unlike providerProcessDetected, it must be populated on both a
		// non-terminal status read and a terminal result read.
		for (const envelope of [statusEnvelope, resultEnvelope]) {
			ok(
				envelope.platformInfo && typeof envelope.platformInfo === "object",
				"platformInfo must be an object",
			);
			ok("mismatch" in envelope.platformInfo, "platformInfo missing mismatch");
			ok("hostArch" in envelope.platformInfo, "platformInfo missing hostArch");
			ok(
				"imageArch" in envelope.platformInfo,
				"platformInfo missing imageArch",
			);
			ok("note" in envelope.platformInfo, "platformInfo missing note");
			strictEqual(typeof envelope.platformInfo.mismatch, "boolean");
			strictEqual(typeof envelope.platformInfo.hostArch, "string");
			ok(
				envelope.platformInfo.imageArch === null ||
					typeof envelope.platformInfo.imageArch === "string",
				"platformInfo.imageArch must be a string or null",
			);
			ok(
				envelope.platformInfo.note === null ||
					typeof envelope.platformInfo.note === "string",
				"platformInfo.note must be a string or null",
			);
		}
	});
});

describe("deriveTelemetryFields parity between status and result envelopes", () => {
	it("status and result envelopes agree on the shared telemetry fields for the same run", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "telemetry-parity-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const activeTaskStartedAt = Date.now() - 5_000;
		const lastCompletionAt = Date.now() - 1_000;
		const activeTaskDeadline = new Date(Date.now() + 1_800_000).toISOString();

		const current = await readRun(runId);
		// Fields set directly (rather than via a real run) purely to exercise
		// the telemetry math with every input populated at once — the two
		// envelope builders must derive identical shared-field values from
		// the same underlying run record regardless of run state.
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				activeTaskId: "1.2",
				activeTaskProvider: "claude",
				activeTaskModel: "claude-sonnet-5",
				activeTaskStartedAt,
				activeTaskDeadline,
				lastCompletionAt,
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());

		// Deterministic fields (no dependency on wall-clock "now" at build
		// time) must match exactly between the two envelopes.
		strictEqual(statusEnvelope.queueStartedAt, resultEnvelope.queueStartedAt);
		strictEqual(statusEnvelope.totalTaskCount, resultEnvelope.totalTaskCount);
		strictEqual(statusEnvelope.totalTaskCount, 3);
		strictEqual(statusEnvelope.pendingCount, resultEnvelope.pendingCount);
		// No checkpoint file exists for this run's tasksFile, so pendingCount
		// falls back to the full orderedTaskIds count — it must NOT be
		// derived from terminalSummary.completedTaskIds (a different,
		// run-record-level notion of "done" that deriveTelemetryFields does
		// not consult).
		strictEqual(statusEnvelope.pendingCount, 3);
		strictEqual(statusEnvelope.runningCount, resultEnvelope.runningCount);
		strictEqual(statusEnvelope.runningCount, 1);
		strictEqual(
			statusEnvelope.lastCompletionAt,
			resultEnvelope.lastCompletionAt,
		);
		strictEqual(statusEnvelope.lastCompletionAt, lastCompletionAt);

		// now()-derived fields: assert both envelopes computed them (not
		// null/NaN) and agree within a generous tolerance for the wall-clock
		// drift between the two spawned CLI calls.
		for (const key of [
			"elapsedMs",
			"elapsedSinceLastCompletionMs",
			"activeTaskAgeMs",
			"activeTaskRemainingMs",
		]) {
			ok(
				typeof statusEnvelope[key] === "number" &&
					!Number.isNaN(statusEnvelope[key]),
				`status envelope ${key} should be a number, got ${statusEnvelope[key]}`,
			);
			ok(
				typeof resultEnvelope[key] === "number" &&
					!Number.isNaN(resultEnvelope[key]),
				`result envelope ${key} should be a number, got ${resultEnvelope[key]}`,
			);
			ok(
				Math.abs(statusEnvelope[key] - resultEnvelope[key]) < 5_000,
				`status/result ${key} drifted too far: ${statusEnvelope[key]} vs ${resultEnvelope[key]}`,
			);
		}
	});

	it("activeTaskAgeMs and activeTaskRemainingMs are null when the underlying fields are unset", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "telemetry-null-fields-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());

		strictEqual(envelope.activeTaskAgeMs, null);
		strictEqual(envelope.activeTaskRemainingMs, null);
		strictEqual(envelope.lastCompletionAt, null);
		strictEqual(envelope.runningCount, 0);
		strictEqual(envelope.totalTaskCount, 1);
		ok(typeof envelope.elapsedMs === "number" && envelope.elapsedMs >= 0);
		// lastCompletionAt is unset, so elapsedSinceLastCompletionMs must fall
		// back to the same queueStartedAt-derived value as elapsedMs — both
		// fields are computed from the same `now` inside deriveTelemetryFields.
		strictEqual(envelope.elapsedSinceLastCompletionMs, envelope.elapsedMs);
	});

	it("activeTaskAgeMs is null once activeTaskId clears, even though activeTaskStartedAt remains set on the underlying run record (regression: activeTaskAgeMs never cleared)", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "telemetry-completed-task-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const current = await readRun(runId);
		// Mirrors onResult's real patch shape (worker-bootstrap.mjs): on task
		// completion activeTaskId/Provider/Model/Deadline are nulled, but
		// activeTaskStartedAt is left as-is — it is never cleared anywhere.
		// Before the fix, activeTaskAgeMs gated on activeTaskStartedAt alone
		// and so kept reporting a stale, ever-growing age here.
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				activeTaskId: null,
				activeTaskProvider: null,
				activeTaskModel: null,
				activeTaskDeadline: null,
				activeTaskStartedAt: Date.now() - 60_000,
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());
		strictEqual(statusEnvelope.activeTaskAgeMs, null);
		strictEqual(statusEnvelope.runningCount, 0);

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0, `stderr: ${resultResult.stderr}`);
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());
		strictEqual(resultEnvelope.activeTaskAgeMs, null);
		strictEqual(resultEnvelope.runningCount, 0);
	});
});

describe("elapsedSinceLastCompletionMs telemetry field (B.4)", () => {
	it("falls back to queueStartedAt-derived elapsed time when lastCompletionAt is unset (zero-completions incident state)", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "elapsed-since-completion-fallback-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const result = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());

		strictEqual(envelope.lastCompletionAt, null);
		ok(
			typeof envelope.elapsedSinceLastCompletionMs === "number" &&
				!Number.isNaN(envelope.elapsedSinceLastCompletionMs),
			`expected a number, got ${envelope.elapsedSinceLastCompletionMs}`,
		);
		strictEqual(envelope.elapsedSinceLastCompletionMs, envelope.elapsedMs);
	});

	it("uses lastCompletionAt once at least one task has completed", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "elapsed-since-completion-lastcompletion-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const lastCompletionAt = Date.now() - 60_000;
		const current = await readRun(runId);
		await updateRun(runId, { lastCompletionAt }, current.revision);

		const result = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());

		strictEqual(envelope.lastCompletionAt, lastCompletionAt);
		// Should track ~60s since lastCompletionAt, not the (much smaller)
		// queueStartedAt-derived elapsedMs for a run created moments ago in
		// this same test.
		ok(
			Math.abs(envelope.elapsedSinceLastCompletionMs - 60_000) < 5_000,
			`expected ~60000ms since lastCompletionAt, got ${envelope.elapsedSinceLastCompletionMs}`,
		);
		ok(
			envelope.elapsedSinceLastCompletionMs > envelope.elapsedMs,
			`expected elapsedSinceLastCompletionMs (${envelope.elapsedSinceLastCompletionMs}) to exceed elapsedMs (${envelope.elapsedMs}) once lastCompletionAt predates queueStartedAt-derived elapsed`,
		);
	});
});

describe("pendingCount telemetry field (checkpoint-derived, CR-3 regression)", () => {
	it("pendingCount equals totalTaskCount on a fresh run with no checkpoint file", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = "pending-fresh-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());
		strictEqual(statusEnvelope.totalTaskCount, 3);
		strictEqual(statusEnvelope.pendingCount, 3);

		// result requires a terminal run state — advance it before checking
		// the same field agrees on the result envelope.
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: [] },
			},
			current.revision,
		);

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0, `stderr: ${resultResult.stderr}`);
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());
		strictEqual(resultEnvelope.pendingCount, 3);
	});

	it("pendingCount excludes tasks a pre-existing checkpoint already marks done, even with zero matching events in this run's own log (resumed-run regression case)", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { CHECKPOINT_VERSION, getCheckpointPath, saveCheckpoint } =
			await import("../src/switchyard/runner/index.mjs");

		const runId = "pending-resumed-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		// Simulate a checkpoint left behind by a prior process on a resumed
		// run: task "1.1" is already marked done there, but this run's own
		// events.jsonl has recorded zero events for it (no run-store events
		// were ever written for this runId). This is the exact CR-3
		// regression shape: a flat `orderedTaskIds.length - events.length`
		// subtraction would see 0 events and report pendingCount as 3,
		// silently counting an already-completed task as still pending. The
		// checkpoint-derived computation must instead see completedTaskIds
		// and report 2.
		saveCheckpoint(getCheckpointPath(tasksFile), {
			version: CHECKPOINT_VERSION,
			tasksFilePath: tasksFile,
			completedTaskIds: ["1.1"],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [],
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());
		strictEqual(statusEnvelope.totalTaskCount, 3);
		strictEqual(
			statusEnvelope.pendingCount,
			2,
			"pendingCount must exclude the checkpoint-completed task even though this run's own events.jsonl has no matching event",
		);

		// result requires a terminal run state — advance it before checking
		// the same field agrees on the result envelope.
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 0, `stderr: ${resultResult.stderr}`);
		const resultEnvelope = JSON.parse(resultResult.stdout.trim());
		strictEqual(resultEnvelope.pendingCount, 2);
	});

	it("status degrades pendingCount rather than crashing when the checkpoint file exists but is corrupt", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { getCheckpointPath } = await import(
			"../src/switchyard/runner/index.mjs"
		);

		const runId = "pending-corrupt-checkpoint-run";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});

		// status/result are read-only diagnostic commands (like
		// readEventsSafe's best-effort event read above) — a checkpoint that
		// exists but fails to parse must not crash an otherwise-healthy
		// status read, even though runQueue's own write path deliberately
		// fails loudly on the same condition.
		writeFileSync(
			getCheckpointPath(tasksFile),
			"{not valid json at all",
			"utf8",
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());
		strictEqual(statusEnvelope.totalTaskCount, 3);
		strictEqual(statusEnvelope.pendingCount, 3);
	});
});

describe("probeProviderProcess (providerProcessDetected)", () => {
	it("never shells out when run.state is not 'running'", () => {
		for (const state of [
			"created",
			"launching",
			"launcher_ready",
			"succeeded",
			"failed",
			"recovery_required",
		]) {
			let execCalled = false;
			const spyExecFn = () => {
				execCalled = true;
				return "";
			};
			const result = probeProviderProcess(
				{
					state,
					workingContainerName: "some-container",
					activeTaskProvider: "claude",
				},
				{ execFn: spyExecFn },
			);
			strictEqual(result, null, `expected null for state ${state}`);
			strictEqual(
				execCalled,
				false,
				`execFn must never be invoked for state ${state}`,
			);
		}
	});

	it("returns null without shelling out when workingContainerName or activeTaskProvider is unset, even while running", () => {
		let execCalled = false;
		const spyExecFn = () => {
			execCalled = true;
			return "";
		};
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: null,
					activeTaskProvider: "claude",
				},
				{ execFn: spyExecFn },
			),
			null,
		);
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: "some-container",
					activeTaskProvider: null,
				},
				{ execFn: spyExecFn },
			),
			null,
		);
		strictEqual(execCalled, false);
	});

	it("returns null without shelling out for a provider with no known binary mapping", () => {
		let execCalled = false;
		const spyExecFn = () => {
			execCalled = true;
			return "";
		};
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "totally-unknown-provider",
			},
			{ execFn: spyExecFn },
		);
		strictEqual(result, null);
		strictEqual(execCalled, false);
	});

	it("returns null (never throws) when execFn itself throws, e.g. Docker unavailable", () => {
		const throwingExecFn = () => {
			throw new Error("simulated docker failure");
		};
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ execFn: throwingExecFn },
		);
		strictEqual(result, null);
	});

	it("returns true when a docker top line's args column matches the mapped binary basename, even via a fully-qualified path", () => {
		const fakeExecFn = () =>
			"  PID ARGS\n  123 /usr/local/bin/claude --headless\n  456 sleep infinity\n";
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ execFn: fakeExecFn },
		);
		strictEqual(result, true);
	});

	it("returns false (a real boolean, not null) when docker top succeeds but no line matches", () => {
		const fakeExecFn = () => "  PID ARGS\n  456 sleep infinity\n";
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ execFn: fakeExecFn },
		);
		strictEqual(result, false);
	});

	it("uses the cursor-agent binary name (not cursor) for the cursor provider", () => {
		const noMatchExecFn = () => "  PID ARGS\n  123 cursor --headless\n";
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: "some-container",
					activeTaskProvider: "cursor",
				},
				{ execFn: noMatchExecFn },
			),
			false,
			"binary name 'cursor' alone must not match — the actual binary is cursor-agent",
		);

		const matchExecFn = () => "  PID ARGS\n  123 cursor-agent --headless\n";
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: "some-container",
					activeTaskProvider: "cursor",
				},
				{ execFn: matchExecFn },
			),
			true,
		);
	});

	it("calls execFn with docker top, an explicit args array, and a 5000ms timeout", () => {
		let capturedCommand;
		let capturedArgs;
		let capturedOptions;
		const spyExecFn = (command, args, options) => {
			capturedCommand = command;
			capturedArgs = args;
			capturedOptions = options;
			return "";
		};
		probeProviderProcess(
			{
				state: "running",
				workingContainerName: "my-container",
				activeTaskProvider: "claude",
			},
			{ execFn: spyExecFn },
		);
		strictEqual(capturedCommand, "docker");
		deepStrictEqual(capturedArgs, ["top", "my-container", "-eo", "pid,args"]);
		strictEqual(capturedOptions.timeout, 5000);
	});
});

describeIf(
	HAS_DOCKER,
	"probeProviderProcess against real Docker containers",
	() => {
		it("returns null (never throws) against a container name that was never created", () => {
			const containerName = `switchyard-test-gone-${randomUUID().slice(0, 8)}`;
			const result = probeProviderProcess({
				state: "running",
				workingContainerName: containerName,
				activeTaskProvider: "claude",
			});
			strictEqual(result, null);
		});

		it("returns null (never throws) against a container removed mid-restart", () => {
			const containerName = createLabeledContainer({
				name: `switchyard-test-removed-${randomUUID().slice(0, 8)}`,
				cmd: ["sleep", "infinity"],
			});
			removeContainer(containerName);
			const result = probeProviderProcess({
				state: "running",
				workingContainerName: containerName,
				activeTaskProvider: "claude",
			});
			strictEqual(result, null);
		});

		it("returns false for a live container running a non-matching process", () => {
			const containerName = createLabeledContainer({
				name: `switchyard-test-noproc-${randomUUID().slice(0, 8)}`,
				cmd: ["sleep", "infinity"],
			});
			try {
				const result = probeProviderProcess({
					state: "running",
					workingContainerName: containerName,
					activeTaskProvider: "claude",
				});
				strictEqual(result, false);
			} finally {
				removeContainer(containerName);
			}
		});
	},
);

// Alpine's /bin/sleep (used by the generic describeIf(HAS_DOCKER, ...) block
// above) is a BusyBox multi-call binary that dispatches on argv[0]'s
// basename — a symlink named "claude" exits immediately with "applet not
// found" rather than running, so a live end-to-end match assertion needs a
// real standalone (non-multi-call) executable to symlink instead. This
// project's own agent image (built by docker/Dockerfile) has one: its
// /bin/sleep is genuine GNU coreutils and ignores argv[0]. Mirrors
// project-seed.test.mjs's imageExists(AGENT_IMAGE) skip pattern so this
// still passes on a host that has Docker but hasn't built the agent image.
const AGENT_IMAGE_SKIP = imageExists(AGENT_IMAGE)
	? false
	: `${AGENT_IMAGE} not built — skipping live providerProcessDetected match test`;

describe("probeProviderProcess matches a real provider-named process (live agent image)", {
	skip: AGENT_IMAGE_SKIP,
}, () => {
	it("returns true for a live container running a matching provider process", async () => {
		// Symlinking the image's real sleep binary to a path named
		// "claude" and exec-ing through that path makes the resulting
		// process's argv[0] (and therefore docker top's args column)
		// read "claude", exercising the real match path end-to-end
		// without needing to invoke the actual provider CLI.
		const containerName = createLabeledContainer({
			name: `switchyard-test-matchproc-${randomUUID().slice(0, 8)}`,
			image: AGENT_IMAGE,
			cmd: [
				"sh",
				"-c",
				"ln -s /bin/sleep /tmp/claude && exec /tmp/claude infinity",
			],
		});
		try {
			let result = null;
			// The container execs through the symlink immediately after
			// start; poll briefly in case docker top is queried before
			// that exec has landed.
			for (let attempt = 0; attempt < 20; attempt++) {
				result = probeProviderProcess({
					state: "running",
					workingContainerName: containerName,
					activeTaskProvider: "claude",
				});
				if (result === true) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			strictEqual(result, true);
		} finally {
			removeContainer(containerName);
		}
	});
});

// Task 1.3 (INV-6): the synchronous `run` path must hold the exclusive
// project lock for the duration of queue execution and release it on every
// terminal path. runQueue is stubbed via runDispatch's injectable
// dependencies so the lock lifecycle is proven without Docker/containers;
// the contention failure is additionally proven end-to-end through a real
// CLI spawn (mirroring detached-dispatch.test.mjs's launch counterpart).
// The run record is initialized BEFORE the lock is acquired (matching
// handleLaunch), so the lock is never held without a recoverable run record
// behind it.
describe("runDispatch project lock lifecycle (INV-6)", () => {
	function stubResult(success) {
		return {
			totalTasks: 1,
			runnableTasks: 1,
			processedTasks: 1,
			completedTaskIds: success ? ["1.1"] : [],
			lastTaskId: "1.1",
			checkpointPath: join(dir, "stub.checkpoint.json"),
			results: [
				{
					taskId: "1.1",
					success,
					provider: "stub",
					model: null,
					result: success ? "ok" : "boom",
					reason: success ? undefined : "stubbed failure",
				},
			],
		};
	}

	async function dispatchWithStub(runQueueFn) {
		const opts = parseDispatchArgs([tasksFile, "--project", projectDir]);
		const savedExitCode = process.exitCode;
		try {
			await dispatchRun(opts, { runQueue: runQueueFn });
			return process.exitCode;
		} finally {
			process.exitCode = savedExitCode;
		}
	}

	async function onlyRunRecord() {
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const runDirs = readdirSync(join(stateRoot, "runs"));
		strictEqual(
			runDirs.length,
			1,
			`expected exactly one run record, got ${runDirs.length}`,
		);
		return readRun(runDirs[0]);
	}

	it("releases the project lock after a successful synchronous run", async () => {
		const { isProjectLockHeld } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const exitCode = await dispatchWithStub(() => stubResult(true));
		strictEqual(exitCode, 0);

		ok(
			!isProjectLockHeld(projectDir),
			"project lock must be released after a successful run",
		);
		const run = await onlyRunRecord();
		strictEqual(run.state, "succeeded");
		strictEqual(run.cleanupState, "complete");
	});

	it("holds the synchronous project lock inside the injected runQueue callback (direct behavioral assertion)", async () => {
		const { isProjectLockHeld } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// Behavioral seam, not source inspection: the lock must actually be
		// held for the duration of queue execution — i.e. visible to the
		// injected runQueue callback itself — and released on the terminal
		// path afterward (INV-6).
		let lockHeldInsideCallback = null;
		const exitCode = await dispatchWithStub(() => {
			lockHeldInsideCallback = isProjectLockHeld(projectDir);
			return stubResult(true);
		});
		strictEqual(exitCode, 0);
		strictEqual(
			lockHeldInsideCallback,
			true,
			"the exclusive project lock must be held inside the runQueue callback",
		);
		ok(
			!isProjectLockHeld(projectDir),
			"project lock must be released after the run",
		);
	});

	it("releases the project lock after a normal failed-task result", async () => {
		const { isProjectLockHeld } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const exitCode = await dispatchWithStub(() => stubResult(false));
		strictEqual(exitCode, 1);

		ok(
			!isProjectLockHeld(projectDir),
			"project lock must be released after a failed-task result",
		);
		const run = await onlyRunRecord();
		strictEqual(run.state, "failed");
		strictEqual(run.cleanupState, "complete");
	});

	it("releases the project lock after a thrown runQueue error", async () => {
		const { isProjectLockHeld } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const savedExitCode = process.exitCode;
		try {
			await rejects(
				dispatchRun(parseDispatchArgs([tasksFile, "--project", projectDir]), {
					runQueue: () => {
						throw new Error("stubbed queue crash");
					},
				}),
				/stubbed queue crash/,
			);
		} finally {
			process.exitCode = savedExitCode;
		}

		ok(
			!isProjectLockHeld(projectDir),
			"project lock must be released after a thrown runQueue error",
		);
		const run = await onlyRunRecord();
		strictEqual(run.state, "failed");
		strictEqual(run.cleanupState, "complete");
	});

	it("releases the project lock even when the run-store init failed (runStoreReady false)", async () => {
		const { isProjectLockHeld } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// Block the run-store from initializing: with a plain file sitting at
		// stateRoot/runs, initializeRun's ensureDir for the run directory
		// fails, so runStoreReady stays false and no run record is created.
		// The queue stub still runs, and its throw must propagate with no
		// project lock left behind regardless of the failed init (INV-6).
		// The lock is only ever attempted once the run record exists, so a
		// degraded run store means no lock at all (the unlabeled legacy
		// path) — never a lock without a record to back it.
		mkdirSync(stateRoot, { recursive: true });
		writeFileSync(join(stateRoot, "runs"), "blocker", "utf8");

		const savedExitCode = process.exitCode;
		try {
			await rejects(
				dispatchRun(parseDispatchArgs([tasksFile, "--project", projectDir]), {
					runQueue: () => {
						throw new Error("queue ran despite init failure");
					},
				}),
				/queue ran despite init failure/,
			);
		} finally {
			process.exitCode = savedExitCode;
		}

		ok(
			!isProjectLockHeld(projectDir),
			"project lock must be released even when the run-store init failed",
		);
		const runsPath = join(stateRoot, "runs");
		ok(
			!existsSync(runsPath) ||
				!statSync(runsPath).isDirectory() ||
				readdirSync(runsPath).length === 0,
			"no run record should exist when the run-store init failed",
		);
	});

	it("a concurrent second run fails fast with the lock-contention error before any queue work (end-to-end)", async () => {
		const { acquireProjectLock, releaseProjectLockIfOwnedBy } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// Hold the project lock directly to simulate an in-flight run. This
		// is deterministic: it does not race a run's terminal cleanup.
		const holderRunId = randomUUID();
		await acquireProjectLock(projectDir, holderRunId);

		const result = runDispatch(
			["run", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			1,
			`run against a locked project should exit 1, got ${result.status}: stderr=${result.stderr}`,
		);
		ok(
			result.stderr.includes("Project lock already held"),
			`expected the lock-contention error, got stderr: ${result.stderr}`,
		);

		// The run record is initialized before the lock is attempted, so the
		// contended run leaves a terminal record (with no queue work ever
		// executed) rather than the old acquire-before-initialize path's
		// nothing at all. The terminal state is what keeps the record out of
		// `recover`'s way and confirms the run never executed.
		const run = await onlyRunRecord();
		strictEqual(run.state, "failed");
		strictEqual(run.cleanupState, "complete");

		// No queue execution: the run aborted at the lock gate, so no
		// checkpoint was ever written for the tasks file.
		const { getCheckpointPath } = await import(
			"../src/switchyard/runner/index.mjs"
		);
		ok(
			!existsSync(getCheckpointPath(tasksFile)),
			"a lock-contended run must not execute any queue work",
		);

		// The failed run's teardown must not have released the first run's
		// lock (ownership-checked release) — prove it still holds the lock,
		// then clean it up.
		strictEqual(
			await releaseProjectLockIfOwnedBy(projectDir, holderRunId),
			true,
			"the first run's lock must still be held after the second run failed",
		);
	});
});
