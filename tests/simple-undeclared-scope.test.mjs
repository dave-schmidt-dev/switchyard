import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import {
	MAX_UNDECLARED_PATHS,
	partitionUndeclared,
} from "../src/switchyard/simple/undeclared-scope.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_STATE_ROOT = tempDir("switchyard-undeclared-state-");
process.env.SWITCHYARD_RUN_STORE_ROOT = SUITE_STATE_ROOT;

after(() => {
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
});

function git(path, args) {
	return execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
}

function commit(path, message) {
	git(path, ["add", "-A"]);
	git(path, [
		"-c",
		"user.name=Switchyard Tests",
		"-c",
		"user.email=switchyard@example.invalid",
		"commit",
		"-qm",
		message,
	]);
}

function makeRepo() {
	const root = tempDir("switchyard-undeclared-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base a\n", "utf8");
	writeFileSync(join(projectPath, "src", "other.txt"), "base other\n", "utf8");
	writeFileSync(join(projectPath, "src", "input.txt"), "base input\n", "utf8");
	git(projectPath, ["init", "-q"]);
	commit(projectPath, "base");
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

function dependencies(repo, provider, overrides = {}) {
	return {
		now: () => 1_000,
		taskId: "simple-undeclared-test",
		attemptId: "attempt-1",
		tmpdir: () => repo.root,
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
			writeFileSync(join(worktreePath, "src", "a.txt"), "provider a\n", "utf8");
			provider(worktreePath);
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
		onRoutingWarning: () => {},
		...overrides,
	};
}

async function expectRefused(repo, provider, reason, extraOptions = {}) {
	const result = await runSimpleTask(
		options(repo, extraOptions),
		dependencies(repo, provider),
	);
	strictEqual(result.status, "failed", JSON.stringify(result));
	strictEqual(result.failureReason, reason);
	strictEqual(result.undeclaredPaths, undefined);
	strictEqual(
		readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
		"base a\n",
	);
	return result;
}

describe("simple dispatch keeps eligible undeclared edits", () => {
	it("integrates one extra source file and returns a reversible patch", async () => {
		const repo = makeRepo();
		const warnings = [];
		const result = await runSimpleTask(
			options(repo),
			dependencies(
				repo,
				(worktreePath) =>
					writeFileSync(
						join(worktreePath, "src", "other.txt"),
						"provider other\n",
						"utf8",
					),
				{ onRoutingWarning: (line) => warnings.push(line) },
			),
		);
		strictEqual(result.status, "succeeded", JSON.stringify(result));
		deepStrictEqual(result.undeclaredPaths, ["src/other.txt"]);
		ok(result.undeclaredPatchPath.endsWith("undeclared.patch"));
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"provider a\n",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "other.txt"), "utf8"),
			"provider other\n",
		);
		const patch = readFileSync(result.undeclaredPatchPath, "utf8");
		ok(patch.includes("src/other.txt"));
		ok(!patch.includes("src/a.txt"), "patch holds only undeclared paths");
		const reverse = spawnSync(
			"git",
			["apply", "-R", "--check", result.undeclaredPatchPath],
			{ cwd: repo.projectPath, encoding: "utf8" },
		);
		strictEqual(reverse.status, 0, reverse.stderr);
		strictEqual(warnings.length, 1);
		ok(warnings[0].includes("src/other.txt"));
		const record = JSON.parse(
			readFileSync(join(SUITE_STATE_ROOT, "runs", result.runId, "run.json")),
		);
		deepStrictEqual(record.terminalSummary.undeclaredPaths, ["src/other.txt"]);
		strictEqual(
			record.terminalSummary.undeclaredPatchPath,
			result.undeclaredPatchPath,
		);
	});

	it("keeps an added undeclared source file", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, (worktreePath) =>
				writeFileSync(join(worktreePath, "src", "new.txt"), "new\n", "utf8"),
			),
		);
		strictEqual(result.status, "succeeded", JSON.stringify(result));
		deepStrictEqual(result.undeclaredPaths, ["src/new.txt"]);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "new.txt"), "utf8"),
			"new\n",
		);
	});

	it("omits undeclared fields when the diff stays in scope", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, () => {}),
		);
		strictEqual(result.status, "succeeded", JSON.stringify(result));
		strictEqual(result.undeclaredPaths, undefined);
		strictEqual(result.undeclaredPatchPath, undefined);
	});
});

