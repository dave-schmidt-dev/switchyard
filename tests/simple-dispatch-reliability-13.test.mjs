import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
	defaultExecuteProvider,
	handleSimple,
	parseOpenCodeGoBridgeDiagnostic,
	runSimpleTask,
	runSimpleWriter,
} from "../src/switchyard/simple/index.mjs";
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
	describe("simple dispatch reliability and regression invariants (SW-R1)", () => {
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
		});
	});
});
