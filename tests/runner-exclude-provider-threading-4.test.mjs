import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDefaultRouteHealthDecision } from "../src/switchyard/router/health.mjs";
import { executeTaskAsync } from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runnerTestDir,
	runQueueAsync,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
// In-memory reservation ledger for the direct executeTaskAsync path: the real
// broker seam is kept (so context.only/exclude/platform/goldenImageVerifiedProviders
// are threaded by createDispatchBroker), but no project ledger files are written.
function stubBrokerReservations() {
	const reservations = new Map();
	let counter = 0;
	return {
		reserveWithSelection: async (select) => {
			const candidate = select([], []);
			if (!candidate) return null;
			counter += 1;
			const reservation = { id: `test-reservation-${counter}` };
			reservations.set(reservation.id, { candidate, state: "reserved" });
			return reservation;
		},
		terminal: async ({ reservationId }) => {
			const record = reservations.get(reservationId);
			if (record) record.state = "released";
			return { reservationId, state: record?.state ?? "released" };
		},
	};
}
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("--exclude-provider threading (context.exclude -> route)", () => {
	it("binds route-health identity to the selected golden image", () => {
		const first = createDefaultRouteHealthDecision({
			qualifiedProviders: [],
			goldenImageReference: "golden-a",
		});
		const second = createDefaultRouteHealthDecision({
			qualifiedProviders: [],
			goldenImageReference: "golden-b",
		});
		notStrictEqual(
			first.publicConfigurationEpoch,
			second.publicConfigurationEpoch,
		);
	});
	it("runQueue forwards options.only onto context.only, reaching route() via executeTask (Task C.9)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			only: ["codex"],
			dependencies: {
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 60,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a\n+change",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].only, ["codex"]);
	});
	it("runQueue defaults context.only to [] when options.only is omitted (Task C.9)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 60,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a\n+change",
					},
				},
			},
		});

		deepStrictEqual(routeCalls[0].only, []);
	});
	it("executeTask passes context.only through to route(), alongside exclude and availableProviders (Task C.9)", async () => {
		const routeCalls = [];
		const routeResult = {
			provider: "codex",
			model: "gpt-5.6-terra",
			percentLeft: 50,
			reason: "spread",
		};

		await executeTaskAsync(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: (opts) => {
					routeCalls.push(opts);
					return routeResult;
				},
				resolveDescriptor: () => descriptorForRoute(routeResult),
				brokerDependencies: {
					resolveTargetIdentity: () => ({
						targetId: "codex",
						harnessKey: "codex",
						ambiguous: false,
					}),
					brokerReservations: stubBrokerReservations(),
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						executeAsync: async () => ({ success: true, output: "ok" }),
						captureDiffAsync: async () => "diff --git a/a b/a\n+change",
					},
				},
				queueBackend: {
					captureTaskBase: () => TASK_BASE,
					validateTaskBase: (_workspaceId, base) => base,
					releaseTaskBase: () => {},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				only: ["codex"],
				platform: "macos",
				goldenImageVerifiedProviders: ["codex"],
			},
		);

		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].only, ["codex"]);
		deepStrictEqual(routeCalls[0].availableProviders, ["codex"]);
		strictEqual(routeCalls[0].platform, "macos");
		deepStrictEqual(routeCalls[0].goldenImageVerifiedProviders, ["codex"]);
	});
});
