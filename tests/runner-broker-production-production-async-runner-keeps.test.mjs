import { rejects, strictEqual } from "node:assert";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { finalizeRun } from "../src/switchyard/dispatch/run-finalization.mjs";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import {
	BOUNDED_QUOTA_EVIDENCE,
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
test("production async runner keeps the resolved target id when a routed task throws", async () => {
	const root = await tempDirAsync("switchyard-production-broker-throw-");
	const tasksFilePath = join(root, "TASKS.md");
	const checkpointPath = join(root, "checkpoint.json");
	await writeFile(
		tasksFilePath,
		"### Task 1.1: Throwing task\n- **Status:** pending\n- **Type:** review\n- **Executor:** switchyard\n- **Description:** throw after routing\n",
	);
	const result = await runQueueAsync({
		tasksFilePath,
		projectPath: root,
		checkpointPath,
		dependencies: {
			queuePreflight: () => ({ ok: true, eligible: true }),
			backendFactory: () => ({
				executionBackend: {},
				create: () => "owned-async-throw-worker",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
			}),
			adapters: {
				claude: {
					executeAsync: async () => ({
						success: false,
						errorKind: "execution_failed",
						failurePhase: "provider_execution",
						exitCode: 1,
					}),
					captureDiffAsync: async () => null,
				},
			},
			// Throws only once the route is already selected, which is the state
			// the real reservation-lock timeout throws from.
			recordDispatch: () => {
				throw new Error("dispatch ledger unavailable");
			},
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
	// The field that went missing. A failed record with no resolved target id
	// cannot be attributed in the dispatch ledger or in route health, both of
	// which key on the target.
	strictEqual(result.results[0].resolvedTargetId, "cheap");
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
			persistDiagnosticArtifact: async (evidence) => {
				strictEqual(evidence, BOUNDED_QUOTA_EVIDENCE);
				return QUOTA_DIAGNOSTIC_REF;
			},
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
							? {
									success: false,
									errorKind: "quota_exhausted",
									diagnosticCode: "quota_exhausted",
									diagnosticOrigin: "adapter",
									diagnosticEvidenceAvailable: true,
									diagnosticEvidence: BOUNDED_QUOTA_EVIDENCE,
									failurePhase: "provider_execution",
								}
							: REVIEW_SUCCESS;
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
			persistDiagnosticArtifact: async (evidence) => {
				strictEqual(evidence, BOUNDED_QUOTA_EVIDENCE);
				return QUOTA_DIAGNOSTIC_REF;
			},
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
									diagnosticCode: "quota_exhausted",
									diagnosticOrigin: "adapter",
									diagnosticEvidenceAvailable: true,
									diagnosticEvidence: BOUNDED_QUOTA_EVIDENCE,
									failurePhase: "provider_execution",
									resolvedTargetId: options.resolvedTargetId,
								}
							: REVIEW_SUCCESS;
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
