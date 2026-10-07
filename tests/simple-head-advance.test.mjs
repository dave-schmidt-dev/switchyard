import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	FAILURE_REGISTRY,
	resolveFailure,
} from "../src/switchyard/diagnostics/failure-registry.mjs";
import {
	captureDirtyOverlay,
	validateDirtyOverlayReceipt,
} from "../src/switchyard/lifecycle/index.mjs";
import { headAdvanceSafe } from "../src/switchyard/simple/head-advance.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_STATE_ROOT = tempDir("switchyard-head-advance-state-");
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
	const root = tempDir("switchyard-head-advance-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	writeFileSync(join(projectPath, "src", "a.txt"), "base a\n", "utf8");
	writeFileSync(join(projectPath, "src", "b.txt"), "base b\n", "utf8");
	writeFileSync(join(projectPath, "src", "other.txt"), "base other\n", "utf8");
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
		files: ["src/a.txt", "src/b.txt"],
		checks: ["test -f src/a.txt"],
		deadlineMs: 100_000,
		...overrides,
	};
}

function dependencies(repo, overrides = {}) {
	return {
		now: () => 1_000,
		taskId: "simple-head-advance-test",
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
		...overrides,
	};
}

describe("headAdvanceSafe", () => {
	it("is safe while peer commits stay outside the declared paths", () => {
		const repo = makeRepo();
		const base = git(repo.projectPath, ["rev-parse", "HEAD"]);
		writeFileSync(join(repo.projectPath, "src", "other.txt"), "peer\n", "utf8");
		commit(repo.projectPath, "peer unrelated");
		const head = git(repo.projectPath, ["rev-parse", "HEAD"]);
		strictEqual(
			headAdvanceSafe({
				projectPath: repo.projectPath,
				base,
				head,
				paths: ["src/a.txt", "src/b.txt"],
			}),
			true,
		);
	});

	it("is unsafe when a peer commit touches a declared path", () => {
		const repo = makeRepo();
		const base = git(repo.projectPath, ["rev-parse", "HEAD"]);
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "peer a\n", "utf8");
		commit(repo.projectPath, "peer declared");
		const head = git(repo.projectPath, ["rev-parse", "HEAD"]);
		strictEqual(
			headAdvanceSafe({
				projectPath: repo.projectPath,
				base,
				head,
				paths: ["src/a.txt", "src/b.txt"],
			}),
			false,
		);
	});

	it("is unsafe when the head does not descend from the base", () => {
		const repo = makeRepo();
		const base = git(repo.projectPath, ["rev-parse", "HEAD"]);
		git(repo.projectPath, ["checkout", "-q", "-b", "side"]);
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "side a\n", "utf8");
		commit(repo.projectPath, "side");
		const side = git(repo.projectPath, ["rev-parse", "HEAD"]);
		git(repo.projectPath, ["checkout", "-q", base]);
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "main a\n", "utf8");
		commit(repo.projectPath, "main");
		const main = git(repo.projectPath, ["rev-parse", "HEAD"]);
		strictEqual(
			headAdvanceSafe({
				projectPath: repo.projectPath,
				base: side,
				head: main,
				paths: ["src/a.txt"],
			}),
			false,
		);
	});

	it("is safe at the same revision, without declared paths, and refuses a bad probe", () => {
		const repo = makeRepo();
		const base = git(repo.projectPath, ["rev-parse", "HEAD"]);
		strictEqual(
			headAdvanceSafe({
				projectPath: repo.projectPath,
				base,
				head: base,
				paths: ["src/a.txt"],
			}),
			true,
		);
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "peer a\n", "utf8");
		commit(repo.projectPath, "peer declared");
		const head = git(repo.projectPath, ["rev-parse", "HEAD"]);
		strictEqual(
			headAdvanceSafe({
				projectPath: repo.projectPath,
				base,
				head,
				paths: [],
			}),
			true,
		);
		strictEqual(
			headAdvanceSafe({
				projectPath: join(repo.root, "missing"),
				base,
				head,
				paths: [],
			}),
			false,
		);
	});
});

