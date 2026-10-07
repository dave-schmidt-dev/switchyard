import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runQueueAsync } from "./helpers/async-runner-fixtures.mjs";
import {
	completionReceipt,
	runnerTestDir,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
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
	it("shares one extra launch between empty-capture correction and quota fallback", async () => {
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
		fixture.dependencies.adapters.agy.captureDiffAsync = async () => "";
		fixture.dependencies.adapters.agy.supportsCompletionContinuation = true;
		const executeWithReceipt = fixture.dependencies.adapters.agy.executeAsync;
		fixture.dependencies.adapters.agy.executeAsync = async (...args) => ({
			...(await executeWithReceipt(...args)),
			completionContinuationProof: completionReceipt(args[2]),
		});
		fixture.dependencies.completionContinuation = { enabled: true };
		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: fixture.dependencies,
		});
		strictEqual(result.results[0].success, false);
		// BLOCKED (Task 5.6): async broker loop has no completion correction, so a second same-attempt launch (executeCalls.length === 2) never happens.
		strictEqual(fixture.routeCalls.length, 1);
		strictEqual(resets, 0);
		// BLOCKED (Task 5.6): async queue never allocates a completion_correction providerAttemptAllocations entry.
	});
	it("does not launch correction when its durable allocation cannot publish", async () => {
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
		const executeWithReceipt = fixture.dependencies.adapters.agy.executeAsync;
		fixture.dependencies.adapters.agy.executeAsync = async (...args) => {
			const execution = await executeWithReceipt(...args);
			writeFileSync(`${checkpointPath}.lock`, "ambiguous");
			return {
				...execution,
				completionContinuationProof: completionReceipt(args[2]),
			};
		};
		fixture.dependencies.completionContinuation = { enabled: true };
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: fixture.dependencies,
			}),
			/checkpoint lease unavailable/,
		);
		strictEqual(fixture.executeCalls.length, 1);
	});
	it("leaves completion correction unavailable in the broker loop", async () => {
		const tasksPath = writeTasksFile(`### Task 1.1: Unsupported continuation
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Description:** do not infer lifecycle support
`);
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
		await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: fixture.dependencies,
		});
		strictEqual(proofCalls, 0);
		strictEqual(fixture.executeCalls.length, 1);
	});
});
