import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
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
import { readEvents, readRun } from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
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
function options(repo, overrides = {}) {
	return {
		promptPath: repo.promptPath,
		projectPath: repo.projectPath,
		capability: "standard",
		files: ["src/a.txt"],
		checks: ["test -f src/a.txt"],
		deadlineMs: 100_000,
		...overrides,
	};
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
		it("records bounded failed-check exit evidence and the exact local recovery identity", async () => {
			const repo = makeRepo();
			const taskId = `failed-check-evidence-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const secretOutput = "PRIVATE_CHECK_OUTPUT_CANARY";
			const result = await runSimpleTask(
				options(repo, { checks: ["test command that must not be persisted"] }),
				dependencies({
					taskId,
					runId,
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
						return { success: true, writerLifecycle: "stopped" };
					},
					runCheck: async () => ({
						success: false,
						code: 37,
						signal: null,
						output: secretOutput,
						stderr: secretOutput,
						writerLifecycle: "stopped",
					}),
				}),
			);
			retain(result, repo.projectPath);

			deepStrictEqual(result.checks, [
				{ index: 1, status: "failed", exitCode: 37, signal: null },
			]);
			strictEqual(result.partialWorktree, result.recovery.partialWorktree);
			strictEqual(result.recovery.identity.taskId, taskId);
			strictEqual(result.recovery.identity.attemptId, result.attemptId);
			strictEqual(result.recovery.cleanup.worktree.state, "retained");
			strictEqual(result.recovery.cleanup.projectLock.state, "released");
			const run = await readRun(runId);
			strictEqual(join(run.worktree.path, "worktree"), result.partialWorktree);
			strictEqual(run.worktree.state, "retained");
			ok(run.worktree.device);
			ok(run.worktree.inode);
			ok(run.worktree.nonce);

			const checkEvent = (await readEvents(runId)).find(
				(event) => event.milestone === "check_finished",
			);
			strictEqual(checkEvent.checkIndex, 1);
			strictEqual(checkEvent.checkStatus, "failed");
			strictEqual(checkEvent.exitCode, 37);
			strictEqual(checkEvent.signal, null);
			ok(!JSON.stringify({ result, run, checkEvent }).includes(secretOutput));
			ok(
				!JSON.stringify({ result, run, checkEvent }).includes(
					"test command that must not be persisted",
				),
			);
		});
		it("records an allowlisted signal when a failed check has no exit code", async () => {
			const repo = makeRepo();
			const taskId = `failed-check-signal-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					taskId,
					runId,
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
						return { success: true, writerLifecycle: "stopped" };
					},
					runCheck: async () => ({
						success: false,
						code: null,
						signal: "SIGTERM",
						writerLifecycle: "stopped",
					}),
				}),
			);
			retain(result, repo.projectPath);

			deepStrictEqual(result.checks, [
				{ index: 1, status: "failed", exitCode: null, signal: "SIGTERM" },
			]);
			const checkEvent = (await readEvents(runId)).find(
				(event) => event.milestone === "check_finished",
			);
			strictEqual(checkEvent.exitCode, null);
			strictEqual(checkEvent.signal, "SIGTERM");
		});
		it("drops out-of-range exit codes and unapproved signals from failed checks", async () => {
			const repo = makeRepo();
			const taskId = `failed-check-untrusted-status-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					taskId,
					runId,
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
						return { success: true, writerLifecycle: "stopped" };
					},
					runCheck: async () => ({
						success: false,
						code: 900,
						signal: "UNTRUSTED_SIGNAL_CANARY",
						writerLifecycle: "stopped",
					}),
				}),
			);
			retain(result, repo.projectPath);

			deepStrictEqual(result.checks, [
				{ index: 1, status: "failed", exitCode: null, signal: null },
			]);
			const checkEvent = (await readEvents(runId)).find(
				(event) => event.milestone === "check_finished",
			);
			strictEqual(checkEvent.exitCode, null);
			strictEqual(checkEvent.signal, null);
			ok(
				!JSON.stringify({ result, checkEvent }).includes(
					"UNTRUSTED_SIGNAL_CANARY",
				),
			);
		});
	});
});
