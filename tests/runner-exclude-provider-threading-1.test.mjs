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
	createDefaultRouteHealthDecision,
	ingestRouteHealthEvents,
	inspectRouteHealth,
} from "../src/switchyard/router/health.mjs";
import {
	createRouteHealthEvent,
	getRunRoot,
	initializeRun,
} from "../src/switchyard/run-store/index.mjs";
import { executeTask as executeTaskImpl } from "../src/switchyard/runner/index.mjs";
import {
	authExpiredExecution,
	codexHealthRoute,
	executeTask,
	runnerTestDir,
	runQueue,
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
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("--exclude-provider threading (context.exclude -> route)", () => {
	it("runQueue forwards options.exclude onto context.exclude, reaching route() via executeTask", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			exclude: ["claude"],
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
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].exclude, ["claude"]);
	});
	it("runQueue defaults context.exclude to [] when options.exclude is omitted", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		runQueue({
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
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
			},
		});

		deepStrictEqual(routeCalls[0].exclude, []);
	});
	it("executeTask passes context.exclude through to route(), alongside availableProviders", () => {
		const routeCalls = [];

		executeTask(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 50,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				exclude: ["claude"],
			},
		);

		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].exclude, ["claude"]);
		deepStrictEqual(routeCalls[0].availableProviders, ["codex"]);
	});
	it("executeTask carries the shared health gate into its synchronous route seam", () => {
		const routeCalls = [];
		const healthDecision = () => ({
			available: false,
			state: "health-unavailable",
			suppress: false,
		});
		executeTask(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "codex",
						model: "gpt-5.6-terra",
						percentLeft: 50,
						reason: "spread",
					};
				},
				healthDecision,
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);
		strictEqual(routeCalls[0].healthDecision, healthDecision);
	});
	it("turns the first real authoritative failure into a durable health hold", async () => {
		const oldRoster = process.env.SWITCHYARD_ROSTER_PATH;
		const oldRuns = process.env.SWITCHYARD_RUN_STORE_ROOT;
		const rosterPath = writeDispatchQualifiedRosterFixture();
		const healthStateRoot = join(TEST_DIR, "first-health");
		process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
		process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_DIR, "first-runs");
		__resetRosterCacheForTests();
		try {
			const healthDecision = createDefaultRouteHealthDecision({
				healthStateRoot,
				qualifiedProviders: ["codex"],
				goldenImageReference: "golden-a",
			});
			// Production path on purpose: the test wrapper's synthetic descriptor
			// differs from the roster-derived health identity, and the binding must
			// only attach when the real descriptor receipt matches that identity.
			const result = executeTaskImpl(
				{ id: "1.1", title: "task", description: "op" },
				{
					route: () => ({
						provider: "codex",
						model: "fixture-codex-standard",
						resolvedTargetId: "codex",
						resolved_harness: "codex",
						requiredCapability: "standard",
						percentLeft: 50,
						reason: "fixture",
					}),
					healthDecision,
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => ({ success: false }),
					adapters: {
						codex: {
							execute: () => ({
								success: false,
								errorKind: "auth_expired",
								diagnosticCode: "auth_expired",
								diagnosticOrigin: "adapter",
								diagnosticEvidenceAvailable: true,
								failurePhase: "provider_execution",
							}),
							captureDiff: () => "",
						},
					},
					queueBackend: { captureTaskBase: () => TASK_BASE },
					projectPath: TEST_DIR,
					workingContainerName: "health-workspace",
					runId: "health-run",
				},
			);
			ok(result.routeHealthBinding);
			await initializeRun({
				runId: "health-run",
				tasksFilePath: join(TEST_DIR, "tasks.md"),
				projectPath: TEST_DIR,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: { fixture: true },
			});
			await createRouteHealthEvent(
				"health-run",
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
				authorisedRuns: [
					{ runId: "health-run", runRoot: getRunRoot("health-run") },
				],
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
		} finally {
			if (oldRoster === undefined) delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = oldRoster;
			if (oldRuns === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = oldRuns;
			__resetRosterCacheForTests();
		}
	});
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
	function quotaExhaustedExecution() {
		return {
			success: false,
			output: "",
			error: "provider quota unavailable",
			errorKind: "quota_exhausted",
			diagnosticCode: "quota_exhausted",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			diagnosticRef: VALID_DIAGNOSTIC_REF,
			diagnosticEvidence: {
				stdout: "",
				stderr: "usage exhausted",
				diagnosticKind: "usage_exhausted",
			},
			failurePhase: "provider_execution",
		};
	}
	async function holdCodexRoute({ healthDecision, healthStateRoot, runId }) {
		const result = executeTaskImpl(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: codexHealthRoute,
				healthDecision,
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: false }),
				adapters: {
					codex: { execute: authExpiredExecution, captureDiff: () => null },
				},
				queueBackend: { captureTaskBase: () => TASK_BASE },
				projectPath: TEST_DIR,
				workingContainerName: "hold-workspace",
				runId,
			},
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
});
