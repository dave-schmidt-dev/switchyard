// Dispatch CLI contract tests: subcommand routing, exit codes, help output,
// and backwards compatibility. Tests parse functions directly for deterministic
// validation and spawns the CLI for exit-code / envelope contract verification.

import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
} from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";

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

function exactFailureEvidence(targetId, harness, model, taskId = "1.1") {
	const descriptorCore = {
		target_id: targetId,
		model_ref: model,
		selector: model,
		effort: null,
		variant: null,
		invocation_args: [],
	};
	const descriptorIdentity = getInvocationDescriptorIdentity(
		descriptorCore,
		harness,
	);
	return {
		taskId,
		success: false,
		provider: harness,
		model,
		resolvedTargetId: targetId,
		invocationDescriptor: {
			...descriptorCore,
			descriptor_identity: descriptorIdentity,
		},
		descriptorIdentity,
		descriptorHarness: harness,
		result: "execution_failed",
		errorKind: "execution_failed",
		reasonCode: "execution_failed",
		reason: "Provider execution failed before a reviewed integration.",
		failurePhase: "provider_execution",
	};
}

import {
	captureHostFingerprint,
	runDispatch as dispatchRun,
	formatRunAbort,
	handleLaunch,
	handleRecover,
	handleRun,
	markLauncherReadyIfLaunching,
	parseDispatchArgs,
	parseLaunchArgs,
	parseOrphanLockRemediationArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
	probeProviderProcess,
	sweepManagedOrphans,
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
} from "../src/switchyard/dispatch/index.mjs";
import { LockError } from "../src/switchyard/run-store/index.mjs";
import {
	QueuePreflightError,
	runQueue,
	TaskSelectionError,
} from "../src/switchyard/runner/index.mjs";

function runDispatch(args, env = {}, timeout = 10_000) {
	return spawnSync(process.execPath, [DISPATCH_PATH, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
		env: { ...process.env, ...env },
	});
}

async function captureLaunchJson(args, dependencies = {}) {
	const output = [];
	const errors = [];
	const originalLog = console.log;
	const originalError = console.error;
	const originalExitCode = process.exitCode;
	console.log = (line) => output.push(String(line));
	console.error = (line) => errors.push(String(line));
	try {
		await handleLaunch(args, dependencies);
	} finally {
		console.log = originalLog;
		console.error = originalError;
		process.exitCode = originalExitCode;
	}
	strictEqual(
		output.length,
		1,
		`expected one stdout object, got ${output.length}`,
	);
	return { envelope: JSON.parse(output[0]), errors };
}

async function captureRunJson(args, dependencies = {}) {
	const output = [];
	const errors = [];
	const originalLog = console.log;
	const originalError = console.error;
	const originalExitCode = process.exitCode;
	console.log = (line) => output.push(String(line));
	console.error = (line) => errors.push(String(line));
	try {
		await handleRun(args, dependencies);
	} finally {
		console.log = originalLog;
		console.error = originalError;
		process.exitCode = originalExitCode;
	}
	strictEqual(
		output.length,
		1,
		`expected one stdout object, got ${output.length}`,
	);
	return { envelope: JSON.parse(output[0]), errors, output };
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
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** A test\n",
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
		strictEqual(opts.platform, "macos");
	});

	it("parses the queue-level macOS platform", () => {
		strictEqual(
			parseDispatchArgs([
				tasksFile,
				"--project",
				projectDir,
				"--platform",
				"macos",
			]).platform,
			"macos",
		);
	});

	it("accepts --json for synchronous run", () => {
		strictEqual(
			parseDispatchArgs([tasksFile, "--project", projectDir, "--json"]).json,
			true,
		);
	});

	it("rejects an unsupported platform before dispatch", () => {
		strictEqual(
			(() => {
				try {
					parseDispatchArgs([
						tasksFile,
						"--project",
						projectDir,
						"--platform",
						"windows",
					]);
					return null;
				} catch (error) {
					return error.message;
				}
			})(),
			'--platform must be macos, got "windows"',
		);
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

	it("collects repeated --task-id selectors", () => {
		const opts = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--task-id",
			"1.2",
			"--task-id",
			"2.1",
		]);
		deepStrictEqual(opts.taskIds, ["1.2", "2.1"]);
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

describe("CLI queue-level platform selection", () => {
	it("runs the macOS queue path through a VM helper without Docker workspace calls", async () => {
		writeFileSync(
			tasksFile,
			"### Task 1.1: Already complete\n- **Status:** done\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** fixture\n",
			"utf8",
		);
		const calls = [];
		const opts = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--platform",
			"macos",
		]);
		await dispatchRun(opts, {
			runQueue: (queueOptions) =>
				runQueue({
					...queueOptions,
					dependencies: {
						...queueOptions.dependencies,
						backendFactory: ({ platform }) => {
							strictEqual(platform, "macos");
							return {
								create: () => {
									calls.push("create-vm");
									return "vm-handle";
								},
								seed: () => calls.push("seed-vm"),
								commit: () => calls.push("commit-vm"),
								reset: () => calls.push("reset-vm"),
								destroy: () => calls.push("destroy-vm"),
							};
						},
					},
				}),
			// Keep the queue-level platform test hermetic: the pre-dispatch
			// hygiene sweep must not query or mutate host Parallels inventory.
			listManaged: () => [],
			reclaim: () => ({
				reclaimed: [],
				reclaimedSnapshots: [],
				skippedSnapshots: [],
				errors: [],
			}),
		});
		strictEqual(calls.includes("create-vm"), true);
		strictEqual(calls.includes("destroy-vm"), true);
		strictEqual(
			calls.some((call) => call.includes("docker")),
			false,
		);
		process.exitCode = 0;
	});
});

