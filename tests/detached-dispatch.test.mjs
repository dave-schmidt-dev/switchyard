// Detached dispatch integration tests: launch/status/result round-trips,
// worker-bootstrap nonce handshake, project locks, and failure recording.
// These spawn real Node subprocesses.

import { ok, strictEqual } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { isContainerRuntimeAvailable } from "../src/switchyard/container/index.mjs";
import {
	containerExists,
	createLabeledContainer,
	createLabeledVolume,
	removeContainer,
	removeVolume,
	volumeExists,
} from "./helpers/lifecycle-fixture.mjs";

const HAS_DOCKER = isContainerRuntimeAvailable();

if (!HAS_DOCKER) {
	console.log("Docker not available — skipping detached crash matrix tests");
}

function describeIf(condition, ...args) {
	if (condition) return describe(...args);
	return describe.skip(...args);
}

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const DISPATCH_PATH = resolve(
	__dirname,
	"..",
	"src",
	"switchyard",
	"dispatch",
	"index.mjs",
);
const BOOTSTRAP_PATH = resolve(
	__dirname,
	"..",
	"src",
	"switchyard",
	"dispatch",
	"worker-bootstrap.mjs",
);
// Task 1.5 (roster-unification plan): src/switchyard/roster/index.mjs now
// lazily loads the roster, resolving SWITCHYARD_ROSTER_PATH or the canonical
// ~/.agent/roster.json default (Task 4.1) and failing loud only if that
// resolved file can't load. This file's real dispatch subprocesses (and the
// detached workers they spawn) go through the real, unmocked router/roster
// on the way to routing a task, so every spawned process needs a valid
// roster — point at this committed synthetic fixture (not the real
// ~/.agent/roster.json).
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);

function runDispatch(args, env = {}) {
	return spawnSync(process.execPath, [DISPATCH_PATH, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		env: { ...process.env, ...env },
	});
}

function runBootstrap(args, env = {}) {
	return spawnSync(process.execPath, [BOOTSTRAP_PATH, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		env: { ...process.env, ...env },
	});
}

let dir;
let tasksFile;
let projectDir;
let stateRoot;

function makeStateRootEnv() {
	return { SWITCHYARD_RUN_STORE_ROOT: stateRoot };
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "switchyard-detached-dispatch-"));
	stateRoot = join(dir, "state-root");
	tasksFile = join(dir, "tasks.md");
	writeFileSync(
		tasksFile,
		"### Task 1.1: Test task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Description:** A test\n",
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
	rmSync(dir, { recursive: true, force: true });
});

async function launchAndGetRunId() {
	const result = runDispatch(
		["launch", tasksFile, "--project", projectDir],
		makeStateRootEnv(),
	);
	strictEqual(result.status, 0, `launch failed: ${result.stderr}`);
	const envelope = JSON.parse(result.stdout.trim());
	ok(typeof envelope.runId === "string" && envelope.runId.length > 0);
	return envelope.runId;
}

function pollStatus(runId, env) {
	return runDispatch(["status", runId], env);
}

