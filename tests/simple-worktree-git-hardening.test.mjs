import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { detachSharedClone } from "../ops/simple-native-launcher-core.mjs";
import {
	snapshotGitControl,
	verifyGitControl,
	worktreeGit,
} from "../src/switchyard/simple/args.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { captureWorktreeDiff } from "../src/switchyard/simple/provider-invocation.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-worktree-git-suite-"));
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");

function gitIn(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
}

function makeRepo() {
	const root = tempDir("switchyard-worktree-git-repo-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base\n", "utf8");
	gitIn(projectPath, ["init", "-q"]);
	gitIn(projectPath, ["add", "-A"]);
	gitIn(projectPath, [
		"-c",
		"user.name=Switchyard Tests",
		"-c",
		"user.email=switchyard@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change src/a.txt", "utf8");
	return { root, projectPath, promptPath };
}

function makeClone() {
	const { root, projectPath } = makeRepo();
	const baseRevision = gitIn(projectPath, ["rev-parse", "HEAD"]).trim();
	const clonePath = join(root, "clone");
	execFileSync(
		"git",
		[
			"clone",
			"--shared",
			"--no-checkout",
			"--quiet",
			"--",
			projectPath,
			clonePath,
		],
		{ timeout: 30_000 },
	);
	execFileSync("git", ["checkout", "--detach", "--quiet", baseRevision], {
		cwd: clonePath,
		timeout: 30_000,
	});
	return { projectPath, clonePath, baseRevision };
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
		tmpdir: () => SUITE_TMPDIR,
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
		runCheck: async () => ({
			success: true,
			code: 0,
			writerLifecycle: "stopped",
		}),
		...overrides,
	};
}

function leakedSimpleRoots() {
	return readdirSync(SUITE_TMPDIR).filter((name) =>
		name.startsWith("switchyard-simple-"),
	);
}

afterEach(() => {
	for (const entry of leakedSimpleRoots()) {
		try {
			rmSync(join(SUITE_TMPDIR, entry), { recursive: true, force: true });
		} catch {}
	}
});

after(() => {
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	try {
		rmSync(SUITE_TMPDIR, { recursive: true, force: true });
	} catch {}
});

