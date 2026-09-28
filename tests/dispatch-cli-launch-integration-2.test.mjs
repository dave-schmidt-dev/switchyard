import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
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
describe("launch integration", () => {
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
