import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import {
	runDispatch as dispatchRun,
	parseDispatchArgs,
} from "../src/switchyard/dispatch/index.mjs";
import { LockError } from "../src/switchyard/run-store/index.mjs";
import {
	CheckpointIdentityError,
	QueuePreflightError,
	TaskSelectionError,
} from "../src/switchyard/runner/index.mjs";
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
	it("preserves exported pre-provider triples through synchronous finalization", async () => {
		const taskIdCanary = "SECRET_TASK_ID_typed_failure";
		const blockerCanary = "SECRET_BLOCKER_typed_failure";
		const cases = [
			{
				error: new CheckpointIdentityError(
					"checkpoint_run_options_mismatch",
					null,
					{ dimensions: ["taskIds"] },
				),
				diagnosticCode: "checkpoint_run_options_mismatch",
				errorKind: "launch_failed",
				failurePhase: "worker_boot",
				action: "repair_contract",
				checkpointDimensions: ["taskIds"],
			},
			{
				error: new CheckpointIdentityError(
					"checkpoint_run_options_mismatch",
					null,
					{ dimensions: ["excludeProviders"] },
				),
				diagnosticCode: "checkpoint_run_options_mismatch",
				errorKind: "launch_failed",
				failurePhase: "worker_boot",
				action: "repair_contract",
				checkpointDimensions: ["excludeProviders"],
			},
			{
				error: new TaskSelectionError(taskIdCanary, blockerCanary),
				diagnosticCode: "task_selection_failed",
				errorKind: "task_selection_failed",
				failurePhase: "task_selection",
				action: "repair_contract",
			},
			{
				error: new QueuePreflightError(
					"preflight failed at /private/canary with raw provider output",
					{
						reason: "no_eligible",
						rejections: [
							{
								capability: "standard",
								reason: "no_provider",
								excludedProviders: ["claude"],
								excludedReasons: { claude: "no_invocation_descriptor" },
							},
						],
					},
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
			strictEqual(
				run.lastFailure.reasonCode,
				testCase.checkpointDimensions
					? "checkpoint_run_options_mismatch"
					: testCase.errorKind,
			);
			if (testCase.checkpointDimensions) {
				strictEqual(
					run.lastFailure.checkpointCode,
					"checkpoint_run_options_mismatch",
				);
				deepStrictEqual(
					run.lastFailure.checkpointDimensions,
					testCase.checkpointDimensions,
				);
				ok(
					run.lastFailure.reason.includes(
						`changed: ${testCase.checkpointDimensions[0]}.`,
					),
				);
				ok(run.lastFailure.reason.includes("switchyard-fresh.checkpoint.json"));
			}
			if (testCase.error instanceof QueuePreflightError) {
				deepStrictEqual(run.preflightDetail, testCase.error.preflightDetail);
			}
			const durable = JSON.stringify(run.lastFailure);
			ok(!durable.includes(taskIdCanary));
			ok(!durable.includes(blockerCanary));
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
	it("records the served-model verification on the synchronous run's task event", async () => {
		const { readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runsRoot = join(stateRoot, "runs");

		async function taskEventFor(extraResultFields) {
			const before = new Set(existsSync(runsRoot) ? readdirSync(runsRoot) : []);
			await dispatchWithStub((queueOptions) => {
				const stub = stubResult(true);
				stub.results[0] = { ...stub.results[0], ...extraResultFields };
				queueOptions.dependencies.onResult(stub.results[0]);
				return stub;
			});
			const runId = readdirSync(runsRoot).find((id) => !before.has(id));
			ok(runId, "the dispatch must create a run record");
			const events = await readEvents(runId);
			const event = events.find((e) => e.event === "task_completed");
			ok(event, "the run must record a task_completed event");
			return event;
		}

		strictEqual(
			(await taskEventFor({ servedModelVerified: true })).servedModelVerified,
			true,
		);
		strictEqual(
			(await taskEventFor({ servedModelVerified: false })).servedModelVerified,
			false,
		);
		const unsupported = await taskEventFor({});
		ok(
			!Object.hasOwn(unsupported, "servedModelVerified"),
			"an adapter that cannot report a served model must leave the field absent, not false",
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
	it("fails closed when run-store callback event persistence fails", async () => {
		const { isProjectLockHeld, createEvent } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const secretCanary =
			"SECRET_CANARY_raw_event_write_failure_never_persisted";
		const exitCode = await dispatchWithStub(
			(queueOptions) => {
				const stub = stubResult(true);
				queueOptions.dependencies.onResult(stub.results[0]);
				return stub;
			},
			{
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
			"CLI must report failure on event persistence error",
		);
		ok(
			!isProjectLockHeld(projectDir),
			"project lock must be released after persistence failure",
		);
		const run = await onlyRunRecord();
		strictEqual(run.state, "failed");
		strictEqual(run.cleanupState, "complete");
		ok(
			run.lastFailure,
			"durable failure metadata must be present on failed run",
		);
		strictEqual(run.lastFailure.errorKind, "run_store_write_failed");
		strictEqual(run.lastFailure.diagnosticCode, "run_store_write_failed");
		strictEqual(run.lastTelemetryWriteFailure, "write_failed");
		strictEqual(run.telemetryWriteFailures, 1);

		const durable = JSON.stringify(run);
		ok(
			!durable.includes(secretCanary),
			"raw injected error text must not be persisted into run record",
		);
	});
});
