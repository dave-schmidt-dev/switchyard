import { rejects, strictEqual } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReservationLedger } from "../src/switchyard/broker/reservations.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import { route as productionRoute } from "../src/switchyard/router/index.mjs";
import { runQueueAsync } from "../src/switchyard/runner/index.mjs";

function descriptor(target, model) {
	const core = {
		target_id: target,
		model_ref: model,
		selector: model,
		effort: null,
		variant: null,
		invocation_args: [],
	};
	return {
		...core,
		descriptor_identity: getInvocationDescriptorIdentity(core, "claude"),
	};
}

test("production async runner uses broker reservation, fallback, and adapter launch", async () => {
	const root = await mkdtemp(join(tmpdir(), "switchyard-production-broker-"));
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Broker task\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **RequiredCapability:** high\n- **RequiredCapabilityJustification:** Production broker fallback must preserve the requested high capability.\n- **Description:** exercise production broker\n",
	);
	const calls = [];
	const dispatches = [];
	const intents = [];
	let snapshotReads = 0;
	const adapters = {
		claude: {
			executeAsync: async (_prompt, _container, options) => {
				calls.push(options.resolvedTargetId);
				return { success: calls.length > 1 };
			},
			captureDiffAsync: async () => null,
		},
	};
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			adapters,
			readSnapshot: () => {
				snapshotReads += 1;
				return {
					snapshot: {
						schema_version: 2,
						updated_at: new Date().toISOString(),
						providers: [],
					},
					snapshotMtime: 1,
				};
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: (intent) => intents.push(intent),
			route: ({ exclude, requiredCapability }) => {
				const target = exclude.includes("Cheap") ? "expensive" : "cheap";
				return {
					provider: target === "cheap" ? "Cheap" : "Expensive",
					resolvedTargetId: target,
					resolved_harness: "claude",
					model: `${target}-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: (provider) => ({
				targetId: provider.toLowerCase(),
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (target, capability) => {
				return descriptor(
					target.toLowerCase(),
					`${target.toLowerCase()}-${capability}`,
				);
			},
		},
	});
	strictEqual(result.results[0].success, true);
	strictEqual(result.results[0].requiredCapability, "high");
	strictEqual(result.results[0].resolvedTargetId, "expensive");
	strictEqual(calls.length, 2);
	strictEqual(calls[0], "cheap");
	strictEqual(calls[1], "expensive");
	strictEqual(intents.length, 2);
	strictEqual(intents[0].provider, "Cheap");
	strictEqual(intents[1].provider, "Expensive");
	strictEqual(dispatches.length, 2);
	strictEqual(dispatches[0].provider, "Cheap");
	strictEqual(dispatches[0].result, "execution_failed");
	strictEqual(dispatches[1].provider, "Expensive");
	strictEqual(dispatches[1].result, "success_no_diff");
	strictEqual(snapshotReads >= 2, true);
	const projectLedger = JSON.parse(
		await readFile(
			join(root, ".logs", "switchyard", "broker", "reservations.json"),
			"utf8",
		),
	);
	strictEqual(
		projectLedger.reservations.length === 2 &&
			projectLedger.reservations.every((entry) =>
				["released", "reconciled"].includes(entry.state),
			),
		true,
	);
});

test("production async broker forwards adapter status and heartbeats", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-status-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Status\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** status\n",
	);
	const invocation = descriptor("cheap", "cheap-standard");
	const statusEvents = [];
	const heartbeats = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-status-worker",
		checkpointPath,
		dependencies: {
			onStatus: (event) => statusEvents.push(event),
			onTaskHeartbeat: (event) => heartbeats.push(event),
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => invocation,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						options.onStatus?.({
							phase: "execution",
							event: "provider_cleanup_started",
							status: "cleanup",
						});
						options.onPoll?.({ elapsedMs: 42 });
						return { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
		},
	});
	strictEqual(result.results[0].success, true);
	strictEqual(
		statusEvents.some((event) => event.event === "provider_cleanup_started"),
		true,
	);
	strictEqual(heartbeats.length, 1);
	strictEqual(heartbeats[0].elapsedMs, 42);
	strictEqual(heartbeats[0].processPhase, "provider_running");
});

test("production async runner drains a dependency chain in one bounded run", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-chain-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: A\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** A\n\n### Task 1.2: B\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Blocked by:** 1.1\n- **Description:** B\n",
	);
	const calls = [];
	const invocation = descriptor("cheap", "cheap-standard");
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-chain-worker",
		checkpointPath,
		maxTasks: 2,
		dependencies: {
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => invocation,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			adapters: {
				claude: {
					executeAsync: async (prompt) => {
						calls.push(prompt);
						return { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
		},
	});
	strictEqual(result.processedTasks, 2);
	strictEqual(calls.length, 2);
	strictEqual(result.completedTaskIds.length, 2);
});

test("production async runner commits each task on an owned container", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-commit-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: A\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** A\n\n### Task 1.2: B\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** B\n",
	);
	const invocation = descriptor("cheap", "cheap-standard");
	let commits = 0;
	let resets = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		maxTasks: 2,
		dependencies: {
			backendFactory: () => ({
				executionBackend: {},
				ensureAgentContainer: () => {},
				create: () => "owned-async-commit-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {
					commits += 1;
				},
				reset: () => {
					resets += 1;
				},
			}),
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => invocation,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffAsync: async () => null,
				},
			},
		},
	});
	strictEqual(result.processedTasks, 2);
	strictEqual(commits, 2);
	strictEqual(resets, 0);
});

test("production async runner resets failed tasks before continuing on an owned container", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-reset-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Failed\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** reset this task\n\n### Task 1.2: Continued\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** continue after reset\n",
	);
	const invocation = descriptor("cheap", "cheap-standard");
	let executions = 0;
	let commits = 0;
	let resets = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		maxTasks: 2,
		stopOnFailure: false,
		dependencies: {
			backendFactory: () => ({
				executionBackend: {},
				ensureAgentContainer: () => {},
				create: () => "owned-async-reset-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {
					commits += 1;
				},
				reset: () => {
					resets += 1;
				},
			}),
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => invocation,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			adapters: {
				claude: {
					executeAsync: async () => {
						executions += 1;
						return executions === 1
							? { success: false, errorKind: "auth_expired" }
							: { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
		},
	});
	strictEqual(result.processedTasks, 2);
	strictEqual(result.results.length, 2);
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[1].success, true);
	strictEqual(resets, 1);
	strictEqual(commits, 1);
});

test("production async runner reconciles an explicitly selected completed task", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-already-complete-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Done\n- **Status:** done\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** already done\n",
	);
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "already-complete-worker",
		checkpointPath,
		taskIds: ["1.1"],
		dependencies: {
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			adapters: {},
		},
	});
	strictEqual(result.results.length, 1);
	strictEqual(result.results[0].result, "already_complete");
	strictEqual(result.processedTasks, 0);
});

test("production async runner fails closed on a persisted retry_started state", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-retry-resume-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Retry\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** retry\n",
	);
	const invocation = descriptor("cheap", "cheap-standard");
	const baseDependencies = {
		route: () => ({
			provider: "Cheap",
			resolvedTargetId: "cheap",
			resolved_harness: "claude",
			model: "cheap-standard",
			reason: "ranked",
		}),
		resolveTargetIdentity: () => ({
			targetId: "cheap",
			harnessKey: "claude",
			ambiguous: false,
		}),
		resolveDescriptor: () => invocation,
		recordDispatch: () => {},
		recordDispatchIntent: () => {},
	};
	await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-retry-worker",
		checkpointPath,
		maxTasks: 0,
		dependencies: {
			...baseDependencies,
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffAsync: async () => null,
				},
			},
		},
	});
	const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
	checkpoint.retryState = {
		taskId: "1.1",
		attempt: 2,
		phase: "retry_started",
		resolvedTargetId: "cheap",
		invocationDescriptor: invocation,
		descriptorIdentity: invocation.descriptor_identity,
		descriptorHarness: "claude",
	};
	checkpoint.quarantinedTargetIds = ["cheap"];
	await writeFile(checkpointPath, JSON.stringify(checkpoint));
	let launches = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-retry-worker",
		checkpointPath,
		dependencies: {
			...baseDependencies,
			adapters: {
				claude: {
					executeAsync: async () => {
						launches += 1;
						return { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
		},
	});
	strictEqual(launches, 0);
	strictEqual(result.results[0].result, "unknown_failure");
	strictEqual(result.results[0].errorKind, "unknown_failure");
	strictEqual(
		JSON.parse(await readFile(checkpointPath, "utf8")).retryState,
		null,
	);
});

test("production async runner isolates selection failures and releases early reservations", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-failure-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: First\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** first\n\n### Task 1.2: Second\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** second\n",
	);
	const ledger = createReservationLedger({ root: join(root, "ledger") });
	let routeCalls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		stopOnFailure: false,
		workingContainerName: "broker-production-worker",
		dependencies: {
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffAsync: async () => null,
				},
			},
			brokerReservations: ledger,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: ({ requiredCapability }) => {
				routeCalls += 1;
				if (routeCalls === 1) throw new Error("identity disagreement");
				return {
					provider: "Cheap",
					resolvedTargetId: "cheap",
					resolved_harness: "claude",
					model: `cheap-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (_target, capability) =>
				descriptor("cheap", `cheap-${capability}`),
		},
	});
	strictEqual(result.results.length, 2);
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[1].success, true);
	strictEqual((await ledger.inspect()).reservations.length, 1);
	strictEqual((await ledger.inspect()).reservations[0].state, "reconciled");
});

