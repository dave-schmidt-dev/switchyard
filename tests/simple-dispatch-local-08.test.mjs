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
describe("simple local execution path", () => {
	it("returns useful partial work and no provider stream or credential value", async () => {
		const repo = makeRepo();
		const secret = "SECRET_CANARY_simple_dispatch";
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						`${secret}\n`,
						"utf8",
					);
					return {
						success: false,
						code: 1,
						output: secret,
						stderr: secret,
						writerLifecycle: "stopped",
						providerLifecycle: {
							terminalStatus: "exited",
							exitCode: 1,
							writerLifecycle: "stopped",
						},
					};
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "provider_exit_nonzero");
		strictEqual(result.providerLifecycle?.exitCode, 1);
		ok(result.partialWorktree);
		ok(!JSON.stringify(result).includes(secret));
	});
	for (const [label, providerFields, reason, errorKind] of [
		[
			"adapter error",
			{ error: new Error("adapter rejected the result") },
			"provider_adapter_error",
			"execution_failed",
		],
		[
			"uncertain cleanup",
			{ cleanupStatus: "uncertain" },
			"provider_cleanup_failed",
			"cleanup_failed",
		],
		[
			"otherwise inconsistent result",
			{},
			"provider_result_inconsistent",
			"execution_failed",
		],
	]) {
		it(`keeps code-zero ${label} failed without checks or integration`, async () => {
			const repo = makeRepo();
			let checks = 0;
			let integrations = 0;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider partial\n",
							"utf8",
						);
						return {
							success: false,
							code: 0,
							writerLifecycle: "stopped",
							providerLifecycle: {
								terminalStatus: "exited",
								exitCode: 0,
								writerLifecycle: "stopped",
								cleanupStatus: providerFields.cleanupStatus ?? "not_required",
							},
							...providerFields,
						};
					},
					runCheck: async () => {
						checks += 1;
						return { success: true };
					},
					integrate: async () => {
						integrations += 1;
						return { success: true };
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, reason);
			strictEqual(result.errorKind, errorKind);
			strictEqual(result.providerLifecycle?.exitCode, 0);
			strictEqual(result.partialWorktree !== null, true);
			strictEqual(checks, 0);
			strictEqual(integrations, 0);
		});
	}
	it("returns bound recovery evidence for safe attended continuation", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"partial\n",
						"utf8",
					);
					return { success: false, code: 1, writerLifecycle: "stopped" };
				},
			}),
		);
		retain(result, repo.projectPath);
		const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo.projectPath,
			encoding: "utf8",
		}).trim();
		strictEqual(result.attemptId, "attempt-1");
		strictEqual(result.recovery.identity.taskId, "simple-test");
		strictEqual(result.recovery.identity.attemptId, "attempt-1");
		strictEqual(result.recovery.identity.baseRevision, baseRevision);
		deepStrictEqual(result.recovery.identity.scope.files, ["src/a.txt"]);
		strictEqual(result.recovery.identity.scope.checks[0].index, 1);
		ok(
			/^sha256:[0-9a-f]{64}$/u.test(
				result.recovery.identity.scope.checks[0].digest,
			),
		);
		strictEqual(result.recovery.result.status, "failed");
		strictEqual(result.recovery.cleanup.writer.state, "stopped");
		strictEqual(result.recovery.cleanup.projectLock.state, "released");
		strictEqual(result.recovery.cleanup.worktree.state, "retained");
		strictEqual(result.recovery.continuation.available, true);
	});
});