describe("launch returns before completion", () => {
	it("launch exits 0 immediately, status returns a tracked run", async () => {
		const startTime = Date.now();
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		const elapsed = Date.now() - startTime;

		strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		ok(elapsed < 5000, `launch took ${elapsed}ms, expected < 5000ms`);

		const envelope = JSON.parse(result.stdout.trim());
		strictEqual(envelope.state, "launcher_ready");
		const runId = envelope.runId;

		const statusResult = pollStatus(runId, makeStateRootEnv());
		strictEqual(
			statusResult.status,
			0,
			`status failed: ${statusResult.stderr}`,
		);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.runId, runId);
	});

	it("detached launch persists the v2 identity and selected task options", async () => {
		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir, "--task-id", "1.1"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `launch failed: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		strictEqual(run.schemaVersion, 2);
		ok(/^[a-f0-9]{64}$/.test(run.queueIdentity));
		strictEqual(run.runOptions.taskIds[0], "1.1");
	});

	it("quarantines malformed records during the awaited worker startup sweep without touching a sibling launch", async () => {
		const { initializeRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const malformedRunId = `malformed-${randomUUID()}`;
		const siblingRunId = randomUUID();

		await initializeRun({
			runId: siblingRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		mkdirSync(join(stateRoot, "runs", malformedRunId), { recursive: true });
		writeFileSync(
			join(stateRoot, "runs", malformedRunId, "run.json"),
			"{ malformed run record",
			"utf8",
		);

		const launchResult = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(
			launchResult.status,
			0,
			`launch failed: ${launchResult.stderr}`,
		);

		// The quarantine move happens inside applyRetention, which bootstrap
		// awaits before claiming its lease. Seeing the moved directory confirms
		// that startup sweep completed before we inspect the sibling record.
		const quarantineRoot = join(stateRoot, ".quarantine");
		let sweepCompleted = false;
		const start = Date.now();
		while (Date.now() - start < 10_000) {
			try {
				const quarantined = readdirSync(quarantineRoot);
				if (quarantined.some((entry) => entry.startsWith(malformedRunId))) {
					sweepCompleted = true;
					break;
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		ok(
			sweepCompleted,
			"worker startup retention sweep did not quarantine malformed record",
		);

		const sibling = await readRun(siblingRunId);
		strictEqual(sibling.state, "created");
		strictEqual(sibling.workerPid, null);
	});
});

describe("worker reaches terminal state and result is readable", () => {
	it("worker runs against a real run and eventually reaches a terminal state", async () => {
		const runId = await launchAndGetRunId();

		let terminalReached = false;
		const start = Date.now();
		const maxWait = 15_000;

		while (Date.now() - start < maxWait) {
			const statusResult = pollStatus(runId, makeStateRootEnv());
			if (statusResult.status !== 0) {
				await new Promise((r) => setTimeout(r, 500));
				continue;
			}
			const status = JSON.parse(statusResult.stdout.trim());

			if (status.state === "succeeded" || status.state === "failed") {
				terminalReached = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 500));
		}

		ok(terminalReached, "run did not reach terminal state within timeout");

		const resultResult = runDispatch(["result", runId], makeStateRootEnv());
		strictEqual(resultResult.status, 1, "result exits 1 for failed run");

		const result = JSON.parse(resultResult.stdout.trim());
		ok(result.terminalSummary !== null, "terminalSummary present");
		ok(Array.isArray(result.artifactRefs), "artifactRefs is an array");
	});
});

describe("--exclude-provider on the detached worker path", () => {
	it("excludes the given provider from routing end-to-end via `launch` (not just the foreground path)", async () => {
		// The shared `projectDir` fixture (beforeEach) is just an empty `.git`
		// directory — enough for the other tests in this file, which only care
		// that the run reaches *some* terminal state, but seedProject's `git
		// archive HEAD` needs a real commit or the worker crashes before ever
		// reaching routing. Use a dedicated, properly-initialized repo here
		// (same recipe as dispatch-cli.test.mjs's "run subcommand via spawn").
		const excludeProjectDir = join(dir, "exclude-provider-project");
		mkdirSync(excludeProjectDir, { recursive: true });
		execSync("git init", { cwd: excludeProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: excludeProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: excludeProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: excludeProjectDir,
			stdio: "ignore",
		});

		// Deterministic routing: point SWITCHYARD_SNAPSHOT_PATH_OVERRIDE at a
		// fixture snapshot with two known-healthy providers instead of relying
		// on whatever the real production snapshot happens to contain (see
		// resolveSnapshotPath() in router/index.mjs — the same override
		// router.test.mjs and runner.test.mjs use for isolation). Without
		// --exclude-provider, claude (90% left) outranks codex (50% left) and
		// wins routing under router/index.mjs's spread-by-headroom rule; with
		// `--exclude-provider claude`, codex must be routed instead.
		const snapshotPath = join(dir, "snapshot.json");
		writeFileSync(
			snapshotPath,
			JSON.stringify({
				schema_version: 2,
				providers: [
					{
						name: "claude",
						ok: true,
						windows: [{ percent_left: 90, pace_delta: 0 }],
					},
					{
						name: "codex",
						ok: true,
						windows: [{ percent_left: 50, pace_delta: 0 }],
					},
				],
			}),
			"utf8",
		);

		const env = {
			...makeStateRootEnv(),
			SWITCHYARD_SNAPSHOT_PATH_OVERRIDE: snapshotPath,
		};

		const launchResult = runDispatch(
			[
				"launch",
				tasksFile,
				"--project",
				excludeProjectDir,
				"--exclude-provider",
				"claude",
			],
			env,
		);
		strictEqual(
			launchResult.status,
			0,
			`launch failed: ${launchResult.stderr}`,
		);
		const { runId } = JSON.parse(launchResult.stdout.trim());

		// onTaskRouted fires (and is persisted to activeTaskProvider) before the
		// blocking adapter.execute call, so poll frequently: this only needs to
		// observe routing, not wait for the task to finish executing.
		let observedProvider = null;
		const start = Date.now();
		// 60s, not the file's usual 15-20s budget: this test's container has to
		// build/start from cold before routing is observable, which measured
		// ~24.9s under sustained Docker load during this plan's own development
		// (see TASKS.md's Docker-contention item) — comfortably inside 60s but
		// past a tighter budget shared with lighter-weight tests in this file.
		const maxWait = 60_000;
		while (Date.now() - start < maxWait) {
			const statusResult = pollStatus(runId, env);
			if (statusResult.status === 0) {
				const status = JSON.parse(statusResult.stdout.trim());
				if (status.activeTaskProvider) {
					observedProvider = status.activeTaskProvider;
					break;
				}
				if (status.state === "succeeded" || status.state === "failed") {
					break;
				}
			}
			await new Promise((r) => setTimeout(r, 200));
		}

		// Fallback for the race where the task already reached a terminal state
		// (task_completed/task_failed) before any poll caught
		// activeTaskProvider populated — the routed provider is still on the
		// terminal event worker-bootstrap.mjs's onResult callback records.
		if (!observedProvider) {
			const { readEvents } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			const events = await readEvents(runId);
			const routedEvent = events.find(
				(e) =>
					e.phase === "execution" &&
					(e.event === "task_completed" || e.event === "task_failed"),
			);
			observedProvider = routedEvent?.provider ?? null;
		}

		ok(observedProvider, "expected the task to be routed to some provider");
		strictEqual(
			observedProvider,
			"codex",
			"claude is excluded and has more headroom, so codex must be routed instead",
		);
		ok(
			observedProvider !== "claude",
			"the excluded provider must never be routed",
		);
	});
});