test("production async runner clears route state after a successful task before selection fails", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-state-isolation-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: First\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** succeeds\n\n### Task 1.2: Second\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** selection fails\n",
	);
	const dispatches = [];
	let routeCalls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		stopOnFailure: false,
		dependencies: {
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: ({ requiredCapability }) => {
				routeCalls += 1;
				if (routeCalls === 2) throw new Error("selection failed");
				return {
					provider: "Cheap",
					resolvedTargetId: "cheap",
					resolved_harness: "claude",
					model: `cheap-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (_target, capability) =>
				descriptor("cheap", `cheap-${capability}`),
		},
	});
	strictEqual(result.results[0].success, true);
	strictEqual(result.results[1].success, false);
	strictEqual(result.results[1].provider, null);
	strictEqual(result.results[1].model, null);
	strictEqual(result.results[1].errorKind, "unknown_failure");
	strictEqual(dispatches.at(-1).provider, "none");
});

test("production async runner records a fallback intent failure before launching it", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-fallback-intent-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Fallback intent\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** intent must precede fallback\n",
	);
	const ledger = createReservationLedger({ root: join(root, "ledger") });
	const calls = [];
	let intentCalls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						calls.push(options.resolvedTargetId);
						return { success: false };
					},
					captureDiffAsync: async () => null,
				},
			},
			brokerReservations: ledger,
			recordDispatch: () => {},
			recordDispatchIntent: () => {
				intentCalls += 1;
				if (intentCalls === 2) {
					const error = new Error("intent write denied");
					error.code = "EPERM";
					throw error;
				}
			},
			route: ({ exclude, requiredCapability }) => {
				const target = exclude.some(
					(identifier) => identifier.toLowerCase() === "cheap",
				)
					? "expensive"
					: "cheap";
				return {
					provider: target === "cheap" ? "Cheap" : "Expensive",
					resolvedTargetId: target,
					resolved_harness: "claude",
					model: `${target}-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: (provider) => ({
				targetId: provider.toLowerCase(),
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (target, capability) =>
				descriptor(
					target.toLowerCase(),
					`${target.toLowerCase()}-${capability}`,
				),
		},
	});
	strictEqual(result.results[0].result, "intent_receipt_failed");
	strictEqual(result.results[0].provider, "Expensive");
	strictEqual(calls.length, 1);
	strictEqual((await ledger.inspect()).reservations.length, 2);
	strictEqual(
		(await ledger.inspect()).reservations.every(
			(entry) => entry.state === "released",
		),
		true,
	);
});