describe("dirty overlay HEAD advancement", () => {
	it("accepts an advanced source HEAD only when the option allows it", () => {
		const repo = makeRepo();
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "dirty a\n", "utf8");
		const receipt = captureDirtyOverlay(
			repo.projectPath,
			["src/a.txt", "src/b.txt"],
			{ allowUnrelated: true },
		);
		writeFileSync(join(repo.projectPath, "src", "other.txt"), "peer\n", "utf8");
		git(repo.projectPath, ["add", "--", "src/other.txt"]);
		git(repo.projectPath, [
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"peer unrelated",
		]);
		const allowed = validateDirtyOverlayReceipt(
			repo.projectPath,
			receipt,
			["src/a.txt", "src/b.txt"],
			{ allowUnrelated: true, allowHeadAdvance: true },
		);
		strictEqual(allowed.ok, true);
		const refused = validateDirtyOverlayReceipt(
			repo.projectPath,
			receipt,
			["src/a.txt", "src/b.txt"],
			{ allowUnrelated: true },
		);
		strictEqual(refused.ok, false);
		strictEqual(refused.reason, "dirty_overlay_source_head_drift");
	});
});

describe("integrate with an advanced project HEAD", () => {
	it("integrates an unrelated peer commit and re-runs the acceptance checks", async () => {
		const repo = makeRepo();
		let checkCalls = 0;
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, {
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider a\n",
						"utf8",
					);
					writeFileSync(
						join(repo.projectPath, "src", "other.txt"),
						"peer other\n",
						"utf8",
					);
					commit(repo.projectPath, "peer unrelated");
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				runCheck: async () => {
					checkCalls += 1;
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "succeeded", JSON.stringify(result));
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"provider a\n",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "other.txt"), "utf8"),
			"peer other\n",
		);
		strictEqual(checkCalls, 2);
	});

	it("fails host_concurrency when a peer commit touches a declared path", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, {
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider a\n",
						"utf8",
					);
					writeFileSync(
						join(repo.projectPath, "src", "a.txt"),
						"peer a\n",
						"utf8",
					);
					commit(repo.projectPath, "peer declared");
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
			}),
		);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "host_concurrency");
		strictEqual(result.failurePhase, "integrate");
		strictEqual(result.providerReliability.causeCode, "host_concurrency");
		strictEqual(result.providerReliability.causeCategory, "environment");
		strictEqual(result.accountability.causeCategory, "environment");
		const resolved = resolveFailure({
			reason: "host_concurrency",
			phase: "integrate",
		});
		strictEqual(resolved.causeCategory, "environment");
		strictEqual(resolved.providerCaused, false);
		strictEqual(FAILURE_REGISTRY.get("host_concurrency").providerCaused, false);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"peer a\n",
		);
	});

	it("fails host_concurrency when a peer commit changes an undeclared manifest", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, {
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider a\n",
						"utf8",
					);
					writeFileSync(
						join(repo.projectPath, "package.json"),
						'{"name":"peer"}\n',
						"utf8",
					);
					commit(repo.projectPath, "peer manifest");
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
			}),
		);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "host_concurrency");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"base a\n",
		);
		ok(result.partialWorktree, "salvage retained");
	});

	it("fails host_concurrency without applying when the advanced-HEAD check fails", async () => {
		const repo = makeRepo();
		writeFileSync(
			join(repo.projectPath, "src", "sentinel.txt"),
			"base sentinel\n",
			"utf8",
		);
		commit(repo.projectPath, "sentinel");
		let checkCalls = 0;
		const result = await runSimpleTask(
			options(repo),
			dependencies(repo, {
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider a\n",
						"utf8",
					);
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
				runCheck: async () => {
					checkCalls += 1;
					if (checkCalls === 1) {
						writeFileSync(
							join(repo.projectPath, "src", "sentinel.txt"),
							"peer sentinel\n",
							"utf8",
						);
						commit(repo.projectPath, "peer sentinel");
						return { success: true, writerLifecycle: "stopped" };
					}
					return {
						success:
							readFileSync(
								join(repo.projectPath, "src", "sentinel.txt"),
								"utf8",
							).trim() === "base sentinel",
						writerLifecycle: "stopped",
					};
				},
			}),
		);
		strictEqual(result.status, "failed");
		strictEqual(result.failureReason, "host_concurrency");
		strictEqual(checkCalls, 2);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"base a\n",
		);
		ok(result.partialWorktree, "salvage retained");
	});
});
