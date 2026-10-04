import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
	runDispatch,
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
		strictEqual(run.dispatchContractVersion, 1);
		strictEqual(run.activeTaskInvocationDescriptor, null);
		ok(/^[a-f0-9]{64}$/.test(run.queueIdentity));
		strictEqual(run.runOptions.taskIds[0], "1.1");
	});
	it("binds a launch-time overlay receipt into the detached run options", async () => {
		const { project, tasksPath } = buildOverlayProject();
		const result = runDispatch(
			["launch", tasksPath, "--project", project, "--dirty-overlay"],
			makeStateRootEnv(),
		);
		strictEqual(result.status, 0, `launch failed: ${result.stderr}`);
		const { runId } = JSON.parse(result.stdout.trim());
		const { readRun } = await import("../src/switchyard/run-store/index.mjs");
		const run = await readRun(runId);
		strictEqual(run.runOptions.dirtyOverlay, true);
		const receiptPath = run.runOptions.dirtyOverlayReceiptPath;
		strictEqual(receiptPath, `${tasksPath}.checkpoint.json.dirty-overlay.json`);
		strictEqual(statSync(receiptPath).mode & 0o777, 0o600);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		strictEqual(run.runOptions.dirtyOverlayReceiptHash, receipt.receiptHash);
		deepStrictEqual(
			receipt.paths.map((entry) => entry.path),
			["src/a.mjs"],
		);
		strictEqual(
			Buffer.from(receipt.paths[0].bytes, "base64").toString("utf8"),
			"export const value = 2;\n",
		);
		// The run-store projection and the launch output carry the receipt hash,
		// never the bytes it stands for.
		strictEqual(JSON.stringify(run).includes(receipt.paths[0].bytes), false);
		strictEqual(result.stdout.includes(receipt.paths[0].bytes), false);
	});
	it("refuses to relaunch against a receipt the worktree has outgrown", () => {
		const { project, tasksPath } = buildOverlayProject();
		const first = runDispatch(
			["launch", tasksPath, "--project", project, "--dirty-overlay"],
			makeStateRootEnv(),
		);
		strictEqual(first.status, 0, `launch failed: ${first.stderr}`);
		const receiptPath = `${tasksPath}.checkpoint.json.dirty-overlay.json`;
		const before = readFileSync(receiptPath, "utf8");

		writeFileSync(join(project, "src", "a.mjs"), "export const value = 3;\n");
		const second = runDispatch(
			["launch", tasksPath, "--project", project, "--dirty-overlay"],
			makeStateRootEnv(),
		);
		ok(second.status !== 0, "a stale receipt must fail the launch");
		match(second.stderr, /dirty_overlay_file_drift/u);
		match(second.stderr, /remove .* to recapture/u);
		strictEqual(readFileSync(receiptPath, "utf8"), before);
	});
	it("refuses to launch an overlay with undeclared dirty content", () => {
		const { project, tasksPath } = buildOverlayProject();
		writeFileSync(join(project, "src", "b.mjs"), "export const extra = 1;\n");
		execFileSync("git", ["add", "src/b.mjs"], { cwd: project, stdio: "pipe" });
		execFileSync("git", ["commit", "-qm", "add b"], {
			cwd: project,
			stdio: "pipe",
		});
		writeFileSync(join(project, "src", "b.mjs"), "export const extra = 2;\n");

		const result = runDispatch(
			["launch", tasksPath, "--project", project, "--dirty-overlay"],
			makeStateRootEnv(),
		);
		ok(result.status !== 0, "undeclared dirty content must fail the launch");
		ok(
			/out-of-scope|src\/b\.mjs/.test(`${result.stderr}${result.stdout}`),
			`expected an out-of-scope rejection, got: ${result.stderr}`,
		);
		strictEqual(
			existsSync(`${tasksPath}.checkpoint.json.dirty-overlay.json`),
			false,
		);
	});
	it("refuses an overlay whose checkpoint would land inside the project", () => {
		const { project } = buildOverlayProject();
		const inProjectTasks = join(project, "queue.md");
		writeFileSync(
			inProjectTasks,
			"### Task 1.1: Overlay task\n- **Status:** pending\n- **Executor:** switchyard\n- **Files:** src/a.mjs\n- **Quick checks:** none\n- **Description:** A test\n",
			"utf8",
		);
		execFileSync("git", ["add", "queue.md"], { cwd: project, stdio: "pipe" });
		execFileSync("git", ["commit", "-qm", "queue"], {
			cwd: project,
			stdio: "pipe",
		});

		const result = runDispatch(
			["launch", inProjectTasks, "--project", project, "--dirty-overlay"],
			makeStateRootEnv(),
		);
		ok(result.status !== 0, "an in-project checkpoint must fail the launch");
		match(result.stderr, /outside the project or be ignored/u);
		strictEqual(
			existsSync(`${inProjectTasks}.checkpoint.json.dirty-overlay.json`),
			false,
		);
	});
	it("refuses an overlay queue containing a task that declares no files", () => {
		const { project, tasksPath } = buildOverlayProject();
		writeFileSync(
			tasksPath,
			`${readFileSync(tasksPath, "utf8")}\n### Task 1.2: Review task\n- **Status:** pending\n- **Executor:** switchyard\n- **Type:** review\n- **Description:** A review\n`,
			"utf8",
		);

		const result = runDispatch(
			["launch", tasksPath, "--project", project, "--dirty-overlay"],
			makeStateRootEnv(),
		);
		ok(result.status !== 0, "an undeclared task must fail the launch");
		match(result.stderr, /task 1\.2 declares none/u);
		strictEqual(
			existsSync(`${tasksPath}.checkpoint.json.dirty-overlay.json`),
			false,
		);
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
		const { runId } = JSON.parse(launchResult.stdout.trim());
		detachedCleanupPending = true;
		detachedCleanupRunId = runId;
		let bodyError = null;

		try {
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
		} catch (error) {
			bodyError = error;
		} finally {
			await finishDetachedRun(runId, makeStateRootEnv(), bodyError);
		}
	});
});
