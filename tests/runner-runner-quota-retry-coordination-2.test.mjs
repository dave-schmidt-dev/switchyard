import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createEmptyCheckpoint,
	loadCheckpoint,
	releaseCheckpointOwnership,
	saveCheckpoint,
} from "../src/switchyard/runner/index.mjs";
import {
	completionReceipt,
	runnerTestDir,
	runQueue,
	runQueueAsync,
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
});
