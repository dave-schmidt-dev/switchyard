// @test-phase: other
// simple end to end: a provider's rename or copy is captured rename-free, so
// an executable bit that a pure rename used to carry unseen now meets the
// executable rule and the `--allow-executable` opt-in. Peer history is diffed
// rename-free too, whatever the host config says, so a peer that renames or
// copies an executable stops the run as `host_concurrency`.

import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
process.env.SWITCHYARD_RUN_STORE_ROOT = tempDir("switchyard-rename-state-");

after(() => {
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
});

const SCRIPT = "#!/bin/sh\necho one\necho two\necho three\n";

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
	const root = tempDir("switchyard-rename-exec-simple-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "src"), { recursive: true });
	mkdirSync(join(projectPath, "bin"));
	writeFileSync(join(projectPath, "src", "a.txt"), "base a\n");
	writeFileSync(join(projectPath, "bin", "run"), SCRIPT);
	chmodSync(join(projectPath, "bin", "run"), 0o755);
	writeFileSync(join(projectPath, "bin", "plain"), SCRIPT);
	git(projectPath, ["init", "-q"]);
	commit(projectPath, "base");
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change files", "utf8");
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

function dependencies(repo, executeProvider) {
	return {
		now: () => 1_000,
		taskId: "simple-rename-executable-test",
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
			executeProvider(worktreePath);
			return { success: true, code: 0, writerLifecycle: "stopped" };
		},
		runCheck: async () => ({ success: true, writerLifecycle: "stopped" }),
	};
}

const mode = (repo, path) =>
	statSync(join(repo.projectPath, path)).mode & 0o777;

function copyWithMode(dir, from, to) {
	copyFileSync(join(dir, from), join(dir, to));
	chmodSync(join(dir, to), statSync(join(dir, from)).mode);
}

describe("simple provider renames and copies", () => {
	it("refuses renaming a declared executable even with the destination opted in", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo, {
				files: ["bin/run", "bin/tool"],
				allowExecutables: ["bin/tool"],
			}),
			dependencies(repo, (w) => git(w, ["mv", "bin/run", "bin/tool"])),
		);
		strictEqual(result.failureReason, "unsafe_diff");
		strictEqual(result.diffRejection.rule, "executable_file_refused");
		strictEqual(mode(repo, "bin/run"), 0o755);
		strictEqual(existsSync(join(repo.projectPath, "bin/tool")), false);
	});

	it("integrates renaming a declared plain file", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo, { files: ["bin/plain", "bin/moved"] }),
			dependencies(repo, (w) => git(w, ["mv", "bin/plain", "bin/moved"])),
		);
		strictEqual(result.status, "succeeded", result.failureReason);
		strictEqual(existsSync(join(repo.projectPath, "bin/plain")), false);
		strictEqual(mode(repo, "bin/moved"), 0o644);
	});

	it("grants a copied executable only with the destination opted in", async () => {
		const refusedRepo = makeRepo();
		const refused = await runSimpleTask(
			options(refusedRepo, { files: ["bin/tool"] }),
			dependencies(refusedRepo, (w) => copyWithMode(w, "bin/run", "bin/tool")),
		);
		strictEqual(refused.failureReason, "unsafe_diff");
		strictEqual(refused.diffRejection.rule, "executable_file_refused");
		strictEqual(existsSync(join(refusedRepo.projectPath, "bin/tool")), false);

		const grantedRepo = makeRepo();
		const granted = await runSimpleTask(
			options(grantedRepo, {
				files: ["bin/tool"],
				allowExecutables: ["bin/tool"],
			}),
			dependencies(grantedRepo, (w) => copyWithMode(w, "bin/run", "bin/tool")),
		);
		strictEqual(granted.status, "succeeded", granted.failureReason);
		strictEqual(mode(grantedRepo, "bin/tool"), 0o755);
	});

	it("grants renaming a plain file and setting its bit only when opted in", async () => {
		const renameAndChmod = (w) => {
			git(w, ["mv", "bin/plain", "bin/tool"]);
			chmodSync(join(w, "bin/tool"), 0o755);
		};
		const refusedRepo = makeRepo();
		const refused = await runSimpleTask(
			options(refusedRepo, { files: ["bin/plain", "bin/tool"] }),
			dependencies(refusedRepo, renameAndChmod),
		);
		strictEqual(refused.diffRejection.rule, "executable_file_refused");
		strictEqual(existsSync(join(refusedRepo.projectPath, "bin/plain")), true);

		const grantedRepo = makeRepo();
		const granted = await runSimpleTask(
			options(grantedRepo, {
				files: ["bin/plain", "bin/tool"],
				allowExecutables: ["bin/tool"],
			}),
			dependencies(grantedRepo, renameAndChmod),
		);
		strictEqual(granted.status, "succeeded", granted.failureReason);
		strictEqual(mode(grantedRepo, "bin/tool"), 0o755);
	});
});

describe("simple peer history renames and copies", () => {
	// The provider edits its declared file while a peer commits on the host.
	function withPeer(repo, peer) {
		return dependencies(repo, (w) => {
			writeFileSync(join(w, "src", "a.txt"), "provider a\n");
			peer(repo.projectPath);
			commit(repo.projectPath, "peer");
		});
	}

	it("stops as host_concurrency when a peer renames an executable", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			withPeer(repo, (p) => git(p, ["mv", "bin/run", "bin/tool"])),
		);
		strictEqual(result.failureReason, "host_concurrency");
		strictEqual(
			readFileSync(join(repo.projectPath, "src/a.txt"), "utf8"),
			"base a\n",
		);
		ok(result.partialWorktree, "salvage retained");
	});

	it("stops as host_concurrency when a peer copies an executable under copy detection", async () => {
		const repo = makeRepo();
		git(repo.projectPath, ["config", "diff.renames", "copies"]);
		const result = await runSimpleTask(
			options(repo),
			withPeer(repo, (p) => copyWithMode(p, "bin/run", "bin/tool")),
		);
		strictEqual(result.failureReason, "host_concurrency");
	});

	it("stops as host_concurrency when a peer renames a file and sets its bit", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			withPeer(repo, (p) => {
				git(p, ["mv", "bin/plain", "bin/tool"]);
				chmodSync(join(p, "bin/tool"), 0o755);
			}),
		);
		strictEqual(result.failureReason, "host_concurrency");
	});

	it("still integrates over a peer that renames a plain file", async () => {
		const repo = makeRepo();
		git(repo.projectPath, ["config", "diff.renames", "copies"]);
		const result = await runSimpleTask(
			options(repo),
			withPeer(repo, (p) => git(p, ["mv", "bin/plain", "bin/moved"])),
		);
		strictEqual(result.status, "succeeded", result.failureReason);
		strictEqual(
			readFileSync(join(repo.projectPath, "src/a.txt"), "utf8"),
			"provider a\n",
		);
	});
});
