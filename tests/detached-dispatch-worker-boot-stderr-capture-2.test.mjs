import { ok, rejects, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	BOOTSTRAP_PATH,
	DISPATCH_PATH,
	ROSTER_FIXTURE_PATH,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let dir;
let tasksFile;
let projectDir;
let stateRoot;
let detachedCleanupPending;
let detachedCleanupRunId;
function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}
beforeEach(async () => {
	dir = tempDir("switchyard-detached-dispatch-");
	detachedCleanupPending = false;
	detachedCleanupRunId = null;
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A test\n",
		"utf8",
	);
	projectDir = join(dir, "project");
	mkdirSync(join(projectDir, ".git"), { recursive: true });

	process.env.SWITCHYARD_RUN_STORE_ROOT = stateRoot;
	process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;
	// Real dispatch subprocesses go through the real, unmocked ledger writer —
	// redirect it so this suite never writes to the real dispatch-ledger.jsonl.
	process.env.SWITCHYARD_LEDGER_PATH = join(dir, "dispatch-ledger.jsonl");
});
afterEach(() => {
	delete process.env.SWITCHYARD_RUN_STORE_ROOT;
	delete process.env.SWITCHYARD_ROSTER_PATH;
	delete process.env.SWITCHYARD_LEDGER_PATH;
	if (detachedCleanupPending) {
		console.error(
			`detached cleanup was not confirmed for run ${detachedCleanupRunId ?? "unknown"}; preserving fixture ${dir}`,
		);
		return;
	}
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("worker boot stderr capture and retention (Task 1.1)", () => {
	it("nonce mismatch with secret canary never writes canary to boot-stderr.log bytes", async () => {
		const { getRunRoot, initializeRun, readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const correctNonce = "correct-nonce-val";
		const secretCanaryNonce = "SECRET_CANARY_NEVER_LEAK_INTO_BOOT_LOG";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: correctNonce,
			launchArgs: [],
		});

		const bootLogPath = resolve(getRunRoot(runId), "boot-stderr.log");
		const fd = openSync(bootLogPath, "w", 0o600);

		const result = spawnSync(
			process.execPath,
			[
				BOOTSTRAP_PATH,
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				secretCanaryNonce,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "ignore", fd],
				env: {
					...process.env,
					...makeStateRootEnv(),
				},
			},
		);
		closeSync(fd);

		strictEqual(result.status, 3, "expected exit 3 for nonce mismatch");

		ok(existsSync(bootLogPath), "boot-stderr.log exists");
		const logBytes = readFileSync(bootLogPath);
		const logText = logBytes.toString("utf8");

		ok(
			!logText.includes("SECRET_CANARY"),
			`secret canary found in boot-stderr.log: ${logText}`,
		);
		ok(
			!logText.includes(secretCanaryNonce),
			`secret nonce found in boot-stderr.log: ${logText}`,
		);

		// Presence alone would prove nothing: assert the classification the
		// event is supposed to carry, and that it too is canary-free.
		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_nonce_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		strictEqual(bootFailed.sequence, 1);
		strictEqual(
			events.every((event, index) => event.sequence === index + 1),
			true,
		);
		ok(!JSON.stringify(bootFailed).includes("SECRET_CANARY"));
	});
	it("launch creates boot-stderr.log and wires it to the worker's stderr", async () => {
		const { getRunRoot } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// Poison NODE_OPTIONS *after* this launcher process is already running, so
		// only the worker it spawns is affected. The worker then dies before Node
		// executes a single line of worker-bootstrap — no diagnostics sink, no
		// event, no unlink. That is the register-no-boot case this channel exists
		// for, and it is the one lever that forces it deterministically: any
		// failure the worker can reach itself would unlink the log on the way past.
		const launchCode = `
		process.env.NODE_OPTIONS = "--this-flag-does-not-exist";
		const { handleLaunch } = await import(${JSON.stringify(DISPATCH_PATH)});
		await handleLaunch([${JSON.stringify(tasksFile)}, "--project", ${JSON.stringify(projectDir)}]);
		`;

		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", launchCode, "--"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					...makeStateRootEnv(),
				},
			},
		);

		strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}: ${result.stderr}`,
		);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.state, "launcher_ready");

		const bootLogPath = resolve(getRunRoot(envelope.runId), "boot-stderr.log");
		ok(existsSync(bootLogPath), `launch never created ${bootLogPath}`);
		const captured = readFileSync(bootLogPath, "utf8");
		ok(
			captured.includes("is not allowed in NODE_OPTIONS"),
			`worker stderr was not wired to the boot log; got: ${captured}`,
		);

		// Without this channel the run record is the whole story, and it says
		// nothing: the worker never reached the code that writes an event.
		const { readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const events = await readEvents(envelope.runId);
		strictEqual(
			events.filter((e) => e.event === "worker_boot_failed").length,
			0,
			"no boot event is possible here — the boot log is the only record",
		);
	});
	it("launch still succeeds when the boot log cannot be opened", async () => {
		const { getRunRoot, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// Reassigning `fs.openSync` alone does NOT reach dispatch's named
		// `import { openSync } from "node:fs"` binding — the ESM linker has
		// already snapshotted it. `syncBuiltinESMExports()` republishes the
		// mutated object through the builtin's named exports, and is the only
		// reason this stub is not vacuous. The stub announces itself and the
		// test asserts on that: otherwise a refactor that stopped opening the
		// log at all would keep this test green.
		const launchCode = `
		import fs from "node:fs";
		import {
	syncBuiltinESMExports,
} from "node:module";
		const realOpenSync = fs.openSync;
		fs.openSync = function (path, ...rest) {
			if (typeof path === "string" && path.endsWith("boot-stderr.log")) {
				process.stderr.write("STUB_REFUSED_BOOT_LOG\\n");
				throw new Error("EACCES: simulated open failure");
			}
			return realOpenSync.call(this, path, ...rest);
		};
		syncBuiltinESMExports();
		const { handleLaunch } = await import(${JSON.stringify(DISPATCH_PATH)});
		await handleLaunch([${JSON.stringify(tasksFile)}, "--project", ${JSON.stringify(projectDir)}]);
		`;

		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", launchCode, "--"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					...makeStateRootEnv(),
				},
			},
		);

		ok(
			result.stderr.includes("STUB_REFUSED_BOOT_LOG"),
			`the open stub never fired, so this test proves nothing: ${result.stderr}`,
		);
		strictEqual(
			result.status,
			0,
			`a diagnostics file must never fail a launch, got ${result.status}: ${result.stderr}`,
		);
		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.state, "launcher_ready");
		const bootLogPath = resolve(getRunRoot(envelope.runId), "boot-stderr.log");
		if (existsSync(bootLogPath)) {
			const bootLog = readFileSync(bootLogPath, "utf8");
			ok(bootLog.length <= 4096, "retained boot diagnostic is bounded");
			ok(!bootLog.includes("STUB_REFUSED_BOOT_LOG"));
		}

		// The fallback has to yield a working worker, not merely a working
		// launcher: `stdio: "ignore"` must still be a valid spawn disposition.
		const deadline = Date.now() + 5000;
		let finalState = "launching";
		while (Date.now() < deadline) {
			finalState = (await readRun(envelope.runId)).state;
			if (finalState !== "launching") {
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		ok(
			finalState !== "launching",
			`worker spawned with the "ignore" fallback never booted (state=${finalState})`,
		);
	});
	it("applyRetention preserves run with non-empty boot-stderr.log and deletes empty or absent", async () => {
		const { applyRetention, getRunRoot, initializeRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		// 1. Run with non-empty boot-stderr.log (should be preserved past cutoff)
		const runKeepId = `retention-keep-boot-${randomUUID()}`;
		await initializeRun({
			runId: runKeepId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: "nonce-keep",
			launchArgs: [],
		});
		const keepBootLog = resolve(getRunRoot(runKeepId), "boot-stderr.log");
		writeFileSync(
			keepBootLog,
			"worker-bootstrap: generation guard refused (fatal)\n",
			{ mode: 0o600 },
		);

		// 2. Run with empty boot-stderr.log (0 bytes -> should be deleted past cutoff)
		const runEmptyLogId = `retention-del-empty-${randomUUID()}`;
		await initializeRun({
			runId: runEmptyLogId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: "nonce-empty",
			launchArgs: [],
		});
		const emptyBootLog = resolve(getRunRoot(runEmptyLogId), "boot-stderr.log");
		writeFileSync(emptyBootLog, "", { mode: 0o600 });

		// 3. Run with no boot-stderr.log and no events.jsonl (should be deleted past cutoff)
		const runNoLogId = `retention-del-nolog-${randomUUID()}`;
		await initializeRun({
			runId: runNoLogId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: "nonce-nolog",
			launchArgs: [],
		});

		const result = await applyRetention({
			maxRuns: 0,
			maxAgeDays: 0,
			now: new Date(Date.now() + 86_400_000).toISOString(),
		});

		// Pin the sweep's scope, not just these three runs: the assertions
		// below say nothing about a directory they do not name.
		strictEqual(
			result.deletedCount,
			2,
			`expected exactly the two runs without a diagnostic record to be swept, got ${result.deletedCount}`,
		);

		// runKeepId must survive
		const keptRun = await readRun(runKeepId);
		strictEqual(keptRun.runId, runKeepId);
		ok(existsSync(keepBootLog));

		// runEmptyLogId and runNoLogId must be deleted
		await rejects(readRun(runEmptyLogId), /Run not found/);
		await rejects(readRun(runNoLogId), /Run not found/);
	});
});
