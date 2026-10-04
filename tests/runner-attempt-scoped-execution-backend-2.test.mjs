import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_SILENCE_TIMEOUT_MS } from "../src/switchyard/adapter/provider-lifecycle.mjs";
import { validateTaskStartTreeAsync } from "../src/switchyard/lifecycle/index.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { createBrokerAdapterLauncher } from "../src/switchyard/runner/index.mjs";
import {
	executeTaskAsync,
	runnerTestDir,
	TASK_BASE,
	testDescriptor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
const VALID_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
describe("attempt-scoped execution backend", () => {
	it("binds the same immutable context through the broker launcher", async () => {
		let observed;
		let observedExecutionOptions;
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
					observedExecutionOptions = options;
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
			onProgress: () => {},
		});
		ok(Object.isFrozen(observed));
		strictEqual(observed.attemptId, "attempt-b");
		strictEqual(
			observedExecutionOptions.silenceTimeoutMs,
			DEFAULT_SILENCE_TIMEOUT_MS,
		);
		strictEqual(typeof observedExecutionOptions.onProgress, "function");
	});
	it("lets agy reach its own print timeout before the silence cutoff", async () => {
		let observedSilenceTimeoutMs;
		const descriptor = testDescriptor();
		const launch = createBrokerAdapterLauncher({
			adapter: {
				executeAsync: async (_prompt, _workspace, options) => {
					observedSilenceTimeoutMs = options.silenceTimeoutMs;
					return { success: true, output: "ok" };
				},
			},
			executionBackend: {},
			workingContainerName: "vm",
			prompt: "fixture",
		});
		const route = {
			provider: "Antigravity",
			resolvedTarget: "antigravity",
			harness: "agy",
			model: descriptor.selector,
			effort: null,
			reservation: { id: "reservation-1" },
		};
		await launch({
			request: { taskId: "1.4", attemptId: "attempt-agy" },
			route,
			invocationDescriptor: descriptor,
			launcherIdentity: {
				...route,
				descriptorIdentity: descriptor.descriptor_identity,
				reservationId: "reservation-1",
			},
			onProgress: () => {},
		});
		strictEqual(observedSilenceTimeoutMs, 10 * 60 * 1000);
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
			const providerLifecycle = {
				schemaVersion: 1,
				pid: 4321,
				startedAt: "2026-09-15T12:00:00.000Z",
				deadlineAt: "2026-09-15T12:05:00.000Z",
				lastOutputAt: null,
				silenceObserved: true,
				silenceTimeoutMs: 300_000,
				terminalStatus: "terminated",
				terminationReason: "deadline",
				exitCode: null,
				signal: "SIGKILL",
				writerLifecycle: "stopped",
				cleanupStatus: "succeeded",
				cleanupStage: null,
			};
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
							providerLifecycle,
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
								return "";
							},
						},
					},
					projectPath: TEST_DIR,
					workingContainerName: "vm",
				},
			);
			strictEqual(result.success, success);
			deepStrictEqual(result.providerLifecycle, providerLifecycle);
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
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
