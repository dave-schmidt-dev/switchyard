import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	__dirname,
	BOOTSTRAP_PATH,
	ROSTER_FIXTURE_PATH,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

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
	it("persists only stages reached before a real worker SIGTERM", async () => {
		const { initializeRun, readEvents, readRun, resolveDiagnosticArtifact } =
			await import("../src/switchyard/run-store/index.mjs");
		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "git:no-head:unknown",
			workerNonce: "ordered-worker-nonce",
			launchArgs: [],
		});

		// Replace only the worker's dynamically imported runner in this child.
		// The worker bootstrap, run-store, write chain, signal handler, and
		// finalizer remain production modules, so the fixture exercises the real
		// detached process boundary without a VM or provider call.
		const fakeRunnerPath = join(dir, "ordered-fake-runner.mjs");
		writeFileSync(
			fakeRunnerPath,
			`export class QueueCleanupError extends Error {}
export async function runQueueAsync(options) {
  const dependencies = options.dependencies;
  const keepAlive = setInterval(() => {}, 1000);
  const transientCorpus = [
    "SECRET_CANARY_PROVIDER_OUTPUT",
    "/private/tmp/host-path-canary",
    "PROMPT_CANARY_should_not_persist",
    "RAW_OVERSIZED_".repeat(4096),
  ];
  void transientCorpus;
  const emit = (event, status, phase = "execution", taskId = undefined) =>
    dependencies.onStatus?.({ phase, event, status, ...(taskId ? { taskId } : {}) });
  emit("aqua_ready", "Aqua session ready", "bootstrap");
  emit("container_created", "Working container created", "bootstrap");
  dependencies.onTaskStart?.({ id: "1.1" });
  dependencies.onTaskRouted?.({
    provider: "opencode",
    model: "fake-model",
    deadline: null,
    resolvedTargetId: "fake-target",
    invocationDescriptor: null,
    descriptorIdentity: null,
    descriptorHarness: "opencode",
  });
  emit("task_routed", "Task 1.1 routed", "execution", "1.1");
  const diagnosticRef = await dependencies.persistDiagnosticArtifact?.({
    stdoutBytes: 1024,
    stderrBytes: 2048,
    stdoutDigest: "sha256:" + "b".repeat(64),
    stderrDigest: "sha256:" + "c".repeat(64),
    diagnosticKind: "auth_required",
  });
  const failure = {
    taskId: "1.1",
    success: false,
    result: "execution_failed",
    provider: "opencode",
    model: "fake-model",
    errorKind: "auth_expired",
    diagnosticCode: "auth_expired",
    failurePhase: "provider_execution",
    diagnosticOrigin: "adapter",
    diagnosticEvidenceAvailable: diagnosticRef !== null,
    diagnosticRef: diagnosticRef ?? null,
  };
  dependencies.onResult?.(failure);
  await new Promise((resolve) => {
    if (dependencies.signal?.aborted) return resolve();
    dependencies.signal?.addEventListener("abort", resolve, { once: true });
  });
  clearInterval(keepAlive);
  return {
    success: false,
    totalTasks: 1,
    runnableTasks: 1,
    processedTasks: 1,
    completedTaskIds: [],
    deferredTaskIds: [],
    results: [failure],
  };
}
`,
			"utf8",
		);
		const loaderPath = join(dir, "ordered-runner-loader.mjs");
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

		const worker = spawn(
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
				"ordered-worker-nonce",
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
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
		let workerStdout = "";
		let workerStderr = "";
		worker.stdout.on("data", (chunk) => {
			workerStdout += chunk.toString();
		});
		worker.stderr.on("data", (chunk) => {
			workerStderr += chunk.toString();
		});
		worker.stdout.resume();
		worker.stderr.resume();

		let stagedEvents = [];
		const stageDeadline = Date.now() + 5_000;
		while (Date.now() < stageDeadline) {
			try {
				stagedEvents = await readEvents(runId);
			} catch {}
			if (stagedEvents.some((event) => event.event === "container_created"))
				break;
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		}
		ok(
			stagedEvents.some((event) => event.event === "container_created"),
			`worker did not reach the staged event boundary: ${JSON.stringify(stagedEvents)}`,
		);
		ok(
			worker.kill("SIGTERM"),
			`worker exited before SIGTERM; stdout=${workerStdout} stderr=${workerStderr}`,
		);

		const exit = await new Promise((resolveExit, rejectExit) => {
			const timer = setTimeout(
				() =>
					rejectExit(new Error("ordered worker did not exit after SIGTERM")),
				5_000,
			);
			worker.once("error", rejectExit);
			worker.once("exit", (code, signal) => {
				clearTimeout(timer);
				resolveExit({ code, signal });
			});
		});
		strictEqual(exit.code, 0, `worker exit: ${JSON.stringify(exit)}`);

		const events = await readEvents(runId);
		const legacyEvents = events.filter(
			(event) => typeof event.event === "string",
		);
		deepStrictEqual(
			legacyEvents.map((event) => event.event),
			[
				"aqua_ready",
				"container_created",
				"task_routed",
				"task_failed",
				"run_failed",
			],
		);
		strictEqual(
			events.every((event, index) => event.sequence === index + 1),
			true,
		);
		const typedStages = events
			.filter((event) => typeof event.stage === "string")
			.map((event) => event.stage);
		deepStrictEqual(typedStages, [
			"worker",
			"run",
			"cleanup",
			"cleanup",
			"run",
			"postcondition",
		]);
		strictEqual((await readRun(runId)).state, "failed");
		const failedEvent = events.find((event) => event.event === "task_failed");
		strictEqual(failedEvent.diagnosticEvidenceAvailable, true);
		ok(/^diagnostic:[a-f0-9]{32}$/u.test(failedEvent.diagnosticRef));
		const artifact = await resolveDiagnosticArtifact(
			runId,
			failedEvent.diagnosticRef,
		);
		strictEqual(artifact?.kind, "provider_diagnostic");
		const resourcesRoot = resolve(stateRoot, "runs", runId, "resources");
		const resourceFiles = readdirSync(resourcesRoot, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => resolve(resourcesRoot, entry.name));
		strictEqual(resourceFiles.length, 1);
		const runRoot = resolve(stateRoot, "runs", runId);
		const corpus = [
			"SECRET_CANARY_PROVIDER_OUTPUT",
			"/private/tmp/host-path-canary",
			"PROMPT_CANARY_should_not_persist",
			"RAW_OVERSIZED_",
		];
		const bytes = [];
		const scan = (path) => {
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				const child = resolve(path, entry.name);
				if (entry.isDirectory()) scan(child);
				else if (entry.isFile()) bytes.push(readFileSync(child));
			}
		};
		scan(runRoot);
		const durableBytes = Buffer.concat(bytes).toString("utf8");
		for (const canary of corpus) ok(!durableBytes.includes(canary), canary);
	});
});
