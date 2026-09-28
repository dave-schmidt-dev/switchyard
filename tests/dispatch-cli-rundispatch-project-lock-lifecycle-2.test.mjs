import { ok, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	runDispatch as dispatchRun,
	handleRun,
	parseDispatchArgs,
} from "../src/switchyard/dispatch/index.mjs";
import {
	DISPATCH_PATH,
	ROSTER_FIXTURE_PATH,
	runDispatch,
} from "./helpers/dispatch-cli-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

async function captureRunJson(args, dependencies = {}) {
	const output = [];
	const errors = [];
	const originalLog = console.log;
	const originalError = console.error;
	const originalExitCode = process.exitCode;
	let exitCode;
	console.log = (line) => output.push(String(line));
	console.error = (line) => errors.push(String(line));
	try {
		await handleRun(args, dependencies);
		exitCode = process.exitCode;
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
	return { envelope: JSON.parse(output[0]), errors, output, exitCode };
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
	async function dispatchWithStub(runQueueFn, extraDependencies = {}) {
		const opts = parseDispatchArgs([tasksFile, "--project", projectDir]);
		const savedExitCode = process.exitCode;
		try {
			await dispatchRun(opts, { runQueue: runQueueFn, ...extraDependencies });
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
	it("run --json fails closed and reports failed envelope on callback event persistence error", async () => {
		const { isProjectLockHeld, createEvent } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const secretCanary = "SECRET_CANARY_raw_json_write_failure_never_persisted";
		const { envelope, exitCode } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			{
				runQueue: async (queueOptions) => {
					const stub = stubResult(true);
					queueOptions.dependencies.onResult(stub.results[0]);
					return stub;
				},
				createEvent: (runId, event) => {
					if (event.phase === "execution") {
						throw new Error(`disk failure: ${secretCanary}`);
					}
					return createEvent(runId, event);
				},
			},
		);

		strictEqual(
			exitCode,
			1,
			"CLI --json must exit 1 on event persistence error",
		);
		strictEqual(envelope.state, "failed");
		strictEqual(envelope.cleanupState, "complete");
		strictEqual(envelope.lastTelemetryWriteFailure, "write_failed");
		strictEqual(envelope.telemetryWriteFailures, 1);
		ok(
			!isProjectLockHeld(projectDir),
			"project lock must be released after JSON persistence failure",
		);
		const run = await onlyRunRecord();
		strictEqual(run.state, "failed");
		strictEqual(run.cleanupState, "complete");
		ok(run.lastFailure);
		strictEqual(run.lastFailure.errorKind, "run_store_write_failed");
		strictEqual(run.lastFailure.diagnosticCode, "run_store_write_failed");
		strictEqual(run.lastTelemetryWriteFailure, "write_failed");

		const durable = JSON.stringify(run);
		ok(
			!durable.includes(secretCanary),
			"raw injected error text must not be in durable run record",
		);
		ok(
			!JSON.stringify(envelope).includes(secretCanary),
			"raw injected error text must not be in stdout JSON envelope",
		);
	});
	it("run --json records a reason when the queue resolves with nothing and never throws", async () => {
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const { envelope } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			{ runQueue: () => undefined },
		);
		const run = await readRun(envelope.runId);
		strictEqual(run.state, "failed");
		ok(
			run.lastFailure,
			"a failed run must always carry failure metadata, never null",
		);
		strictEqual(run.lastFailure.diagnosticCode, "queue_returned_no_result");
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
		strictEqual(run.startedAt, null);
		ok(typeof run.finishedAt === "string");

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