describe("captureHostFingerprint", () => {
	it("ignores the project-local durable run store while detecting source edits", () => {
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "README.md"), "canary\n", "utf8");
		execSync(
			"git init -q && git add README.md && git -c user.name=Test -c user.email=test@example.invalid commit -qm seed",
			{
				cwd: projectDir,
			},
		);
		mkdirSync(join(stateRoot, "runs", "live"), { recursive: true });
		writeFileSync(join(stateRoot, "runs", "live", "run.json"), "{}\n", "utf8");

		ok(captureHostFingerprint(projectDir).endsWith(":clean"));
		writeFileSync(join(projectDir, "README.md"), "changed\n", "utf8");
		ok(captureHostFingerprint(projectDir).endsWith(":dirty"));
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

	it("parses the state-root-bound orphan-lock remediation command", () => {
		deepStrictEqual(
			parseOrphanLockRemediationArgs([
				"--dry-run",
				"--state-root",
				"/tmp/switchyard state",
			]),
			{
				argv: ["--dry-run"],
				stateRoot: "/tmp/switchyard state",
			},
		);
	});
});

describe("usage output", () => {
	it("USAGE contains subcommand listing", () => {
		ok(USAGE.includes("--version"));
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
	it("--version prints the package version independently of cwd", () => {
		const packageVersion = JSON.parse(
			readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
		).version;
		strictEqual(packageVersion, "0.2.1");
		const result = spawnSync(process.execPath, [DISPATCH_PATH, "--version"], {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		strictEqual(result.status, 0);
		strictEqual(result.stdout, `${packageVersion}\n`);
		strictEqual(result.stderr, "");
	});

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

	it("orphan-lock remediation help exits 0 without changing state", () => {
		const result = runDispatch(["remediate-orphaned-locks", "--help"]);
		strictEqual(result.status, 0);
		ok(result.stdout.includes("Usage: node remediate-orphaned-locks.mjs"));
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

	it("launch --json zero-task fixture emits exactly one pre-init object", () => {
		const emptyTasksFile = join(dir, "empty-json-tasks.md");
		writeFileSync(emptyTasksFile, "# No task headings.\n", "utf8");
		const result = runDispatch(
			["launch", emptyTasksFile, "--project", projectDir, "--json"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 2);
		strictEqual(result.stdout.trim().split("\n").length, 1);
		const envelope = JSON.parse(result.stdout);
		strictEqual(envelope.runId, null);
		strictEqual(envelope.statusCommand, null);
		strictEqual(envelope.resultCommand, null);
		strictEqual(envelope.disposition.action, "repair_contract");
		strictEqual(envelope.disposition.reasonCode, "queue_empty");
	});

	it("launch --json identity fixture emits exactly one pre-init object", async () => {
		const canary = "SECRET_CANARY_identity_failure";
		const { envelope, errors } = await captureLaunchJson(
			[tasksFile, "--project", projectDir, "--json"],
			{
				prepareRunIdentity: () => {
					throw new Error(canary);
				},
			},
		);
		strictEqual(envelope.runId, null);
		strictEqual(envelope.statusCommand, null);
		strictEqual(envelope.resultCommand, null);
		strictEqual(envelope.disposition.action, "repair_contract");
		strictEqual(envelope.disposition.reasonCode, "queue_identity_invalid");
		ok(!errors.join("\n").includes(canary));
	});

	for (const fixture of [
		{ name: "lock-live", holderLiveness: "live" },
		{ name: "lock-startup-grace", holderLiveness: "startup_grace" },
		{ name: "lock-cleanup-failed", holderLiveness: "cleanup_failed" },
		{ name: "lock-malformed", holderLiveness: "malformed" },
		{ name: "lock-foreign", holderLiveness: "foreign" },
		{ name: "lock-missing", holderLiveness: "missing" },
		{ name: "lock-ambiguous", holderLiveness: "unknown" },
		{ name: "lock-dead", holderLiveness: "dead" },
	]) {
		it(`launch --json ${fixture.name} fixture emits a terminal retry-launch object`, async () => {
			const { LockError } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			const holderRunId = `${fixture.name}-${randomUUID()}`;
			const lockCalls = [];
			const { envelope } = await captureLaunchJson(
				[tasksFile, "--project", projectDir, "--json"],
				{
					releaseOrphanedProjectLocks: async () => {
						lockCalls.push("pre-acquisition-orphan-sweep");
						return [];
					},
					reconcileProjectLockClaims: async () => {
						lockCalls.push("pre-acquisition-claim-sweep");
						return [];
					},
					acquireProjectLock: async () => {
						lockCalls.push("contention");
						throw new LockError("closed fixture", {
							code: "PROJECT_LOCK_HELD",
							holderRunId,
						});
					},
					readRun: async () => ({ runId: holderRunId }),
					classifyRunLiveness: () => fixture.holderLiveness,
				},
			);
			ok(typeof envelope.runId === "string");
			ok(envelope.statusCommand.includes(envelope.runId));
			ok(envelope.resultCommand.includes(envelope.runId));
			strictEqual(envelope.disposition.action, "stop");
			strictEqual(envelope.disposition.direction, "retry_launch");
			strictEqual(envelope.disposition.reasonCode, "project_lock_held");
			strictEqual(envelope.disposition.blockingRunId, null);
			strictEqual(envelope.disposition.recoveryCommand, null);
			deepStrictEqual(lockCalls, [
				"pre-acquisition-orphan-sweep",
				"pre-acquisition-claim-sweep",
				"contention",
			]);
		});
	}

	it("launch --json spawn fixture emits one durable canary-free object", async () => {
		const canary = "SECRET_CANARY_spawn_failure";
		const fakeChild = {
			unref() {},
			on(event, listener) {
				if (event === "error") listener(new Error(canary));
				return this;
			},
		};
		const { envelope, errors } = await captureLaunchJson(
			[tasksFile, "--project", projectDir, "--json"],
			{ spawn: () => fakeChild },
		);
		ok(typeof envelope.runId === "string");
		ok(envelope.statusCommand.includes(envelope.runId));
		ok(envelope.resultCommand.includes(envelope.runId));
		strictEqual(envelope.disposition.action, "repair_contract");
		strictEqual(envelope.disposition.reasonCode, "worker_boot_exception");
		ok(!errors.join("\n").includes(canary));
	});

	it("launch --json success fixture emits exactly one parseable object", () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir, "--json"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, result.stderr);
		strictEqual(result.stdout.trim().split("\n").length, 1);
		const envelope = JSON.parse(result.stdout);
		strictEqual(envelope.state, "launcher_ready");
		ok(typeof envelope.runId === "string");
	});

	it("a launched run retains its durable contract diagnosis when its checkpoint becomes unloadable", async () => {
		const launchResponse = runDispatch(
			["launch", tasksFile, "--project", projectDir, "--json"],
			makeStateRootEnv(),
		);
		strictEqual(launchResponse.status, 0, launchResponse.stderr);
		const launchEnvelope = JSON.parse(launchResponse.stdout.trim());
		const { readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const current = await readRun(launchEnvelope.runId);
		await updateRun(
			launchEnvelope.runId,
			{
				state: "failed",
				cleanupState: "complete",
				lastFailure: {
					errorKind: "execution_failed",
					reasonCode: "execution_failed",
					reason: "Provider execution failed before a reviewed integration.",
					diagnosticCode: "checkpoint_queue_identity_mismatch",
					failurePhase: "adapter_validation",
				},
			},
			current.revision,
		);
		writeFileSync(`${tasksFile}.checkpoint.json`, "{unloadable", "utf8");

		const responses = [
			[0, runDispatch(["status", launchEnvelope.runId], makeStateRootEnv())],
			[1, runDispatch(["result", launchEnvelope.runId], makeStateRootEnv())],
		];
		for (const [expectedStatus, response] of responses) {
			strictEqual(response.status, expectedStatus, response.stderr);
			const envelope = JSON.parse(response.stdout.trim());
			strictEqual(envelope.runId, launchEnvelope.runId);
			strictEqual(envelope.disposition.action, "repair_contract");
			strictEqual(
				envelope.disposition.reasonCode,
				"checkpoint_queue_identity_mismatch",
			);
		}
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
		strictEqual(envelope.schemaVersion, 2);
		ok(typeof envelope.runId === "string" && envelope.runId.length > 0);
		strictEqual(envelope.state, "launcher_ready");
		strictEqual(envelope.stateRoot, stateRoot);
		ok(envelope.statusCommand.includes("switchyard-dispatch status"));
		ok(envelope.resultCommand.includes("switchyard-dispatch result"));
		ok(envelope.statusCommand.includes("--state-root"));
		ok(envelope.resultCommand.includes("--state-root"));
	});

	it("launch envelope commands let a fresh shell poll a quoted state root", () => {
		const quotedStateRoot = join(dir, "state'root");
		const launched = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			{
				...makeStateRootEnv(),
				SWITCHYARD_RUN_STORE_ROOT: quotedStateRoot,
			},
		);
		strictEqual(launched.status, 0, `stderr: ${launched.stderr}`);
		const envelope = JSON.parse(launched.stdout.trim());
		strictEqual(envelope.stateRoot, quotedStateRoot);

		const freshEnv = {
			...process.env,
			PATH: `${join(process.env.HOME ?? "/", ".agent", "bin")}:${process.env.PATH ?? ""}`,
			SWITCHYARD_ROSTER_PATH: ROSTER_FIXTURE_PATH,
			SWITCHYARD_LEDGER_PATH: join(dir, "fresh-poller-ledger.jsonl"),
		};
		delete freshEnv.SWITCHYARD_RUN_STORE_ROOT;

		const status = spawnSync("/bin/sh", ["-c", envelope.statusCommand], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: freshEnv,
		});
		strictEqual(status.status, 0, `stderr: ${status.stderr}`);
		strictEqual(JSON.parse(status.stdout.trim()).runId, envelope.runId);

		const result = spawnSync("/bin/sh", ["-c", envelope.resultCommand], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: freshEnv,
		});
		notStrictEqual(result.status, 3, `stderr: ${result.stderr}`);
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
		strictEqual(run.schemaVersion, 2);
		ok(/^[a-f0-9]{64}$/.test(run.queueIdentity));
		strictEqual(run.runOptions.version, 1);
		deepStrictEqual(run.excludeProviders, []);
	});

	it("launch persists repeatable task selection in runOptions", async () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir, "--task-id", "1.1"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		deepStrictEqual(run.runOptions.taskIds, ["1.1"]);
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

describe("synchronous run JSON envelope", () => {
	function noVmDependencies(overrides = {}) {
		return {
			assertGenerationAllowed: () => {},
			releaseOrphanedProjectLocks: async () => [],
			reconcileProjectLockClaims: async () => [],
			executionBackend: {
				listManaged: () => [],
				reclaim: () => ({
					reclaimed: [],
					errors: [],
					skippedSnapshots: [],
				}),
			},
			...overrides,
		};
	}

	it("emits one result-compatible success envelope with an empty stderr", async () => {
		const { envelope, errors, output } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				runQueue: async () => ({
					totalTasks: 1,
					runnableTasks: 1,
					processedTasks: 1,
					completedTaskIds: ["1.1"],
					results: [{ taskId: "1.1", success: true, result: "success" }],
					checkpointPath: join(dir, "success.checkpoint.json"),
				}),
			}),
		);
		strictEqual(output.length, 1);
		deepStrictEqual(errors, []);
		ok(typeof envelope.runId === "string");
		strictEqual(envelope.state, "succeeded");
		strictEqual(envelope.cleanupState, "complete");
		strictEqual(envelope.disposition.action, "complete");
		strictEqual(envelope.disposition.direction, "complete");
	});

	it("emits one closed failure envelope without raw exception text", async () => {
		const canary = "SECRET_CANARY_sync_json_raw_error";
		const { envelope, errors, output } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				runQueue: async () => {
					throw new TaskSelectionError("9.9", canary);
				},
			}),
		);
		const serialized = JSON.stringify(envelope);
		strictEqual(output.length, 1);
		deepStrictEqual(errors, []);
		ok(!serialized.includes(canary));
		ok(!serialized.includes("9.9"));
		ok(typeof envelope.runId === "string");
		strictEqual(envelope.state, "failed");
		strictEqual(envelope.disposition.action, "repair_contract");
		strictEqual(envelope.disposition.direction, "repair_input");
		strictEqual(envelope.disposition.reasonCode, "task_selection_failed");
	});

	it("emits a null-address pre-initialization contract envelope", async () => {
		const { envelope, errors } = await captureRunJson(["--json"]);
		deepStrictEqual(errors, []);
		strictEqual(envelope.runId, null);
		strictEqual(envelope.stateRoot, null);
		strictEqual(envelope.statusCommand, null);
		strictEqual(envelope.resultCommand, null);
		strictEqual(envelope.disposition.action, "repair_contract");
		strictEqual(envelope.disposition.direction, "repair_input");
		strictEqual(envelope.disposition.reasonCode, "invalid_invocation");
	});

	it("maps an empty parsed queue before initialization without creating a run", async () => {
		const emptyTasksFile = join(dir, "empty-run-json.md");
		writeFileSync(emptyTasksFile, "# no task headings\n", "utf8");
		const { envelope, errors } = await captureRunJson(
			[emptyTasksFile, "--project", projectDir, "--json"],
			noVmDependencies(),
		);
		deepStrictEqual(errors, []);
		strictEqual(envelope.runId, null);
		strictEqual(envelope.disposition.reasonCode, "queue_empty");
		strictEqual(envelope.disposition.direction, "repair_input");
	});

	it("binds a durable default failure message to its run ID", async () => {
		const canary = "closed-default-failure";
		const originalError = console.error;
		console.error = () => {};
		try {
			await rejects(
				handleRun(
					[tasksFile, "--project", projectDir],
					noVmDependencies({
						runQueue: async () => {
							throw new TaskSelectionError("9.9", canary);
						},
					}),
				),
				(error) => {
					ok(typeof error.switchyardRunId === "string");
					const message = formatRunAbort(error);
					ok(message.includes(`run ${error.switchyardRunId}`));
					return true;
				},
			);
		} finally {
			console.error = originalError;
		}
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

	it("status and terminal result expose the same bounded queue diagnostics", async () => {
		const diagnosticTasksFile = join(dir, "diagnostic-tasks.md");
		writeFileSync(
			diagnosticTasksFile,
			`### Task 1.1: Provider task with sensitive description
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/provider-secret-name.mjs
- **Description:** provider task description

### Task 1.2: Human gate
- **Status:** pending
- **Executor:** human
- **Description:** human approval details

### Task 1.3: Native gate
- **Status:** pending
- **Executor:** native
- **Description:** local worker details

### Task 1.4: Dependency gate
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/dependent.mjs
- **Blocked by:** Task 1.1

### Task 1.5: External gate
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/external.mjs
- **External blockers:** decision:approval

### Task 1.6: Completed task
- **Status:** done
- **Executor:** switchyard
- **Files:** src/completed.mjs
`,
			"utf8",
		);
		const runId = "diagnostic-parity";
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		await initializeRun({
			runId,
			tasksFilePath: diagnosticTasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.6"] },
			},
			current.revision,
		);

		const status = JSON.parse(
			runDispatch(["status", runId], makeStateRootEnv()).stdout.trim(),
		);
		const result = JSON.parse(
			runDispatch(["result", runId], makeStateRootEnv()).stdout.trim(),
		);
		deepStrictEqual(status.queueDiagnostics, result.queueDiagnostics);
		deepStrictEqual(status.queueDiagnostics.selected, {
			count: 5,
			reason: "queue_default",
		});
		strictEqual(status.queueDiagnostics.runnable.count, 1);
		strictEqual(status.queueDiagnostics.humanGated.count, 1);
		strictEqual(status.queueDiagnostics.nativeGated.count, 1);
		strictEqual(status.queueDiagnostics.dependencyBlocked.count, 1);
		strictEqual(status.queueDiagnostics.externalBlocked.count, 1);
		strictEqual(status.queueDiagnostics.completed.count, 1);
		const allowedReasons = new Set([
			"queue_default",
			"provider_eligible_and_unblocked",
			"executor_human",
			"executor_native",
			"task_dependency",
			"external_blocker",
			"queue_status_or_checkpoint",
			"queue_unavailable",
		]);
		for (const value of Object.values(status.queueDiagnostics)) {
			ok(allowedReasons.has(value.reason));
		}
		const serialized = JSON.stringify(status.queueDiagnostics);
		ok(!serialized.includes("provider-secret-name.mjs"));
		ok(!serialized.includes("provider task description"));
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

	it("recover without --help runs and exits (Parallels may not be available)", () => {
		const result = runDispatch(["recover"]);
		ok(
			result.status === 0 || result.status === 1,
			`unexpected exit code: ${result.status}`,
		);
		const output = JSON.parse(result.stdout.trim());
		ok(typeof output.vmsReclaimed === "number");
		ok(Array.isArray(output.errors));
		ok(Array.isArray(output.candidates) || output.candidates === null);
	});

	it("finalizes a dead old run while preserving a newer live project-lock owner", async () => {
		const {
			acquireProjectLock,
			advanceState,
			initializeRun,
			isProjectLockOwnedBy,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");
		const staleRunId = randomUUID();
		await initializeRun({
			runId: staleRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(staleRunId, "running");
		let current = await readRun(staleRunId);
		await updateRun(staleRunId, { workerPid: 999999 }, current.revision);

		const activeRunId = randomUUID();
		await initializeRun({
			runId: activeRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(activeRunId, "running");
		current = await readRun(activeRunId);
		await updateRun(activeRunId, { workerPid: process.pid }, current.revision);
		await acquireProjectLock(projectDir, activeRunId);

		const output = [];
		const originalLog = console.log;
		const originalExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", staleRunId], { listManaged: () => [] });
		} finally {
			console.log = originalLog;
			process.exitCode = originalExitCode;
		}

		const envelope = JSON.parse(output[0]);
		deepStrictEqual(envelope.errors, []);
		strictEqual(envelope.projectLocksReleased, 0);
		strictEqual(await isProjectLockOwnedBy(projectDir, activeRunId), true);
		const staleRun = await readRun(staleRunId);
		strictEqual(staleRun.state, "failed");
		strictEqual(staleRun.cleanupState, "complete");
		strictEqual(staleRun.terminalizedBy, "dead_worker_recovery");
	});

	it("counts a project lock successfully released by dead-run finalization", async () => {
		const {
			acquireProjectLock,
			advanceState,
			initializeRun,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");
		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(runId, "running");
		const current = await readRun(runId);
		await updateRun(runId, { workerPid: 999999 }, current.revision);
		await acquireProjectLock(projectDir, runId);

		const output = [];
		const originalLog = console.log;
		const originalExitCode = process.exitCode;
		console.log = (line) => output.push(String(line));
		try {
			await handleRecover(["--run", runId], { listManaged: () => [] });
		} finally {
			console.log = originalLog;
			process.exitCode = originalExitCode;
		}

		const envelope = JSON.parse(output[0]);
		deepStrictEqual(envelope.errors, []);
		strictEqual(envelope.projectLocksReleased, 1);
		strictEqual(isProjectLockHeld(projectDir), false);
	});
});

describe("reclaimed-but-unrecorded snapshots reach the operator", () => {
	// reclaim() may delete a VM and still be forbidden from deleting the parent
	// snapshots it left on the golden, when the sidecar naming them is gone.
	// That is the one INV-3 leak the sweep cannot repair, so both operator
	// paths have to say so out loud rather than reporting a clean reclaim.
	const DEAD_VM = "switchyard-work-orphan-999999";

	function reclaimWithResidue() {
		return {
			reclaimed: [{ uuid: "u-1", name: DEAD_VM, forced: true }],
			reclaimedSnapshots: [],
			skipped: [],
			skippedSnapshots: [
				{ name: DEAD_VM, uuid: "u-1", reason: "no-snapshot-sidecar" },
			],
			errors: [],
		};
	}

	it("sweepManagedOrphans reports the residue instead of dropping it", async () => {
		const swept = await sweepManagedOrphans({
			listManaged: () => [{ runId: "run-1", name: DEAD_VM, status: "stopped" }],
			reclaim: reclaimWithResidue,
			readRun: async () => {
				throw new Error("no such run");
			},
		});

		strictEqual(swept.vmsReclaimed, 1);
		deepStrictEqual(swept.unreclaimedSnapshots, [
			{ name: DEAD_VM, uuid: "u-1", reason: "no-snapshot-sidecar" },
		]);
	});

	it("sweepManagedOrphans reports an empty residue when every sidecar was found", async () => {
		const swept = await sweepManagedOrphans({
			listManaged: () => [],
			reclaim: () => ({
				reclaimed: [],
				reclaimedSnapshots: [],
				skipped: [],
				skippedSnapshots: [],
				errors: [],
			}),
			readRun: async () => {
				throw new Error("no such run");
			},
		});

		deepStrictEqual(swept.unreclaimedSnapshots, []);
	});

	it("pre-run sweep filters VM reclaim to readable dead runs in the current project", async () => {
		const currentProject = join(dir, "current-project");
		const entries = [
			{ runId: "local-dead", name: "local-dead", status: "stopped" },
			{ runId: "local-live", name: "local-live", status: "stopped" },
			{ runId: "foreign-dead", name: "foreign-dead", status: "stopped" },
			{ runId: "missing", name: "missing", status: "stopped" },
			{ runId: "malformed", name: "malformed", status: "stopped" },
		];
		const runs = {
			"local-dead": {
				projectPath: currentProject,
				state: "running",
				cleanupState: "pending",
				workerPid: 999999,
			},
			"local-live": {
				projectPath: currentProject,
				state: "running",
				cleanupState: "pending",
				workerPid: process.pid,
			},
			"foreign-dead": {
				projectPath: join(dir, "foreign-project"),
				state: "failed",
				cleanupState: "complete",
				workerPid: null,
			},
		};
		let reclaimOptions;
		const swept = await sweepManagedOrphans({
			projectPath: currentProject,
			listManaged: () => entries,
			readRun: async (runId) => {
				if (runId === "missing" || runId === "malformed") {
					throw new Error("unavailable");
				}
				return runs[runId];
			},
			reclaim: (options) => {
				reclaimOptions = options;
				const reclaimed = entries.filter((entry) => options.eligibility(entry));
				return {
					reclaimed,
					reclaimedSnapshots: [],
					skippedSnapshots: [],
					errors: [],
				};
			},
			releaseOrphanedProjectLocks: async () => [],
			reconcileProjectLockClaims: async () => [],
		});

		deepStrictEqual(
			reclaimOptions &&
				entries
					.filter((entry) => reclaimOptions.eligibility(entry))
					.map((entry) => entry.runId),
			["local-dead"],
		);
		strictEqual(swept.vmsReclaimed, 1);
	});

	it("recover's JSON envelope names the golden's leftover snapshots", async () => {
		const lines = [];
		const realLog = console.log;
		console.log = (line) => lines.push(line);
		const priorExitCode = process.exitCode;
		try {
			await handleRecover([], {
				listManaged: () => [
					{ runId: "run-1", name: DEAD_VM, status: "stopped" },
				],
				reclaim: reclaimWithResidue,
				readRun: async () => {
					throw new Error("no such run");
				},
			});
		} finally {
			console.log = realLog;
			process.exitCode = priorExitCode;
		}

		strictEqual(lines.length, 1);
		const output = JSON.parse(lines[0]);
		strictEqual(output.vmsReclaimed, 1);
		deepStrictEqual(output.unreclaimedSnapshots, [
			{ name: DEAD_VM, uuid: "u-1", reason: "no-snapshot-sidecar" },
		]);
	});

	it("the pre-dispatch sweep report reads a field sweepManagedOrphans actually returns", async () => {
		// It read `containersReclaimed`/`volumesReclaimed` after the
		// Docker-to-Parallels rename, so `undefined > 0` made the branch
		// unreachable and every pre-run reclamation went unreported.
		const source = readFileSync(DISPATCH_PATH, "utf8");
		const swept = await sweepManagedOrphans({
			listManaged: () => [],
			reclaim: () => ({
				reclaimed: [],
				reclaimedSnapshots: [],
				skipped: [],
				skippedSnapshots: [],
				errors: [],
			}),
			readRun: async () => {
				throw new Error("no such run");
			},
		});
		for (const match of source.matchAll(/swept\.([A-Za-z]+)/g)) {
			ok(
				Object.hasOwn(swept, match[1]),
				`pre-run sweep reads swept.${match[1]}, which sweepManagedOrphans does not return`,
			);
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
			"### Task 1.1: Test run task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** Run test\n",
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
			"stateRoot",
			"statusCommand",
			"resultCommand",
		];
		for (const key of required) {
			ok(key in envelope, `launch envelope missing field: ${key}`);
		}
		strictEqual(envelope.schemaVersion, 2);
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
			"resolvedTargetId",
			"snapshotStatus",
			"snapshotMtime",
			"snapshotAgeMsAtRoute",
			"completedCount",
			"failedCount",
			"lastFailure",
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
			"resolvedTargetId",
			"snapshotStatus",
			"snapshotMtime",
			"snapshotAgeMsAtRoute",
			"completedCount",
			"failedCount",
			"lastFailure",
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
		];
		for (const key of required) {
			ok(key in envelope, `result envelope missing field: ${key}`);
		}
	});

	it("drops a lastFailure artifact ref the artifacts channel cannot resolve", async () => {
		// Run eab7d23c (2026-08-25) persisted `lastFailure.artifactRef` while
		// `artifactRefs` was `[]`: the ref is derived unconditionally from the
		// task id, but the copy into the artifacts channel is best-effort and
		// swallows its own failure. An operator then cannot tell a lost artifact
		// from a bad pointer. Report only what the run can actually produce.
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = "dangling-artifact-ref";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const lastFailure = {
			errorKind: "integration_failed",
			reasonCode: "integration_failed",
			reason: "The reviewed integration gate rejected the task result.",
			artifactRef: "artifact:0123456789abcdef01234567",
		};
		let current = await readRun(runId);
		await updateRun(runId, { lastFailure }, current.revision);

		const statusEnvelope = JSON.parse(
			runDispatch(["status", runId], makeStateRootEnv()).stdout.trim(),
		);

		current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				terminalSummary: { completedTaskIds: ["1.1"] },
			},
			current.revision,
		);
		const resultEnvelope = JSON.parse(
			runDispatch(["result", runId], makeStateRootEnv()).stdout.trim(),
		);

		deepStrictEqual(resultEnvelope.artifactRefs, []);
		strictEqual(resultEnvelope.lastFailure.artifactRef, undefined);
		// Both envelopes must agree, or `status` advertises a ref `result` denies.
		strictEqual(statusEnvelope.lastFailure.artifactRef, undefined);
		// Dropping the ref must not drop the diagnosis with it.
		strictEqual(resultEnvelope.lastFailure.reasonCode, "integration_failed");
		deepStrictEqual(statusEnvelope.lastFailure, resultEnvelope.lastFailure);
	});

	it("capstone: status and result preserve the same bounded route/failure projection", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { saveCheckpoint } = await import(
			"../src/switchyard/runner/index.mjs"
		);
		const runId = "unconditional-contract-projection";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		// The ref must be one the artifacts channel can actually resolve, or both
		// envelopes now drop it as unresolvable. `listArtifactRefs` hashes the
		// file NAME, so seed a real artifact and derive the ref from its name.
		const { getRunRoot } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const artifactsDir = join(getRunRoot(runId), "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(join(artifactsDir, "1.1.diff"), "partial\n", "utf8");
		const resolvableRef = `artifact:${createHash("sha256")
			.update("1.1.diff")
			.digest("hex")
			.slice(0, 24)}`;
		const routeAndFailure = {
			resolvedTargetId: "agy-gemini",
			snapshotStatus: "stale",
			snapshotMtime: 1_754_000_000_000,
			snapshotAgeMsAtRoute: 301_000,
			lastFailure: {
				errorKind: "integration_failed",
				reasonCode: "integration_failed",
				reason: "The reviewed integration gate rejected the task result.",
				artifactRef: resolvableRef,
			},
		};
		let current = await readRun(runId);
		await updateRun(runId, routeAndFailure, current.revision);
		const retryProjection = {
			quarantinedTargetIds: ["agy-gemini"],
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
			},
			retryTransitionId: 2,
		};
		saveCheckpoint(`${tasksFile}.checkpoint.json`, {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			...retryProjection,
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0, `stderr: ${statusResult.stderr}`);
		const statusEnvelope = JSON.parse(statusResult.stdout.trim());

		current = await readRun(runId);
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

		for (const envelope of [statusEnvelope, resultEnvelope]) {
			for (const [key, expected] of Object.entries(routeAndFailure)) {
				deepStrictEqual(envelope[key], expected, `${key} projection drifted`);
			}
			for (const [key, expected] of Object.entries(retryProjection)) {
				deepStrictEqual(
					envelope[key],
					expected,
					`${key} retry projection drifted`,
				);
			}
		}
		ok(
			!JSON.stringify({ statusEnvelope, resultEnvelope }).includes(
				"SECRET_CANARY",
			),
		);
	});

	it("status and result project descriptor-bound Agy-to-OpenCode checkpoint evidence", async () => {
		const { initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { saveCheckpoint } = await import(
			"../src/switchyard/runner/index.mjs"
		);
		const runId = "agy-opencode-attempts";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		const agyFailure = exactFailureEvidence(
			"antigravity",
			"agy",
			"fixture-agy-standard",
		);
		const opencodeFailure = exactFailureEvidence(
			"opencode-go",
			"opencode",
			"fixture/opencode-standard",
		);
		saveCheckpoint(`${tasksFile}.checkpoint.json`, {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: [],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [opencodeFailure],
			retryAttempts: [agyFailure],
		});
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "failed",
				cleanupState: "complete",
				lastFailure: {
					errorKind: "execution_failed",
					reasonCode: "execution_failed",
					reason: "Provider execution failed before a reviewed integration.",
					failurePhase: "provider_execution",
				},
				terminalizedBy: "worker",
				terminalSummary: { processedTasks: 1 },
			},
			current.revision,
		);

		const statusEnvelope = JSON.parse(
			runDispatch(["status", runId], makeStateRootEnv()).stdout.trim(),
		);
		const resultResponse = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResponse.status, 1);
		const resultEnvelope = JSON.parse(resultResponse.stdout.trim());
		for (const envelope of [statusEnvelope, resultEnvelope]) {
			strictEqual(envelope.disposition.action, "target_failed");
			strictEqual(envelope.disposition.taskId, "1.1");
			deepStrictEqual(envelope.disposition.failedTargetIds, [
				"antigravity",
				"opencode-go",
			]);
		}
	});

	it("six sanitized OpenCode failures emit bounded target evidence without cooldown state", async () => {
		const { createEvent, initializeRun, readRun, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { saveCheckpoint } = await import(
			"../src/switchyard/runner/index.mjs"
		);
		const runId = "opencode-six-failures";
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-host",
			launchArgs: [],
		});
		saveCheckpoint(`${tasksFile}.checkpoint.json`, {
			version: 1,
			tasksFilePath: tasksFile,
			completedTaskIds: [],
			lastTaskId: "1.1",
			lastUpdatedAt: new Date().toISOString(),
			results: [],
		});
		const failureEvidence = exactFailureEvidence(
			"opencode-go",
			"opencode",
			"fixture/opencode-standard",
		);
		for (let attempt = 0; attempt < 6; attempt += 1) {
			await createEvent(runId, {
				...failureEvidence,
				phase: "execution",
				event: "task_failed",
				status: "Task 1.1 failed",
			});
		}
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "failed",
				cleanupState: "complete",
				terminalizedBy: "worker",
				terminalSummary: { processedTasks: 1 },
			},
			current.revision,
		);

		const response = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(response.status, 1);
		const envelope = JSON.parse(response.stdout.trim());
		deepStrictEqual(envelope.disposition.failedTargetIds, ["opencode-go"]);
		strictEqual(Object.hasOwn(envelope, "cooldown"), false);
		strictEqual(Object.hasOwn(envelope.disposition, "cooldown"), false);
		const persistedRun = await readRun(runId);
		strictEqual(Object.hasOwn(persistedRun, "cooldown"), false);
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
		const { getCheckpointPath, saveCheckpoint } = await import(
			"../src/switchyard/runner/index.mjs"
		);

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
			version: 1,
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

	it("returns null (never throws) when the backend itself throws, e.g. the VM is unreachable", () => {
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => {
				throw new Error("simulated prlctl failure");
			},
		});
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ executionBackend: backend },
		);
		strictEqual(result, null);
	});

	it("returns true when a guest ps line's command column matches the mapped binary basename, even via a fully-qualified path", () => {
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () =>
				"123 /usr/local/bin/claude --headless\n456 sleep infinity\n",
		});
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ executionBackend: backend },
		);
		strictEqual(result, true);
	});

	it("returns false (a real boolean, not null) when the guest probe succeeds but no line matches", () => {
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => "456 sleep infinity\n",
		});
		const result = probeProviderProcess(
			{
				state: "running",
				workingContainerName: "some-container",
				activeTaskProvider: "claude",
			},
			{ executionBackend: backend },
		);
		strictEqual(result, false);
	});

	it("uses the cursor-agent binary name (not cursor) for the cursor provider", () => {
		const noMatchBackend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => "123 cursor --headless\n",
		});
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: "some-container",
					activeTaskProvider: "cursor",
				},
				{ executionBackend: noMatchBackend },
			),
			false,
			"binary name 'cursor' alone must not match — the actual binary is cursor-agent",
		);

		const matchBackend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: () => "123 cursor-agent --headless\n",
		});
		strictEqual(
			probeProviderProcess(
				{
					state: "running",
					workingContainerName: "some-container",
					activeTaskProvider: "cursor",
				},
				{ executionBackend: matchBackend },
			),
			true,
		);
	});

	it("inspects the workspace through prlctl exec against the routed workspace id", () => {
		let capturedCommand;
		let capturedArgs;
		const backend = new ParallelsExecutionBackend({
			aquaUid: 501,
			execFn: (command, args) => {
				capturedCommand = command;
				capturedArgs = args;
				return "";
			},
		});
		probeProviderProcess(
			{
				state: "running",
				workingContainerName: "my-container",
				activeTaskProvider: "claude",
			},
			{ executionBackend: backend },
		);
		strictEqual(capturedCommand, "prlctl");
		strictEqual(capturedArgs[0], "exec");
		strictEqual(capturedArgs[1], "my-container");
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

	async function dispatchThrownFailure(error) {
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const runsRoot = join(stateRoot, "runs");
		const before = new Set(existsSync(runsRoot) ? readdirSync(runsRoot) : []);
		const savedExitCode = process.exitCode;
		try {
			await rejects(
				dispatchRun(parseDispatchArgs([tasksFile, "--project", projectDir]), {
					runQueue: () => {
						throw error;
					},
				}),
				error,
			);
		} finally {
			process.exitCode = savedExitCode;
		}
		const runId = readdirSync(runsRoot).find(
			(candidate) => !before.has(candidate),
		);
		ok(runId, "typed synchronous failure must leave a new durable run");
		return readRun(runId);
	}

	it("preserves exported pre-provider triples through synchronous finalization", async () => {
		const cases = [
			{
				error: new TaskSelectionError("9.9", "dependency-blocked:1.1"),
				diagnosticCode: "task_selection_failed",
				errorKind: "task_selection_failed",
				failurePhase: "task_selection",
				action: "repair_contract",
			},
			{
				error: new QueuePreflightError(
					"preflight failed at /private/canary with raw provider output",
				),
				diagnosticCode: "environment_incomplete",
				errorKind: "environment_incomplete",
				failurePhase: "queue_preflight",
				action: "repair_contract",
			},
			...[
				"PROJECT_LOCK_HELD",
				"PROJECT_LOCK_RECOVERY_IN_PROGRESS",
				"PROJECT_LOCK_OWNERSHIP_FAILED",
				"PROJECT_LOCK_OWNERSHIP_DISPLACED",
				"PROJECT_LOCK_CLAIM_CLEANUP_FAILED",
				"PROJECT_LOCK_RECOVERY_CLAIM_BLOCKS_EXECUTION",
			].map((code) => ({
				error: new LockError("private lock detail /private/canary", { code }),
				diagnosticCode: code.toLowerCase(),
				errorKind: "project_lock_failed",
				failurePhase: "project_lock",
				action: "stop",
			})),
		];

		for (const testCase of cases) {
			const run = await dispatchThrownFailure(testCase.error);
			strictEqual(run.lastFailure.diagnosticCode, testCase.diagnosticCode);
			strictEqual(run.lastFailure.errorKind, testCase.errorKind);
			strictEqual(run.lastFailure.failurePhase, testCase.failurePhase);
			strictEqual(run.lastFailure.reasonCode, testCase.errorKind);
			const durable = JSON.stringify(run.lastFailure);
			ok(!durable.includes("9.9"));
			ok(!durable.includes("1.1"));
			ok(!durable.includes("/private/canary"));
			ok(!durable.includes("raw provider output"));
			const disposition = projectDisposition({
				run,
				liveness: "terminal_clean",
				optionalEvidenceValid: false,
			});
			strictEqual(disposition.action, testCase.action);
			strictEqual(disposition.reasonCode, testCase.diagnosticCode);
		}
	});

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

	it("publishes activeTaskId while the task is running, so the envelope stops reading idle", async () => {
		// Live-run feedback 2026-08-04/05 (Sentinel Tasks 1.3, 1.4, 3.1): a
		// synchronous run reported activeTaskId=null and a stale updatedAt for
		// the whole ~14 minutes a provider was executing. activeTaskId is the
		// gate buildStatusEnvelope uses for activeTaskProvider, activeTaskModel,
		// activeTaskDeadline, activeTaskAgeMs, and runningCount, so the one
		// missing write suppressed onTaskRouted's writes too. The detached path
		// has always written it from worker-bootstrap's onTaskStart.
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");

		let observedDuringExecution = "unobserved";
		const exitCode = await dispatchWithStub(async (queueOptions) => {
			queueOptions.dependencies.onTaskStart({ id: "1.1", title: "stub" });
			const runDirs = readdirSync(join(stateRoot, "runs"));
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const run = await readRun(runDirs[0]);
				if (run.activeTaskId != null) {
					observedDuringExecution = run.activeTaskId;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			return stubResult(true);
		});

		strictEqual(exitCode, 0);
		strictEqual(
			observedDuringExecution,
			"1.1",
			"activeTaskId must be readable from the run record while the task runs",
		);
		// And it must be cleared on the terminal path, or every finished run
		// would read as permanently busy.
		const run = await onlyRunRecord();
		strictEqual(run.activeTaskId ?? null, null);
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

	it("defaults durable state to the target project when no override is set", async () => {
		const savedRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		try {
			const exitCode = await dispatchRun(
				parseDispatchArgs([tasksFile, "--project", projectDir]),
				{ runQueue: () => stubResult(true) },
			);
			strictEqual(exitCode, undefined);
			ok(
				existsSync(join(projectDir, ".logs", "switchyard", "runs")),
				"default run store must be colocated with the dispatched project",
			);
		} finally {
			if (savedRoot === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = savedRoot;
		}
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

	it("fails before queue execution when run-store initialization fails", async () => {
		const { isProjectLockHeld } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// Block run-store initialization with a plain file at stateRoot/runs.
		// INV-6 requires a durable record before any queue work, so this must
		// fail before the runner can route or create a working container.
		mkdirSync(stateRoot, { recursive: true });
		writeFileSync(join(stateRoot, "runs"), "blocker", "utf8");

		let queueCalls = 0;
		const savedExitCode = process.exitCode;
		try {
			await rejects(
				dispatchRun(parseDispatchArgs([tasksFile, "--project", projectDir]), {
					runQueue: () => {
						queueCalls += 1;
						return stubResult(true);
					},
				}),
				/run-store initialization failed before routing/,
			);
		} finally {
			process.exitCode = savedExitCode;
		}

		strictEqual(queueCalls, 0, "queue must not run without a durable store");
		ok(!isProjectLockHeld(projectDir), "no project lock may be acquired");
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

describe("retention sweep call sites (Task 6.5)", () => {
	const CALL_SITES = [
		["dispatch/index.mjs", DISPATCH_PATH],
		[
			"dispatch/worker-bootstrap.mjs",
			resolve(dirname(DISPATCH_PATH), "worker-bootstrap.mjs"),
		],
	];

	it("no call site pins the sweep to dry-run any more", () => {
		// The sweep shipped as dry-run-only pending a review of its logs. Both
		// call sites now delete for real; a regression here is the difference
		// between a retention policy and a log line about one.
		for (const [label, path] of CALL_SITES) {
			// Strip line comments first: the source explains that dry-run
			// remains available, and naming the option is not using it.
			const source = readFileSync(path, "utf8")
				.split("\n")
				.map((line) => line.replace(/^\s*\/\/.*$/, ""))
				.join("\n");
			const calls = source.match(/applyRetention\(\{[^}]*\}/g) ?? [];
			ok(calls.length > 0, `${label} must still run a retention sweep`);
			for (const call of calls) {
				ok(
					!/dryRun/.test(call),
					`${label} must not pin its retention sweep to dry-run: ${call}`,
				);
			}
		}
	});

	it("dry-run mode remains available for inspection", async () => {
		// Removing the call-site flag must not remove the mode: an operator
		// needs a way to see what a sweep would do before it does it.
		const runStore = await import("../src/switchyard/run-store/index.mjs");
		const result = await runStore.applyRetention({ dryRun: true });
		ok(
			Number.isInteger(result.deletedCount) &&
				Number.isInteger(result.collectedCount),
			"dryRun must still report what it would remove",
		);
	});
});
