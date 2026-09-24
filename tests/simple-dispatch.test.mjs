import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	getRunRoot,
	isProjectLockHeld,
	readEvents,
	readRun,
	runStoreTesting,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import {
	assessSimpleRecoveryEvidence,
	buildSimpleProviderInvocation,
	defaultExecuteProvider,
	handleSimple,
	parseSimpleArgs,
	runSimpleTask,
	simpleProviderCompatibility,
	simpleRouteIsFunded,
} from "../src/switchyard/simple/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const originalTmpdirEnv = process.env.TMPDIR;
const originalRunStoreEnv = process.env.SWITCHYARD_RUN_STORE_ROOT;
const SUITE_TMPDIR = realpathSync(tempDir("switchyard-suite-tmp-"));
process.env.TMPDIR = SUITE_TMPDIR;
process.env.SWITCHYARD_RUN_STORE_ROOT = join(SUITE_TMPDIR, "run-store");

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

function simpleCliArgs(repo, checks = ["test -f src/a.txt"]) {
	return [
		repo.promptPath,
		"--project",
		repo.projectPath,
		"--capability",
		"standard",
		"--file",
		"src/a.txt",
		...checks.flatMap((command) => ["--check", command]),
		"--deadline",
		new Date(61_000).toISOString(),
	];
}

function spawnSignalHarness(repo, runId, signal, mode = "provider") {
	const moduleDirectory = resolve(__dirname, "..", "src", "switchyard");
	const bootstrap = `
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const simpleModule = await import(process.env.SWITCHYARD_SIMPLE_MODULE);
const runStore = await import(process.env.SWITCHYARD_RUN_STORE_MODULE);
let terminalWrites = [];
let lockReleases = 0;
const directChildKills = [];
const providerChild = new EventEmitter();
providerChild.stdout = new EventEmitter();
providerChild.stderr = new EventEmitter();
providerChild.stdin = { end() {} };
providerChild.kill = (signal) => {
  directChildKills.push(signal);
  queueMicrotask(() => providerChild.emit("close", null, signal));
  return true;
};
const argv = [
  process.env.SWITCHYARD_PROMPT,
  "--project", process.env.SWITCHYARD_PROJECT,
  "--capability", "standard",
  "--file", "src/a.txt",
  "--check", "test -f src/a.txt",
  "--deadline", new Date(61_000).toISOString(),
];
const executeProvider = (context) => {
  if (process.env.SWITCHYARD_MODE === "provider") {
    return simpleModule.defaultExecuteProvider({
      ...context,
      spawnFn: () => {
        process.stdout.write("READY\\n");
        return providerChild;
      },
    });
  }
  writeFileSync(join(context.worktreePath, "src", "a.txt"), "provider\\n");
  return Promise.resolve({ success: true, writerLifecycle: "stopped" });
};
const integrate = process.env.SWITCHYARD_MODE === "integration"
  ? async ({ projectPath }) => {
      process.stdout.write("INTEGRATING\\n");
      await new Promise((resolve) => setTimeout(resolve, 500));
      writeFileSync(join(projectPath, "src", "a.txt"), "provider\\n");
      return { success: true };
    }
  : undefined;
await simpleModule.handleSimple(argv, {
  now: () => 1_000,
  taskId: process.env.SWITCHYARD_TASK_ID,
  runId: process.env.SWITCHYARD_RUN_ID,
  tmpdir: process.env.TMPDIR,
  acquireProjectLock: runStore.acquireProjectLock,
  releaseProjectLock: async (projectPath, id) => {
    lockReleases += 1;
    return runStore.releaseProjectLockIfOwnedBy(projectPath, id);
  },
  route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
  resolveTargetIdentity: () => ({ targetId: "codex", harnessKey: "codex", ambiguous: false }),
  getInvocationDescriptor: () => ({ target_id: "codex", selector: "gpt-5.3-codex-spark", invocation_args: [] }),
  assertFundedRoute: () => {},
  executeProvider,
  runCheck: async () => process.env.SWITCHYARD_MODE === "provider"
    ? Promise.reject(new Error("check launched after provider cancellation"))
    : { success: true, writerLifecycle: "stopped" },
  ...(integrate ? { integrate } : {}),
  updateRunWithRetry: async (id, patch) => {
    if (patch.state === "failed" || patch.state === "succeeded") terminalWrites.push(patch.state);
    return runStore.updateRunWithRetry(id, patch);
  },
  writeResult: (line) => process.stdout.write("RESULT " + line + "\\n"),
});
process.stdout.write("META " + JSON.stringify({ terminalWrites, lockReleases, directChildKills }) + "\\n");
`;
	const taskId = runId.replace(/^simple-/u, "");
	const child = spawn(
		process.execPath,
		["--input-type=module", "-e", bootstrap],
		{
			cwd: repo.projectPath,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: process.env.HOME ?? SUITE_TMPDIR,
				TMPDIR: SUITE_TMPDIR,
				SWITCHYARD_RUN_STORE_ROOT: join(SUITE_TMPDIR, "run-store"),
				SWITCHYARD_SIMPLE_MODULE: pathToFileURL(
					join(moduleDirectory, "simple", "index.mjs"),
				).href,
				SWITCHYARD_RUN_STORE_MODULE: pathToFileURL(
					join(moduleDirectory, "run-store", "index.mjs"),
				).href,
				SWITCHYARD_PROMPT: repo.promptPath,
				SWITCHYARD_PROJECT: repo.projectPath,
				SWITCHYARD_TASK_ID: taskId,
				SWITCHYARD_RUN_ID: runId,
				SWITCHYARD_MODE: mode,
			},
		},
	);

	return new Promise((resolveResult, rejectResult) => {
		let stdout = "";
		let stderr = "";
		let signalSent = false;
		const readyMarker = mode === "integration" ? "INTEGRATING\n" : "READY\n";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			rejectResult(new Error(`signal child did not settle: ${stderr}`));
		}, 10_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (!signalSent && stdout.includes(readyMarker)) {
				signalSent = true;
				if (!child.kill(signal)) {
					clearTimeout(timer);
					rejectResult(new Error(`could not send ${signal} to signal child`));
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			rejectResult(error);
		});
		child.once("close", (code, exitSignal) => {
			clearTimeout(timer);
			resolveResult({ code, exitSignal, signalSent, stdout, stderr });
		});
	});
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
	if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdirEnv;
	if (originalRunStoreEnv === undefined)
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	else process.env.SWITCHYARD_RUN_STORE_ROOT = originalRunStoreEnv;
	try {
		rmSync(SUITE_TMPDIR, { recursive: true, force: true });
	} catch {}
});

