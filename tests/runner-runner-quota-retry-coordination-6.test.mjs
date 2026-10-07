import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	getInvocationDescriptorIdentity,
} from "../src/switchyard/roster/index.mjs";
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
	it("does not resume descriptor-only legacy retry state in sync or async queues", async () => {
		for (const [name, entrypoint] of [["async", runQueueAsync]]) {
			const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject ${name} legacy retry
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** descriptor evidence alone cannot authorize replay
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const descriptor = descriptorForRoute({
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
				retryAttempts: [],
				retryTransitions: [],
				retryTransitionId: 0,
				retryState: {
					taskId: "1.1",
					attempt: 1,
					phase: "target_quarantined",
					resolvedTargetId: "agy-gemini",
					invocationDescriptor: descriptor,
					descriptorIdentity: descriptor.descriptor_identity,
					descriptorHarness: "agy",
				},
			});
			let resetCalls = 0;
			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-other", target: "agy-other" },
				],
				executionOutcomes: { agy: [{ success: true, output: "must not run" }] },
				resetWorkingTree: () => {
					resetCalls += 1;
				},
			});
			const invoke = () =>
				entrypoint({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				});
			await rejects(invoke, /explicit reconciliation/);
			strictEqual(fixture.executeCalls.length, 0, name);
			strictEqual(resetCalls, 0, name);
		}
	});
	it("rejects a forged Claude descriptor for antigravity before reset, reroute, or execution", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject forged retry evidence
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** a descriptor signed for the wrong harness must not resume
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const descriptorCore = {
			target_id: "antigravity",
			model_ref: "fixture-gemini",
			selector: "fixture-gemini",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		const forgedDescriptor = {
			...descriptorCore,
			descriptor_identity: getInvocationDescriptorIdentity(
				descriptorCore,
				"claude",
			),
		};
		writeLegacyCheckpoint(checkpointPath, {
			version: 1,
			tasksFilePath: tasksPath,
			completedTaskIds: [],
			lastTaskId: null,
			lastUpdatedAt: null,
			results: [],
			quarantinedTargetIds: ["antigravity"],
			retryAttempts: [],
			retryTransitions: [],
			retryTransitionId: 0,
			retryState: {
				taskId: "1.1",
				attempt: 1,
				phase: "target_quarantined",
				resolvedTargetId: "antigravity",
				invocationDescriptor: forgedDescriptor,
				descriptorIdentity: forgedDescriptor.descriptor_identity,
				descriptorHarness: "claude",
			},
		});

		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "antigravity" },
			],
			executionOutcomes: {
				agy: [{ success: true, output: "must not execute" }],
			},
		});
		let resetCalls = 0;
		fixture.dependencies.resetWorkingTree = () => {
			resetCalls += 1;
		};

		const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
		__resetRosterCacheForTests();
		try {
			await rejects(
				runQueueAsync({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				}),
				/descriptor harness does not match target/,
			);
		} finally {
			if (previousRosterPath === undefined) {
				delete process.env.SWITCHYARD_ROSTER_PATH;
			} else {
				process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
			}
			__resetRosterCacheForTests();
		}

		strictEqual(resetCalls, 0);
		deepStrictEqual(fixture.routeCalls, []);
		strictEqual(fixture.executeCalls.length, 0);
	});
	for (const corruptField of ["retryAttempts", "retryTransitions"]) {
		it(`rejects forged descriptor evidence in ${corruptField} before routing`, async () => {
			const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject corrupt retry evidence
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** malformed retry evidence must not be resumed
`);
			const checkpointPath = `${tasksPath}.checkpoint.json`;
			const descriptorCore = {
				target_id: "antigravity",
				model_ref: "fixture-gemini",
				selector: "fixture-gemini",
				effort: null,
				variant: null,
				invocation_args: [],
			};
			const forgedDescriptor = {
				...descriptorCore,
				descriptor_identity: getInvocationDescriptorIdentity(
					descriptorCore,
					"claude",
				),
			};
			writeLegacyCheckpoint(checkpointPath, {
				version: 1,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				lastTaskId: null,
				lastUpdatedAt: null,
				results: [],
				quarantinedTargetIds: [],
				retryAttempts:
					corruptField === "retryAttempts"
						? [
								{
									taskId: "1.1",
									attempt: 1,
									resolvedTargetId: "antigravity",
									invocationDescriptor: forgedDescriptor,
									descriptorIdentity: forgedDescriptor.descriptor_identity,
									descriptorHarness: "claude",
								},
							]
						: [],
				retryTransitions:
					corruptField === "retryTransitions"
						? [
								{
									transitionId: 1,
									type: "attempt_recorded",
									taskId: "1.1",
									resolvedTargetId: "antigravity",
									invocationDescriptor: forgedDescriptor,
									descriptorIdentity: forgedDescriptor.descriptor_identity,
									descriptorHarness: "claude",
								},
							]
						: [],
				retryTransitionId: corruptField === "retryTransitions" ? 1 : 0,
				retryState: null,
			});

			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-gemini", target: "antigravity" },
				],
				executionOutcomes: {
					agy: [{ success: true, output: "must not execute" }],
				},
			});
			const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
			process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
			__resetRosterCacheForTests();
			try {
				await rejects(
					runQueueAsync({
						tasksFilePath: tasksPath,
						projectPath: TEST_DIR,
						checkpointPath,
						dependencies: fixture.dependencies,
					}),
					/descriptor harness does not match target/,
				);
			} finally {
				if (previousRosterPath === undefined) {
					delete process.env.SWITCHYARD_ROSTER_PATH;
				} else {
					process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
				}
				__resetRosterCacheForTests();
			}
			deepStrictEqual(fixture.routeCalls, []);
			strictEqual(fixture.executeCalls.length, 0);
		});
	}
});
