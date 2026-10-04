import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	commandAvailable,
	PARALLELS_AQUA_UID,
	PARALLELS_GOLDEN_IMAGE,
	ROSTER_FIXTURE_PATH,
	runBootstrap,
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
describe("checkpoint identity failures on detached worker path (Task 1.3)", () => {
	it("terminalizes an unknown CheckpointIdentityError with closed fatal evidence", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);

		const runId = randomUUID();
		const nonce = randomUUID();
		const loaderPath = join(dir, "unknown-checkpoint-identity-loader.mjs");
		const arbitraryCode = "checkpoint_unrecognized_test_code";
		const arbitraryDetail = "must-not-persist:/private/example";

		writeFileSync(
			loaderPath,
			`export async function load(url, context, nextLoad) {
				if (url.endsWith("/src/switchyard/runner/index.mjs")) {
					return {
						format: "module",
						shortCircuit: true,
						source: ${JSON.stringify(`const error = new Error(${JSON.stringify(arbitraryDetail)});\nerror.name = "CheckpointIdentityError";\nerror.code = "${arbitraryCode}";\nthrow error;\n`)},
					};
				}
				return nextLoad(url, context);
			}`,
			"utf8",
		);

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
		});

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			{
				...makeStateRootEnv(),
				NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
			},
		);

		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find(
			(event) => event.event === "worker_boot_failed",
		);
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.status, "fatal");
		strictEqual(bootFailed.reasonCode, "launch_failed");
		strictEqual(bootFailed.diagnosticCode, "worker_boot_exception");
		ok(!JSON.stringify(bootFailed).includes(arbitraryCode));
		ok(!JSON.stringify(bootFailed).includes(arbitraryDetail));

		const run = await readRun(runId);
		strictEqual(run.state, "failed");
		strictEqual(run.cleanupState, "complete");
		strictEqual(run.lastFailure.diagnosticCode, "worker_boot_exception");
		ok(!JSON.stringify(run).includes(arbitraryCode));
		ok(!JSON.stringify(run).includes(arbitraryDetail));
	});
	it("bootstrap with run-options mismatch emits checkpoint_run_options_mismatch", async () => {
		const { initializeRun, readEvents, readRun } = await import(
			"../src/switchyard/run-store/index.mjs"
		);
		const { normalizeRunOptions, createQueueIdentity, loadTaskQueue } =
			await import("../src/switchyard/runner/index.mjs");

		const runId = randomUUID();
		const nonce = randomUUID();
		const checkpointPath = `${tasksFile}.checkpoint.json`;

		const tasks = loadTaskQueue(tasksFile);
		const runOptions1 = normalizeRunOptions({
			checkpointPath,
			maxTasks: 1,
			stopOnFailure: true,
		});
		const runOptions2 = normalizeRunOptions({
			checkpointPath,
			maxTasks: 2,
			stopOnFailure: true,
		});

		const queueIdentity = createQueueIdentity({
			tasksFilePath: tasksFile,
			markdown: readFileSync(tasksFile, "utf8"),
			tasks,
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		writeFileSync(
			checkpointPath,
			JSON.stringify({
				version: 2,
				tasksFilePath: tasksFile,
				queueIdentity,
				runOptions: runOptions2,
				completedTaskIds: [],
				results: [],
			}),
			"utf8",
		);

		await initializeRun({
			runId,
			tasksFilePath: tasksFile,
			projectPath: projectDir,
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: nonce,
			launchArgs: [],
			queueIdentity,
			projectRevision: "rev-1",
			runOptions: runOptions1,
		});

		const result = runBootstrap(
			["--state-root", stateRoot, "--run-id", runId, "--nonce", nonce],
			makeStateRootEnv(),
		);

		strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}: ${result.stderr}`,
		);

		const events = await readEvents(runId);
		const bootFailed = events.find((e) => e.event === "worker_boot_failed");
		ok(bootFailed, "worker_boot_failed event recorded");
		strictEqual(bootFailed.phase, "worker");
		strictEqual(bootFailed.event, "worker_boot_failed");
		strictEqual(bootFailed.status, "checkpoint_run_options_mismatch");
		strictEqual(bootFailed.errorKind, "launch_failed");
		strictEqual(bootFailed.reasonCode, "checkpoint_run_options_mismatch");
		strictEqual(bootFailed.diagnosticCode, "checkpoint_run_options_mismatch");
		strictEqual(bootFailed.failurePhase, "worker_boot");
		ok(bootFailed.reason.includes("normalized run options changed"));
		strictEqual(bootFailed.error, undefined);
		ok(!JSON.stringify(bootFailed).includes(projectDir));

		const run = await readRun(runId);
		ok(run.lastFailure !== null, "lastFailure populated in run.json");
		strictEqual(run.lastFailure.errorKind, "launch_failed");
		strictEqual(run.lastFailure.reasonCode, "checkpoint_run_options_mismatch");
		ok(run.lastFailure.reason.includes("create a fresh checkpoint explicitly"));
		strictEqual(run.lastFailure.failurePhase, "worker_boot");
		ok(!JSON.stringify(run.lastFailure).includes(projectDir));
		const disposition = projectDisposition({
			run,
			liveness: "terminal_clean",
			optionalEvidenceValid: false,
		});
		strictEqual(disposition.action, "repair_contract");
		strictEqual(disposition.reasonCode, "checkpoint_run_options_mismatch");
	});
});
