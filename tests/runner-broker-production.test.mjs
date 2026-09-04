import { ok, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createReservationLedger } from "../src/switchyard/broker/reservations.mjs";
import { finalizeRun } from "../src/switchyard/dispatch/run-finalization.mjs";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
} from "../src/switchyard/roster/index.mjs";
import { route as productionRoute } from "../src/switchyard/router/index.mjs";
import { runQueueAsync } from "../src/switchyard/runner/index.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");
const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;

function writeDispatchQualifiedRosterFixture() {
	const roster = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
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
		`switchyard-runner-broker-qualified-roster-${process.pid}-${randomUUID()}.json`,
	);
	writeFileSync(fixturePath, JSON.stringify(roster), "utf8");
	return fixturePath;
}

let qualifiedRosterPath = null;

before(() => {
	qualifiedRosterPath = writeDispatchQualifiedRosterFixture();
	process.env.SWITCHYARD_ROSTER_PATH = qualifiedRosterPath;
	__resetRosterCacheForTests();
});

after(() => {
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
	if (qualifiedRosterPath) {
		try {
			rmSync(qualifiedRosterPath, { force: true });
		} catch {}
	}
});

// Every dependencies object below sets queuePreflight to a trivial pass.
// This file exercises broker reservation/fallback/adapter-launch behavior
// downstream of admission, not the macOS/Parallels provider-eligibility
// preflight gate itself (that's covered directly in tests/router.test.mjs
// and tests/runner.test.mjs's "Task 6.1"/"Task 6.3" describe blocks) --
// without the override, runQueueAsync's default preflight reads real
// on-disk routing state via the production readSnapshotAtRoute, which
// none of these tmpdir-rooted fixtures provide, so every task would be
// rejected before dispatch regardless of the scenario under test.
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