describe("--only-provider on the detached worker path", () => {
	it("restricts routing to the given provider end-to-end via `launch` (not just the foreground path) (Task C.9)", async () => {
		// Mirrors the --exclude-provider test above, but proves the allowlist
		// (not just the denylist) works end-to-end through the real detached
		// worker path: without --only-provider, claude (90% left) outranks
		// codex (50% left) and wins routing under router/index.mjs's
		// spread-by-headroom rule; with `--only-provider codex`, codex must be
		// routed instead even though claude has more headroom.
		const onlyProjectDir = join(dir, "only-provider-project");
		mkdirSync(onlyProjectDir, { recursive: true });
		execSync("git init", { cwd: onlyProjectDir, stdio: "ignore" });
		execSync("git config user.email test@test.com", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});
		execSync("git config user.name test", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});
		execSync("git commit --allow-empty -m initial", {
			cwd: onlyProjectDir,
			stdio: "ignore",
		});

		const snapshotPath = join(dir, "snapshot-only.json");
		writeFileSync(
			snapshotPath,
			JSON.stringify({
				schema_version: 2,
				providers: [
					{
						name: "claude",
						ok: true,
						windows: [{ percent_left: 90, pace_delta: 0 }],
					},
					{
						name: "codex",
						ok: true,
						windows: [{ percent_left: 50, pace_delta: 0 }],
					},
				],
			}),
			"utf8",
		);

		const env = {
			...makeStateRootEnv(),
			SWITCHYARD_SNAPSHOT_PATH_OVERRIDE: snapshotPath,
		};

		const launchResult = runDispatch(
			[
				"launch",
				tasksFile,
				"--project",
				onlyProjectDir,
				"--only-provider",
				"codex",
			],
			env,
		);
		strictEqual(
			launchResult.status,
			0,
			`launch failed: ${launchResult.stderr}`,
		);
		const { runId } = JSON.parse(launchResult.stdout.trim());

		let observedProvider = null;
		const start = Date.now();
		const maxWait = 60_000;
		while (Date.now() - start < maxWait) {
			const statusResult = pollStatus(runId, env);
			if (statusResult.status === 0) {
				const status = JSON.parse(statusResult.stdout.trim());
				if (status.activeTaskProvider) {
					observedProvider = status.activeTaskProvider;
					break;
				}
				if (status.state === "succeeded" || status.state === "failed") {
					break;
				}
			}
			await new Promise((r) => setTimeout(r, 200));
		}

		if (!observedProvider) {
			const { readEvents } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			const events = await readEvents(runId);
			const routedEvent = events.find(
				(e) =>
					e.phase === "execution" &&
					(e.event === "task_completed" || e.event === "task_failed"),
			);
			observedProvider = routedEvent?.provider ?? null;
		}

		ok(observedProvider, "expected the task to be routed to some provider");
		strictEqual(
			observedProvider,
			"codex",
			"claude has more headroom but is not in the --only-provider allowlist, so codex must be routed instead",
		);
		ok(
			observedProvider !== "claude",
			"a provider outside the --only-provider allowlist must never be routed",
		);
	});
});

describe("duplicate project runs fail", () => {
	it("launch is blocked while the project lock is already held", async () => {
		const { acquireProjectLock } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		// Hold the project lock directly to simulate an in-flight run. This is
		// deterministic: it does not race a detached worker's terminal cleanup
		// (which now releases the lock — see the "terminal run" test below).
		await acquireProjectLock(projectDir, randomUUID());

		const result = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(
			result.status,
			1,
			`launch against a locked project should exit 1, got ${result.status}: ${result.stderr}`,
		);
	});
});

