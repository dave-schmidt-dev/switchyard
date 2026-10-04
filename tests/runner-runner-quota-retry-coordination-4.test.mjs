import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	runnerTestDir,
	runQueue,
	runQueueAsync,
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
});
