import { rejects, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	descriptorForRoute,
	runnerTestDir,
	runQueueAsync,
	TASK_BASE,
	withExplicitSwitchyardExecutor,
} from "./helpers/async-runner-fixtures.mjs";

const TEST_DIR = runnerTestDir(import.meta.url);
function writeLegacyCheckpoint(path, checkpoint) {
	writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
}
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
	it("does not resume a possibly applied legacy quarantined task", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Resume quota retry
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** resume after a durable quarantine transition
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resumeDescriptor = descriptorForRoute({
			provider: "agy",
			model: "fixture-gemini",
			resolvedTargetId: "agy-gemini",
		});
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["agy-gemini"],
			retryAttempts: [
				{
					taskId: "1.1",
					attempt: 1,
					provider: "agy",
					model: "fixture-gemini",
					resolvedTargetId: "agy-gemini",
					result: "execution_failed",
					success: false,
					timedOut: false,
					errorKind: "quota_exhausted",
					reasonCode: "quota_exhausted",
					reason:
						"Provider quota is exhausted; the target is unavailable for this attempt.",
				},
			],
			retryTransitions: [
				{ transitionId: 1, type: "attempt_recorded", taskId: "1.1" },
				{ transitionId: 2, type: "target_quarantined", taskId: "1.1" },
			],
			retryTransitionId: 2,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
				invocationDescriptor: resumeDescriptor,
				descriptorIdentity: resumeDescriptor.descriptor_identity,
				descriptorHarness: "agy",
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		});

		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
				{ provider: "agy", model: "fixture-claude", target: "agy-claude" },
			],
			executionOutcomes: { agy: [{ success: true, output: "ok" }] },
		});
		let resetCalls = 0;
		fixture.dependencies.resetWorkingTree = () => {
			resetCalls += 1;
		};

		const before = readFileSync(checkpointPath, "utf8");
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: fixture.dependencies,
			}),
			/invalid quota diagnostic provenance/,
		);
		strictEqual(fixture.executeCalls.length, 0);
		strictEqual(resetCalls, 0);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
	});
	it("does not reconstruct a possibly applied legacy attempt", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Resume before quarantine
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** recover the transition boundary
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const resumeDescriptor = descriptorForRoute({
			provider: "agy",
			model: "fixture-gemini",
			resolvedTargetId: "agy-gemini",
		});
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: [],
			retryAttempts: [
				{
					taskId: "1.1",
					attempt: 1,
					provider: "agy",
					model: "fixture-gemini",
					resolvedTargetId: "agy-gemini",
					result: "execution_failed",
					success: false,
					timedOut: false,
					errorKind: "quota_exhausted",
					reasonCode: "quota_exhausted",
					reason:
						"Provider quota is exhausted; the target is unavailable for this attempt.",
				},
			],
			retryTransitions: [
				{ transitionId: 1, type: "attempt_recorded", taskId: "1.1" },
			],
			retryTransitionId: 1,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "attempt_recorded",
				resolvedTargetId: "agy-gemini",
				invocationDescriptor: resumeDescriptor,
				descriptorIdentity: resumeDescriptor.descriptor_identity,
				descriptorHarness: "agy",
				diagnosticCode: "quota_exhausted",
				diagnosticOrigin: "adapter",
				diagnosticEvidenceAvailable: true,
				failurePhase: "provider_execution",
			},
		});

		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
				{ provider: "agy", model: "fixture-claude", target: "agy-claude" },
			],
			executionOutcomes: { agy: [{ success: true, output: "ok" }] },
		});

		const before = readFileSync(checkpointPath, "utf8");
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: fixture.dependencies,
			}),
			/invalid quota diagnostic provenance/,
		);
		strictEqual(fixture.executeCalls.length, 0);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
	});
	it("fails closed on historical model-only retry state without launching", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject insufficient retry evidence
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** an old retry record has no exact descriptor
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["agy-gemini"],
			retryAttempts: [],
			retryTransitions: [],
			retryTransitionId: 0,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "agy-gemini",
			},
		});
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-claude", target: "agy-claude" },
			],
			executionOutcomes: { agy: [{ success: true, output: "must not run" }] },
		});
		await rejects(
			runQueueAsync({
				tasksFilePath: tasksPath,
				projectPath: TEST_DIR,
				checkpointPath,
				dependencies: fixture.dependencies,
			}),
			/explicit reconciliation/,
		);
		strictEqual(fixture.executeCalls.length, 0);
	});
});
