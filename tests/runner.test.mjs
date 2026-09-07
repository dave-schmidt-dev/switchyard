import {
	deepStrictEqual,
	match,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
	throws,
} from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROVIDER_EXECUTION_TIMEOUT_MS } from "../src/switchyard/adapter/constants.mjs";
import {
	classifyPreProviderFailure,
	INTEGRATION_REFUSAL_KINDS,
	isPersistentFailureMetadata,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import { validateTaskStartTreeAsync } from "../src/switchyard/lifecycle/index.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
	validateInvocationDescriptor,
} from "../src/switchyard/roster/index.mjs";
import {
	attestRouteRepair,
	createDefaultRouteHealthDecision,
	ingestRouteHealthEvents,
	inspectRouteHealth,
} from "../src/switchyard/router/health.mjs";
import { route as realRoute } from "../src/switchyard/router/index.mjs";
import {
	createRouteHealthEvent,
	getRunRoot,
	initializeRun,
	VmSlotUnavailableError,
} from "../src/switchyard/run-store/index.mjs";
import {
	acquireCheckpointLease,
	CHECKPOINT_IDENTITY_CODES,
	CheckpointIdentityError,
	createBrokerAdapterLauncher,
	createCliOrchestrator,
	createEmptyCheckpoint,
	createQueueBackend,
	createQueueIdentity,
	deriveQueueDiagnostics,
	executeTaskAsync as executeTaskAsyncImpl,
	executeTask as executeTaskImpl,
	executeTaskWithOrchestrator as executeTaskWithOrchestratorImpl,
	findIgnoredDeclaredPath,
	getRunnableTasks,
	integrationFailureMetadata,
	loadCheckpoint,
	loadTaskQueue,
	migrateLegacyCheckpoint,
	normalizeRunOptions,
	parseTaskQueue,
	planPotentialAttemptTasks,
	QueueCleanupError,
	QueuePreflightError,
	reconcileExternalCompletion,
	releaseCheckpointOwnership,
	resolveOrchestrator,
	runQueueAsync as runQueueAsyncImpl,
	runQueue as runQueueImpl,
	runQueueWithOrchestrator as runQueueWithOrchestratorImpl,
	saveCheckpoint,
	TaskSelectionError,
	validateTaskGraph,
	waitForJobCompletion,
	writeDispatchIntent,
	writeDispatchIntentAsync,
} from "../src/switchyard/runner/index.mjs";

const TEST_DIR = join(cwd(), ".switchyard-runner-test");
function writeLegacyCheckpoint(path, checkpoint) {
	writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
}
// Task 1.5 (roster-unification plan): src/switchyard/roster/index.mjs now
// lazily loads the roster, resolving SWITCHYARD_ROSTER_PATH or the canonical
// ~/.agent/roster.json default (Task 4.1) and failing loud only if that
// resolved file can't load. Most of this file's tests inject
// `dependencies.route` and never touch the roster at all, but the two tests
// explicitly noted as exercising the real, unmocked route() do reach it —
// point them at this committed synthetic fixture (not the real
// ~/.agent/roster.json) so they keep passing.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);
const TASK_BASE = {
	ref: "refs/switchyard/task-base/runner-tests/1.1",
	tree: "3".repeat(40),
};
const VALID_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
const HOST_BOOT_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function hostBirth(pid) {
	return `switchyard-host-process-v1:${HOST_BOOT_UUID}:${pid}:${pid * 10 + 1}`;
}

function presentHostProbe(pid) {
	return {
		state: "present",
		pid,
		bootSessionUuid: HOST_BOOT_UUID,
		startTicks: String(pid * 10 + 1),
		identity: hostBirth(pid),
	};
}

describe("macOS queue admission", () => {
	it("captures canonical creator identity before the shared default allocation path", () => {
		const stateRoot = join(TEST_DIR, "host-birth-default");
		mkdirSync(stateRoot, { recursive: true });
		const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
		let cloneName;
		const calls = [];
		const executionBackend = new ParallelsExecutionBackend({
			aquaUid: 501,
			requireLinkedCloneMeasurement: false,
			hostProcessIdentityProbe: presentHostProbe,
			prlctlFn: (args) => {
				calls.push(args);
				if (args[0] === "clone") cloneName = args[3];
				if (args[0] === "list") {
					return cloneName
						? `{22222222-2222-4222-8222-222222222222}\trunning\t${cloneName}`
						: "";
				}
				return "";
			},
		});
		executionBackend.boot = () => {};
		executionBackend._hardenClone = () => {};
		executionBackend._prepareWorkspace = () => {};
		try {
			const queue = createQueueBackend({
				projectPath: "/private/tmp/fixture-project",
				runId: "fixture-birth-run",
				dependencies: {
					goldenImage: "fixture-golden",
					aquaUid: "501",
					executionBackend,
				},
			});
			const uuid = queue.create("/private/tmp/fixture-project");
			const ownership = executionBackend.readVmOwnership(
				uuid,
				join(stateRoot, "runs", "fixture-birth-run", "resources"),
			);
			strictEqual(ownership.processStartIdentity, hostBirth(process.pid));
			ok(calls.some((args) => args[0] === "clone"));
		} finally {
			if (previous === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
		}
	});

	it("refuses the default allocation before any VM call when birth is unavailable", () => {
		const previous = process.env.SWITCHYARD_RUN_STORE_ROOT;
		process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_DIR, "host-birth-denied");
		let vmCalls = 0;
		try {
			const queue = createQueueBackend({
				projectPath: "/private/tmp/fixture-project",
				runId: "fixture-birth-denied",
				dependencies: {
					goldenImage: "fixture-golden",
					aquaUid: "501",
					executionBackend: new ParallelsExecutionBackend({
						hostProcessIdentityProbe: () => ({ state: "unknown" }),
						prlctlFn: () => {
							vmCalls += 1;
							return "";
						},
					}),
				},
			});
			throws(
				() => queue.create("/private/tmp/fixture-project"),
				/birth identity unavailable/,
			);
			strictEqual(vmCalls, 0);
		} finally {
			if (previous === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = previous;
		}
	});
	it("refuses a real VM allocation without the authoritative run-store root", () => {
		let creates = 0;
		const backend = createQueueBackend({
			projectPath: "/private/tmp/fixture-project",
			runId: "fixture-run",
			dependencies: {
				goldenImage: "fixture-golden",
				aquaUid: "501",
				executionBackend: {
					create: () => {
						creates += 1;
					},
				},
			},
		});
		const original = process.env.SWITCHYARD_RUN_STORE_ROOT;
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		try {
			throws(
				() => backend.create("/private/tmp/fixture-project"),
				/RUN_STORE_ROOT/,
			);
		} finally {
			if (original === undefined) delete process.env.SWITCHYARD_RUN_STORE_ROOT;
			else process.env.SWITCHYARD_RUN_STORE_ROOT = original;
		}
		strictEqual(creates, 0);
	});

	it("rejects a missing Aqua UID before cloning", () => {
		let creates = 0;
		const backend = createQueueBackend({
			dependencies: {
				goldenImage: "fixture-golden",
				aquaUid: "",
				executionBackend: {
					create() {
						creates += 1;
					},
				},
			},
		});
		throws(() => backend.create("/fixture"), /SWITCHYARD_PARALLELS_AQUA_UID/);
		strictEqual(creates, 0);
	});

	it("surfaces Aqua wait and ready status for every queue create path", async () => {
		const entrypoints = [
			["sync", runQueue],
			["async", runQueueAsync],
			["orchestrator", runQueueWithOrchestrator],
		];

		for (const [name, entrypoint] of entrypoints) {
			const root = join(TEST_DIR, `aqua-status-${name}`);
			mkdirSync(root, { recursive: true });
			const tasksPath = join(root, "TASKS.md");
			const checkpointPath = join(root, "checkpoint.json");
			writeFileSync(
				tasksPath,
				withExplicitSwitchyardExecutor(
					"### Task 1.1: Bootstrap only\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** no task execution\n",
				),
			);
			const events = [];
			const backendFactory = () => ({
				readiness: () => ({ inventoryCount: 0 }),
				create(_path, { onStatus }) {
					onStatus({
						type: "aqua-wait",
						uuid: "vm-uuid",
						domain: "gui/501",
						elapsedMs: 250,
					});
					onStatus({
						type: "aqua-ready",
						uuid: "vm-uuid",
						domain: "gui/501",
					});
					return `${name}-container`;
				},
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			});

			const result = entrypoint({
				tasksFilePath: tasksPath,
				projectPath: root,
				checkpointPath,
				maxTasks: 0,
				dependencies: {
					backendFactory,
					onStatus: (event) => events.push(event),
					orchestrator: {
						launch: async () => "job",
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: null }),
					},
				},
			});
			await result;

			deepStrictEqual(
				events
					.filter(
						({ event }) => event === "aqua_wait" || event === "aqua_ready",
					)
					.map(({ phase, event, status }) => ({ phase, event, status })),
				[
					{
						phase: "bootstrap",
						event: "aqua_wait",
						status: "Waiting for Aqua session to become ready",
					},
					{
						phase: "bootstrap",
						event: "aqua_ready",
						status: "Aqua session ready",
					},
				],
				`${name} queue path must surface Aqua lifecycle status`,
			);
		}
	});
});

describe("attempt-scoped execution backend", () => {
	it("binds immutable sync context, preserves receivers, and rejects contradiction", () => {
		const seen = [];
		const backend = {
			label: "receiver",
			execArgv(_workspaceId, options) {
				strictEqual(this, backend);
				seen.push(options.cleanupContext);
				return { command: "true", args: [] };
			},
		};
		let adapterOptions;
		executeTask(
			{ id: "1.4", title: "marker", description: "marker" },
			{
				runId: "run-a",
				attemptId: "attempt-a",
				processStartIdentity: null,
				executionBackend: backend,
				route: () => ({ provider: "claude", model: "claude-sonnet-5" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: (_prompt, _workspace, options) => {
							adapterOptions = options;
							options.executionBackend.execArgv("vm", {});
							options.executionBackend.execArgv("vm", {
								cleanupContext: {
									...options.cleanupContext,
									operation: "helper",
								},
							});
							throws(
								() =>
									options.executionBackend.execArgv("vm", {
										cleanupContext: {
											...options.cleanupContext,
											attemptId: "other",
										},
									}),
								/contradictory cleanup context attemptId/,
							);
							return { success: false, output: "" };
						},
						captureDiff: (_workspace, options) => {
							options.executionBackend.execArgv("vm", {});
							return null;
						},
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "vm",
			},
		);
		ok(Object.isFrozen(adapterOptions.cleanupContext));
		strictEqual(seen[0].operation, "provider");
		strictEqual(seen[1].operation, "helper");
		strictEqual(seen[2].operation, "helper");
		strictEqual(seen[0].attemptId, "attempt-a");
		const beforeWrongWorkspace = seen.length;
		throws(
			() => adapterOptions.executionBackend.execArgv("other-vm", {}),
			/contradictory cleanup context workspaceId/,
		);
		strictEqual(seen.length, beforeWrongWorkspace);
	});

	it("binds helper context to a successful synchronous capture", () => {
		let observed;
		let captureFacade;
		let backendCalls = 0;
		const backend = {
			execArgv(_workspaceId, options) {
				backendCalls += 1;
				observed = options.cleanupContext;
				return { command: "true", args: [] };
			},
		};
		const result = executeTask(
			{ id: "1.4-success", title: "marker", description: "marker" },
			{
				runId: "run-sync-success",
				attemptId: "attempt-sync-success",
				executionBackend: backend,
				route: () => ({ provider: "claude", model: "claude-sonnet-5" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: (_workspace, options) => {
							captureFacade = options.executionBackend;
							options.executionBackend.execArgv("vm", {});
							return null;
						},
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "vm",
			},
		);
		strictEqual(result.success, true);
		strictEqual(observed.operation, "helper");
		strictEqual(observed.attemptId, "attempt-sync-success");
		const beforePromotion = backendCalls;
		throws(
			() =>
				captureFacade.execArgv("vm", {
					cleanupContext: { operation: "provider" },
				}),
			/helper cleanup context cannot become provider context/,
		);
		strictEqual(backendCalls, beforePromotion);
	});

	it("binds the same immutable context through the broker launcher", async () => {
		let observed;
		const backend = {
			execArgv(_workspaceId, options) {
				observed = options.cleanupContext;
				return { command: "true", args: [] };
			},
		};
		const descriptor = testDescriptor();
		const cleanupContext = {
			runId: "run-b",
			taskId: "1.4",
			attemptId: "attempt-b",
			descriptorIdentity: descriptor.descriptor_identity,
			workspaceId: "vm",
			processStartIdentity: null,
			operation: "provider",
		};
		const launch = createBrokerAdapterLauncher({
			adapter: {
				executeAsync: async (_prompt, _workspace, options) => {
					options.executionBackend.execArgv("vm", {});
					return { success: true, output: "ok" };
				},
			},
			executionBackend: backend,
			workingContainerName: "vm",
			prompt: "fixture",
			cleanupContext,
		});
		const route = {
			provider: "claude",
			resolvedTarget: "claude",
			harness: "claude",
			model: descriptor.selector,
			effort: null,
			reservation: { id: "reservation-1" },
		};
		await launch({
			request: { taskId: "1.4", attemptId: "attempt-b" },
			route,
			invocationDescriptor: descriptor,
			launcherIdentity: {
				...route,
				descriptorIdentity: descriptor.descriptor_identity,
				reservationId: "reservation-1",
			},
		});
		ok(Object.isFrozen(observed));
		strictEqual(observed.attemptId, "attempt-b");
	});

	it("keeps adapter evidence unpersisted until broker boundary", async () => {
		const descriptor = testDescriptor();
		const launch = createBrokerAdapterLauncher({
			adapter: {
				executeAsync: async () => ({
					success: false,
					diagnosticEvidence: {
						stdoutBytes: 3,
						stderrBytes: 0,
						stdoutDigest: `sha256:${"a".repeat(64)}`,
						stderrDigest: `sha256:${"b".repeat(64)}`,
					},
				}),
			},
			executionBackend: {},
			workingContainerName: "vm",
		});
		const route = {
			provider: "claude",
			resolvedTarget: "claude",
			harness: "claude",
			model: descriptor.selector,
			effort: null,
			reservation: { id: "reservation-1" },
		};
		const result = await launch({
			request: { taskId: "1.4", attemptId: "attempt-e" },
			route,
			invocationDescriptor: descriptor,
			launcherIdentity: {
				...route,
				descriptorIdentity: descriptor.descriptor_identity,
				reservationId: "reservation-1",
			},
		});
		strictEqual(result.diagnosticEvidence.stdoutBytes, 3);
		strictEqual(result.diagnosticRef, null);
		strictEqual(result.diagnosticEvidenceAvailable, false);
	});

	for (const success of [true, false]) {
		it(`binds the final broker attempt to ${success ? "success" : "failure"} capture`, async () => {
			let observed;
			const backend = {
				execArgv(_workspaceId, options) {
					observed = options.cleanupContext;
					return { command: "true", args: [] };
				},
			};
			const route = {
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTarget: "claude",
				harness: "claude",
				capability: "standard",
				reason: "fixture",
				snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
			};
			const result = await executeTaskAsync(
				{ id: `1.4-broker-${success}`, title: "marker", description: "marker" },
				{
					runId: "run-broker-capture",
					attemptId: `attempt-broker-${success}`,
					resolveDescriptor: () => testDescriptor(),
					executionBackend: backend,
					broker: {
						selectAndReserve: async () => route,
						launcherIdentity: () => ({}),
						execute: async () => ({
							success,
							outcome: success ? "success" : "failure",
							reason: success ? null : "fixture failure",
						}),
					},
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => ({ success: true }),
					adapters: {
						claude: {
							executeAsync: async () => ({ success: true }),
							captureDiffAsync: async (_workspace, options) => {
								options.executionBackend.execArgv("vm", {});
								return null;
							},
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "vm",
				},
			);
			strictEqual(result.success, success);
			strictEqual(observed.operation, "helper");
			strictEqual(observed.attemptId, `attempt-broker-${success}`);
		});
	}

	it("uses the fallback descriptor through the bound helper facade for base validation", async () => {
		const primaryDescriptor = testDescriptor({
			target_id: "primary-target",
			model_ref: "primary-model",
			selector: "primary-model",
		});
		const fallbackDescriptor = testDescriptor({
			target_id: "fallback-target",
			model_ref: "fallback-model",
			selector: "fallback-model",
		});
		const primaryRoute = {
			provider: "claude",
			resolvedTarget: "primary-target",
			resolvedTargetId: "primary-target",
			harness: "claude",
			model: "primary-model",
			capability: "standard",
			reason: "fixture",
			reservation: { id: "primary-reservation" },
			snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
		};
		const fallbackRoute = {
			...primaryRoute,
			resolvedTarget: "fallback-target",
			resolvedTargetId: "fallback-target",
			model: "fallback-model",
			reservation: { id: "fallback-reservation" },
		};
		const argumentBuilder = new ParallelsExecutionBackend({ aquaUid: 501 });
		const helperContexts = [];
		let captureError = null;
		const executionBackend = {
			execArgv(workspaceId, options) {
				argumentBuilder.execArgv(workspaceId, options);
				helperContexts.push({
					argv: options.argv,
					cleanupContext: options.cleanupContext,
				});
				if (options.argv[1] === "rev-parse") {
					return {
						command: process.execPath,
						args: [
							"-e",
							`process.stdout.write(${JSON.stringify(TASK_BASE.tree)})`,
						],
					};
				}
				const isDiff = options.argv.at(-1) === TASK_BASE.tree;
				return {
					command: process.execPath,
					args: [
						"-e",
						isDiff ? 'process.stdout.write("diff --git a/a b/a")' : "",
					],
				};
			},
		};
		let routeCalls = 0;
		let brokerCalls = 0;
		const context = {
			runId: "fallback-run",
			attemptId: "fallback-attempt",
			executionBackend,
			workingContainerName: "vm",
			projectPath: TEST_DIR,
			taskBases: {},
			persistTaskBase: (taskId, base) => {
				context.taskBases[taskId] = base;
			},
			queueBackend: {
				beforeRun: () => {},
				captureTaskBaseAsync: async () => TASK_BASE,
				validateTaskBaseAsync: async (_workspaceId, base) => base,
			},
			broker: {
				selectAndReserve: async () => {
					routeCalls += 1;
					return routeCalls === 1 ? primaryRoute : fallbackRoute;
				},
				launcherIdentity: () => ({}),
				execute: async () => {
					brokerCalls += 1;
					return brokerCalls === 1
						? {
								success: false,
								outcome: "failure",
								errorKind: "quota_exhausted",
								diagnosticCode: "quota_exhausted",
								diagnosticOrigin: "adapter",
								diagnosticEvidenceAvailable: true,
								diagnosticRef: VALID_DIAGNOSTIC_REF,
								failurePhase: "provider_execution",
							}
						: { success: true, outcome: "success" };
				},
			},
			resolveDescriptor: (target) =>
				target === "primary-target" ? primaryDescriptor : fallbackDescriptor,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true }),
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffDetailedAsync: async (workspaceId, options) => {
						try {
							await validateTaskStartTreeAsync(
								options.executionBackend,
								workspaceId,
								options.taskBase,
								{ cleanupContext: options.cleanupContext },
							);
						} catch (error) {
							captureError = error;
							return { status: "transport_failed", diff: null };
						}
						return { status: "captured", diff: "diff --git a/a b/a" };
					},
				},
			},
		};
		const first = await executeTaskAsync(
			{ id: "1.fallback", title: "fallback", description: "fallback" },
			context,
		);
		strictEqual(first.success, false);
		strictEqual(first.errorKind, "quota_exhausted");
		helperContexts.length = 0;
		const result = await executeTaskAsync(
			{ id: "1.fallback", title: "fallback", description: "fallback" },
			context,
		);
		strictEqual(
			captureError,
			null,
			captureError?.message ?? JSON.stringify(result),
		);
		strictEqual(result.success, true, JSON.stringify(result));
		strictEqual(brokerCalls, 2);
		strictEqual(
			context.taskBases["1.fallback"].cleanupContext.descriptorIdentity,
			primaryDescriptor.descriptor_identity,
		);
		ok(helperContexts.length >= 1);
		ok(helperContexts.some(({ argv }) => argv[1] === "rev-parse"));
		for (const { cleanupContext: helperContext } of helperContexts) {
			strictEqual(helperContext.operation, "helper");
			strictEqual(
				helperContext.descriptorIdentity,
				fallbackDescriptor.descriptor_identity,
			);
		}
	});
});

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

// These older runner fixtures predate the mandatory task-contract Executor:
// field. Normalize only the fixture text so the real parser receives an
// explicit field; the missing-Executor rejection is tested directly below.
function withExplicitSwitchyardExecutor(markdown) {
	const lines = markdown.split("\n");
	return lines
		.flatMap((line, index) => {
			if (!/^- \*\*Status:\*\*/.test(line)) return [line];
			const nextHeading = lines.findIndex(
				(candidate, candidateIndex) =>
					candidateIndex > index && /^### Task /.test(candidate),
			);
			const blockEnd = nextHeading === -1 ? lines.length : nextHeading;
			const hasExecutor = lines
				.slice(index + 1, blockEnd)
				.some((candidate) => /^- \*\*Executor:\*\*/.test(candidate));
			return hasExecutor ? [line] : [line, "- **Executor:** switchyard"];
		})
		.join("\n");
}

function parseFixture(markdown) {
	return parseTaskQueue(withExplicitSwitchyardExecutor(markdown));
}

function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, withExplicitSwitchyardExecutor(content), "utf8");
	return tasksPath;
}

function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});

