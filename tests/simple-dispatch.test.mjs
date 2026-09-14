import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	assessSimpleRecoveryEvidence,
	buildSimpleProviderInvocation,
	parseSimpleArgs,
	runSimpleTask,
} from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const DISPATCH_PATH = resolve(
	__dirname,
	"..",
	"src",
	"switchyard",
	"dispatch",
	"index.mjs",
);
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
			targetId: "codex-spark",
			harnessKey: "codex",
			ambiguous: false,
		}),
		getInvocationDescriptor: () => ({
			target_id: "codex-spark",
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
			dirname(root) === realpathSync(tmpdir()) &&
			basename(root).startsWith("switchyard-simple-")
		) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("simple dispatch argument boundary", () => {
	it("requires one bounded absolute deadline and rejects missing or excessive values", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"low",
			"--file",
			"src/a.txt",
			"--check",
			"true",
		];
		for (const extra of [
			[],
			["--deadline", "not-a-date"],
			["--deadline", "1970-01-01T00:00:00Z"],
			["--deadline", "1970-01-01T01:00:01Z"],
		]) {
			let threw = false;
			try {
				parseSimpleArgs([...base, ...extra], { now: () => 1_000 });
			} catch {
				threw = true;
			}
			strictEqual(threw, true);
		}
		const parsed = parseSimpleArgs(
			[...base, "--deadline", "1970-01-01T00:10:00Z"],
			{ now: () => 1_000 },
		);
		strictEqual(parsed.deadlineMs, 600_000);
	});

	it("rejects credential-shaped and escaping file declarations", () => {
		const repo = makeRepo();
		for (const path of [
			"../outside",
			".git/config",
			".env",
			"keys/id.pem",
			"./src/a.txt",
			"src//a.txt",
			"src/./a.txt",
			"src/",
			"src/*.txt",
			"src\\a.txt",
		]) {
			let threw = false;
			try {
				parseSimpleArgs(
					[
						repo.promptPath,
						"--project",
						repo.projectPath,
						"--capability",
						"low",
						"--file",
						path,
						"--check",
						"true",
						"--deadline",
						"1970-01-01T00:10:00Z",
					],
					{ now: () => 1_000 },
				);
			} catch {
				threw = true;
			}
			strictEqual(threw, true, path);
		}
	});

	it("rejects final and intermediate symlinks in declared paths", () => {
		const repo = makeRepo();
		symlinkSync("a.txt", join(repo.projectPath, "src", "link.txt"));
		symlinkSync("src", join(repo.projectPath, "linked-src"));
		for (const path of ["src/link.txt", "linked-src/a.txt"]) {
			let threw = false;
			try {
				parseSimpleArgs(
					[
						repo.promptPath,
						"--project",
						repo.projectPath,
						"--capability",
						"low",
						"--file",
						path,
						"--check",
						"true",
						"--deadline",
						"1970-01-01T00:10:00Z",
					],
					{ now: () => 1_000 },
				);
			} catch {
				threw = true;
			}
			strictEqual(threw, true, path);
		}
	});

	it("keeps legacy run help available while adding simple help", () => {
		const simple = spawnSync(
			process.execPath,
			[DISPATCH_PATH, "simple", "--help"],
			{
				encoding: "utf8",
			},
		);
		strictEqual(simple.status, 0);
		ok(simple.stdout.includes("switchyard-dispatch simple"));
		const legacy = spawnSync(
			process.execPath,
			[DISPATCH_PATH, "run", "--help"],
			{
				encoding: "utf8",
			},
		);
		strictEqual(legacy.status, 0);
		ok(legacy.stdout.includes("switchyard-dispatch run"));
	});

	it("runs Codex ephemerally with the workspace-write sandbox", () => {
		const repo = makeRepo();
		const invocation = buildSimpleProviderInvocation(
			"codex",
			{ selector: "gpt-5.3-codex-spark", invocation_args: [] },
			"bounded task",
			join(repo.root, "worktree"),
		);
		strictEqual(invocation.command, "codex");
		ok(invocation.args.includes("--ephemeral"));
		ok(invocation.args.includes("--ignore-user-config"));
		ok(invocation.args.includes("--ignore-rules"));
		strictEqual(invocation.args.includes("-a"), false);
		strictEqual(invocation.args.includes("--approve-for-me"), false);
		const approvalIndex = invocation.args.indexOf('approval_policy="never"');
		ok(approvalIndex > 0);
		strictEqual(invocation.args[approvalIndex - 1], "-c");
		const sandboxIndex = invocation.args.indexOf("-s");
		strictEqual(invocation.args[sandboxIndex + 1], "workspace-write");
		const workdirIndex = invocation.args.indexOf("-C");
		strictEqual(invocation.args[workdirIndex + 1], join(repo.root, "worktree"));
		strictEqual(invocation.args.at(-1), "-");
		strictEqual(invocation.args.includes("bounded task"), false);
	});

	it("allows only bounded reasoning configuration from roster descriptors", () => {
		const repo = makeRepo();
		const safe = buildSimpleProviderInvocation(
			"codex",
			{
				selector: "gpt-5.3-codex-spark",
				invocation_args: ["-c", "model_reasoning_effort=high"],
			},
			"bounded task",
			join(repo.root, "worktree"),
		);
		ok(safe.args.includes("model_reasoning_effort=high"));
		for (const invocationArgs of [
			["-s", "danger-full-access"],
			["-c", "sandbox_workspace_write.network_access=true"],
			["-c"],
		]) {
			let threw = false;
			try {
				buildSimpleProviderInvocation(
					"codex",
					{
						selector: "gpt-5.3-codex-spark",
						invocation_args: invocationArgs,
					},
					"bounded task",
					join(repo.root, "worktree"),
				);
			} catch (error) {
				threw = error?.code === "local_descriptor_args_unsafe";
			}
			strictEqual(threw, true, invocationArgs.join(" "));
		}
	});
});