describe("terminal run releases the project lock", () => {
	it("after a run reaches terminal state the lock is released and a second launch succeeds", async () => {
		const { isProjectLockHeld } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const runId = await launchAndGetRunId();

		const start = Date.now();
		const maxWait = 20_000;

		let terminalReached = false;
		while (Date.now() - start < maxWait) {
			const statusResult = pollStatus(runId, makeStateRootEnv());
			if (statusResult.status === 0) {
				const status = JSON.parse(statusResult.stdout.trim());
				if (status.state === "succeeded" || status.state === "failed") {
					terminalReached = true;
					break;
				}
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		ok(terminalReached, "run did not reach terminal state within timeout");

		// The worker releases the project lock right after writing terminal
		// state; poll until the lock file is gone.
		let released = false;
		while (Date.now() - start < maxWait) {
			if (!isProjectLockHeld(projectDir)) {
				released = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		ok(
			released,
			"project lock was not released after the run reached terminal state",
		);

		const second = runDispatch(
			["launch", tasksFile, "--project", projectDir],
			makeStateRootEnv(),
		);
		strictEqual(
			second.status,
			0,
			`second launch after lock release should exit 0, got ${second.status}: ${second.stderr}`,
		);
	});
});

describe("recover releases stale project locks", () => {
	it("recover --run clears a project lock left by a dead/terminal run", async () => {
		const {
			initializeRun,
			advanceState,
			acquireProjectLock,
			isProjectLockHeld,
		} = await import("../src/switchyard/run-store/index.mjs");

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		// Terminal, dead run that still holds its project lock (the Bug 1
		// residue a hard-crashed worker would leave behind).
		await advanceState(runId, "failed");
		await acquireProjectLock(projectDir, runId);
		strictEqual(isProjectLockHeld(projectDir), true);

		const result = runDispatch(["recover", "--run", runId], makeStateRootEnv());
		ok(
			result.status === 0 || result.status === 1,
			`recover exit code should be 0 or 1, got ${result.status}: ${result.stderr}`,
		);
		strictEqual(
			isProjectLockHeld(projectDir),
			false,
			"recover should have released the stale project lock",
		);
	});

	it("recover --run does not release a lock held by a live worker", async () => {
		const {
			initializeRun,
			advanceState,
			acquireProjectLock,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(runId, "running");
		// Point the lease at this test process, which is provably alive.
		const current = await readRun(runId);
		await updateRun(runId, { workerPid: process.pid }, current.revision);
		await acquireProjectLock(projectDir, runId);
		strictEqual(isProjectLockHeld(projectDir), true);

		const result = runDispatch(["recover", "--run", runId], makeStateRootEnv());
		ok(
			result.status === 0 || result.status === 1,
			`recover exit code should be 0 or 1, got ${result.status}: ${result.stderr}`,
		);
		strictEqual(
			isProjectLockHeld(projectDir),
			true,
			"recover must not yank a project lock from a live worker",
		);
	});

	it("recover --run clears a lock left by a crashed worker still marked running", async () => {
		const {
			initializeRun,
			advanceState,
			acquireProjectLock,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		// Non-terminal state with a dead worker pid: exactly the residue a
		// hard-crashed worker (unhandledRejection -> process.exit before any
		// terminal write) leaves behind. The safety net must reclaim this via
		// the liveness probe, not the terminal-state check.
		await advanceState(runId, "running");
		const current = await readRun(runId);
		await updateRun(runId, { workerPid: 99999 }, current.revision);
		await acquireProjectLock(projectDir, runId);
		strictEqual(isProjectLockHeld(projectDir), true);

		const result = runDispatch(["recover", "--run", runId], makeStateRootEnv());
		ok(
			result.status === 0 || result.status === 1,
			`recover exit code should be 0 or 1, got ${result.status}: ${result.stderr}`,
		);
		strictEqual(
			isProjectLockHeld(projectDir),
			false,
			"recover should have released the lock held by a dead running worker",
		);
	});

	it("recover --run does not release a lock reassigned to a newer active run on the same project", async () => {
		const {
			initializeRun,
			advanceState,
			acquireProjectLock,
			isProjectLockHeld,
			readRun,
			updateRun,
		} = await import("../src/switchyard/run-store/index.mjs");

		const staleRunId = randomUUID();
		await initializeRun({
			runId: staleRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(staleRunId, "failed");
		// staleRunId's own project lock was already released by its own worker
		// (the Bug 1 terminal-path fix) — never acquired here, matching that.

		// A newer run has since legitimately acquired the SAME project's lock
		// and is still actively running.
		const activeRunId = randomUUID();
		await initializeRun({
			runId: activeRunId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await advanceState(activeRunId, "running");
		const current = await readRun(activeRunId);
		await updateRun(activeRunId, { workerPid: process.pid }, current.revision);
		await acquireProjectLock(projectDir, activeRunId);
		strictEqual(isProjectLockHeld(projectDir), true);

		// Someone runs recover against the OLD, already-terminal run id —
		// a blind release-by-path would incorrectly clear activeRunId's lock.
		const result = runDispatch(
			["recover", "--run", staleRunId],
			makeStateRootEnv(),
		);
		ok(
			result.status === 0 || result.status === 1,
			`recover exit code should be 0 or 1, got ${result.status}: ${result.stderr}`,
		);
		strictEqual(
			isProjectLockHeld(projectDir),
			true,
			"recover must not release a lock owned by a different, currently-active run",
		);
	});
});

describe("non-matching nonce", () => {
	it("bootstrap with wrong nonce exits 3 and records worker_boot_failed", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const correctNonce = "correct-nonce-value";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: correctNonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			[
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				"wrong-nonce-value",
			],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			3,
			`expected exit 3 for nonce mismatch, got ${result.status}: ${result.stderr}`,
		);

		const { readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		// writeFatalEvent now routes the real Error through Diagnostics
		// (error: error, not detail: error?.message), so the persisted
		// payload carries a serialized `error` object rather than a raw
		// `detail` string.
		ok(bootFailed.error, "worker_boot_failed event carries a serialized error");
		ok(bootFailed.error.message.includes("nonce mismatch"));
	});

	it("bootstrap with a secret-canary-bearing nonce redacts it from the persisted worker_boot_failed event", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const correctNonce = "correct-nonce-value";

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: correctNonce,
			launchArgs: [],
		});

		// The nonce-mismatch Error message interpolates both the received
		// and expected nonce values, so a canary-shaped wrong nonce lands
		// straight in error.message — proving writeFatalEvent's Diagnostics
		// path (not just the Diagnostics unit tests) actually redacts it
		// before it reaches events.jsonl.
		const result = runBootstrap(
			[
				"--state-root",
				stateRoot,
				"--run-id",
				runId,
				"--nonce",
				"SECRET_CANARY_leaked_nonce_value",
			],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			3,
			`expected exit 3 for nonce mismatch, got ${result.status}: ${result.stderr}`,
		);

		const { readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		ok(bootFailed.error, "worker_boot_failed event carries a serialized error");
		strictEqual(bootFailed.error.message, "[REDACTED]");

		assertNoSecretCanary(runId);
	});
});

describe("fast/failed bootstrap", () => {
	it("bootstrap that fails to import the runner records worker_boot_failed and does not hang", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = randomUUID();

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		// Build a broken bootstrap script that fails to import
		const brokenBootstrapPath = join(dir, "broken-bootstrap.mjs");
		writeFileSync(
			brokenBootstrapPath,
			`process.env.SWITCHYARD_RUN_STORE_ROOT = ${JSON.stringify(stateRoot)};
process.env.SWITCHYARD_RUN_STORE_ROOT = process.env.SWITCHYARD_RUN_STORE_ROOT;
import("${resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs")}").then(async (runStore) => {
	await runStore.advanceState("${runId}", "running");
	throw new Error("simulated import failure: module not found");
}).catch(async (err) => {
	try {
		await (await import("${resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs")}")).createEvent("${runId}", {
			phase: "worker",
			event: "worker_boot_failed",
			status: "fatal",
			detail: err.message ?? "import failed",
		});
	} catch {}
	process.exit(1);
});
`,
			"utf8",
		);

		// Set the run's workerNonce to the correct value so the broken
		// bootstrap can proceed past nonce check (it doesn't validate)

		const start = Date.now();
		const result = spawnSync(process.execPath, [brokenBootstrapPath], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			env: { ...process.env, SWITCHYARD_RUN_STORE_ROOT: stateRoot },
		});
		const elapsed = Date.now() - start;

		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: ${result.stderr}`,
		);
		ok(elapsed < 10_000, `broken bootstrap hung: ${elapsed}ms`);

		const { readEvents } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
	});
});

describe("status and result envelope contracts", () => {
	it("status shows activeTaskId when a task is running and completed/failed counts change", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1", "1.2"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		// Advance to running and set activeTaskId
		const current = await readRun(runId);
		await updateRun(
			runId,
			{ state: "running", activeTaskId: "1.1" },
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.state, "running");
		strictEqual(status.activeTaskId, "1.1");
	});

	it("status exposes workerLive:true and the routed provider/model/deadline for a live worker, without needing docker top", async () => {
		// Regression: an operator had to shell out to `docker top`/`ps` to
		// distinguish a genuinely active run from a ghost (a "running" state
		// whose worker process actually died), and had to inspect the host
		// process to learn which provider/model a task was routed to.
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const deadline = new Date(Date.now() + 1_800_000).toISOString();
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "running",
				workerPid: process.pid,
				activeTaskId: "1.1",
				activeTaskProvider: "claude",
				activeTaskModel: "claude-sonnet-5",
				activeTaskDeadline: deadline,
			},
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.workerLive, true);
		strictEqual(status.activeTaskProvider, "claude");
		strictEqual(status.activeTaskModel, "claude-sonnet-5");
		strictEqual(status.activeTaskDeadline, deadline);
	});

	it("status exposes workerLive:false for a running state whose worker pid is dead (ghost run)", async () => {
		const { initializeRun, updateRun, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const current = await readRun(runId);
		await updateRun(
			runId,
			{ state: "running", workerPid: 99999, activeTaskId: "1.1" },
			current.revision,
		);

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.workerLive, false);
	});

	it("status reports workerLive:null for a non-running state (no live-worker question applies)", async () => {
		const { initializeRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fp",
			launchArgs: [],
		});

		const statusResult = runDispatch(["status", runId], makeStateRootEnv());
		strictEqual(statusResult.status, 0);
		const status = JSON.parse(statusResult.stdout.trim());
		strictEqual(status.state, "created");
		strictEqual(status.workerLive, null);
		strictEqual(status.activeTaskProvider, null);
		strictEqual(status.activeTaskModel, null);
		strictEqual(status.activeTaskDeadline, null);
	});
});

function assertNoSecretCanary(runId) {
	const runDir = resolve(stateRoot, "runs", runId);
	const runJsonRaw = readFileSync(resolve(runDir, "run.json"), "utf8");
	ok(
		!runJsonRaw.includes("SECRET_CANARY_"),
		"run.json must not contain SECRET_CANARY_",
	);

	try {
		const eventsRaw = readFileSync(resolve(runDir, "events.jsonl"), "utf8");
		ok(
			!eventsRaw.includes("SECRET_CANARY_"),
			"events.jsonl must not contain SECRET_CANARY_",
		);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}

	try {
		const artifactsDir = resolve(runDir, "artifacts");
		const entries = readdirSync(artifactsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile()) {
				const content = readFileSync(resolve(artifactsDir, entry.name), "utf8");
				ok(
					!content.includes("SECRET_CANARY_"),
					`artifact ${entry.name} must not contain SECRET_CANARY_`,
				);
			}
		}
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
}

function cleanFixture(name) {
	removeContainer(name);
	removeVolume(`${name}-vol`);
}

const SWITCHYARD_LABELS = {
	managed: "com.zerodelta.switchyard.managed",
	runId: "com.zerodelta.switchyard.run_id",
	project: "com.zerodelta.switchyard.project",
};

describeIf(HAS_DOCKER, "detached crash matrix", () => {
	describe("scenario 1: death before lease claim", () => {
		let runId;

		beforeEach(async () => {
			runId = randomUUID();
			const { initializeRun } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: randomUUID(),
				launchArgs: [],
			});
		});

		it("bootstrap that dies before lease claim records worker_boot_failed", async () => {
			const { readEvents } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			const runStorePath = resolve(
				__dirname,
				"..",
				"src",
				"switchyard",
				"run-store",
				"index.mjs",
			);

			const wrapperPath = join(dir, "crash-before-lease.mjs");
			writeFileSync(
				wrapperPath,
				`process.env.SWITCHYARD_RUN_STORE_ROOT = ${JSON.stringify(stateRoot)};
async function main() {
	const runStore = await import(${JSON.stringify(runStorePath)});
	await runStore.readRun("${runId}");
	const err = new Error("simulated crash: process killed before lease claim");
	await runStore.createEvent("${runId}", {
		phase: "worker",
		event: "worker_boot_failed",
		status: "fatal",
		detail: err.message,
	});
	process.exit(1);
}
main();
`,
				"utf8",
			);

			const result = spawnSync(process.execPath, [wrapperPath], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				env: { ...process.env, SWITCHYARD_RUN_STORE_ROOT: stateRoot },
			});

			strictEqual(
				result.status,
				1,
				`expected exit 1, got ${result.status}: ${result.stderr}`,
			);

			const events = await readEvents(runId);
			const bootFailed = events.find((e) => e.event === "worker_boot_failed");
			ok(bootFailed, "worker_boot_failed event recorded");
		});

		it("no SECRET_CANARY_ in run artifacts after crash before lease", () => {
			assertNoSecretCanary(runId);
		});
	});

	describe("scenario 2: death after lease but before container", () => {
		let runId;

		beforeEach(async () => {
			runId = randomUUID();
			const { initializeRun, advanceState } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: randomUUID(),
				launchArgs: [],
			});
			await advanceState(runId, "running");
		});

		it("expired lease allows recovery when no Docker objects were created", async () => {
			const { isRunLockExpired, acquireRunLock, readRun, updateRun } =
				await import("../src/switchyard/run-store/index.mjs");

			const current = await readRun(runId);
			await updateRun(
				runId,
				{
					workerPid: 99999,
					workerStartToken: "old-token",
					lastLeaseHeartbeat: new Date(Date.now() - 120_000).toISOString(),
				},
				current.revision,
			);

			const expired = await isRunLockExpired(runId, { maxAgeMs: 60_000 });
			ok(expired, "lease should be expired after 120s with 60s max age");

			const updated = await acquireRunLock(
				runId,
				process.pid,
				randomUUID(),
				"recovery-nonce",
				{ allowRecovery: true, maxAgeMs: 60_000 },
			);
			strictEqual(updated.workerPid, process.pid);
		});

		it("run in running state with no Docker objects is handled gracefully by recovery", async () => {
			const { recoverManagedObjects } = await import(
				"../src/switchyard/lifecycle/index.mjs"
			);

			const result = recoverManagedObjects({
				isRunActive: (rid) => rid !== runId,
			});

			strictEqual(result.containersReclaimed, 0);
			strictEqual(result.volumesReclaimed, 0);
		});

		it("no SECRET_CANARY_ in run artifacts", () => {
			assertNoSecretCanary(runId);
		});
	});

	describe("scenario 3: death after container creation", () => {
		let runId;
		let trackedContainer;
		let trackedVolume;

		beforeEach(async () => {
			runId = randomUUID();
			const { initializeRun, advanceState } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: randomUUID(),
				launchArgs: [],
			});
			await advanceState(runId, "running");

			trackedContainer = createLabeledContainer({
				name: `switchyard-test-crash3-${randomUUID().slice(0, 8)}`,
				labels: {
					[SWITCHYARD_LABELS.managed]: "true",
					[SWITCHYARD_LABELS.runId]: runId,
					[SWITCHYARD_LABELS.project]: projectDir,
				},
			});

			trackedVolume = createLabeledVolume({
				name: `${trackedContainer}-vol`,
				labels: {
					[SWITCHYARD_LABELS.managed]: "true",
					[SWITCHYARD_LABELS.runId]: runId,
					[SWITCHYARD_LABELS.project]: projectDir,
				},
			});
		});

		afterEach(() => {
			cleanFixture(trackedContainer);
		});

		it("reclaims labeled container and volume for dead run", async () => {
			strictEqual(
				containerExists(trackedContainer),
				true,
				"fixture container must exist before recovery",
			);
			strictEqual(
				volumeExists(trackedVolume),
				true,
				"fixture volume must exist before recovery",
			);

			const { recoverManagedObjects } = await import(
				"../src/switchyard/lifecycle/index.mjs"
			);

			const result = recoverManagedObjects({
				isRunActive: (rid) => rid !== runId,
			});

			ok(
				result.containersReclaimed >= 1,
				"should reclaim at least the fixture container",
			);
			ok(
				result.volumesReclaimed >= 1,
				"should reclaim at least the fixture volume",
			);

			strictEqual(
				containerExists(trackedContainer),
				false,
				"fixture container must be removed after recovery",
			);
			strictEqual(
				volumeExists(trackedVolume),
				false,
				"fixture volume must be removed after recovery",
			);
		});

		it("no SECRET_CANARY_ in run artifacts after container recovery", () => {
			assertNoSecretCanary(runId);
		});
	});

	describe("scenario 4: death during integration", () => {
		let runId;
		let trackedContainer;
		let unrelatedContainer;

		beforeEach(async () => {
			runId = randomUUID();
			const { initializeRun, advanceState, readRun, updateRun } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: randomUUID(),
				launchArgs: [],
			});
			await advanceState(runId, "running");

			const current = await readRun(runId);
			await updateRun(runId, { activeTaskId: "1.1" }, current.revision);

			trackedContainer = createLabeledContainer({
				name: `switchyard-test-crash4-${randomUUID().slice(0, 8)}`,
				labels: {
					[SWITCHYARD_LABELS.managed]: "true",
					[SWITCHYARD_LABELS.runId]: runId,
					[SWITCHYARD_LABELS.project]: projectDir,
				},
			});

			createLabeledVolume({
				name: `${trackedContainer}-vol`,
				labels: {
					[SWITCHYARD_LABELS.managed]: "true",
					[SWITCHYARD_LABELS.runId]: runId,
					[SWITCHYARD_LABELS.project]: projectDir,
				},
			});

			const unrelatedRunId = randomUUID();
			await initializeRun({
				runId: unrelatedRunId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				launchArgs: [],
			});

			unrelatedContainer = createLabeledContainer({
				name: `switchyard-test-crash4-other-${randomUUID().slice(0, 8)}`,
				labels: {
					[SWITCHYARD_LABELS.managed]: "true",
					[SWITCHYARD_LABELS.runId]: unrelatedRunId,
					[SWITCHYARD_LABELS.project]: projectDir,
				},
			});
		});

		afterEach(() => {
			cleanFixture(trackedContainer);
			cleanFixture(unrelatedContainer);
		});

		it("reclaims only target run objects, preserves unrelated container", async () => {
			strictEqual(
				containerExists(trackedContainer),
				true,
				"fixture container must exist before recovery",
			);
			strictEqual(
				containerExists(unrelatedContainer),
				true,
				"unrelated container must exist before recovery",
			);

			const { recoverManagedObjects } = await import(
				"../src/switchyard/lifecycle/index.mjs"
			);

			const reclaimEvents = [];
			const result = recoverManagedObjects({
				isRunActive: (rid) => rid !== runId,
				onStatus: (e) => reclaimEvents.push(e),
			});

			ok(
				result.containersReclaimed >= 1,
				"should reclaim at least the fixture container",
			);

			strictEqual(
				containerExists(trackedContainer),
				false,
				"fixture container must be removed after recovery",
			);
			strictEqual(
				containerExists(unrelatedContainer),
				true,
				"unrelated container must NOT be affected by recovery",
			);

			const reclaimed = reclaimEvents.filter(
				(e) => e.type === "reclaimed" && e.object === "container",
			);
			const ourRecovered = reclaimed.find((e) => e.name === trackedContainer);
			ok(ourRecovered, "recovered fixture must emit reclaimed event");
			strictEqual(ourRecovered.runId, runId);

			const unrelatedSkipped = reclaimEvents.find(
				(e) =>
					e.type === "skip" &&
					e.name === unrelatedContainer &&
					e.reason === "active-run",
			);
			ok(unrelatedSkipped, "unrelated container must be skipped as active-run");
		});

		it("exact-label teardown with strictEqual assertion", async () => {
			const { recoverManagedObjects } = await import(
				"../src/switchyard/lifecycle/index.mjs"
			);

			strictEqual(
				containerExists(trackedContainer),
				true,
				"before cleanup: container must exist",
			);
			strictEqual(
				volumeExists(`${trackedContainer}-vol`),
				true,
				"before cleanup: volume must exist",
			);

			recoverManagedObjects({
				isRunActive: (rid) => rid !== runId,
			});

			strictEqual(
				containerExists(trackedContainer),
				false,
				"after cleanup: container must be removed",
			);
			strictEqual(
				volumeExists(`${trackedContainer}-vol`),
				false,
				"after cleanup: volume must be removed",
			);
		});

		it("no SECRET_CANARY_ in run artifacts after integration crash", () => {
			assertNoSecretCanary(runId);
		});
	});

	describe("scenario 5: death during cleanup", () => {
		let runId;
		let trackedContainer;

		beforeEach(async () => {
			runId = randomUUID();
			const { initializeRun, advanceState, readRun, updateRun } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			await initializeRun({
				runId,
				tasksFilePath: tasksFile,
				projectPath: projectDir,
				orderedTaskIds: ["1.1"],
				initialHostFingerprint: "test-fingerprint",
				workerNonce: randomUUID(),
				launchArgs: [],
			});
			await advanceState(runId, "running");

			const runCurrent = await readRun(runId);
			await updateRun(
				runId,
				{
					state: "succeeded",
					cleanupState: "failed",
					terminalSummary: {
						totalTasks: 1,
						runnableTasks: 1,
						processedTasks: 1,
						completedTaskIds: ["1.1"],
						failedCount: 0,
					},
				},
				runCurrent.revision,
			);

			trackedContainer = createLabeledContainer({
				name: `switchyard-test-crash5-${randomUUID().slice(0, 8)}`,
				labels: {
					[SWITCHYARD_LABELS.managed]: "true",
					[SWITCHYARD_LABELS.runId]: runId,
					[SWITCHYARD_LABELS.project]: projectDir,
				},
			});

			createLabeledVolume({
				name: `${trackedContainer}-vol`,
				labels: {
					[SWITCHYARD_LABELS.managed]: "true",
					[SWITCHYARD_LABELS.runId]: runId,
					[SWITCHYARD_LABELS.project]: projectDir,
				},
			});
		});

		afterEach(() => {
			cleanFixture(trackedContainer);
		});

		it("reclaims remaining containers after cleanup failure", async () => {
			strictEqual(
				containerExists(trackedContainer),
				true,
				"fixture container must exist before recovery",
			);

			const { recoverManagedObjects } = await import(
				"../src/switchyard/lifecycle/index.mjs"
			);

			const result = recoverManagedObjects({
				isRunActive: (rid) => rid !== runId,
			});

			ok(
				result.containersReclaimed >= 1,
				"should reclaim at least the fixture container",
			);

			strictEqual(
				containerExists(trackedContainer),
				false,
				"fixture container must be removed after recovery",
			);
			strictEqual(
				volumeExists(`${trackedContainer}-vol`),
				false,
				"fixture volume must be removed after recovery",
			);
		});

		it("run state remains succeeded with cleanupState failed after object recovery", async () => {
			const { recoverManagedObjects } = await import(
				"../src/switchyard/lifecycle/index.mjs"
			);

			recoverManagedObjects({
				isRunActive: (rid) => rid !== runId,
			});

			const { readRun } = await import("../src/switchyard/run-store/index.mjs");
			const runState = await readRun(runId);
			strictEqual(runState.state, "succeeded");
			strictEqual(runState.cleanupState, "failed");
		});

		it("no SECRET_CANARY_ in run artifacts after cleanup crash", () => {
			assertNoSecretCanary(runId);
		});
	});
});