describe("dispatch descriptor receipt contract", () => {
	it("fails closed when direct intent helpers have no writer", async () => {
		const payload = { taskId: "direct-missing", provider: "claude" };
		const syncFailure = writeDispatchIntent({}, payload);
		strictEqual(syncFailure.ledgerFailureCode, "missing_writer");
		strictEqual(
			(await writeDispatchIntentAsync({}, payload)).ledgerFailureCode,
			"missing_writer",
		);
	});

	it("fails closed on a thenable returned by a synchronous intent writer", () => {
		let executions = 0;
		const descriptor = testDescriptor();
		const base = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTargetId: "claude",
				resolved_harness: "claude",
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: () => {},
			adapters: {
				claude: {
					execute: () => {
						executions += 1;
						return { success: true };
					},
					captureDiff: () => null,
				},
			},
			workingContainerName: "fake-container",
			projectPath: TEST_DIR,
		};
		for (const writer of [
			() => Promise.resolve(),
			() => Promise.reject(new Error("synthetic writer failure")),
		]) {
			const result = executeTask(
				{ id: "direct-thenable", title: "task", description: "work" },
				{ ...base, recordDispatchIntent: writer },
			);
			strictEqual(result.result, "intent_receipt_failed");
			strictEqual(result.ledgerFailureCode, "async_writer");
		}
		strictEqual(executions, 0);
	});

	it("fails closed before adapter execution when the context writer is absent", () => {
		let executions = 0;
		const result = executeTask(
			{ id: "direct-no-writer", title: "task", description: "work" },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude",
					resolved_harness: "claude",
				}),
				resolveDescriptor: () => testDescriptor(),
				recordDispatch: () => {},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
						captureDiff: () => null,
					},
				},
				workingContainerName: "fake-container",
				projectPath: TEST_DIR,
			},
		);
		strictEqual(result.result, "intent_receipt_failed");
		strictEqual(result.ledgerFailureCode, "missing_writer");
		strictEqual(executions, 0);
	});

	it("rejects a missing or changed receipt before adapter execution", () => {
		let executions = 0;
		const descriptor = testDescriptor();
		const base = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTargetId: "claude",
				resolved_harness: "claude",
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: () => {},
			integrationGate: () => ({ success: true }),
			adapters: {
				claude: {
					execute: () => {
						executions += 1;
						return { success: true };
					},
					captureDiff: () => null,
				},
			},
			workingContainerName: "fake-container",
			projectPath: TEST_DIR,
		};
		const missing = executeTask(
			{ id: "1.1", title: "task", description: "work" },
			{
				...base,
				route: () => ({ ...base.route(), invocationDescriptor: null }),
			},
		);
		strictEqual(missing.result, "descriptor_receipt_invalid");
		const changed = executeTask(
			{ id: "1.1", title: "task", description: "work" },
			{
				...base,
				route: () => ({
					...base.route(),
					invocationDescriptor: testDescriptor({ selector: "claude-opus-4" }),
				}),
			},
		);
		strictEqual(changed.result, "descriptor_receipt_invalid");
		strictEqual(executions, 0);
	});

	it("fails closed when the authoritative intent receipt cannot be written", () => {
		let executions = 0;
		const descriptor = testDescriptor();
		const result = executeTask(
			{ id: "1.2", title: "task", description: "work", requiredPaths: null },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude",
					resolved_harness: "claude",
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {},
				integrationGate: () => ({ success: true }),
				recordDispatchIntent: () => {
					const error = new Error("EPERM: /private/host/path");
					error.code = "EPERM";
					throw error;
				},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
						captureDiff: () => null,
					},
				},
				workingContainerName: "fake-container",
				projectPath: TEST_DIR,
			},
		);
		strictEqual(result.result, "intent_receipt_failed");
		strictEqual(result.ledgerFailureCode, "EPERM");
		strictEqual(result.errorKind, "intent_receipt");
		strictEqual(executions, 0);
	});

	it("continues after a legacy projection failure once local intent succeeds", () => {
		let executions = 0;
		let intentWrites = 0;
		const descriptor = testDescriptor();
		const result = executeTask(
			{ id: "1.3", title: "task", description: "work", requiredPaths: null },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude",
					resolved_harness: "claude",
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {
					const error = new Error("EPERM: /private/host/path");
					error.code = "EPERM";
					throw error;
				},
				recordDispatchIntent: () => {
					intentWrites += 1;
				},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
						captureDiff: () => null,
					},
				},
				integrationGate: () => ({ success: true }),
				workingContainerName: "fake-container",
				projectPath: TEST_DIR,
			},
		);
		strictEqual(result.success, true);
		strictEqual(intentWrites, 1);
		strictEqual(executions, 1);
	});

	it("runQueue blocks adapter execution when its local intent writer rejects", () => {
		const tasksFilePath = writeTasksFile(`
### Task 1.6: intent gate
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** work
`);
		let executions = 0;
		const result = runQueue({
			tasksFilePath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: join(TEST_DIR, "intent-gate-checkpoint.json"),
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude",
					resolved_harness: "claude",
				}),
				resolveDescriptor: () => testDescriptor(),
				recordDispatch: () => {},
				recordDispatchIntent: () => {
					const error = new Error("EPERM: /private/host/path");
					error.code = "EPERM";
					throw error;
				},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
						captureDiff: () => null,
					},
				},
				integrationGate: () => ({ success: true }),
			},
		});
		strictEqual(result.results[0].result, "intent_receipt_failed");
		strictEqual(executions, 0);
	});

	it("writes the orchestrator intent before launch and blocks launch on failure", async () => {
		const descriptor = testDescriptor();
		const events = [];
		const base = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTargetId: "claude",
				resolved_harness: "claude",
			}),
			resolveDescriptor: () => descriptor,
			recordDispatch: () => {},
			workingContainerName: "fake-container",
			projectPath: TEST_DIR,
			pollIntervalMs: 1,
			maxPolls: 1,
			sleepFn: async () => {},
			integrationGate: () => ({ success: true }),
			adapters: { claude: {} },
		};
		const success = await executeTaskWithOrchestrator(
			{ id: "1.4", title: "task", description: "work" },
			{
				...base,
				recordDispatchIntent: () => events.push("intent"),
				orchestrator: {
					launch: async () => {
						events.push("launch");
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: null }),
				},
			},
		);
		strictEqual(success.success, true);
		deepStrictEqual(events, ["intent", "launch"]);

		let launched = false;
		const blocked = await executeTaskWithOrchestrator(
			{ id: "1.5", title: "task", description: "work" },
			{
				...base,
				recordDispatchIntent: () => {
					const error = new Error("EPERM: /private/host/path");
					error.code = "EPERM";
					throw error;
				},
				orchestrator: {
					launch: async () => {
						launched = true;
						return "job-2";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: null }),
				},
			},
		);
		strictEqual(blocked.result, "intent_receipt_failed");
		strictEqual(launched, false);
	});

	it("fails before orchestrator launch when the task-base probe exhausts its budget", async () => {
		let launches = 0;
		const statuses = [];
		const result = await executeTaskWithOrchestrator(
			{ id: "1.6", title: "task", description: "work" },
			{
				route: () => ({ provider: "claude", model: "test-model" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				workingContainerName: "worker",
				projectPath: TEST_DIR,
				adapters: { claude: {} },
				queueBackend: {
					beforeRun: () => {},
					captureTaskBaseAsync: async () => {
						throw new Error("task base probe deadline exhausted");
					},
				},
				onStatus: (status) => statuses.push(status),
				orchestrator: {
					launch: async () => {
						launches += 1;
						return "job";
					},
				},
			},
		);
		strictEqual(result.result, "task_base_capture_failed");
		strictEqual(launches, 0);
		ok(statuses.some(({ event }) => event === "task_base_failed"));
	});

	it("does not recapture a corrupt persisted base for an active attempt", () => {
		let captures = 0;
		let executions = 0;
		const result = executeTask(
			{ id: "1.9", title: "task", description: "work" },
			{
				route: () => ({ provider: "claude", model: "test-model" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				workingContainerName: "worker",
				projectPath: TEST_DIR,
				taskBases: { 1.9: TASK_BASE },
				queueBackend: {
					beforeRun: () => {},
					captureTaskBase: () => {
						captures += 1;
						return TASK_BASE;
					},
					validateTaskBase: () => {
						throw new Error("missing anchor");
					},
				},
				adapters: {
					claude: {
						execute: () => {
							executions += 1;
							return { success: true };
						},
					},
				},
			},
		);
		strictEqual(result.result, "task_base_capture_failed");
		strictEqual(captures, 0);
		strictEqual(executions, 0);
	});

	for (const foreignField of ["runId", "taskId", "workspaceId"]) {
		it(`rejects persisted task-base metadata with a foreign ${foreignField}`, () => {
			let validations = 0;
			let executions = 0;
			const cleanupContext = {
				runId: "run-owned",
				taskId: "1.ownership",
				attemptId: "attempt-original",
				descriptorIdentity: "descriptor-original",
				workspaceId: "worker-owned",
				processStartIdentity: null,
				operation: "helper",
				[foreignField]: "foreign",
			};
			const result = executeTask(
				{ id: "1.ownership", title: "task", description: "work" },
				{
					runId: "run-owned",
					route: () => ({ provider: "claude", model: "test-model" }),
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					workingContainerName: "worker-owned",
					projectPath: TEST_DIR,
					taskBases: {
						"1.ownership": { ...TASK_BASE, cleanupContext },
					},
					queueBackend: {
						beforeRun: () => {},
						validateTaskBase: () => {
							validations += 1;
							return TASK_BASE;
						},
					},
					adapters: {
						claude: {
							execute: () => {
								executions += 1;
								return { success: true };
							},
						},
					},
				},
			);
			strictEqual(result.result, "task_base_capture_failed");
			strictEqual(validations, 0);
			strictEqual(executions, 0);
		});
	}

	it("uses host-captured orchestrator bytes and rejects a contradictory base receipt", async () => {
		let gatedDiff = null;
		let captureCleanupContext = null;
		let captureError = null;
		const context = {
			runId: "orchestrator-capture-run",
			attemptId: "orchestrator-capture-attempt",
			route: () => ({ provider: "claude", model: "test-model" }),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			workingContainerName: "worker",
			projectPath: TEST_DIR,
			pollIntervalMs: 1,
			maxPolls: 1,
			sleepFn: async () => {},
			adapters: {
				claude: {
					captureDiffAsync: async (_workspace, options) => {
						try {
							options.executionBackend.execArgv("worker", {});
						} catch (error) {
							captureError = error;
							throw error;
						}
						return "authoritative-host-diff";
					},
				},
			},
			executionBackend: {
				execArgv(_workspace, options) {
					captureCleanupContext = options.cleanupContext;
					return { command: "true", args: [] };
				},
			},
			integrationGate: (diff) => {
				gatedDiff = diff;
				return { success: true };
			},
			orchestrator: {
				launch: async () => "job",
				status: async () => ({ state: "done" }),
				result: async () => ({
					success: true,
					diff: "untrusted-returned-diff",
				}),
			},
		};
		const accepted = await executeTaskWithOrchestrator(
			{ id: "1.7", title: "task", description: "work" },
			context,
		);
		strictEqual(
			accepted.success,
			true,
			`${JSON.stringify(accepted)} capture=${captureError?.message}`,
		);
		strictEqual(gatedDiff, "authoritative-host-diff");
		strictEqual(captureCleanupContext.operation, "helper");
		strictEqual(captureCleanupContext.workspaceId, "worker");

		const rejected = await executeTaskWithOrchestrator(
			{ id: "1.8", title: "task", description: "work" },
			{
				...context,
				orchestrator: {
					...context.orchestrator,
					result: async () => ({
						success: true,
						taskBase: { ...TASK_BASE, tree: "9".repeat(40) },
					}),
				},
			},
		);
		strictEqual(rejected.result, "task_base_capture_failed");

		const opencodeDescriptor = descriptorForRoute({
			provider: "OpenCode Go",
			resolved_harness: "opencode",
			resolvedTargetId: "opencode-go",
			model: "fixture/opencode-low",
		});
		for (const hostDiff of ["authoritative-opencode-diff", ""]) {
			let captures = 0;
			const result = await executeTaskWithOrchestrator(
				{
					id: `1.openc-${hostDiff.length}`,
					title: "task",
					description: "work",
				},
				{
					...context,
					route: () => ({
						provider: "OpenCode Go",
						model: "fixture/opencode-low",
						resolvedTargetId: "opencode-go",
						resolved_harness: "opencode",
						invocationDescriptor: opencodeDescriptor,
					}),
					resolveDescriptor: () => opencodeDescriptor,
					adapters: {
						opencode: {
							captureDiffAsync: async () => {
								captures += 1;
								return hostDiff;
							},
						},
					},
				},
			);
			strictEqual(result.success, true);
			strictEqual(captures, 1);
		}
	});
});

function testDescriptor(overrides = {}) {
	const core = {
		target_id: "claude",
		model_ref: "claude-sonnet-5",
		selector: "claude-sonnet-5",
		effort: null,
		variant: null,
		invocation_args: [],
		...overrides,
	};
	return validateInvocationDescriptor(
		{
			...core,
			descriptor_identity: getInvocationDescriptorIdentity(core, "claude"),
		},
		"claude",
	);
}

function descriptorForRoute(routeResult) {
	if (!routeResult?.provider) return null;
	const harness = routeResult.provider
		.replace(/^antigravity-claude$/, "agy")
		.replace(/^opencode-go$/, "opencode");
	const model = routeResult.model ?? "test-model";
	const core = {
		target_id: routeResult.resolvedTargetId ?? routeResult.provider,
		model_ref: model,
		selector: model,
		effort: null,
		variant: null,
		invocation_args: [],
	};
	return {
		...core,
		descriptor_identity: getInvocationDescriptorIdentity(core, harness),
	};
}

function withTestDescriptorContext(context) {
	let latest = null;
	let launchedTaskBase = null;
	let orchestratorDiff = "";
	const originalRoute = context.route;
	const originalResolveDescriptor = context.resolveDescriptor;
	const route = (options) => {
		const routed = originalRoute(options);
		if (routed?.provider && !adapters[routed.provider]) {
			adapters[routed.provider] = {
				captureDiffAsync: async () => orchestratorDiff,
			};
		}
		latest = descriptorForRoute(routed);
		return latest && routed && !Object.hasOwn(routed, "invocationDescriptor")
			? { ...routed, invocationDescriptor: latest }
			: routed;
	};
	const orchestrator = context.orchestrator
		? {
				...context.orchestrator,
				launch: async (payload) => {
					launchedTaskBase = payload.taskBase;
					return context.orchestrator.launch(payload);
				},
				result: async (jobId) => {
					const result = await context.orchestrator.result(jobId);
					orchestratorDiff =
						typeof result?.diff === "string" ? result.diff : "";
					return context.requireExplicitTaskBaseResult
						? result
						: { ...result, taskBase: result?.taskBase ?? launchedTaskBase };
				},
			}
		: undefined;
	const fixtureAdapters =
		context.adapters ??
		(context.orchestrator
			? Object.fromEntries(
					[
						"claude",
						"codex",
						"agy",
						"cursor",
						"copilot",
						"opencode",
						"vibe",
					].map((name) => [name, {}]),
				)
			: {});
	const adapters = Object.fromEntries(
		Object.entries(fixtureAdapters).map(([name, adapter]) => [
			name,
			{
				...adapter,
				captureDiffAsync:
					adapter.captureDiffAsync ?? (async () => orchestratorDiff),
			},
		]),
	);
	return {
		...context,
		...(orchestrator ? { orchestrator } : {}),
		adapters,
		queueBackend: context.queueBackend ?? {
			beforeRun: () => {},
			afterRun: () => {},
			captureTaskBase: () => TASK_BASE,
			validateTaskBase: (_workspaceId, base) => base,
			releaseTaskBase: () => {},
		},
		taskBases: context.taskBases ?? {},
		persistTaskBase: context.persistTaskBase ?? (() => {}),
		route,
		resolveDescriptor: (...args) =>
			latest ?? originalResolveDescriptor?.(...args) ?? null,
	};
}

function executeTask(task, context) {
	return executeTaskImpl(task, withTestDescriptorContext(context));
}

async function executeTaskWithOrchestrator(task, context) {
	return executeTaskWithOrchestratorImpl(
		task,
		withTestDescriptorContext(context),
	);
}

async function executeTaskAsync(task, context) {
	return executeTaskAsyncImpl(task, withTestDescriptorContext(context));
}

// Legacy per-method container-lifecycle stubs (ensureAgentContainer,
// createWorkingContainer, provisionCredentials, seedProject,
// commitWorkingTree, resetWorkingTree, wipeWorkingContainer) predate
// createQueueBackend's dependencies.backendFactory seam and are no longer
// read directly by production code -- only a backendFactory returning a
// full {create, destroy, seed, commit, reset, ...} object is honored (see
// runner/index.mjs's createQueueBackend, which falls through to the real
// ParallelsExecutionBackend when no backendFactory -- or an incomplete one
// -- is supplied). Synthesize a backendFactory from these flat keys here so
// the dozens of tests written against the old shape keep exercising the
// same stub behavior without a per-test rewrite. Call signatures mirror the
// real production call sites exactly: create(projectPath, {runId}),
// provision(name), seed(name, projectPath), commit(name), reset(name),
// destroy(name), ensureAgentContainer().
function legacyBackendFactory(dependencies) {
	return () => ({
		executionBackend: dependencies.executionBackend,
		readiness: dependencies.hostReadiness ?? (() => ({ inventoryCount: 0 })),
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
	});
}

function withTestDescriptorOptions(options) {
	const dependencies = options.dependencies ?? {};
	const context = withTestDescriptorContext({
		...dependencies,
		route: dependencies.route ?? realRoute,
	});
	const testIdentityResolver =
		dependencies.resolveTargetIdentity ??
		(dependencies.route
			? (provider) => {
					const routed = context.route({
						requiredCapability: "standard",
						availableProviders: Object.keys(context.adapters ?? {}),
					});
					if (routed?.provider !== provider) {
						return { targetId: null, harnessKey: null, ambiguous: true };
					}
					return {
						targetId: routed.resolvedTargetId ?? routed.resolvedTarget ?? null,
						harnessKey: routed.resolved_harness ?? routed.harness ?? provider,
						ambiguous: false,
					};
				}
			: undefined);
	return {
		...options,
		platform: options.platform ?? "macos",
		dependencies: {
			...dependencies,
			route: context.route,
			resolveDescriptor: context.resolveDescriptor,
			adapters: context.adapters,
			...(context.orchestrator ? { orchestrator: context.orchestrator } : {}),
			// macOS/Parallels is the sole execution backend now, so every
			// runQueue* call through this helper runs the real provider
			// preflight gate unless a test overrides it. The overwhelming
			// majority of these tests exercise dispatch/retry/ledger/
			// orchestration logic downstream of admission, not the gate
			// itself (that's covered directly in the "Task 6.1"/"Task 6.3"
			// describe blocks below, which call runQueueImpl or
			// preflightMacosQueue directly and so never pass through this
			// helper) -- so default preflight to a no-op here and let a
			// test that actually wants real gate behavior override
			// dependencies.queuePreflight explicitly.
			queuePreflight:
				dependencies.queuePreflight ?? (() => ({ ok: true, eligible: true })),
			backendFactory:
				dependencies.backendFactory ?? legacyBackendFactory(dependencies),
			...(testIdentityResolver
				? { resolveTargetIdentity: testIdentityResolver }
				: {}),
		},
	};
}

function runQueue(options) {
	return runQueueImpl(withTestDescriptorOptions(options));
}

async function runQueueAsync(options) {
	return runQueueAsyncImpl(withTestDescriptorOptions(options));
}

async function runQueueWithOrchestrator(options) {
	return runQueueWithOrchestratorImpl(withTestDescriptorOptions(options));
}

describe("runner queue parsing", () => {
	it("parses task blocks with status and description", () => {
		const markdown = `## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do first thing

### Task 1.2: Second task
- **Status:** in progress
- **Files:** src/a.mjs
- **Description:** Do second thing
`;

		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 2);
		strictEqual(tasks[0].id, "1.1");
		strictEqual(tasks[0].status, "pending");
		strictEqual(tasks[1].id, "1.2");
		strictEqual(tasks[1].status, "in progress");
	});

	it("parses tasks with Work or unlabelled body sections", () => {
		const markdown = `
### Task 2.1: Work section task
- **Status:** pending
- **Files:** src/a.mjs
- **Work:** Do the work steps

### Task 2.2: Raw body task
- **Status:** pending
- **Files:** src/a.mjs
1. Step one
2. Step two
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 2);
		strictEqual(tasks[0].description, "Do the work steps");
		strictEqual(tasks[1].description.includes("Step one"), true);
	});

	it("returns runnable tasks excluding completed checkpoint IDs", () => {
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "in progress" },
			{ id: "1.3", status: "done" },
		];
		const checkpoint = {
			completedTaskIds: ["1.1"],
		};
		const runnable = getRunnableTasks(tasks, checkpoint);
		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.2"],
		);
	});

	it("warns and excludes a task with an unrecognized status instead of silently dropping it", () => {
		// Regression (Task 12): the old filter matched exactly
		// `pending`/`in progress`, so a typo'd status was excluded with no
		// signal, indistinguishable from a deliberate skip. The task must now
		// still be excluded, but the exclusion must be *visible*. The
		// discriminating assertion is that console.error fires — the old code
		// also excluded it, so "excluded" alone would pass on the unfixed code.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "pnding" }, // typo
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1"],
		);
		strictEqual(warnings.length, 1);
		ok(warnings[0].includes("1.2"));
		ok(warnings[0].includes("pnding"));
	});

	it("excludes recognized non-runnable statuses (done, blocked) without any warning", () => {
		// `done` and `blocked` are documented project vocabulary — an
		// intentional skip, not a mistake — so they must be excluded silently.
		// Warning on them (e.g. on every completed task) would be pure noise.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.2", status: "done" },
			{ id: "1.3", status: "blocked" },
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1"],
		);
		strictEqual(warnings.length, 0);
	});

	it("normalizes case and surrounding whitespace before matching status", () => {
		// A differently-cased or padded status is a recognized status, not an
		// unrecognized one — it must run, not warn.
		const tasks = [
			{ id: "1.1", status: "  Pending  " },
			{ id: "1.2", status: "IN PROGRESS" },
		];
		const warnings = [];
		const originalError = console.error;
		console.error = (...args) => {
			warnings.push(args.join(" "));
		};
		let runnable;
		try {
			runnable = getRunnableTasks(tasks, { completedTaskIds: [] });
		} finally {
			console.error = originalError;
		}

		deepStrictEqual(
			runnable.map((task) => task.id),
			["1.1", "1.2"],
		);
		strictEqual(warnings.length, 0);
	});

	it("throws on duplicate task IDs within one parse instead of yielding both", () => {
		// Regression (Task 12): a malformed queue with two blocks sharing an id
		// previously returned both — `done.has(id)` only checks the checkpoint's
		// completed set, not IDs already yielded in this same pass — so both
		// would execute in one run. Fail loudly, matching loadCheckpoint's
		// posture on malformed input.
		const tasks = [
			{ id: "1.1", status: "pending" },
			{ id: "1.1", status: "pending" },
		];
		throws(
			() => getRunnableTasks(tasks, { completedTaskIds: [] }),
			/duplicate task id "1\.1"/,
		);
	});

	it("extracts requiredPaths from a Files: field", () => {
		const markdown = `## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** src/a.mjs, tests/a.test.mjs
- **Description:** Do things with files
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		deepStrictEqual(tasks[0].requiredPaths, ["src/a.mjs", "tests/a.test.mjs"]);
	});

	it("unwraps one matching inline-code pair per Files entry", () => {
		const markdown = `## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** \`src/a.mjs\`, tests/a.test.mjs, \`HISTORY.md\`
- **Description:** Do things with files
`;
		const tasks = parseFixture(markdown);
		deepStrictEqual(tasks[0].requiredPaths, [
			"src/a.mjs",
			"tests/a.test.mjs",
			"HISTORY.md",
		]);
	});

	it("rejects malformed inline-code wrappers in Files entries", () => {
		for (const filesValue of [
			"`src/a.mjs",
			"src/a.mjs`",
			"``src/a.mjs``",
			"`src/`a.mjs`",
		]) {
			const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** ${filesValue}
- **Description:** Bad
`;
			throws(
				() => parseFixture(markdown),
				/(?:unmatched|malformed) inline-code/,
			);
		}
	});

	it("applies existing path validation after inline-code unwrapping", () => {
		for (const [filesValue, message] of [
			["`/etc/passwd`", /absolute path/],
			["`../outside/evil.mjs`", /path traversal/],
			["`src/*.mjs`", /wildcards/],
			["`src/`", /directory-only/],
			["src//empty.mjs", /empty path component/],
		]) {
			const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** ${filesValue}
- **Description:** Bad
`;
			throws(() => parseFixture(markdown), message);
		}
	});

	it("sets requiredPaths to null when no Files: field is present on a review task", () => {
		const markdown = `## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Type:** review
- **Description:** Do things
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].requiredPaths, null);
	});

	it("rejects a Files: field with an absolute path", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** /etc/passwd
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /absolute path/);
	});

	it("rejects a Files: field with '..' traversal", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** ../outside/evil.mjs
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /path traversal/);
	});

	it("rejects a Files: field with a wildcard", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/*.mjs
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /wildcards/);
	});

	it("rejects an empty Files: field (no paths)", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:**   	
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /empty/);
	});

	it("rejects a Files: field with backslash separators", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src\\evil.mjs
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /backslash/);
	});

	it("rejects a Files: field with directory-only entries", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /directory-only/);
	});

	it("rejects a Files: field with duplicate paths", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs, src/a.mjs
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /duplicate/);
	});

	it("matches the shared task-file path corpus", () => {
		const corpus = JSON.parse(
			readFileSync(
				join(cwd(), "tests/fixtures/task-file-path-corpus.json"),
				"utf8",
			),
		);
		for (const fixture of corpus) {
			const markdown = `### Task 1.1: Corpus\n- **Status:** pending\n- **Files:** ${fixture.path}\n`;
			if (fixture.valid) {
				strictEqual(parseFixture(markdown)[0].requiredPaths[0], fixture.path);
			} else {
				throws(() => parseFixture(markdown), new RegExp(fixture.reason));
			}
		}
	});

	it("validates Files entries against the project before backend preflight", () => {
		const root = join(TEST_DIR, "files-contract");
		mkdirSync(join(root, "existing-dir"), { recursive: true });
		mkdirSync(join(root, "outside"), { recursive: true });
		writeFileSync(join(root, "existing.mjs"), "export {}\n");
		symlinkSync("existing.mjs", join(root, "link.mjs"));
		symlinkSync("outside", join(root, "linked-dir"));
		const cases = [
			["existing-dir", /regular file, not a directory or symlink/],
			["link.mjs", /regular file, not a directory or symlink/],
			["linked-dir/future.mjs", /symlink directory/],
			["future.mjs", null],
			["..cache/new-file.mjs", null],
		];
		for (const [path, expected] of cases) {
			const tasksPath = join(root, `${path.replaceAll("/", "-")}.md`);
			writeFileSync(
				tasksPath,
				`### Task 1.1: File task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** ${path}\n- **Description:** fixture\n`,
			);
			let preflightCalls = 0;
			const invoke = () =>
				runQueueImpl({
					tasksFilePath: tasksPath,
					projectPath: root,
					platform: "macos",
					checkpointPath: `${tasksPath}.checkpoint.json`,
					dependencies: {
						queuePreflight: () => {
							preflightCalls += 1;
						},
						backendFactory: () => ({
							platform: "macos",
							preflight: () => {
								preflightCalls += 1;
							},
						}),
					},
				});
			if (expected) throws(invoke, expected);
			else throws(invoke);
			strictEqual(preflightCalls, expected ? 0 : 1);
		}
	});

	it("ignores prose-embedded Files: mentions and only matches - **Files:** lines", () => {
		const markdown = `## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This mentions Files: but without the bullet anchor
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		deepStrictEqual(tasks[0].requiredPaths, ["src/a.mjs"]);
	});

	it("extracts timeoutMs from a Timeout: field in minutes", () => {
		const markdown = `## Phase 1

### Task 1.1: Long task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 90m
- **Description:** Needs more than the default 30 minutes
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].timeoutMs, 90 * 60 * 1000);
	});

	it("extracts timeoutMs from a Timeout: field in seconds, hours, and fractional hours", () => {
		strictEqual(
			parseFixture(
				"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Timeout:** 45s\n",
			)[0].timeoutMs,
			45 * 1000,
		);
		strictEqual(
			parseFixture(
				"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Timeout:** 2h\n",
			)[0].timeoutMs,
			2 * 3_600_000,
		);
		strictEqual(
			parseFixture(
				"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Timeout:** 1.5h\n",
			)[0].timeoutMs,
			1.5 * 3_600_000,
		);
	});

	it("sets timeoutMs to null when no Timeout: field is present", () => {
		const markdown = `## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do things
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].timeoutMs, null);
	});

	it("rejects a Timeout: field without a unit suffix (bare number is ambiguous)", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 90
- **Description:** Bad
`;
		throws(
			() => parseFixture(markdown),
			/expected a number followed by s\/m\/h/,
		);
	});

	it("rejects a Timeout: field with an unsupported unit", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 90ms
- **Description:** Bad
`;
		throws(
			() => parseFixture(markdown),
			/expected a number followed by s\/m\/h/,
		);
	});

	it("rejects a Timeout: field below the 1-second floor", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 0s
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /must be between 1s and 24h/);
	});

	it("rejects a Timeout: field above the 24-hour typo-guard ceiling", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Timeout:** 48h
- **Description:** Bad
`;
		throws(() => parseFixture(markdown), /must be between 1s and 24h/);
	});

	it("extracts requiredCapability from RequiredCapability:, normalizing case", () => {
		const markdown = `## Phase 1

### Task 1.1: Declared capability task
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **RequiredCapability:** Standard
- **Description:** Task prose does not select the capability lane
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].requiredCapability, "standard");
		strictEqual(tasks[0].executor, "switchyard");
	});

	it("sets requiredCapability to null when Executor is explicit", () => {
		const markdown = `## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **Description:** Do things
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].requiredCapability, null);
		strictEqual(tasks[0].executor, "switchyard");
	});

	it("rejects a task contract with no Executor field", () => {
		const markdown = `### Task 1.1: Missing executor
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do things
`;
		throws(
			() => parseTaskQueue(markdown),
			/Task 1.1: missing Executor field \(expected one of: native, switchyard, human\)/,
		);
	});

	it("rejects the retired Tier: field instead of accepting it as an alias", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad task
- **Status:** pending
- **Files:** src/a.mjs
- **Tier:** urgent
- **Description:** Bad
`;
		throws(
			() => parseFixture(markdown),
			/Tier is a retired task-contract field/,
		);
	});

	it("rejects duplicate, mixed, empty, and invalid RequiredCapability declarations", () => {
		const cases = [
			[
				"- **RequiredCapability:** high\n- **RequiredCapability:** low",
				/duplicate RequiredCapability/,
			],
			["- **RequiredCapability:** high, standard", /mixed RequiredCapability/],
			["- **RequiredCapability:**", /RequiredCapability field is empty/],
			["- **RequiredCapability:** urgent", /invalid RequiredCapability field/],
		];

		for (const [declaration, error] of cases) {
			const markdown = `### Task 1.1: Bad capability\n- **Status:** pending\n- **Files:** src/a.mjs\n${declaration}\n`;
			throws(() => parseFixture(markdown), error);
		}
	});

	it("requires a non-empty justification for explicit low/high capabilities", () => {
		for (const capability of ["high", "low"]) {
			const markdown = `### Task 1.1: Missing justification
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **RequiredCapability:** ${capability}
- **Description:** Work
`;
			throws(
				() => parseFixture(markdown),
				/RequiredCapabilityJustification is required for explicit/,
			);
		}
	});

	it("rejects an empty RequiredCapabilityJustification field", () => {
		const markdown = `### Task 1.1: Empty justification
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **RequiredCapability:** low
- **RequiredCapabilityJustification:**
- **Description:** Work
`;
		throws(
			() => parseFixture(markdown),
			/RequiredCapabilityJustification field is empty/,
		);
	});

	it("rejects duplicate RequiredCapabilityJustification declarations", () => {
		const markdown = `### Task 1.1: Duplicate justification
- **Status:** pending
- **Files:** src/a.mjs
- **Executor:** switchyard
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** First reason
- **RequiredCapabilityJustification:** Second reason
- **Description:** Work
`;
		throws(
			() => parseFixture(markdown),
			/duplicate RequiredCapabilityJustification declarations/,
		);
	});

	it("parses Executor strictly and normalizes accepted values", () => {
		for (const executor of ["Native", "SWITCHYARD", "human"]) {
			const files =
				executor.toLowerCase() === "switchyard"
					? "- **Files:** src/a.mjs\n"
					: "";
			const markdown = `### Task 1.1: Executor task\n- **Status:** pending\n${files}- **Executor:** ${executor}\n- **Description:** Work\n`;
			strictEqual(parseFixture(markdown)[0].executor, executor.toLowerCase());
		}
	});

	it("rejects duplicate, empty, and invalid Executor declarations", () => {
		const cases = [
			["- **Executor:** native\n- **Executor:** human", /duplicate Executor/],
			["- **Executor:**", /invalid Executor field/],
			["- **Executor:** provider", /invalid Executor field/],
		];

		for (const [declaration, error] of cases) {
			const markdown = `### Task 1.1: Bad executor\n- **Status:** pending\n- **Type:** review\n${declaration}\n`;
			throws(() => parseFixture(markdown), error);
		}
	});

	it("defaults type to implementation when no Type: field is present", () => {
		const markdown = `## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do things
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].type, "implementation");
	});

	it("extracts type from a Type: field, accepting explicit review and normalizing case", () => {
		const markdown = `## Phase 1

### Task 1.1: Review task
- **Status:** pending
- **Files:** src/a.mjs
- **Type:** Review
- **Description:** Perform code review
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].type, "review");
	});

	it("rejects a Type: field with an unrecognized value, failing closed at parse time", () => {
		const markdown = `## Phase 1

### Task 1.1: Bad type task
- **Status:** pending
- **Files:** src/a.mjs
- **Type:** audit
- **Description:** Bad type
`;
		throws(
			() => parseFixture(markdown),
			/invalid Type field "audit" \(expected one of: implementation, review\)/,
		);
	});

	it("rejects a switchyard implementation task without Files: field, failing closed at parse time", () => {
		const markdown = `## Phase 1

### Task 1.1: Implementation task without files
- **Status:** pending
- **Type:** implementation
- **Executor:** switchyard
- **Description:** Do work
`;
		throws(
			() => parseFixture(markdown),
			/Task 1.1: switchyard implementation task requires a Files: field/,
		);
	});

	it("allows native and human implementation tasks without Files: field", () => {
		const markdown = `## Phase 1

### Task 1.1: Non-switchyard implementation task without files
- **Status:** pending
- **Executor:** native
- **Description:** Do work
`;
		strictEqual(parseFixture(markdown)[0].requiredPaths, null);
	});

	it("allows review-type task without Files: field, leaving requiredPaths as null", () => {
		const markdown = `## Phase 1

### Task 1.1: Review task without files
- **Status:** pending
- **Type:** review
- **Description:** Review PR
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].type, "review");
		strictEqual(tasks[0].requiredPaths, null);
	});

	it("parses AllowManifests: true and returns allowManifests: true", () => {
		const markdown = `## Phase 1

### Task 1.1: Opt in to manifests
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** true
- **Description:** Update dependencies
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].allowManifests, true);
	});

	it("parses AllowManifests: false and returns allowManifests: false without manifest authority", () => {
		const markdown = `## Phase 1

### Task 1.1: Explicitly disable manifests
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** false
- **Description:** Update dependencies
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].allowManifests, false);
	});

	it("defaults allowManifests to false when AllowManifests is omitted", () => {
		const markdown = `## Phase 1

### Task 1.1: Omitted AllowManifests
- **Status:** pending
- **Files:** src/index.mjs
- **Description:** Update code
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 1);
		strictEqual(tasks[0].allowManifests, false);
	});

	it("rejects non-boolean AllowManifests values, failing closed before routing", () => {
		const invalidValues = [
			"True",
			"False",
			"TRUE",
			"FALSE",
			"yes",
			"no",
			"1",
			"0",
			"maybe",
			"",
		];
		for (const val of invalidValues) {
			const markdown = `## Phase 1

### Task 1.1: Bad AllowManifests
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** ${val}
- **Description:** Update dependencies
`;
			throws(
				() => parseFixture(markdown),
				/AllowManifests must be true or false when present/,
			);
		}
	});

	it("rejects duplicate AllowManifests declarations", () => {
		const markdown = `## Phase 1

### Task 1.1: Duplicate AllowManifests
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** true
- **AllowManifests:** false
- **Description:** Update dependencies
`;
		throws(
			() => parseFixture(markdown),
			/duplicate AllowManifests declarations are not allowed/,
		);
	});

	it("rejects AllowManifests on review tasks", () => {
		for (const boolVal of ["true", "false"]) {
			const markdown = `## Phase 1

### Task 1.1: Review task with AllowManifests
- **Status:** pending
- **Type:** review
- **AllowManifests:** ${boolVal}
- **Description:** Review dependencies
`;
			throws(
				() => parseFixture(markdown),
				/AllowManifests is only supported for implementation-type tasks/,
			);
		}
	});
});

describe("AllowManifests execution authority and pre-routing rejection", () => {
	it("passes allowSensitiveManifests: false to integrationGate when AllowManifests: false", () => {
		const markdown = `## Phase 1

### Task 1.1: AllowManifests false task
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** false
- **Description:** No manifest authority
`;
		const task = parseFixture(markdown)[0];
		strictEqual(task.allowManifests, false);

		const gateCalls = [];
		const result = executeTask(task, {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 50,
				reason: "spread",
			}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: (diff, projectPath, options) => {
				gateCalls.push({ diff, projectPath, options });
				return { success: true, message: "ok" };
			},
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/package.json b/package.json",
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.allowSensitiveManifests, false);
	});

	it("passes allowSensitiveManifests: true to integrationGate when AllowManifests: true", () => {
		const markdown = `## Phase 1

### Task 1.1: AllowManifests true task
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** true
- **Description:** Authorized manifest change
`;
		const task = parseFixture(markdown)[0];
		strictEqual(task.allowManifests, true);

		const gateCalls = [];
		const result = executeTask(task, {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 50,
				reason: "spread",
			}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: (diff, projectPath, options) => {
				gateCalls.push({ diff, projectPath, options });
				return { success: true, message: "ok" };
			},
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/package.json b/package.json",
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.allowSensitiveManifests, true);
	});

	it("fails before routing when task contains invalid AllowManifests value", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Invalid AllowManifests task
- **Status:** pending
- **Files:** package.json
- **AllowManifests:** invalid_value
- **Description:** Bad value
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		let routeCalled = false;
		throws(
			() =>
				runQueue({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {
						route: () => {
							routeCalled = true;
							return {
								provider: "claude",
								model: "claude-sonnet-5",
								percentLeft: 50,
								reason: "spread",
							};
						},
						recordDispatch: () => {},
						recordDispatchIntent: () => {},
						integrationGate: () => ({ success: true }),
						adapters: {
							claude: {
								execute: () => ({ success: true, output: "ok" }),
								captureDiff: () => "diff",
							},
						},
					},
				}),
			/AllowManifests must be true or false when present/,
		);
		strictEqual(routeCalled, false);
	});
});

describe("async runner provider lifecycle", () => {
	async function runAsyncRedactionCase({ execution, integrationGate }) {
		const root = join(
			TEST_DIR,
			`async-redaction-${Date.now()}-${Math.random()}`,
		);
		mkdirSync(root, { recursive: true });
		const tasksPath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		writeFileSync(
			tasksPath,
			"### Task 4.2: Async redaction\n- **Status:** pending\n- **Type:** review\n- **Description:** exercise redaction\n- **Executor:** switchyard\n",
		);
		const descriptor = descriptorForRoute({
			provider: "opencode",
			resolved_harness: "opencode",
			resolvedTargetId: "async-target",
			model: "fake-model",
		});
		let observed;
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: root,
			workingContainerName: "async-worker",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "opencode",
					resolved_harness: "opencode",
					resolvedTargetId: "async-target",
					model: "fake-model",
					invocationDescriptor: descriptor,
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate,
				onResult: (value) => {
					observed = value;
				},
				adapters: {
					opencode: {
						executeAsync: async () => execution,
						captureDiffAsync: async () => "SECRET_RAW_DIFF",
					},
				},
			},
		});
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		return { result, observed, checkpoint };
	}

	it("awaits executeAsync before returning a terminal task result", async () => {
		const root = join(TEST_DIR, "async-lifecycle");
		mkdirSync(root, { recursive: true });
		const tasksPath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		writeFileSync(
			tasksPath,
			"### Task 4.1: Async provider\n- **Status:** pending\n- **Type:** review\n- **Description:** exercise async lifecycle\n- **Executor:** switchyard\n",
		);
		const descriptor = descriptorForRoute({
			provider: "opencode",
			resolved_harness: "opencode",
			resolvedTargetId: "async-target",
			model: "fake-model",
		});
		let settled = false;
		const routeOptions = [];
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: root,
			workingContainerName: "async-worker",
			checkpointPath,
			dependencies: {
				route: (options) => {
					routeOptions.push(options);
					return {
						provider: "opencode",
						resolved_harness: "opencode",
						resolvedTargetId: "async-target",
						model: "fake-model",
						invocationDescriptor: descriptor,
					};
				},
				goldenImageVerifiedProviders: ["opencode-go"],
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {},
				adapters: {
					opencode: {
						executeAsync: async () => {
							await new Promise((resolve) => setTimeout(resolve, 5));
							settled = true;
							return { success: true, output: "" };
						},
						captureDiff: () => null,
						captureDiffAsync: async () => null,
					},
				},
			},
		});
		strictEqual(settled, true);
		strictEqual(result.results[0].success, true);
		const brokerRouteOptions = routeOptions.find(
			(options) => options.platform === "macos",
		);
		strictEqual(brokerRouteOptions.platform, "macos");
		deepStrictEqual(brokerRouteOptions.goldenImageVerifiedProviders, [
			"opencode-go",
		]);
		strictEqual(result.processedTasks, 1);
		strictEqual(result.completedTaskIds[0], "4.1");
	});

	it("persists provider evidence once and keeps only a valid ref", async () => {
		const outcomes = [
			{
				label: "valid",
				returned: `diagnostic:${"a".repeat(32)}`,
				expectRef: `diagnostic:${"a".repeat(32)}`,
			},
			{ label: "invalid", returned: "diagnostic:not-a-token", expectRef: null },
			{ label: "null", returned: null, expectRef: null },
			{
				label: "throws",
				returned: new Error("persist failed"),
				expectRef: null,
			},
		];
		for (const { label, returned, expectRef } of outcomes) {
			const root = join(
				TEST_DIR,
				`diagnostic-producer-${label}-${randomUUID()}`,
			);
			mkdirSync(root, { recursive: true });
			const tasksPath = join(root, "TASKS.md");
			const checkpointPath = join(root, "checkpoint.json");
			writeFileSync(
				tasksPath,
				"### Task 4.2: Diagnostic producer\n- **Status:** pending\n- **Type:** review\n- **Description:** exercise persistence\n- **Executor:** switchyard\n",
			);
			const descriptor = descriptorForRoute({
				provider: "opencode",
				resolved_harness: "opencode",
				resolvedTargetId: "diagnostic-target",
				model: "fake-model",
			});
			let persistCalls = 0;
			const result = await runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: root,
				workingContainerName: "diagnostic-worker",
				checkpointPath,
				dependencies: {
					route: () => ({
						provider: "opencode",
						resolved_harness: "opencode",
						resolvedTargetId: "diagnostic-target",
						model: "fake-model",
						invocationDescriptor: descriptor,
					}),
					resolveDescriptor: () => descriptor,
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					persistDiagnosticArtifact: async (evidence) => {
						persistCalls += 1;
						strictEqual(Object.hasOwn(evidence, "stdout"), false);
						strictEqual(Object.hasOwn(evidence, "stderr"), false);
						strictEqual(evidence.diagnosticKind, "auth_required");
						strictEqual(evidence.diagnosticCode, undefined);
						if (returned instanceof Error) throw returned;
						return returned;
					},
					adapters: {
						opencode: {
							executeAsync: async () => ({
								success: false,
								error: "authentication required",
								errorKind: "auth_expired",
								diagnosticCode: "auth_expired",
								diagnosticOrigin: "adapter",
								diagnosticEvidenceAvailable: true,
								failurePhase: "provider_execution",
								diagnosticEvidence: {
									stdoutBytes: 21,
									stderrBytes: 0,
									stdoutDigest: `sha256:${"b".repeat(64)}`,
									stderrDigest: `sha256:${"c".repeat(64)}`,
									diagnosticKind: "auth_required",
								},
							}),
							captureDiffAsync: async () => null,
						},
					},
				},
			});
			strictEqual(persistCalls, 1, `${label}: one producer call`);
			strictEqual(result.results[0].diagnosticRef ?? null, expectRef, label);
			strictEqual(
				result.results[0].diagnosticEvidenceAvailable,
				expectRef !== null,
				label,
			);
			ok(!JSON.stringify(result).includes('"diagnosticEvidence":'), label);
		}
	});

	it("fails closed for synchronous provider evidence without an artifact", async () => {
		const root = join(TEST_DIR, "sync-diagnostic-projection");
		mkdirSync(root, { recursive: true });
		const tasksPath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		writeFileSync(
			tasksPath,
			"### Task 4.3: Synchronous diagnostic\n- **Status:** pending\n- **Type:** review\n- **Description:** reject unretained evidence\n- **Executor:** switchyard\n",
		);
		const descriptor = descriptorForRoute({
			provider: "opencode",
			resolved_harness: "opencode",
			resolvedTargetId: "sync-diagnostic-target",
			model: "fake-model",
		});
		const dispatches = [];
		const statuses = [];
		const runStoreCalls = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: root,
			workingContainerName: "sync-diagnostic-worker",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "opencode",
					resolved_harness: "opencode",
					resolvedTargetId: "sync-diagnostic-target",
					model: "fake-model",
					invocationDescriptor: descriptor,
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: (entry) => dispatches.push(entry),
				recordDispatchIntent: () => {},
				onStatus: (event) => statuses.push(event),
				adapters: {
					opencode: {
						execute: () => ({
							success: false,
							error: "authentication required",
							errorKind: "auth_expired",
							diagnosticCode: "auth_expired",
							diagnosticOrigin: "adapter",
							diagnosticEvidenceAvailable: true,
							failurePhase: "provider_execution",
						}),
						captureDiff: () => null,
					},
				},
				runStore: {
					updateRun: (partial) => {
						runStoreCalls.push({ ...partial });
						return Promise.resolve({ revision: 0 });
					},
				},
			},
		});
		await result.ledgerWritesSettled;
		const checkpointFailure = loadCheckpoint(checkpointPath, tasksPath)
			.results[0];
		const dispatchFailure = dispatches.find(
			(entry) => entry.result === "execution_failed",
		);
		const statusFailure = statuses.find(
			(event) => event.event === "task_failed",
		);
		const terminalFailure = runStoreCalls.find(
			(call) => call.state === "failed",
		).lastFailure;
		for (const value of [
			result.results[0],
			checkpointFailure,
			dispatchFailure,
			statusFailure,
			terminalFailure,
		]) {
			ok(value, "sync diagnostic projection is present");
			strictEqual(value.diagnosticCode, "auth_expired");
			strictEqual(value.diagnosticOrigin, "adapter");
			strictEqual(value.diagnosticEvidenceAvailable, false);
			strictEqual(value.diagnosticRef ?? null, null);
		}
		ok(!readFileSync(checkpointPath, "utf8").includes('"diagnosticEvidence":'));
	});

	it("emits bounded scalar heartbeats while an async provider is in flight", async () => {
		const root = join(TEST_DIR, "async-heartbeat");
		mkdirSync(root, { recursive: true });
		const tasksPath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		writeFileSync(
			tasksPath,
			"### Task 4.2: Heartbeat\n- **Status:** pending\n- **Type:** review\n- **Description:** heartbeat\n- **Executor:** switchyard\n",
		);
		const descriptor = descriptorForRoute({
			provider: "opencode",
			resolved_harness: "opencode",
			resolvedTargetId: "async-target",
			model: "fake-model",
		});
		const heartbeats = [];
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: root,
			workingContainerName: "async-worker",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "opencode",
					resolved_harness: "opencode",
					resolvedTargetId: "async-target",
					model: "fake-model",
					invocationDescriptor: descriptor,
				}),
				resolveDescriptor: () => descriptor,
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				onTaskHeartbeat: (value) => heartbeats.push(value),
				adapters: {
					opencode: {
						executeAsync: async (_prompt, _container, options) => {
							options.onPoll({
								elapsedMs: 42,
								stdoutBytes: 999,
								stderrBytes: 999,
							});
							return { success: true, output: "SECRET_STREAM" };
						},
						captureDiffAsync: async () => null,
					},
				},
			},
		});
		strictEqual(result.results[0].success, true);
		strictEqual(heartbeats.length, 1);
		strictEqual(heartbeats[0].taskId, "4.2");
		strictEqual(heartbeats[0].elapsedMs, 42);
		strictEqual(heartbeats[0].processPhase, "provider_transport_running");
		ok(!Object.hasOwn(heartbeats[0], "stdoutBytes"));
		ok(!JSON.stringify(heartbeats).includes("SECRET_STREAM"));
	});

	it("async managed-container lifecycle reports processed tasks and cleans up on selection failure", async () => {
		const root = join(TEST_DIR, "async-managed-container");
		mkdirSync(root, { recursive: true });
		const tasksPath = join(root, "TASKS.md");
		writeFileSync(
			tasksPath,
			"### Task 4.2: Managed\n- **Status:** pending\n- **Type:** review\n- **Description:** managed\n- **Executor:** switchyard\n",
		);
		let wiped = 0;
		const ready = [];
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: root,
				taskIds: ["9.9"],
				dependencies: {
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "managed-worker",
					provisionCredentials: () => {},
					seedProject: () => {},
					wipeWorkingContainer: () => {
						wiped += 1;
					},
					onContainerReady: (info) => ready.push(info.workingContainerName),
				},
			}),
			TaskSelectionError,
		);
		deepStrictEqual(ready, ["managed-worker"]);
		strictEqual(
			wiped,
			1,
			"selection/graph errors after container creation must still clean up the owned container",
		);
		wiped = 0;
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: root,
				dependencies: {
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "managed-worker-2",
					provisionCredentials: () => {},
					seedProject: () => {},
					wipeWorkingContainer: () => {
						wiped += 1;
					},
					onContainerReady: () => {
						throw new Error("ready callback failed");
					},
				},
			}),
			/ready callback failed/,
		);
		strictEqual(
			wiped,
			1,
			"ready callback failures must clean up owned containers",
		);
	});

	it("redacts timeout partial diffs before onResult and checkpoint persistence", async () => {
		const { result, observed, checkpoint } = await runAsyncRedactionCase({
			execution: { success: false, timedOut: true, error: "timed out" },
			integrationGate: () => ({ success: true }),
		});
		strictEqual(result.results[0].partialDiff, undefined);
		strictEqual(result.results[0].artifactRef, undefined);
		strictEqual(observed.partialDiff, undefined);
		strictEqual(observed.artifactRef, undefined);
		ok(result.results[0].partialDiffPath?.endsWith("4.2.diff"));
		strictEqual(checkpoint.results[0].partialDiffPath, null);
		strictEqual(checkpoint.results[0].artifactRef, undefined);
		ok(!JSON.stringify(checkpoint).includes("SECRET_RAW_DIFF"));
	});

	it("redacts integration-rejection partial diffs before onResult", async () => {
		const { result, observed, checkpoint } = await runAsyncRedactionCase({
			execution: { success: true, output: "" },
			integrationGate: () => ({ success: false }),
		});
		strictEqual(result.results[0].partialDiff, undefined);
		strictEqual(result.results[0].artifactRef, undefined);
		strictEqual(observed.partialDiff, undefined);
		strictEqual(observed.artifactRef, undefined);
		ok(result.results[0].partialDiffPath?.endsWith("4.2.diff"));
		strictEqual(checkpoint.results[0].partialDiffPath, null);
		strictEqual(checkpoint.results[0].artifactRef, undefined);
		ok(!JSON.stringify(checkpoint).includes("SECRET_RAW_DIFF"));
	});
});

describe("runner dependency metadata", () => {
	it("parses task-only dependencies and external blockers", () => {
		const markdown = `## Phase 1

### Task 1.1: Root
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** none
- **Description:** Root

### Task 1.2: Middle
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** Task 1.1
- **Description:** Middle

### Task 1.3: Leaf
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** Tasks 1.1, Task 1.2
- **External blockers:** decision:release-approval, gate:phase-1
- **Description:** Leaf
`;
		const tasks = parseFixture(markdown);
		deepStrictEqual(
			tasks.map((task) => task.blockedBy),
			[[], ["1.1"], ["1.1", "1.2"]],
		);
		deepStrictEqual(tasks[2].externalBlockers, [
			"decision:release-approval",
			"gate:phase-1",
		]);
	});

	it("rejects free prose and malformed external blocker ids", () => {
		const prose = `### Task 1.1: Bad dependency
- **Status:** pending
- **Files:** src/a.mjs
- **Blocked by:** after the review is approved
`;
		throws(() => parseFixture(prose), /invalid Blocked by field/);

		const malformedExternal = `### Task 1.1: Bad external blocker
- **Status:** pending
- **Files:** src/a.mjs
- **External blockers:** David must approve
`;
		throws(
			() => parseFixture(malformedExternal),
			/invalid External blockers id/,
		);
	});

	it("rejects unknown, self, cyclic, and duplicate dependencies", () => {
		const queue = (body) => `### Task 1.1: Task one
- **Status:** pending
- **Files:** src/a.mjs
${body}
`;
		throws(
			() => parseFixture(queue("- **Blocked by:** Task 9.9")),
			/unknown Blocked by task "9\.9"/,
		);
		throws(
			() => parseFixture(queue("- **Blocked by:** Task 1.1")),
			/self-dependency is not allowed/,
		);

		const cycle = `### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Blocked by:** Task 1.2

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Blocked by:** Task 1.1
`;
		throws(() => parseFixture(cycle), /task dependency cycle detected/);
		throws(
			() => parseFixture(queue("- **Blocked by:** Task 1.1, Task 1.1")),
			/duplicate Blocked by dependency/,
		);
	});

	it("gates chains and diamonds on done or checkpoint-success prerequisites", () => {
		const tasks = [
			{ id: "1.1", status: "pending", executor: "switchyard" },
			{
				id: "1.2",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
			},
			{
				id: "1.3",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
			},
			{
				id: "1.4",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.2", "1.3"],
			},
		];

		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: [] }).map((task) => task.id),
			["1.1"],
		);
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: ["1.1"] }).map(
				(task) => task.id,
			),
			["1.2", "1.3"],
		);
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: ["1.1", "1.2", "1.3"] }).map(
				(task) => task.id,
			),
			["1.4"],
		);

		const failedPrerequisite = [
			...tasks.slice(0, 2),
			{
				id: "1.5",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.2"],
			},
		];
		deepStrictEqual(
			getRunnableTasks(failedPrerequisite, {
				completedTaskIds: [],
				results: [{ taskId: "1.2", success: false }],
			}).map((task) => task.id),
			["1.1"],
		);
	});

	it("keeps external, native, human, and unselected work out of provider routing", () => {
		const tasks = [
			{
				id: "1.1",
				status: "pending",
				executor: "switchyard",
				externalBlockers: ["decision:approval"],
			},
			{ id: "1.2", status: "pending", executor: "native" },
			{ id: "1.3", status: "pending", executor: "human" },
			{
				id: "1.4",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.2"],
			},
		];
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: [] }).map((task) => task.id),
			[],
		);
		deepStrictEqual(
			getRunnableTasks(
				tasks,
				{ completedTaskIds: [] },
				{ resolvedExternalBlockers: ["decision:approval"] },
			).map((task) => task.id),
			["1.1"],
		);
		deepStrictEqual(
			getRunnableTasks(
				[
					{ id: "1.1", status: "done", executor: "human" },
					{
						id: "1.2",
						status: "pending",
						executor: "switchyard",
						blockedBy: ["1.1"],
					},
				],
				{ completedTaskIds: [] },
			).map((task) => task.id),
			["1.2"],
		);
	});

	it("validates programmatic dependency graphs before routing", () => {
		throws(
			() => validateTaskGraph([{ id: "1.1", blockedBy: ["9.9"] }]),
			/unknown Blocked by task "9\.9"/,
		);
	});

	it("derives content-free queue diagnostics with stable reason codes", () => {
		const tasks = [
			{
				id: "1.1",
				status: "pending",
				executor: "switchyard",
				description: "provider task description",
				requiredPaths: ["src/provider-secret-name.mjs"],
			},
			{ id: "1.2", status: "pending", executor: "human" },
			{ id: "1.3", status: "pending", executor: "native" },
			{
				id: "1.4",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
			},
			{
				id: "1.5",
				status: "pending",
				executor: "switchyard",
				externalBlockers: ["decision:approval"],
			},
			{ id: "1.6", status: "done", executor: "switchyard" },
		];

		const diagnostics = deriveQueueDiagnostics(tasks, {
			completedTaskIds: ["1.6"],
		});
		deepStrictEqual(diagnostics, {
			selected: { count: 5, reason: "queue_default" },
			runnable: { count: 1, reason: "provider_eligible_and_unblocked" },
			humanGated: { count: 1, reason: "executor_human" },
			nativeGated: { count: 1, reason: "executor_native" },
			dependencyBlocked: { count: 1, reason: "task_dependency" },
			externalBlocked: { count: 1, reason: "external_blocker" },
			completed: { count: 1, reason: "queue_status_or_checkpoint" },
		});

		const serialized = JSON.stringify(diagnostics);
		ok(!serialized.includes("provider task description"));
		ok(!serialized.includes("provider-secret-name.mjs"));
		ok(!serialized.includes("decision:approval"));
	});

	it("capstone: immutable handoff and Sentinel-style queues honor every unconditional contract", () => {
		// Keep this fixture immutable and local: the capstone must not depend on
		// an active plan file, a provider credential, or a live quota response.
		const markdown = `## Phase 1

### Task 1.1: Sentinel root
- **Status:** pending
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** The root task spans multiple provider boundaries.
- **Executor:** switchyard
- **Files:** src/root.mjs
- **Blocked by:** none
- **Description:** provider work stays in the selected execution lane

### Task 1.2: Native handoff
- **Status:** pending
- **RequiredCapability:** standard
- **Executor:** native
- **Description:** native work never enters provider routing

### Task 1.3: Human approval
- **Status:** pending
- **RequiredCapability:** low
- **RequiredCapabilityJustification:** The human approval is a mechanical confirmation.
- **Executor:** human
- **Description:** human work is gated outside the provider queue

### Task 1.4: External gate
- **Status:** pending
- **RequiredCapability:** standard
- **Executor:** switchyard
- **Files:** src/gated.mjs
- **External blockers:** decision:release-approval
- **Description:** the unresolved external gate remains parked

### Task 1.5: Dependent follow-up
- **Status:** pending
- **RequiredCapability:** low
- **RequiredCapabilityJustification:** The follow-up is a bounded mechanical change.
- **Executor:** switchyard
- **Files:** src/follow-up.mjs
- **Blocked by:** Task 1.1
- **Description:** follow-up waits for durable success of the root
`;
		const tasks = parseFixture(markdown);
		strictEqual(tasks.length, 5);
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: [] }).map((task) => task.id),
			["1.1"],
		);
		deepStrictEqual(
			getRunnableTasks(tasks, { completedTaskIds: ["1.1"] }).map(
				(task) => task.id,
			),
			["1.5"],
		);
		throws(
			() =>
				getRunnableTasks(
					tasks,
					{ completedTaskIds: [] },
					{ selectedTaskIds: ["1.4"] },
				),
			(error) =>
				error instanceof TaskSelectionError &&
				error.reason === "external-blocked:decision:release-approval",
		);

		const diagnostics = deriveQueueDiagnostics(tasks, {
			completedTaskIds: [],
		});
		strictEqual(diagnostics.runnable.count, 1);
		strictEqual(diagnostics.nativeGated.reason, "executor_native");
		strictEqual(diagnostics.humanGated.reason, "executor_human");
		strictEqual(diagnostics.externalBlocked.reason, "external_blocker");
		strictEqual(diagnostics.dependencyBlocked.reason, "task_dependency");
		const serializedDiagnostics = JSON.stringify(diagnostics);
		ok(!serializedDiagnostics.includes("provider work stays"));
		ok(!serializedDiagnostics.includes("src/root.mjs"));
		ok(!serializedDiagnostics.includes("decision:release-approval"));

		const runOptions = normalizeRunOptions({
			maxTasks: 2,
			only: ["agy"],
			exclude: ["codex"],
			taskIds: ["1.1"],
		});
		const identity = createQueueIdentity({
			tasksFilePath: "/immutable/sentinel/tasks.md",
			markdown,
			tasks,
			projectRevision: "sentinel-revision",
			runOptions,
		});
		notStrictEqual(
			identity,
			createQueueIdentity({
				tasksFilePath: "/immutable/sentinel/tasks.md",
				markdown,
				tasks,
				projectRevision: "sentinel-revision",
				runOptions: normalizeRunOptions({ ...runOptions, maxTasks: 1 }),
			}),
			"run-shaping options must be identity-bound",
		);
		notStrictEqual(
			identity,
			createQueueIdentity({
				tasksFilePath: "/immutable/sentinel/tasks.md",
				markdown: `${markdown}\n<!-- immutable fixture revision -->\n`,
				tasks,
				projectRevision: "sentinel-revision",
				runOptions,
			}),
			"queue content must be identity-bound",
		);
	});
});

describe("runner task selection and queue identity", () => {
	it("plans only the bounded potential attempts and dynamically unblocks in queue order", () => {
		const tasks = [
			{
				id: "1.1",
				status: "pending",
				executor: "native",
				requiredCapability: "high",
			},
			{
				id: "1.2",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
				requiredCapability: "high",
			},
			{
				id: "1.3",
				status: "pending",
				executor: "switchyard",
				requiredCapability: "standard",
			},
			{
				id: "1.4",
				status: "pending",
				executor: "human",
				requiredCapability: "high",
			},
		];
		const planned = planPotentialAttemptTasks(
			tasks,
			{ completedTaskIds: [] },
			{ maxTasks: 1 },
		);
		deepStrictEqual(
			planned.map((task) => task.id),
			["1.3"],
		);
		const unblocked = planPotentialAttemptTasks(
			tasks,
			{ completedTaskIds: ["1.1"] },
			{ maxTasks: 2 },
		);
		deepStrictEqual(
			unblocked.map((task) => task.id),
			["1.2", "1.3"],
		);
		const retryFirst = planPotentialAttemptTasks(
			tasks,
			{ completedTaskIds: [], retryState: { taskId: "1.3" } },
			{ selectedTaskIds: ["1.3"], maxTasks: 1 },
		);
		deepStrictEqual(
			retryFirst.map((task) => task.id),
			["1.3"],
		);
		const selectedHigh = planPotentialAttemptTasks(
			tasks,
			{ completedTaskIds: ["1.1"] },
			{ selectedTaskIds: ["1.2"], maxTasks: 2 },
		);
		deepStrictEqual(
			selectedHigh.map((task) => task.id),
			["1.2"],
		);
		const blocked = planPotentialAttemptTasks(
			[
				{ id: "native", status: "pending", executor: "native" },
				{ id: "human", status: "pending", executor: "human" },
				{ id: "external", status: "pending", externalBlockers: ["approval"] },
			],
			{ completedTaskIds: [] },
			{ maxTasks: 3 },
		);
		deepStrictEqual(blocked, []);
		const sanitized = new QueuePreflightError("synthetic", {
			reason: "no_eligible",
			rejections: [
				{
					capability: "standard",
					reason: "safe",
					excludedProviders: ["claude", "\u0000canary"],
					excludedReasons: { claude: "no_descriptor", leak: { raw: true } },
				},
			],
			canary: "must-drop",
		});
		deepStrictEqual(sanitized.preflightDetail, {
			reason: "no_eligible",
			rejections: [
				{
					capability: "standard",
					reason: "safe",
					excludedProviders: ["claude", " canary"],
					excludedReasons: { claude: "no_descriptor" },
				},
			],
		});
		const malformed = new QueuePreflightError("synthetic", {
			reason: "no_eligible",
			rejections: "not-an-array",
		});
		deepStrictEqual(malformed.preflightDetail, {
			reason: "no_eligible",
			rejections: [],
		});
		const nestedMalformed = new QueuePreflightError("synthetic", {
			reason: "no_eligible",
			rejections: [
				null,
				"bad",
				{
					capability: "standard",
					excludedProviders: "bad",
					excludedReasons: [],
				},
			],
		});
		deepStrictEqual(nestedMalformed.preflightDetail, {
			reason: "no_eligible",
			rejections: [{ capability: "standard", reason: "unknown" }],
		});
	});
	it("rejects explicit selection with a stable reason for each unsafe target", () => {
		const checkpoint = { completedTaskIds: [] };
		const tasks = [
			{ id: "1.1", status: "pending", executor: "switchyard" },
			{ id: "1.2", status: "pending", executor: "native" },
			{ id: "1.3", status: "pending", executor: "human" },
			{
				id: "1.4",
				status: "pending",
				executor: "switchyard",
				externalBlockers: ["decision:approval"],
			},
			{
				id: "1.5",
				status: "pending",
				executor: "switchyard",
				blockedBy: ["1.1"],
			},
		];

		for (const [taskId, reason] of [
			["missing", "unknown-task"],
			["1.2", "native-task"],
			["1.3", "human-task"],
			["1.4", "external-blocked:decision:approval"],
			["1.5", "dependency-blocked:1.1"],
		]) {
			throws(
				() =>
					getRunnableTasks(tasks, checkpoint, { selectedTaskIds: [taskId] }),
				(error) =>
					error instanceof TaskSelectionError && error.reason === reason,
			);
		}
	});

	it("creates and validates an identity-bound v3 checkpoint", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Identity task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** Identity
`);
		const tasks = loadTaskQueue(tasksPath);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions = normalizeRunOptions({
			checkpointPath,
			maxTasks: 1,
			stopOnFailure: true,
			taskIds: ["1.1"],
		});
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks,
			projectRevision: "rev-1",
			runOptions,
		});
		const empty = createEmptyCheckpoint(tasksPath, {
			queueIdentity,
			runOptions,
		});
		saveCheckpoint(checkpointPath, empty);
		const loaded = loadCheckpoint(checkpointPath, tasksPath, {
			queueIdentity,
			runOptions,
		});
		strictEqual(loaded.version, 3);
		strictEqual(loaded.queueIdentity, queueIdentity);
		throws(
			() =>
				loadCheckpoint(checkpointPath, tasksPath, {
					queueIdentity: `${"0".repeat(64)}`,
					runOptions,
				}),
			/checkpoint identity mismatch/,
		);
	});
});

describe("runner orchestration", () => {
	it("re-evaluates dependencies after each successful task", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Root task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** none
- **Description:** Root operation

### Task 1.2: Dependent task
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Blocked by:** Task 1.1
- **Description:** Dependent operation
`);
		const dispatches = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.runnableTasks, 1);
		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			dispatches.map((dispatch) => dispatch.taskId),
			["1.1", "1.2"],
		);
	});

	it("executes tasks serially and checkpoints completion", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		const prompts = [];

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: (entry) => dispatches.push(entry),
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: (prompt) => {
						prompts.push(prompt);
						return { success: true, output: "ok" };
					},
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(result.completedTaskIds.length, 2);
		strictEqual(dispatches.length, 2);
		deepStrictEqual(prompts, [
			"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** First operation",
			"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** Second operation",
		]);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1", "1.2"]);
	});

	it("resumes from checkpoint and only runs remaining work", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const prompts = [];

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: (prompt) => {
						prompts.push(prompt);
						return { success: true, output: "ok" };
					},
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
			maxTasks: 1,
		});

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		deepStrictEqual(prompts, [
			"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** First operation",
			"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** Second operation",
		]);
	});

	it("treats an exactly selected completed task as already_complete without routing", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Already complete
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** Already completed operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let routeCalls = 0;
		const dependencies = {
			route: () => {
				routeCalls += 1;
				throw new Error("completed exact selection must not route");
			},
			recordDispatch: () => {
				throw new Error("completed exact selection must not dispatch");
			},
			adapters: {},
		};

		// Seed an identity-bound checkpoint through the normal queue path so the
		// exact selection has durable successful-completion evidence to reconcile.
		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			taskIds: ["1.1"],
			dependencies: {
				route: () => ({ provider: "claude", model: "sonnet", reason: "test" }),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true }),
				adapters: {
					claude: {
						execute: () => ({ success: true }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			taskIds: ["1.1"],
			dependencies,
		});

		strictEqual(routeCalls, 0);
		strictEqual(result.results.length, 1);
		strictEqual(result.results[0].result, "already_complete");
		strictEqual(result.results[0].success, true);
		strictEqual(
			loadCheckpoint(checkpointPath, tasksPath, {
				queueIdentity: result.queueIdentity,
				runOptions: result.runOptions,
			}).results.at(-1).result,
			"already_complete",
		);
	});
	it("captures and releases a fresh immutable base for each terminal task", () => {
		const tasksPath = writeTasksFile(`
### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const captured = [];
		const released = [];
		const persistedBeforeExecute = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "worker",
			checkpointPath,
			dependencies: {
				route: () => ({ provider: "claude", model: "test-model" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				captureTaskBase: (_workspaceId, { taskId }) => {
					captured.push(taskId);
					return {
						ref: `refs/switchyard/task-base/run/${taskId}`,
						tree: taskId === "1.1" ? "1".repeat(40) : "2".repeat(40),
					};
				},
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: (_workspaceId, base) => released.push(base.ref),
				adapters: {
					claude: {
						execute: () => {
							const taskId = captured.at(-1);
							persistedBeforeExecute.push(
								Boolean(
									JSON.parse(readFileSync(checkpointPath, "utf8")).taskBases[
										taskId
									],
								),
							);
							return { success: true };
						},
						captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
					},
				},
				integrationGate: () => ({ success: true }),
			},
		});
		strictEqual(result.completedTaskIds.length, 2);
		deepStrictEqual(captured, ["1.1", "1.2"]);
		deepStrictEqual(persistedBeforeExecute, [true, true]);
		deepStrictEqual(released, [
			"refs/switchyard/task-base/run/1.1",
			"refs/switchyard/task-base/run/1.2",
		]);
		deepStrictEqual(
			JSON.parse(readFileSync(checkpointPath, "utf8")).taskBases,
			{},
		);
	});

	it("persists task-base release uncertainty and prevents reuse", () => {
		const tasksPath = writeTasksFile(`
### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "worker",
			checkpointPath,
			dependencies: {
				route: () => ({ provider: "claude", model: "test-model" }),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				captureTaskBase: () => TASK_BASE,
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: () => {
					throw new Error("uncertain");
				},
				adapters: {
					claude: {
						execute: () => ({ success: true }),
						captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
					},
				},
				integrationGate: () => ({ success: true }),
			},
		});
		strictEqual(
			result.results.at(-1).result,
			"halted_after_task_base_release_failure",
		);
		const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
		strictEqual(checkpoint.taskBases["1.1"].ref, TASK_BASE.ref);
		strictEqual(checkpoint.taskBases["1.1"].tree, TASK_BASE.tree);
		strictEqual(checkpoint.taskBases["1.1"].cleanupContext.operation, "helper");
		strictEqual(checkpoint.taskBaseReleaseUncertain.taskId, "1.1");
	});

	it("captures a new base when a terminal failure is retried in a fresh workspace", () => {
		const tasksPath = writeTasksFile(`
### Task 1.1: Retryable in a new run
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** retry later
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const captured = [];
		const makeDependencies = (success) => ({
			route: () => ({ provider: "claude", model: "test-model" }),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			captureTaskBase: (workspaceId) => {
				captured.push(workspaceId);
				return {
					ref: `refs/switchyard/task-base/run-${captured.length}/1.1`,
					tree: String(captured.length).repeat(40),
				};
			},
			validateTaskBase: (_workspaceId, base) => base,
			releaseTaskBase: () => {},
			adapters: {
				claude: {
					execute: () => ({ success }),
					captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
				},
			},
			integrationGate: () => ({ success: true }),
		});
		const failed = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "worker-one",
			checkpointPath,
			dependencies: makeDependencies(false),
		});
		strictEqual(failed.results[0].success, false);
		deepStrictEqual(
			JSON.parse(readFileSync(checkpointPath, "utf8")).taskBases,
			{},
		);
		const retried = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "worker-two",
			checkpointPath,
			dependencies: makeDependencies(true),
		});
		strictEqual(retried.results.at(-1).success, true);
		deepStrictEqual(captured, ["worker-one", "worker-two"]);
	});
});

describe("immutable-base recovery guards", () => {
	const entrypoints = [
		["sync", runQueue],
		["async", runQueueAsync],
		["orchestrator", runQueueWithOrchestrator],
	];

	function recoveryDependencies(
		mode,
		counters,
		{ cleanupFailed = false } = {},
	) {
		const parallels = new ParallelsExecutionBackend({ aquaUid: 501 });
		const validateHelperTransport = (options) => {
			parallels.execArgv("recovery-worker", {
				argv: ["git", "status", "--porcelain"],
				recordPid: true,
				cleanupContext: options.cleanupContext,
			});
			counters.helperContexts.push(options.cleanupContext);
		};
		const execution = cleanupFailed
			? {
					success: true,
					cleanupFailed: true,
					cleanupStage: "pid_marker_removed",
				}
			: { success: true };
		const brokerExecution = cleanupFailed
			? {
					success: true,
					outcome: "success",
					cleanupFailed: true,
					cleanupStage: "pid_marker_removed",
				}
			: { success: true, outcome: "success" };
		return {
			route: () => ({
				provider: "claude",
				model: "fixture-model",
				resolved_harness: "claude",
			}),
			resolveDescriptor: () =>
				testDescriptor({
					model_ref: "fixture-model",
					selector: "fixture-model",
				}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			createWorkingContainer: () => "recovery-worker",
			seedProject: () => {},
			commitWorkingTree: () => {
				counters.commits += 1;
			},
			resetWorkingTree: () => {
				counters.resets += 1;
			},
			wipeWorkingContainer: () => {},
			captureTaskBase: (_workspaceId, { taskId, ...options }) => {
				validateHelperTransport(options);
				counters.captures += 1;
				return {
					ref: `refs/switchyard/task-base/recovery/${taskId}`,
					tree: "6".repeat(40),
				};
			},
			validateTaskBase: (_workspaceId, base, options) => {
				validateHelperTransport(options);
				return base;
			},
			releaseTaskBase: (_workspaceId, _base, options) => {
				validateHelperTransport(options);
				counters.releases += 1;
				if (counters.releaseThrows) throw new Error("uncertain release");
			},
			onTaskStart: (task) => counters.started.push(task.id),
			integrationGate: () => ({ success: true }),
			adapters: {
				claude: {
					execute: () => execution,
					executeAsync: async () => execution,
					captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
					captureDiffAsync: async () => "diff --git a/src/a.mjs b/src/a.mjs",
				},
			},
			...(mode === "async"
				? {
						broker: {
							selectAndReserve: async () => ({
								provider: "claude",
								model: "fixture-model",
								resolvedTarget: "claude",
								harness: "claude",
								capability: "standard",
								reason: "spread",
								snapshotIdentity: {
									status: "fresh",
									mtime: null,
									ageMs: 0,
								},
							}),
							launcherIdentity: () => ({}),
							execute: async () => brokerExecution,
						},
					}
				: {}),
			...(mode === "orchestrator"
				? {
						orchestrator: {
							launch: async () => "recovery-job",
							status: async () => ({ state: "done" }),
							result: async () =>
								cleanupFailed
									? {
											success: true,
											cleanupFailed: true,
											cleanupStage: "pid_marker_removed",
										}
									: { success: true },
						},
					}
				: {}),
		};
	}

	for (const [mode, entrypoint] of entrypoints) {
		it(`${mode} blocks a fresh queue after task-base release becomes uncertain`, async () => {
			const tasksPath = writeTasksFile(`
### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const counters = {
				captures: 0,
				commits: 0,
				resets: 0,
				releases: 0,
				releaseThrows: true,
				started: [],
				helperContexts: [],
			};
			const options = {
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				runId: `recovery-${mode}`,
				checkpointPath,
				maxTasks: 1,
				dependencies: recoveryDependencies(mode, counters),
			};
			const first = await entrypoint(options);
			strictEqual(
				first.results.at(-1).result,
				"halted_after_task_base_release_failure",
			);
			await rejects(
				Promise.resolve().then(() => entrypoint(options)),
				/recovery is required/,
			);
			deepStrictEqual(counters.started, ["1.1"]);
			strictEqual(counters.captures, 1);
			strictEqual(counters.releases, 1);
			ok(counters.helperContexts.length >= 2);
			for (const helperContext of counters.helperContexts) {
				strictEqual(helperContext.operation, "helper");
				strictEqual(helperContext.runId, `recovery-${mode}`);
				strictEqual(helperContext.taskId, "1.1");
			}
			deepStrictEqual(
				new Set(counters.helperContexts.map(({ attemptId }) => attemptId)).size,
				1,
			);
		});

		it(`${mode} preserves the base and halts when provider cleanup is uncertain`, async () => {
			const tasksPath = writeTasksFile(`
### Task 1.1: Cleanup uncertainty
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** cleanup uncertainty
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const counters = {
				captures: 0,
				commits: 0,
				resets: 0,
				releases: 0,
				releaseThrows: false,
				started: [],
				helperContexts: [],
			};
			const options = {
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				runId: `recovery-cleanup-${mode}`,
				checkpointPath,
				stopOnFailure: false,
				dependencies: recoveryDependencies(mode, counters, {
					cleanupFailed: true,
				}),
			};
			const first = await entrypoint(options);
			strictEqual(
				first.results.at(-1).result,
				"halted_after_provider_cleanup_failure",
			);
			const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
			strictEqual(checkpoint.providerCleanupUncertain.taskId, "1.1");
			strictEqual(
				checkpoint.taskBases["1.1"].ref,
				"refs/switchyard/task-base/recovery/1.1",
			);
			strictEqual(checkpoint.taskBases["1.1"].tree, "6".repeat(40));
			strictEqual(
				checkpoint.taskBases["1.1"].cleanupContext.operation,
				"helper",
			);
			strictEqual(counters.commits, 0);
			strictEqual(counters.resets, 0);
			strictEqual(counters.releases, 0);
			await rejects(
				Promise.resolve().then(() => entrypoint(options)),
				/recovery is required/,
			);
			deepStrictEqual(counters.started, ["1.1"]);
			strictEqual(counters.captures, 1);
		});
	}
});

describe("runner stopOnFailure + integration gate failure", () => {
	function dependenciesWithGateResult(gateResult) {
		return {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => gateResult,
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
				codex: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/b b/b",
				},
			},
		};
	}

	it("halts the queue when integrationGate fails and stopOnFailure is true", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: true,
			dependencies: dependenciesWithGateResult({
				success: false,
				message: "rejected",
			}),
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].result, "integration_failed");
		strictEqual(result.results[0].success, false);
		deepStrictEqual(result.completedTaskIds, []);
	});

	it("continues past an integrationGate failure when stopOnFailure is false", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: false,
			dependencies: dependenciesWithGateResult({
				success: false,
				message: "rejected",
			}),
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["integration_failed", "integration_failed"],
		);
		deepStrictEqual(result.completedTaskIds, []);
	});

	it("reconciles alreadyApplied as a successful terminal outcome", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Already applied
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** Idempotent operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const artifactRef = "artifact:0123456789abcdef01234567";
		const dispatches = [];
		const events = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "sonnet",
					reason:
						"../../private/sk-proj-opaquevalue at service.prod.company.com",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				onStatus: (event) => events.push(event),
				integrationGate: () => ({ alreadyApplied: true, artifactRef }),
				adapters: {
					claude: {
						execute: () => ({ success: true }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.results[0].success, true);
		strictEqual(result.results[0].result, "success");
		strictEqual(result.results[0].alreadyApplied, true);
		strictEqual(result.results[0].artifactRef, artifactRef);
		strictEqual(dispatches[0].result, "success");
		strictEqual(dispatches[0].alreadyApplied, true);
		strictEqual(dispatches[0].artifactRef, artifactRef);
		strictEqual(dispatches[0].reason, "spread");
		strictEqual(sanitizeFailureMetadata(dispatches[0]), null);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].alreadyApplied, true);
		strictEqual(checkpoint.results[0].artifactRef, artifactRef);
		ok(!JSON.stringify(dispatches).includes("unknown_failure"));
		ok(
			!JSON.stringify({ result, checkpoint, dispatches, events }).includes(
				"sk-proj-opaquevalue",
			),
		);
		ok(events.some((event) => event.outcome === "already_applied"));
	});

	it("keeps orchestrator alreadyApplied outcomes safe and ledger-compatible", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Orchestrator already applied
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** Idempotent headless operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const artifactRef = "artifact:fedcba987654321001234567";
		const dispatches = [];
		const events = [];
		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "sonnet",
					resolvedTargetId: "claude-target",
					resolved_harness: "claude",
					reason:
						"../../private/sk-proj-orchestrator at service.prod.company.com",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				onStatus: (event) => events.push(event),
				integrationGate: () => ({ alreadyApplied: true, artifactRef }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(result.results[0].result, "success");
		strictEqual(result.results[0].alreadyApplied, true);
		strictEqual(dispatches[0].reason, "spread");
		strictEqual(dispatches[0].artifactRef, artifactRef);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		ok(
			!JSON.stringify({ result, checkpoint, dispatches, events }).includes(
				"sk-proj-orchestrator",
			),
		);
		ok(events.some((event) => event.outcome === "already_applied"));
	});
});

describe("runner poll/wait loop", () => {
	it("waits through running states until done", async () => {
		const statuses = [
			{ state: "running", expected_by: "2999-01-01T00:00:00Z" },
			{ state: "2/3", expected_by: "2999-01-01T00:00:00Z" },
			{ state: "done", expected_by: "2999-01-01T00:00:00Z" },
		];
		let i = 0;
		const pollStates = [];
		let sleeps = 0;

		const result = await waitForJobCompletion({
			jobId: "job-1",
			orchestrator: {
				status: async () => {
					const current = statuses[Math.min(i, statuses.length - 1)];
					i += 1;
					return current;
				},
			},
			pollIntervalMs: 1,
			sleepFn: async () => {
				sleeps += 1;
			},
			onPoll: ({ state }) => {
				pollStates.push(state);
			},
		});

		strictEqual(result.state, "done");
		strictEqual(result.timedOut, false);
		deepStrictEqual(pollStates, ["running", "2/3", "done"]);
		strictEqual(sleeps, 2);
	});

	it("returns timed_out when expected_by is exceeded", async () => {
		const result = await waitForJobCompletion({
			jobId: "job-2",
			orchestrator: {
				status: async () => ({
					state: "running",
					expected_by: "2020-01-01T00:00:00Z",
				}),
			},
			now: () => Date.parse("2021-01-01T00:00:00Z"),
			pollIntervalMs: 1,
			sleepFn: async () => {},
		});

		strictEqual(result.state, "timed_out");
		strictEqual(result.timedOut, true);
	});
});

describe("runner headless orchestrator mode", () => {
	it("runs through launch/status/result and checkpoints", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		const dispatches = [];
		const polls = [];
		const statusesByJob = new Map([
			["job-1", [{ state: "running" }, { state: "done" }]],
			["job-2", [{ state: "done" }]],
		]);
		const diffsByJob = new Map([
			["job-1", "diff --git a/a b/a"],
			["job-2", ""],
		]);
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			pollIntervalMs: 1,
			dependencies: {
				captureTaskBase: (_workspaceId, { taskId }) => ({
					ref: `refs/switchyard/task-base/orchestrator/${taskId}`,
					tree: taskId === "1.1" ? "1".repeat(40) : "2".repeat(40),
				}),
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: () => {},
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					resolvedTargetId: "claude-target",
					resolved_harness: "claude",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				onPoll: ({ state }) => polls.push(state),
				orchestrator: {
					launch: async (payload) => {
						launches.push(payload);
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async (jobId) => {
						const queue = statusesByJob.get(jobId) ?? [{ state: "missing" }];
						if (queue.length > 1) {
							return queue.shift();
						}
						return queue[0];
					},
					result: async (jobId) => ({
						success: true,
						diff: diffsByJob.get(jobId) ?? "",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(dispatches.length, 2);
		deepStrictEqual(
			dispatches.map((entry) => entry.result),
			["success", "success"],
		);
		deepStrictEqual(
			launches.map((payload) => payload.prompt),
			[
				"### Task 1.1: First task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** First operation",
				"### Task 1.2: Second task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** Second operation",
			],
		);
		deepStrictEqual(
			launches.map(({ taskBase }) => ({
				ref: taskBase.ref,
				tree: taskBase.tree,
			})),
			[
				{
					ref: "refs/switchyard/task-base/orchestrator/1.1",
					tree: "1".repeat(40),
				},
				{
					ref: "refs/switchyard/task-base/orchestrator/1.2",
					tree: "2".repeat(40),
				},
			],
		);
		deepStrictEqual(polls, ["running", "done", "done"]);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1", "1.2"]);
		strictEqual(checkpoint.results[0].descriptorHarness, "claude");
		strictEqual(checkpoint.results[0].resolvedTargetId, "claude-target");
	});

	it("resumes in orchestrator mode from checkpoint", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		let launchIndex = 0;

		const dependencies = {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 65,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			sleepFn: async () => {},
			orchestrator: {
				launch: async (payload) => {
					launches.push(payload);
					launchIndex += 1;
					return `job-${launchIndex}`;
				},
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
			},
		};

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			maxTasks: 1,
			dependencies,
		});

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		deepStrictEqual(
			launches.map((payload) => payload.taskId),
			["1.1", "1.2"],
		);
	});

	it("blocks historical model-only retry state before routing or orchestrator launch", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Historical retry
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** A legacy retry record must not be reinterpreted as a fresh task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["agy-gemini"],
			retryAttempts: [],
			retryTransitions: [],
			retryTransitionId: 0,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
			},
		});
		let routeCalls = 0;
		let launchCalls = 0;

		await rejects(
			() =>
				runQueueWithOrchestrator({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {
						route: () => {
							routeCalls += 1;
							return { provider: "agy", model: "fixture-gemini" };
						},
						orchestrator: {
							launch: async () => {
								launchCalls += 1;
								return "job-never-launched";
							},
							status: async () => ({ state: "done" }),
							result: async () => ({ success: true, diff: "" }),
						},
					},
				}),
			/explicit reconciliation/,
		);
		strictEqual(routeCalls, 0);
		strictEqual(launchCalls, 0);
	});

	it("blocks complete retry state until orchestrator retry-resume semantics are audited", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Complete retry
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** A complete retry record needs an explicit resume state machine
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const descriptor = testDescriptor({
			target_id: "claude-target",
			model_ref: "claude-sonnet-5",
			selector: "claude-sonnet-5",
		});
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["claude-target"],
			retryAttempts: [],
			retryTransitions: [],
			retryTransitionId: 0,
			retryState: {
				taskId: "1.1",
				attempt: 2,
				phase: "retry_started",
				resolvedTargetId: "claude-target",
				invocationDescriptor: descriptor,
				descriptorIdentity: descriptor.descriptor_identity,
				descriptorHarness: "claude",
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		});
		let routeCalls = 0;
		let launchCalls = 0;

		await rejects(
			() =>
				runQueueWithOrchestrator({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
					checkpointPath,
					dependencies: {
						route: () => {
							routeCalls += 1;
							return { provider: "claude", model: "claude-sonnet-5" };
						},
						orchestrator: {
							launch: async () => {
								launchCalls += 1;
								return "job-never-launched";
							},
							status: async () => ({ state: "done" }),
							result: async () => ({ success: true, diff: "" }),
						},
					},
				}),
			/invalid quota diagnostic provenance/,
		);
		strictEqual(routeCalls, 0);
		strictEqual(launchCalls, 0);
	});

	it("re-selects and re-fails the same unsupported provider on every resume (orchestrator launch failure, not a route gap — Task E.1)", async () => {
		// Since Task E.1, executeTaskWithOrchestrator passes availableProviders
		// (derived from context.adapters), same as executeTask — so this
		// dependencies object declares an adapters.cursor entry to keep cursor
		// selectable, isolating the scenario under test: the external
		// orchestrator is an opaque black box with no capability-discovery
		// protocol, so route() can still pick a provider the orchestrator
		// itself can't run. Here the fake orchestrator rejects "cursor" at
		// launch(), standing in for one that doesn't support that provider.
		// Because a failed launch never adds the task to completedTaskIds, a
		// resume re-selects the same task and the same provider and fails
		// identically — accepted behavior today, not a bug.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launchAttempts = [];
		const dispatches = [];

		const dependencies = {
			route: ({ availableProviders }) =>
				availableProviders && !availableProviders.includes("cursor")
					? { provider: null, reason: "no candidates" }
					: {
							provider: "cursor",
							model: "cursor-fast",
							percentLeft: 95,
							reason: "spread",
						},
			recordDispatch: (entry) => dispatches.push(entry),
			integrationGate: () => ({ success: true, message: "ok" }),
			sleepFn: async () => {},
			adapters: {
				cursor: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => null,
				},
			},
			orchestrator: {
				launch: async (payload) => {
					launchAttempts.push(payload);
					throw new Error(
						`orchestrator cannot run provider ${payload.provider}`,
					);
				},
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
			},
		};

		const first = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		// Failed task is recorded but NOT marked complete...
		strictEqual(first.results[0].result, "launch_failed");
		deepStrictEqual(first.completedTaskIds, []);
		deepStrictEqual(
			loadCheckpoint(checkpointPath, tasksPath).completedTaskIds,
			[],
		);

		// ...so a resume re-runs the SAME task against the SAME provider.
		const second = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies,
		});

		strictEqual(second.results[0].result, "launch_failed");
		deepStrictEqual(second.completedTaskIds, []);

		strictEqual(launchAttempts.length, 2);
		deepStrictEqual(
			launchAttempts.map((payload) => payload.taskId),
			["1.1", "1.1"],
		);
		deepStrictEqual(
			launchAttempts.map((payload) => payload.provider),
			["cursor", "cursor"],
		);
	});
});

describe("runner provider spread recording", { concurrency: false }, () => {
	it("revalidates default macOS qualification immediately before fake adapter launch", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Runtime qualification
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** exercise the production router through the runner
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const snapshotPath = join(
			tmpdir(),
			`switchyard-runtime-qualification-${process.pid}-${randomUUID()}.json`,
		);
		const previousSnapshotPath = process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		const qualifiedRosterPath = writeDispatchQualifiedRosterFixture();
		process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = snapshotPath;
		process.env.SWITCHYARD_ROSTER_PATH = qualifiedRosterPath;
		__resetRosterCacheForTests();
		try {
			writeFileSync(
				snapshotPath,
				JSON.stringify({
					schema_version: 2,
					updated_at: new Date().toISOString(),
					providers: [
						{ name: "claude", ok: true, windows: [{ percent_left: 99 }] },
						{ name: "codex", ok: true, windows: [{ percent_left: 20 }] },
					],
				}),
				"utf8",
			);
			const result = runQueueImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				platform: "macos",
				dependencies: {
					queuePreflight: () => ({ ok: true, eligible: true }),
					recordDispatchIntent: () => {},
					recordDispatch: () => {},
					integrationGate: () => ({ success: true }),
					backendFactory: () => ({
						readiness: () => ({ inventoryCount: 0 }),
						create: () => "fake-container",
						destroy: () => {},
						seed: () => {},
						commit: () => {},
						reset: () => {},
					}),
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
					},
				},
			});
			strictEqual(result.results[0].provider, "codex");
		} finally {
			if (previousSnapshotPath === undefined) {
				delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
			} else {
				process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = previousSnapshotPath;
			}
			if (previousRosterPath === undefined)
				delete process.env.SWITCHYARD_ROSTER_PATH;
			else process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			__resetRosterCacheForTests();
			rmSync(snapshotPath, { force: true });
			rmSync(qualifiedRosterPath, { force: true });
		}
	});
	it("records split dispatches across claude and codex", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Type:** review
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Type:** review
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		let routeIndex = 0;
		const routes = [
			{
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 70,
				reason: "spread",
			},
			{
				provider: "codex",
				model: "gpt-5.6-terra",
				percentLeft: 68,
				reason: "spread",
			},
		];
		let launchIndex = 0;

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => {
					const selected = routes[Math.min(routeIndex, routes.length - 1)];
					routeIndex += 1;
					return selected;
				},
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
		});

		deepStrictEqual(
			dispatches.map((entry) => entry.provider),
			["claude", "codex"],
		);
		deepStrictEqual(
			dispatches.map((entry) => entry.model),
			["claude-sonnet-5", "gpt-5.6-terra"],
		);
		deepStrictEqual(
			dispatches.map((entry) => entry.result),
			["success_no_diff", "success_no_diff"],
		);
	});

	it("uses headroom routing to split providers across tasks", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Type:** review
- **Description:** integration task one

### Task 1.2: Second task
- **Status:** pending
- **Type:** review
- **Description:** integration task two
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		// Isolated per-test temp snapshot, not the real shared SNAPSHOT_PATH: this
		// test intentionally exercises the real, unmocked route() (no
		// dependencies.route override below), and tests/router.test.mjs also
		// exercises the real loader concurrently in its own process. Both used to
		// read/write/rm the SAME on-disk SNAPSHOT_PATH (the host-side gradus
		// snapshot), which raced under `node --test`'s concurrent-file execution.
		// The env var is read dynamically by resolveSnapshotPath() in
		// src/switchyard/router/index.mjs, so pointing it at a unique file here
		// redirects the real readSnapshot() without touching production callers.
		const snapshotPath = join(
			tmpdir(),
			`switchyard-runner-test-headroom-${process.pid}-${randomUUID()}.json`,
		);
		let launchIndex = 0;

		const writeSnapshot = (claudePercentLeft, codexPercentLeft) => {
			writeFileSync(
				snapshotPath,
				JSON.stringify({
					schema_version: 2,
					providers: [
						{
							name: "claude",
							ok: true,
							windows: [{ percent_left: claudePercentLeft, pace_delta: 100 }],
						},
						{
							name: "codex",
							ok: true,
							windows: [{ percent_left: codexPercentLeft, pace_delta: 100 }],
						},
					],
				}),
				"utf8",
			);
		};

		const previousOverride = process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
		process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = snapshotPath;
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		const qualifiedRosterPath = writeDispatchQualifiedRosterFixture();
		process.env.SWITCHYARD_ROSTER_PATH = qualifiedRosterPath;
		__resetRosterCacheForTests();

		try {
			writeSnapshot(72, 60);

			await runQueueWithOrchestrator({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					goldenImageVerifiedProviders: ["claude", "codex"],
					recordDispatch: (entry) => {
						dispatches.push(entry);
						if (dispatches.length === 1) {
							writeSnapshot(4, 68);
						}
					},
					integrationGate: () => ({ success: true, message: "ok" }),
					sleepFn: async () => {},
					orchestrator: {
						launch: async () => {
							launchIndex += 1;
							return `job-${launchIndex}`;
						},
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: "" }),
					},
				},
			});

			deepStrictEqual(
				dispatches.map((entry) => entry.provider),
				["claude", "codex"],
			);
			// Assert the mechanism, not just the outcome sequence: the first
			// dispatch picks claude specifically because it has more headroom
			// (72 > 60) via spread selection, and the second picks codex
			// specifically because claude's headroom then dropped to 4% —
			// below DEFAULT_FLOOR (5.0) — excluding it, not because provider
			// selection happened to differ for some unrelated reason.
			strictEqual(dispatches[0].reason, "spread");
			strictEqual(dispatches[0].percentLeft, 72);
			strictEqual(dispatches[1].reason, "spread");
			strictEqual(dispatches[1].percentLeft, 68);
		} finally {
			if (previousOverride === undefined) {
				delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
			} else {
				process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = previousOverride;
			}
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
			try {
				rmSync(snapshotPath, { force: true });
				rmSync(qualifiedRosterPath, { force: true });
			} catch {
				// ignore cleanup errors
			}
		}
	});

	it("never dispatches to a roster provider with no adapter, even with the most headroom", async () => {
		// Regression: vibe/agy/cursor/copilot are in the roster but only
		// claude/codex have adapters wired here. Before the availableProviders
		// fix, route() (unconstrained) could legitimately pick vibe for a
		// low-capability task, selectAdapter() would return null, and the task
		// would fail with "unsupported_provider" forever — every resume
		// re-picks the same unsupported provider and fails identically.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** simple trivial cleanup
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		// Isolated per-test temp snapshot — see the "uses headroom routing" test
		// above for why: this test also exercises the real, unmocked route().
		const snapshotPath = join(
			tmpdir(),
			`switchyard-runner-test-noadapter-${process.pid}-${randomUUID()}.json`,
		);

		const previousOverride = process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
		process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = snapshotPath;
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		const qualifiedRosterPath = writeDispatchQualifiedRosterFixture();
		process.env.SWITCHYARD_ROSTER_PATH = qualifiedRosterPath;
		__resetRosterCacheForTests();

		try {
			writeFileSync(
				snapshotPath,
				JSON.stringify({
					schema_version: 2,
					providers: [
						{
							name: "claude",
							ok: true,
							windows: [{ percent_left: 30, pace_delta: 100 }],
						},
						{
							name: "vibe",
							ok: true,
							windows: [{ percent_left: 95, pace_delta: 10 }],
						},
					],
				}),
				"utf8",
			);

			const dispatches = [];
			const result = runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					// Real router (not mocked) — only override recordDispatch/adapters.
					goldenImageVerifiedProviders: ["claude"],
					recordDispatch: (entry) => dispatches.push(entry),
					integrationGate: () => ({ success: true, message: "ok" }),
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/b b/b",
						},
					},
				},
			});

			strictEqual(dispatches[0].provider, "claude");
			notStrictEqual(dispatches[0].result, "unsupported_provider");
			strictEqual(result.results[0].success, true);
		} finally {
			if (previousOverride === undefined) {
				delete process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE;
			} else {
				process.env.SWITCHYARD_SNAPSHOT_PATH_OVERRIDE = previousOverride;
			}
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
			try {
				rmSync(snapshotPath, { force: true });
				rmSync(qualifiedRosterPath, { force: true });
			} catch {
				// ignore cleanup errors
			}
		}
	});

	for (const provider of ["agy", "cursor"]) {
		it(`dispatches to the ${provider} adapter when route selects it (regression: selectAdapter only recognized claude/codex)`, () => {
			// Regression: runQueue's default adapters map was extended to include
			// agy/cursor (so route()'s availableProviders correctly reports them
			// as dispatchable), but selectAdapter() itself was never updated
			// beyond its original claude/codex checks. That combination is worse
			// than not wiring them at all: route() is now told agy/cursor are
			// available and may legitimately pick one, but selectAdapter() then
			// returns null for it and the task fails with "unsupported_provider"
			// on every attempt (and every resume), exactly the failure mode the
			// availableProviders fix was meant to eliminate.
			const dispatches = [];
			const result = executeTask(
				{ id: "1.1", title: "task", description: "simple cleanup" },
				{
					route: () => ({
						provider,
						model: `${provider}-model`,
						percentLeft: 50,
						reason: "spread",
					}),
					recordDispatch: (entry) => dispatches.push(entry),
					recordDispatchIntent: () => {},
					integrationGate: () => ({ success: true, message: "ok" }),
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/b b/b",
						},
						agy: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/c b/c",
						},
						cursor: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/d b/d",
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
			);

			notStrictEqual(
				result.result,
				"unsupported_provider",
				`${provider} has an adapter wired but was rejected as unsupported`,
			);
			strictEqual(result.success, true);
			strictEqual(dispatches[0].provider, provider);
			strictEqual(dispatches[0].result, "success");
		});
	}
});

describe("external completion handoff", () => {
	it("fails closed before reading or mutating any checkpoint for malformed input", async () => {
		const result = await reconcileExternalCompletion({});
		strictEqual(result.status, "refused");
		strictEqual(result.reasonCode, "malformed_receipt");
	});
});

describe("runner quota retry coordination", () => {
	function makeQuotaRetryDependencies({
		routePlan,
		executionOutcomes,
		onResult,
		onStatus,
		only = [],
		recordDispatch,
		integrationGate = () => ({ success: true, message: "ok" }),
		resetWorkingTree = () => {},
	} = {}) {
		const routeCalls = [];
		const executeCalls = [];
		const executeOptions = [];
		let latestRoutedCandidate = null;
		const retryProjections = [];
		const taskBaseCaptures = [];
		const taskBaseReleases = [];
		const outcomes = new Map(
			Object.entries(executionOutcomes ?? {}).map(([provider, values]) => [
				provider,
				[...values],
			]),
		);
		const route = ({ exclude = [], only = [] } = {}) => {
			routeCalls.push({ exclude: [...exclude], only: [...only] });
			const candidate = routePlan.find(
				(entry) =>
					!exclude.includes(entry.target) &&
					!exclude.includes(entry.provider) &&
					(only.length === 0 ||
						only.includes(entry.target) ||
						only.includes(entry.provider)),
			);
			latestRoutedCandidate = candidate ?? null;
			if (!candidate) {
				return {
					provider: null,
					model: null,
					resolvedTargetId: null,
					reason: "no_eligible_retry_target",
					log: [],
				};
			}
			return {
				...candidate,
				resolvedTargetId: candidate.target,
				percentLeft: 50,
				reason: "fixture",
				log: [],
			};
		};
		const makeAdapter = (provider) => ({
			execute: (_prompt, _workspace, options) => {
				executeCalls.push(provider);
				executeOptions.push(options);
				const queue = outcomes.get(provider) ?? [];
				const outcome = queue.shift() ?? {
					success: true,
					output: "ok",
				};
				return outcome;
			},
			executeAsync: async (_prompt, _workspace, options) => {
				executeCalls.push(provider);
				executeOptions.push(options);
				const queue = outcomes.get(provider) ?? [];
				const outcome = queue.shift() ?? { success: true, output: "ok" };
				if (
					outcome?.diagnosticEvidenceAvailable === true &&
					typeof outcome.diagnosticRef === "string" &&
					/^diagnostic:[a-f0-9]{32}$/u.test(outcome.diagnosticRef)
				) {
					return {
						...outcome,
						diagnosticEvidence: outcome.diagnosticEvidence ?? {
							stdoutBytes: 0,
							stderrBytes: 0,
							stdoutDigest: `sha256:${"a".repeat(64)}`,
							stderrDigest: `sha256:${"b".repeat(64)}`,
							diagnosticKind: "usage_exhausted",
						},
					};
				}
				return outcome;
			},
			captureDiff: () => "diff --git a/a b/a\n+change",
			captureDiffAsync: async () => "diff --git a/a b/a\n+change",
		});
		return {
			routeCalls,
			executeCalls,
			executeOptions,
			retryProjections,
			taskBaseCaptures,
			taskBaseReleases,
			dependencies: {
				route,
				recordDispatch: recordDispatch ?? (() => {}),
				onResult,
				onStatus,
				onRetryStateChanged: (projection) => retryProjections.push(projection),
				integrationGate,
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "owned-retry-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree,
				captureTaskBase: (_workspaceId, { taskId }) => {
					taskBaseCaptures.push(taskId);
					return TASK_BASE;
				},
				validateTaskBase: (_workspaceId, base) => base,
				releaseTaskBase: (_workspaceId, base) => taskBaseReleases.push(base),
				wipeWorkingContainer: () => {},
				persistDiagnosticArtifact: async (evidence) => {
					strictEqual(evidence?.diagnosticKind, "usage_exhausted");
					return VALID_DIAGNOSTIC_REF;
				},
				resolveTargetIdentity: (provider) => {
					const candidate = latestRoutedCandidate;
					if (!candidate || candidate.provider !== provider) {
						return {
							targetId: null,
							harnessKey: null,
							ambiguous: true,
						};
					}
					return {
						targetId: candidate.target,
						harnessKey: candidate.harness ?? candidate.provider,
						ambiguous: false,
					};
				},
				adapters: {
					agy: makeAdapter("agy"),
					codex: makeAdapter("codex"),
				},
			},
			only,
		};
	}

	function completionReceipt(options, overrides = {}) {
		return {
			version: 1,
			kind: "completion_continuation_lifecycle",
			providerExited: true,
			childrenExited: true,
			cleanupSucceeded: true,
			taskId: options.cleanupContext.taskId,
			attemptId: options.cleanupContext.attemptId,
			descriptorIdentity: options.cleanupContext.descriptorIdentity,
			workspaceId: options.cleanupContext.workspaceId,
			...overrides,
		};
	}

	it("continues once in the owned workspace only after lifecycle proof", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Complete missing path
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** add the declared file
`);
		let gateCalls = 0;
		let monotonic = 0;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
			],
			integrationGate: () => {
				gateCalls += 1;
				return gateCalls === 1
					? {
							success: false,
							message: "required_paths_missing",
							missingPaths: ["src/a.mjs"],
						}
					: { success: true, message: "ok" };
			},
		});
		fixture.dependencies.now = () => monotonic;
		fixture.dependencies.monotonicNow = () => monotonic;
		fixture.dependencies.adapters.agy.supportsCompletionContinuation = true;
		const executeWithReceipt = fixture.dependencies.adapters.agy.execute;
		fixture.dependencies.adapters.agy.execute = (...args) => {
			const execution = executeWithReceipt(...args);
			if (fixture.executeCalls.length === 1) monotonic = 1_000;
			return {
				...execution,
				completionContinuationProof: completionReceipt(args[2]),
			};
		};
		fixture.dependencies.completionContinuation = { enabled: true };

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: fixture.dependencies,
		});
		strictEqual(result.results[0].success, true);
		deepStrictEqual(fixture.executeCalls, ["agy", "agy"]);
		strictEqual(fixture.routeCalls.length, 1);
		strictEqual(fixture.executeOptions[0].timeoutMs, 1_800_000);
		strictEqual(fixture.executeOptions[1].timeoutMs, 1_799_000);
		// The continuation is the same attempt continuing: a
		// completion_correction allocation must not move the cleanup context
		// (and therefore the minted receipt) to attempt-2, or the route-health
		// binding keyed on attempt-1 could never match it.
		deepStrictEqual(
			fixture.executeOptions.map((options) => options.cleanupContext.attemptId),
			["attempt-1", "attempt-1"],
		);
		const checkpoint = loadCheckpoint(
			`${tasksPath}.checkpoint.json`,
			tasksPath,
		);
		deepStrictEqual(checkpoint.providerAttemptAllocations, [
			{
				taskId: "1.1",
				reason: "completion_correction",
				state: "result_recorded",
				allocatedAt: checkpoint.providerAttemptAllocations[0].allocatedAt,
				deadline: checkpoint.providerAttemptAllocations[0].deadline,
				descriptorIdentity:
					checkpoint.providerAttemptAllocations[0].descriptorIdentity,
				workspaceId: "owned-retry-container",
				baseTree: TASK_BASE.tree,
				attemptId: "attempt-1",
			},
		]);
	});

	it("applies one cumulative correction through the real gate and commits the worker once", () => {
		const projectPath = join(TEST_DIR, "completion-real-gate");
		mkdirSync(projectPath, { recursive: true });
		runFixtureGit(projectPath, ["init", "-q"]);
		writeFileSync(join(projectPath, "README.md"), "fixture\n");
		runFixtureGit(projectPath, ["add", "README.md"]);
		runFixtureGit(projectPath, [
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"base",
		]);
		const headBefore = runFixtureGit(projectPath, ["rev-parse", "HEAD"]);
		const baseTree = runFixtureGit(projectPath, [
			"rev-parse",
			`${headBefore}^{tree}`,
		]);
		const workerPath = join(TEST_DIR, "completion-worker-repo");
		const clone = spawnSync("git", ["clone", "-q", projectPath, workerPath], {
			encoding: "utf8",
		});
		strictEqual(clone.status, 0, clone.stderr);
		const tasksPath = writeTasksFile(`### Task 1.1: Complete both files
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs, src/b.mjs
- **Description:** add both declared files
`);
		let executions = 0;
		let commits = 0;
		let resets = 0;
		let teardowns = 0;
		const adapter = {
			supportsCompletionContinuation: true,
			execute: (_prompt, _workspace, options) => {
				executions += 1;
				mkdirSync(join(workerPath, "src"), { recursive: true });
				if (executions === 1) {
					writeFileSync(join(workerPath, "src/a.mjs"), "export const a = 1;\n");
					runFixtureGit(workerPath, ["add", "src/a.mjs"]);
					runFixtureGit(workerPath, [
						"-c",
						"user.name=Worker",
						"-c",
						"user.email=worker@example.invalid",
						"commit",
						"-qm",
						"provider commit",
					]);
				} else {
					writeFileSync(join(workerPath, "src/b.mjs"), "export const b = 2;\n");
					runFixtureGit(workerPath, ["add", "-N", "src/b.mjs"]);
				}
				return {
					success: true,
					output: "ignored",
					completionContinuationProof: completionReceipt(options),
				};
			},
			captureDiff: () =>
				runFixtureGit(workerPath, ["diff", "--binary", headBefore]),
		};
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				completionContinuation: { enabled: true },
				route: () => ({
					provider: "agy",
					model: "fixture-model",
					resolvedTargetId: "agy-fixture",
					resolved_harness: "agy",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				adapters: { agy: adapter },
				backendFactory: () => ({
					readiness: () => ({ inventoryCount: 0 }),
					ensureAgentContainer: () => {},
					create: () => "completion-worker",
					provision: () => {},
					seed: () => {},
					commit: () => {
						commits += 1;
						runFixtureGit(workerPath, ["add", "-A"]);
						runFixtureGit(workerPath, [
							"-c",
							"user.name=Runner",
							"-c",
							"user.email=runner@example.invalid",
							"commit",
							"-qm",
							"accepted correction",
						]);
					},
					reset: () => {
						resets += 1;
					},
					captureTaskBase: () => ({ ref: headBefore, tree: baseTree }),
					validateTaskBase: (_workspace, base) => base,
					releaseTaskBase: () => {},
					destroy: () => {
						teardowns += 1;
					},
				}),
			},
		});
		strictEqual(
			result.results[0].success,
			true,
			JSON.stringify(result.results[0]),
		);
		strictEqual(executions, 2);
		strictEqual(commits, 1);
		strictEqual(resets, 0);
		strictEqual(teardowns, 1);
		strictEqual(
			runFixtureGit(workerPath, ["rev-list", "--count", `${headBefore}..HEAD`]),
			"2",
		);
		strictEqual(
			readFileSync(join(projectPath, "src/a.mjs"), "utf8"),
			"export const a = 1;\n",
		);
		strictEqual(
			readFileSync(join(projectPath, "src/b.mjs"), "utf8"),
			"export const b = 2;\n",
		);
		strictEqual(runFixtureGit(projectPath, ["rev-parse", "HEAD"]), headBefore);
	});

	it("does not continue after lifecycle drift, declined cleanup, or an expired budget", () => {
		for (const condition of [
			"cleanup_declined",
			"descriptor_drift",
			"workspace_drift",
			"deadline_expired",
		]) {
			const tasksPath = writeTasksFile(`### Task 1.1: Stop correction
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** stop safely
`);
			let monotonic = 0;
			let proofCalls = 0;
			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-model", target: "agy-fixture" },
				],
				integrationGate: () => ({
					success: false,
					message: "required_paths_missing",
					missingPaths: ["src/a.mjs"],
				}),
			});
			const originalExecute = fixture.dependencies.adapters.agy.execute;
			fixture.dependencies.adapters.agy.supportsCompletionContinuation = true;
			fixture.dependencies.adapters.agy.execute = (...args) => {
				const execution = originalExecute(...args);
				if (condition === "deadline_expired") monotonic = 2_000_000;
				if (condition !== "deadline_expired") proofCalls += 1;
				return {
					...execution,
					completionContinuationProof: completionReceipt(args[2], {
						...(condition === "cleanup_declined"
							? { cleanupSucceeded: false }
							: {}),
						...(condition === "descriptor_drift"
							? { descriptorIdentity: "drifted" }
							: {}),
						...(condition === "workspace_drift"
							? { workspaceId: "other-worker" }
							: {}),
					}),
				};
			};
			fixture.dependencies.completionContinuation = { enabled: true };
			fixture.dependencies.monotonicNow = () => monotonic;
			const result = runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath: `${tasksPath}.checkpoint.json`,
				dependencies: fixture.dependencies,
			});
			strictEqual(result.results[0].success, false, condition);
			strictEqual(fixture.executeCalls.length, 1, condition);
			strictEqual(
				proofCalls,
				condition === "deadline_expired" ? 0 : 1,
				condition,
			);
			deepStrictEqual(
				loadCheckpoint(`${tasksPath}.checkpoint.json`, tasksPath)
					.providerAttemptAllocations,
				[],
				condition,
			);
		}
	});

	it("does not replenish allocated or running correction attempts after restart", () => {
		for (const state of ["allocated", "running"]) {
			const tasksPath = writeTasksFile(`### Task 1.1: Resume safely
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** do not repeat an ambiguous invocation
`);
			const checkpointPath = `${tasksPath}.${state}.checkpoint.json`;
			const checkpoint = createEmptyCheckpoint(tasksPath);
			checkpoint.providerAttemptAllocations = [
				{
					taskId: "1.1",
					reason: "completion_correction",
					state,
					allocatedAt: "2026-09-06T03:00:00.000Z",
					deadline: "2026-09-06T03:30:00.000Z",
					descriptorIdentity: "descriptor-before-crash",
					workspaceId: "worker-before-crash",
					baseTree: "4".repeat(40),
					attemptId: "attempt-1",
				},
			];
			saveCheckpoint(checkpointPath, checkpoint);
			strictEqual(releaseCheckpointOwnership(checkpointPath, checkpoint), true);
			let launches = 0;
			const result = runQueue({
				tasksFilePath: tasksPath,
				checkpointPath,
				projectPath: TEST_DIR,
				runId: `resumed-${state}`,
				dependencies: {
					now: () => 0,
					monotonicNow: () => 0,
					route: () => {
						launches += 1;
						return { provider: "agy", model: "fixture-model" };
					},
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					adapters: {},
				},
			});
			strictEqual(result.processedTasks, 1, state);
			strictEqual(
				result.results[0].reason,
				"persisted extra provider invocation already consumed",
			);
			strictEqual(launches, 0, state);
		}
	});

	it("rejects a fractional remaining budget after task-base preparation before provider launch", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Expire preparing
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** preparation consumes the budget
`);
		let monotonic = 0;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-model", target: "agy-fixture" },
			],
		});
		fixture.dependencies.monotonicNow = () => monotonic;
		fixture.dependencies.captureTaskBase = () => {
			monotonic = 1_799_999.5;
			return TASK_BASE;
		};
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: fixture.dependencies,
		});
		strictEqual(result.results[0].result, "execution_timed_out");
		strictEqual(fixture.executeCalls.length, 0);
	});

	it("gives a late quota fallback its own fresh provider timeout", async () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Retry quota
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** reroute after qualified quota exhaustion
`);
		let monotonic = 0;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-first", target: "agy-first" },
				{ provider: "agy", model: "fixture-second", target: "agy-second" },
			],
			executionOutcomes: {
				agy: [
					{
						success: false,
						result: "execution_failed",
						errorKind: "quota_exhausted",
						diagnosticCode: "quota_exhausted",
						diagnosticOrigin: "adapter",
						diagnosticEvidenceAvailable: true,
						diagnosticRef: VALID_DIAGNOSTIC_REF,
						failurePhase: "provider_execution",
					},
				],
			},
		});
		fixture.dependencies.now = () => monotonic;
		fixture.dependencies.monotonicNow = () => monotonic;
		const firstExecute = fixture.dependencies.adapters.agy.executeAsync;
		fixture.dependencies.adapters.agy.executeAsync = async (...args) => {
			const result = await firstExecute(...args);
			monotonic = 1_700_000;
			return result;
		};

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: fixture.dependencies,
		});
		strictEqual(
			result.results[0].success,
			true,
			JSON.stringify(result.results[0]),
		);
		deepStrictEqual(fixture.executeCalls, ["agy", "agy"]);
		deepStrictEqual(
			fixture.executeOptions.map(({ timeoutMs }) => timeoutMs),
			[1_800_000, 1_800_000],
		);
	});

	it("does not authorize quota fallback from structured code without an artifact", async () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Unretained quota
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** a structured label without durable evidence cannot replay
`);
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-first", target: "agy-first" },
				{ provider: "agy", model: "fixture-second", target: "agy-second" },
			],
			executionOutcomes: {
				agy: [
					{
						success: false,
						result: "execution_failed",
						errorKind: "quota_exhausted",
						diagnosticCode: "quota_exhausted",
						diagnosticOrigin: "adapter",
						diagnosticEvidenceAvailable: true,
						failurePhase: "provider_execution",
					},
				],
			},
		});
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			stopOnFailure: true,
			dependencies: fixture.dependencies,
		});
		strictEqual(result.results[0].success, false);
		strictEqual(result.results[0].diagnosticRef, null);
		strictEqual(result.results[0].diagnosticEvidenceAvailable, false);
		deepStrictEqual(fixture.executeCalls, ["agy"]);
	});

	it("shares one extra launch between empty-capture correction and quota fallback", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Empty then quota
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** finish the required file
`);
		let resets = 0;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-model", target: "agy-fixture" },
			],
			executionOutcomes: {
				agy: [
					{ success: true, output: "primary" },
					{
						success: false,
						result: "execution_failed",
						errorKind: "quota_exhausted",
						diagnosticCode: "agy_quota_exhausted",
						diagnosticOrigin: "adapter",
						diagnosticEvidenceAvailable: true,
					},
				],
			},
			integrationGate: () => ({
				success: false,
				message: "empty_required_diff",
			}),
			resetWorkingTree: () => {
				resets += 1;
			},
		});
		fixture.dependencies.adapters.agy.captureDiff = () => "";
		fixture.dependencies.adapters.agy.supportsCompletionContinuation = true;
		const executeWithReceipt = fixture.dependencies.adapters.agy.execute;
		fixture.dependencies.adapters.agy.execute = (...args) => ({
			...executeWithReceipt(...args),
			completionContinuationProof: completionReceipt(args[2]),
		});
		fixture.dependencies.completionContinuation = { enabled: true };
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: fixture.dependencies,
		});
		strictEqual(result.results[0].success, false);
		strictEqual(fixture.executeCalls.length, 2);
		strictEqual(fixture.routeCalls.length, 1);
		strictEqual(resets, 0);
		strictEqual(
			loadCheckpoint(`${tasksPath}.checkpoint.json`, tasksPath)
				.providerAttemptAllocations[0].reason,
			"completion_correction",
		);
	});

	it("does not launch correction when its durable allocation cannot publish", () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Persist first
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** allocate before continuing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-model", target: "agy-fixture" },
			],
			integrationGate: () => ({
				success: false,
				message: "required_paths_missing",
				missingPaths: ["src/a.mjs"],
			}),
		});
		fixture.dependencies.adapters.agy.supportsCompletionContinuation = true;
		const executeWithReceipt = fixture.dependencies.adapters.agy.execute;
		fixture.dependencies.adapters.agy.execute = (...args) => {
			const execution = executeWithReceipt(...args);
			writeFileSync(`${checkpointPath}.lock`, "ambiguous");
			return {
				...execution,
				completionContinuationProof: completionReceipt(args[2]),
			};
		};
		fixture.dependencies.completionContinuation = { enabled: true };
		throws(
			() =>
				runQueue({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				}),
			/checkpoint lease unavailable/,
		);
		strictEqual(fixture.executeCalls.length, 1);
	});

	it("leaves completion correction unavailable in broker and orchestrator loops", async () => {
		for (const mode of ["broker", "orchestrator"]) {
			const tasksPath = writeTasksFile(`### Task 1.1: Unsupported continuation
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** do not infer lifecycle support
`);
			let launches = 0;
			let proofCalls = 0;
			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-model", target: "agy-fixture" },
				],
				integrationGate: () => ({
					success: false,
					message: "required_paths_missing",
					missingPaths: ["src/a.mjs"],
				}),
			});
			fixture.dependencies.completionContinuation = { enabled: true };
			fixture.dependencies.adapters.agy.supportsCompletionContinuation = true;
			fixture.dependencies.adapters.agy.verifyCompletionContinuation = () => {
				proofCalls += 1;
				return null;
			};
			if (mode === "orchestrator") {
				fixture.dependencies.orchestrator = {
					launch: () => {
						launches += 1;
						return "job-1";
					},
					status: () => ({ state: "done" }),
					result: () => ({ success: true }),
				};
				await runQueueWithOrchestrator({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath: `${tasksPath}.checkpoint.json`,
					dependencies: fixture.dependencies,
				});
			} else {
				await runQueueAsync({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath: `${tasksPath}.checkpoint.json`,
					dependencies: fixture.dependencies,
				});
			}
			strictEqual(proofCalls, 0, mode);
			strictEqual(
				mode === "orchestrator" ? launches : fixture.executeCalls.length,
				1,
				mode,
			);
		}
	});

	it("quarantines one target, retries on an isolated target, and counts one logical task", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Quota fallback
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** retry after a verified quota failure
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		const results = [];
		const statuses = [];
		let resetCalls = 0;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
				{ provider: "agy", model: "fixture-claude", target: "agy-claude" },
			],
			executionOutcomes: {
				agy: [
					{
						success: false,
						output: "",
						error: "provider quota unavailable",
						errorKind: "quota_exhausted",
						diagnosticCode: "quota_exhausted",
						diagnosticOrigin: "adapter",
						diagnosticEvidenceAvailable: true,
						diagnosticRef: VALID_DIAGNOSTIC_REF,
						failurePhase: "provider_execution",
					},
					{ success: true, output: "ok" },
				],
			},
			onResult: (result) => results.push(result),
			onStatus: (event) => statuses.push(event),
			recordDispatch: (entry) => dispatches.push(entry),
			resetWorkingTree: () => {
				resetCalls += 1;
			},
		});

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			maxTasks: 1,
			dependencies: fixture.dependencies,
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results.length, 1);
		strictEqual(result.results[0].success, true);
		strictEqual(results.length, 1, "onResult receives only the final outcome");
		strictEqual(fixture.executeCalls.length, 2);
		deepStrictEqual(fixture.taskBaseCaptures, ["1.1"]);
		strictEqual(fixture.taskBaseReleases.length, 1);
		strictEqual(resetCalls, 1, "reset completes before the retry");
		deepStrictEqual(
			fixture.routeCalls.map((call) => call.exclude),
			[[], ["agy-gemini"]],
		);
		strictEqual(
			dispatches.length,
			2,
			"both attempts remain in the dispatch ledger",
		);
		strictEqual(dispatches[0].errorKind, "quota_exhausted");
		strictEqual(dispatches[0].resolvedTargetId, "agy-gemini");
		strictEqual(dispatches[1].resolvedTargetId, "agy-claude");
		ok(statuses.some((event) => event.event === "retry_reset_started"));
		deepStrictEqual(
			fixture.retryProjections.map(
				(projection) => projection.retryTransitionId,
			),
			[1, 2, 4, 5],
		);
		deepStrictEqual(fixture.retryProjections.at(-1), {
			quarantinedTargetIds: ["agy-gemini"],
			retryState: null,
			retryTransitionId: 5,
		});

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1"]);
		strictEqual(
			checkpoint.results.length,
			1,
			"checkpoint results are final-only",
		);
		strictEqual(checkpoint.results[0].success, true);
		deepStrictEqual(checkpoint.quarantinedTargetIds, ["agy-gemini"]);
		strictEqual(checkpoint.retryAttempts.length, 2);
		deepStrictEqual(
			checkpoint.retryTransitions.map((transition) => transition.type),
			[
				"attempt_recorded",
				"target_quarantined",
				"reset_completed",
				"retry_started",
				"finalized",
			],
		);
		for (const transition of checkpoint.retryTransitions) {
			if (transition.invocationDescriptor) {
				strictEqual(
					transition.invocationDescriptor.target_id,
					transition.resolvedTargetId,
				);
			}
		}
		strictEqual(checkpoint.retryState, null);
		ok(
			!readFileSync(checkpointPath, "utf8").includes(
				"provider quota unavailable",
			),
		);
	});

	it("does not retry a caller-supplied container or escape an explicit target allowlist", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Quota fallback
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** no unsafe retry
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const executeCalls = [];
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
				{ provider: "codex", model: "fixture-codex", target: "codex-main" },
			],
			executionOutcomes: {},
		});
		fixture.dependencies.adapters.agy.execute = () => {
			executeCalls.push("agy");
			return {
				success: false,
				output: "",
				error: "quota",
				errorKind: "quota_exhausted",
			};
		};

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-owned",
			checkpointPath,
			only: ["agy-gemini"],
			dependencies: fixture.dependencies,
		});

		strictEqual(result.processedTasks, 1);
		deepStrictEqual(executeCalls, ["agy"]);
		strictEqual(result.results[0].errorKind, "quota_exhausted");
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.quarantinedTargetIds, []);
		strictEqual(checkpoint.retryAttempts.length, 0);
	});

	it("does not reset, quarantine, or reroute text-only quota labels in sync and async queues", async () => {
		for (const [name, entrypoint] of [
			["sync", runQueue],
			["async", runQueueAsync],
		]) {
			const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject ${name} text-only quota
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** legacy label is informational only
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			let resetCalls = 0;
			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
					{ provider: "codex", model: "fixture-codex", target: "codex-main" },
				],
				executionOutcomes: {
					agy: [
						{
							success: false,
							output: "",
							error: "quota-like prose",
							errorKind: "quota_exhausted",
						},
					],
				},
				resetWorkingTree: () => {
					resetCalls += 1;
				},
			});
			const result = await entrypoint({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				stopOnFailure: true,
				dependencies: fixture.dependencies,
			});
			strictEqual(result.results[0].success, false, name);
			strictEqual(fixture.executeCalls.length, 1, name);
			strictEqual(resetCalls, 0, name);
			const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
			deepStrictEqual(checkpoint.quarantinedTargetIds, [], name);
			deepStrictEqual(checkpoint.retryAttempts, [], name);
			deepStrictEqual(checkpoint.retryTransitions, [], name);
		}
	});

	it("does not resume a possibly applied legacy quarantined task", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Resume quota retry
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** resume after a durable quarantine transition
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resumeDescriptor = descriptorForRoute({
			provider: "agy",
			model: "fixture-gemini",
			resolvedTargetId: "agy-gemini",
		});
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["agy-gemini"],
			retryAttempts: [
				{
					taskId: "1.1",
					attempt: 1,
					provider: "agy",
					model: "fixture-gemini",
					resolvedTargetId: "agy-gemini",
					result: "execution_failed",
					success: false,
					timedOut: false,
					errorKind: "quota_exhausted",
					reasonCode: "quota_exhausted",
					reason:
						"Provider quota is exhausted; the target is unavailable for this attempt.",
				},
			],
			retryTransitions: [
				{ transitionId: 1, type: "attempt_recorded", taskId: "1.1" },
				{ transitionId: 2, type: "target_quarantined", taskId: "1.1" },
			],
			retryTransitionId: 2,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
				invocationDescriptor: resumeDescriptor,
				descriptorIdentity: resumeDescriptor.descriptor_identity,
				descriptorHarness: "agy",
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		});

		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
				{ provider: "agy", model: "fixture-claude", target: "agy-claude" },
			],
			executionOutcomes: { agy: [{ success: true, output: "ok" }] },
		});
		let resetCalls = 0;
		fixture.dependencies.resetWorkingTree = () => {
			resetCalls += 1;
		};

		const before = readFileSync(checkpointPath, "utf8");
		throws(
			() =>
				runQueue({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				}),
			/invalid quota diagnostic provenance/,
		);
		strictEqual(fixture.executeCalls.length, 0);
		strictEqual(resetCalls, 0);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
	});

	it("does not reconstruct a possibly applied legacy attempt", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Resume before quarantine
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** recover the transition boundary
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resumeDescriptor = descriptorForRoute({
			provider: "agy",
			model: "fixture-gemini",
			resolvedTargetId: "agy-gemini",
		});
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: [],
			retryAttempts: [
				{
					taskId: "1.1",
					attempt: 1,
					provider: "agy",
					model: "fixture-gemini",
					resolvedTargetId: "agy-gemini",
					result: "execution_failed",
					success: false,
					timedOut: false,
					errorKind: "quota_exhausted",
					reasonCode: "quota_exhausted",
					reason:
						"Provider quota is exhausted; the target is unavailable for this attempt.",
				},
			],
			retryTransitions: [
				{ transitionId: 1, type: "attempt_recorded", taskId: "1.1" },
			],
			retryTransitionId: 1,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "attempt_recorded",
				resolvedTargetId: "agy-gemini",
				invocationDescriptor: resumeDescriptor,
				descriptorIdentity: resumeDescriptor.descriptor_identity,
				descriptorHarness: "agy",
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		});

		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
				{ provider: "agy", model: "fixture-claude", target: "agy-claude" },
			],
			executionOutcomes: { agy: [{ success: true, output: "ok" }] },
		});

		const before = readFileSync(checkpointPath, "utf8");
		throws(
			() =>
				runQueue({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				}),
			/invalid quota diagnostic provenance/,
		);
		strictEqual(fixture.executeCalls.length, 0);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
	});

	it("fails closed on historical model-only retry state without launching", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject insufficient retry evidence
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** an old retry record has no exact descriptor
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["agy-gemini"],
			retryAttempts: [],
			retryTransitions: [],
			retryTransitionId: 0,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
			},
		});
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-claude", target: "agy-claude" },
			],
			executionOutcomes: { agy: [{ success: true, output: "must not run" }] },
		});
		throws(
			() =>
				runQueue({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				}),
			/explicit reconciliation/,
		);
		strictEqual(fixture.executeCalls.length, 0);
	});

	it("does not resume descriptor-only legacy retry state in sync or async queues", async () => {
		for (const [name, entrypoint] of [
			["sync", runQueue],
			["async", runQueueAsync],
		]) {
			const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject ${name} legacy retry
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** descriptor evidence alone cannot authorize replay
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const descriptor = descriptorForRoute({
				provider: "agy",
				model: "fixture-gemini",
				resolvedTargetId: "agy-gemini",
			});
			writeLegacyCheckpoint(checkpointPath, {
				version: 1,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				lastTaskId: null,
				lastUpdatedAt: null,
				results: [],
				quarantinedTargetIds: ["agy-gemini"],
				retryAttempts: [],
				retryTransitions: [],
				retryTransitionId: 0,
				retryState: {
					taskId: "1.1",
					attempt: 1,
					phase: "target_quarantined",
					resolvedTargetId: "agy-gemini",
					invocationDescriptor: descriptor,
					descriptorIdentity: descriptor.descriptor_identity,
					descriptorHarness: "agy",
				},
			});
			let resetCalls = 0;
			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-other", target: "agy-other" },
				],
				executionOutcomes: { agy: [{ success: true, output: "must not run" }] },
				resetWorkingTree: () => {
					resetCalls += 1;
				},
			});
			const invoke = () =>
				entrypoint({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				});
			if (name === "sync") throws(invoke, /explicit reconciliation/);
			else await rejects(invoke, /explicit reconciliation/);
			strictEqual(fixture.executeCalls.length, 0, name);
			strictEqual(resetCalls, 0, name);
		}
	});

	it("rejects a forged Claude descriptor for antigravity before reset, reroute, or execution", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject forged retry evidence
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** a descriptor signed for the wrong harness must not resume
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const descriptorCore = {
			target_id: "antigravity",
			model_ref: "fixture-gemini",
			selector: "fixture-gemini",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const forgedDescriptor = {
			...descriptorCore,
			descriptor_identity: getInvocationDescriptorIdentity(
				descriptorCore,
				"claude",
			),
		};
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["antigravity"],
			retryAttempts: [],
			retryTransitions: [],
			retryTransitionId: 0,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "antigravity",
				invocationDescriptor: forgedDescriptor,
				descriptorIdentity: forgedDescriptor.descriptor_identity,
				descriptorHarness: "claude",
			},
		});

		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "antigravity" },
			],
			executionOutcomes: {
				agy: [{ success: true, output: "must not execute" }],
			},
		});
		let resetCalls = 0;
		fixture.dependencies.resetWorkingTree = () => {
			resetCalls += 1;
		};

		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
		__resetRosterCacheForTests();
		try {
			throws(
				() =>
					runQueue({
						tasksFilePath: tasksPath,
						projectPath: TEST_DIR,
						checkpointPath,
						dependencies: fixture.dependencies,
					}),
				/descriptor harness does not match target/,
			);
		} finally {
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
		}

		strictEqual(resetCalls, 0);
		deepStrictEqual(fixture.routeCalls, []);
		strictEqual(fixture.executeCalls.length, 0);
	});

	for (const corruptField of ["retryAttempts", "retryTransitions"]) {
		it(`rejects forged descriptor evidence in ${corruptField} before routing`, () => {
			const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject corrupt retry evidence
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** malformed retry evidence must not be resumed
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const descriptorCore = {
				target_id: "antigravity",
				model_ref: "fixture-gemini",
				selector: "fixture-gemini",
				effort: null,
				variant: null,
				invocation_args: [],
			};
			const forgedDescriptor = {
				...descriptorCore,
				descriptor_identity: getInvocationDescriptorIdentity(
					descriptorCore,
					"claude",
				),
			};
			writeLegacyCheckpoint(checkpointPath, {
				version: 1,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				lastTaskId: null,
				lastUpdatedAt: null,
				results: [],
				quarantinedTargetIds: [],
				retryAttempts:
					corruptField === "retryAttempts"
						? [
								{
									taskId: "1.1",
									attempt: 1,
									resolvedTargetId: "antigravity",
									invocationDescriptor: forgedDescriptor,
									descriptorIdentity: forgedDescriptor.descriptor_identity,
									descriptorHarness: "claude",
								},
							]
						: [],
				retryTransitions:
					corruptField === "retryTransitions"
						? [
								{
									transitionId: 1,
									type: "attempt_recorded",
									taskId: "1.1",
									resolvedTargetId: "antigravity",
									invocationDescriptor: forgedDescriptor,
									descriptorIdentity: forgedDescriptor.descriptor_identity,
									descriptorHarness: "claude",
								},
							]
						: [],
				retryTransitionId: corruptField === "retryTransitions" ? 1 : 0,
				retryState: null,
			});

			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-gemini", target: "antigravity" },
				],
				executionOutcomes: {
					agy: [{ success: true, output: "must not execute" }],
				},
			});
			const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
			process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
			__resetRosterCacheForTests();
			try {
				throws(
					() =>
						runQueue({
							tasksFilePath: tasksPath,
							projectPath: TEST_DIR,
							checkpointPath,
							dependencies: fixture.dependencies,
						}),
					/descriptor harness does not match target/,
				);
			} finally {
				if (previousRosterPath === undefined) {
					delete process.env.SWITCHYARD_ROSTER_PATH;
				} else {
					process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
				}
				__resetRosterCacheForTests();
			}
			deepStrictEqual(fixture.routeCalls, []);
			strictEqual(fixture.executeCalls.length, 0);
		});
	}

	it("does not erase present non-array retry collections before validation", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject non-array retry evidence
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** corrupt retry collection
`);
		for (const corruptField of ["retryAttempts", "retryTransitions"]) {
			const checkpointPath = `${tasksPath}.${corruptField}.checkpoint.json`;
			writeLegacyCheckpoint(checkpointPath, {
				version: 1,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				lastTaskId: null,
				lastUpdatedAt: null,
				results: [],
				[corruptField]: { forged: true },
			});
			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-gemini", target: "antigravity" },
				],
			});
			throws(
				() =>
					runQueue({
						tasksFilePath: tasksPath,
						projectPath: TEST_DIR,
						checkpointPath,
						dependencies: fixture.dependencies,
					}),
				new RegExp(`${corruptField} is invalid`),
			);
			deepStrictEqual(fixture.routeCalls, []);
			strictEqual(fixture.executeCalls.length, 0);
		}
	});

	it("halts safely when the mandatory retry reset fails", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reset failure
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** reset failure
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
			],
			executionOutcomes: {
				agy: [
					{
						success: false,
						output: "",
						error: "quota",
						errorKind: "quota_exhausted",
						diagnosticCode: "quota_exhausted",
						diagnosticOrigin: "adapter",
						diagnosticEvidenceAvailable: true,
						diagnosticRef: VALID_DIAGNOSTIC_REF,
						failurePhase: "provider_execution",
					},
				],
			},
			resetWorkingTree: () => {
				throw new Error("reset implementation failed");
			},
		});

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: fixture.dependencies,
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].result, "halted_after_reset_failure");
		strictEqual(fixture.executeCalls.length, 1);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.retryState, null);
		strictEqual(checkpoint.retryTransitions.at(-1).type, "retry_halted");
		ok(
			!readFileSync(checkpointPath, "utf8").includes(
				"reset implementation failed",
			),
		);
	});

	it("does not infer dead ownership after a real child-process crash", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Child crash recovery
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** recover after the provider target is quarantined
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runnerUrl = pathToFileURL(
			resolve(cwd(), "src/switchyard/runner/index.mjs"),
		).href;
		const rosterUrl = pathToFileURL(
			resolve(cwd(), "src/switchyard/roster/index.mjs"),
		).href;
		const childScript = `
import { runQueueAsync } from ${JSON.stringify(runnerUrl)};
import { getInvocationDescriptorIdentity } from ${JSON.stringify(rosterUrl)};
const [tasksFilePath, checkpointPath, projectPath] = process.argv.slice(1);
const routePlan = [
  { provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
  { provider: "agy", model: "fixture-claude", target: "agy-claude" },
];
let latestDescriptor = null;
let latestRoutedCandidate = null;
const descriptorFor = (candidate) => {
  const core = {
    target_id: candidate.target,
    model_ref: candidate.model,
    selector: candidate.model,
    effort: null,
    variant: null,
    invocation_args: [],
  };
  return { ...core, descriptor_identity: getInvocationDescriptorIdentity(core, "agy") };
};
const route = ({ exclude = [], only = [] } = {}) => {
  const candidate = routePlan.find((entry) =>
    !exclude.includes(entry.target) &&
    !exclude.includes(entry.provider) &&
    (only.length === 0 || only.includes(entry.target) || only.includes(entry.provider))
  );
  latestRoutedCandidate = candidate ?? null;
  return candidate
    ? (latestDescriptor = descriptorFor(candidate), { ...candidate, resolvedTargetId: candidate.target, invocationDescriptor: latestDescriptor, percentLeft: 50, log: [] })
    : { provider: null, model: null, resolvedTargetId: null, reason: "no_eligible_retry_target", log: [] };
};
await runQueueAsync({
  tasksFilePath,
  projectPath,
  checkpointPath,
  platform: "macos",
  // isQuotaRetryCandidate (runner/index.mjs) only treats a quota_exhausted
  // failure as retryable when ownsWorkingContainer is true, which the queue
  // only sets when IT creates the working container itself -- a caller-
  // supplied workingContainerName skips that bootstrap block entirely and
  // silently disables retry/quarantine. So this crash-recovery test needs a
  // synthetic backendFactory (not a workingContainerName shortcut) to let
  // the queue own the container while still avoiding any real VM lifecycle.
  dependencies: {
    route,
    resolveTargetIdentity: (provider) => {
      const candidate = latestRoutedCandidate;
      return candidate && candidate.provider === provider
        ? { targetId: candidate.target, harnessKey: "agy", ambiguous: false }
        : { targetId: null, harnessKey: null, ambiguous: true };
    },
    resolveDescriptor: () => latestDescriptor,
    recordDispatch: () => {},
		recordDispatchIntent: () => {},
    integrationGate: () => ({ success: true }),
    // No real routing snapshot exists in this child process's cwd; the
    // default macOS preflight gate is irrelevant to what this test proves,
    // so bypass it the same way tests/runner.test.mjs's shared runQueue
    // wrapper does for the rest of this file.
    queuePreflight: () => ({ ok: true, eligible: true }),
    backendFactory: () => ({
      readiness: () => ({ inventoryCount: 0 }),
      ensureAgentContainer: () => {},
      create: () => "child-owned-retry-container",
      provision: () => {},
      seed: () => {},
      commit: () => {},
      reset: () => {},
      captureTaskBase: () => ({ ref: "refs/switchyard/task-base/child-crash/1.1", tree: "4".repeat(40) }),
      validateTaskBase: (_workspaceId, base) => base,
      destroy: () => {},
    }),
    onRetryStateChanged: ({ retryTransitionId }) => {
      if (retryTransitionId === Number(process.env.CRASH_AT)) process.exit(73);
    },
    persistDiagnosticArtifact: async () => "diagnostic:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    adapters: {
      agy: {
        executeAsync: async () => ({
          success: false,
          output: "",
          error: "quota",
          errorKind: "quota_exhausted",
          diagnosticCode: "quota_exhausted",
          diagnosticOrigin: "adapter",
          diagnosticEvidenceAvailable: true,
          diagnosticRef: "diagnostic:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          diagnosticEvidence: {
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            stderrDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            diagnosticKind: "usage_exhausted",
          },
          failurePhase: "provider_execution",
        }),
        captureDiffAsync: async () => "diff --git a/a b/a\\n+change",
      },
    },
  },
});
`;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				childScript,
				tasksPath,
				checkpointPath,
				TEST_DIR,
			],
			{
				encoding: "utf8",
				env: { ...process.env, CRASH_AT: "4" },
			},
		);
		strictEqual(child.status, 73, child.stderr);

		const interrupted = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(interrupted.quarantinedTargetIds, ["agy-gemini"]);
		strictEqual(interrupted.retryTransitionId, 4);
		strictEqual(interrupted.retryState.phase, "retry_started");
		strictEqual(interrupted.retryState.descriptorHarness, "agy");
		strictEqual(
			interrupted.retryState.invocationDescriptor.target_id,
			interrupted.retryState.resolvedTargetId,
		);

		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
				{ provider: "agy", model: "fixture-claude", target: "agy-claude" },
			],
			executionOutcomes: { agy: [{ success: true, output: "ok" }] },
		});
		const before = readFileSync(checkpointPath, "utf8");
		throws(
			() =>
				runQueue({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				}),
			/checkpoint owner displaced/,
		);
		strictEqual(fixture.executeCalls.length, 0);
		deepStrictEqual(fixture.routeCalls, []);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
	});
});

describe("runner no-provider outcome uses a safe route reason code (Task D.3)", () => {
	it("maps an untrusted route reason to a closed code in result and ledger", () => {
		// The result and ledger retain only the closed route reason code; raw
		// upstream diagnostics never cross either boundary.
		const dispatches = [];
		const result = executeTask(
			{ id: "1.1", title: "task", description: "simple cleanup" },
			{
				route: () => ({
					provider: null,
					reason:
						"no_eligible_upstream_unavailable: claude — sk-proj-opaquevalue at service.prod.company.com",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true }),
				adapters: {},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.result, "no_provider");
		strictEqual(result.success, false);
		strictEqual(result.reason, "no_eligible_upstream_unavailable");
		// Ledger record uses the same safe code.
		strictEqual(dispatches[0].result, "no_provider");
		strictEqual(dispatches[0].reason, "no_eligible_upstream_unavailable");
	});

	it("maps an untrusted route reason before orchestrator outcome projection", async () => {
		const dispatches = [];
		let launches = 0;
		const result = await executeTaskWithOrchestrator(
			{ id: "1.1", title: "task", description: "simple cleanup" },
			{
				route: () => ({
					provider: null,
					reason:
						"../../private/sk-proj-opaquevalue at service.prod.company.com",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true }),
				adapters: {},
				orchestrator: {
					launch: async () => {
						launches += 1;
						return "should-not-launch";
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.reason, "no_eligible");
		strictEqual(dispatches[0].reason, "no_eligible");
		strictEqual(launches, 0);
	});
});

describe("runner cli orchestrator wiring", () => {
	it("builds launch/status/result calls for CLI orchestrator", async () => {
		const calls = [];
		const outputs = [
			JSON.stringify({ job_id: "job-123" }),
			JSON.stringify({ state: "done", expected_by: "2999-01-01T00:00:00Z" }),
			JSON.stringify({ success: true, diff: "diff --git a/a b/a" }),
		];

		const orch = createCliOrchestrator({
			command: "switchyard-orch",
			baseArgs: ["--headless"],
			execFn: (command, args) => {
				calls.push([command, args]);
				return outputs.shift();
			},
		});

		const jobId = await orch.launch({ taskId: "1.1" });
		const status = await orch.status(jobId);
		const result = await orch.result(jobId);

		strictEqual(jobId, "job-123");
		strictEqual(status.state, "done");
		strictEqual(result.success, true);
		deepStrictEqual(calls[0], [
			"switchyard-orch",
			["--headless", "launch", "--json", JSON.stringify({ taskId: "1.1" })],
		]);
		deepStrictEqual(calls[1], [
			"switchyard-orch",
			["--headless", "status", "job-123"],
		]);
		deepStrictEqual(calls[2], [
			"switchyard-orch",
			["--headless", "result", "job-123"],
		]);
	});

	it("resolves orchestrator from dependencies first", () => {
		const marker = { status: async () => ({ state: "done" }) };
		const resolved = resolveOrchestrator({ orchestrator: marker });
		strictEqual(resolved, marker);
	});

	it("throws when no dependency or environment orchestrator is set", () => {
		const previousCmd = process.env.SWITCHYARD_ORCHESTRATOR_CMD;
		const previousArgs = process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;
		delete process.env.SWITCHYARD_ORCHESTRATOR_CMD;
		delete process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;

		let error = null;
		try {
			resolveOrchestrator({});
		} catch (err) {
			error = err;
		} finally {
			if (previousCmd === undefined) {
				delete process.env.SWITCHYARD_ORCHESTRATOR_CMD;
			} else {
				process.env.SWITCHYARD_ORCHESTRATOR_CMD = previousCmd;
			}
			if (previousArgs === undefined) {
				delete process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON;
			} else {
				process.env.SWITCHYARD_ORCHESTRATOR_ARGS_JSON = previousArgs;
			}
		}

		ok(error instanceof Error);
		ok(error.message.includes("SWITCHYARD_ORCHESTRATOR_CMD"));
	});
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

describe("orchestrator status/result error guards", () => {
	it("waitForJobCompletion returns status_error instead of throwing when status() fails", async () => {
		const result = await waitForJobCompletion({
			jobId: "job-1",
			orchestrator: {
				status: async () => {
					throw new Error("orchestrator CLI crashed");
				},
			},
			sleepFn: async () => {},
		});

		strictEqual(result.state, "status_error");
		strictEqual(result.timedOut, false);
	});

	it("runQueueWithOrchestrator fails only the affected task when result() throws, not the whole queue", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => {
						throw new Error("orchestrator result endpoint unreachable");
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["result_fetch_failed", "result_fetch_failed"],
		);
		strictEqual(
			dispatches[0].reason,
			"orchestrator result endpoint unreachable",
		);
	});
});

describe("container lifecycle wiring (Tasks 8+9)", () => {
	function baseDependencies() {
		return {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			// No-op by default so an auto-create test doesn't invoke the real
			// docker+git seedProject against TEST_DIR (not a git repo). The
			// callOrder test below overrides this with a recording spy.
			seedProject: () => {},
			// No-op by default for the same reason — the real commitWorkingTree
			// runs docker+git. The callOrder test overrides it with a spy.
			commitWorkingTree: () => {},
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
			},
		};
	}

	it("runQueue skips ensureAgentContainer/createWorkingContainer entirely when workingContainerName is supplied", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let ensureCalled = false;
		let createCalled = false;
		let wipeCalled = false;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {
					ensureCalled = true;
				},
				createWorkingContainer: () => {
					createCalled = true;
					return "should-not-be-used";
				},
				wipeWorkingContainer: () => {
					wipeCalled = true;
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(
			ensureCalled,
			false,
			"a caller-supplied workingContainerName must skip ensureAgentContainer",
		);
		strictEqual(createCalled, false);
		strictEqual(
			wipeCalled,
			false,
			"a caller-supplied workingContainerName is the caller's to wipe, not runQueue's",
		);
	});

	it("fires onContainerReady with the resolved workingContainerName on both the pre-supplied and freshly-created branches", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);

		// Branch 1: caller supplies workingContainerName — onContainerReady must
		// still fire, surfacing that same name.
		const suppliedCheckpointPath = `${tasksPath}.supplied.checkpoint.json`;
		const suppliedReady = [];
		const suppliedResult = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: suppliedCheckpointPath,
			dependencies: {
				...baseDependencies(),
				onContainerReady: (info) => suppliedReady.push(info),
			},
		});

		strictEqual(suppliedResult.processedTasks, 1);
		deepStrictEqual(suppliedReady, [
			{ workingContainerName: "fake-container" },
		]);

		// Branch 2: no workingContainerName supplied — runQueue creates its own,
		// and onContainerReady must fire with the name it generated.
		const createdCheckpointPath = `${tasksPath}.created.checkpoint.json`;
		const createdReady = [];
		const createdResult = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: createdCheckpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				onContainerReady: (info) => createdReady.push(info),
			},
		});

		strictEqual(createdResult.processedTasks, 1);
		deepStrictEqual(createdReady, [
			{ workingContainerName: "generated-working-container" },
		]);
	});

	it("runQueue creates and wipes its own working container when none is supplied, ensuring the agent container first", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const callOrder = [];
		let capturedProjectPath;
		let capturedContextContainerName;
		let seededContainerName;
		let seededProjectPath;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {
					callOrder.push("ensure");
				},
				createWorkingContainer: (projectPath) => {
					callOrder.push("create");
					capturedProjectPath = projectPath;
					return "generated-working-container";
				},
				provisionCredentials: (name) => {
					callOrder.push("provision");
					capturedContextContainerName = name;
					return 1;
				},
				seedProject: (name, projectPath) => {
					callOrder.push("seed");
					seededContainerName = name;
					seededProjectPath = projectPath;
				},
				commitWorkingTree: (name) => {
					callOrder.push("commit");
					capturedContextContainerName = name;
				},
				wipeWorkingContainer: (name) => {
					callOrder.push("wipe");
					capturedContextContainerName = name;
				},
				// Marks the checkpoint save position in the sequence (fired right
				// after saveCheckpoint), proving the durable write lands between
				// execute and commit — not after it (INV-6).
				onCheckpointSaved: () => callOrder.push("checkpoint"),
				adapters: {
					claude: {
						execute: (_prompt, workingContainerName) => {
							callOrder.push(`execute:${workingContainerName}`);
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(capturedProjectPath, TEST_DIR);
		strictEqual(capturedContextContainerName, "generated-working-container");
		// The container it created is the one it seeds, with the project path
		// (INV-2: the seed is what gives captureDiff a baseline to diff against).
		strictEqual(seededContainerName, "generated-working-container");
		strictEqual(seededProjectPath, TEST_DIR);
		// commit lands after the task's execute (advancing the container baseline
		// so a following task diffs only against its own work) and before wipe.
		// The checkpoint save lands between execute and commit so a commit
		// failure can never strand a completed task outside the durable record.
		deepStrictEqual(callOrder, [
			"ensure",
			"create",
			"provision",
			"seed",
			"execute:generated-working-container",
			"checkpoint",
			"commit",
			"wipe",
		]);
	});

	it("commits the working container after EACH task so multi-task diffs stay isolated (INV-2)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const order = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				...baseDependencies(),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => order.push("commit"),
				wipeWorkingContainer: () => {},
				onCheckpointSaved: () => order.push("checkpoint"),
				adapters: {
					claude: {
						execute: () => {
							order.push("execute");
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		// Exactly one commit per task, each immediately after that task's execute
		// — never batched at the end, which would leave every task diffing the
		// original seed and re-emitting earlier tasks' hunks. Each task's
		// checkpoint save (fired right after saveCheckpoint) also lands between
		// that task's execute and commit: the durable record is on disk before
		// the container baseline is advanced (INV-6).
		deepStrictEqual(order, [
			"execute",
			"checkpoint",
			"commit",
			"execute",
			"checkpoint",
			"commit",
		]);
	});

	it("runQueue still wipes the working container it created when a task throws mid-queue (INV-3)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		throws(() => {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					...baseDependencies(),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-working-container",
					provisionCredentials: () => {},
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
					route: () => {
						throw new Error("route exploded mid-queue");
					},
				},
			});
		}, /route exploded mid-queue/);

		strictEqual(
			wipeCalled,
			true,
			"the working container must still be wiped even when the task loop throws",
		);
	});

	it("runQueue wipes the working container it created when seedProject throws (INV-3)", () => {
		// seedProject runs inside the try/finally specifically so a seed failure
		// (e.g. the project has no committed HEAD to archive) still triggers the
		// INV-3 wipe rather than leaking the container. If seeding were placed in
		// the pre-try setup block next to provisionCredentials, this would leak.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		throws(() => {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					...baseDependencies(),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-working-container",
					provisionCredentials: () => {},
					seedProject: () => {
						throw new Error("seed exploded: project has no commits");
					},
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
				},
			});
		}, /seed exploded/);

		strictEqual(
			wipeCalled,
			true,
			"a container created by runQueue must still be wiped when seeding throws",
		);
	});

	it("runQueueWithOrchestrator also skips container wiring when workingContainerName is supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let ensureCalled = false;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				ensureAgentContainer: () => {
					ensureCalled = true;
				},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "diff --git a/a b/a" }),
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(ensureCalled, false);
	});

	it("runQueueWithOrchestrator creates and wipes its own working container when none is supplied, ensuring the agent container first", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const callOrder = [];
		let capturedProjectPath;
		let capturedContextContainerName;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				ensureAgentContainer: () => {
					callOrder.push("ensure");
				},
				createWorkingContainer: (projectPath) => {
					callOrder.push("create");
					capturedProjectPath = projectPath;
					return "generated-orchestrator-container";
				},
				provisionCredentials: (name) => {
					callOrder.push("provision");
					capturedContextContainerName = name;
					return 1;
				},
				seedProject: () => {
					callOrder.push("seed");
				},
				commitWorkingTree: () => {
					callOrder.push("commit");
				},
				wipeWorkingContainer: (name) => {
					callOrder.push("wipe");
					capturedContextContainerName = name;
				},
				// Marks the checkpoint save position in the sequence (fired right
				// after saveCheckpoint) — it must land between launch and commit.
				onCheckpointSaved: () => callOrder.push("checkpoint"),
				orchestrator: {
					launch: async (payload) => {
						callOrder.push(`launch:${payload.workingContainerName}`);
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "diff --git a/a b/a" }),
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(capturedProjectPath, TEST_DIR);
		strictEqual(
			capturedContextContainerName,
			"generated-orchestrator-container",
		);
		deepStrictEqual(callOrder, [
			"ensure",
			"create",
			"provision",
			"seed",
			"launch:generated-orchestrator-container",
			"checkpoint",
			"commit",
			"wipe",
		]);
	});

	it("runQueueWithOrchestrator still wipes the working container it created when a task throws mid-queue (INV-3)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let wipeCalled = false;

		await rejects(async () => {
			await runQueueWithOrchestrator({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					recordDispatch: () => {},
					integrationGate: () => ({ success: true, message: "ok" }),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-orchestrator-container",
					provisionCredentials: () => {},
					seedProject: () => {},
					wipeWorkingContainer: () => {
						wipeCalled = true;
					},
					route: () => {
						throw new Error("route exploded mid-orchestrator-queue");
					},
					orchestrator: {
						launch: async () => "job-1",
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: "" }),
					},
				},
			});
		}, /route exploded mid-orchestrator-queue/);

		strictEqual(
			wipeCalled,
			true,
			"the working container must still be wiped even when the orchestrator task loop throws",
		);
	});
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

	function macosBackend(
		events,
		{ failCreate = false, failDestroy = false } = {},
	) {
		return {
			platform: "macos",
			preflight: () => events.push("preflight"),
			readiness: () => {
				events.push("readiness");
				return { inventoryCount: 0 };
			},
			acquireSlot: () => {
				events.push("acquire");
				return { token: "test-slot" };
			},
			releaseSlot: () => events.push("release"),
			ensureAgentContainer: () => events.push("ensure"),
			create: () => {
				events.push("create");
				if (failCreate) throw new Error("create failed");
				return "test-vm";
			},
			provision: () => events.push("provision"),
			seed: () => events.push("seed"),
			commit: () => {},
			reset: () => {},
			destroy: () => {
				events.push("destroy");
				if (failDestroy) {
					throw new Error("SECRET_CANARY synthetic backend teardown failure");
				}
			},
		};
	}

	it("runs preflight and admission before create, then releases after teardown on all three entrypoints", async () => {
		for (const entrypoint of ["sync", "async", "orchestrator"]) {
			const events = [];
			const tasksPath = writeTerminalQueue();
			const options = {
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				checkpointPath: `${tasksPath}.${entrypoint}.checkpoint.json`,
				dependencies: {
					backendFactory: () => macosBackend(events),
					orchestrator: {
						launch: async () => "job",
						status: async () => ({ state: "done" }),
						result: async () => ({ success: true, diff: "" }),
					},
				},
			};
			if (entrypoint === "sync") runQueueImpl(options);
			if (entrypoint === "async") await runQueueAsyncImpl(options);
			if (entrypoint === "orchestrator")
				await runQueueWithOrchestratorImpl(options);
			strictEqual(events[0], "preflight");
			strictEqual(events[1], "readiness");
			ok(events.indexOf("readiness") < events.indexOf("acquire"));
			ok(events.indexOf("acquire") < events.indexOf("create"));
			ok(events.indexOf("destroy") < events.indexOf("release"));
		}
	});

	it("stops at a synthetic preflight rejection before slot, VM, container, provider, or adapter calls", async () => {
		for (const entrypoint of ["sync", "async", "orchestrator"]) {
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
					orchestrator: {
						launch: async () => {
							events.push("provider");
							return "job";
						},
					},
				},
			};
			if (entrypoint === "sync") throws(() => runQueueImpl(options));
			if (entrypoint === "async")
				await rejects(() => runQueueAsyncImpl(options));
			if (entrypoint === "orchestrator")
				await rejects(() => runQueueWithOrchestratorImpl(options));
			deepStrictEqual(events, ["preflight"]);
		}
	});

	it("fails host readiness before a slot, workspace, or provider launch in every entrypoint", async () => {
		for (const [code, message] of [
			["vm_host_inventory_permission_denied", "inventory permission denied"],
			["vm_host_inventory_unavailable", "inventory unavailable"],
			["vm_host_service_degraded", "service degraded"],
		]) {
			for (const entrypoint of ["sync", "async", "orchestrator"]) {
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
						orchestrator: {
							launch: async () => "job",
							status: async () => ({ state: "done" }),
							result: async () => ({ success: true, diff: "" }),
						},
					},
				};
				const invoke =
					entrypoint === "sync"
						? () => runQueueImpl(options)
						: entrypoint === "async"
							? () => runQueueAsyncImpl(options)
							: () => runQueueWithOrchestratorImpl(options);
				await rejects(
					Promise.resolve().then(invoke),
					(error) => error === failure,
				);
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

		const queue = runQueueAsyncImpl({
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

		await runQueueAsyncImpl({
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
			runQueueAsyncImpl({
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
				runQueueAsyncImpl({
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

	it("does not retry unrelated VM-admission failures", async () => {
		const events = [];
		const statuses = [];
		const tasksPath = writeTerminalQueue();
		const backend = macosBackend(events);
		const storageFailure = new Error("admission storage failed");
		let attempts = 0;
		backend.acquireSlot = () => {
			events.push("acquire");
			attempts += 1;
			throw storageFailure;
		};

		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				checkpointPath: `${tasksPath}.wait-unrelated.checkpoint.json`,
				dependencies: {
					backendFactory: () => backend,
					onStatus: (event) => statuses.push(event),
					vmSlotWaitTimeoutMs: 100,
					vmSlotWaitIntervalMs: 10,
					sleepFn: async () => {},
				},
			}),
			(error) => error === storageFailure,
		);
		strictEqual(attempts, 1);
		strictEqual(
			statuses.some((event) => event.event === "vm_slot_wait"),
			false,
		);
		strictEqual(events.includes("create"), false);
	});

	it("awaits cleanup-state persistence before destroying an owned workspace", async () => {
		const events = [];
		let releaseCleanup;
		let signalCleanupEntered;
		const cleanupGate = new Promise((resolve) => {
			releaseCleanup = resolve;
		});
		const cleanupEntered = new Promise((resolve) => {
			signalCleanupEntered = resolve;
		});
		const tasksPath = writeTerminalQueue();
		const queuePromise = runQueueAsyncImpl({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			platform: "macos",
			checkpointPath: `${tasksPath}.cleanup-order.checkpoint.json`,
			dependencies: {
				backendFactory: () => macosBackend(events),
				onCleanupStarted: async () => {
					events.push("cleanup-started");
					signalCleanupEntered();
					await cleanupGate;
					events.push("cleanup-resolved");
				},
			},
		});
		await cleanupEntered;
		strictEqual(events.at(-1), "cleanup-started");
		strictEqual(events.includes("destroy"), false);
		releaseCleanup();
		await queuePromise;
		ok(events.indexOf("cleanup-resolved") < events.indexOf("destroy"));
	});

	it("destroys the workspace and releases the slot when cleanup-state persistence rejects", async () => {
		const events = [];
		const tasksPath = writeTerminalQueue();
		await runQueueAsyncImpl({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			platform: "macos",
			checkpointPath: `${tasksPath}.cleanup-rejection.checkpoint.json`,
			dependencies: {
				backendFactory: () => macosBackend(events),
				onCleanupStarted: async () => {
					throw new Error("synthetic cleanup persistence failure");
				},
			},
		});
		ok(events.indexOf("destroy") >= 0);
		ok(events.indexOf("release") > events.indexOf("destroy"));
	});

	it("rejects with closed recovery evidence when async backend teardown fails", async () => {
		const events = [];
		const statuses = [];
		const tasksPath = writeTerminalQueue();
		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				checkpointPath: `${tasksPath}.cleanup-failure.checkpoint.json`,
				dependencies: {
					backendFactory: () => macosBackend(events, { failDestroy: true }),
					onStatus: (event) => statuses.push(event),
				},
			}),
			(error) => {
				strictEqual(error.name, "QueueCleanupError");
				strictEqual(error.code, "recovery_incomplete");
				deepStrictEqual(error.failure, {
					errorKind: "unknown_failure",
					reasonCode: "unknown_failure",
					reason: "The task failed for an unclassified reason.",
					diagnosticCode: "recovery_incomplete",
					failurePhase: "terminal_reconciliation",
				});
				strictEqual(error.terminalSummary.failedCount, 0);
				strictEqual(JSON.stringify(error).includes("SECRET_CANARY"), false);
				return true;
			},
		);
		ok(events.indexOf("release") > events.indexOf("destroy"));
		const cleanupFailed = statuses.find(
			(event) => event.event === "cleanup_failed",
		);
		ok(cleanupFailed, "cleanup_failed progress is preserved");
		strictEqual(cleanupFailed.status, "Cleanup failed; recovery required");
		strictEqual(JSON.stringify(cleanupFailed).includes("SECRET_CANARY"), false);
	});

	it("carries a displaced closed failure code onto the cleanup error", () => {
		const displaced = new CheckpointIdentityError(
			CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH,
		);
		const error = new QueueCleanupError(null, displaced);
		// Cleanup still wins: the code and the recovery reason are unchanged, so
		// the caller disposition still reads recovery-required. Only the reported
		// cause sharpens, from "something failed" to the contract that broke.
		strictEqual(error.code, "recovery_incomplete");
		deepStrictEqual(error.failure, {
			errorKind: "unknown_failure",
			reasonCode: "unknown_failure",
			reason: "The task failed for an unclassified reason.",
			diagnosticCode: "checkpoint_queue_identity_mismatch",
			failurePhase: "terminal_reconciliation",
		});
		strictEqual(JSON.stringify(error).includes(displaced.message), false);
	});

	it("refuses a displaced code that is outside the persisted vocabulary", () => {
		const displaced = new Error("SECRET_CANARY unclassified host failure");
		displaced.diagnosticCode = "SECRET_CANARY_not_a_closed_code";
		const error = new QueueCleanupError(null, displaced);
		// The in-flight error is not a channel: only a code this project mints
		// itself crosses, so an unrecognized one leaves the fixed code standing.
		strictEqual(error.failure.diagnosticCode, "recovery_incomplete");
		strictEqual(JSON.stringify(error).includes("SECRET_CANARY"), false);
	});

	it("still fails closed on teardown when a queue failure is already in flight", async () => {
		const events = [];
		const tasksPath = writeTerminalQueue();
		await rejects(
			runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				platform: "macos",
				taskIds: ["9.9"],
				checkpointPath: `${tasksPath}.displaced-failure.checkpoint.json`,
				dependencies: {
					backendFactory: () => macosBackend(events, { failDestroy: true }),
				},
			}),
			(error) => {
				// Capturing the in-flight failure must not let it win the throw: a
				// caller that saw the selection error alone would finalize without
				// knowing a workspace is still on the host.
				strictEqual(error.name, "QueueCleanupError");
				strictEqual(error.code, "recovery_incomplete");
				// TaskSelectionError carries no closed diagnostic, so the fixed one holds.
				strictEqual(error.failure.diagnosticCode, "recovery_incomplete");
				return true;
			},
		);
		ok(events.indexOf("destroy") >= 0);
		ok(events.indexOf("release") > events.indexOf("destroy"));
	});

	it("releases a slot when workspace creation fails", () => {
		const events = [];
		const tasksPath = writeTerminalQueue();
		throws(
			() =>
				runQueueImpl({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					platform: "macos",
					dependencies: {
						backendFactory: () => macosBackend(events, { failCreate: true }),
					},
				}),
			/create failed/,
		);
		deepStrictEqual(events, [
			"preflight",
			"readiness",
			"acquire",
			"ensure",
			"create",
			"release",
		]);
	});

	it("rejects an invalid platform before backend selection or admission", () => {
		const events = [];
		const tasksPath = writeTerminalQueue();
		throws(
			() =>
				runQueueImpl({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					platform: "windows",
					dependencies: {
						backendFactory: () => {
							events.push("factory");
							return macosBackend(events);
						},
					},
				}),
			/runOptions\.platform must be one of macos/,
		);
		deepStrictEqual(events, []);
	});

	it("rejects the default macOS preflight before slot acquisition or VM creation", () => {
		const events = [];
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Native queue gate
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** test gate
- **Description:** fixture
`);
		throws(
			() =>
				runQueueImpl({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					platform: "macos",
					dependencies: {
						backendFactory: () => ({
							create: () => {
								events.push("create");
								return "vm";
							},
							seed: () => {},
							commit: () => {},
							reset: () => {},
							destroy: () => {},
							acquireSlot: () => events.push("acquire"),
						}),
						// "claude" has quota and meets the "high" capability bar, but
						// the default GOLDEN_IMAGE_VERIFIED_PROVIDERS allowlist is
						// codex-only, so the default preflight must still fail closed
						// on it (mirrors tests/router.test.mjs's equivalent case).
						adapters: { claude: {} },
						preflightReadSnapshot: () => ({
							snapshot: {
								schema_version: 2,
								updated_at: new Date().toISOString(),
								providers: [
									{
										name: "claude",
										ok: true,
										windows: [{ percent_left: 80, pace_delta: 1 }],
									},
								],
							},
							snapshotStatus: "fresh",
							snapshotMtime: 1,
							snapshotAgeMsAtRoute: 0,
						}),
					},
				}),
			/high: no_golden_image_verified_provider_with_quota_headroom.*claude/,
		);
		deepStrictEqual(events, []);
	});

	it("formats a closed provider reason in the preflight failure", () => {
		const events = [];
		const rosterPath = join(
			tmpdir(),
			`switchyard-runner-closed-reason-${process.pid}-${randomUUID()}.json`,
		);
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Native queue gate
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** test gate
- **Description:** fixture
`);
		try {
			writeFileSync(
				rosterPath,
				readFileSync(ROSTER_FIXTURE_PATH, "utf8"),
				"utf8",
			);
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			throws(
				() =>
					runQueueImpl({
						tasksFilePath: tasksPath,
						projectPath: TEST_DIR,
						platform: "macos",
						dependencies: {
							backendFactory: () => ({
								create: () => {
									events.push("create");
									return "vm";
								},
								seed: () => {},
								commit: () => {},
								reset: () => {},
								destroy: () => {},
								acquireSlot: () => events.push("acquire"),
							}),
							adapters: { claude: {} },
							goldenImageVerifiedProviders: ["claude"],
							preflightReadSnapshot: () => ({
								snapshot: {
									schema_version: 2,
									updated_at: new Date().toISOString(),
									providers: [
										{
											name: "claude",
											ok: true,
											windows: [{ percent_left: 80, pace_delta: 1 }],
										},
									],
								},
								snapshotStatus: "fresh",
								snapshotMtime: 1,
								snapshotAgeMsAtRoute: 0,
							}),
						},
					}),
				(error) => {
					strictEqual(error.name, "QueuePreflightError");
					strictEqual(
						error.message,
						"macOS queue provider preflight failed: high: no_golden_image_verified_provider_with_quota_headroom (excluded: claude; reasons: claude: no_invocation_descriptor)",
					);
					return true;
				},
			);
		} finally {
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
		deepStrictEqual(events, []);
	});

	it("keeps provider exclusion and reason lists in sorted order", () => {
		const events = [];
		const rosterPath = join(
			tmpdir(),
			`switchyard-runner-provider-order-${process.pid}-${randomUUID()}.json`,
		);
		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Native queue gate
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** test gate
- **Description:** fixture
`);
		try {
			writeFileSync(
				rosterPath,
				readFileSync(ROSTER_FIXTURE_PATH, "utf8"),
				"utf8",
			);
			process.env.SWITCHYARD_ROSTER_PATH = rosterPath;
			__resetRosterCacheForTests();
			throws(
				() =>
					runQueueImpl({
						tasksFilePath: tasksPath,
						projectPath: TEST_DIR,
						platform: "macos",
						dependencies: {
							backendFactory: () => ({
								create: () => {
									events.push("create");
									return "vm";
								},
								seed: () => {},
								commit: () => {},
								reset: () => {},
								destroy: () => {},
								acquireSlot: () => events.push("acquire"),
							}),
							adapters: { claude: {}, codex: {} },
							goldenImageVerifiedProviders: ["claude", "codex"],
							preflightReadSnapshot: () => ({
								snapshot: {
									schema_version: 2,
									updated_at: new Date().toISOString(),
									// Deliberately reverse alphabetical order. Both lists must
									// use the stable sorted presentation order.
									providers: [
										{
											name: "codex",
											ok: true,
											windows: [{ percent_left: 80, pace_delta: 1 }],
										},
										{
											name: "claude",
											ok: true,
											windows: [{ percent_left: 80, pace_delta: 1 }],
										},
									],
								},
								snapshotStatus: "fresh",
								snapshotMtime: 1,
								snapshotAgeMsAtRoute: 0,
							}),
						},
					}),
				(error) => {
					strictEqual(error.name, "QueuePreflightError");
					strictEqual(
						error.message,
						"macOS queue provider preflight failed: high: no_golden_image_verified_provider_with_quota_headroom (excluded: claude, codex; reasons: claude: no_invocation_descriptor, codex: no_invocation_descriptor)",
					);
					return true;
				},
			);
		} finally {
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
			rmSync(rosterPath, { force: true });
		}
		deepStrictEqual(events, []);
	});
});

describe("runner commit/reset behavior (Task 3.2)", () => {
	it("commits only after successful tasks, not after failed ones", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task

### Task 1.3: Third
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** third task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];
		let gateCalls = 0;
		let routeCalls = 0;
		let executeCalls = 0;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => {
					routeCalls += 1;
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 72,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				integrationGate: () => {
					gateCalls += 1;
					if (gateCalls === 2) {
						return { success: false, message: "rejected" };
					}
					return { success: true, message: "ok" };
				},
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							executeCalls += 1;
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 3);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["success", "integration_failed", "success"],
		);
		strictEqual(commits.length, 2, "commit called after tasks 1 and 3 only");
		strictEqual(resets.length, 1, "reset called after failed task 2");
		strictEqual(
			routeCalls,
			3,
			"integration rejection must not re-route the task",
		);
		strictEqual(
			executeCalls,
			3,
			"integration rejection must not re-execute the task",
		);
	});

	it("resets rejected state before continuing when stopOnFailure is false", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(commits.length, 0, "commit never called for failed tasks");
		strictEqual(resets.length, 2, "reset called after each failed task");
	});

	it("does not reset when stopOnFailure is true", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: true,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1, "stopped after first failure");
		strictEqual(commits.length, 0);
		strictEqual(
			resets.length,
			0,
			"reset not called when stopOnFailure is true",
		);
	});

	it("does not reset when working container is caller-supplied", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(commits.length, 0);
		strictEqual(
			resets.length,
			0,
			"reset not called when container is caller-supplied",
		);
	});

	it("orchestrator path: commits only after success, resets on failure with continuation", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task

### Task 1.3: Third
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** third task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const commits = [];
		const resets = [];
		let launchIndex = 0;
		let gateCalls = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => {
					gateCalls += 1;
					if (gateCalls === 2) {
						return { success: false, message: "rejected" };
					}
					return { success: true, message: "ok" };
				},
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => commits.push(true),
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 3);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["success", "integration_failed", "success"],
		);
		strictEqual(
			commits.length,
			2,
			"orchestrator: commit called after tasks 1 and 3 only",
		);
		strictEqual(
			resets.length,
			1,
			"orchestrator: reset called after failed task 2",
		);
		strictEqual(
			launchIndex,
			3,
			"integration rejection must not relaunch a task",
		);
	});

	it("orchestrator path: does not reset when stopOnFailure is true", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resets = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: true,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 1, "stopped after first failure");
		strictEqual(
			resets.length,
			0,
			"orchestrator: reset not called when stopOnFailure is true",
		);
	});

	it("orchestrator path: does not reset when working container is caller-supplied", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resets = [];

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				commitWorkingTree: () => {},
				resetWorkingTree: () => resets.push(true),
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(
			resets.length,
			0,
			"orchestrator: reset not called when container is caller-supplied",
		);
	});
	it("orchestrator path: resets when result returns success=false (execution_failed) with continuation", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resets = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => resets.push(true),
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: false,
						error: "execution_failed",
					}),
				},
			},
		});

		strictEqual(result.processedTasks, 2);
		deepStrictEqual(
			result.results.map((r) => r.result),
			["execution_failed", "execution_failed"],
		);
		strictEqual(
			resets.length,
			2,
			"orchestrator: reset called after each execution_failed",
		);
	});

	it("sync path: a completed task is already in the durable checkpoint when commitWorkingTree throws (INV-6)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let checkpointAtCommit = null;

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					// Snapshot the checkpoint the instant commit is attempted.
					checkpointAtCommit = JSON.parse(readFileSync(checkpointPath, "utf8"));
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(checkpointAtCommit, "commitWorkingTree was attempted");
		// The checkpoint save runs ahead of the commit block, so a commit failure
		// can never strand a completed task outside the durable record.
		deepStrictEqual(checkpointAtCommit.completedTaskIds, ["1.1"]);
		strictEqual(checkpointAtCommit.results[0].taskId, "1.1");
		strictEqual(checkpointAtCommit.results[0].result, "success");
		strictEqual(checkpointAtCommit.results[0].success, true);
	});

	it("orchestrator path: a completed task is already in the durable checkpoint when commitWorkingTree throws (INV-6)", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let checkpointAtCommit = null;

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					checkpointAtCommit = JSON.parse(readFileSync(checkpointPath, "utf8"));
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		ok(checkpointAtCommit, "commitWorkingTree was attempted");
		deepStrictEqual(checkpointAtCommit.completedTaskIds, ["1.1"]);
		strictEqual(checkpointAtCommit.results[0].taskId, "1.1");
		strictEqual(checkpointAtCommit.results[0].result, "success");
		strictEqual(checkpointAtCommit.results[0].success, true);
	});

	it("sync path: a commitWorkingTree failure halts the queue before the next task, keeping the completed task's durable checkpoint (Task 1.2)", () => {
		// INV-3: a success whose container baseline was not advanced is not
		// reusable — the next task would diff against (and re-emit) task 1's
		// uncommitted work. The run must stop before task 2's execute, even
		// with stopOnFailure:false (only the commit failure can stop it here).
		// Task 1's checkpoint stays on disk (INV-6); the halt is recorded as a
		// distinct outcome, not by failing task 1.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		const executes = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw new Error("commit exploded");
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							executes.push(true);
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(
			executes.length,
			1,
			"task 2's execute must never run against an unadvanced container",
		);
		strictEqual(result.processedTasks, 1);
		// The completed task's durable checkpoint stays on disk (INV-6)...
		deepStrictEqual(result.completedTaskIds, ["1.1"]);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1"]);
		strictEqual(checkpoint.results[0].taskId, "1.1");
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].success, true);
		// ...and the halt is a distinct, recorded outcome — not a failure
		// assigned to the successfully completed task.
		strictEqual(result.results.length, 2);
		strictEqual(result.results[0].result, "success");
		strictEqual(result.results[1].result, "halted_after_commit_failure");
		strictEqual(result.results[1].success, false);
		strictEqual(result.results[1].action, "commit");
		ok(
			result.results[1].reason.includes("commit exploded"),
			"halt outcome carries the underlying commit failure detail",
		);
		strictEqual(checkpoint.results[1].result, "halted_after_commit_failure");
		// The durable halt entry carries the action-specific static fields
		// and never embeds the raw commit error message.
		strictEqual(checkpoint.results[1].action, "commit");
		strictEqual(checkpoint.results[1].success, false);
		strictEqual(checkpoint.results[1].timedOut, false);
		strictEqual(checkpoint.results[1].partialDiffPath, null);
		ok(
			!readFileSync(checkpointPath, "utf8").includes("commit exploded"),
			"checkpoint.json must not embed the commit failure's raw message",
		);
		// The failure stays observable on the status channel.
		const commitFailure = events.find(
			(e) =>
				e.event === "checkpoint_failed" &&
				e.status.startsWith("Checkpoint commit failed"),
		);
		ok(commitFailure, "checkpoint_failed event emitted for the commit failure");
		strictEqual(commitFailure.taskId, "1.1");
		ok(
			events.find((e) => e.event === "queue_halted"),
			"queue_halted event emitted when the run stops",
		);
		// The terminal status must not claim "Queue complete" for a halted run.
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(
			terminal.status,
			"Queue halted: 1 tasks processed",
			"a halted run reports a halted terminal status, not Queue complete",
		);
	});

	it("orchestrator path: a commitWorkingTree failure halts the queue before the next launch (Task 1.2)", async () => {
		// Same INV-3 halt through the headless orchestrator path: task 2 must
		// never be launched once task 1's container baseline commit failed.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw new Error("orchestrator commit exploded");
				},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async (payload) => {
						launches.push(payload);
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(
			launches.length,
			1,
			"task 2 must never be launched against an unadvanced container",
		);
		deepStrictEqual(launches[0].taskId, "1.1");
		strictEqual(result.processedTasks, 1);
		deepStrictEqual(result.completedTaskIds, ["1.1"]);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, ["1.1"]);
		strictEqual(checkpoint.results[0].result, "success");
		strictEqual(checkpoint.results[0].success, true);
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_commit_failure");
		strictEqual(result.results[1].success, false);
		strictEqual(result.results[1].action, "commit");
		strictEqual(checkpoint.results[1].result, "halted_after_commit_failure");
		// The durable orchestrator halt entry carries the action-specific
		// static fields and never embeds the raw commit error message.
		strictEqual(checkpoint.results[1].action, "commit");
		strictEqual(checkpoint.results[1].success, false);
		strictEqual(checkpoint.results[1].timedOut, false);
		strictEqual(checkpoint.results[1].partialDiffPath, null);
		ok(
			!readFileSync(checkpointPath, "utf8").includes(
				"orchestrator commit exploded",
			),
			"checkpoint.json must not embed the commit failure's raw message",
		);
	});

	it("sync path: a resetWorkingTree failure after a failed task halts the queue before the next task, keeping the failed task's durable checkpoint (Task 1.2)", () => {
		// INV-3 continuation reset: with stopOnFailure:false a failed task's
		// un-reset changes would bleed into the next task, so a reset failure
		// must stop the run before task 2's execute. The failed task's
		// checkpoint entry stays durable (INV-6, success:false and NOT in
		// completedTaskIds); the halt is a distinct halted_after_reset_failure
		// outcome — not a failure retroactively assigned to the failed task.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const executes = [];
		const events = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {
					throw new Error("reset exploded");
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							executes.push(true);
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(
			executes.length,
			1,
			"task 2's execute must never run after a reset failure",
		);
		strictEqual(result.processedTasks, 1);
		// The failed task's bookkeeping stays durable and un-completed.
		deepStrictEqual(result.completedTaskIds, []);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		strictEqual(checkpoint.results[0].taskId, "1.1");
		strictEqual(checkpoint.results[0].result, "integration_failed");
		strictEqual(checkpoint.results[0].success, false);
		// The outcome identifies a reset halt, action-specifically and durably.
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_reset_failure");
		strictEqual(result.results[1].action, "reset");
		strictEqual(result.results[1].success, false);
		ok(
			result.results[1].reason.includes("reset exploded"),
			"halt outcome carries the underlying reset failure detail",
		);
		strictEqual(checkpoint.results[1].result, "halted_after_reset_failure");
		strictEqual(checkpoint.results[1].action, "reset");
		// Raw command stderr must never reach the durable checkpoint.
		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("reset exploded"),
			"checkpoint.json must not embed the reset failure's raw message",
		);
		// The failure stays observable on the status channel and the terminal
		// status is truthful about the halt.
		const resetFailure = events.find(
			(e) =>
				e.event === "checkpoint_failed" &&
				e.status.startsWith("Checkpoint reset failed"),
		);
		ok(resetFailure, "checkpoint_failed event emitted for the reset failure");
		strictEqual(resetFailure.taskId, "1.1");
		ok(
			events.find((e) => e.event === "queue_halted"),
			"queue_halted event emitted when the run stops",
		);
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(terminal.status, "Queue halted: 1 tasks processed");
	});

	it("orchestrator path: a resetWorkingTree failure after a failed task halts the queue before the next launch (Task 1.2)", async () => {
		// Same INV-3 halt through the headless orchestrator path: task 2 must
		// never be launched once task 1's continuation reset failed.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const launches = [];
		const events = [];
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {
					throw new Error("orchestrator reset exploded");
				},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				orchestrator: {
					launch: async (payload) => {
						launches.push(payload);
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
			},
		});

		strictEqual(
			launches.length,
			1,
			"task 2 must never be launched after a reset failure",
		);
		deepStrictEqual(launches[0].taskId, "1.1");
		strictEqual(result.processedTasks, 1);
		deepStrictEqual(result.completedTaskIds, []);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		strictEqual(checkpoint.results[0].result, "integration_failed");
		strictEqual(checkpoint.results[0].success, false);
		strictEqual(result.results.length, 2);
		strictEqual(result.results[1].result, "halted_after_reset_failure");
		strictEqual(result.results[1].action, "reset");
		strictEqual(result.results[1].success, false);
		strictEqual(checkpoint.results[1].result, "halted_after_reset_failure");
		strictEqual(checkpoint.results[1].action, "reset");
		const terminal = events.find((e) => e.event === "terminal");
		ok(terminal, "terminal event emitted");
		strictEqual(terminal.status, "Queue halted: 1 tasks processed");
	});

	it("failed and timed-out tasks still land in the checkpoint with success:false under the reordered flow", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Fails
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Times out
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText = "diff --git a/wip.mjs b/wip.mjs\n+work in progress";
		let callCount = 0;

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => {
							callCount += 1;
							if (callCount === 1) {
								return { success: false, error: "provider crashed" };
							}
							return {
								success: false,
								error: "spawnSync docker ETIMEDOUT",
								timedOut: true,
							};
						},
						captureDiff: () => diffText,
					},
				},
			},
		});

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results.length, 2);
		deepStrictEqual(
			checkpoint.results.map((r) => r.success),
			[false, false],
		);
		deepStrictEqual(
			checkpoint.results.map((r) => r.result),
			["execution_failed", "execution_timed_out"],
		);
		strictEqual(checkpoint.results[1].timedOut, true);
		deepStrictEqual(checkpoint.completedTaskIds, []);
	});

	it("orchestrator path: failed and timed-out tasks land in the checkpoint with success:false under the reordered flow", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Fails
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Times out
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let launchIndex = 0;

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-orch-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				sleepFn: async () => {},
				// Deterministic orchestrator timeout: the first status poll
				// reports a running job whose expected_by is already in the
				// past relative to the injected clock, so waitForJobCompletion
				// returns timed_out without sleeping.
				now: () => 2_000_000_000_000,
				orchestrator: {
					launch: async () => {
						launchIndex += 1;
						return `job-${launchIndex}`;
					},
					status: async (jobId) =>
						jobId === "job-1"
							? { state: "done" }
							: {
									state: "running",
									expected_by: "2020-01-01T00:00:00Z",
								},
					result: async () => ({
						success: false,
						error: "provider crashed",
					}),
				},
			},
		});

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results.length, 2);
		deepStrictEqual(
			checkpoint.results.map((r) => r.success),
			[false, false],
		);
		deepStrictEqual(
			checkpoint.results.map((r) => r.result),
			["execution_failed", "orchestrator_timed_out"],
		);
		deepStrictEqual(checkpoint.completedTaskIds, []);
		// The orchestrator timeout verdict must reach the durable record, not
		// just the result string: the checkpoint's timedOut flag is truthful
		// for the orchestrator_timed_out outcome (and the in-memory result it
		// was derived from).
		strictEqual(result.results[1].timedOut, true);
		strictEqual(result.results[1].result, "orchestrator_timed_out");
		strictEqual(checkpoint.results[1].timedOut, true);
	});

	it("persists the halt outcome to the checkpoint before queue_halted and terminal events (INV-6)", () => {
		// The halt entry must be on disk the moment the queue_halted observer
		// event fires — not merely after the run's final save — so any
		// observer reading the checkpoint at that point (e.g. an operator
		// reacting to the status channel) already sees the durable halt
		// outcome. Asserted behaviorally: read the checkpoint inside the
		// queue_halted handler.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		let haltOnDiskWhenEventFired = null;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => {
					events.push(e.event);
					if (e.event === "queue_halted") {
						haltOnDiskWhenEventFired = loadCheckpoint(
							checkpointPath,
							tasksPath,
						);
					}
				},
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw new Error("commit exploded");
				},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(haltOnDiskWhenEventFired, "queue_halted event fired");
		strictEqual(
			haltOnDiskWhenEventFired.results.length,
			2,
			"the halt entry must already be on disk when queue_halted fires",
		);
		strictEqual(
			haltOnDiskWhenEventFired.results[1].result,
			"halted_after_commit_failure",
		);
		strictEqual(haltOnDiskWhenEventFired.results[1].action, "commit");
		// The task's own durable entry precedes the halt, and the halt
		// precedes the terminal event.
		const saved = events.indexOf("checkpoint_saved");
		const halted = events.indexOf("queue_halted");
		const terminal = events.indexOf("terminal");
		ok(saved !== -1 && saved < halted, "task entry saved before queue_halted");
		ok(
			halted !== -1 && halted < terminal,
			"queue_halted fires before the terminal event",
		);
		strictEqual(result.results[1].result, "halted_after_commit_failure");
	});

	it("formats a non-Error commit seam failure safely and halts without crashing (regression)", () => {
		// Injected dependency seams may throw any value, not just an Error. A
		// thrown plain object must not crash the halt formatting (no unguarded
		// `error.message` dereference) and must not leak its arbitrary
		// contents into the halt text or the durable checkpoint.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {
					throw { marker: "RAW_CANARY_commit_object" };
				},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[1].result, "halted_after_commit_failure");
		strictEqual(result.results[1].action, "commit");
		// A non-Error throw maps to the bounded static label, never to the
		// thrown object's own contents.
		ok(
			result.results[1].reason.includes("unknown error"),
			"halt reason uses the bounded static label for a non-Error throw",
		);
		ok(
			!result.results[1].reason.includes("RAW_CANARY_commit_object"),
			"a non-Error throw's arbitrary value must never reach the halt reason",
		);
		strictEqual(
			result.results[1].error,
			null,
			"a non-Error throw's arbitrary value must never reach the halt error field",
		);
		ok(
			!readFileSync(checkpointPath, "utf8").includes(
				"RAW_CANARY_commit_object",
			),
			"checkpoint.json must never embed a non-Error throw's value",
		);
		ok(
			events.find((e) => e.event === "queue_halted"),
			"queue_halted still emitted after a non-Error commit failure",
		);
		ok(
			events.find((e) => e.event === "terminal"),
			"terminal event still emitted after a non-Error commit failure",
		);
	});

	it("formats a null reset seam failure safely (no unguarded message dereference)", () => {
		// A seam that throws literally `null` is the sharpest non-Error case:
		// any unguarded `error.message` in the reset halt path would throw a
		// TypeError instead of producing the halt outcome.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: false, message: "rejected" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {
					throw null;
				},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[1].result, "halted_after_reset_failure");
		strictEqual(result.results[1].action, "reset");
		ok(
			result.results[1].reason.includes("unknown error"),
			"a null throw maps to the bounded static label",
		);
		strictEqual(result.results[1].error, null);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[1].result, "halted_after_reset_failure");
		strictEqual(checkpoint.results[1].action, "reset");
	});
});

describe("runner progress hooks (INV-1: no silent waits)", () => {
	it("fires onTaskStart before and onResult after each task, in order", () => {
		// A serial dispatch blocks with no feedback during each multi-minute
		// provider exec. These hooks are the CLI's feedback path — assert they
		// fire interleaved (start then result, per task) so the surface can
		// print a line as each task begins and finishes.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				onTaskStart: (task) => events.push(`start:${task.id}`),
				onResult: (result) =>
					events.push(`result:${result.taskId}:${result.success}`),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		deepStrictEqual(events, [
			"start:1.1",
			"result:1.1:true",
			"start:1.2",
			"result:1.2:true",
		]);
	});

	it("fires onTaskRouted with provider/model/deadline before the blocking adapter.execute call", () => {
		// Regression: task_started fires before routing decides a provider, so
		// an operator watching progress couldn't learn which provider/model was
		// picked until the (up to 30-minute) adapter call finished. onTaskRouted
		// must fire between routing and the execute call.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
- **Timeout:** 60s
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];
		const routedBefore = Date.now();

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				onTaskRouted: (info) => events.push({ type: "routed", ...info }),
				adapters: {
					claude: {
						execute: () => {
							events.push({ type: "execute" });
							return { success: true, output: "ok" };
						},
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const routedAfter = Date.now();
		strictEqual(events.length, 2);
		strictEqual(events[0].type, "routed");
		strictEqual(events[0].taskId, "1.1");
		strictEqual(events[0].provider, "claude");
		strictEqual(events[0].model, "claude-sonnet-5");
		// The deadline must encode the task's declared Timeout (60s), not
		// merely "some future time" — a deadline hardcoded to now, or to the
		// wrong unit, fails this range check. runQueue is synchronous, so the
		// routing happens between the two timestamps captured around it and
		// deadline = routing time + 60s must land in [before, after] + 60s.
		const deadlineMs = new Date(events[0].deadline).getTime();
		ok(
			deadlineMs >= routedBefore + 60_000 && deadlineMs <= routedAfter + 60_000,
			`deadline must encode the 60s task Timeout, got ${events[0].deadline}`,
		);
		strictEqual(events[1].type, "execute", "routed must fire before execute");
	});

	it("emits a task_routed onStatus event with provider/model/deadline", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const routed = events.find((e) => e.event === "task_routed");
		ok(routed, "task_routed event fired");
		strictEqual(routed.phase, "execution");
		strictEqual(routed.provider, "claude");
		strictEqual(routed.model, "claude-sonnet-5");
		ok(routed.deadline, "deadline present");

		const routedIndex = events.findIndex((e) => e.event === "task_routed");
		const completedIndex = events.findIndex(
			(e) => e.event === "task_completed",
		);
		ok(
			routedIndex < completedIndex,
			"task_routed must fire before task_completed",
		);
	});

	it("runner emits task_started, diff_captured, gate_validated, gate_applied, task_completed, checkpoint_saved, and cleanup events via onStatus", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) =>
					events.push({
						phase: e.phase,
						event: e.event,
						outcome: e.outcome,
						byteCount: e.byteCount,
						taskId: e.taskId,
					}),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const byEvent = {};
		for (const e of events) {
			byEvent[e.event] = e;
		}

		ok(byEvent.container_created, "container_created fired");
		strictEqual(byEvent.container_created.phase, "bootstrap");
		ok(byEvent.task_started, "task_started fired");
		strictEqual(byEvent.task_started.taskId, "1.1");
		ok(byEvent.diff_captured, "diff_captured fired");
		strictEqual(byEvent.diff_captured.byteCount, 18);
		ok(byEvent.gate_validated, "gate_validated fired");
		strictEqual(byEvent.gate_validated.outcome, "passed");
		ok(byEvent.gate_applied, "gate_applied fired");
		ok(byEvent.task_completed, "task_completed fired");
		strictEqual(byEvent.task_completed.taskId, "1.1");
		ok(byEvent.checkpoint_saved, "checkpoint_saved fired");
		ok(byEvent.terminal, "terminal fired");
		strictEqual(byEvent.terminal.phase, "lifecycle");
		ok(byEvent.cleanup_started, "cleanup_started fired");
		ok(byEvent.cleanup_complete, "cleanup_complete fired");
	});

	it("runner emits task_failed event with error serialization", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							error: "SECRET_CANARY_provider_failure",
						}),
						captureDiff: () => "",
					},
				},
			},
		});

		const failed = events.find((e) => e.event === "task_failed");
		ok(failed, "task_failed event emitted");
		strictEqual(failed.taskId, "1.1");
		ok(failed.error, "error field present");
		strictEqual(failed.errorKind, "execution_failed");
		strictEqual(failed.reasonCode, "execution_failed");
		strictEqual(
			failed.error.message,
			"Provider execution failed before a reviewed integration.",
		);
		ok(!JSON.stringify(events).includes("SECRET_CANARY_provider_failure"));
	});

	it("runner emits gate_validated event with rejected outcome on gate failure", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Gate-failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will be rejected
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "gate rejected diff",
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const validated = events.find((e) => e.event === "gate_validated");
		ok(validated, "gate_validated event emitted");
		strictEqual(validated.outcome, "rejected");
		strictEqual(validated.errorKind, "integration_failed");
		strictEqual(validated.reasonCode, "integration_failed");
		strictEqual(
			validated.status,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(validated.artifactRef, undefined);
		ok(
			!events.find((e) => e.event === "gate_applied"),
			"gate_applied not emitted on rejection",
		);
		ok(!JSON.stringify(events).includes("gate rejected diff"));
	});

	it("runner emits checkpoint events (checkpoint_saved) for each task", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** first task

### Task 1.2: Second
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** second task
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const checkpoints = events.filter((e) => e.event === "checkpoint_saved");
		strictEqual(checkpoints.length, 2);
		strictEqual(checkpoints[0].taskId, "1.1");
		strictEqual(checkpoints[1].taskId, "1.2");
	});

	it("runner emits container_created when it creates a working container", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-diag-container",
				provisionCredentials: () => 1,
				seedProject: () => {},
				commitWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		const created = events.find((e) => e.event === "container_created");
		ok(created, "container_created event emitted");
		strictEqual(created.phase, "bootstrap");
	});

	it("does NOT emit container_created when working container is supplied by caller", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "caller-supplied-container",
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "should-not-be-used",
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(
			events.find((e) => e.event === "container_created"),
			undefined,
			"container_created not emitted for caller-supplied container",
		);
	});

	it("onStatus absence: existing behavior unchanged (no new output when hook not provided)", () => {
		// Regression guard: ensure that when neither onStatus nor diagnostics
		// is provided, runQueue behaves exactly as before — no errors, no
		// new side effects.
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].success, true);
	});

	it("supports Diagnostics instance via dependencies.diagnostics", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		// Build a minimal diagnostics-like interface inline.
		const diag = {
			emit: (e) => events.push(e),
		};

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				diagnostics: diag,
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(events.length > 0, "diagnostics.emit was called");
		ok(
			events.find((e) => e.event === "task_completed"),
			"task_completed event via diagnostics",
		);
	});

	it("cleanup_failed event is emitted when wipe fails", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		throws(() => {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: {
					onStatus: (e) => events.push(e),
					route: () => ({
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 72,
						reason: "spread",
					}),
					recordDispatch: () => {},
					integrationGate: () => ({ success: true, message: "ok" }),
					ensureAgentContainer: () => {},
					createWorkingContainer: () => "generated-diag-container",
					provisionCredentials: () => 1,
					seedProject: () => {},
					commitWorkingTree: () => {},
					wipeWorkingContainer: () => {
						throw new Error("wipe exploded");
					},
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/a b/a",
						},
					},
				},
			});
		}, /wipe exploded/);

		const failed = events.find((e) => e.event === "cleanup_failed");
		ok(failed, "cleanup_failed event emitted");
		strictEqual(failed.phase, "cleanup");
		ok(
			events.find((e) => e.event === "cleanup_started"),
			"cleanup_started was emitted first",
		);
	});

	it("Diagnostics instance supports multiple sinks via dependencies.diagnostics", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Only task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Do the thing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const sinkA = [];
		const sinkB = [];
		const d = {
			_sinks: [],
			emit(event) {
				for (const s of this._sinks) s(event);
			},
			sink(fn) {
				this._sinks.push(fn);
			},
			removeSink(fn) {
				this._sinks = this._sinks.filter((s) => s !== fn);
			},
		};
		d.sink((e) => sinkA.push(e));
		d.sink((e) => sinkB.push(e));

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				diagnostics: d,
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
			},
		});

		ok(
			sinkA.length === sinkB.length,
			"both sinks received same number of events",
		);
		ok(sinkA.length > 0, "sink A received events");
		deepStrictEqual(
			sinkA.map((e) => e.event),
			sinkB.map((e) => e.event),
		);
	});

	it("fires onResult with success:false when a task fails", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				onTaskStart: (task) => events.push(`start:${task.id}`),
				onResult: (result) =>
					events.push(`result:${result.taskId}:${result.success}`),
				adapters: {
					claude: {
						execute: () => ({ success: false, error: "simulated failure" }),
						captureDiff: () => "",
					},
				},
			},
		});

		deepStrictEqual(events, ["start:1.1", "result:1.1:false"]);
	});
});

describe("Files requiredPaths propagation", () => {
	it("passes unwrapped Files paths to integrationGate", () => {
		const markdown = `## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** \`src/a.mjs\`, \`tests/a.test.mjs\`
- **Description:** simple cleanup
`;
		const task = parseFixture(markdown)[0];
		const gateCalls = [];
		const result = executeTask(task, {
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 50,
				reason: "spread",
			}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: (diff, projectPath, options) => {
				gateCalls.push({ diff, projectPath, options });
				return { success: true, message: "ok" };
			},
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => "diff --git a/a b/a",
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		});

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		deepStrictEqual(gateCalls[0].options.requiredPaths, [
			"src/a.mjs",
			"tests/a.test.mjs",
		]);
	});

	it("executeTask passes requiredPaths to integrationGate", () => {
		const gateCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: ["src/a.mjs", "tests/a.test.mjs"],
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		deepStrictEqual(gateCalls[0].options.requiredPaths, [
			"src/a.mjs",
			"tests/a.test.mjs",
		]);
	});

	it("executeTask passes null requiredPaths to integrationGate when task has none", () => {
		const gateCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: null,
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].options.requiredPaths, null);
	});

	it("executeTask calls integrationGate with empty diff when requiredPaths is set (not success_no_diff)", () => {
		const gateCalls = [];
		const dispatches = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "simple cleanup",
				requiredPaths: ["src/f.mjs"],
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				recordDispatchIntent: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: false, message: "empty_required_diff" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, false);
		strictEqual(result.result, "integration_failed");
		strictEqual(result.errorKind, "integration_failed");
		strictEqual(result.reasonCode, "integration_failed");
		strictEqual(
			result.reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(result.diagnosticCode, "empty_required_diff");
		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].diff, "");
		deepStrictEqual(gateCalls[0].options.requiredPaths, ["src/f.mjs"]);
		strictEqual(dispatches[0].result, "integration_failed");
		strictEqual(dispatches[0].errorKind, "integration_failed");
		strictEqual(dispatches[0].reasonCode, "integration_failed");
		strictEqual(
			dispatches[0].reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(dispatches[0].diagnosticCode, "empty_required_diff");
	});

	it("executeTaskWithOrchestrator passes requiredPaths to integrationGate", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Simple operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const gateCalls = [];

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: (_diff, _projectPath, options) => {
					gateCalls.push({ options });
					return { success: true, message: "ok" };
				},
				sleepFn: async () => {},
				orchestrator: {
					launch: async (_payload) => {
						// Inject requiredPaths into the task so the orchestrator
						// path receives them.
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				onTaskStart: (task) => {
					// Simulate parseTaskQueue injecting requiredPaths
					task.requiredPaths = ["src/a.mjs"];
				},
			},
		});

		strictEqual(gateCalls.length, 1);
		deepStrictEqual(gateCalls[0].options.requiredPaths, ["src/a.mjs"]);
	});

	it("executeTaskWithOrchestrator calls gate with empty diff when requiredPaths is set", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: File task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Simple operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const gateCalls = [];
		const dispatches = [];

		const result = await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: (diff, _projectPath, options) => {
					gateCalls.push({ diff, options });
					return { success: false, message: "empty_required_diff" };
				},
				sleepFn: async () => {},
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
				onTaskStart: (task) => {
					task.requiredPaths = ["src/a.mjs"];
				},
			},
		});

		strictEqual(gateCalls.length, 1);
		strictEqual(gateCalls[0].diff, "");
		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(taskResult.result, "integration_failed");
		strictEqual(taskResult.errorKind, "integration_failed");
		strictEqual(taskResult.reasonCode, "integration_failed");
		strictEqual(
			taskResult.reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(taskResult.diagnosticCode, "empty_required_diff");
		strictEqual(dispatches[0].result, "integration_failed");
		strictEqual(dispatches[0].errorKind, "integration_failed");
		strictEqual(dispatches[0].reasonCode, "integration_failed");
		strictEqual(
			dispatches[0].reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(dispatches[0].diagnosticCode, "empty_required_diff");
	});
});

describe("runner runStore dependency", () => {
	it("calls runStore.updateRun during task execution with activeTaskId", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				runStore,
			},
		});

		strictEqual(result.processedTasks, 2);

		const taskStartCalls = runStoreCalls.filter(
			(c) => typeof c.activeTaskId === "string",
		);
		strictEqual(taskStartCalls.length, 2);
		strictEqual(taskStartCalls[0].activeTaskId, "1.1");
		strictEqual(taskStartCalls[1].activeTaskId, "1.2");

		const emptyCalls = runStoreCalls.filter(
			(c) => c.activeTaskId === undefined && c.state === undefined,
		);
		strictEqual(emptyCalls.length, 2);

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "succeeded");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
		strictEqual(terminalCall.terminalizedBy, "worker");
		strictEqual(terminalCall.lastFailure, undefined);
	});

	it("runStore terminal call sets state to failed when tasks fail", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** This will fail
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: false, error: "simulated failure" }),
						captureDiff: () => "",
					},
				},
				runStore,
			},
		});

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "failed");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
		strictEqual(terminalCall.terminalizedBy, "worker");
		ok(terminalCall.lastFailure, "terminal call has lastFailure");
		ok(isPersistentFailureMetadata(terminalCall.lastFailure));
		strictEqual(terminalCall.lastFailure.errorKind, "execution_failed");
		notStrictEqual(terminalCall.lastFailure.errorKind, "unclassified");
	});

	it("calls onCheckpointSaved after each checkpoint save", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First operation

### Task 1.2: Second task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const checkpoints = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				onCheckpointSaved: () => checkpoints.push(true),
			},
		});

		strictEqual(result.processedTasks, 2);
		strictEqual(checkpoints.length, 2);
	});
});

describe("executeTask timeout handling", () => {
	it("captures a partial diff and returns execution_timed_out without calling integrationGate when the adapter reports timedOut", () => {
		const gateCalls = [];
		const captureDiffCalls = [];
		const dispatches = [];

		const result = executeTask(
			{
				id: "1.1",
				title: "task",
				description: "a task that overran its timeout",
				requiredPaths: null,
			},
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				recordDispatchIntent: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "partial output before kill",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						captureDiff: (containerName) => {
							captureDiffCalls.push(containerName);
							return "diff --git a/wip.mjs b/wip.mjs\n+work in progress";
						},
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.success, false);
		strictEqual(result.result, "execution_timed_out");
		strictEqual(result.timedOut, true);
		strictEqual(
			result.partialDiff,
			"diff --git a/wip.mjs b/wip.mjs\n+work in progress",
		);
		strictEqual(captureDiffCalls.length, 1, "captureDiff called once");
		strictEqual(captureDiffCalls[0], "fake-container");
		strictEqual(
			gateCalls.length,
			0,
			"a timed-out diff must never reach integrationGate — it is not a reviewed success (INV-2)",
		);
		strictEqual(dispatches[0].result, "execution_timed_out");
	});

	it("passes task.timeoutMs through to adapter.execute, falling back to the provider default when absent", () => {
		const executeCalls = [];
		const context = () => ({
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5",
				percentLeft: 50,
				reason: "spread",
			}),
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: (_prompt, _containerName, options) => {
						executeCalls.push(options.timeoutMs);
						return { success: true, output: "ok" };
					},
					captureDiff: () => null,
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			now: () => 1_000,
			monotonicNow: () => 0,
		});

		executeTask(
			{ id: "1.1", title: "custom", description: "x", timeoutMs: 90_000 },
			context(),
		);
		executeTask({ id: "1.2", title: "default", description: "x" }, context());

		strictEqual(executeCalls[0], 90_000);
		strictEqual(executeCalls[1], PROVIDER_EXECUTION_TIMEOUT_MS);
	});

	it("captures but never integrates a diff from a non-timeout execution failure", () => {
		const captureDiffCalls = [];
		const gateCalls = [];

		const result = executeTask(
			{ id: "1.1", title: "task", description: "a normal failure" },
			{
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: (...args) => {
					gateCalls.push(args);
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "provider crashed",
						}),
						captureDiff: (containerName) => {
							captureDiffCalls.push(containerName);
							return "diff --git a/wip.mjs b/wip.mjs\n+recoverable work";
						},
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(result.result, "execution_failed");
		strictEqual(result.timedOut, undefined);
		strictEqual(result.captureStatus, "captured");
		strictEqual(
			result.partialDiff,
			"diff --git a/wip.mjs b/wip.mjs\n+recoverable work",
		);
		strictEqual(captureDiffCalls.length, 1);
		strictEqual(gateCalls.length, 0, "failed provider work stays review-only");
	});
});

// Task 1.1: RequiredCapability is the task-contract name at the parser and
// runner boundary. Task 1.2 carries that name through route selection.
describe("runner task contract resolution", () => {
	function capabilityCapturingContext(routeCalls) {
		return {
			route: (opts) => {
				routeCalls.push(opts);
				return {
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 50,
					reason: "spread",
				};
			},
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "ok" }),
					captureDiff: () => null,
				},
			},
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
		};
	}

	it("executeTask routes at RequiredCapability regardless of description text", () => {
		const routeCalls = [];
		// Description text must never override the declared capability.
		executeTask(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: "high",
				requiredCapabilityJustification:
					"The task requires architectural review.",
			},
			capabilityCapturingContext(routeCalls),
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
	});

	it("legacy programmatic task objects with an omitted capability use standard", () => {
		const routeCalls = [];
		executeTask(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: null,
			},
			capabilityCapturingContext(routeCalls),
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "standard");
	});

	it("executeTask never provider-routes native or human tasks", () => {
		for (const executor of ["native", "human"]) {
			const routeCalls = [];
			const result = executeTask(
				{
					id: "1.1",
					title: "task",
					description: "format the readme",
					executor,
					requiredCapability: "high",
					requiredCapabilityJustification:
						"The task requires architectural review.",
				},
				capabilityCapturingContext(routeCalls),
			);
			strictEqual(routeCalls.length, 0);
			strictEqual(result.provider, null);
			strictEqual(result.result, "executor_not_switchyard");
		}
	});

	it("executeTask rejects an invalid RequiredCapability instead of silently routing at capability 0", () => {
		const routeCalls = [];
		throws(
			() =>
				executeTask(
					{
						id: "1.1",
						title: "task",
						description: "format the readme",
						requiredCapability: "urgent",
					},
					capabilityCapturingContext(routeCalls),
				),
			/invalid declared RequiredCapability "urgent"/,
		);
		// The reject must happen before route() is ever reached -- an invalid
		// RequiredCapability must not silently reach the router as a fallback or
		// zero capability.
		strictEqual(routeCalls.length, 0);
	});

	it("executeTask rejects explicit low/high capability without justification before routing", () => {
		for (const capability of ["high", "low"]) {
			const routeCalls = [];
			throws(
				() =>
					executeTask(
						{
							id: "1.1",
							title: "task",
							description: "format the readme",
							requiredCapability: capability,
						},
						capabilityCapturingContext(routeCalls),
					),
				/RequiredCapabilityJustification is required for explicit/,
			);
			strictEqual(routeCalls.length, 0);
		}
	});

	it("executeTaskWithOrchestrator routes at RequiredCapability regardless of description", async () => {
		const routeCalls = [];
		const result = await executeTaskWithOrchestrator(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: "high",
				requiredCapabilityJustification:
					"The task requires architectural review.",
			},
			{
				...capabilityCapturingContext(routeCalls),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
		strictEqual(result.taskId, "1.1");
	});

	it("executeTaskWithOrchestrator uses standard when RequiredCapability is absent", async () => {
		const routeCalls = [];
		await executeTaskWithOrchestrator(
			{
				id: "1.1",
				title: "task",
				description: "format the readme",
				requiredCapability: null,
			},
			{
				...capabilityCapturingContext(routeCalls),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
			},
		);
		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "standard");
	});

	it("executeTaskWithOrchestrator never provider-routes native or human tasks", async () => {
		for (const executor of ["native", "human"]) {
			const routeCalls = [];
			let launches = 0;
			const result = await executeTaskWithOrchestrator(
				{
					id: "1.1",
					title: "task",
					description: "format the readme",
					executor,
					requiredCapability: "high",
					requiredCapabilityJustification:
						"The task requires architectural review.",
				},
				{
					...capabilityCapturingContext(routeCalls),
					orchestrator: {
						launch: async () => {
							launches += 1;
							return "job-1";
						},
					},
				},
			);
			strictEqual(routeCalls.length, 0);
			strictEqual(launches, 0);
			strictEqual(result.provider, null);
			strictEqual(result.result, "executor_not_switchyard");
		}
	});

	it("executeTaskWithOrchestrator rejects an invalid RequiredCapability instead of silently routing at capability 0", async () => {
		const routeCalls = [];
		await rejects(
			() =>
				executeTaskWithOrchestrator(
					{
						id: "1.1",
						title: "task",
						description: "format the readme",
						requiredCapability: "urgent",
					},
					{
						...capabilityCapturingContext(routeCalls),
						orchestrator: {
							launch: async () => "job-1",
							status: async () => ({ state: "done" }),
							result: async () => ({ success: true, diff: "" }),
						},
					},
				),
			/invalid declared RequiredCapability "urgent"/,
		);
		strictEqual(routeCalls.length, 0);
	});

	it("executeTaskWithOrchestrator rejects explicit low/high without justification before routing or launch", async () => {
		for (const capability of ["high", "low"]) {
			const routeCalls = [];
			let launches = 0;
			await rejects(
				() =>
					executeTaskWithOrchestrator(
						{
							id: "1.1",
							title: "task",
							description: "format the readme",
							requiredCapability: capability,
						},
						{
							...capabilityCapturingContext(routeCalls),
							orchestrator: {
								launch: async () => {
									launches += 1;
									return "job-1";
								},
							},
						},
					),
				/RequiredCapabilityJustification is required for explicit/,
			);
			strictEqual(routeCalls.length, 0);
			strictEqual(launches, 0);
		}
	});

	it("end to end: RequiredCapability reaches route() as requiredCapability", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Declared-capability task
- **Status:** pending
- **Files:** src/a.mjs
- **RequiredCapability:** high
- **RequiredCapabilityJustification:** The task requires architectural review.
- **Description:** format the readme
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const routeCalls = [];

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: capabilityCapturingContext(routeCalls),
		});

		strictEqual(routeCalls.length, 1);
		strictEqual(routeCalls[0].requiredCapability, "high");
	});
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
							captureDiff: () => null,
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

	// Drive the production runner (no test descriptor wrapper) so the roster
	// descriptor receipt is the one the health identity was derived from.
	function productionQueueOptions(options) {
		const wrapped = withTestDescriptorOptions(options);
		const dependencies = { ...wrapped.dependencies };
		dependencies.route = options.dependencies.route;
		delete dependencies.resolveDescriptor;
		delete dependencies.resolveTargetIdentity;
		return { ...wrapped, dependencies };
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

	// Owned-workspace queue dependencies with a scripted codex outcome list;
	// the legacy container stubs make the queue own its workspace so the
	// quota fallback path is reachable.
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

	// Put the codex standard route into a real repair-hold through the
	// production evidence chain: authoritative failure -> terminal binding ->
	// run-store event -> ingestion.
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

	it(
		"keeps a started enforce-mode trial fenced and skips quota fallback without lifecycle proof",
		withQualifiedRoster(async () => {
			for (const mode of ["sync", "async"]) {
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
				const result =
					mode === "sync"
						? runQueueImpl(options)
						: await runQueueAsyncImpl(options);
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
			}
		}),
	);

	it(
		"never claims a trial in shadow mode and leaves quota fallback untouched",
		withQualifiedRoster(async () => {
			for (const mode of ["sync", "async"]) {
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
				// One checkpoint per mode: a shared one would hand the async run a
				// checkpoint whose task the sync run already completed.
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
				const result =
					mode === "sync"
						? runQueueImpl(options)
						: await runQueueAsyncImpl(options);
				const fallbackAuthorized = mode === "async";
				strictEqual(
					fixture.executeCalls.length,
					fallbackAuthorized ? 2 : 1,
					`${mode}: shadow mode only spends a launch when durable evidence authorizes fallback`,
				);
				strictEqual(result.results[0].success, fallbackAuthorized, mode);
				strictEqual(
					loadCheckpoint(checkpointPath, tasksPath).providerAttemptAllocations
						.length,
					fallbackAuthorized ? 1 : 0,
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
			}
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
			const result = executeTaskImpl(
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
							captureDiff: () => null,
						},
					},
					queueBackend: { captureTaskBase: () => TASK_BASE },
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
			const holder = executeTaskImpl(
				{ id: "holder", title: "claim holder", description: "op" },
				{
					route: codexHealthRoute,
					healthDecision,
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => ({ success: true }),
					adapters: {
						codex: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => null,
						},
					},
					queueBackend: { captureTaskBase: () => TASK_BASE },
					projectPath: TEST_DIR,
					workingContainerName: "claim-holder-workspace",
					runId: "claim-holder-run",
				},
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
			const syncRunStoreCalls = [];
			fixture.dependencies.healthDecision = healthDecision;
			fixture.dependencies.onStatus = (event) => statusEvents.push(event);
			fixture.dependencies.runStore = {
				updateRun: (partial) => {
					syncRunStoreCalls.push({ ...partial });
					return Promise.resolve({ revision: 0 });
				},
			};
			const routeCalls = [];
			fixture.dependencies.route = () => {
				routeCalls.push(true);
				return codexHealthRoute();
			};
			const result = runQueueImpl(
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
			const syncTerminal = syncRunStoreCalls.find(
				(call) => call.state !== undefined,
			);
			strictEqual(syncTerminal.state, "deferred");
			deepStrictEqual(syncTerminal.terminalSummary.completedTaskIds, []);
			deepStrictEqual(syncTerminal.terminalSummary.deferredTaskIds, [
				"1.1",
				"1.2",
			]);
			strictEqual(syncTerminal.terminalSummary.failedCount, 0);
			strictEqual(syncTerminal.lastFailure, undefined);

			const orchestratorTasksPath =
				writeTasksFile(`### Task 2.1: Deferred orchestrator
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** deferred orchestrator task
`);
			const orchestratorCheckpointPath = `${orchestratorTasksPath}.orchestrator.checkpoint.json`;
			const orchestratorRunStoreCalls = [];
			const orchestratorLaunches = [];
			const orchestratorFixture = ownedCodexQueueDependencies([]);
			orchestratorFixture.dependencies.healthDecision = healthDecision;
			orchestratorFixture.dependencies.runStore = {
				updateRun: (partial) => {
					orchestratorRunStoreCalls.push({ ...partial });
					return Promise.resolve({ revision: 0 });
				},
			};
			orchestratorFixture.dependencies.orchestrator = {
				launch: async () => {
					orchestratorLaunches.push(true);
					return "must-not-launch";
				},
				status: async () => ({ state: "done" }),
				result: async () => ({ success: true, diff: "" }),
			};
			const orchestratorResult = await runQueueWithOrchestratorImpl(
				productionQueueOptions({
					tasksFilePath: orchestratorTasksPath,
					projectPath: TEST_DIR,
					workingContainerName: "claim-contention-orchestrator",
					checkpointPath: orchestratorCheckpointPath,
					runId: "claim-contention-orchestrator-run",
					dependencies: orchestratorFixture.dependencies,
				}),
			);
			deepStrictEqual(orchestratorLaunches, []);
			deepStrictEqual(orchestratorResult.results, []);
			deepStrictEqual(orchestratorResult.completedTaskIds, []);
			deepStrictEqual(orchestratorResult.deferredTaskIds, ["2.1"]);
			const orchestratorTerminal = orchestratorRunStoreCalls.find(
				(call) => call.state !== undefined,
			);
			strictEqual(orchestratorTerminal.state, "deferred");
			deepStrictEqual(
				orchestratorTerminal.terminalSummary.completedTaskIds,
				[],
			);
			deepStrictEqual(orchestratorTerminal.terminalSummary.deferredTaskIds, [
				"2.1",
			]);
			strictEqual(orchestratorTerminal.terminalSummary.failedCount, 0);
			strictEqual(orchestratorTerminal.lastFailure, undefined);
		}),
	);

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

	it("runQueue forwards options.only onto context.only, reaching route() via executeTask (Task C.9)", () => {
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
		deepStrictEqual(routeCalls[0].only, ["codex"]);
	});

	it("runQueue defaults context.only to [] when options.only is omitted (Task C.9)", () => {
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
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
			},
		});

		deepStrictEqual(routeCalls[0].only, []);
	});

	it("executeTask passes context.only through to route(), alongside exclude and availableProviders (Task C.9)", () => {
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

	it("executeTaskWithOrchestrator passes both provider filters and availableProviders through to route() (Task E.1)", async () => {
		// Task E.1 closed the "intentionally-unfiltered orchestrator route" gap
		// (Task 16): executeTaskWithOrchestrator now mirrors executeTask and
		// passes availableProviders derived from context.adapters, alongside
		// the pre-existing exclude forwarding.
		const routeCalls = [];

		const result = await executeTaskWithOrchestrator(
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
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
				sleepFn: async () => {},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				adapters: {
					codex: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => null,
					},
				},
				exclude: ["claude"],
				only: ["codex"],
				platform: "macos",
				goldenImageVerifiedProviders: ["codex"],
			},
		);

		strictEqual(result.success, true);
		strictEqual(routeCalls.length, 1);
		deepStrictEqual(routeCalls[0].exclude, ["claude"]);
		deepStrictEqual(routeCalls[0].only, ["codex"]);
		deepStrictEqual(routeCalls[0].availableProviders, ["codex"]);
		strictEqual(routeCalls[0].platform, "macos");
		deepStrictEqual(routeCalls[0].goldenImageVerifiedProviders, ["codex"]);
	});
});

describe("runQueue timeout diff persistence", () => {
	it("persists a timed-out task's partial diff to disk and records partialDiffPath + timedOut in checkpoint.json without embedding the raw diff text", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText =
			"diff --git a/wip.mjs b/wip.mjs\n+SECRET_CANARY_wip_marker";

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
							cleanupFailed: true,
							cleanupStage: "pid_marker_removed",
							failurePhase: "provider_cleanup",
						}),
						captureDiff: () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.timedOut, true);
		strictEqual(taskResult.errorKind, "provider_cleanup_failed");
		strictEqual(taskResult.cleanupStage, "pid_marker_removed");
		strictEqual(
			taskResult.diagnosticCode,
			"provider_cleanup_after_pid_marker_removed",
		);
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"raw diff text must not ride along in the in-memory result once persisted",
		);
		ok(taskResult.partialDiffPath, "result carries the artifact path");
		ok(existsSync(taskResult.partialDiffPath));
		strictEqual(readFileSync(taskResult.partialDiffPath, "utf8"), diffText);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].success, false);
		strictEqual(checkpoint.results[0].timedOut, true);
		strictEqual(
			checkpoint.results[0].diagnosticCode,
			"provider_cleanup_after_pid_marker_removed",
		);
		strictEqual(checkpoint.results[0].partialDiffPath, null);
		strictEqual(checkpoint.results[0].artifactRef, undefined);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_wip_marker"),
			"checkpoint.json must reference the artifact by path only, never embed the diff text",
		);
		ok(
			!rawCheckpointJson.includes(taskResult.partialDiffPath),
			"checkpoint.json must not persist the host artifact path",
		);
	});

	it("emits a distinct partial_diff_capture_failed signal when a timed-out task's rescue attempt recovers no diff", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				onStatus: (e) => events.push(e),
				adapters: {
					claude: {
						execute: () => ({
							success: false,
							output: "",
							error: "spawnSync docker ETIMEDOUT",
							timedOut: true,
						}),
						// The kill+capture rescue ran but found nothing to recover —
						// e.g. no edits were made yet, or capture itself failed.
						captureDiff: () => null,
					},
				},
			},
		});

		const [taskResult] = result.results;
		strictEqual(taskResult.timedOut, true);
		strictEqual(taskResult.partialDiffPath, undefined);

		const failedEvent = events.find(
			(e) => e.event === "partial_diff_capture_failed",
		);
		ok(
			failedEvent,
			"expected a partial_diff_capture_failed status event when captureDiff returns null on timeout",
		);
		strictEqual(failedEvent.taskId, "1.1");
		ok(
			!events.some((e) => e.event === "partial_diff_captured"),
			"a failed rescue must not also fire the success event",
		);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].timedOut, true);
		strictEqual(checkpoint.results[0].partialDiffPath, null);
	});

	it("keeps an explicitly empty timed-out capture distinct from capture failure", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout without edits
`);
		const events = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				route: () => ({
					provider: "vibe",
					model: "mistral-medium-3.5",
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				onStatus: (event) => events.push(event),
				adapters: {
					vibe: {
						execute: () => ({
							success: false,
							timedOut: true,
							error: "timed out",
						}),
						captureDiffDetailed: () => ({ status: "empty", diff: null }),
					},
				},
			},
		});
		strictEqual(result.results[0].result, "execution_timed_out");
		strictEqual(result.results[0].captureStatus, "empty");
		ok(events.some((event) => event.event === "diff_capture_started"));
		ok(
			!events.some((event) => event.event === "partial_diff_capture_failed"),
			"an explicit empty capture is not a capture failure",
		);
	});

	it("preserves a synchronous capture failure status in the partial-diff failure event", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Long-running task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** overruns its timeout while diff capture fails
`);
		const events = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				route: () => ({
					provider: "vibe",
					model: "mistral-medium-3.5",
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				onStatus: (event) => events.push(event),
				adapters: {
					vibe: {
						execute: () => ({
							success: false,
							timedOut: true,
							error: "timed out",
						}),
						captureDiffDetailed: () => ({
							status: "diff_failed",
							diff: null,
						}),
					},
				},
			},
		});

		strictEqual(result.results[0].captureStatus, "diff_failed");
		const failedEvent = events.find(
			(event) => event.event === "partial_diff_capture_failed",
		);
		ok(failedEvent, "a non-empty capture status must emit a failure event");
		strictEqual(failedEvent.captureStatus, "diff_failed");
	});
});

describe("runQueue non-timeout rejection diff persistence (Task D.4)", () => {
	it("persists a non-timeout, non-credential integrationGate rejection's diff to disk, same as the timeout path", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Rejected task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** produces a diff the gate rejects for a non-credential reason
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText =
			"diff --git a/wip.mjs b/wip.mjs\n+SECRET_CANARY_rejected_marker";
		const dispatches = [];
		const events = [];

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				onStatus: (event) => events.push(event),
				integrationGate: () => ({
					success: false,
					message: "SECRET_CANARY_gate_message",
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "", error: null }),
						captureDiff: () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(taskResult.result, "integration_failed");
		strictEqual(taskResult.errorKind, "integration_failed");
		strictEqual(taskResult.reasonCode, "integration_failed");
		strictEqual(
			taskResult.reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(taskResult.artifactRef, undefined);
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"raw diff text must not ride along in the in-memory result once persisted",
		);
		ok(taskResult.partialDiffPath, "result carries the artifact path");
		ok(existsSync(taskResult.partialDiffPath));
		strictEqual(readFileSync(taskResult.partialDiffPath, "utf8"), diffText);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].partialDiffPath, null);
		strictEqual(checkpoint.results[0].errorKind, "integration_failed");
		strictEqual(checkpoint.results[0].reasonCode, "integration_failed");
		strictEqual(
			checkpoint.results[0].reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(checkpoint.results[0].artifactRef, undefined);
		const failedEvent = events.find((event) => event.event === "task_failed");
		ok(failedEvent, "task_failed status event is present");
		strictEqual(failedEvent.errorKind, "integration_failed");
		strictEqual(failedEvent.reasonCode, "integration_failed");
		strictEqual(
			failedEvent.reason,
			"The reviewed integration gate rejected the task result.",
		);
		strictEqual(failedEvent.artifactRef, undefined);
		strictEqual(dispatches.length, 1);
		strictEqual(dispatches[0].errorKind, "integration_failed");
		strictEqual(dispatches[0].reasonCode, "integration_failed");
		strictEqual(dispatches[0].artifactRef, undefined);
		ok(
			!JSON.stringify({ dispatches, events, checkpoint }).includes(
				"SECRET_CANARY_gate_message",
			),
		);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_rejected_marker"),
			"checkpoint.json must reference the artifact by path only, never embed the diff text",
		);
		ok(
			!rawCheckpointJson.includes(taskResult.partialDiffPath),
			"checkpoint.json must not persist the host artifact path",
		);
	});

	it("records execution identity as a bounded verification flag, never the served string", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Verified task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** the adapter reads back which model actually served the run
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const baseDependencies = {
			route: () => ({
				provider: "vibe",
				model: "glm-5.2-high",
				percentLeft: 72,
				reason: "spread",
			}),
			recordDispatch: () => {},
			integrationGate: () => ({ success: true, message: "ok" }),
			ensureAgentContainer: () => {},
			createWorkingContainer: () => "generated-working-container",
			provisionCredentials: () => {},
			seedProject: () => {},
			commitWorkingTree: () => {},
			resetWorkingTree: () => {},
			wipeWorkingContainer: () => {},
		};
		const run = (execute) =>
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath: `${checkpointPath}.${randomUUID()}`,
				dependencies: {
					...baseDependencies,
					adapters: {
						vibe: {
							execute,
							captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs\n+ok",
						},
					},
				},
			});

		const verified = run(() => ({
			success: true,
			output: "",
			error: null,
			servedModel: "glm-5.2-high",
		}));
		strictEqual(verified.results[0].servedModelVerified, true);

		const unreadable = run(() => ({
			success: true,
			output: "",
			error: null,
			servedModel: null,
		}));
		strictEqual(unreadable.results[0].servedModelVerified, false);

		// Absent, not false: an adapter that cannot report one has not failed a
		// check, and recording `false` would say it had.
		const unsupported = run(() => ({ success: true, output: "", error: null }));
		strictEqual(unsupported.results[0].servedModelVerified, undefined);
		ok(!("servedModelVerified" in unsupported.results[0]));

		// The guest-supplied string itself never reaches a result.
		const echoed = run(() => ({
			success: true,
			output: "",
			error: null,
			servedModel: "SECRET_CANARY_served_model",
		}));
		ok(
			!JSON.stringify(echoed.results[0]).includes("SECRET_CANARY_served_model"),
		);
	});

	it("does not persist a provider transcript when the gate rejects an empty diff", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Empty-diff task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** the provider explains itself but changes nothing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const transcript =
			"I inspected src/a.mjs and concluded no change was required.";

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({
							success: true,
							output: transcript,
							error: null,
						}),
						captureDiff: () => "",
					},
				},
			},
		});

		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(
			taskResult.diagnosticCode ?? taskResult.reasonCode,
			"empty_required_diff",
		);
		const artifactPath = `${checkpointPath}.partial-diffs/1.1.output`;
		ok(!existsSync(artifactPath), "raw provider output must not be retained");
		strictEqual(taskResult.artifactRef, undefined);
		strictEqual(
			taskResult.gateEvidence,
			null,
			"raw transcript must not ride along in the result handed to onResult",
		);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes(transcript),
			"checkpoint.json must reference the artifact, never embed the transcript",
		);
		ok(
			!rawCheckpointJson.includes(taskResult.gateEvidencePath),
			"checkpoint.json must not persist the host artifact path",
		);
	});

	it("keeps no transcript for a credential-flagged empty-diff rejection", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Empty-diff task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** the gate flags the rejection as credential-bearing
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "empty_required_diff",
					credentialFlagged: true,
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({
							success: true,
							output: "SECRET_CANARY_transcript",
							error: null,
						}),
						captureDiff: () => "",
					},
				},
			},
		});

		const artifactsDir = `${checkpointPath}.partial-diffs`;
		ok(
			!existsSync(artifactsDir) || readdirSync(artifactsDir).length === 0,
			"a credential-flagged rejection must keep no transcript either",
		);
	});

	it("NEVER persists a credential-flagged rejection's diff to disk (security property)", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Credential-flagged task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** produces a diff the gate rejects for touching a credential-convention path
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const diffText =
			"diff --git a/.env b/.env\n+SECRET_CANARY_must_never_touch_disk";

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 72,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "diff touches a credential-convention path: .env",
					credentialFlagged: true,
				}),
				ensureAgentContainer: () => {},
				createWorkingContainer: () => "generated-working-container",
				provisionCredentials: () => {},
				seedProject: () => {},
				commitWorkingTree: () => {},
				resetWorkingTree: () => {},
				wipeWorkingContainer: () => {},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "", error: null }),
						captureDiff: () => diffText,
					},
				},
			},
		});

		strictEqual(result.processedTasks, 1);
		const [taskResult] = result.results;
		strictEqual(taskResult.success, false);
		strictEqual(
			taskResult.partialDiff,
			undefined,
			"credential-flagged diff must never even ride along in the in-memory result",
		);
		strictEqual(
			taskResult.partialDiffPath,
			undefined,
			"credential-flagged rejection must never produce an artifact path",
		);

		const artifactsDir = `${checkpointPath}.partial-diffs`;
		ok(
			!existsSync(artifactsDir) || readdirSync(artifactsDir).length === 0,
			"no artifact file may exist under .partial-diffs for a credential-flagged rejection",
		);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].partialDiffPath, null);

		const rawCheckpointJson = readFileSync(checkpointPath, "utf8");
		ok(
			!rawCheckpointJson.includes("SECRET_CANARY_must_never_touch_disk"),
			"checkpoint.json must never embed a credential-flagged diff's text",
		);
	});
});

describe("reject declared paths that cannot be seeded (Task 1.1)", () => {
	it("findIgnoredDeclaredPath identifies Git-ignored files and ignores tracked/unignored paths", () => {
		strictEqual(findIgnoredDeclaredPath(null), null);
		strictEqual(findIgnoredDeclaredPath([]), null);
		strictEqual(findIgnoredDeclaredPath([""]), null);
		strictEqual(
			findIgnoredDeclaredPath(["src/switchyard/runner/index.mjs"]),
			null,
		);
		strictEqual(
			findIgnoredDeclaredPath(["src/switchyard/new_untracked_file.mjs"]),
			null,
		);
		strictEqual(findIgnoredDeclaredPath(["HISTORY.md"]), "HISTORY.md");
		strictEqual(findIgnoredDeclaredPath(["TASKS.md"]), "TASKS.md");
		strictEqual(findIgnoredDeclaredPath([".logs/run.json"]), ".logs/run.json");
		strictEqual(
			findIgnoredDeclaredPath([
				"src/switchyard/runner/index.mjs",
				"HISTORY.md",
			]),
			"HISTORY.md",
		);
	});

	it("executeTask rejects an ignored declared path before provider routing with declared_path_not_seeded", () => {
		const routeCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "edit history",
				description: "record update",
				requiredPaths: ["HISTORY.md"],
			},
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff",
					},
				},
				projectPath: TEST_DIR,
			},
		);

		strictEqual(routeCalls.length, 0, "must not route to any provider");
		strictEqual(result.success, false);
		strictEqual(result.provider, null);
		strictEqual(result.model, null);
		strictEqual(result.result, "declared_path_not_seeded");
		strictEqual(result.errorKind, "declared_path_not_seeded");
		strictEqual(result.reasonCode, "declared_path_not_seeded");
		strictEqual(
			result.reason,
			"The task declared a Git-ignored path that cannot be seeded or captured.",
		);
		ok(!result.reason.includes("HISTORY.md"));
	});

	it("executeTask preserves current behavior for tracked paths and unignored new files", () => {
		const routeCalls = [];
		const gateCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "valid work",
				description: "implementation",
				requiredPaths: [
					"src/switchyard/runner/index.mjs",
					"src/switchyard/new_untracked_test_file.mjs",
				],
			},
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: (diff, projectPath, options) => {
					gateCalls.push({ diff, projectPath, options });
					return { success: true, message: "ok" };
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(routeCalls.length, 1);
		strictEqual(result.success, true);
		strictEqual(gateCalls.length, 1);
	});

	it("executeTask preserves current behavior when requiredPaths is null", () => {
		const routeCalls = [];
		const result = executeTask(
			{
				id: "1.1",
				title: "review task",
				description: "no required paths",
				requiredPaths: null,
			},
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "",
					},
				},
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
			},
		);

		strictEqual(routeCalls.length, 1);
		strictEqual(result.success, true);
	});

	it("executeTaskWithOrchestrator rejects an ignored declared path before provider routing or launch", async () => {
		const routeCalls = [];
		let launches = 0;
		const result = await executeTaskWithOrchestrator(
			{
				id: "1.1",
				title: "edit tasks record",
				description: "update tasks",
				requiredPaths: ["TASKS.md"],
			},
			{
				route: (opts) => {
					routeCalls.push(opts);
					return {
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 80,
						reason: "spread",
					};
				},
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => {
						launches += 1;
						return "job-1";
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true, diff: "" }),
				},
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "",
					},
				},
				projectPath: TEST_DIR,
			},
		);

		strictEqual(routeCalls.length, 0);
		strictEqual(launches, 0);
		strictEqual(result.success, false);
		strictEqual(result.provider, null);
		strictEqual(result.result, "declared_path_not_seeded");
		strictEqual(result.errorKind, "declared_path_not_seeded");
		strictEqual(result.reasonCode, "declared_path_not_seeded");
		strictEqual(
			result.reason,
			"The task declared a Git-ignored path that cannot be seeded or captured.",
		);
		ok(!result.reason.includes("TASKS.md"));
	});

	it("executeTaskAsync rejects an ignored declared path before broker reservation or routing", async () => {
		let brokerCalled = false;
		const result = await executeTaskAsync(
			{
				id: "1.1",
				title: "edit tasks record",
				description: "update tasks",
				requiredPaths: ["TASKS.md"],
			},
			{
				broker: {
					selectAndReserve: async () => {
						brokerCalled = true;
						return null;
					},
				},
				projectPath: TEST_DIR,
			},
		);

		strictEqual(brokerCalled, false);
		strictEqual(result.success, false);
		strictEqual(result.provider, null);
		strictEqual(result.result, "declared_path_not_seeded");
	});

	it("the ignored-record regression rejects before dispatch with declared_path_not_seeded in runQueue", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Edit ignored local record
- **Status:** pending
- **Executor:** switchyard
- **Files:** HISTORY.md
- **Description:** append update to history
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const dispatches = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				resolveTargetIdentity: () => ({
					targetId: "claude-sonnet-5",
					harnessKey: "claude",
					ambiguous: false,
				}),
				route: () => {
					throw new Error(
						"route must not be called for an ignored declared path",
					);
				},
				recordDispatch: (entry) => dispatches.push(entry),
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff",
					},
				},
			},
		});

		strictEqual(dispatches.length, 0, "must not record dispatch to a provider");
		strictEqual(result.processedTasks, 1);
		deepStrictEqual(result.completedTaskIds, []);

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].result, "declared_path_not_seeded");
		strictEqual(checkpoint.results[0].success, false);
		strictEqual(checkpoint.results[0].errorKind, "declared_path_not_seeded");
		strictEqual(checkpoint.results[0].reasonCode, "declared_path_not_seeded");
		strictEqual(
			checkpoint.results[0].reason,
			"The task declared a Git-ignored path that cannot be seeded or captured.",
		);
		ok(!checkpoint.results[0].reason.includes("HISTORY.md"));
	});
});

describe("typed checkpoint identity failures (Task 1.3)", () => {
	it("task-file mismatch throws CheckpointIdentityError with checkpoint_task_file_mismatch", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions = normalizeRunOptions({ checkpointPath });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: "/other/nonexistent/tasks.md",
				queueIdentity,
				runOptions,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, { queueIdentity, runOptions });
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_task_file_mismatch");
		strictEqual(thrown.reasonCode, "checkpoint_task_file_mismatch");
		strictEqual(thrown.diagnosticCode, "checkpoint_task_file_mismatch");
		ok(thrown.reason.includes("checkpoint task file mismatch"));
		ok(
			!thrown.message.includes("/other/nonexistent/tasks.md"),
			"must not leak host paths",
		);
		ok(
			!thrown.reason.includes("/other/nonexistent/tasks.md"),
			"must not leak host paths in reason",
		);
	});

	it("missing queue identity throws CheckpointIdentityError with checkpoint_missing_queue_identity", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions = normalizeRunOptions({ checkpointPath });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, { queueIdentity, runOptions });
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_missing_queue_identity");
		strictEqual(thrown.reasonCode, "checkpoint_missing_queue_identity");
		strictEqual(thrown.diagnosticCode, "checkpoint_missing_queue_identity");
		ok(thrown.reason.includes("missing queueIdentity"));
	});

	it("queue-identity mismatch throws CheckpointIdentityError with checkpoint_queue_identity_mismatch", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions = normalizeRunOptions({ checkpointPath });

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksPath,
				queueIdentity: "a".repeat(64),
				runOptions,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, {
				queueIdentity: "b".repeat(64),
				runOptions,
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_queue_identity_mismatch");
		strictEqual(thrown.reasonCode, "checkpoint_queue_identity_mismatch");
		strictEqual(thrown.diagnosticCode, "checkpoint_queue_identity_mismatch");
		ok(thrown.reason.includes("queue identity mismatch"));
		deepStrictEqual(thrown.changedDimensions, ["queueIdentity"]);
		strictEqual(thrown.freshCheckpointPath, "switchyard-fresh.checkpoint.json");
		ok(thrown.message.includes("switchyard-fresh.checkpoint.json"));
	});

	it("run-options mismatch throws CheckpointIdentityError with checkpoint_run_options_mismatch", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions1 = normalizeRunOptions({ checkpointPath, maxTasks: 1 });
		const runOptions2 = normalizeRunOptions({ checkpointPath, maxTasks: 2 });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksPath,
				queueIdentity,
				runOptions: runOptions2,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, {
				queueIdentity,
				runOptions: runOptions1,
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_run_options_mismatch");
		strictEqual(thrown.reasonCode, "checkpoint_run_options_mismatch");
		strictEqual(thrown.diagnosticCode, "checkpoint_run_options_mismatch");
		ok(thrown.reason.includes("normalized run options changed"));
	});

	for (const [field, value] of [
		["taskIds", ["9.9"]],
		["excludeProviders", ["claude"]],
	]) {
		it(`reports ${field} for normalized checkpoint option mismatch`, () => {
			const tasksPath = writeTasksFile(
				"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
			);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const expectedOptions = normalizeRunOptions({ checkpointPath });
			const storedOptions = normalizeRunOptions({
				checkpointPath,
				[field]: value,
			});
			const queueIdentity = createQueueIdentity({
				tasksFilePath: tasksPath,
				markdown: readFileSync(tasksPath, "utf8"),
				tasks: loadTaskQueue(tasksPath),
				projectRevision: "rev-1",
				runOptions: expectedOptions,
			});
			writeFileSync(
				checkpointPath,
				JSON.stringify({
					version: 2,
					tasksFilePath: tasksPath,
					queueIdentity,
					runOptions: storedOptions,
					completedTaskIds: [],
					results: [],
				}),
				"utf8",
			);
			throws(
				() =>
					loadCheckpoint(checkpointPath, tasksPath, {
						queueIdentity,
						runOptions: expectedOptions,
					}),
				(error) => {
					strictEqual(error.code, "checkpoint_run_options_mismatch");
					deepStrictEqual(error.changedDimensions, [field]);
					return true;
				},
			);
		});
	}

	it("historical checkpoint throws CheckpointIdentityError with checkpoint_historical_checkpoint", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 1,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			loadCheckpoint(checkpointPath, tasksPath, {
				queueIdentity: "a".repeat(64),
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"must be CheckpointIdentityError",
		);
		strictEqual(thrown.name, "CheckpointIdentityError");
		strictEqual(thrown.code, "checkpoint_historical_checkpoint");
		strictEqual(thrown.reasonCode, "checkpoint_historical_checkpoint");
		strictEqual(thrown.diagnosticCode, "checkpoint_historical_checkpoint");
		ok(thrown.reason.includes("historical state without queue identity"));
	});

	it("five checkpoint identity regressions emit distinct static codes", () => {
		const codes = [
			CHECKPOINT_IDENTITY_CODES.TASK_FILE_MISMATCH,
			CHECKPOINT_IDENTITY_CODES.MISSING_QUEUE_IDENTITY,
			CHECKPOINT_IDENTITY_CODES.QUEUE_IDENTITY_MISMATCH,
			CHECKPOINT_IDENTITY_CODES.RUN_OPTIONS_MISMATCH,
			CHECKPOINT_IDENTITY_CODES.HISTORICAL_CHECKPOINT,
		];
		const uniqueCodes = new Set(codes);
		strictEqual(uniqueCodes.size, 5, "five distinct codes defined");
		deepStrictEqual(codes, [
			"checkpoint_task_file_mismatch",
			"checkpoint_missing_queue_identity",
			"checkpoint_queue_identity_mismatch",
			"checkpoint_run_options_mismatch",
			"checkpoint_historical_checkpoint",
		]);
	});

	it("the run-options mismatch regression emits checkpoint_run_options_mismatch in runQueue", () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions1 = normalizeRunOptions({ checkpointPath, maxTasks: 1 });
		const runOptions2 = normalizeRunOptions({ checkpointPath, maxTasks: 2 });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksPath,
				queueIdentity,
				runOptions: runOptions2,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		let thrown = null;
		try {
			runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				runOptions: runOptions1,
				queueIdentity,
				projectRevision: "rev-1",
				dependencies: {
					route: () => ({ provider: "claude", model: "claude-sonnet-5" }),
					integrationGate: () => ({ success: true }),
					adapters: {},
				},
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"runQueue must throw CheckpointIdentityError",
		);
		strictEqual(thrown.code, "checkpoint_run_options_mismatch");
	});

	it("the run-options mismatch regression emits checkpoint_run_options_mismatch in runQueueAsync", async () => {
		const tasksPath = writeTasksFile(
			"### Task 1.1: T\n- **Status:** pending\n- **Files:** src/a.mjs\n- **Description:** T\n",
		);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runOptions1 = normalizeRunOptions({ checkpointPath, maxTasks: 1 });
		const runOptions2 = normalizeRunOptions({ checkpointPath, maxTasks: 2 });
		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksPath,
			markdown: readFileSync(tasksPath, "utf8"),
			tasks: loadTaskQueue(tasksPath),
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksFileOrTasksPath(tasksPath),
				queueIdentity,
				runOptions: runOptions2,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		function tasksFileOrTasksPath(p) {
			return p;
		}

		let thrown = null;
		try {
			await runQueueAsyncImpl({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				runOptions: runOptions1,
				queueIdentity,
				projectRevision: "rev-1",
			});
		} catch (error) {
			thrown = error;
		}

		ok(
			thrown instanceof CheckpointIdentityError,
			"runQueueAsync must throw CheckpointIdentityError",
		);
		strictEqual(thrown.code, "checkpoint_run_options_mismatch");
	});
});

describe("preserve closed integration rejection codes (Task 1.3)", () => {
	const CLOSED_INTEGRATION_FIXTURES = [
		{
			name: "empty_required_diff",
			code: "empty_required_diff",
			gateResult: { success: false, message: "empty_required_diff" },
		},
		{
			name: "required_paths_missing",
			code: "required_paths_missing",
			gateResult: { success: false, message: "required_paths_missing" },
		},
		{
			name: "undeclared_paths_touched",
			code: "undeclared_paths_touched",
			gateResult: { success: false, message: "undeclared_paths_touched" },
		},
		{
			name: "no_op_diff",
			code: "no_op_diff",
			gateResult: { success: false, message: "no_op_diff" },
		},
		{
			name: "empty_diff",
			code: "empty_diff",
			gateResult: {
				success: false,
				message: "empty diff",
				reasonKind: "empty_diff",
			},
		},
		{
			name: "path_escapes_project_root",
			code: "path_escapes_project_root",
			gateResult: {
				success: false,
				message: "path escapes project root: /outside",
				reasonKind: "path_escapes_project_root",
			},
		},
		{
			name: "git_internals_touched",
			code: "git_internals_touched",
			gateResult: {
				success: false,
				message: "diff touches .git directory",
				reasonKind: "git_internals_touched",
			},
		},
		{
			name: "credential_path_touched",
			code: "credential_path_touched",
			gateResult: {
				success: false,
				message: "diff touches credential file: .env",
				reasonKind: "credential_path_touched",
				credentialFlagged: true,
			},
		},
		{
			name: "symlink_creation_refused",
			code: "symlink_creation_refused",
			gateResult: {
				success: false,
				message: "refusing to create symlink: link",
				reasonKind: "symlink_creation_refused",
			},
		},
		{
			name: "executable_file_refused",
			code: "executable_file_refused",
			gateResult: {
				success: false,
				message: "refusing executable mode: bin.sh",
				reasonKind: "executable_file_refused",
			},
		},
		{
			name: "manifest_review_required",
			code: "manifest_review_required",
			gateResult: {
				success: false,
				message:
					"diff touches a build/execution manifest file and requires AllowManifests: true",
				reasonKind: "manifest_review_required",
			},
		},
		{
			name: "corrupt_patch",
			code: "corrupt_patch",
			gateResult: {
				success: false,
				message: "diff could not be parsed by git apply",
				reasonKind: "corrupt_patch",
			},
		},
		{
			name: "conflict",
			code: "conflict",
			gateResult: {
				success: false,
				message: "Diff apply failed",
				reasonKind: "conflict",
			},
		},
		{
			name: "integration_state_unknown",
			code: "integration_state_unknown",
			gateResult: {
				success: false,
				message: "Diff apply failed",
				reasonKind: "integration_state_unknown",
			},
		},
	];

	it("contains fixtures for every closed integration rejection code", () => {
		const expectedCodes = new Set([
			"empty_required_diff",
			"required_paths_missing",
			"undeclared_paths_touched",
			"no_op_diff",
			...INTEGRATION_REFUSAL_KINDS,
		]);
		strictEqual(CLOSED_INTEGRATION_FIXTURES.length, expectedCodes.size);
		strictEqual(CLOSED_INTEGRATION_FIXTURES.length, 14);
		for (const fixture of CLOSED_INTEGRATION_FIXTURES) {
			ok(
				expectedCodes.has(fixture.code),
				`${fixture.code} is not an expected closed integration code`,
			);
		}
	});

	for (const fixture of CLOSED_INTEGRATION_FIXTURES) {
		it(`preserves closed rejection '${fixture.name}' across result, event, checkpoint, lastFailure, and caller projection in runQueue`, () => {
			const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Integration rejection task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Test preservation of ${fixture.name}
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const events = [];
			const dispatches = [];

			const queueResult = runQueue({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				workingContainerName: "fake-container",
				checkpointPath,
				dependencies: {
					onStatus: (e) => events.push(e),
					route: () => ({
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 70,
						reason: "spread",
					}),
					recordDispatch: (entry) => dispatches.push(entry),
					integrationGate: () => fixture.gateResult,
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
						},
					},
				},
			});

			// 1. Caller projection / result
			strictEqual(queueResult.results.length, 1);
			const [taskResult] = queueResult.results;
			strictEqual(taskResult.success, false);
			strictEqual(taskResult.result, "integration_failed");
			strictEqual(taskResult.diagnosticCode, fixture.code);

			// 2. Events (gate_validated and task_failed)
			const gateValidatedEvent = events.find(
				(e) => e.event === "gate_validated",
			);
			ok(gateValidatedEvent, "gate_validated event emitted");
			strictEqual(gateValidatedEvent.outcome, "rejected");
			strictEqual(gateValidatedEvent.diagnosticCode, fixture.code);

			const taskFailedEvent = events.find((e) => e.event === "task_failed");
			ok(taskFailedEvent, "task_failed event emitted");
			strictEqual(taskFailedEvent.diagnosticCode, fixture.code);

			// 3. Checkpoint (in-memory and durable JSON file)
			const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
			strictEqual(checkpoint.results[0].success, false);
			strictEqual(checkpoint.results[0].diagnosticCode, fixture.code);

			const durableCheckpoint = JSON.parse(
				readFileSync(checkpointPath, "utf8"),
			);
			strictEqual(durableCheckpoint.results[0].diagnosticCode, fixture.code);

			// 4. lastFailure projection
			const lastFailure = sanitizeFailureMetadata(taskResult);
			strictEqual(lastFailure.diagnosticCode, fixture.code);
			strictEqual(lastFailure.errorKind, "integration_failed");
			strictEqual(lastFailure.reasonCode, "integration_failed");

			// 5. Caller projection via executeTask
			const singleResult = executeTask(
				{
					id: "1.1",
					title: "task",
					description: "test",
					requiredPaths: ["src/a.mjs"],
				},
				{
					route: () => ({
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 70,
						reason: "spread",
					}),
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => fixture.gateResult,
					adapters: {
						claude: {
							execute: () => ({ success: true, output: "ok" }),
							captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
			);
			strictEqual(singleResult.diagnosticCode, fixture.code);
		});
	}

	it("projects reasonKind first when both reasonKind and allowlisted message are present", () => {
		const result = integrationFailureMetadata("t-1", "", false, {
			success: false,
			reasonKind: "conflict",
			message: "no_op_diff",
		});
		strictEqual(result.diagnosticCode, "conflict");
	});

	it("accepts allowlisted structural codes via message when reasonKind is absent", () => {
		for (const kind of [
			"empty_required_diff",
			"required_paths_missing",
			"undeclared_paths_touched",
			"no_op_diff",
			...INTEGRATION_REFUSAL_KINDS.filter(
				(kind) => kind !== "integration_state_unknown",
			),
		]) {
			const result = integrationFailureMetadata("t-1", "", false, {
				success: false,
				message: kind,
			});
			strictEqual(result.diagnosticCode, kind);
		}
	});

	it("prefers reasonKind over an allowlisted message for diagnostic projection", () => {
		const result = integrationFailureMetadata("t-1", "", false, {
			success: false,
			reasonKind: "conflict",
			message: "empty_required_diff",
			diagnosticCode: "required_paths_missing",
		});
		strictEqual(result.diagnosticCode, "conflict");
	});

	it("does not infer integration_state_unknown from message text", () => {
		const result = integrationFailureMetadata("t-1", "", false, {
			success: false,
			message: "integration_state_unknown",
		});
		strictEqual(result.diagnosticCode, undefined);
	});

	it("discards untrusted diagnosticCode values when reasonKind/message are untrusted", () => {
		const arbitraryCode = "PROSE_CANARY_untrusted_diagnostic_code_abc_42";
		const result = integrationFailureMetadata("t-1", "", false, {
			success: false,
			message: arbitraryCode,
			diagnosticCode: arbitraryCode,
		});
		strictEqual(result.diagnosticCode, undefined);
	});

	it("arbitrary gate prose produces no match in durable and JSON fixtures", () => {
		const arbitraryProse = "PROSE_CANARY_arbitrary_untrusted_gate_prose_xyz_42";
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Arbitrary prose task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Test discarding arbitrary gate prose
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const events = [];

		const queueResult = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				onStatus: (e) => events.push(e),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 70,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: arbitraryProse,
					diagnosticCode: arbitraryProse,
				}),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/src/a.mjs b/src/a.mjs",
					},
				},
			},
		});

		const [taskResult] = queueResult.results;
		strictEqual(taskResult.diagnosticCode, undefined);
		strictEqual(taskResult.errorKind, "integration_failed");
		strictEqual(taskResult.reasonCode, "integration_failed");

		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.results[0].diagnosticCode, undefined);

		const gateValidatedEvent = events.find((e) => e.event === "gate_validated");
		ok(gateValidatedEvent);
		strictEqual(gateValidatedEvent.diagnosticCode, undefined);

		const taskFailedEvent = events.find((e) => e.event === "task_failed");
		ok(taskFailedEvent);
		strictEqual(taskFailedEvent.diagnosticCode, undefined);

		const lastFailure = sanitizeFailureMetadata(taskResult);
		strictEqual(lastFailure.diagnosticCode, undefined);

		// Assert that arbitrary prose text is NEVER matched in any serialized/durable fixture
		ok(!JSON.stringify(taskResult).includes(arbitraryProse));
		ok(!JSON.stringify(checkpoint).includes(arbitraryProse));
		ok(!JSON.stringify(events).includes(arbitraryProse));
		ok(!JSON.stringify(lastFailure).includes(arbitraryProse));
		const rawCheckpointOnDisk = readFileSync(checkpointPath, "utf8");
		ok(!rawCheckpointOnDisk.includes(arbitraryProse));
	});

	it("preserves every closed rejection code in executeTaskAsync and executeTaskWithOrchestrator", async () => {
		for (const fixture of CLOSED_INTEGRATION_FIXTURES) {
			const invocationDescriptor = descriptorForRoute({
				provider: "claude",
				model: "claude-sonnet-5",
			});
			const selectedRoute = {
				reservation: { id: "res-1" },
				provider: "claude",
				model: "claude-sonnet-5",
				resolvedTarget: "claude",
				harness: "claude",
				capability: "standard",
				effort: null,
				percentLeft: 70,
				reason: "spread",
				snapshotIdentity: {
					status: "fresh",
					mtime: new Date().toISOString(),
					ageMs: 0,
				},
			};
			const asyncResult = await executeTaskAsync(
				{
					id: "1.1",
					title: "task",
					description: "test",
					requiredPaths: ["src/a.mjs"],
				},
				{
					broker: {
						selectAndReserve: async () => selectedRoute,
						launcherIdentity: () => ({
							provider: selectedRoute.provider,
							resolvedTarget: selectedRoute.resolvedTarget,
							harness: selectedRoute.harness,
							model: selectedRoute.model,
							effort: selectedRoute.effort,
							descriptorIdentity: invocationDescriptor.descriptor_identity,
							reservationId: selectedRoute.reservation.id,
						}),
						execute: async () => ({ success: true }),
						release: async () => {},
					},
					resolveDescriptor: () => invocationDescriptor,
					recordDispatch: async () => {},
					recordDispatchIntent: async () => {},
					integrationGate: () => fixture.gateResult,
					adapters: {
						claude: {
							executeAsync: async () => ({ success: true, output: "ok" }),
							captureDiffAsync: async () =>
								"diff --git a/src/a.mjs b/src/a.mjs",
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
			);
			strictEqual(
				asyncResult.diagnosticCode,
				fixture.code,
				`executeTaskAsync failed to preserve ${fixture.code}`,
			);

			const orchEvents = [];
			const orchResult = await executeTaskWithOrchestrator(
				{
					id: "1.1",
					title: "task",
					description: "test",
					requiredPaths: ["src/a.mjs"],
				},
				{
					route: () => ({
						provider: "claude",
						model: "claude-sonnet-5",
						percentLeft: 70,
						reason: "spread",
					}),
					recordDispatch: async () => {},
					recordDispatchIntent: () => {},
					integrationGate: () => fixture.gateResult,
					orchestrator: {
						launch: async () => "job-1",
						status: async () => ({ state: "done" }),
						result: async () => ({
							success: true,
							diff: "diff --git a/src/a.mjs b/src/a.mjs",
						}),
					},
					onStatus: (e) => orchEvents.push(e),
					projectPath: TEST_DIR,
					workingContainerName: "fake-container",
				},
			);
			strictEqual(
				orchResult.diagnosticCode,
				fixture.code,
				`executeTaskWithOrchestrator failed to preserve ${fixture.code}`,
			);
			const orchGateValidated = orchEvents.find(
				(e) => e.event === "gate_validated",
			);
			ok(orchGateValidated);
			strictEqual(orchGateValidated.diagnosticCode, fixture.code);
		}
	});
});

describe("carry real cause through runner terminal projections (Task 1.4)", () => {
	it("carries trusted diagnostic and exact route provenance into checkpoint and run-store state", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Structured provider failure
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** retain bounded diagnostic provenance
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];
		const dispatches = [];
		const statuses = [];
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "agy",
					model: "fixture-model",
					resolvedTargetId: "agy-gemini",
					percentLeft: 70,
					reason: "spread",
				}),
				recordDispatch: (entry) => dispatches.push(entry),
				onStatus: (event) => statuses.push(event),
				adapters: {
					agy: {
						execute: () => ({
							success: false,
							error: "SECRET_CANARY raw provider text",
							errorKind: "auth_expired",
							diagnosticCode: "auth_expired",
							diagnosticOrigin: "adapter",
							diagnosticEvidenceAvailable: true,
							failurePhase: "provider_execution",
							exitCode: 1,
						}),
						captureDiff: () => null,
					},
				},
				runStore: {
					updateRun: (partial) => {
						runStoreCalls.push({ ...partial });
						return Promise.resolve({ revision: 0 });
					},
				},
			},
		});
		await result.ledgerWritesSettled;
		const failure = result.results[0];
		const checkpointFailure = loadCheckpoint(checkpointPath, tasksPath)
			.results[0];
		const terminalFailure = runStoreCalls.find(
			(call) => call.state === "failed",
		).lastFailure;
		const dispatchFailure = dispatches.find(
			(entry) => entry.result === "execution_failed",
		);
		const statusFailure = statuses.find(
			(event) => event.event === "task_failed",
		);
		for (const value of [
			failure,
			checkpointFailure,
			terminalFailure,
			dispatchFailure,
			statusFailure,
		]) {
			ok(value, "sync failure projection is present");
			strictEqual(value.diagnosticCode, "auth_expired");
			strictEqual(value.diagnosticOrigin, "adapter");
			strictEqual(value.diagnosticEvidenceAvailable, false);
			strictEqual(value.diagnosticRef ?? null, null);
		}
		for (const value of [
			failure,
			checkpointFailure,
			terminalFailure,
			dispatchFailure,
		]) {
			strictEqual(value.resolvedTargetId, "agy-gemini");
			strictEqual(value.descriptorHarness, "agy");
			match(value.descriptorIdentity, /^sha256:[a-f0-9]{64}$/);
		}
		ok(!readFileSync(checkpointPath, "utf8").includes("SECRET_CANARY"));
	});
	it("runQueue terminal projection carries sanitized lastFailure and terminalizedBy on task failure", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Integration rejection task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Integration failure test
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 70,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({
					success: false,
					message: "empty_required_diff",
				}),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "failed");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
		strictEqual(terminalCall.terminalizedBy, "worker");
		ok(terminalCall.lastFailure, "lastFailure present on failed run");
		ok(isPersistentFailureMetadata(terminalCall.lastFailure));
		strictEqual(terminalCall.lastFailure.errorKind, "integration_failed");
		strictEqual(terminalCall.lastFailure.diagnosticCode, "empty_required_diff");
		notStrictEqual(terminalCall.lastFailure.errorKind, "unclassified");
	});

	it("runQueue terminal projection carries the LAST failed task's failure when multiple tasks run", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: First failed task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** First failure

### Task 1.2: Second failed task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Second failure
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		let execCount = 0;
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			stopOnFailure: false,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 70,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => {
							execCount += 1;
							if (execCount === 1) {
								return { success: false, error: "first execution failure" };
							}
							return {
								success: false,
								timedOut: true,
								error: "second timeout failure",
							};
						},
						captureDiff: () => "",
					},
				},
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "failed");
		strictEqual(terminalCall.terminalizedBy, "worker");
		ok(terminalCall.lastFailure);
		ok(isPersistentFailureMetadata(terminalCall.lastFailure));
		strictEqual(terminalCall.lastFailure.errorKind, "execution_timed_out");
		notStrictEqual(terminalCall.lastFailure.errorKind, "unclassified");
	});

	it("runQueue surfaces terminal updateRun rejection via outcome_projection_failed", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Simple task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Simple operation
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const statuses = [];
		const projectionFailures = [];

		const runStore = {
			updateRun: (partial) => {
				if (partial.state !== undefined) {
					const err = new Error("permission denied writing terminal run");
					err.code = "EACCES";
					return Promise.reject(err);
				}
				return Promise.resolve({ revision: 0 });
			},
		};

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				onStatus: (e) => statuses.push(e),
				onLedgerProjectionFailure: (m) => projectionFailures.push(m),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 70,
					reason: "spread",
				}),
				recordDispatch: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				adapters: {
					claude: {
						execute: () => ({ success: true, output: "ok" }),
						captureDiff: () => "diff --git a/a b/a",
					},
				},
				runStore,
			},
		});

		await result.ledgerWritesSettled;

		const outcomeFailedEvent = statuses.find(
			(e) => e.event === "outcome_projection_failed",
		);
		ok(outcomeFailedEvent, "emitted outcome_projection_failed event");
		strictEqual(outcomeFailedEvent.phase, "ledger");
		strictEqual(outcomeFailedEvent.ledgerFailureCode, "EACCES");
		strictEqual(projectionFailures.length, 1);
		strictEqual(projectionFailures[0].ledgerFailureCode, "EACCES");
	});

	it("runQueueWithOrchestrator terminal projection carries sanitized lastFailure and terminalizedBy on task failure", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Failing task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Orchestrator failure
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => {
						throw new Error("spawn failed");
					},
					status: async () => ({ state: "done" }),
					result: async () => ({ success: false }),
				},
				runStore,
			},
		});

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "failed");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
		strictEqual(terminalCall.terminalizedBy, "worker");
		ok(
			terminalCall.lastFailure,
			"lastFailure present on failed orchestrator run",
		);
		ok(isPersistentFailureMetadata(terminalCall.lastFailure));
		strictEqual(terminalCall.lastFailure.errorKind, "launch_failed");
		notStrictEqual(terminalCall.lastFailure.errorKind, "unclassified");
	});

	it("runQueueWithOrchestrator terminal projection sets terminalizedBy: 'worker' and no lastFailure on success", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Success task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Orchestrator success
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runStoreCalls = [];

		const runStore = {
			updateRun: (partial) => {
				runStoreCalls.push({ ...partial });
				return Promise.resolve({ revision: 0 });
			},
		};

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				runStore,
			},
		});

		const terminalCall = runStoreCalls.find((c) => c.state !== undefined);
		ok(terminalCall, "terminal updateRun call present");
		strictEqual(terminalCall.state, "succeeded");
		strictEqual(terminalCall.activeTaskId, null);
		strictEqual(terminalCall.cleanupState, "complete");
		strictEqual(terminalCall.terminalizedBy, "worker");
		strictEqual(terminalCall.lastFailure, undefined);
	});

	it("runQueueWithOrchestrator surfaces terminal updateRun rejection via outcome_projection_failed", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Success task
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** Orchestrator success
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const statuses = [];
		const projectionFailures = [];

		const runStore = {
			updateRun: (partial) => {
				if (partial.state !== undefined) {
					const err = new Error("readonly filesystem");
					err.code = "EROFS";
					return Promise.reject(err);
				}
				return Promise.resolve({ revision: 0 });
			},
		};

		await runQueueWithOrchestrator({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			workingContainerName: "fake-container",
			checkpointPath,
			dependencies: {
				onStatus: (e) => statuses.push(e),
				onLedgerProjectionFailure: (m) => projectionFailures.push(m),
				route: () => ({
					provider: "claude",
					model: "claude-sonnet-5",
					percentLeft: 65,
					reason: "spread",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				integrationGate: () => ({ success: true, message: "ok" }),
				orchestrator: {
					launch: async () => "job-1",
					status: async () => ({ state: "done" }),
					result: async () => ({
						success: true,
						diff: "diff --git a/a b/a",
					}),
				},
				runStore,
			},
		});

		const outcomeFailedEvent = statuses.find(
			(e) => e.event === "outcome_projection_failed",
		);
		ok(outcomeFailedEvent, "emitted outcome_projection_failed event");
		strictEqual(outcomeFailedEvent.phase, "ledger");
		strictEqual(outcomeFailedEvent.ledgerFailureCode, "EROFS");
		strictEqual(projectionFailures.length, 1);
		strictEqual(projectionFailures[0].ledgerFailureCode, "EROFS");
	});
});
