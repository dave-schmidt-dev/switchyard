import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { VmSlotUnavailableError } from "../src/switchyard/run-store/index.mjs";
import {
	QueuePreflightError,
	runQueueAsync,
} from "../src/switchyard/runner/index.mjs";
import {
	macosBackend,
	runnerTestDir,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
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
describe("queue platform admission ordering (Tasks 6.1-6.2)", () => {
	function writeTerminalQueue() {
		return writeTasksFile(`## Phase 1

### Task 1.1: Already complete
- **Status:** done
- **Type:** review
- **Description:** no provider work
- **Executor:** switchyard
`);
	}
	it("runs preflight and admission before create, then releases after teardown on sync and async entrypoints", async () => {
		for (const [entrypoint, invoke] of [["async", runQueueAsync]]) {
			const events = [];
			const tasksPath = writeTerminalQueue();
			const options = {
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				checkpointPath: `${tasksPath}.${entrypoint}.checkpoint.json`,
				dependencies: {
					backendFactory: () => macosBackend(events),
				},
			};
			await invoke(options);
			strictEqual(events[0], "preflight");
			strictEqual(events[1], "readiness");
			ok(events.indexOf("readiness") < events.indexOf("acquire"));
			ok(events.indexOf("acquire") < events.indexOf("create"));
			ok(events.indexOf("destroy") < events.indexOf("release"));
		}
	});
	it("stops at a synthetic preflight rejection before slot, VM, container, provider, or adapter calls", async () => {
		for (const [entrypoint, invoke] of [["async", runQueueAsync]]) {
			const events = [];
			const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Must not launch
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** fixture
`);
			const backend = macosBackend(events);
			backend.preflight = () => {
				events.push("preflight");
				throw new QueuePreflightError("synthetic preflight", {
					reason: "no_eligible",
					rejections: [{ capability: "standard", reason: "no_provider" }],
				});
			};
			const options = {
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				checkpointPath: `${tasksPath}.${entrypoint}.checkpoint.json`,
				dependencies: {
					backendFactory: () => backend,
				},
			};
			await rejects(invoke(options));
			deepStrictEqual(events, ["preflight"]);
		}
	});
	it("fails host readiness before a slot, workspace, or provider launch in every entrypoint", async () => {
		for (const [code, message] of [
			["vm_host_inventory_permission_denied", "inventory permission denied"],
			["vm_host_inventory_unavailable", "inventory unavailable"],
			["vm_host_service_degraded", "service degraded"],
		]) {
			for (const [entrypoint, invoke] of [["async", runQueueAsync]]) {
				const events = [];
				const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Must not launch
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** fixture
`);
				const failure = Object.assign(new Error(message), { code });
				const backend = macosBackend(events);
				backend.readiness = () => {
					events.push("readiness");
					throw failure;
				};
				let providerLaunches = 0;
				const options = {
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					platform: "macos",
					checkpointPath: `${tasksPath}.${code}.${entrypoint}.checkpoint.json`,
					dependencies: {
						backendFactory: () => backend,
						route: () => {
							providerLaunches += 1;
							throw new Error("provider launch must not occur");
						},
					},
				};
				await rejects(invoke(options), (error) => error === failure);
				deepStrictEqual(events, ["preflight", "readiness"]);
				strictEqual(providerLaunches, 0);
			}
		}
	});
	it("waits asynchronously for a released VM slot before creating the workspace", async () => {
		const events = [];
		const statuses = [];
		const tasksPath = writeTerminalQueue();
		const backend = macosBackend(events);
		let attempts = 0;
		let releaseWait;
		let signalWaitStarted;
		const waitStarted = new Promise((resolve) => {
			signalWaitStarted = resolve;
		});
		backend.acquireSlot = () => {
			events.push("acquire");
			attempts += 1;
			if (attempts === 1) {
				throw new VmSlotUnavailableError(["SECRET_HOLDER_ID"]);
			}
			return { token: "test-slot" };
		};

		const queue = runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			platform: "macos",
			checkpointPath: `${tasksPath}.wait-release.checkpoint.json`,
			dependencies: {
				backendFactory: () => backend,
				onStatus: (event) => statuses.push(event),
				vmSlotWaitTimeoutMs: 100,
				vmSlotWaitIntervalMs: 10,
				nowFn: () => 0,
				sleepFn: () => {
					signalWaitStarted();
					return new Promise((resolve) => {
						releaseWait = resolve;
					});
				},
			},
		});

		await waitStarted;
		strictEqual(events.includes("create"), false);
		releaseWait();
		await queue;
		strictEqual(attempts, 2);
		ok(events.indexOf("acquire") < events.indexOf("create"));
		deepStrictEqual(
			statuses
				.filter((event) => event.event === "vm_slot_wait")
				.map((event) => event.elapsedMs),
			[0],
		);
		strictEqual(JSON.stringify(statuses).includes("SECRET_HOLDER_ID"), false);
	});
	it("emits immediate and periodic VM-slot wait progress", async () => {
		const events = [];
		const statuses = [];
		const tasksPath = writeTerminalQueue();
		const backend = macosBackend(events);
		let attempts = 0;
		let now = 0;
		backend.acquireSlot = () => {
			events.push("acquire");
			attempts += 1;
			if (attempts < 3) {
				const unavailable = new Error("SECRET slot signal");
				unavailable.code = "VM_SLOT_UNAVAILABLE";
				throw unavailable;
			}
			return { token: "test-slot" };
		};

		await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			platform: "macos",
			checkpointPath: `${tasksPath}.wait-progress.checkpoint.json`,
			dependencies: {
				backendFactory: () => backend,
				onStatus: (event) => statuses.push(event),
				vmSlotWaitTimeoutMs: 100,
				vmSlotWaitIntervalMs: 10,
				nowFn: () => now,
				sleepFn: async (delayMs) => {
					now += delayMs;
				},
			},
		});

		deepStrictEqual(
			statuses
				.filter((event) => event.event === "vm_slot_wait")
				.map((event) => event.elapsedMs),
			[0, 10],
		);
		strictEqual(JSON.stringify(statuses).includes("SECRET slot signal"), false);
	});
	it("bounds async VM-slot admission and preserves the typed timeout error", async () => {
		const events = [];
		const statuses = [];
		const tasksPath = writeTerminalQueue();
		const backend = macosBackend(events);
		const unavailable = new VmSlotUnavailableError(["holder"]);
		let now = 0;
		let attempts = 0;
		backend.acquireSlot = () => {
			events.push("acquire");
			attempts += 1;
			throw unavailable;
		};

		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				checkpointPath: `${tasksPath}.wait-timeout.checkpoint.json`,
				dependencies: {
					backendFactory: () => backend,
					onStatus: (event) => statuses.push(event),
					vmSlotWaitTimeoutMs: 20,
					vmSlotWaitIntervalMs: 10,
					nowFn: () => now,
					sleepFn: async (delayMs) => {
						now += delayMs;
					},
				},
			}),
			(error) => error === unavailable,
		);
		strictEqual(attempts, 3);
		deepStrictEqual(
			statuses
				.filter((event) => event.event === "vm_slot_wait")
				.map((event) => event.elapsedMs),
			[0, 10, 20],
		);
		strictEqual(events.includes("create"), false);
	});
	it("uses a monotonic VM-slot deadline when the wall clock stands still", async () => {
		const events = [];
		const statuses = [];
		const tasksPath = writeTerminalQueue();
		const backend = macosBackend(events);
		const unavailable = new VmSlotUnavailableError(["holder"]);
		let attempts = 0;
		backend.acquireSlot = () => {
			events.push("acquire");
			attempts += 1;
			if (attempts < 3) throw unavailable;
			return { token: "test-slot" };
		};

		const originalDateNow = Date.now;
		Date.now = () => 0;
		try {
			await rejects(
				runQueueAsync({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					platform: "macos",
					checkpointPath: `${tasksPath}.wait-monotonic.checkpoint.json`,
					dependencies: {
						backendFactory: () => backend,
						onStatus: (event) => statuses.push(event),
						vmSlotWaitTimeoutMs: 2,
						vmSlotWaitIntervalMs: 1,
						sleepFn: async () =>
							new Promise((resolve) => setTimeout(resolve, 10)),
					},
				}),
				(error) => error === unavailable,
			);
		} finally {
			Date.now = originalDateNow;
		}

		strictEqual(attempts, 2);
		const elapsed = statuses
			.filter((event) => event.event === "vm_slot_wait")
			.map((event) => event.elapsedMs);
		strictEqual(elapsed.length, 2);
		ok(elapsed[0] >= 0 && elapsed[0] < 2);
		strictEqual(elapsed[1], 2);
		strictEqual(events.includes("create"), false);
	});
});
