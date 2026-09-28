import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	commandAvailable,
	PARALLELS_AQUA_UID,
	PARALLELS_GOLDEN_IMAGE,
	pollStatus,
	ROSTER_FIXTURE_PATH,
	runDispatch,
	SWITCHYARD_SKIP_LIVE_VM_TESTS,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let parallelsConfigurationFault = null;
function assertParallelsConfigured() {
	if (parallelsConfigurationFault) {
		throw new Error(parallelsConfigurationFault);
	}
}
function parallelsGoldenImagePrerequisiteReason() {
	if (!commandAvailable("prlctl")) return "Parallels prlctl is unavailable";
	// Parallels is installed but the operator has not said which VM to clone.
	// That is a configuration fault, not an absent dependency, so it FAILS the gate
	// instead of skipping it. The previous `|| "macOS"` fallback pointed at the
	// unhardened Task 1.1 base VM, which is present and stopped on this host: with
	// the variable unset the gate would have cloned and asserted against a VM that
	// was never hardened. Production already refuses to guess (README.md: "no
	// default -- guessing at which VM to clone is not a safe default").
	if (!PARALLELS_GOLDEN_IMAGE) {
		parallelsConfigurationFault =
			"SWITCHYARD_PARALLELS_GOLDEN_IMAGE must be set to run the VM gate";
		return null;
	}
	let output;
	try {
		output = execFileSync("prlctl", ["list", "-a", "-o", "uuid,status,name"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	const golden = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split(/\s+/))
		.find(
			(fields) =>
				fields.length >= 3 &&
				fields.slice(2).join(" ") === PARALLELS_GOLDEN_IMAGE,
		);
	if (!golden) return `golden image ${PARALLELS_GOLDEN_IMAGE} is unavailable`;
	if (!/^stopped$/i.test(golden[1])) {
		return `golden image ${PARALLELS_GOLDEN_IMAGE} is not stopped`;
	}
	// An unset or malformed Aqua uid is a configuration fault, not an absent
	// dependency, so it FAILS the gate instead of skipping it. Returning a skip
	// reason here made the gate report green having proven nothing: it passes
	// locally only because ~/.zshrc exports the variable, so any non-interactive
	// shell, CI runner, or launchd context silently lost the INV-1 assertions.
	if (!PARALLELS_AQUA_UID) {
		parallelsConfigurationFault =
			"SWITCHYARD_PARALLELS_AQUA_UID must be set to run the VM gate";
		return null;
	}
	if (!/^\d+$/.test(PARALLELS_AQUA_UID) || Number(PARALLELS_AQUA_UID) <= 0) {
		parallelsConfigurationFault = `SWITCHYARD_PARALLELS_AQUA_UID must be a positive integer uid, got ${JSON.stringify(PARALLELS_AQUA_UID.slice(0, 32))}`;
		return null;
	}
	try {
		if (new ParallelsExecutionBackend().listManaged().length > 0) {
			return "a Switchyard working VM is active";
		}
	} catch {
		return "Parallels VM inventory is unavailable";
	}
	return null;
}
const PARALLELS_PREREQUISITE_REASON = SWITCHYARD_SKIP_LIVE_VM_TESTS
	? "fixture-only: SWITCHYARD_SKIP_LIVE_VM_TESTS=1"
	: parallelsGoldenImagePrerequisiteReason();
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
describe("recover releases stale project locks", {
	skip: PARALLELS_PREREQUISITE_REASON
		? `VM gate skipped: ${PARALLELS_PREREQUISITE_REASON}`
		: undefined,
}, () => {
	it("recover --run clears a project lock left by a dead/terminal run", async () => {
		assertParallelsConfigured();
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
		// Terminal-clean, dead run that still holds its project lock: the stale-lock
		// residue a hard-crashed worker would leave behind.
		await advanceState(runId, "failed");
		const current = await readRun(runId);
		await updateRun(runId, { cleanupState: "complete" }, current.revision);
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
		assertParallelsConfigured();
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
		assertParallelsConfigured();
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
