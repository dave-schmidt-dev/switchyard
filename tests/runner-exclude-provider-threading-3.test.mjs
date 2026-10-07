import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
} from "../src/switchyard/roster/index.mjs";
import {
	attestRouteRepair,
	createDefaultRouteHealthDecision,
	ingestRouteHealthEvents,
	inspectRouteHealth,
} from "../src/switchyard/router/health.mjs";
import {
	createRouteHealthEvent,
	getRunRoot,
	initializeRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	executeTaskAsync as executeTaskAsyncImpl,
	loadCheckpoint,
	runQueueAsync as runQueueAsyncImpl,
} from "../src/switchyard/runner/index.mjs";
import {
	authExpiredExecution,
	codexHealthRoute,
	productionQueueOptions,
	runnerTestDir,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);
const VALID_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
function writeDispatchQualifiedRosterFixture() {
	const roster = JSON.parse(readFileSync(ROSTER_FIXTURE_PATH, "utf8"));
	const testedAt = new Date().toISOString();
	for (const [targetId, target] of Object.entries(roster.targets)) {
		if (!target.enabled) continue;
		for (const slots of Object.values(target.slots ?? {})) {
			for (const slot of slots ?? []) {
				if (slot.manual_only) continue;
				const model = roster.models[slot.model_ref];
				if (model?.status !== "active") continue;
				const core = {
					target_id: targetId,
					model_ref: slot.model_ref,
					selector: model.selector,
					effort: slot.effort ?? null,
					variant: slot.variant ?? null,
					invocation_args: slot.invocation_args ?? [],
				};
				const descriptorIdentity = getInvocationDescriptorIdentity(
					core,
					target.harness,
				);
				target.qualifications ??= {};
				target.qualifications[descriptorIdentity] = {
					...core,
					descriptor_identity: descriptorIdentity,
					status: "dispatch_qualified",
					tested_at: testedAt,
					credential_profile: target.credential_profile,
				};
			}
		}
	}
	const fixturePath = join(
		tmpdir(),
		`switchyard-runner-qualified-roster-${process.pid}-${randomUUID()}.json`,
	);
	writeFileSync(fixturePath, JSON.stringify(roster), "utf8");
	return fixturePath;
}
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}
// Route-health deferral must resolve the production descriptor (the qualified
// roster's exact codex/standard receipt), so these direct executeTaskAsync
// contexts keep resolveDescriptor unset and stub only the broker boundary.
function codexReservedRoute() {
	return {
		provider: "codex",
		model: "fixture-codex-standard",
		resolvedTarget: "codex",
		harness: "codex",
		capability: "standard",
		reason: "fixture",
		reservation: { id: "task-reservation" },
		snapshotIdentity: { status: "fresh", mtime: 1, ageMs: 0 },
	};
}
function stubCodexBroker(executeAsync) {
	return {
		selectAndReserve: async () => codexReservedRoute(),
		fallbackAndReserve: async () => {
			throw new Error("fallback must not run");
		},
		execute: async () => executeAsync(),
		release: async () => {},
		launcherIdentity: () => ({}),
	};
}
function codexTaskContext({
	executeAsync,
	captureDiffAsync,
	healthDecision,
	integrationGate,
	runId,
	workingContainerName,
}) {
	return {
		broker: stubCodexBroker(executeAsync),
		healthDecision,
		recordDispatch: () => {},
		recordDispatchIntent: () => {},
		integrationGate,
		adapters: {
			codex: {
				executeAsync,
				captureDiffAsync,
			},
		},
		queueBackend: { captureTaskBase: () => TASK_BASE },
		projectPath: TEST_DIR,
		workingContainerName,
		runId,
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
	function ownedCodexQueueDependencies(outcomes) {
		const executeCalls = [];
		const queue = [...outcomes];
		const execute = () => {
			executeCalls.push("codex");
			return queue.shift() ?? { success: true, output: "ok" };
		};
		return {
			executeCalls,
			dependencies: {
				route: codexHealthRoute,
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "owned-health-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				captureTaskBase: () => TASK_BASE,
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: () => {},
				wipeWorkingContainer: () => {},
				persistDiagnosticArtifact: async (evidence) => {
					strictEqual(evidence?.diagnosticKind, "usage_exhausted");
					return VALID_DIAGNOSTIC_REF;
				},
				adapters: {
					codex: {
						execute,
						executeAsync: async () => execute(),
						captureDiff: () => "diff --git a/a b/a\n+change",
						captureDiffAsync: async () => "diff --git a/a b/a\n+change",
					},
				},
			},
		};
	}
	async function holdCodexRoute({ healthDecision, healthStateRoot, runId }) {
		const result = await executeTaskAsyncImpl(
			{ id: "1.1", title: "task", description: "op" },
			codexTaskContext({
				executeAsync: async () => authExpiredExecution(),
				captureDiffAsync: async () => null,
				healthDecision,
				integrationGate: () => ({ success: false }),
				runId,
				workingContainerName: "hold-workspace",
			}),
		);
		ok(result.routeHealthBinding, "hold evidence needs a terminal binding");
		await initializeRun({
			runId,
			tasksFilePath: join(TEST_DIR, "tasks.md"),
			projectPath: TEST_DIR,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: { fixture: true },
		});
		await createRouteHealthEvent(
			runId,
			{
				phase: "execution",
				event: "task_failed",
				status: "failed",
				taskId: "1.1",
				attempt: result.routeHealthAttempt,
				resolvedTargetId: result.resolvedTargetId,
				invocationDescriptor: result.invocationDescriptor,
				descriptorIdentity: result.descriptorIdentity,
				descriptorHarness: result.descriptorHarness,
				diagnosticCode: result.diagnosticCode,
				diagnosticOrigin: result.diagnosticOrigin,
				diagnosticEvidenceAvailable: true,
				failurePhase: result.failurePhase,
			},
			result.routeHealthBinding,
		);
		await ingestRouteHealthEvents({
			authorisedRuns: [{ runId, runRoot: getRunRoot(runId) }],
			healthStateRoot,
		});
		const identity = healthDecision.identityFor({
			provider: "codex",
			requiredCapability: "standard",
		});
		strictEqual(
			(await inspectRouteHealth({ ...identity, healthStateRoot })).state,
			"repair-hold",
		);
		return identity;
	}
	function withQualifiedRoster(fn) {
		return async () => {
			const oldRoster = process.env.SWITCHYARD_ROSTER_PATH;
			const oldRuns = process.env.SWITCHYARD_RUN_STORE_ROOT;
			process.env.SWITCHYARD_ROSTER_PATH =
				writeDispatchQualifiedRosterFixture();
			process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_DIR, "health-runs");
			__resetRosterCacheForTests();
			try {
				await fn();
			} finally {
				if (oldRoster === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
				else process.env.SWITCHYARD_ROSTER_PATH = oldRoster;
				if (oldRuns === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
				else process.env.SWITCHYARD_RUN_STORE_ROOT = oldRuns;
				__resetRosterCacheForTests();
			}
		};
	}
	it(
		"defers a held route before the broker launches and releases its reservation",
		withQualifiedRoster(async () => {
			const healthStateRoot = join(TEST_DIR, "broker-health");
			const shadow = createDefaultRouteHealthDecision({
				healthStateRoot,
				qualifiedProviders: ["codex"],
				goldenImageReference: "golden-a",
			});
			await holdCodexRoute({
				healthDecision: shadow,
				healthStateRoot,
				runId: "hold-run-broker",
			});
			const enforce = createDefaultRouteHealthDecision({
				healthStateRoot,
				mode: "enforce",
				qualifiedProviders: ["codex"],
				goldenImageReference: "golden-a",
			});
			const outcomes = [];
			for (const healthDecision of [enforce, shadow]) {
				const executions = [];
				const releases = [];
				const reservedRoute = {
					provider: "codex",
					model: "fixture-codex-standard",
					resolvedTarget: "codex",
					harness: "codex",
					capability: "standard",
					reason: "fixture",
					reservation: { id: "reservation-1" },
					snapshotIdentity: { status: "fresh", mtime: 1, ageMs: 0 },
				};
				const result = await executeTaskAsyncImpl(
					{ id: "1.1", title: "task", description: "op" },
					{
						broker: {
							selectAndReserve: async () => reservedRoute,
							fallbackAndReserve: async () => {
								throw new Error("fallback must not run");
							},
							execute: async (_request, route) => {
								executions.push(route.provider);
								return { ...authExpiredExecution(), outcome: "failure" };
							},
							release: async (route, outcome) =>
								releases.push([route.reservation.id, outcome]),
							launcherIdentity: (route) => ({ provider: route.provider }),
						},
						healthDecision,
						recordDispatch: () => {},
						recordDispatchIntent: () => {},
						integrationGate: () => ({ success: false }),
						adapters: {
							codex: {
								executeAsync: async () => authExpiredExecution(),
								captureDiffAsync: async () => null,
							},
						},
						queueBackend: { captureTaskBase: () => TASK_BASE },
						projectPath: TEST_DIR,
						workingContainerName: "broker-workspace",
						runId: `broker-run-${healthDecision.mode}`,
					},
				);
				outcomes.push({
					mode: healthDecision.mode,
					result: result.result,
					executions,
					releases,
				});
			}
			deepStrictEqual(outcomes, [
				{
					mode: "enforce",
					result: "route_health_deferred",
					executions: [],
					releases: [["reservation-1", "failure"]],
				},
				{
					mode: "shadow",
					result: "execution_failed",
					executions: ["codex"],
					releases: [],
				},
			]);
		}),
	);
	it(
		"keeps concurrent enforce-mode claim contention pending and continues the default queue",
		withQualifiedRoster(async () => {
			const healthStateRoot = join(TEST_DIR, "concurrent-claim-health");
			const healthDecision = createDefaultRouteHealthDecision({
				healthStateRoot,
				mode: "enforce",
				qualifiedProviders: ["codex"],
				goldenImageReference: "golden-a",
			});
			const identity = await holdCodexRoute({
				healthDecision,
				healthStateRoot,
				runId: "concurrent-claim-holder",
			});
			await attestRouteRepair({
				...identity,
				healthStateRoot,
				repairKind: "auth_repaired",
				nowMs: Date.now() + 1_000,
			});
			const holder = await executeTaskAsyncImpl(
				{ id: "holder", title: "claim holder", description: "op" },
				codexTaskContext({
					executeAsync: async () => ({ success: true, output: "ok" }),
					captureDiffAsync: async () => "diff --git a/a b/a\n+change",
					healthDecision,
					integrationGate: () => ({ success: true }),
					runId: "claim-holder-run",
					workingContainerName: "claim-holder-workspace",
				}),
			);
			strictEqual(holder.success, true);

			const tasksPath = writeTasksFile(`### Task 1.1: Deferred one
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** first deferred task

### Task 1.2: Deferred two
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** second deferred task
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const statusEvents = [];
			const fixture = ownedCodexQueueDependencies([]);
			fixture.dependencies.healthDecision = healthDecision;
			fixture.dependencies.onStatus = (event) => statusEvents.push(event);
			fixture.dependencies.runStore = {
				updateRun: () => Promise.resolve({ revision: 0 }),
			};
			const routeCalls = [];
			fixture.dependencies.route = () => {
				routeCalls.push(true);
				return codexHealthRoute();
			};
			const result = await runQueueAsyncImpl(
				productionQueueOptions({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "claim-contention-workspace",
					checkpointPath,
					runId: "claim-contention-run",
					dependencies: fixture.dependencies,
				}),
			);
			strictEqual(
				routeCalls.length,
				2,
				"deferred work must not stop the queue",
			);
			strictEqual(fixture.executeCalls.length, 0);
			strictEqual(result.results.length, 0);
			strictEqual(result.processedTasks, 0);
			deepStrictEqual(result.completedTaskIds, []);
			strictEqual(
				statusEvents.filter((event) => event.event === "route_health_deferred")
					.length,
				2,
			);
			deepStrictEqual(
				loadCheckpoint(checkpointPath, tasksPath).completedTaskIds,
				[],
			);
			await result.ledgerWritesSettled;
			// BLOCKED (Task 5.11b): runQueueAsync never calls runStore.updateRun with a terminal deferred projection, so the state "deferred" assertion cannot be ported.
			// BLOCKED (Task 5.11b): runQueueAsync writes no terminalSummary (completedTaskIds/deferredTaskIds/failedCount) to runStore.updateRun, so those assertions cannot be ported.
			// BLOCKED (Task 5.11b): runQueueAsync never attaches a terminal lastFailure to a runStore.updateRun call, so that absence assertion cannot be ported.
		}),
	);
});
