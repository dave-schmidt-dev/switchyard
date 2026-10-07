import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
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
	it("does not erase present non-array retry collections before validation", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reject non-array retry evidence
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** corrupt retry collection
`);
		for (const corruptField of ["retryAttempts", "retryTransitions"]) {
			const checkpointPath = `${tasksPath}.${corruptField}.checkpoint.json`;
			writeLegacyCheckpoint(checkpointPath, {
				version: 1,
				tasksFilePath: tasksPath,
				completedTaskIds: [],
				lastTaskId: null,
				lastUpdatedAt: null,
				results: [],
				[corruptField]: { forged: true },
			});
			const fixture = makeQuotaRetryDependencies({
				routePlan: [
					{ provider: "agy", model: "fixture-gemini", target: "antigravity" },
				],
			});
			await rejects(
				runQueueAsync({
					tasksFilePath: tasksPath,
					projectPath: TEST_DIR,
					checkpointPath,
					dependencies: fixture.dependencies,
				}),
				new RegExp(`${corruptField} is invalid`),
			);
			deepStrictEqual(fixture.routeCalls, []);
			strictEqual(fixture.executeCalls.length, 0);
		}
	});
	it("halts safely when the mandatory retry reset fails", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Reset failure
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** reset failure
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
			],
			executionOutcomes: {
				agy: [
					{
						success: false,
						output: "",
						error: "quota",
						errorKind: "quota_exhausted",
						diagnosticCode: "quota_exhausted",
						diagnosticOrigin: "adapter",
						diagnosticEvidenceAvailable: true,
						diagnosticRef: VALID_DIAGNOSTIC_REF,
						failurePhase: "provider_execution",
					},
				],
			},
			resetWorkingTree: () => {
				throw new Error("reset implementation failed");
			},
		});

		const result = await runQueueAsync({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath,
			dependencies: fixture.dependencies,
		});

		strictEqual(result.processedTasks, 1);
		strictEqual(result.results[0].result, "halted_after_reset_failure");
		strictEqual(fixture.executeCalls.length, 1);
		const checkpoint = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(checkpoint.retryState, null);
		strictEqual(checkpoint.retryTransitions.at(-1).type, "retry_halted");
		ok(
			!readFileSync(checkpointPath, "utf8").includes(
				"reset implementation failed",
			),
		);
	});
	it("does not infer dead ownership after a real child-process crash", async () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Child crash recovery
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** recover after the provider target is quarantined
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		const runnerUrl = pathToFileURL(
			resolve(cwd(), "src/switchyard/runner/index.mjs"),
		).href;
		const rosterUrl = pathToFileURL(
			resolve(cwd(), "src/switchyard/roster/index.mjs"),
		).href;
		const childScript = `
import { runQueueAsync } from ${JSON.stringify(runnerUrl)};
import { getInvocationDescriptorIdentity } from ${JSON.stringify(rosterUrl)};
const [tasksFilePath, checkpointPath, projectPath] = process.argv.slice(1);
const routePlan = [
  { provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
  { provider: "agy", model: "fixture-claude", target: "agy-claude" },
];
let latestDescriptor = null;
let latestRoutedCandidate = null;
const descriptorFor = (candidate) => {
  const core = {
    target_id: candidate.target,
    model_ref: candidate.model,
    selector: candidate.model,
    effort: null,
    variant: null,
    invocation_args: [],
  };
  return { ...core, descriptor_identity: getInvocationDescriptorIdentity(core, "agy") };
};
const route = ({ exclude = [], only = [] } = {}) => {
  const candidate = routePlan.find((entry) =>
    !exclude.includes(entry.target) &&
    !exclude.includes(entry.provider) &&
    (only.length === 0 || only.includes(entry.target) || only.includes(entry.provider))
  );
  latestRoutedCandidate = candidate ?? null;
  return candidate
    ? (latestDescriptor = descriptorFor(candidate), { ...candidate, resolvedTargetId: candidate.target, invocationDescriptor: latestDescriptor, percentLeft: 50, log: [] })
    : { provider: null, model: null, resolvedTargetId: null, reason: "no_eligible_retry_target", log: [] };
};
await runQueueAsync({
  tasksFilePath,
  projectPath,
  checkpointPath,
  platform: "macos",
  // isQuotaRetryCandidate (runner/index.mjs) only treats a quota_exhausted
  // failure as retryable when ownsWorkingContainer is true, which the queue
  // only sets when IT creates the working container itself -- a caller-
  // supplied workingContainerName skips that bootstrap block entirely and
  // silently disables retry/quarantine. So this crash-recovery test needs a
  // synthetic backendFactory (not a workingContainerName shortcut) to let
  // the queue own the container while still avoiding any real VM lifecycle.
  dependencies: {
    route,
    resolveTargetIdentity: (provider) => {
      const candidate = latestRoutedCandidate;
      return candidate && candidate.provider === provider
        ? { targetId: candidate.target, harnessKey: "agy", ambiguous: false }
        : { targetId: null, harnessKey: null, ambiguous: true };
    },
    resolveDescriptor: () => latestDescriptor,
    recordDispatch: () => {},
		recordDispatchIntent: () => {},
    integrationGate: () => ({ success: true }),
    // No real routing snapshot exists in this child process's cwd; the
    // default macOS preflight gate is irrelevant to what this test proves,
    // so bypass it with this isolated test's injected preflight dependency.
    queuePreflight: () => ({ ok: true, eligible: true }),
    backendFactory: () => ({
      readiness: () => ({ inventoryCount: 0 }),
      ensureAgentContainer: () => {},
      create: () => "child-owned-retry-container",
      provision: () => {},
      seed: () => {},
      commit: () => {},
      reset: () => {},
      captureTaskBase: () => ({ ref: "refs/switchyard/task-base/child-crash/1.1", tree: "4".repeat(40) }),
      validateTaskBase: (_workspaceId, base) => base,
      destroy: () => {},
    }),
    onRetryStateChanged: ({ retryTransitionId }) => {
      if (retryTransitionId === Number(process.env.CRASH_AT)) process.exit(73);
    },
    persistDiagnosticArtifact: async () => "diagnostic:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    adapters: {
      agy: {
        executeAsync: async () => ({
          success: false,
          output: "",
          error: "quota",
          errorKind: "quota_exhausted",
          diagnosticCode: "quota_exhausted",
          diagnosticOrigin: "adapter",
          diagnosticEvidenceAvailable: true,
          diagnosticRef: "diagnostic:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          diagnosticEvidence: {
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            stderrDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            diagnosticKind: "usage_exhausted",
          },
          failurePhase: "provider_execution",
        }),
        captureDiffAsync: async () => "diff --git a/a b/a\\n+change",
      },
    },
  },
});
`;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				childScript,
				tasksPath,
				checkpointPath,
				TEST_DIR,
			],
			{
				encoding: "utf8",
				env: { ...process.env, CRASH_AT: "4" },
			},
		);
		strictEqual(child.status, 73, child.stderr);

		const interrupted = loadCheckpoint(checkpointPath, tasksPath);
		deepStrictEqual(interrupted.quarantinedTargetIds, ["agy-gemini"]);
		strictEqual(interrupted.retryTransitionId, 4);
		strictEqual(interrupted.retryState.phase, "retry_started");
		strictEqual(interrupted.retryState.descriptorHarness, "agy");
		strictEqual(
			interrupted.retryState.invocationDescriptor.target_id,
			interrupted.retryState.resolvedTargetId,
		);

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
			/checkpoint owner displaced/,
		);
		strictEqual(fixture.executeCalls.length, 0);
		deepStrictEqual(fixture.routeCalls, []);
		strictEqual(readFileSync(checkpointPath, "utf8"), before);
	});
});