describe("simple local execution path", () => {
	it("executes one routed provider, checks in the worktree, and applies only its diff", async () => {
		const repo = makeRepo();
		const seen = { executions: 0, checks: 0 };
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				route: (routeOptions) => {
					strictEqual(
						routeOptions.hasInvocationDescriptor("Codex (Spark)", "standard"),
						true,
					);
					return { provider: "Codex (Spark)", reason: "priority_fill" };
				},
				executeProvider: async ({ worktreePath, descriptor }) => {
					seen.executions += 1;
					strictEqual(descriptor.target_id, "codex-spark");
					execFileSync("git", ["branch", "provider-local"], {
						cwd: worktreePath,
					});
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"changed\n",
						"utf8",
					);
					return { success: true, code: 0 };
				},
				runCheck: async ({ worktreePath }) => {
					seen.checks += 1;
					strictEqual(
						readFileSync(join(worktreePath, "src", "a.txt"), "utf8"),
						"changed\n",
					);
					return { success: true };
				},
			}),
		);
		strictEqual(result.status, "succeeded");
		strictEqual(result.provider, "Codex (Spark)");
		deepStrictEqual(result.changedFiles, ["src/a.txt"]);
		deepStrictEqual(result.checks, [{ index: 1, status: "passed" }]);
		deepStrictEqual(seen, { executions: 1, checks: 1 });
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"changed\n",
		);
		strictEqual(
			execFileSync("git", ["branch", "--list", "provider-local"], {
				cwd: repo.projectPath,
				encoding: "utf8",
			}).trim(),
			"",
		);
		strictEqual(result.partialWorktree, null);
	});

	it("runs real shell checks from the disposable worktree", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(options(repo), dependencies());
		strictEqual(result.status, "succeeded");
		deepStrictEqual(result.checks, [{ index: 1, status: "passed" }]);
	});

	it("uses one decreasing deadline across execution and all checks", async () => {
		const repo = makeRepo();
		let clock = 1_000;
		const observed = [];
		const result = await runSimpleTask(
			options(repo, { checks: ["first", "second"], deadlineMs: 101_000 }),
			dependencies({
				now: () => clock,
				executeProvider: async ({ worktreePath, timeoutMs }) => {
					observed.push(timeoutMs);
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"changed\n",
						"utf8",
					);
					clock += 30_000;
					return { success: true, code: 0 };
				},
				runCheck: async ({ timeoutMs }) => {
					observed.push(timeoutMs);
					clock += 20_000;
					return { success: true };
				},
				integrate: async () => ({ success: true }),
			}),
		);
		strictEqual(result.status, "succeeded");
		deepStrictEqual(observed, [100_000, 70_000, 50_000]);
		strictEqual(result.elapsedMs, 70_000);
	});

	it("stops at the absolute deadline instead of beginning another phase", async () => {
		const repo = makeRepo();
		let clock = 1_000;
		let integrated = false;
		const result = await runSimpleTask(
			options(repo, { deadlineMs: 101_000 }),
			dependencies({
				now: () => clock,
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"partial\n",
						"utf8",
					);
					clock = 41_000;
					return { success: true };
				},
				runCheck: async () => {
					clock = 102_000;
					return { success: true };
				},
				integrate: async () => {
					integrated = true;
					return { success: true };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "deadline_expired");
		strictEqual(result.failurePhase, "integrate");
		strictEqual(integrated, false);
		ok(result.partialWorktree);
	});

	it("refuses initial owner edits before provider execution", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "owner\n", "utf8");
		let executed = false;
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async () => {
					executed = true;
				},
			}),
		);
		strictEqual(result.failureReason, "declared_path_has_owner_edits");
		strictEqual(executed, false);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"owner\n",
		);
	});

	it("preserves a concurrent owner edit and the provider's partial work", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider\n",
						"utf8",
					);
					writeFileSync(
						join(repo.projectPath, "src", "a.txt"),
						"owner concurrent\n",
						"utf8",
					);
					return { success: true };
				},
				runCheck: async () => ({ success: true }),
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "declared_path_changed_concurrently");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"owner concurrent\n",
		);
		ok(result.partialWorktree);
	});

	it("rejects undeclared output without applying it", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider\n",
						"utf8",
					);
					writeFileSync(join(worktreePath, "other.txt"), "extra\n", "utf8");
					return { success: true };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "undeclared_paths_changed");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"base\n",
		);
		ok(!existsSync(join(repo.projectPath, "other.txt")));
	});

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
					};
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "provider_exit_nonzero");
		ok(result.partialWorktree);
		ok(!JSON.stringify(result).includes(secret));
	});

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

	it("refuses drift, missing evidence, a possibly running writer, and an unconfirmed lock", async () => {
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
		const expected = {
			taskId: "simple-test",
			attemptId: "attempt-1",
			baseRevision: result.recovery.identity.baseRevision,
			files: ["src/a.txt"],
			checks: ["test -f src/a.txt"],
		};
		strictEqual(assessSimpleRecoveryEvidence(null, expected).available, false);
		strictEqual(
			assessSimpleRecoveryEvidence(
				{
					...result.recovery,
					identity: {
						...result.recovery.identity,
						baseRevision: "0".repeat(40),
					},
				},
				expected,
			).reason,
			"recovery_identity_mismatch",
		);
		strictEqual(
			assessSimpleRecoveryEvidence(
				{
					...result.recovery,
					cleanup: {
						...result.recovery.cleanup,
						writer: { state: "unavailable" },
					},
				},
				expected,
			).available,
			false,
		);
		strictEqual(
			assessSimpleRecoveryEvidence(
				{
					...result.recovery,
					cleanup: {
						...result.recovery.cleanup,
						projectLock: { state: "unavailable" },
					},
				},
				expected,
			).available,
			false,
		);
		const sha256Expected = { ...expected, baseRevision: "a".repeat(64) };
		const sha256Recovery = {
			...result.recovery,
			identity: {
				...result.recovery.identity,
				baseRevision: sha256Expected.baseRevision,
			},
		};
		strictEqual(
			assessSimpleRecoveryEvidence(sha256Recovery, sha256Expected).available,
			true,
		);
	});

	it("preserves partial work but refuses continuation when lock release is unconfirmed", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				releaseProjectLock: async () => false,
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
		strictEqual(result.recovery.cleanup.projectLock.state, "unavailable");
		strictEqual(result.recovery.continuation.available, false);
		strictEqual(
			result.recovery.continuation.reason,
			"project_lock_release_unconfirmed",
		);
		ok(result.partialWorktree);
	});

	it("cleans a completed empty provider capture instead of inventing partial work", async () => {
		const repo = makeRepo();
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async () => ({
					success: false,
					code: 1,
					writerLifecycle: "stopped",
				}),
			}),
		);
		strictEqual(result.failureReason, "provider_exit_nonzero");
		strictEqual(result.changedFiles.length, 0);
		strictEqual(result.partialWorktree, null);
		strictEqual(result.recovery.continuation.reason, "no_partial_work");
	});

	it("refuses continuation when a failing check leaves its writer lifecycle unavailable", async () => {
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
					return { success: true, writerLifecycle: "stopped" };
				},
				runCheck: async () => ({
					success: false,
					timedOut: true,
					writerLifecycle: "unavailable",
				}),
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "check_deadline_exceeded");
		ok(result.partialWorktree);
		strictEqual(result.recovery.cleanup.writer.state, "unavailable");
		strictEqual(result.recovery.cleanup.projectLock.state, "released");
		strictEqual(result.recovery.continuation.available, false);
		strictEqual(result.recovery.continuation.reason, "writer_stop_unconfirmed");
	});

	it("maps silence to a specific terminal diagnosis without retries", async () => {
		const repo = makeRepo();
		let calls = 0;
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				executeProvider: async () => {
					calls += 1;
					return { success: false, code: null, silenceTimedOut: true };
				},
			}),
		);
		strictEqual(result.failureReason, "provider_silence_timeout");
		strictEqual(calls, 1);
	});

	it("fails closed when another task owns the existing project lock", async () => {
		const repo = makeRepo();
		const error = Object.assign(new Error("do not expose holder details"), {
			code: "PROJECT_LOCK_HELD",
		});
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				acquireProjectLock: async () => {
					throw error;
				},
			}),
		);
		strictEqual(result.failureReason, "PROJECT_LOCK_HELD");
		strictEqual(result.failurePhase, "preflight");
		ok(!JSON.stringify(result).includes("holder details"));
	});

	it("reports no eligible provider without attempting execution", async () => {
		const repo = makeRepo();
		let executed = false;
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				route: () => ({ provider: null, reason: "no_eligible_provider" }),
				executeProvider: async () => {
					executed = true;
				},
			}),
		);
		strictEqual(result.failureReason, "no_eligible_provider");
		strictEqual(result.failurePhase, "route");
		strictEqual(executed, false);
	});
});
