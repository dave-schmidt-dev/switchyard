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
import {
	readRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import {
	cleanupSimpleWorktree,
	simpleQuarantinePath,
} from "../src/switchyard/simple/worktree-cleanup.mjs";
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
		it("removes a successful root from the system temp directory through guarded cleanup", async () => {
			const repo = makeRepo();
			const runId = `simple-guarded-success-${Date.now()}`;
			const statuses = [];
			let ownedPath;
			let ownedNonce;
			try {
				const result = await runSimpleTask(
					options(repo),
					dependencies({
						runId,
						tmpdir: ORIGINAL_REAL_TMPDIR,
						cleanupSimpleWorktree,
						onStatus: (status) => statuses.push(status),
						updateRunWithRetry: async (id, patch) => {
							if (
								patch.worktree?.path &&
								dirname(patch.worktree.path) === ORIGINAL_REAL_TMPDIR
							)
								ownedPath = patch.worktree.path;
							if (patch.worktree?.nonce) ownedNonce = patch.worktree.nonce;
							return updateRunWithRetry(id, patch);
						},
					}),
				);
				strictEqual(result.status, "succeeded");
				const run = await readRun(runId);
				strictEqual(run.cleanupState, "complete");
				strictEqual(run.worktree.state, "removed");
				strictEqual(dirname(ownedPath), ORIGINAL_REAL_TMPDIR);
				strictEqual(existsSync(ownedPath), false);
				strictEqual(existsSync(run.worktree.path), false);
				ok(
					statuses.some(
						(status) => status.processPhase === "cleanup_quarantine_started",
					),
					"production guarded cleanup quarantined the root",
				);
				ok(
					statuses.some(
						(status) => status.processPhase === "cleanup_remove_started",
					),
					"production guarded cleanup removed the root",
				);
			} finally {
				// A failing assertion must not leave this test's real TMPDIR root behind.
				if (
					ownedPath &&
					dirname(ownedPath) === ORIGINAL_REAL_TMPDIR &&
					/^switchyard-simple-[0-9a-f-]{36}$/u.test(basename(ownedPath))
				)
					rmSync(ownedPath, { recursive: true, force: true });
				if (ownedNonce && /^[0-9a-f-]{36}$/u.test(ownedNonce)) {
					const quarantine = simpleQuarantinePath(ownedNonce);
					if (existsSync(quarantine))
						rmSync(quarantine, { recursive: true, force: true });
				}
			}
		});
		it("retains allocation intent when mkdir fails without proving absence", async () => {
			const repo = makeRepo();
			const runId = `simple-mkdir-failure-${Date.now()}`;
			let candidatePath;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					runId,
					mkdirSync: (path) => {
						candidatePath = path;
						throw Object.assign(new Error("allocation unavailable"), {
							code: "EACCES",
						});
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "worktree_allocation_failed");
			strictEqual(result.errorKind, "environment_failure");
			const run = await readRun(runId);
			strictEqual(run.worktree.path, candidatePath);
			strictEqual(run.worktree.state, "retained");
			strictEqual(run.worktree.reason, "worktree_allocation_failed");
			strictEqual(run.cleanupState, "pending");
		});
	});
});
