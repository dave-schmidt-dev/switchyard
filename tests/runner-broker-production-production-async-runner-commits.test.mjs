import { rejects, strictEqual } from "node:assert";
import { rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { createBrokerAdapterLauncher } from "../src/switchyard/runner/index.mjs";
import {
	descriptor,
	previousRosterPath,
	REVIEW_SUCCESS,
	runQueueAsync,
	writeDispatchQualifiedRosterFixture,
} from "./helpers/runner-broker-production-fixtures.mjs";
import { tempDirAsync } from "./helpers/tempdir.mjs";

const QUOTA_DIAGNOSTIC_REF = `diagnostic:${"a".repeat(32)}`;
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
test("production async runner commits each task on an owned container", async () => {
	const root = await tempDirAsync("switchyard-production-broker-commit-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: A\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A\n\n### Task 1.2: B\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/b.mjs\n- **Quick checks:** none\n- **Description:** B\n",
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
			integrationGate: () => ({ success: true }),
			adapters: {
				claude: {
					executeAsync: async () => ({ success: true }),
					captureDiffAsync: async (_container, task) =>
						`diff --git a/src/${task?.id === "1.2" ? "b" : "a"}.mjs b/src/${task?.id === "1.2" ? "b" : "a"}.mjs\n`,
				},
			},
		},
	});
	strictEqual(result.processedTasks, 2);
	strictEqual(commits, 2);
	strictEqual(resets, 0);
});
test("production async runner keeps implementation transcripts off the broker boundary", async () => {
	const root = await tempDirAsync("switchyard-production-broker-canary-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: A\n- **Status:** pending\n- **Type:** implementation\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A\n",
	);
	const invocation = descriptor("cheap", "cheap-standard");
	const records = [];
	// A JSON-shaped implementation transcript is the hazard: the review-result
	// parser accepts any `{...}` payload, so deriving a verdict for every task
	// would sanitize this text and relay it across the boundary that exists to
	// keep provider bytes out of the runner.
	const canary = "SWITCHYARD_TRANSCRIPT_CANARY";
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		maxTasks: 1,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				executionBackend: {},
				ensureAgentContainer: () => {},
				create: () => "owned-async-canary-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
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
			recordDispatch: (entry) => {
				records.push(entry);
			},
			recordDispatchIntent: () => {},
			integrationGate: () => ({ success: true }),
			adapters: {
				claude: {
					executeAsync: async () => ({
						success: true,
						output: JSON.stringify({
							verdict: "clean",
							summary: canary,
							findings: [{ severity: "high", detail: canary }],
						}),
					}),
					captureDiffAsync: async () => "diff --git a/src/a.mjs b/src/a.mjs\n",
				},
			},
		},
	});
	strictEqual(result.processedTasks, 1);
	strictEqual(JSON.stringify(result).includes(canary), false);
	strictEqual(JSON.stringify(records).includes(canary), false);
	strictEqual((await readFile(checkpointPath, "utf8")).includes(canary), false);
});
test("broker launcher derives a verdict only for review work", async () => {
	const invocation = descriptor("cheap", "cheap-standard");
	const route = {
		provider: "Cheap",
		resolvedTarget: "cheap",
		harness: "claude",
		model: invocation.selector,
		effort: null,
		reservation: { id: "reservation-canary" },
	};
	const launcherIdentity = {
		...route,
		descriptorIdentity: invocation.descriptor_identity,
		reservationId: "reservation-canary",
	};
	// A JSON-shaped transcript parses as a verdict whatever the task was, so the
	// launcher must be told which kind of work it ran. Without that, an
	// implementation task's own words are sanitized into a review result and
	// relayed across the boundary that exists to stop provider bytes.
	const canary = "SWITCHYARD_LAUNCHER_CANARY";
	const adapter = {
		executeAsync: async () => ({
			success: true,
			output: JSON.stringify({ verdict: "clean", summary: canary }),
		}),
	};
	const launchFor = (deriveReviewResult) =>
		createBrokerAdapterLauncher({
			adapter,
			executionBackend: {},
			workingContainerName: "vm",
			prompt: "fixture",
			deriveReviewResult,
		})({
			request: { taskId: "1.1", attemptId: "attempt-canary" },
			route,
			invocationDescriptor: invocation,
			launcherIdentity,
		});

	const implementation = await launchFor(false);
	strictEqual(implementation.success, true);
	strictEqual(implementation.reviewResult, null);
	strictEqual(JSON.stringify(implementation).includes(canary), false);

	const review = await launchFor(true);
	strictEqual(review.reviewResult.status, "available");
	strictEqual(review.reviewResult.summary, canary);
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
							: REVIEW_SUCCESS;
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
	const ambiguousCheckpointBytes = await readFile(checkpointPath, "utf8");
	let launches = 0;
	await rejects(
		() =>
			runQueueAsync({
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
			}),
		/checkpoint owner displaced/,
	);
	strictEqual(launches, 0);
	strictEqual(
		await readFile(checkpointPath, "utf8"),
		ambiguousCheckpointBytes,
		"an unreleased pending checkpoint must remain byte-for-byte unchanged",
	);
});
