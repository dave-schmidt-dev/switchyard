import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { cwd } from "node:process";
import { afterEach, describe, it } from "node:test";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import { getInvocationDescriptorIdentity } from "../src/switchyard/roster/index.mjs";
import {
	invalidCompletedQuickCheckTaskIds,
	quickCheckSandboxProfile,
	runQuickChecks,
	runQuickChecksAsync,
} from "../src/switchyard/runner/checks.mjs";
import {
	loadCheckpoint,
	parseTaskQueue,
	runQueue,
	runQueueAsync,
	runQueueWithOrchestrator,
} from "../src/switchyard/runner/index.mjs";

const TEST_DIR = join(cwd(), ".switchyard-quick-check-test");
function writeTasksFile(content) {
	mkdirSync(TEST_DIR, { recursive: true });
	const tasksPath = join(TEST_DIR, "tasks.md");
	writeFileSync(tasksPath, content, "utf8");
	return tasksPath;
}
function writeLegacyCheckpoint(path, checkpoint) {
	writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
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
	it("confines provider-edited checks to the candidate and runtime", async () => {
		const project = join(TEST_DIR, "task-check-sandbox");
		mkdirSync(project, { recursive: true });
		const outside = join(TEST_DIR, "outside-marker");
		writeFileSync(outside, "host-only");
		const listener = createServer();
		await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
		const port = listener.address().port;
		try {
			writeFileSync(
				join(project, "package.json"),
				JSON.stringify({ scripts: { lint: "node --test check.mjs" } }),
			);
			writeFileSync(
				join(project, "check.mjs"),
				`import { readFileSync, writeFileSync } from "node:fs";\nimport { connect } from "node:net";\nconst outside = ${JSON.stringify(outside)};\ntry { readFileSync(outside); throw new Error("host path readable"); } catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }\ntry { writeFileSync(outside, "modified"); throw new Error("host path writable"); } catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }\nawait new Promise((resolve, reject) => { const socket = connect({ host: "127.0.0.1", port: ${port} }); socket.on("connect", () => { socket.destroy(); reject(new Error("network reachable")); }); socket.on("error", (error) => ["EPERM", "EACCES"].includes(error.code) ? resolve() : reject(error)); });\n`,
			);
			writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
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
			const baseTree = runFixtureGit(project, ["rev-parse", "HEAD^{tree}"]);
			writeFileSync(join(project, "a.mjs"), "export const a = 2;\n");
			const diff = runFixtureGit(project, ["diff", "--", "a.mjs"]);
			writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
			const receipt = runQuickChecks({
				projectPath: project,
				taskId: "sandbox",
				attempt: 1,
				baseTree,
				diff,
				checks: [["npm", "run", "lint"]],
				allowedPaths: ["a.mjs"],
			});
			strictEqual(receipt.status, "passed");
			strictEqual(receipt.cleanup.status, "complete");
			strictEqual(readFileSync(outside, "utf8"), "host-only");
			ok(
				!quickCheckSandboxProfile(project, TEST_DIR).includes(
					"network-outbound",
				),
			);
		} finally {
			listener.close();
		}
	});
	it("keeps failed lint incomplete and retains an exact failed receipt", () => {
		const project = join(TEST_DIR, "task-51");
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				private: true,
				scripts: { lint: "node --check broken.mjs" },
			}),
		);
		writeFileSync(join(project, "broken.mjs"), "export const answer = 1;\n");
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
		writeFileSync(join(project, "broken.mjs"), "export const = ;\n");
		const diff = runFixtureGit(project, ["diff", "--", "broken.mjs"]);
		writeFileSync(join(project, "broken.mjs"), "export const answer = 1;\n");
		const receipt = runQuickChecks({
			projectPath: project,
			taskId: "51",
			attempt: 1,
			baseTree: base,
			diff,
			checks: [["npm", "run", "lint"]],
		});
		strictEqual(receipt.status, "failed");
		strictEqual(receipt.checks[0].exitCode, 1);
		strictEqual(receipt.cleanup.status, "complete");
		strictEqual(receipt.baseTree, base);
		ok(receipt.candidateTree);
		ok(!JSON.stringify(receipt).includes("export const ="));
	});

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
				model: "claude-sonnet-5",
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
					captureDiff: () => patch,
				},
			},
		};
		const options = {
			tasksFilePath: tasksPath,
			projectPath: project,
			workingContainerName: "fake",
			checkpointPath,
			stopOnFailure: false,
			dependencies,
		};
		const failed = runQueue(options);
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
			model_ref: "claude-sonnet-5",
			selector: "claude-sonnet-5",
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
				broker: {
					selectAndReserve: async () => {
						asyncSelectionReached = true;
						return {
							provider: "claude",
							model: "claude-sonnet-5",
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
		const failedOrchestrator = await runQueueWithOrchestrator({
			...options,
			pollIntervalMs: 1,
			dependencies: {
				...dependencies,
				adapters: { claude: { captureDiffAsync: async () => patch } },
				orchestrator: {
					launch: async () => "job-51",
					status: async () => ({ state: "done" }),
					result: async () => ({ success: true }),
				},
			},
		});
		deepStrictEqual(failedOrchestrator.completedTaskIds, []);
		strictEqual(
			loadCheckpoint(checkpointPath, tasksPath).results.at(-1).result,
			"check_failed",
		);

		patch = null;
		const captureFailed = runQueue(options);
		deepStrictEqual(captureFailed.completedTaskIds, []);
		strictEqual(
			loadCheckpoint(checkpointPath, tasksPath).results.at(-1).result,
			"diff_capture_failed",
		);

		patch = patchFor("export const answer = 2;\n");
		const passed = runQueue(options);
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
		throws(() => runQueue(options));
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
		throws(() => runQueue(options));
		const beforeReceipts = structuredClone(second);
		delete beforeReceipts.results.find(
			(item) => item.taskId === "51" && item.success,
		).quickCheckReceipt;
		writeLegacyCheckpoint(checkpointPath, beforeReceipts);
		throws(() => runQueue(options), /exact passing Quick check receipt/);
	});

	it("rejects missing, misspelled, nested, duplicate and unsupported declarations", () => {
		const contract = (declaration) => `### Task 51: Contract
- **Status:** pending
- **Executor:** switchyard
- **Files:** src/a.mjs
${declaration}
`;
		for (const declaration of [
			"",
			"- **Quik checks:** none",
			"  - **Quick checks:** none",
			"- **Quick checks:** none\n- **Quick checks:** none",
			"- **Quick checks:** npm run lint && echo ok",
			"- **Quick checks:** none\n  - npm run lint",
			"- **Quick checks:** none\n- **Quick check setup:** npm ci --ignore-scripts --offline",
		]) {
			throws(() => parseTaskQueue(contract(declaration)), /Quick check/i);
		}
		deepStrictEqual(
			parseTaskQueue(contract("- **Quick checks:** none"))[0].quickChecks
				.checks,
			[],
		);
		deepStrictEqual(
			parseTaskQueue(`### Task 52: Review
- **Status:** pending
- **Type:** review
- **Executor:** switchyard
- **Quick checks:** none
`)[0].quickChecks.checks,
			[],
		);
	});

	it("reconstructs a prior accepted tree without copying an unrelated untracked file", () => {
		const project = join(TEST_DIR, "task-check-base");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
		writeFileSync(join(project, "check.mjs"), "export const check = 1;\n");
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
		writeFileSync(join(project, "a.mjs"), "export const a = 2;\n");
		writeFileSync(join(project, "b.mjs"), "export const b = 1;\n");
		runFixtureGit(project, ["add", "-A"]);
		const baseTree = runFixtureGit(project, ["write-tree"]);
		runFixtureGit(project, ["reset", "-q"]);
		writeFileSync(
			join(project, "local-untracked-secret.txt"),
			"local-only fixture\n",
		);
		writeFileSync(join(project, "check.mjs"), "export const check = 2;\n");
		const diff = runFixtureGit(project, ["diff", "--", "check.mjs"]);
		writeFileSync(join(project, "check.mjs"), "export const check = 1;\n");
		const input = {
			projectPath: project,
			taskId: "54",
			attempt: 1,
			baseTree,
			diff,
			checks: [["node", "--check", "check.mjs"]],
			allowedPaths: ["check.mjs"],
			snapshotPaths: ["a.mjs", "b.mjs"],
		};
		const passed = runQuickChecks(input);
		strictEqual(passed.status, "passed");
		strictEqual(passed.cleanup.status, "complete");
		strictEqual(
			runQuickChecks({ ...input, snapshotPaths: ["a.mjs"] }).failureCode,
			"base_mismatch",
		);
	});

	it("kills escaped check helpers after normal and abrupt runner exits", async () => {
		for (const abrupt of [false, true]) {
			const project = join(TEST_DIR, `task-check-child-${abrupt}`);
			mkdirSync(project, { recursive: true });
			let marker = null;
			const script = `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), detached: true, stdio: "ignore" });\nwriteFileSync(join(process.env.HOME, "check-helper.pid"), String(child.pid));\nchild.unref();\n${abrupt ? "setInterval(() => {}, 1000);" : "await new Promise((resolve) => setTimeout(resolve, 200));"}\n`;
			writeFileSync(join(project, "check.mjs"), script);
			writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
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
			const baseTree = runFixtureGit(project, ["rev-parse", "HEAD^{tree}"]);
			writeFileSync(join(project, "a.mjs"), "export const a = 2;\n");
			const diff = runFixtureGit(project, ["diff", "--", "a.mjs"]);
			writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
			let pid = null;
			let runnerPid = null;
			try {
				const pending = runQuickChecksAsync({
					projectPath: project,
					taskId: abrupt ? "56" : "55",
					attempt: 1,
					baseTree,
					diff,
					checks: [["node", "--test", "check.mjs"]],
					allowedPaths: ["a.mjs"],
					onRunnerStarted: (value, root) => {
						runnerPid = value;
						marker = join(root, "check-helper.pid");
					},
				});
				for (let i = 0; i < 100 && !existsSync(marker); i += 1)
					await new Promise((resolve) => setTimeout(resolve, 20));
				ok(existsSync(marker), "check helper must start before cleanup");
				pid = Number(readFileSync(marker, "utf8"));
				if (abrupt) {
					process.kill(runnerPid, "SIGKILL");
				}
				const receipt = await pending;
				if (abrupt) strictEqual(receipt, null);
				else {
					strictEqual(receipt?.status, "passed");
					strictEqual(receipt.cleanup.status, "complete");
				}
				ok(Number.isSafeInteger(pid) && pid > 0);
				const stopped = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				ok(
					stopped.status === 1 || /^Z/u.test(stopped.stdout.trim()),
					"escaped helper must be gone or reaped",
				);
			} finally {
				if (runnerPid) {
					try {
						process.kill(-runnerPid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}
				if (pid) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}
			}
		}
	});

	it("kills a detached helper before synchronous check cleanup", () => {
		const project = join(TEST_DIR, "task-check-sync-child");
		const root = join(TEST_DIR, "check-root");
		mkdirSync(project, { recursive: true });
		mkdirSync(root, { recursive: true });
		const script = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
writeFileSync(join(process.env.HOME, "check-helper.pid"), String(child.pid));
child.unref();
`;
		writeFileSync(join(project, "check.mjs"), script);
		writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
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
		const baseTree = runFixtureGit(project, ["rev-parse", "HEAD^{tree}"]);
		writeFileSync(join(project, "a.mjs"), "export const a = 2;\n");
		const diff = runFixtureGit(project, ["diff", "--", "a.mjs"]);
		writeFileSync(join(project, "a.mjs"), "export const a = 1;\n");
		let pid = null;
		try {
			const receipt = runQuickChecks({
				projectPath: project,
				taskId: "sync-helper",
				attempt: 1,
				baseTree,
				diff,
				checks: [["node", "--test", "check.mjs"]],
				allowedPaths: ["a.mjs"],
				ownedRoot: root,
			});
			strictEqual(receipt.status, "passed");
			const marker = join(root, "check-helper.pid");
			ok(existsSync(marker));
			pid = Number(readFileSync(marker, "utf8"));
			const stopped = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			ok(
				stopped.status === 1 || /^Z/u.test(stopped.stdout.trim()),
				"detached helper must be gone before receipt returns",
			);
		} finally {
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}
		}
	});

	it("runs declared offline dependency setup before the check", () => {
		const project = join(TEST_DIR, "task-setup");
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				name: "task-setup-fixture",
				version: "1.0.0",
				private: true,
			}),
		);
		writeFileSync(
			join(project, "package-lock.json"),
			JSON.stringify({
				name: "task-setup-fixture",
				version: "1.0.0",
				lockfileVersion: 3,
				requires: true,
				packages: { "": { name: "task-setup-fixture", version: "1.0.0" } },
			}),
		);
		writeFileSync(join(project, "a.mjs"), "export const answer = 1;\n");
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
		const baseTree = runFixtureGit(project, ["rev-parse", "HEAD^{tree}"]);
		writeFileSync(join(project, "a.mjs"), "export const answer = 2;\n");
		const diff = runFixtureGit(project, ["diff", "--", "a.mjs"]);
		writeFileSync(join(project, "a.mjs"), "export const answer = 1;\n");
		const quickChecks = parseTaskQueue(`### Task 53: Setup
- **Status:** pending
- **Executor:** switchyard
- **Files:** a.mjs
- **Quick checks:** node --check a.mjs
- **Quick check setup:** npm ci --ignore-scripts --offline
`)[0].quickChecks;
		const receipt = runQuickChecks({
			projectPath: project,
			taskId: "53",
			attempt: 1,
			baseTree,
			diff,
			...quickChecks,
			allowedPaths: ["a.mjs"],
		});
		strictEqual(receipt.status, "passed");
		strictEqual(receipt.setup.exitCode, 0);
		strictEqual(receipt.checks[0].exitCode, 0);
	});
});
