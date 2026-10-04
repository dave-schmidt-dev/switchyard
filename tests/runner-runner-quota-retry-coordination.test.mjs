import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadCheckpoint } from "../src/switchyard/runner/index.mjs";
import {
	completionReceipt,
	runnerTestDir,
	runQueue,
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
function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, {
		cwd: projectPath,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
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
	it("continues once in the owned workspace only after lifecycle proof", () => {
		const tasksPath = writeTasksFile(`## Phase 1

### Task 1.1: Complete missing path
- **Status:** pending
- **Files:** src/a.mjs
- **Description:** add the declared file
`);
		let gateCalls = 0;
		let monotonic = 0;
		const fixture = makeQuotaRetryDependencies({
			routePlan: [
				{ provider: "agy", model: "fixture-gemini", target: "agy-gemini" },
			],
			integrationGate: () => {
				gateCalls += 1;
				return gateCalls === 1
					? {
							success: false,
							message: "required_paths_missing",
							missingPaths: ["src/a.mjs"],
						}
					: { success: true, message: "ok" };
			},
		});
		fixture.dependencies.now = () => monotonic;
		fixture.dependencies.monotonicNow = () => monotonic;
		fixture.dependencies.adapters.agy.supportsCompletionContinuation = true;
		const executeWithReceipt = fixture.dependencies.adapters.agy.execute;
		fixture.dependencies.adapters.agy.execute = (...args) => {
			const execution = executeWithReceipt(...args);
			if (fixture.executeCalls.length === 1) monotonic = 1_000;
			return {
				...execution,
				completionContinuationProof: completionReceipt(args[2]),
			};
		};
		fixture.dependencies.completionContinuation = { enabled: true };

		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath: TEST_DIR,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: fixture.dependencies,
		});
		strictEqual(result.results[0].success, true);
		deepStrictEqual(fixture.executeCalls, ["agy", "agy"]);
		strictEqual(fixture.routeCalls.length, 1);
		strictEqual(fixture.executeOptions[0].timeoutMs, 1_800_000);
		strictEqual(fixture.executeOptions[1].timeoutMs, 1_799_000);
		// The continuation is the same attempt continuing: a
		// completion_correction allocation must not move the cleanup context
		// (and therefore the minted receipt) to attempt-2, or the route-health
		// binding keyed on attempt-1 could never match it.
		deepStrictEqual(
			fixture.executeOptions.map((options) => options.cleanupContext.attemptId),
			["attempt-1", "attempt-1"],
		);
		const checkpoint = loadCheckpoint(
			`${tasksPath}.checkpoint.json`,
			tasksPath,
		);
		deepStrictEqual(checkpoint.providerAttemptAllocations, [
			{
				taskId: "1.1",
				reason: "completion_correction",
				state: "result_recorded",
				allocatedAt: checkpoint.providerAttemptAllocations[0].allocatedAt,
				deadline: checkpoint.providerAttemptAllocations[0].deadline,
				descriptorIdentity:
					checkpoint.providerAttemptAllocations[0].descriptorIdentity,
				workspaceId: "owned-retry-container",
				baseTree: TASK_BASE.tree,
				attemptId: "attempt-1",
			},
		]);
	});
	it("accepts a declared subset through the real gate without correction", () => {
		const projectPath = join(TEST_DIR, "completion-real-gate");
		mkdirSync(projectPath, { recursive: true });
		runFixtureGit(projectPath, ["init", "-q"]);
		writeFileSync(join(projectPath, "README.md"), "fixture\n");
		runFixtureGit(projectPath, ["add", "README.md"]);
		runFixtureGit(projectPath, [
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"base",
		]);
		const headBefore = runFixtureGit(projectPath, ["rev-parse", "HEAD"]);
		const baseTree = runFixtureGit(projectPath, [
			"rev-parse",
			`${headBefore}^{tree}`,
		]);
		const workerPath = join(TEST_DIR, "completion-worker-repo");
		const clone = spawnSync("git", ["clone", "-q", projectPath, workerPath], {
			encoding: "utf8",
		});
		strictEqual(clone.status, 0, clone.stderr);
		const tasksPath = writeTasksFile(`### Task 1.1: Complete both files
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs, src/b.mjs
- **Description:** add both declared files
`);
		let executions = 0;
		let commits = 0;
		let resets = 0;
		let teardowns = 0;
		const adapter = {
			supportsCompletionContinuation: true,
			execute: (_prompt, _workspace, options) => {
				executions += 1;
				mkdirSync(join(workerPath, "src"), { recursive: true });
				if (executions === 1) {
					writeFileSync(join(workerPath, "src/a.mjs"), "export const a = 1;\n");
					runFixtureGit(workerPath, ["add", "src/a.mjs"]);
					runFixtureGit(workerPath, [
						"-c",
						"user.name=Worker",
						"-c",
						"user.email=worker@example.invalid",
						"commit",
						"-qm",
						"provider commit",
					]);
				} else {
					writeFileSync(join(workerPath, "src/b.mjs"), "export const b = 2;\n");
					runFixtureGit(workerPath, ["add", "-N", "src/b.mjs"]);
				}
				return {
					success: true,
					output: "ignored",
					completionContinuationProof: completionReceipt(options),
				};
			},
			captureDiff: () =>
				runFixtureGit(workerPath, ["diff", "--binary", headBefore]),
		};
		const result = runQueue({
			tasksFilePath: tasksPath,
			projectPath,
			checkpointPath: `${tasksPath}.checkpoint.json`,
			dependencies: {
				completionContinuation: { enabled: true },
				route: () => ({
					provider: "agy",
					model: "fixture-model",
					resolvedTargetId: "agy-fixture",
					resolved_harness: "agy",
				}),
				recordDispatch: () => {},
				recordDispatchIntent: () => {},
				adapters: { agy: adapter },
				backendFactory: () => ({
					readiness: () => ({ inventoryCount: 0 }),
					ensureAgentContainer: () => {},
					create: () => "completion-worker",
					provision: () => {},
					seed: () => {},
					commit: () => {
						commits += 1;
						runFixtureGit(workerPath, ["add", "-A"]);
						runFixtureGit(workerPath, [
							"-c",
							"user.name=Runner",
							"-c",
							"user.email=runner@example.invalid",
							"commit",
							"-qm",
							"accepted correction",
						]);
					},
					reset: () => {
						resets += 1;
					},
					captureTaskBase: () => ({ ref: headBefore, tree: baseTree }),
					validateTaskBase: (_workspace, base) => base,
					releaseTaskBase: () => {},
					destroy: () => {
						teardowns += 1;
					},
				}),
			},
		});
		strictEqual(
			result.results[0].success,
			true,
			JSON.stringify(result.results[0]),
		);
		strictEqual(executions, 1);
		strictEqual(commits, 1);
		strictEqual(resets, 0);
		strictEqual(teardowns, 1);
		strictEqual(
			runFixtureGit(workerPath, ["rev-list", "--count", `${headBefore}..HEAD`]),
			"1",
		);
		strictEqual(
			readFileSync(join(projectPath, "src/a.mjs"), "utf8"),
			"export const a = 1;\n",
		);
		ok(!existsSync(join(projectPath, "src/b.mjs")));
		strictEqual(runFixtureGit(projectPath, ["rev-parse", "HEAD"]), headBefore);
	});
});
