import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
} from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import {
	formatRunAbort,
	handleRun,
	parseDispatchArgs,
} from "../src/switchyard/dispatch/index.mjs";
import { createDefaultRouteHealthDecision } from "../src/switchyard/router/health.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../src/switchyard/router/index.mjs";
import { TaskSelectionError } from "../src/switchyard/runner/index.mjs";
import { ROSTER_FIXTURE_PATH } from "./helpers/dispatch-cli-fixtures.mjs";
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
describe("run subcommand equivalence", () => {
	it("keeps bounded selection options available to preflight", () => {
		const parsed = parseDispatchArgs([
			tasksFile,
			"--project",
			projectDir,
			"--task-id",
			"1.1",
			"--max-tasks",
			"1",
		]);
		deepStrictEqual(parsed.taskIds, ["1.1"]);
		strictEqual(parsed.maxTasks, 1);
	});

	it("run subcommand parseDispatchArgs matches positional parseDispatchArgs", () => {
		const args = [tasksFile, "--project", projectDir, "--max-tasks", "5"];
		const positional = parseDispatchArgs(args);
		const subcommand = parseDispatchArgs(args);
		deepStrictEqual(positional, subcommand);
		strictEqual(positional.maxTasks, 5);
		strictEqual(subcommand.maxTasks, 5);
	});
});
describe("synchronous run JSON envelope", () => {
	function noVmDependencies(overrides = {}) {
		return {
			assertGenerationAllowed: () => {},
			releaseOrphanedProjectLocks: async () => [],
			reconcileProjectLockClaims: async () => [],
			executionBackend: {
				listManaged: () => [],
				reclaim: () => ({
					reclaimed: [],
					errors: [],
					skippedSnapshots: [],
				}),
			},
			...overrides,
		};
	}

	it("reports failed quick checks as a failed disposition", () => {
		const disposition = projectDisposition({
			run: {
				state: "failed",
				cleanupState: "complete",
				lastFailure: {
					errorKind: "check_failed",
					reasonCode: "check_failed",
				},
			},
		});
		strictEqual(disposition.action, "stop");
		strictEqual(disposition.reasonCode, "check_failed");
	});

	it("run --json exits failed for a Task 51 style check result", async () => {
		const { envelope, exitCode } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				runQueue: async () => ({
					totalTasks: 1,
					runnableTasks: 1,
					processedTasks: 1,
					completedTaskIds: [],
					results: [
						{
							taskId: "1.1",
							success: false,
							result: "check_failed",
							errorKind: "check_failed",
							reasonCode: "check_failed",
						},
					],
					checkpointPath: join(dir, "check-failed.checkpoint.json"),
				}),
			}),
		);
		strictEqual(exitCode, 1);
		strictEqual(envelope.state, "failed");
		strictEqual(envelope.terminalSummary.completedTaskIds.length, 0);
	});

	it("emits one result-compatible success envelope with an empty stderr", async () => {
		const { envelope, errors, output } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				runQueue: async () => ({
					totalTasks: 1,
					runnableTasks: 1,
					processedTasks: 1,
					completedTaskIds: ["1.1"],
					results: [{ taskId: "1.1", success: true, result: "success" }],
					checkpointPath: join(dir, "success.checkpoint.json"),
				}),
			}),
		);
		strictEqual(output.length, 1);
		deepStrictEqual(errors, []);
		ok(typeof envelope.runId === "string");
		strictEqual(envelope.state, "succeeded");
		strictEqual(envelope.cleanupState, "complete");
		strictEqual(envelope.disposition.action, "complete");
		strictEqual(envelope.disposition.direction, "complete");
	});

	it("emits deferred_work with exit 6 when selected work remains pending", async () => {
		const { envelope, errors, exitCode } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				runQueue: async () => ({
					totalTasks: 1,
					runnableTasks: 1,
					processedTasks: 0,
					completedTaskIds: [],
					deferredTaskIds: ["1.1"],
					results: [],
					checkpointPath: join(dir, "deferred.checkpoint.json"),
				}),
			}),
		);
		deepStrictEqual(errors, []);
		strictEqual(exitCode, 6);
		strictEqual(envelope.state, "deferred");
		strictEqual(envelope.disposition.action, "defer");
		strictEqual(envelope.disposition.reasonCode, "deferred_work");
		deepStrictEqual(envelope.terminalSummary.deferredTaskIds, ["1.1"]);
	});

	it("projects battery deferral with the next task and diagnostic", async () => {
		const { envelope, exitCode } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				runQueue: async () => ({
					totalTasks: 1,
					runnableTasks: 1,
					processedTasks: 0,
					completedTaskIds: [],
					deferredTaskIds: ["1.1"],
					policyDeferred: {
						version: 1,
						action: "policy_deferred",
						direction: "advance_authorized_fallback",
						reasonCode: "host_on_battery",
						diagnosticCode: "host_on_battery",
						nextTaskId: "1.1",
						taskFileSha256: "a".repeat(64),
					},
					results: [],
					checkpointPath: join(dir, "battery.checkpoint.json"),
				}),
			}),
		);
		strictEqual(exitCode, 6);
		strictEqual(envelope.state, "deferred");
		strictEqual(envelope.disposition.action, "policy_deferred");
		strictEqual(envelope.disposition.direction, "advance_authorized_fallback");
		strictEqual(envelope.disposition.diagnosticCode, "host_on_battery");
		strictEqual(envelope.disposition.taskId, "1.1");
		strictEqual(envelope.disposition.taskFileSha256, "a".repeat(64));
	});

	it("classifies an invalid golden image reference instead of throwing", async () => {
		// An empty SWITCHYARD_PARALLELS_GOLDEN_IMAGE defeats the `??` default and
		// makes the route-health epoch unbuildable. Before the health decision
		// moved inside the classified pre-provider block this escaped `run`
		// as a raw RouteHealthSchemaError with no envelope.
		const previous = process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE;
		process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE = "";
		let queueCalls = 0;
		try {
			const { envelope } = await captureRunJson(
				[tasksFile, "--project", projectDir, "--json"],
				noVmDependencies({
					runQueue: async () => {
						queueCalls += 1;
						throw new Error("queue must not run without a health epoch");
					},
				}),
			);
			strictEqual(queueCalls, 0);
			strictEqual(envelope.state, "failed");
			strictEqual(envelope.runId, null);
			strictEqual(envelope.disposition.action, "repair_contract");
			strictEqual(
				envelope.disposition.diagnosticCode,
				"environment_incomplete",
			);
		} finally {
			if (previous === undefined)
				delete process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE;
			else process.env.SWITCHYARD_PARALLELS_GOLDEN_IMAGE = previous;
		}
	});

	// The detached worker wires this (worker-bootstrap.mjs), the synchronous path
	// did not, so a provider failure on the in-process path deleted its evidence
	// without ever offering it to the run store and reported
	// diagnosticEvidenceAvailable: false with no artifact on disk.
	it("hands the synchronous queue a run-store diagnostic artifact writer", async () => {
		let persistDiagnosticArtifact;
		const { envelope } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				runQueue: async (queueOptions) => {
					persistDiagnosticArtifact =
						queueOptions.dependencies.persistDiagnosticArtifact;
					return {
						totalTasks: 1,
						runnableTasks: 1,
						processedTasks: 1,
						completedTaskIds: ["1.1"],
						results: [{ taskId: "1.1", success: true, result: "success" }],
						checkpointPath: join(dir, "diagnostic.checkpoint.json"),
					};
				},
			}),
		);
		strictEqual(
			typeof persistDiagnosticArtifact,
			"function",
			"synchronous dispatch must give the runner a way to persist evidence",
		);
		const ref = await persistDiagnosticArtifact({
			stdoutBytes: 0,
			stderrBytes: 38,
			stdoutDigest: `sha256:${"a".repeat(64)}`,
			stderrDigest: `sha256:${"b".repeat(64)}`,
		});
		ok(
			/^diagnostic:[a-f0-9]{32}$/u.test(ref ?? ""),
			`expected a diagnostic reference, got ${ref}`,
		);
		const { resolveDiagnosticArtifact } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const artifact = await resolveDiagnosticArtifact(envelope.runId, ref);
		strictEqual(artifact?.stderrBytes, 38);
		strictEqual(artifact?.stdoutDigest, `sha256:${"a".repeat(64)}`);
	});

	it("binds the queue health epoch to the injected golden image", async () => {
		let queueHealth = null;
		await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				goldenImage: "golden-a",
				runQueue: async (queueOptions) => {
					queueHealth = queueOptions.dependencies.healthDecision;
					return {
						totalTasks: 1,
						runnableTasks: 1,
						processedTasks: 1,
						completedTaskIds: ["1.1"],
						results: [{ taskId: "1.1", success: true, result: "success" }],
						checkpointPath: join(dir, "golden.checkpoint.json"),
					};
				},
			}),
		);
		const epochFor = (goldenImageReference) =>
			createDefaultRouteHealthDecision({
				qualifiedProviders: GOLDEN_IMAGE_VERIFIED_PROVIDERS,
				goldenImageReference,
			}).publicConfigurationEpoch;
		strictEqual(queueHealth.mode, "shadow");
		strictEqual(queueHealth.publicConfigurationEpoch, epochFor("golden-a"));
		notStrictEqual(queueHealth.publicConfigurationEpoch, epochFor("golden-b"));
	});

	it("emits one closed failure envelope without raw exception text", async () => {
		const canary = "SECRET_CANARY_sync_json_raw_error";
		const taskIdCanary = "SECRET_TASK_ID_sync_json_raw_error";
		const { envelope, errors, output } = await captureRunJson(
			[tasksFile, "--project", projectDir, "--json"],
			noVmDependencies({
				runQueue: async () => {
					throw new TaskSelectionError(taskIdCanary, canary);
				},
			}),
		);
		const serialized = JSON.stringify(envelope);
		strictEqual(output.length, 1);
		deepStrictEqual(errors, []);
		ok(!serialized.includes(canary));
		ok(!serialized.includes(taskIdCanary));
		ok(typeof envelope.runId === "string");
		strictEqual(envelope.state, "failed");
		strictEqual(envelope.disposition.action, "repair_contract");
		strictEqual(envelope.disposition.direction, "repair_input");
		strictEqual(envelope.disposition.reasonCode, "task_selection_failed");
	});

	it("emits a null-address pre-initialization contract envelope", async () => {
		const { envelope, errors } = await captureRunJson(["--json"]);
		deepStrictEqual(errors, []);
		strictEqual(envelope.runId, null);
		strictEqual(envelope.stateRoot, null);
		strictEqual(envelope.statusCommand, null);
		strictEqual(envelope.resultCommand, null);
		strictEqual(envelope.disposition.action, "repair_contract");
		strictEqual(envelope.disposition.direction, "repair_input");
		strictEqual(envelope.disposition.reasonCode, "invalid_invocation");
	});

	it("maps an empty parsed queue before initialization without creating a run", async () => {
		const emptyTasksFile = join(dir, "empty-run-json.md");
		writeFileSync(emptyTasksFile, "# no task headings\n", "utf8");
		const { envelope, errors } = await captureRunJson(
			[emptyTasksFile, "--project", projectDir, "--json"],
			noVmDependencies(),
		);
		deepStrictEqual(errors, []);
		strictEqual(envelope.runId, null);
		strictEqual(envelope.disposition.reasonCode, "queue_empty");
		strictEqual(envelope.disposition.direction, "repair_input");
	});

	it("binds a durable default failure message to its run ID", async () => {
		const canary = "closed-default-failure";
		const originalError = console.error;
		console.error = () => {};
		try {
			await rejects(
				handleRun(
					[tasksFile, "--project", projectDir],
					noVmDependencies({
						runQueue: async () => {
							throw new TaskSelectionError("9.9", canary);
						},
					}),
				),
				(error) => {
					ok(typeof error.switchyardRunId === "string");
					const message = formatRunAbort(error);
					ok(message.includes(`run ${error.switchyardRunId}`));
					return true;
				},
			);
		} finally {
			console.error = originalError;
		}
	});
});
