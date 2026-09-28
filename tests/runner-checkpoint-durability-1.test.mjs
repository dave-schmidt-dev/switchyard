import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
	throws,
} from "node:assert";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	acquireCheckpointLease,
	createEmptyCheckpoint,
	loadCheckpoint,
	releaseCheckpointOwnership,
	runQueueAsync as runQueueAsyncImpl,
	runQueue as runQueueImpl,
	runQueueWithOrchestrator as runQueueWithOrchestratorImpl,
	saveCheckpoint,
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
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);
const VALID_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
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
	it("reads completed legacy history unchanged across all queue loops", async () => {
		for (const version of [1, 2]) {
			for (const [mode, entrypoint] of [
				["sync", runQueue],
				["async", runQueueAsync],
				["orchestrator", runQueueWithOrchestrator],
			]) {
				const tasksPath = writeTasksFile(`### Task 1.1: Legacy completion
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** retain completed history
`);
				const checkpointPath = `${tasksPath}.checkpoint.json`;
				writeLegacyCheckpoint(checkpointPath, {
					version,
					tasksFilePath: tasksPath,
					...(version === 2
						? { queueIdentity: "legacy-queue", runOptions: null, taskBases: {} }
						: {}),
					completedTaskIds: ["1.1"],
					lastTaskId: "1.1",
					lastUpdatedAt: "2026-01-01T00:00:00.000Z",
					results: [{ taskId: "1.1", success: true }],
				});
				const before = readFileSync(checkpointPath, "utf8");
				let providerLaunches = 0;
				const dependencies = {
					route: () => {
						providerLaunches += 1;
						return { provider: "claude", model: "fixture-model" };
					},
					adapters: {
						claude: {
							execute: () => {
								providerLaunches += 1;
								return { success: true };
							},
							executeAsync: async () => {
								providerLaunches += 1;
								return { success: true };
							},
						},
					},
					orchestrator: {
						launch: () => {
							providerLaunches += 1;
							return "unexpected";
						},
						status: () => ({ state: "done" }),
						result: () => ({ success: true }),
					},
				};
				const result = await entrypoint({
					tasksFilePath: tasksPath,
					checkpointPath,
					projectPath: TEST_DIR,
					workingContainerName: `legacy-${version}-${mode}`,
					dependencies,
				});
				strictEqual(result.processedTasks, 0, `${version}/${mode}`);
				strictEqual(providerLaunches, 0, `${version}/${mode}`);
				strictEqual(
					readFileSync(checkpointPath, "utf8"),
					before,
					`${version}/${mode}`,
				);
			}
		}
	});
	it("rejects a stale independently loaded writer using the disk revision", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const original = createEmptyCheckpoint(tasksPath);
		saveCheckpoint(checkpointPath, original);
		const first = loadCheckpoint(checkpointPath, tasksPath);
		const stale = structuredClone(first);
		first.lastTaskId = "first";
		saveCheckpoint(checkpointPath, first);
		const before = readFileSync(checkpointPath, "utf8");
		stale.lastTaskId = "stale";
		throws(() => saveCheckpoint(checkpointPath, stale), /revision mismatch/);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
	});
	it("holds an exclusive lease and rejects owner or nonce displacement", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const checkpoint = createEmptyCheckpoint(tasksPath);
		saveCheckpoint(checkpointPath, checkpoint);
		const lease = acquireCheckpointLease(checkpointPath, checkpoint.owner);
		throws(
			() => acquireCheckpointLease(checkpointPath, checkpoint.owner),
			/lease unavailable/,
		);
		writeFileSync(
			lease.lockPath,
			JSON.stringify({ owner: checkpoint.owner, nonce: "displaced" }),
		);
		const before = readFileSync(checkpointPath, "utf8");
		throws(
			() => saveCheckpoint(checkpointPath, checkpoint, { lease }),
			/lease displaced/,
		);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
	});
	it("revalidates the lease after staging and before canonical publication", () => {
		const tasksPath = writeTasksFile("## Phase 1\n");
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const checkpoint = createEmptyCheckpoint(tasksPath);
		saveCheckpoint(checkpointPath, checkpoint);
		const before = readFileSync(checkpointPath, "utf8");
		checkpoint.lastTaskId = "must-not-publish";
		throws(
			() =>
				saveCheckpoint(checkpointPath, checkpoint, {
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
	it("allows a separate process queue to resume only a durably released checkpoint", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Completed task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** already completed in the checkpoint
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const checkpoint = createEmptyCheckpoint(tasksPath);
		checkpoint.completedTaskIds.push("1.1");
		checkpoint.results.push({ taskId: "1.1", success: true });
		saveCheckpoint(checkpointPath, checkpoint);
		strictEqual(releaseCheckpointOwnership(checkpointPath, checkpoint), true);
		const runnerUrl = pathToFileURL(
			resolve(cwd(), "src/switchyard/runner/index.mjs"),
		).href;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { runQueue } from ${JSON.stringify(runnerUrl)}; const [tasks,checkpointPath,projectPath]=process.argv.slice(1); const backendFactory=()=>({readiness:()=>({inventoryCount:0}),ensureAgentContainer:()=>{},create:()=>"unused",provision:()=>{},seed:()=>{},commit:()=>{},reset:()=>{},destroy:()=>{},captureTaskBase:()=>({ref:"unused",tree:"1".repeat(40)}),validateTaskBase:(_id,base)=>base,releaseTaskBase:()=>{}}); const result=runQueue({tasksFilePath:tasks,checkpointPath,projectPath,workingContainerName:"fake-container",dependencies:{queuePreflight:()=>({ok:true,eligible:true}),backendFactory,acquireVmSlot:()=>null,releaseVmSlot:()=>{}}}); if(result.processedTasks!==0) throw new Error("unexpected execution");`,
				tasksPath,
				checkpointPath,
				TEST_DIR,
			],
			{ encoding: "utf8" },
		);
		strictEqual(child.status, 0, child.stderr);
		strictEqual(
			loadCheckpoint(checkpointPath, tasksPath).ownershipReleased,
			true,
		);
	});
	it("uses a new fenced owner when a later run claims a released checkpoint", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Completed task
- **Status:** done
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** already complete
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const common = {
			tasksFilePath: tasksPath,
			checkpointPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			dependencies: {
				queuePreflight: () => ({ ok: true, eligible: true }),
				acquireVmSlot: () => null,
				releaseVmSlot: () => {},
			},
		};
		runQueue({ ...common, runId: "same-process-run-a" });
		const afterA = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(afterA.ownershipReleased, true);
		strictEqual(afterA.owner.runId, "same-process-run-a");

		runQueue({ ...common, runId: "same-process-run-b" });
		const afterB = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(afterB.ownershipReleased, true);
		strictEqual(afterB.owner.runId, "same-process-run-b");
		notStrictEqual(afterB.owner.nonce, afterA.owner.nonce);
		const beforeStaleSave = readFileSync(checkpointPath, "utf8");
		throws(() => saveCheckpoint(checkpointPath, afterA), /owner displaced/);
		strictEqual(readFileSync(checkpointPath, "utf8"), beforeStaleSave);
	});
	it("releases a claimed checkpoint after preflight errors in all queue entrypoints", async () => {
		for (const [name, entrypoint] of [
			["sync", runQueueImpl],
			["async", runQueueAsyncImpl],
			["orchestrator", runQueueWithOrchestratorImpl],
		]) {
			const tasksPath = writeTasksFile(`### Task 1.1: Completed ${name}
- **Status:** done
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** already complete
`);
			const checkpointPath = `${tasksPath}.${name}.checkpoint.json`;
			const checkpoint = createEmptyCheckpoint(tasksPath);
			saveCheckpoint(checkpointPath, checkpoint);
			strictEqual(releaseCheckpointOwnership(checkpointPath, checkpoint), true);
			const options = {
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					backendFactory: () => ({
						platform: "macos",
						readiness: () => ({ inventoryCount: 0 }),
						create: () => "fake-vm",
						seed: () => {},
						commit: () => {},
						reset: () => {},
						destroy: () => {},
					}),
					queuePreflight: () => {
						throw new Error("synthetic post-claim preflight error");
					},
					acquireVmSlot: () => null,
					releaseVmSlot: () => {},
				},
			};
			await rejects(
				Promise.resolve().then(() => entrypoint(options)),
				/synthetic post-claim preflight error/,
			);
			strictEqual(
				loadCheckpoint(checkpointPath, tasksPath).ownershipReleased,
				true,
				name,
			);
			const result = await entrypoint({
				...options,
				dependencies: {
					...options.dependencies,
					queuePreflight: () => ({ ok: true, eligible: true }),
				},
			});
			strictEqual(result.processedTasks, 0, name);
			strictEqual(
				loadCheckpoint(checkpointPath, tasksPath).ownershipReleased,
				true,
				name,
			);
		}
	});
	it("a detached-style SIGTERM lets runQueueAsync destroy an owned VM exactly once", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Already complete
- **Status:** done
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** no provider launch
`);
		const checkpointPath = `${tasksPath}.sigterm.checkpoint.json`;
		const runnerUrl = pathToFileURL(
			resolve(cwd(), "src/switchyard/runner/index.mjs"),
		).href;
		const script = `
import { runQueueAsync, loadCheckpoint } from ${JSON.stringify(runnerUrl)};
const [tasksFilePath, checkpointPath, projectPath] = process.argv.slice(1);
const shutdown = new AbortController();
process.on("SIGTERM", () => shutdown.abort());
let destroys = 0;
const backendFactory = () => ({
  platform: "macos",
  preflight: () => {},
  readiness: () => ({ inventoryCount: 0 }),
  acquireSlot: () => ({ token: "fake-slot" }),
  releaseSlot: () => {},
  ensureAgentContainer: () => {},
  create: () => "fake-vm",
  provision: () => {},
  seed: () => {},
  commit: () => {},
  reset: () => {},
  destroy: () => { destroys += 1; if (destroys > 1) throw new Error("double destroy"); },
});
const result = await runQueueAsync({
  tasksFilePath, checkpointPath, projectPath,
  dependencies: {
    backendFactory,
    signal: shutdown.signal,
    hostPowerPolicyEnabled: false,
    onContainerReady: () => process.emit("SIGTERM"),
  },
});
console.log(JSON.stringify({ destroys, processedTasks: result.processedTasks,
  released: loadCheckpoint(checkpointPath, tasksFilePath).ownershipReleased }));
`;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				script,
				tasksPath,
				checkpointPath,
				TEST_DIR,
			],
			{ encoding: "utf8", timeout: 5_000 },
		);
		strictEqual(child.status, 0, child.stderr);
		deepStrictEqual(JSON.parse(child.stdout.trim()), {
			destroys: 1,
			processedTasks: 0,
			released: true,
		});
	});
	it("foreground SIGINT still invokes owned VM cleanup", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Already complete
- **Status:** done
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** no provider launch
`);
		const checkpointPath = `${tasksPath}.sigint.checkpoint.json`;
		const destroyPath = `${tasksPath}.sigint-destroyed`;
		const runnerUrl = pathToFileURL(
			resolve(cwd(), "src/switchyard/runner/index.mjs"),
		).href;
		const script = `
import { appendFileSync } from "node:fs";
import { runQueueAsync } from ${JSON.stringify(runnerUrl)};
const [tasksFilePath, checkpointPath, projectPath, destroyPath] = process.argv.slice(1);
const backendFactory = () => ({
  platform: "macos", preflight: () => {}, readiness: () => ({ inventoryCount: 0 }),
  acquireSlot: () => ({ token: "fake-slot" }), releaseSlot: () => {},
  ensureAgentContainer: () => {}, create: () => "fake-vm", provision: () => {},
  seed: () => {}, commit: () => {}, reset: () => {},
  destroy: () => appendFileSync(destroyPath, "destroy\\n"),
});
await runQueueAsync({ tasksFilePath, checkpointPath, projectPath,
  dependencies: { backendFactory, hostPowerPolicyEnabled: false,
    onContainerReady: () => process.emit("SIGINT") } });
`;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				script,
				tasksPath,
				checkpointPath,
				TEST_DIR,
				destroyPath,
			],
			{ encoding: "utf8", timeout: 5_000 },
		);
		ok(child.signal !== null || child.status !== 0, child.stderr);
		strictEqual(readFileSync(destroyPath, "utf8"), "destroy\n");
	});
});
