import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	readRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import {
	defaultExecuteProvider,
	handleSimple,
} from "../src/switchyard/simple/index.mjs";
import { simpleQuarantinePath } from "../src/switchyard/simple/worktree-cleanup.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdirEnv = process.env.TMPDIR;
const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const ORIGINAL_REAL_TMPDIR = realpathSync(tmpdir());
function listRealTmpSimpleDirectoryNames(
	dir = ORIGINAL_REAL_TMPDIR,
	prefix = "switchyard-simple-",
) {
	return new Set(
		readdirSync(dir, { withFileTypes: true })
			.filter((dirent) => dirent.name.startsWith(prefix))
			.map((dirent) => dirent.name),
	);
}
function findNewSimpleRoots(
	initialSnapshot,
	currentEntries,
	prefix = "switchyard-simple-",
) {
	const initialSet =
		initialSnapshot instanceof Set ? initialSnapshot : new Set(initialSnapshot);
	return Array.from(currentEntries).filter(
		(name) => name.startsWith(prefix) && !initialSet.has(name),
	);
}
function assertNoLeakedSimpleRoots(initialSnapshot, currentEntries, prefix) {
	const leaked = findNewSimpleRoots(initialSnapshot, currentEntries, prefix);
	deepStrictEqual(
		leaked,
		[],
		`isolated simple tests leaked real temp roots: ${leaked.join(", ")}`,
	);
}
const initialRealTmpSimpleRoots =
	listRealTmpSimpleDirectoryNames(ORIGINAL_REAL_TMPDIR);
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-suite-tmp-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");

const retainedWorktrees = [];
function makeRepo() {
	const root = tempDir("switchyard-simple-test-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n", "utf8");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change src/a.txt", "utf8");
	return { root, projectPath, promptPath };
}

