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
	runQueueAsync,
} from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

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
function codexHealthRoute() {
	return {
		provider: "codex",
		model: "fixture-codex-standard",
		resolvedTargetId: "codex",
		resolved_harness: "codex",
		requiredCapability: "standard",
		percentLeft: 50,
		reason: "fixture",
	};
}
function authExpiredExecution() {
	return {
		success: false,
		errorKind: "auth_expired",
		diagnosticCode: "auth_expired",
		diagnosticOrigin: "adapter",
		diagnosticEvidenceAvailable: true,
		failurePhase: "provider_execution",
	};
}
// Async-only twin of runner-fixtures' legacyBackendFactory: the broker queue
// honors only a backendFactory returning a full lifecycle object, so
// synthesize one from the flat per-method stubs and pin the macOS slot here
// instead of waiting on host admission.
function asyncQueueBackendFactory(dependencies) {
	return () => ({
		readiness: () => ({ inventoryCount: 0 }),
		ensureAgentContainer: dependencies.ensureAgentContainer ?? (() => {}),
		create: dependencies.createWorkingContainer ?? (() => "test-container"),
		provision: dependencies.provisionCredentials ?? (() => null),
		seed: dependencies.seedProject ?? (() => {}),
		commit: dependencies.commitWorkingTree ?? (() => {}),
		reset: dependencies.resetWorkingTree ?? (() => {}),
		captureTaskBase: dependencies.captureTaskBase ?? (() => TASK_BASE),
		validateTaskBase:
			dependencies.validateTaskBase ?? ((_workspaceId, base) => base),
		releaseTaskBase: dependencies.releaseTaskBase ?? (() => {}),
		destroy: dependencies.wipeWorkingContainer ?? (() => {}),
		acquireSlot: () => null,
		releaseSlot: () => {},
		preflight:
			dependencies.queuePreflight ?? (() => ({ ok: true, eligible: true })),
	});
}
// Production descriptor resolution on purpose: health identity, roster and
// route must agree, so no synthetic resolveDescriptor is injected here.
function productionQueueOptions(options) {
	const dependencies = options.dependencies ?? {};
	return {
		...options,
		platform: options.platform ?? "macos",
		dependencies: {
			...dependencies,
			queuePreflight:
				dependencies.queuePreflight ?? (() => ({ ok: true, eligible: true })),
			backendFactory:
				dependencies.backendFactory ?? asyncQueueBackendFactory(dependencies),
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
		const result = await executeTaskAsyncImpl(
			{ id: "1.1", title: "task", description: "op" },
			{
				route: codexHealthRoute,
				healthDecision,
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: false }),
				adapters: {
					codex: {
						execute: authExpiredExecution,
						captureDiff: () => null,
						executeAsync: async () => ({
							...authExpiredExecution(),
							diagnosticEvidence: { stdout: "", stderr: "auth expired" },
						}),
						captureDiffAsync: async () => null,
					},
				},
				persistDiagnosticArtifact: async () => VALID_DIAGNOSTIC_REF,
				queueBackend: {
					captureTaskBase: () => TASK_BASE,
					captureTaskBaseAsync: async () => TASK_BASE,
					validateTaskBase: (_workspaceId, base) => base,
					releaseTaskBase: () => {},
				},
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
	it(
		"keeps a started enforce-mode trial fenced and skips quota fallback without lifecycle proof",
		withQualifiedRoster(async () => {
			const mode = "async";
			const healthStateRoot = join(TEST_DIR, `trial-health-${mode}`);
			const healthDecision = createDefaultRouteHealthDecision({
				healthStateRoot,
				mode: "enforce",
				qualifiedProviders: ["codex"],
				goldenImageReference: "golden-a",
			});
			const identity = await holdCodexRoute({
				healthDecision,
				healthStateRoot,
				runId: `hold-run-${mode}`,
			});
			await attestRouteRepair({
				...identity,
				healthStateRoot,
				repairKind: "auth_repaired",
				nowMs: Date.now() + 1_000,
			});
			strictEqual(
				healthDecision({ provider: "codex", requiredCapability: "standard" })
					.trialAvailable,
				true,
				mode,
			);
			const tasksPath = writeTasksFile(`### Task 1.1: Trial without proof
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** run the attested trial
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const fixture = ownedCodexQueueDependencies([
				quotaExhaustedExecution(),
				{ success: true, output: "ok" },
			]);
			fixture.dependencies.healthDecision = healthDecision;
			const options = productionQueueOptions({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				runId: `trial-run-${mode}`,
				dependencies: fixture.dependencies,
			});
			const result = await runQueueAsync(options);
			strictEqual(result.results[0].success, false, mode);
			strictEqual(result.results[0].result, "execution_failed", mode);
			strictEqual(
				fixture.executeCalls.length,
				1,
				`${mode}: a started trial never spends the quota fallback launch`,
			);
			deepStrictEqual(
				loadCheckpoint(checkpointPath, tasksPath).providerAttemptAllocations,
				[],
				mode,
			);
			const health = await inspectRouteHealth({
				...identity,
				healthStateRoot,
			});
			strictEqual(health.state, "half-open", mode);
			strictEqual(
				health.claimStatus,
				"started",
				`${mode}: without lifecycle proof the claim stays fenced`,
			);
		}),
	);
	it(
		"never claims a trial in shadow mode and leaves quota fallback untouched",
		withQualifiedRoster(async () => {
			const mode = "async";
			const healthStateRoot = join(TEST_DIR, `shadow-trial-health-${mode}`);
			const healthDecision = createDefaultRouteHealthDecision({
				healthStateRoot,
				qualifiedProviders: ["codex"],
				goldenImageReference: "golden-a",
			});
			strictEqual(healthDecision.mode, "shadow", mode);
			const identity = await holdCodexRoute({
				healthDecision,
				healthStateRoot,
				runId: `shadow-hold-run-${mode}`,
			});
			await attestRouteRepair({
				...identity,
				healthStateRoot,
				repairKind: "auth_repaired",
				nowMs: Date.now() + 1_000,
			});
			strictEqual(
				healthDecision({ provider: "codex", requiredCapability: "standard" })
					.trialAvailable,
				true,
				mode,
			);
			const tasksPath = writeTasksFile(`### Task 1.1: Shadow trial
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** shadow mode must not claim the attested trial
`);
			const checkpointPath = `${tasksPath}.shadow-${mode}.checkpoint.json`;
			const fixture = ownedCodexQueueDependencies([
				quotaExhaustedExecution(),
				{ success: true, output: "ok" },
			]);
			fixture.dependencies.healthDecision = healthDecision;
			const statusEvents = [];
			fixture.dependencies.onStatus = (event) => statusEvents.push(event);
			const options = productionQueueOptions({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				runId: `shadow-trial-run-${mode}`,
				dependencies: fixture.dependencies,
			});
			const result = await runQueueAsync(options);
			strictEqual(
				fixture.executeCalls.length,
				2,
				`${mode}: shadow mode only spends a launch when durable evidence authorizes fallback`,
			);
			strictEqual(result.results[0].success, true, mode);
			strictEqual(
				loadCheckpoint(checkpointPath, tasksPath).providerAttemptAllocations
					.length,
				1,
				mode,
			);
			ok(
				statusEvents.some(
					(event) => event?.event === "half_open_trial_shadowed",
				),
				`${mode}: shadow mode reports the trial it would have claimed`,
			);
			const health = await inspectRouteHealth({
				...identity,
				healthStateRoot,
			});
			strictEqual(health.state, "repair-hold", mode);
			strictEqual(health.claimStatus, null, `${mode}: no claim was written`);
		}),
	);
	it(
		"never claims a trial for an attempt without a run identity",
		withQualifiedRoster(async () => {
			const healthStateRoot = join(TEST_DIR, "anonymous-health");
			const healthDecision = createDefaultRouteHealthDecision({
				healthStateRoot,
				qualifiedProviders: ["codex"],
				goldenImageReference: "golden-a",
			});
			const identity = await holdCodexRoute({
				healthDecision,
				healthStateRoot,
				runId: "hold-run-anonymous",
			});
			await attestRouteRepair({
				...identity,
				healthStateRoot,
				repairKind: "auth_repaired",
				nowMs: Date.now() + 1_000,
			});
			const executeCalls = [];
			// Before the run-identity guard this threw a health schema error out
			// of the claim path instead of returning the provider outcome.
			const result = await executeTaskAsyncImpl(
				{ id: "1.1", title: "task", description: "op" },
				{
					route: codexHealthRoute,
					healthDecision,
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => ({ success: false }),
					adapters: {
						codex: {
							execute: () => {
								executeCalls.push("codex");
								return quotaExhaustedExecution();
							},
							executeAsync: async () => {
								executeCalls.push("codex");
								return quotaExhaustedExecution();
							},
							captureDiff: () => null,
							captureDiffAsync: async () => null,
						},
					},
					persistDiagnosticArtifact: async () => VALID_DIAGNOSTIC_REF,
					queueBackend: {
						captureTaskBase: () => TASK_BASE,
						captureTaskBaseAsync: async () => TASK_BASE,
						validateTaskBase: (_workspaceId, base) => base,
						releaseTaskBase: () => {},
					},
					projectPath: TEST_DIR,
					workingContainerName: "anonymous-workspace",
				},
			);
			strictEqual(result.result, "execution_failed");
			strictEqual(result.errorKind, "quota_exhausted");
			deepStrictEqual(executeCalls, ["codex"]);
			strictEqual(result._routeHealthTrialStarted, undefined);
			strictEqual(result.routeHealthBinding, undefined);
			const health = await inspectRouteHealth({ ...identity, healthStateRoot });
			strictEqual(health.state, "repair-hold");
			strictEqual(health.claimStatus, null, "no claim without a run identity");
		}),
	);
});