test("production async runner preserves a broker precondition failure on retry", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-precondition-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Retry precondition\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** preserve bounded ledger identity\n",
	);
	const dispatches = [];
	let calls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		dependencies: {
			backendFactory: () => ({
				executionBackend: {},
				create: () => "owned-broker-precondition-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						calls += 1;
						if (calls === 2) {
							return {
								success: false,
								errorKind: "quota_exhausted",
								resolvedTargetId: options.resolvedTargetId,
							};
						}
						return { success: false };
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: ({ exclude, requiredCapability }) => {
				const excluded = exclude.map((entry) => entry.toLowerCase());
				const target = excluded.includes("expensive") ? "cheap" : "expensive";
				return {
					provider: target === "cheap" ? "Cheap" : "Expensive",
					resolvedTargetId: target,
					resolved_harness: "claude",
					model: `${target}-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: (provider) => ({
				targetId: provider.toLowerCase(),
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (target, capability) =>
				descriptor(
					target.toLowerCase(),
					`${target.toLowerCase()}-${capability}`,
				),
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].errorKind, "unknown_failure");
	strictEqual(
		dispatches.at(-1).ledgerFailureCode,
		"fallback_already_attempted",
	);
	strictEqual(calls, 3);
});

test("production async runner does not fallback a typed nonretryable failure", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-nonretryable-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Auth failure\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** no fallback\n",
	);
	const ledger = createReservationLedger({ root: join(root, "ledger") });
	const calls = [];
	const dispatches = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						calls.push(options.resolvedTargetId);
						return { success: false, errorKind: "auth_expired" };
					},
					captureDiffAsync: async () => null,
				},
			},
			brokerReservations: ledger,
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: ({ requiredCapability }) => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: `cheap-${requiredCapability}`,
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (_target, capability) =>
				descriptor("cheap", `cheap-${capability}`),
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].errorKind, "auth_expired");
	strictEqual(calls.length, 1);
	strictEqual(dispatches[0].errorKind, "auth_expired");
	strictEqual((await ledger.inspect()).reservations[0].state, "released");
});

test("production async runner records the routed provider when post-execution capture throws", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-postexecution-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Capture failure\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** preserve route identity\n",
	);
	const dispatches = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffAsync: async () => {
						throw new Error("capture failed");
					},
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => descriptor("cheap", "cheap-standard"),
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].provider, "Cheap");
	strictEqual(result.results[0].model, "cheap-standard");
	strictEqual(dispatches.at(-1).result, "execution_failed");
	strictEqual(dispatches.at(-1).provider, "Cheap");
});

test("production async runner records fallback after post-execution capture throws", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-fallback-postexecution-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Fallback capture failure\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** record both provider outcomes\n",
	);
	const dispatches = [];
	let executions = 0;
	let captures = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			adapters: {
				claude: {
					executeAsync: async () => {
						executions += 1;
						return executions === 1 ? { success: false } : { success: true };
					},
					captureDiffAsync: async () => {
						captures += 1;
						throw new Error("fallback capture failed");
					},
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: ({ exclude, requiredCapability }) => {
				const fallback = exclude.some(
					(identifier) => identifier.toLowerCase() === "cheap",
				);
				const target = fallback ? "expensive" : "cheap";
				return {
					provider: target === "cheap" ? "Cheap" : "Expensive",
					resolvedTargetId: target,
					resolved_harness: "claude",
					model: `${target}-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: (provider) => ({
				targetId: provider.toLowerCase(),
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (target, capability) =>
				descriptor(
					target.toLowerCase(),
					`${target.toLowerCase()}-${capability}`,
				),
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(executions, 2);
	strictEqual(captures, 1);
	strictEqual(dispatches.length, 2);
	strictEqual(dispatches[0].provider, "Cheap");
	strictEqual(dispatches[0].result, "execution_failed");
	strictEqual(dispatches[1].provider, "Expensive");
	strictEqual(dispatches[1].result, "execution_failed");
});

test("production async runner releases a reservation before an adapter precondition failure", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-release-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Missing adapter lifecycle\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** fail before launch\n",
	);
	const ledger = createReservationLedger({ root: join(root, "ledger") });
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			adapters: { claude: { captureDiffAsync: async () => null } },
			brokerReservations: ledger,
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: () => ({
				provider: "Cheap",
				resolvedTargetId: "cheap",
				resolved_harness: "claude",
				model: "cheap-standard",
				reason: "ranked",
			}),
			resolveTargetIdentity: () => ({
				targetId: "cheap",
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: () => descriptor("cheap", "cheap-standard"),
		},
	});
	strictEqual(result.results[0].result, "execution_failed");
	strictEqual((await ledger.inspect()).reservations[0].state, "released");
});

test("production async runner cleans up when broker construction fails closed", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-construction-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Missing project\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** fail closed\n",
	);
	let destroyed = 0;
	await rejects(
		runQueueAsync({
			tasksFilePath,
			projectPath: "",
			checkpointPath,
			projectRevision: "fixed",
			dependencies: {
				backendFactory: () => ({
					executionBackend: {},
					create: () => "owned-broker-construction-worker",
					destroy: () => {
						destroyed += 1;
					},
					seed: () => {},
					commit: () => {},
					reset: () => {},
				}),
			},
		}),
		/requires projectPath/,
	);
	strictEqual(destroyed, 1);
});

