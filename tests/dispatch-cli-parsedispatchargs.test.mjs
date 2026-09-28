import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseDispatchArgs } from "../src/switchyard/dispatch/index.mjs";
import { ROSTER_FIXTURE_PATH } from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
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

	it("bounds a qualification attempt to one selected provider and task", () => {
		const opts = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--qualification-attempt",
			"--only-provider",
			"vibe",
			"--task-id",
			"1.1",
		]);
		strictEqual(opts.qualificationAttempt, true);
		strictEqual(opts.maxTasks, 1);
	});

	it("rejects an unscoped qualification attempt before provider allocation", () => {
		strictEqual(
			(() => {
				try {
					parseDispatchArgs([
						tasksFile,
						"--project",
						projectDir,
						"--qualification-attempt",
					]);
					return false;
				} catch (error) {
					return error.message.includes("exactly one --only-provider");
				}
			})(),
			true,
		);
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
