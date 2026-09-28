import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checkpointRemediation } from "../src/switchyard/adapter/exec-error.mjs";
import {
	runDispatch as dispatchRun,
	handleLaunch,
	markLauncherReadyIfLaunching,
	parseDispatchArgs,
} from "../src/switchyard/dispatch/index.mjs";
import { releaseProjectLockIfOwnedBy } from "../src/switchyard/run-store/index.mjs";
import {
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

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
	it("rejects directory and symlink Files entries identically before run initialization", () => {
		mkdirSync(join(projectDir, "existing-dir"), { recursive: true });
		symlinkSync("existing-dir", join(projectDir, "existing-link"));
		mkdirSync(join(projectDir, "outside"), { recursive: true });
		symlinkSync("outside", join(projectDir, "linked-dir"));
		for (const invalidPath of [
			"existing-dir",
			"existing-link",
			"linked-dir/future.mjs",
		]) {
			writeFileSync(
				tasksFile,
				`### Task 1.1: Invalid\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** ${invalidPath}\n- **Description:** invalid\n`,
				"utf8",
			);
			for (const command of ["run", "launch"]) {
				const human = runDispatch(
					[command, tasksFile, "--project", projectDir],
					makeStateRootEnv(),
				);
				strictEqual(human.status, 2);
				ok(
					human.stderr.includes("Files entry must name a regular file") ||
						human.stderr.includes("must not traverse a symlink directory"),
				);
				const json = runDispatch(
					[command, tasksFile, "--project", projectDir, "--json"],
					makeStateRootEnv(),
				);
				strictEqual(json.status, 2);
				const envelope = JSON.parse(json.stdout.trim());
				strictEqual(envelope.disposition.reasonCode, "queue_contract_invalid");
				strictEqual(
					envelope.disposition.diagnosticCode,
					"queue_contract_invalid",
				);
				ok(!existsSync(join(stateRoot, "runs")));
				ok(!existsSync(join(stateRoot, "locks")));
			}
		}
	});
	it("rejects invalid Files before injected queue or detached spawn seams", async () => {
		mkdirSync(join(projectDir, "existing-dir"), { recursive: true });
		symlinkSync("existing-dir", join(projectDir, "existing-link"));
		mkdirSync(join(projectDir, "intermediate"), { recursive: true });
		symlinkSync("intermediate", join(projectDir, "intermediate-link"));
		let queueCalls = 0;
		let spawnCalls = 0;
		for (const invalidPath of [
			"existing-dir",
			"existing-link",
			"intermediate-link/future.mjs",
		]) {
			writeFileSync(
				tasksFile,
				`### Task 1.1: Invalid\n- **Status:** pending\n- **Executor:** switchyard\n- **Quick checks:** none\n- **Files:** ${invalidPath}\n- **Description:** invalid\n`,
				"utf8",
			);
			await rejects(
				() =>
					dispatchRun(parseDispatchArgs([tasksFile, "--project", projectDir]), {
						runQueue: () => {
							queueCalls += 1;
							throw new Error("queue should not run");
						},
					}),
				/Files entry|symlink directory/,
			);
			const { envelope } = await captureLaunchJson(
				[tasksFile, "--project", projectDir, "--json"],
				{
					spawn: () => {
						spawnCalls += 1;
						throw new Error("spawn should not run");
					},
				},
			);
			strictEqual(envelope.disposition.reasonCode, "queue_contract_invalid");
		}
		strictEqual(queueCalls, 0);
		strictEqual(spawnCalls, 0);
		ok(!existsSync(join(stateRoot, "runs")));
		ok(!existsSync(join(stateRoot, "locks")));
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
	it("run --json classifies a malformed queue as a contract failure", () => {
		const badTasksFile = join(dir, "bad-capability-tasks.md");
		writeFileSync(
			badTasksFile,
			"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n" +
				"- **RequiredCapability:** verify\n- **Files:** src/a.mjs\n- **Description:** A test\n",
			"utf8",
		);
		const result = runDispatch(
			["run", badTasksFile, "--project", projectDir, "--json"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 2);
		const envelope = JSON.parse(result.stdout.trim().split("\n").at(-1));
		strictEqual(envelope.disposition.action, "repair_contract");
		strictEqual(envelope.disposition.direction, "repair_input");
		strictEqual(envelope.disposition.reasonCode, "queue_contract_invalid");
		// The classified cause used to arrive as null, which told the caller a
		// classified contract failure had no classified cause.
		strictEqual(envelope.disposition.diagnosticCode, "queue_contract_invalid");
	});
	it("run names the malformed queue field instead of blaming the host", () => {
		const badTasksFile = join(dir, "bad-capability-human-tasks.md");
		writeFileSync(
			badTasksFile,
			"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n" +
				"- **RequiredCapability:** verify\n- **Files:** src/a.mjs\n- **Description:** A test\n",
			"utf8",
		);
		const result = runDispatch(
			["run", badTasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 2);
		ok(
			result.stderr.includes(
				'Task 1.1: invalid RequiredCapability field "verify"',
			),
			`expected the parse error on stderr, got: ${result.stderr}`,
		);
		ok(
			!result.stderr.includes("run-store initialization failed"),
			"a caller contract failure must not be reported as a run-store failure",
		);
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
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(envelope.runId);
		strictEqual(run.startedAt, null);
		ok(typeof run.finishedAt === "string");
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
		// Keep the launcher child test-owned. A real detached worker can overwrite
		// the injected terminal diagnosis before the status assertions run.
		const fakeChild = new EventEmitter();
		fakeChild.pid = 999999;
		fakeChild.unref = () => {};
		const launchLines = [];
		const originalLog = console.log;
		try {
			console.log = (line) => launchLines.push(line);
			await handleLaunch([tasksFile, "--project", projectDir, "--json"], {
				spawn: () => fakeChild,
			});
		} finally {
			console.log = originalLog;
		}
		const launchEnvelope = JSON.parse(launchLines.at(-1));
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
					reasonCode: "checkpoint_queue_identity_mismatch",
					reason: checkpointRemediation("checkpoint_queue_identity_mismatch", {
						dimensions: ["queueIdentity"],
					}),
					checkpointCode: "checkpoint_queue_identity_mismatch",
					checkpointDimensions: ["queueIdentity"],
					diagnosticCode: "checkpoint_queue_identity_mismatch",
					failurePhase: "adapter_validation",
				},
			},
			current.revision,
		);
		await releaseProjectLockIfOwnedBy(projectDir, launchEnvelope.runId);
		writeFileSync(`${tasksFile}.checkpoint.json`, "{unloadable", "utf8");
		const checkpointBytes = readFileSync(`${tasksFile}.checkpoint.json`);

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
			strictEqual(
				envelope.lastFailure.reason,
				checkpointRemediation("checkpoint_queue_identity_mismatch", {
					dimensions: ["queueIdentity"],
				}),
			);
			strictEqual(
				readFileSync(`${tasksFile}.checkpoint.json`).equals(checkpointBytes),
				true,
			);
		}
	});
});