test("production router path coordinates the requested snapshot source", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-real-router-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Real router\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** use production router\n",
	);
	let seenSource = null;
	let calls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		only: ["claude"],
		dependencies: {
			adapters: {
				claude: {
					executeAsync: async () => {
						calls += 1;
						return { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: productionRoute,
			readSnapshot: ({ source, nowMs }) => {
				seenSource = source;
				return {
					snapshot: {
						schema_version: 2,
						updated_at: new Date(nowMs).toISOString(),
						providers: [
							{
								name: "Claude",
								ok: true,
								windows: [
									{
										id: "weekly",
										percent_left: 90,
										reset_iso: new Date(nowMs + 86_400_000).toISOString(),
										window_hours: 168,
										pace_delta: 0,
									},
								],
							},
						],
					},
					snapshotMtime: 1,
				};
			},
		},
	});
	strictEqual(
		result.results[0].success,
		true,
		JSON.stringify(result.results[0]),
	);
	strictEqual(calls, 1);
	strictEqual(seenSource, "gradus-v2");
});

test("production router path rejects an unknown snapshot source", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-unknown-source-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Unknown source\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** fail closed\n",
	);
	let calls = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-production-worker",
		checkpointPath,
		dependencies: {
			adapters: {
				claude: {
					executeAsync: async () => {
						calls += 1;
						return { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: productionRoute,
			snapshotSource: "not-configured",
		},
	});
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].errorKind, "unknown_failure");
	strictEqual(calls, 0);
});