describe("simple dispatch argument boundary", () => {
	it("accepts an explicit dirty overlay with read-only inputs", () => {
		const repo = makeRepo();
		writeFileSync(
			join(repo.projectPath, "src", "input.txt"),
			"input\n",
			"utf8",
		);
		execFileSync("git", ["add", "-A"], { cwd: repo.projectPath });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Switchyard Tests",
				"-c",
				"user.email=switchyard@example.invalid",
				"commit",
				"-qm",
				"input",
			],
			{ cwd: repo.projectPath },
		);
		const parsed = parseSimpleArgs(
			[
				repo.promptPath,
				"--project",
				repo.projectPath,
				"--capability",
				"low",
				"--file",
				"src/a.txt",
				"--input",
				"src/input.txt",
				"--dirty-overlay",
				"--check",
				"true",
				"--deadline",
				"1970-01-01T00:10:00Z",
			],
			{ now: () => 1_000 },
		);
		deepStrictEqual(parsed.readOnlyInputs, ["src/input.txt"]);
		strictEqual(parsed.dirtyOverlay, true);
	});

	it("rejects read-only inputs unless dirty overlay is explicitly enabled", () => {
		const repo = makeRepo();
		throws(
			() =>
				parseSimpleArgs(
					[
						repo.promptPath,
						"--project",
						repo.projectPath,
						"--capability",
						"low",
						"--file",
						"src/a.txt",
						"--input",
						"src/a.txt",
						"--check",
						"true",
						"--deadline",
						"1970-01-01T00:10:00Z",
					],
					{ now: () => 1_000 },
				),
			/overlap|dirty-overlay/,
		);
	});

	it("rejects the Docker credential path under the simple union filter", () => {
		const repo = makeRepo();
		throws(
			() =>
				parseSimpleArgs(
					[
						repo.promptPath,
						"--project",
						repo.projectPath,
						"--capability",
						"low",
						"--file",
						".docker/config.json",
						"--check",
						"true",
						"--deadline",
						"1970-01-01T00:10:00Z",
					],
					{ now: () => 1_000 },
				),
			/unsafe --file path/,
		);
	});

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

	it("accepts one supported provider pin and rejects ambiguous or unsupported pins", () => {
		const repo = makeRepo();
		const base = [
			repo.promptPath,
			"--project",
			repo.projectPath,
			"--capability",
			"standard",
			"--file",
			"src/a.txt",
			"--check",
			"true",
			"--deadline",
			"1970-01-01T00:10:00Z",
		];
		strictEqual(
			parseSimpleArgs([...base, "--only-provider", "antigravity-claude"], {
				now: () => 1_000,
			}).onlyProviders[0],
			"antigravity-claude",
		);
		strictEqual(
			parseSimpleArgs([...base, "--only-provider", "cursor"], {
				now: () => 1_000,
			}).onlyProviders[0],
			"cursor",
		);
		for (const pin of ["antigravity-claude, codex", "agy"]) {
			throws(() =>
				parseSimpleArgs([...base, "--only-provider", pin], {
					now: () => 1_000,
				}),
			);
		}
		throws(() =>
			parseSimpleArgs(
				[
					...base,
					"--only-provider",
					"codex",
					"--only-provider",
					"antigravity-claude",
				],
				{ now: () => 1_000 },
			),
		);
	});

	it("keeps Gemini and Claude Antigravity targets distinct", () => {
		const gemini = buildSimpleProviderInvocation(
			"agy",
			{
				target_id: "antigravity",
				selector: "gemini-3.8-flash-high",
			},
			"work",
			"/tmp/worktree",
			"antigravity",
		);
		strictEqual(gemini.command, "agy");
		deepStrictEqual(gemini.args, [
			"--new-project",
			"--mode",
			"accept-edits",
			"--dangerously-skip-permissions",
			"--sandbox",
			"--model",
			"gemini-3.8-flash-high",
			"--add-dir",
			"/tmp/worktree",
			"--output-format",
			"json",
			"--print-timeout",
			"30m",
			"--print",
			"work",
		]);
		const claude = buildSimpleProviderInvocation(
			"agy",
			{
				target_id: "antigravity-claude",
				selector: "claude-sonnet-4-6",
			},
			"work",
			"/tmp/worktree",
			"antigravity-claude",
		);
		strictEqual(
			claude.args[claude.args.indexOf("--model") + 1],
			"claude-sonnet-4-6",
		);
		throws(() =>
			buildSimpleProviderInvocation(
				"agy",
				{ target_id: "antigravity", selector: "claude-sonnet-4-6" },
				"work",
				"/tmp/worktree",
				"antigravity",
			),
		);
	});

	it("runs Copilot with a session-only sandbox and no shell or broad permissions", () => {
		const invocation = buildSimpleProviderInvocation(
			"copilot",
			{ target_id: "copilot-student", selector: "auto" },
			"work",
			"/tmp/worktree",
			"copilot-student",
		);
		strictEqual(invocation.command, "copilot");
		for (const flag of [
			"--experimental",
			"--sandbox",
			"--disallow-temp-dir",
			"--disable-builtin-mcps",
			"--no-custom-instructions",
			"--no-ask-user",
			"--no-auto-update",
		]) {
			ok(invocation.args.includes(flag), flag);
		}
		strictEqual(
			invocation.args[invocation.args.indexOf("--available-tools") + 1],
			"apply_patch,create,edit,view,glob,grep",
		);
		strictEqual(invocation.args.includes("shell"), false);
		strictEqual(invocation.args.includes("--allow-all"), false);
		strictEqual(invocation.args.includes("--allow-all-paths"), false);
		strictEqual(invocation.args.includes("--yolo"), false);
		strictEqual(
			invocation.args[invocation.args.indexOf("-C") + 1],
			"/tmp/worktree",
		);
	});

	it("fails closed when a target and shared harness descriptor do not match", () => {
		deepStrictEqual(
			simpleProviderCompatibility({
				targetId: "antigravity-claude",
				harness: "agy",
				descriptor: {
					target_id: "antigravity-claude",
					selector: "gemini-3.8-flash-high",
				},
			}),
			{ compatible: false, reason: "local_descriptor_model_unavailable" },
		);
	});

	it("admits included subscription and quota funding without paid overage", () => {
		for (const mode of ["subscription", "quota"]) {
			strictEqual(
				simpleRouteIsFunded({
					enabled: true,
					funding: {
						included: { mode },
						overage: { enabled: false },
					},
				}),
				true,
			);
		}
		strictEqual(
			simpleRouteIsFunded({
				enabled: true,
				funding: {
					included: { mode: "quota" },
					overage: { enabled: true },
				},
			}),
			false,
		);
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

	it("prints simple help directly instead of writing it as a result", async () => {
		const originalLog = console.log;
		const signalProcess = new EventEmitter();
		let printed = "";
		let resultWrites = 0;
		console.log = (message) => {
			printed = message;
		};
		try {
			await handleSimple(["--help"], {
				signalProcess,
				writeResult: () => {
					resultWrites += 1;
				},
			});
		} finally {
			console.log = originalLog;
		}
		ok(printed.includes("switchyard-dispatch simple"));
		strictEqual(resultWrites, 0);
	});

	it("runs Codex ephemerally with the workspace-write sandbox", () => {
		const repo = makeRepo();
		const invocation = buildSimpleProviderInvocation(
			"codex",
			{
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: [],
			},
			"bounded task",
			join(repo.root, "worktree"),
			"codex",
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
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: ["-c", "model_reasoning_effort=high"],
			},
			"bounded task",
			join(repo.root, "worktree"),
			"codex",
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
						target_id: "codex",
						selector: "gpt-5.3-codex-spark",
						invocation_args: invocationArgs,
					},
					"bounded task",
					join(repo.root, "worktree"),
					"codex",
				);
			} catch (error) {
				threw = error?.code === "local_descriptor_args_unsafe";
			}
			strictEqual(threw, true, invocationArgs.join(" "));
		}
	});
});

