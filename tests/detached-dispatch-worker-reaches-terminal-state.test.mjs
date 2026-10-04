import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import {
	__dirname,
	BOOTSTRAP_PATH,
	pollStatus,
	ROSTER_FIXTURE_PATH,
	runDispatch,
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
async function launchAndGetRunId() {
	const result = runDispatch(
		["launch", tasksFile, "--project", projectDir],
		makeStateRootEnv(),
	);
	strictEqual(result.status, 0, `launch failed: ${result.stderr}`);
	const envelope = JSON.parse(result.stdout.trim());
	ok(typeof envelope.runId === "string" && envelope.runId.length > 0);
	return envelope.runId;
}
describe("worker reaches terminal state and result is readable", () => {
	it("does not stamp startedAt while the provider queue is still loading", async () => {
		const { initializeRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = randomUUID();
		const nonce = `delayed-import-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "git:no-head:unknown",
			workerNonce: nonce,
			launchArgs: [],
		});

		const markerPath = join(dir, "runner-imported.marker");
		const fakeRunnerPath = join(dir, "delayed-import-runner.mjs");
		writeFileSync(
			fakeRunnerPath,
			`import { writeFileSync } from "node:fs";
writeFileSync(process.env.SWITCHYARD_TEST_IMPORT_MARKER, "loaded", "utf8");
await new Promise((resolve) => setTimeout(resolve, 1000));
export class QueueCleanupError extends Error {}
export async function runQueueAsync() {
  return {
    success: true,
    totalTasks: 1,
    runnableTasks: 1,
    processedTasks: 0,
    completedTaskIds: [],
    deferredTaskIds: [],
    results: [],
  };
}
`,
			"utf8",
		);
		const loaderPath = join(dir, "delayed-import-runner-loader.mjs");
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
		const runner = spawn(
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
				stdio: ["ignore", "ignore", "ignore"],
				env: {
					...process.env,
					...makeStateRootEnv(),
					SWITCHYARD_TEST_IMPORT_MARKER: markerPath,
					SWITCHYARD_TEST_RUNNER_URL: pathToFileURL(
						resolve(__dirname, "../src/switchyard/runner/index.mjs"),
					).href,
					SWITCHYARD_TEST_FAKE_RUNNER_URL: pathToFileURL(fakeRunnerPath).href,
				},
			},
		);

		let observedPreExecutionState = false;
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			if (existsSync(markerPath)) {
				const snapshot = await readRun(runId);
				if (snapshot.workerPid !== null) {
					strictEqual(snapshot.startedAt, null);
					observedPreExecutionState = true;
					break;
				}
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		}
		ok(
			observedPreExecutionState,
			"worker must remain pre-execution while runner import is pending",
		);

		const exit = await new Promise((resolveExit, rejectExit) => {
			const timer = setTimeout(
				() => rejectExit(new Error("delayed runner worker timed out")),
				5_000,
			);
			runner.once("error", rejectExit);
			runner.once("exit", (code, signal) => {
				clearTimeout(timer);
				resolveExit({ code, signal });
			});
		});
		strictEqual(exit.code, 0, `worker exit: ${JSON.stringify(exit)}`);
		const terminal = await readRun(runId);
		ok(typeof terminal.startedAt === "string");
	});

	it("worker runs against a real run and eventually reaches a terminal state", async () => {
		const runId = await launchAndGetRunId();

		let terminalReached = false;
		let terminalStatus = null;
		const start = Date.now();
		const maxWait = 15_000;

		while (Date.now() - start < maxWait) {
			const statusResult = pollStatus(runId, makeStateRootEnv());
			if (statusResult.status !== 0) {
				await new Promise((r) => setTimeout(r, 500));
				continue;
			}
			const status = JSON.parse(statusResult.stdout.trim());

			if (status.state === "succeeded" || status.state === "failed") {
				terminalStatus = status;
				terminalReached = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 500));
		}

		ok(terminalReached, "run did not reach terminal state within timeout");

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 1, "result exits 1 for failed run");

		const result = JSON.parse(resultResult.stdout.trim());
		ok(
			terminalStatus?.outcomeShadow,
			"detached status carries shadow evidence",
		);
		deepStrictEqual(
			terminalStatus.outcomeShadow,
			result.outcomeShadow,
			"detached status/result shadow parity",
		);
		deepStrictEqual(
			terminalStatus.disposition.outcomeShadow,
			result.disposition.outcomeShadow,
			"detached disposition carries the same shadow evidence",
		);
		ok(result.terminalSummary !== null, "terminalSummary present");
		ok(Array.isArray(result.artifactRefs), "artifactRefs is an array");
		ok(typeof result.startedAt === "string", "startedAt present");
		ok(typeof result.finishedAt === "string", "finishedAt present");
		ok(Date.parse(result.startedAt) <= Date.parse(result.finishedAt));

		// A completed run leaves no empty artifacts/ behind. The channel has had
		// no writer since the partial-diff copy was removed for INV-2, and every
		// run provisioning one anyway is what accumulated 81 empty directories in
		// the consuming project by 2026-09-04. listArtifactRefs reads the same
		// absent path to produce the array asserted just above, so this is the
		// end-to-end proof that absence costs the result envelope nothing.
		ok(
			!existsSync(resolve(stateRoot, "runs", runId, "artifacts")),
			"a real run must not leave an empty artifacts directory",
		);
		strictEqual(result.dispatchContractVersion, 1);
		if (result.lastTaskDescriptorIdentity !== null) {
			ok(
				/^sha256:[a-f0-9]{64}$/.test(result.lastTaskDescriptorIdentity),
				"terminal result preserves the routed descriptor identity",
			);
			strictEqual(
				result.lastTaskInvocationDescriptor.descriptor_identity,
				result.lastTaskDescriptorIdentity,
			);
		}
	});
});
describe("detached descriptor receipt parity", () => {
	it("preserves a descriptor identity from run-store event/overlay into status and result", async () => {
		const { initializeRun, updateRun, createEvent } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const descriptorCore = {
			target_id: "claude-code",
			model_ref: "fixture/claude-standard",
			selector: "fixture-claude-standard",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const descriptor = {
			...descriptorCore,
			descriptor_identity: getInvocationDescriptorIdentity(
				descriptorCore,
				"claude",
			),
		};
		const runId = `receipt-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "fixture",
		});
		await updateRun(
			runId,
			{
				state: "succeeded",
				cleanupState: "complete",
				lastTaskInvocationDescriptor: descriptor,
				lastTaskDescriptorIdentity: descriptor.descriptor_identity,
				lastTaskDescriptorHarness: "claude",
				lastResolvedTargetId: descriptor.target_id,
			},
			1,
		);
		await createEvent(runId, {
			phase: "execution",
			event: "task_completed",
			status: "Task 1.1 completed",
			taskId: "1.1",
			invocationDescriptor: descriptor,
			descriptorIdentity: descriptor.descriptor_identity,
			descriptorHarness: "claude",
			resolvedTargetId: descriptor.target_id,
		});

		const status = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(status.status, 0);
		const statusEnvelope = JSON.parse(status.stdout.trim());
		strictEqual(
			statusEnvelope.lastTaskDescriptorIdentity,
			descriptor.descriptor_identity,
		);
		const result = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(result.status, 0);
		const resultEnvelope = JSON.parse(result.stdout.trim());
		strictEqual(
			resultEnvelope.lastTaskDescriptorIdentity,
			descriptor.descriptor_identity,
		);
		strictEqual(
			resultEnvelope.lastTaskInvocationDescriptor.descriptor_identity,
			descriptor.descriptor_identity,
		);
	});

	it("rejects unsafe argv, mismatched identities, and invalid event versions", async () => {
		const { initializeRun, updateRun, createEvent } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const descriptorCore = {
			target_id: "claude-code",
			model_ref: "fixture/claude-standard",
			selector: "fixture-claude-standard",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const descriptor = {
			...descriptorCore,
			descriptor_identity: getInvocationDescriptorIdentity(
				descriptorCore,
				"claude",
			),
		};
		const runId = `receipt-invalid-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "fixture",
		});

		await rejects(
			updateRun(
				runId,
				{
					lastTaskInvocationDescriptor: descriptor,
					lastTaskDescriptorIdentity: `sha256:${"0".repeat(64)}`,
					lastTaskDescriptorHarness: "claude",
					lastResolvedTargetId: descriptor.target_id,
				},
				1,
			),
			/does not match/,
		);
		await rejects(
			updateRun(
				runId,
				{
					lastTaskInvocationDescriptor: {
						...descriptor,
						invocation_args: ["--prompt", "secret-token"],
					},
					lastTaskDescriptorHarness: "claude",
					lastResolvedTargetId: descriptor.target_id,
				},
				1,
			),
			/invalid descriptor receipt/,
		);
		await rejects(
			createEvent(runId, {
				phase: "execution",
				event: "task_completed",
				status: "complete",
				invocationDescriptor: descriptor,
				descriptorIdentity: `sha256:${"0".repeat(64)}`,
				descriptorHarness: "claude",
				resolvedTargetId: descriptor.target_id,
				dispatchContractVersion: 1,
			}),
			/event descriptorIdentity does not match invocationDescriptor/,
		);
		await rejects(
			createEvent(runId, {
				phase: "execution",
				event: "task_completed",
				status: "complete",
				dispatchContractVersion: 0,
			}),
			/event dispatchContractVersion must be a positive integer/,
		);
	});
});
