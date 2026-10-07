import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
} from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import { invalidCompletedQuickCheckTaskIds } from "../src/switchyard/runner/checks.mjs";
import {
	loadCheckpoint,
	parseTaskQueue,
	runQueueAsync,
} from "../src/switchyard/runner/index.mjs";
import { runQueueAsync as runFixtureQueueAsync } from "./helpers/async-runner-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const TEST_DIR = tempDir("switchyard-quick-checks-queue-");
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, content, "utf8");
	return tasksPath;
}
function writeLegacyCheckpoint(path, checkpoint) {
	writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
}
function fixturePreflightReadSnapshot() {
	// Keep the real queue preflight deterministic without reading host quota.
	return {
		snapshot: {
			schema_version: 2,
			updated_at: new Date().toISOString(),
			providers: [
				{
					name: "claude",
					ok: true,
					windows: [{ percent_left: 80, pace_delta: 1 }],
				},
			],
		},
		snapshotStatus: "fresh",
		snapshotMtime: 1,
		snapshotAgeMsAtRoute: 0,
	};
}
function runFixtureGit(projectPath, args) {
	const result = spawnSync("git", args, { cwd: projectPath, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}
afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});
describe("Task 51 quick-check regression", () => {
	it("blocks checkpoint completion and dependents until a new candidate passes", async () => {
		const project = join(TEST_DIR, "task-51-queue");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				private: true,
				scripts: { lint: "node --check src/a.mjs" },
			}),
		);
		writeFileSync(join(project, "src/a.mjs"), "export const answer = 1;\n");
		runFixtureGit(project, ["init", "-q"]);
		runFixtureGit(project, ["add", "."]);
		runFixtureGit(project, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"base",
		]);
		const base = runFixtureGit(project, ["rev-parse", "HEAD^{tree}"]);
		const source = join(project, "src/a.mjs");
		const patchFor = (contents) => {
			writeFileSync(source, contents);
			const patch = runFixtureGit(project, ["diff", "--", "src/a.mjs"]);
			writeFileSync(source, "export const answer = 1;\n");
			return patch;
		};
		let patch = patchFor("export const = ;\n");
		const tasksPath = writeTasksFile(`### Task 51: Fix lint
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Quick checks:** npm run lint
- **Description:** Change the source

### Task 52: Dependent
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
- **Quick checks:** none
- **Blocked by:** Task 51
- **Description:** Follow up
`);
		const checkpointPath = `${tasksPath}.checkpoint.json`;
		let dispatchCount = 0;
		const dependencies = {
			backendFactory: () => ({
				create: () => "fake",
				destroy: () => {},
				seed: () => {},
				commit: () => {},
				reset: () => {},
				readiness: () => ({}),
				captureTaskBase: () => ({
					ref: "refs/switchyard/task-base/test/51",
					tree: base,
				}),
				validateTaskBase: (_id, value) => value,
				releaseTaskBase: () => {},
			}),
			route: () => ({
				provider: "claude",
				model: "claude-sonnet-5-5",
				percentLeft: 80,
				reason: "spread",
			}),
			recordDispatch: () => {
				dispatchCount += 1;
			},
			recordDispatchIntent: () => {},
			integrationGate,
			adapters: {
				claude: {
					execute: () => ({ success: true, output: "done" }),
					executeAsync: async () => ({ success: true, output: "done" }),
					captureDiff: () => patch,
					captureDiffAsync: async () => patch,
				},
			},
			goldenImageVerifiedProviders: ["claude"],
			preflightReadSnapshot: fixturePreflightReadSnapshot,
		};
		const options = {
			tasksFilePath: tasksPath,
			projectPath: project,
			workingContainerName: "fake",
			checkpointPath,
			stopOnFailure: false,
			dependencies,
		};
		const failed = await runFixtureQueueAsync(options);
		deepStrictEqual(failed.completedTaskIds, []);
		strictEqual(dispatchCount, 1);
		const first = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(
			first.results[0].result,
			"check_failed",
			JSON.stringify({
				errorKind: first.results[0].errorKind,
				reasonCode: first.results[0].reasonCode,
				captureStatus: first.results[0].captureStatus,
			}),
		);
		strictEqual(first.results[0].quickCheckReceipt.status, "failed");
		strictEqual(first.results[0].quickCheckReceipt.failureCode, "check_failed");
		strictEqual(first.results[0].quickCheckReceipt.checks[0].index, 0);
		strictEqual(first.results[0].quickCheckReceipt.checks[0].exitCode, 1);
		ok(
			!JSON.stringify(first.results[0].quickCheckReceipt).includes(
				"export const =",
			),
		);
		strictEqual(readFileSync(source, "utf8"), "export const answer = 1;\n");
		const asyncProject = join(TEST_DIR, "task-51-queue-async");
		mkdirSync(join(asyncProject, "src"), { recursive: true });
		writeFileSync(
			join(asyncProject, "package.json"),
			readFileSync(join(project, "package.json")),
		);
		writeFileSync(
			join(asyncProject, "src/a.mjs"),
			"export const answer = 1;\n",
		);
		runFixtureGit(asyncProject, ["init", "-q"]);
		runFixtureGit(asyncProject, ["add", "."]);
		runFixtureGit(asyncProject, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"base",
		]);
		const asyncCheckpointPath = `${tasksPath}.async.checkpoint.json`;
		const asyncDescriptorCore = {
			target_id: "claude",
			model_ref: "claude-sonnet-5-5",
			selector: "claude-sonnet-5-5",
			effort: null,
			variant: null,
			invocation_args: [],
		};
		let asyncExecutionReached = false;
		let asyncSelectionReached = false;
		const failedAsync = await runQueueAsync({
			...options,
			projectPath: asyncProject,
			checkpointPath: asyncCheckpointPath,
			dependencies: {
				...dependencies,
				// The fixture roster carries no host qualification receipts, so the
				// real preflight is stubbed exactly as the async fixture wrapper does.
				queuePreflight: () => ({ ok: true, eligible: true }),
				broker: {
					selectAndReserve: async () => {
						asyncSelectionReached = true;
						return {
							provider: "claude",
							model: "claude-sonnet-5-5",
							resolvedTarget: "claude",
							harness: "claude",
							capability: "standard",
							reason: "fixture",
							snapshotIdentity: { status: "fresh", mtime: null, ageMs: 0 },
						};
					},
					launcherIdentity: () => ({}),
					execute: async () => {
						asyncExecutionReached = true;
						return { success: true };
					},
				},
				resolveDescriptor: () => ({
					...asyncDescriptorCore,
					descriptor_identity: getInvocationDescriptorIdentity(
						asyncDescriptorCore,
						"claude",
					),
				}),
				adapters: {
					claude: {
						executeAsync: async () => ({ success: true, output: "done" }),
						captureDiffAsync: async () => patch,
					},
				},
			},
		});
		deepStrictEqual(failedAsync.completedTaskIds, []);
		strictEqual(asyncSelectionReached, true);
		strictEqual(asyncExecutionReached, true);
		const asyncResult = loadCheckpoint(
			asyncCheckpointPath,
			tasksPath,
		).results.at(-1);
		strictEqual(asyncResult.result, "check_failed");

		patch = null;
		const captureFailed = await runFixtureQueueAsync(options);
		deepStrictEqual(captureFailed.completedTaskIds, []);
		strictEqual(
			loadCheckpoint(checkpointPath, tasksPath).results.at(-1).result,
			"diff_capture_failed",
		);

		patch = "";
		const empty = await runFixtureQueueAsync(options);
		deepStrictEqual(empty.completedTaskIds, []);
		strictEqual(
			loadCheckpoint(checkpointPath, tasksPath).results.at(-1).result,
			"check_failed",
		);

		patch = patchFor("export const answer = 2;\n");
		const passed = await runFixtureQueueAsync(options);
		ok(passed.completedTaskIds.includes("51"));
		const second = loadCheckpoint(checkpointPath, tasksPath);
		strictEqual(second.results[0].quickCheckReceipt.status, "failed");
		const passingReceipt = second.results.find(
			(item) => item.taskId === "51" && item.success,
		).quickCheckReceipt;
		strictEqual(passingReceipt.status, "passed");
		strictEqual(passingReceipt.attempt, 4);
		notStrictEqual(
			passingReceipt.diffSha256,
			second.results[0].quickCheckReceipt.diffSha256,
		);
		const pendingIntent = structuredClone(second);
		pendingIntent.integrationIntents["51"].status = "pending";
		deepStrictEqual(
			invalidCompletedQuickCheckTaskIds(
				parseTaskQueue(readFileSync(tasksPath, "utf8")),
				pendingIntent,
			),
			["51"],
		);
		writeLegacyCheckpoint(checkpointPath, pendingIntent);
		await rejects(runFixtureQueueAsync(options));
		const wrongAttempt = structuredClone(second);
		wrongAttempt.results.find(
			(item) => item.taskId === "51" && item.success,
		).attempt = 3;
		deepStrictEqual(
			invalidCompletedQuickCheckTaskIds(
				parseTaskQueue(readFileSync(tasksPath, "utf8")),
				wrongAttempt,
			),
			["51"],
		);
		writeLegacyCheckpoint(checkpointPath, wrongAttempt);
		await rejects(runFixtureQueueAsync(options));
		const beforeReceipts = structuredClone(second);
		delete beforeReceipts.results.find(
			(item) => item.taskId === "51" && item.success,
		).quickCheckReceipt;
		writeLegacyCheckpoint(checkpointPath, beforeReceipts);
		await rejects(
			runFixtureQueueAsync(options),
			/exact passing Quick check receipt/,
		);
	});
});