describe("simple local execution path", () => {
	for (const [label, output, verdict, expectedStatus] of [
		["non-JSON", "provider prose", "agy_unparseable", "failed"],
		["non-SUCCESS", '{"status":"FAILED"}', "agy_non_success", "failed"],
		["SUCCESS", '{"status":"SUCCESS"}', "agy_success", "succeeded"],
	]) {
		it(`runs diff capture and checks after agy exit 0 with ${label} output`, async () => {
			const repo = makeRepo();
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					route: () => ({ provider: "Antigravity", reason: "priority_fill" }),
					resolveTargetIdentity: () => ({
						targetId: "antigravity",
						harnessKey: "agy",
						ambiguous: false,
					}),
					getInvocationDescriptor: () => ({
						target_id: "antigravity",
						selector: "gemini-3.8-flash-high",
						invocation_args: [],
					}),
					executeProvider: (context) =>
						defaultExecuteProvider({
							...context,
							spawnFn: () => {
								writeFileSync(
									join(context.worktreePath, "src", "a.txt"),
									"provider\n",
								);
								const child = new EventEmitter();
								child.stdout = new EventEmitter();
								child.stderr = new EventEmitter();
								child.stdin = { end() {} };
								queueMicrotask(() => {
									child.stdout.emit("data", Buffer.from(output));
									child.emit("close", 0, null);
								});
								return child;
							},
						}),
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, expectedStatus);
			strictEqual(result.providerLifecycle?.exitCode, 0);
			strictEqual(result.providerVerdictCode, verdict);
			deepStrictEqual(result.changedFiles, ["src/a.txt"]);
			ok(result.checks.length > 0);
			ok(result.checks.every((check) => check.status === "passed"));
			if (expectedStatus === "failed") {
				strictEqual(result.failureReason, "provider_verdict_rejected");
				strictEqual(result.errorKind, "execution_failed");
				ok(result.partialWorktree);
			}
			strictEqual(
				readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
				expectedStatus === "succeeded" ? "provider\n" : "base\n",
			);
		});
	}

	it("offers only exact locally compatible targets to automatic routing", async () => {
		const repo = makeRepo();
		let routedOptions = null;
		const identities = {
			codex: { targetId: "codex", harnessKey: "codex", ambiguous: false },
			antigravity: {
				targetId: "antigravity",
				harnessKey: "agy",
				ambiguous: false,
			},
			"antigravity-claude": {
				targetId: "antigravity-claude",
				harnessKey: "agy",
				ambiguous: false,
			},
			"copilot-student": {
				targetId: "copilot-student",
				harnessKey: "copilot",
				ambiguous: false,
			},
		};
		const descriptors = {
			codex: {
				target_id: "codex",
				selector: "gpt-5.6-luna",
				invocation_args: [],
			},
			antigravity: {
				target_id: "antigravity",
				selector: "gemini-3.8-flash-medium",
				invocation_args: [],
			},
			"copilot-student": {
				target_id: "copilot-student",
				selector: "auto",
				invocation_args: [],
			},
		};
		const result = await runSimpleTask(
			options(repo, { capability: "low" }),
			dependencies({
				route: (routeOptions) => {
					routedOptions = routeOptions;
					return { provider: null, reason: "test_stop" };
				},
				resolveTargetIdentity: (name) => identities[name] ?? identities.codex,
				getInvocationDescriptor: (name) => descriptors[name] ?? null,
			}),
		);
		deepStrictEqual(routedOptions.availableProviders, [
			"codex",
			"antigravity",
			"copilot-student",
		]);
		strictEqual(result.failureReason, "test_stop");
		strictEqual(result.failurePhase, "route");
	});

	it("rejects an incompatible explicit pin before routing or launch", async () => {
		const repo = makeRepo();
		let routeCalls = 0;
		let executeCalls = 0;
		const result = await runSimpleTask(
			options(repo, {
				onlyProviders: ["antigravity"],
			}),
			dependencies({
				route: () => {
					routeCalls += 1;
					return { provider: "Antigravity" };
				},
				resolveTargetIdentity: () => ({
					targetId: "antigravity",
					harnessKey: "agy",
					ambiguous: false,
				}),
				getInvocationDescriptor: () => ({
					target_id: "antigravity",
					selector: "claude-sonnet-4-6",
					invocation_args: [],
				}),
				executeProvider: async () => {
					executeCalls += 1;
					return { success: true };
				},
			}),
		);
		strictEqual(result.failureReason, "local_descriptor_model_unavailable");
		strictEqual(result.failurePhase, "route");
		strictEqual(routeCalls, 0);
		strictEqual(executeCalls, 0);
	});

	it("rejects manifest declarations before provider launch with a typed failure", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo.projectPath, "package.json"), "{}\n", "utf8");
		execFileSync("git", ["add", "package.json"], { cwd: repo.projectPath });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Switchyard Tests",
				"-c",
				"user.email=switchyard@example.invalid",
				"commit",
				"-qm",
				"manifest",
			],
			{ cwd: repo.projectPath },
		);
		let executions = 0;
		const result = await runSimpleTask(
			options(repo, { files: ["package.json"] }),
			dependencies({
				executeProvider: async () => {
					executions += 1;
					return { success: true };
				},
			}),
		);
		strictEqual(executions, 0);
		strictEqual(result.failureReason, "manifest_review_required");
		strictEqual(result.failurePhase, "input_validation");
		strictEqual(result.errorKind, "validation_failed");
	});

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
					strictEqual(descriptor.target_id, "codex");
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

	it("emits evidence-only provider, change, capture, and check milestones", async () => {
		const repo = makeRepo();
		const events = [];
		const result = await runSimpleTask(
			options(repo),
			dependencies({ onStatus: (event) => events.push(event) }),
		);
		strictEqual(result.status, "succeeded");
		const milestones = events.map((event) => event.milestone).filter(Boolean);
		ok(milestones.includes("provider_started"));
		ok(milestones.includes("capture_started"));
		ok(milestones.includes("first_change_observed"));
		ok(milestones.includes("check_started"));
		ok(milestones.includes("check_finished"));
		const check = events.find((event) => event.milestone === "check_started");
		strictEqual(check.checkIndex, 1);
		strictEqual(check.checkIdentity.length, 64);
		strictEqual(JSON.stringify(events).includes("test -f src/a.txt"), false);
	});

	it("throttles first-change probes while keeping provider heartbeats", async () => {
		const repo = makeRepo();
		const events = [];
		let clock = 1_000;
		const result = await runSimpleTask(
			options(repo),
			dependencies({
				now: () => clock,
				onStatus: (event) => events.push(event),
				executeProvider: async ({ worktreePath, onProgress }) => {
					onProgress();
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider\n",
						"utf8",
					);
					clock += 1_000;
					onProgress();
					clock += 1_000;
					onProgress();
					return { success: true, code: 0, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "succeeded");
		strictEqual(
			events.filter((event) => event.processPhase === "provider_running")
				.length,
			3,
		);
		strictEqual(
			events.find((event) => event.milestone === "first_change_observed")
				?.phase,
			"diff",
		);
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

	it("transports authorized dirty writable and read-only bytes while preserving unrelated dirt", async () => {
		const repo = makeRepo();
		writeFileSync(
			join(repo.projectPath, "src", "input.txt"),
			"input base\n",
			"utf8",
		);
		writeFileSync(
			join(repo.projectPath, "src", "unrelated.txt"),
			"unrelated base\n",
			"utf8",
		);
		execFileSync("git", ["add", "-A"], { cwd: repo.projectPath });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Switchyard Tests",
				"-c",
				"user.email=switchyard@example.invalid",
				"commit",
				"-qm",
				"inputs",
			],
			{ cwd: repo.projectPath },
		);
		writeFileSync(
			join(repo.projectPath, "src", "a.txt"),
			"dirty writable\n",
			"utf8",
		);
		writeFileSync(
			join(repo.projectPath, "src", "input.txt"),
			"dirty input\n",
			"utf8",
		);
		writeFileSync(
			join(repo.projectPath, "src", "unrelated.txt"),
			"owner dirt\n",
			"utf8",
		);
		const result = await runSimpleTask(
			options(repo, {
				files: ["src/a.txt"],
				readOnlyInputs: ["src/input.txt"],
				dirtyOverlay: true,
			}),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					strictEqual(
						readFileSync(join(worktreePath, "src", "a.txt"), "utf8"),
						"dirty writable\n",
					);
					strictEqual(
						readFileSync(join(worktreePath, "src", "input.txt"), "utf8"),
						"dirty input\n",
					);
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider\n",
						"utf8",
					);
					return { success: true };
				},
				runCheck: async ({ worktreePath }) => {
					strictEqual(
						readFileSync(join(worktreePath, "src", "input.txt"), "utf8"),
						"dirty input\n",
					);
					return { success: true };
				},
			}),
		);
		strictEqual(result.status, "succeeded");
		strictEqual(result.dirtyBaseline.writable_paths[0], "src/a.txt");
		strictEqual(result.dirtyBaseline.read_only_inputs[0], "src/input.txt");
		const sharedExpected = JSON.parse(
			execFileSync(
				"python3",
				[
					"-c",
					`import hashlib,json,platform,subprocess,sys
from pathlib import Path
b=json.load(sys.stdin)
r=b.pop("receipt_sha256")
common=Path(subprocess.check_output(["git","rev-parse","--git-common-dir"],cwd=sys.argv[1],text=True).strip())
if not common.is_absolute(): common=Path(sys.argv[1])/common
print(json.dumps({"repository_identity":hashlib.sha256(str(common.resolve()).encode()).hexdigest(),"host_identity":platform.node().strip() or "unknown-host","receipt_sha256":hashlib.sha256(json.dumps(b,sort_keys=True,separators=(",",":")).encode()).hexdigest(),"received_receipt":r}))`,
					repo.projectPath,
				],
				{
					encoding: "utf8",
					input: JSON.stringify(result.dirtyBaseline),
				},
			),
		);
		strictEqual(
			result.dirtyBaseline.repository_identity,
			sharedExpected.repository_identity,
		);
		strictEqual(
			result.dirtyBaseline.host_identity,
			sharedExpected.host_identity,
		);
		strictEqual(sharedExpected.received_receipt, sharedExpected.receipt_sha256);
		deepStrictEqual(Object.keys(result.dirtyBaseline).sort(), [
			"base_commit",
			"files",
			"host_identity",
			"read_only_inputs",
			"receipt_sha256",
			"repository_identity",
			"task_id",
			"writable_paths",
		]);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"provider\n",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "input.txt"), "utf8"),
			"dirty input\n",
		);
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "unrelated.txt"), "utf8"),
			"owner dirt\n",
		);
	});

	it("rejects scoped untracked and deleted inputs before provider routing", async () => {
		for (const mode of ["untracked", "deleted"]) {
			const repo = makeRepo();
			const path = join(repo.projectPath, "src", "input.txt");
			if (mode === "untracked") writeFileSync(path, "new\n", "utf8");
			else {
				writeFileSync(path, "tracked\n", "utf8");
				execFileSync("git", ["add", "-A"], { cwd: repo.projectPath });
				execFileSync(
					"git",
					[
						"-c",
						"user.name=Switchyard Tests",
						"-c",
						"user.email=switchyard@example.invalid",
						"commit",
						"-qm",
						"input",
					],
					{ cwd: repo.projectPath },
				);
				rmSync(path);
			}
			let routed = false;
			const result = await runSimpleTask(
				options(repo, { files: ["src/input.txt"], dirtyOverlay: true }),
				dependencies({
					route: () => {
						routed = true;
						return { provider: null };
					},
				}),
			);
			strictEqual(routed, false, mode);
			strictEqual(result.failurePhase, "preflight", mode);
			strictEqual(result.preflightDetail.condition.includes(mode), true, mode);
			const retry = await runSimpleTask(
				options(repo, { files: ["src/input.txt"], dirtyOverlay: true }),
				dependencies({ taskId: "simple-test-retry" }),
			);
			strictEqual(
				retry.preflightDetail.identity,
				result.preflightDetail.identity,
				`${mode} retry identity`,
			);
			strictEqual(retry.preflightDetail.taskId, "simple-test-retry", mode);
		}
	});

	it("rejects provider writes to read-only inputs", async () => {
		const repo = makeRepo();
		writeFileSync(
			join(repo.projectPath, "src", "input.txt"),
			"input\n",
			"utf8",
		);
		execFileSync("git", ["add", "-A"], { cwd: repo.projectPath });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Switchyard Tests",
				"-c",
				"user.email=switchyard@example.invalid",
				"commit",
				"-qm",
				"input",
			],
			{ cwd: repo.projectPath },
		);
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "dirty\n", "utf8");
		writeFileSync(
			join(repo.projectPath, "src", "input.txt"),
			"dirty input\n",
			"utf8",
		);
		const result = await runSimpleTask(
			options(repo, { readOnlyInputs: ["src/input.txt"], dirtyOverlay: true }),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "input.txt"),
						"provider write\n",
						"utf8",
					);
					return { success: true };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "read_only_input_changed");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "input.txt"), "utf8"),
			"dirty input\n",
		);
	});

	it("accepts a simple overlay path beyond the legacy tar-name limit", async () => {
		const repo = makeRepo();
		const longPath = `src/${"nested".repeat(18)}.txt`;
		writeFileSync(join(repo.projectPath, longPath), "base\n", "utf8");
		execFileSync("git", ["add", "-A"], { cwd: repo.projectPath });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Switchyard Tests",
				"-c",
				"user.email=switchyard@example.invalid",
				"commit",
				"-qm",
				"long path",
			],
			{ cwd: repo.projectPath },
		);
		writeFileSync(join(repo.projectPath, longPath), "dirty\n", "utf8");
		const result = await runSimpleTask(
			options(repo, { files: [longPath], dirtyOverlay: true }),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(join(worktreePath, longPath), "provider\n", "utf8");
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		strictEqual(result.status, "succeeded");
		strictEqual(
			readFileSync(join(repo.projectPath, longPath), "utf8"),
			"provider\n",
		);
	});

	it("rejects host drift on a read-only baseline before integration", async () => {
		const repo = makeRepo();
		writeFileSync(
			join(repo.projectPath, "src", "input.txt"),
			"input\n",
			"utf8",
		);
		execFileSync("git", ["add", "-A"], { cwd: repo.projectPath });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Switchyard Tests",
				"-c",
				"user.email=switchyard@example.invalid",
				"commit",
				"-qm",
				"input",
			],
			{ cwd: repo.projectPath },
		);
		writeFileSync(join(repo.projectPath, "src", "a.txt"), "dirty\n", "utf8");
		const result = await runSimpleTask(
			options(repo, {
				readOnlyInputs: ["src/input.txt"],
				dirtyOverlay: true,
			}),
			dependencies({
				executeProvider: async ({ worktreePath }) => {
					writeFileSync(
						join(worktreePath, "src", "a.txt"),
						"provider\n",
						"utf8",
					);
					writeFileSync(
						join(repo.projectPath, "src", "input.txt"),
						"owner drift\n",
						"utf8",
					);
					return { success: true, writerLifecycle: "stopped" };
				},
			}),
		);
		retain(result, repo.projectPath);
		strictEqual(result.failureReason, "dirty_overlay_drift");
		strictEqual(
			readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
			"dirty\n",
		);
	});

	describe("simple dispatch reliability and regression invariants (SW-R1)", () => {
		it("produces a durable discoverable record without provider launch on preflight rejection", async () => {
			const repo = makeRepo();
			let providerLaunched = false;
			const taskId = `preflight-reject-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const result = await runSimpleTask(
				options(repo, {
					deadlineMs: 0,
				}),
				dependencies({
					taskId,
					runId,
					executeProvider: async () => {
						providerLaunched = true;
						return { success: true };
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.failurePhase, "preflight");
			strictEqual(providerLaunched, false);

			const record = await readRun(runId);
			ok(record, "run record must exist in run-store");
			strictEqual(record.runId, runId);
			strictEqual(record.state, "failed");
			strictEqual(record.lastFailure?.failurePhase, "preflight");
		});

		it("classifies injected EPERM at preflight as permission_denied with accurate failurePhase", async () => {
			const repo = makeRepo();
			const eperm = Object.assign(new Error("EPERM: operation not permitted"), {
				code: "EPERM",
			});
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					acquireProjectLock: async () => {
						throw eperm;
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.failurePhase, "preflight");
			strictEqual(result.errorKind, "permission_denied");
		});

		it("classifies non-preflight filesystem errno as environment_failure with accurate failurePhase", async () => {
			const repo = makeRepo();
			const enospc = Object.assign(
				new Error("ENOSPC: no space left on device"),
				{
					code: "ENOSPC",
				},
			);
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					executeProvider: async () => {
						throw enospc;
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, "failed");
			strictEqual(result.failurePhase, "execute");
			strictEqual(result.errorKind, "environment_failure");
		});

		it("succeeds when a changed subset of declared outputs is modified", async () => {
			const repo = makeRepo();
			writeFileSync(join(repo.projectPath, "src", "b.txt"), "base b\n", "utf8");
			execFileSync("git", ["add", "-A"], { cwd: repo.projectPath });
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Switchyard Tests",
					"-c",
					"user.email=switchyard@example.invalid",
					"commit",
					"-qm",
					"add b",
				],
				{ cwd: repo.projectPath },
			);
			const result = await runSimpleTask(
				options(repo, { files: ["src/a.txt", "src/b.txt"] }),
				dependencies({
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider a\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			strictEqual(result.status, "succeeded");
			deepStrictEqual(result.changedFiles, ["src/a.txt"]);
			strictEqual(
				readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
				"provider a\n",
			);
			strictEqual(
				readFileSync(join(repo.projectPath, "src", "b.txt"), "utf8"),
				"base b\n",
			);
		});

		it("fails when an undeclared file is touched by provider", async () => {
			const repo = makeRepo();
			writeFileSync(join(repo.projectPath, "src", "b.txt"), "base b\n", "utf8");
			execFileSync("git", ["add", "-A"], { cwd: repo.projectPath });
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Switchyard Tests",
					"-c",
					"user.email=switchyard@example.invalid",
					"commit",
					"-qm",
					"add b",
				],
				{ cwd: repo.projectPath },
			);
			const result = await runSimpleTask(
				options(repo, { files: ["src/a.txt"] }),
				dependencies({
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider a\n",
							"utf8",
						);
						writeFileSync(
							join(worktreePath, "src", "b.txt"),
							"provider b\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "undeclared_paths_changed");
		});

		it("succeeds with declared untracked predecessor output when legacy backend is unavailable", async () => {
			const repo = makeRepo();
			const trackedPath = join(repo.projectPath, "src", "a.txt");
			const trackedContent = "predecessor tracked content\n";
			writeFileSync(trackedPath, trackedContent, "utf8");
			const untrackedPath = join(repo.projectPath, "src", "pred.txt");
			const untrackedContent = "predecessor content\n";
			const predecessor = await runSimpleTask(
				options(repo, {
					files: ["src/pred.txt"],
					checks: ["test -f src/pred.txt"],
				}),
				dependencies({
					taskId: "predecessor-producer",
					runId: "simple-predecessor-producer",
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "pred.txt"),
							untrackedContent,
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			strictEqual(predecessor.status, "succeeded");
			strictEqual(typeof predecessor.baseRevision, "string");
			const receiptPath = join(repo.root, "pred-receipt.json");
			writeFileSync(receiptPath, JSON.stringify(predecessor), "utf8");

			const result = await runSimpleTask(
				options(repo, {
					files: ["src/a.txt", "src/pred.txt"],
					dirtyOverlay: true,
					predecessorReceipt: receiptPath,
				}),
				dependencies({
					executeProvider: async ({ worktreePath }) => {
						strictEqual(
							readFileSync(join(worktreePath, "src", "a.txt"), "utf8"),
							trackedContent,
						);
						strictEqual(
							readFileSync(join(worktreePath, "src", "pred.txt"), "utf8"),
							untrackedContent,
						);
						writeFileSync(
							join(worktreePath, "src", "pred.txt"),
							"new content\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			strictEqual(result.status, "succeeded");
			strictEqual(readFileSync(trackedPath, "utf8"), trackedContent);
			strictEqual(readFileSync(untrackedPath, "utf8"), "new content\n");
		});

		it("fails before provider execution when predecessor receipt digest mismatches", async () => {
			const repo = makeRepo();
			const untrackedPath = join(repo.projectPath, "src", "pred.txt");
			writeFileSync(untrackedPath, "actual content\n", "utf8");

			const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repo.projectPath,
				encoding: "utf8",
			}).trim();
			const receiptPath = join(repo.root, "bad-receipt.json");
			writeFileSync(
				receiptPath,
				JSON.stringify({
					runId: "predecessor-run-mismatch",
					baseRevision,
					outputs: [
						{
							path: "src/pred.txt",
							size: 999,
							sha256: "0".repeat(64),
							mode: 0o644,
						},
					],
				}),
				"utf8",
			);

			let providerLaunched = false;
			const result = await runSimpleTask(
				options(repo, {
					files: ["src/pred.txt"],
					dirtyOverlay: true,
					predecessorReceipt: receiptPath,
				}),
				dependencies({
					executeProvider: async () => {
						providerLaunched = true;
						return { success: true };
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.failurePhase, "preflight");
			strictEqual(providerLaunched, false);
		});

		it("rejects a succeeded predecessor whose cleanup is still pending", async () => {
			const repo = makeRepo();
			const content = "pending predecessor\n";
			writeFileSync(join(repo.projectPath, "src", "pred.txt"), content, "utf8");
			const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repo.projectPath,
				encoding: "utf8",
			}).trim();
			const receipt = {
				runId: "pending-predecessor",
				baseRevision,
				outputs: [
					{
						path: "src/pred.txt",
						size: Buffer.byteLength(content),
						sha256: createHash("sha256").update(content).digest("hex"),
						mode: 0o644,
					},
				],
			};
			const receiptPath = join(repo.root, "pending-receipt.json");
			writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");
			let providerLaunched = false;
			const result = await runSimpleTask(
				options(repo, {
					files: ["src/pred.txt"],
					dirtyOverlay: true,
					predecessorReceipt: receiptPath,
				}),
				dependencies({
					readRun: async () => ({
						runId: receipt.runId,
						state: "succeeded",
						cleanupState: "pending",
						projectPath: repo.projectPath,
						terminalSummary: { status: "succeeded", ...receipt },
					}),
					executeProvider: async () => {
						providerLaunched = true;
						return { success: true };
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "predecessor_receipt_unverified");
			strictEqual(result.failurePhase, "preflight");
			strictEqual(providerLaunched, false);
		});

		it("fails before provider execution when predecessor receipt file is missing", async () => {
			const repo = makeRepo();
			const untrackedPath = join(repo.projectPath, "src", "pred.txt");
			writeFileSync(untrackedPath, "actual content\n", "utf8");

			let providerLaunched = false;
			const result = await runSimpleTask(
				options(repo, {
					files: ["src/pred.txt"],
					dirtyOverlay: true,
					predecessorReceipt: join(repo.root, "non-existent-receipt.json"),
				}),
				dependencies({
					executeProvider: async () => {
						providerLaunched = true;
						return { success: true };
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.failurePhase, "preflight");
			strictEqual(providerLaunched, false);
		});

		it("fails at integration when untracked predecessor output drifts on host", async () => {
			const repo = makeRepo();
			const untrackedPath = join(repo.projectPath, "src", "pred.txt");
			const originalContent = "predecessor content\n";
			const predecessor = await runSimpleTask(
				options(repo, {
					files: ["src/pred.txt"],
					checks: ["test -f src/pred.txt"],
				}),
				dependencies({
					taskId: "predecessor-drift-producer",
					runId: "simple-predecessor-drift-producer",
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "pred.txt"),
							originalContent,
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			strictEqual(predecessor.status, "succeeded");
			const receiptPath = join(repo.root, "pred-receipt.json");
			writeFileSync(receiptPath, JSON.stringify(predecessor), "utf8");

			const result = await runSimpleTask(
				options(repo, {
					files: ["src/pred.txt"],
					dirtyOverlay: true,
					predecessorReceipt: receiptPath,
				}),
				dependencies({
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "pred.txt"),
							"provider modification\n",
							"utf8",
						);
						// Host file drifts during provider execution
						writeFileSync(untrackedPath, "host drift content\n", "utf8");
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "dirty_overlay_drift");
			strictEqual(result.failurePhase, "integrate");
		});

		it("run-store write fault before preflight cannot launch provider", async () => {
			const repo = makeRepo();
			let providerLaunched = false;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					initializeRun: async () => {
						throw new Error("disk full");
					},
					executeProvider: async () => {
						providerLaunched = true;
						return { success: true };
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.errorKind, "run_store_write_failed");
			strictEqual(result.failurePhase, "preflight");
			strictEqual(providerLaunched, false);
		});

		it("run-store write fault at terminal success cannot publish success", async () => {
			const repo = makeRepo();
			const durablePatches = [];
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
					updateRunWithRetry: async (_runId, patch) => {
						durablePatches.push(patch);
						if (patch.state === "succeeded") {
							throw new Error("run-store write error");
						}
						return patch;
					},
				}),
			);
			strictEqual(result.status, "failed");
			strictEqual(result.errorKind, "run_store_write_failed");
			strictEqual(result.failurePhase, "cleanup");
			ok(
				durablePatches.some(
					(patch) =>
						patch.state === "running" &&
						patch.cleanupState === "pending" &&
						patch.terminalSummary?.status === "integration_applied",
				),
				"host integration must be durable before terminal publication",
			);
		});

		it("persists named milestones while repetitive heartbeats are not persisted", async () => {
			const repo = makeRepo();
			const taskId = `milestone-heartbeat-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					taskId,
					runId,
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			strictEqual(result.status, "succeeded");

			const events = await readEvents(runId);
			ok(events.length > 0, "events must be recorded");
			const milestoneEvents = events.filter((e) => e.event === "milestone");
			ok(milestoneEvents.length > 0, "named milestone events must be recorded");
			const milestoneNames = milestoneEvents.map((e) => e.milestone);
			ok(
				milestoneNames.includes("route_selected"),
				"route_selected milestone present",
			);
			ok(
				milestoneNames.includes("integration_started") ||
					milestoneNames.includes("integration_completed"),
				"integrate milestone present",
			);

			const heartbeatEvents = events.filter((e) => e.event === "heartbeat");
			strictEqual(
				heartbeatEvents.length,
				0,
				"heartbeats must not be persisted in run store",
			);
		});

		it("persists allocating intent before mkdir, then active and removed states", async () => {
			const repo = makeRepo();
			const runId = `simple-allocation-${Date.now()}`;
			const order = [];
			const result = await runSimpleTask(
				options(repo),
				dependencies({
					runId,
					updateRunWithRetry: async (id, patch) => {
						const written = await updateRunWithRetry(id, patch);
						if (patch.worktree) {
							const root = written.worktree;
							strictEqual(root.canonicalParent, SUITE_TMPDIR);
							strictEqual(root.path, join(SUITE_TMPDIR, root.candidateChild));
							strictEqual(existsSync(root.path), root.state === "active");
							order.push(root.state);
						}
						return written;
					},
					mkdirSync: (path, opts) => {
						const run = JSON.parse(
							readFileSync(join(getRunRoot(runId), "run.json"), "utf8"),
						);
						strictEqual(run.worktree.state, "allocating");
						strictEqual(run.worktree.path, path);
						order.push("mkdir");
						return mkdirSync(path, opts);
					},
				}),
			);
			strictEqual(result.status, "succeeded");
			deepStrictEqual(order, ["allocating", "mkdir", "active", "removed"]);
			const run = await readRun(runId);
			strictEqual(run.worktree.state, "removed");
			strictEqual(run.worktree.reason, null);
			strictEqual(run.cleanupState, "complete");
			strictEqual(existsSync(run.worktree.path), false);
		});

		it("accepts a string temp parent and records its canonical path", async () => {
			const repo = makeRepo();
			const runId = `simple-string-tmpdir-${Date.now()}`;
			const result = await runSimpleTask(
				options(repo),
				dependencies({ runId, tmpdir: SUITE_TMPDIR }),
			);
			strictEqual(result.status, "succeeded");
			const run = await readRun(runId);
			strictEqual(run.worktree.canonicalParent, SUITE_TMPDIR);
			strictEqual(run.worktree.state, "removed");
			strictEqual(existsSync(run.worktree.path), false);
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

		for (const fault of ["file", "directory"]) {
			it(`does not allocate a root when intent ${fault} sync fails`, async () => {
				const repo = makeRepo();
				const runId = `simple-sync-${fault}-${Date.now()}`;
				let mkdirCalled = false;
				let providerCalled = false;
				let injected = false;
				let candidatePath;
				const result = await runSimpleTask(
					options(repo),
					dependencies({
						runId,
						updateRunWithRetry: async (id, patch) => {
							if (patch.worktree?.state !== "allocating")
								return updateRunWithRetry(id, patch);
							candidatePath = patch.worktree.path;
							const current = await readRun(id);
							return runStoreTesting.writeRunAtomically(
								join(getRunRoot(id), "run.json"),
								{
									...current,
									...patch,
									revision: current.revision + 1,
								},
								{
									rename,
									unlink,
									open: async (path, flags, mode) => {
										const handle = await open(path, flags, mode);
										return {
											writeFile: (...args) => handle.writeFile(...args),
											close: () => handle.close(),
											sync: async () => {
												if ((flags === "r") === (fault === "directory")) {
													injected = true;
													throw Object.assign(
														new Error("injected sync failure"),
														{ code: "EIO" },
													);
												}
												await handle.sync();
											},
										};
									},
								},
							);
						},
						mkdirSync: () => {
							mkdirCalled = true;
						},
						executeProvider: async () => {
							providerCalled = true;
						},
					}),
				);
				strictEqual(injected, true);
				strictEqual(result.status, "failed");
				strictEqual(result.failureReason, "run_store_write_failed");
				strictEqual(result.failurePhase, "prepare");
				strictEqual(mkdirCalled, false);
				strictEqual(providerCalled, false);
				strictEqual(existsSync(candidatePath), false);
			});
		}

		it("retains salvage and records retained worktree state when checks fail", async () => {
			const repo = makeRepo();
			const taskId = `worktree-salvage-${Date.now()}`;
			const runId = `simple-${taskId}`;

			const result = await runSimpleTask(
				options(repo, { checks: ["false"] }),
				dependencies({
					taskId,
					runId,
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			retain(result, repo.projectPath);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "check_failed");
			ok(result.partialWorktree);

			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.worktree.state, "retained");
			strictEqual(run.worktree.reason, "check_failed");
			ok(typeof run.worktree.retainedAt === "string");
			strictEqual(run.cleanupState, "pending");
			strictEqual(join(run.worktree.path, "worktree"), result.partialWorktree);
			strictEqual(existsSync(run.worktree.path), true);
		});

		it("preserves succeeded status when lock release fails during cleanup", async () => {
			const repo = makeRepo();
			const taskId = `cleanup-lock-fail-${Date.now()}`;
			const runId = `simple-${taskId}`;

			const result = await runSimpleTask(
				options(repo),
				dependencies({
					taskId,
					runId,
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
					releaseProjectLock: async () => false,
				}),
			);
			strictEqual(
				result.status,
				"succeeded",
				"cleanup failure must not rewrite a successful integration as failed",
			);

			const run = await readRun(runId);
			strictEqual(run.state, "succeeded");
			strictEqual(run.cleanupState, "failed");
			ok(run.cleanupFailure !== null);
			strictEqual(
				run.cleanupFailure.result,
				"project_lock_release_unconfirmed",
			);
			strictEqual(run.worktree.state, "removed");
		});

		it("preserves succeeded status and marks worktree retained when worktree cleanup fails", async () => {
			const repo = makeRepo();
			const taskId = `cleanup-rm-fail-${Date.now()}`;
			const runId = `simple-${taskId}`;
			let allocatedWorktreeRoot = null;

			const result = await runSimpleTask(
				options(repo),
				dependencies({
					taskId,
					runId,
					rmSync: () => {
						throw Object.assign(new Error("injected removal failure"), {
							code: "EACCES",
						});
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.worktree?.state === "active") {
							allocatedWorktreeRoot = patch.worktree.path;
						}
						return updateRunWithRetry(id, patch);
					},
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(
							join(worktreePath, "src", "a.txt"),
							"provider\n",
							"utf8",
						);
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			retain(result, repo.projectPath);

			strictEqual(
				result.status,
				"succeeded",
				"worktree cleanup failure must not rewrite successful integration",
			);
			strictEqual(
				result.partialWorktree,
				join(allocatedWorktreeRoot, "worktree"),
			);
			strictEqual(
				readFileSync(join(repo.projectPath, "src/a.txt"), "utf8"),
				"provider\n",
			);

			const run = await readRun(runId);
			strictEqual(run.state, "succeeded");
			strictEqual(run.cleanupState, "failed");
			ok(run.cleanupFailure !== null);
			strictEqual(run.cleanupFailure.result, "worktree_cleanup_failed");
			strictEqual(run.worktree.state, "retained");
			strictEqual(run.worktree.reason, "worktree_cleanup_failed");
			ok(typeof run.worktree.retainedAt === "string");
		});

		it("settles SIGINT during a provider, retains uncertain work, and releases the lock", async () => {
			const repo = makeRepo();
			const signalProcess = new EventEmitter();
			const taskId = `sigint-provider-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const terminalWrites = [];
			let providerStartedResolve;
			const providerStarted = new Promise((resolveStarted) => {
				providerStartedResolve = resolveStarted;
			});
			let checkStarted = false;
			let output = null;
			let lockReleases = 0;
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.stdin = { end() {} };
			child.kill = (signal) => {
				queueMicrotask(() => child.emit("close", null, signal));
				return true;
			};

			const running = handleSimple(
				simpleCliArgs(repo),
				dependencies({
					now: () => 1_000,
					taskId,
					runId,
					tmpdir: SUITE_TMPDIR,
					signalProcess,
					writeResult: (line) => {
						output = line;
					},
					releaseProjectLock: async () => {
						lockReleases += 1;
						return true;
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.state === "failed" || patch.state === "succeeded") {
							terminalWrites.push(patch.state);
						}
						return updateRunWithRetry(id, patch);
					},
					executeProvider: (context) =>
						defaultExecuteProvider({
							...context,
							spawnFn: () => {
								providerStartedResolve();
								return child;
							},
						}),
					runCheck: async () => {
						checkStarted = true;
						return { success: true, writerLifecycle: "stopped" };
					},
				}),
			);
			await providerStarted;
			signalProcess.emit("SIGINT");
			await running;

			const result = JSON.parse(output);
			retain(result, repo.projectPath);
			strictEqual(signalProcess.exitCode, 130);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "provider_cancelled");
			ok(result.partialWorktree);
			strictEqual(result.recovery.cleanup.writer.state, "unavailable");
			strictEqual(existsSync(result.partialWorktree), true);
			strictEqual(checkStarted, false);
			strictEqual(lockReleases, 1);
			deepStrictEqual(terminalWrites, ["failed"]);
			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.worktree.state, "retained");
			strictEqual(run.cleanupState, "pending");
			strictEqual(signalProcess.listenerCount("SIGINT"), 0);
			strictEqual(signalProcess.listenerCount("SIGTERM"), 0);
		});

		it("retains a cloned checkout when SIGINT arrives before provider launch", async () => {
			const repo = makeRepo();
			const signalProcess = new EventEmitter();
			const taskId = `sigint-before-provider-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const terminalWrites = [];
			let output = null;
			let providerLaunches = 0;
			let lockReleases = 0;

			await handleSimple(
				simpleCliArgs(repo),
				dependencies({
					now: () => 1_000,
					taskId,
					runId,
					tmpdir: SUITE_TMPDIR,
					signalProcess,
					writeResult: (line) => {
						output = line;
					},
					onStatus: (event) => {
						if (event.milestone === "provider_started") {
							signalProcess.emit("SIGINT");
						}
					},
					releaseProjectLock: async () => {
						lockReleases += 1;
						return true;
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.state === "failed" || patch.state === "succeeded") {
							terminalWrites.push(patch.state);
						}
						return updateRunWithRetry(id, patch);
					},
					executeProvider: async () => {
						providerLaunches += 1;
						return { success: false, writerLifecycle: "never_started" };
					},
				}),
			);

			const result = JSON.parse(output);
			retain(result, repo.projectPath);
			strictEqual(signalProcess.exitCode, 130);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "provider_cancelled");
			strictEqual(providerLaunches, 0);
			ok(result.partialWorktree);
			strictEqual(
				existsSync(join(result.partialWorktree, "src", "a.txt")),
				true,
			);
			strictEqual(result.recovery.cleanup.writer.state, "unavailable");
			strictEqual(lockReleases, 1);
			deepStrictEqual(terminalWrites, ["failed"]);
			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.worktree.state, "retained");
			strictEqual(run.cleanupState, "pending");
		});

		it("settles SIGTERM during a check without starting integration", async () => {
			const repo = makeRepo();
			const signalProcess = new EventEmitter();
			const taskId = `sigterm-check-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const terminalWrites = [];
			let checkStartedResolve;
			const checkStarted = new Promise((resolveStarted) => {
				checkStartedResolve = resolveStarted;
			});
			let output = null;
			let lockReleases = 0;
			let checkStarts = 0;

			const running = handleSimple(
				simpleCliArgs(repo, ["read -r value", "true"]),
				dependencies({
					now: () => 1_000,
					taskId,
					runId,
					tmpdir: SUITE_TMPDIR,
					signalProcess,
					writeResult: (line) => {
						output = line;
					},
					onStatus: (event) => {
						if (event.milestone === "check_started") checkStarts += 1;
						if (event.milestone === "check_started") checkStartedResolve();
					},
					releaseProjectLock: async () => {
						lockReleases += 1;
						return true;
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.state === "failed" || patch.state === "succeeded") {
							terminalWrites.push(patch.state);
						}
						return updateRunWithRetry(id, patch);
					},
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
						return { success: true, writerLifecycle: "stopped" };
					},
					integrate: async () => {
						throw new Error("integration must not start after SIGTERM");
					},
				}),
			);
			await checkStarted;
			signalProcess.emit("SIGTERM");
			await running;

			const result = JSON.parse(output);
			retain(result, repo.projectPath);
			strictEqual(signalProcess.exitCode, 143);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "provider_cancelled");
			ok(result.partialWorktree);
			strictEqual(result.recovery.cleanup.writer.state, "unavailable");
			strictEqual(lockReleases, 1);
			strictEqual(checkStarts, 1);
			deepStrictEqual(terminalWrites, ["failed"]);
			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.worktree.state, "retained");
			strictEqual(signalProcess.listenerCount("SIGINT"), 0);
			strictEqual(signalProcess.listenerCount("SIGTERM"), 0);
		});

		it("uses a normal failure exit when an interrupted integration later fails", async () => {
			const repo = makeRepo();
			const signalProcess = new EventEmitter();
			const taskId = `sigint-integration-failure-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const terminalWrites = [];
			let output = null;
			let lockReleases = 0;

			await handleSimple(
				simpleCliArgs(repo),
				dependencies({
					now: () => 1_000,
					taskId,
					runId,
					tmpdir: SUITE_TMPDIR,
					signalProcess,
					writeResult: (line) => {
						output = line;
					},
					onStatus: () => {},
					releaseProjectLock: async () => {
						lockReleases += 1;
						return true;
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.state === "failed" || patch.state === "succeeded") {
							terminalWrites.push(patch.state);
						}
						return updateRunWithRetry(id, patch);
					},
					integrate: async () => {
						signalProcess.emit("SIGINT");
						await new Promise((resolveDelay) => setImmediate(resolveDelay));
						return {
							success: false,
							message: "unrelated integration conflict",
						};
					},
				}),
			);

			const result = JSON.parse(output);
			retain(result, repo.projectPath);
			strictEqual(signalProcess.exitCode, 1);
			strictEqual(result.status, "failed");
			strictEqual(result.failureReason, "integration_failed");
			ok(result.partialWorktree);
			strictEqual(lockReleases, 1);
			deepStrictEqual(terminalWrites, ["failed"]);
			const run = await readRun(runId);
			strictEqual(run.state, "failed");
			strictEqual(run.worktree.state, "retained");
			strictEqual(signalProcess.listenerCount("SIGINT"), 0);
			strictEqual(signalProcess.listenerCount("SIGTERM"), 0);
		});

		it("keeps successful integration succeeded when SIGTERM arrives during failed cleanup", async () => {
			const repo = makeRepo();
			const signalProcess = new EventEmitter();
			const taskId = `sigterm-cleanup-${Date.now()}`;
			const runId = `simple-${taskId}`;
			const terminalWrites = [];
			let output = null;
			let lockReleases = 0;

			await handleSimple(
				simpleCliArgs(repo),
				dependencies({
					now: () => 1_000,
					taskId,
					runId,
					tmpdir: SUITE_TMPDIR,
					signalProcess,
					writeResult: (line) => {
						output = line;
					},
					releaseProjectLock: async () => {
						lockReleases += 1;
						return true;
					},
					updateRunWithRetry: async (id, patch) => {
						if (patch.state === "failed" || patch.state === "succeeded") {
							terminalWrites.push(patch.state);
						}
						return updateRunWithRetry(id, patch);
					},
					executeProvider: async ({ worktreePath }) => {
						writeFileSync(join(worktreePath, "src", "a.txt"), "provider\n");
						return { success: true, writerLifecycle: "stopped" };
					},
					rmSync: () => {
						signalProcess.emit("SIGTERM");
						throw Object.assign(new Error("cleanup interrupted"), {
							code: "EIO",
						});
					},
				}),
			);

			const result = JSON.parse(output);
			retain(result, repo.projectPath);
			strictEqual(signalProcess.exitCode, 143);
			strictEqual(result.status, "succeeded");
			ok(result.partialWorktree);
			strictEqual(existsSync(result.partialWorktree), true);
			strictEqual(
				readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
				"provider\n",
			);
			strictEqual(lockReleases, 1);
			deepStrictEqual(terminalWrites, ["succeeded"]);
			const run = await readRun(runId);
			strictEqual(run.state, "succeeded");
			strictEqual(run.cleanupState, "failed");
			strictEqual(run.cleanupFailure.result, "worktree_cleanup_failed");
			strictEqual(run.worktree.state, "retained");
			strictEqual(signalProcess.listenerCount("SIGINT"), 0);
			strictEqual(signalProcess.listenerCount("SIGTERM"), 0);
		});

		for (const [signal, expectedExitCode] of [
			["SIGINT", 130],
			["SIGTERM", 143],
		]) {
			it(`settles real ${signal} in a child process with one terminal record`, async () => {
				const repo = makeRepo();
				const taskId = `real-${signal.toLowerCase()}-${Date.now()}`;
				const runId = `simple-${taskId}`;
				const child = await spawnSignalHarness(repo, runId, signal);
				const resultLine = child.stdout
					.split("\n")
					.find((line) => line.startsWith("RESULT "));
				const resultLineCount = child.stdout
					.split("\n")
					.filter((line) => line.startsWith("RESULT ")).length;
				const metaLine = child.stdout
					.split("\n")
					.find((line) => line.startsWith("META "));
				ok(
					child.signalSent,
					`${signal} should be sent after provider start; stdout=${child.stdout}; stderr=${child.stderr}; exit=${child.code}/${child.exitSignal}`,
				);
				strictEqual(child.code, expectedExitCode, child.stderr);
				strictEqual(child.exitSignal, null);
				ok(resultLine, child.stdout);
				strictEqual(resultLineCount, 1);
				ok(metaLine, child.stdout);
				const result = JSON.parse(resultLine.slice("RESULT ".length));
				const meta = JSON.parse(metaLine.slice("META ".length));
				retain(result, repo.projectPath);
				strictEqual(result.status, "failed");
				strictEqual(result.failureReason, "provider_cancelled");
				ok(result.partialWorktree);
				strictEqual(existsSync(result.partialWorktree), true);
				strictEqual(result.recovery.cleanup.writer.state, "unavailable");
				deepStrictEqual(meta.terminalWrites, ["failed"]);
				strictEqual(meta.lockReleases, 1);
				const run = await readRun(runId);
				strictEqual(run.state, "failed");
				strictEqual(run.worktree.state, "retained");
				strictEqual(run.cleanupState, "pending");
				strictEqual(isProjectLockHeld(repo.projectPath), false);
				deepStrictEqual(meta.directChildKills, ["SIGTERM"]);
				const terminalEvents = (await readEvents(runId)).filter(
					(event) => event.phase === "terminal",
				);
				strictEqual(terminalEvents.length, 1);
			});
		}

		for (const [signal, expectedExitCode] of [
			["SIGINT", 130],
			["SIGTERM", 143],
		]) {
			it(`finishes an async integration after real ${signal} and records success`, async () => {
				const repo = makeRepo();
				const taskId = `integration-${signal.toLowerCase()}-${Date.now()}`;
				const runId = `simple-${taskId}`;
				const child = await spawnSignalHarness(
					repo,
					runId,
					signal,
					"integration",
				);
				const resultLines = child.stdout
					.split("\n")
					.filter((line) => line.startsWith("RESULT "));
				const metaLine = child.stdout
					.split("\n")
					.find((line) => line.startsWith("META "));
				ok(
					child.signalSent,
					`${signal} should arrive during integration; stdout=${child.stdout}; stderr=${child.stderr}; exit=${child.code}/${child.exitSignal}`,
				);
				strictEqual(child.code, expectedExitCode, child.stderr);
				strictEqual(child.exitSignal, null);
				strictEqual(resultLines.length, 1);
				ok(metaLine, child.stdout);
				ok(
					child.stderr.includes(
						`received ${signal} during integration; waiting for it to finish`,
					),
					child.stderr,
				);
				ok(
					child.stderr.includes("milestone=integration_completed"),
					child.stderr,
				);
				const result = JSON.parse(resultLines[0].slice("RESULT ".length));
				const meta = JSON.parse(metaLine.slice("META ".length));
				strictEqual(result.status, "succeeded");
				strictEqual(result.partialWorktree, null);
				strictEqual(
					readFileSync(join(repo.projectPath, "src", "a.txt"), "utf8"),
					"provider\n",
				);
				deepStrictEqual(meta.terminalWrites, ["succeeded"]);
				strictEqual(meta.lockReleases, 1);
				deepStrictEqual(meta.directChildKills, []);
				strictEqual(isProjectLockHeld(repo.projectPath), false);
				const run = await readRun(runId);
				strictEqual(run.state, "succeeded");
				strictEqual(run.cleanupState, "complete");
				strictEqual(run.worktree.state, "removed");
				const terminalEvents = (await readEvents(runId)).filter(
					(event) => event.phase === "terminal",
				);
				strictEqual(terminalEvents.length, 1);
			});
		}

		it("keeps all test roots and run records inside its private TMPDIR", () => {
			strictEqual(realpathSync(tmpdir()), SUITE_TMPDIR);
			strictEqual(
				process.env.SWITCHYARD_RUN_STORE_ROOT,
				join(SUITE_TMPDIR, "run-store"),
			);
			strictEqual(dirname(makeRepo().root), SUITE_TMPDIR);
		});
	});
});
