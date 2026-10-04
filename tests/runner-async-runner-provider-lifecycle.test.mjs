import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	descriptorForRoute,
	runnerTestDir,
	runQueue,
	runQueueAsync,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
afterEach(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("async runner provider lifecycle", () => {
	it("awaits executeAsync before returning a terminal task result", async () => {
		const root = join(TEST_DIR, "async-lifecycle");
		mkdirSync(root, { recursive: true });
		const tasksPath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		writeFileSync(
			tasksPath,
			"### Task 4.1: Async provider\n- **Status:** pending\n- **Type:** implementation\n- **Files:** src/switchyard/runner/index.mjs\n- **Description:** exercise async lifecycle\n- **Executor:** switchyard\n- **Quick checks:** none\n",
		);
		const descriptor = descriptorForRoute({
			provider: "opencode",
			resolved_harness: "opencode",
			resolvedTargetId: "async-target",
			model: "fake-model",
		});
		let settled = false;
		const routeOptions = [];
		const typedOutcomes = [];
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: root,
			workingContainerName: "async-worker",
			checkpointPath,
			runId: "typed-async-lifecycle",
			dependencies: {
				enableNonProviderOutcomes: true,
				outcomeWriterEpoch: "epoch-typed-async-lifecycle",
				recordOutcomeEvent: async (outcome) => typedOutcomes.push(outcome),
				integrationGate: () => ({ success: true }),
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
							return {
								success: true,
								output: JSON.stringify({ verdict: "clean", findings: [] }),
							};
						},
						captureDiff: () => null,
						captureDiffAsync: async () => "",
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
		for (const requiredStage of [
			"worker",
			"run",
			"preflight",
			"provider",
			"artifact",
			"integration",
			"postcondition",
		]) {
			ok(
				typedOutcomes.some(({ stage }) => stage === requiredStage),
				`missing typed ${requiredStage} production fact`,
			);
		}
		const artifactOutcome = typedOutcomes.find(
			({ stage }) => stage === "artifact",
		);
		const integrationOutcome = typedOutcomes.find(
			({ stage }) => stage === "integration",
		);
		strictEqual(artifactOutcome.status, "succeeded");
		strictEqual(artifactOutcome.detail.code, "artifact_capture");
		strictEqual(integrationOutcome.status, "succeeded");
		strictEqual(integrationOutcome.detail.code, "integration_gate");
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
				"### Task 4.2: Diagnostic producer\n- **Status:** pending\n- **Type:** implementation\n- **Files:** src/switchyard/runner/index.mjs\n- **Description:** exercise persistence\n- **Executor:** switchyard\n- **Quick checks:** none\n",
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
			"### Task 4.3: Synchronous diagnostic\n- **Status:** pending\n- **Type:** implementation\n- **Files:** src/switchyard/runner/index.mjs\n- **Description:** reject unretained evidence\n- **Executor:** switchyard\n- **Quick checks:** none\n",
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
				integrationGate: () => ({ success: true }),
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
			"### Task 4.2: Heartbeat\n- **Status:** pending\n- **Type:** implementation\n- **Files:** src/switchyard/runner/index.mjs\n- **Description:** heartbeat\n- **Executor:** switchyard\n- **Quick checks:** none\n",
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
				integrationGate: () => ({ success: true }),
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
							return {
								success: true,
								output: JSON.stringify({ verdict: "clean", findings: [] }),
							};
						},
						captureDiffAsync: async () => "",
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
});