describe("simple dispatch fails closed on ineligible undeclared edits", () => {
	it("refuses an undeclared manifest", async () => {
		const repo = makeRepo();
		const result = await expectRefused(
			repo,
			(worktreePath) =>
				writeFileSync(
					join(worktreePath, "package.json"),
					'{"name":"x"}\n',
					"utf8",
				),
			"undeclared_paths_changed",
		);
		strictEqual(existsSync(join(repo.projectPath, "package.json")), false);
		ok(result.partialWorktree, "salvage retained");
	});

	it("refuses a changed read-only input", async () => {
		const repo = makeRepo();
		await expectRefused(
			repo,
			(worktreePath) =>
				writeFileSync(
					join(worktreePath, "src", "input.txt"),
					"changed\n",
					"utf8",
				),
			"read_only_input_changed",
			{ readOnlyInputs: ["src/input.txt"] },
		);
	});

	it("refuses a deleted undeclared file", async () => {
		const repo = makeRepo();
		await expectRefused(
			repo,
			(worktreePath) => rmSync(join(worktreePath, "src", "other.txt")),
			"undeclared_paths_changed",
		);
		ok(existsSync(join(repo.projectPath, "src", "other.txt")));
	});

	it("refuses an undeclared path that is dirty in the project", async () => {
		const repo = makeRepo();
		writeFileSync(
			join(repo.projectPath, "src", "other.txt"),
			"owner edit\n",
			"utf8",
		);
		await expectRefused(
			repo,
			(worktreePath) =>
				writeFileSync(
					join(worktreePath, "src", "other.txt"),
					"provider other\n",
					"utf8",
				),
			"undeclared_paths_changed",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "other.txt"), "utf8"),
			"owner edit\n",
		);
	});

	it("refuses an undeclared path a peer committed since base", async () => {
		const repo = makeRepo();
		await expectRefused(
			repo,
			(worktreePath) => {
				writeFileSync(
					join(worktreePath, "src", "other.txt"),
					"provider other\n",
					"utf8",
				);
				writeFileSync(
					join(repo.projectPath, "src", "other.txt"),
					"peer other\n",
					"utf8",
				);
				commit(repo.projectPath, "peer other");
			},
			"undeclared_paths_changed",
		);
	});

	it("refuses when any undeclared path is ineligible", async () => {
		const repo = makeRepo();
		await expectRefused(
			repo,
			(worktreePath) => {
				writeFileSync(
					join(worktreePath, "src", "other.txt"),
					"provider other\n",
					"utf8",
				);
				writeFileSync(join(worktreePath, "run.sh"), "echo hi\n", "utf8");
			},
			"undeclared_paths_changed",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "other.txt"), "utf8"),
			"base other\n",
		);
	});
});

describe("undeclared scope through real check sessions", () => {
	it("applies the kept edit inside the check session", async () => {
		const repo = makeRepo();
		const deps = dependencies(repo, (worktreePath) =>
			writeFileSync(
				join(worktreePath, "src", "other.txt"),
				"provider other\n",
				"utf8",
			),
		);
		delete deps.runCheck;
		delete deps.now;
		delete deps.acquireProjectLock;
		delete deps.releaseProjectLock;
		const result = await runSimpleTask(
			options(repo, {
				checks: ['grep -q "provider other" src/other.txt'],
				deadlineMs: Date.now() + 180_000,
			}),
			deps,
		);
		strictEqual(result.status, "succeeded", JSON.stringify(result));
		deepStrictEqual(result.undeclaredPaths, ["src/other.txt"]);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "other.txt"), "utf8"),
			"provider other\n",
		);
	});
});

describe("undeclared scope at integration", () => {
	function extraEdit(worktreePath) {
		writeFileSync(
			join(worktreePath, "src", "other.txt"),
			"provider other\n",
			"utf8",
		);
	}

	it("fails host_concurrency when a peer commits a kept path after checks start", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, extraEdit, {
				runCheck: async () => {
					writeFileSync(
						join(repo.projectPath, "src", "other.txt"),
						"peer other\n",
						"utf8",
					);
					commit(repo.projectPath, "peer other");
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "failed", JSON.stringify(result));
		strictEqual(result.failureReason, "host_concurrency");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "other.txt"), "utf8"),
			"peer other\n",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"base a\n",
		);
	});

	it("fails declared_path_changed_concurrently when a kept path turns dirty", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, extraEdit, {
				runCheck: async () => {
					writeFileSync(
						join(repo.projectPath, "src", "other.txt"),
						"owner edit\n",
						"utf8",
					);
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "failed", JSON.stringify(result));
		strictEqual(result.failureReason, "declared_path_changed_concurrently");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "other.txt"), "utf8"),
			"owner edit\n",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"base a\n",
		);
	});
});

