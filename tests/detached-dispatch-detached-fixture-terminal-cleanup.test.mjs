import { ok, rejects, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	attachCleanupFailure,
	cleanupDiagnostic,
	commandAvailable,
	compactDiagnostic,
	PARALLELS_AQUA_UID,
	PARALLELS_GOLDEN_IMAGE,
	pollStatus,
	ROSTER_FIXTURE_PATH,
	SWITCHYARD_SKIP_LIVE_VM_TESTS,
} from "./helpers/detached-dispatch-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

let parallelsConfigurationFault = null;
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
function buildOverlayProject() {
	const project = join(dir, "overlay-project");
	mkdirSync(join(project, "src"), { recursive: true });
	const git = (...args) =>
		execFileSync("git", args, { cwd: project, stdio: "pipe" });
	writeFileSync(join(project, "src", "a.mjs"), "export const value = 1;\n");
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "Test");
	git("add", "src/a.mjs");
	git("commit", "-qm", "base");
	writeFileSync(join(project, "src", "a.mjs"), "export const value = 2;\n");
	// Queue artifacts stay outside the project: the checkpoint and receipt are
	// untracked, and an overlay capture rejects untracked content in scope.
	const tasksPath = join(dir, "overlay-tasks.md");
	writeFileSync(
		tasksPath,
		"### Task 1.1: Overlay task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A test\n",
		"utf8",
	);
	return { project, tasksPath };
}
async function awaitRunTerminalCleanup(
	runId,
	env,
	{
		maxWait = 300_000,
		pollInterval = 200,
		progressInterval = 5_000,
		pollStatusFn = pollStatus,
		onProgress = () => process.stderr.write("detached cleanup: polling\n"),
		sleep = (delayMs) =>
			new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
	} = {},
) {
	const start = Date.now();
	let nextProgressAt = 0;
	let lastStatus = null;
	let lastStatusResult = null;
	let pollCount = 0;
	const emitProgress = (status) => {
		const now = Date.now();
		if (now < nextProgressAt) return;
		nextProgressAt = now + Math.max(0, progressInterval);
		try {
			onProgress({
				pollCount,
				elapsedMs: now - start,
				status: cleanupDiagnostic(status),
			});
		} catch {
			// Progress is advisory and must never mask the cleanup result.
		}
	};
	while (true) {
		pollCount += 1;
		try {
			const statusResult = pollStatusFn(runId, env);
			lastStatusResult = statusResult;
			if (statusResult.status === 0) {
				let status = null;
				try {
					status = JSON.parse(statusResult.stdout.trim());
					lastStatus = status;
					if (
						(status?.state === "succeeded" || status?.state === "failed") &&
						status?.cleanupState === "complete"
					) {
						return status;
					}
				} catch {
					// A partial/corrupt observation is retained in the timeout
					// diagnostic; it can never count as completed cleanup.
				}
				emitProgress(status);
				if (
					status?.state === "recovery_required" ||
					status?.cleanupState === "failed"
				) {
					const cleanupFailure = new Error(
						`run ${runId} entered unrecoverable cleanup state: ${JSON.stringify(cleanupDiagnostic(status))}`,
					);
					cleanupFailure.code = "cleanup_recovery_required";
					throw cleanupFailure;
				}
			}
			if (statusResult.status !== 0) emitProgress(null);
		} catch (error) {
			if (error?.code === "cleanup_recovery_required") throw error;
			lastStatusResult = { status: "threw", stderr: error.message };
			emitProgress(null);
		}

		const elapsed = Date.now() - start;
		if (elapsed >= maxWait) break;
		await sleep(Math.min(pollInterval, maxWait - elapsed));
	}
	let diagnosticEvents = [];
	let diagnosticRun = null;
	try {
		const { readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		diagnosticEvents = await readEvents(runId);
		diagnosticRun = await readRun(runId);
	} catch {}
	throw new Error(
		`run ${runId} did not reach terminal state with completed cleanup within ${maxWait}ms after ${pollCount} polls; last status: ${JSON.stringify(cleanupDiagnostic(lastStatus))}; run record: ${JSON.stringify(cleanupDiagnostic(diagnosticRun))}; status exit: ${lastStatusResult?.status ?? "unknown"}; status stderr: ${compactDiagnostic(lastStatusResult?.stderr) || "<empty>"}; recent events: ${JSON.stringify(diagnosticEvents.slice(-5).map(({ phase, event, taskId }) => ({ phase, event, taskId: taskId ?? null })))}`,
	);
}
async function finishDetachedRun(runId, env, bodyError, cleanupOptions = {}) {
	let cleanupError = null;
	if (runId) {
		try {
			await awaitRunTerminalCleanup(runId, env, cleanupOptions);
			detachedCleanupPending = false;
		} catch (error) {
			cleanupError = error;
		}
	}

	if (bodyError) {
		if (cleanupError) attachCleanupFailure(bodyError, cleanupError);
		throw bodyError;
	}
	if (cleanupError) throw cleanupError;
}
describe("detached fixture terminal cleanup guard", () => {
	it("waits through a terminal-but-pending state and fails with bounded diagnostics if cleanup never completes", async () => {
		const statuses = [
			{ state: "running", cleanupState: "not_started", workerPid: 123 },
			{ state: "failed", cleanupState: "pending", workerPid: 123 },
			{ state: "failed", cleanupState: "complete", workerPid: null },
		];
		let pollCount = 0;
		const progress = [];
		const terminal = await awaitRunTerminalCleanup(
			"fixture-run",
			{},
			{
				maxWait: 100,
				pollInterval: 0,
				pollStatusFn: () => ({
					status: 0,
					stdout: JSON.stringify(statuses[pollCount++]),
					stderr: "",
				}),
				progressInterval: 0,
				onProgress: (event) => progress.push(event),
				sleep: async () => {},
			},
		);

		strictEqual(pollCount, 3);
		strictEqual(terminal.cleanupState, "complete");
		strictEqual(progress.length, 2);
		strictEqual(progress[0].status.state, "running");
		strictEqual(progress[1].status.cleanupState, "pending");

		let recoveryPolls = 0;
		await rejects(
			awaitRunTerminalCleanup(
				"recovery-run",
				{},
				{
					maxWait: 300_000,
					pollStatusFn: () => {
						recoveryPolls += 1;
						return {
							status: 0,
							stdout: JSON.stringify({
								state: "recovery_required",
								cleanupState: "failed",
								workerPid: 123,
							}),
							stderr: "",
						};
					},
					sleep: async () => {
						throw new Error("must not sleep after recovery failure");
					},
				},
			),
			/entered unrecoverable cleanup state.*recovery_required/,
		);
		strictEqual(recoveryPolls, 1);

		await rejects(
			awaitRunTerminalCleanup(
				"diagnostic-run",
				{},
				{
					maxWait: 0,
					pollStatusFn: () => ({
						status: 0,
						stdout: JSON.stringify({
							state: "failed",
							cleanupState: "pending",
							workerPid: 456,
						}),
						stderr: "",
					}),
				},
			),
			/diagnostic-run.*"state":"failed","cleanupState":"pending"/,
		);
	});
	it("rethrows the original routing failure when cleanup also fails and keeps fixture preservation armed", async () => {
		const routingError = new Error("synthetic selector assertion failure");
		detachedCleanupPending = true;
		detachedCleanupRunId = "masked-error-run";
		let observedError = null;
		try {
			await finishDetachedRun("masked-error-run", {}, routingError, {
				maxWait: 0,
				pollStatusFn: () => ({
					status: 0,
					stdout: JSON.stringify({
						state: "failed",
						cleanupState: "pending",
					}),
					stderr: "",
				}),
			});
		} catch (error) {
			observedError = error;
		}

		strictEqual(observedError, routingError);
		ok(
			observedError.cause?.message.includes(
				"did not reach terminal state with completed cleanup",
			),
			"cleanup failure diagnostic must be attached to the original error",
		);
		strictEqual(detachedCleanupPending, true);
		// This regression deliberately simulates failure without a real detached
		// worker, so disarm preservation before the shared afterEach runs.
		detachedCleanupPending = false;
	});
});
