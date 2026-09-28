import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { projectDisposition } from "../src/switchyard/dispatch/disposition.mjs";
import { ParallelsExecutionBackend } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import {
	__dirname,
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
describe("typed pre-provider failures on the detached terminal path", () => {
	it("preserves exported task-selection, queue-preflight, and lock triples", async () => {
		const runnerUrl = `${pathToFileURL(resolve(__dirname, "..", "src", "switchyard", "runner", "index.mjs")).href}?typed-terminalization`;
		const runStoreUrl = pathToFileURL(
			resolve(__dirname, "..", "src", "switchyard", "run-store", "index.mjs"),
		).href;
		const cases = [
			{
				name: "task-selection",
				source: `import { TaskSelectionError } from ${JSON.stringify(runnerUrl)}; throw new TaskSelectionError("9.9", "external-blocked:private-canary");`,
				diagnosticCode: "task_selection_failed",
				errorKind: "task_selection_failed",
				failurePhase: "task_selection",
				action: "repair_contract",
				direction: "repair_input",
			},
			{
				name: "queue-preflight",
				source: `import { QueuePreflightError } from ${JSON.stringify(runnerUrl)}; throw new QueuePreflightError("/private/canary raw provider output", { reason: "no_eligible", rejections: [{ capability: "standard", reason: "no_provider", excludedProviders: ["claude"], excludedReasons: { claude: "no_invocation_descriptor" } }] });`,
				diagnosticCode: "environment_incomplete",
				errorKind: "environment_incomplete",
				failurePhase: "queue_preflight",
				action: "repair_contract",
				direction: "repair_input",
			},
			{
				name: "project-lock",
				source: `import { LockError } from ${JSON.stringify(runStoreUrl)}; throw new LockError("/private/canary lock detail", { code: "PROJECT_LOCK_OWNERSHIP_FAILED" });`,
				diagnosticCode: "project_lock_ownership_failed",
				errorKind: "project_lock_failed",
				failurePhase: "project_lock",
				action: "stop",
				direction: "retry_launch",
			},
		];

		for (const testCase of cases) {
			const { initializeRun, readEvents, readRun } = await import(
				"../src/switchyard/run-store/index.mjs"
			);
			const runId = randomUUID();
			const nonce = randomUUID();
			const loaderPath = join(dir, `${testCase.name}-loader.mjs`);
			writeFileSync(
				loaderPath,
				`export async function load(url, context, nextLoad) {
					if (url.endsWith("/src/switchyard/runner/index.mjs")) {
						return { format: "module", shortCircuit: true, source: ${JSON.stringify(testCase.source)} };
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
			strictEqual(result.status, 1, `${testCase.name}: ${result.stderr}`);
			const event = (await readEvents(runId)).find(
				(entry) => entry.event === "worker_boot_failed",
			);
			ok(event, `${testCase.name}: terminal event missing`);
			const run = await readRun(runId);
			for (const evidence of [event, run.lastFailure]) {
				strictEqual(evidence.diagnosticCode, testCase.diagnosticCode);
				strictEqual(evidence.errorKind, testCase.errorKind);
				strictEqual(evidence.failurePhase, testCase.failurePhase);
				strictEqual(evidence.reasonCode, testCase.errorKind);
				const durable = JSON.stringify(evidence, (key, value) =>
					key === "timestamp" ? undefined : value,
				);
				ok(!durable.includes("9.9"));
				ok(!durable.includes("private-canary"));
				ok(!durable.includes("/private/canary"));
				ok(!durable.includes("raw provider output"));
			}
			if (testCase.name === "queue-preflight") {
				deepStrictEqual(run.preflightDetail, {
					reason: "no_eligible",
					rejections: [
						{
							capability: "standard",
							reason: "no_provider",
							excludedProviders: ["claude"],
							excludedReasons: { claude: "no_invocation_descriptor" },
						},
					],
				});
			}
			const disposition = projectDisposition({
				run,
				liveness: "terminal_clean",
				optionalEvidenceValid: false,
			});
			strictEqual(disposition.action, testCase.action);
			strictEqual(disposition.direction, testCase.direction);
			strictEqual(disposition.reasonCode, testCase.diagnosticCode);
		}
	});
});
