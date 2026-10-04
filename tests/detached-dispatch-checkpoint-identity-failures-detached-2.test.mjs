import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checkpointRemediation } from "../src/switchyard/adapter/exec-error.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	commandAvailable,
	PARALLELS_AQUA_UID,
	PARALLELS_GOLDEN_IMAGE,
	ROSTER_FIXTURE_PATH,
	runBootstrap,
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
describe("checkpoint identity failures on detached worker path (Task 1.3)", () => {
	it("five checkpoint identity regressions emit distinct static codes on the worker-fatal path", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { normalizeRunOptions, createQueueIdentity, loadTaskQueue } =
			await import("../src/switchyard/runner/index.mjs");

		const checkpointPath = `${tasksFile}.checkpoint.json`;
		const tasks = loadTaskQueue(tasksFile);
		const runOptions = normalizeRunOptions({
			checkpointPath,
			maxTasks: 1,
			stopOnFailure: true,
		});
		const mismatchedRunOptions = normalizeRunOptions({
			checkpointPath,
			maxTasks: 2,
			stopOnFailure: true,
		});
		const taskIdsRunOptions = normalizeRunOptions({
			checkpointPath,
			maxTasks: 1,
			taskIds: ["9.9"],
			stopOnFailure: true,
		});
		const excludeProvidersRunOptions = normalizeRunOptions({
			checkpointPath,
			maxTasks: 1,
			excludeProviders: ["claude"],
			stopOnFailure: true,
		});

		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksFile,
			markdown: readFileSync(tasksFile, "utf8"),
			tasks,
			projectRevision: "rev-1",
			runOptions,
		});
		const mismatchedQueueIdentity = "f".repeat(64);

		const cases = [
			{
				name: "task-file mismatch",
				expectedCode: "checkpoint_task_file_mismatch",
				dimensions: ["tasksFilePath"],
				checkpoint: {
					version: 2,
					tasksFilePath: "/other/path/tasks.md",
					queueIdentity,
					runOptions,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "missing queue identity",
				expectedCode: "checkpoint_missing_queue_identity",
				dimensions: ["queueIdentity"],
				checkpoint: {
					version: 2,
					tasksFilePath: tasksFile,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "queue-identity mismatch",
				expectedCode: "checkpoint_queue_identity_mismatch",
				dimensions: ["queueIdentity"],
				checkpoint: {
					version: 2,
					tasksFilePath: tasksFile,
					queueIdentity: mismatchedQueueIdentity,
					runOptions,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "run-options mismatch",
				expectedCode: "checkpoint_run_options_mismatch",
				dimensions: ["maxTasks"],
				checkpoint: {
					version: 2,
					tasksFilePath: tasksFile,
					queueIdentity,
					runOptions: mismatchedRunOptions,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "taskIds option mismatch",
				expectedCode: "checkpoint_run_options_mismatch",
				dimensions: ["taskIds"],
				checkpoint: {
					version: 2,
					tasksFilePath: tasksFile,
					queueIdentity,
					runOptions: taskIdsRunOptions,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "excludeProviders option mismatch",
				expectedCode: "checkpoint_run_options_mismatch",
				dimensions: ["excludeProviders"],
				checkpoint: {
					version: 2,
					tasksFilePath: tasksFile,
					queueIdentity,
					runOptions: excludeProvidersRunOptions,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
			{
				name: "historical checkpoint",
				expectedCode: "checkpoint_historical_checkpoint",
				dimensions: ["checkpointVersion"],
				checkpoint: {
					version: 1,
					tasksFilePath: tasksFile,
					completedTaskIds: [],
					results: [],
				},
				runOptions,
				queueIdentity,
			},
		];

		const observedCodes = new Set();

		for (const testCase of cases) {
			const runId = randomUUID();
			const nonce = randomUUID();
			const providerCanary = "PROVIDER_OUTPUT_CANARY_identity_failure";
			testCase.checkpoint.providerOutput = providerCanary;

			writeFileSync(
				checkpointPath,
				JSON.stringify(testCase.checkpoint),
				"utf8",
			);
			const checkpointBytes = readFileSync(checkpointPath);

			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: nonce,
				launchArgs: [],
				queueIdentity: testCase.queueIdentity,
				projectRevision: "rev-1",
				runOptions: testCase.runOptions,
			});

			const result = runBootstrap(
				["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
				makeStateRootEnv(),
			);

			strictEqual(
				result.status,
				1,
				`${testCase.name} expected exit 1, got ${result.status}: ${result.stderr}`,
			);

			const events = await readEvents(runId);
			const bootFailed = events.find((e) => e.event === "worker_boot_failed");
			ok(bootFailed, `${testCase.name}: worker_boot_failed event recorded`);
			strictEqual(
				bootFailed.phase,
				"worker",
				`${testCase.name} phase mismatch`,
			);
			strictEqual(
				bootFailed.event,
				"worker_boot_failed",
				`${testCase.name} event mismatch`,
			);
			strictEqual(
				bootFailed.status,
				testCase.expectedCode,
				`${testCase.name} status code mismatch`,
			);
			strictEqual(
				bootFailed.errorKind,
				"launch_failed",
				`${testCase.name} errorKind mismatch`,
			);
			strictEqual(
				bootFailed.reasonCode,
				testCase.expectedCode,
				`${testCase.name} reasonCode mismatch`,
			);
			strictEqual(
				bootFailed.diagnosticCode,
				testCase.expectedCode,
				`${testCase.name} diagnosticCode mismatch`,
			);
			strictEqual(
				bootFailed.failurePhase,
				"worker_boot",
				`${testCase.name} failurePhase mismatch`,
			);
			strictEqual(
				bootFailed.error,
				undefined,
				`${testCase.name} should not have raw error object`,
			);
			ok(
				!JSON.stringify(bootFailed).includes(projectDir),
				`${testCase.name} should not leak host paths`,
			);
			const expectedRemedy = checkpointRemediation(testCase.expectedCode, {
				dimensions: testCase.dimensions,
			});
			strictEqual(bootFailed.reason, expectedRemedy);
			ok(
				bootFailed.reason.includes(
					`changed: ${testCase.dimensions.join(", ")}.`,
				),
			);
			ok(bootFailed.reason.includes("switchyard-fresh.checkpoint.json"));
			ok(!JSON.stringify(bootFailed).includes(providerCanary));
			observedCodes.add(testCase.expectedCode);

			const run = await readRun(runId);
			ok(
				run.lastFailure !== null,
				`${testCase.name}: lastFailure populated in run.json`,
			);
			strictEqual(run.lastFailure.errorKind, "launch_failed");
			strictEqual(run.lastFailure.reasonCode, testCase.expectedCode);
			strictEqual(run.lastFailure.reason, expectedRemedy);
			strictEqual(run.lastFailure.checkpointCode, testCase.expectedCode);
			deepStrictEqual(
				run.lastFailure.checkpointDimensions,
				testCase.dimensions,
			);
			strictEqual(run.lastFailure.failurePhase, "worker_boot");
			ok(!JSON.stringify(run.lastFailure).includes(projectDir));
			ok(!JSON.stringify(run.lastFailure).includes(providerCanary));
			strictEqual(readFileSync(checkpointPath).equals(checkpointBytes), true);
		}

		strictEqual(observedCodes.size, 5, "five distinct static codes emitted");
	});
});
