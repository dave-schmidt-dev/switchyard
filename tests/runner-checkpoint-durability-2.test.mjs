import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyPreProviderFailure } from "../src/switchyard/adapter/exec-error.mjs";
import {
	appendOutcomeEvent,
	createStageOutcome,
	initializeRun,
	readEvents,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	createEmptyCheckpoint,
	loadCheckpoint,
	migrateLegacyCheckpoint,
} from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueue,
	runQueueAsync,
	runQueueWithOrchestrator,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeLegacyCheckpoint(path, checkpoint) {
	writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
}
const __dirname = fileURLToPath(new URL(".", import.meta.url));
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("checkpoint durability", () => {
	it("durably releases checkpoint ownership in all three queue loops", async () => {
		for (const [name, entrypoint] of [
			["sync", runQueue],
			["async", runQueueAsync],
			["orchestrator", runQueueWithOrchestrator],
		]) {
			const tasksPath = writeTasksFile(
				`### Task 1.1: Completed ${name}\n- **Status:** done\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** already complete\n`,
			);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			await entrypoint({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					queuePreflight: () => ({ ok: true, eligible: true }),
					acquireVmSlot: () => null,
					releaseVmSlot: () => {},
					orchestrator: {
						launch: () => "unused",
						status: () => ({ state: "done" }),
						result: () => ({ success: true }),
					},
				},
			});
			strictEqual(
				loadCheckpoint(checkpointPath, tasksPath).ownershipReleased,
				true,
				name,
			);
		}
	});
	it("persists terminal shadow evidence before releasing all three checkpoint shapes", async () => {
		const replayFixture = JSON.parse(
			readFileSync(
				resolve(__dirname, "fixtures", "outcome-replay.json"),
				"utf8",
			),
		);
		const typedTerminalEvidence = replayFixture.records
			.filter(
				(record) =>
					record.evidenceStatus === "observed" && record.stage !== "provider",
			)
			.map((record, index) =>
				createStageOutcome({
					runId: "terminal-shadow-fixture",
					taskId: "1.1",
					attempt: record.counter,
					attemptId: `fixture-attempt-${index + 1}`,
					stage: record.stage,
					status: "failed",
					producer: "runner",
					code:
						record.stage === "artifact"
							? "diff_capture_failed"
							: "task_postcondition",
					detail: { artifactKind: "diff", captured: false },
				}),
			);
		const runId = "terminal-shadow-fixture";
		const previousStoreRoot = process.env.SWITCHYARD_RUN_STORE_ROOT;
		const projections = [];
		try {
			for (const [name, entrypoint] of [
				["sync", runQueue],
				["async", runQueueAsync],
				["orchestrator", runQueueWithOrchestrator],
			]) {
				const storeRoot = join(
					TEST_DIR,
					`shadow-cross-path-${name}-${randomUUID()}`,
				);
				mkdirSync(storeRoot, { recursive: true });
				process.env.SWITCHYARD_RUN_STORE_ROOT = storeRoot;
				const tasksPath = writeTasksFile(
					`### Task 1.1: Terminal shadow ${name}\n- **Status:** done\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** terminal shadow evidence\n`,
				);
				const checkpointPath = `${tasksPath}.checkpoint.json`;
				await initializeRun({
					runId,
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					orderedTaskIds: ["1.1"],
					initialHostFingerprint: "fixture",
					workerPid: process.pid,
					workerStartToken: "shadow-start-token",
					workerNonce: randomUUID(),
				});
				let current = await readRun(runId);
				const writerEpoch = `epoch-${runId}`;
				current = await updateRun(
					runId,
					{
						outcomeWriterEpoch: writerEpoch,
						state: "succeeded",
						cleanupState: "complete",
						terminalSummary: {
							totalTasks: 1,
							runnableTasks: 0,
							processedTasks: 0,
							completedTaskIds: ["1.1"],
							deferredTaskIds: [],
							failedCount: 0,
						},
					},
					current.revision,
				);
				for (const [index, evidence] of typedTerminalEvidence.entries()) {
					const terminalEvidence = createStageOutcome({
						...evidence,
						runId,
						code: "artifact_capture",
						writerEpoch,
						recordedAt: `2026-09-09T00:00:0${index}.000Z`,
					});
					await appendOutcomeEvent(runId, terminalEvidence, {
						writerEpoch,
					});
				}
				const runStore = {
					updateRun: async (partial) => {
						const latest = await readRun(runId);
						return updateRun(runId, partial, latest.revision);
					},
					readRun: () => readRun(runId),
					readEvents: () => readEvents(runId),
				};
				const dependencies = {
					queuePreflight: () => ({ ok: true, eligible: true }),
					acquireVmSlot: () => null,
					releaseVmSlot: () => {},
					runStore,
					enableTypedOutcomes: false,
					orchestrator: {
						launch: () => "unused",
						status: () => ({ state: "done" }),
						result: () => ({ success: true }),
					},
				};
				const result = await entrypoint({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					runId,
					dependencies,
				});
				await result.ledgerWritesSettled;
				const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
				const persistedRun = await readRun(runId);
				strictEqual(checkpoint.outcomeShadow.parity.evidence, "shadow", name);
				strictEqual(checkpoint.outcomeShadow.parity.cutoverBlocked, true, name);
				strictEqual(
					JSON.stringify(checkpoint.outcomeShadow.projection),
					JSON.stringify(persistedRun.outcomeShadow.projection),
					name,
				);
				strictEqual(checkpoint.outcomeProjection, null, name);
				projections.push(checkpoint.outcomeShadow.projection);
				strictEqual(checkpoint.ownershipReleased, true, name);
			}
			for (const projection of projections.slice(1))
				strictEqual(JSON.stringify(projection), JSON.stringify(projections[0]));
		} finally {
			if (previousStoreRoot === undefined)
				delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previousStoreRoot;
		}
	});
	it("migrates only an explicitly proven never-started legacy checkpoint", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeLegacyCheckpoint(checkpointPath, {
			version: 2,
			tasksFilePath: tasksPath,
			queueIdentity: "queue",
			runOptions: null,
			completedTaskIds: ["1.1"],
			results: [{ taskId: "1.1", success: true }],
			taskBases: {},
		});
		const owner = createEmptyCheckpoint(tasksPath).owner;
		const before = readFileSync(checkpointPath, "utf8");
		throws(
			() => migrateLegacyCheckpoint(checkpointPath, tasksPath, null, { owner }),
			(error) => {
				deepStrictEqual(classifyPreProviderFailure(error), {
					diagnosticCode: "integration_state_unknown",
					errorKind: "integration_failed",
					failurePhase: "checkpoint_validation",
				});
				return true;
			},
		);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
		const migrated = migrateLegacyCheckpoint(checkpointPath, tasksPath, null, {
			owner,
			provenNeverStarted: true,
		});
		strictEqual(migrated.version, 3);
		deepStrictEqual(migrated.completedTaskIds, ["1.1"]);
	});
	it("revalidates migration ownership after staging", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeLegacyCheckpoint(checkpointPath, {
			version: 2,
			tasksFilePath: tasksPath,
			queueIdentity: "queue",
			runOptions: null,
			completedTaskIds: [],
			results: [],
			taskBases: {},
		});
		const owner = createEmptyCheckpoint(tasksPath).owner;
		const before = readFileSync(checkpointPath, "utf8");
		throws(
			() =>
				migrateLegacyCheckpoint(checkpointPath, tasksPath, null, {
					owner,
					provenNeverStarted: true,
					beforePublish: ({ lease }) => {
						writeFileSync(lease.lockPath, "displaced", "utf8");
					},
				}),
			/checkpoint lease displaced/,
		);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
		ok(
			!readdirSync(join(checkpointPath, "..")).some((name) =>
				name.endsWith(".tmp"),
			),
		);
	});
	it("leaves unknown and corrupt checkpoint bytes untouched", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		for (const raw of ['{"version":99}', "{broken"]) {
			const checkpointPath = `${tasksPath}.${randomUUID()}.checkpoint.json`;
			writeFileSync(checkpointPath, raw);
			throws(() => loadCheckpoint(checkpointPath, tasksPath));
			strictEqual(readFileSync(checkpointPath, "utf8"), raw);
		}
	});
	it("round-trips through an atomic write with no leftover temp file", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: ["1.1"],
			lastTaskId: "1.1",
			lastUpdatedAt: "2026-01-01T00:00:00Z",
			results: [],
		});

		strictEqual(existsSync(`${checkpointPath}.tmp`), false);
		deepStrictEqual(
			loadCheckpoint(checkpointPath, tasksPath).completedTaskIds,
			["1.1"],
		);
	});
	it("throws instead of silently discarding a checkpoint that exists but fails to parse", () => {
		// Regression: a prior version caught any parse error and returned a
		// fresh empty checkpoint, indistinguishable from "no checkpoint yet" —
		// a crash mid-write (before checkpoints were written atomically) would
		// silently erase all completed-task history and trigger a full re-run.
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeFileSync(checkpointPath, "{not valid json", "utf8");

		throws(() => loadCheckpoint(checkpointPath, tasksPath), /not valid JSON/);
	});
	it("throws on a checkpoint file with an unexpected shape", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeFileSync(checkpointPath, JSON.stringify({ foo: "bar" }), "utf8");

		throws(() => loadCheckpoint(checkpointPath, tasksPath), /unexpected shape/);
	});
	it("still returns an empty checkpoint when the file is simply missing", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpoint = loadCheckpoint(
			`${tasksPath}.checkpoint.json`,
			tasksPath,
		);
		deepStrictEqual(checkpoint.completedTaskIds, []);
	});
	it("runQueue fails closed instead of silently succeeding when the tasks file parses to zero tasks", () => {
		// Regression: a tasks file with 0 "### Task <id>: <title>" headings
		// (wrong heading level, empty file, corrupted markdown) parsed to an
		// empty array and runQueue returned totalTasks:0/runnableTasks:0 as a
		// normal success — a silent no-op instead of a loud, diagnosable
		// failure.
		const tasksPath = writeTasksFile("## Phase 1\nNo task headings here.\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		throws(
			() =>
				runQueue({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {},
				}),
			/no tasks parsed from .*0 headings/,
		);

		// The auditable checkpoint must exist even though the run never
		// reached the per-task loop.
		strictEqual(existsSync(checkpointPath), true);
		const raw = JSON.parse(readFileSync(checkpointPath, "utf8"));
		strictEqual(raw.parseError.detectedHeadings, 0);
		strictEqual(raw.parseError.tasksFilePath, tasksPath);
	});
	it("runQueueWithOrchestrator also fails closed on a zero-task parse", async () => {
		const tasksPath = writeTasksFile("## Phase 1\nNo task headings here.\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		await rejects(
			() =>
				runQueueWithOrchestrator({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {},
				}),
			/no tasks parsed from .*0 headings/,
		);
		strictEqual(existsSync(checkpointPath), true);
	});
	it("runQueue always leaves a checkpoint file behind on a normal completion, even with zero runnable tasks", () => {
		// Regression: saveCheckpoint was only called inside the per-task loop,
		// so a run whose queue was already fully completed by a prior
		// checkpoint (runnable.length === 0, totalTasks > 0) returned a
		// checkpointPath with nothing on disk backing it up on this
		// invocation.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: ["1.1"],
			lastTaskId: "1.1",
			lastUpdatedAt: "2026-01-01T00:00:00Z",
			results: [{ taskId: "1.1", success: true }],
		});

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {},
		});

		strictEqual(result.totalTasks, 1);
		strictEqual(result.runnableTasks, 0);
		strictEqual(existsSync(checkpointPath), true);
		const onDisk = JSON.parse(readFileSync(checkpointPath, "utf8"));
		deepStrictEqual(onDisk.completedTaskIds, ["1.1"]);
	});
});
