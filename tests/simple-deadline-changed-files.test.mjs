import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { readRun } from "../src/switchyard/run-store/index.mjs";
import { snapshotGitControl } from "../src/switchyard/simple/args.mjs";
import {
	captureDeadlineChangedFiles,
	runSimpleTask,
} from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdirEnv = process.env.TMPDIR;
const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-suite-tmp-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");
const retainedWorktrees = [];

function makeRepo() {
	const root = tempDir("switchyard-deadline-test-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n", "utf8");
	writeFileSync(join(projectPath, "src", "b.txt"), "base b\n", "utf8");
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
	writeFileSync(promptPath, "Change files", "utf8");
	return { root, projectPath, promptPath };
}

function options(repo, overrides = {}) {
	return {
		promptPath: repo.promptPath,
		projectPath: repo.projectPath,
		capability: "standard",
		files: ["src/a.txt", "src/b.txt"],
		checks: ["test -f src/a.txt"],
		deadlineMs: 10_000,
		...overrides,
	};
}

function dependencies(overrides = {}) {
	return {
		now: () => 1_000,
		taskId: "simple-deadline-test",
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
	if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdirEnv;
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	try {
		rmSync(SUITE_TMPDIR, { recursive: true, force: true });
	} catch {}
});

describe("deadline retained worktree changed files", () => {
	it("reports changed files when provider edits declared file and fails after deadline", async () => {
		const repo = makeRepo();
		let currentTime = 1_000;
		const result = await runSimpleTask(
			options(repo, { deadlineMs: 10_000 }),
			dependencies({
				now: () => currentTime,
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider edit\n",
						"utf8",
					);
					currentTime = 12_000;
					return {
						success: false,
						timedOut: true,
						code: null,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "provider_deadline_exceeded");
		ok(result.partialWorktree, "partialWorktree must be set");
		deepStrictEqual(result.changedFiles, ["src/a.txt"]);
	});

	it("reports changed files when provider commits edit before overrunning deadline", async () => {
		const repo = makeRepo();
		let currentTime = 1_000;
		const result = await runSimpleTask(
			options(repo, { deadlineMs: 10_000 }),
			dependencies({
				now: () => currentTime,
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider committed edit\n",
						"utf8",
					);
					execFileSync("git", ["add", "src/a.txt"], { cwd: worktreePath });
					execFileSync(
						"git",
						[
							"-c",
							"user.name=Switchyard Tests",
							"-c",
							"user.email=switchyard@example.invalid",
							"commit",
							"-qm",
							"provider commit",
						],
						{ cwd: worktreePath },
					);
					currentTime = 12_000;
					return {
						success: false,
						timedOut: true,
						code: null,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "provider_deadline_exceeded");
		ok(result.partialWorktree, "partialWorktree must be set");
		deepStrictEqual(result.changedFiles, ["src/a.txt"]);
	});

	it("reports changed files when provider succeeds after deadline expired", async () => {
		const repo = makeRepo();
		let currentTime = 1_000;
		const result = await runSimpleTask(
			options(repo, { deadlineMs: 10_000 }),
			dependencies({
				now: () => currentTime,
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider late success\n",
						"utf8",
					);
					currentTime = 12_000;
					return {
						success: true,
						code: 0,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "deadline_expired");
		strictEqual(result.failurePhase, "checks");
		ok(result.partialWorktree, "partialWorktree must be set");
		deepStrictEqual(result.changedFiles, ["src/a.txt"]);
	});

	it("reports changed files when provider commits edit and succeeds after deadline", async () => {
		const repo = makeRepo();
		let currentTime = 1_000;
		const result = await runSimpleTask(
			options(repo, { deadlineMs: 10_000 }),
			dependencies({
				now: () => currentTime,
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider committed late success\n",
						"utf8",
					);
					execFileSync("git", ["add", "src/a.txt"], { cwd: worktreePath });
					execFileSync(
						"git",
						[
							"-c",
							"user.name=Switchyard Tests",
							"-c",
							"user.email=switchyard@example.invalid",
							"commit",
							"-qm",
							"provider commit",
						],
						{ cwd: worktreePath },
					);
					currentTime = 12_000;
					return {
						success: true,
						code: 0,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "deadline_expired");
		ok(result.partialWorktree, "partialWorktree must be set");
		deepStrictEqual(result.changedFiles, ["src/a.txt"]);
	});

	it("reports all changed files across commits and uncommitted edits on deadline", async () => {
		const repo = makeRepo();
		let currentTime = 1_000;
		const result = await runSimpleTask(
			options(repo, { deadlineMs: 10_000 }),
			dependencies({
				now: () => currentTime,
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"committed a\n",
						"utf8",
					);
					execFileSync("git", ["add", "src/a.txt"], { cwd: worktreePath });
					execFileSync(
						"git",
						[
							"-c",
							"user.name=Switchyard Tests",
							"-c",
							"user.email=switchyard@example.invalid",
							"commit",
							"-qm",
							"commit a",
						],
						{ cwd: worktreePath },
					);
					writeFileSync(
						join(worktreePath, "src", "b.txt"),
						"uncommitted b\n",
						"utf8",
					);
					currentTime = 12_000;
					return {
						success: false,
						timedOut: true,
						code: null,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "failed");
		ok(result.partialWorktree);
		deepStrictEqual(result.changedFiles.sort(), ["src/a.txt", "src/b.txt"]);
	});

	it("retains worktree with empty changedFiles when provider overruns deadline without edits", async () => {
		const repo = makeRepo();
		let currentTime = 1_000;
		const result = await runSimpleTask(
			options(repo, { deadlineMs: 10_000 }),
			dependencies({
				now: () => currentTime,
				executeProvider: async () => {
					currentTime = 12_000;
					return {
						success: false,
						timedOut: true,
						code: null,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "failed");
		ok(result.partialWorktree);
		deepStrictEqual(result.changedFiles, []);
	});

	it("reports changed files as available when the writer is stopped", () => {
		const repo = makeRepo();
		const control = snapshotGitControl(repo.projectPath);
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "captured\n", "utf8");
		const changed = captureDeadlineChangedFiles({
			worktreePath: repo.projectPath,
			worktreeBaseRevision: "HEAD",
			worktreeGitControl: control,
			writerLifecycle: "stopped",
		});
		deepStrictEqual(changed, { files: ["src/a.txt"], available: true });
	});

	it("marks the capture unavailable when writer lifecycle is not stopped", () => {
		const repo = makeRepo();
		const changed = captureDeadlineChangedFiles({
			worktreePath: repo.projectPath,
			worktreeBaseRevision: "HEAD",
			worktreeGitControl: {},
			writerLifecycle: "unavailable",
		});
		deepStrictEqual(changed, { files: [], available: false });
	});

	it("marks the capture unavailable when capture fails", () => {
		const repo = makeRepo();
		const changed = captureDeadlineChangedFiles({
			worktreePath: repo.projectPath,
			worktreeBaseRevision: "0000000000000000000000000000000000000000",
			worktreeGitControl: null,
			writerLifecycle: "stopped",
		});
		deepStrictEqual(changed, { files: [], available: false });
	});

	it("persists changedFilesUnavailable when the deadline capture is skipped", async () => {
		const repo = makeRepo();
		let currentTime = 1_000;
		const runId = "simple-deadline-changed-files-unavailable";
		const result = await runSimpleTask(
			options(repo, { deadlineMs: 10_000 }),
			dependencies({
				now: () => currentTime,
				runId,
				executeProvider: async () => {
					currentTime = 12_000;
					return {
						success: true,
						code: 0,
						writerLifecycle: "unavailable",
					};
				},
				runCheck: async () => ({ success: true }),
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "deadline_expired");
		deepStrictEqual(result.changedFiles, []);
		const record = await readRun(runId);
		strictEqual(record.failureDetails?.changedFilesUnavailable, true);
	});
});
