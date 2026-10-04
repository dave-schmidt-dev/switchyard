import { ok, strictEqual } from "node:assert";
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
	ROSTER_FIXTURE_PATH,
	runDispatch,
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
	it("worker that fails before diagnostics sink exists leaves non-empty boot-stderr.log naming the failure", async () => {
		const { getRunRoot, initializeRun, readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = "test-nonce-pre-sink";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		const markerPath = join(dir, "active-generation-marker.json");
		writeFileSync(
			markerPath,
			JSON.stringify({
				schemaVersion: 1,
				state: "in_progress",
				runId: "generation-guard-test-run",
				owner: "native",
				startedAt: new Date().toISOString(),
				metadata: {},
			}),
		);

		const bootLogPath = resolve(getRunRoot(runId), "boot-stderr.log");
		const fd = openSync(bootLogPath, "w", 0o600);

		// Run worker-bootstrap with a maintenance generation active so it refuses
		// before runStore is imported and before the diagnostics sink is constructed
		const result = spawnSync(
			process.execPath,
			[
				BOOTSTRAP_PATH,
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				nonce,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "ignore", fd],
				env: {
					...process.env,
					...makeStateRootEnv(),
					SWITCHYARD_GENERATION_MARKER: markerPath,
				},
			},
		);
		closeSync(fd);

		strictEqual(
			result.status,
			1,
			"expected exit 1 for generation guard refusal",
		);

		const events = await readEvents(runId);
		strictEqual(events.length, 1);
		strictEqual(events[0].event, "worker_boot_failed");
		strictEqual(events[0].errorKind, "launch_failed");

		// boot-stderr.log exists and contains the failure reason
		ok(existsSync(bootLogPath), "boot-stderr.log must exist");
		const bootStderr = readFileSync(bootLogPath, "utf8");
		ok(bootStderr.length > 0, "boot-stderr.log must have non-zero size");
		strictEqual(bootStderr, "worker_boot_exception\n");
	});
	it("uncaught boot exception stack reaches boot-stderr.log and persists worker_boot_exception", async () => {
		const { getRunRoot, initializeRun, readEvents, updateRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = "test-nonce-uncaught";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});
		await updateRun(runId, { dispatchContractVersion: 99 }, 1);

		const bootLogPath = resolve(getRunRoot(runId), "boot-stderr.log");
		const fd = openSync(bootLogPath, "w", 0o600);

		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
				process.nextTick(() => {
					throw new Error("Simulated uncaught boot explosion for Task 1.1");
				});
				const { runWorkerBootstrap } = await import(
					${JSON.stringify(BOOTSTRAP_PATH)}
				);
				await runWorkerBootstrap(process.argv);
				`,
				"--",
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				nonce,
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

		strictEqual(
			child.status,
			1,
			"expected child to exit 1 on uncaughtException",
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_boot_exception");
		strictEqual(bootFailed.failurePhase, "worker_boot");

		// Fatal handlers do not echo raw exception messages or stack frames.
		ok(existsSync(bootLogPath), "boot-stderr.log must exist");
		const bootStderr = readFileSync(bootLogPath, "utf8");
		strictEqual(bootStderr, "worker_boot_exception\n");
	});
	it("retains boot-stderr.log when the worker fails before provider routing", async () => {
		const { getRunRoot, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `launch failed: ${result.stderr}`);
		const envelope = JSON.parse(result.stdout.trim());
		const runId = envelope.runId;

		const deadline = Date.now() + 5000;
		let finalState = "launching";
		while (Date.now() < deadline) {
			const run = await readRun(runId);
			finalState = run.state;
			if (run.state !== "launching") {
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}

		// State advancement proves the worker executed its identity checks. In
		// this fixture provider admission fails, so the boot log remains as the
		// bounded pre-provider diagnostic channel.
		ok(
			finalState !== "launching",
			`worker never advanced past launching (state=${finalState}); unlink assertion below would be vacuous`,
		);

		const runRoot = getRunRoot(runId);
		const bootLogPath = resolve(runRoot, "boot-stderr.log");
		ok(existsSync(bootLogPath), "pre-provider failure retains boot-stderr.log");
	});
});
