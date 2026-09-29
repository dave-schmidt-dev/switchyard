import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	captureHostFingerprint,
	runDispatch as dispatchRun,
	parseDispatchArgs,
	parseHealthArgs,
	parseLaunchArgs,
	parseOrphanLockRemediationArgs,
	parseRecoverArgs,
	parseResultArgs,
	parseStatusArgs,
	USAGE,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
	USAGE_VALIDATE_INPUTS,
} from "../src/switchyard/dispatch/index.mjs";
import {
	acquireProjectLock,
	advanceState,
	initializeRun,
} from "../src/switchyard/run-store/index.mjs";
import { runQueue } from "../src/switchyard/runner/index.mjs";
import {
	__dirname,
	DISPATCH_PATH,
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-dispatch-cli-");
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** A test\n",
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
	rmSync(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});
describe("health control CLI", () => {
	it("defaults queue routing to shadow and makes enforcement explicit", () => {
		strictEqual(
			parseDispatchArgs([tasksFile, "--project", projectDir]).healthMode,
			"shadow",
		);
		strictEqual(
			parseDispatchArgs([
				tasksFile,
				"--project",
				projectDir,
				"--health-enforce",
			]).healthMode,
			"enforce",
		);
	});

	it("accepts only bounded inspection and attended attestation fields", () => {
		const hash = `sha256:${"a".repeat(64)}`;
		deepStrictEqual(
			parseHealthArgs([
				"inspect",
				"--target",
				"codex",
				"--descriptor",
				hash,
				"--public-configuration-epoch",
				hash,
				"--repair-epoch",
				"0",
			]).action,
			"inspect",
		);
		strictEqual(
			parseHealthArgs([
				"attest-repair",
				"--target",
				"codex",
				"--descriptor",
				hash,
				"--public-configuration-epoch",
				hash,
				"--repair-kind",
				"auth_repaired",
			]).repairKind,
			"auth_repaired",
		);
	});
});
describe("CLI queue-level platform selection", () => {
	it("runs the macOS queue path through a VM helper without Docker workspace calls", async () => {
		writeFileSync(
			tasksFile,
			"### Task 1.1: Already complete\n- **Status:** done\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** src/a.mjs\n- **Description:** fixture\n",
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
								readiness: () => ({ inventoryCount: 0 }),
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

	it("USAGE_VALIDATE_INPUTS names the validation command and JSON behavior", () => {
		ok(USAGE_VALIDATE_INPUTS.includes("validate-inputs <tasks.md>"));
		ok(USAGE_VALIDATE_INPUTS.includes("--dirty-overlay"));
		ok(USAGE_VALIDATE_INPUTS.includes("output is always one JSON object"));
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
		ok(USAGE_RECOVER.includes("report-only"));
		ok(USAGE_RECOVER.includes("runLiveness"));
		ok(USAGE_RECOVER.includes("global project-lock cleanup"));
	});
});
describe("CLI exit codes via process spawn", () => {
	it("--version prints the package version independently of cwd", () => {
		const packageVersion = JSON.parse(
			readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
		).version;
		strictEqual(packageVersion, "0.3.0");
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

	it("remediate-orphaned-locks reads a supplied state root dry without mutation and rejects invalid flags", async () => {
		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["task-1"],
			initialHostFingerprint: { git: "abc123", worktree: "clean" },
			launchArgs: [],
		});
		await advanceState(runId, "failed");
		await acquireProjectLock(projectDir, runId);
		const lockName = `${createHash("sha256")
			.update(`project:${resolve(projectDir)}`)
			.digest("hex")}.lock`;
		const lockPath = join(stateRoot, "locks", lockName);
		const before = readFileSync(lockPath, "utf8");

		const dryRun = runDispatch(
			["remediate-orphaned-locks", "--dry-run", "--state-root", stateRoot],
			makeStateRootEnv(),
		);
		strictEqual(dryRun.status, 0);
		ok(dryRun.stdout.includes(runId));
		strictEqual(readFileSync(lockPath, "utf8"), before);

		const invalid = runDispatch(
			["remediate-orphaned-locks", "--unknown-remediation-flag"],
			makeStateRootEnv(),
		);
		strictEqual(invalid.status, 2);
	});
});
