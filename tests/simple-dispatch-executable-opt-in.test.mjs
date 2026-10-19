// @test-phase: serial
import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
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
				dirname(recordedPath) ===
					join(ORIGINAL_REAL_TMPDIR, "switchyard-simple-roots") &&
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
function writeExecutable(worktreePath, path) {
	mkdirSync(dirname(join(worktreePath, path)), { recursive: true });
	writeFileSync(join(worktreePath, path), "#!/bin/sh\necho ok\n", "utf8");
	chmodSync(join(worktreePath, path), 0o755);
}
describe("simple executable opt-in", () => {
	it("integrates a new opted-in executable through checks and the gate", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo, {
				files: ["bin/tool"],
				allowExecutables: ["bin/tool"],
				checks: ["test -x bin/tool"],
			}),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeExecutable(worktreePath, "bin/tool");
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "succeeded", result.failureReason);
		strictEqual(
			statSync(join(repo.projectPath, "bin/tool")).mode & 0o777,
			0o755,
		);
	});
	it("integrates a new shell script that has both opt-ins", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo, {
				files: ["tests/test-foo.sh"],
				allowManifests: ["tests/test-foo.sh"],
				allowExecutables: ["tests/test-foo.sh"],
				checks: ["test -x tests/test-foo.sh"],
			}),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeExecutable(worktreePath, "tests/test-foo.sh");
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.status, "succeeded", result.failureReason);
		strictEqual(
			statSync(join(repo.projectPath, "tests/test-foo.sh")).mode & 0o777,
			0o755,
		);
	});
	it("refuses a new executable that was not opted in", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo, { files: ["bin/tool"], checks: ["test -x bin/tool"] }),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeExecutable(worktreePath, "bin/tool");
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "unsafe_diff");
		strictEqual(result.diffRejection.rule, "executable_file_refused");
		strictEqual(existsSync(join(repo.projectPath, "bin/tool")), false);
	});
	it("refuses an executable bit on a declared file that was not opted in", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo, {
				files: ["bin/tool", "src/a.txt"],
				allowExecutables: ["bin/tool"],
				checks: ["test -x bin/tool"],
			}),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeExecutable(worktreePath, "bin/tool");
					chmodSync(join(worktreePath, "src", "a.txt"), 0o755);
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "unsafe_diff");
		strictEqual(result.diffRejection.rule, "executable_file_refused");
		strictEqual(statSync(join(repo.projectPath, "src/a.txt")).mode & 0o111, 0);
		strictEqual(existsSync(join(repo.projectPath, "bin/tool")), false);
	});
	it("refuses a second, undeclared executable", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo, {
				files: ["bin/tool"],
				allowExecutables: ["bin/tool"],
				checks: ["test -x bin/tool"],
			}),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeExecutable(worktreePath, "bin/tool");
					writeExecutable(worktreePath, "bin/other");
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "undeclared_paths_changed");
		deepStrictEqual(result.diffRejection.paths, ["bin/other"]);
		strictEqual(existsSync(join(repo.projectPath, "bin/tool")), false);
		strictEqual(existsSync(join(repo.projectPath, "bin/other")), false);
	});
});
