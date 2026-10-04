import { strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import {
	descriptor,
	previousRosterPath,
	REVIEW_SUCCESS,
	runQueueAsync,
	writeDispatchQualifiedRosterFixture,
} from "./helpers/runner-broker-production-fixtures.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

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
							diagnosticOrigin: "launcher",
							diagnosticEvidenceAvailable: true,
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
						return REVIEW_SUCCESS;
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
test("qualification attempt reserves the configured Vibe descriptor without an automatic receipt", async () => {
	const root = await tempDirAsync("switchyard-broker-qualification-attempt-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	const requalificationRosterPath = join(
		tmpdir(),
		`switchyard-runner-broker-requalification-roster-${process.pid}-${randomUUID()}.json`,
	);
	const requalificationRoster = JSON.parse(
		readFileSync(qualifiedRosterPath, "utf8"),
	);
	requalificationRoster.targets.vibe.enabled = true;
	delete requalificationRoster.targets.vibe.disabled_reason;
	requalificationRoster.targets.vibe.qualifications = {};
	writeFileSync(
		requalificationRosterPath,
		JSON.stringify(requalificationRoster),
		"utf8",
	);
	process.env.SWITCHYARD_ROSTER_PATH = requalificationRosterPath;
	__resetRosterCacheForTests();
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Requalify Vibe\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **RequiredCapability:** standard\n- **Description:** exercise the explicitly authorized descriptor path\n",
	);
	const observed = [];
	try {
		const runAttempt = (qualificationAttempt) =>
			runQueueAsync({
				tasksFilePath,
				projectPath: root,
				workingContainerName: "broker-qualification-attempt-worker",
				checkpointPath: qualificationAttempt
					? checkpointPath
					: join(root, "ordinary-checkpoint.json"),
				only: ["Vibe"],
				maxTasks: 1,
				qualificationAttempt,
				dependencies: {
					queuePreflight: () => ({ ok: true, eligible: true }),
					route: () => ({
						provider: "Vibe",
						resolvedTargetId: "vibe",
						resolved_harness: "vibe",
						model: "fixture-vibe-standard",
						reason: "qualification_attempt",
					}),
					resolveTargetIdentity: () => ({
						targetId: "vibe",
						harnessKey: "vibe",
						ambiguous: false,
					}),
					recordDispatch: () => {},
					recordDispatchIntent: () => {},
					adapters: {
						vibe: {
							executeAsync: async (_prompt, _container, options) => {
								observed.push(options.invocationDescriptor);
								return REVIEW_SUCCESS;
							},
							captureDiffAsync: async () => null,
						},
					},
				},
			});
		const ordinary = await runAttempt(false);
		strictEqual(ordinary.results[0].success, false);
		strictEqual(observed.length, 0);

		const result = await runAttempt(true);
		strictEqual(
			result.results[0].success,
			true,
			JSON.stringify(result.results[0]),
		);
		strictEqual(observed.length, 1);
		strictEqual(observed[0].target_id, "vibe");
		strictEqual(observed[0].selector, "fixture-vibe-standard");
	} finally {
		process.env.SWITCHYARD_ROSTER_PATH = qualifiedRosterPath;
		__resetRosterCacheForTests();
		rmSync(requalificationRosterPath, { force: true });
	}
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
						return REVIEW_SUCCESS;
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
