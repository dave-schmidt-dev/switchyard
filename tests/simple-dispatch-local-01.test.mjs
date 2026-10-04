import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	defaultExecuteProvider,
	parseOpenCodeGoBridgeDiagnostic,
	runSimpleWriter,
} from "../src/switchyard/simple/index.mjs";
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
	it("parses only the fixed numeric OpenCode Go diagnostic and suppresses CLI text", async () => {
		const marker =
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=2 upstream_status=429 proxy_rejections=0\n";
		strictEqual(
			parseOpenCodeGoBridgeDiagnostic(marker),
			"opencode_go_diag_requests_2_status_429_rejections_0",
		);
		for (const invalid of [
			`${marker}private text`,
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1000000 upstream_status=429 proxy_rejections=0\n",
			"SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1 upstream_status=600 proxy_rejections=0\n",
			"prefix SWITCHYARD_OPENCODE_GO_DIAG_V1 requests=1 upstream_status=429 proxy_rejections=0\n",
		]) {
			strictEqual(parseOpenCodeGoBridgeDiagnostic(invalid), null);
		}

		const context = {
			targetId: "opencode-go",
			harness: "opencode",
			descriptor: {
				target_id: "opencode-go",
				selector: "opencode-go/deepseek-v4.1-flash",
				invocation_args: ["--variant", "low"],
			},
			capability: "low",
			prompt: "private prompt sentinel",
			worktreePath: "/tmp/switchyard-simple-test/worktree",
			timeoutMs: 5_000,
			spawnFn: () => {
				const child = new EventEmitter();
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.stdin = { end() {} };
				queueMicrotask(() => {
					child.stdout.emit("data", Buffer.from(marker));
					child.stderr.emit("data", Buffer.from("private CLI stderr sentinel"));
					child.emit("close", 1, null);
				});
				return child;
			},
		};
		const result = await defaultExecuteProvider(context);
		strictEqual(result.success, false);
		strictEqual(
			result.providerVerdictCode,
			"opencode_go_diag_requests_2_status_429_rejections_0",
		);
		strictEqual(result.output, "");
		strictEqual(result.stderr, "");
	});
	it("confirms the dedicated process group is gone after its leader exits", async () => {
		const result = await runSimpleWriter(
			"/bin/sh",
			["-c", "sleep 0.2 </dev/null >/dev/null 2>&1 & exit 0"],
			{ timeoutMs: 5_000, termGraceMs: 100 },
		);
		strictEqual(result.success, true);
		strictEqual(result.writerLifecycle, "stopped");
		ok(Number.isSafeInteger(result.processGroupId));
		throws(() => process.kill(-result.processGroupId, 0), { code: "ESRCH" });
	});
	it("stops a detached child that still holds the disposable worktree", async (t) => {
		const identityProbe = spawnSync(
			"ps",
			["-o", "lstart=", "-o", "stat=", "-p", String(process.pid)],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		if (identityProbe.status !== 0 || identityProbe.error) {
			t.skip("process identity inspection is denied by the active sandbox");
			return;
		}
		const worktreePath = tempDir("switchyard-simple-detached-holder-");
		const pidPath = join(worktreePath, "helper.pid");
		const termPath = join(worktreePath, "helper.term");
		const helperProgram = `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(termPath)}, "term"));
setInterval(() => {}, 1_000);
setTimeout(() => process.exit(0), 3_000).unref();
`;
		const providerProgram = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const helper = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(helperProgram)}], {
  cwd: process.argv[1], detached: true, stdio: "ignore"
});
writeFileSync(process.argv[2], String(helper.pid));
helper.unref();
`;
		let helperPid = null;
		try {
			const result = await runSimpleWriter(
				process.execPath,
				["--input-type=module", "-e", providerProgram, worktreePath, pidPath],
				{
					cwd: worktreePath,
					processScopePath: worktreePath,
					timeoutMs: 5_000,
					termGraceMs: 100,
				},
			);
			if (existsSync(pidPath))
				helperPid = Number(readFileSync(pidPath, "utf8"));
			strictEqual(result.success, true);
			strictEqual(result.writerLifecycle, "stopped");
			strictEqual(readFileSync(termPath, "utf8"), "term");
			const stopped = spawnSync(
				"ps",
				["-o", "stat=", "-p", String(helperPid)],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			ok(
				stopped.status === 1 || /^Z/u.test(stopped.stdout.trim()),
				"detached helper should be gone or reaped after teardown",
			);
		} finally {
			if (helperPid !== null) {
				try {
					process.kill(helperPid, "SIGKILL");
				} catch {}
			}
			rmSync(worktreePath, { recursive: true, force: true });
		}
	});
});