describe("hardened host git", () => {
	it("pins git-dir/work-tree, config and environment on worktree git calls", () => {
		const binDir = tempDir("switchyard-fake-git-");
		const worktreePath = tempDir("switchyard-worktree-git-");
		writeFileSync(
			join(binDir, "git"),
			[
				"#!/usr/bin/env node",
				'const fs = require("node:fs");',
				"fs.appendFileSync(",
				'  process.cwd() + "/git-argv.json",',
				"  JSON.stringify({",
				"    args: process.argv.slice(2),",
				"    lang: process.env.LANG,",
				"    noSystem: process.env.GIT_CONFIG_NOSYSTEM,",
				"    globalConfig: process.env.GIT_CONFIG_GLOBAL,",
				"    ceiling: process.env.GIT_CEILING_DIRECTORIES,",
				"    noReplace: process.env.GIT_NO_REPLACE_OBJECTS,",
				'    hasPath: typeof process.env.PATH === "string",',
				'    hasHome: typeof process.env.HOME === "string",',
				'  }) + "\\n",',
				");",
			].join("\n"),
			{ mode: 0o755 },
		);
		const originalPath = process.env.PATH;
		process.env.PATH = originalPath ? `${binDir}:${originalPath}` : binDir;
		try {
			strictEqual(
				worktreeGit(worktreePath, ["diff", "--cached", "HEAD"], {
					timeout: 10_000,
				}).status,
				0,
			);
			strictEqual(
				worktreeGit(worktreePath, ["status", "--porcelain=v1"], {
					timeout: 10_000,
				}).status,
				0,
			);
		} finally {
			process.env.PATH = originalPath;
		}
		const [diffCall, statusCall] = readFileSync(
			join(worktreePath, "git-argv.json"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const observed of [diffCall, statusCall]) {
			deepStrictEqual(observed.args.slice(0, 4), [
				"--git-dir",
				join(worktreePath, ".git"),
				"--work-tree",
				worktreePath,
			]);
			for (const config of [
				"core.fsmonitor=false",
				"core.hooksPath=/dev/null",
				"core.untrackedCache=false",
				"diff.external=",
				"core.attributesFile=/dev/null",
			]) {
				ok(observed.args.includes(config));
			}
			strictEqual(observed.lang, "C");
			strictEqual(observed.noSystem, "1");
			strictEqual(observed.globalConfig, "/dev/null");
			strictEqual(observed.ceiling, dirname(worktreePath));
			strictEqual(observed.noReplace, "1");
			strictEqual(observed.hasPath, true);
			strictEqual(observed.hasHome, true);
		}
		const diffAt = diffCall.args.indexOf("diff");
		deepStrictEqual(diffCall.args.slice(diffAt, diffAt + 3), [
			"diff",
			"--no-ext-diff",
			"--no-textconv",
		]);
		strictEqual(statusCall.args.includes("--no-ext-diff"), false);
	});
});

describe("git control verification", () => {
	it("accepts an untouched clone and a provider that ran git add and git commit", () => {
		const { clonePath, baseRevision } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		verifyGitControl(clonePath, snapshot);
		writeFileSync(join(clonePath, "src", "a.txt"), "provider\n", "utf8");
		gitIn(clonePath, ["add", "-A"]);
		gitIn(clonePath, [
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"provider",
		]);
		verifyGitControl(clonePath, snapshot);
		const captured = captureWorktreeDiff(
			clonePath,
			baseRevision,
			Date.now() + 60_000,
			Date.now,
			snapshot,
		);
		deepStrictEqual(captured.changedFiles, ["src/a.txt"]);
		ok(captured.diff.includes("provider"));
	});

	it("rejects a written .git/config", () => {
		const { clonePath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		appendFileSync(join(clonePath, ".git", "config"), "\n[tamper]\n");
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
	});

	it("rejects a written .git/commondir", () => {
		const { clonePath, projectPath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		writeFileSync(
			join(clonePath, ".git", "commondir"),
			`${join(projectPath, ".git")}\n`,
		);
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
	});

	it("rejects a written .git/objects/info/alternates", () => {
		const { clonePath, projectPath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		appendFileSync(
			join(clonePath, ".git", "objects", "info", "alternates"),
			`${join(projectPath, ".git", "objects")}\n`,
		);
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
	});

	it("rejects a written .git/info/grafts", () => {
		const { clonePath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		const sha = "0123456789012345678901234567890123456789";
		writeFileSync(join(clonePath, ".git", "info", "grafts"), `${sha} ${sha}\n`);
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
	});

	it("rejects a written .git/refs/replace/<sha>", () => {
		const { clonePath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		const sha = "0123456789012345678901234567890123456789";
		mkdirSync(join(clonePath, ".git", "refs", "replace"), { recursive: true });
		writeFileSync(join(clonePath, ".git", "refs", "replace", sha), `${sha}\n`);
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
	});

	it("rejects a packed-refs line naming refs/replace/", () => {
		const { clonePath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		const sha = "0123456789012345678901234567890123456789";
		const packedRefsPath = join(clonePath, ".git", "packed-refs");
		const existing = existsSync(packedRefsPath)
			? readFileSync(packedRefsPath, "utf8")
			: "";
		writeFileSync(packedRefsPath, `${existing}${sha} refs/replace/${sha}\n`);
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
	});

	it("rejects a symlink under .git/objects/", () => {
		const { clonePath, projectPath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		symlinkSync(
			join(projectPath, "src", "a.txt"),
			join(clonePath, ".git", "objects", "tampered-link"),
		);
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
	});

	it("accepts a shared-clone detach that repacks and removes alternates", () => {
		const { clonePath } = makeClone();
		ok(existsSync(join(clonePath, ".git", "objects", "info", "alternates")));
		const snapshot = snapshotGitControl(clonePath);
		detachSharedClone(clonePath);
		ok(!existsSync(join(clonePath, ".git", "objects", "info", "alternates")));
		verifyGitControl(clonePath, snapshot);
	});

	it("rejects a written .git/objects/info/http-alternates", () => {
		const { clonePath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		writeFileSync(
			join(clonePath, ".git", "objects", "info", "http-alternates"),
			"https://example.invalid/objects\n",
		);
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
	});

	it("rejects an unreadable .git entry as tampering", (t) => {
		if (process.getuid?.() === 0) return t.skip("root bypasses file modes");
		const { clonePath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		const config = join(clonePath, ".git", "config");
		chmodSync(config, 0o000);
		try {
			throws(() => verifyGitControl(clonePath, snapshot), {
				code: "git_control_tampered",
			});
		} finally {
			chmodSync(config, 0o644);
		}
	});

	it("rejects a gitfile replacing .git", () => {
		const { clonePath, projectPath } = makeClone();
		const snapshot = snapshotGitControl(clonePath);
		rmSync(join(clonePath, ".git"), { recursive: true, force: true });
		writeFileSync(
			join(clonePath, ".git"),
			`gitdir: ${join(projectPath, ".git")}\n`,
		);
		throws(() => verifyGitControl(clonePath, snapshot), {
			code: "git_control_tampered",
		});
		throws(() => snapshotGitControl(clonePath), {
			code: "git_control_tampered",
		});
	});
});

describe("simple dispatch git hardening", () => {
	it("returns the expected changedFiles and diff for an untouched clone", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(options(repo), dependencies());
		strictEqual(result.status, "succeeded");
		deepStrictEqual(result.changedFiles, ["src/a.txt"]);
		strictEqual(result.checks.length, 1);
		strictEqual(result.checks[0].status, "passed");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"provider\n",
		);
		strictEqual(result.partialWorktree, null);
		deepStrictEqual(leakedSimpleRoots(), []);
	});

	it("fails without running git when the provider rewrites git control and filters", async () => {
		const repo = makeRepo();
		const sentinelPath = join(repo.root, "filter-sentinel");
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					appendFileSync(
						join(worktreePath, ".git", "config"),
						`\n[core]\n\tfsmonitor = true\n[filter "sentinel"]\n\tclean = node -e 'require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "sentinel")'\n\trequired = true\n`,
						"utf8",
					);
					writeFileSync(
						join(worktreePath, ".gitattributes"),
						"*.txt filter=sentinel\n",
						"utf8",
					);
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider\n",
						"utf8",
					);
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "unsafe_diff");
		strictEqual(result.diagnosticCode, "git_control_tampered");
		strictEqual(result.partialWorktree, null);
		strictEqual(existsSync(sentinelPath), false);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"base\n",
		);
		deepStrictEqual(leakedSimpleRoots(), []);
	});

	it("fails without running git when the provider replaces .git with a gitfile", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					rmSync(join(worktreePath, ".git"), {
						recursive: true,
						force: true,
					});
					writeFileSync(
						join(worktreePath, ".git"),
						`gitdir: ${join(repo.projectPath, ".git")}\n`,
						"utf8",
					);
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "unsafe_diff");
		strictEqual(result.diagnosticCode, "git_control_tampered");
		strictEqual(result.partialWorktree, null);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"base\n",
		);
		deepStrictEqual(leakedSimpleRoots(), []);
	});

	it("fails when a baseline check writes .git/config before the provider starts", async () => {
		const repo = makeRepo();
		let providerStarted = false;
		const result = await runSimpleTask(
			options(repo, { baselineChecks: ["true"] }),
			dependencies({
				runCheck: async ({ worktreePath }) => {
					appendFileSync(join(worktreePath, ".git", "config"), "\n[tamper]\n");
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				executeProvider: async () => {
					providerStarted = true;
					throw new Error("provider must not start after baseline tampering");
				},
			}),
		);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "unsafe_diff");
		strictEqual(result.diagnosticCode, "git_control_tampered");
		strictEqual(providerStarted, false);
		strictEqual(result.providerStarted, false);
		strictEqual(result.partialWorktree, null);
		deepStrictEqual(leakedSimpleRoots(), []);
	});
});