test("production async runner retains cli usage failure without peer fallback", async () => {
	const root = await tempDirAsync("switchyard-production-broker-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Broker task\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **RequiredCapability:** high\n- **RequiredCapabilityJustification:** This production broker path must hold the requested high capability across a CLI usage failure.\n- **Description:** exercise production broker\n",
	);
	const calls = [];
	const dispatches = [];
	const intents = [];
	let snapshotReads = 0;
	const adapters = {
		claude: {
			executeAsync: async (_prompt, _container, options) => {
				calls.push(options.resolvedTargetId);
				return calls.length > 1
					? { success: true }
					: {
							success: false,
							error: "SECRET_CANARY_provider output",
							errorKind: "execution_failed",
							diagnosticCode: "cli_usage_error",
							exitCode: 2,
							failurePhase: "provider_execution",
						};
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	strictEqual(result.results[0].success, false);
	strictEqual(result.results[0].requiredCapability, "high");
	strictEqual(result.results[0].resolvedTargetId, "cheap");
	strictEqual(calls.length, 1);
	strictEqual(calls[0], "cheap");
	strictEqual(intents.length, 1);
	strictEqual(intents[0].provider, "Cheap");
	strictEqual(dispatches.length, 1);
	strictEqual(dispatches[0].provider, "Cheap");
	strictEqual(dispatches[0].result, "execution_failed");
	strictEqual(dispatches[0].diagnosticCode, "cli_usage_error");
	strictEqual(dispatches[0].exitCode, 2);
	strictEqual(dispatches[0].failurePhase, "provider_execution");
	strictEqual(JSON.stringify(dispatches[0]).includes("SECRET_CANARY"), false);
	strictEqual(snapshotReads >= 1, true);
	const projectLedger = JSON.parse(
		await readFile(
			join(root, ".logs", "switchyard", "broker", "reservations.json"),
			"utf8",
		),
	);
	strictEqual(
		projectLedger.reservations.length === 1 &&
			projectLedger.reservations.every((entry) =>
				["released", "reconciled"].includes(entry.state),
			),
		true,
	);
});

test("production async runner never infers peer fallback from failure prose", async () => {
	for (const reason of [
		"provider reported transient timeout",
		"transient provider launch failure",
		"timeout while starting provider",
	]) {
		const root = await tempDirAsync("switchyard-broker-prose-");
		const tasksFilePath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		await writeFile(
			tasksFilePath,
			"### Task 1.1: Prose failure\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** no inferred retry\n",
		);
		let calls = 0;
		const result = await runQueueAsync({
			tasksFilePath,
			projectPath: root,
			workingContainerName: "broker-prose-worker",
			checkpointPath,
			dependencies: {
				queuePreflight: () => ({ ok: true, eligible: true }),
				backendFactory: () => ({
					executionBackend: {},
					create: () => "broker-prose-worker",
					destroy: () => {},
					seed: () => {},
					commit: () => {},
					reset: () => {},
				}),
				adapters: {
					claude: {
						executeAsync: async () => {
							calls += 1;
							return { success: false, error: reason };
						},
						captureDiffAsync: async () => null,
					},
				},
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
		strictEqual(result.results[0].success, false);
		strictEqual(calls, 1);
	}
});

test("production async broker forwards adapter status and heartbeats", async () => {
	const root = await tempDirAsync("switchyard-production-broker-status-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	strictEqual(heartbeats[0].processPhase, "provider_transport_running");
});

test("production async runner drains a dependency chain in one bounded run", async () => {
	const root = await tempDirAsync("switchyard-production-broker-chain-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync("switchyard-production-broker-commit-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync("switchyard-production-broker-reset-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync(
		"switchyard-production-broker-already-complete-",
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
	const root = await tempDirAsync("switchyard-production-broker-retry-resume-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Retry\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** retry\n",
	);
	const invocation = descriptor("cheap", "cheap-standard");
	const baseDependencies = {
		queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync("switchyard-production-broker-failure-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync(
		"switchyard-production-broker-state-isolation-",
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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

test("production async runner does not write a fallback intent for a generic failure", async () => {
	const root = await tempDirAsync(
		"switchyard-production-broker-fallback-intent-",
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	strictEqual(result.results[0].result, "execution_failed");
	strictEqual(result.results[0].provider, "Cheap");
	strictEqual(calls.length, 1);
	strictEqual(intentCalls, 1);
	strictEqual((await ledger.inspect()).reservations.length, 1);
	strictEqual(
		(await ledger.inspect()).reservations.every(
			(entry) => entry.state === "released",
		),
		true,
	);
});

test("production async runner preserves a generic broker failure without retry", async () => {
	const root = await tempDirAsync("switchyard-production-broker-precondition-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	strictEqual(result.results[0].errorKind, "execution_failed");
	strictEqual(dispatches.length, 1);
	strictEqual(dispatches[0].result, "execution_failed");
	strictEqual(calls, 1);
});

test("production async runner does not fallback a typed nonretryable failure", async () => {
	const root = await tempDirAsync("switchyard-production-broker-nonretryable-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync(
		"switchyard-production-broker-postexecution-",
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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

test("production async runner does not retry before post-execution capture", async () => {
	const root = await tempDirAsync(
		"switchyard-production-broker-fallback-postexecution-",
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	strictEqual(executions, 1);
	strictEqual(captures, 1);
	strictEqual(dispatches.length, 1);
	strictEqual(dispatches[0].provider, "Cheap");
	strictEqual(dispatches[0].result, "execution_failed");
});

test("production async runner releases a reservation before an adapter precondition failure", async () => {
	const root = await tempDirAsync("switchyard-production-broker-release-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync("switchyard-production-broker-construction-");
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
				queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync("switchyard-production-broker-real-router-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync(
		"switchyard-production-broker-unknown-source-",
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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
	const root = await tempDirAsync("switchyard-production-broker-quota-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Quota retry\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** retry once\n",
	);
	const calls = [];
	const dispatches = [];
	let resets = 0;
	const retryStarts = new Map();
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			onRetryStateChanged: ({ retryState }) => {
				if (retryState?.phase !== "retry_started") return;
				retryStarts.set(
					retryState.taskId,
					(retryStarts.get(retryState.taskId) ?? 0) + 1,
				);
			},
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
	strictEqual(retryStarts.get("1.1"), 1);
	strictEqual(
		[...retryStarts.values()].every((count) => count <= 1),
		true,
	);
});

test("production async runner refreshes quarantined exclusions for each task", async () => {
	const root = await tempDirAsync("switchyard-production-broker-quota-queue-");
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
			queuePreflight: () => ({ ok: true, eligible: true }),
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

test("async teardown failure finalizes as recovery required, never succeeded cleanup complete", async () => {
	const root = await tempDirAsync(
		"switchyard-production-cleanup-finalization-",
	);
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Already complete\n- **Status:** done\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** exercise terminal cleanup failure\n",
	);
	let cleanupError = null;
	await rejects(
		runQueueAsync({
			tasksFilePath,
			projectPath: root,
			checkpointPath,
			dependencies: {
				queuePreflight: () => ({ ok: true, eligible: true }),
				backendFactory: () => ({
					create: () => "owned-cleanup-failure-worker",
					destroy: () => {
						throw new Error("SECRET_CANARY backend teardown detail");
					},
					seed: () => {},
					commit: () => {},
					reset: () => {},
				}),
			},
		}),
		(error) => {
			cleanupError = error;
			return error?.code === "recovery_incomplete";
		},
	);

	const persisted = {};
	const patches = [];
	const outcome = await finalizeRun(
		{
			runId: "cleanup-finalization",
			state: "failed",
			failure: cleanupError.failure,
			eventName: "run_failed",
			eventStatus: "recovery_required",
			terminalSummary: cleanupError.terminalSummary,
			cleanup: async () => {
				throw new Error("queue cleanup incomplete");
			},
		},
		{
			createEvent: async () => {},
			updateRunWithRetry: async (_runId, patch) => {
				patches.push(patch);
				Object.assign(persisted, patch);
				return { ...persisted };
			},
			releaseRunLock: async () => {},
		},
	);

	strictEqual(outcome.terminal, false);
	strictEqual(outcome.cleanupComplete, false);
	strictEqual(persisted.state, "recovery_required");
	strictEqual(persisted.cleanupState, "failed");
	strictEqual(persisted.lastFailure.diagnosticCode, "recovery_incomplete");
	strictEqual(persisted.terminalizedBy, undefined);
	strictEqual(
		patches.some(
			(patch) =>
				patch.state === "succeeded" || patch.cleanupState === "complete",
		),
		false,
	);
	strictEqual(JSON.stringify(persisted).includes("SECRET_CANARY"), false);
});

// Regression: the broker executor's terminal returns are frozen allowlists, so
// a launcher field nothing there names is dropped in silence. servedModelVerified
// was dropped exactly that way -- every unit test passed because they drove the
// synchronous runner, and the first live dispatch recorded no flag at all. This
// pins the executor -> runner leg without a VM.
test("production async runner records the adapter's served-model verification", async () => {
	for (const [servedModel, expected] of [
		["cheap-standard", true],
		[null, false],
		[undefined, undefined],
	]) {
		const root = await tempDirAsync("switchyard-broker-served-");
		const tasksFilePath = join(root, "TASKS.md");
		const checkpointPath = join(root, "checkpoint.json");
		await writeFile(
			tasksFilePath,
			"### Task 1.1: Served model\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** carry the served-model fact\n",
		);
		const result = await runQueueAsync({
			tasksFilePath,
			projectPath: root,
			workingContainerName: "broker-served-worker",
			checkpointPath,
			dependencies: {
				queuePreflight: () => ({ ok: true, eligible: true }),
				backendFactory: () => ({
					executionBackend: {},
					create: () => "broker-served-worker",
					destroy: () => {},
					seed: () => {},
					commit: () => {},
					reset: () => {},
				}),
				adapters: {
					claude: {
						executeAsync: async () => ({
							success: true,
							output: "done",
							...(servedModel === undefined ? {} : { servedModel }),
						}),
						captureDiffAsync: async () => null,
					},
				},
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
		const record = result.results[0];
		if (expected === undefined) {
			strictEqual(
				Object.hasOwn(record, "servedModelVerified"),
				false,
				"an adapter that cannot report a served model must leave the field absent",
			);
		} else {
			strictEqual(record.servedModelVerified, expected);
		}
		const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
		strictEqual(
			checkpoint.results[0].servedModelVerified,
			expected,
			"the checkpoint entry must agree with the result record",
		);
		strictEqual(
			JSON.stringify(result).includes("cheap-standard-served"),
			false,
		);
	}
});

// The same defect as above, found by auditing the boundary the served-model
// drop exposed: the launcher never returned cleanupStage at all, so a cleanup
// failure was persisted without naming the kill step that failed. This drives
// the whole launcher -> executor -> runner chain, which is where it died.
test("production async runner records which cleanup stage failed", async () => {
	const root = await tempDirAsync("switchyard-broker-cleanup-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Cleanup stage\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** carry the cleanup stage\n",
	);
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-cleanup-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				executionBackend: {},
				create: () => "broker-cleanup-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					// A provider that outlived its kill: the stage is the only
					// fact that says how far cleanup got before it gave up.
					executeAsync: async () => ({
						success: false,
						output: "",
						error: "provider cleanup failed after timeout",
						timedOut: true,
						cleanupFailed: true,
						cleanupStage: "tree_terminated",
					}),
					captureDiffAsync: async () => null,
				},
			},
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
	const record = result.results[0];
	strictEqual(record.result, "execution_timed_out_cleanup_failed");
	strictEqual(record.errorKind, "provider_cleanup_failed");
	strictEqual(
		record.diagnosticCode,
		"provider_cleanup_after_tree_terminated",
		"the diagnostic code is derived from the stage, so a dropped stage degrades it",
	);
	const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
	strictEqual(
		checkpoint.results[0].diagnosticCode,
		"provider_cleanup_after_tree_terminated",
	);
});

// Regression: the empty-diff transcript rescue was only ever exercised through
// the synchronous runQueue path (tests/runner.test.mjs). The broker path wires
// the same evidence through a different route -- createDispatchBroker's
// onTranscript callback, context._activeTaskTranscript, and a second
// saveGateEvidence call site inside runQueueAsync -- and nothing drove any of
// it. A break in that chain would leave an `empty_required_diff` rejection
// from a real (broker) dispatch with no evidence again, exactly the gap the
// fix closed for the synchronous path only.
test("production async runner keeps the provider transcript as evidence when the broker gate rejects an empty diff", async () => {
	const root = await tempDirAsync("switchyard-broker-gate-evidence-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	const transcript =
		"I inspected src/a.mjs and concluded no change was required.";
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Empty-diff task\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** the provider explains itself but changes nothing\n",
	);
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-gate-evidence-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				executionBackend: {},
				create: () => "broker-gate-evidence-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					executeAsync: async () => ({
						success: true,
						output: transcript,
						error: null,
					}),
					captureDiffAsync: async () => null,
				},
			},
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
	const record = result.results[0];
	strictEqual(record.success, false);
	strictEqual(
		record.diagnosticCode ?? record.reasonCode,
		"empty_required_diff",
	);
	ok(
		/^artifact:[a-f0-9]{24}$/.test(record.artifactRef ?? ""),
		`expected an opaque artifact reference, got ${record.artifactRef}`,
	);
	const artifactPath = `${checkpointPath}.partial-diffs/1.1.output`;
	ok(existsSync(artifactPath), "the transcript must be kept as an artifact");
	strictEqual(readFileSync(artifactPath, "utf8"), transcript);
	strictEqual(
		record.gateEvidence,
		undefined,
		"raw transcript must not ride along in the result",
	);

	const rawCheckpointJson = await readFile(checkpointPath, "utf8");
	ok(
		!rawCheckpointJson.includes(transcript),
		"checkpoint.json must reference the artifact, never embed the transcript",
	);
});

// The failure branches above name the cleanup stage, but a provider can also
// exit 0 having left its process tree alive - the launcher reports
// `success: true` with `cleanupFailed: true`. Every success branch built its
// record and its envelope from a fixed field list that named neither, so the
// broker forwarded both fields to a reader that dropped them and the task was
// persisted as an unqualified success while a provider process kept running in
// the guest. Nothing in the suite drove success + cleanupFailed together.
test("production async runner keeps cleanup evidence on a task that succeeded", async () => {
	const root = await tempDirAsync("switchyard-broker-cleanup-success-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Surviving provider\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** succeed while cleanup fails\n",
	);
	const dispatches = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-cleanup-success-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async () => ({
						success: true,
						output: "",
						cleanupFailed: true,
						cleanupStage: "tree_terminated",
					}),
					captureDiffAsync: async () => null,
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
	const record = result.results[0];
	strictEqual(record.result, "success_no_diff");
	strictEqual(record.success, true);
	strictEqual(
		record.cleanupFailed,
		true,
		"a success that left a process running is not an unqualified success",
	);
	strictEqual(record.cleanupStage, "tree_terminated");
	const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
	strictEqual(checkpoint.results[0].cleanupFailed, true);
	strictEqual(checkpoint.results[0].cleanupStage, "tree_terminated");
	// The ledger is the record an operator greps to find hosts with orphaned
	// provider processes, so it has to carry the stage too.
	strictEqual(dispatches.at(-1).result, "success_no_diff");
	strictEqual(dispatches.at(-1).cleanupStage, "tree_terminated");
});

// The same shape on an ordinary success must stay untouched: the fields are
// evidence of a specific failure, and emitting `cleanupFailed: false` on every
// clean task would make the ledger's own signal unreadable.
test("production async runner adds no cleanup fields when cleanup succeeded", async () => {
	const root = await tempDirAsync("switchyard-broker-cleanup-clean-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Clean exit\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** succeed with cleanup intact\n",
	);
	const dispatches = [];
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		workingContainerName: "broker-cleanup-clean-worker",
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true, output: "" }),
					captureDiffAsync: async () => null,
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
	strictEqual(result.results[0].success, true);
	strictEqual(
		Object.hasOwn(result.results[0], "cleanupFailed"),
		false,
		"a clean run must not carry a cleanupFailed key at all",
	);
	strictEqual(Object.hasOwn(result.results[0], "cleanupStage"), false);
	strictEqual(Object.hasOwn(dispatches.at(-1), "cleanupFailed"), false);
});