describe("undeclared scope during check repair", () => {
	it("refuses an undeclared path a failing check introduced", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		const result = await runSimpleTask(
			options(repo, { repairChecks: true }),
			dependencies(repo, () => {}, {
				executeProvider: async ({ worktreePath }) => {
					providerCalls += 1;
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider a\n",
						"utf8",
					);
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				runCheck: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "other.txt"),
						"check mutation\n",
						"utf8",
					);
					return { success: false, code: 2, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "failed", JSON.stringify(result));
		strictEqual(result.failurePhase, "diff");
		strictEqual(result.failureReason, "undeclared_paths_changed");
		strictEqual(providerCalls, 1);
	});

	it("keeps a provider undeclared edit through a successful repair", async () => {
		const repo = makeRepo();
		let providerCalls = 0;
		let checkCalls = 0;
		const result = await runSimpleTask(
			options(repo, { repairChecks: true }),
			dependencies(repo, () => {}, {
				isProjectLockOwnedBy: async () => true,
				executeProvider: async ({ worktreePath }) => {
					providerCalls += 1;
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						`provider a ${providerCalls}\n`,
						"utf8",
					);
					writeFileSync(
						join(worktreePath, "src", "other.txt"),
						"provider other\n",
						"utf8",
					);
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				runCheck: async () => {
					checkCalls += 1;
					return {
						success: checkCalls > 1,
						code: checkCalls > 1 ? 0 : 2,
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		strictEqual(result.status, "succeeded", JSON.stringify(result));
		strictEqual(providerCalls, 2);
		deepStrictEqual(result.undeclaredPaths, ["src/other.txt"]);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "other.txt"), "utf8"),
			"provider other\n",
		);
	});
});

describe("partitionUndeclared", () => {
	function headOf(repo) {
		return git(repo.projectPath, ["rev-parse", "HEAD"]);
	}

	function block(path, header = `diff --git a/${path} b/${path}`) {
		return [
			header,
			"index 1111111..2222222 100644",
			`--- a/${path}`,
			`+++ b/${path}`,
			"@@ -1 +1 @@",
			"-base",
			"+next",
			"",
		].join("\n");
	}

	it("refuses .git, escaping, renamed and deleted paths", () => {
		const repo = makeRepo();
		const base = headOf(repo);
		const diff = [
			block("nested/.git/config"),
			block("../outside.txt"),
			[
				"diff --git a/src/old.txt b/src/moved.txt",
				"similarity index 100%",
				"rename from src/old.txt",
				"rename to src/moved.txt",
				"",
			].join("\n"),
			[
				"diff --git a/src/gone.txt b/src/gone.txt",
				"deleted file mode 100644",
				"index 1111111..0000000",
				"",
			].join("\n"),
		].join("");
		const result = partitionUndeclared({
			undeclared: [
				"nested/.git/config",
				"../outside.txt",
				"src/moved.txt",
				"src/gone.txt",
			],
			diff,
			projectPath: repo.projectPath,
			baseRevision: base,
		});
		deepStrictEqual(result.eligible, []);
		strictEqual(result.ineligible.length, 4);
		strictEqual(result.patch, "");
	});

	it("refuses more than the eligible path cap", () => {
		const repo = makeRepo();
		const paths = Array.from(
			{ length: MAX_UNDECLARED_PATHS + 1 },
			(_, index) => `src/extra-${index}.txt`,
		);
		for (const path of paths)
			writeFileSync(join(repo.projectPath, path), "base\n", "utf8");
		commit(repo.projectPath, "extras");
		const base = headOf(repo);
		const result = partitionUndeclared({
			undeclared: paths,
			diff: paths.map((path) => block(path)).join(""),
			projectPath: repo.projectPath,
			baseRevision: base,
		});
		deepStrictEqual(result.eligible, []);
		strictEqual(result.ineligible.length, MAX_UNDECLARED_PATHS + 1);
		const atCap = partitionUndeclared({
			undeclared: paths.slice(0, MAX_UNDECLARED_PATHS),
			diff: paths
				.slice(0, MAX_UNDECLARED_PATHS)
				.map((path) => block(path))
				.join(""),
			projectPath: repo.projectPath,
			baseRevision: base,
		});
		strictEqual(atCap.eligible.length, MAX_UNDECLARED_PATHS);
		deepStrictEqual(atCap.ineligible, []);
	});
});
