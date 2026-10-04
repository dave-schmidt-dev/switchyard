import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	__dirname,
	BOOTSTRAP_PATH,
	commandAvailable,
	PARALLELS_AQUA_UID,
	PARALLELS_GOLDEN_IMAGE,
	ROSTER_FIXTURE_PATH,
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
describe("detached worker event ordering", () => {
	it("persists the exact battery deferral through the real detached finalizer", async () => {
		const { initializeRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = randomUUID();
		const nonce = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["2.1"],
			initialHostFingerprint: "git:no-head:unknown",
			workerNonce: nonce,
			launchArgs: [],
		});

		const fakeRunnerPath = join(dir, "battery-fake-runner.mjs");
		writeFileSync(
			fakeRunnerPath,
			`export class QueueCleanupError extends Error {}
export async function runQueueAsync() {
  return {
    results: [],
    totalTasks: 1,
    runnableTasks: 1,
    processedTasks: 0,
    completedTaskIds: [],
    deferredTaskIds: ["2.1"],
    policyDeferred: {
      version: 1,
      action: "policy_deferred",
      direction: "advance_authorized_fallback",
      reasonCode: "host_on_battery",
      diagnosticCode: "host_on_battery",
      nextTaskId: "2.1",
      taskFileSha256: "${"a".repeat(64)}"
    }
  };
}
`,
			"utf8",
		);
		const loaderPath = join(dir, "battery-runner-loader.mjs");
		writeFileSync(
			loaderPath,
			`const target = process.env.SWITCHYARD_TEST_RUNNER_URL;
const replacement = process.env.SWITCHYARD_TEST_FAKE_RUNNER_URL;
export async function resolve(specifier, context, nextResolve) {
  const candidate = new URL(specifier, context.parentURL).href;
  if (candidate === target) return { url: replacement, shortCircuit: true };
  return nextResolve(specifier, context, nextResolve);
}
`,
			"utf8",
		);

		const worker = spawnSync(
			process.execPath,
			[
				"--experimental-loader",
				pathToFileURL(loaderPath).href,
				BOOTSTRAP_PATH,
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				nonce,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				env: {
					...process.env,
					...makeStateRootEnv(),
					SWITCHYARD_TEST_RUNNER_URL: pathToFileURL(
						resolve(__dirname, "../src/switchyard/runner/index.mjs"),
					).href,
					SWITCHYARD_TEST_FAKE_RUNNER_URL: pathToFileURL(fakeRunnerPath).href,
				},
			},
		);

		strictEqual(worker.status, 0, worker.stderr);
		const run = await readRun(runId);
		strictEqual(run.state, "deferred");
		strictEqual(run.cleanupState, "complete");
		deepStrictEqual(run.policyDeferred, {
			version: 1,
			action: "policy_deferred",
			direction: "advance_authorized_fallback",
			reasonCode: "host_on_battery",
			diagnosticCode: "host_on_battery",
			nextTaskId: "2.1",
			taskFileSha256: "a".repeat(64),
		});
		const disposition = projectDisposition({ run });
		strictEqual(disposition.action, "policy_deferred");
		strictEqual(disposition.direction, "advance_authorized_fallback");
		strictEqual(disposition.reasonCode, "host_on_battery");
		strictEqual(disposition.diagnosticCode, "host_on_battery");
		strictEqual(disposition.taskId, "2.1");
		strictEqual(disposition.taskFileSha256, "a".repeat(64));
	});
	for (const outcome of [
		{
			label: "completed",
			success: true,
			event: "task_completed",
			result: "review_completed",
			verdict:
				'{ verdict: "approved", summary: "one finding raised", findings: [{ severity: "medium", title: "unbounded receipt reuse", path: "src/switchyard/dispatch/index.mjs", line: 12 }], comments: [], rawOutput: "SECRET_CANARY_REVIEW_OUTPUT" }',
			expected: { status: "available", verdict: "findings", findingCount: 1 },
		},
		{
			label: "failed",
			success: false,
			event: "task_failed",
			result: "review_unavailable",
			verdict:
				'{ verdict: "unknown", reason: "provider_failed", rawOutput: "SECRET_CANARY_REVIEW_OUTPUT" }',
			expected: {
				status: "unavailable",
				verdict: "unavailable",
				findingCount: 0,
			},
		},
	])
		it(`carries a review verdict onto the detached ${outcome.label} event`, async () => {
			const { initializeRun, readEvents, readRun } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			const runId = randomUUID();
			const nonce = randomUUID();
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "git:no-head:unknown",
				workerNonce: nonce,
				launchArgs: [],
			});

			const fakeRunnerPath = join(
				dir,
				`review-fake-runner-${outcome.label}.mjs`,
			);
			writeFileSync(
				fakeRunnerPath,
				`export class QueueCleanupError extends Error {}
export async function runQueueAsync(options) {
  const dependencies = options.dependencies;
  const outcome = {
    taskId: "1.1",
    success: ${outcome.success},
    result: "${outcome.result}",
    provider: "opencode",
    model: "fake-model",
    reviewResult: ${outcome.verdict},
  };
  dependencies.onResult?.(outcome);
  return {
    success: ${outcome.success},
    totalTasks: 1,
    runnableTasks: 1,
    processedTasks: 1,
    completedTaskIds: ${outcome.success ? '["1.1"]' : "[]"},
    deferredTaskIds: [],
    results: [outcome],
  };
}
`,
				"utf8",
			);
			const loaderPath = join(dir, `review-runner-loader-${outcome.label}.mjs`);
			writeFileSync(
				loaderPath,
				`const target = process.env.SWITCHYARD_TEST_RUNNER_URL;
const replacement = process.env.SWITCHYARD_TEST_FAKE_RUNNER_URL;
export async function resolve(specifier, context, nextResolve) {
  const candidate = new URL(specifier, context.parentURL).href;
  if (candidate === target) return { url: replacement, shortCircuit: true };
  return nextResolve(specifier, context, nextResolve);
}
`,
				"utf8",
			);

			const worker = spawnSync(
				process.execPath,
				[
					"--experimental-loader",
					pathToFileURL(loaderPath).href,
					BOOTSTRAP_PATH,
					"--state-root",
					stateRoot,
					"--run-id",
					runId,
					"--nonce",
					nonce,
				],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 10_000,
					env: {
						...process.env,
						...makeStateRootEnv(),
						SWITCHYARD_TEST_RUNNER_URL: pathToFileURL(
							resolve(__dirname, "../src/switchyard/runner/index.mjs"),
						).href,
						SWITCHYARD_TEST_FAKE_RUNNER_URL: pathToFileURL(fakeRunnerPath).href,
					},
				},
			);

			strictEqual(worker.status, 0, worker.stderr);
			const events = await readEvents(runId);
			const terminal = events.find((event) => event.event === outcome.event);
			ok(terminal, `no ${outcome.event} event: ${JSON.stringify(events)}`);
			strictEqual(terminal.reviewResult.status, outcome.expected.status);
			strictEqual(terminal.reviewResult.verdict, outcome.expected.verdict);
			strictEqual(
				terminal.reviewResult.findingCount,
				outcome.expected.findingCount,
			);
			strictEqual(terminal.reviewResult.sourceMutationCount, 0);
			// Projection is by approved key, so an unapproved provider field on
			// the verdict is dropped rather than carried into durable state.
			strictEqual(terminal.reviewResult.rawOutput, undefined);
			const run = await readRun(runId);
			strictEqual(run.lastReviewResult?.verdict, outcome.expected.verdict);
			strictEqual(
				run.lastReviewResult?.findingCount,
				outcome.expected.findingCount,
			);
			strictEqual(
				JSON.stringify(run).includes("SECRET_CANARY_REVIEW_OUTPUT"),
				false,
			);
		});
});