test("production async runner quarantines quota targets and retries the same task once", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-quota-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Quota retry\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** retry once\n",
	);
	const calls = [];
	const dispatches = [];
	let resets = 0;
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		dependencies: {
			backendFactory: () => ({
				executionBackend: {},
				create: () => "unused",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {
					resets += 1;
				},
			}),
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						calls.push(options.resolvedTargetId);
						return calls.length === 1
							? { success: false, errorKind: "quota_exhausted" }
							: { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: (entry) => dispatches.push(entry),
			recordDispatchIntent: () => {},
			route: ({ exclude, requiredCapability }) => {
				const quarantined = exclude.some(
					(identifier) => identifier.toLowerCase() === "cheap",
				);
				const target = quarantined ? "expensive" : "cheap";
				return {
					provider: target === "cheap" ? "Cheap" : "Expensive",
					resolvedTargetId: target,
					resolved_harness: "claude",
					model: `${target}-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: (provider) => ({
				targetId: provider.toLowerCase(),
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (target, capability) =>
				descriptor(
					target.toLowerCase(),
					`${target.toLowerCase()}-${capability}`,
				),
		},
	});
	strictEqual(result.results[0].success, true);
	strictEqual(resets, 1);
	strictEqual(calls.length, 2);
	strictEqual(calls[0], "cheap");
	strictEqual(calls[1], "expensive");
	strictEqual(dispatches[0].errorKind, "quota_exhausted");
	strictEqual(result.retryState, null);
	strictEqual(result.quarantinedTargetIds.includes("cheap"), true);
});

test("production async runner refreshes quarantined exclusions for each task", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "switchyard-production-broker-quota-queue-"),
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Quota one\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** quarantine cheap\n\n### Task 1.2: Quota two\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** respect quarantine\n",
	);
	const routeExclusions = [];
	let executions = 0;
	const invocationFor = (target, capability) =>
		descriptor(target, `${target}-${capability}`);
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		maxTasks: 2,
		stopOnFailure: false,
		dependencies: {
			backendFactory: () => ({
				executionBackend: {},
				create: () => "owned-async-quota-queue-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					executeAsync: async (_prompt, _container, options) => {
						executions += 1;
						return executions === 1
							? {
									success: false,
									errorKind: "quota_exhausted",
									resolvedTargetId: options.resolvedTargetId,
								}
							: { success: true };
					},
					captureDiffAsync: async () => null,
				},
			},
			recordDispatch: () => {},
			recordDispatchIntent: () => {},
			route: ({ exclude, requiredCapability }) => {
				routeExclusions.push([...exclude]);
				const quarantined = exclude.some(
					(identifier) => identifier.toLowerCase() === "cheap",
				);
				const target = quarantined ? "expensive" : "cheap";
				return {
					provider: target === "cheap" ? "Cheap" : "Expensive",
					resolvedTargetId: target,
					resolved_harness: "claude",
					model: `${target}-${requiredCapability}`,
					reason: "ranked",
				};
			},
			resolveTargetIdentity: (provider) => ({
				targetId: provider.toLowerCase(),
				harnessKey: "claude",
				ambiguous: false,
			}),
			resolveDescriptor: (target, capability) =>
				invocationFor(target.toLowerCase(), capability),
		},
	});
	strictEqual(result.processedTasks, 2);
	strictEqual(result.results.length, 2);
	strictEqual(
		result.results.every((entry) => entry.success),
		true,
	);
	strictEqual(routeExclusions.length, 3);
	strictEqual(routeExclusions[0].includes("cheap"), false);
	strictEqual(routeExclusions[1].includes("cheap"), true);
	strictEqual(routeExclusions[2].includes("cheap"), true);
});