function simpleCliArgs(repo, checks = ["test -f src/a.txt"]) {
	return [
		repo.promptPath,
		"--project",
		repo.projectPath,
		"--capability",
		"standard",
		"--file",
		"src/a.txt",
		...checks.flatMap((command) => ["--check", command]),
		"--deadline",
		new Date(61_000).toISOString(),
	];
}
function dependencies(overrides = {}) {
	return {
		now: () => 1_000,
		taskId: "simple-test",
		attemptId: "attempt-1",
		acquireProjectLock: async () => {},
		releaseProjectLock: async () => true,
		route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
		resolveTargetIdentity: () => ({
			targetId: "codex",
			harnessKey: "codex",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => ({
			target_id: "codex",
			selector: "gpt-5.3-codex-spark",
			invocation_args: [],
		}),
		assertFundedRoute: () => {},
		executeProvider: async ({ worktreePath }) => {
			writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n", "utf8");
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		...overrides,
	};
}
function retain(result, projectPath) {
	if (result.partialWorktree) {
		retainedWorktrees.push({
			projectPath,
			worktreePath: result.partialWorktree,
		});
	}
}
afterEach(() => {
	for (const { worktreePath } of retainedWorktrees.splice(0)) {
		const root = dirname(resolve(worktreePath));
		if (
			dirname(root) === SUITE_TMPDIR &&
			basename(root).startsWith("switchyard-simple-")
		) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {}
		}
	}
	if (existsSync(SUITE_TMPDIR)) {
		for (const entry of readdirSync(SUITE_TMPDIR)) {
			if (/^switchyard-simple-[0-9a-f-]{36}$/u.test(entry)) {
				try {
					rmSync(join(SUITE_TMPDIR, entry), { recursive: true, force: true });
				} catch {}
			}
		}
	}
});
after(() => {
	const ownQuarantineRoots = [];
	const ownRealTmpRoots = [];
	const runsDir = join(SUITE_TMPDIR, "run-store", "runs");
	if (existsSync(runsDir)) {
		for (const entry of readdirSync(runsDir)) {
			const recordPath = join(runsDir, entry, "run.json");
			if (!existsSync(recordPath)) continue;
			const record = JSON.parse(readFileSync(recordPath, "utf8"));
			const recordedPath = record.worktree?.path;
			if (
				typeof recordedPath === "string" &&
				dirname(recordedPath) === ORIGINAL_REAL_TMPDIR &&
				existsSync(recordedPath)
			)
				ownRealTmpRoots.push(recordedPath);
			if (record.worktree?.nonce) {
				const quarantine = simpleQuarantinePath(record.worktree.nonce);
				if (existsSync(quarantine)) ownQuarantineRoots.push(quarantine);
			}
		}
	}
	if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdirEnv;
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	try {
		rmSync(SUITE_TMPDIR, { recursive: true, force: true });
	} catch {}

	const syntheticRoot = "switchyard-simple-synthetic-leak-check";
	deepStrictEqual(
		findNewSimpleRoots(initialRealTmpSimpleRoots, [
			...initialRealTmpSimpleRoots,
			syntheticRoot,
		]),
		[syntheticRoot],
	);
	throws(
		() =>
			assertNoLeakedSimpleRoots(initialRealTmpSimpleRoots, [
				...initialRealTmpSimpleRoots,
				syntheticRoot,
			]),
		/isolated simple tests leaked real temp roots/,
	);

	deepStrictEqual(
		ownRealTmpRoots,
		[],
		"simple tests leaked owned real temp roots",
	);
	deepStrictEqual(
		ownQuarantineRoots,
		[],
		"simple tests leaked owned quarantines",
	);
});
describe("simple local execution path", () => {
	describe("simple dispatch reliability and regression invariants (SW-R1)", () => {
		it("settles SIGINT during a clean provider, removes the root, and releases the lock", async () => {
			const repo = makeRepo();
			const signalProcess = new EventEmitter();
			const taskId = `sigint-provider-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const terminalWrites = [];
			let providerStartedResolve;
			const providerStarted = new Promise((resolveStarted) => {
				providerStartedResolve = resolveStarted;
			});
			let checkStarted = false;
			let output = null;
			let lockReleases = 0;
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.stdin = { end() {} };
			child.kill = (signal) => {
				queueMicrotask(() => child.emit("close", null, signal));
				return true;
			};

			const running = handleSimple(
				simpleCliArgs(repo),
				dependencies({
					now: () => 1_000,
					taskId,
					runId,
					tmpdir: SUITE_TMPDIR,
					signalProcess,
					writeResult: (line) => {
						output = line;
					},
					releaseProjectLock: async () => {
						lockReleases += 1;
						return true;
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.state === "failed" || patch.state === "succeeded") {
							terminalWrites.push(patch.state);
						}
						return updateRunWithRetry(id, patch);
					},
					executeProvider: (context) =>
						defaultExecuteProvider({
							...context,
							spawnFn: () => {
								providerStartedResolve();
								return child;
							},
						}),
					runCheck: async () => {
						checkStarted = true;
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			await providerStarted;
			signalProcess.emit("SIGINT");
			await running;

			const result = JSON.parse(output);
			retain(result, repo.projectPath);
			strictEqual(signalProcess.exitCode, 130);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "provider_cancelled");
			strictEqual(result.partialWorktree, null);
			strictEqual(result.recovery.cleanup.writer.state, "stopped");
			strictEqual(checkStarted, false);
			strictEqual(lockReleases, 1);
			deepStrictEqual(terminalWrites, ["failed"]);
			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.worktree.state, "removed");
			strictEqual(run.cleanupState, "complete");
			strictEqual(signalProcess.listenerCount("SIGINT"), 0);
			strictEqual(signalProcess.listenerCount("SIGTERM"), 0);
		});
		it("removes a cloned checkout when SIGINT arrives before provider launch", async () => {
			const repo = makeRepo();
			const signalProcess = new EventEmitter();
			const taskId = `sigint-before-provider-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const terminalWrites = [];
			let output = null;
			let providerLaunches = 0;
			let lockReleases = 0;

			await handleSimple(
				simpleCliArgs(repo),
				dependencies({
					now: () => 1_000,
					taskId,
					runId,
					tmpdir: SUITE_TMPDIR,
					signalProcess,
					writeResult: (line) => {
						output = line;
					},
					onStatus: (event) => {
						if (event.milestone === "provider_starting") {
							signalProcess.emit("SIGINT");
						}
					},
					releaseProjectLock: async () => {
						lockReleases += 1;
						return true;
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.state === "failed" || patch.state === "succeeded") {
							terminalWrites.push(patch.state);
						}
						return updateRunWithRetry(id, patch);
					},
					executeProvider: async () => {
						providerLaunches += 1;
						return { success: false, writerLifecycle: "never_started" };
					},
				}),
			);

			const result = JSON.parse(output);
			retain(result, repo.projectPath);
			strictEqual(signalProcess.exitCode, 130);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "provider_cancelled");
			strictEqual(providerLaunches, 0);
			strictEqual(result.partialWorktree, null);
			strictEqual(result.recovery.cleanup.writer.state, "never_started");
			strictEqual(lockReleases, 1);
			deepStrictEqual(terminalWrites, ["failed"]);
			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.worktree.state, "removed");
			strictEqual(run.cleanupState, "complete");
		});
	});
});
